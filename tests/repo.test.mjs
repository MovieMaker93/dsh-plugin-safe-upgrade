import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { ConfigRepo, containsSecret } from '../lib/repo.js'
import { compare, newer } from '../lib/semver.js'
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
  assert.equal((await tracked(repo)).includes('AGENTS.md'), false)
  assert.match(readFileSync(join(fx.home, 'runtime.env'), 'utf8'), /LITELLM/, 'ignored files untouched')
})

test('semver: prereleases order correctly', () => {
  assert.equal(compare('0.1.7-rc.2', '0.1.5-rc.1'), 1)
  assert.equal(compare('0.1.7-rc.2', '0.1.7-rc.10'), -1)
  assert.equal(compare('0.1.7-alpha.2', '0.1.7-rc.1'), -1)
  assert.equal(compare('0.1.7', '0.1.7-rc.9'), 1)
  assert.equal(compare('0.2.0-rc.1', '0.1.9'), 1)
  assert.equal(newer('0.1.5-rc.1', '0.1.5-rc.1'), false)
})
