// Regression suite against a real dsh from npm (no stubs): catches a dsh
// release that changes what the plugin relies on — the Loader's fiber states,
// profile loading, `--dump-config` side effects, auth, the web app, npm pins.
//
//   scripts/install-dsh.sh latest /tmp/dsh
//   DSH_E2E_INSTALL=/tmp/dsh [DSH_E2E_UPGRADE_TO=next] npm run test:e2e
//
// Every test uses a throwaway $DSH_HOME and HOME and a free port; nothing
// outside the temp directories is touched.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync,
  rmSync, symlinkSync, writeFileSync,
} from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { JobRunner, createJob, markerPath } from '../../lib/engine.js'
import { ConfigRepo } from '../../lib/repo.js'
import { checkWebUi } from '../../lib/uicheck.js'
import {
  PACKAGE_ROOT, PACKAGE_VERSION, dshBin, readDshVersion, readJson, run, tail,
} from '../../lib/util.js'

const INSTALL = process.env.DSH_E2E_INSTALL
const UPGRADE_TO = process.env.DSH_E2E_UPGRADE_TO
const VERSION = INSTALL ? readDshVersion(INSTALL) : undefined
const skip = INSTALL ? false : 'set DSH_E2E_INSTALL to a real dsh install (see scripts/install-dsh.sh)'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitFor(fn, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await fn()
    if (value) return value
    if (Date.now() > deadline) throw new Error(`timed out after ${Math.round(timeoutMs / 1000)}s waiting for ${label}`)
    await sleep(500)
  }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => resolve(port))
    })
  })
}

/**
 * A fresh $DSH_HOME whose `web` profile was initialized by the real dsh and
 * has this checkout linked in as a bundle, the way `dsh plugin add link:` does.
 */
async function newHome() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-e2e-'))
  const home = join(root, 'home')
  const user = join(root, 'user')
  mkdirSync(home)
  mkdirSync(user)
  const env = { ...process.env, DSH_HOME: home, HOME: user }
  const init = await run(dshBin(INSTALL), ['--profile', 'web', '--dump-config'], { env, cwd: user })
  assert.equal(init.code, 0, `dsh could not initialize the web profile:\n${tail(init.stderr, 20)}`)
  const profile = join(home, 'profiles', 'web')
  const manifestPath = join(profile, 'package.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  manifest.dependencies = { ...manifest.dependencies, 'dsh-plugin-safe-upgrade': `link:${PACKAGE_ROOT}` }
  manifest.dsh.profile.bundles.push('dsh-plugin-safe-upgrade')
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  mkdirSync(join(profile, 'node_modules'), { recursive: true })
  symlinkSync(PACKAGE_ROOT, join(profile, 'node_modules', 'dsh-plugin-safe-upgrade'))
  return { root, home, user, profile, env }
}

/** Every path under `dir` with a content hash (links by target), skipping `skip` top-level names. */
function treeState(dir, skipNames = []) {
  const state = {}
  const walk = (at, rel) => {
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      const path = join(at, entry.name)
      const key = rel === '' ? entry.name : `${rel}/${entry.name}`
      if (rel === '' && skipNames.includes(entry.name)) continue
      if (entry.isSymbolicLink()) state[key] = `link:${readlinkSync(path)}`
      else if (entry.isDirectory()) {
        state[key] = 'dir'
        walk(path, key)
      } else state[key] = createHash('sha256').update(readFileSync(path)).digest('hex')
    }
  }
  walk(dir, '')
  return state
}

/** A link projection like the ones dsh 0.1.5 left in profiles; dsh 0.1.7+ deletes them while loading. */
function addLegacyProjection(profile) {
  mkdirSync(join(profile, '.dsh-module-fallback', 'node_modules', 'legacy-pkg'), { recursive: true })
  writeFileSync(join(profile, '.dsh-module-fallback', 'node_modules', 'legacy-pkg', 'package.json'), '{"name":"legacy-pkg"}\n')
  symlinkSync('../.dsh-module-fallback/node_modules/legacy-pkg', join(profile, 'node_modules', 'legacy-pkg'))
}

function jobContext(home, overrides = {}) {
  return {
    home,
    installDir: INSTALL,
    unit: 'dsh-e2e-not-a-unit',
    scope: 'system',
    profiles: ['web'],
    healthUrl: 'http://127.0.0.1:9/',
    uiCheck: false,
    requireMarker: true,
    ...overrides,
  }
}

async function runJob(home, kind, request, overrides) {
  const { path } = createJob(home, kind, request, jobContext(home, overrides))
  const lines = []
  const runner = new JobRunner(readJson(path), path, { log: (line) => lines.push(line) })
  await runner.runJob()
  return { job: runner.job, log: lines.join('\n') }
}

/** Boot `dsh web` in its own process group; resolves once the plugin wrote a fresh boot marker. */
async function bootDsh({ home, user, env }) {
  const port = await freePort()
  const since = Date.now()
  const child = spawn(dshBin(INSTALL), ['web', '--host', '127.0.0.1', '--port', String(port), '--no-open'], {
    env, cwd: user, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  child.stdout.on('data', (chunk) => {
    output += chunk
  })
  child.stderr.on('data', (chunk) => {
    output += chunk
  })
  const exited = new Promise((resolve) => child.once('exit', resolve))
  const stop = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return
    try {
      process.kill(-child.pid, 'SIGTERM')
    } catch {}
    const timer = setTimeout(() => {
      try {
        process.kill(-child.pid, 'SIGKILL')
      } catch {}
    }, 15_000)
    await exited
    clearTimeout(timer)
  }
  const redacted = () => output.replace(/token=[A-Za-z0-9_-]+/g, 'token=***')
  try {
    const marker = await waitFor(() => {
      if (child.exitCode !== null) throw new Error(`dsh exited (${child.exitCode}) during boot:\n${tail(redacted(), 30)}`)
      const found = readJson(markerPath(home))
      return found !== undefined && Date.parse(found.writtenAt) >= since - 1000 && found
    }, 150_000, `the plugin's boot marker (dsh output:\n${tail(redacted(), 30)})`)
    const token = [...output.matchAll(/[?&]token=([A-Za-z0-9_-]+)/g)].pop()?.[1]
    return { port, marker, token, stop, output: redacted }
  } catch (error) {
    await stop()
    throw error
  }
}

test(`boot: dsh ${VERSION ?? '?'} loads the plugin, reports a healthy boot and records a known-good config`, { skip }, async (t) => {
  const fx = await newHome()
  const dsh = await bootDsh(fx)
  try {
    const { marker } = dsh
    assert.equal(marker.healthy, true, JSON.stringify(marker))
    assert.deepEqual([marker.failed, marker.pending, marker.brokenPresets], [[], [], []])
    assert.equal(marker.dshVersion, VERSION)
    assert.equal(marker.plugin, PACKAGE_VERSION)
    assert.ok(marker.loaded > 10, `only ${marker.loaded} loader entries: the plugin may be reading the Loader wrong`)
    assert.doesNotMatch(dsh.output(), /skipping profile bundle "dsh-plugin-safe-upgrade"/)

    const good = await new ConfigRepo(fx.home).listTags('good-')
    assert.equal(good.length, 1)
    assert.equal(good[0].meta.dshVersion, VERSION)

    // The routes are registered and behind dsh's own authentication.
    const base = `http://127.0.0.1:${dsh.port}`
    assert.equal((await fetch(`${base}/api/safe-upgrade/status`)).status, 401)
    assert.ok(dsh.token, 'dsh printed a login URL')
    const login = await fetch(`${base}/?token=${dsh.token}`, { redirect: 'manual' })
    const cookie = login.headers.getSetCookie().map((value) => value.split(';')[0]).join('; ')
    assert.ok(cookie, `logging in set no cookie (HTTP ${login.status})`)
    const status = await fetch(`${base}/api/safe-upgrade/status`, { headers: { cookie } })
    assert.equal(status.status, 200)
    const body = await status.json()
    assert.equal(body.dshVersion, VERSION)
    assert.equal(body.boot.healthy, true)
    assert.equal(body.idle, true)

    // The web app, with this plugin's client half injected, reaches the composer.
    const ui = await checkWebUi({ url: `${base}/?token=${dsh.token}`, timeoutMs: 90_000 })
    if (ui.status === 'skipped') t.diagnostic(`web UI not checked: ${ui.detail}`)
    else assert.equal(ui.status, 'ok', `web UI: ${ui.status} ${ui.detail ?? ''}`)

    // A live config edit is snapshotted while dsh runs.
    const patch = join(fx.profile, 'cordis.patch.yml')
    writeFileSync(patch, `${readFileSync(patch, 'utf8')}\n# e2e edit\n`)
    const repo = new ConfigRepo(fx.home)
    await waitFor(async () => (await repo.recent(1))[0]?.subject.startsWith('auto: '), 30_000, 'an auto snapshot of the edit')
    const committed = await repo.git(['show', 'HEAD:profiles/web/cordis.patch.yml'])
    assert.match(committed.stdout, /# e2e edit/)
  } finally {
    await dsh.stop()
    rmSync(fx.root, { recursive: true, force: true })
  }
})

test(`validation: --dump-config on dsh ${VERSION ?? '?'} composes without writing the live home`, { skip }, async (t) => {
  const fx = await newHome()
  try {
    addLegacyProjection(fx.profile)
    // Canary: what dsh itself writes when composing (reported, not asserted).
    const probe = join(fx.root, 'probe')
    cpSync(fx.home, probe, { recursive: true, verbatimSymlinks: true })
    const probeBefore = treeState(probe)
    await run(dshBin(INSTALL), ['--profile', 'web', '--dump-config'], { env: { ...fx.env, DSH_HOME: probe }, cwd: fx.user })
    const probeAfter = treeState(probe)
    const touched = [...new Set([...Object.keys(probeBefore), ...Object.keys(probeAfter)])].filter((key) => probeBefore[key] !== probeAfter[key])
    t.diagnostic(`dsh --dump-config itself changes: ${touched.join(', ') || 'nothing'}`)

    const before = treeState(fx.home, ['safe-upgrade'])
    const { job, log } = await runJob(fx.home, 'upgrade', { target: VERSION, dryRun: true })
    assert.equal(job.status, 'ok', `${job.failedStep}: ${job.error}\n${log}`)
    assert.deepEqual(job.report.configs, { web: 'ok' })
    assert.deepEqual(treeState(fx.home, ['safe-upgrade']), before, 'the live home is byte-for-byte unchanged')
    for (const warning of job.warnings ?? []) t.diagnostic(`warning (${warning.source}): ${warning.text}`)
  } finally {
    rmSync(`${INSTALL}.next-${VERSION}`, { recursive: true, force: true })
    rmSync(fx.root, { recursive: true, force: true })
  }
})

test(`dry run: upgrading dsh ${VERSION ?? '?'} to ${UPGRADE_TO || '(unset)'} stages and composes with the real registry`, {
  skip: skip || (UPGRADE_TO ? false : 'set DSH_E2E_UPGRADE_TO to a dist-tag or version'),
}, async (t) => {
  const fx = await newHome()
  let target
  try {
    const before = treeState(fx.home, ['safe-upgrade'])
    const { job, log } = await runJob(fx.home, 'upgrade', { target: UPGRADE_TO, dryRun: true })
    target = job.toVersion
    assert.equal(job.status, 'ok', `${job.failedStep}: ${job.error}\n${log}`)
    assert.equal(job.report.to, target)
    assert.deepEqual(job.report.configs, { web: 'ok' })
    assert.equal(readDshVersion(INSTALL), VERSION, 'the running install is untouched')
    assert.equal(existsSync(`${INSTALL}.next-${target}`), false, 'the staged copy is removed')
    assert.deepEqual(treeState(fx.home, ['safe-upgrade']), before)
    t.diagnostic(`${VERSION} → ${target}: pinned ${job.report.pinned}, kept ${job.report.kept.join(', ') || 'none'}`)
    for (const warning of job.warnings ?? []) t.diagnostic(`warning (${warning.source}): ${warning.text}`)
  } finally {
    if (target) rmSync(`${INSTALL}.next-${target}`, { recursive: true, force: true })
    rmSync(fx.root, { recursive: true, force: true })
  }
})

test('the suite really ran against a dsh install', { skip }, () => {
  assert.ok(VERSION, `no @deepseek-ai/dsh under ${INSTALL}/node_modules`)
  assert.ok(lstatSync(dshBin(INSTALL)))
})
