import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { JobRunner, createJob, refreshMirror } from '../lib/engine.js'
import { ConfigRepo } from '../lib/repo.js'
import { readDshVersion, readJson } from '../lib/util.js'
import { FROM, TO, fixture } from './helpers.mjs'

async function runJob(fx, kind, request, contextOverrides = {}) {
  const { path } = createJob(fx.home, kind, request, { ...fx.context, ...contextOverrides })
  const runner = new JobRunner(readJson(path), path, { fetchImpl: fx.fetchImpl })
  await runner.runJob()
  return runner.job
}

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
