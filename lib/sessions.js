/**
 * Session compatibility: which stored sessions a dsh install can open, which
 * agent presets they were recorded under, and which presets a composed
 * config defines. An upgrade compares the running install with the target
 * before any downtime; a rollback warns about sessions an older session
 * format cannot list.
 *
 * Opening sessions uses the install's own session store in a child process
 * (lib/session-probe.mjs), so migration rules are exactly that version's.
 * @module dsh-plugin-safe-upgrade/sessions
 */

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { PACKAGE_ROOT, run } from './util.js'

const PRESET_PACKAGE = '@deepseek-ai/dsh-agent-preset'
const REGISTRY_PACKAGE = '@deepseek-ai/dsh-agent-preset-registry'
const GENERATION_FILE = /^session(?:\.v(\d+))?\.jsonl(?:\.zstd)?$/

/**
 * Resolve a package's ESM entry inside an install (package.json `exports["."]`, then `main`).
 * @returns {string} absolute file path of the entry.
 */
export function packageEntry(installDir, name) {
  const dir = join(installDir, 'node_modules', ...name.split('/'))
  const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
  let target = manifest.exports?.['.'] ?? manifest.exports ?? manifest.module ?? manifest.main ?? 'index.js'
  while (target !== null && typeof target === 'object') target = target.import ?? target.default ?? target.node
  if (typeof target !== 'string') throw new Error(`${name}: no ESM entry in ${join(dir, 'package.json')}`)
  return join(dir, target)
}

/** @returns {string} the entry as a URL for `import()`. */
export function packageEntryUrl(installDir, name) {
  return pathToFileURL(packageEntry(installDir, name)).href
}

/** @returns {number | undefined} the session format an install writes (`SESSION_FORMAT_VERSION`). */
export function installFormatVersion(installDir) {
  try {
    const match = /\bSESSION_FORMAT_VERSION = (\d+)/.exec(readFileSync(packageEntry(installDir, '@deepseek-ai/dsh-session'), 'utf8'))
    return match === null ? undefined : Number(match[1])
  } catch {
    return undefined // not a dsh with a versioned session format
  }
}

/**
 * Newest stored generation per session directory: `session.jsonl[.zstd]` is
 * format 0, `session.vN.jsonl[.zstd]` format N.
 * @returns {Array<{dir: string, version: number}>}
 */
export function sessionGenerations(root) {
  const found = []
  const list = (dir) => {
    try {
      return readdirSync(dir, { withFileTypes: true })
    } catch {
      return []
    }
  }
  for (const project of list(root)) {
    if (!project.isDirectory()) continue
    for (const session of list(join(root, project.name))) {
      if (!session.isDirectory()) continue
      let newest
      for (const file of list(join(root, project.name, session.name))) {
        const match = GENERATION_FILE.exec(file.name)
        if (match !== null) newest = Math.max(newest ?? 0, Number(match[1] ?? 0))
      }
      if (newest !== undefined) found.push({ dir: join(project.name, session.name), version: newest })
    }
  }
  return found
}

/**
 * Open every session under `root` with the install's own session store.
 * @returns {Promise<{ok: true, listed: number, unreadable: Array<{id: string, cwd?: string, child: boolean, error: string}>, presets: Record<string, number>}
 *   | {ok: false, error: string}>}
 */
export async function probeSessions(installDir, root, { timeoutMs = 900_000 } = {}) {
  const result = await run(process.execPath, [join(PACKAGE_ROOT, 'lib', 'session-probe.mjs'), installDir, root], { timeoutMs })
  const line = result.stdout.trim().split('\n').pop() ?? ''
  try {
    const parsed = JSON.parse(line)
    if (parsed.ok === true || parsed.ok === false) return parsed
  } catch {
    // Not a probe answer: report the process failure below.
  }
  return { ok: false, error: (result.stderr.trim() || `session probe exited ${result.code}`).split('\n').slice(-3).join(' ') }
}

/** Top-level `- id:` entries of a `--dump-config` output, comments dropped. */
function dumpEntries(text) {
  const entries = []
  let current
  for (const line of String(text).split('\n')) {
    if (/^\s*#/.test(line)) continue
    if (line.startsWith('- id: ')) {
      current = [line]
      entries.push(current)
    } else if (current !== undefined && line.startsWith('  ')) {
      current.push(line)
    } else if (line.trim() !== '') {
      current = undefined
    }
  }
  return entries
}

const unquote = (value) => value.trim().replace(/^(['"])(.*)\1$/, '$2')

function entryField(lines, indent, key) {
  const prefix = `${' '.repeat(indent)}${key}:`
  const line = lines.find((row) => row.startsWith(`${prefix} `) || row === prefix)
  return line === undefined ? undefined : unquote(line.slice(prefix.length))
}

/**
 * Agent presets a composed config defines, from `dsh --dump-config` output.
 * @returns {{defined: string[], defaultId?: string, rows: Map<string, string[]>} | undefined}
 *   undefined when the config has no agent preset registry (dsh before 0.1.7 read presets from directories).
 */
export function presetsFromDump(text) {
  const entries = dumpEntries(text)
  const registry = entries.find((lines) => entryField(lines, 2, 'name') === REGISTRY_PACKAGE)
  if (registry === undefined) return undefined
  const rows = new Map()
  for (const lines of entries) {
    if (entryField(lines, 2, 'name') !== PRESET_PACKAGE || entryField(lines, 2, 'disabled') === 'true') continue
    const configAt = lines.indexOf('  config:')
    const id = configAt === -1 ? undefined : entryField(lines.slice(configAt + 1), 4, 'id')
    if (id !== undefined) rows.set(id, lines)
  }
  const configAt = registry.indexOf('  config:')
  const defaultId = configAt === -1 ? undefined : entryField(registry.slice(configAt + 1), 4, 'default')
  return { defined: [...rows.keys()], defaultId, rows }
}

/**
 * A profile patch inserting one preset row per `ids`, each a copy of the
 * `sourceId` preset (default: the registry default) under the retired ID.
 * @returns {string} YAML to append to the profile's `cordis.patch.yml`.
 */
export function legacyPresetPatch(dumpText, ids, { sourceId, dshVersion } = {}) {
  const presets = presetsFromDump(dumpText)
  if (presets === undefined) throw new Error('this dsh config has no agent preset registry')
  const source = sourceId ?? presets.defaultId
  const lines = source === undefined ? undefined : presets.rows.get(source)
  if (lines === undefined) throw new Error(`no "${source}" preset to copy`)
  const configAt = lines.indexOf('  config:')
  const body = lines.slice(configAt + 1).filter((line) => !/^ {4}(id|name|description|order):/.test(line))
  const items = ids.map((id) => [
    `- id: preset-${id}`,
    `  name: '${PRESET_PACKAGE}'`,
    '  config:',
    `    id: ${JSON.stringify(id)}`,
    `    name: ${JSON.stringify(`${id} (legacy)`)}`,
    `    description: ${JSON.stringify(`Copy of the "${source}" preset, added by dsh-safe-upgrade so sessions recorded under "${id}" can be continued.`)}`,
    '    order: 99',
    ...body,
  ].map((line) => `    ${line}`).join('\n'))
  return [
    '',
    `# Added by dsh-safe-upgrade: legacy presets for sessions recorded under ${ids.join(', ')},`,
    `# which dsh${dshVersion ? ` ${dshVersion}` : ''} does not define. Each copies the "${source}" preset.`,
    '# Remove a row once no session needs it.',
    '- insert:',
    ...items,
    '',
  ].join('\n')
}

/**
 * `existing` profile patch text with `rows` (block-style YAML list entries)
 * added. dsh initializes a profile patch as comments plus `[]`, an empty flow
 * sequence that block entries cannot follow, so the rows replace that line.
 * @returns {string} the new patch text.
 */
export function withPatchRows(existing, rows) {
  const lines = String(existing).split('\n')
  const content = lines.filter((line) => line.trim() !== '' && !line.trim().startsWith('#'))
  if (content.length === 1 && content[0].trim() === '[]') {
    return `${lines.filter((line) => line.trim() !== '[]').join('\n').replace(/\n*$/, '\n')}${rows}`
  }
  return `${existing}${existing === '' || existing.endsWith('\n') ? '' : '\n'}${rows}`
}

/** Add block-style `rows` to the patch file at `path` (see withPatchRows). */
export function appendPatchRows(path, rows) {
  const existing = existsSync(path) ? readFileSync(path, 'utf8') : ''
  writeFileSync(path, withPatchRows(existing, rows), 'utf8')
}

/**
 * Compare probes of the running and target installs over the same sessions.
 * @param {object} before - probe of the running install.
 * @param {object} after - probe of the target install.
 * @param {string[] | undefined} defined - presets the target config defines (undefined: not checkable).
 * @returns {{regressions: object[], missingPresets: Record<string, number>, alreadyUnreadable: number}}
 */
export function compareProbes(before, after, defined) {
  const brokenBefore = new Set(before.ok ? before.unreadable.map((row) => row.id) : [])
  const regressions = after.ok ? after.unreadable.filter((row) => before.ok && !brokenBefore.has(row.id)) : []
  const missingPresets = {}
  if (after.ok && defined !== undefined) {
    for (const [id, count] of Object.entries(after.presets)) if (!defined.includes(id)) missingPresets[id] = count
  }
  return { regressions, missingPresets, alreadyUnreadable: brokenBefore.size }
}

/** @returns {boolean} whether `root` holds any session directory. */
export function hasSessions(root) {
  return existsSync(root) && sessionGenerations(root).length > 0
}
