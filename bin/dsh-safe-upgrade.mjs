#!/usr/bin/env node
/**
 * dsh-safe-upgrade CLI.
 *
 *   status                         versions, guard, last jobs, known-good tags
 *   upgrade [version|latest|next]  guarded upgrade (--dry-run to only validate)
 *   rollback <ref>                 restore a good-* tag, pre-* tag or commit
 *   check-ui                       load the web UI in headless Chromium and report
 *   precheck --profile <p>         dump-config the profile (used as ExecStartPre)
 *   install-guard [--remove]       add/remove the systemd boot guard
 *   auto-rollback                  recovery entry point for the boot guard
 *
 * Common options: --unit <name> (default dsh), --scope system|user,
 * --install-dir <dir>, --home <DSH_HOME>, --foreground,
 * --force (skip both idle checks: at request time and right before the stop).
 */

import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  JobRunner, activeLock, createJob, listJobs, markerPath,
} from '../lib/engine.js'
import { healthUrlFromArgv } from '../lib/index.js'
import { DEFAULT_REGISTRY } from '../lib/registry.js'
import { ConfigRepo } from '../lib/repo.js'
import {
  defaultScope, describeUnit, guardInstalled, installGuard, launchTransient,
} from '../lib/systemd.js'
import {
  PACKAGE_ROOT, dshBin, dshHome, installDirFromBin, lastSessionWrite, listProfiles, readDshVersion, readJson,
  run, sleep, stateDir, tail,
} from '../lib/util.js'

const CLI_PATH = realpathSync(fileURLToPath(import.meta.url))

function parseArgs(argv) {
  const positional = []
  const flags = {}
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (!arg.startsWith('--')) {
      positional.push(arg)
      continue
    }
    const [key, inline] = arg.slice(2).split('=', 2)
    if (inline !== undefined) flags[key] = inline
    else if (argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) flags[key] = argv[++i]
    else flags[key] = true
  }
  return { positional, flags }
}

function fail(message, code = 1) {
  console.error(`dsh-safe-upgrade: ${message}`)
  process.exit(code)
}

/** Resolve unit, install dir, home and profile from flags and the unit itself. */
async function resolveContext(flags) {
  const unit = typeof flags.unit === 'string' ? flags.unit : 'dsh'
  const scope = flags.scope === 'user' || flags.scope === 'system' ? flags.scope : defaultScope()
  const described = await describeUnit(unit, { scope }).catch(() => ({ argv: [], env: {} }))
  const home = typeof flags.home === 'string' ? flags.home : described.env.DSH_HOME ?? dshHome()
  const installDir = typeof flags['install-dir'] === 'string' ? flags['install-dir'] : installDirFromBin(described.argv[0])
  const saved = readJson(join(stateDir(home), 'config.json'), {})
  return {
    unit,
    scope,
    home,
    installDir,
    user: described.user,
    group: described.group,
    profile: typeof flags.profile === 'string' ? flags.profile : described.profile ?? 'web',
    context: {
      home,
      installDir,
      unit,
      scope,
      profiles: saved.profiles ?? listProfiles(home),
      healthUrl: saved.healthUrl ?? healthUrlFromArgv(described.argv) ?? 'http://127.0.0.1:3080/',
      healthTimeoutMs: saved.healthTimeoutMs ?? 150_000,
      idleWaitMs: saved.idleWaitMs ?? 300_000,
      registry: saved.registry ?? DEFAULT_REGISTRY,
      keepPrev: saved.keepPrev ?? 2,
      telegram: saved.telegram,
      failOnWarnings: saved.failOnWarnings === true,
      uiCheck: saved.uiCheck ?? 'auto',
      chromium: saved.chromium,
      uiTimeoutMs: saved.uiTimeoutMs ?? 45_000,
      requireMarker: existsSync(markerPath(home)),
      simulateFailure: typeof flags['simulate-failure'] === 'string' ? flags['simulate-failure'] : undefined,
    },
  }
}

function requireIdle(home, force) {
  if (force) return
  const lock = activeLock(home)
  if (lock !== undefined) fail(`job ${lock.id} is already running`)
  const quietFor = Date.now() - lastSessionWrite(home)
  if (quietFor < 120_000) {
    fail(`a session was written ${Math.round(quietFor / 1000)}s ago — a turn may be running. Retry when idle or pass --force.`)
  }
}

/** Launch the job in its own unit (so restarting dsh can't kill it) and follow its log. */
async function launchAndFollow(resolved, kind, request, flags) {
  const { home } = resolved
  const { id, path } = createJob(home, kind, request, resolved.context)
  if (flags.foreground) {
    const runner = new JobRunner(readJson(path), path, { log: (line) => console.log(line) })
    await runner.runJob()
    return runner.job
  }
  const launched = await launchTransient({
    unit: `dsh-safe-upgrade-${id}`,
    argv: [process.execPath, join(PACKAGE_ROOT, 'lib', 'supervisor.mjs'), '--job', path],
    env: { DSH_HOME: home, HOME: process.env.HOME, PATH: process.env.PATH },
    scope: resolved.scope,
  })
  if (launched.code !== 0) fail(`could not start supervisor unit: ${launched.stderr.trim()}`)
  console.log(`job ${id} running in unit dsh-safe-upgrade-${id} (safe to disconnect; follow with journalctl -fu dsh-safe-upgrade-${id})`)
  const logPath = path.replace(/\.json$/, '.log')
  let printed = 0
  for (;;) {
    await sleep(1500)
    if (existsSync(logPath)) {
      const lines = readFileSync(logPath, 'utf8').split('\n').filter(Boolean)
      for (const line of lines.slice(printed)) console.log(line)
      printed = lines.length
    }
    const job = readJson(path)
    if (job && ['ok', 'noop', 'rolled-back', 'failed'].includes(job.status)) return job
  }
}

function printJob(job) {
  console.log(`\nresult: ${job.status}${job.failedStep ? ` (failed at ${job.failedStep})` : ''}`)
  if (job.fromVersion || job.toVersion) console.log(`version: ${job.fromVersion ?? '?'} -> ${job.toVersion ?? '?'}`)
  if (job.error) console.log(`error: ${job.error}`)
  if (job.rollbackError) console.log(`rollback error: ${job.rollbackError}`)
  if (job.report) console.log(`report: ${JSON.stringify(job.report)}`)
  for (const warning of job.warnings ?? []) console.log(`warning (${warning.source}): ${warning.text}`)
}

async function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2))
  const command = positional[0]
  if (command === undefined || flags.help) {
    const header = readFileSync(CLI_PATH, 'utf8').split('\n')
    console.log(header.slice(2, header.indexOf(' */')).map((l) => l.replace(/^ \* ?/, '')).join('\n'))
    return
  }
  const resolved = await resolveContext(flags)
  const { home, installDir, unit, scope } = resolved

  switch (command) {
    case 'status': {
      const repo = new ConfigRepo(home)
      console.log(`unit:        ${unit} (${scope})`)
      console.log(`DSH_HOME:    ${home}`)
      console.log(`install:     ${installDir ?? '(not found)'}`)
      console.log(`dsh version: ${installDir ? readDshVersion(installDir) : '?'}`)
      console.log(`boot guard:  ${guardInstalled(unit, scope) ? 'installed' : 'not installed'}`)
      const marker = readJson(markerPath(home))
      if (marker) {
        const problems = [...(marker.failed ?? []), ...(marker.pending ?? []).map((p) => `${p} still loading`), ...(marker.brokenPresets ?? [])]
        console.log(`last boot:   ${marker.writtenAt} ${marker.healthy ? 'healthy' : `UNHEALTHY: ${problems.join('; ')}`}`)
      }
      if (repo.exists()) {
        const good = await repo.listTags('good-')
        console.log(`good tags:   ${good.slice(0, 3).map((t) => `${t.name} (dsh ${t.meta.dshVersion ?? '?'})`).join(', ') || 'none'}`)
        for (const commit of await repo.recent(5)) console.log(`  ${commit.sha.slice(0, 8)} ${commit.date} ${commit.subject}`)
      } else console.log('history:     not started (starts on the first boot with the plugin)')
      for (const job of listJobs(home, 5)) console.log(`job ${job.id}: ${job.kind}${job.request?.dryRun ? ' (dry run)' : ''} ${job.status}${job.failedStep ? ` @${job.failedStep}` : ''}`)
      return
    }
    case 'upgrade': {
      if (!installDir) fail(`cannot find the dsh install for unit ${unit}; pass --install-dir`)
      const target = positional[1] ?? 'latest'
      if (!flags['dry-run']) requireIdle(home, flags.force)
      const job = await launchAndFollow(resolved, 'upgrade', { target, dryRun: flags['dry-run'] === true, force: flags.force === true }, flags)
      printJob(job)
      process.exit(job.status === 'ok' || job.status === 'noop' ? 0 : 1)
    }
    case 'rollback': {
      const ref = positional[1]
      if (!ref) fail('usage: dsh-safe-upgrade rollback <ref>   (see `status` for good-* tags)')
      if (!installDir) fail(`cannot find the dsh install for unit ${unit}; pass --install-dir`)
      requireIdle(home, flags.force)
      const job = await launchAndFollow(resolved, 'rollback', { ref, force: flags.force === true }, flags)
      printJob(job)
      process.exit(job.status === 'ok' ? 0 : 1)
    }
    case 'check-ui': {
      // Same check the upgrade runs after a boot, against the running unit.
      const runner = new JobRunner({ id: 'check-ui', context: { ...resolved.context, uiCheck: true }, steps: [] }, join(stateDir(home), 'check-ui.json'))
      const sinceMs = Date.now() - 7 * 24 * 3600_000 // newest login URL in the unit's journal
      try {
        const result = await runner.checkUi(sinceMs)
        console.log(`web UI ok (${result.ms} ms)`)
      } catch (error) {
        fail(error.message)
      }
      return
    }
    case 'precheck': {
      if (!installDir) fail('precheck needs --install-dir')
      const result = await run(dshBin(installDir), ['--profile', resolved.profile, '--dump-config'], {
        env: { ...process.env, DSH_HOME: home }, timeoutMs: 120_000,
      })
      if (result.code !== 0) {
        console.error(`dsh-safe-upgrade precheck: profile ${resolved.profile} does not compose:\n${tail(result.stderr || result.stdout, 25)}`)
        process.exit(1)
      }
      console.log(`dsh-safe-upgrade precheck: profile ${resolved.profile} composes`)
      return
    }
    case 'install-guard': {
      if (!installDir) fail(`cannot find the dsh install for unit ${unit}; pass --install-dir`)
      // Recovery runs as the unit's own account (see renderGuard), never as root for an unprivileged dsh.
      const spec = { unit, scope, node: process.execPath, cli: CLI_PATH, installDir, home, profile: resolved.profile, user: resolved.user, group: resolved.group }
      if (!flags.remove) {
        const check = await run(dshBin(installDir), ['--profile', resolved.profile, '--dump-config'], {
          env: { ...process.env, DSH_HOME: home }, timeoutMs: 120_000,
        })
        if (check.code !== 0) fail(`refusing to install: profile ${resolved.profile} does not compose right now:\n${tail(check.stderr, 15)}`)
      }
      const paths = await installGuard(spec, { remove: flags.remove === true })
      if (flags.remove) {
        console.log(`removed ${paths.dropinPath}${paths.kept ? ` (kept ${paths.recoverPath}: another unit is still guarded)` : ` and ${paths.recoverPath}`}`)
      } else {
        console.log(`installed ${paths.dropinPath}\ninstalled ${paths.recoverPath}`)
        if (paths.recoverDropinPath) {
          console.log(`installed ${paths.recoverDropinPath} (recovery runs as ${resolved.user}, like ${unit})`)
          console.log(`Recovery restarts ${unit} as ${resolved.user}: that account needs permission to manage ${unit}.service (polkit; see README).`)
        }
        console.log(`It takes effect on the next (re)start of ${unit}. Re-run install-guard if you change ${unit}'s User=.`)
      }
      return
    }
    case 'auto-rollback': {
      const lock = activeLock(home)
      if (lock !== undefined) {
        console.log(`job ${lock.id} is running; it owns recovery. Nothing to do.`)
        return
      }
      if (!installDir) fail('auto-rollback needs --install-dir')
      const { path } = createJob(home, 'auto-rollback', {}, resolved.context)
      const runner = new JobRunner(readJson(path), path, { log: (line) => console.log(line) })
      await runner.runJob()
      printJob(runner.job)
      process.exit(runner.job.status === 'ok' ? 0 : 1)
    }
    default:
      fail(`unknown command ${command} (try --help)`, 2)
  }
}

await main()
