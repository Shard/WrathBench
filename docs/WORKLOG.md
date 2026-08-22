# Worklog

Dated records of investigations and fixes that graduated out of docs/FOLLOW-UPS.md.
The trajectory data and the commits are the primary sources; this is the narrative
index — what was wrong, why, and what shipped. Reverse chronological.

## 2026-08-22

### The release-point dashboard: comparability, turns-to-level, ladder, replay

Track C. The eval charts' integrity claim is that two rows beside each other
were given the same thing, and nothing recorded what that was: `git describe`
does not distinguish an effort level, a tool-call ceiling, a disabled watchdog,
an operator objective, or the claude CLI's own context engine. ADR-0026 names
the tuple, stamps it into meta.json at launch, and refuses to recompute it for
older runs — an absent tuple reads "not recorded", because a prompt hash taken
against today's prompt would assert a comparability that was never established.
A resume re-stamps, since `--resume` can tighten the leash and a launch-time
budget would then describe a run that no longer exists.

The prompt hash is of the *rendered* prompt. With no objective that equals the
fixed prompt's hash by construction (ADR-0024 renders both drivers through one
function), so every scored run shares one hash and a steered run visibly does
not.

Turns-to-level needed a turn index, which state rows did not have: a `turn`
column, additive like `money` before it, stamped by the driver rather than
counted by the sampler — the fixed loop and the claude driver own different
counters, and one claude turn has held 168 tool calls. That last fact is why
the charts exclude the claude driver whether or not the shakeout stamp is
there: its turns and the fixed loop's turns are different units. Because samples
are taken every 60s and not once per turn, every surface says "first
observation" rather than implying a precision the sampling does not have. Time
is active time, integrated over the same segments the run page's playtime comes
from, so a run that sat quota-exhausted is not charged for it.

The ladder derives five of eight rungs and prints the rule beside each one.
Rungs 2, 4 and 6 read "not instrumented" rather than being approximated by a
level threshold: zone changes, taxi use and group joins are none of them
recorded, and inventing a proxy would be the one failure mode a public ladder
cannot recover from. Map replay turned out to cost almost nothing, which is
ADR-0019 paying off: the renderer already consumed a position feed, so replay
is a cursor over a recorded track producing the same shape, not a second
renderer.

Not done: per-run server build (which worldserver a trajectory ran against),
which wants the runner to log `/health`'s build and would then join the tuple.

**Per-run server build shipped separately (FOLLOW-UPS 42).** `run.ts` now
fetches the module's `/health` at launch and at every resume-restamp and
stamps `comparability.serverBuild: { build, startedAtMs } | null` — null,
never blocking, when the module is unreachable. The run page's comparability
panel shows it, and the footer's "not necessarily the build this run drove"
hedge now applies only to a run that predates the field; a run with its own
recorded build states it as fact instead of guessing off the viewer's live
`/health` poll. `/api/eval`'s grouping key picked up server build alongside
model, harness version and effort, since it is pinned and changed
deliberately the same way the harness version is.

### The deploy script reported "DEPLOYED and verified" having smoked nothing

The first real use of `infra/deploy-worldserver.sh` printed
`DEPLOYED and verified` and exited 0 without executing a single smoke, in a
window where the fleet service was stopped and there were zero live runs.
Three independent defects lined up, and each is worth remembering separately.

**A number arrived wearing colour.** The preflight timeout was read with
`bun -e 'console.log(Math.ceil(...))'`. Bun colourises *inspected values* —
`console.log` of a number, not of a string — and it does so into a pipe when
`FORCE_COLOR` is set, which the operator's shell exports. So bash got
`ESC[0mESC[33m900ESC[0m` where it wanted `900`, and both `$(( ))` deadlines
died with `arithmetic syntax error`. The sibling reads survived only because
they happened to log strings. Machine-read helpers now run under
`NO_COLOR=1 FORCE_COLOR=0 TERM=dumb`, write with `process.stdout.write` rather
than `console.log`, get piped through an ANSI strip anyway, and every numeric
is regex-validated before it reaches arithmetic — one bun call now emits the
whole preflight block as `KEY<TAB>VALUE`.

**`set -e` does not cover an arithmetic assignment.** `x=$(( bad ))` fails,
prints its error, and neither exits under `errexit` nor fires an `ERR` trap: to
bash it is an assignment, not a failed command. That is how a script with
`set -euo pipefail` at the top walked past two hard errors into its success
line. The general lesson is that `set -e` is a backstop, never the mechanism:
verification now hangs off an explicit `VERIFIED_BY` string that only an
actually-executed, zero-exit step sets, the success line is unreachable without
it, and an `ERR` trap installed after the promote rolls back on anything
unexpected. (`set +e` does not silence an `ERR` trap either — only a tested
command is exempt, so the smokes and the gate check are `if cmd; then` now.)
Each smoke logs its name, duration and exit code, so "no smoke was executed" is
visible in the transcript rather than inferred from its absence.

**A stopped supervisor still had a fresh heartbeat.** `fleet_alive()` asked only
whether `fleet-state.json`'s heartbeat was under three minutes old, so a fleet
stopped seconds earlier read as "up and gating" and the script settled in to
wait for a gate result nobody would ever write. Liveness from the host now
requires the container to be running (`docker compose ps --status running
fleet`) *and* the heartbeat to be fresh, and the log line names both.

Shipped alongside: `--dry-run` (resolved values and the verification path it
would take, executing nothing) and `infra/deploy-worldserver.test.ts`, which
runs the real script against a `docker` PATH shim under `FORCE_COLOR=3` and
pins the properties that failed — a failing smoke rolls back and exits
non-zero, a failing gate record rolls back, and no path prints "verified"
without a step that ran.

Lesson: a verification step that reports success by falling off the end of the
script is not a verification step. It has to name what verified it.

### Objective and watchdog overrides become run dimensions (ADR-0024)

The operator wants a long, unscored navigation probe: sonnet on the
subscription driver, a multi-hour episode, and an explicit travel objective, to
find out whether the navigation surface is usable unprompted. That needs two
things the harness did not have, and both had to be built so they could never
become per-model prompts or per-model tuning.

`objective` is now an optional run config value (`--objective`, roster entry
field, fleet lane default), recorded in meta.json, the `run` row and the
trajectory, and rendered into the fixed system prompt between the standing goal
and the runtime description as a delimited `--- Operator objective for this run
---` block that says in the prompt itself that it adds to the goal rather than
replacing it. The prompt is now the join of two constants with the block
between them, so a run with no objective is byte-identical to what shipped
before by construction rather than by test; a test asserts the claude CLI's
`--system-prompt` value equals the fixed loop's system message for the same
objective, across different models and effort levels. A run that carries an
objective is stamped `unscored (operator objective)` in the same `shakeout`
field the external-scaffold drivers use, stacking behind the driver's own
stamp, and the viewer's `/api/runs` row and the dashboard now carry it.

Watchdog thresholds gained per-entry and per-lane overrides, validated with the
one zod schema in `runner/src/config.ts` that roster, fleet and runner all
import. `null` — or `0`, the only spelling argv can carry — disables a watchdog,
which meant fixing the semantics as well as the schema: `check()` now guards on
`!== null` per threshold, because a zero left as a zero trips on the first check
instead of disabling. Overrides ride argv as `--watchdogs-json`, which is the
only flag that can carry a null; `--episode-ms` still carries a numeric wall
clock and `watchdogs.episodeMs` wins over an entry's `episodeMs` when both are
set.

The lane shipped armed-off as `nav-probe`: account SHAKEOUT (shared with
sub-sonnet, which is why they are alternatives — only one may be enabled),
loop:false so an enable buys exactly one episode, Dwarf Paladin as sub-sonnet
runs, 6h wall clock, `no-xp` disabled because travel earns nothing for hours,
20m idle. Its `maxToolCalls` is raised to 2500 from the 500 default: the claude
driver has been observed at ~4 tool calls a minute, so the default would have
ended the probe as `tool-call-limit` about two hours in and the trajectory would
have read like a harness fault. Roster entries and lanes can set it now.


### `/health` names its build (FOLLOW-UPS 41)

The fleet gate had to infer server identity from a log file's birth time because
the module could not say which build it was. Now it can: `/health` carries
`build` (the repo's `git describe`, passed in as the `WRATHBENCH_BUILD` docker
build-arg by `infra/build-worldserver.sh` and compiled into `WbManager.cpp` via
`module/mod-wrathbench.cmake`, scoped to that one translation unit so the
ccache survives a new stamp), `startedAtMs` and `uptimeMs` — to every caller,
since it is ops identity rather than game state. `run-fleet` keys the gate on
`build@startedAtMs` when present and falls back to the boot marker + health
digest otherwise, so the currently deployed (unstamped) server keeps gating
through the deploy; the gate record and `--status` carry `build`, and the
viewer's `/api/info` reports `worldserver: {build, startedAtMs}` (null when the
module is unreachable — on the host, the normal state until the port or
`WRATHBENCH_MODULE_URL` is arranged; item 42). Built to
`wrathbench/worldserver:next`, define verified in the binary; deploy pending
the next drain window.

### The deploy-window smoke becomes a fleet gate (ADR-0023)

Deploying a worldserver was a manual checklist ending in "run a smoke if you
remember". A server that boots and answers `/health` can still fail to drive a
quest arc — a dropped action, a stale map volume — and the discoverer was
otherwise a model, hours later, in an unwatched trajectory; every episode
launched in between is spent. The second, untyped trigger is worse:
`restart: unless-stopped` brings a crashed worldserver back on its own and the
fleet spawns straight into it.

The smoke moved into the supervisor. `infra/fleet.json` grows a hot-reloaded
top-level `preflight` block (`enabled`, `account`, `smokes`, `timeoutMs`); the
supervisor runs those scripts before it spawns any lane and again whenever the
server identity changes, records `{at, serverIdentity, ok, results}` in
`fleet-state.json`, and only then spawns. A failure blocks spawning, complains
once per identity, and is re-checked every tick, so a fix or a rollback unblocks
the fleet with no operator action; only `start` is suppressed, so an operator can
still drain a lane during a bad deploy.

Server identity had no honest source: `/health` serves non-loopback callers
liveness only (no build id, no uptime) and the supervisor is a container with no
docker socket. It is taken instead from what the two containers share — the logs
volume, where each boot creates a fresh `Server.log` — plus a digest of
`/health`'s stable fields. That is weaker than an image id and is allowed to be,
because nothing keys on the string: `infra/deploy-worldserver.sh` keys on the
gate result's *timestamp*, so a marker that fails to change can only cost an
extra smoke run, never greenlight an unsmoked server. An unreadable log volume
yields a marker that changes every ten minutes on its own — fail toward
re-smoking, never toward a frozen "already smoked".

`infra/deploy-worldserver.sh` replaces the manual sequence: refuse while any
episode is live (`run-fleet --live-runs`, exit code carries it), `:latest` ->
`:prev`, `:next` -> `:latest`, recreate `--no-deps`, wait for health, wait for
the supervisor's gate result on the new server (falling through to smoking
directly when the supervisor predates the gate or preflight is off), roll back to
`:prev` on failure.

Shipped armed-off. The gate needs its own account — a smoke holds a live session
for its whole arc, so sharing one with a lane means mutual reclaims, and
`parseFleet` refuses that config — and `SMOKE` needs a one-time `bootstrap` run
plus a worldserver recreate to enter `AC_WRATH_BENCH_ACCOUNTS`. `PROBE` was
explicitly not reused: an armed gate that fights an operator's live probe is
worse than no gate.

### Dashboard: the viewer splits into a read-only API and a SolidJS SPA (ADR-0022)

The viewer's two hand-written HTML pages had reached the end of what a template
string can carry. The features wanted next are a fleet overview and live state
across lanes — a dozen values that update independently — which is a component
model and a reactivity graph, not more string concatenation. The UI moved to
`dashboard/`, a Bun workspace on SolidJS + Vite; the Bun process kept everything
that touches the filesystem and became a read-only JSON API plus the static host
for the built SPA. The dependency is a deliberate exception to "Bun built-ins
before dependencies" and ADR-0022 says why.

Two leaks turned up on the way and are the substantive fix in this change. The
`meta` trajectory entry embeds the whole run config, module bearer token
included, and the generic summariser copied it wholesale — so
`/api/run/<id>/entries?from=0` served the token, and `/raw/0` served it verbatim.
Both are now redacted by field name at any depth. The token is loopback-scoped
and happens to equal the run id today, so nothing was compromised; what makes it
worth recording is that the test written first — "no field called token" — would
have passed while the value sat nested inside `config_json`. The test asserts on
the *value* against every route instead.

`WRATHBENCH_VIEWER_PUBLIC=1` withholds the three routes carrying verbatim game
text or Blizzard-derived bytes: raw entries, scratchpads, minimap tiles. It is
opt-in-to-public rather than opt-in-to-raw, because the run page depends on raw
bodies — defaulting them off would have broken the working view to protect a
deployment that does not exist yet.

Parity is close but not complete: the cost estimate, the whole-feed expand
preset, and distinct styling for state samples and harness notices did not port,
each for a reason recorded in FOLLOW-UPS 32. The old pages keep serving at
`/legacy/…` so the two can be compared on real runs, and FOLLOW-UPS 34 deletes
them after a week. Deleting them also removes the last hand-copied duplicate of
the ADR-0019 coordinate transform — the SPA imports `worldmap.ts` directly,
which the string pages could not.

### Reference bundle rebuilt to schema 3; run.ts stops bypassing openBundle (FOLLOW-UPS 30) — SWAPPED

`run.ts` and `mcp.ts` each opened `data/wiki/bundle.sqlite` with a bare
`new Database(path, { readonly: true })`, which walks straight past
`openBundle`'s schema check. Nothing crashed — `searchReference` treats a
missing `page_coords` as "no coords" — so the deployed schema-1 bundle (built
2026-08-21, no `page_coords`, no `page_ids`) silently served every episode since
the coordinate channel shipped without a coordinate and without an id index,
and no trajectory said so. Availability was never a code problem: the guard is
what makes the staleness *loud*, the rebuild is what makes the channels real.

- Both entry points now go through `runner/src/wiki.ts`'s `openWikiBundle`, one
  seam with two deliberate outcomes: an absent file is `undefined` (a run with
  no reference is a supported configuration, `search_reference` says so), a
  present-but-too-old file throws, naming `page_coords`, the build-beside
  command and the swap. `runner/test/wiki.test.ts` pins all three.
- A schema-3 bundle is built and verified at `data/wiki/bundle.next.sqlite`
  (43s, 22.20 GiB of XML, 114494 pages kept, 14386 coord rows, 84262 id rows).
  It was swapped in 2026-08-22 ~21:56–22:00 local: the live bundle is now
  schema 3, rebuilt with the id-kind fix.

**Swap** (deploy window, same filesystem so the rename is atomic; an in-flight
episode holds an fd on the old inode and is unaffected — only newly launched
episodes see schema 3):

```
cd data/wiki \
  && ln bundle.sqlite bundle.sqlite.bak-$(date +%Y%m%d-%H%M) \
  && mv -f bundle.next.sqlite bundle.sqlite
```

The swap was **blocking**, not optional: the fleet bind-mounts the repo, so the
fail-closed guard was live the moment the edit landed, and until the rename every
newly launched episode exited at startup instead of running coordless. The guard
sits ahead of the run directory, the trajectory and the session on purpose, so
there is no run.sqlite and `run-roster`'s `classify` calls it `launch-failed`:
the spec is finished with, not retried, and no account is burned. One such exit
per spec per roster cycle until the rename.

Known residual, tracked as FOLLOW-UPS 31: nested templates defeat `extractIds`'
nearest-preceding-opening heuristic, so a quest page can state its own id under
kind `npc`. It costs a ranking preference, not the match, and the next rebuild
is another `mv` — no second drain.

### Questgiver markers and quest objectives (FOLLOW-UPS 27, 28) — deployed

Both items from the five-trajectory review, built and unit-tested but **not yet
live**: the module half is in the `wrathbench/worldserver:next` image only, and
the running worldserver answers the new actions with `400 unsupported_action`
(which the SDK swallows, so current runs are unaffected — `questGiver` and
`objectives` just stay `undefined` until the deploy).

- **Module** (`a4ed1a3`): `quest_query`, `questgiver_status_query`,
  `questgiver_status_multiple_query` on `POST /action`, one client opcode each;
  `SMSG_QUESTGIVER_STATUS_MULTIPLE` and `SMSG_QUEST_QUERY_RESPONSE` tapped and
  decoded (field order from `PlayerMenu::SendQuestQueryResponse`, cited in
  PROTOCOL.md; reward fields consumed, not served).
- **SDK** (`756eb83`): `state.units()` rows carry `questGiver` (named
  `DIALOG_STATUS_*`: `available`, `reward`, `incomplete`, `none`, …) plus the raw
  byte; `units({ questGiver: "reward" })` and `closest({ questGiver })` filter on
  it; `state.quest(id)` carries `title` and `objectives: [{ kind, entry, text,
  required, have, done }]` from the template in `state.quests` joined with the
  log counters / backpack stacks. The client sends the queries a real client
  sends unprompted (ADR-0021), and the turn-in / quest-list silences now say
  "this NPC's questgiver status is `available`, not `reward` — it is not quest
  N's ender". Raw `questQuery` / `questGiverStatusQuery` exist for a refresh on
  demand. Tests: sdk 274 (was 254), repo 733 minus the wiki track's in-flight
  failures.

**Deploy window** (docs/OPERATIONS.md "Deploy window"; zero live runs first):

```
# 0. drain: set every lane in infra/fleet.json to "enabled": false, wait for
#    ./infra/run-fleet.sh --status to show no live run (or `stop fleet`)
# 1. confirm the candidate image is the one built from a4ed1a3 or later
docker images wrathbench/worldserver          # :next newer than :latest
# 2. promote and recreate only the worldserver
docker tag wrathbench/worldserver:latest wrathbench/worldserver:prev
docker tag wrathbench/worldserver:next wrathbench/worldserver:latest
docker compose -f infra/compose.yml up -d --no-deps worldserver
# 3. wait for the world to come up (health + Server.log), then smoke
docker compose -f infra/compose.yml exec runner bun infra/smoke/quest-status.ts
docker compose -f infra/compose.yml exec runner bun infra/smoke/module-quest.ts   # regression
# 4. re-enable the lanes (or `up -d --no-deps fleet`)
```

**Deployed 2026-08-22** (`:next` retagged `:latest`, `:prev` is the rollback).
`module-quest.ts` passed; `quest-status.ts` first failed on its own wrong
assumption — the core's unprompted login-time `SMSG_QUESTGIVER_STATUS_MULTIPLE`
is *empty* (sent before the visibility container is populated, although the
create blocks precede it on the stream; verified live on PROBE). A
`questgiver_status_multiple_query` sent once Willem is in view returns every
questgiver with the right status, and the per-guid answer agrees, so the module
decode is correct and no rebuild was needed; the smoke now queries after Willem
is in view, and the SDK's initial-view markers come from its per-guid spawn
queries (comment corrected, behaviour unchanged). Re-run: PASS end to end.

`quest-status.ts` asserts: after Willem is in view, `questgiver_status_multiple_query` names
Deputy Willem with an available status; `questgiver_status_query` for his guid
returns the same status as `SMSG_QUESTGIVER_STATUS`; `quest_query 783` decodes a
title and four zeroed npc-or-go slots; `quest_query 7` decodes
`requiredNpcOrGo[0] = { entry 6, count 8 }`; `quest_query` without `questId` is
`400 missing_quest_id`; after accepting 783, `questgiver_status_multiple_query`
shows Willem no longer available; then session delete + character delete. If it
fails, `docker tag wrathbench/worldserver:prev wrathbench/worldserver:latest`
and recreate again. Also watch the first live episode's action audit for the
auto-query volume (one `questgiver_status_query` per questgiver entering view,
one `questgiver_status_multiple_query` per quest-log change).

### `search_reference`: banded ranking, an id channel, and a repeat memo (FOLLOW-UPS 25)

laguna issued 11 searches and nemotron 13 near-identical ones inside one episode,
and the top hits were pages whose only connection to the query was digits in
prose. Two causes, both harness-side, both fixed.

- **Ranking is banded now, and bm25 only decides inside a band**: exact title,
  entity id, title tokens, body. bm25 with the title column weighted was not
  enough — a page mentioning an entity thirty times outranks the page named for
  it, and a damage-comparison page whose arithmetic contained "783" outranked the
  quest page the model was after. The full-text candidate set is fetched far wider than
  `limit` before banding, because a title match twentieth by bm25 has to be in the
  candidate set to be promoted at all; a band sort over the old narrow fetch would
  have passed every unit test and changed nothing on the real bundle.
- **An id query is answered only from id-shaped fields.** `parseIdQuery` treats a
  numeric token as an id when it is the whole query, when an id word precedes it
  (`quest 783`, `npc entry 197`), or when the number opens the query and an id
  word follows (`721 npc entry Northshire`) — the id word is consumed with it,
  since leaving "quest" in the text query matches every quest page. `level 5
  quests` is deliberately untouched. The id is looked up in the new `page_ids`
  table (bundle schema 3), which `extractIds` lifts off the raw wikitext before
  the strip, exactly as coords are: `{{questbox|…|id=…}}`, `{{npcbox|…|id=…}}`,
  `|itemid=`, `|questid=`, `|entry=`, tagged with the kind the enclosing template
  implies. Verified against the real dump (a 4000-page probe build yields 1014 id
  rows: 415 npc, 276 item, 242 unknown, 81 quest), not just synthetic fixtures.
  An id token never reaches the text index, so prose can no longer answer an id
  question — and where the bundle has no id table, the tool says the bundle has
  no id index rather than letting "no results" read as "no such quest".
- **Repetition is visible.** A repeated query (normalized for case, punctuation
  and whitespace) comes back prefixed with one line: how many tool calls ago it
  was asked, how many times this episode, and whether the top titles are the same
  or changed. Across the run corpus 44 of 542 searches were exact normalized
  repeats. The state is a `WeakMap` keyed on the `ToolContext`, which every driver
  constructs once per episode, so it lives exactly as long as the episode, never
  touches disk, and needed no change in `loop.ts` or `adapter-claude.ts`.

Measured against the real bundle (top-3 titles, before → after): `"A Threat Within
quest 783"` led with a damage-comparison page and now leads with the quest page;
`"entry 721 Northshire"` and `"Northshire Valley NPC entry 299 69"` now lead with
the zone page instead of a room article; `"creature entry 721"` and `"npc entry
883"` return nothing plus the no-id-index note instead of three unrelated pages.
Those last two stop returning unrelated pages today and will resolve to the entity
page once the bundle is rebuilt *and* the page states that id — the wiki does not
state one for every entity (415 npc ids across 3297 pages in the probe build), and
the tool result says so rather than letting an unrecorded id read as "no such NPC".
The deployed bundle is still schema 1, which is FOLLOW-UPS 30 and the reason the
coordinate channel has been silently empty since it shipped.

### Ergonomics pass on five roster trajectories: closest filters, measured silences, shape docs

A review of five 2026-08-22 episodes (hy3, nemotron, laguna, ox-alpha, qwen)
against the shipped surface. Every item below is a place where the harness knew
the answer and did not say it; none of them widens a contract, and none is
model-specific (ADR-0004).

- **`state.closest()` took only a predicate** (`30c826a`). Four of the five
  models called `state.closest({entry: 196})` or `{name: "Deputy Willem"}` by
  analogy with `state.units(filter)`, and got a bare V8 `TypeError: filter is
  not a function` — hy3 burned 10 turns plus a 15-turn detour, nemotron hit it
  7 times, laguna 4, ox-alpha 1. The analogy was right, so `closest` now takes a
  criteria object too, routed through `units()`'s own `normalizeUnitFilter` and
  a shared `passesUnitFilter`, which means a bad key gets the same actionable
  rejection `units()` gives (ADR-0016) and the two definitions cannot drift.
  Ordering stays by distance: `units()`'s name-tier ranking is deliberately not
  inherited, because "nearest" is the whole question `closest` answers.
- **Questgiver silence now carries the distance** (`5666f27`). The core answers
  nothing when the NPC is out of range, is the wrong NPC, or has nothing to
  give; the old message listed all three as equally likely. Range is the one the
  client can rule out locally, and in *every* observed case it was not the cause
  — laguna spent turns 103-238 standing 0.1y from the giver of quest 783, whose
  ender is McBride; ox-alpha lost 8-10 turns, nemotron 10, qwen 5. The message
  now quotes `distance: 0.8y` from the state cache, and when that is inside
  interact range it says range is *not* the cause, names what is left, and points
  at `search_reference` for the quest's ender. The number is also set on the
  `EventTimeoutError` so a snippet can branch without parsing prose.
- **`moveTo` `no_path` carries `{ distance, hint }`** (`5666f27`), the way
  `turnInQuest`'s `too_far` already did — qwen spent 8 turns rediscovering that
  a long hop works when chunked into short steps. This is FOLLOW-UPS 18(3)'s
  "teach the recovery recipe" half; splitting `no_path` into distinguishable
  causes stays module work and stays open.
- **Prompt: raw-action `ok`, state shapes, and the tool/ambient seam.** Raw
  `questComplete`/`questChooseReward` answered `{"ok": true}` while the server
  silently dropped both (qwen, 5 turns): the prompt now says a raw action's `ok`
  means *dispatched*, not *succeeded*, and points at the helper that confirms the
  outcome. The prompt's old universal "every observed field is `{value, seq,
  ts}`" was false for `questLog` (hy3, 1 turn) and hid that `state.self` has no
  top-level `maxHealth` (qwen crashed on `state.self.maxHealth.value` and ran
  blind on max HP for the rest of the episode); it now enumerates wrapped vs
  flat with a one-line example for each, and the *shapes themselves are
  unchanged* on purpose — changing the wire/state shape mid-0.3 would break
  comparability across the runs already on the board. And models kept calling
  `write_scratchpad(...)`/`search_reference(...)` as bare snippet globals
  (laguna 2, hy3 1), so one sentence next to `scratchpad` now separates tools
  (called between snippets) from ambient objects (available inside one).
- **Deferred to FOLLOW-UPS**, with the evidence: the questgiver status icon and
  quest objective text/counts (items 27, 28 — both module-tier observation
  surface a client already receives), `search_reference`'s id-substring noise and
  missing "you already asked this" signal (item 25), and a `nothing_offered`
  status for turn-ins (item 26 — investigated and rejected: the empty gossip
  menus laguna saw were answers to its own `questList`/`gossipHello`, not to
  `quest_complete`, so resolving on them would fabricate an outcome). Item 29
  records that the local-qwen lane is inference-bound (median 48s/turn, 78 of 90
  minutes inside the model), so none of this moves that lane.

No module rebuild is needed for any of it: the runner mounts this repo and the
sandbox loads the SDK from source at episode launch, so the next episode to
start picks these up. 694 tests green (`bun test`), `sdk/API.md` regenerated.


### Roster defer ladder, taint, and the idle-lane fix (`infra/run-roster.ts`)

Two failures observed live on the same afternoon, both in the roster's loop
scheduler, both fixed together because they share the cycle bookkeeping.

- **The backoff clamped.** The per-spec defer ladder shared `RETRY_BACKOFF_MS`
  with the mid-episode pause retry: `2m/5m/10m`, clamped at 10m forever. A model
  whose upstream free pool is saturated for the day therefore got retried every
  10m indefinitely — `z-ai/glm-5.2:free` reached `-c17`, seventeen 0-turn
  rate-limited stubs polluting the run directory for no signal. The ladder is now
  its own constant and escalates `1m/3m/5m/10m/15m/30m/1h/3h/6h`; the 10th
  consecutive defer marks the spec **tainted** and drops it from the rotation for
  the rest of the process (`say()` line, a JSONL row with outcome `tainted`
  carrying the defer count and last reason, and a tainted line in the exit
  summary). A successful episode still clears the count, as before. The
  mid-episode pause retry keeps the old `2m/5m/10m` under its own name: a run
  with real turns on the board wants to come back fast, and the two decisions
  were never the same decision.
- **Defer state died with the process.** A supervisor restart or a `fleet.json`
  edit respawned the lane with an empty defer map, so a spec sitting on a 6h
  backoff came back as a fresh launch at rung 1 — the escalation could never
  actually be reached in a fleet that gets edited. State now persists to
  `<--log>.defer.json` (tmp+rename, keyed on the stable cycle-1 spec id, *not* on
  `DeferEntry.runId`, which may be a `-cN`) and reloads on start (scoped by the `--log` path, so it can only belong to this roster and date).
  `run-fleet.sh --status` reads the same sidecar and prints tainted and cooling
  specs per lane.
- **Resumed lanes idled forever.** Under `--resume-roster --loop`, an entry whose
  cycle-1 run was already terminated was skipped *and removed from* the roster.
  With a whole roster in that state — five of six lanes at 16:48–17:01 — every
  later cycle logged "restarting the roster (0 episode(s))" and the lane did
  nothing for the rest of its budget. Being terminated is a statement about cycle
  1 only: the spec now stays in the rotation and cycle 2+ launches it fresh under
  a `-cN` id.
- **The gap lied.** A cycle that launched nothing slept the flat 10m announcing
  "all models backing off" even when nothing was backing off. The gap decision is
  now an explicit three-way (`planGap`): flat gap when episodes ran, sleep until
  the earliest `notBefore` when specs are genuinely cooling, and no sleep at all
  when the cycle was a pure no-op. The loop also exits cleanly when the rotation
  empties (everything terminated or tainted) instead of spinning.

The scheduling decisions are pure functions — `backoffMs`, `isTainted`,
`nextDefer`, `planAttempt`, `planCycle`, `planGap`, `serializeDefers`/`parseDefers`
— and `infra/roster-backoff.test.ts` pins each one (76 tests across `infra/`),
so none of this needs a live run to verify.

### API ergonomics pass: HUD, generated API.md, UnitView/gossip-by-text, wiki coords (issue #2, items 1–4)

A four-part harness-surface change to make the existing two-tier API usable the way
RuneBench's is, without importing porcelain or breaking the observation contract.
Item 5 (travel / `no_path` split / area triggers) was deliberately not started.

- **Item 1 — state HUD** (`b5e3d8b`). `formatStateSummary` became a fixed line-oriented
  client HUD (session, character, position, health, xp, money, bag, quests, target,
  nearby, open-window `ui` fold, stream, chat) driven only by observed snapshot fields;
  unobserved still prints `unobserved`, never `0`. The nearby line derives from
  `state.units()` and never prints exact mob health (CONTRACTS.md); the `ui` fold is
  computed in the sandbox (which holds the full event buffer) so `formatStateSummary`'s
  signature — and its off-limits callers — stayed untouched.
- **Item 2 — generated `sdk/API.md`** (`56be196`). A generator emits the doc from the live
  `WrathClient`/`StateCache`/`EventStream` prototypes with bidirectional drift checks
  (an invented row or an undocumented public method fails the build); `bun run docs:api:check`
  gates staleness. The sandbox exposes it as ambient `API_MD_PATH`, and the prompt's
  `Object.getOwnPropertyDescriptors` introspection recipe (ADR-0015's turn-waster) was
  deleted in favour of pointing at that file.
- **Item 3 — name-on-find, guid-on-act** (`2ed903c`, `8910a17`, `337ecfb`). `state.units({name})`
  matching went from substring-includes to exact/whole-word/shortest-then-nearest (and
  accepts a RegExp); guid-taking helpers now accept a `UnitView` directly while raw
  actions stay guid-only (deliberate ADR-0015 fence); `gossipSelect(guid, "option text")`
  resolves against a new last-gossip cache fold from `SMSG_GOSSIP_MESSAGE`/`_COMPLETE`.
- **Item 4 — wiki coordinate channel** (`10e871e`). Coordinates are extracted from raw
  wowwiki wikitext (`{{coords}}`, infobox loc) *before* stripping and persisted in a new
  `page_coords` bundle table (schema v2, fail-closed on old bundles); `search_reference`
  returns them as reference hints, explicitly not live observation. No AzerothCore DB or
  Questie source.

ADR-0004 consequence: this bumps the harness surface (prompt, context policy, SDK, and
reference bundle all changed together), so free-model scores before and after this pass
are not comparable — the post-cutover build is the new baseline. ADR-0012 gained a dated
addendum for the HUD; item 18's "wowwiki coordinates" clause is closed.

### Death was unrecoverable: an unacked teleport froze movement permanently (item 14)

Night-opus-1 (Dwarf Paladin, level 5) died in Dun Morogh, released, and then sat
motionless at the Kharanos graveyard for twelve minutes before deleting and
recreating the character at level 1. Five levels lost to the harness, not the model.

Root cause: the module never acked a teleport. `RepopAtGraveyard` calls `TeleportTo`,
which sets the near-teleport semaphore (`Player.cpp:1512/1538`); the server then
discards every movement opcode until the client sends `MSG_MOVE_TELEPORT_ACK`
(`MovementHandler.cpp:373`). The module had no teleport handling at all, so after any
teleport the character was wedged — synthesized movement packets silently dropped,
server-side position never advancing, moves returning `interrupted` or `no_path`.
Three further blockers stacked on it: the movement tick stopped any `!IsAlive()`
mover (`WbManager.cpp:1070`), conflating a ghost with a corpse and making the corpse
run impossible; `CMSG_SPIRIT_HEALER_ACTIVATE` was not whitelisted, so the graveyard
fallback was a dead end; and `reclaim_corpse` returned an indistinguishable ok
whether the server accepted or silently dropped it on one of five preconditions.
Independently, `moveTo` correlated terminal `WB_MOVE_RESULT` events on `moveId`
alone (`sdk/src/client.ts:865-879`) against a lifetime ring, but `moveIdGen` reset on
session recreate — so after a relog the SDK matched the previous session's stale
results, corrupting the model's own diagnosis.

Earlier deaths (gate2-ox-4, night-xpreview-1) had looked fine only because their
corpses were underfoot — the graveyard teleport had never applied. gate2-ox-4 in
fact finished its run alive at full health and permanently immobilized, and passed
its gate that way.

Shipped: module acks pending teleports on the world tick (`TickTeleportAcks`, near
and far, through the stock handlers, paced retries) — module-internal bridging the
agent never sees; the mover guard now stops only a dead unreleased body so a ghost
moves; `spirit_healer_activate` whitelisted end to end; SDK scopes move-result
correlation to a session epoch, with a regression test in `sdk/test/client.test.ts`;
`/character-delete`, `/session` and `/characters` gated to a `WrathBench.Accounts`
allowlist; the runner prompt documents die → repop → ghost run → reclaim with the
spirit-healer fallback. Verified end to end by `infra/smoke/death-recovery.ts`, which
now dies for real 150y from a graveyard and completes the corpse run.

Lesson: an action accepted on ack-returns-ok evidence is not an action that works.
ADR-0013 listed death recovery in the Phase 0 set and no smoke test ever died, so
the only two deaths that had happened were the one shape that survives the bug.

### Un-awaited SDK call killed the sandbox (item 15)

Three `sandbox_restarted` events in night-laguna-oc-1, each milliseconds after a
snippet that returned ok. The shape was always a fire-and-forget SDK call —
`console.log("Quest list:", JSON.stringify(sdk.questList()))`, no await. The promise
rejected after the HTTP round trip with no holder, and Bun 1.4 exits the process on
an unhandled rejection, so the whole runtime died for a routine error the try/catch
around the eval could never see. Turns running the same loop without the
fire-and-forget call survived — the controlled diff. Reproduced offline.

Fixed: the child installs `unhandledRejection`/`uncaughtException` handlers that
report (log-buffer entry on the next snippet result, plus a `fatal` session note)
instead of dying; the host pipes child stderr, keeps a tail, and stamps exit code,
signal and last stderr into the `sandbox_restarted` notice. Tests in
`runner/test/sandbox.test.ts`.

Lesson: the host was blind — stderr was `inherit` and the exit code ignored, so the
notice said only "exited unexpectedly". A supervisor that cannot say why its child
died costs more than the crash.

### "Quest-giver flicker" hypothesis killed (item 16)

The prior read — fast spawn/despawn NPCs, interacts landing a beat late — was wrong
on both counts. In night-laguna-oc-2's served event stream, Conservator Ilthalaine
and Tarindrella were created at t+0 and every later destroy/out-of-range for either
guid happened with the character 64–104y away, i.e. at the server's ~100y visibility
boundary. Two other runs show the identical far-edge churn in the same zone and
quested fine.

The actual failure was the model: laguna hallucinated wowhead-style creature entries
(1984, 1988/1992, 2031) that in the live database are unrelated critters, so its
entry-filtered scans matched nothing and it chased respawning boars as "cycling quest
NPCs" for forty minutes without ever referencing the real guid it already had. Module
destroy/OOR forwarding and the StateCache were clean. No code change.

Lesson: classify weak-model failures as model or harness before fixing anything. The
weak-model bottleneck here was knowledge and API discipline — invented entries,
unread wire truth — not observation flicker or action plumbing.

### Failure-surface audit, Tier 1 and Tier 2 (item 17)

An audit of 2,680 tool results across the overnight runs (229 errors) mapped every
failure surface. The deterministic, model-agnostic fixes shipped: Bun transpiler
AggregateErrors flattened into per-error message plus line:column and line text, with
line numbers corrected for the compile wrapper (43 of 229 errors had been a bare
"AggregateError: Parse error"); client-side guid and position validation that rejects
`undefined`/`null` and precision-truncating `number` guids by name; a
descriptor-based SDK-inspection idiom that never invokes getters; tool arguments
validated as `z.strictObject` with alias normalization, JSON fence-strip and
trailing-comma repair, echoed input on failure, and a "did you mean" for unknown tool
names; module missing-param replies that echo action and param, and `400 invalid_guid`
instead of coercing to guid 0; hints rendered into `WrathRequestError` for every known
error code; timeout ergonomics (buffered logs drained via the liveness pong,
recovery guidance in the event-loop-kill message); and `EventTimeoutError` saying what
it was waiting for.

ADR-0017 shipped alongside: guids are opaque decimal strings at the model surface,
with bigint confined behind the SDK's parseGuid/formatGuid seam.

Lesson: most model errors were the harness failing to say what was wrong, not the
model failing to reason. Auditing the error corpus in bulk found more than reading
trajectories one at a time.

### Solo auto-loot never stored an item (item 20)

The module's `loot_all` replay collected only `LOOT_SLOT_TYPE_ALLOW_LOOT` (0) slots,
but every solo `SMSG_LOOT_RESPONSE` marks its slots `LOOT_SLOT_TYPE_OWNER` (4)
(`LootMgr.cpp`, PERMISSION_OWNER). The module therefore sent `CMSG_LOOT_RELEASE` and
nothing else — no item ever entered a bag — while the SDK cheerfully reported
`{ ok: true, status: "looted" }` derived from the loot window's contents.

Fixed on both sides: the module accepts ALLOW_LOOT and OWNER (master/roll/locked stay
excluded, being group states a solo benchmark never auto-stores), and `lootCorpse`
derives its result from `SMSG_ITEM_PUSH_RESULT` receipts with a distinct
`none_stored` status. Shipped in the same post-mortem: `turnInQuest` races
`SMSG_INVENTORY_CHANGE_FAILURE` and returns `inventory_full` rather than timing out
on a full bag; `state.bag()`, the backpack view opus had rebuilt by hand from push
listeners, invSlot regexes and a forced relog (ADR-0015's bar met); and the prompt
now documents both SDK tiers.

Lesson: this is exactly the ADR-0016 rule — report the receipt, not the request.
Deriving success from what you asked for rather than what the server confirmed hid
the bug from day one.

### turnInQuest mis-statuses (item 21)

Both roster-opus and roster-sonnet read the helper's source and routed around it with
raw actions, which is the tell. Three defects in one method: a completable
`SMSG_QUESTGIVER_REQUEST_ITEMS` was answered by re-sending `quest_complete`, which the
core answers with REQUEST_ITEMS forever on item-delivery quests (now the reward is
chosen directly from that answer); a refusal while the quest log said complete
returned the same `not_complete` as unfinished objectives (now `wrong_questgiver`);
and an out-of-range turn-in burned the full timeout because the server drops it
silently (now a >40y cached-distance fast fail as `too_far`, the threshold left
deliberately gross so position staleness can never falsely reject — ADR-0016).

Shipped alongside: `item_not_usable` echoes what the local bag cache sees;
the 30s-timeout message carries a concrete fire-and-forget idiom (sonnet never once
used background routines and re-ran inline travel loops into the cap four times);
`state.self` documented as a property; claude-lane trajectory records carry a `call`
index because that lane's single long driver turn makes `turn` useless for analysis.

Lesson: when two independent models read a helper's source and issue raw actions
instead, the helper's status vocabulary is the defect.

### Long-distance travel probe (item 18)

`infra/smoke/travel.ts` walked a Dwarf from Coldridge Valley to the Deeprun Tram
entrance — about 1,900y, 18 of 18 waypoints, 7.7 minutes, on chained `move_to` hops.
Per-hop mmaps pathing is excellent: the Coldridge tunnel, switchback roads and the
long ascending Ironforge entrance hall were wall-followed inside single hops, and
waypoints taken from creature spawn coordinates (things that provably stand on the
mesh) arrived first try, 0.0–0.1y off, at ~7y/s. Zone and area transitions on map 0
are seamless and invisible. Mobs aggroing en route never interrupted a move. No
teleport fired on the ground route, so the item-14 ack fix was not load-bearing here.

Two findings became the open work in item 18. `no_path` is three different failures
wearing one name — target z off the mesh, path too long or complex
(PATHFIND_SHORT/INCOMPLETE folded into `no_path` at `WbManager.cpp:780-791`), and a
genuine mesh edge — and the agent cannot tell them apart. The recovery recipe that
cleared every recoverable case is a z-ladder (±4/10/20/40) then midpoint
subdivision; a 143y hop that failed at every z arrived cleanly as two 72y hops. All
rejections return in under 20ms, so probing is cheap. And the tram is a hard blocker
before the tram itself: areatrigger teleports fire on client-sent
`CMSG_AREA_TRIGGER`, which no action can express, and the navmesh ends about 8y
inside the portal tunnel.

Lesson: an agent would have to invent the z-ladder recipe unprompted. A status that
collapses three causes into one name pushes the whole recovery burden onto the model.

### Sandbox environment isolation (item 19 residual)

The sandbox child no longer inherits or auto-loads host environment
(`--env-file=/dev/null` plus an explicit allowlist). A trajectory audit over all
historical runs found no run had ever read the environment or the `.env` file. The
remaining gap — a snippet reading `.env` by absolute path — needs filesystem
sandboxing and stays open in item 19.

## 2026-08-21

### Dynamic context compaction: not needed on current evidence (item 8a)

A three-agent research pass concluded the extractive digest should be deferred behind
an evidence gate rather than built: under the fixed context policy, requests plateau
at roughly 8–12k tokens regardless of episode length, so there was nothing to
compact. The gate conditions (genuine context exhaustion, or a model re-querying
facts lost to a window trim) and the design to build if they trip stay open in item
8a — and the subscription-lane amendment of 2026-08-22 arguably trips them already.
- 2026-08-22 Track B: spellbook/cooldown/talent taps, learn_talent + raw passthrough (ADR-0025), state.spells()/cooldowns()/talents(), CONTRACTS drift fixed (trainers shipped, whisper never existed); module built to :next, not deployed.
