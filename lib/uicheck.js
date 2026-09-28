/**
 * Web UI smoke check: load the dsh web app in headless Chromium and wait for
 * either the composer (the app booted) or dsh's own "Failed to load plugins"
 * screen. Browser-side plugin failures (a client half waiting for a service
 * that no longer exists) never show up in the host loader, so this is the
 * only place they can be caught.
 *
 * Talks to Chromium over the DevTools protocol with Node's built-in WebSocket;
 * no dependencies.
 * @module dsh-plugin-safe-upgrade/uicheck
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export const CHROMIUM_CANDIDATES = [
  '/usr/bin/chromium-browser',
  '/usr/bin/chromium',
  '/usr/lib64/chromium-browser/chromium-browser',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/snap/bin/chromium',
]

/** @returns {string | undefined} the first Chromium/Chrome binary found. */
export function findChromium(explicit) {
  if (explicit) return existsSync(explicit) ? explicit : undefined
  return CHROMIUM_CANDIDATES.find((path) => existsSync(path))
}

/**
 * Evaluated in the page: 'failed: …' when dsh shows its boot failure screen,
 * 'ok' once a composer exists, '' while still booting.
 */
const PROBE = `(() => {
  const text = document.body ? document.body.innerText : ''
  const failure = /did not activate|Failed to load plugins/.exec(text)
  if (failure) return 'failed: ' + text.slice(Math.max(0, failure.index - 40), failure.index + 400).replace(/\\s+/g, ' ').trim()
  if (document.querySelector('[role="textbox"], textarea, [contenteditable="true"]')) return 'ok'
  return ''
})()`

function waitForDevtools(child, timeoutMs) {
  return new Promise((resolve, reject) => {
    let buffer = ''
    const timer = setTimeout(() => reject(new Error('chromium did not expose DevTools')), timeoutMs)
    child.stderr.on('data', (chunk) => {
      buffer += chunk
      const match = /DevTools listening on (ws:\/\/[^\s]+)/.exec(buffer)
      if (match) {
        clearTimeout(timer)
        resolve(match[1])
      }
    })
    child.once('exit', (code) => {
      clearTimeout(timer)
      reject(new Error(`chromium exited (${code}) before DevTools was ready`))
    })
  })
}

function cdp(url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url)
    let id = 0
    const pending = new Map()
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data))
      const waiter = pending.get(message.id)
      if (waiter === undefined) return
      pending.delete(message.id)
      if (message.error) waiter.reject(new Error(message.error.message))
      else waiter.resolve(message.result)
    })
    socket.addEventListener('error', () => reject(new Error('DevTools socket error')))
    socket.addEventListener('open', () => resolve({
      send(method, params = {}, sessionId) {
        const message = { id: ++id, method, params }
        if (sessionId) message.sessionId = sessionId
        socket.send(JSON.stringify(message))
        return new Promise((ok, fail) => pending.set(message.id, { resolve: ok, reject: fail }))
      },
      close() {
        socket.close()
      },
    }))
  })
}

/**
 * @param {{url: string, chromium?: string, timeoutMs?: number}} options
 * @returns {Promise<{status: 'ok' | 'failed' | 'timeout' | 'skipped', detail?: string, ms?: number}>}
 */
export async function checkWebUi({ url, chromium, timeoutMs = 45_000 }) {
  const binary = findChromium(chromium)
  if (binary === undefined) return { status: 'skipped', detail: 'no Chromium/Chrome binary found' }
  const profile = mkdtempSync(join(tmpdir(), 'dsh-safe-upgrade-ui-'))
  const child = spawn(binary, [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--no-first-run',
    '--no-default-browser-check', '--disable-extensions', `--user-data-dir=${profile}`,
    '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1', 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] })
  const started = Date.now()
  let client
  try {
    client = await cdp(await waitForDevtools(child, 20_000))
    const { targetId } = await client.send('Target.createTarget', { url: 'about:blank' })
    const { sessionId } = await client.send('Target.attachToTarget', { targetId, flatten: true })
    await client.send('Page.navigate', { url }, sessionId)
    while (Date.now() - started < timeoutMs) {
      await new Promise((resolve) => setTimeout(resolve, 750))
      let value = ''
      try {
        value = (await client.send('Runtime.evaluate', { expression: PROBE, returnByValue: true }, sessionId)).result?.value ?? ''
      } catch {
        continue // navigation in progress
      }
      if (value === 'ok') return { status: 'ok', ms: Date.now() - started }
      if (value.startsWith('failed: ')) return { status: 'failed', detail: value.slice(8), ms: Date.now() - started }
    }
    return { status: 'timeout', detail: `no composer or failure screen within ${Math.round(timeoutMs / 1000)}s` }
  } finally {
    try {
      client?.close()
    } catch {}
    child.kill('SIGKILL')
    await new Promise((resolve) => (child.exitCode !== null || child.signalCode !== null ? resolve() : child.once('exit', resolve)))
    rmSync(profile, { recursive: true, force: true })
  }
}
