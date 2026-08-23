# ADR-0022: Dashboard as a SolidJS SPA over a read-only viewer API

Status: Accepted. Date: 2026-08-22.

## Context
The viewer was two HTML documents in TypeScript template strings. Right for a
timeline; wrong once the fleet became a service (ADR-0020) and the questions
became live state — every lane, every account, supervisor liveness, run-to-run
comparison — that a string with no component model answers by rebuilding the DOM
by hand. The dashboard is also meant to become a public read-only status page,
a different threat model from a loopback debug view, designed for now even
though not deployed now.

## Decision
- **Split along one line.** The Bun process keeps what needs the filesystem: a
  read-only JSON API, an SSE tail per run, minimap tiles, static hosting of the
  built SPA. All UI lives in `dashboard/`, a Bun workspace. Same origin in
  production, so no CORS anywhere.
- **SolidJS, as a deliberate exception** to "Bun built-ins before dependencies".
  That rule stands for the harness; here the alternative is hand-rolling a
  reactivity graph in vanilla TypeScript, which is writing a framework badly.
  Fine-grained reactivity (no virtual DOM to reconcile a canvas against) and a
  small runtime make it the cheap exception. Contained: nothing in `sdk/`,
  `runner/src` or `module/` imports it; the harness runs with no build step.
- **Read-only by construction, not convention**: no route accepts a body,
  databases open readonly.
- **Secrets stripped at the boundary**: the `meta` entry embeds the run config
  including the bearer token, so redaction is keyed on field name at any depth
  wherever a raw record can reach a client.
- **`WRATHBENCH_VIEWER_PUBLIC=1` withholds raw entries, scratchpads and tiles** —
  the routes carrying verbatim game text or Blizzard bytes. Opt-in-to-public
  rather than opt-in-to-raw, because the operator's own run page depends on raw
  bodies and a deployment that does not exist yet should not break the working
  view. No auth or rate limiter is added: both belong with the hosting decision.
- Two modules are shared rather than copied — the API wire types and the
  ADR-0019 transform — both import-free by construction so `bun:sqlite` stays
  out of a browser bundle.

## The open legal question
Tiles are Blizzard textures and quest/NPC/item text is game text. The map
degrades without tiles, and a public deployment ships none of them until
DATA-AND-LEGAL.md settles it. Entry summaries still carry model output and
snippet text; the first public deployment is gated on that decision, not on
this record.

## Consequences
- The repository gains a `node_modules` graph, contained to one workspace.
- Two ways to run the UI (dev proxy, static host) means every client path is
  root-relative so both serve the same paths.
- The hand-written pages and `/legacy` routes were deleted on 2026-08-22; a
  checkout with no build gets a plain-text notice naming the build command.
