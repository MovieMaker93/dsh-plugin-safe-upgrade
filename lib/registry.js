/**
 * npm registry reads: dist-tags for the update check and per-package version
 * lists for resolving an upgrade target across every `@deepseek-ai/*`
 * dependency of the dsh install.
 * @module dsh-plugin-safe-upgrade/registry
 */

export const DEFAULT_REGISTRY = 'https://registry.npmjs.org'
export const DSH_PACKAGE = '@deepseek-ai/dsh'

function packageUrl(registry, name) {
  return `${registry.replace(/\/+$/, '')}/${name.replace('/', '%2f')}`
}

async function getJson(url, { fetchImpl = fetch, accept = 'application/json', timeoutMs = 15_000 } = {}) {
  const response = await fetchImpl(url, {
    headers: { accept },
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!response.ok) {
    const error = new Error(`GET ${url} -> ${response.status}`)
    error.status = response.status
    throw error
  }
  return response.json()
}

/**
 * @param {{registry?: string, fetchImpl?: typeof fetch, name?: string}} [options]
 * @returns {Promise<Record<string, string>>} dist-tags, e.g. `{latest, next, alpha}`.
 */
export async function fetchDistTags({ registry = DEFAULT_REGISTRY, fetchImpl, name = DSH_PACKAGE } = {}) {
  return getJson(`${registry.replace(/\/+$/, '')}/-/package/${name.replace('/', '%2f')}/dist-tags`, { fetchImpl })
}

/**
 * @param {string} name
 * @param {{registry?: string, fetchImpl?: typeof fetch}} [options]
 * @returns {Promise<string[]>} every published version of `name` ([] when unpublished).
 */
export async function fetchVersions(name, { registry = DEFAULT_REGISTRY, fetchImpl } = {}) {
  try {
    // The abbreviated install document is a fraction of the full packument.
    const doc = await getJson(packageUrl(registry, name), {
      fetchImpl,
      accept: 'application/vnd.npm.install-v1+json',
    })
    return Object.keys(doc.versions ?? {})
  } catch (error) {
    if (error.status === 404) return []
    throw error
  }
}

/**
 * Resolve `latest`/`next`/... to a version; a version string passes through.
 * @param {string} target
 * @param {Record<string, string>} distTags
 * @returns {string | undefined}
 */
export function resolveTarget(target, distTags) {
  if (/^\d+\.\d+\.\d+/.test(target)) return target
  return distTags[target]
}

/**
 * Map `fn` over `items` with at most `limit` in flight.
 * @template T, R
 * @param {T[]} items
 * @param {number} limit
 * @param {(item: T) => Promise<R>} fn
 * @returns {Promise<R[]>}
 */
export async function mapLimit(items, limit, fn) {
  const results = new Array(items.length)
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const index = next++
      results[index] = await fn(items[index])
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return results
}
