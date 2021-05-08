/**
 * Target classification and root confinement.
 *
 * Every address written in an llms.txt file is untrusted data. Classifying it
 * is therefore a pure, total function: it never throws, never fetches and never
 * touches the filesystem, so the audit can decide what a target *is* before it
 * decides whether it is allowed to look at it.
 */

import { isAbsolute, relative, sep } from 'node:path'

/**
 * Schemes that have no business naming a document in a documentation index.
 * These are refused as errors rather than reported as an exotic scheme: a
 * `javascript:` or `data:` entry in a file whose whole purpose is to be read by
 * an automated consumer is a defect worth failing a build for.
 */
export const UNSAFE_SCHEMES = Object.freeze(['javascript', 'data', 'vbscript', 'file', 'blob'])

/** Sort by UTF-16 code unit. Never `localeCompare`: ICU data varies between Node builds. */
export function byCodeUnit(left, right) {
  if (left === right) return 0
  return left < right ? -1 : 1
}

export function toPosix(value) {
  return value.split(sep).join('/')
}

/**
 * Is `candidate` the root itself or something below it?
 *
 * Both arguments must already be absolute. This is the lexical half of
 * confinement only — the real-path half lives in the audit, because it needs
 * the filesystem.
 */
export function isInside(root, candidate) {
  if (candidate === root) return true
  const rel = relative(root, candidate)
  if (rel === '' || rel === '..') return false
  return !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}

function decodePath(value) {
  try {
    return decodeURIComponent(value)
  } catch {
    // A malformed percent escape is kept as written rather than guessed at, so
    // the path that is looked up is the path that was published.
    return value
  }
}

/**
 * Classify one link target.
 *
 * Returns one of:
 *   { kind: 'empty' }
 *   { kind: 'fragment', fragment }
 *   { kind: 'remote', key, fragment }
 *   { kind: 'unsafe', scheme }
 *   { kind: 'other-scheme', scheme }
 *   { kind: 'local', path, rootRelative, fragment, query }
 */
export function classifyTarget(raw) {
  const target = String(raw).trim()
  if (target === '') return { kind: 'empty' }
  if (target.startsWith('#')) return { kind: 'fragment', fragment: target.slice(1) }

  const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(target)
  if (scheme !== null) {
    const name = scheme[1].toLowerCase()
    if (name === 'http' || name === 'https') return remote(target)
    if (UNSAFE_SCHEMES.includes(name)) return { kind: 'unsafe', scheme: name }
    return { kind: 'other-scheme', scheme: name }
  }

  // A protocol-relative address is remote: it cannot be resolved on disk, and
  // this tool has no network with which to learn anything else about it.
  if (target.startsWith('//')) return { kind: 'remote', key: target, fragment: '' }

  const hash = target.indexOf('#')
  const withoutFragment = hash === -1 ? target : target.slice(0, hash)
  const fragment = hash === -1 ? '' : target.slice(hash + 1)
  const question = withoutFragment.indexOf('?')
  const path = question === -1 ? withoutFragment : withoutFragment.slice(0, question)
  const query = question === -1 ? '' : withoutFragment.slice(question + 1)

  if (path === '') return { kind: 'empty' }
  return {
    kind: 'local',
    path: decodePath(path),
    rootRelative: path.startsWith('/'),
    fragment,
    query,
  }
}

/**
 * The lookup key for an imported capture entry.
 *
 * The fragment is removed when the address parses as a URL, because a capture
 * records what an address served, not which heading a reader jumped to.
 * Everything else is compared exactly as written: normalising a trailing slash
 * or a case-different host would quietly answer a question about one address
 * with evidence about another.
 */
function remote(target) {
  try {
    const url = new URL(target)
    const fragment = url.hash === '' ? '' : url.hash.slice(1)
    url.hash = ''
    return { kind: 'remote', key: url.href, fragment }
  } catch {
    return { kind: 'remote', key: target, fragment: '' }
  }
}
