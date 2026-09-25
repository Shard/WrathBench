# Dashboard

The operator SPA over the viewer's read-only API: fleet overview, one page per
run, and the live map. SolidJS + Vite, TypeScript strict, no CSS framework.

Why an SPA and why a dependency at all, and which page owns which grain:
docs/ARCHITECTURE.md (dashboard section). The routes are `src/main.tsx`.

## Running

Two ways, and they must behave the same.

**Development** — Vite serves the SPA and proxies `/api` and `/tiles` to a
viewer you run yourself:

```
bun runner/viewer/serve.ts          # terminal 1: the API, on 127.0.0.1:8090
bun run dashboard:dev               # terminal 2: http://127.0.0.1:5180
```

`WRATHBENCH_VIEWER_ORIGIN` points the proxy somewhere other than 8090 — useful
when the operator's own viewer already owns that port.

**Production** — build once, and the viewer hosts the result itself:

```
bun run dashboard:build             # writes dashboard/dist
bun runner/viewer/serve.ts          # http://127.0.0.1:8090
```

The viewer serves `dashboard/dist` when it exists. When it does not there is no
UI at all, so a checkout that wants the dashboard has to build it.
`WRATHBENCH_DASHBOARD_DIR` overrides where the viewer looks.

**Public** — the same SPA, reading published JSON snapshots out of a bucket
instead of a viewer (docs/PUBLIC-DASHBOARD.md). One build-time flag selects it:

```
VITE_WRATHBENCH_SNAPSHOT_BASE=https://wrathbench-data.shard.page bun run dashboard:build
```

Minimap tiles are a separate flag, `VITE_WRATHBENCH_TILES_BASE`, and separate
on purpose (`src/lib/tiles.ts`): they land in the bucket by a hand-run
`infra/publish-tiles.ts --upload` and never by a snapshot pass, so deriving the
one flag from the other would have a JSON publish assert that tiles are there.
The public site sets it to the data hostname. Unset, the map requests no tile
and draws its labelled grid — the same thing the viewer does under
`WRATHBENCH_VIEWER_PUBLIC=1`, and the right build from a checkout that never ran
the extraction. The private build sets neither flag and serves tiles same-origin
as always.

The other build-time flags are `VITE_WRATHBENCH_PUBLIC_ORIGIN` and
`VITE_WRATHBENCH_OG_STAMP` (the social card's tags, docs/PUBLIC-DASHBOARD.md)
and `VITE_WRATHBENCH_REPO_URL` — where the source lives. Unset or empty, which
is the default in both builds, no repository link is rendered at all: a link
that 404s is worse than none. `infra/deploy-dashboard.sh` passes it through from
`WRATHBENCH_REPO_URL` in `.env`, and empty is not an error there the way an
empty origin is (no origin means a broken card, no repo URL just means no link),
so turning the link on is one env line and a redeploy (`src/lib/repo.ts`). The
value is validated as an http(s) URL, so a stray setting cannot put an
arbitrary scheme in an anchor.

Set, `src/api/client.ts` hands the pages `createSnapshotClient` instead of
`createClient`; unset, nothing about the private build changes. The snapshot
client implements the same `Client` interface, so no page knows which one it is
talking to. Every page keeps the poll interval stated at its call site; a memo
inside the client is what keeps a fast poller off the network.

## The ladder's derivations

The scored ladder's row ordering — highest rung, then the `(level, xp)` pair,
then gold; missing readings sort last, never as zero — is one derivation over
recorded signals (docs/METHODOLOGY.md, "Scoring"), versioned with the
dashboard in `src/lib/ladder.ts`: three separate numbers, no aggregate score.

The freeplay ladder is an overview of the top characters on freeplay at the
current time, not a leaderboard (operator, 2026-08-29). It shows the whole
active field — every freeplay run not deleted and not tainted, including
paused and disabled characters and runs in progress — so the scored surfaces'
"is this evidence" predicate is deliberately not what filters it; a launch
that produced nothing is dropped and a run's state is a column rather than an
exclusion. One row is one character across attempts: the latest attempt
carries the character's current level and state and the lineage rides with
it, so the same character never appears twice. The reader's own filters apply
as on the scored tiers, "exclude free" included (operator, 2026-08-29,
reversing an exemption made the same day): same control, same default-on, same
predicate, over both the table and the graph. The one exemption that stands is
the harness series, because a character is durable across series and cutting
its older attempts would report a long-lived character as attempt 1.

## Structure

```
src/api/      typed client over the viewer JSON endpoints, the SSE tail, and
              the snapshot client the public build reads a bucket with
src/lib/      pure helpers: view maths, formatting, polling
src/pages/    one file per route
src/components/  the shell and the pieces shared between pages
```

What both sides need is imported from the viewer rather than copied, under
the `@viewer/*` alias. The viewer imports the same files, so a drift between
what it serves and what this expects is a compile error rather than a runtime
surprise, and nothing server-side may follow them into the browser bundle.

## Tests

`bun test` from the repo root runs them with everything else. They cover the
pure layer — view maths and pip placement, the API client's paths, encoding and
error mapping — plus a focused shared-axis component regression. That regression
uses the small `happy-dom` harness to mount the Solid `<For>` loops and update
retained SVG ticks in place; the rest of the suite does not need a DOM.

## Conventions

- Nothing here writes. There is no client method that sends a body, because
  there is no route that takes one.
- Paths are root-relative, so the same code runs behind the dev proxy and
  same-origin off the viewer. That is why there is no CORS configuration.
- Polling intervals are stated at each call site, not hidden in `poll()` —
  docs/PUBLIC-DASHBOARD.md (the snapshot client) names polling rate as a
  public-hosting constraint.
