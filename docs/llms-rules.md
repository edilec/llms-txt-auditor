# Rules, limits and determinism

This document is the reference for what `llms-txt-auditor` inspects, what each rule means, and
what the tool refuses to claim. Rule ids are stable: renaming one is a breaking change and is
recorded in the changelog.

`src/index.mjs` exports `RULE_SEVERITY`, the single table every finding takes its severity from.
The catalog below is asserted against that table in both directions by
`test/severity-table.test.mjs`, so the code and this page cannot drift apart.

## What llms.txt is

A Markdown file at the root of a site, holding an H1 name, an optional blockquote summary, free
prose, and H2 sections whose bodies are link lists of the form `- [name](target): description`.
An H2 section named `Optional` marks content a consumer may skip.

**It is a convention, not an enforcement mechanism.** It does not compel any crawler, agent or
model provider to read it, honour it, or stay away from anything. Every report this tool writes
carries that sentence in its `advisory` field. Nothing in this catalog is evidence about what any
consumer did.

## What is parsed

A deliberate Markdown subset, described here so a surprise is a documented one:

| Construct | Read as |
| --- | --- |
| `# Name` / `## Section` (ATX, up to `######`) | headings; trailing `#` characters are stripped |
| A `===` or `---` underline under a paragraph | a setext H1 or H2 |
| `> text` | a blockquote; consecutive lines join with a space |
| `- item`, `* item`, `+ item`, `1. item` | list items, at up to 7 leading spaces |
| A following, more-indented non-blank line | a continuation of the item above it |
| ``` ``` ``` and `~~~` fences | skipped entirely, including any links inside |
| `[name](target)`, `[name](<target>)`, `[name](target "title")` | an entry link; parentheses inside a target may nest |

Not implemented, and reported rather than guessed at: reference-style links (`[name][label]`),
HTML blocks, tables, and lazy blockquote continuation. Front matter is not recognised; a `---`
line before any paragraph is read as a thematic break and ignored.

Line numbers are 1-based and count lines as `\r\n`, `\n` or `\r` separated. Columns are 1-based
and point at the `[` of the entry link.

## Targets

| Target | Treatment |
| --- | --- |
| `docs/page.md`, `./page.md` | resolved against the directory holding the llms.txt file |
| `/docs/page.md` | resolved against the declared root |
| `https://…`, `http://`, `//host/path` | remote; never fetched, only looked up in an imported capture |
| `mailto:`, `tel:`, other schemes | reported as an address this tool cannot check |
| `javascript:`, `data:`, `vbscript:`, `file:`, `blob:` | refused as unsafe; never resolved |
| `#fragment` | reported: a fragment of the index is not a document |

A local target's query and fragment are removed before it is resolved, and percent escapes in the
path are decoded. Anchors inside a target document are **not** checked.

Confinement is enforced twice: the resolved path must be inside the declared root by spelling,
and the **real** path, after every symbolic link has been followed, must be inside the **real**
root. Nothing outside the root is opened, and no path or content from outside it reaches the
report.

The audited file itself is held to the same rule, and refused rather than reported on: `--file`
must be inside the declared root once **both** paths are fully resolved. A root reached through a
symbolic link is therefore still the root — `/tmp` and `/private/tmp` name one directory, and a
file inside it never left it.

## Coverage claims

A line of prose, a summary, or an H2 heading states complete coverage when it contains both a
completeness word and a listing word:

- completeness: `all`, `every`, `each`, `complete`, `completely`, `entire`, `entirety`,
  `exhaustive`, `exhaustively`, `full`, `fully`, `whole`
- listing: `below`, `cover`, `covered`, `covers`, `coverage`, `document`, `documented`,
  `documents`, `here`, `include`, `included`, `includes`, `index`, `indexed`, `link`, `linked`,
  `links`, `list`, `listed`, `lists`, `listing`

This is a lexical test over a fixed vocabulary, not comprehension. It is documented rather than
tuned: what it misses is listed under "Limits and non-goals" in the README.

A claim inside an H2 section is measured against **that section's** link list. A claim in the
summary or in the prose before the first section is measured against **the whole file**. Both are
measured against the whole declared inventory, so a section covering only part of a tree needs a
narrower `--inventory`.

A claim with no usable inventory is `coverage-unverified` and the run is `incomplete`. An
unchecked claim is never a pass.

Entry descriptions are not scanned for claims: a description describes one document, and reading
a claim into it would produce failures nobody wrote.

## Rule catalog

| Rule | Severity | Meaning |
| --- | --- | --- |
| `coverage-claim-unmet` | error | Text in the file states complete coverage, but documents in the declared inventory are not in the link list it claims for. This is the contradictory-scope case. |
| `coverage-unverified` | warning | Text states complete coverage and no usable inventory was available, so the claim was not checked. The run is `incomplete`. |
| `description-duplicated` | warning | The same description is used for two different targets, so the entries cannot be told apart. |
| `description-missing` | warning | An entry carries no description. |
| `description-separator` | info | The description follows something other than the `:` the convention uses. |
| `description-too-long` | info | The description is longer than `maxDescriptionChars`. |
| `description-uninformative` | warning | The description repeats the link text, or is shorter than `minDescriptionChars`. |
| `entry-name-missing` | warning | The link has empty text, so the entry names nothing. |
| `entry-outside-section` | warning | A link list appears before the first H2, where the convention expects prose. |
| `file-not-utf8` | error | The file did not decode as UTF-8 under a strict decoder. Nothing in it was audited; the run is `incomplete`. |
| `file-too-large` | error | The file is larger than `maxBytes`. Nothing was audited; the run is `incomplete`. |
| `file-too-many-lines` | error | The file has more lines than `maxLines`. The rest was not read; the run is `incomplete`. |
| `file-unreadable` | error | The file could not be opened, or is not a regular file. Nothing was audited; the run is `incomplete`. |
| `fragment-only-target` | warning | The target is a `#fragment` of the llms.txt file itself, not a document. |
| `heading-level-unsupported` | warning | An H3 or deeper heading. The convention defines H1 for the name and H2 for sections. |
| `inventory-document-unlisted` | warning | A document in the declared inventory that no entry links to. |
| `inventory-entry-skipped` | warning | An inventory entry was not walked - a symbolic link, an unreadable directory, or something that is not a regular file. The inventory is partial, so the run is `incomplete`. |
| `inventory-too-deep` | error | The inventory tree is deeper than `maxInventoryDepth`. The deeper directories were not inventoried; the run is `incomplete`. |
| `inventory-too-many-files` | error | The inventory holds more documents than `maxInventoryFiles`. The rest were not inventoried; the run is `incomplete`. |
| `inventory-unreadable` | error | The declared inventory root could not be listed. Coverage was not checked; the run is `incomplete`. |
| `list-item-not-a-link` | error | A list item in a link list that holds no `[name](target)` link. |
| `local-target-empty-file` | warning | The target exists inside the root but has zero bytes. |
| `local-target-escapes-root` | error | The target leaves the declared root through a symbolic link. It was refused, and nothing outside the root was read. |
| `local-target-missing` | error | No such file inside the declared root. |
| `local-target-not-file` | error | The target is not a regular file: a directory, to which no index-file convention is applied, or a named pipe, socket or device node, which names nothing a reader can read to the end. |
| `local-target-outside-root` | error | The target resolves outside the declared root by its spelling. It was refused before being opened. |
| `local-target-unreadable` | error | The target could not be resolved - a symlink loop, or a permission failure. It was not checked; the run is `incomplete`. |
| `nothing-checked` | warning | The run examined no link list entries at all. A pass on no evidence is not a pass, so the run is `incomplete`. |
| `optional-section-claims-required` | warning | The `Optional` section is content a consumer may skip, but its text says the content is required. |
| `remote-target-broken` | error | The imported capture records this address as broken. |
| `remote-target-unverified` | warning | A remote address with no usable capture entry. Nothing is fetched, so nothing is known about it and the run is `incomplete`. |
| `section-duplicated` | warning | Two H2 sections share a heading, so a consumer merging by heading loses one. |
| `section-empty` | warning | An H2 section with no link list. |
| `section-heading-empty` | error | An H2 with no text. |
| `section-prose-ignored` | info | Prose inside an H2 section, which a consumer reading only link lists will skip. |
| `summary-missing` | warning | No blockquote summary directly after the H1. |
| `target-duplicated` | warning | Two entries resolve to the same document or the same address. |
| `target-empty` | error | The link has no target. |
| `title-duplicated` | error | A second H1 heading. |
| `title-missing` | error | No H1 heading. |
| `title-not-first` | error | Content appears before the H1. |
| `too-many-links` | error | More list entries than `maxLinks`. The rest were not checked; the run is `incomplete`. |
| `unsafe-target` | error | A `javascript:`, `data:`, `vbscript:`, `file:` or `blob:` target. It cannot name a document and was not resolved. |
| `unsupported-scheme` | info | A scheme such as `mailto:` or `tel:` that is not a document address this tool can check. |

## Limits

Every limit is enforced, overridable from the CLI, and reported when it is reached. Exceeding one
is a named finding and an `incomplete` report, never a silently shorter answer.

| Limit | Flag | Default | Applies to |
| --- | --- | ---: | --- |
| `maxBytes` | `--max-bytes` | 1048576 | the llms.txt file |
| `maxLines` | `--max-lines` | 20000 | lines read from it |
| `maxLinks` | `--max-links` | 2000 | list entries examined |
| `maxInventoryFiles` | `--max-inventory-files` | 5000 | documents inventoried |
| `maxInventoryDepth` | `--max-inventory-depth` | 12 | directory depth below the inventory root |
| `minDescriptionChars` | `--min-description-chars` | 10 | shortest description not reported as uninformative |
| `maxDescriptionChars` | `--max-description-chars` | 200 | longest description accepted without comment |

An unknown limit name, a non-integer or a value below 1 is a configuration error, not a value that
is ignored. So is an unknown CLI option, and so is an unknown key in a capture document: a
one-character typo must not turn a real failure into a green run.

Evidence excerpts are flattened to one line, stripped of control characters, and cut to 160
characters (120 for a `target`).

A capture that cannot be parsed is bounded separately, because an excerpt does not reach it. V8
reports an invalid document two ways, and one of them embeds the input:
`Unexpected token 'A', "AKIAIOSFODNN7EXAMPLE" is not valid JSON` reproduces a short capture in
full, and a longer one through a window around the offence. Cutting from the end cannot help when
the quoted span is at the front. The refusal keeps only the useful half -- the position, line and
column where V8 reports them, and the offending token where it does not -- so the capture nothing
has validated is also the capture that is not repeated back.

## Inventory

`--inventory DIR` names the documentation root the file is supposed to index. It must be inside
the declared root. Files ending `.htm`, `.html`, `.markdown`, `.md`, `.mdx`, `.rst` or `.txt` are
documents; the llms.txt file itself is excluded. Entries whose name begins with `.` are skipped,
as are `.git` and `node_modules` directories.

Symbolic links inside the inventory are never followed. Each one is reported, and because a
skipped entry means the inventory is partial, the run is `incomplete`.

## Imported captures

`--capture FILE` imports what remote addresses served when someone else fetched them. This tool
has no network of its own.

```json
{
  "schemaVersion": "1",
  "capturedAt": "2026-09-01",
  "source": "how this capture was produced",
  "urls": {
    "https://example.com/docs": { "state": "ok", "httpStatus": 200 },
    "https://example.com/gone": { "state": "broken", "httpStatus": 404, "note": "retired" }
  }
}
```

`state` is `ok`, `broken` or `unknown`. Keys are compared as written, after a fragment is removed
from an address that parses as a URL: a trailing slash or a different host case is a different
address, because answering a question about one address with evidence about another is worse than
saying nothing. `capturedAt` is data that is echoed into the summary; no clock is read.

An address with no entry, or one recorded `unknown`, is `remote-target-unverified` and the run is
`incomplete`.

## Report

```json
{
  "schemaVersion": "1",
  "tool": "llms-txt-auditor",
  "status": "pass",
  "advisory": "llms.txt is a publishing convention, not an enforcement mechanism…",
  "summary": { "checked": 4, "errors": 0, "warnings": 0, "info": 0 },
  "findings": []
}
```

`summary.checked` counts the link list entries examined. `status` is `pass`, `fail` or
`incomplete`; `incomplete` wins over both others, because a run that did not read something cannot
report on it. The summary also carries `sections`, `localTargets`, `remoteTargets`,
`otherTargets`, `verified`, `unverified`, `coverageClaims`, `inventoryDocuments`,
`inventoryLinked`, `inventorySkipped`, `captureImported`, `capturedAt` and `inventoryDeclared`.

A finding carries `ruleId`, `severity`, `message`, `location.file`, and where they apply `line`,
`column`, `target`, `evidence` and `suggestion`. `location.file` is relative to the declared root,
never an absolute host path.

## Determinism

Findings are ordered by `location.file`, then `line`, then `column`, then `ruleId`, then `target`,
then the order they were recorded. Every comparison is by UTF-16 code unit — never `localeCompare`,
whose ICU data varies between Node builds. Directory entries are sorted before use, so filesystem
enumeration order never reaches the output. No clock, locale, random source or environment
variable is read. Two runs over the same bytes produce byte-identical stdout.

## Exit codes

| Code | Meaning | stdout |
| ---: | --- | --- |
| 0 | completed, nothing failed | the report |
| 1 | completed, the check failed | the report |
| 2 | evidence missing, bounded out or unverified (`incomplete`) | the report |
| 2 | invalid usage, unknown option, or a malformed capture | **empty** |

A configuration error means the run never had a subject, so there is nothing to report about and
stdout stays empty. An input that could not be read did have a subject, so a report is written
saying which input was not read.
