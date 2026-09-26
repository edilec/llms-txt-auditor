import assert from 'node:assert/strict'
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'

import { RULE_SEVERITY, auditLlmsTxt } from '../src/index.mjs'

/**
 * The catalog, exercised end to end.
 *
 * The acceptance condition for this tool is about the tool as a whole: no rule
 * it can emit may claim that llms.txt makes a consumer do anything. Scanning
 * the findings of one broken fixture tests that condition on the fourteen rules
 * that fixture happens to produce and says nothing about the other thirty, so
 * a forbidden phrase in any of them passes unnoticed.
 *
 * These cases fire every rule in `RULE_SEVERITY` at least once, which is worth
 * asserting on its own -- a documented rule no input can produce is a rule that
 * does not exist -- and the prose of everything they produce is scanned.
 */

const LONG_DESCRIPTION = 'a description of the document, '.repeat(8).trim()

async function makeTree(files) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'llms-catalog-')))
  for (const [relativePath, content] of Object.entries(files)) {
    const absolute = join(root, relativePath)
    await mkdir(dirname(absolute), { recursive: true })
    await writeFile(absolute, content)
  }
  return root
}

/**
 * Run every case and return the findings they produced.
 *
 * Each case is small and named after what it is for, so a rule that stops
 * firing points at the case that covered it.
 */
async function everyFinding(t) {
  const findings = []
  const roots = []
  const build = async (files) => {
    const root = await makeTree(files)
    roots.push(root)
    return root
  }
  t.after(() => Promise.all(roots.map((root) => rm(root, { recursive: true, force: true }))))
  const audit = async (options) => {
    const report = await auditLlmsTxt(options)
    findings.push(...report.findings)
    return report
  }

  // Headings, sections and the shape of the file.
  const structure = await build({
    'llms.txt': [
      'A paragraph written before the name.',
      '',
      '# Handbook',
      '',
      '### A heading below a section level',
      '',
      '## Guides',
      '',
      'Prose sitting inside a section.',
      '',
      '- [A](a.md): a description of a document.',
      '',
      '## Guides',
      '',
      '##',
      '',
      '- [B](b.md): another description of a document.',
      '',
      '## Nothing here',
      '',
      '# Handbook, named a second time',
      '',
    ].join('\n'),
    'a.md': '# A\n',
    'b.md': '# B\n',
  })
  await audit({ file: join(structure, 'llms.txt') })

  // Entries, descriptions and every kind of target.
  const entries = await build({
    'llms.txt': [
      '# Handbook',
      '',
      '> The team handbook.',
      '',
      '- [Early](early.md): a link listed before the first section.',
      '',
      '## Guides',
      '',
      '- [](a.md): an entry whose link carries no text.',
      '- [B](b.md)',
      '- [C](c.md) - a description written after a dash.',
      '- [D](d.md): D',
      '- [E](e.md): a description shared by two entries.',
      '- [F](f.md): a description shared by two entries.',
      '- [G](): a description of a document.',
      '- [H](#guides): a description of a document.',
      '- [I](javascript:alert(1)): a description of a document.',
      '- [J](mailto:team@example.com): a description of a document.',
      '- [K](missing.md): a description of a document.',
      '- [L](sub): a description of a document.',
      '- [M](empty.md): a description of a document.',
      '- [N](../outside.md): a description of a document.',
      '- a list item that holds no link',
      '- [O](a.md): a description of a document, written again.',
      '- [P](https://example.com/gone): a description of a document.',
      '- [Q](https://example.com/unknown): a description of a document.',
      `- [R](r.md): ${LONG_DESCRIPTION}`,
      '',
    ].join('\n'),
    'early.md': '# Early\n',
    'a.md': '# A\n',
    'b.md': '# B\n',
    'c.md': '# C\n',
    'd.md': '# D\n',
    'e.md': '# E\n',
    'f.md': '# F\n',
    'r.md': '# R\n',
    'empty.md': '',
    'sub/keep.md': '# Keep\n',
  })
  await audit({
    file: join(entries, 'llms.txt'),
    capture: {
      schemaVersion: '1',
      urls: { 'https://example.com/gone': { state: 'broken', httpStatus: 404, note: 'retired' } },
    },
  })

  // A target that leaves the root through a link, and one that loops.
  const outside = await build({ 'notes.md': '# Notes\n' })
  const escapes = await build({
    'llms.txt': [
      '# Handbook',
      '',
      '> The team handbook.',
      '',
      '## Guides',
      '',
      '- [Escape](escape.md): a description of a document.',
      '- [Loop](loop-a): a description of a document.',
      '',
    ].join('\n'),
  })
  await symlink(join(outside, 'notes.md'), join(escapes, 'escape.md'))
  await symlink('loop-b', join(escapes, 'loop-a'))
  await symlink('loop-a', join(escapes, 'loop-b'))
  await audit({ file: join(escapes, 'llms.txt') })

  // A coverage claim measured against an inventory, and an inventory holding a
  // document nobody linked and an entry that cannot be walked.
  const coverage = await build({
    'llms.txt': [
      '# Handbook',
      '',
      '> The team handbook.',
      '',
      '## Guides',
      '',
      'Every guide is listed below.',
      '',
      '- [A](docs/a.md): a description of a document.',
      '',
    ].join('\n'),
    'notes.md': '# Notes\n',
    'docs/a.md': '# A\n',
    'docs/b.md': '# B\n',
  })
  await symlink(join(coverage, 'notes.md'), join(coverage, 'docs', 'linked.md'))
  await audit({ file: join(coverage, 'llms.txt'), inventory: join(coverage, 'docs') })

  // The same claim with no inventory to measure it against.
  await audit({ file: join(coverage, 'llms.txt') })

  // An inventory that cannot be listed, one that is too deep, one that holds
  // more documents than the limit allows.
  const bounded = await build({
    'llms.txt': [
      '# Handbook',
      '',
      '> The team handbook.',
      '',
      '## Guides',
      '',
      '- [A](docs/a.md): a description of a document.',
      '',
    ].join('\n'),
    'docs/a.md': '# A\n',
    'docs/b.md': '# B\n',
    'docs/deeper/c.md': '# C\n',
  })
  await audit({ file: join(bounded, 'llms.txt'), inventory: join(bounded, 'no-such-directory') })
  await audit({ file: join(bounded, 'llms.txt'), inventory: join(bounded, 'docs'), limits: { maxInventoryDepth: 1 } })
  await audit({ file: join(bounded, 'llms.txt'), inventory: join(bounded, 'docs'), limits: { maxInventoryFiles: 1 } })

  // The file's own bounds: too many bytes, too many lines, too many links.
  await audit({ file: join(bounded, 'llms.txt'), limits: { maxBytes: 16 } })
  await audit({ file: join(bounded, 'llms.txt'), limits: { maxLines: 3 } })
  const twoLinks = await build({
    'llms.txt': [
      '# Handbook',
      '',
      '> The team handbook.',
      '',
      '## Guides',
      '',
      '- [A](a.md): a description of a document.',
      '- [B](b.md): another description of a document.',
      '',
    ].join('\n'),
    'a.md': '# A\n',
    'b.md': '# B\n',
  })
  await audit({ file: join(twoLinks, 'llms.txt'), limits: { maxLinks: 1 } })

  // A subject that is not there, and one that is not UTF-8.
  const subjects = await build({ 'placeholder.md': '# Placeholder\n' })
  await audit({ file: join(subjects, 'llms.txt'), root: subjects })
  // A lone continuation byte: valid Latin-1, not valid UTF-8.
  await writeFile(join(subjects, 'not-utf8.txt'), Buffer.from([0x23, 0x20, 0x48, 0xc3, 0x28, 0x0a]))
  await audit({ file: join(subjects, 'not-utf8.txt'), root: subjects })

  // A file with no name, and a file with nothing indexed in it.
  const sparse = await build({
    'no-title.txt': ['## Guides', '', '- [A](a.md): a description of a document.', ''].join('\n'),
    'empty-index.txt': ['# Handbook', '', '> The team handbook, with nothing indexed yet.', ''].join('\n'),
    'optional.txt': [
      '# Handbook',
      '',
      '> The team handbook.',
      '',
      '## Optional',
      '',
      'Reading this section is mandatory before a release.',
      '',
      '- [Security](security.md): required reading before any deployment.',
      '',
    ].join('\n'),
    'a.md': '# A\n',
    'security.md': '# Security\n',
  })
  await audit({ file: join(sparse, 'no-title.txt'), root: sparse })
  await audit({ file: join(sparse, 'empty-index.txt'), root: sparse })
  await audit({ file: join(sparse, 'optional.txt'), root: sparse })

  return findings
}

test('every rule in the catalog is one an input can actually produce', async (t) => {
  const findings = await everyFinding(t)
  const fired = new Set(findings.map((finding) => finding.ruleId))

  const missing = Object.keys(RULE_SEVERITY).filter((ruleId) => !fired.has(ruleId))
  assert.deepEqual(missing, [], `no case produces: ${missing.join(', ')}`)
  for (const finding of findings) {
    assert.equal(finding.severity, RULE_SEVERITY[finding.ruleId], `${finding.ruleId} was emitted at the wrong severity`)
  }
})

test('no rule message claims llms.txt compels a consumer, across the whole catalog', async (t) => {
  const findings = await everyFinding(t)
  const fired = new Set(findings.map((finding) => finding.ruleId))

  // The guard the scan depends on: a scan over a handful of rules would pass
  // while saying nothing about the rest.
  assert.equal(fired.size, Object.keys(RULE_SEVERITY).length)

  const prose = findings.map((finding) => `${finding.message} ${finding.suggestion ?? ''}`).join(' ')
  for (const forbidden of [/\bcompl(y|ies|iance)\b/i, /\benforc/i, /\bcrawler/i, /\brequires? (a )?(crawler|agent|model)/i]) {
    assert.doesNotMatch(prose, forbidden, `a rule message claims enforcement: ${forbidden}`)
  }
})
