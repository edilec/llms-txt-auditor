# Changelog

All notable changes to this project are documented in this file.

## Unreleased

### Added

- `auditLlmsTxt`, reading a local llms.txt file against the documentation
  inventory it indexes and reporting structure, link targets, descriptions and
  stated coverage with 1-based line and column numbers;
- a deliberate Markdown subset parser for the convention — ATX and setext
  headings, blockquote summary, list items with continuation lines, fenced
  blocks skipped entirely, and an inline link scanner that handles balanced
  parentheses, angle-bracketed destinations and link titles;
- contradictory-scope detection: a summary, a paragraph or an H2 heading that
  states complete coverage is measured against the declared inventory, and a
  claim the link list does not deliver is an error (`coverage-claim-unmet`);
  a claim with no usable inventory is reported unverified and the run is
  `incomplete`, never a pass;
- local target resolution confined to a declared root twice over — on the path
  as written, and again on its real path once every symbolic link has been
  followed — so a link planted inside the root cannot make the tool open an
  out-of-root file or echo its name or content into the report;
- imported address captures, the only way a remote address becomes verified:
  nothing is ever fetched, and an address with no capture entry leaves the run
  `incomplete`;
- one frozen `RULE_SEVERITY` table that every finding's severity comes from,
  with an unknown rule id throwing rather than defaulting, asserted against the
  documented catalog in both directions;
- explicit byte, line, entry, inventory-size and inventory-depth limits whose
  breach is a named finding and an `incomplete` status, never a silent
  truncation; unknown limits, unknown CLI options and unknown capture keys are
  refused rather than ignored;
- a `nothing-checked` guard, so a run that examined no entries can never report
  a pass on no evidence;
- an `advisory` field on every report, stating that llms.txt is a publishing
  convention and compels no crawler, agent or model provider;
- a CLI writing the JSON report to stdout only, diagnostics to stderr, and
  exiting 0 / 1 / 2, with an empty stdout for a configuration error;
- runnable clean and deliberately broken examples;
- the rule catalog, the parsed Markdown subset, the claim vocabulary, the limits
  and the determinism guarantee in `docs/llms-rules.md`.

No release has been published.
