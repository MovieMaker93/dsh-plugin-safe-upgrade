/**
 * Config history: a git repository in `$DSH_HOME` that records only the files
 * that decide whether dsh boots (settings, patches, profile manifests, agent
 * presets) — never sessions, credentials or caches.
 *
 * The allowlist is enforced here, not by `.gitignore`: an adopted repository
 * keeps its own ignore file, and snapshots, restores and diffs still touch
 * config paths only. Snapshots never run `git add`: each file is read once,
 * scanned for secrets, and exactly those scanned bytes are written as a blob
 * and committed through a private index, so content that fails the scan (or
 * is too large to scan) never enters the object store.
 * @module dsh-plugin-safe-upgrade/repo
 */

import { createHash, randomBytes } from 'node:crypto'
import {
  chmodSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, renameSync,
  rmSync, symlinkSync, writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { run, sleep, stamp, stateDir } from './util.js'

/**
 * Written as `.gitignore` when the plugin creates the repository, so `git
 * status` in `$DSH_HOME` stays readable. It mirrors the allowlist below but
 * has no say over what is recorded.
 */
export const DEFAULT_GITIGNORE = `# Managed by dsh-plugin-safe-upgrade: track boot-critical config only.
/*
!/.gitignore
!/settings.yaml
!/AGENTS.md
!/cordis.patch.yml
!/.agent-presets/
!/profiles/
/profiles/*/*
!/profiles/*/package.json
!/profiles/*/pnpm-lock.yaml
!/profiles/*/pnpm-workspace.yaml
!/profiles/*/cordis.yml
!/profiles/*/cordis.patch.yml
/profiles/node_modules/
node_modules/
*.bak*
*.tmp-*
`

/** Config files directly in `$DSH_HOME`. */
export const HOME_CONFIG = ['.gitignore', 'settings.yaml', 'AGENTS.md', 'cordis.patch.yml']
/** Config files directly in each `$DSH_HOME/profiles/<name>`. */
export const PROFILE_CONFIG = ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'cordis.yml', 'cordis.patch.yml']
/** Directory whose whole tree is config. */
export const PRESETS_DIR = '.agent-presets'

/** Literal secrets that must never enter history. */
export const SECRET_PATTERNS = [
  /\bsk-[A-Za-z0-9_-]{20,}/,
  /\bgh[pousr]_[A-Za-z0-9]{30,}/,
  /\bgithub_pat_[A-Za-z0-9_]{30,}/,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\b\d{8,10}:AA[A-Za-z0-9_-]{30,}/, // Telegram bot token
  // `apiKey: abc...` / `token: "..."` with a literal value (not an env reference).
  /^\s*["']?(?:api[_-]?key|access[_-]?token|auth[_-]?token|token|secret|password|client[_-]?secret)["']?\s*[:=]\s*(?!!!js)["']?(?![$]\{)[A-Za-z0-9_\-./+=]{16,}/im,
]

/** Files larger than this are refused, not committed unscanned. */
export const MAX_SCAN_BYTES = 2 * 1024 * 1024
const AUTHOR = ['-c', 'user.name=dsh-safe-upgrade', '-c', 'user.email=safe-upgrade@localhost', '-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false']

/** @returns {boolean} whether `text` contains something that looks like a credential. */
export function containsSecret(text) {
  return SECRET_PATTERNS.some((pattern) => pattern.test(text))
}

/** @returns {boolean} whether the repo-relative `path` is config the history may record and restore. */
export function isConfigPath(path) {
  const parts = path.split('/')
  if (parts.some((part) => part === '' || part === '.' || part === '..' || part === '.git' || part === 'node_modules' || part.includes('.bak') || part.includes('.tmp-'))) {
    return false
  }
  if (parts.length === 1) return HOME_CONFIG.includes(parts[0])
  if (parts[0] === PRESETS_DIR) return true
  return parts.length === 3 && parts[0] === 'profiles' && PROFILE_CONFIG.includes(parts[2])
}

function entries(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
}

function lstatOrUndefined(path) {
  try {
    return lstatSync(path)
  } catch {
    return undefined
  }
}

/** @returns {string[]} sorted repo-relative config paths present under `root` (files and symlinks). */
export function listConfigFiles(root) {
  const found = []
  const add = (rel) => {
    const stat = lstatOrUndefined(join(root, rel))
    if (stat !== undefined && (stat.isFile() || stat.isSymbolicLink()) && isConfigPath(rel)) found.push(rel)
  }
  for (const name of HOME_CONFIG) add(name)
  for (const profile of entries(join(root, 'profiles'))) {
    if (!profile.isDirectory() || profile.name === 'node_modules') continue
    for (const name of PROFILE_CONFIG) add(`profiles/${profile.name}/${name}`)
  }
  const walk = (dir, rel, depth) => {
    if (depth > 12) return
    for (const entry of entries(dir)) {
      const childRel = `${rel}/${entry.name}`
      if (entry.isDirectory()) {
        if (isConfigPath(childRel)) walk(join(dir, entry.name), childRel, depth + 1)
      } else add(childRel)
    }
  }
  walk(join(root, PRESETS_DIR), PRESETS_DIR, 0)
  return found.sort()
}

/**
 * Read one file the way git would store it: a symlink as its target text,
 * a regular file as its bytes. Oversized files are reported, not read.
 * @returns {{mode: string, data?: Buffer, size?: number} | undefined} undefined when absent.
 */
export function readEntry(root, rel) {
  const path = join(root, rel)
  const stat = lstatOrUndefined(path)
  if (stat === undefined) return undefined
  if (stat.isSymbolicLink()) return { mode: '120000', data: Buffer.from(readlinkSync(path)) }
  if (!stat.isFile()) return undefined
  const mode = stat.mode & 0o111 ? '100755' : '100644'
  if (stat.size > MAX_SCAN_BYTES) return { mode, size: stat.size }
  const data = readFileSync(path)
  // It may have grown between stat and read: the limit applies to what was read.
  return data.length > MAX_SCAN_BYTES ? { mode, size: data.length } : { mode, data }
}

/** @returns {string} git's object id for a blob holding `data`. */
export function blobId(data, format = 'sha1') {
  return createHash(format === 'sha256' ? 'sha256' : 'sha1').update(`blob ${data.length}\0`).update(data).digest('hex')
}

/**
 * Write `data` at `root/rel` as a git entry of `mode`, replacing (never
 * writing through) whatever is there, and keeping an existing file's permissions.
 */
function writeEntry(root, rel, mode, data) {
  const path = join(root, rel)
  mkdirSync(dirname(path), { recursive: true })
  const existing = lstatOrUndefined(path)
  if (mode === '120000') {
    rmSync(path, { force: true })
    symlinkSync(data.toString(), path)
    return
  }
  let perms = existing?.isFile() ? existing.mode & 0o777 : 0o644
  perms = mode === '100755' ? perms | 0o111 : perms & ~0o111
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`
  writeFileSync(tmp, data, { mode: perms })
  chmodSync(tmp, perms)
  renameSync(tmp, path)
}

export class ConfigRepo {
  /**
   * @param {string} home - `$DSH_HOME`.
   * @param {{log?: (msg: string) => void, gitignore?: string}} [options]
   */
  constructor(home, { log = () => {}, gitignore = DEFAULT_GITIGNORE } = {}) {
    this.home = home
    this.log = log
    this.gitignore = gitignore
  }

  /** Run git in the repo; retries briefly while another process holds index.lock. */
  async git(args, { allowFail = false, timeoutMs = 60_000, env, input, binary } = {}) {
    for (let attempt = 0; ; attempt++) {
      const result = await run('git', ['-C', this.home, ...AUTHOR, ...args], {
        timeoutMs, input, binary, env: env === undefined ? undefined : { ...process.env, ...env },
      })
      if (result.code === 0) return result
      if (/index\.lock|could not lock/i.test(result.stderr) && attempt < 10) {
        await sleep(300)
        continue
      }
      if (allowFail) return result
      throw new Error(`git ${args.join(' ')} failed (${result.code}): ${result.stderr.trim()}`)
    }
  }

  exists() {
    return lstatOrUndefined(join(this.home, '.git')) !== undefined
  }

  /**
   * Create the repository on first use. An existing repository is adopted
   * as-is: its .gitignore is the owner's and is never rewritten.
   * @returns {Promise<{created: boolean, head?: string}>}
   */
  async ensure() {
    if (this.exists()) return { created: false }
    await this.git(['init', '-q'])
    const ignorePath = join(this.home, '.gitignore')
    if (lstatOrUndefined(ignorePath) === undefined) writeFileSync(ignorePath, this.gitignore, 'utf8')
    const head = await this.snapshot('safe-upgrade: initial config snapshot')
    return { created: true, head }
  }

  /** @returns {Promise<string | undefined>} HEAD sha, undefined before the first commit. */
  async head() {
    const result = await this.git(['rev-parse', '--verify', '-q', 'HEAD'], { allowFail: true })
    return result.code === 0 ? result.stdout.trim() : undefined
  }

  /** @returns {Promise<'sha1' | 'sha256'>} the repository's object format. */
  async objectFormat() {
    if (this._format === undefined) {
      const result = await this.git(['rev-parse', '--show-object-format'], { allowFail: true })
      this._format = result.stdout.trim() === 'sha256' ? 'sha256' : 'sha1'
    }
    return this._format
  }

  /**
   * @param {string} ref
   * @param {{all?: boolean}} [options] - `all`: include non-config paths.
   * @returns {Promise<Map<string, {mode: string, id: string}>>} the blobs in `ref`'s tree.
   */
  async treeEntries(ref, { all = false } = {}) {
    const result = await this.git(['ls-tree', '-r', '-z', '--full-tree', ref])
    const map = new Map()
    for (const record of result.stdout.split('\0')) {
      const tab = record.indexOf('\t')
      if (tab === -1) continue
      const [mode, type, id] = record.slice(0, tab).split(' ')
      const path = record.slice(tab + 1)
      if (type === 'blob' && (all || isConfigPath(path))) map.set(path, { mode, id })
    }
    return map
  }

  /**
   * Record the current config: every allowlisted file that changed since
   * HEAD, minus files that are too large to scan or look like they carry a
   * literal secret (those keep their last recorded version).
   * @param {string} message
   * @returns {Promise<string | undefined>} the new commit sha, or undefined when nothing changed.
   */
  async snapshot(message) {
    const format = await this.objectFormat()
    for (let attempt = 0; ; attempt++) {
      const head = await this.head()
      const recorded = head === undefined ? new Map() : await this.treeEntries(head)
      const changes = []
      const refused = []
      const present = listConfigFiles(this.home)
      for (const path of present) {
        let entry
        try {
          entry = readEntry(this.home, path)
        } catch {
          continue // vanished while we looked
        }
        if (entry === undefined) continue
        if (entry.data === undefined) {
          refused.push(`${path}: ${entry.size} bytes is over the ${MAX_SCAN_BYTES}-byte scan limit`)
          continue
        }
        const id = blobId(entry.data, format)
        const before = recorded.get(path)
        if (before !== undefined && before.id === id && before.mode === entry.mode) continue
        if (containsSecret(entry.data.toString('utf8'))) {
          refused.push(`${path}: it looks like it contains a literal secret`)
          continue
        }
        changes.push({ path, mode: entry.mode, id, data: entry.data })
      }
      for (const path of recorded.keys()) {
        if (lstatOrUndefined(join(this.home, path)) === undefined) changes.push({ path, remove: true })
      }
      for (const line of refused) this.log(`safe-upgrade: not committing ${line}`)
      if (changes.length === 0) return undefined

      for (const change of changes) {
        if (change.remove) continue
        const written = (await this.git(['hash-object', '-w', '--no-filters', '--stdin'], { input: change.data })).stdout.trim()
        if (written !== change.id) throw new Error(`git stored ${change.path} as ${written}, expected ${change.id}`)
      }
      const zero = '0'.repeat(format === 'sha256' ? 64 : 40)
      const indexInfo = changes.map((c) => (c.remove ? `0 ${zero}\t${c.path}\0` : `${c.mode} ${c.id}\t${c.path}\0`)).join('')

      // A private index: HEAD's tree plus exactly the scanned blobs. Whatever
      // sits in the real index (or the working tree) is never committed.
      const indexFile = join(this.home, '.git', `safe-upgrade-index-${process.pid}-${randomBytes(6).toString('hex')}`)
      let commit
      try {
        const env = { GIT_INDEX_FILE: indexFile }
        await this.git(head === undefined ? ['read-tree', '--empty'] : ['read-tree', head], { env })
        await this.git(['update-index', '-z', '--index-info'], { env, input: indexInfo })
        const tree = (await this.git(['write-tree'], { env })).stdout.trim()
        if (head !== undefined && tree === (await this.git(['rev-parse', `${head}^{tree}`])).stdout.trim()) return undefined
        const files = changes.map((c) => c.path)
        const body = files.length > 8 ? `${files.slice(0, 8).join(', ')} (+${files.length - 8} more)` : files.join(', ')
        commit = (await this.git(['commit-tree', tree, ...(head === undefined ? [] : ['-p', head]), '-m', message, '-m', body])).stdout.trim()
      } finally {
        rmSync(indexFile, { force: true })
      }
      // Compare-and-swap: a concurrent snapshot that moved HEAD makes us redo ours on top.
      const moved = await this.git(['update-ref', '-m', `safe-upgrade: ${message}`, 'HEAD', commit, head ?? ''], { allowFail: true })
      if (moved.code !== 0) {
        if (attempt < 3) continue
        throw new Error(`git update-ref HEAD failed: ${moved.stderr.trim()}`)
      }
      // Keep the real index in step so `git status` in $DSH_HOME stays clean.
      await this.git(['update-index', '-z', '--index-info'], { input: indexInfo, allowFail: true })
      return commit
    }
  }

  /** Create an annotated tag on HEAD whose message is JSON metadata. */
  async tag(name, meta = {}) {
    await this.git(['tag', '-a', '-f', name, '-m', JSON.stringify(meta)])
  }

  /**
   * @param {string} prefix - e.g. `good-`.
   * @returns {Promise<Array<{name: string, date: string, sha: string, meta: any}>>} newest first.
   */
  async listTags(prefix) {
    const format = '%(refname:short)%09%(creatordate:iso-strict)%09%(*objectname)%(objectname)%09%(contents:subject)'
    const result = await this.git(['for-each-ref', '--sort=-creatordate', `--format=${format}`, `refs/tags/${prefix}*`], { allowFail: true })
    return result.stdout.split('\n').filter(Boolean).map((line) => {
      const [name, date, sha, subject] = line.split('\t')
      let meta = {}
      try {
        meta = JSON.parse(subject)
      } catch {}
      // `%(*objectname)%(objectname)`: the peeled commit comes first for annotated tags.
      return { name, date, sha: sha.slice(0, sha.length % 64 === 0 ? 64 : 40), meta }
    })
  }

  /** Keep the newest `keep` tags with `prefix`, delete the rest. */
  async pruneTags(prefix, keep) {
    const tags = await this.listTags(prefix)
    for (const tag of tags.slice(keep)) await this.git(['tag', '-d', tag.name], { allowFail: true })
  }

  /** @returns {Promise<Array<{sha: string, date: string, subject: string}>>} newest first. */
  async recent(limit = 10) {
    const result = await this.git(['log', `-${limit}`, '--format=%H%x09%cI%x09%s'], { allowFail: true })
    return result.stdout.split('\n').filter(Boolean).map((line) => {
      const [sha, date, subject] = line.split('\t')
      return { sha, date, subject }
    })
  }

  /** @returns {Promise<boolean>} whether `ref` names a commit. */
  async hasRef(ref) {
    return (await this.git(['rev-parse', '--verify', '-q', `${ref}^{commit}`], { allowFail: true })).code === 0
  }

  /**
   * What a restore of `ref` would act on: config paths recorded at `ref` or
   * at HEAD. Files never recorded (a secret-bearing settings.yaml) are not
   * the history's to judge.
   */
  async restorePlan(ref) {
    const target = await this.treeEntries(ref)
    const head = await this.head()
    const recorded = head === undefined ? new Map() : await this.treeEntries(head)
    return { target, recorded, paths: [...new Set([...target.keys(), ...recorded.keys()])].sort() }
  }

  /** @returns {Promise<string[]>} config files that differ between `ref` and `root` (default `$DSH_HOME`). */
  async changedSince(ref, { root = this.home } = {}) {
    const format = await this.objectFormat()
    const { target, paths } = await this.restorePlan(ref)
    return paths.filter((path) => {
      const want = target.get(path)
      const have = readEntry(root, path)
      if (want === undefined || have === undefined) return want !== have
      return have.data === undefined || have.mode !== want.mode || blobId(have.data, format) !== want.id
    })
  }

  /**
   * Put the config files recorded at `ref` back into `root` (default
   * `$DSH_HOME`) and delete config files recorded since that `ref` lacks.
   * Nothing outside the allowlist is touched, even when an adopted
   * repository recorded it. In `$DSH_HOME`, a file whose current content is
   * not in history (skipped as a secret, or edited in the last instant) is
   * copied to `safe-upgrade/restore-backups/` before it is replaced.
   * @param {string} ref
   * @returns {Promise<string[]>} the files that changed.
   */
  async restore(ref, { root = this.home } = {}) {
    if (!(await this.hasRef(ref))) throw new Error(`unknown config ref ${ref}`)
    const format = await this.objectFormat()
    const { target, recorded, paths } = await this.restorePlan(ref)
    const backupDir = root === this.home ? join(stateDir(this.home), 'restore-backups', stamp()) : undefined
    const changed = []
    for (const path of paths) {
      const want = target.get(path)
      const have = readEntry(root, path)
      const current = have?.data === undefined ? undefined : blobId(have.data, format)
      if (want !== undefined && current === want.id && have.mode === want.mode) continue
      if (want === undefined && have === undefined) continue
      const inHistory = have === undefined || current === recorded.get(path)?.id
      if (!inHistory && backupDir !== undefined) {
        const copy = join(backupDir, path)
        mkdirSync(dirname(copy), { recursive: true, mode: 0o700 })
        writeFileSync(copy, have.data ?? readFileSync(join(root, path)), { mode: 0o600 })
        this.log(`safe-upgrade: ${path} was not in history; saved a copy to ${copy}`)
      }
      if (want === undefined) {
        rmSync(join(root, path), { force: true })
      } else {
        const blob = await this.git(['cat-file', 'blob', want.id], { binary: true })
        writeEntry(root, path, want.mode, blob.stdout)
      }
      changed.push(path)
    }
    return changed
  }
}
