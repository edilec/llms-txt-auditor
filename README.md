# llms-txt-auditor

Audit a local `llms.txt` file and the documentation inventory it indexes: structure, link targets,
descriptions and stated coverage, with a 1-based line number on every diagnostic.

- **Repository:** [edilec/llms-txt-auditor](https://github.com/edilec/llms-txt-auditor)
- **Area:** SEO & Search
- **License:** MIT

`llms.txt` is a Markdown convention: an H1 name, an optional blockquote summary, prose, then H2
sections of link lists with optional descriptions. This tool reads that shape, resolves the local
targets inside a declared root, and compares what the file *claims* to cover with what is actually
on disk.

**It is a convention, not an enforcement mechanism.** Publishing the file does not compel any
crawler, agent or model provider to read it, honour it, or stay away from anything. This tool
reports on a file and on documents; it can tell you nothing about what any consumer did. Every
report it writes carries that sentence in its `advisory` field.

## Install

Node 22 or newer. No runtime dependencies, no dev dependencies, nothing to install.

```
node bin/llms-txt-auditor.mjs --help
```

## Usage

```
llms-txt-auditor --file FILE [--root DIR] [--inventory DIR] [--capture FILE] [--json] [limits]
```

| Option | Meaning |
| --- | --- |
| `--file FILE` | the llms.txt file to audit (required) |
| `--root DIR` | declared root every local target must stay inside; defaults to the directory holding `--file` |
| `--inventory DIR` | documentation root the file is meant to index; without it, a coverage claim cannot be checked |
| `--capture FILE` | imported record of what remote addresses served |
| `--json` | suppress the human summary on stderr |

Limits: `--max-bytes`, `--max-lines`, `--max-links`, `--max-inventory-files`,
`--max-inventory-depth`, `--min-description-chars`, `--max-description-chars`. Each is enforced,
and exceeding one is a named finding and an `incomplete` report — never a shorter answer with no
explanation. An unknown option, an unknown limit or an unknown key in a capture document is a
configuration error, because a one-character typo must not turn a real failure into a green run.

Run the shipped examples:

```
node bin/llms-txt-auditor.mjs --file examples/clean/llms.txt \
  --inventory examples/clean/docs --capture examples/clean/capture.json   # exit 0

node bin/llms-txt-auditor.mjs --file examples/broken/llms.txt \
  --inventory examples/broken/docs --capture examples/broken/capture.json # exit 1
```

The broken example reports, among others, a misspelled local target, an entry pointing at a
directory, a target that resolves outside the declared root, a `javascript:` target, and a section
that says "Every page of the handbook is listed here" while three inventoried documents are not in
its list.

## Output

stdout carries the JSON report and nothing else, so it can be piped into a parser. stderr carries
the human summary and any diagnostics.

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

| Exit | Meaning | stdout |
| ---: | --- | --- |
| 0 | completed, nothing failed | the report |
| 1 | completed, the check failed | the report |
| 2 | evidence missing, bounded out or unverified (`incomplete`) | the report |
| 2 | invalid usage, unknown option, or a malformed capture | empty |

A configuration error means the run never had a subject, so nothing is written to stdout. An input
that could not be read *did* have a subject, so a report is written saying which input was not
read. Nothing unread is ever reported as a pass.

The rule catalog, the parsed Markdown subset, the claim vocabulary, the limits and the determinism
guarantee are in [`docs/llms-rules.md`](./docs/llms-rules.md).

## Limits and non-goals

What this tool **cannot** conclude, stated plainly so a green run is not read as more than it is:

- **Nothing about crawler or model behaviour.** It cannot tell you whether anything fetched the
  file, honoured it, ignored it, or trained on the documents it names. No file at a URL can compel
  that, and no local audit can observe it.
- **Nothing about remote addresses.** There is no network here. An `https://` entry is *unverified*
  unless an imported capture records what it served, and an unverified run is `incomplete`, not a
  pass. A capture is a record of some past fetch by someone else; it is not evidence about now.
- **Nothing about whether a document is any good.** It checks that a target exists, is a regular
  file, and is not empty. It does not read the document, check its headings, follow anchors inside it, or
  judge whether the description is true.
- **Coverage claims are detected lexically.** A sentence counts as a completeness claim when it
  carries both a completeness word and a listing word from a fixed vocabulary (documented in
  `docs/llms-rules.md`). A claim phrased in other words is not detected, and a sentence that
  happens to use both kinds of word is detected whether or not its author meant a claim. A clean
  run means no *detected* claim was unmet.
- **A claim is measured against the whole declared inventory.** A section that covers only part of
  a tree needs a narrower `--inventory`; otherwise its claim is judged against everything.
- **The inventory is a directory listing, not a site.** It is what the declared root holds, filtered
  by file extension. Documents published from elsewhere, generated at build time, or excluded by a
  site generator are invisible to it.
- **The Markdown subset is deliberate.** Reference-style links, HTML blocks and tables are not
  parsed. A list item that holds no inline link is reported as such rather than interpreted.
- **A symbolic link is never followed out of the declared root**, and an entry inside the inventory
  that is not walked leaves the run `incomplete`. Confinement is a refusal, not a best effort.
- **`pass` with `checked: 0` is not a thing.** A run that examined no entries reports
  `nothing-checked` and is `incomplete`: green on no evidence is a defect, not a clean bill.

## Development

```
npm run check     # lint, tests, the clean example, and a packaging dry run
npm test          # node --test
npm run example   # the clean example, exit 0
```

Node built-ins only: no runtime dependencies and no dev dependencies. Tests cover the public API
and the real CLI, including root confinement against planted symbolic links, every path that can
leave a run `incomplete`, every rule in the catalog firing at least once, and byte-identical
output across two runs.

## License

MIT. See [LICENSE](./LICENSE).
