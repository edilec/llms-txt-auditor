import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'

import { auditLlmsTxt, exitCodeFor } from '../src/index.mjs'

/**
 * Every path that can set the incomplete flag, with a case that fails if the
 * assignment is deleted.
 *
 * Several of these findings are warnings, which fail nothing on their own: for
 * those the flag is the only thing standing between an unread input and a green
 * run, which is exactly the invariant that has been quietly lost before. Each
 * case asserts the status, so removing the flag turns the status into `pass` or
 * `fail` and the assertion fails.
 */

async function makeTree(files) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'llms-incomplete-')))
  for (const [relativePath, content] of Object.entries(files)) {
    const absolute = join(root, relativePath)
    await mkdir(dirname(absolute), { recursive: true })
    await writeFile(absolute, content)
  }
  return root
}

const header = ['# Handbook', '', '> The team handbook.', '', '## Guides', '']
const withEntries = (...entries) => [...header, ...entries, ''].join('\n')

async function expectIncomplete(t, files, options, expectedRules) {
  const root = await makeTree(files)
  t.after(() => rm(root, { recursive: true, force: true }))
  const report = await auditLlmsTxt({ file: join(root, 'llms.txt'), ...options(root) })

  assert.deepEqual(report.findings.map((finding) => finding.ruleId), expectedRules)
  assert.equal(report.status, 'incomplete')
  assert.equal(exitCodeFor(report), 2)
  return report
}

test('a missing file is incomplete, never a pass', async (t) => {
  const root = await makeTree({ 'other.md': 'x\n' })
  t.after(() => rm(root, { recursive: true, force: true }))

  const report = await auditLlmsTxt({ file: join(root, 'llms.txt'), root })

  assert.deepEqual(report.findings.map((finding) => finding.ruleId), ['file-unreadable'])
  assert.equal(report.status, 'incomplete')
  assert.equal(report.summary.checked, 0)
  assert.equal(exitCodeFor(report), 2)
})

test('a directory where the file should be is incomplete', async (t) => {
  const root = await makeTree({ 'llms.txt/inner.md': 'x\n' })
  t.after(() => rm(root, { recursive: true, force: true }))

  const report = await auditLlmsTxt({ file: join(root, 'llms.txt'), root })

  assert.deepEqual(report.findings.map((finding) => finding.ruleId), ['file-unreadable'])
  assert.equal(report.status, 'incomplete')
})

test('bytes that are not UTF-8 are incomplete, and are decided by the decoder', async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'llms-incomplete-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  // A lone continuation byte: valid Latin-1, not valid UTF-8.
  await writeFile(join(root, 'llms.txt'), Buffer.from([0x23, 0x20, 0x48, 0xc3, 0x28, 0x0a]))

  const report = await auditLlmsTxt({ file: join(root, 'llms.txt') })

  assert.deepEqual(report.findings.map((finding) => finding.ruleId), ['file-not-utf8'])
  assert.equal(report.status, 'incomplete')
  assert.equal(exitCodeFor(report), 2)
})

test('a literal replacement character is content, not evidence about the encoding', async (t) => {
  const root = await makeTree({
    'llms.txt': withEntries('- [Onboarding](docs/onboarding.md): joining the team � and getting access.'),
    'docs/onboarding.md': '# Onboarding\n',
  })
  t.after(() => rm(root, { recursive: true, force: true }))

  const report = await auditLlmsTxt({ file: join(root, 'llms.txt') })

  assert.deepEqual(report.findings, [])
  assert.equal(report.status, 'pass')
})

test('a file over maxBytes is incomplete and nothing in it is audited', async (t) => {
  await expectIncomplete(
    t,
    { 'llms.txt': withEntries('- [A](a.md): a description of a document.'), 'a.md': 'x\n' },
    () => ({ limits: { maxBytes: 16 } }),
    ['file-too-large'],
  )
})

test('a file over maxLines is incomplete and says what was not read', async (t) => {
  const report = await expectIncomplete(
    t,
    { 'llms.txt': withEntries('- [A](a.md): a description of a document.'), 'a.md': 'x\n' },
    () => ({ limits: { maxLines: 3 } }),
    ['nothing-checked', 'file-too-many-lines'],
  )
  assert.match(report.findings[1].message, /over the maxLines limit of 3; nothing from line 4 on was read/)
  assert.equal(report.findings[1].line, 4)
})

test('a file over maxLines is incomplete even when the part that was read had entries', async (t) => {
  // The case above is masked: with nothing read at all `nothing-checked` sets
  // the flag by itself, so the truncation flag is never the thing under test.
  // Here the first entry is read and checked, and the truncation flag is the
  // only thing between a partly-read file and a green run.
  const report = await expectIncomplete(
    t,
    {
      'llms.txt': [
        '# Handbook',
        '',
        '> The team handbook.',
        '',
        '## Guides',
        '',
        '- [A](a.md): a description of a document.',
        '',
        '- [B](b.md): another description entirely.',
        '',
      ].join('\n'),
      'a.md': 'x\n',
      'b.md': 'y\n',
    },
    () => ({ limits: { maxLines: 8 } }),
    ['file-too-many-lines'],
  )
  assert.equal(report.summary.checked, 1)
  assert.equal(report.findings[0].severity, 'error')
})

test('a file the process may not read is incomplete, not a run that read everything', async (t) => {
  if (process.platform === 'win32' || process.getuid?.() === 0) {
    // Nothing here can make a file unreadable, so there is no case to run.
    t.skip('this case needs an unprivileged process on a POSIX filesystem')
    return
  }
  const root = await makeTree({ 'llms.txt': withEntries('- [A](a.md): a description of a document.'), 'a.md': 'x\n' })
  t.after(async () => {
    await chmod(join(root, 'llms.txt'), 0o600)
    await rm(root, { recursive: true, force: true })
  })
  // stat still answers for a mode-000 file; it is the read that fails, which is
  // its own path through readSubject and its own incomplete flag.
  await chmod(join(root, 'llms.txt'), 0o000)

  const report = await auditLlmsTxt({ file: join(root, 'llms.txt') })

  assert.deepEqual(report.findings.map((finding) => finding.ruleId), ['file-unreadable'])
  assert.match(report.findings[0].message, /could not be read \(EACCES\)/)
  assert.equal(report.status, 'incomplete')
  assert.equal(exitCodeFor(report), 2)
  assert.equal(report.summary.checked, 0)
})

test('more entries than maxLinks is incomplete', async (t) => {
  await expectIncomplete(
    t,
    {
      'llms.txt': withEntries('- [A](a.md): the first document.', '- [B](b.md): the second document.'),
      'a.md': 'x\n',
      'b.md': 'y\n',
    },
    () => ({ limits: { maxLinks: 1 } }),
    ['too-many-links'],
  )
})

test('an inventory root that cannot be listed is incomplete', async (t) => {
  await expectIncomplete(
    t,
    { 'llms.txt': withEntries('- [A](a.md): a description of a document.'), 'a.md': 'x\n' },
    (root) => ({ inventory: join(root, 'missing-docs') }),
    ['inventory-unreadable'],
  )
})

test('an inventory over maxInventoryFiles is incomplete', async (t) => {
  await expectIncomplete(
    t,
    {
      'llms.txt': withEntries('- [A](docs/a.md): the first document.'),
      'docs/a.md': 'x\n',
      'docs/b.md': 'y\n',
    },
    (root) => ({ inventory: join(root, 'docs'), limits: { maxInventoryFiles: 1 } }),
    ['inventory-too-many-files'],
  )
})

test('an inventory deeper than maxInventoryDepth is incomplete', async (t) => {
  await expectIncomplete(
    t,
    {
      'llms.txt': withEntries('- [A](docs/a.md): the first document.'),
      'docs/a.md': 'x\n',
      'docs/deeper/b.md': 'y\n',
    },
    (root) => ({ inventory: join(root, 'docs'), limits: { maxInventoryDepth: 1 } }),
    ['inventory-too-deep'],
  )
})

test('a remote address with no capture is unverified, and unverified is not a pass', async (t) => {
  const report = await expectIncomplete(
    t,
    { 'llms.txt': withEntries('- [Status](https://status.example.com/x): the current state of the service.') },
    () => ({}),
    ['remote-target-unverified'],
  )
  assert.equal(report.summary.unverified, 1)
  assert.equal(report.findings[0].severity, 'warning')
})

test('a remote address the capture does not cover is unverified', async (t) => {
  await expectIncomplete(
    t,
    { 'llms.txt': withEntries('- [Status](https://status.example.com/x): the current state of the service.') },
    () => ({ capture: { schemaVersion: '1', urls: { 'https://example.com/other': { state: 'ok' } } } }),
    ['remote-target-unverified'],
  )
})

test('a remote address the capture records as unknown is unverified', async (t) => {
  await expectIncomplete(
    t,
    { 'llms.txt': withEntries('- [Status](https://status.example.com/x): the current state of the service.') },
    () => ({ capture: { schemaVersion: '1', urls: { 'https://status.example.com/x': { state: 'unknown' } } } }),
    ['remote-target-unverified'],
  )
})

test('a coverage claim with no inventory is unverified, not satisfied', async (t) => {
  const report = await expectIncomplete(
    t,
    {
      'llms.txt': [
        '# Handbook',
        '',
        '> The team handbook.',
        '',
        'Every page of the handbook is linked below.',
        '',
        '## Guides',
        '',
        '- [Onboarding](docs/onboarding.md): joining the team and getting access.',
        '',
      ].join('\n'),
      'docs/onboarding.md': '# Onboarding\n',
    },
    () => ({}),
    ['coverage-unverified'],
  )
  assert.equal(report.findings[0].line, 5)
  assert.equal(report.findings[0].severity, 'warning')
  assert.equal(report.summary.coverageClaims, 1)
})

test('a claim measured against a bounded-out inventory stays unverified', async (t) => {
  await expectIncomplete(
    t,
    {
      'llms.txt': [
        '# Handbook',
        '',
        '> The team handbook.',
        '',
        'Every page of the handbook is linked below.',
        '',
        '## Guides',
        '',
        '- [Onboarding](docs/onboarding.md): joining the team and getting access.',
        '',
      ].join('\n'),
      'docs/onboarding.md': '# Onboarding\n',
      'docs/billing.md': '# Billing\n',
    },
    (root) => ({ inventory: join(root, 'docs'), limits: { maxInventoryFiles: 1 } }),
    ['inventory-document-unlisted', 'inventory-too-many-files', 'coverage-unverified'],
  )
})

test('a run that checked no entries at all is incomplete, never a green pass', async (t) => {
  const report = await expectIncomplete(
    t,
    { 'llms.txt': ['# Handbook', '', '> The team handbook, with nothing indexed yet.', ''].join('\n') },
    () => ({}),
    ['nothing-checked'],
  )
  assert.equal(report.summary.checked, 0)
  assert.equal(report.findings[0].severity, 'warning')
})
