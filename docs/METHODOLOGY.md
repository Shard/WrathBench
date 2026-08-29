# Methodology

The decisions that shape what a WrathBench result means, and the principles
behind them. This is the successor to the numbered ADR series (50 records,
consolidated 2026-08-25; the full texts are in git history under
`docs/decisions/`, and `docs/WORKLOG.md` holds the table mapping each old
number to where its decision lives now). It is edited in place: a change to
anything here is a change to what the benchmark measures and is treated as
such — see "Changing this document" at the end. Mechanics live in the doc that owns the
component (`docs/ARCHITECTURE.md`, `docs/CONTRACTS.md`, `docs/EPISODES.md`,
`docs/OPERATIONS.md`, `module/PROTOCOL.md`, `wiki/README.md`); this page is
the why.

## The principles

Every decision below is an application of a short list of rules. When a new
question comes up, these are what it is judged against.

1. **The server is the source of truth for what happened.** Success is
   declared from server state, never from the harness's own bookkeeping.
2. **The agent observes and acts only as a real game client could.** Client
   parity is also the ownership test: what a client does locally, the module
   does; what a player decides, the model decides; game semantics live in
   TypeScript, never in C++.
3. **The model is the only variable.** One loop, one prompt, one context
   policy, one surface, for every model. Anything that would be tuning if it
   varied per model is either frozen into the harness version or recorded as
   a per-run dimension identical in shape for everyone.
4. **Record signals, derive scores offline.** The harness never computes a
   score; any number is a versioned derivation over recorded signals,
   recomputable over every past run.
5. **Stamped, never recomputed.** What a run was given is written down at
   launch and never back-filled, re-labeled, or re-derived against today's
   definitions. Saying nothing is more honest than asserting a comparability
   that was never established.
6. **Surface is earned, never speculative.** A helper or option exists
   because a trajectory showed models needing it, citable by run id.
7. **Feedback explains, never plays.** The harness may repair an input only
   when exactly one valid reading exists, and every rejection says what was
   received, what was expected, and the next step. It never teaches strategy,
   and silently wrong behavior is the one forbidden outcome.
8. **Game outcomes are values, not exceptions.** "You cannot walk there" is
   an ordinary answer. Throws are reserved for transport errors and absent
   answers.

## What WrathBench measures

**World of Warcraft 3.3.5a on AzerothCore.** Chosen over the other candidates
(OpenXcom, Warcraft III, Papers Please) for the richest decision space with an
open engine and no established harness, and for a path to coordination tasks.
The cost accepted with it: the game is real-time with no faster-than-realtime
mode, so episode cost is linear in wall clock, and the legal posture must be
explicit (`docs/DATA-AND-LEGAL.md`).

**Script-and-supervise, not direct play.** The game is real-time; per-action
model decisions would measure latency and require pausing a world that cannot
pause. Instead the model writes TypeScript snippets against the SDK in a
persistent per-session runtime, leaves routines running, receives events, and
intervenes — the way humans already play WoW partly through macros. The
benchmark therefore measures how well a model drives a fixed toolkit toward
long-horizon goals in a live world, and says so (`docs/VISION.md`). SDK
fluency is a confound; the fixed harness is the mitigation.

**Fixed harness, frozen per version.** The SDK surface, agent loop, prompt,
context policy, and reference bundle are frozen per harness version; the loop
is identical across models with no per-model prompts, retries, or tuning.
Scores mean "harness vX, model Y, episode Z" and old scores keep their label.
Harness versions are a research lever: score movement across versions shows
which models were bottlenecked on what. The version grain that groups
evidence is the **series** — `major.minor` of the harness stamp. A minor bump
is a change to what the run measures (it restarts evidence); a fix commit is
not. A change to what gets *scheduled* is not a bump: targets are stopping
rules, not measurements.

**Harness and driver are separate words.** The *harness* is what owns the
agent loop and context management: `wrathbench` (our fixed loop) or
`claude-code` (the Claude Code CLI scaffold, which owns its own history and
compaction). The *driver* is how the runner reaches the model (`openai`,
`claude-code`, `stub`). The harness is recorded as a tag on every run and
chart row, not used as a partition: claude-code rows sit in the same charts,
visibly tagged. Nothing about the claude-code harness unscores a run; `stub`
never scores (it is not a model). `harnessVersion` is a different word again —
the build of this repository, which applies to both harnesses.

## Client fidelity

**The two contracts.** The agent observes exactly what a real 3.3.5a client
connected to this character could observe, and every action is dispatched as
the client opcode a real client would send, through the character's
`WorldSession` handler — never server internals. The contracts are stated in
`docs/CONTRACTS.md`, enforced by the module, and logged at the boundary; they
are what make a server-side control module defensible as a benchmark surface.
The module attaches a stock `WorldSession` to a parked loopback socket so
every handler-side check applies unchanged; the only skipped machinery is
transport auth, which validates the wire, not the actions. Ambiguity resolves
toward the client: if it is unclear whether a client could see something, it
is not served.

**Client parity decides which layer owns a behavior.** This one test settled
every navigation and observation question, and is the test for the next one:

- *Movement* is synthesized client packets (start, heartbeats, stop) through
  the stock handlers, with arrival declared from the server-side character —
  the mover impersonates the client's movement engine, and the server's
  verdict is the result. Routing "move to position" against the server's
  mmaps is the one deliberate exception, granted because a client's human
  routes with eyes and the module has none.
- *Pathing detail is the module's, never the model's.* Move results are a
  typed cause vocabulary (`no_mesh`, `target_off_mesh`, `drop`, `teleported`,
  `transferred`, …); recovery ladders (z-resolution, path subdivision) run
  inside the module, because a client does them locally and a model
  reinventing them measures the wrong thing. The SDK carries a per-status
  hint and nothing else.
- *Areatriggers, transports, time-sync, the corpse query* fire from the
  module without an agent action, because a client sends them without the
  player choosing to. There is no "enter portal" action because a client
  never sends one.
- *Observation decodes the wire's own delta shape.* The module serves
  whitelisted fields from the packets as they arrive plus the guid→type map
  a client keeps; the SDK owns the world model. The module sends only the
  cache-miss lookups needed to decode the stream at all; every other
  auto-query a client sends (questgiver status, quest templates) is sent by
  the SDK — the module sends what is needed to *read* packets, the SDK what
  is needed to *show* the client's screen.
- *Client-cache knowledge is fair.* Reading the client's own DBC files from
  the data volume (areatriggers, area names, spell names) is rendering what
  a client renders, not new observation.
- *Achievements and flight use are observed, never inferred.* The packets a
  client is sent carry both — each achievement as it lands, the completed
  block of the login dump, and the server's reply to a flight request — and
  being flown is a named bit of the unit flags the observation stream already
  served. The module never asks the server's achievement manager anything: a
  run's achievements are what its own packets said, and a flight "ends" when
  the runner sees the flag flip, because no packet says so and inventing an
  event for it would be the SDK asserting an outcome the wire never gave.
  Names, points and categories come from the client's own achievement table
  on the data volume, the same client-cache knowledge as the area tables.
  Progress *toward* an achievement is deliberately not tapped: it is not a
  milestone, and the criteria stream is chatter a client renders and a
  benchmark has no derivation for.

**Widening either contract is a major harness version; narrowing is at least
a minor one.**

## The model surface

**Two tiers, deliberately unequal, and no middle tier.** The primary tier is
small: one obvious helper per common want, whose default is the whole common
case, grown only by observed need in trajectories (the review question for
any new helper: which run showed models needing this?). The escape hatch —
raw actions, the event stream, the state cache — is public and supported with
the same stability guarantees. There is no convenience middle tier
(`killNearest`, `grindUntilLevel`): a composition every model writes
graduates to the primary tier; until then it lives in snippets.

**The raw tier is an allowlist of ordinary client opcodes.** `raw` queues an
allowlisted opcode with a caller-built body verbatim into the stock handler.
The membership rule: a stock client sends it in ordinary play, its handler
does nothing a non-GM client could not do, and no dedicated action already
covers it. Replies reach the agent only through the existing event whitelist
— "I sent it and saw nothing" is precisely the evidence that earns a tap or a
helper. A raw opcode recurring in trajectories is the signal to give it an
action; widening the allowlist is additive, narrowing it is a harness change.
The allowlist is the agent's action surface, never a place to spend for
operator convenience.

**Game outcomes are return values.** Helpers that wait for a game verdict
return a discriminated union (`ok: true | false` with the module's own status
words and the server-confirmed position), because the failure statuses are
expected outcomes of normal play and an unhandled exception would end a run
over a wall. Transport and request errors throw; so does an event timeout,
because no result arriving is the *absence* of an outcome, not an outcome,
and inventing a `status: "timeout"` would put an SDK fabrication in a field
that otherwise only holds the module's words. The corollary: an SDK-side
status is legal only when it describes the SDK declining to act
(`unknown_target`, `lost`) — never a renamed or inferred server outcome.

**Softening: repair the deterministic, explain the rest.** Most model-facing
failures in early runs were feedback failures, not capability failures, and
weak models burned episodes blind-retrying. So the harness repairs an input
only when exactly one valid reading exists (a fence around JSON, a string
where a number is required); with two plausible readings it rejects and
explains, and never picks. Softening never changes game semantics, adds
gameplay helpers, or teaches strategy — a hint says "use String(guid)", never
"you should be fighting boars". Error-message text is load-bearing surface:
changing it is a harness change.

**Guids are opaque decimal strings everywhere a model can see one.** BigInt
was the top error class of the first measured night and never load-bearing at
the model surface. The SDK may use bigint internally and never lets one
escape; a `number` guid is rejected loudly for precision loss. Session-scoped
short aliases were rejected: they die on reconnect, so a stale alias silently
names the wrong unit — the forbidden class. Representation is fair game to
optimize; referents are not.

**A name in view is a valid referent, with bounded fuzz** (operator, 2026-08-29).
Wherever a helper or raw action takes a guid, it also takes the name of a unit,
item, spell, talent, faction or taxi node the model can currently observe, since
a player points at things by name. Resolution is deterministic and narrow:
normalise case, whitespace and apostrophes; exact match, else a unique
substring, else a unique match within a small edit distance. One candidate acts;
none refuses with what is in view; two or more refuse and list them — the
harness never picks between plausible referents, so referent selection stays
the model's. Opcode names and guids themselves are never fuzzed.

**A deadline explains, never caps.** The runner passes the sandbox's abandon
time into the SDK so a hint can say a walk was always longer than the caller
had left. No wait shortens and no call is refused because of it — capping
would silently change what is measured without appearing in any tuple field.

**A fact about the world is in the prompt's remit; a strategy hint is not.**
The system prompt describes the world, the runtime surface, the tools and the
goal, and the extent of the world is one of those facts: the prompt states
that this is the complete, unmodified 3.3.5a world, that every zone, city,
road, flight path, boat and tram a player could use exists and is reachable,
and that nothing has been walled off for the benchmark. It names no
destination, direction or timing, so it steers no play — a player knows this
much before logging in. Observed need: two opus-low freeplay runs (e360,
2026-08-26, and a11, 2026-08-29) concluded from local pathing failures that
the starter valley was walled and wrote that into the scratchpad as a hard
fact, spending the rest of the episode inside it, while fable and sonnet runs
on the same build left the valley. Operator decision 2026-08-29. What to do
when a move fails stays out: that is strategy, and it was explicitly
rejected.

**A harness message addressed to the model is delivered by the harness.**
Anything the harness has to say to the model — a per-status hint, a notice —
reaches it through a channel the model's own code cannot drop. Attaching it
to a return value and trusting the snippet to keep the field is not delivery:
a11 (2026-08-29) took 41 refusals carrying the hint that would have unstuck
it and read none of them, because its loops kept only `.status`. The harness
channel is in addition to the hint the result already carries, never instead
of it — result text stays load-bearing surface. Operator decision 2026-08-29.

## Context policy

One fixed context for every model; the authoritative encoding is
`runner/src/context.ts`. Every request is rebuilt as: the fixed system
prompt; a window of recent messages kept verbatim, trimmed in blocks so the
provider cache prefix survives; and one fresh deterministic user message —
goal line, harness notices, a fixed-format client-HUD state summary
(presentation of already-observed fields, never new observation; a field no
event carried reads `unobserved`), the recent events, and the full
scratchpad. Old per-turn messages are dropped, so the scratchpad is the only
durable memory — and the prompt says so, which makes writing it part of the
task rather than a harness kindness. `assembleContext` is pure and tested
byte-identical, so a trajectory replays into exactly the context the model
saw; a loop-level test pins the byte-stable prefix where the bytes leave.
Models with weak note-taking underperform at equal reasoning strength; that
is signal, not bias. A growing conversation with model-driven summarization
was rejected because the summarizer becomes an unversioned, model-dependent
part of the harness. Any constant in the policy is a harness version change.

## Episodes, lanes, and evidence

**Reset is a fresh character.** Every scored episode starts with a freshly
created level-1 character in its starting zone — character creation is a
client action, the reset is total, and GM shortcuts to mid-level starts would
skip the gearing and quest state a real character has. DB snapshots wait for
a task that needs them. Benchmark characters are never fixtured: the
smoke-fixture tool that pre-places gate characters writes only to smoke and
probe accounts, outside the observation contract rather than an exception to
it (the operator arranging the world before a run, like choosing an account).

**The model names its own character; race and class are the episode's.** The
launch note invites a name inside the game's own rule — 2–12 letters, no
spaces, no letter three times running — and says it is the model's for the
episode; the roster's name survives only as the suggestion offered to a model
that would rather not choose. Race and class are stated in the same note as
*not* the model's to choose, and why: they are dimensions every run is read
against. Nothing about the name is a measurement — no tuple field carries it,
no chart groups on it — and a fixed one was actively harmful, because a
character name is realm-wide unique while the hygiene that clears it is
per-account, so a fresh attempt scheduled elsewhere met a name it could not
use and no way to pick another. Letting the thing being driven be named by the
thing driving it costs nothing measured and is the more honest shape. The
freshness belt does not read names and did not change: it arms on every
character guid hygiene listed for the account, so a model that names a
survivor is caught by its guid and its level, never by its spelling.

**A knob is legitimate as a run dimension**: set per run, recorded in run
metadata, identical in shape for every model. Effort, operator objective,
watchdog overrides, `wikiCoords`, and the episode id are dimensions; `opus at
low` and `opus at high` are two comparable rows, not one tuned model.
Everything is stamped into one comparability tuple at launch
(`runner/src/comparability.ts`) — harness version and series, prompt hash of
the *rendered* bytes, harness tag, effort, episode id and budget, objective
presence, `wikiCoords`, wiki-bundle identity — and never recomputed. A run
written before a field existed reads `null` forever. A resume, where a lane
still allows one, re-stamps for the leash actually enforced and records that
it did.

**One field of the tuple is observed rather than stamped, and it is an
annotation, not a grouping key.** A run is launched with the string the roster
named, which under the claude-code harness is usually an alias the CLI resolves
minutes later to a real id — so no page could say which model a run had
actually been on, and the aliases cannot simply be replaced in the roster
because renaming a ref's model ends its runs. The resolved id is therefore
recorded on first observation, never revised (a later segment that resolves
elsewhere does not overwrite the id a score was earned under), and excluded
from the tuple's equality test, so an aliased run's resume does not emit a
restamp record that says nothing. It is back-filled at *read* time for runs
that predate it, from their own trajectories, and never written back to disk —
an old run is read differently, not relabelled. The pages show it only where it
differs from what was asked for, and flag a roster model that resolved to more
than one id across its runs, because that drift is the thing the field exists
to make visible. The wiki bundle's identity has the same standing: it says
which file a run was reading, while the thing that actually groups is the
harness minor bump a text-changing rebuild ships with.

**Steering is what makes a run unscored.** An objective is operator-authored
world knowledge rendered into the fixed prompt at one fixed place; with no
objective the prompt is byte-identical to the shipped one, by construction.
Any run with an objective is stamped unscored and cannot drift into a chart
by being forgotten. `wikiCoords` defaults to false — exact yards from the
wiki are an answer key for the "find things" rungs, and without them a model
must do what a player does: read "in the inn at Goldshire", walk there, look.
Harder is the point; coordinates are served only in steered episodes, and if
the names-only ladder proves unclimbable the pull-back is a labeled coords
tier, never a silent change.
The same rule governs client-side tables the module reads: the flight-master
window carries node *names* (`TaxiNodes.dbc`, the same precedent as area
names), never the node positions the DBC also holds — a model learns where
Thelsamar is by flying there, not from a coordinate list. Operator decision
2026-08-29.

**Three lanes, separated by what a series bump does to them.** Evals (`e90`,
`e360`) re-arm on every series bump and feed the charts. Probe campaigns — a
commissioned objective swept over cells by a set of models — run to
completion and are never re-armed. Freeplay never finishes and never counts.
Not duration and not steering: `e360` is six hours while `freeplay` has no episode wall-clock cap; `probing` and `freeplay` are both unscored. Each episode id is a
comparability group — scores never mix across ids, nor across series within
one — and a wrong default is replaced by a *new id*, never widened in place,
because widening silently re-scopes every existing score. Definitions:
`docs/EPISODES.md`.

**A lapsed run is evidence only if its lane says so; everywhere else it is a
failed attempt.** A run that pauses — for a deploy, for a provider's refusal —
or that goes quiet because the host slept, stops without a verdict, and what
happens to it is a property of the lane and not of the operator's mood. On the
scored lanes it is ended: the account and character go back, and the model gets
a fresh attempt with a new run id and a full clock. Resuming was the old rule
and it was right for a sandbox and wrong for a measurement — an `e90` is ninety
minutes of *play*, and a run that paused at minute 41, sat out a two-hour quota
window and came back is not that in any sense a reader of the ladder would
recognise. Nothing about its tuple is false; the episode is. Freeplay resumes,
because it never finishes and never counts; a probe campaign resumes only if it
says so, because a swept cell is usually better re-swept than continued.

A failed attempt numbers a run id and is visible with its reason, but it is
never a recorded episode: the same predicate that keeps steered runs off the
scored surfaces keeps it off them, and the episode grain counts it as an
attempt spent rather than a member. Three counted failures on one model,
episode and series stop the scheduler trying — evidence about a model's
endpoint, not about the model — and what counts is the termination reason and
nothing else. A fleet stop is the harness's own doing and an offline gap is
harness weather, so both spend the attempt and neither is a strike. Reading a
reason rather than parsing a detail string is what keeps that distinction from
being rediscovered as a bug, and one shared list of the reasons that are not
the model's fault is what keeps a run written off by the scheduler from still
being drawn on the ladder. Mechanics — the sweep, the strike ladder, the
per-lane table — are `docs/OPERATIONS.md` and `docs/EPISODES.md`.

**The tier is the evidence budget.** How much a model runs is one word on its
roster entry, denominated in runs, and it is the only thing that sets a run
count: `t0` trial (e90 ×1, held), `t1` standard (e90 ×3), `t2` long (e90 ×3 +
e360 ×1). Promotion is a threshold applied to every model alike — one counted
`e90` reaching level 5 climbs `t1` to `t2` — never a judgement; what a model
*earned* is recorded separately from where it was *admitted*, so a trial
model keeps its witness and promotes instantly when an operator moves it.
Eligibility falls out of the budget (an episode a tier buys no runs of cannot
be scheduled), unscored episodes cannot be named in a budget (enforced by
type), and billing buys no runs and costs none — paid-ness decides only where
a run may physically execute. A bespoke volume is a named tier added to the
table in code, reviewed like an episode id; there is deliberately no
per-entry override. Money caps are external to the fleet by decision.
Scheduling mechanics — account classes, the defer ladder, priorities — are
`docs/OPERATIONS.md`.

## Scoring

**The goal prompt is deliberately broad** — progress the character: level,
gear, quests, wealth, capability — and never names a statistic a model could
Goodhart. WoW cooperates: leveling is a journey around the level spine with
nowhere to reach max level standing still, so the broad goal has a real
gradient. Its wording changes only at a harness boundary.

**The harness records a signal vector, not a score**: level curve, XP, quests
with ids, money, deaths, position, spells, playtime, achievements earned with
their points, flights taken, and event and turn counts. Recording is cheap and
additive; anything derivable later need not be decided now — but the converse
binds, so a claim the ladder wants to make later has to be in the recording
first, which is why the achievement and flight taps were added before any rung
read them. A run that predates a signal carries no reading for it, and a
derivation must treat that as *not recorded* rather than as zero.

**Scores are derived offline, versioned, recomputable.** Any leaderboard
number is a derivation over recorded signals, recomputable over every past
run; changing a derivation invalidates nothing, changing the recording or the
prompt does. Old runs lack new columns and derivations must tolerate that.
Goodhart pressure moves from the model to the derivation author, where it can
be revised without re-running anything. The dashboard ladder's row ordering
(highest rung, then the `(level, xp)` pair, then gold; missing readings sort
last, never as zero) is one such derivation, versioned with the dashboard in
`dashboard/src/lib/ladder.ts` — three separate numbers, no aggregate score.

**A ladder belongs to a comparability group, so `probing` has none** (operator
decision, 2026-08-29). A probe campaign varies its cells on purpose; a table
ranking its runs against each other ranks the sweep, not the models. Probe runs
stay visible wherever runs are listed — they simply have no ladder, the viewer
refuses to serve one, and none is published.

**The freeplay ladder is an overview, not a leaderboard** (operator decision,
2026-08-29): the top characters on freeplay at the current time. It shows the
whole active field — every freeplay run not deleted and not tainted, including
paused and disabled streams and runs in progress, not only finished ones — so
the scored surfaces' "is this evidence" predicate is deliberately not what
filters it; a launch that produced nothing is dropped and a run's state is a
column rather than an exclusion. Because a freeplay stream is durable, one row
is **one character across attempts**, not one run: the latest attempt carries
the character's current level and state and the lineage rides with it, so the
same character never appears twice. The reader's own filters still apply as
they do on the scored tiers, **"exclude free" included** (operator, 2026-08-29,
reversing the exemption made the same day): same control, same default-on, same
predicate, over both the table and the graph. The one exemption that stands is
the harness series — a stream is durable across series, and cutting its older
attempts would report a long-lived character as attempt 1. Nothing here touches
the scored ladders, which remain keyed by model over scored runs alone.

**No single number is promised in this phase**; the honest artifact is the
scorecard.

## The reference bundle

The agent's out-of-game knowledge is a search tool over a bundle built from a
2020 wiki dump — wiki reference, not ground truth, and framed that way in the
tool description, which also carries one fixed sentence, identical in every
lane, saying the world is 3.3.5a.

**The bundle is a Wrath snapshot.** Four expansions of divergence sit between
the dump and the world; what is not patch 3.3.5 is removed at build time by
deterministic rules — era cutoff at patch 4.0.1, post-Wrath signal drops,
pre-announcement protection, section and paragraph cuts — with every rule's
count written to the bundle's `meta`, so removal is verifiable by rebuilding
from the same dump. Labels were tried first and rejected: a note costs every
snippet a line, does not survive a snippet window, and leaves the wrong world
in the index. A model asking about something that only exists in Cataclysm
gets nothing, which is the intended answer. A canary list of titles a 3.3.5a
reference cannot be missing guards every build, because a rule one word too
broad is invisible to counters and obvious to a list of names. Rules,
counters and the canary: `wiki/README.md`.

**Structured facts are lifted before stripping destroys them.** The quest
infobox (giver, ender, category) rides as data, and **the ender is never
inferred from the giver** — when the page does not state it, the answer is
"turn-in NPC not stated", because guessing "same NPC" manufactures a
confident wrong answer in precisely the case the field exists to fix.

**The build may ask the world DB whether an id exists, and nothing else.** A
late page with no era evidence in its text is admitted when an id it states
about itself exists in the 3.3.5a world DB under a name that agrees with the
page's subject. The export is read once, offline, into a file, so the build
stays a function of files; the agent still sees wiki text and only wiki text.
The honest residue is one bit per admitted page — that the page's own claim
checks out — which buys the agent nothing a search of the page did not.

**A bundle rebuild that changes page text ships with a harness minor bump**,
the same as any other change to what the model could read; the bundle's
self-description is stamped into the comparability tuple so the bump is
falsifiable.

## Changing this document

A change to anything above is a change to what the benchmark measures, and it
is made only on the operator's explicit direction — never on an agent's own
initiative. An edit here records a decision the operator made; work that
would require changing or contradicting one stops and puts the question to
the operator first. Surface, prompt, context policy, contract, or bundle-text
changes move the harness version (minor at least; contract widenings are
major). Scheduling and derivation changes do not bump the version but are
still edits to this page or the owning doc, dated in the worklog. Keep this
document consolidated: fold a new decision into the section it belongs to,
prune what it obsoletes, and let git history hold the past — no append-only
records.
