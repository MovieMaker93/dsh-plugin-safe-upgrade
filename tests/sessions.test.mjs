import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import {
  compareProbes, hasSessions, installFormatVersion, legacyPresetPatch, packageEntry, presetsFromDump, probeSessions,
  sessionGenerations, withPatchRows,
} from '../lib/sessions.js'

const roots = []
after(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }) })
const temp = () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-safe-upgrade-sessions-'))
  roots.push(root)
  return root
}

// Shaped like `dsh --profile web --dump-config` of dsh 0.1.7: comments name
// source layers, rows carry `!!js` conditions.
const DUMP = `# composed from @deepseek-ai/dsh-base
- id: agent-preset-registry
  name: '@deepseek-ai/dsh-agent-preset-registry'
  config:
    default: standard
- id: preset-standard
  name: '@deepseek-ai/dsh-agent-preset'
  config:
    id: standard
    order: 1
    plugins:
      - id: persona
        name: '@deepseek-ai/dsh-persona'
        config:
          suffix: Your working directory is {{cwd}}.
      - id: tool-bash
        name: '@deepseek-ai/dsh-tool-bash'
        disabled: !!js process.platform === 'win32'
# from profiles/web/cordis.patch.yml
- id: preset-ptc
  name: "@deepseek-ai/dsh-agent-preset"
  config:
    id: ptc
    plugins: []
- id: preset-off
  name: '@deepseek-ai/dsh-agent-preset'
  disabled: true
  config:
    id: off
    plugins: []
- id: web
  name: '@deepseek-ai/dsh-web-app'
`

test('presetsFromDump: declared presets, the registry default, disabled rows skipped', () => {
  const presets = presetsFromDump(DUMP)
  assert.deepEqual(presets.defined, ['standard', 'ptc'])
  assert.equal(presets.defaultId, 'standard')
  assert.equal(presetsFromDump('- id: web\n  name: web-app\n'), undefined, 'no registry: dsh before 0.1.7')
})

test('legacyPresetPatch: copies the default preset under each retired ID, and composes back', () => {
  const patch = legacyPresetPatch(DUMP, ['standard-tools', 'old'], { dshVersion: '0.1.7-rc.2' })
  assert.match(patch, /# Added by dsh-safe-upgrade: legacy presets for sessions recorded under standard-tools, old/)
  assert.match(patch, /disabled: !!js process\.platform === 'win32'/, 'plugin rows, conditions included, are copied verbatim')
  assert.doesNotMatch(patch, /order: 1$/m)
  // The inserted rows, as a dump would list them once composed.
  const rows = patch.split('\n').filter((line) => line.startsWith('    ')).map((line) => line.slice(4)).join('\n')
  const composed = presetsFromDump(`${DUMP}${rows}\n`)
  assert.deepEqual(composed.defined, ['standard', 'ptc', 'standard-tools', 'old'])
  assert.throws(() => legacyPresetPatch(DUMP, ['x'], { sourceId: 'absent' }), /no "absent" preset to copy/)
  assert.throws(() => legacyPresetPatch('- id: web\n', ['x']), /no agent preset registry/)
})

test('withPatchRows: replaces the empty `[]` of a fresh profile patch, appends to a list', () => {
  const rows = '- insert:\n    - id: preset-x\n'
  const fresh = '# Your patch layer for this dsh profile\n# (comments kept)\n[]\n'
  assert.equal(withPatchRows(fresh, rows), `# Your patch layer for this dsh profile\n# (comments kept)\n${rows}`)
  assert.equal(withPatchRows('- id: web\n  disabled: true', rows), `- id: web\n  disabled: true\n${rows}`)
  assert.equal(withPatchRows('', rows), rows)
})

test('compareProbes: only sessions that open today count as regressions; undefined presets are listed', () => {
  const before = { ok: true, listed: 3, unreadable: [{ id: 'old-child', child: true, error: 'v2' }], presets: {} }
  const after = {
    ok: true,
    listed: 3,
    unreadable: [{ id: 'old-child', child: true, error: 'v2' }, { id: 'now-broken', child: false, error: 'boom' }],
    presets: { standard: 1, 'standard-tools': 2 },
  }
  const result = compareProbes(before, after, ['standard'])
  assert.deepEqual(result.regressions.map((row) => row.id), ['now-broken'])
  assert.deepEqual(result.missingPresets, { 'standard-tools': 2 })
  assert.equal(result.alreadyUnreadable, 1)
  assert.deepEqual(compareProbes({ ok: false, error: 'x' }, after, undefined), { regressions: [], missingPresets: {}, alreadyUnreadable: 0 })
})

test('sessionGenerations and hasSessions read the newest stored format per session', () => {
  const root = temp()
  const dir = (project, session, ...files) => {
    mkdirSync(join(root, project, session), { recursive: true })
    for (const file of files) writeFileSync(join(root, project, session, file), '')
  }
  dir('--root-a--', 'session-1', 'session.jsonl.zstd', 'session.v4.jsonl.zstd', 'session.lock')
  dir('--root-a--', 'session-2', 'session.v3.jsonl')
  dir('--root-b--', 'child', 'session.jsonl.zstd')
  dir('--root-b--', 'empty', 'session.lock')
  writeFileSync(join(root, 'stray.jsonl'), '')
  const found = Object.fromEntries(sessionGenerations(root).map((row) => [row.dir, row.version]))
  assert.deepEqual(found, { [join('--root-a--', 'session-1')]: 4, [join('--root-a--', 'session-2')]: 3, [join('--root-b--', 'child')]: 0 })
  assert.equal(hasSessions(root), true)
  assert.equal(hasSessions(join(root, 'absent')), false)
})

/** A stand-in install: cordis's Context and a JSONL store fed from `sessions.json`. */
function fakeInstall(formatVersion = 4) {
  const install = temp()
  const pkg = (name, manifest, files) => {
    const dir = join(install, 'node_modules', ...name.split('/'))
    mkdirSync(join(dir, 'lib'), { recursive: true })
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, type: 'module', ...manifest }))
    for (const [file, text] of Object.entries(files)) writeFileSync(join(dir, file), text)
  }
  pkg('@deepseek-ai/cordis', { exports: { '.': { types: './lib/index.d.ts', default: './lib/index.js' } } }, {
    'lib/index.js': 'export class Context {}\n',
  })
  pkg('@deepseek-ai/dsh-session', { main: 'lib/index.js' }, {
    'lib/index.js': `const SESSION_FORMAT_VERSION = ${formatVersion};\nexport { SESSION_FORMAT_VERSION }\n`,
  })
  pkg('@deepseek-ai/dsh-session-persistence-jsonl', { exports: { '.': './lib/index.js' } }, {
    'lib/index.js': `import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
export default class Store {
  constructor(ctx, config) { this.config = config }
  rows() { return JSON.parse(readFileSync(join(this.config.root, 'sessions.json'), 'utf8')) }
  async list() {
    if (this.config.compression === 'zstd' && existsSync(join(this.config.root, 'PLAIN'))) {
      throw new Error('session artifact "x" uses .jsonl, but this backend is configured for compression "zstd"')
    }
    return this.rows().map((row) => ({ header: row.header }))
  }
  async open(id, access) {
    if (access !== 'read') throw new Error('write access is not expected')
    const row = this.rows().find((candidate) => candidate.header.id === id)
    if (row.error) throw new Error(row.error + ' (raw log: /secret/path)')
    return { read: async () => ({ events: row.events ?? [] }), close: async () => {} }
  }
}
`,
  })
  return install
}

test('packageEntry resolves nested exports; installFormatVersion reads the session writer', () => {
  const install = fakeInstall(3)
  assert.match(packageEntry(install, '@deepseek-ai/cordis'), /cordis[\\/]lib[\\/]index\.js$/)
  assert.equal(installFormatVersion(install), 3)
  assert.equal(installFormatVersion(temp()), undefined)
})

test('probeSessions opens every session with the install\'s own store, read-only', async () => {
  const install = fakeInstall()
  const root = temp()
  writeFileSync(join(root, 'PLAIN'), '') // forces the uncompressed-root fallback
  writeFileSync(join(root, 'sessions.json'), JSON.stringify([
    { header: { id: 'a', cwd: '/w', agentPreset: 'standard-tools' } },
    { header: { id: 'b', cwd: '/w', agentPreset: 'standard' }, events: [{ type: 'agent-preset/selected', data: { agentPreset: 'minimal' } }] },
    { header: { id: 'c', cwd: '/w', agentPreset: 'standard-tools', origin: 'subagent' } },
    { header: { id: 'd', cwd: '/w', origin: 'subagent' }, error: 'subagent/descriptor 5 uses unsupported descriptor version 2' },
  ]))
  const result = await probeSessions(install, root)
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(result.listed, 4)
  assert.deepEqual(result.presets, { 'standard-tools': 1, minimal: 1 }, 'selections win; subagent children are not counted')
  assert.deepEqual(result.unreadable, [{ id: 'd', cwd: '/w', child: true, error: 'subagent/descriptor 5 uses unsupported descriptor version 2' }])
  const broken = await probeSessions(temp(), root)
  assert.equal(broken.ok, false)
  assert.match(broken.error, /cordis/)
})
