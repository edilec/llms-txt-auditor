import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { RULE_SEVERITY, severityFor } from '../src/index.mjs'

const projectDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * Severity decides whether a run fails or passes, so it is the one thing here
 * most worth pinning. Forty construction sites each carrying their own literal
 * is the shape that drifts silently; these tests assert that the single table,
 * the documented catalog and the shipped source all agree.
 */

async function documentedSeverities() {
  const text = await readFile(join(projectDirectory, 'docs/llms-rules.md'), 'utf8')
  const rows = [...text.matchAll(/\|\s*`([a-z0-9-]+)`\s*\|\s*(error|warning|info)\s*\|/g)]
  return Object.fromEntries(rows.map((row) => [row[1], row[2]]))
}

test('the documented catalog and the severity table are the same table', async () => {
  const documented = await documentedSeverities()

  assert.equal(Object.keys(documented).length, Object.keys(RULE_SEVERITY).length)
  assert.deepEqual(Object.keys(documented).sort(), Object.keys(RULE_SEVERITY).sort())
  assert.deepEqual(documented, { ...RULE_SEVERITY })
})

test('no rule is emitted that the table does not define', async () => {
  const sources = await readdir(join(projectDirectory, 'src'))
  const emitted = new Set()
  for (const name of sources) {
    const text = await readFile(join(projectDirectory, 'src', name), 'utf8')
    for (const match of text.matchAll(/ruleId:\s*'([a-z0-9-]+)'/g)) emitted.add(match[1])
  }

  assert.ok(emitted.size > 20, 'the scan found almost no rule ids, so it is not testing anything')
  for (const ruleId of emitted) {
    assert.ok(Object.hasOwn(RULE_SEVERITY, ruleId), `${ruleId} is emitted but missing from RULE_SEVERITY`)
  }
})

test('an unknown rule id throws instead of taking a default severity', () => {
  assert.throws(() => severityFor('not-a-rule'), /not in RULE_SEVERITY/)
  assert.equal(severityFor('unsafe-target'), 'error')
})

test('the table cannot be edited at runtime', () => {
  assert.equal(Object.isFrozen(RULE_SEVERITY), true)
  assert.throws(() => {
    RULE_SEVERITY['unsafe-target'] = 'info'
  }, TypeError)
  assert.equal(RULE_SEVERITY['unsafe-target'], 'error')
})

test('the refusals that keep a run out of trouble are errors, not warnings', () => {
  // Downgrading any of these turns a refusal into a green build.
  assert.equal(RULE_SEVERITY['local-target-escapes-root'], 'error')
  assert.equal(RULE_SEVERITY['local-target-outside-root'], 'error')
  assert.equal(RULE_SEVERITY['local-target-missing'], 'error')
  assert.equal(RULE_SEVERITY['unsafe-target'], 'error')
  assert.equal(RULE_SEVERITY['file-not-utf8'], 'error')
  assert.equal(RULE_SEVERITY['coverage-claim-unmet'], 'error')
})

test('every table entry uses a severity the report contract defines', () => {
  for (const [ruleId, severity] of Object.entries(RULE_SEVERITY)) {
    assert.ok(['error', 'warning', 'info'].includes(severity), `${ruleId} has severity ${severity}`)
  }
})

test('every documented limit is a real limit the code enforces', async () => {
  const { DEFAULT_LIMITS } = await import('../src/index.mjs')
  const text = await readFile(join(projectDirectory, 'docs/llms-rules.md'), 'utf8')
  const documented = [...text.matchAll(/\|\s*`(max[A-Za-z]+|minDescriptionChars)`\s*\|\s*`(--[a-z-]+)`\s*\|\s*(\d+)\s*\|/g)]

  assert.deepEqual(
    documented.map((row) => row[1]).sort(),
    Object.keys(DEFAULT_LIMITS).sort(),
    'docs/llms-rules.md and DEFAULT_LIMITS list different limits',
  )
  for (const [, name, , value] of documented) {
    assert.equal(Number(value), DEFAULT_LIMITS[name], `the documented default for ${name} is not the real one`)
  }
})
