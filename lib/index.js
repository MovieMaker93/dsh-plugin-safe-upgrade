/**
 * dsh-plugin-safe-upgrade: host half.
 *
 * - Keeps boot-critical config under git in $DSH_HOME and snapshots every edit.
 * - After each boot, checks the Loader for failed plugins and broken presets,
 *   writes a boot marker, and tags healthy boots `good-<stamp>`.
 * - Tracks running turns so upgrades and rollbacks only start while idle.
 * - Checks npm for new dsh releases.
 * - Serves authenticated routes that launch the upgrade/rollback engine in its
 *   own transient systemd unit, so it survives restarting dsh.
 * @module dsh-plugin-safe-upgrade
 */

import { readFileSync, watch } from 'node:fs'
import { join } from 'node:path'
import {
  activeLock, createJob, listJobs, markerPath,
} from './engine.js'
import { DEFAULT_REGISTRY, fetchDistTags } from './registry.js'
import { ConfigRepo } from './repo.js'
import { newer, valid } from './semver.js'
import { guardInstalled, launchTransient } from './systemd.js'
import {
  PACKAGE_ROOT, PACKAGE_VERSION, dshHome, installDirFromBin, listProfiles, readDshVersion,
  readJson, sleep, stamp, stateDir, writeJson,
} from './util.js'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'safe-upgrade'

const FIBER = { PENDING: 0, LOADING: 1, ACTIVE: 2, FAILED: 3 }
const HOME_FILES = new Set(['settings.yaml', 'AGENTS.md', 'cordis.patch.yml'])
const PROFILE_FILES = new Set(['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'cordis.yml', 'cordis.patch.yml'])
const REF = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,120}$/
const TURN_STALE_MS = 6 * 3600_000

/**
 * The systemd unit this process runs in, from /proc/self/cgroup.
 * @returns {{unit: string, scope: 'system' | 'user'} | undefined}
 */
export function detectUnit(cgroupText) {
  let text = cgroupText
  if (text === undefined) {
    try {
      text = readFileSync('/proc/self/cgroup', 'utf8')
    } catch {
      return undefined
    }
  }
  const path = text.split('\n').map((line) => line.split(':').slice(2).join(':')).find((p) => p.includes('.service'))
  if (path === undefined) return undefined
  const services = path.split('/').filter((part) => part.endsWith('.service'))
  const own = services[services.length - 1]
  if (own === undefined || /^user@\d+\.service$/.test(own)) return undefined
  return { unit: own.replace(/\.service$/, ''), scope: path.includes('/user@') ? 'user' : 'system' }
}

/** `--port`/`--host` of this dsh web launch → the health URL. */
export function healthUrlFromArgv(argv) {
  const value = (flag) => {
    const at = argv.indexOf(flag)
    if (at !== -1) return argv[at + 1]
    const inline = argv.find((arg) => arg.startsWith(`${flag}=`))
    return inline?.slice(flag.length + 1)
  }
  const port = value('--port')
  if (port === undefined) return undefined
  let host = value('--host') ?? '127.0.0.1'
  if (host === '0.0.0.0' || host === '::') host = '127.0.0.1'
  if (host.includes(':') && !host.startsWith('[')) host = `[${host}]`
  return `http://${host}:${port}/`
}

/** Merge the row config over auto-detected defaults. */
export function resolveConfig(raw = {}, { home = dshHome(), argv = process.argv, cgroup } = {}) {
  const detected = detectUnit(cgroup)
  const at = argv.indexOf('--profile')
  const profile = at !== -1 ? argv[at + 1] : argv.slice(2).includes('web') ? 'web' : undefined
  return {
    home,
    unit: raw.unit ?? detected?.unit,
    scope: raw.scope ?? detected?.scope ?? 'system',
    installDir: raw.installDir ?? installDirFromBin(argv[1]),
    profile,
    profiles: Array.isArray(raw.profiles) ? raw.profiles : listProfiles(home),
    healthUrl: raw.healthUrl ?? healthUrlFromArgv(argv) ?? 'http://127.0.0.1:3080/',
    healthTimeoutMs: raw.healthTimeoutMs ?? 150_000,
    channel: raw.channel ?? 'latest',
    checkIntervalHours: raw.checkIntervalHours ?? 6,
    registry: raw.registry ?? DEFAULT_REGISTRY,
    keepPrev: raw.keepPrev ?? 2,
    keepGoodTags: raw.keepGoodTags ?? 10,
    snapshots: raw.snapshots !== false,
    telegram: raw.telegram,
    failOnWarnings: raw.failOnWarnings === true,
    testing: raw.testing === true,
  }
}

/** Compact job view for the client. */
function summarizeJob(job) {
  if (job === undefined) return undefined
  return {
    id: job.id,
    kind: job.kind,
    dryRun: job.request?.dryRun === true,
    target: job.request?.target ?? job.request?.ref ?? job.report?.ref,
    status: job.status,
    fromVersion: job.fromVersion,
    toVersion: job.toVersion,
    createdAt: job.createdAt,
    finishedAt: job.finishedAt,
    failedStep: job.failedStep,
    error: job.error,
    warnings: (job.warnings ?? []).map((warning) => warning.text),
    steps: (job.steps ?? []).map((step) => `${step.name}:${step.status}`),
  }
}

export function apply(ctx, rawConfig) {
  const config = resolveConfig(rawConfig ?? {})
  const { home } = config
  const log = (message) => console.log(`[safe-upgrade] ${message}`)
  const warn = (message) => console.warn(`[safe-upgrade] ${message}`)
  const repo = new ConfigRepo(home, { log: warn })
  const running = new Map()
  const tags = { value: undefined, checkedAt: undefined, error: undefined }
  let bootMarker

  // The CLI and the boot guard run outside dsh: leave them the resolved
  // settings (no secrets — telegram holds env var names / an env file path).
  try {
    const { home: _home, testing: _testing, ...shared } = config
    writeJson(join(stateDir(home), 'config.json'), shared)
  } catch (error) {
    warn(`could not write ${stateDir(home)}/config.json: ${error?.message ?? error}`)
  }

  // ── update check ──────────────────────────────────────────────────────
  const checkNow = async () => {
    try {
      tags.value = await fetchDistTags({ registry: config.registry })
      tags.error = undefined
    } catch (error) {
      tags.error = String(error?.message ?? error)
    }
    tags.checkedAt = new Date().toISOString()
  }
  ctx.effect(() => {
    const first = setTimeout(checkNow, 20_000)
    const every = setInterval(checkNow, Math.max(1, config.checkIntervalHours) * 3600_000)
    first.unref?.()
    every.unref?.()
    return () => {
      clearTimeout(first)
      clearInterval(every)
    }
  }, 'safe-upgrade: update check')

  // ── idle tracking ─────────────────────────────────────────────────────
  ctx.inject(['agents'], (agentCtx) => {
    agentCtx.on('session/event', (session, event) => {
      if (event?.type === 'turn/start') running.set(session.id, Date.now())
      else if (event?.type === 'turn/end') running.delete(session.id)
    })
  })
  const runningTurns = () => {
    const now = Date.now()
    for (const [id, at] of running) if (now - at > TURN_STALE_MS) running.delete(id)
    return running.size
  }

  // ── boot health + known-good tag ──────────────────────────────────────
  const bootCheck = async (loader, presets) => {
    const deadline = Date.now() + 120_000
    let entries = []
    for (;;) {
      entries = Array.from(loader.entries()).filter((entry) => !entry.options?.group && !entry.disabled)
      const busy = entries.filter((entry) => entry.fiber && (entry.fiber.state === FIBER.PENDING || entry.fiber.state === FIBER.LOADING))
      if (busy.length === 0 || Date.now() > deadline) break
      await sleep(2000)
    }
    const failed = entries
      .filter((entry) => entry.fiber?.state === FIBER.FAILED)
      .map((entry) => `${entry.id ?? '?'} (${entry.options?.name ?? '?'})`)
    let brokenPresets = []
    try {
      const inventory = presets === undefined ? [] : await presets.compositionInventory()
      brokenPresets = inventory.filter((preset) => preset.broken).map((preset) => `preset ${preset.id}: ${preset.broken}`)
    } catch (error) {
      warn(`preset inventory unavailable: ${error?.message ?? error}`)
    }
    const healthy = failed.length === 0 && brokenPresets.length === 0
    bootMarker = {
      pid: process.pid,
      startedAt: new Date(Date.now() - process.uptime() * 1000).toISOString(),
      writtenAt: new Date().toISOString(),
      dshVersion: config.installDir ? readDshVersion(config.installDir) : undefined,
      installDir: config.installDir,
      unit: config.unit,
      profile: config.profile,
      plugin: PACKAGE_VERSION,
      loaded: entries.length,
      healthy,
      failed,
      brokenPresets,
    }
    if (!healthy) warn(`boot check found problems: ${[...failed, ...brokenPresets].join('; ')}`)
    if (config.snapshots) {
      try {
        const { created } = await repo.ensure()
        if (created) log(`started config history in ${home} (git)`)
        await repo.snapshot('boot: config at startup')
        if (healthy && !(await repo.tagsAtHead()).some((tag) => tag.startsWith('good-'))) {
          await repo.tag(`good-${stamp()}`, { dshVersion: bootMarker.dshVersion, profile: config.profile })
          await repo.pruneTags('good-', config.keepGoodTags)
        }
      } catch (error) {
        warn(`config history unavailable: ${error?.message ?? error}`)
      }
    }
    // Written last: the engine treats this file as "the new process is fully up".
    writeJson(markerPath(home), bootMarker)
  }
  ctx.inject(['loader'], (loaderCtx) => {
    const loader = loaderCtx.loader ?? loaderCtx.get?.('loader')
    if (loader === undefined) return
    loaderCtx.effect(() => {
      let cancelled = false
      const timer = setTimeout(() => {
        if (cancelled) return
        bootCheck(loader, loaderCtx.get?.('agentPresets')).catch((error) => warn(`boot check failed: ${error?.message ?? error}`))
      }, 3000)
      return () => {
        cancelled = true
        clearTimeout(timer)
      }
    }, 'safe-upgrade: boot check')
  })

  // ── auto-snapshot on config edits ─────────────────────────────────────
  if (config.snapshots) {
    ctx.effect(() => {
      const changed = new Set()
      let timer
      const flush = async () => {
        timer = undefined
        if (activeLock(home) !== undefined || !repo.exists()) return
        const files = [...changed]
        changed.clear()
        try {
          const sha = await repo.snapshot(`auto: ${files.join(', ')}`)
          if (sha) log(`snapshot ${sha.slice(0, 8)}: ${files.join(', ')}`)
        } catch (error) {
          warn(`snapshot failed: ${error?.message ?? error}`)
        }
      }
      const note = (file) => {
        changed.add(file)
        clearTimeout(timer)
        timer = setTimeout(() => void flush(), 3000)
        timer.unref?.()
      }
      const watchers = []
      const add = (dir, options, accept, label) => {
        try {
          watchers.push(watch(dir, options, (_event, file) => {
            if (file && accept(String(file))) note(label(String(file)))
          }))
        } catch {
          // Missing directory: nothing to watch there.
        }
      }
      add(home, {}, (file) => HOME_FILES.has(file), (file) => file)
      for (const profile of config.profiles) {
        add(join(home, 'profiles', profile), {}, (file) => PROFILE_FILES.has(file), (file) => `profiles/${profile}/${file}`)
      }
      add(join(home, '.agent-presets'), { recursive: true }, (file) => !file.includes('.bak') && !file.includes('.tmp-'), (file) => `.agent-presets/${file}`)
      return () => {
        clearTimeout(timer)
        for (const watcher of watchers) watcher.close()
      }
    }, 'safe-upgrade: config watcher')
  }

  // ── status + job launch ───────────────────────────────────────────────
  const status = async () => {
    const current = config.installDir ? readDshVersion(config.installDir) : undefined
    const updates = {}
    const channelVersion = tags.value?.[config.channel]
    for (const [tag, version] of Object.entries(tags.value ?? {})) {
      if (!valid(version) || current === undefined || !valid(current)) continue
      // A tag behind the channel (an old alpha next to a newer rc) is not an upgrade worth offering.
      const behindChannel = valid(channelVersion) && newer(channelVersion, version)
      updates[tag] = { version, newer: newer(version, current) && !behindChannel }
    }
    const lock = activeLock(home)
    return {
      plugin: PACKAGE_VERSION,
      dshVersion: current,
      installDir: config.installDir,
      unit: config.unit,
      scope: config.scope,
      supervised: config.unit !== undefined && config.installDir !== undefined,
      guard: config.unit ? guardInstalled(config.unit, config.scope) : false,
      runningTurns: runningTurns(),
      idle: runningTurns() === 0,
      channel: config.channel,
      distTags: tags.value,
      checkedAt: tags.checkedAt,
      checkError: tags.error,
      updates,
      busyJob: lock?.id,
      lastJob: summarizeJob(listJobs(home, 1)[0]),
      goodTags: repo.exists() ? (await repo.listTags('good-')).slice(0, 5) : [],
      snapshots: repo.exists() ? await repo.recent(10) : [],
      boot: bootMarker ?? readJson(markerPath(home)),
    }
  }

  const launch = async (kind, request) => {
    if (!config.unit || !config.installDir) {
      return [409, { ok: false, error: 'dsh is not running as a systemd service; use the dsh-safe-upgrade CLI instead' }]
    }
    if (runningTurns() > 0) return [409, { ok: false, error: `a turn is running (${runningTurns()}); try again when idle` }]
    const lock = activeLock(home)
    if (lock !== undefined) return [409, { ok: false, error: `job ${lock.id} is already running` }]
    const context = {
      home,
      installDir: config.installDir,
      unit: config.unit,
      scope: config.scope,
      profiles: config.profiles,
      healthUrl: config.healthUrl,
      healthTimeoutMs: config.healthTimeoutMs,
      registry: config.registry,
      keepPrev: config.keepPrev,
      telegram: config.telegram,
      failOnWarnings: config.failOnWarnings,
      requireMarker: true,
      simulateFailure: config.testing ? request.simulateFailure : undefined,
    }
    delete request.simulateFailure
    const { id, path, job } = createJob(home, kind, request, context)
    const result = await launchTransient({
      unit: `dsh-safe-upgrade-${id}`,
      argv: [process.execPath, join(PACKAGE_ROOT, 'lib', 'supervisor.mjs'), '--job', path],
      env: { DSH_HOME: home, HOME: process.env.HOME, PATH: process.env.PATH },
      scope: config.scope,
    })
    if (result.code !== 0) {
      writeJson(path, { ...job, status: 'failed', error: `could not start supervisor: ${result.stderr.trim()}`, finishedAt: new Date().toISOString() })
      return [500, { ok: false, error: `could not start supervisor: ${result.stderr.trim()}` }]
    }
    log(`${kind} job ${id} started (${JSON.stringify(request)})`)
    return [202, { ok: true, id }]
  }

  ctx.inject(['connection', 'webServer'], (routeCtx) => {
    const connection = routeCtx.connection ?? routeCtx.get?.('connection')
    const webServer = routeCtx.webServer ?? routeCtx.get?.('webServer')
    const json = (res, code, value) => {
      res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      res.end(JSON.stringify(value))
    }
    const readBody = (req, limit = 16 * 1024) => new Promise((resolve, reject) => {
      let size = 0
      const chunks = []
      req.on('data', (chunk) => {
        size += chunk.length
        if (size > limit) {
          reject(Object.assign(new Error('body too large'), { statusCode: 413 }))
          req.destroy()
          return
        }
        chunks.push(chunk)
      })
      req.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        try {
          resolve(text === '' ? {} : JSON.parse(text))
        } catch {
          reject(Object.assign(new Error('invalid JSON'), { statusCode: 400 }))
        }
      })
      req.on('error', reject)
    })
    const guarded = (method, handler) => async (req, res) => {
      const rejection = connection.requestRejection(req)
      if (rejection !== undefined) {
        res.writeHead(rejection)
        res.end(rejection === 401 ? 'unauthorized' : 'forbidden')
        return
      }
      if (req.method !== method) {
        res.writeHead(405, { allow: method })
        res.end()
        return
      }
      try {
        const [code, body] = await handler(method === 'POST' ? await readBody(req) : {})
        json(res, code, body)
      } catch (error) {
        json(res, error?.statusCode ?? 500, { ok: false, error: String(error?.message ?? error) })
      }
    }
    const routes = [
      ['/api/safe-upgrade/status', guarded('GET', async () => [200, await status()])],
      ['/api/safe-upgrade/check', guarded('POST', async () => {
        await checkNow()
        return [200, await status()]
      })],
      ['/api/safe-upgrade/upgrade', guarded('POST', async (body) => {
        const target = typeof body.version === 'string' && body.version !== '' ? body.version : config.channel
        if (!/^[A-Za-z0-9][A-Za-z0-9.+-]{0,60}$/.test(target)) return [400, { ok: false, error: 'invalid version' }]
        return launch('upgrade', { target, dryRun: body.dryRun === true, simulateFailure: body.simulateFailure })
      })],
      ['/api/safe-upgrade/rollback', guarded('POST', async (body) => {
        const ref = body.ref
        if (typeof ref !== 'string' || !REF.test(ref)) return [400, { ok: false, error: 'invalid ref' }]
        if (!repo.exists() || !(await repo.hasRef(ref))) return [404, { ok: false, error: `unknown ref ${ref}` }]
        return launch('rollback', { ref })
      })],
    ]
    routeCtx.effect(() => {
      const disposers = routes.map(([path, handler]) => webServer.register({ kind: 'exact', path, handler }))
      return () => {
        for (const dispose of disposers) dispose()
      }
    }, 'safe-upgrade: routes')
  })
}
