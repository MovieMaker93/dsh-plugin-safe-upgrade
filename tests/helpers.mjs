// Test fixture: a fake dsh install + DSH_HOME, and stub `systemctl`, `npm`,
// `systemd-run` binaries on PATH that simulate a dsh service booting.
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Fixtures live until the test process exits, then go (they held ~0.25 MB each, forever).
const roots = []
process.once('exit', () => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

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
    # One line per EnvironmentFile=, like systemd; none by default.
    if [ -f "$S/envfiles" ]; then sed 's/^/EnvironmentFiles=/; s/$/ (ignore_errors=no)/' "$S/envfiles"; else echo "EnvironmentFiles="; fi
    echo "User=$(cat "$S/unit-user" 2>/dev/null)"
    echo "Group=$(cat "$S/unit-group" 2>/dev/null)"
    echo "MainPID=4242"
    echo "ActiveState=$(cat "$S/state" 2>/dev/null || echo active)"
    ;;
  is-active) cat "$S/state" 2>/dev/null || echo active ;;
  stop)
    if [ -f "$S/stop-fail" ]; then echo "Failed to stop $2.service: Access denied" >&2; exit 1; fi
    echo inactive > "$S/state" ;;
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

// The fake dsh launcher: only --dump-config matters to the engine. Like dsh
// 0.1.7 it writes while composing: the profile's root cordis.yml, a
// normalized manifest, and it deletes 0.1.5 link projections.
const DSH = `#!/bin/sh
self=$(readlink -f "$0")
version=$(node -p "require('$(dirname "$self")/../package.json').version")
profile=web
prev=
for arg in "$@"; do [ "$prev" = "--profile" ] && profile=$arg; prev=$arg; done
P="$DSH_HOME/profiles/$profile"
echo "$DSH_HOME" >> "$FAKE_STATE_DIR/dump-homes"
case " $* " in
  *" --dump-config "*)
    # Loading the profile writes before composing can fail, as in dsh 0.1.7.
    if [ -d "$P/.dsh-module-fallback" ]; then
      find "$P/node_modules/" -maxdepth 1 -type l -lname '*dsh-module-fallback*' -delete
      rm -rf "$P/.dsh-module-fallback"
    fi
    printf '{"name":"dsh-profile-%s","normalized":true}\\n' "$profile" > "$P/package.json"
    printf '# root config written by dump-config\\n' > "$P/cordis.yml"
    if [ -f "$FAKE_STATE_DIR/dump-fail" ] || { [ -f "$FAKE_STATE_DIR/dump-fail-version" ] && [ "$(cat "$FAKE_STATE_DIR/dump-fail-version")" = "$version" ]; } \\
      || grep -q 'web-fetch-http' "$P/cordis.patch.yml" 2>/dev/null; then
      echo "error: duplicate loader entry id web-fetch-http" >&2
      exit 1
    fi
    if [ -f "$FAKE_STATE_DIR/dump-warn" ]; then
      echo 'dsh: [profiles/web/cordis.patch.yml] patch: entry "agent-presets" not found' >&2
    fi
    echo "- id: web"
    if [ -f "$FAKE_STATE_DIR/dump-presets" ]; then
      # A preset registry, its default preset, and every preset row the profile patch inserts.
      printf "%s\\n" "- id: agent-preset-registry" "  name: '@deepseek-ai/dsh-agent-preset-registry'" "  config:" "    default: standard" \\
        "- id: preset-standard" "  name: '@deepseek-ai/dsh-agent-preset'" "  config:" "    id: standard" "    order: 1" \\
        "    plugins:" "      - id: tool-fs" "        name: '@deepseek-ai/dsh-tool-fs'"
      grep -o '^    - id: preset-[A-Za-z0-9_.-]*' "$P/cordis.patch.yml" 2>/dev/null | sed 's/.*id: preset-//' | while read -r id; do
        printf "%s\\n" "- id: preset-$id" "  name: '@deepseek-ai/dsh-agent-preset'" "  config:" "    id: $id" "    plugins: []"
      done
    fi
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
  roots.push(root)
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
  // What the host half publishes inside a running dsh: no turn running.
  mkdirSync(join(home, 'safe-upgrade'), { recursive: true })
  writeFileSync(join(home, 'safe-upgrade', 'turns.json'), JSON.stringify({ pid: process.pid, running: [] }))

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
    uiCheck: false, // engine tests stub the UI checker explicitly where it matters
  }

  const flag = (name, value = '') => writeFileSync(join(state, name), value)
  const log = (name) => (existsSync(join(state, name)) ? readFileSync(join(state, name), 'utf8') : '')
  /** A stored session directory under $DSH_HOME/sessions holding one generation file. */
  const storeSession = (session, file = 'session.v4.jsonl.zstd', project = '--root-work--') => {
    mkdirSync(join(home, 'sessions', project, session), { recursive: true })
    writeFileSync(join(home, 'sessions', project, session, file), '')
  }
  return { root, home, install, state, bin, context, fetchImpl, flag, log, storeSession }
}
