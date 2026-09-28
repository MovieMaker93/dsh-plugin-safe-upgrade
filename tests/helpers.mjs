// Test fixture: a fake dsh install + DSH_HOME, and stub `systemctl`, `npm`,
// `systemd-run` binaries on PATH that simulate a dsh service booting.
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export const REGISTRY = 'https://registry.test'
export const FROM = '0.1.5-rc.1'
export const TO = '0.1.7-rc.2'

const SYSTEMCTL = `#!/bin/sh
S="$FAKE_STATE_DIR"
echo "$*" >> "$S/systemctl.log"
[ "$1" = "--user" ] && shift
cmd="$1"
case "$cmd" in
  show)
    echo "ExecStart={ path=$FAKE_INSTALL/node_modules/.bin/dsh ; argv[]=$FAKE_INSTALL/node_modules/.bin/dsh web --host 127.0.0.1 --port 3999 ; ignore_errors=no ; start_time=[n/a] }"
    echo "Environment=HOME=$HOME DSH_HOME=$FAKE_HOME"
    echo "EnvironmentFiles="
    echo "MainPID=4242"
    echo "ActiveState=$(cat "$S/state" 2>/dev/null || echo active)"
    ;;
  is-active) cat "$S/state" 2>/dev/null || echo active ;;
  stop) echo inactive > "$S/state" ;;
  reset-failed|daemon-reload) : ;;
  start|restart)
    echo active > "$S/state"
    node -e '
      const fs = require("fs"), path = require("path")
      const [install, home, state] = process.argv.slice(1)
      const version = JSON.parse(fs.readFileSync(path.join(install, "node_modules/@deepseek-ai/dsh/package.json"))).version
      const badFile = path.join(state, "bad-version")
      const bad = fs.existsSync(badFile) && fs.readFileSync(badFile, "utf8").trim() === version
      const dir = path.join(home, "safe-upgrade")
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(path.join(dir, "boot-ok.json"), JSON.stringify({
        writtenAt: new Date().toISOString(), dshVersion: version, healthy: !bad,
        failed: bad ? ["web-app (@deepseek-ai/dsh-web-app)"] : [], brokenPresets: [], loaded: 42,
      }))
    ' "$FAKE_INSTALL" "$FAKE_HOME" "$S"
    # Like the host half: a healthy boot tags HEAD good-* with its dsh version.
    if [ -d "$FAKE_HOME/.git" ] && grep -q '"healthy":true' "$FAKE_HOME/safe-upgrade/boot-ok.json"; then
      ver=$(node -p "require('$FAKE_INSTALL/node_modules/@deepseek-ai/dsh/package.json').version")
      git -C "$FAKE_HOME" -c user.name=t -c user.email=t@t -c tag.gpgsign=false tag -a "good-boot-$(date +%s%N)" -m "{\\"dshVersion\\":\\"$ver\\"}" >/dev/null 2>&1 || true
    fi
    ;;
esac
exit 0
`

const NPM = `#!/bin/sh
echo "$*" >> "$FAKE_STATE_DIR/npm.log"
if [ -f "$FAKE_STATE_DIR/npm-fail" ]; then echo "npm ERR! simulated failure" >&2; exit 1; fi
node -e '
  const fs = require("fs")
  const manifest = JSON.parse(fs.readFileSync("package.json", "utf8"))
  for (const [name, range] of Object.entries(manifest.dependencies ?? {})) {
    if (!name.startsWith("@deepseek-ai/")) continue
    const dir = "node_modules/" + name
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(dir + "/package.json", JSON.stringify({ name, version: range.replace(/^[~^]/, "") }))
  }
'
`

const SYSTEMD_RUN = `#!/bin/sh
echo "$*" >> "$FAKE_STATE_DIR/systemd-run.log"
exit 0
`

const JOURNALCTL = `#!/bin/sh
cat "$FAKE_STATE_DIR/journal" 2>/dev/null
exit 0
`

// The fake dsh launcher: only --dump-config matters to the engine.
const DSH = `#!/bin/sh
self=$(readlink -f "$0")
version=$(node -p "require('$(dirname "$self")/../package.json').version")
case " $* " in
  *" --dump-config "*)
    if [ -f "$FAKE_STATE_DIR/dump-fail" ] || { [ -f "$FAKE_STATE_DIR/dump-fail-version" ] && [ "$(cat "$FAKE_STATE_DIR/dump-fail-version")" = "$version" ]; }; then
      echo "error: duplicate loader entry id web-fetch-http" >&2
      exit 1
    fi
    if [ -f "$FAKE_STATE_DIR/dump-warn" ]; then
      echo 'dsh: [profiles/web/cordis.patch.yml] patch: entry "agent-presets" not found' >&2
    fi
    echo "- id: web"
    ;;
esac
exit 0
`

function exe(path, text) {
  writeFileSync(path, text, 'utf8')
  chmodSync(path, 0o755)
}

/**
 * Build a fresh fixture and point PATH/env at it.
 * @returns {{root, home, install, state, bin, context: object, fetchImpl: Function, flag: Function}}
 */
export function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-safe-upgrade-'))
  const home = join(root, 'home')
  const install = join(root, 'share', 'dsh')
  const state = join(root, 'state')
  const bin = join(root, 'bin')
  for (const dir of [home, install, state, bin, join(home, 'profiles', 'web'), join(home, 'sessions')]) mkdirSync(dir, { recursive: true })

  writeFileSync(join(home, 'settings.yaml'), 'agent-default-model:\n  provider: spark-local\n  model: qwen\n')
  writeFileSync(join(home, 'runtime.env'), 'LITELLM_API_KEY=sk-live-should-never-be-committed-1234567890\n')
  writeFileSync(join(home, 'profiles', 'web', 'package.json'), JSON.stringify({ name: 'dsh-profile-web', dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } } }, null, 2))
  writeFileSync(join(home, 'profiles', 'web', 'cordis.patch.yml'), '- id: web\n  config:\n    searchProvider: ddg-shim\n')
  mkdirSync(join(home, 'profiles', 'web', 'node_modules', 'x'), { recursive: true })
  writeFileSync(join(home, 'profiles', 'web', 'node_modules', 'x', 'index.js'), '')
  writeFileSync(join(home, 'sessions', 'one.jsonl'), '{}\n')

  writeFileSync(join(install, 'package.json'), JSON.stringify({
    dependencies: {
      '@deepseek-ai/cordis-plugin-group': '^1.0.1',
      '@deepseek-ai/dsh': `^${FROM}`,
      '@deepseek-ai/dsh-base': `^${FROM}`,
      react: '^18.3.1',
    },
  }, null, 2))
  const dshPkg = join(install, 'node_modules', '@deepseek-ai', 'dsh')
  mkdirSync(join(dshPkg, 'lib'), { recursive: true })
  writeFileSync(join(dshPkg, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: FROM }))
  exe(join(dshPkg, 'lib', 'bin.js'), DSH)
  mkdirSync(join(install, 'node_modules', '.bin'), { recursive: true })
  symlinkSync('../@deepseek-ai/dsh/lib/bin.js', join(install, 'node_modules', '.bin', 'dsh'))

  exe(join(bin, 'systemctl'), SYSTEMCTL)
  exe(join(bin, 'npm'), NPM)
  exe(join(bin, 'systemd-run'), SYSTEMD_RUN)
  exe(join(bin, 'journalctl'), JOURNALCTL)
  writeFileSync(join(state, 'state'), 'active\n')

  process.env.PATH = `${bin}:${process.env.PATH}`
  process.env.FAKE_STATE_DIR = state
  process.env.FAKE_INSTALL = install
  process.env.FAKE_HOME = home
  process.env.DSH_HOME = home

  const fetchImpl = async (input) => {
    const url = String(input)
    const json = (value) => ({ ok: true, status: 200, json: async () => value })
    if (url.includes('/-/package/')) return json({ latest: TO, next: '0.2.0-rc.1' })
    if (url.startsWith(REGISTRY)) {
      const name = url.slice(REGISTRY.length + 1).replace('%2f', '/')
      const versions = name === '@deepseek-ai/cordis-plugin-group' ? { '1.0.1': {}, '1.0.2': {} } : { [FROM]: {}, [TO]: {} }
      return json({ versions })
    }
    const active = readFileSync(join(state, 'state'), 'utf8').trim() === 'active'
    if (!active) throw new Error('ECONNREFUSED')
    return { ok: false, status: 401, json: async () => ({}) }
  }

  const context = {
    home,
    installDir: install,
    unit: 'dsh-test',
    scope: 'system',
    profiles: ['web'],
    healthUrl: 'http://127.0.0.1:3999/',
    healthTimeoutMs: 8000,
    registry: REGISTRY,
    keepPrev: 2,
    requireMarker: true,
  }

  const flag = (name, value = '') => writeFileSync(join(state, name), value)
  const log = (name) => (existsSync(join(state, name)) ? readFileSync(join(state, name), 'utf8') : '')
  return { root, home, install, state, bin, context, fetchImpl, flag, log }
}
