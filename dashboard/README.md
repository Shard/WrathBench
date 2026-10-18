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

## The map's player

A run the trace recorder drove (`runner/viewer/trace.ts`) is drawn by one
clock-driven player, `src/lib/traceplayer.ts`, the same in the live map and in
a replay: every frame each pip is placed where the trace puts the character at
the playhead, with a heading wedge from its facing and a trail of the last
90 s fading out behind it (flights in `--flight`; a cut ends the trail, so a
hearth jumps cleanly). Both clocks run off `performance.now()` from an anchor
rather than adding up frames, so a tab put away and brought back is where the
time says. A run with no trace — every run before the recorder, and any
moment the trace cannot answer for while a window loads — draws as before:
a live pip walks to its newest reading, a replayed one is time-interpolated
along the 60 s track.

**Live, the playhead is a jitter buffer** a delay `D` behind the feed. `D` is
the expected period between the feed's horizons, plus the most a horizon can
be held up between its render and the tab, plus a margin of a tenth of the
period (2 s at least). Each client states how its feed is made
(`feedCadence`), so the formula is one and the inputs differ:

- the viewer renders on request, so a horizon is as fresh as the 5 s poll and
  at worst one 5 s recorder drain old: about 12 s;
- the public `live.json` lands about every seven minutes, behind a 30 s memo,
  a 30 s edge TTL and a poll: about 9 minutes.

The period is learned from the horizons it sees — the longest of the last four
gaps, an outage ignored. On each arrival the playhead aims at `D` behind; one
within a deadband carries on at 1×, one further behind catches up at 1.5×,
and one more than `D` behind (a waking tab, a publisher back from a stop)
jumps. Between arrivals it never passes the data's end: a pip that catches up
holds there until the next arrival, which resumes it. The public horizon is
the snapshot's `generatedAt`; the private feed carries no clock, so its
horizon is the newest thing in it, never this browser's time.

**A replay plays on the run's own clock** at 1×, 10×, 60× (the default),
600× or 3600×, so a 90-minute run takes 90 s at 60× and a nine-day character
a few minutes at 3600×. A gap of more than 150 s in the track — two missed
state samples, the run not being driven — plays in one second at any speed
that would take longer, which is what kept the old one-sample-per-tick scale
free of dead air. At 60× and below, and whenever paused, the pip and the unit
frame come from the trace's segments near the cursor; faster, from the track.
The span is the track's points and the trace together, and the route is drawn
from the trace's frames wherever a loaded window covers it, so a short run
with one 60 s point still scrubs and draws its path. A run still going has
its newest minutes only in the open tail, which the replay reads from the
run's index (publicly, its position in `live.json`) on the live map's cadence
while there is one.

**The unit frame** reads the trace state at the playhead: health, power,
level and experience (a gauge the trace did not observe stays unobserved
rather than being filled from the 60 s sample beside it, and the health bar
reads dead at a corpse), a cast bar, combat, mounted, flying, resting and
ghost badges, the target's health where it is published, and the buffs row: spell
icons as Wowhead links (`src/lib/wowhead.ts`), stacks, and the time left.

**Money and the inventory** in the sidebar come from the trace's character
sheet at the same playhead as the pip and the unit frame, wherever the trace
answers for it: live, paused, and in a replay at 60× or slower
(`TraceStore.sheetAt`, folded by the codec's `sheetAt`, turned into the
panels' rows by `sheetItems` in `src/lib/inventory.ts`). That puts the public
sidebar in step with the pip, where the position's newest reading ran the
publish delay ahead of it. The sheet's rows are the ones the 60 s reading
carries, worn bags left out as there, plus each item's random property, which
the Wowhead link carries (`itemUrl`), and a worn item's durability, on its
square's tooltip. The sheet names an item by its template, so where the
tooltip script is blocked a suffixed item shows its base name. The same array
comes back while the sheet's lists say the same thing, across a re-polled tail
and a window arriving closed too, and an unchanged row keeps its object, so a
money change or a frame redraws nothing in the bag.

Wherever the sheet cannot say, the sidebar shows the coarse reading instead
(`sheetReading`): faster than 60×, with no trace loaded at the playhead, in a
segment from before the sheet, and while a key is null — not observed, as after
a sandbox restart before the character's own create block, never empty bags.
Live, the feed carries money but no inventory, so a live character the sheet
cannot answer for reads "—"; in a replay, the reading is the track's at or
before the cursor (`itemsAtCursor` in `src/lib/replay.ts`), folded from the track's
patches by the viewer's own codec (`@viewer/track-inv`). It keeps a reading
every 64 patches and hands back the same array while the cursor stays between
two changes, so the bag and the paperdoll redraw only when the inventory
does. A track published before the patches carries each reading whole on its
points, and is read as it is. The quest log, reputation and skills the sheet
also carries have no panel yet.

**Fetching is listed-only.** A segment is requested only for a `t0` a
position's `recent` or a track's `segs` listed — the public edge caches a 404
for a day — and within the data host's rate limit: the live map fetches for
the runs on the continent on screen, the playhead's window and the next one
in its last minute, at most four in flight.

**The units around a live character** draw under the pips on the private
live map (`src/lib/nearbyplayer.ts`, over the viewer's nearby codec): each
run's newest window from `/api/run/<id>/nearby`, sampled at the same playhead
as the pip, so a creature and the character fighting it line up however far
behind the feed the map runs. A unit two characters both see is one guid and
one dot. The colours are packet-field classes, never a reaction looked up in
client data: engaged with the character `--err`, a service NPC `--ok` (with
its `!`/`?` quest mark in `--warn`), another player `--accent`, anything else
`--dim`, the dead a `--dim` ring; the selected character's own target is
ringed, and its name replaces the entry on the unit frame's target bar.
Names show on hover at any zoom the layer draws at and, further in, for every
unit, culled greedily so none overlaps another or a character's puck and name.

The layer draws from about a pixel a yard, and the map asks for windows under
the same gate: on its 5 s poll (and straight away on zooming in), only for runs
the feed flagged `nearby` whose pip is on or near the screen. NPCs nearly
always move, so their motion alone redraws the map at most ten times a second
rather than at frame rate. Past a window's horizon the layer is empty rather
than frozen, bar a second of slack for the two pods' clocks. A replay has no
units: the ring is live only and keeps 15 minutes. The public build asks for
none either; nothing publishes them yet.

## The replay's route

The map's replay draws the route behind the pip in the run's colour, a flight
path in `--flight`, and no line across a teleport or a change of map. Which is
which comes from what the record says happened, not from speed
(`classifySegments` in `src/lib/replay.ts`): a flying character's position was
held at the departure flight master for the whole flight, so its landing is
one jump that looks exactly like a hearthstone by distance, and a release to a
nearby graveyard is slower than a mounted ride. The viewer derives the events
at read time — flight and graveyard milestones, the action log's hearthstone —
into the track's `travel` list, without storing anything new; the moves' typed
`teleported` and `transferred` verdicts and map changes are already on the
track. An implied-speed limit backs them up for jumps nothing explains.

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
error mapping — plus a few focused component checks: the shared chart axis, the
map's play bar across a route swap, the campaigns page across its routes, and
the run page's scratchpad panel against a hostile pad.
Those use the small `happy-dom` harness to mount the components through Vite;
the rest of the suite does not need a DOM.

## Conventions

- Nothing here writes. There is no client method that sends a body, because
  there is no route that takes one.
- Paths are root-relative, so the same code runs behind the dev proxy and
  same-origin off the viewer. That is why there is no CORS configuration.
- Polling intervals are stated at each call site, not hidden in `poll()` —
  docs/PUBLIC-DASHBOARD.md (the snapshot client) names polling rate as a
  public-hosting constraint.
