import assert from 'node:assert/strict'
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'

import { ConfigError, auditLlmsTxt } from '../src/index.mjs'

/**
 * Confinement is the one guarantee that has to hold against a hostile tree, so
 * these cases build a real one: a directory outside the declared root holding a
 * file whose name and content appear nowhere in the audited file, reachable
 * only by following a symbolic link planted inside the root.
 *
 * Every case asserts the refusal *and* that neither the outside name nor the
 * outside content appears anywhere in the serialized report.
 */

const OUTSIDE_CONTENT = 'OUT-OF-ROOT-CONTENT-MARKER'
const OUTSIDE_NAME = 'leaked-secret-note.md'

async function makeTree(files) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'llms-confine-')))
  for (const [relativePath, content] of Object.entries(files)) {
    const absolute = join(root, relativePath)
    await mkdir(dirname(absolute), { recursive: true })
    await writeFile(absolute, content)
  }
  return root
}

async function makeOutside() {
  const outside = await realpath(await mkdtemp(join(tmpdir(), 'llms-outside-')))
  await writeFile(join(outside, OUTSIDE_NAME), `${OUTSIDE_CONTENT}\n`)
  await writeFile(join(outside, 'notes.md'), `${OUTSIDE_CONTENT}\n`)
  return outside
}

function assertNoLeak(report, outside) {
  const serialized = JSON.stringify(report)
  assert.equal(serialized.includes(OUTSIDE_CONTENT), false, 'out-of-root content reached the report')
  assert.equal(serialized.includes(OUTSIDE_NAME), false, 'an out-of-root filename reached the report')
  assert.equal(serialized.includes(outside), false, 'an out-of-root host path reached the report')
}

const body = (entry) => ['# Handbook', '', '> The team handbook.', '', '## Guides', '', entry, ''].join('\n')

test('a symlink to a file outside the root is refused, not followed', async (t) => {
  const outside = await makeOutside()
  const root = await makeTree({ 'llms.txt': body('- [Notes](escape.md): looks like a document inside the root.') })
  await symlink(join(outside, 'notes.md'), join(root, 'escape.md'))
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(outside, { recursive: true, force: true })]))

  const report = await auditLlmsTxt({ file: join(root, 'llms.txt') })

  assert.deepEqual(
    report.findings.map((finding) => [finding.ruleId, finding.line, finding.severity]),
    [['local-target-escapes-root', 7, 'error']],
  )
  assert.equal(report.status, 'fail')
  assertNoLeak(report, outside)
})

test('a symlink to a directory outside the root is refused, not followed', async (t) => {
  const outside = await makeOutside()
  const root = await makeTree({ 'llms.txt': body('- [Notes](out/notes.md): looks like a document inside the root.') })
  await symlink(outside, join(root, 'out'), 'dir')
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(outside, { recursive: true, force: true })]))

  const report = await auditLlmsTxt({ file: join(root, 'llms.txt') })

  assert.deepEqual(
    report.findings.map((finding) => [finding.ruleId, finding.line, finding.severity]),
    [['local-target-escapes-root', 7, 'error']],
  )
  assertNoLeak(report, outside)
})

test('a spelled traversal is refused before the target is opened', async (t) => {
  const outside = await makeOutside()
  const root = await makeTree({ 'nested/llms.txt': body(`- [Notes](../../${OUTSIDE_NAME}): outside by spelling.`) })
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(outside, { recursive: true, force: true })]))

  const report = await auditLlmsTxt({ file: join(root, 'nested', 'llms.txt'), root: join(root, 'nested') })

  assert.deepEqual(report.findings.map((finding) => finding.ruleId), ['local-target-outside-root'])
  assert.equal(JSON.stringify(report).includes(OUTSIDE_CONTENT), false)
})

test('a root-relative target resolves against the declared root, and stays inside it', async (t) => {
  const root = await makeTree({
    'site/llms.txt': body('- [Onboarding](/docs/onboarding.md): joining the team and getting access.'),
    'docs/onboarding.md': '# Onboarding\n',
  })
  t.after(() => rm(root, { recursive: true, force: true }))

  const report = await auditLlmsTxt({ file: join(root, 'site', 'llms.txt'), root })

  assert.deepEqual(report.findings, [])
  assert.equal(report.summary.localTargets, 1)
})

test('a symlink loop is reported unreadable and leaves the run incomplete', async (t) => {
  const root = await makeTree({ 'llms.txt': body('- [Looping](loop-a): a link that points at itself.') })
  await symlink('loop-b', join(root, 'loop-a'))
  await symlink('loop-a', join(root, 'loop-b'))
  t.after(() => rm(root, { recursive: true, force: true }))

  const report = await auditLlmsTxt({ file: join(root, 'llms.txt') })

  assert.deepEqual(report.findings.map((finding) => finding.ruleId), ['local-target-unreadable'])
  assert.equal(report.status, 'incomplete')
})

test('a symlink inside the inventory is skipped, reported, and never walked out of the root', async (t) => {
  const outside = await makeOutside()
  const root = await makeTree({
    'llms.txt': body('- [Onboarding](docs/onboarding.md): joining the team and getting access.'),
    'docs/onboarding.md': '# Onboarding\n',
  })
  await symlink(outside, join(root, 'docs', 'external'), 'dir')
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(outside, { recursive: true, force: true })]))

  const report = await auditLlmsTxt({ file: join(root, 'llms.txt'), inventory: join(root, 'docs') })

  assert.deepEqual(
    report.findings.map((finding) => [finding.location.file, finding.ruleId, finding.severity]),
    [['docs/external', 'inventory-entry-skipped', 'warning']],
  )
  // The only finding is a warning, so the incomplete flag is the one thing
  // keeping this run from reporting a pass.
  assert.equal(report.status, 'incomplete')
  assert.equal(report.summary.inventoryDocuments, 1)
  assert.equal(report.summary.inventorySkipped, 1)
  assertNoLeak(report, outside)
})

test('an llms.txt file that leaves the root through a link is refused before it is read', async (t) => {
  const outside = await makeOutside()
  await writeFile(join(outside, 'llms.txt'), body('- [Notes](notes.md): a file the operator never declared.'))
  const root = await makeTree({ 'placeholder.md': 'x\n' })
  await symlink(join(outside, 'llms.txt'), join(root, 'llms.txt'))
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(outside, { recursive: true, force: true })]))

  await assert.rejects(() => auditLlmsTxt({ file: join(root, 'llms.txt'), root }), {
    name: 'ConfigError',
    message: 'The llms.txt file leaves the declared root through a symbolic link',
  })
})

test('an inventory root outside the declared root is refused', async (t) => {
  const outside = await makeOutside()
  const root = await makeTree({ 'llms.txt': body('- [Onboarding](docs/onboarding.md): joining the team.'), 'docs/onboarding.md': '# O\n' })
  await symlink(outside, join(root, 'linked-docs'), 'dir')
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(outside, { recursive: true, force: true })]))

  await assert.rejects(() => auditLlmsTxt({ file: join(root, 'llms.txt'), inventory: outside }), ConfigError)
  await assert.rejects(() => auditLlmsTxt({ file: join(root, 'llms.txt'), inventory: join(root, 'linked-docs') }), {
    message: 'The inventory root leaves the declared root through a symbolic link',
  })
})

/**
 * The mirror image of the cases above: confinement must refuse what leaves the
 * root without refusing what never left it. The declared root is compared after
 * both sides have been resolved, so a root reached through a symbolic link -
 * every temporary directory on macOS, where `/tmp` is a link to `/private/tmp`
 * - is still the root, and a file genuinely inside it is still inside it.
 */

test('a root reached through a symbolic link still holds its own llms.txt', async (t) => {
  const base = await makeTree({
    'actual/llms.txt': body('- [Onboarding](onboarding.md): joining the team and getting access.'),
    'actual/onboarding.md': '# Onboarding\n',
  })
  await symlink(join(base, 'actual'), join(base, 'link'), 'dir')
  t.after(() => rm(base, { recursive: true, force: true }))

  const report = await auditLlmsTxt({ file: join(base, 'link', 'llms.txt') })

  assert.deepEqual(report.findings, [])
  assert.equal(report.status, 'pass')
  assert.equal(report.summary.localTargets, 1)
})

test('a declared root spelled through a symbolic link is the same root', async (t) => {
  const base = await makeTree({
    'actual/site/llms.txt': body('- [Onboarding](/docs/onboarding.md): joining the team and getting access.'),
    'actual/docs/onboarding.md': '# Onboarding\n',
  })
  await symlink(join(base, 'actual'), join(base, 'link'), 'dir')
  t.after(() => rm(base, { recursive: true, force: true }))

  const report = await auditLlmsTxt({ file: join(base, 'link', 'site', 'llms.txt'), root: join(base, 'link') })

  assert.deepEqual(report.findings, [])
  assert.equal(report.summary.localTargets, 1)
})

test('a missing file under a linked root is reported, not refused as outside it', async (t) => {
  const base = await makeTree({ 'actual/placeholder.md': 'x\n' })
  await symlink(join(base, 'actual'), join(base, 'link'), 'dir')
  t.after(() => rm(base, { recursive: true, force: true }))

  const report = await auditLlmsTxt({ file: join(base, 'link', 'llms.txt') })

  assert.deepEqual(report.findings.map((finding) => finding.ruleId), ['file-unreadable'])
  assert.equal(report.status, 'incomplete')
})

test('a file spelled outside the root says so, and is not blamed on a link', async (t) => {
  const outside = await makeOutside()
  const root = await makeTree({ 'placeholder.md': 'x\n' })
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(outside, { recursive: true, force: true })]))

  await assert.rejects(() => auditLlmsTxt({ file: join(outside, OUTSIDE_NAME), root }), {
    name: 'ConfigError',
    message: 'The llms.txt file is outside the declared root',
  })
})
