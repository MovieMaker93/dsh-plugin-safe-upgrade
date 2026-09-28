/**
 * The upgrade / rollback engine. Runs OUTSIDE the dsh process (a transient
 * systemd unit or the CLI), because it stops, swaps and restarts dsh.
 *
 * Upgrade = stage the new version in a side copy of the install while dsh
 * keeps serving, validate it (npm install + dump-config per profile), then
 * stop → swap directories → start → wait for a healthy boot. Any failure after
 * the swap puts the previous install and config back and starts that.
 * @module dsh-plugin-safe-upgrade/engine
 */

import {
  appendFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync,
  renameSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync,
} from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { sendAlert } from './alert.js'
import { fetchDistTags, fetchVersions, mapLimit, resolveTarget } from './registry.js'
import { ConfigRepo } from './repo.js'
import { valid } from './semver.js'
import { describeUnit, systemctl } from './systemd.js'
import { checkWebUi } from './uicheck.js'
import {
  dshBin, readDshVersion, readJson, run, sleep, stamp, stateDir, tail, writeJson,
} from './util.js'

const HEALTHY_STATUS = new Set([200, 204, 301, 302, 401, 403])
/** dump-config stderr lines worth surfacing (e.g. `patch: entry "x" not found`). */
const CONFIG_WARNING = /\bwarn|not found|deprecat|retired|ignored|unknown\b/i
/** Journal lines from a fresh boot worth surfacing (plugins that log instead of failing). */
const BOOT_WARNING = /\b(error|failed|failure|exception|TypeError|ReferenceError|SyntaxError|not a function|not found|cannot|deprecated|ERR_[A-Z_]+)\b/i
const MAX_WARNINGS = 20

/** @returns {string} where the plugin's boot marker lives. */
export function markerPath(home) {
  return join(stateDir(home), 'boot-ok.json')
}

export function jobsDir(home) {
  return join(stateDir(home), 'jobs')
}

export function lockPath(home) {
  return join(stateDir(home), 'job.lock')
}

/** @returns {{id: string, pid: number} | undefined} the running job, if its process is alive. */
export function activeLock(home) {
  const lock = readJson(lockPath(home))
  if (lock === undefined) return undefined
  try {
    process.kill(lock.pid, 0)
    return lock
  } catch {
    return undefined
  }
}

/** @returns {string} a sortable, unit-name-safe job id. */
export function newJobId() {
  return `${stamp().toLowerCase()}-${Math.random().toString(36).slice(2, 6)}`
}

/**
 * Write a queued job file.
 * @returns {{id: string, path: string, job: object}}
 */
export function createJob(home, kind, request, context) {
  const id = newJobId()
  const path = join(jobsDir(home), `${id}.json`)
  const job = { id, kind, status: 'queued', createdAt: new Date().toISOString(), request, context, steps: [] }
  writeJson(path, job)
  return { id, path, job }
}

/** @returns {object[]} newest-first job summaries. */
export function listJobs(home, limit = 10) {
  const dir = jobsDir(home)
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .reverse()
    .slice(0, limit)
    .map((name) => readJson(join(dir, name)))
    .filter(Boolean)
}

/** Keep the newest `keep` job files (and their logs). */
export function pruneJobs(home, keep = 30) {
  const dir = jobsDir(home)
  if (!existsSync(dir)) return
  const names = readdirSync(dir).filter((name) => name.endsWith('.json')).sort().reverse()
  for (const name of names.slice(keep)) {
    rmSync(join(dir, name), { force: true })
    rmSync(join(dir, name.replace(/\.json$/, '.log')), { force: true })
  }
}

/**
 * Probe the dsh web endpoint.
 * @returns {Promise<number>} HTTP status, 0 when unreachable.
 */
export async function probe(url, fetchImpl = fetch) {
  try {
    const response = await fetchImpl(url, { redirect: 'manual', signal: AbortSignal.timeout(5000) })
    return response.status
  } catch {
    return 0
  }
}

/**
 * Keep a `$DSH_HOME/profiles/node_modules` link mirror (some deployments
 * symlink every install package there) in step with the install: drop links
 * that now dangle, add links for packages that are new in scopes the mirror
 * already covers. Deployments without such a mirror are left alone.
 * @returns {{added: number, removed: number} | undefined}
 */
export function refreshMirror(home, installDir) {
  const mirror = join(home, 'profiles', 'node_modules')
  const source = join(installDir, 'node_modules')
  if (!existsSync(mirror) || !existsSync(source)) return undefined
  let added = 0
  let removed = 0
  const syncDir = (mirrorDir, sourceDir, addMissing) => {
    let managed = 0
    for (const entry of readdirSync(mirrorDir, { withFileTypes: true })) {
      const at = join(mirrorDir, entry.name)
      if (!entry.isSymbolicLink()) continue
      const target = readlinkSync(at)
      if (!target.startsWith(source)) continue
      managed++
      if (!existsSync(at)) {
        unlinkSync(at)
        removed++
      }
    }
    if (!addMissing || managed === 0) return
    for (const entry of readdirSync(sourceDir, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue
      const at = join(mirrorDir, entry.name)
      let present = true
      try {
        lstatSync(at)
      } catch {
        present = false
      }
      if (!present) {
        symlinkSync(join(sourceDir, entry.name), at)
        added++
      }
    }
  }
  syncDir(mirror, source, false)
  for (const entry of readdirSync(mirror, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith('@')) continue
    const scopeSource = join(source, entry.name)
    if (existsSync(scopeSource)) syncDir(join(mirror, entry.name), scopeSource, true)
  }
  return { added, removed }
}

/** Sibling directory names used for staged, previous and failed installs. */
export function siblings(installDir) {
  const base = basename(installDir)
  const parent = dirname(installDir)
  return {
    next: (version) => join(parent, `${base}.next-${version}`),
    prev: (version) => join(parent, `${base}.prev-${version}`),
    failed: (version) => join(parent, `${base}.failed-${version}-${stamp()}`),
    list: (kind) => (existsSync(parent) ? readdirSync(parent) : [])
      .filter((name) => name.startsWith(`${base}.${kind}-`))
      .map((name) => join(parent, name)),
  }
}

export class JobRunner {
  /**
   * @param {object} job - the job document (see createJob).
   * @param {string} path - where the job document is persisted.
   * @param {{fetchImpl?: typeof fetch, log?: (line: string) => void, uiChecker?: typeof checkWebUi}} [options]
   */
  constructor(job, path, { fetchImpl = fetch, log, uiChecker = checkWebUi } = {}) {
    this.job = job
    this.path = path
    this.fetchImpl = fetchImpl
    this.uiChecker = uiChecker
    this.logPath = path.replace(/\.json$/, '.log')
    this.extraLog = log
    const c = job.context
    this.home = c.home
    this.installDir = c.installDir
    this.unit = c.unit
    this.scope = c.scope ?? 'system'
    this.repo = new ConfigRepo(this.home, { log: (line) => this.log(line) })
    this.dirs = siblings(this.installDir)
  }

  log(line) {
    const text = `[${new Date().toISOString()}] ${line}`
    mkdirSync(dirname(this.logPath), { recursive: true })
    appendFileSync(this.logPath, `${text}\n`)
    this.extraLog?.(text)
  }

  save() {
    writeJson(this.path, this.job)
  }

  /** Run one named step, recording its outcome on the job. */
  async step(name, fn) {
    const record = { name, status: 'running', startedAt: new Date().toISOString() }
    this.job.steps.push(record)
    this.save()
    this.log(`step ${name}: start`)
    try {
      const detail = await fn()
      record.status = 'ok'
      if (detail !== undefined) record.detail = detail
      return detail
    } catch (error) {
      record.status = 'failed'
      record.error = String(error?.message ?? error)
      this.log(`step ${name}: FAILED ${record.error}`)
      error.step ??= name
      throw error
    } finally {
      record.finishedAt = new Date().toISOString()
      this.save()
    }
  }

  simulate(point) {
    if (this.job.context.simulateFailure === point) throw new Error(`simulated failure at ${point}`)
  }

  async unitEnv() {
    if (this._env) return this._env
    const described = await describeUnit(this.unit, { scope: this.scope }).catch(() => ({ env: {} }))
    this._env = { ...process.env, ...described.env, DSH_HOME: this.home }
    return this._env
  }

  profiles() {
    return this.job.context.profiles
  }

  /** Record deduplicated warnings on the job (they never fail it on their own). */
  noteWarnings(source, lines) {
    const list = (this.job.warnings ??= [])
    for (const raw of lines) {
      const text = String(raw).trim().slice(0, 300)
      if (text === '' || /token=/i.test(text) || list.some((w) => w.text === text)) continue
      if (list.length >= MAX_WARNINGS) break
      list.push({ source, text })
      this.log(`warning (${source}): ${text}`)
    }
  }

  /** `dsh --profile <p> --dump-config` for every profile with the given install. */
  async dumpConfigAll(installDir) {
    const env = await this.unitEnv()
    const results = {}
    for (const profile of this.profiles()) {
      const result = await run(dshBin(installDir), ['--profile', profile, '--dump-config'], {
        env, cwd: env.HOME, timeoutMs: 120_000,
      })
      if (result.code !== 0) {
        throw new Error(`dump-config failed for profile ${profile}: ${tail(result.stderr || result.stdout, 15)}`)
      }
      this.noteWarnings(`config ${profile}`, result.stderr.split('\n').filter((line) => CONFIG_WARNING.test(line)))
      results[profile] = 'ok'
    }
    return results
  }

  /** Scan the unit's journal since `sinceMs` for errors plugins logged without failing. */
  async collectBootWarnings(sinceMs) {
    if (sinceMs === undefined) return
    const args = [...(this.scope === 'user' ? ['--user'] : []), '-u', this.unit, '--since', `@${Math.floor(sinceMs / 1000)}`, '-o', 'cat', '--no-pager']
    const result = await run('journalctl', args, { timeoutMs: 20_000 })
    if (result.code !== 0) return
    const lines = result.stdout.split('\n').filter((line) => BOOT_WARNING.test(line)
      && !/^\s+at /.test(line)
      && !/^(Started|Stopped|Stopping|Starting|Finished) /.test(line))
    this.noteWarnings('boot', lines)
  }

  /**
   * Load the web UI of the boot started at `sinceMs` in headless Chromium.
   * dsh prints a fresh login URL on every boot; it is read from the journal
   * and never logged. `uiCheck`: 'auto' (default) fails only on dsh's own
   * failure screen, `true` also fails when the check cannot run, `false` skips.
   */
  async checkUi(sinceMs, { strictOverride } = {}) {
    const mode = this.job.context.uiCheck ?? 'auto'
    if (mode === false) return { skipped: 'uiCheck is off' }
    const strict = strictOverride ?? mode === true
    const args = [...(this.scope === 'user' ? ['--user'] : []), '-u', this.unit, '--since', `@${Math.floor(sinceMs / 1000)}`, '-o', 'cat', '--no-pager']
    const journal = await run('journalctl', args, { timeoutMs: 20_000 })
    const token = [...journal.stdout.matchAll(/[?&]token=([A-Za-z0-9_-]+)/g)].pop()?.[1]
    const base = this.job.context.healthUrl
    const url = token ? `${base}${base.includes('?') ? '&' : '?'}token=${token}` : base
    const result = await this.uiChecker({
      url,
      chromium: this.job.context.chromium,
      timeoutMs: this.job.context.uiTimeoutMs ?? 45_000,
    })
    if (result.status === 'ok') return { ms: result.ms }
    if (result.status === 'failed') throw new Error(`web UI failed to boot: ${result.detail}`)
    if (strict) throw new Error(`web UI check ${result.status}: ${result.detail}`)
    this.noteWarnings('ui', [`web UI check ${result.status}: ${result.detail}`])
    return { [result.status]: result.detail }
  }

  /** With `failOnWarnings`, a boot that logged problems counts as a failed one. */
  enforceWarnings() {
    if (this.job.context.failOnWarnings && (this.job.warnings?.length ?? 0) > 0) {
      const error = new Error(`${this.job.warnings.length} warning(s) and failOnWarnings is on: ${this.job.warnings[0].text}`)
      error.step = 'warnings'
      throw error
    }
  }

  async ctl(args) {
    const result = await systemctl(args, { scope: this.scope })
    if (result.code !== 0) throw new Error(`systemctl ${args.join(' ')} failed: ${result.stderr.trim()}`)
    return result
  }

  /**
   * Wait for the web endpoint AND a boot marker newer than `since` that
   * reports no failed plugins (and the expected dsh version).
   */
  async waitHealthy(since, expectVersion) {
    const timeoutMs = this.job.context.healthTimeoutMs ?? 150_000
    const requireMarker = this.job.context.requireMarker !== false
    const deadline = Date.now() + timeoutMs
    let lastStatus = 0
    while (Date.now() < deadline) {
      lastStatus = await probe(this.job.context.healthUrl, this.fetchImpl)
      const marker = readJson(markerPath(this.home))
      const fresh = marker !== undefined && Date.parse(marker.writtenAt) >= since
      if (HEALTHY_STATUS.has(lastStatus) && (!requireMarker || fresh)) {
        if (fresh && marker.healthy === false) {
          const failed = [...(marker.failed ?? []), ...(marker.brokenPresets ?? [])].join(', ')
          throw new Error(`dsh booted but reported failures: ${failed}`)
        }
        if (fresh && expectVersion && marker.dshVersion !== expectVersion) {
          throw new Error(`dsh booted ${marker.dshVersion}, expected ${expectVersion}`)
        }
        this.simulate('health')
        return { http: lastStatus, marker: fresh ? { dshVersion: marker.dshVersion, loaded: marker.loaded } : undefined }
      }
      const state = (await systemctl(['is-active', this.unit], { scope: this.scope })).stdout.trim()
      if (state === 'failed') throw new Error(`${this.unit} entered the failed state`)
      await sleep(2000)
    }
    throw new Error(`dsh was not healthy within ${Math.round(timeoutMs / 1000)}s (last HTTP ${lastStatus || 'unreachable'})`)
  }

  /**
   * Build `installDir.next-<version>`: copy the live install, pin every
   * `@deepseek-ai/*` dependency that is published at `version`, npm install.
   * @returns {Promise<{dir: string, pinned: number, kept: string[]}>}
   */
  async stage(version) {
    const next = this.dirs.next(version)
    rmSync(next, { recursive: true, force: true })
    const copy = await run('cp', ['-a', this.installDir, next], { timeoutMs: 600_000 })
    if (copy.code !== 0) throw new Error(`copy failed: ${copy.stderr.trim()}`)
    const manifestPath = join(next, 'package.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    const deps = manifest.dependencies ?? {}
    const names = Object.keys(deps).filter((name) => name.startsWith('@deepseek-ai/'))
    const registry = this.job.context.registry
    const published = await mapLimit(names, 8, (name) => fetchVersions(name, { registry, fetchImpl: this.fetchImpl }))
    const kept = []
    let pinned = 0
    names.forEach((name, i) => {
      if (published[i].includes(version)) {
        deps[name] = version
        pinned++
      } else {
        kept.push(`${name}@${deps[name]}`)
      }
    })
    if (!deps['@deepseek-ai/dsh'] || deps['@deepseek-ai/dsh'] !== version) {
      throw new Error(`@deepseek-ai/dsh@${version} is not published`)
    }
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
    this.log(`pinned ${pinned} @deepseek-ai packages to ${version}; kept ${kept.join(', ') || 'none'}`)
    this.simulate('install')
    const env = await this.unitEnv()
    const install = await run('npm', ['install', '--no-audit', '--no-fund', '--loglevel=error'], {
      cwd: next, env, timeoutMs: 1_200_000,
    })
    if (install.code !== 0) throw new Error(`npm install failed: ${tail(install.stderr || install.stdout, 20)}`)
    const got = readDshVersion(next)
    if (got !== version) throw new Error(`staged install reports dsh ${got}, expected ${version}`)
    return { dir: next, pinned, kept }
  }

  /** Remove old `.prev-*` copies beyond `keepPrev`, never the one just made. */
  prunePrev(keepPath) {
    const keep = this.job.context.keepPrev ?? 2
    const prevs = this.dirs.list('prev')
      .filter((path) => path !== keepPath)
      .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
    for (const path of prevs.slice(Math.max(0, keep - 1))) {
      this.log(`removing old install copy ${path}`)
      rmSync(path, { recursive: true, force: true })
    }
  }

  async alert(text) {
    const sent = await sendAlert(this.job.context.telegram, text, { log: (line) => this.log(line) })
    if (sent) this.log('telegram alert sent')
  }

  finish(status, extra = {}) {
    Object.assign(this.job, extra, { status, finishedAt: new Date().toISOString() })
    this.save()
    this.log(`job ${this.job.id} finished: ${status}`)
  }

  async resolveTargetVersion(target) {
    if (valid(target)) return target
    const tags = await fetchDistTags({ registry: this.job.context.registry, fetchImpl: this.fetchImpl })
    const version = resolveTarget(target, tags)
    if (version === undefined) throw new Error(`no dist-tag "${target}" for @deepseek-ai/dsh`)
    return version
  }

  // ── job kinds ──────────────────────────────────────────────────────────

  async dryRun() {
    const from = readDshVersion(this.installDir)
    const version = await this.step('resolve', () => this.resolveTargetVersion(this.job.request.target))
    Object.assign(this.job, { fromVersion: from, toVersion: version })
    let staged
    try {
      staged = await this.step('stage', () => this.stage(version))
      const configs = await this.step('dump-config', () => this.dumpConfigAll(staged.dir))
      this.finish('ok', { report: { from, to: version, pinned: staged.pinned, kept: staged.kept, configs } })
    } catch (error) {
      this.finish('failed', { failedStep: error.step, error: String(error.message) })
    } finally {
      rmSync(this.dirs.next(version), { recursive: true, force: true })
    }
  }

  async upgrade() {
    const from = readDshVersion(this.installDir)
    this.job.fromVersion = from
    let version
    try {
      version = await this.step('resolve', () => this.resolveTargetVersion(this.job.request.target))
      this.job.toVersion = version
      if (version === from) {
        this.finish('noop', { note: `already on ${from}` })
        return
      }
      await this.step('snapshot', async () => {
        await this.repo.ensure()
        await this.repo.snapshot(`pre-upgrade ${from} -> ${version}`)
        this.job.preTag = `pre-upgrade-${stamp()}`
        await this.repo.tag(this.job.preTag, { dshVersion: from, job: this.job.id })
        return this.job.preTag
      })
    } catch (error) {
      // Nothing has changed yet.
      this.finish('failed', { failedStep: error.step, error: String(error.message) })
      await this.alert(`dsh upgrade to ${version ?? this.job.request.target} failed before any change (${error.step}): ${error.message}`)
      return
    }

    let staged
    try {
      staged = await this.step('stage', () => this.stage(version))
      await this.step('dump-config', () => this.dumpConfigAll(staged.dir))
    } catch (error) {
      // Still nothing live has changed: discard the staged copy.
      rmSync(this.dirs.next(version), { recursive: true, force: true })
      this.finish('failed', { failedStep: error.step, error: String(error.message) })
      await this.alert(`dsh upgrade ${from} → ${version} stopped at ${error.step}; the running dsh was not touched.\n${error.message}`)
      return
    }

    const prev = this.dirs.prev(from)
    let swapped = false
    try {
      await this.step('stop', () => this.ctl(['stop', this.unit]))
      await this.step('swap', () => {
        rmSync(prev, { recursive: true, force: true })
        renameSync(this.installDir, prev)
        renameSync(staged.dir, this.installDir)
        swapped = true
        return { prev }
      })
      await this.step('mirror', () => refreshMirror(this.home, this.installDir))
      const since = Date.now()
      this.lastStart = since
      await this.step('start', () => this.ctl(['start', this.unit]))
      await this.step('health', () => this.waitHealthy(since, version))
      await this.step('ui', () => this.checkUi(since))
      await this.step('warnings', async () => {
        await sleep(2000) // let late plugin logs land
        await this.collectBootWarnings(since)
        this.enforceWarnings()
        return { count: this.job.warnings?.length ?? 0 }
      })
      this.prunePrev(prev)
      this.finish('ok', { report: { from, to: version, pinned: staged.pinned, kept: staged.kept, prev } })
      const warned = this.job.warnings?.length ? `\n⚠️ ${this.job.warnings.length} warning(s):\n${this.job.warnings.slice(0, 5).map((w) => `• ${w.text}`).join('\n')}` : ''
      await this.alert(`dsh upgraded ${from} → ${version} ✅${warned}`)
    } catch (error) {
      this.job.failedStep = error.step
      this.job.error = String(error.message)
      await this.revertUpgrade({ from, version, prev, swapped })
    }
  }

  /** Undo a failed upgrade: previous install, pre-upgrade config, start. */
  async revertUpgrade({ from, version, prev, swapped }) {
    // Keep what the failed boot logged: it is usually the answer to "why".
    await this.collectBootWarnings(this.lastStart).catch(() => {})
    try {
      await this.step('rollback-stop', () => systemctl(['stop', this.unit], { scope: this.scope }))
      // `swapped` is false when the swap itself failed half way (install dir
      // already moved aside): the previous install must come back either way.
      if (existsSync(prev) && (swapped || !existsSync(this.installDir))) {
        await this.step('rollback-install', () => {
          const failed = this.dirs.failed(version)
          if (existsSync(this.installDir)) renameSync(this.installDir, failed)
          renameSync(prev, this.installDir)
          return { failed }
        })
      }
      rmSync(this.dirs.next(version), { recursive: true, force: true })
      await this.step('rollback-config', () => this.restoreConfig(this.job.preTag, `rollback: upgrade to ${version} failed`))
      await this.step('rollback-mirror', () => refreshMirror(this.home, this.installDir))
      const since = Date.now()
      await this.step('rollback-start', async () => {
        await systemctl(['reset-failed', this.unit], { scope: this.scope })
        return this.ctl(['start', this.unit])
      })
      const context = this.job.context
      const simulated = context.simulateFailure
      context.simulateFailure = undefined // a simulated fault must not also sink the recovery
      try {
        await this.step('rollback-health', () => this.waitHealthy(since, from))
      } finally {
        context.simulateFailure = simulated
      }
      for (const dir of this.dirs.list('failed')) rmSync(dir, { recursive: true, force: true })
      await this.dropTagsFromFailedAttempt(version)
      this.finish('rolled-back')
      await this.alert(`dsh upgrade ${from} → ${version} FAILED at ${this.job.failedStep}; rolled back to ${from} ✅\n${this.job.error}`)
    } catch (error) {
      this.finish('failed', { rollbackError: String(error.message) })
      await this.alert(`dsh upgrade ${from} → ${version} FAILED and the rollback also failed (${error.step}): ${error.message}\nManual attention needed on ${this.unit}.`)
    }
  }

  /**
   * The rejected version may have booted far enough for the host half to tag
   * it good-*; recovery must never pick that tag, so drop it.
   */
  async dropTagsFromFailedAttempt(version) {
    if (!this.repo.exists()) return
    const since = Date.parse(this.job.startedAt ?? this.job.createdAt) - 1000
    for (const tag of await this.repo.listTags('good-')) {
      if (tag.meta?.dshVersion === version && Date.parse(tag.date) >= since) {
        await this.repo.git(['tag', '-d', tag.name], { allowFail: true })
        this.log(`removed ${tag.name}: it marked the rejected ${version} boot as good`)
      }
    }
  }

  async restoreConfig(ref, message) {
    if (ref === undefined) return { skipped: 'no config ref' }
    const changed = await this.repo.restore(ref)
    await this.repo.snapshot(message)
    return { ref, changed }
  }

  /**
   * Put config back to `ref` (a good-* tag, pre-* tag or commit) and, when
   * the tag records another dsh version whose install copy still exists,
   * swap that install back too.
   */
  async rollback(ref, { reason = 'manual', resetFailed = false } = {}) {
    const current = readDshVersion(this.installDir)
    this.job.fromVersion = current
    let safetyTag
    let wanted
    try {
      await this.step('snapshot', async () => {
        await this.repo.ensure()
        await this.repo.snapshot(`pre-rollback (${reason})`)
        safetyTag = `pre-rollback-${stamp()}`
        await this.repo.tag(safetyTag, { dshVersion: current, job: this.job.id })
        this.job.preTag = safetyTag
        return safetyTag
      })
      wanted = await this.step('resolve', async () => {
        if (!(await this.repo.hasRef(ref))) throw new Error(`unknown ref ${ref}`)
        const tag = (await this.repo.listTags('')).find((t) => t.name === ref)
        const version = tag?.meta?.dshVersion
        const prevDir = version && version !== current ? this.dirs.prev(version) : undefined
        const swap = prevDir !== undefined && existsSync(prevDir)
        return { ref, version, swap, prevDir, note: prevDir && !swap ? `no saved install for ${version}; keeping ${current}` : undefined }
      })
    } catch (error) {
      this.finish('failed', { failedStep: error.step, error: String(error.message) })
      return
    }
    this.job.toVersion = wanted.swap ? wanted.version : current

    let swapped = false
    try {
      await this.step('stop', () => systemctl(['stop', this.unit], { scope: this.scope }))
      if (wanted.swap) {
        await this.step('swap', () => {
          const keep = this.dirs.prev(current)
          rmSync(keep, { recursive: true, force: true })
          renameSync(this.installDir, keep)
          renameSync(wanted.prevDir, this.installDir)
          swapped = true
          return { kept: keep }
        })
      }
      await this.step('restore-config', () => this.restoreConfig(ref, `rollback to ${ref} (${reason})`))
      await this.step('mirror', () => refreshMirror(this.home, this.installDir))
      await this.step('dump-config', () => this.dumpConfigAll(this.installDir))
      const since = Date.now()
      await this.step('start', async () => {
        if (resetFailed) await systemctl(['reset-failed', this.unit], { scope: this.scope })
        return this.ctl(['start', this.unit])
      })
      await this.step('health', () => this.waitHealthy(since, this.job.toVersion))
      // After a rollback the UI result is reported, never used to undo it.
      await this.step('ui', () => this.checkUi(since, { strictOverride: false }).catch((error) => {
        this.noteWarnings('ui', [error.message])
        return { failed: error.message }
      }))
      await sleep(2000)
      await this.collectBootWarnings(since)
      this.finish('ok', { report: { ref, version: this.job.toVersion } })
      await this.alert(`dsh rolled back to ${ref} (${reason}) ✅ — running ${this.job.toVersion}`)
    } catch (error) {
      this.job.failedStep = error.step
      this.job.error = String(error.message)
      // Put things back the way they were before this rollback.
      try {
        await this.step('undo-stop', () => systemctl(['stop', this.unit], { scope: this.scope }))
        if (swapped) {
          await this.step('undo-swap', () => {
            const keep = this.dirs.prev(current)
            renameSync(this.installDir, wanted.prevDir)
            renameSync(keep, this.installDir)
          })
        }
        await this.step('undo-config', () => this.restoreConfig(safetyTag, `undo failed rollback to ${ref}`))
        await this.step('undo-mirror', () => refreshMirror(this.home, this.installDir))
        const since = Date.now()
        await this.step('undo-start', async () => {
          await systemctl(['reset-failed', this.unit], { scope: this.scope })
          return this.ctl(['start', this.unit])
        })
        this.job.context.simulateFailure = undefined
        await this.step('undo-health', () => this.waitHealthy(since, current))
        this.finish('failed', { note: 'rollback failed; restored the state from before it' })
      } catch (undoError) {
        this.finish('failed', { undoError: String(undoError.message) })
      }
      await this.alert(`dsh rollback to ${ref} (${reason}) FAILED at ${this.job.failedStep}: ${this.job.error}\nStatus: ${this.job.status}${this.job.undoError ? ` — undo also failed: ${this.job.undoError}` : ' (previous state restored)'}`)
    }
  }

  /**
   * Called by the recovery unit after dsh failed to start repeatedly: roll
   * back to the newest good-* tag, at most once per `cooldownMs`.
   */
  async autoRollback() {
    const lock = join(stateDir(this.home), 'recover.json')
    const cooldownMs = this.job.context.recoverCooldownMs ?? 15 * 60_000
    const last = readJson(lock)
    if (last !== undefined && Date.now() - Date.parse(last.at) < cooldownMs) {
      this.finish('failed', { error: `recovery already attempted at ${last.at}; not looping` })
      await this.alert(`${this.unit} failed again after an automatic rollback at ${last.at}. Not retrying — manual attention needed.`)
      return
    }
    writeJson(lock, { at: new Date().toISOString(), job: this.job.id })
    const good = await this.repo.exists() ? (await this.repo.listTags('good-'))[0] : undefined
    if (good === undefined) {
      this.finish('failed', { error: 'no good-* tag to roll back to' })
      await this.alert(`${this.unit} failed to start and there is no known-good config to roll back to.`)
      return
    }
    const current = readDshVersion(this.installDir)
    const changed = await this.repo.changedSince(good.name)
    if (changed.length === 0 && (good.meta.dshVersion === undefined || good.meta.dshVersion === current)) {
      this.finish('failed', { error: `config and install already match ${good.name}; the failure is not a config change` })
      await this.alert(`${this.unit} failed to start, but config and dsh version already match the last good state (${good.name}). Not a config problem — check journalctl -u ${this.unit}.`)
      return
    }
    await this.rollback(good.name, { reason: 'automatic recovery', resetFailed: true })
  }

  /** Entry point: run whatever kind this job is, holding the job lock. */
  async runJob() {
    writeJson(lockPath(this.home), { id: this.job.id, pid: process.pid, at: new Date().toISOString() })
    this.job.status = 'running'
    this.job.startedAt = new Date().toISOString()
    this.save()
    try {
      switch (this.job.kind) {
        case 'upgrade':
          return this.job.request.dryRun ? await this.dryRun() : await this.upgrade()
        case 'rollback':
          return await this.rollback(this.job.request.ref)
        case 'auto-rollback':
          return await this.autoRollback()
        default:
          throw new Error(`unknown job kind ${this.job.kind}`)
      }
    } catch (error) {
      this.finish('failed', { error: String(error?.message ?? error) })
    } finally {
      rmSync(lockPath(this.home), { force: true })
      pruneJobs(this.home)
    }
  }
}
