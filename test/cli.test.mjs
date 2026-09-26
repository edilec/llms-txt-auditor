import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const projectDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const cli = join(projectDirectory, 'bin', 'llms-txt-auditor.mjs')

function run(args) {
  return new Promise((fulfil) => {
    execFile(process.execPath, [cli, ...args], { cwd: projectDirectory }, (error, stdout, stderr) => {
      fulfil({ code: error === null ? 0 : (error.code ?? 1), stdout, stderr })
    })
  })
}

const cleanArguments = [
  '--file', 'examples/clean/llms.txt',
  '--inventory', 'examples/clean/docs',
  '--capture', 'examples/clean/capture.json',
]
const brokenArguments = [
  '--file', 'examples/broken/llms.txt',
  '--inventory', 'examples/broken/docs',
  '--capture', 'examples/broken/capture.json',
]

test('the clean example exits 0 with the report on stdout and the summary on stderr', async () => {
  const { code, stdout, stderr } = await run(cleanArguments)

  assert.equal(code, 0)
  const report = JSON.parse(stdout)
  assert.equal(report.status, 'pass')
  assert.deepEqual(report.findings, [])
  assert.match(stderr, /4 entry\(s\) in 2 section\(s\): 0 error, 0 warning, 0 info, status pass\./)
  assert.match(stderr, /not an enforcement mechanism/)
})

test('the broken example exits 1 and names the broken targets and the unmet claim', async () => {
  const { code, stdout } = await run(brokenArguments)

  assert.equal(code, 1)
  const report = JSON.parse(stdout)
  assert.equal(report.status, 'fail')
  assert.deepEqual(
    report.findings.filter((finding) => finding.severity === 'error').map((finding) => finding.ruleId),
    [
      'title-not-first',
      'coverage-claim-unmet',
      'local-target-missing',
      'local-target-not-file',
      'local-target-outside-root',
      'unsafe-target',
      'list-item-not-a-link',
      'remote-target-broken',
    ],
  )
})

test('--json keeps stderr empty so stdout can be piped on its own', async () => {
  const { code, stdout, stderr } = await run([...cleanArguments, '--json'])

  assert.equal(code, 0)
  assert.equal(stderr, '')
  assert.equal(JSON.parse(stdout).tool, 'llms-txt-auditor')
})

test('two runs over the same inputs write byte-identical stdout', async () => {
  const first = await run([...brokenArguments, '--json'])
  const second = await run([...brokenArguments, '--json'])

  assert.equal(first.stdout, second.stdout)
  assert.equal(first.stdout.includes('"status": "fail"'), true)
})

test('--help explains the tool, states the advisory, and writes no report', async () => {
  const { code, stdout, stderr } = await run(['--help'])

  assert.equal(code, 0)
  assert.equal(stderr, '')
  assert.match(stdout, /Usage:\n {2}llms-txt-auditor --file FILE/)
  assert.match(stdout, /not an enforcement mechanism/)
  assert.equal(stdout.includes('"schemaVersion"'), false)
})

test('an unknown option is a configuration error: exit 2 and an empty stdout', async () => {
  const { code, stdout, stderr } = await run([...cleanArguments, '--max-link', '5'])

  assert.equal(code, 2)
  assert.equal(stdout, '')
  assert.match(stderr, /Unknown option "--max-link"/)
})

test('a missing --file is a configuration error with an empty stdout', async () => {
  const { code, stdout, stderr } = await run(['--inventory', 'examples/clean/docs'])

  assert.equal(code, 2)
  assert.equal(stdout, '')
  assert.match(stderr, /--file is required/)
})

test('a limit flag with a non-integer value is refused rather than ignored', async () => {
  const { code, stdout, stderr } = await run([...cleanArguments, '--max-links', 'lots'])

  assert.equal(code, 2)
  assert.equal(stdout, '')
  assert.match(stderr, /--max-links requires a positive integer/)
})

test('a capture with an unknown key is refused rather than silently accepted', async (t) => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'llms-cli-')))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const capture = join(directory, 'capture.json')
  await writeFile(capture, JSON.stringify({ schemaVersion: '1', urlz: {}, urls: {} }))

  const { code, stdout, stderr } = await run(['--file', 'examples/clean/llms.txt', '--capture', capture])

  assert.equal(code, 2)
  assert.equal(stdout, '')
  assert.match(stderr, /Unknown capture key "urlz"/)
})

test('an unreadable input exits 2 with an incomplete report on stdout', async () => {
  const { code, stdout } = await run(['--file', 'examples/clean/no-such-file.txt', '--json'])

  assert.equal(code, 2)
  const report = JSON.parse(stdout)
  assert.equal(report.status, 'incomplete')
  assert.equal(report.summary.checked, 0)
  assert.deepEqual(report.findings.map((finding) => finding.ruleId), ['file-unreadable'])
})

test('a limit set on the command line reaches the audit', async () => {
  const { code, stdout } = await run([...cleanArguments, '--max-links', '2', '--json'])

  assert.equal(code, 2)
  const report = JSON.parse(stdout)
  assert.equal(report.status, 'incomplete')
  assert.equal(report.summary.checked, 2)
  assert.ok(report.findings.some((finding) => finding.ruleId === 'too-many-links'))
})

test('the README and the help text never claim llms.txt compels a crawler', async () => {
  const readme = await readFile(join(projectDirectory, 'README.md'), 'utf8')
  const { stdout: help } = await run(['--help'])

  for (const text of [readme, help]) {
    assert.doesNotMatch(text, /llms\.txt (forces|requires|compels|makes)/i)
    assert.doesNotMatch(text, /enforces? (crawler|compliance)/i)
    assert.match(text, /convention, not an enforcement mechanism/)
  }
  assert.match(readme, /## Limits and non-goals/)
})
