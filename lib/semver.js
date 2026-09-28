/**
 * Minimal semver ordering with prerelease support (no ranges). dsh ships
 * almost exclusively prereleases (`0.1.7-rc.2`, `0.2.0-alpha.1`), so plain
 * string or numeric comparison gets them wrong.
 * @module dsh-plugin-safe-upgrade/semver
 */

const SEMVER = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/

/**
 * @param {string} version
 * @returns {{major: number, minor: number, patch: number, pre: string[]} | undefined}
 */
export function parse(version) {
  const match = SEMVER.exec(String(version ?? '').trim())
  if (match === null) return undefined
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    pre: match[4] === undefined ? [] : match[4].split('.'),
  }
}

/** @returns {boolean} whether `version` is a full x.y.z[-pre] version. */
export function valid(version) {
  return parse(version) !== undefined
}

function compareIdentifiers(a, b) {
  const aNum = /^\d+$/.test(a)
  const bNum = /^\d+$/.test(b)
  if (aNum && bNum) return Math.sign(Number(a) - Number(b))
  if (aNum) return -1
  if (bNum) return 1
  return a < b ? -1 : a > b ? 1 : 0
}

/**
 * @param {string} a
 * @param {string} b
 * @returns {-1 | 0 | 1} ordering of `a` relative to `b`.
 * @throws when either argument is not a version.
 */
export function compare(a, b) {
  const x = parse(a)
  const y = parse(b)
  if (x === undefined || y === undefined) throw new Error(`not a version: ${x === undefined ? a : b}`)
  for (const key of ['major', 'minor', 'patch']) {
    if (x[key] !== y[key]) return x[key] < y[key] ? -1 : 1
  }
  // A release outranks every prerelease of the same x.y.z.
  if (x.pre.length === 0 || y.pre.length === 0) {
    return x.pre.length === y.pre.length ? 0 : x.pre.length === 0 ? 1 : -1
  }
  const length = Math.max(x.pre.length, y.pre.length)
  for (let i = 0; i < length; i++) {
    if (x.pre[i] === undefined) return -1
    if (y.pre[i] === undefined) return 1
    const order = compareIdentifiers(x.pre[i], y.pre[i])
    if (order !== 0) return order
  }
  return 0
}

/** @returns {boolean} whether `a` is strictly newer than `b`. */
export function newer(a, b) {
  return compare(a, b) > 0
}
