# Methodology

What a WrathBench result means and what would make it stop meaning that: eight
principles, then the decisions that apply them, each a rule and its why.
Mechanics live in the doc that owns the component. A change to anything here
is a change to what the benchmark measures — see "Changing this document".

## The principles

Every decision below is an application of a short list of rules. When a new
question comes up, these are what it is judged against.

1. **The server is the source of truth for what happened.** Success is
   declared from server state, never from the harness's own bookkeeping.
2. **The agent observes and acts only as a real game client could.** Client
   parity is also the ownership test: what a client does locally, the module
   does; what a player decides, the model decides; game semantics live in
   TypeScript, never in C++.
3. **The model is the only variable within a harness.** One loop, one
   prompt, one context policy, one surface, for every model under a harness
   label. Anything that would be tuning if it varied per model is either
   frozen into the harness version or recorded as a per-run dimension
   identical in shape for everyone. A scaffold that varies its prompt,
   sampling or tools by model id is configured out of doing so, and whatever
   cannot be is part of what its label means and is stated with it
   (operator, 2026-10-16).
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

**World of Warcraft 3.3.5a on AzerothCore, script-and-supervise.** The game
offers the richest decision space with an open engine and no established
harness; it is real-time and cannot pause, so per-action model decisions would
measure latency. The model instead writes TypeScript against the SDK in a
persistent runtime, leaves routines running and intervenes. The benchmark
therefore measures how well a model drives a fixed toolkit toward long-horizon
goals in a live world, and says so (`docs/VISION.md`); SDK fluency is a
confound and the fixed harness is the mitigation. Episode cost is linear in
wall clock, and the legal posture is explicit (`docs/DATA-AND-LEGAL.md`).

**Fixed harness, frozen per version.** Surface, loop, prompt, context policy
and reference bundle are frozen per harness version, identical across models.
A score means "harness vX, model Y, episode Z" and old scores keep their label;
movement across versions is itself signal. The grain that groups evidence is
the **series**, `major.minor` of the harness stamp: a minor bump changes what
a run measures and restarts evidence; a fix commit does not, nor does a change
to what gets *scheduled*, because targets are stopping rules, not
measurements. The SDK is versioned separately from the harness (operator,
2026-10-28). Its model-facing surface is still part of the surface frozen per
harness version, so changing it moves the harness version as before
("Changing this document"). The SDK version a run drove is a label only: it is
not part of the comparability tuple and filters nothing on the ladder or the
dashboard (operator, 2026-10-28).

**Harness and driver are separate words.** The *harness* owns the loop and
context: `wrathbench` (our fixed loop), `claude-code` or `codex` (CLI scaffolds
that own their own history and compaction); the *driver* is how the runner
reaches the model. The harness is a tag on every row, never a partition, and
it stays one because no model id runs under two harnesses in a scored lane:
the roster refuses it, and a variant of a harness runs only as a
probe-campaign arm until the operator promotes it (operator, 2026-10-16).
Nothing about a CLI harness unscores a run, and `stub` never scores because it
is not a model. **Each CLI scaffold is its own comparability group**
(2026-09-05): each contains a *different* unversioned summarizer, which is the
whole reason a scaffold is tagged apart from `wrathbench`, and disjoint ids
keep its rows from pooling with another harness's. What a scaffold does per
model that cannot be configured out is stated with its label (principle 3):
`codex` gives GPT-6 models its code mode and collaboration tools. A harness
setting has the harness's default and may be overridden per roster entry, as a
recorded run dimension like effort rather than per-model tuning (operator,
2026-10-16); the compaction window is one (claude-code, 2026-10-09), and a
general one that covers codex too, with each CLI's own `auto` staying the
default on every driver and a probe campaign comparing windows (arms `auto`,
100k, 200k and 300k) (operator, 2026-10-11). `pi`, the pi coding-agent CLI, is
a labelled harness of the same kind, its own comparability group and
probe-only until the operator promotes it, and its campaign compacts at a
fixed 300k-token window (operator, 2026-10-20).

## Client fidelity

**The two contracts.** The agent observes exactly what a real 3.3.5a client
connected to this character could observe, and every action is dispatched as
the client opcode a real client would send, through the character's own
`WorldSession` handler — never server internals (`docs/CONTRACTS.md`; enforced
by the module, logged at the boundary). They are what make a server-side
control module defensible as a benchmark surface. Ambiguity resolves toward
the client: if it is unclear whether a client could see something, it is not
served.

**Client parity decides which layer owns a behavior.** What a client does
locally the module does without an agent action, because a model reinventing
it would measure the wrong thing. The one deliberate exception is routing
"move to position" against the server's navmesh, because a client's human
routes with eyes and the module has none. Nothing is inferred that the wire
did not say.

Changing either contract moves the harness version; the rule is
`docs/CONTRACTS.md`, "Changing the contracts".

## The model surface

**Two tiers, deliberately unequal, and no middle tier.** The primary tier is
small — one obvious helper per common want, grown only by observed need (which
run showed models needing this?). The escape hatch — raw actions, the event
stream, the state cache — is public with the same stability guarantees. There
is no convenience middle tier: a composition every model writes graduates to
the primary tier; until then it lives in snippets. The raw tier is an allowlist
of ordinary client opcodes (`docs/CONTRACTS.md`); widening it is additive,
narrowing it is a harness change.

**Softening: repair the deterministic, explain the rest.** Most early
model-facing failures were feedback failures, and weak models burned episodes
blind-retrying. The harness repairs an input only when exactly one valid
reading exists; with two it rejects, explains, and never picks. It never
changes game semantics or teaches strategy, and error-message text is
load-bearing surface: changing it is a harness change.

**A name in view is a valid referent, with bounded fuzz** (2026-08-29). A
player points at things by name, so wherever a helper takes a guid it also
takes the name of something currently observed. One candidate acts; none, or
two or more, refuse and say what is in view — the harness never picks between
plausible referents. Guids are opaque strings, never fuzzed or aliased: a stale
alias silently naming the wrong unit is the forbidden class.

**A deadline explains, never caps.** The SDK knows the caller's remaining time
so a hint can say a walk was always too long; no wait shortens and no call is
refused for it, since capping would change what is measured without appearing
in any tuple field.

**A fact about the world is in the prompt's remit; a strategy hint is not**
(2026-08-29). The prompt says this is the complete, unmodified 3.3.5a world
with nothing walled off — a player knows that before logging in — after two
runs concluded from local pathing failures that the starter valley was walled.
It names no destination, direction or timing; what to do when a move fails is
strategy and stays out.

**A harness message addressed to the model is delivered by the harness**
(2026-08-29), on a channel the model's code cannot drop: one run took 41
refusals carrying the hint that would have unstuck it and read none. The
channel is in addition to the hint in the result, never instead of it.
Hints are SDK surface (operator, 2026-10-28).

**A character with no way out has the client's own** (operator decision,
2026-10-28). A ghost dropped into a crevice whose every exit was a climb,
with no spirit healer near and its corpse far off, had no legitimate move
left; a player there presses Help → "I'm stuck". `unstuck()` sends what that
button sends, the Stuck spell through the ordinary cast handler, and the
server decides the move. It acts only on a second call within a minute, the
first sending nothing and saying what will happen. It is in the SDK
reference like any helper, and by the same decision not in the prompt.

## Context policy

One fixed context for every model (`runner/src/context.ts`): the fixed system
prompt, a window of recent messages trimmed in blocks so the provider cache
prefix survives, and one fresh deterministic message — the turn number,
harness notices, a HUD summary of already-observed fields, recent events and
the full scratchpad. It restates no goal: the directive is the system
prompt's alone, so nothing per turn competes with an objective (operator,
2026-10-23). Within the window only the most recent block is verbatim: in the
older block each tool result is folded to a deterministic one-line record —
tool, arguments cut short, ok or error, duration where known — while the
model's own calls stay as sent (operator, 2026-10-19). Kept verbatim, one
timeout hint rode about twenty requests. The fold moves only at a trim, so it
breaks no cache prefix of its own, and the last two turns are never folded, so
a result is read in full on the turn it arrives and the turn after. The CLI
scaffolds keep and compact their own conversation, so neither the trim nor the
fold applies to them. One CLI driver turn can run for hours, which leaves the
HUD seen at its two ends only, so on claude-code each snippet result ends with
what changed since the previous one: party members' transitions, chat from
others, damage taken, level and quest changes, at most 600 characters, and
nothing when nothing changed (operator, 2026-10-21). Codex and pi do not take
it yet, and the fixed loop never does, since it rebuilds the HUD every turn. Old turns are dropped, so the scratchpad is the only durable
memory and the prompt says so; models with weak note-taking underperform at
equal reasoning strength, which is signal, not bias. A write that would take
the scratchpad past its 32,000-character cap is refused and saves nothing,
never truncated, and every turn shows its size against the cap (operator,
2026-10-14). Model-driven summarization was rejected because the summarizer
becomes an unversioned, model-dependent part of the harness. Any constant in the policy is a harness
version change.

**Reflection is the model's to take, and only at rest or in flight** (2026-08-30). A
`reflect` tool spends a turn thinking instead of acting, only while the
character is in a client-visible rest area — never mid-combat, always among
the NPCs a player visits anyway — or on a taxi flight, once per rest visit or
flight (operator, 2026-10-14): the flight flag is client-visible, a passenger
cannot fight, and a flight is minutes of otherwise idle turns. It returns a
fixed, content-free prompt and the model writes the outcome into its own
scratchpad; the harness summarizes nothing. Reflect turns count like any
other: a free turn would invite gaming.

**An episodic log, asked for at each trim or compaction, read back at rest or in flight** (2026-08-30).
On the last turn before a block-trim the harness asks for a short status entry
— append-only and harness-stamped, a record the model cannot edit, unlike the
scratchpad — readable only while reflecting: newest first, filterable by level
and zone, and pageable back to the first entry (operator, 2026-10-14). The
trigger is the loss of context, not a cadence constant. The CLI scaffolds have
no trim, so theirs is the CLI's own compaction (operator, 2026-10-14), with the
same entry, cap and stamps: the harness asks before it where the usage the CLI
reports predicts it, and right after an observed one otherwise. The asymmetry
left between harness groups is that a CLI ask is a prediction from outside the
loss, and can land after it.

## Episodes, lanes, and evidence

**Reset is a fresh character.** Every scored episode starts with a freshly
created level-1 character, because a mid-level start would skip the state a
real character has. The model names it, since nothing about the name is
measured; race and class are the episode's, because every run is read against
them.

**A knob is legitimate as a run dimension**: set per run, recorded, identical
in shape for every model. Effort, objective, `wikiCoords`, routing and the
episode id are dimensions; `opus at low` and `opus at high` are two comparable
rows, not one tuned model. Everything is stamped into one comparability tuple
at launch (`runner/src/comparability.ts`) and never recomputed; a run written
before a field existed reads `null` forever. **A fact observed after launch
annotates the tuple; it never keys it.** The model id a CLI alias resolved to
and the provider that actually served a request are recorded on first
observation, never revised, and excluded from the tuple's equality test; old
runs are back-filled at *read* time, never written back — read differently,
not relabelled. The wiki bundle's identity has the same standing: it says
which file a run read, and so which side of a text-changing rebuild a run sits
on; the rebuild itself ships as a patch within the series.

**Routing is pinned, and it is config** (2026-09-16). One slug served by six
backends is six machines and six caches, not one measurement. The default is
the model author's own provider with fallbacks off; a third-party provider is
a deliberate, named datapoint, and a run a named provider cannot serve fails
rather than moving. The *requested* routing is a KEY in the tuple: pinned and
unpinned runs do not share a chart.

**Steering is what makes a run unscored.** An objective is operator-authored
world knowledge rendered into the prompt at one fixed place, so any run with
one is stamped unscored and cannot drift into a chart. An objective replaces
the broad goal for that run rather than adding to it, and since such a run is
already unscored, no eval prompt changes (operator, 2026-10-21). `wikiCoords` defaults
to false: exact yards from the wiki are an answer key for the "find things"
rungs, and without them a model must read "in the inn at Goldshire", walk
there and look. Harder is the point; if the names-only ladder proves
unclimbable the pull-back is a labeled coords tier, never a silent change.

**The reference wiki is a capability, and a run may be configured without it**
(2026-09-16). `wiki: false` is an off switch, not a factorial arm: it removes
the retrieval channel and leaves the memorised one untouched, so it isolates
nothing about priors. A different condition is a KEY in the tuple; the field
is absent on runs that have the wiki, so older runs stamp as they did.

**Three lanes, separated by what a series bump does to them.** Evals (`e90`,
`e360`) re-arm on every bump and feed the charts; probe campaigns run a
commissioned sweep to completion and are never re-armed; freeplay never
finishes and never counts. Each episode id is a comparability group, and a
wrong default is replaced by a *new id*, never widened in place, because
widening silently re-scopes every existing score. A probe exists only as a cell
and an arm of a versioned campaign definition committed to git; a published
version never changes, so any change is a new version, for the same reason
(2026-10-09; arms 2026-10-11).
Definitions: `docs/EPISODES.md`.

**A lapsed run is evidence only if its lane says so; everywhere else it is a
failed attempt.** A run that pauses or goes quiet stops without a verdict, and
what happens next is the lane's property. Scored lanes end it and the model
gets a fresh attempt with a full clock: an `e90` is ninety minutes of *play*,
and a run that paused at minute 41 and came back two hours later is not that.
Freeplay resumes because it never counts; a probe resumes only if its campaign
says so. A failed attempt is visible with its reason but is never a recorded
episode, and only the termination reason decides what it counts as: a
provider's refusal is a strike (three on one model, episode and series stop
the scheduler — evidence about an endpoint, not a model), a fleet stop or an
offline gap is harness weather, and a transport failure mid-episode
(`adapter-error`) ended the run on the endpoint's clock, so it is never scored
(2026-08-30).

**The tier is the evidence budget.** How much a model runs is one word on its
roster entry, denominated in runs, and the only thing that sets a run count:
`t0` trial (one `e90`, held), `t1` standard (three), `t2` long (three plus one
`e360`). Promotion is a threshold applied to every model alike — one counted
`e90` reaching level 5 climbs `t1` to `t2` — never a judgement. Billing buys no
runs and costs none; it decides only where a run may execute, and money caps
are external to the fleet by decision; subscription usage is the one cap inside
it: a scored launch on a subscription lane holds, and freeplay pauses and does
not start, at a configured share of the usage window (operator, 2026-10-16).
Mechanics: `docs/RUNBOOK.md`.

## Scoring

**The goal prompt is deliberately broad** — progress the character: level,
gear, quests, wealth, capability — and never names a statistic a model could
Goodhart. WoW cooperates: there is nowhere to reach max level standing still,
so the broad goal has a real gradient. Its wording changes only at a harness
boundary.

**The harness records a signal vector, not a score** — level curve, XP,
quests, money, deaths, position, spells, playtime, achievements, flights, event
and turn counts — **and scores are derived offline, versioned, recomputable.**
Changing a derivation invalidates nothing; changing the recording or the prompt
does, so a claim the ladder wants to make later has to be in the recording
first, and Goodhart pressure moves to the derivation author, where it can be
revised without re-running anything. A run that predates a signal carries no
reading for it, and a derivation treats that as *not recorded*, never zero.
The ladder orders on three separate numbers — highest rung, the `(level, xp)`
pair, gold — and no aggregate score.

**The ladder shows its dispersion, and one reference line: a scripted run
through the SDK** (2026-09-16, 2026-09-18; operator, 2026-10-19). A row's
maxima are over runs already paid for, so the row also says how many reached
each rung and the range of levels they spanned. An empirical ceiling and a
human speedrun band were withdrawn because one human entry per category is not
enough data to earn the space; the figures stay in `docs/PUBLIC-DASHBOARD.md`
("The human reference") and return when there are several runs to state a
distribution from. What is drawn instead is a ceiling on what the surface
allows (operator, 2026-10-19, reversing the 2026-09-16 line that no scripted
agent is built and nothing new is run): one scripted reference run per harness
series, a TypeScript program against the SDK played from a fresh level-1
character through `run_snippet`, in the models' sandbox, session, contracts
and snippet timeout. A human speedrun says nothing about what the SDK lets a
player do; this does, so a model's movement across series can be read against
the surface's own. It is stamped and never scored — outside every
comparability group, never in the row order, never counted toward a target —
and is shown only as a labelled line. The program itself is a solution to the
episode on this SDK, so it stays out of the public tree (operator,
2026-10-20): the repository keeps the driver hook, the stamp and the counting
rules, and the operator's runner image carries the program.

**A ladder belongs to a comparability group.** `probing` has none
(2026-08-29): a campaign varies its cells on purpose, so ranking its runs ranks
the sweep, not the models. The freeplay ladder is an overview, not a
leaderboard (2026-08-29): the whole active field, paused and in-progress
characters included, one row per character across attempts, with the reader's
filters applied — except the series, because a character is durable across
series and cutting its older attempts would misreport its age.

**The character is the universal unit, and a scored run is a character of one
attempt** (2026-09-16). Every run belongs to a character, so the scored case is
the degenerate one rather than an exception; "stream" is retired for
"character", a consolidation and not a change of meaning.

**No single number is promised**; the honest artifact is the scorecard.

## The reference bundle

The agent's out-of-game knowledge is a search tool over a bundle built from a
2020 wiki dump — wiki reference, not ground truth, framed that way in the tool
description, which also states once that the world is 3.3.5a.

**The bundle is a Wrath snapshot.** What is not patch 3.3.5 is removed at
build time by deterministic, self-counting rules, so removal is verifiable by
rebuilding. Labels were rejected: a note costs every snippet a line, does not
survive a snippet window, and leaves the wrong world in the index. **The quest
ender is never inferred from the giver**: guessing manufactures a confident
wrong answer in precisely the case the field exists to fix. **The build may
ask the world DB whether an id exists, and nothing else**; the agent still
sees wiki text and only wiki text. Rules and counters: `wiki/README.md`.

**Within a harness series, a bundle rebuild that changes page text ships as
a patch** (operator, 2026-10-16). The bundle's self-description is stamped on
every run, and its build time marks which runs read the text before the
rebuild and which after.

## Known limitations

Five things a reader of the ladder cannot see from it, each bounding what a
number here means.

**Contamination is assumed, not controlled.** Every model measured here has
read fifteen years of walkthroughs for this content, and no probe separates
recall from reasoning. That is survivable only because the claim is driving a
fixed toolkit, not knowledge of an unseen world: knowing where Kharanos is
counts as part of the model, as the standard library does on a coding
benchmark. The names-first rule governs the *harness's* leakage and is not a
contamination control.

**Most rows are one to a few runs, and that is a budget.** An entry's `n` is
usually one and never more than three, printed beside it; one run has spread,
and a gap of a level or two sits inside it. The cap is what the operator can
pay for today, expected to rise as episodes get cheaper (2026-09-19).

**There is no floor.** The scripted reference run is a ceiling; no scripted
floor or baseline has run through this harness, so nothing distinguishes a
model that planned well from one that remembered a guide or simply held the
SDK correctly. Until one does, a rung means "a model got here", never "this is
hard".

**Provenance is stamped, and partial.** Every run carries the harness build
and the comparability tuple — series, prompt hash of the rendered bytes,
harness tag, effort, episode id and budget, objective presence, `wikiCoords`,
`wiki`, routing, bundle identity, module build. Not yet: a hash of the SDK
source, the AzerothCore pin, the contract version, the compose configuration.
A run is traceable to a build of this repository, not yet to one manifest
naming every version it depended on.

**A CLI-scaffold run's cost is not comparable to an API-driver one.** The CLI
harnesses run one growing conversation rather than the fixed window and bill a
flat subscription rather than metered tokens; a codex run reports no cost at
all and is shown a list-price estimate marked as-if-metered — a comparison,
not a bill (2026-09-05; `docs/COSTS.md`).

## Changing this document

A change to anything above is a change to what the benchmark measures, and it
is made only on the operator's explicit direction — never on an agent's own
initiative. An edit here records a decision the operator made; work that
would require changing or contradicting one stops and puts the question to
the operator first. Surface, prompt, context policy, contract, or bundle-text
changes move the harness version (minor at least; contract widenings are
major); scheduling and derivation changes do not, but are still dated edits
here or in the owning doc. Keep this document a north star — a rule and its
why, mechanics in the owning doc: fold a new decision into the section it
belongs to, prune what it obsoletes, and let git history hold the past.
