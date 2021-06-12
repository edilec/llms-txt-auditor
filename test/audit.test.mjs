import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { dirname, join, resolve } from 'node:path'
import { realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { ADVISORY, auditLlmsTxt, exitCodeFor } from '../src/index.mjs'

const projectDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const example = (...parts) => join(projectDirectory, 'examples', ...parts)

async function readJson(path) {
  const { readFile } = await import('node:fs/promises')
  return JSON.parse(await readFile(path, 'utf8'))
}

/** Build a throwaway tree. Returns its real path, so symlinked temp roots compare cleanly. */
async function makeTree(files) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'llms-audit-')))
  for (const [relativePath, content] of Object.entries(files)) {
    const absolute = join(root, relativePath)
    await mkdir(dirname(absolute), { recursive: true })
    await writeFile(absolute, content)
  }
  return root
}

const place = (report) =>
  report.findings.map((finding) => [finding.location.file, finding.line ?? null, finding.ruleId, finding.severity])

test('the broken example: broken local targets and a contradictory scope claim are flagged', async () => {
  const report = await auditLlmsTxt({
    file: example('broken', 'llms.txt'),
    inventory: example('broken', 'docs'),
    capture: await readJson(example('broken', 'capture.json')),
  })

  // An exact expected structure, in the documented order: file, then line, then
  // ruleId. Three files and eleven distinct lines take part, so reversing any
  // part of the sort key changes this list.
  assert.deepEqual(place(report), [
    ['docs/api-reference.md', null, 'inventory-document-unlisted', 'warning'],
    ['docs/billing.md', null, 'inventory-document-unlisted', 'warning'],
    ['docs/deployment.md', null, 'inventory-document-unlisted', 'warning'],
    ['llms.txt', 1, 'title-not-first', 'error'],
    ['llms.txt', 3, 'summary-missing', 'warning'],
    ['llms.txt', 7, 'coverage-claim-unmet', 'error'],
    ['llms.txt', 7, 'section-prose-ignored', 'info'],
    ['llms.txt', 10, 'local-target-missing', 'error'],
    ['llms.txt', 11, 'local-target-not-file', 'error'],
    ['llms.txt', 12, 'local-target-outside-root', 'error'],
    ['llms.txt', 13, 'description-missing', 'warning'],
    ['llms.txt', 13, 'unsupported-scheme', 'info'],
    ['llms.txt', 14, 'unsafe-target', 'error'],
    ['llms.txt', 15, 'list-item-not-a-link', 'error'],
    ['llms.txt', 16, 'remote-target-broken', 'error'],
    ['llms.txt', 18, 'heading-level-unsupported', 'warning'],
  ])

  assert.equal(report.status, 'fail')
  assert.equal(exitCodeFor(report), 1)
  assert.equal(report.summary.checked, 9)

  const claim = report.findings.find((finding) => finding.ruleId === 'coverage-claim-unmet')
  assert.match(claim.message, /claims complete coverage \("every"\), but 3 inventoried document\(s\)/)
  assert.match(claim.evidence, /not linked: docs\/api-reference\.md, docs\/billing\.md, docs\/deployment\.md/)
  assert.equal(claim.line, 7)
})

test('the clean example passes with no findings', async () => {
  const report = await auditLlmsTxt({
    file: example('clean', 'llms.txt'),
    inventory: example('clean', 'docs'),
    capture: await readJson(example('clean', 'capture.json')),
  })

  assert.deepEqual(report.findings, [])
  assert.equal(report.status, 'pass')
  assert.equal(exitCodeFor(report), 0)
  assert.deepEqual(
    { checked: report.summary.checked, linked: report.summary.inventoryLinked, verified: report.summary.verified },
    { checked: 4, linked: 3, verified: 1 },
  )
})

test('every report carries the advisory, and no message claims llms.txt compels a consumer', async () => {
  const report = await auditLlmsTxt({
    file: example('broken', 'llms.txt'),
    inventory: example('broken', 'docs'),
    capture: await readJson(example('broken', 'capture.json')),
  })

  assert.equal(report.advisory, ADVISORY)
  assert.match(ADVISORY, /not an enforcement mechanism/)

  const prose = report.findings.map((finding) => `${finding.message} ${finding.suggestion ?? ''}`).join(' ')
  for (const forbidden of [/\bcompl(y|ies|iance)\b/i, /\benforc/i, /\bcrawler/i, /\brequires? (a )?(crawler|agent|model)/i]) {
    assert.doesNotMatch(prose, forbidden, `a rule message claims enforcement: ${forbidden}`)
  }
})

test('a section claiming complete coverage is measured against that section only', async (t) => {
  const root = await makeTree({
    'llms.txt': [
      '# Handbook',
      '',
      '> The team handbook.',
      '',
      '## Guides',
      '',
      'Every guide is listed below.',
      '',
      '- [Onboarding](docs/onboarding.md): joining the team and getting access.',
      '',
      '## Elsewhere',
      '',
      '- [Billing](docs/billing.md): how usage is metered and invoiced.',
      '',
    ].join('\n'),
    'docs/onboarding.md': '# Onboarding\n',
    'docs/billing.md': '# Billing\n',
  })
  t.after(() => rm(root, { recursive: true, force: true }))

  const report = await auditLlmsTxt({ file: join(root, 'llms.txt'), inventory: join(root, 'docs') })
  const claim = report.findings.find((finding) => finding.ruleId === 'coverage-claim-unmet')

  // docs/billing.md is linked in the file, but not in the section that claims
  // to list every guide, so the claim is still unmet.
  assert.equal(claim.line, 7)
  assert.match(claim.message, /1 inventoried document\(s\) are missing from its link list/)
  assert.match(claim.evidence, /not linked: docs\/billing\.md$/)
  assert.equal(report.status, 'fail')
})

test('a claim the link list actually delivers is not a finding', async (t) => {
  const root = await makeTree({
    'llms.txt': [
      '# Handbook',
      '',
      '> The team handbook.',
      '',
      '## Guides',
      '',
      'Every guide is listed below.',
      '',
      '- [Onboarding](docs/onboarding.md): joining the team and getting access.',
      '- [Billing](docs/billing.md): how usage is metered and invoiced.',
      '',
    ].join('\n'),
    'docs/onboarding.md': '# Onboarding\n',
    'docs/billing.md': '# Billing\n',
  })
  t.after(() => rm(root, { recursive: true, force: true }))

  const report = await auditLlmsTxt({ file: join(root, 'llms.txt'), inventory: join(root, 'docs') })

  assert.deepEqual(report.findings.map((finding) => finding.ruleId), ['section-prose-ignored'])
  assert.equal(report.summary.coverageClaims, 1)
  assert.equal(report.status, 'pass')
})

test('description rules report the entry that broke them, with its line', async (t) => {
  const root = await makeTree({
    'llms.txt': [
      '# Handbook',
      '',
      '> The team handbook.',
      '',
      '## Guides',
      '',
      '- [Onboarding](docs/onboarding.md)',
      '- [Billing](docs/billing.md): Billing',
      '- [Access](docs/access.md): short',
      '- [Payroll](docs/payroll.md) - how usage is metered and invoiced.',
      '- [Invoices](docs/invoices.md): how usage is metered and invoiced.',
      '',
    ].join('\n'),
    'docs/onboarding.md': '# Onboarding\n',
    'docs/billing.md': '# Billing\n',
    'docs/access.md': '# Access\n',
    'docs/payroll.md': '# Payroll\n',
    'docs/invoices.md': '# Invoices\n',
  })
  t.after(() => rm(root, { recursive: true, force: true }))

  const report = await auditLlmsTxt({ file: join(root, 'llms.txt') })

  assert.deepEqual(place(report), [
    ['llms.txt', 7, 'description-missing', 'warning'],
    ['llms.txt', 8, 'description-uninformative', 'warning'],
    ['llms.txt', 9, 'description-uninformative', 'warning'],
    ['llms.txt', 10, 'description-separator', 'info'],
    ['llms.txt', 11, 'description-duplicated', 'warning'],
  ])
  assert.match(report.findings[2].message, /5 characters, under the minDescriptionChars limit of 10/)
  assert.match(report.findings[4].message, /already used on line 10 for a different target/)
})

test('minDescriptionChars is enforced at the configured value, not only at its default', async (t) => {
  const root = await makeTree({
    'llms.txt': ['# H', '', '> A summary.', '', '## S', '', '- [A](a.md): twelve chars', ''].join('\n'),
    'a.md': 'content\n',
  })
  t.after(() => rm(root, { recursive: true, force: true }))

  const file = join(root, 'llms.txt')
  assert.deepEqual((await auditLlmsTxt({ file })).findings.map((finding) => finding.ruleId), [])
  assert.deepEqual(
    (await auditLlmsTxt({ file, limits: { minDescriptionChars: 30 } })).findings.map((finding) => finding.ruleId),
    ['description-uninformative'],
  )
})

test('an Optional section that says its content is required is a contradiction', async (t) => {
  const root = await makeTree({
    'llms.txt': [
      '# Handbook',
      '',
      '> The team handbook.',
      '',
      '## Optional',
      '',
      'Reading this section is mandatory before a release.',
      '',
      '- [Security](docs/security.md): required reading before any deployment.',
      '- [Trivia](docs/trivia.md): office history, safe to skip entirely.',
      '',
    ].join('\n'),
    'docs/security.md': '# Security\n',
    'docs/trivia.md': '# Trivia\n',
  })
  t.after(() => rm(root, { recursive: true, force: true }))

  const report = await auditLlmsTxt({ file: join(root, 'llms.txt') })

  assert.deepEqual(place(report), [
    ['llms.txt', 7, 'optional-section-claims-required', 'warning'],
    ['llms.txt', 7, 'section-prose-ignored', 'info'],
    ['llms.txt', 9, 'optional-section-claims-required', 'warning'],
  ])
  assert.equal(report.status, 'pass')
})

test('two entries naming the same document are reported once, on the later line', async (t) => {
  const root = await makeTree({
    'llms.txt': [
      '# Handbook',
      '',
      '> The team handbook.',
      '',
      '## Guides',
      '',
      '- [Onboarding](docs/onboarding.md): joining the team and getting access.',
      '- [Joining](./docs/onboarding.md): joining the team, said a second time.',
      '- [Remote](https://example.com/x): the same address as the next entry.',
      '- [Remote again](https://example.com/x#part): the same address as the one above.',
      '',
    ].join('\n'),
    'docs/onboarding.md': '# Onboarding\n',
  })
  t.after(() => rm(root, { recursive: true, force: true }))

  const report = await auditLlmsTxt({
    file: join(root, 'llms.txt'),
    capture: { schemaVersion: '1', urls: { 'https://example.com/x': { state: 'ok' } } },
  })

  assert.deepEqual(
    report.findings.filter((finding) => finding.ruleId === 'target-duplicated').map((finding) => finding.line),
    [8, 10],
  )
})

test('a target that is not a regular file is refused, not accepted as an empty document', async (t) => {
  const root = await makeTree({
    'llms.txt': [
      '# Handbook',
      '',
      '> The team handbook.',
      '',
      '## Guides',
      '',
      '- [Channel](channel.md): a socket wearing the name of a document.',
      '',
    ].join('\n'),
  })
  // A socket is the one non-regular file a test can create with a built-in, and
  // it stands in for a named pipe or a device node: zero bytes, present on
  // disk, and nothing a consumer can read to the end.
  const server = createServer()
  await new Promise((fulfil) => server.listen(join(root, 'channel.md'), fulfil))
  t.after(async () => {
    await new Promise((fulfil) => server.close(fulfil))
    await rm(root, { recursive: true, force: true })
  })

  const report = await auditLlmsTxt({ file: join(root, 'llms.txt') })

  assert.deepEqual(place(report), [['llms.txt', 7, 'local-target-not-file', 'error']])
  assert.match(report.findings[0].message, /channel\.md is not a regular file/)
  assert.equal(report.status, 'fail')
  assert.equal(exitCodeFor(report), 1)
})

test('two runs over the same bytes produce the same report', async () => {
  const options = {
    file: example('broken', 'llms.txt'),
    inventory: example('broken', 'docs'),
    capture: await readJson(example('broken', 'capture.json')),
  }
  const first = JSON.stringify(await auditLlmsTxt(options))
  const second = JSON.stringify(await auditLlmsTxt(options))

  assert.equal(first, second)
  assert.equal(first.includes('"status": "fail"') || first.includes('"status":"fail"'), true)
})

/**
 * Configuration refusals. A documented knob that is quietly ignored is how a
 * one-character typo turns a real failure into a green run, so every one of
 * these is a refusal rather than a default.
 */

test('an unknown, malformed or contradictory limit is refused, never ignored', async () => {
  const { ConfigError, DEFAULT_LIMITS, validateLimits } = await import('../src/index.mjs')

  assert.throws(() => validateLimits({ maxLink: 5 }), { name: 'ConfigError', message: /Unknown limit "maxLink"/ })
  assert.throws(() => validateLimits({ maxLinks: 0 }), /must be a positive integer/)
  assert.throws(() => validateLimits({ maxLinks: 1.5 }), /must be a positive integer/)
  assert.throws(() => validateLimits({ maxLinks: '10' }), /must be a positive integer/)
  assert.throws(() => validateLimits({ minDescriptionChars: 300 }), /must not exceed maxDescriptionChars/)
  assert.throws(() => validateLimits('nope'), ConfigError)

  assert.deepEqual(validateLimits({}), { ...DEFAULT_LIMITS })
  assert.equal(validateLimits({ maxLinks: 7 }).maxLinks, 7)
})

test('the audit itself refuses an unknown limit, so the CLI is not the only gate', async () => {
  await assert.rejects(
    () => auditLlmsTxt({ file: example('clean', 'llms.txt'), limits: { maxLinkz: 3 } }),
    { name: 'ConfigError', message: /Unknown limit "maxLinkz"/ },
  )
})

test('a malformed capture is a configuration error, not a quiet "verified"', async () => {
  const { validateCapture } = await import('../src/index.mjs')
  const valid = { schemaVersion: '1', urls: { 'https://example.com/x': { state: 'ok' } } }

  assert.equal(validateCapture(valid), valid)
  assert.throws(() => validateCapture({ ...valid, urlz: {} }), /Unknown capture key "urlz"/)
  assert.throws(() => validateCapture({ schemaVersion: '2', urls: {} }), /Unsupported capture schemaVersion: 2/)
  assert.throws(() => validateCapture({ schemaVersion: '1' }), /missing its urls object/)
  assert.throws(
    () => validateCapture({ schemaVersion: '1', urls: { 'https://example.com/x': { state: 'fine' } } }),
    /unsupported state "fine"/,
  )
  assert.throws(
    () => validateCapture({ schemaVersion: '1', urls: { 'https://example.com/x': { state: 'ok', statu: 200 } } }),
    /Unknown capture entry key "statu"/,
  )
  assert.throws(() => validateCapture({ ...valid, capturedAt: 20260901 }), /capturedAt must be a string/)
})

test('an audit with no file, or a root that is not a directory, is refused', async () => {
  await assert.rejects(() => auditLlmsTxt({}), { name: 'ConfigError', message: /path to an llms.txt file is required/ })
  await assert.rejects(
    () => auditLlmsTxt({ file: example('clean', 'llms.txt'), root: example('clean', 'nowhere') }),
    /The declared root could not be read/,
  )
})

test('the llms.txt file is not a document in its own inventory', async (t) => {
  const root = await makeTree({
    'llms.txt': [
      '# Handbook',
      '',
      '> The team handbook, where the index sits beside the documents it lists.',
      '',
      '## Guides',
      '',
      'Every guide is listed below.',
      '',
      '- [Onboarding](onboarding.md): joining the team and getting access.',
      '',
    ].join('\n'),
    'onboarding.md': '# Onboarding\n',
  })
  t.after(() => rm(root, { recursive: true, force: true }))

  // The inventory root is the directory holding llms.txt, and `.txt` is a
  // documentation extension: without the exclusion the index would count as a
  // document nobody linked, and the coverage claim would fail on itself.
  const report = await auditLlmsTxt({ file: join(root, 'llms.txt'), inventory: root })

  assert.deepEqual(report.findings.map((finding) => finding.ruleId), ['section-prose-ignored'])
  assert.equal(report.summary.inventoryDocuments, 1)
  assert.equal(report.summary.inventoryLinked, 1)
  assert.equal(report.status, 'pass')
})
