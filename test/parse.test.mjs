import assert from 'node:assert/strict'
import test from 'node:test'

import { parseLlmsTxt, scanLink, splitDescription, splitLines } from '../src/index.mjs'

const SAMPLE = [
  '# Name',
  '',
  '> Summary line',
  '> continued.',
  '',
  'Intro prose.',
  '',
  '## Docs',
  '',
  '- [A](a.md): first entry.',
  '- [B](<b with space.md>): second entry.',
  '- [C](c(1).md "title"): third entry.',
  '- [D](d.md) no separator here.',
  '- plain item',
  '  wrapped continuation.',
  '',
  '```',
  '- [Fenced](nope.md): must not become an entry.',
  '```',
  '',
  'Setext Section',
  '--------------',
  '',
  '### Deeper',
  '',
].join('\n')

test('splitLines handles all three line terminators', () => {
  assert.deepEqual(splitLines('a\nb\r\nc\rd'), ['a', 'b', 'c', 'd'])
})

test('the document model records structure with 1-based lines', () => {
  const document = parseLlmsTxt(SAMPLE)

  assert.deepEqual(document.titles, [{ text: 'Name', line: 1, style: 'atx' }])
  assert.deepEqual(document.summary, { text: 'Summary line continued.', line: 3 })
  assert.deepEqual(document.preamble, [])
  assert.deepEqual(document.intro.prose, [{ line: 6, text: 'Intro prose.', kind: 'paragraph' }])
  assert.deepEqual(document.intro.entries, [])

  assert.deepEqual(
    document.sections.map((section) => [section.heading, section.line, section.style]),
    [['Docs', 8, 'atx'], ['Setext Section', 21, 'setext']],
  )
  assert.deepEqual(document.headingsBelowSection, [{ text: 'Deeper', line: 24, level: 3 }])
})

test('entries carry name, target, separator, description, line and column', () => {
  const [section] = parseLlmsTxt(SAMPLE).sections

  assert.deepEqual(
    section.entries.map((entry) => ({
      line: entry.line,
      column: entry.column,
      hasLink: entry.hasLink,
      name: entry.name,
      target: entry.target,
      separator: entry.separator,
      description: entry.description,
    })),
    [
      { line: 10, column: 3, hasLink: true, name: 'A', target: 'a.md', separator: ':', description: 'first entry.' },
      { line: 11, column: 3, hasLink: true, name: 'B', target: 'b with space.md', separator: ':', description: 'second entry.' },
      { line: 12, column: 3, hasLink: true, name: 'C', target: 'c(1).md', separator: ':', description: 'third entry.' },
      { line: 13, column: 3, hasLink: true, name: 'D', target: 'd.md', separator: '', description: 'no separator here.' },
      {
        line: 14,
        column: 3,
        hasLink: false,
        name: undefined,
        target: undefined,
        separator: undefined,
        description: undefined,
      },
    ],
  )
  assert.equal(section.entries[4].raw, 'plain item wrapped continuation.')
})

test('a link inside a fenced block is not an entry', () => {
  const targets = parseLlmsTxt(SAMPLE).sections.flatMap((section) => section.entries.map((entry) => entry.target))
  assert.equal(targets.includes('nope.md'), false)
  assert.deepEqual(parseLlmsTxt(SAMPLE).sections[1].entries, [])
})

test('scanLink reads angle-bracketed, parenthesised and titled destinations', () => {
  assert.deepEqual(scanLink('see [x](a(b)c.md) here'), {
    name: 'x',
    target: 'a(b)c.md',
    title: null,
    start: 4,
    end: 17,
  })
  assert.equal(scanLink('[x](<a b.md> "t")').target, 'a b.md')
  assert.equal(scanLink('[x](<a b.md> "t")').title, 't')
  assert.equal(scanLink('[nested [brackets]](t.md)').name, 'nested [brackets]')
  assert.equal(scanLink('no link here'), null)
  assert.equal(scanLink('[not a link] (spaced.md)'), null)
})

test('splitDescription reports which separator was used', () => {
  assert.deepEqual(splitDescription(': a description'), { separator: ':', description: 'a description' })
  assert.deepEqual(splitDescription(' — dashed'), { separator: '—', description: 'dashed' })
  assert.deepEqual(splitDescription(' bare text'), { separator: '', description: 'bare text' })
  assert.deepEqual(splitDescription('   '), { separator: null, description: '' })
})

test('maxLinks stops at the bound and says so instead of truncating quietly', () => {
  const text = ['# N', '', '## S', '', '- [a](a.md): one.', '- [b](b.md): two.', '- [c](c.md): three.'].join('\n')
  const document = parseLlmsTxt(text, { maxLinks: 2 })

  assert.equal(document.truncated.links, true)
  assert.deepEqual(document.sections[0].entries.map((entry) => entry.target), ['a.md', 'b.md'])
  assert.equal(parseLlmsTxt(text, { maxLinks: 3 }).truncated.links, false)
})

test('maxLines stops reading at the bound', () => {
  const document = parseLlmsTxt(SAMPLE, { maxLines: 8 })

  assert.equal(document.truncated.lines, true)
  assert.deepEqual(document.sections.map((section) => section.heading), ['Docs'])
  assert.deepEqual(document.sections[0].entries, [])
})

test('content before the H1 is kept as preamble', () => {
  const document = parseLlmsTxt(['A stray line.', '', '# Name', ''].join('\n'))
  assert.deepEqual(document.preamble, [{ line: 1, kind: 'paragraph' }])
  assert.deepEqual(document.titles, [{ text: 'Name', line: 3, style: 'atx' }])
})
