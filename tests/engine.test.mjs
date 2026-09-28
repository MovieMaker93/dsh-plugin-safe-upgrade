import assert from 'node:assert/strict'
import {
  existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import {
  JobRunner, acquireLock, createJob, lockPath, refreshMirror, releaseLock,
} from '../lib/engine.js'
import { ConfigRepo } from '../lib/repo.js'
import { readDshVersion, readJson, writeJson } from '../lib/util.js'
import { FROM, TO, fixture } from './helpers.mjs'

async function runJob(fx, kind, request, contextOverrides = {}, runnerOptions = {}) {
  const { path } = createJob(fx.home, kind, request, { ...fx.context, ...contextOverrides })
  const runner = new JobRunner(readJson(path), path, { fetchImpl: fx.fetchImpl, ...runnerOptions })
  await runner.runJob()
  return runner.job
}

test('upgrade: a web UI that shows dsh\'s plugin-failure screen is rolled back', async () => {
  const fx = fixture()
  await goodBaseline(fx)
  fx.flag('journal', 'dsh web: http://127.0.0.1:3999/?token=abc123\n')
  const seen = []
  const uiChecker = async ({ url }) => {
    seen.push(url)
    return { status: 'failed', detail: 'web boot: 1 entry did not activate dsh-esc-stop: pending (waiting for service: settingsScope)' }
  }
  const job = await runJob(fx, 'upgrade', { target: TO }, { uiCheck: 'auto' }, { uiChecker })
  assert.equal(job.status, 'rolled-back', JSON.stringify(job.steps))
  assert.equal(job.failedStep, 'ui')
  assert.match(job.error, /settingsScope/)
  assert.equal(readDshVersion(fx.install), FROM)
  assert.equal(seen[0], 'http://127.0.0.1:3999/?token=abc123', 'the fresh login token is read from the journal')
  assert.ok(!JSON.stringify(job).includes('abc123'), 'the token never reaches the job file')
})

test('upgrade: an inconclusive UI check is a warning in auto mode, a failure when strict', async () => {
  const fx = fixture()
  await goodBaseline(fx)
  const uiChecker = async () => ({ status: 'skipped', detail: 'no Chromium/Chrome binary found' })
  const auto = await runJob(fx, 'upgrade', { target: TO }, { uiCheck: 'auto' }, { uiChecker })
  assert.equal(auto.status, 'ok', JSON.stringify(auto.steps))
  assert.ok(auto.warnings.some((w) => w.source === 'ui' && /skipped/.test(w.text)))
  const fx2 = fixture()
  await goodBaseline(fx2)
  const strict = await runJob(fx2, 'upgrade', { target: TO }, { uiCheck: true }, { uiChecker })
  assert.equal(strict.status, 'rolled-back')
  assert.equal(strict.failedStep, 'ui')
})

async function goodBaseline(fx) {
  const repo = new ConfigRepo(fx.home)
  await repo.ensure()
  await repo.tag('good-20260928-000000', { dshVersion: FROM })
  return repo
}

const siblingsOf = (install) => readdirSync(dirname(install)).filter((name) => name.startsWith('dsh.'))

test('upgrade: stages, swaps, boots the new version, keeps the previous install', async () => {
  const fx = fixture()
  await goodBaseline(fx)
  const job = await runJob(fx, 'upgrade', { target: 'latest' })
  assert.equal(job.status, 'ok', JSON.stringify(job, null, 2))
  assert.equal(job.fromVersion, FROM)
  assert.equal(job.toVersion, TO)
  assert.equal(readDshVersion(fx.install), TO)
  assert.equal(readDshVersion(`${fx.install}.prev-${FROM}`), FROM)
  const manifest = JSON.parse(readFileSync(join(fx.install, 'package.json'), 'utf8'))
  assert.equal(manifest.dependencies['@deepseek-ai/dsh'], TO)
  assert.equal(manifest.dependencies['@deepseek-ai/dsh-base'], TO)
  assert.equal(manifest.dependencies['@deepseek-ai/cordis-plugin-group'], '^1.0.1', 'packages not published at the target keep their range')
  assert.deepEqual(siblingsOf(fx.install), [`dsh.prev-${FROM}`], 'no staged or failed copies left behind')
  assert.match(fx.log('systemctl.log'), /stop dsh-test[\s\S]*start dsh-test/)
  const tags = await new ConfigRepo(fx.home).listTags('pre-upgrade-')
  assert.equal(tags.length, 1)
  assert.equal(tags[0].meta.dshVersion, FROM)
})

test('upgrade: a new version that boots with failed plugins is rolled back', async () => {
  const fx = fixture()
  await goodBaseline(fx)
  fx.flag('bad-version', TO)
  const job = await runJob(fx, 'upgrade', { target: TO })
  assert.equal(job.status, 'rolled-back', JSON.stringify(job, null, 2))
  assert.equal(job.failedStep, 'health')
  assert.match(job.error, /web-app/)
  assert.equal(readDshVersion(fx.install), FROM, 'previous install restored')
  assert.deepEqual(siblingsOf(fx.install), [], 'failed and staged copies cleaned up')
  assert.equal(readFileSync(join(fx.state, 'state'), 'utf8').trim(), 'active')
})

test('upgrade: npm failure stops before touching the running service', async () => {
  const fx = fixture()
  fx.flag('npm-fail')
  const job = await runJob(fx, 'upgrade', { target: TO })
  assert.equal(job.status, 'failed')
  assert.equal(job.failedStep, 'stage')
  assert.equal(readDshVersion(fx.install), FROM)
  assert.doesNotMatch(fx.log('systemctl.log'), /\bstop\b/, 'dsh was never stopped')
  assert.deepEqual(siblingsOf(fx.install), [])
})

test('upgrade: a staged version whose config does not compose is rejected', async () => {
  const fx = fixture()
  fx.flag('dump-fail-version', TO)
  const job = await runJob(fx, 'upgrade', { target: TO })
  assert.equal(job.status, 'failed')
  assert.equal(job.failedStep, 'dump-config')
  assert.match(job.error, /duplicate loader entry id/)
  assert.equal(readDshVersion(fx.install), FROM)
  assert.doesNotMatch(fx.log('systemctl.log'), /\bstop\b/)
})

test('upgrade: simulated health failure exercises the full rollback path', async () => {
  const fx = fixture()
  const repo = await goodBaseline(fx)
  const job = await runJob(fx, 'upgrade', { target: TO }, { simulateFailure: 'health' })
  assert.equal(job.status, 'rolled-back', JSON.stringify(job.steps))
  assert.equal(readDshVersion(fx.install), FROM)
  // The rejected TO boot was healthy long enough to be tagged; that tag must go.
  const good = await repo.listTags('good-')
  assert.equal(good.some((tag) => tag.meta.dshVersion === TO), false, JSON.stringify(good))
  assert.equal(good[0].meta.dshVersion, FROM, 'newest good tag is the rolled-back boot')
})

const JOURNAL = [
  'Started dsh.service - DeepSeek Harness Web UI.',
  'dsh web: http://127.0.0.1:3080/?token=secret-login-token',
  '[esc-stop] settings registration failed TypeError: settingsCtx.settings.register is not a function',
  '    at Object.callback (file:///opt/smart-dsh/dsh-esc-stop/lib/index.js:24:25)',
  '',
].join('\n')

test('upgrade: stale patches and logged plugin errors are reported as warnings', async () => {
  const fx = fixture()
  await goodBaseline(fx)
  fx.flag('dump-warn')
  fx.flag('journal', JOURNAL)
  const job = await runJob(fx, 'upgrade', { target: TO })
  assert.equal(job.status, 'ok', JSON.stringify(job, null, 2))
  const texts = job.warnings.map((w) => w.text)
  assert.ok(texts.some((t) => t.includes('entry "agent-presets" not found')), texts.join('\n'))
  assert.ok(texts.some((t) => t.includes('settings.register is not a function')))
  assert.ok(!texts.some((t) => t.includes('token=')), 'login tokens never reach job files')
  assert.ok(!texts.some((t) => t.trim().startsWith('at ')), 'stack frames are dropped')
})

test('upgrade: failOnWarnings turns a noisy boot into a rollback', async () => {
  const fx = fixture()
  await goodBaseline(fx)
  fx.flag('journal', JOURNAL)
  const job = await runJob(fx, 'upgrade', { target: TO }, { failOnWarnings: true })
  assert.equal(job.status, 'rolled-back', JSON.stringify(job.steps))
  assert.equal(job.failedStep, 'warnings')
  assert.equal(readDshVersion(fx.install), FROM)
})

test('dry run reports config warnings for the target version', async () => {
  const fx = fixture()
  fx.flag('dump-warn')
  const job = await runJob(fx, 'upgrade', { target: TO, dryRun: true })
  assert.equal(job.status, 'ok')
  assert.equal(job.warnings.length, 1)
  assert.equal(job.warnings[0].source, 'config web')
})

test('upgrade: already on the target is a no-op', async () => {
  const fx = fixture()
  const job = await runJob(fx, 'upgrade', { target: FROM })
  assert.equal(job.status, 'noop')
  assert.equal(fx.log('systemctl.log').includes('stop'), false)
})

test('dry run validates a staged copy and changes nothing', async () => {
  const fx = fixture()
  const job = await runJob(fx, 'upgrade', { target: 'latest', dryRun: true })
  assert.equal(job.status, 'ok', JSON.stringify(job, null, 2))
  assert.equal(job.report.to, TO)
  assert.equal(job.report.pinned, 2)
  assert.equal(readDshVersion(fx.install), FROM)
  assert.deepEqual(siblingsOf(fx.install), [])
  assert.equal(fx.log('systemctl.log').includes('stop'), false)
})

test('rollback restores config from a snapshot and restarts', async () => {
  const fx = fixture()
  const repo = await goodBaseline(fx)
  const before = readFileSync(join(fx.home, 'settings.yaml'), 'utf8')
  writeFileSync(join(fx.home, 'settings.yaml'), 'broken: [\n')
  await repo.snapshot('edit that breaks things')
  const job = await runJob(fx, 'rollback', { ref: 'good-20260928-000000' })
  assert.equal(job.status, 'ok', JSON.stringify(job, null, 2))
  assert.equal(readFileSync(join(fx.home, 'settings.yaml'), 'utf8'), before)
  assert.match((await repo.recent(1))[0].subject, /rollback to good-20260928-000000/)
})

test('rollback to a tag from an older dsh swaps the saved install back', async () => {
  const fx = fixture()
  await goodBaseline(fx)
  assert.equal((await runJob(fx, 'upgrade', { target: TO })).status, 'ok')
  const job = await runJob(fx, 'rollback', { ref: 'good-20260928-000000' })
  assert.equal(job.status, 'ok', JSON.stringify(job, null, 2))
  assert.equal(readDshVersion(fx.install), FROM)
  assert.equal(readDshVersion(`${fx.install}.prev-${TO}`), TO, 'the newer install is kept for a roll-forward')
})

test('auto-rollback recovers from a broken hand edit, once', async () => {
  const fx = fixture()
  const repo = await goodBaseline(fx)
  writeFileSync(join(fx.home, 'profiles', 'web', 'cordis.patch.yml'), '- insert:\n    - id: web-fetch-http\n')
  await repo.snapshot('auto: profiles/web/cordis.patch.yml')
  const job = await runJob(fx, 'auto-rollback', {})
  assert.equal(job.status, 'ok', JSON.stringify(job, null, 2))
  assert.match(readFileSync(join(fx.home, 'profiles', 'web', 'cordis.patch.yml'), 'utf8'), /searchProvider/)
  const again = await runJob(fx, 'auto-rollback', {})
  assert.equal(again.status, 'failed')
  assert.match(again.error, /already attempted/)
})

test('auto-rollback does nothing when the config already matches the good tag', async () => {
  const fx = fixture()
  await goodBaseline(fx)
  const job = await runJob(fx, 'auto-rollback', {})
  assert.equal(job.status, 'failed')
  assert.match(job.error, /not a config change/)
})

test('refreshMirror drops dangling links and adds new scoped packages', async () => {
  const fx = fixture()
  const { mkdirSync, symlinkSync } = await import('node:fs')
  const mirror = join(fx.home, 'profiles', 'node_modules')
  mkdirSync(join(mirror, '@deepseek-ai'), { recursive: true })
  symlinkSync(join(fx.install, 'node_modules', '@deepseek-ai', 'dsh'), join(mirror, '@deepseek-ai', 'dsh'))
  symlinkSync(join(fx.install, 'node_modules', '@deepseek-ai', 'gone'), join(mirror, '@deepseek-ai', 'gone'))
  mkdirSync(join(fx.install, 'node_modules', '@deepseek-ai', 'dsh-new'), { recursive: true })
  const result = refreshMirror(fx.home, fx.install)
  assert.deepEqual(result, { added: 1, removed: 1 })
  assert.ok(existsSync(join(mirror, '@deepseek-ai', 'dsh-new')))
})

// ── review findings ────────────────────────────────────────────────────────

test('job lock: two jobs started together never both run, and the loser leaves the winner\'s lock', async () => {
  const fx = fixture()
  let release
  const gate = new Promise((resolve) => {
    release = resolve
  })
  const slowFetch = async (url, init) => {
    await gate // hold the first job inside its critical section
    return fx.fetchImpl(url, init)
  }
  const first = createJob(fx.home, 'upgrade', { target: 'latest', dryRun: true }, fx.context)
  const second = createJob(fx.home, 'upgrade', { target: 'latest', dryRun: true }, fx.context)
  const a = new JobRunner(readJson(first.path), first.path, { fetchImpl: slowFetch })
  const b = new JobRunner(readJson(second.path), second.path, { fetchImpl: fx.fetchImpl })
  const running = a.runJob()
  await b.runJob()
  assert.equal(b.job.status, 'failed')
  assert.match(b.job.error, new RegExp(`job ${first.id} is already running`))
  assert.equal(readJson(lockPath(fx.home))?.id, first.id, 'the losing job did not delete the winner\'s lock')
  release()
  await running
  assert.equal(a.job.status, 'ok', JSON.stringify(a.job.steps))
  assert.equal(existsSync(lockPath(fx.home)), false)
})

test('job lock: a lock left by a dead process is taken over, a live one is not', () => {
  const fx = fixture()
  writeJson(lockPath(fx.home), { id: 'crashed', pid: 2 ** 22 + 12345, at: 'x' })
  assert.deepEqual(acquireLock(fx.home, 'next'), { acquired: true })
  assert.equal(readJson(lockPath(fx.home)).id, 'next')
  const busy = acquireLock(fx.home, 'third')
  assert.equal(busy.acquired, false)
  assert.equal(busy.holder.id, 'next')
  releaseLock(fx.home, 'third') // not the owner: no effect
  assert.equal(readJson(lockPath(fx.home)).id, 'next')
  releaseLock(fx.home, 'next')
  assert.equal(existsSync(lockPath(fx.home)), false)
})

/** A 0.1.5 link projection that dsh 0.1.7 deletes when it composes the profile. */
function legacyProjection(fx) {
  const web = join(fx.home, 'profiles', 'web')
  mkdirSync(join(web, '.dsh-module-fallback', 'node_modules', 'legacy-pkg'), { recursive: true })
  symlinkSync('../.dsh-module-fallback/node_modules/legacy-pkg', join(web, 'node_modules', 'legacy-pkg'))
  const isLink = (path) => {
    try {
      return lstatSync(path).isSymbolicLink()
    } catch {
      return false
    }
  }
  return () => ({
    manifest: readFileSync(join(web, 'package.json'), 'utf8'),
    rootConfig: existsSync(join(web, 'cordis.yml')),
    link: isLink(join(web, 'node_modules', 'legacy-pkg')),
    projection: existsSync(join(web, '.dsh-module-fallback')),
  })
}

test('validation: a dry run composes in a throwaway home and leaves the live one untouched', async () => {
  const fx = fixture()
  const live = legacyProjection(fx)
  const before = live()
  const job = await runJob(fx, 'upgrade', { target: TO, dryRun: true })
  assert.equal(job.status, 'ok', JSON.stringify(job, null, 2))
  assert.deepEqual(live(), before, 'manifest, cordis.yml and legacy links unchanged')
  const homes = fx.log('dump-homes').trim().split('\n')
  assert.ok(homes.length > 0 && homes.every((home) => home !== fx.home), homes.join('\n'))
  assert.deepEqual(readdirSync(join(fx.home, 'safe-upgrade')).filter((name) => name.startsWith('validate-')), [], 'validation home removed')
  assert.ok(existsSync(join(fx.home, 'profiles', 'web', 'node_modules', 'x', 'index.js')), 'symlinked node_modules survived the cleanup')
})

test('validation: an upgrade rejected at dump-config changed nothing live', async () => {
  const fx = fixture()
  const live = legacyProjection(fx)
  const before = live()
  fx.flag('dump-fail-version', TO)
  const job = await runJob(fx, 'upgrade', { target: TO })
  assert.equal(job.status, 'failed')
  assert.equal(job.failedStep, 'dump-config')
  assert.deepEqual(live(), before)
})

test('rollback: a swap that fails half way is undone half way', async () => {
  const fx = fixture()
  await goodBaseline(fx)
  assert.equal((await runJob(fx, 'upgrade', { target: TO })).status, 'ok')
  const job = await runJob(fx, 'rollback', { ref: 'good-20260928-000000' }, { simulateFailure: 'swap' })
  assert.equal(job.status, 'failed', JSON.stringify(job.steps))
  assert.equal(job.failedStep, 'swap')
  assert.match(job.note, /restored the state from before it/)
  assert.equal(readDshVersion(fx.install), TO, 'the live install is back in place')
  assert.equal(readDshVersion(`${fx.install}.prev-${FROM}`), FROM, 'the target install is still kept')
  assert.equal(readFileSync(join(fx.state, 'state'), 'utf8').trim(), 'active')
})

test('upgrade: a swap that fails half way restores the previous install', async () => {
  const fx = fixture()
  await goodBaseline(fx)
  const job = await runJob(fx, 'upgrade', { target: TO }, { simulateFailure: 'swap' })
  assert.equal(job.status, 'rolled-back', JSON.stringify(job.steps))
  assert.equal(readDshVersion(fx.install), FROM)
  assert.deepEqual(siblingsOf(fx.install), [])
})

test('rollback: a failed stop aborts before any install or config change', async () => {
  const fx = fixture()
  const repo = await goodBaseline(fx)
  writeFileSync(join(fx.home, 'settings.yaml'), 'edited: true\n')
  await repo.snapshot('edit')
  fx.flag('stop-fail')
  const job = await runJob(fx, 'rollback', { ref: 'good-20260928-000000' })
  assert.equal(job.status, 'failed', JSON.stringify(job.steps))
  assert.equal(job.failedStep, 'stop')
  assert.match(job.error, /could not stop dsh-test \(now active\)/)
  assert.equal(readFileSync(join(fx.home, 'settings.yaml'), 'utf8'), 'edited: true\n', 'config untouched')
  assert.doesNotMatch(fx.log('systemctl.log'), /\bstart dsh-test/)
})

test('upgrade: a failed stop leaves the install and config as they were', async () => {
  const fx = fixture()
  await goodBaseline(fx)
  fx.flag('stop-fail')
  const job = await runJob(fx, 'upgrade', { target: TO })
  assert.equal(job.status, 'failed')
  assert.equal(job.failedStep, 'stop')
  assert.equal(readDshVersion(fx.install), FROM)
  assert.deepEqual(siblingsOf(fx.install), [], 'staged copy discarded')
})

test('failOnWarnings: a dry run with warnings fails', async () => {
  const fx = fixture()
  fx.flag('dump-warn')
  const job = await runJob(fx, 'upgrade', { target: TO, dryRun: true }, { failOnWarnings: true })
  assert.equal(job.status, 'failed')
  assert.equal(job.failedStep, 'warnings')
})

test('failOnWarnings: an upgrade with config warnings stops before dsh is touched', async () => {
  const fx = fixture()
  await goodBaseline(fx)
  fx.flag('dump-warn')
  const job = await runJob(fx, 'upgrade', { target: TO }, { failOnWarnings: true })
  assert.equal(job.status, 'failed')
  assert.equal(job.failedStep, 'warnings')
  assert.doesNotMatch(fx.log('systemctl.log'), /\bstop\b/)
})

test('failOnWarnings: a manual rollback whose boot logs errors is undone', async () => {
  const fx = fixture()
  const repo = await goodBaseline(fx)
  writeFileSync(join(fx.home, 'settings.yaml'), 'edited: true\n')
  await repo.snapshot('edit')
  fx.flag('journal', JOURNAL)
  const job = await runJob(fx, 'rollback', { ref: 'good-20260928-000000' }, { failOnWarnings: true })
  assert.equal(job.status, 'failed', JSON.stringify(job.steps))
  assert.equal(job.failedStep, 'warnings')
  assert.equal(readFileSync(join(fx.home, 'settings.yaml'), 'utf8'), 'edited: true\n', 'pre-rollback config is back')
})

test('failOnWarnings: automatic recovery is not undone by warnings', async () => {
  const fx = fixture()
  const repo = await goodBaseline(fx)
  writeFileSync(join(fx.home, 'profiles', 'web', 'cordis.patch.yml'), '- insert:\n    - id: web-fetch-http\n')
  await repo.snapshot('auto: profiles/web/cordis.patch.yml')
  fx.flag('journal', JOURNAL)
  const job = await runJob(fx, 'auto-rollback', {}, { failOnWarnings: true })
  assert.equal(job.status, 'ok', JSON.stringify(job.steps))
})

test('idle: a turn that started during staging stops the upgrade before dsh is stopped', async () => {
  const fx = fixture()
  await goodBaseline(fx)
  writeJson(join(fx.home, 'safe-upgrade', 'turns.json'), { pid: process.pid, running: [{ session: 's1', since: new Date().toISOString() }] })
  const job = await runJob(fx, 'upgrade', { target: TO }, { idleWaitMs: 300 })
  assert.equal(job.status, 'failed')
  assert.equal(job.failedStep, 'idle')
  assert.match(job.error, /1 turn\(s\) still running/)
  assert.doesNotMatch(fx.log('systemctl.log'), /\bstop\b/)
  assert.equal(readDshVersion(fx.install), FROM)
  assert.deepEqual(siblingsOf(fx.install), [])
})

test('idle: the upgrade waits for a running turn to end, then proceeds', async () => {
  const fx = fixture()
  await goodBaseline(fx)
  const turns = join(fx.home, 'safe-upgrade', 'turns.json')
  const jobs = join(fx.home, 'safe-upgrade', 'jobs')
  writeJson(turns, { pid: process.pid, running: [{ session: 's1', since: new Date().toISOString() }] })
  // The turn ends once the supervisor has started waiting for it.
  const ends = setInterval(() => {
    const logs = existsSync(jobs) ? readdirSync(jobs).filter((name) => name.endsWith('.log')) : []
    if (logs.some((name) => readFileSync(join(jobs, name), 'utf8').includes('waiting up to'))) {
      writeJson(turns, { pid: process.pid, running: [] })
      clearInterval(ends)
    }
  }, 100)
  const job = await runJob(fx, 'upgrade', { target: TO }, { idleWaitMs: 20_000 })
  clearInterval(ends)
  assert.equal(job.status, 'ok', JSON.stringify(job.steps))
  assert.ok(job.steps.find((step) => step.name === 'idle').detail.waitedMs > 0)
})

test('idle: a forced upgrade does not wait', async () => {
  const fx = fixture()
  await goodBaseline(fx)
  writeJson(join(fx.home, 'safe-upgrade', 'turns.json'), { pid: process.pid, running: [{ session: 's1', since: new Date().toISOString() }] })
  const job = await runJob(fx, 'upgrade', { target: TO, force: true }, { idleWaitMs: 300 })
  assert.equal(job.status, 'ok', JSON.stringify(job.steps))
})

test('auto-rollback prefers a good tag it can return to over a newer one whose install is gone', async () => {
  const fx = fixture()
  const repo = await goodBaseline(fx) // FROM, the running version
  await new Promise((resolve) => setTimeout(resolve, 1100)) // distinct creatordate
  await repo.tag('good-20260928-000100', { dshVersion: '0.0.9-pruned' }) // newer, install long gone
  writeFileSync(join(fx.home, 'profiles', 'web', 'cordis.patch.yml'), '- insert:\n    - id: web-fetch-http\n')
  await repo.snapshot('auto: profiles/web/cordis.patch.yml')
  const job = await runJob(fx, 'auto-rollback', {})
  assert.equal(job.status, 'ok', JSON.stringify(job.steps))
  assert.equal(job.report.ref, 'good-20260928-000000')
})
