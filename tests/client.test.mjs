import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import vm from 'node:vm'

function loadClient(fetchImpl) {
  let definition
  const sandbox = {
    window: { __ModuleLoader__: { load: (def) => { definition = def } } },
    fetch: fetchImpl,
    localStorage: new Map(Object.entries({})),
    // Unref'd so the job-follow poll never keeps the test process alive.
    setTimeout: (fn, ms) => {
      const timer = setTimeout(fn, ms)
      timer.unref()
      return timer
    },
    clearTimeout,
    console,
  }
  sandbox.localStorage.getItem = (key) => sandbox.localStorage.get(key) ?? null
  sandbox.localStorage.setItem = (key, value) => sandbox.localStorage.set(key, value)
  vm.runInNewContext(readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8'), sandbox)
  assert.equal(definition.id, 'dsh-plugin-safe-upgrade')
  return definition.factory(() => ({}))
}

const STATUS = {
  supervised: true,
  idle: true,
  runningTurns: 0,
  dshVersion: '0.1.5-rc.1',
  channel: 'latest',
  updates: {
    latest: { version: '0.1.7-rc.2', newer: true },
    next: { version: '0.2.0-rc.1', newer: true },
    alpha: { version: '0.1.5-alpha.1', newer: false },
  },
  checkedAt: new Date().toISOString(),
  guard: true,
  goodTags: [{ name: 'good-20260928-201500', date: '2026-09-28T20:15:00+02:00', meta: { dshVersion: '0.1.5-rc.1' } }],
  snapshots: [{ sha: 'a'.repeat(40), date: '2026-09-28T20:16:00+02:00', subject: 'auto: settings.yaml' }],
}

test('client registers /upgrade and /rollback with live options', async () => {
  const posts = []
  const fetchImpl = async (url, init) => {
    if (init?.method === 'POST') {
      posts.push([url, JSON.parse(init.body)])
      return { ok: true, status: 202, json: async () => ({ ok: true, id: 'job1' }) }
    }
    return { ok: true, status: 200, json: async () => STATUS }
  }
  const mod = loadClient(fetchImpl)
  assert.deepEqual([...mod.inject], ['commandUi']) // spread: the array comes from the vm realm
  const commands = new Map()
  const scope = {
    get: () => ({ register: (command) => (commands.set(command.name, command), () => {}) }),
    effect: (fn) => fn(),
  }
  mod.apply({ effect: () => {}, inject: (_names, fn) => fn(scope) })
  assert.deepEqual([...commands.keys()], ['upgrade', 'rollback'])
  for (const command of commands.values()) {
    // dsh calls these on every dispatch ("contribution.available is not a function" otherwise).
    assert.equal(typeof command.available, 'function')
    assert.equal(command.available(), true)
    assert.equal(typeof command.description, 'function')
    assert.equal(command.ui.kind, 'popupSelect')
  }

  const upgradeOptions = await commands.get('upgrade').ui.options()
  const labels = upgradeOptions.map((o) => o.label)
  assert.ok(labels.includes('Upgrade to 0.1.7-rc.2 (latest)'))
  assert.ok(labels.includes('Upgrade to 0.2.0-rc.1 (next)'))
  assert.ok(labels.includes('Dry run 0.1.7-rc.2'))
  assert.ok(!labels.some((l) => l.includes('alpha')), 'older tags are not offered')

  await commands.get('upgrade').ui.onSelect(upgradeOptions.find((o) => o.id === 'upgrade:0.1.7-rc.2'))
  assert.deepEqual(posts.at(-1), ['/api/safe-upgrade/upgrade', { version: '0.1.7-rc.2' }])

  const rollbackOptions = await commands.get('rollback').ui.options()
  assert.equal(rollbackOptions.length, 2)
  await commands.get('rollback').ui.onSelect(rollbackOptions[0])
  assert.deepEqual(posts.at(-1), ['/api/safe-upgrade/rollback', { ref: 'good-20260928-201500' }])
})

test('client refuses to start a job while a turn runs', async () => {
  const fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ ...STATUS, idle: false, runningTurns: 2 }) })
  const mod = loadClient(fetchImpl)
  const commands = new Map()
  mod.apply({
    effect: () => {},
    inject: (_n, fn) => fn({ get: () => ({ register: (c) => (commands.set(c.name, c), () => {}) }), effect: (f) => f() }),
  })
  await assert.rejects(commands.get('upgrade').ui.onSelect({ id: 'upgrade:0.1.7-rc.2' }), /turn is running/)
})
