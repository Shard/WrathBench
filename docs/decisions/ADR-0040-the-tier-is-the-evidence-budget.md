# ADR-0040: The tier is the evidence budget

Status: Accepted. Date: 2026-08-24. Supersedes the scheduling half of ADR-0034
(account classes, the defer ladder, series keying and the paid throttle stand;
its targets, promotion rule and extras are replaced here). **This is the single
statement of how much a model runs.**

## Context

ADR-0034 was written on 2026-08-23 and amended six times inside a day. Each
amendment was sound on its own and each added another optional block to
`policy`: per-entry `runsPerEpisode`, `policy.paid.runsPerEpisode`,
`policy.extras.characters`, `policy.extras.local`, `roster.<name>.tiers` as a
force. Four of them answered one question — how much does this model run — and
they could disagree with each other.

The bill came due trialling a new paid model on the minimum eval. It should
have been one line. It took a per-entry `runsPerEpisode: {e90: 1, e360: 0}`, a
queue job split into two jobs, an account-class dance, and four rounds of test
failures. Worse, it left the board saying

```
gpt-luna  paid  promoted  1/1 L6  0/0
```

— the projection asserting the model had earned `e360` and the target asserting
it would never run one, with nothing reconciling them. That is not a bug in
either half. It is what happens when a **gate** is encoded as a **target**
because the config has no way to say "this model is on trial".

## Decision

**A tier is a statement of how much evidence a model gets, denominated in
runs, and it is the only thing that sets a run count.**

| tier | budget | promotion |
|---|---|---|
| `t0` trial | e90 x1 | **held** — never climbs on its own |
| `t1` standard | e90 x3 | climbs to `t2` on one counted `e90` reaching the promotion level |
| `t2` long | e90 x3 + e360 x1 | top rung today |

`roster.<name>.tier` is **required** on every entry the policy can schedule and
**refused** on one carrying an `objective` — a steered entry is outside the
policy (ADR-0033) and has no budget to state. Required rather than defaulted
because with a default, adding a model and forgetting the field quietly buys a
full budget, and for a paid model that is money nobody approved.

**The table is code** (`TIER_TABLE`, `runner/src/models.ts`), beside `EPISODES`.
A budget every model is held to alike is a recorded decision — the same
argument that made promotion a threshold rather than a judgement (ADR-0034) —
and a bespoke volume is a **named tier added to that table**, reviewed like an
episode id. There is deliberately no per-entry override: one would rebuild the
precedence maze this record exists to remove.

**Billing stops being five decisions.** It kept target base, account class,
extras eligibility, the paid cap and the concurrency key. It keeps only the two
that are about **where a run may physically execute**: the account class and the
rate-limit key. Paid-ness buys a model no runs and costs it none, so there is no
per-billing target table and no `policy.paid.runsPerEpisode`. A paid model is
trialled by giving it `t0` — the same sentence a free model's budget is written
in — and promoted by an operator deciding to spend.

**Eligibility falls out of the budget.** An episode a tier buys no runs of is
not one the model may be scheduled on. One statement, so a target of zero and
"not eligible" can never disagree again.

**The witness is kept apart from the ladder.** `earnedRung1` is what a model
EARNED; the tier is where it was ADMITTED. A `t0` model that reaches level 5
keeps its rung — `--status` shows `t0*` — and spends nothing. Moving it to `t1`
promotes it *immediately*, on evidence it already has, with nothing re-run.
Conversely an operator may hand-place a model on `t2`: it becomes eligible and
it never reads as promoted, because **"promoted" is said only of a climb**.

`t0` is not rung zero. It is a pen beside the ladder: a trial model is not
unpromoted, it is not admitted. That framing is what makes the status line
legible — `t0* · rung 1 earned · ladder held` — where the old table could only
manage `promoted, 0/0`.

**Idle work becomes one axis.** `roster.<name>.idle` is `none` (default),
`characters` (another scored run of an eligible episode, next race/class in
`IDLE_CHARACTERS`) or `unlimited` (one freeplay session at a time). It replaces
both `policy.extras.characters`'s implicit scope and `policy.extras.local`'s
class-conditional branch, under which the same model meant different things
depending on which account it landed on and a non-local model could not take
freeplay at all. Default `none`, so idle work is never bought by omission.

**An `unlimited` session carries a six-hour clock on every class.** Local
extras used to be unbounded on purpose. That is wrong now it is not local-only,
and it was already sharp: a class governs the next pick and never a run in
flight (ADR-0034), so a session ended only by a 20-minute idle watchdog — which
a model that keeps playing never trips — holds its account indefinitely, and
after a series bump the re-armed targets queue behind it forever. Six hours is
`e360`'s constant and the id pins no clock of its own, so nothing about
comparability changes. Long-horizon continuity is meant to come from **resuming
the character**, not from one run that never ends (FOLLOW-UPS 67).

**`idle: "characters"` is a designation, not a default for free models.** The
cycle is indexed by the model's own extras count (`chars[n % chars.length]`),
so it walks the eight race/class cells one model at a time. Turning it on for
every free entry therefore does not sample the matrix — it gives each model its
first cell, and eight models produce eight Human Warriors. The matrix only
exists if one model stays on it long enough to reach cell eight.

So the shipped 0.5 config names one per rate-limit lane: **`ox-alpha`** on
OpenRouter and **`x-preview-f`** on OpenCode. Both have met their e90 targets
and both already have extras on the board, so neither pick is speculative; and
because `maxConcurrent` is 1 on each lane, one per lane is also the most that
can ever run at once. Every other free entry is `none`. This costs nothing
already recorded: extras counts come from run facts on disk (`f.extra`), not
from the config, so the history of a model moved to `none` stays on its row.

**The retired keys are refused by name**, not ignored: `policy.runsPerEpisode`,
`policy.paid.runsPerEpisode`, `policy.extras`, per-entry `runsPerEpisode`, and
`roster.<name>.tiers`. A file still carrying one meant something specific by it,
and silently dropping it would re-scope a budget someone wrote on purpose.

## The boundary this record refuses

**A tier is denominated in runs.** The trial cap that prompted all this existed
because "3 e90 + 1 e360 on luna measures ~$10, the whole daily budget" — the
operator reasons in dollars and run counts are a proxy. When a money budget is
wanted it is **a spend cap beside `policy.paid.maxConcurrent`**, never a tier.
Minting `t0a`/`t0b` to approximate dollars is the accretion this table exists to
stop. Hard cost control is external to the fleet by decision (2026-08-24).

`t3` is reserved and deliberately unimplemented: deeper sampling wants a
criterion, and rung 2 of the game ladder — the travel rung — is not instrumented
(FOLLOW-UPS 35). When it is, `t2 → t3` gets a real witness.

## The harness series does not bump

Counting, targets, promotion witnesses and the ladder key on the series
(ADR-0034), and `harnessSeries`'s own contract is that **a minor bump is a
change to what the run measures**. This changes what gets *scheduled*, not what
any run measures: the comparability tuple — episode, budget, watchdogs, effort,
harness, objective, prompt hash — is untouched, and targets are stopping rules,
not measurements. The board already tolerates unequal sample sizes across
models. So the series stays `0.4` and the evidence on the board survives.

The invariant, stated precisely, is the thing to check on review:

> The counted-run set, the promotion witnesses, and every run's comparability
> tuple are identical before and after. Statuses and targets may differ.

Statuses and targets *do* differ, deliberately: that is the fix. A golden test
is evidence for the invariant, not the argument for it.

## Consequences

- Trialling a model is one line: `"tier": "t0"`. No override, no queue job, no
  account edit, no billing flip, no second entry.
- Raising everyone's targets moves from a 60-second hot-reload of JSON to a code
  change behind the deploy-smoke gate. That is a real operational regression on
  the one machine this runs for, and it is the trade: a target change is a
  recorded decision, the same argument as promotion-by-threshold.
- The word **tier** now means a rung of the evidence ladder and never an
  episode. `docs/EPISODES.md` and the dashboard used it loosely for `e90`/`e360`;
  both say *episode* now. In code the collision never existed — episodes have
  always been `EpisodeId` — but a rename done in one place and skipped elsewhere
  is worse than none.
- The tier enum and table live in `runner/src/models.ts`, which the viewer
  already imports, and both parsers validate against its exported keys. The
  supervisor's parser and the viewer's zod twin stay deliberate twins
  (`runner/viewer/models.ts` may not import `bun:sqlite`), but the value set
  cannot skew. The viewer stays lenient — an entry with no tier is skipped, not
  rejected: the supervisor validates the config, the viewer reads it.
- Shipped as `fleet.next.json`. `preferNextConfig` hands the new file to whoever
  asks for `fleet.json`, so the running supervisor keeps its config until it
  restarts and the rename commutes — the mitigation ADR-0034 records using twice.

## Alternatives

- **`promote: auto | manual | never` instead of a terminal `t0`.** It makes `t0`
  and `t1 + promote:never` two spellings of one state, which is what ADR-0034's
  "one concept, the job" amendment exists to kill, and it reopens the per-model
  judgement door that promotion-by-threshold deliberately closed. It would also
  encode a tier as a flag — the mirror of the bug this record fixes.
- **A per-billing tier table** (`t2` = e360 x1 paid, x3 free). It puts money back
  inside the axis that was just cleared of it. Splitting the rung instead keeps
  every tier uniform and makes the expensive step one an operator grants.
- **Keeping the per-entry override "for flexibility".** It is a fourth level of
  precedence over the three just removed, and it forfeits the whole point.
- **A binary freeplay axis** (`f0`/`f1`). It names only freeplay, so the free
  roster's character extras would have to survive as a second, fleet-level
  mechanism — two idle-time mechanisms where the goal was one axis.
