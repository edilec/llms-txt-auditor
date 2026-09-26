/**
 * The documentation inventory: what is actually on disk under a declared root.
 *
 * Coverage is the one claim in an llms.txt file that cannot be checked from the
 * file alone — "everything is listed below" is only true or false relative to a
 * set of documents. That set is built here, by walking a declared directory
 * under explicit bounds.
 *
 * The walk never follows a symbolic link. A link inside the inventory is a link
 * to something the operator did not declare, and following one would let a
 * planted link pull an out-of-tree filename into the report. Every skipped
 * entry is reported, so a partial inventory is never mistaken for a complete
 * one.
 */

import { readdir, stat } from 'node:fs/promises'
import { extname, join, relative, resolve } from 'node:path'

import { byCodeUnit, toPosix } from './paths.mjs'

/** Extensions treated as documentation. Everything else is not a document. */
export const INVENTORY_EXTENSIONS = Object.freeze(['.htm', '.html', '.markdown', '.md', '.mdx', '.rst', '.txt'])

/** Directory names never walked. */
export const SKIPPED_DIRECTORIES = Object.freeze(['.git', 'node_modules'])

export function isDocumentName(name) {
  return INVENTORY_EXTENSIONS.includes(extname(name).toLowerCase())
}

/**
 * Collect the documents under `rootReal`.
 *
 * `excludeReal` names paths to leave out — the llms.txt file itself, which is
 * an index of the documentation rather than a member of it.
 *
 * Returns `{ ok: false, reason }` when the root itself cannot be listed, and
 * otherwise `{ ok: true, documents, skipped, exceeded }` where `exceeded` names
 * a breached limit rather than quietly returning a shorter list.
 */
export async function collectInventory(rootReal, limits, excludeReal = []) {
  let rootInfo
  try {
    rootInfo = await stat(rootReal)
  } catch (error) {
    return { ok: false, reason: error.code ?? 'unknown error' }
  }
  if (!rootInfo.isDirectory()) return { ok: false, reason: 'not a directory' }

  const excluded = new Set(excludeReal)
  const documents = []
  const skipped = []
  let exceeded = null

  const walk = async (directory, depth) => {
    if (exceeded !== null) return
    if (depth > limits.maxInventoryDepth) {
      exceeded = 'maxInventoryDepth'
      return
    }

    let entries
    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch (error) {
      skipped.push({ relative: toPosix(relative(rootReal, directory)) || '.', reason: error.code ?? 'unknown error' })
      return
    }

    // Filesystem enumeration order is not part of the contract.
    const names = entries.map((entry) => entry.name).sort(byCodeUnit)
    const byName = new Map(entries.map((entry) => [entry.name, entry]))

    for (const name of names) {
      if (exceeded !== null) return
      if (name.startsWith('.')) continue
      const entry = byName.get(name)
      const absolute = join(directory, name)
      const relativePath = toPosix(relative(rootReal, absolute))

      if (entry.isSymbolicLink()) {
        skipped.push({ relative: relativePath, reason: 'symbolic link' })
        continue
      }
      if (entry.isDirectory()) {
        if (SKIPPED_DIRECTORIES.includes(name)) continue
        await walk(absolute, depth + 1)
        continue
      }
      if (!entry.isFile()) {
        skipped.push({ relative: relativePath, reason: 'not a regular file' })
        continue
      }
      if (!isDocumentName(name)) continue
      if (excluded.has(absolute)) continue
      if (documents.length >= limits.maxInventoryFiles) {
        exceeded = 'maxInventoryFiles'
        return
      }
      let info
      try {
        info = await stat(absolute)
      } catch (error) {
        skipped.push({ relative: relativePath, reason: error.code ?? 'unknown error' })
        continue
      }
      documents.push({ relative: relativePath, absolute, bytes: info.size })
    }
  }

  await walk(resolve(rootReal), 1)
  documents.sort((left, right) => byCodeUnit(left.relative, right.relative))
  skipped.sort((left, right) => byCodeUnit(left.relative, right.relative))
  return { ok: true, documents, skipped, exceeded }
}
