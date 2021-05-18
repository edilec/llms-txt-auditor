#!/usr/bin/env node

import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import { ADVISORY, DEFAULT_LIMITS, auditLlmsTxt, exitCodeFor, formatReport } from '../src/index.mjs'

const HELP = `llms-txt-auditor

Audit a local llms.txt file and the documentation inventory it indexes:
structure, link targets, descriptions and stated coverage, with 1-based line
numbers on every diagnostic.

Usage:
  llms-txt-auditor --file FILE [--root DIR] [--inventory DIR] [--capture FILE]
                   [--json] [limits]

Options:
  --file FILE                 The llms.txt file to audit (required)
  --root DIR                  Declared root that every local target must stay
                              inside. Defaults to the directory holding --file.
  --inventory DIR             Documentation root the file is meant to index.
                              Without it, a stated coverage claim cannot be
                              checked and the run is incomplete.
  --capture FILE              Imported capture of what remote addresses served
  --json                      Suppress the human summary on stderr
  --max-bytes N               Largest llms.txt accepted (default ${DEFAULT_LIMITS.maxBytes})
  --max-lines N               Lines read from it (default ${DEFAULT_LIMITS.maxLines})
  --max-links N               List entries examined (default ${DEFAULT_LIMITS.maxLinks})
  --max-inventory-files N     Documents inventoried (default ${DEFAULT_LIMITS.maxInventoryFiles})
  --max-inventory-depth N     Directory depth walked (default ${DEFAULT_LIMITS.maxInventoryDepth})
  --min-description-chars N   Shortest useful description (default ${DEFAULT_LIMITS.minDescriptionChars})
  --max-description-chars N   Longest accepted description (default ${DEFAULT_LIMITS.maxDescriptionChars})
  -h, --help                  Show this help

Streams:
  stdout  the JSON report, and nothing else, so it can be piped into a parser.
          A configuration error writes nothing to stdout at all.
  stderr  the human summary and any diagnostics

Exit codes:
  0  the file and the inventory agreed, and everything was checked
  1  the check completed and found a failure
  2  invalid usage, or evidence that was missing, bounded out or unverified.
     Nothing unread is ever reported as a pass.

Nothing is ever fetched. A remote address is unverified unless an imported
capture records what it served, and an unverified run is incomplete.

${ADVISORY}
`

const LIMIT_FLAGS = new Map([
  ['--max-bytes', 'maxBytes'],
  ['--max-lines', 'maxLines'],
  ['--max-links', 'maxLinks'],
  ['--max-inventory-files', 'maxInventoryFiles'],
  ['--max-inventory-depth', 'maxInventoryDepth'],
  ['--min-description-chars', 'minDescriptionChars'],
  ['--max-description-chars', 'maxDescriptionChars'],
])

function parseArguments(argv) {
  if (argv.includes('-h') || argv.includes('--help')) return { help: true }
  const options = { file: null, root: null, inventory: null, capture: null, json: false, limits: {} }

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    const takeValue = (name) => {
      const value = argv[index + 1]
      if (value === undefined || value.startsWith('-')) throw new Error(`${name} requires a value`)
      index += 1
      return value
    }
    if (argument === '--json') options.json = true
    else if (argument === '--file') options.file = takeValue('--file')
    else if (argument === '--root') options.root = takeValue('--root')
    else if (argument === '--inventory') options.inventory = takeValue('--inventory')
    else if (argument === '--capture') options.capture = takeValue('--capture')
    else if (LIMIT_FLAGS.has(argument)) {
      const raw = takeValue(argument)
      if (!/^\d+$/.test(raw) || Number(raw) < 1) throw new Error(`${argument} requires a positive integer`)
      options.limits[LIMIT_FLAGS.get(argument)] = Number(raw)
    } else throw new Error(`Unknown option "${argument}"`)
  }

  if (options.file === null) throw new Error('--file is required')
  return options
}

async function loadCapture(path) {
  let text
  try {
    text = await readFile(resolve(path), 'utf8')
  } catch (error) {
    throw new Error(`Could not read the capture (${error.code ?? 'unknown error'})`)
  }
  try {
    return JSON.parse(text)
  } catch (error) {
    throw new Error(`The capture is not valid JSON: ${error.message}`)
  }
}

async function main(argv) {
  let options
  try {
    options = parseArguments(argv)
  } catch (error) {
    process.stderr.write(`${error.message}\n\n${HELP}`)
    return 2
  }
  if (options.help) {
    process.stdout.write(HELP)
    return 0
  }

  let report
  try {
    const capture = options.capture === null ? null : await loadCapture(options.capture)
    report = await auditLlmsTxt({
      file: options.file,
      root: options.root ?? undefined,
      inventory: options.inventory ?? undefined,
      capture,
      limits: options.limits,
    })
  } catch (error) {
    // A configuration error means the run never had a subject, so there is
    // nothing to report about and stdout stays empty.
    process.stderr.write(`${error.message}\n`)
    return 2
  }

  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  if (!options.json) process.stderr.write(formatReport(report))
  return exitCodeFor(report)
}

process.exitCode = await main(process.argv.slice(2))
