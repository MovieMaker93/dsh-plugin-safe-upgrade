import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  RECOVER_TEMPLATE, describeUnit, guardedUnits, installGuard, parseEnvironmentProperty, parseExecStart,
  profileFromArgv, renderGuard, unitEnvironment,
} from '../lib/systemd.js'
import { fixture } from './helpers.mjs'

const spec = (unit) => ({
  unit, scope: 'system', node: '/usr/bin/node', cli: '/opt/p/bin/dsh-safe-upgrade.mjs',
  installDir: `/srv/${unit}/share/dsh`, home: `/srv/${unit}/home`, profile: 'web',
})

test('the recovery template is generic; the drop-in carries the unit specifics', () => {
  const { dropin, recover } = renderGuard(spec('dsh'))
  assert.match(dropin, /OnFailure=dsh-safe-upgrade-recover@%N\.service/)
  assert.match(dropin, /ExecStartPre=.* precheck --unit dsh .*--install-dir \/srv\/dsh\/share\/dsh --home \/srv\/dsh\/home --profile web/)
  assert.match(recover, /auto-rollback --unit %i --scope system/)
  assert.doesNotMatch(recover, /\/srv\//, 'no unit-specific paths in the shared template')
})

test('removing one unit\'s guard keeps the template while another unit is guarded', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'units-'))
  await installGuard(spec('dsh'), { dir, reload: false })
  await installGuard(spec('dsh-staging'), { dir, reload: false })
  assert.deepEqual(guardedUnits(dir).sort(), ['dsh', 'dsh-staging'])
  const first = await installGuard(spec('dsh-staging'), { dir, reload: false, remove: true })
  assert.equal(first.kept, true)
  assert.ok(existsSync(join(dir, RECOVER_TEMPLATE)))
  assert.match(readFileSync(join(dir, 'dsh.service.d', '50-safe-upgrade.conf'), 'utf8'), /--unit dsh /)
  const last = await installGuard(spec('dsh'), { dir, reload: false, remove: true })
  assert.equal(last.kept, false)
  assert.equal(existsSync(join(dir, RECOVER_TEMPLATE)), false)
})

test('recovery runs as the unit\'s own account; root units need no override', () => {
  const unprivileged = renderGuard({ ...spec('dsh'), user: 'dsh', group: 'dsh' })
  assert.match(unprivileged.recoverDropin, /^User=dsh$/m)
  assert.match(unprivileged.recoverDropin, /^Group=dsh$/m)
  assert.equal(renderGuard({ ...spec('dsh'), user: 'root' }).recoverDropin, undefined)
  assert.equal(renderGuard(spec('dsh')).recoverDropin, undefined)
  assert.equal(renderGuard({ ...spec('dsh'), scope: 'user', user: 'dsh' }).recoverDropin, undefined, 'a user manager runs as its user already')
})

test('the recovery account drop-in is installed next to the template and removed with the guard', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'units-'))
  const installed = await installGuard({ ...spec('dsh'), user: 'svc' }, { dir, reload: false })
  assert.equal(installed.recoverDropinPath, join(dir, 'dsh-safe-upgrade-recover@dsh.service.d', '50-safe-upgrade.conf'))
  assert.match(readFileSync(installed.recoverDropinPath, 'utf8'), /^User=svc$/m)
  assert.deepEqual(guardedUnits(dir), ['dsh'], 'the recovery instance is not a guarded unit')
  await installGuard({ ...spec('dsh'), user: 'root' }, { dir, reload: false })
  assert.equal(existsSync(installed.recoverDropinPath), false, 'reinstalling for a root unit drops the override')
  await installGuard({ ...spec('dsh'), user: 'svc' }, { dir, reload: false })
  await installGuard(spec('dsh'), { dir, reload: false, remove: true })
  assert.equal(existsSync(installed.recoverDropinPath), false)
})

test('describeUnit: EnvironmentFile= values override Environment=, later files win', async () => {
  const fx = fixture()
  const first = join(fx.root, 'first.env')
  const second = join(fx.root, 'second.env')
  writeFileSync(first, `DSH_HOME=/from/first\nONLY_FIRST=1\n`)
  writeFileSync(second, `DSH_HOME=/from/second\n`)
  writeFileSync(join(fx.state, 'envfiles'), `${first}\n${second}\n`)
  writeFileSync(join(fx.state, 'unit-user'), 'svc')
  const unit = await describeUnit('dsh-test')
  assert.equal(unit.env.DSH_HOME, '/from/second', 'the inline Environment= DSH_HOME is overridden')
  assert.equal(unit.env.ONLY_FIRST, '1')
  assert.equal(unit.env.HOME, process.env.HOME, 'inline values without a file override stay')
  assert.equal(unit.user, 'svc')
  assert.deepEqual(unitEnvironment({ Environment: 'A=inline B=inline', EnvironmentFiles: '' }), { A: 'inline', B: 'inline' })
})

test('unit introspection parsers', () => {
  const exec = '{ path=/x/node_modules/.bin/dsh ; argv[]=/x/node_modules/.bin/dsh web --host 127.0.0.1 --port 3080 --no-open ; ignore_errors=no ; start_time=[Mon] }'
  const argv = parseExecStart(exec)
  assert.deepEqual(argv, ['/x/node_modules/.bin/dsh', 'web', '--host', '127.0.0.1', '--port', '3080', '--no-open'])
  assert.equal(profileFromArgv(argv), 'web')
  assert.equal(profileFromArgv(['dsh', '--profile', 'headless', 'job']), 'headless')
  assert.deepEqual(
    parseEnvironmentProperty('HOME=/root DSH_HOME=/root/.dsh "GREETING=hello world" "Q=say \\"hi\\""'),
    { HOME: '/root', DSH_HOME: '/root/.dsh', GREETING: 'hello world', Q: 'say "hi"' },
  )
})
