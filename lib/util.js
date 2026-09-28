/**
 * Shared helpers: dsh path discovery, atomic JSON state files, env-file
 * parsing and a bounded child-process runner. Node built-ins only.
 * @module dsh-plugin-safe-upgrade/util
 */

import { execFile } from 'node:child_process'
import {
  closeSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync,
  realpathSync, renameSync, statSync, writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

export const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
export const PACKAGE_VERSION = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8')).version

/** @returns {string} `$DSH_HOME`, defaulting to `~/.dsh` like dsh itself. */
export function dshHome(env = process.env) {
  return env.DSH_HOME || join(env.HOME || homedir(), '.dsh')
}

/** @returns {string} this plugin's private state directory under `$DSH_HOME`. */
export function stateDir(home) {
  return join(home, 'safe-upgrade')
}

/** @returns {string} where the host half publishes the turns running in dsh. */
export function turnsPath(home) {
  return join(stateDir(home), 'turns.json')
}

/** A turn older than this is assumed to have ended without a `turn/end`. */
export const TURN_STALE_MS = 6 * 3600_000

/** @returns {boolean} whether `pid` names a live process (EPERM: alive, owned by someone else). */
export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

/** @returns {number} newest mtime (ms) under `$DSH_HOME/sessions`, 0 when none (bounded walk). */
export function lastSessionWrite(home) {
  let newest = 0
  let visited = 0
  const walk = (dir, depth) => {
    if (depth > 4 || visited > 20_000) return
    let entries = []
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      visited++
      const path = join(dir, entry.name)
      if (entry.isDirectory()) walk(path, depth + 1)
      else {
        try {
          newest = Math.max(newest, statSync(path).mtimeMs)
        } catch {}
      }
    }
  }
  walk(join(home, 'sessions'), 0)
  return newest
}

/**
 * Derive the dsh install directory (the folder whose `node_modules` holds
 * `@deepseek-ai/dsh`) from the running or configured dsh binary. Works for the
 * `.bin/dsh` symlink and for the resolved `lib/bin.js`.
 * @param {string | undefined} binPath
 * @returns {string | undefined}
 */
export function installDirFromBin(binPath) {
  if (typeof binPath !== 'string' || binPath.length === 0) return undefined
  let real
  try {
    real = realpathSync(binPath)
  } catch {
    return undefined
  }
  const marker = `${sep}node_modules${sep}@deepseek-ai${sep}dsh${sep}`
  const at = real.lastIndexOf(marker)
  return at === -1 ? undefined : real.slice(0, at)
}

/** @returns {string} the install's `dsh` launcher. */
export function dshBin(installDir) {
  return join(installDir, 'node_modules', '.bin', 'dsh')
}

/** @returns {string | undefined} the installed `@deepseek-ai/dsh` version. */
export function readDshVersion(installDir) {
  try {
    const manifest = join(installDir, 'node_modules', '@deepseek-ai', 'dsh', 'package.json')
    return JSON.parse(readFileSync(manifest, 'utf8')).version
  } catch {
    return undefined
  }
}

/** @returns {string[]} profile names under `$DSH_HOME/profiles` (dirs with a package.json). */
export function listProfiles(home) {
  const root = join(home, 'profiles')
  if (!existsSync(root)) return []
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== 'node_modules')
    .filter((entry) => existsSync(join(root, entry.name, 'package.json')))
    .map((entry) => entry.name)
    .sort()
}

/** Atomic JSON write (temp file + fsync + rename), mode 0600. */
export function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`
  const fd = openSync(tmp, 'w', 0o600)
  try {
    writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  renameSync(tmp, path)
}

/** @returns {any} parsed JSON, or `fallback` when missing or unreadable. */
export function readJson(path, fallback = undefined) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return fallback
  }
}

/**
 * Parse a systemd-style EnvironmentFile: KEY=VALUE lines, `#` comments,
 * optional single or double quotes, optional `export ` prefix.
 * @param {string} text
 * @returns {Record<string, string>}
 */
export function parseEnvFile(text) {
  const env = {}
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#') || line.startsWith(';')) continue
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line)
    if (match === null) continue
    let value = match[2]
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    env[match[1]] = value
  }
  return env
}

/** @returns {Record<string, string>} the parsed env file, or {} when unreadable. */
export function readEnvFile(path) {
  try {
    return parseEnvFile(readFileSync(path, 'utf8'))
  } catch {
    return {}
  }
}

/**
 * Run a command without a shell. Resolves with `{code, stdout, stderr}` and
 * never rejects on a non-zero exit, so callers decide what failure means.
 * @param {string} command
 * @param {string[]} args
 * `input` is written to the child's stdin; `binary: true` returns stdout as a Buffer.
 * @param {{cwd?: string, env?: Record<string,string>, timeoutMs?: number, input?: string | Buffer, binary?: boolean}} [options]
 * @returns {Promise<{code: number, stdout: string | Buffer, stderr: string}>}
 */
export function run(command, args, { cwd, env, timeoutMs = 120_000, input, binary = false } = {}) {
  return new Promise((resolve) => {
    const child = execFile(command, args, {
      cwd,
      env: env ?? process.env,
      timeout: timeoutMs,
      maxBuffer: 64 * 1024 * 1024,
      encoding: binary ? 'buffer' : 'utf8',
    }, (error, stdout, stderr) => {
      let code = 0
      stderr = String(stderr ?? '')
      if (error) code = typeof error.code === 'number' ? error.code : 1
      if (error && error.killed) stderr = `${stderr}\n[timed out after ${timeoutMs} ms]`
      if (error && typeof error.code === 'string') stderr = `${stderr}\n${error.message}`
      resolve({ code, stdout: stdout ?? (binary ? Buffer.alloc(0) : ''), stderr })
    })
    if (input !== undefined) {
      child.stdin?.on('error', () => {}) // a child that exits early must not crash us with EPIPE
      child.stdin?.end(input)
    }
  })
}

/** @returns {string} a sortable UTC stamp, e.g. `20260928-201104`. */
export function stamp(date = new Date()) {
  return date.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15)
}

/** @returns {number | undefined} mtime in ms, or undefined when missing. */
export function mtimeMs(path) {
  try {
    return statSync(path).mtimeMs
  } catch {
    return undefined
  }
}

/** @returns {string} the last `lines` lines of `text`. */
export function tail(text, lines = 40) {
  const all = String(text ?? '').trimEnd().split('\n')
  return all.slice(-lines).join('\n')
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
