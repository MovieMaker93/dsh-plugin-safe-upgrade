/**
 * Config history: a git repository in `$DSH_HOME` that tracks only the files
 * that decide whether dsh boots (settings, patches, profile manifests, agent
 * presets) — never sessions, credentials or caches. A secret guard unstages
 * any file that carries a literal key before it can be committed.
 * @module dsh-plugin-safe-upgrade/repo
 */

import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { run, sleep } from './util.js'

/**
 * Whitelist: ignore everything, then re-include boot-critical config. Profile
 * directories are re-included file by file so node_modules and module
 * fallbacks stay out without having to enumerate them.
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

const MAX_SCAN_BYTES = 2 * 1024 * 1024
const AUTHOR = ['-c', 'user.name=dsh-safe-upgrade', '-c', 'user.email=safe-upgrade@localhost', '-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false']

/** @returns {boolean} whether `text` contains something that looks like a credential. */
export function containsSecret(text) {
  return SECRET_PATTERNS.some((pattern) => pattern.test(text))
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
  async git(args, { allowFail = false, timeoutMs = 60_000 } = {}) {
    for (let attempt = 0; ; attempt++) {
      const result = await run('git', ['-C', this.home, ...AUTHOR, ...args], { timeoutMs })
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
    return existsSync(join(this.home, '.git'))
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
    if (!existsSync(ignorePath)) writeFileSync(ignorePath, this.gitignore, 'utf8')
    const head = await this.snapshot('safe-upgrade: initial config snapshot')
    return { created: true, head }
  }

  /** @returns {Promise<string | undefined>} HEAD sha, undefined before the first commit. */
  async head() {
    const result = await this.git(['rev-parse', '--verify', '-q', 'HEAD'], { allowFail: true })
    return result.code === 0 ? result.stdout.trim() : undefined
  }

  /**
   * Stage every tracked-by-whitelist change, drop secret-bearing files, and
   * commit when something is left.
   * @param {string} message
   * @returns {Promise<string | undefined>} the new commit sha, or undefined when nothing changed.
   */
  async snapshot(message) {
    await this.git(['add', '-A'])
    const staged = (await this.git(['diff', '--cached', '--name-only', '-z'])).stdout.split('\0').filter(Boolean)
    if (staged.length === 0) return undefined
    const head = await this.head()
    const skipped = []
    for (const file of staged) {
      const path = join(this.home, file)
      let text
      try {
        if (statSync(path).size > MAX_SCAN_BYTES) continue
        text = readFileSync(path, 'utf8')
      } catch {
        continue // deleted: nothing to scan
      }
      if (!containsSecret(text)) continue
      skipped.push(file)
      const inHead = head !== undefined && (await this.git(['cat-file', '-e', `HEAD:${file}`], { allowFail: true })).code === 0
      await this.git(inHead ? ['reset', '-q', 'HEAD', '--', file] : ['rm', '--cached', '-q', '--', file])
    }
    for (const file of skipped) this.log(`safe-upgrade: not committing ${file}: it looks like it contains a literal secret`)
    const remaining = (await this.git(['diff', '--cached', '--name-only'])).stdout.trim()
    if (remaining === '') return undefined
    const files = remaining.split('\n')
    const body = files.length > 8 ? `${files.slice(0, 8).join(', ')} (+${files.length - 8} more)` : files.join(', ')
    await this.git(['commit', '-q', '--no-verify', '-m', message, '-m', body])
    return this.head()
  }

  /** Create an annotated tag on HEAD whose message is JSON metadata. */
  async tag(name, meta = {}) {
    await this.git(['tag', '-a', '-f', name, '-m', JSON.stringify(meta)])
  }

  /** @returns {Promise<string[]>} tag names pointing at HEAD. */
  async tagsAtHead() {
    const result = await this.git(['tag', '--points-at', 'HEAD'], { allowFail: true })
    return result.stdout.split('\n').map((line) => line.trim()).filter(Boolean)
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
      return { name, date, sha: sha.slice(0, 40), meta }
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

  /** @returns {Promise<string[]>} files that differ between `ref` and the working tree. */
  async changedSince(ref) {
    const result = await this.git(['diff', '--name-only', ref, '--'], { allowFail: true })
    return result.stdout.split('\n').filter(Boolean)
  }

  /**
   * Put every tracked file back to its content at `ref` and delete tracked
   * files that did not exist there. Untracked and ignored files (sessions,
   * credentials, node_modules) are never touched.
   * @param {string} ref
   * @returns {Promise<string[]>} the files that changed.
   */
  async restore(ref) {
    if (!(await this.hasRef(ref))) throw new Error(`unknown config ref ${ref}`)
    const changed = await this.changedSince(ref)
    const atRef = new Set((await this.git(['ls-tree', '-r', '--name-only', ref])).stdout.split('\n').filter(Boolean))
    const tracked = (await this.git(['ls-files'])).stdout.split('\n').filter(Boolean)
    for (const file of tracked) {
      if (!atRef.has(file)) await this.git(['rm', '-q', '--', file], { allowFail: true })
    }
    await this.git(['checkout', ref, '--', '.'])
    return changed
  }
}
