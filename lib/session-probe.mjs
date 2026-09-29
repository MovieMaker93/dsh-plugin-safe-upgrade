#!/usr/bin/env node
/**
 * `node session-probe.mjs <installDir> <sessionsRoot>`: list every stored
 * session with that dsh install's own JSONL session store and open each one
 * read-only (never for write, so nothing is migrated or published). Prints
 * one JSON line: `{ok, listed, unreadable, presets}` or `{ok: false, error}`.
 * @module dsh-plugin-safe-upgrade/session-probe
 */

import { packageEntryUrl } from './sessions.js'

const [installDir, root] = process.argv.slice(2)

async function openStore(Context, Store, compression) {
  const store = new Store(new Context(), { root, compression })
  return { store, listed: await store.list() }
}

try {
  if (!installDir || !root) throw new Error('usage: session-probe.mjs <installDir> <sessionsRoot>')
  const { Context } = await import(packageEntryUrl(installDir, '@deepseek-ai/cordis'))
  const { default: Store } = await import(packageEntryUrl(installDir, '@deepseek-ai/dsh-session-persistence-jsonl'))
  let opened
  try {
    opened = await openStore(Context, Store, 'zstd')
  } catch (error) {
    // A root written without compression refuses the zstd backend by name.
    if (!/configured for compression/.test(String(error))) throw error
    opened = await openStore(Context, Store, 'none')
  }
  const { store, listed } = opened
  const unreadable = []
  const presets = {}
  for (const snapshot of listed) {
    const { header } = snapshot
    const child = header.origin === 'subagent'
    try {
      const handle = await store.open(header.id, 'read')
      let preset = header.agentPreset
      try {
        for (const event of (await handle.read()).events) {
          if (event.type === 'agent-preset/selected') preset = event.data?.agentPreset ?? preset
        }
      } finally {
        await handle.close?.()
      }
      if (!child && typeof preset === 'string' && preset !== '') presets[preset] = (presets[preset] ?? 0) + 1
    } catch (error) {
      unreadable.push({
        id: String(header.id),
        ...(header.cwd === undefined ? {} : { cwd: header.cwd }),
        child,
        error: String(error?.message ?? error).replace(/ \(raw log: [^)]*\)/g, '').slice(0, 300),
      })
    }
  }
  process.stdout.write(`${JSON.stringify({ ok: true, listed: listed.length, unreadable, presets })}\n`)
  process.exit(0)
} catch (error) {
  process.stdout.write(`${JSON.stringify({ ok: false, error: String(error?.message ?? error).slice(0, 500) })}\n`)
  process.exit(0)
}
