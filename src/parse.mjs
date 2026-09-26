/**
 * A bounded Markdown-subset parser for the llms.txt convention.
 *
 * llms.txt is not general Markdown: it is an H1 name, an optional blockquote
 * summary, free prose, then H2 sections whose bodies are link lists. This
 * parser reads exactly that shape and records a 1-based line (and column) for
 * everything it finds, because a diagnostic that cannot name a line is a
 * diagnostic an author cannot act on.
 *
 * It is deliberately not a CommonMark implementation. What it does and does not
 * understand is listed in `docs/llms-rules.md`, and anything it cannot place is
 * reported rather than reinterpreted.
 */

const ATX_HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*$/
const SETEXT_UNDERLINE = /^ {0,3}(=+|-+)[ \t]*$/
const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})(.*)$/
const BLOCKQUOTE = /^ {0,3}>[ \t]?(.*)$/
const LIST_ITEM = /^( {0,7})([-*+]|\d{1,9}[.)])(?:[ \t]+(.*)|[ \t]*)$/
const THEMATIC_BREAK = /^ {0,3}(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/

/** Separators seen in the wild between a link and its description. */
const DESCRIPTION_SEPARATORS = Object.freeze([':', '—', '–', '-'])

export function splitLines(text) {
  return text.split(/\r\n|\n|\r/)
}

function findClosingBracket(text, open) {
  let depth = 0
  for (let index = open; index < text.length; index += 1) {
    const character = text[index]
    if (character === '\\') {
      index += 1
      continue
    }
    if (character === '[') depth += 1
    else if (character === ']') {
      depth -= 1
      if (depth === 0) return index
    }
  }
  return -1
}

function readTitle(text, start) {
  const opener = text[start]
  if (opener !== '"' && opener !== "'" && opener !== '(') return { title: null, end: start }
  const closer = opener === '(' ? ')' : opener
  for (let index = start + 1; index < text.length; index += 1) {
    if (text[index] === '\\') {
      index += 1
      continue
    }
    if (text[index] === closer) return { title: text.slice(start + 1, index), end: index + 1 }
  }
  return null
}

function readDestination(text, start) {
  let index = start
  while (index < text.length && (text[index] === ' ' || text[index] === '\t')) index += 1

  let target = ''
  if (text[index] === '<') {
    const close = text.indexOf('>', index + 1)
    if (close === -1) return null
    target = text.slice(index + 1, close)
    index = close + 1
  } else {
    const from = index
    let depth = 0
    for (; index < text.length; index += 1) {
      const character = text[index]
      if (character === '\\') {
        index += 1
        continue
      }
      if (character === ' ' || character === '\t') break
      if (character === '(') depth += 1
      else if (character === ')') {
        if (depth === 0) break
        depth -= 1
      }
    }
    target = text.slice(from, index)
  }

  while (index < text.length && (text[index] === ' ' || text[index] === '\t')) index += 1
  const titled = readTitle(text, index)
  if (titled === null) return null
  index = titled.end
  while (index < text.length && (text[index] === ' ' || text[index] === '\t')) index += 1
  if (text[index] !== ')') return null
  return { target, title: titled.title, end: index + 1 }
}

/**
 * Find the first inline link in `text`, starting at `from`.
 *
 * Written by hand rather than as one regular expression because a destination
 * may carry balanced parentheses or be wrapped in angle brackets, and a
 * pattern that gets that wrong mis-reports the target — the single value the
 * whole audit turns on.
 */
export function scanLink(text, from = 0) {
  for (let index = from; index < text.length; index += 1) {
    const character = text[index]
    if (character === '\\') {
      index += 1
      continue
    }
    if (character !== '[') continue
    const nameEnd = findClosingBracket(text, index)
    if (nameEnd === -1) return null
    if (text[nameEnd + 1] !== '(') continue
    const destination = readDestination(text, nameEnd + 2)
    if (destination === null) continue
    return {
      name: text.slice(index + 1, nameEnd),
      target: destination.target,
      title: destination.title,
      start: index,
      end: destination.end,
    }
  }
  return null
}

/**
 * Split the text following a link into its description and the separator used.
 *
 * The convention writes `- [name](url): description`. Other separators are
 * accepted so the description is still read, and the deviation is reported by
 * the audit rather than silently normalised away.
 */
export function splitDescription(rest) {
  const trimmed = rest.trim()
  if (trimmed === '') return { separator: null, description: '' }
  const separator = DESCRIPTION_SEPARATORS.find((candidate) => trimmed.startsWith(candidate)) ?? null
  if (separator === null) return { separator: '', description: trimmed }
  return { separator, description: trimmed.slice(separator.length).trim() }
}

function blockOfLines(lines, limitLines) {
  const blocks = []
  const total = Math.min(lines.length, limitLines)
  let index = 0

  const pushParagraph = (collected) => {
    if (collected.length === 0) return
    blocks.push({
      kind: 'paragraph',
      line: collected[0].line,
      text: collected.map((entry) => entry.text.trim()).join(' '),
    })
  }

  while (index < total) {
    const raw = lines[index]
    const line = index + 1

    const fence = FENCE_OPEN.exec(raw)
    if (fence !== null) {
      const marker = fence[1][0]
      const length = fence[1].length
      let cursor = index + 1
      while (cursor < total) {
        const closing = FENCE_OPEN.exec(lines[cursor])
        if (closing !== null && closing[1][0] === marker && closing[1].length >= length && closing[2].trim() === '') {
          cursor += 1
          break
        }
        cursor += 1
      }
      blocks.push({ kind: 'fence', line, endLine: Math.min(cursor, total) })
      index = cursor
      continue
    }

    if (raw.trim() === '') {
      index += 1
      continue
    }

    const heading = ATX_HEADING.exec(raw)
    if (heading !== null) {
      const text = (heading[2] ?? '').replace(/[ \t]+#+$/, '').trim()
      blocks.push({ kind: 'heading', level: heading[1].length, text, line, style: 'atx' })
      index += 1
      continue
    }

    if (THEMATIC_BREAK.test(raw)) {
      index += 1
      continue
    }

    const quote = BLOCKQUOTE.exec(raw)
    if (quote !== null) {
      const collected = []
      let cursor = index
      while (cursor < total) {
        const next = BLOCKQUOTE.exec(lines[cursor])
        if (next === null) break
        collected.push(next[1])
        cursor += 1
      }
      blocks.push({ kind: 'blockquote', line, endLine: cursor, text: collected.join(' ').trim() })
      index = cursor
      continue
    }

    const item = LIST_ITEM.exec(raw)
    if (item !== null) {
      const items = []
      let cursor = index
      while (cursor < total) {
        const next = LIST_ITEM.exec(lines[cursor])
        if (next === null) break
        const markerColumn = next[1].length + 1
        const contentColumn = markerColumn + next[2].length + (next[3] === undefined ? 0 : 1)
        const collected = { line: cursor + 1, indent: next[1].length, marker: next[2], column: contentColumn, text: next[3] ?? '' }
        cursor += 1
        // A wrapped description continues the item until a blank line or a new block.
        while (cursor < total) {
          const continuation = lines[cursor]
          if (continuation.trim() === '') break
          if (LIST_ITEM.test(continuation) || ATX_HEADING.test(continuation)) break
          if (FENCE_OPEN.test(continuation) || BLOCKQUOTE.test(continuation)) break
          collected.text = `${collected.text} ${continuation.trim()}`.trim()
          cursor += 1
        }
        items.push(collected)
      }
      blocks.push({ kind: 'list', line, items })
      index = cursor
      continue
    }

    const collected = []
    let cursor = index
    let becameHeading = false
    while (cursor < total) {
      const candidate = lines[cursor]
      if (candidate.trim() === '') break
      const underline = SETEXT_UNDERLINE.exec(candidate)
      if (underline !== null && collected.length > 0) {
        blocks.push({
          kind: 'heading',
          level: underline[1][0] === '=' ? 1 : 2,
          text: collected.map((entry) => entry.text.trim()).join(' '),
          line: collected[0].line,
          style: 'setext',
        })
        cursor += 1
        becameHeading = true
        break
      }
      if (ATX_HEADING.test(candidate) || FENCE_OPEN.test(candidate)) break
      if (BLOCKQUOTE.test(candidate) || LIST_ITEM.test(candidate)) break
      collected.push({ line: cursor + 1, text: candidate })
      cursor += 1
    }
    if (!becameHeading) pushParagraph(collected)
    if (cursor === index) cursor += 1
    index = cursor
  }

  return blocks
}

function entryFrom(item) {
  const link = scanLink(item.text)
  if (link === null) {
    return { line: item.line, column: item.column, hasLink: false, raw: item.text, indent: item.indent }
  }
  const rest = item.text.slice(link.end)
  const { separator, description } = splitDescription(rest)
  return {
    line: item.line,
    column: item.column + link.start,
    hasLink: true,
    raw: item.text,
    indent: item.indent,
    name: link.name.trim(),
    target: link.target,
    title: link.title,
    separator,
    description,
  }
}

/**
 * Parse an llms.txt document.
 *
 * `limits.maxLines` and `limits.maxLinks` are enforced here and reported back
 * through `truncated`, so the caller can turn either into an explicit finding.
 * Neither is ever applied silently.
 */
export function parseLlmsTxt(text, limits = {}) {
  const maxLines = limits.maxLines ?? Number.MAX_SAFE_INTEGER
  const maxLinks = limits.maxLinks ?? Number.MAX_SAFE_INTEGER

  const lines = splitLines(text)
  const truncated = { lines: lines.length > maxLines, links: false }
  const blocks = blockOfLines(lines, maxLines)

  const document = {
    lineCount: lines.length,
    titles: [],
    preamble: [],
    summary: null,
    intro: { prose: [], entries: [] },
    sections: [],
    headingsBelowSection: [],
    truncated,
  }

  let seenTitle = false
  let current = null
  let expectSummary = false
  let entryCount = 0

  const target = () => (current === null ? document.intro : current)

  for (const block of blocks) {
    if (block.kind === 'fence') {
      expectSummary = false
      continue
    }

    if (block.kind === 'heading') {
      if (block.level === 1) {
        document.titles.push({ text: block.text, line: block.line, style: block.style })
        if (!seenTitle) {
          seenTitle = true
          expectSummary = true
          current = null
        }
        continue
      }
      if (block.level === 2) {
        current = { heading: block.text, line: block.line, style: block.style, prose: [], entries: [] }
        document.sections.push(current)
        expectSummary = false
        continue
      }
      document.headingsBelowSection.push({ text: block.text, line: block.line, level: block.level })
      expectSummary = false
      continue
    }

    if (!seenTitle) {
      document.preamble.push({ line: block.line, kind: block.kind })
      continue
    }

    if (block.kind === 'blockquote' && expectSummary && document.summary === null) {
      document.summary = { text: block.text, line: block.line }
      expectSummary = false
      continue
    }
    expectSummary = false

    if (block.kind === 'list') {
      for (const item of block.items) {
        if (entryCount >= maxLinks) {
          truncated.links = true
          break
        }
        entryCount += 1
        target().entries.push(entryFrom(item))
      }
      continue
    }

    target().prose.push({ line: block.line, text: block.text, kind: block.kind })
  }

  return document
}
