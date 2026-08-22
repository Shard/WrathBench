# ADR-0022: Dashboard as a SolidJS SPA over a read-only viewer API

Date: 2026-08-22. Status: accepted.

## Context

The viewer was two hand-written HTML documents held in TypeScript template
strings — a runs/timeline page and a map. That was the right shape when it was
a timeline: no build step, no dependencies, one file to read. It stopped being
the right shape once the fleet became a service (ADR-0020) and the questions
grew: what is every lane doing, which accounts are in use, is the supervisor
still beating, how does one run compare with the four beside it. Each of those
is state that changes on its own, and a string with no component model answers
them by rebuilding the DOM by hand.

The intent is also broader than one operator's laptop. The dashboard is meant to
become a public, read-only status page for the project. That is a different
threat model from a loopback debug view, and it has to be designed for now even
though it is not deployed now.

## Decision

**Split the viewer in two.** The Bun process keeps the parts that need the
filesystem: a read-only JSON API under `/api`, an SSE tail per run, minimap
tiles, and static hosting of the built SPA. All UI moves to `dashboard/`, a Bun
workspace that builds to `dashboard/dist`. Same origin in production, which is
why there is no CORS anywhere; in development Vite proxies `/api` to the viewer.

**SolidJS, and this is a deliberate exception.** CLAUDE.md says Bun built-ins
before dependencies, and that rule stands for the harness. The dashboard is the
one place where the alternative is worse: live fleet state is a dozen
independently-updating values, and hand-rolling a component model and a
reactivity graph in vanilla TypeScript is writing a framework badly rather than
avoiding one. Solid was the operator's explicit choice; the reasons that make it
the cheap exception are that its reactivity is fine-grained (no virtual DOM to
reconcile a canvas against) and its runtime is small enough that the built
bundle is comparable to the string pages it replaces.

**The API is read-only by construction, not by convention.** There is no route
that accepts a body and no client method that sends one. Databases open
readonly. It serves run and fleet metadata: rows, state samples, entry
summaries, positions, lane liveness.

**Secrets are stripped at the boundary.** The `meta` trajectory entry embeds the
whole run config, bearer token included, and the generic summariser copied it
wholesale — so `/api/run/<id>/entries?from=0` and `/raw/0` both served it.
Redaction is keyed on field name at any depth and applied at both places a raw
record can reach a client. `apiKeyEnv` stays: it names an environment variable,
and the value of that variable is never written to the trajectory. Nothing reads
`.env`.

**`WRATHBENCH_VIEWER_PUBLIC=1` withholds the three routes a public deployment
must not carry**: raw entries, scratchpads, and minimap tiles. It is
opt-in-to-public rather than opt-in-to-raw, because the operator's own run page
depends on raw bodies and defaulting them off would break the working view to
protect a deployment that does not exist yet. The flag is the thing a public
deploy sets; the default stays the developer's.

**Polling rate is a constraint, not a mechanism.** Intervals are stated at each
call site (runs 10s, fleet 5s, positions 5s) so they are visible in review. The
live tail is the existing SSE endpoint, which already heartbeats once a second
so a quiet run can be told from a dead connection. No auth and no rate limiter
are added here — a public deployment needs both decided with the hosting, and
guessing at them now would be a mechanism nobody had asked for.

**Migration.** The hand-written pages keep serving, at `/legacy/…` once a build
exists and at `/` when it does not, so a fresh checkout still shows runs with no
build step. They derive their route prefix from the URL, which is what lets one
document work at either path.

## The open legal question

Minimap tiles are Blizzard textures. They are extracted from the operator's own
client into `data/` and are the only Blizzard-derived bytes the viewer serves.
The map must therefore degrade cleanly without them — a missing tile draws as a
labelled grid square, and it always has — and **a public deployment must not
ship them** until `docs/DATA-AND-LEGAL.md` settles it. Public mode withholds
`/tiles` for exactly this reason. The same question hangs over trajectory text:
quest text, NPC and item names are game text, which is why raw entries and
scratchpads are withheld alongside the tiles rather than treated as a separate
concern. Entry summaries still carry model output and snippet text; whether
those are publishable is the same undecided question, and the honest position is
that the first public deployment is gated on that decision, not on this ADR.

## Consequences

- The repository gains a `node_modules` graph it did not have. Contained to one
  workspace: nothing in `sdk/`, `runner/src` or `module/` imports it, and the
  harness still runs with no build step.
- Two modules are shared between viewer and dashboard rather than duplicated —
  `api-types.ts` (the wire shapes) and `worldmap.ts` (the ADR-0019 transform).
  Both are import-free by construction, which is what keeps `bun:sqlite` out of
  a browser bundle. `worldmap.ts` stays standalone; a test pins that.
- The map is now the only renderer of the transform, where before the page
  carried a hand-copied duplicate. ADR-0019's seams survive the port: one
  function fetches the position feed, and no draw path reads run liveness.
- Two ways to run the UI means two ways for it to break. The dev proxy and the
  static host must serve the same paths, which is why every client path is
  root-relative.
