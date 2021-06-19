import assert from 'node:assert/strict'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'

import { auditLlmsTxt, byCodeUnit } from '../src/index.mjs'

/**
 * The ordering guarantee, defended against the one change that would quietly
 * break it.
 *
 * `byCodeUnit` carries the comment "Never localeCompare: ICU data varies
 * between Node builds", and swapping its body for `localeCompare` reorders
 * every report over mixed-case filenames while two runs in one build still
 * agree with each other. So the two determinism cases that compare a run with
 * itself cannot see it: what follows compares the order against the one the
 * documentation states.
 */

async function makeTree(files) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'llms-order-')))
  for (const [relativePath, content] of Object.entries(files)) {
    const absolute = join(root, relativePath)
    await mkdir(dirname(absolute), { recursive: true })
    await writeFile(absolute, content)
  }
  return root
}

test('byCodeUnit orders by UTF-16 code unit, which is not alphabetical order', () => {
  // Every capital letter sorts before every lowercase one. A locale-aware
  // comparator folds case instead and answers the other way round on each of
  // these pairs.
  assert.equal(byCodeUnit('Almond.md', 'apple.md'), -1)
  assert.equal(byCodeUnit('apple.md', 'Banana.md'), 1)
  assert.equal(byCodeUnit('Z.md', 'a.md'), -1)
  assert.equal(byCodeUnit('a', 'B'), 1)

  // Total, and never a partial order: equal is 0, and swapping the arguments
  // swaps the sign.
  assert.equal(byCodeUnit('same', 'same'), 0)
  assert.equal(byCodeUnit('resume', 'résumé'), -1)
  assert.equal(byCodeUnit('résumé', 'resume'), 1)
})

test('findings over mixed-case filenames come back in code unit order', async (t) => {
  const root = await makeTree({
    'llms.txt': [
      '# Handbook',
      '',
      '> The team handbook.',
      '',
      '## Guides',
      '',
      '- [Notes](notes.md): the one document that is not in the inventory.',
      '',
    ].join('\n'),
    'notes.md': '# Notes\n',
    'docs/Almond.md': '# Almond\n',
    'docs/apple.md': '# Apple\n',
    'docs/Banana.md': '# Banana\n',
    'docs/cherry.md': '# Cherry\n',
  })
  t.after(() => rm(root, { recursive: true, force: true }))

  const report = await auditLlmsTxt({ file: join(root, 'llms.txt'), inventory: join(root, 'docs') })

  // Capitals first, as the documented sort says. Under `localeCompare` this
  // reads Almond, apple, Banana, cherry.
  assert.deepEqual(
    report.findings.map((finding) => finding.location.file),
    ['docs/Almond.md', 'docs/Banana.md', 'docs/apple.md', 'docs/cherry.md'],
  )
  assert.deepEqual(new Set(report.findings.map((finding) => finding.ruleId)), new Set(['inventory-document-unlisted']))
})
