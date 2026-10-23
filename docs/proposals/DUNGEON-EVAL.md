# A scored dungeon episode: the Deadmines

**Status: proposal, not a decision.** Nothing here is set up, scheduled or
recorded anywhere. It writes down what a scored party episode built on the
Deadmines campaign would be, so the operator can decide it piece by piece.
Every choice that would shape what a result means is the operator's
(`docs/METHODOLOGY.md`, "Changing this document"); this page offers options
and decides none. `docs/METHODOLOGY.md` and `docs/EPISODES.md` are untouched.

It rests on the Deadmines probe campaign (`docs/proposals/GROUP-PLAY.md`;
`runner/campaigns/deadmines@1` to `@4`): five agent loops of one model, one
staged level-20 character each, pre-formed as a party beside the portal,
told to clear the Deadmines and defeat Edwin VanCleef.

## The evidence

What the campaign showed, from the recorded runs:

| | Sonnet 5.5, several parties on `deadmines@1`–`@3` | Opus 5.5, `fleet-deadmines-party-base-claude-opus-5-5-20261021-a2-*` |
|---|---|---|
| Outcome | Never cleared | Cleared: VanCleef dead 2h03m after launch |
| Bosses | Best party killed Rhahk'Zor once | Rhahk'Zor at 33 min; Sneed's Shredder and Sneed at 1h11–1h12; Gilnid 1h31; Mr. Smite 1h51; Captain Greenskin 2h01; VanCleef 2h03; Cookie 2h07, after the clear |
| Wipes and deaths | — | Six full wipes in the first 51 minutes, almost none after; 6–8 deaths per member; roughly 20–25 minutes of each member's clock spent dead |
| What changed | One party gave up and left to level in Westfall | After the sixth wipe the party adapted: single Taunt pulls by the tank, crowd control on call in party chat |
| Cost | — | About $8–11 as-metered per member on the Claude Code driver, $40–55 per party |

Three harness facts from the same run bound what it says about the model:

- Every member was still on its *first* driver turn when VanCleef died. On
  the CLI scaffolds the HUD reaches the model once per driver turn, so each
  member read the harness's state summary once in two hours and played from
  its own snippet results and chat.
- One member lost 29 minutes to a server-side root bug, since fixed. A later
  member-minutes-dead figure for that run is a bug's number as much as the
  model's.
- The run ended `manual`: `deadmines@3` had no kill end, nothing ended the
  five runs after the clear, the tank walked on to Stormwind, and the
  operator's stop recorded a failed attempt that is not counted. `deadmines@4`
  adds the `kill-target` end on VanCleef (entry 639), so a clear now ends all
  five as one counted verdict (`runner/src/end-conditions.ts`).

And one staging flake was seen across the rounds: a party whose stager did
not put every member in place, which the roster turns into five
`launch-failed` stubs and no run.

## 1. What it measures

The solo ladder asks how well one loop drives the SDK toward a broad goal
over a long horizon. This episode asks three things the ladder cannot:

- **Coordination among copies of one model.** Five loops, five contexts, one
  channel: party chat, whispers and what each one sees. Nobody holds the
  whole picture. Who pulls, who waits, who tells the healer they are out of
  mana, is decided in chat or not at all. The Sonnet parties mostly did not
  decide it; the Opus party did, after six wipes.
- **Sustained tactical play.** A dungeon is one fight after another against
  elites that kill a careless party, for two hours, with no rest area and no
  quest log to lean on. The solo episodes reward route knowledge and
  persistence; this one punishes a tank who runs ahead or a mage who pulls.
- **Recovering from wipes.** A wipe is a corpse run through the mine, a
  regroup at the portal, and a new plan, five times over. The record shows
  whether a model changes what it does or repeats it — the Opus run's six
  wipes then none is the shape of the signal.

What it does **not** measure, and should say so wherever the board is drawn:

- Not levelling, route-finding, questing or economy — the start is staged at
  level 20 in green gear, and the solo ladder owns all of that.
- Not the model's knowledge of the Deadmines: every model has read the
  walkthrough, as every model has read Elwynn's (`docs/METHODOLOGY.md`,
  "Known limitations"). Knowing the boss order is part of the model.
- Not play against another model, and not play with a human: five copies of
  one model are the party, by design (§4).
- Not SDK fluency as such, though it confounds here as it does everywhere,
  and more: a member who cannot write a working pull routine wipes four
  others.

## 2. Episode shape

**Id.** A new scored episode id, beside `e90` and `e360`, with `scored:
true` and its own comparability group. A working name is `dm240` — the
dungeon and the clock, the way the solo ids name their clock — and the name
is the operator's. It is a *new id*, never a widening of `probing`: the
campaign's runs stay unscored where they are. Like the two solo ids it
forbids per-run steering, carries no `extra`, and re-arms on every harness
series bump. Where it sits in the roster's evidence budget is an open
question (§7): the tiers are denominated in `e90`/`e360` runs, and a dungeon
attempt is five pods for four hours, so it is either a new word on the
roster entry or something `t2` buys.

**Staging.** As the campaign stages it, frozen as part of the id: Alliance,
level 20, a Human Warrior tank leading, a Dwarf Priest healer, a Human Mage,
a Human Rogue and a Dwarf Retribution Paladin, each in its quest-green
loadout with preset talents (`infra/fixtures/loadouts.ts`), on the
`moonbrook-mine` scenario a few yards from the portal, pre-formed with the
warrior leading. The staging scenario and the loadouts are versioned and
stamped on every member (§4); a changed loadout is a new version, and a
changed composition is a new id.

**Prompt.** The world facts, then the clock, then the directive, then the
body every run gets — the shape `buildSystemPrompt` already renders for a
steered probe (`runner/src/prompt.ts`), with the directive in the delimited
objective block in place of the broad goal:

- The directive is the campaign's §8 text, per member, with the names filled
  in: who the five are, which one you are and your role, where the party
  stands, that the objective is to clear the Deadmines and defeat Edwin
  VanCleef, and that you share party chat. It names the task and says
  nothing about how to play it.
- The clock is one sentence, "This episode lasts four hours.", a new case in
  `episodeSection`, which is exhaustive over the ids on purpose.

This is the one place the proposal touches a methodological rule, and it is
flagged rather than resolved: **"steering is what makes a run unscored"**
(`docs/METHODOLOGY.md`, "Episodes, lanes, and evidence"). The rule exists
because an operator objective is per-run world knowledge an operator chose to
give one model. Here the directive is pinned by the episode id, byte-identical
for every model and every attempt, part of the prompt hash, and no operator
authors anything at launch. The proposal's reading is that it is a fixed
directive and not steering, in the sense the rule guards against; whether the
rule is worded that way is the operator's decision (§7, question 1). Until it
is, the episode cannot be scored.

**Budget and leash.** The campaign's: four hours of wall clock, idle 20
minutes per member, the no-XP watchdog off (a party spends its XP-less
minutes on corpse runs and regroups, which is the behaviour the episode
exists to permit), the 8000-call runaway guard. Four hours is generous
against the one clear at 2h03m with six wipes and a 29-minute bug inside it,
and against a human party's one to one and a half hours; three would have
sufficed for that run and would cut a wasted attempt by a quarter. Time to
clear is recorded either way, so the clock sets only how long a slow party
is given. Options: four hours (what the evidence was gathered under) or
three; the operator's call (§7).

**Ends.** The first met ends all five runs on one reason:

- `kill-target` on a kill of VanCleef (entry 639) credited to any member:
  the clear, counted. The achievement "Deadmines" (628) earned per member is
  a second, independent server statement of the same fact.
- `episode-limit`: the clock ran out, counted as not cleared.
- A member's `idle` or `tool-call-limit`: the model stopped on one loop, and
  the roster ends the other four `party-ended`. Proposed as counted, not
  cleared, as idle counts on `e90` — the model is the one that stopped — with
  the asymmetry stated: one quiet member ends four that were playing. The
  alternative is a failed attempt, retried fresh, which is kinder to the model
  and costlier to the operator (§7).

**What counts as a scored attempt.** A party is one attempt, as the campaign
counts it: every member on disk, none `launch-failed`, none still in flight,
all five ended on the same counted reason. The record is the five members'
trajectories linked by the party id; the row is the party.

**What does not count, and what is a strike.** The lane rules carry over
unchanged (`docs/METHODOLOGY.md`, "A lapsed run is evidence only if its lane
says so"):

- **Not counted, not a strike, retried fresh:** a staging failure (five
  `launch-failed` stubs — the stager is the harness); an operator stop
  (`manual`); a fleet stop or an offline gap; `harness-error` on any member;
  `adapter-error` on any member (the endpoint's clock, as on `e90`); a pause
  in this lane, since a scored episode does not resume. Each is a failed
  attempt, visible with its reason, never a row.
- **A strike:** a provider's refusal (`quota-exhausted`, `rate-limited`) on
  any member. Proposed as one strike per party attempt, not one per member:
  five sessions on one lane are five chances to meet the same endpoint fact,
  and five strikes from one launch would taint a model on the evidence of
  one window. Three strikes stop the scheduler for that model, episode and
  series, as today. The Opus run logged 22–23 rate-limit *notices* per
  member without a refusal; the pressure is real and the strike rule should
  expect it.

## 3. Scoring

**A signal vector, recorded by the harness, derived offline, versioned**
(`docs/METHODOLOGY.md`, "Scoring"). Every signal below is already in the
record or one derivation away from it; nothing needs a new tap:

- **Cleared**: yes or no, from the `kill` milestone of entry 639 credited to
  the party, cross-checked by achievement 628 per member.
- **Time to clear**: launch to that kill, for a cleared row. Launch is
  proposed as the origin because staging is a minute from the portal; the
  first `instance entered` is the alternative (§7).
- **Bosses killed**, as the set of the eight boss entries (644 Rhahk'Zor,
  642 Sneed's Shredder, 643 Sneed, 1763 Gilnid, 646 Mr. Smite, 647 Captain
  Greenskin, 639 VanCleef, 645 Cookie) with the time of each, from the union
  of the five `kill` series. The *sequence* is recorded, never scored against
  a canonical order: the Opus party killed Cookie after VanCleef, which is a
  fact about how it played and not a fault.
- **Deaths and wipes**: deaths per member and in total; a wipe derived as a
  window in which every member has a death after its last resurrection.
- **Member-minutes dead**: the sum over members of death-to-resurrection
  intervals. In the Opus run roughly 20–25 minutes per member, 29 of one
  member's from a server bug now fixed.
- **Cost**: metered on an API driver, as-metered on a CLI scaffold, and never
  compared across the two (`docs/METHODOLOGY.md`, "Known limitations";
  `docs/COSTS.md`).
- Recorded and shown, not ordered on: tool calls, turns, party-chat lines,
  minutes outside the instance after the first entry.

**A separate board, not the solo ladder.** The ladder's rungs are a solo
character's; a party of five staged level-20s belongs on none of them. The
dungeon board is its own page with one row per (model, effort, harness),
grouped by series like the ladder, each row showing `n`, how many of `n`
cleared, and the spread of the ordered numbers. The ladder's rung 6, "a
5-man dungeon cleared by a party of agents" (`dashboard/src/lib/ladder.ts`),
could read a counted clear on this board as its test; whether it does is the
operator's (§7).

**Ordering.** The ladder orders on separate numbers and no aggregate; the
board should do the same. Partial clears are the awkward case, because the
bosses are not strictly linear (Cookie sits off the path to VanCleef).
Options, for the operator to choose among or reject:

- **A.** Cleared before not cleared; among cleared, time to clear ascending;
  among not cleared, distinct bosses killed descending, then time to the last
  boss ascending. Deaths, wipes and member-minutes dead are shown and never
  ordered on.
- **B.** As A, with wipes ascending before time among cleared rows: a clean
  clear in 2h30 above a six-wipe clear in 2h03. This ranks how a party
  played, not only whether it got there.
- **C.** Cleared, then distinct bosses, then nothing: ties stand, and the
  rest is read off the row. The most conservative reading of "no aggregate".

Under any option a row's maxima are over the attempts already paid for and
its dispersion is printed beside them, as on the ladder. And in every option
the derivation is versioned and recomputable: choosing A today and B later
re-runs nothing.

**Scoring is the operator's decision.** The vector above is what the record
can say; which of its numbers order a board, and whether a board is drawn at
all before §6 is met, is not proposed here.

## 4. Comparability

**The tuple.** Every member run stamps the existing fields (series, prompt
hash, harness tag, effort, episode id and budget, `wikiCoords`, `wiki`,
routing, bundle identity, module build) and gains:

- `party`: the party id that links the five rows, the member's role, and the
  composition as five (role, race, class) entries;
- the staging scenario and its version (`moonbrook-mine@N`), and the loadout
  version (a version on `infra/fixtures/loadouts.ts`, or its content hash);
- the party's `kill-target` entry, so a later dungeon never pools with this
  one by accident.

Two parties compare when they share the episode id, the series, the
harness tag, the composition, the staging version and the loadout version.
A changed loadout is a new version and a new group; a changed composition
is a new id. Stamped at launch, never recomputed; a member run from before a
field existed reads `null` for it forever.

**Re-arming.** As `e90` and `e360`: a new harness series restarts the
evidence and the scheduler owes the model its attempts again. A fix commit
does not. The clock, the watchdogs and the composition are the id's pins, so
changing any of them is a new id, not a series bump.

**Five copies of one model, not a mixed party.** The model is the only
variable within a harness (`docs/METHODOLOGY.md`, principle 3). A mixed party
produces a result with no row to put it on — it is a property of the mix,
and a weak healer under a strong tank measures neither. It also changes the
question: coordinating with copies of yourself, who reason as you do and
read your chat as you would write it, is the cleanest form of the
coordination question, and the one a single row can answer. Mixed parties
are a probe campaign's question, never a scored one.

**Per-driver differences.** Each CLI scaffold is already its own
comparability group, for its own unversioned compaction. In a dungeon the
difference is larger than in a solo run: the fixed loop hands every member
the HUD every turn, while a CLI member sees it once per driver turn and
otherwise plays from snippet results and chat. The Opus clear was five
members each on driver turn 1 for two hours. Until that cadence is settled
(§6) a CLI row on this board measures the scaffold's turn structure as much
as the model, and the board should say which harness each row ran under in
the row, as the ladder does, never pooling across tags.

## 5. Cost and lanes

An attempt is five loops for up to four hours: five run pods, five accounts
(`PARTY1`–`PARTY5` today, so one party at a time until a second set exists),
and five model sessions drawn from one lane.

- **Subscription lanes** (Claude, Codex, Go): $0 marginal, and the only cap
  is the usage gate — a scored launch holds at a configured share of the
  usage window. Five concurrent sessions on one OAuth token draw one window
  five times as fast; the Opus party read $40–55 as-metered for a 2h19m
  attempt and logged rate-limit notices throughout. A full four-hour attempt
  that does not clear costs more. One attempt per lane per usage window is
  the realistic cadence, and the lane cannot run solo evals meanwhile.
- **API lanes**: metered. A cheap model of the DeepSeek V4.1 Flash class ran
  an `e360` for about $2.38, so a four-hour party is on the order of $8 and a
  three-attempt row about $25 (`GROUP-PLAY.md` §7). A frontier API model at
  Opus-class prices is the as-metered figure above, $40–55 per attempt, $120–
  170 for three, `paid.maxConcurrent ≥ 5` and a routing pin that serves five
  sessions.
- **Attempts per model.** Three, as `t1`'s solo budget, is the floor that
  earns a row with any dispersion; one clear in one attempt is a witness, not
  a row. At three attempts per model and one party at a time, a lane gives
  about one model a day. A roster of ten models is two weeks of lane time or
  a few hundred dollars of API, before any retry.

## 6. Readiness gates

The episode measures the model only once the harness stops showing in the
record. Each of these is a gate on *scoring*, not on building:

1. **HUD cadence on the CLI scaffolds.** Once per driver turn is once per
   two hours in this episode. Either the harness delivers the HUD on a
   cadence the model can play from on every driver, or the board admits only
   the fixed loop at first. Settled by a campaign arm, not by argument.
2. **Sleep and wake tuning.** A member that sleeps blind through a pull, or
   wakes on every regen tick, is a harness effect on deaths and wipes. The
   wake reasons exist (`attacked`, `died`, `chat`); the tuning is the open
   part.
3. **No open server bugs on the critical path.** The root bug that held one
   member dead for 29 minutes is fixed; the next full attempt should show no
   member dead for a bug's reason, and the smokes that guard the fix stay in
   the gate.
4. **Party frames in a full run.** The out-of-sight member stats landed after
   the Opus run; one full attempt should show that a ghost at the graveyard
   is no longer a seven-minute "are you there?" in party chat.
5. **Staging reliability.** One flake was seen. A failed staging already
   classifies as not counted, so it costs no evidence, but it costs a lane
   window; the stager should verify its five members (level, position,
   gear, group) before the launch and retry once, so a flake is a log line
   and not an evening.
6. **Variance.** One clear by one model and none by another is a difference
   between two models at `n` of one and several. No row before three counted
   attempts on a settled harness, and the board prints `n` and the spread
   whatever the rule.
7. **A final campaign arm as the dress rehearsal.** Run the exact shape this
   episode would pin — the clock, the leash, the end, the staging and
   loadout versions, the directive — as one more Deadmines campaign version
   on at least two models, three parties each, and promote only when the
   harness-fault rate across those attempts is zero: no `harness-error`, no
   staging failure, no bug-caused death, no member whose HUD cadence the
   trajectory shows mattered. The campaign's rows stay unscored; what
   graduates is the shape.
8. **The methodological decision** of §2 on the fixed directive, recorded in
   `docs/METHODOLOGY.md` by the operator, and the episode's budget word.

## 7. Open questions for the operator

1. Is an episode-pinned directive, identical for every model and part of the
   prompt hash, compatible with "steering is what makes a run unscored", or
   does that rule need an explicit exception for this id before it can score?
2. What is the episode id, and what buys an attempt: a new word on the roster
   entry denominated in parties, or a promotion from `t2`?
3. Four hours as in the campaign, or three?
4. Which ordering, if any, does the board use: A, B, C, or none until more
   evidence exists?
5. Does time to clear start at launch or at the first instance entry?
6. When one member goes idle or hits the call ceiling, is the party's attempt
   counted as not cleared, or a failed attempt retried fresh?
7. Is a provider refusal one strike per party attempt or one per member?
8. Is the composition fixed for the id as staged today, with any other
   composition a new id?
9. Which harnesses are eligible at first: the fixed loop only until the HUD
   cadence is settled on the CLI scaffolds, or all of them with the tag shown?
10. Does a counted clear on this board satisfy ladder rung 6, and by what
    rule?
11. Does Cookie count toward partial progress, or only the bosses on the path
    to VanCleef?
12. What is the minimum `n` before a row appears on the board?
