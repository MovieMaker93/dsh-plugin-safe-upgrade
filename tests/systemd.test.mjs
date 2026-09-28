import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  RECOVER_TEMPLATE, guardedUnits, installGuard, parseEnvironmentProperty, parseExecStart, profileFromArgv, renderGuard,
} from '../lib/systemd.js'

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
