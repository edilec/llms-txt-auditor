/**
 * llms-txt-auditor
 *
 * Read a local llms.txt file and the documentation inventory it is supposed to
 * index, and report where the two disagree: structure that does not match the
 * convention, link targets that do not exist inside the declared root,
 * descriptions that tell a reader nothing, and coverage the file claims but
 * does not deliver.
 *
 * Two things this tool will not do. It never fetches anything, so an address it
 * cannot resolve on disk is unverified unless an imported capture says
 * otherwise, and an unverified run is `incomplete` rather than a pass. And it
 * never reports on crawler behaviour: llms.txt is a convention, and a
 * convention compels nobody. See ADVISORY, which every report carries.
 */

import { readFile, realpath, stat } from 'node:fs/promises'
import { basename, dirname, relative, resolve } from 'node:path'

import { byCodeUnit, classifyTarget, isInside, toPosix } from './paths.mjs'
import { collectInventory } from './inventory.mjs'
import { parseLlmsTxt } from './parse.mjs'

export { byCodeUnit, classifyTarget, isInside, toPosix, UNSAFE_SCHEMES } from './paths.mjs'
export { collectInventory, INVENTORY_EXTENSIONS, isDocumentName } from './inventory.mjs'
export { parseLlmsTxt, scanLink, splitDescription, splitLines } from './parse.mjs'

export const TOOL_ID = 'llms-txt-auditor'
export const REPORT_SCHEMA_VERSION = '1'
export const CAPTURE_SCHEMA_VERSION = '1'
export const CAPTURE_STATES = Object.freeze(['ok', 'broken', 'unknown'])

/**
 * Carried in every report, and repeated in the README and the CLI help.
 *
 * The acceptance condition for this tool is that it never claims llms.txt makes
 * a crawler do anything. Putting the disclaimer in the machine-readable output
 * makes that checkable rather than merely intended.
 */
export const ADVISORY =
  'llms.txt is a publishing convention, not an enforcement mechanism. It does not compel any ' +
  'crawler, agent or model provider to read, honour, or ignore anything. This report describes ' +
  'the file and the documents it names, never how any consumer behaved.'

/**
 * Bounds are part of the contract.
 *
 * An llms.txt file and the tree it indexes are untrusted input. Every limit is
 * explicit, overridable from the CLI, and reported when it is reached:
 * exceeding one produces a named finding and an `incomplete` report, never a
 * quietly shorter answer.
 */
export const DEFAULT_LIMITS = Object.freeze({
  maxBytes: 1048576,
  maxLines: 20000,
  maxLinks: 2000,
  maxInventoryFiles: 5000,
  maxInventoryDepth: 12,
  minDescriptionChars: 10,
  maxDescriptionChars: 200,
})

/**
 * The authoritative rule severity table.
 *
 * Severity is the whole difference between a run that fails and one that
 * passes. As a literal at forty construction sites it drifts silently, so every
 * finding takes its severity from here, an unknown rule id throws instead of
 * defaulting, and `docs/llms-rules.md` is asserted against this table in both
 * directions by `test/severity-table.test.mjs`.
 */
export const RULE_SEVERITY = Object.freeze({
  'coverage-claim-unmet': 'error',
  'coverage-unverified': 'warning',
  'description-duplicated': 'warning',
  'description-missing': 'warning',
  'description-separator': 'info',
  'description-too-long': 'info',
  'description-uninformative': 'warning',
  'entry-name-missing': 'warning',
  'entry-outside-section': 'warning',
  'file-not-utf8': 'error',
  'file-too-large': 'error',
  'file-too-many-lines': 'error',
  'file-unreadable': 'error',
  'fragment-only-target': 'warning',
  'heading-level-unsupported': 'warning',
  'inventory-document-unlisted': 'warning',
  'inventory-entry-skipped': 'warning',
  'inventory-too-deep': 'error',
  'inventory-too-many-files': 'error',
  'inventory-unreadable': 'error',
  'list-item-not-a-link': 'error',
  'local-target-empty-file': 'warning',
  'local-target-escapes-root': 'error',
  'local-target-missing': 'error',
  'local-target-not-file': 'error',
  'local-target-outside-root': 'error',
  'local-target-unreadable': 'error',
  'nothing-checked': 'warning',
  'optional-section-claims-required': 'warning',
  'remote-target-broken': 'error',
  'remote-target-unverified': 'warning',
  'section-duplicated': 'warning',
  'section-empty': 'warning',
  'section-heading-empty': 'error',
  'section-prose-ignored': 'info',
  'summary-missing': 'warning',
  'target-duplicated': 'warning',
  'target-empty': 'error',
  'title-duplicated': 'error',
  'title-missing': 'error',
  'title-not-first': 'error',
  'too-many-links': 'error',
  'unsafe-target': 'error',
  'unsupported-scheme': 'info',
})

/**
 * Coverage claim detection.
 *
 * A line states complete coverage when it carries both a completeness word and
 * a word about listing. This is a lexical test over a fixed vocabulary, not
 * comprehension: it is documented as such in `docs/llms-rules.md`, and what it
 * misses is a stated non-goal rather than a silent gap.
 */
const COMPLETENESS = /\b(all|every|each|complete|completely|entire|entirety|exhaustive|exhaustively|full|fully|whole)\b/
const LISTING = /\b(below|cover|covered|covers|coverage|document|documented|documents|here|include|included|includes|index|indexed|link|linked|links|list|listed|lists|listing)\b/
const REQUIREMENT = /\b(required|require|requires|requirement|mandatory|essential|must|necessary)\b/

const OPTIONAL_SECTION = 'optional'
const EVIDENCE_LIMIT = 160
const MISSING_SAMPLE = 8
const UNPRINTABLE = /[\u0000-\u001f\u007f\u2028\u2029]/g

/** A problem with how the tool was invoked, not with the file being audited. */
export class ConfigError extends Error {
  constructor(message) {
    super(message)
    this.name = 'ConfigError'
  }
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

/**
 * A bounded, single-line excerpt.
 *
 * Content from the audited file is data. It is flattened, stripped of control
 * characters and cut to length before it reaches the report, so it can never be
 * mistaken for a line of the report's own structure.
 */
function excerpt(value, limit = EVIDENCE_LIMIT) {
  const flattened = String(value).replace(UNPRINTABLE, ' ').replace(/\s+/g, ' ').trim()
  return flattened.length <= limit ? flattened : `${flattened.slice(0, limit)}...`
}

const QUOTED_INPUT = /^Unexpected token (.{1,12}?), (?:\.\.\.)?".*"(?:\.\.\.)? is not valid JSON$/s
const PARSE_POSITION = /\bat position \d+(?: \(line \d+ column \d+\))?$/
const PARSE_EMPTY = /^Unexpected end of JSON input$/

/**
 * The useful half of a `JSON.parse` failure, without the capture content V8
 * puts in the other half.
 *
 * V8 reports a parse failure in two shapes. One names a position and quotes
 * nothing. The other quotes the input back:
 * `Unexpected token 'A', "AKIAIOSFODNN7EXAMPLE" is not valid JSON` -- the whole
 * capture when it is short, a window around the offence when it is not. A
 * capture is an imported record of what remote addresses served, so it is
 * untrusted by construction, and a capture short enough to be only a credential
 * is reproduced in full by its own error message.
 *
 * `excerpt` cannot close it. Flattening replaces control characters, and the
 * cut is taken from the END while the quoted span sits at the front.
 *
 * The quoting shape is recognised FIRST. Looking for `at position` first would
 * be defeated by a capture that merely CONTAINS that phrase, because the quoted
 * span would then be kept as though V8 had written it.
 *
 * Only the offending token survives from the quoting shape. The quoted span
 * never leaves this function.
 */
export function parseFailureDetail(error) {
  const message = String(error?.message ?? '')
  const quoted = QUOTED_INPUT.exec(message)
  if (quoted !== null) return `unexpected token ${quoted[1]}`
  if (PARSE_POSITION.test(message) || PARSE_EMPTY.test(message)) return message
  return 'it could not be parsed as JSON'
}

export function validateLimits(overrides = {}) {
  if (!isRecord(overrides)) throw new ConfigError('Limits must be an object')
  const limits = { ...DEFAULT_LIMITS }
  for (const [name, value] of Object.entries(overrides)) {
    if (!Object.hasOwn(DEFAULT_LIMITS, name)) {
      throw new ConfigError(`Unknown limit "${name}". Known limits: ${Object.keys(DEFAULT_LIMITS).join(', ')}`)
    }
    if (!Number.isInteger(value) || value < 1) throw new ConfigError(`Limit "${name}" must be a positive integer`)
    limits[name] = value
  }
  if (limits.minDescriptionChars > limits.maxDescriptionChars) {
    throw new ConfigError('minDescriptionChars must not exceed maxDescriptionChars')
  }
  return Object.freeze(limits)
}

const CAPTURE_KEYS = Object.freeze(['schemaVersion', 'capturedAt', 'source', 'urls'])
const CAPTURE_ENTRY_KEYS = Object.freeze(['state', 'httpStatus', 'note'])

/**
 * Validate an imported address capture.
 *
 * This tool has no network. The only way a remote address becomes verified is
 * an operator importing a capture produced elsewhere, so a malformed capture is
 * a configuration error rather than a finding: accepting one quietly would turn
 * "unknown" into "fine", and a mistyped key would do it silently.
 */
export function validateCapture(document) {
  if (!isRecord(document)) throw new ConfigError('Capture must be a JSON object')
  for (const key of Object.keys(document)) {
    if (!CAPTURE_KEYS.includes(key)) {
      throw new ConfigError(`Unknown capture key "${key}". Known keys: ${CAPTURE_KEYS.join(', ')}`)
    }
  }
  if (document.schemaVersion !== CAPTURE_SCHEMA_VERSION) {
    throw new ConfigError(`Unsupported capture schemaVersion: ${document.schemaVersion ?? 'missing'}`)
  }
  if (document.capturedAt !== undefined && typeof document.capturedAt !== 'string') {
    throw new ConfigError('Capture capturedAt must be a string when present')
  }
  if (document.source !== undefined && typeof document.source !== 'string') {
    throw new ConfigError('Capture source must be a string when present')
  }
  if (!isRecord(document.urls)) throw new ConfigError('Capture is missing its urls object')

  for (const [url, entry] of Object.entries(document.urls)) {
    if (!isRecord(entry)) throw new ConfigError(`Capture entry for "${excerpt(url, 80)}" must be an object`)
    for (const key of Object.keys(entry)) {
      if (!CAPTURE_ENTRY_KEYS.includes(key)) {
        throw new ConfigError(
          `Unknown capture entry key "${key}" for "${excerpt(url, 80)}". Known keys: ${CAPTURE_ENTRY_KEYS.join(', ')}`,
        )
      }
    }
    if (!CAPTURE_STATES.includes(entry.state)) {
      throw new ConfigError(
        `Capture entry for "${excerpt(url, 80)}" has unsupported state "${entry.state ?? 'missing'}". Known states: ${CAPTURE_STATES.join(', ')}`,
      )
    }
    if (entry.httpStatus !== undefined && !Number.isInteger(entry.httpStatus)) {
      throw new ConfigError(`Capture entry for "${excerpt(url, 80)}" has a non-integer httpStatus`)
    }
  }
  return document
}

function createCollector(file) {
  return { file, rows: [], incomplete: false, order: 0 }
}

function record(collector, row) {
  collector.rows.push({ file: collector.file, ...row, order: collector.order })
  collector.order += 1
}

/**
 * The severity of one rule.
 *
 * Every finding goes through here. An unknown rule id throws rather than
 * defaulting to something harmless, so a rule that was never given a severity
 * cannot be emitted at an accidental one.
 */
export function severityFor(ruleId) {
  const severity = RULE_SEVERITY[ruleId]
  if (severity === undefined) {
    throw new Error(`Rule "${ruleId}" is not in RULE_SEVERITY; add it there and to docs/llms-rules.md.`)
  }
  return severity
}

function toFinding(row) {
  const severity = severityFor(row.ruleId)
  const finding = { ruleId: row.ruleId, severity, message: row.message, location: { file: row.file } }
  if (row.line !== undefined) finding.line = row.line
  if (row.column !== undefined) finding.column = row.column
  if (row.target !== undefined) finding.target = excerpt(row.target, 120)
  if (row.evidence !== undefined && row.evidence !== null && row.evidence !== '') finding.evidence = excerpt(row.evidence)
  if (row.suggestion !== undefined) finding.suggestion = row.suggestion
  return finding
}

function claimIn(text) {
  const lowered = String(text).toLowerCase()
  const completeness = COMPLETENESS.exec(lowered)
  if (completeness === null || !LISTING.test(lowered)) return null
  return completeness[1]
}

function statesRequirement(text) {
  return REQUIREMENT.test(String(text).toLowerCase())
}

function emptyCounts() {
  return {
    entries: 0,
    sections: 0,
    localTargets: 0,
    remoteTargets: 0,
    otherTargets: 0,
    verified: 0,
    unverified: 0,
    coverageClaims: 0,
    inventoryDocuments: 0,
    inventoryLinked: 0,
    inventorySkipped: 0,
  }
}

/**
 * Order findings by (file, line, column, ruleId, target), then by the order
 * they were recorded. Nothing in that key depends on the locale, the clock or
 * the order the filesystem happened to hand back an entry.
 */
function finish(collector, counts, extras) {
  collector.rows.sort(
    (left, right) =>
      byCodeUnit(left.file, right.file) ||
      (left.line ?? 0) - (right.line ?? 0) ||
      (left.column ?? 0) - (right.column ?? 0) ||
      byCodeUnit(left.ruleId, right.ruleId) ||
      byCodeUnit(left.target ?? '', right.target ?? '') ||
      left.order - right.order,
  )
  const findings = collector.rows.map(toFinding)
  const errors = findings.filter((finding) => finding.severity === 'error').length
  const warnings = findings.filter((finding) => finding.severity === 'warning').length

  return {
    schemaVersion: REPORT_SCHEMA_VERSION,
    tool: TOOL_ID,
    status: collector.incomplete ? 'incomplete' : errors > 0 ? 'fail' : 'pass',
    advisory: ADVISORY,
    summary: {
      checked: counts.entries,
      errors,
      warnings,
      info: findings.length - errors - warnings,
      ...counts,
      ...extras,
    },
    findings,
  }
}

/**
 * The subject's real path, resolved as far as the filesystem allows.
 *
 * A subject that cannot be resolved still has to be placed relative to the
 * root, so the directory holding it is resolved instead and the name is put
 * back: a missing file inside a linked root is evidence to report, not a
 * refusal to run. The unreadable subject itself is left to `readSubject`.
 */
async function realSubject(fileResolved) {
  try {
    return await realpath(fileResolved)
  } catch {
    try {
      return resolve(await realpath(dirname(fileResolved)), basename(fileResolved))
    } catch {
      return fileResolved
    }
  }
}

async function readSubject(file, limits, collector, relativeFile) {
  let info
  try {
    info = await stat(file)
  } catch (error) {
    record(collector, {
      ruleId: 'file-unreadable',
      message: `${relativeFile} could not be read (${error.code ?? 'unknown error'}), so nothing was audited.`,
      suggestion: 'Check the --file path.',
    })
    collector.incomplete = true
    return null
  }
  if (!info.isFile()) {
    record(collector, {
      ruleId: 'file-unreadable',
      message: `${relativeFile} is not a regular file, so nothing was audited.`,
    })
    collector.incomplete = true
    return null
  }
  if (info.size > limits.maxBytes) {
    record(collector, {
      ruleId: 'file-too-large',
      message: `${relativeFile} is ${info.size} bytes, over the maxBytes limit of ${limits.maxBytes}, so nothing was audited.`,
      suggestion: 'Raise --max-bytes if this size is expected.',
    })
    collector.incomplete = true
    return null
  }

  let bytes
  try {
    bytes = await readFile(file)
  } catch (error) {
    record(collector, {
      ruleId: 'file-unreadable',
      message: `${relativeFile} could not be read (${error.code ?? 'unknown error'}), so nothing was audited.`,
    })
    collector.incomplete = true
    return null
  }

  // Strict decoding. Encoding validity is decided by the decoder on the bytes,
  // never inferred from the decoded text: a file may legitimately contain a
  // literal U+FFFD, and treating that as evidence of a bad encoding would
  // disable this guard exactly where it matters.
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    return { text: text.charCodeAt(0) === 0xfeff ? text.slice(1) : text, bytes: info.size }
  } catch {
    record(collector, {
      ruleId: 'file-not-utf8',
      message: `${relativeFile} is not valid UTF-8, so it was not decoded and nothing in it was audited.`,
      suggestion: 'Re-save the file as UTF-8.',
    })
    collector.incomplete = true
    return null
  }
}

function auditStructure(document, collector) {
  if (document.titles.length === 0) {
    record(collector, {
      ruleId: 'title-missing',
      line: 1,
      message: 'No H1 heading: the convention opens with the name of the project or site.',
      suggestion: 'Add a single "# Name" line at the top of the file.',
    })
  } else {
    if (document.preamble.length > 0) {
      record(collector, {
        ruleId: 'title-not-first',
        line: document.preamble[0].line,
        message: `Content appears before the H1 on line ${document.titles[0].line}; the name must come first.`,
      })
    }
    for (const extra of document.titles.slice(1)) {
      record(collector, {
        ruleId: 'title-duplicated',
        line: extra.line,
        message: 'A second H1 heading: the file names one project, and an H1 here hides the section structure below it.',
        evidence: extra.text,
        suggestion: 'Demote this heading to an H2 section.',
      })
    }
    if (document.summary === null) {
      record(collector, {
        ruleId: 'summary-missing',
        line: document.titles[0].line,
        message: 'No blockquote summary directly after the H1, so a consumer reading only the top of the file learns nothing about the project.',
        suggestion: 'Add a "> one sentence summary" line under the title.',
      })
    }
  }

  for (const heading of document.headingsBelowSection) {
    record(collector, {
      ruleId: 'heading-level-unsupported',
      line: heading.line,
      message: `H${heading.level} heading: the convention defines H1 for the name and H2 for sections, so a consumer may not treat this as a section.`,
      evidence: heading.text,
      suggestion: 'Promote it to an H2 section, or fold the content into the section above.',
    })
  }

  const seenHeadings = new Map()
  for (const section of document.sections) {
    if (section.heading === '') {
      record(collector, {
        ruleId: 'section-heading-empty',
        line: section.line,
        message: 'An H2 with no text: the section cannot be named or selected by a consumer.',
      })
    } else {
      const key = section.heading.toLowerCase()
      const first = seenHeadings.get(key)
      if (first === undefined) seenHeadings.set(key, section.line)
      else {
        record(collector, {
          ruleId: 'section-duplicated',
          line: section.line,
          message: `A section named "${excerpt(section.heading, 60)}" already appears on line ${first}; a consumer merging sections by heading will lose one of them.`,
        })
      }
    }

    if (section.entries.length === 0) {
      record(collector, {
        ruleId: 'section-empty',
        line: section.line,
        message: 'This H2 section contains no link list, so it offers a consumer nothing to fetch.',
        suggestion: 'Add the link list, or remove the heading.',
      })
    }

    for (const prose of section.prose) {
      record(collector, {
        ruleId: 'section-prose-ignored',
        line: prose.line,
        message: 'Prose inside an H2 section: the convention puts free text before the first section, and a consumer reading only link lists will skip this.',
        evidence: prose.text,
      })
    }

    if (section.heading.trim().toLowerCase() !== OPTIONAL_SECTION) continue
    for (const prose of section.prose) {
      if (!statesRequirement(prose.text)) continue
      record(collector, {
        ruleId: 'optional-section-claims-required',
        line: prose.line,
        message: 'The "Optional" section is defined as content a consumer may skip, but this text says the content is required.',
        evidence: prose.text,
        suggestion: 'Move required reading into a normal section, or drop the requirement wording.',
      })
    }
    for (const entry of section.entries) {
      if (!entry.hasLink || !statesRequirement(entry.description)) continue
      record(collector, {
        ruleId: 'optional-section-claims-required',
        line: entry.line,
        column: entry.column,
        target: entry.target,
        message: 'This entry sits in the "Optional" section, which a consumer may skip, but its description says it is required.',
        evidence: entry.description,
      })
    }
  }
}

function auditDescriptions(entry, collector, limits, descriptions) {
  if (entry.name === '') {
    record(collector, {
      ruleId: 'entry-name-missing',
      line: entry.line,
      column: entry.column,
      target: entry.target,
      message: 'The link has no text, so the entry offers no name for what it points at.',
    })
  }

  if (entry.separator !== null && entry.separator !== ':') {
    record(collector, {
      ruleId: 'description-separator',
      line: entry.line,
      column: entry.column,
      target: entry.target,
      evidence: entry.description,
      message: `The description follows "${entry.separator === '' ? 'no separator' : entry.separator}"; the convention writes "[name](target): description".`,
    })
  }

  const description = entry.description.trim()
  if (description === '') {
    record(collector, {
      ruleId: 'description-missing',
      line: entry.line,
      column: entry.column,
      target: entry.target,
      message: 'No description: a consumer choosing between entries has only the link text to go on.',
      suggestion: 'Add ": what this document covers" after the link.',
    })
    return
  }

  const normalized = description.toLowerCase()
  if (normalized === entry.name.trim().toLowerCase()) {
    record(collector, {
      ruleId: 'description-uninformative',
      line: entry.line,
      column: entry.column,
      target: entry.target,
      evidence: description,
      message: 'The description repeats the link text, so it adds nothing to it.',
    })
  } else if (description.length < limits.minDescriptionChars) {
    record(collector, {
      ruleId: 'description-uninformative',
      line: entry.line,
      column: entry.column,
      target: entry.target,
      evidence: description,
      message: `The description is ${description.length} characters, under the minDescriptionChars limit of ${limits.minDescriptionChars}.`,
    })
  }

  if (description.length > limits.maxDescriptionChars) {
    record(collector, {
      ruleId: 'description-too-long',
      line: entry.line,
      column: entry.column,
      target: entry.target,
      evidence: description,
      message: `The description is ${description.length} characters, over the maxDescriptionChars limit of ${limits.maxDescriptionChars}.`,
    })
  }

  const first = descriptions.get(normalized)
  if (first === undefined) descriptions.set(normalized, { line: entry.line, target: entry.target })
  else if (first.target !== entry.target) {
    record(collector, {
      ruleId: 'description-duplicated',
      line: entry.line,
      column: entry.column,
      target: entry.target,
      evidence: description,
      message: `The same description is already used on line ${first.line} for a different target, so the two entries are indistinguishable.`,
    })
  }
}

function noteIdentity(identity, entry, collector, identities) {
  const first = identities.get(identity)
  if (first === undefined) {
    identities.set(identity, entry.line)
    return
  }
  record(collector, {
    ruleId: 'target-duplicated',
    line: entry.line,
    column: entry.column,
    target: entry.target,
    message: `The same target is already linked on line ${first}.`,
  })
}

/** Where a local target resolves, before any confinement decision. */
function resolveLocal(classified, context) {
  const relativePart = classified.rootRelative ? classified.path.replace(/^\/+/, '') : classified.path
  const from = classified.rootRelative ? context.rootReal : context.fileDirectory
  return resolve(from, relativePart)
}

async function auditTarget(entry, context) {
  const { collector, counts, rootReal, capture, identities, linked } = context
  const classified = classifyTarget(entry.target ?? '')
  const at = { line: entry.line, column: entry.column, target: entry.target }

  if (classified.kind === 'empty') {
    counts.otherTargets += 1
    record(collector, { ...at, ruleId: 'target-empty', message: 'The link has no target.' })
    return
  }
  if (classified.kind === 'fragment') {
    counts.otherTargets += 1
    record(collector, {
      ...at,
      ruleId: 'fragment-only-target',
      message: 'The target is a fragment of this file, not a document a consumer can fetch.',
    })
    return
  }
  if (classified.kind === 'unsafe') {
    counts.otherTargets += 1
    record(collector, {
      ...at,
      ruleId: 'unsafe-target',
      message: `The "${classified.scheme}:" scheme cannot name a document and was not resolved.`,
      suggestion: 'Link to a document by relative path, or by https address.',
    })
    return
  }
  if (classified.kind === 'other-scheme') {
    counts.otherTargets += 1
    record(collector, {
      ...at,
      ruleId: 'unsupported-scheme',
      message: `The "${classified.scheme}:" scheme is not a document address this tool can check.`,
    })
    return
  }

  if (classified.kind === 'remote') {
    counts.remoteTargets += 1
    noteIdentity(`remote:${classified.key}`, entry, collector, identities)
    const state = capture === null ? undefined : capture.urls[classified.key]

    if (capture === null || state === undefined || state.state === 'unknown') {
      counts.unverified += 1
      // Nothing was fetched and nothing was imported about this address, so the
      // run cannot answer for it. Unverified is not a pass.
      collector.incomplete = true
      record(collector, {
        ...at,
        ruleId: 'remote-target-unverified',
        evidence: state === undefined ? undefined : state.note,
        message: capture === null
          ? 'Remote address: this tool never fetches, and no capture was imported, so nothing is known about it.'
          : state === undefined
            ? 'The imported capture has no entry for this address, so nothing is known about it.'
            : 'The imported capture records this address as unknown.',
        suggestion: 'Import a capture with --capture recording what this address served.',
      })
      return
    }

    counts.verified += 1
    if (state.state === 'broken') {
      record(collector, {
        ...at,
        ruleId: 'remote-target-broken',
        evidence: state.note,
        message: `The imported capture records this address as broken${state.httpStatus === undefined ? '' : ` (HTTP ${state.httpStatus})`}.`,
      })
    }
    return
  }

  counts.localTargets += 1
  const resolved = resolveLocal(classified, context)

  // Lexical confinement first: a traversal target is refused before it is opened.
  if (!isInside(rootReal, resolved)) {
    record(collector, {
      ...at,
      ruleId: 'local-target-outside-root',
      message: 'The target resolves outside the declared root and was refused; nothing outside the root was read.',
      suggestion: 'Point at a document inside the root, or use an https address.',
    })
    return
  }

  let real
  try {
    real = await realpath(resolved)
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') {
      record(collector, { ...at, ruleId: 'local-target-missing', message: 'No such file inside the declared root.' })
      return
    }
    collector.incomplete = true
    record(collector, {
      ...at,
      ruleId: 'local-target-unreadable',
      message: `The target could not be resolved (${error.code ?? 'unknown error'}), so it was not checked.`,
    })
    return
  }

  // Real-path confinement second: a symbolic link planted inside the root does
  // not get to pull a file from outside it into this report.
  if (!isInside(rootReal, real)) {
    record(collector, {
      ...at,
      ruleId: 'local-target-escapes-root',
      message: 'The target leaves the declared root through a symbolic link and was refused; nothing outside the root was read.',
      suggestion: 'Replace the link with a document inside the root.',
    })
    return
  }

  const info = await stat(real)
  const relativeTarget = toPosix(relative(rootReal, real))
  // A document is a regular file. A directory, a named pipe, a socket or a
  // device node is not one, and reading it is not something a consumer can
  // finish: a pipe with no writer blocks forever. This is the same line the
  // inventory walk draws, so the two halves of the audit agree about what a
  // document is.
  if (!info.isFile()) {
    record(collector, {
      ...at,
      ruleId: 'local-target-not-file',
      message: info.isDirectory()
        ? `The target is a directory (${relativeTarget}); this tool applies no index-file convention to it.`
        : `The target ${relativeTarget} is not a regular file, so it names nothing a reader can read to the end.`,
      suggestion: 'Link to the document itself.',
    })
    return
  }
  if (info.size === 0) {
    record(collector, { ...at, ruleId: 'local-target-empty-file', message: `The target ${relativeTarget} exists but is empty.` })
  }

  noteIdentity(`local:${real}`, entry, collector, identities)
  entry.resolvedReal = real
  linked.add(real)
}

/**
 * Compare what the file claims to cover against what is on disk.
 *
 * A claim with no readable inventory is the interesting case: it is not a pass,
 * because nothing checked it. It is reported unverified and the run is
 * `incomplete`.
 */
async function auditCoverage(document, context, options, extras) {
  const { collector, counts, limits, rootReal, linked } = context

  const claims = []
  const consider = (section, line, text) => {
    const phrase = claimIn(text)
    if (phrase !== null) claims.push({ section, line, phrase, text })
  }
  if (document.summary !== null) consider(null, document.summary.line, document.summary.text)
  for (const prose of document.intro.prose) consider(null, prose.line, prose.text)
  for (const section of document.sections) {
    consider(section, section.line, section.heading)
    for (const prose of section.prose) consider(section, prose.line, prose.text)
  }
  counts.coverageClaims = claims.length

  let inventory = null
  let inventoryReal = null
  if (extras.inventoryDeclared) {
    const inventoryResolved = resolve(options.inventory)
    if (!isInside(rootReal, inventoryResolved)) {
      throw new ConfigError('The inventory root is outside the declared root')
    }
    try {
      inventoryReal = await realpath(inventoryResolved)
    } catch (error) {
      inventory = { ok: false, reason: error.code ?? 'unknown error' }
    }
    if (inventoryReal !== null && !isInside(rootReal, inventoryReal)) {
      throw new ConfigError('The inventory root leaves the declared root through a symbolic link')
    }
    if (inventory === null) inventory = await collectInventory(inventoryReal, limits, [context.fileReal])

    if (!inventory.ok) {
      collector.incomplete = true
      record(collector, {
        ruleId: 'inventory-unreadable',
        message: `The declared inventory root could not be listed (${inventory.reason}), so coverage was not checked.`,
        suggestion: 'Check the --inventory path.',
      })
    } else {
      counts.inventoryDocuments = inventory.documents.length
      counts.inventorySkipped = inventory.skipped.length

      for (const skipped of inventory.skipped) {
        // A skipped entry means the inventory is partial, and a coverage answer
        // from a partial inventory is not an answer.
        collector.incomplete = true
        record(collector, {
          ruleId: 'inventory-entry-skipped',
          file: toPosix(relative(rootReal, resolve(inventoryReal, skipped.relative))),
          message: `Not walked (${skipped.reason}), so whatever it leads to was not inventoried and the coverage figures below do not include it.`,
        })
      }

      if (inventory.exceeded !== null) {
        collector.incomplete = true
        record(collector, {
          ruleId: inventory.exceeded === 'maxInventoryDepth' ? 'inventory-too-deep' : 'inventory-too-many-files',
          message: inventory.exceeded === 'maxInventoryDepth'
            ? `The inventory is deeper than the maxInventoryDepth limit of ${limits.maxInventoryDepth}, so the deeper directories were not inventoried.`
            : `The inventory holds more than the maxInventoryFiles limit of ${limits.maxInventoryFiles} documents, so the rest were not inventoried.`,
          suggestion: 'Raise the limit, or point --inventory at a narrower tree.',
        })
      }

      for (const document_ of inventory.documents) {
        if (linked.has(document_.absolute)) {
          counts.inventoryLinked += 1
          continue
        }
        record(collector, {
          ruleId: 'inventory-document-unlisted',
          file: toPosix(relative(rootReal, document_.absolute)),
          message: 'This document exists in the declared inventory, but no entry in the llms.txt file links to it.',
          suggestion: 'Link it from a section, or move it out of the inventory root.',
        })
      }
    }
  }

  const usable = inventory !== null && inventory.ok && inventory.exceeded === null
  for (const claim of claims) {
    if (!usable) {
      collector.incomplete = true
      record(collector, {
        ruleId: 'coverage-unverified',
        line: claim.line,
        evidence: claim.text,
        message: extras.inventoryDeclared
          ? 'This text states complete coverage, but the inventory could not be read in full, so the claim was not checked.'
          : 'This text states complete coverage, but no inventory was declared, so the claim was not checked.',
        suggestion: 'Pass --inventory DIR so the claim can be compared with what is on disk.',
      })
      continue
    }

    const scope = claim.section === null
      ? linked
      : new Set(claim.section.entries.map((entry) => entry.resolvedReal).filter((value) => value !== undefined))
    const missing = inventory.documents.filter((document_) => !scope.has(document_.absolute))
    if (missing.length === 0) continue

    const sample = missing.slice(0, MISSING_SAMPLE).map((document_) => toPosix(relative(rootReal, document_.absolute)))
    record(collector, {
      ruleId: 'coverage-claim-unmet',
      line: claim.line,
      message: claim.section === null
        ? `This text claims complete coverage ("${claim.phrase}"), but ${missing.length} inventoried document(s) are linked nowhere in the file.`
        : `This section claims complete coverage ("${claim.phrase}"), but ${missing.length} inventoried document(s) are missing from its link list.`,
      evidence: `${claim.text} | not linked: ${sample.join(', ')}${missing.length > sample.length ? `, and ${missing.length - sample.length} more` : ''}`,
      suggestion: 'List the missing documents, or narrow the claim to what the section actually covers.',
    })
  }
}

/**
 * Audit an llms.txt file.
 *
 * `options.file` is the llms.txt path. `options.root` is the declared root that
 * every local target must stay inside, defaulting to the directory holding the
 * file. `options.inventory` is the documentation root whose documents the file
 * is supposed to index. `options.capture` is an already-parsed address capture,
 * or null.
 *
 * Nothing here reads the network, the clock, the locale or the environment, so
 * two runs over the same bytes produce the same report.
 */
export async function auditLlmsTxt(options = {}) {
  if (typeof options.file !== 'string' || options.file.trim() === '') {
    throw new ConfigError('A path to an llms.txt file is required')
  }
  const limits = validateLimits(options.limits ?? {})
  const capture = options.capture === undefined || options.capture === null ? null : validateCapture(options.capture)

  const fileResolved = resolve(options.file)
  const rootDeclared = resolve(options.root ?? dirname(fileResolved))
  let rootReal
  try {
    rootReal = await realpath(rootDeclared)
  } catch (error) {
    throw new ConfigError(`The declared root could not be read (${error.code ?? 'unknown error'})`)
  }
  if (!(await stat(rootReal)).isDirectory()) throw new ConfigError('The declared root must be a directory')

  // The subject is named by the operator, so a subject that leaves the root is
  // a refusal to run, not a finding about the site.
  //
  // Both sides of that comparison are resolved the same way. Comparing a
  // realpath'd root against a merely spelled file path refuses an llms.txt that
  // never left the root at all, whenever the path to the root runs through a
  // symbolic link — which is every temporary directory on macOS, where `/tmp`
  // is a link to `/private/tmp`.
  const fileReal = await realSubject(fileResolved)
  if (!isInside(rootReal, fileReal)) {
    // Which refusal this is matters to the operator: a path spelled outside the
    // root is a typo in the invocation, a path that only leaves it once the
    // links are followed is a fact about the tree.
    throw new ConfigError(
      isInside(rootDeclared, fileResolved)
        ? 'The llms.txt file leaves the declared root through a symbolic link'
        : 'The llms.txt file is outside the declared root',
    )
  }

  const relativeFile = toPosix(relative(rootReal, fileReal)) || 'llms.txt'
  const collector = createCollector(relativeFile)
  const counts = emptyCounts()
  const extras = {
    captureImported: capture !== null,
    capturedAt: capture === null ? null : excerpt(capture.capturedAt ?? '', 60) || null,
    inventoryDeclared: typeof options.inventory === 'string' && options.inventory.trim() !== '',
  }

  const subject = await readSubject(fileReal, limits, collector, relativeFile)
  if (subject === null) return finish(collector, counts, extras)

  const document = parseLlmsTxt(subject.text, limits)
  counts.sections = document.sections.length

  if (document.truncated.lines) {
    collector.incomplete = true
    record(collector, {
      ruleId: 'file-too-many-lines',
      line: limits.maxLines + 1,
      message: `The file has ${document.lineCount} lines, over the maxLines limit of ${limits.maxLines}; nothing from line ${limits.maxLines + 1} on was read.`,
      suggestion: 'Raise --max-lines if this length is expected.',
    })
  }
  if (document.truncated.links) {
    collector.incomplete = true
    record(collector, {
      ruleId: 'too-many-links',
      message: `More list entries than the maxLinks limit of ${limits.maxLinks}; the rest were not checked.`,
      suggestion: 'Raise --max-links if this many entries are expected.',
    })
  }

  auditStructure(document, collector)

  const context = {
    collector,
    counts,
    limits,
    rootReal,
    fileReal,
    fileDirectory: dirname(fileReal),
    capture,
    identities: new Map(),
    linked: new Set(),
  }
  const descriptions = new Map()
  const groups = [
    { section: null, entries: document.intro.entries },
    ...document.sections.map((section) => ({ section, entries: section.entries })),
  ]

  for (const group of groups) {
    for (const entry of group.entries) {
      counts.entries += 1
      if (!entry.hasLink) {
        record(collector, {
          ruleId: 'list-item-not-a-link',
          line: entry.line,
          column: entry.column,
          evidence: entry.raw,
          message: 'This list item holds no [name](target) link, so a consumer reading the list finds nothing to fetch here.',
        })
        continue
      }
      if (group.section === null) {
        record(collector, {
          ruleId: 'entry-outside-section',
          line: entry.line,
          column: entry.column,
          target: entry.target,
          message: 'This link is listed before the first H2 section, where the convention expects prose rather than a file list.',
          suggestion: 'Move it under an H2 section.',
        })
      }
      auditDescriptions(entry, collector, limits, descriptions)
      await auditTarget(entry, context)
    }
  }

  await auditCoverage(document, context, options, extras)

  if (counts.entries === 0) {
    // A pass having checked nothing is green on no evidence. It is reported,
    // and the run is incomplete, so an empty index cannot look like a clean one.
    collector.incomplete = true
    record(collector, {
      ruleId: 'nothing-checked',
      message: 'No link list entries were found, so this run checked no documents and cannot say the index is sound.',
      suggestion: 'Add the H2 sections and their link lists, or audit a different file.',
    })
  }

  return finish(collector, counts, extras)
}

export function exitCodeFor(report) {
  if (report.status === 'incomplete') return 2
  return report.status === 'fail' ? 1 : 0
}

const SEVERITY_WIDTH = 7

export function formatReport(report) {
  const { summary } = report
  const lines = [
    `${summary.checked} entry(s) in ${summary.sections} section(s): ${summary.errors} error, ${summary.warnings} warning, ${summary.info} info, status ${report.status}.`,
    `${summary.localTargets} local, ${summary.remoteTargets} remote (${summary.verified} verified from a capture, ${summary.unverified} unverified), ${summary.otherTargets} other target(s).`,
    `${summary.inventoryDocuments} inventoried document(s), ${summary.inventoryLinked} linked, ${summary.coverageClaims} coverage claim(s).`,
  ]
  for (const finding of report.findings) {
    const place = finding.line === undefined
      ? finding.location.file
      : `${finding.location.file}:${finding.line}${finding.column === undefined ? '' : `:${finding.column}`}`
    lines.push(`${finding.severity.toUpperCase().padEnd(SEVERITY_WIDTH)} ${place} ${finding.ruleId} ${finding.message}`)
  }
  lines.push(ADVISORY)
  return `${lines.join('\n')}\n`
}
