/**
 * systemd plumbing: read the dsh unit (launch argv, environment), control it,
 * launch detached supervisor units, and install the boot guard.
 * @module dsh-plugin-safe-upgrade/systemd
 */

import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { readEnvFile, run } from './util.js'

/** @returns {string[]} `--user` for user-scope units, [] for system ones. */
function scopeArgs(scope) {
  return scope === 'user' ? ['--user'] : []
}

/** @returns {'user' | 'system'} the scope matching this process's privileges. */
export function defaultScope() {
  return typeof process.getuid === 'function' && process.getuid() !== 0 ? 'user' : 'system'
}

export async function systemctl(args, { scope = 'system', timeoutMs = 120_000 } = {}) {
  return run('systemctl', [...scopeArgs(scope), ...args], { timeoutMs })
}

/**
 * @returns {Promise<Record<string, string>>} the requested unit properties. A
 * property systemd prints once per value (EnvironmentFiles) is joined with newlines.
 */
export async function show(unit, properties, { scope } = {}) {
  const result = await systemctl(['show', unit, '--no-pager', ...properties.map((p) => `-p${p}`)], { scope })
  const values = {}
  for (const line of result.stdout.split('\n')) {
    const at = line.indexOf('=')
    if (at <= 0) continue
    const key = line.slice(0, at)
    const value = line.slice(at + 1)
    values[key] = values[key] ? (value === '' ? values[key] : `${values[key]}\n${value}`) : value
  }
  return values
}

/**
 * Parse `ExecStart={ path=... ; argv[]=a b c ; ... }` into argv.
 * @param {string} execStart
 * @returns {string[]}
 */
export function parseExecStart(execStart) {
  const match = /argv\[\]=(.*?) ;/.exec(execStart ?? '')
  if (match === null) return []
  return match[1].trim().split(/\s+/)
}

/**
 * The profile a dsh launch boots: `dsh web ...` → `web`,
 * `dsh --profile x ...` → `x`.
 * @param {string[]} argv
 * @returns {string | undefined}
 */
export function profileFromArgv(argv) {
  const args = argv.slice(1)
  const at = args.indexOf('--profile')
  if (at !== -1 && args[at + 1] !== undefined) return args[at + 1]
  const inline = args.find((arg) => arg.startsWith('--profile='))
  if (inline !== undefined) return inline.slice('--profile='.length)
  if (args[0] === 'web') return 'web'
  return undefined
}

/**
 * Parse systemd's `Environment=` property: space-separated KEY=VALUE words,
 * where systemd double-quotes a whole word that contains spaces
 * (`"GREETING=hello world"`) and backslash-escapes inside it.
 */
export function parseEnvironmentProperty(value) {
  const words = []
  let word = ''
  let started = false
  let quoted = false
  let escaped = false
  for (const ch of value ?? '') {
    if (escaped) {
      word += ch
      escaped = false
    } else if (ch === '\\') {
      escaped = true
    } else if (ch === '"') {
      quoted = !quoted
      started = true
    } else if (!quoted && /\s/.test(ch)) {
      if (started) words.push(word)
      word = ''
      started = false
    } else {
      word += ch
      started = true
    }
  }
  if (started) words.push(word)
  const env = {}
  for (const entry of words) {
    const at = entry.indexOf('=')
    if (at > 0 && /^[A-Za-z_][A-Za-z0-9_]*$/.test(entry.slice(0, at))) env[entry.slice(0, at)] = entry.slice(at + 1)
  }
  return env
}

/**
 * The environment systemd hands the unit's process: `Environment=` first,
 * then each `EnvironmentFile=` in order, whose values win (systemd.exec(5):
 * "Settings from these files override settings made with Environment=").
 * @param {{Environment?: string, EnvironmentFiles?: string}} props
 * @returns {Record<string, string>}
 */
export function unitEnvironment(props) {
  const env = parseEnvironmentProperty(props.Environment)
  for (const line of (props.EnvironmentFiles ?? '').split('\n')) {
    const path = line.replace(/\s*\(ignore_errors=\w+\)\s*$/, '').trim()
    if (path !== '') Object.assign(env, readEnvFile(path))
  }
  return env
}

/**
 * Everything needed to act on the dsh unit from outside it.
 * @returns {Promise<{argv: string[], env: Record<string,string>, profile?: string, user?: string, group?: string, mainPid: number, activeState: string}>}
 */
export async function describeUnit(unit, { scope } = {}) {
  const props = await show(unit, ['ExecStart', 'Environment', 'EnvironmentFiles', 'User', 'Group', 'MainPID', 'ActiveState'], { scope })
  const argv = parseExecStart(props.ExecStart)
  return {
    argv,
    env: unitEnvironment(props),
    profile: profileFromArgv(argv),
    user: props.User || undefined,
    group: props.Group || undefined,
    mainPid: Number(props.MainPID ?? 0),
    activeState: props.ActiveState ?? 'unknown',
  }
}

/**
 * Start `argv` as its own transient unit so it outlives a restart of dsh.
 * A system-scope unit started by an unprivileged process runs as that
 * process's user, never as root (systemd-run's default).
 * @param {{unit: string, argv: string[], env: Record<string,string>, scope?: string}} spec
 */
export async function launchTransient({ unit, argv, env, scope = 'system' }) {
  const setenv = Object.entries(env)
    .filter(([, value]) => value !== undefined && value !== '')
    .map(([key, value]) => `--setenv=${key}=${value}`)
  const uid = typeof process.getuid === 'function' ? process.getuid() : 0
  const identity = scope === 'system' && uid !== 0 ? [`--uid=${uid}`, `--gid=${process.getgid()}`] : []
  return run('systemd-run', [
    ...scopeArgs(scope), `--unit=${unit}`, '--collect', '--no-block', '--quiet',
    '--property=Type=exec', ...identity, ...setenv, ...argv,
  ], { timeoutMs: 30_000 })
}

export const DROPIN_NAME = '50-safe-upgrade.conf'
export const RECOVER_TEMPLATE = 'dsh-safe-upgrade-recover@.service'

/** @returns {string} the unit directory for the scope. */
export function unitDir(scope, env = process.env) {
  return scope === 'user' ? join(env.HOME ?? '', '.config', 'systemd', 'user') : '/etc/systemd/system'
}

/** @returns {string} the per-unit drop-in directory of the recovery template's instance. */
export function recoverInstanceDir(dir, unit) {
  return join(dir, `${RECOVER_TEMPLATE.replace('@.service', `@${unit}.service`)}.d`)
}

/**
 * Render the boot-guard drop-in, the recovery template and, for a system
 * unit with `User=`, the recovery instance's drop-in that runs recovery as
 * that same account. Without it, systemd would run recovery as root — root
 * executing plugin code the service account can write.
 * @param {{unit: string, node: string, cli: string, installDir: string, home: string, profile: string, scope: string, user?: string, group?: string}} spec
 */
export function renderGuard({ unit, node, cli, installDir, home, profile, scope, user, group }) {
  const dropin = `# Managed by dsh-plugin-safe-upgrade (install-guard). Remove with: dsh-safe-upgrade install-guard --remove --unit ${unit}
[Unit]
StartLimitIntervalSec=120
StartLimitBurst=3
OnFailure=dsh-safe-upgrade-recover@%N.service

[Service]
ExecStartPre=${node} ${cli} precheck --unit ${unit} --scope ${scope} --install-dir ${installDir} --home ${home} --profile ${profile}
`
  // Shared by every guarded unit: it resolves install dir and DSH_HOME from
  // the failed unit (%i) itself, so it carries nothing unit-specific.
  const recover = `# Managed by dsh-plugin-safe-upgrade (install-guard). Shared by every guarded dsh unit.
[Unit]
Description=Roll %i back to its last known-good dsh config

[Service]
Type=oneshot
ExecStart=${node} ${cli} auto-rollback --unit %i --scope ${scope}
`
  const unprivileged = scope === 'system' && user !== undefined && user !== '' && user !== 'root' && user !== '0'
  const recoverDropin = unprivileged
    ? `# Managed by dsh-plugin-safe-upgrade (install-guard): recovery for ${unit} runs as its service account.
[Service]
User=${user}
${group ? `Group=${group}\n` : ''}`
    : undefined
  return { dropin, recover, recoverDropin }
}

/** @returns {string[]} units in `dir` that still carry the guard drop-in. */
export function guardedUnits(dir) {
  if (!existsSync(dir)) return []
  const recoverPrefix = RECOVER_TEMPLATE.replace('.service', '')
  return readdirSync(dir)
    .filter((name) => name.endsWith('.service.d') && !name.startsWith(recoverPrefix) && existsSync(join(dir, name, DROPIN_NAME)))
    .map((name) => name.slice(0, -'.service.d'.length))
}

/**
 * Install (or remove) the guard files and reload systemd.
 * @returns {Promise<{dropinPath: string, recoverPath: string}>}
 */
export async function installGuard(spec, { remove = false, dir = unitDir(spec.scope), reload = true } = {}) {
  const dropinDir = join(dir, `${spec.unit}.service.d`)
  const dropinPath = join(dropinDir, DROPIN_NAME)
  const recoverPath = join(dir, RECOVER_TEMPLATE)
  const recoverDropinPath = join(recoverInstanceDir(dir, spec.unit), DROPIN_NAME)
  if (remove) {
    rmSync(dropinPath, { force: true })
    rmSync(recoverDropinPath, { force: true })
    // The recovery template is shared: keep it while another unit is guarded.
    if (guardedUnits(dir).length === 0) rmSync(recoverPath, { force: true })
  } else {
    const { dropin, recover, recoverDropin } = renderGuard(spec)
    mkdirSync(dropinDir, { recursive: true })
    writeFileSync(dropinPath, dropin, 'utf8')
    writeFileSync(recoverPath, recover, 'utf8')
    if (recoverDropin === undefined) rmSync(recoverDropinPath, { force: true })
    else {
      mkdirSync(dirname(recoverDropinPath), { recursive: true })
      writeFileSync(recoverDropinPath, recoverDropin, 'utf8')
    }
  }
  if (reload) {
    const result = await systemctl(['daemon-reload'], { scope: spec.scope })
    if (result.code !== 0) throw new Error(`systemctl daemon-reload failed: ${result.stderr.trim()}`)
  }
  return {
    dropinPath,
    recoverPath,
    recoverDropinPath: existsSync(recoverDropinPath) ? recoverDropinPath : undefined,
    kept: remove && existsSync(recoverPath),
  }
}

/** @returns {boolean} whether the guard drop-in is present. */
export function guardInstalled(unit, scope) {
  return existsSync(join(unitDir(scope), `${unit}.service.d`, DROPIN_NAME))
}
