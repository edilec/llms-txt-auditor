import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { parseFailureDetail } from '../src/index.mjs'

/**
 * A capture is an imported record of what remote addresses served, so it is
 * untrusted by construction, and the capture that fails to parse is the one
 * nothing has validated. V8 hands its content straight back inside the error
 * message: `Unexpected token 'A', "AKIAIOSFODNN7EXAMPLE" is not valid JSON` is
 * the whole capture when it is short, and a window around the offence when it
 * is not. `The capture is not valid JSON: ...` interpolated that message, so a
 * capture holding a credential was reproduced on stderr, where a CI log keeps
 * it.
 *
 * `excerpt` does not fix it: it flattens control characters and cuts from the
 * END, while the quoted span sits at the FRONT and is well inside the limit.
 *
 * The canary is AWS's own published documentation placeholder, not a
 * credential. It is checked down to eight characters, because half a leak is
 * still a leak.
 */

const projectDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const cli = join(projectDirectory, 'bin', 'llms-txt-auditor.mjs')
const CANARY = 'AKIAIOSFODNN7EXAMPLE'
const SHORTEST_PREFIX = 8

const LLMS_TXT = `# Example

> A short summary of the site.

## Docs

- [Guide](https://example.com/guide): the guide
`

function run(args) {
  return new Promise((fulfil) => {
    execFile(process.execPath, [cli, ...args], { cwd: projectDirectory }, (error, stdout, stderr) => {
      fulfil({ code: error === null ? 0 : (error.code ?? 1), stdout, stderr })
    })
  })
}

async function workspace(t) {
  const directory = await mkdtemp(join(tmpdir(), 'llms-txt-auditor-leak-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  await writeFile(join(directory, 'llms.txt'), LLMS_TXT)
  return directory
}

function assertNoCanary(stream, where) {
  for (let length = CANARY.length; length >= SHORTEST_PREFIX; length -= 1) {
    const prefix = CANARY.slice(0, length)
    assert.ok(
      !stream.includes(prefix),
      `${where} carries ${length} characters of the canary: ${JSON.stringify(stream)}`,
    )
  }
}

test('a capture that is nothing but a credential is not echoed back', async (t) => {
  const directory = await workspace(t)
  const capture = join(directory, 'capture.json')
  await writeFile(capture, CANARY)

  for (const extra of [[], ['--json']]) {
    const result = await run(['--file', join(directory, 'llms.txt'), '--capture', capture, ...extra])
    assert.equal(result.code, 2, 'an unparseable capture is a refusal')
    assertNoCanary(result.stdout, `stdout for ${JSON.stringify(extra)}`)
    assertNoCanary(result.stderr, `stderr for ${JSON.stringify(extra)}`)
  }
})

test('a credential inside an unparseable capture is not echoed either', async (t) => {
  const directory = await workspace(t)
  const capture = join(directory, 'capture.json')
  // V8 quotes a WINDOW around the offence, not only the head of the file, so a
  // secret in the middle of a broken capture leaks just as readily.
  await writeFile(capture, `{"schemaVersion": "1", "token": ${CANARY}}`)

  const result = await run(['--file', join(directory, 'llms.txt'), '--capture', capture, '--json'])
  assert.equal(result.code, 2)
  assertNoCanary(result.stdout, 'stdout')
  assertNoCanary(result.stderr, 'stderr')
})

test('a capture that merely CONTAINS "at position" does not smuggle itself through', async (t) => {
  // Looking for `at position` before recognising the quoting shape would keep
  // the quoted span whenever the file supplied that phrase itself.
  const directory = await workspace(t)
  const capture = join(directory, 'capture.json')
  await writeFile(capture, `${CANARY} at position 9 (line 1 column 10)`)

  const result = await run(['--file', join(directory, 'llms.txt'), '--capture', capture])
  assertNoCanary(result.stdout, 'stdout')
  assertNoCanary(result.stderr, 'stderr')
  assert.match(result.stderr, /unexpected token 'A'/)
})

test('the refusal still says where the capture broke', async (t) => {
  const directory = await workspace(t)
  const capture = join(directory, 'capture.json')
  await writeFile(capture, '{"schemaVersion": "1" "pages": []}')

  const result = await run(['--file', join(directory, 'llms.txt'), '--capture', capture])
  assert.equal(result.code, 2)
  assert.match(result.stderr, /The capture is not valid JSON/)
  // A diagnostic that says nothing is a different defect: position, line and
  // column are V8's useful half and none of them is capture content.
  assert.match(result.stderr, /at position 22 \(line 1 column 23\)/)
})

test('parseFailureDetail keeps the position and drops the quoted capture', () => {
  const cases = [
    [CANARY, "unexpected token 'A'"],
    [`{"a": ${CANARY}}`, "unexpected token 'A'"],
    ['ssn 123-45-6789', "unexpected token 's'"],
    [
      '{"a": 1 "b": 2}',
      "Expected ',' or '}' after property value in JSON at position 8 (line 1 column 9)",
    ],
    [`{"a":"${CANARY}`, 'Unterminated string in JSON at position 26 (line 1 column 27)'],
    ['', 'Unexpected end of JSON input'],
  ]
  for (const [text, expected] of cases) {
    try {
      JSON.parse(text)
      assert.fail(`${JSON.stringify(text)} was supposed to be unparseable`)
    } catch (error) {
      assert.equal(parseFailureDetail(error), expected)
    }
  }
})

test('a non-Error, and an error with no message, still produce a usable detail', () => {
  assert.equal(parseFailureDetail(undefined), 'it could not be parsed as JSON')
  assert.equal(parseFailureDetail({}), 'it could not be parsed as JSON')
  assert.equal(parseFailureDetail(new Error('')), 'it could not be parsed as JSON')
})

/**
 * Ordering pin: the quoting shape must be recognised BEFORE the offset.
 *
 * A helper that searches for `at position` first finds that phrase inside the
 * quoted span whenever the document itself supplies it, and slices the
 * document straight back out. The first case below is the one that bites when
 * the two branches are swapped back, and it takes two assertions to bite:
 * whether the document survives, AND whether the diagnostic does. The closing
 * double-quote guard turns a reverted ordering into the generic sentence
 * rather than a leak, so a test that only looked for the leak would sit green
 * over a helper that had stopped saying anything at all about this document.
 *
 * The last two cases pin that same opposite failure for the shapes V8 writes
 * without a quoted span. A helper that answered every message generically
 * would leak nothing and diagnose nothing.
 */

const ORDERING_SECRET = 'sk-live-9f2c1b7a4d'

/** The detail this tool produces for a document V8 refuses. */
function detailOfParseFailure(text) {
  try {
    JSON.parse(text)
  } catch (error) {
    return parseFailureDetail(error)
  }
  throw new Error(`${JSON.stringify(text)} parsed, so it pins nothing`)
}

/** What V8 actually said, so a case cannot quietly stop having a subject. */
function messageOfParseFailure(text) {
  try {
    JSON.parse(text)
  } catch (error) {
    return error.message
  }
  throw new Error(`${JSON.stringify(text)} parsed, so it pins nothing`)
}

test('a document that merely CONTAINS "at position" is not sliced back out', () => {
  const document = 'at position 1'
  assert.match(
    messageOfParseFailure(document),
    /"at position 1"/,
    'V8 still quotes this document back, so this case still has a subject',
  )

  const detail = detailOfParseFailure(document)
  assert.equal(detail.includes('"'), false, `a double quote survived: ${JSON.stringify(detail)}`)
  assert.equal(detail.includes(document), false, `the document survived: ${JSON.stringify(detail)}`)
  assert.match(
    detail,
    /unexpected token 'a'/,
    'the offending token is still named -- searching for the offset first loses it here',
  )
})

test('a document that is nothing but a credential-shaped token is not echoed', () => {
  const detail = detailOfParseFailure(ORDERING_SECRET)
  assert.equal(detail.includes(ORDERING_SECRET), false, `the token survived: ${JSON.stringify(detail)}`)
  assert.equal(detail.includes('"'), false)
})

test('no four-character prefix of a long sensitive document reaches the detail', () => {
  // Long enough that V8 quotes a ten-character window rather than the whole
  // document: asserting only on the whole string would pass while ten
  // characters of the secret still shipped.
  const detail = detailOfParseFailure(`${ORDERING_SECRET}${'x'.repeat(400)}`)
  for (let length = 4; length <= 10; length += 1) {
    assert.equal(
      detail.includes(ORDERING_SECRET.slice(0, length)),
      false,
      `the first ${length} characters of the document survived: ${JSON.stringify(detail)}`,
    )
  }
  assert.equal(detail.includes('"'), false)
})

test('a quoted span containing a newline is still recognised as a quoted span', () => {
  // Without the `s` flag the quoted-span pattern does not match this message
  // at all and the document falls through to a branch that keeps it.
  const detail = detailOfParseFailure('}x\n')
  assert.match(detail, /unexpected token/)
  assert.equal(detail.includes('"'), false, `a double quote survived: ${JSON.stringify(detail)}`)
})

test('the genuinely safe positional form keeps its position, line and column', () => {
  const detail = detailOfParseFailure('{"a": 1 "b": 2}')
  assert.match(detail, /at position 8/)
  assert.match(detail, /line 1 column 9/)
})

test('"Unexpected end of JSON input" passes through unchanged', () => {
  assert.equal(detailOfParseFailure(''), 'Unexpected end of JSON input')
})
