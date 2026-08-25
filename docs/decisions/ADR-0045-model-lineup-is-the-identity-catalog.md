# ADR-0045: model-lineup.json is the identity catalog; logos come from a pinned icon package

Date: 2026-08-25. Status: accepted.

## Context

`infra/fleet.json` is deliberately a scheduling catalog: every roster field is a
scheduling fact, and presentation has always been absent from its schema. Adding
a cosmetic field there would be the first, and it would have to survive four
parsers kept in deliberate sync (the supervisor's, the viewer's, and the two
`RosterModel` builders).

Meanwhile the dashboard wants model identity everywhere: an icon beside the
roster name on the models page, beside the model cell on the fleet page, in the
results chart's label gutter, and on the map instead of an anonymous colored
pip. The repo had no place that knows "openai/gpt-5.6-luna is a GPT model from
OpenAI" — the only model-name knowledge in code is scheduling classification
(`isClaudeFamily`, the billing suffix rules) and the pricing table's display
ids. Baking vendor knowledge into components would be exactly the per-model
override logic CLAUDE.md forbids.

## Decision

A new committed file, `infra/model-lineup.json`, is the identity catalog. It
defines *families*: `{ id, name, vendor, icon, match }`. Matching is data-driven
and dumb on purpose: lowercase the model id, strip a trailing `:free`, take the
first family whose glob pattern (`*` matches anything) matches. Order in the
file is the precedence. An id no family matches gets a neutral monogram in the
UI — never a special case in code. fleet.json is untouched; the lineup is keyed
by model id patterns, not roster names, so it recognizes ids wherever they
appear (roster, run history, map positions).

Logos are fetched, not drawn: `infra/fetch-model-logos.ts` downloads the npm
tarball of `@lobehub/icons-static-svg` (the lobehub/lobe-icons project, MIT) at
the version pinned in the lineup's `icons` block — from `registry.npmjs.org`
directly, since that host is reachable where CDN mirrors are not — and extracts
exactly the icons the lineup names into
`dashboard/src/assets/model-logos/<family-id>.svg`. The SVGs are committed:
they are a few hundred bytes each, the dashboard builds from a bare clone
without network, and a lineup edit plus one CLI run is the whole update story.
The CLI prunes assets no family references and has a `--check` mode so drift
between lineup and assets is detectable without network.

The dashboard consumes both ends purely: `src/lib/lineup.ts` is the matcher
(tested, no DOM), and a `ModelIcon` component inlines the SVG text so mono
icons (`fill="currentColor"`) follow the theme. The map keeps run-id colors for
trails and falls back to the colored pip when a position's model is unknown.

## Consequences

- Recognizing a new model is a data edit: add or extend a family, run the
  fetch CLI, commit. No code changes, no per-model branches.
- The icon package version is pinned like every other pin; bumping it is a
  deliberate edit to the lineup file.
- Brand logos remain trademarks of their owners; the package license (MIT)
  covers the artwork files' distribution, and THIRD-PARTY-NOTICES.md records
  the provenance. Nothing Blizzard-derived is involved.
- The pricing table's display ids and the scheduler's `isClaudeFamily` stay
  where they are: they are billing and scheduling facts, not presentation, and
  folding them into the lineup would couple scheduling to a cosmetic file.
