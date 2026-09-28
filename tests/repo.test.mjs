import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { ConfigRepo, MAX_SCAN_BYTES, containsSecret } from '../lib/repo.js'
import { compare, newer } from '../lib/semver.js'
import { run } from '../lib/util.js'
import { fixture } from './helpers.mjs'

const tracked = async (repo) => (await repo.git(['ls-files'])).stdout.split('\n').filter(Boolean).sort()

test('ensure() starts a whitelist-only history', async () => {
  const fx = fixture()
  const repo = new ConfigRepo(fx.home)
  const { created } = await repo.ensure()
  assert.equal(created, true)
  assert.deepEqual(await tracked(repo), [
    '.gitignore',
    'profiles/web/cordis.patch.yml',
    'profiles/web/package.json',
    'settings.yaml',
  ])
  assert.equal((await repo.ensure()).created, false, 'second call adopts the repo')
})

test('an existing .gitignore is never overwritten', async () => {
  const fx = fixture()
  writeFileSync(join(fx.home, '.gitignore'), '# mine\n/sessions/\n')
  await new ConfigRepo(fx.home).ensure()
  assert.equal(readFileSync(join(fx.home, '.gitignore'), 'utf8'), '# mine\n/sessions/\n')
})

test('snapshot() refuses files that carry literal secrets', async () => {
  const fx = fixture()
  const warnings = []
  const repo = new ConfigRepo(fx.home, { log: (line) => warnings.push(line) })
  await repo.ensure()
  writeFileSync(join(fx.home, 'settings.yaml'), 'llm:\n  apiKey: sk-abcdefghijklmnopqrstuvwxyz123456\n')
  writeFileSync(join(fx.home, 'AGENTS.md'), '# notes\n')
  const sha = await repo.snapshot('edit')
  assert.ok(sha, 'the clean file is still committed')
  const committed = (await repo.git(['show', 'HEAD:settings.yaml'])).stdout
  assert.doesNotMatch(committed, /sk-abc/)
  assert.ok(warnings.some((line) => line.includes('settings.yaml')))
  assert.ok((await tracked(repo)).includes('AGENTS.md'))
})

test('containsSecret: env references are fine, literal keys are not', () => {
  assert.equal(containsSecret('apiKeyEnv: LITELLM_API_KEY\nmaxTokens: 32768\n'), false)
  assert.equal(containsSecret('token: !!js process.env.GITHUB_TOKEN\n'), false)
  assert.equal(containsSecret('password: ${DB_PASSWORD}\n'), false)
  assert.equal(containsSecret('apiKey: "a1b2c3d4e5f6g7h8i9j0k1l2"\n'), true)
  assert.equal(containsSecret('GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789\n'), true)
  assert.equal(containsSecret('-----BEGIN OPENSSH PRIVATE KEY-----\n'), true)
})

test('tags carry metadata, prune keeps the newest', async () => {
  const fx = fixture()
  const repo = new ConfigRepo(fx.home)
  await repo.ensure()
  for (let i = 0; i < 4; i++) {
    writeFileSync(join(fx.home, 'AGENTS.md'), `v${i}\n`)
    await repo.snapshot(`edit ${i}`)
    await repo.tag(`good-2026092${i}-000000`, { dshVersion: `0.1.${i}` })
    await new Promise((resolve) => setTimeout(resolve, 1100)) // distinct creatordate
  }
  await repo.pruneTags('good-', 2)
  const tags = await repo.listTags('good-')
  assert.deepEqual(tags.map((t) => t.name), ['good-20260923-000000', 'good-20260922-000000'])
  assert.equal(tags[0].meta.dshVersion, '0.1.3')
  assert.equal(tags[0].sha.length, 40)
})

test('restore() returns tracked files to a ref, leaves untracked ones alone', async () => {
  const fx = fixture()
  const repo = new ConfigRepo(fx.home)
  await repo.ensure()
  const first = await repo.head()
  writeFileSync(join(fx.home, 'settings.yaml'), 'changed: true\n')
  writeFileSync(join(fx.home, 'AGENTS.md'), 'new file\n')
  await repo.snapshot('later')
  const changed = await repo.restore(first)
  assert.deepEqual(changed.sort(), ['AGENTS.md', 'settings.yaml'])
  assert.match(readFileSync(join(fx.home, 'settings.yaml'), 'utf8'), /spark-local/)
  assert.equal(existsSync(join(fx.home, 'AGENTS.md')), false)
  await repo.snapshot('restored')
  assert.equal((await tracked(repo)).includes('AGENTS.md'), false)
  assert.match(readFileSync(join(fx.home, 'runtime.env'), 'utf8'), /LITELLM/, 'ignored files untouched')
})

/** Every object in the repository, contents included (loose and packed). */
const allObjects = async (repo) => (await repo.git(['cat-file', '--batch-all-objects', '--batch'])).stdout

test('snapshot: content that fails the secret scan never reaches the object store', async () => {
  const fx = fixture()
  const repo = new ConfigRepo(fx.home)
  await repo.ensure()
  writeFileSync(join(fx.home, 'settings.yaml'), 'llm:\n  apiKey: sk-abcdefghijklmnopqrstuvwxyz123456\n')
  await repo.snapshot('edit')
  assert.doesNotMatch(await allObjects(repo), /sk-abcdefghij/, 'no blob, dangling or not, holds the key')
  const status = (await repo.git(['status', '--porcelain', '--', 'settings.yaml'])).stdout
  assert.match(status, /^ M settings\.yaml/, 'the file stays a plain unstaged edit')
})

test('snapshot: commits exactly what was scanned, not whatever the index holds', async () => {
  const fx = fixture()
  const repo = new ConfigRepo(fx.home)
  await repo.ensure()
  // Something staged a secret-bearing version behind our back (git add by hand, a racing edit).
  writeFileSync(join(fx.home, 'AGENTS.md'), 'token: abcdefghijklmnopqrstuvwxyz0123\n')
  await repo.git(['add', 'AGENTS.md'])
  writeFileSync(join(fx.home, 'AGENTS.md'), '# clean notes\n')
  await repo.snapshot('edit')
  assert.equal((await repo.git(['show', 'HEAD:AGENTS.md'])).stdout, '# clean notes\n')
})

test('snapshot: a file too large to scan is refused, not committed unscanned', async () => {
  const fx = fixture()
  const warnings = []
  const repo = new ConfigRepo(fx.home, { log: (line) => warnings.push(line) })
  await repo.ensure()
  const big = `${'# padding\n'.repeat(Math.ceil(MAX_SCAN_BYTES / 10) + 10)}apiKey: sk-synthetic0123456789abcdefghij\n`
  writeFileSync(join(fx.home, 'AGENTS.md'), big)
  writeFileSync(join(fx.home, 'settings.yaml'), 'changed: true\n')
  assert.ok(await repo.snapshot('edit'), 'the other change is still committed')
  assert.equal((await tracked(repo)).includes('AGENTS.md'), false)
  assert.doesNotMatch(await allObjects(repo), /sk-synthetic/)
  assert.ok(warnings.some((line) => /AGENTS\.md: \d+ bytes is over the/.test(line)), warnings.join('\n'))
})

test('allowlist: an adopted repository with a permissive .gitignore still records config only', async () => {
  const fx = fixture()
  await run('git', ['-C', fx.home, 'init', '-q'])
  writeFileSync(join(fx.home, '.gitignore'), '# the owner ignores nothing\n')
  writeFileSync(join(fx.home, 'sessions', 'private.jsonl'), '{"role":"user","content":"private"}\n')
  const repo = new ConfigRepo(fx.home)
  assert.equal((await repo.ensure()).created, false)
  await repo.snapshot('first')
  const files = await tracked(repo)
  assert.deepEqual(files, ['.gitignore', 'profiles/web/cordis.patch.yml', 'profiles/web/package.json', 'settings.yaml'])
  assert.doesNotMatch(await allObjects(repo), /"private"/)
})

test('restore: paths outside the allowlist are left alone even when history recorded them', async () => {
  const fx = fixture()
  await run('git', ['-C', fx.home, 'init', '-q'])
  const repo = new ConfigRepo(fx.home)
  // The owner committed a notes file themselves before adopting the plugin.
  writeFileSync(join(fx.home, 'notes.txt'), 'v1\n')
  await repo.git(['add', 'notes.txt'])
  await repo.git(['commit', '-q', '-m', 'owner commit'])
  await repo.snapshot('config')
  const first = await repo.head()
  writeFileSync(join(fx.home, 'notes.txt'), 'v2, not config\n')
  writeFileSync(join(fx.home, 'settings.yaml'), 'changed: true\n')
  await repo.snapshot('edit')
  assert.deepEqual(await repo.changedSince(first), ['settings.yaml'])
  assert.deepEqual(await repo.restore(first), ['settings.yaml'])
  assert.equal(readFileSync(join(fx.home, 'notes.txt'), 'utf8'), 'v2, not config\n')
})

test('restore: a file whose content is not in history is saved before it is replaced', async () => {
  const fx = fixture()
  const repo = new ConfigRepo(fx.home)
  await repo.ensure()
  const first = await repo.head()
  writeFileSync(join(fx.home, 'settings.yaml'), 'apiKey: sk-abcdefghijklmnopqrstuvwxyz123456\n') // never committed
  await repo.restore(first)
  const backups = join(fx.home, 'safe-upgrade', 'restore-backups')
  const [dir] = readdirSync(backups)
  assert.match(readFileSync(join(backups, dir, 'settings.yaml'), 'utf8'), /sk-abc/)
  assert.match(readFileSync(join(fx.home, 'settings.yaml'), 'utf8'), /spark-local/)
})

test('snapshot: two snapshots racing both land, one after the other', async () => {
  const fx = fixture()
  const repo = new ConfigRepo(fx.home)
  await repo.ensure()
  writeFileSync(join(fx.home, 'AGENTS.md'), '# notes\n')
  writeFileSync(join(fx.home, 'settings.yaml'), 'changed: true\n')
  await Promise.all([repo.snapshot('a'), new ConfigRepo(fx.home).snapshot('b')])
  assert.equal((await repo.git(['show', 'HEAD:AGENTS.md'])).stdout, '# notes\n')
  assert.equal((await repo.git(['show', 'HEAD:settings.yaml'])).stdout, 'changed: true\n')
  assert.equal((await repo.git(['status', '--porcelain'])).stdout.trim(), '', 'index and worktree agree with HEAD')
})

test('semver: prereleases order correctly', () => {
  assert.equal(compare('0.1.7-rc.2', '0.1.5-rc.1'), 1)
  assert.equal(compare('0.1.7-rc.2', '0.1.7-rc.10'), -1)
  assert.equal(compare('0.1.7-alpha.2', '0.1.7-rc.1'), -1)
  assert.equal(compare('0.1.7', '0.1.7-rc.9'), 1)
  assert.equal(compare('0.2.0-rc.1', '0.1.9'), 1)
  assert.equal(newer('0.1.5-rc.1', '0.1.5-rc.1'), false)
})
