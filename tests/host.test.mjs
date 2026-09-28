import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { test } from 'node:test'
import { apply, detectUnit, healthUrlFromArgv, resolveConfig } from '../lib/index.js'
import { ConfigRepo } from '../lib/repo.js'
import { readJson } from '../lib/util.js'
import { fixture } from './helpers.mjs'

/** A minimal cordis-like host context (same approach as Smart-DSH's tests). */
function fakeHost(services) {
  const listeners = new Map()
  const disposers = []
  const routes = new Map()
  services.webServer = {
    register(route) {
      routes.set(route.path, route)
      return () => routes.delete(route.path)
    },
  }
  const scope = () => ({
    ...services,
    get: (name) => services[name],
    on(name, listener) {
      listeners.set(name, [...(listeners.get(name) ?? []), listener])
    },
    effect(fn) {
      const dispose = fn()
      if (typeof dispose === 'function') disposers.push(dispose)
    },
    inject(names, fn) {
      fn(scope())
    },
  })
  const ctx = scope()
  return {
    ctx,
    routes,
    emit: (name, ...args) => (listeners.get(name) ?? []).forEach((fn) => fn(...args)),
    dispose: () => disposers.forEach((fn) => fn()),
  }
}

async function call(route, { method = 'GET', body, authed = true } = {}) {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))])
  req.method = method
  req.headers = authed ? { cookie: 'ok' } : {}
  const res = {
    status: 0,
    body: '',
    writeHead(status) {
      this.status = status
    },
    end(text) {
      this.body = text ?? ''
    },
  }
  await route.handler(req, res)
  let json
  try {
    json = JSON.parse(res.body)
  } catch {}
  return { status: res.status, json }
}

test('detectUnit / healthUrlFromArgv / resolveConfig', () => {
  assert.deepEqual(detectUnit('0::/system.slice/dsh.service\n'), { unit: 'dsh', scope: 'system' })
  assert.deepEqual(detectUnit('0::/user.slice/user-1000.slice/user@1000.service/app.slice/dsh-web.service\n'), { unit: 'dsh-web', scope: 'user' })
  assert.equal(detectUnit('0::/user.slice/user-1000.slice/session-3.scope\n'), undefined)
  assert.equal(healthUrlFromArgv(['node', 'dsh', 'web', '--host', '0.0.0.0', '--port', '3080']), 'http://127.0.0.1:3080/')
  assert.equal(healthUrlFromArgv(['node', 'dsh', 'web', '--port=8080']), 'http://127.0.0.1:8080/')
  const fx = fixture()
  const config = resolveConfig({}, {
    home: fx.home,
    argv: ['node', join(fx.install, 'node_modules', '.bin', 'dsh'), 'web', '--port', '3080'],
    cgroup: '0::/system.slice/dsh.service',
  })
  assert.equal(config.unit, 'dsh')
  assert.equal(config.installDir, fx.install)
  assert.equal(config.profile, 'web')
  assert.deepEqual(config.profiles, ['web'])
  assert.equal(config.healthUrl, 'http://127.0.0.1:3080/')
})

test('host: boot check, auth, idle gating, job launch', async () => {
  const fx = fixture()
  const entries = [
    { id: 'web', options: { name: '@deepseek-ai/dsh-web-app' }, fiber: { state: 2 } },
    { id: 'grp', options: { name: 'cordis:group', group: true } },
  ]
  const host = fakeHost({
    connection: { requestRejection: (req) => (req.headers.cookie === 'ok' ? undefined : 401) },
    loader: { entries: () => entries },
    agentPresets: { compositionInventory: async () => [{ id: 'standard-tools', rows: [] }] },
    agents: {},
  })
  apply(host.ctx, { unit: 'dsh-test-fake', installDir: fx.install, profiles: ['web'] })
  try {
    // Boot check runs 3 s after load: marker + initial history + good tag.
    await new Promise((resolve) => setTimeout(resolve, 5000))
    const marker = readJson(join(fx.home, 'safe-upgrade', 'boot-ok.json'))
    assert.equal(marker.healthy, true)
    assert.equal(marker.dshVersion, '0.1.5-rc.1')
    const good = await new ConfigRepo(fx.home).listTags('good-')
    assert.equal(good.length, 1)
    assert.equal(good[0].meta.dshVersion, '0.1.5-rc.1')
    assert.ok(existsSync(join(fx.home, 'safe-upgrade', 'config.json')))

    const status = host.routes.get('/api/safe-upgrade/status')
    assert.equal((await call(status, { authed: false })).status, 401)
    const ok = await call(status)
    assert.equal(ok.status, 200)
    assert.equal(ok.json.dshVersion, '0.1.5-rc.1')
    assert.equal(ok.json.idle, true)
    assert.equal(ok.json.goodTags.length, 1)

    const upgrade = host.routes.get('/api/safe-upgrade/upgrade')
    assert.equal((await call(upgrade, { method: 'GET' })).status, 405)
    host.emit('session/event', { id: 's1' }, { type: 'turn/start' })
    const busy = await call(upgrade, { method: 'POST', body: { version: '0.1.7-rc.2' } })
    assert.equal(busy.status, 409)
    assert.match(busy.json.error, /turn is running/)
    host.emit('session/event', { id: 's1' }, { type: 'turn/end' })
    assert.equal((await call(upgrade, { method: 'POST', body: { version: '--evil' } })).status, 400)
    const launched = await call(upgrade, { method: 'POST', body: { version: '0.1.7-rc.2', dryRun: true } })
    assert.equal(launched.status, 202, JSON.stringify(launched.json))
    const runLog = readFileSync(join(fx.state, 'systemd-run.log'), 'utf8')
    assert.match(runLog, new RegExp(`--unit=dsh-safe-upgrade-${launched.json.id}`))
    assert.match(runLog, /supervisor\.mjs --job/)
    const job = readJson(join(fx.home, 'safe-upgrade', 'jobs', `${launched.json.id}.json`))
    assert.deepEqual(job.request, { target: '0.1.7-rc.2', dryRun: true })
    assert.equal(job.context.simulateFailure, undefined, 'fault injection only with testing: true')

    const rollback = host.routes.get('/api/safe-upgrade/rollback')
    assert.equal((await call(rollback, { method: 'POST', body: { ref: '-x' } })).status, 400)
    assert.equal((await call(rollback, { method: 'POST', body: { ref: 'nope' } })).status, 404)
  } finally {
    host.dispose()
  }
})

test('host: a failed plugin makes the boot unhealthy and skips the good tag', async () => {
  const fx = fixture()
  const host = fakeHost({
    connection: { requestRejection: () => undefined },
    loader: { entries: () => [{ id: 'web-fetch-http', options: { name: '@deepseek-ai/dsh-web-fetch-http' }, fiber: { state: 3 } }] },
    agents: {},
  })
  apply(host.ctx, { unit: 'dsh-test-fake', installDir: fx.install, profiles: ['web'] })
  try {
    await new Promise((resolve) => setTimeout(resolve, 5000))
    const marker = readJson(join(fx.home, 'safe-upgrade', 'boot-ok.json'))
    assert.equal(marker.healthy, false)
    assert.match(marker.failed[0], /web-fetch-http/)
    assert.equal((await new ConfigRepo(fx.home).listTags('good-')).length, 0)
  } finally {
    host.dispose()
  }
})
