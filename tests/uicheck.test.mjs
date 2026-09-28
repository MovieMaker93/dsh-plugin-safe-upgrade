// Drives a real headless Chromium (skipped when none is installed) against
// pages that imitate dsh's three outcomes: app booted, plugin-boot failure
// screen, and a page that never settles.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { test } from 'node:test'
import { checkWebUi, findChromium } from '../lib/uicheck.js'

const later = (html) => `<!doctype html><body><p>Loading…</p><script>
setTimeout(() => { document.body.innerHTML = ${JSON.stringify(html)} }, 800)
</script></body>`

const PAGES = {
  '/ok': later('<main><div role="textbox" contenteditable="true" aria-label="Describe what you want to build"></div></main>'),
  '/fail': later('<div>HARNESS</div><div>Failed to load plugins</div><div>web boot: 1 entry did not activate</div><div>dsh-esc-stop: pending (waiting for service: settingsScope)</div>'),
  '/never': '<!doctype html><body><p>Loading…</p></body>',
}

const chromium = findChromium()

test('real Chromium: booted app, failure screen, and a page that never settles', { skip: chromium === undefined && 'no Chromium installed' }, async () => {
  const server = createServer((req, res) => {
    res.writeHead(PAGES[req.url.split('?')[0]] ? 200 : 404, { 'content-type': 'text/html' })
    res.end(PAGES[req.url.split('?')[0]] ?? 'not found')
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  try {
    // Generous deadlines (the production default is 45 s): a cold browser on a
    // busy CI runner is slow, and the check returns as soon as the page settles.
    const ok = await checkWebUi({ url: `${base}/ok?token=x`, timeoutMs: 60_000 })
    assert.equal(ok.status, 'ok', JSON.stringify(ok))
    const failed = await checkWebUi({ url: `${base}/fail`, timeoutMs: 60_000 })
    assert.equal(failed.status, 'failed', JSON.stringify(failed))
    assert.match(failed.detail, /did not activate/)
    assert.match(failed.detail, /settingsScope/)
    const never = await checkWebUi({ url: `${base}/never`, timeoutMs: 3000 })
    assert.equal(never.status, 'timeout')
  } finally {
    server.close()
  }
})

test('no browser available is reported as skipped, not as a failure', async () => {
  const result = await checkWebUi({ url: 'http://127.0.0.1:9/', chromium: '/nonexistent/chromium' })
  assert.equal(result.status, 'skipped')
})
