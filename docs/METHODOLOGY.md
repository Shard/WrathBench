# Methodology

The decisions that shape what a WrathBench result means, and the principles
behind them. This is the successor to the numbered ADR series (50 records,
consolidated 2026-08-25; the full texts are in git history under
`docs/decisions/`, and the operator's private record holds the table mapping
each old number to where its decision lives now). It is edited in place: a change to
anything here is a change to what the benchmark measures and is treated as
such — see "Changing this document" at the end. Mechanics live in the doc that owns the
component (`docs/ARCHITECTURE.md`, `docs/CONTRACTS.md`, `docs/EPISODES.md`,
`docs/RUNBOOK.md`, `module/PROTOCOL.md`, `wiki/README.md`); this page is
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
agent loop and context management: `wrathbench` (our fixed loop),
`claude-code` (the Claude Code CLI scaffold, which owns its own history and
compaction) or `codex` (the OpenAI Codex CLI scaffold, likewise). The
*driver* is how the runner reaches the model (`openai`, `claude-code`,
`codex`, `stub`). The harness is recorded as a tag on every run and chart
row, not used as a partition: claude-code and codex rows sit in the same
charts, visibly tagged. Nothing about a CLI harness unscores a run; `stub`
never scores (it is not a model). `harnessVersion` is a different word again —
the build of this repository, which applies to every harness.

**Each CLI scaffold is its own comparability group** (operator, 2026-09-05,
asking for a ChatGPT-subscription lane). `codex` is not folded into
`claude-code` as one "CLI" group even though both run the same regime — one
continuous session the scaffold owns and compacts — because what sits inside
each is a *different* unversioned summarizer, and the whole reason a scaffold
is tagged apart from `wrathbench` is that its summarizer is not ours. The two
scaffolds get the same prompt bytes (the one per-harness sentence says "the
CLI", never which), so their prompt hashes match and the harness tag is what
separates them. A ChatGPT subscription is a lane exactly as a Claude
subscription is: one logged-in `CODEX_HOME` per lane, one live session per
lane, never copied per run.

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

**The scratchpad is edited, not only rewritten** (operator decision
2026-09-01). `edit_scratchpad({ old, new, replaceAll? })` replaces an exact
substring of the pad, taking its shape from the string-replace edit tool models
are trained on (Claude Code's): `old` must match byte for byte and be unique
unless `replaceAll` is set, and a miss or an ambiguity is refused with what to
fix rather than guessed at — the same refusal discipline referent resolution
uses. `write_scratchpad` stays, because full replacement is a different
operation and not a convenience wrapper over the edit. Observed need (#41,
2026-09-01): about 28% of a high-frequency writer's rewrites (sonnet-low, 26
writes in one run) changed under 20% of the pad, which is a rewrite tax on the
models least able to afford the output tokens; the sample does not show it
fleet-wide, so this is the profile the evidence covers.

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

**Reflection is the model's to take, and only at rest** (operator,
2026-08-30). A `reflect` tool lets the model spend a turn thinking instead
of acting. It works only while the character is in a rest area (the
client-visible resting flag: inns and cities); elsewhere it refuses with
that fact as the hint, so reflection never happens mid-combat and always
happens among the NPCs a player would visit anyway. The window closes when the
character leaves the rested state or after thirty turns, whichever comes
first — the thirty is a circuit breaker against a thinking deadlock, not a
hint — and reflection is available again on the next rest visit. The tool returns a fixed, content-free prompt
(review the scratchpad against what has been observed and told; state
beliefs and their evidence; what worked, what did not; what next) and the
model writes the outcome into its own scratchpad. The harness summarizes
nothing, which is what separates this from the rejected model-driven
summarizer above. Reflect turns are recorded with a `reflect` marker and
count toward turns-to-level like any other turn: choosing when to think is
part of playing well, and a free turn would invite gaming. Separately, the
model is now told in `[harness notices]` when a block-trim drops older
conversation, so it is never silently blind to its own memory. Both are
patch changes; the 0.6 series bump is reserved for the first semi-public
release.

**An episodic log, written before each trim, read back at rest** (operator,
2026-08-30). On the last turn before a block-trim the harness asks for a
short status entry — what the model is doing and how it is going — via
`log_status` — the trim is taken one turn after the window crosses its
ceiling, so that turn is known rather than predicted. Entries are append-only, stamped with turn, level and zone,
and are not the scratchpad: working memory is the model's to rewrite, the
log is a record it cannot edit. It is read back only while reflecting:
`reflect` opens a reflection window that lasts as long as the character
stays rested — many turns if the model wants them, with every other tool
still usable, since the inn's vendors and trainers are part of the point —
in which `read_log` pages the whole log on demand (the tool is always listed but refuses outside that
window, so the tool list stays fixed for both harness groups — nine tools since `read_scratchpad`
was removed, the scratchpad being injected verbatim into every turn's context already; operator,
2026-08-30). Looking back
at where things went wrong is what resting is for. The trigger is the trim
itself, not a cadence constant; the CLI-scaffold drivers (claude-code, codex)
have no trim, so they get neither the prompt nor the entries, a documented
asymmetry between harness groups.

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
presence, `wikiCoords`, a withheld reference wiki, wiki-bundle identity — and
never recomputed. A run written before a field existed reads `null` forever. A
resume, where a lane still allows one, re-stamps for the leash actually
enforced and records that it did.

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

**Routing is pinned, and it is config.** An aggregator answers one model slug
from many backends — six have served `glm-5.3-flash` here — and those are six
machines with six quantisations, six throughputs and six prompt caches. Pooled
as one row they are not one measurement. So, operator decision 2026-09-16:
prefer the lab's own endpoint unless there is a specific reason, and a
third-party provider is a deliberate, named datapoint (the way qwen 3.8 ran on
Cerebras), never a silent fallback. The default is therefore the model author's
own provider with fallbacks off, an entry may name providers instead, and a run
that a named provider cannot serve fails rather than moving. The *requested*
routing is a launch dimension exactly like effort, so it is stamped into the
comparability tuple and it is a KEY: an unpinned run and a pinned one are two
conditions and do not share a chart. The provider that actually *served* the
run is recorded rather than keyed, for the reason the resolved model id is — a
fact observed minutes after launch cannot be part of what a launch stamped —
and with fallbacks off the two agree, which is what makes a disagreement worth
seeing. The field is absent, not null, on a run whose endpoint has one backend
(a CLI harness, Cerebras, LM Studio, OpenCode Zen): there is nothing to record,
and those runs go on stamping exactly as they did before the field existed.

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

**The reference wiki is a capability, and a run may be configured without it**
(operator, 2026-09-16, issue #61). It is included by default — every scored run
to date has had it, and the bundle is part of the fixed harness — but an entry
may state `wiki: false`, and then the run has no `search_reference` tool, the
prompt does not name one, and no bundle is opened. That is a declared off
switch, not a factorial arm bought out of the tier budget: nothing schedules a
matched bundle-off study, and withholding the bundle would not isolate a
model's own priors anyway, because it removes the retrieval channel and leaves
the memorised one untouched. Because the run is a different condition, `wiki:
false` is stamped into the comparability tuple as a KEY and the rendered prompt
hashes differently; the field is absent on a run that has the wiki, so every
run stamped before the switch existed stamps byte-for-byte as it did.

The flight-master window carries the node *names* (`TaxiNodes.dbc`, the same
precedent as area names), and the node positions those same client-side rows
hold are contract-clean (`docs/CONTRACTS.md`, operator 2026-09-16) and
withheld by no decision here. The earlier "never the positions" wording
(2026-08-29) was an extrapolation rather than an operator decision, and is
retracted 2026-09-16. The wiki-coordinates decision above is unchanged and is
the only rule this project has about positions.

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
harness weather, so both spend the attempt and neither is a strike; a
transport failure mid-episode (`adapter-error`) is the same — the run ended
on the endpoint's clock, not the model's, so it is never scored (operator,
2026-08-30). Reading a
reason rather than parsing a detail string is what keeps that distinction from
being rediscovered as a bug, and one shared list of the reasons that are not
the model's fault is what keeps a run written off by the scheduler from still
being drawn on the ladder. Mechanics — the sweep, the strike ladder, the
per-lane table — are `docs/RUNBOOK.md` and `docs/EPISODES.md`.

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
`docs/RUNBOOK.md`.

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

**The ladder shows its dispersion; its reference lines are withdrawn**
(operator decisions, 2026-09-16 and 2026-09-18). A tier is an evidence budget,
so a row's maxima are maxima over runs the fleet already paid for: the row
says how many of its askable runs reached each rung, and the level cell's
hover gives the range and median of levels its counted runs spanned, beside
the best run rather than instead of it. Until 2026-09-18 the page also drew
two labelled lines behind the level readings — an empirical ceiling derived
at read time from the current series' scored runs on the tier in view, and a
human speedrun band per tier from the Wrath of the Lich King Classic Archive
board on speedrun.com (level 9–10 at ninety minutes from its single 1–10
entry, level 18–19 at six hours interpolated from its 1–20 entry). The
operator withdrew both from the page on 2026-09-18: the rail was hard to read
and one human entry per category is not enough data to earn the space. The
figures, their provenance and caveats stay in the repository
(`dashboard/src/lib/reference.ts`, and "The human reference" in
`docs/PUBLIC-DASHBOARD.md`) and the band returns if and when there are
several runs to state a distribution from. A scripted greedy-XP grinder and a
deterministic walkthrough were considered as baselines and not chosen: no
scripted agent is built and nothing new is run. Nothing here is a score and
nothing here enters the row order.

**A ladder belongs to a comparability group, so `probing` has none** (operator
decision, 2026-08-29). A probe campaign varies its cells on purpose; a table
ranking its runs against each other ranks the sweep, not the models. Probe runs
stay visible wherever runs are listed — they simply have no ladder, the viewer
refuses to serve one, and none is published.

**The freeplay ladder is an overview, not a leaderboard** (operator decision,
2026-08-29): the top characters on freeplay at the current time. It shows the
whole active field — every freeplay run not deleted and not tainted, including
paused and disabled characters and runs in progress, not only finished ones — so
the scored surfaces' "is this evidence" predicate is deliberately not what
filters it; a launch that produced nothing is dropped and a run's state is a
column rather than an exclusion. Because a freeplay character is durable, one row
is **one character across attempts**, not one run: the latest attempt carries
the character's current level and state and the lineage rides with it, so the
same character never appears twice. The reader's own filters still apply as
they do on the scored tiers, **"exclude free" included** (operator, 2026-08-29,
reversing the exemption made the same day): same control, same default-on, same
predicate, over both the table and the graph. The one exemption that stands is
the harness series — a character is durable across series, and cutting its older
attempts would report a long-lived character as attempt 1. Nothing here touches
the scored ladders, which remain keyed by model over scored runs alone.

**The character is the universal unit, and a scored run is a character of one
attempt** (operator decision, 2026-09-16). Every run belongs to a character —
the chain is the head run's id, as it has always been — so the scored case is
the degenerate one rather than an exception, and nothing that reads a run has
to ask whether it is freeplay to know it has a character. This retires the
noun "stream" for "character" throughout, which is a consolidation and not a
change of meaning: freeplay is still one character per model and effort, and a
lapsed scored episode is still a failed attempt, not the start of a chain.

**No single number is promised**; the honest artifact is the
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

## Known limitations

Five things a reader of the ladder cannot see from it, each bounding what a
number here means. Naming them is cheaper than being corrected about them.

**Contamination is assumed, not controlled.** Every model measured here has
almost certainly read Wowhead, Wowpedia, levelling guides and the quest text
itself; fifteen years of walkthroughs for this content are in the open web.
No probe separates what a model recalls from what it works out, and none has
been run. That is survivable only because of what the benchmark claims: "What
WrathBench measures" says it measures how well a model drives a fixed toolkit
toward long-horizon goals in a live world, and that is the whole claim — not knowledge of an unseen world, not discovery. Knowing where
Kharanos is counts as part of the model, the way knowing the standard library
counts on a coding benchmark. The names-first rule under "Episodes, lanes, and
evidence" is not a contamination control and should not be read as one: it
governs the *harness's* own leakage — a coordinate list served out of our
bundle would be an answer key we handed over — and says nothing about what the
model already knew. The size of the prior is unmeasured.

**Most rows are one to a few runs, and that is a budget.** The tier is the
evidence budget: `t0` buys one `e90`, `t1` three, `t2` three plus one `e360`,
so a ladder entry's `n` is usually one and never more than three. The ladder
prints that `n` beside every entry. One run has spread — a live world, a
provider's weather, a death that costs minutes — and a gap of a level or two
sits inside it. This is why the ladder shows a highest rung, a `(level, xp)`
pair and gold as three separate numbers rather than one score ("Scoring"), and
why no single number is promised. The cap is not a claim that three is enough;
it is what the operator can pay for across the whole board today, and it is
expected to rise as the cost of an episode falls (operator, 2026-09-19).

**There is no floor.** No scripted baseline has been run through this harness:
no greedy XP grinder, no deterministic quest-walkthrough script, no random
agent. So "level 9 in ninety minutes" is a number with nothing under it, and
nothing presently distinguishes a model that planned well from one that
remembered a guide or simply held the SDK correctly. The fixed harness bounds
the last of those and nothing bounds the first two. Until a baseline runs, a
rung means "a model got here", never "this is hard".

**Provenance is stamped, and partial.** Every run's metadata carries the
harness build — the repository's own describe stamp against the series tag,
in the form `harness-0.5-<n>-g<sha>` — and beside it the comparability tuple
(`runner/src/comparability.ts`): series, the prompt hash of the rendered
bytes, harness tag, effort, episode id and budget, objective presence,
`wikiCoords`, the wiki bundle's identity, and the module's own build as
`/health` reported it. It is stamped at launch, never recomputed, served on
the run's API row and shown on the run page. What it does not yet carry: a
hash of the SDK source, the AzerothCore pin, the observation and action
contract version, and the compose configuration. A run is therefore traceable
to a build of this repository, not yet to one manifest naming every version it
depended on.

**A CLI-scaffold run's cost is not comparable to an API-driver one.** The
`claude-code` and `codex` harnesses each own their own history and compaction
("What WrathBench measures"), which in practice is one continuous conversation
that grows across the episode rather than the fixed window
`runner/src/context.ts` rebuilds. Their token counts are of a different regime,
and both lanes bill a flat subscription rather than metered tokens: a codex run
reports no cost at all and is shown a list-price estimate over its tokens,
marked as-if-metered — a comparison and not a bill (operator, 2026-09-05;
`docs/COSTS.md` §3 carries the measurements and the decision). Cost axes across
harness groups are read accordingly.

## Changing this document

A change to anything above is a change to what the benchmark measures, and it
is made only on the operator's explicit direction — never on an agent's own
initiative. An edit here records a decision the operator made; work that
would require changing or contradicting one stops and puts the question to
the operator first. Surface, prompt, context policy, contract, or bundle-text
changes move the harness version (minor at least; contract widenings are
major). Scheduling and derivation changes do not bump the version but are
still edits to this page or the owning doc, dated. Keep this
document consolidated: fold a new decision into the section it belongs to,
prune what it obsoletes, and let git history hold the past — no append-only
records.
