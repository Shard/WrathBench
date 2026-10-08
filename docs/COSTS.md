# Costs

How cost is measured in this harness, and the rules learned measuring it. It
carries no per-episode resource tables, pricing table or platform reliability
counts: such a snapshot goes stale the moment a series re-arms. Cost
surfaces belong in the UI, and the viewer has them: actual and expected cost
on the run page, and cost columns on the run, model and fleet listings. A
model not yet run gets one projected figure, on its draft on the `/config` page
(docs/RUNBOOK.md, "Adding a model"): the catalogue's list price applied to the
median counted e90's tokens. It is labelled an estimate because it is the
extrapolation from another model's token shape that the first rule below warns
against, and it reads low for a reasoning-heavy model — by two to three times,
the operator's figure in GitHub issue #66.

## 1. Where the data lives

- Every `t:"response"` trajectory record carries the provider-reported
  `usage` block when the provider sends one: `prompt_tokens`,
  `completion_tokens`, `cached_tokens`, `cache_write_tokens`,
  `reasoning_tokens`, and OpenRouter's own `cost` in credits. It also names
  the serving `provider` when the body reports one, and the first one seen is
  promoted onto the run itself
  (`run.resolved_provider`, `meta.resolved.provider`) so a cost sweep can group
  by backend without replaying the trajectory. Routing is pinned
  (docs/METHODOLOGY.md, "Routing is pinned"), so a cache miss attributable
  to a backend move is now something the config has to have asked for.
- Under the openai adapter the same record also carries `usageRaw`: the
  provider's own `usage` object as sent, kept to its numeric fields (one
  nested level, capped in keys and key length; `runner/src/adapter.ts`), for
  every provider alike. It is there to reconcile a bill against fields the
  normalised block has no name for, such as DeepSeek's
  `prompt_cache_hit_tokens`/`prompt_cache_miss_tokens` or OpenRouter's
  `cost_details`. Nothing derived reads it, and the public projection
  leaves it out.
- The claude-code harness emits `usageRaw`/`costUsd` only on a clean
  `claude_result` (natural completion), so a watchdog kill would cut the stream
  before that record landed; the driver winds down instead — it records the
  termination, refuses every further tool call, and reads the CLI's stream for
  up to 90s so the closing `result` can land (runner/README.md, "Winding a
  claude-code episode down"). A run that gets one reads `source: "reported"`
  and carries a cost; a run whose CLI never closed its turn reads `snapshot`,
  and its `wind-down` record says `grace-expired`.
- A `claude_result` lands once per harness TURN, and its two halves do not cover
  the same thing: `usage` is that turn's, so a run's output is the sum over the
  records, while `total_cost_usd` is CUMULATIVE for the CLI session, so a
  session's cost is its LAST record and never the sum. The record also carries
  `sessionId` (the boundary a pause and resume crosses) and
  `duration_api_ms` (time inside API calls, as against `duration_ms`'s whole
  turn).
- Per-response `usage.completion_tokens` under the claude-code driver is the
  API's `message_start` snapshot, not the finished count — low by roughly 300×,
  and so is any tokens/second read off it; the input side is correct. Output
  comes off `claude_result.usageRaw.output_tokens`. Actual cost (`costUsd`)
  never depended on it; EXPECTED cost, which prices `completionTokens`, does. A
  run whose turns never emitted a `claude_result` at all keeps the snapshot
  figures and is labelled `source: "snapshot"` rather than `"reported"`, in the
  API and on the run page both.
- As-metered cost for a claude-code run is the last `claude_result.costUsd`
  figure per CLI session, summed across sessions. Summing every record
  triangle-counts a cumulative series: the haiku run read $69.30 that way for a
  session that charged $4.35.
- That figure leaves out every turn that ended before its `claude_result`
  landed: a turn cut off by a pause, or one the wind-down grace could not
  save. Two paused sessions left one Fable freeplay run at $839 for ~$1,588 of
  tokens. **Operator's decision, 2026-10-08:** backfill and mark it. Once a
  session is over (a pause, the termination, or the next session starting),
  the responses it made after its last result are priced at the run's own
  list row (the served-model row the expected figure uses) and added to the
  CLI's figure; a turn still in flight is not counted, so a live run is not
  marked between results; the actual then carries both parts (`CostFigure.backfill`) and
  every surface shows it with a `*` whose hover says how much was estimated
  and for how many turns. The estimate is a floor, because those turns' output
  is the opening snapshot (above). A model with no row (Haiku 5.5) gets nothing
  added and the `*` all the same, since the figure still reads low. A run with
  no `claude_result` at all is not backfilled: it has no reported figure to add
  to, and its expected cost already prices every token.
- Estimates and provider-reported actuals are different species and are never
  presented as each other (the deploy-window design draws the line; the viewer falls back to
  an estimate only where the provider reported nothing, and labels it).

## 2. Rules, each paid for

- **Measure a new model's first ~15 minutes; never extrapolate from another
  model's token shape.** Projecting gpt-5.6-luna from deepseek's episode shape
  was wrong by 3.5x in the expensive direction: token volume per episode is a
  function of the model's SPEED (luna ran ~7x more snippets per minute), not a
  harness constant.
- **Do not sum claude-code per-response `usage` into dollars.** Summed
  per-response prompt tokens overshot a real `costUsd` by ~4x and the summed
  output figure undercounted real output ~6.8x on the one run with ground
  truth — and the output side is worse than that measurement suggested: the
  figures are opening snapshots, so on the haiku run they undercount
  by ~300×. Per-response blocks are good for the SHAPE of context growth, never
  for absolute $, and on the output side not even for shape. The 4× prompt
  overshoot was measured on the retired `claude-subscription` driver, whose
  runs stay unpriced; under the `claude-code` driver the per-response prompt
  sums equal the CLI's own per-turn `claude_result` sums, and output comes off
  `claude_result` (§1), which is why the expected figure can be read beside
  the CLI's.
- **Price a Claude run on the model the CLI served, at the 1-hour cache-write
  rate.** The roster's `opus` and `sonnet` are aliases that changed meaning
  with CLI pins (Opus 5.5 from 2.1.280, Sonnet 5.5 from 2.1.284); priced by
  family, Opus 5.5 read as Opus 5, about 2× its real cost. The CLI names what
  it served on its first line, and `CLAUDE_PRICES` in `runner/viewer/pricing.ts`
  matches that id exactly, with dated windows like the other tables. Every
  claude-code run writes 1-hour cache, billed at 2× input rather than the
  5-minute 1.25×. Sonnet 5 stays at $2/$10: the announced rise to $3/$15 never
  happened. Haiku 5.5 has no row, because Anthropic prices each call by its
  prompt size and a run's totals cannot say which calls were which (GitHub
  issue #122); its runs read the CLI's own figure.
- **Cost control is external to the fleet by decision**: a tier is
  denominated in runs, dollars are the operator's reasoning. If an in-fleet
  money budget is ever wanted, it belongs beside `policy.paid.maxConcurrent`,
  not as a new tier.
- **Subscription episodes are $0 marginal but not free in value**: ~99.5%+ of
  their prompt volume is cache reads, and the one clean e360 measurement
  as-metered was ~$44 — reserve the lane for confirmed candidates, not volume
  sampling.

## 3. Context growth across an episode

**openai-adapter driver (OpenRouter/OpenCode/local, fixed-context policy):** prompt tokens climb
for the first several turns then plateau — confirmed on both lanes measured (`ox-alpha` turns 1→61:
3,292 → 7,321 → 11,414 → 12,533 → 13,241; `qwen3.8-27b` turns 1→71: 3,466 → 10,185 → 17,955 →
18,343): requests plateau at roughly 8–12k tokens regardless
of episode length. The runner trims older conversation aggressively, so cost per turn is bounded
regardless of how long the episode runs. `cached_tokens` on these lanes is sporadic, and the
sporadicity is measured, not assumed (run
`fleet-deepseek-flash-e90-deepseek-v4-flash-0731-20260824-a4`, 150 calls). The harness's side is
clean: replaying every consecutive request pair from the trajectory, the serialized message array
was byte-identical up to the append point in all 139 non-trim pairs — the prefix the context
policy promises (`docs/METHODOLOGY.md`, "Context policy") is the prefix that goes over the wire, and a loop-level test now pins
it. The misses decompose as: (1) the 11 block trims, one designed miss per ~11-turn block; (2)
OpenRouter routing the same model slug across backends — correlating each call's generation id
with OpenRouter's generation API, every `cached_tokens: 128` stretch was a different serving
provider than the surrounding calls, and that provider barely caches at all (128 tokens flat
against 13k prompts); (3) same-provider misses — ~1/3 of mid-block calls on the majority backend
returned `cached_tokens: 0` on a byte-identical prefix sent seconds after a hit, which is backend-
internal (load-balancing across replicas with per-node KV caches), not anything the request can
change. Classes 2 and 3 are provider weather; the response record now carries the serving
`provider` name so future sweeps can attribute misses without generation-API replays. The
mid-run `prompt_tokens` drop is class 1 — the trim working as designed.
Separately: Anthropic models via OpenRouter still need explicit `cache_control` breakpoints
(0%→89% measured); the open models cache implicitly, no opt-in involved.

**claude-code harness (Sonnet/Opus via the Claude Code CLI on a subscription):** no trimming
— the full conversation replays every turn and grows essentially unbounded. `roster-sonnet-20260822`
(e90, episode-limit segment): `prompt_tokens` 4,092 → 66,685 → 126,748 → 160,932 → 206,116 over the
turn window, ending near 200k right before the 500-tool-call cap. `roster-opus-20260822` similarly
grows into the six-figure range. This is a genuinely different context policy, not a tuning
difference — it is what makes `claude-code` a harness of its own in the run's tag, and
it explains these numbers rather than unscoring the rows. Nothing compacts the claude-code conversation today: the
compaction gate was never tripped by the fixed-context lanes, and the
subscription lane arguably trips it already.

**codex harness (OpenAI models via the Codex CLI on a ChatGPT subscription):** the same
regime with a different scaffold — one persisted thread, resumed per turn, compacted by the CLI on
its own schedule. Its `turn.completed` usage (`input_tokens` with the cached part as a subset,
`output_tokens`, `reasoning_output_tokens`) is the THREAD's running total, not the turn's: a resumed
thread is rebuilt with its counts, so the last turn of a 2,082-turn run reported 2.01B input tokens,
and summing those totals per turn read the run as 1.69 trillion. The driver lands each turn's
delta against the previous total of the same thread once, on the turn's last `response` entry, with
the CLI's figure beside it as `usageCumulative`, so the sum over responses is the run's real prompt
and output; records written before it did carry the total, and the viewer derives the same delta
for them when it reads them (`runner/src/codex-usage.ts`). A total that fell — a resume that lost
turns whose rollout could not be written — counts zero for that turn and is the new baseline. The
lost turns had already been counted when the CLI first reported them, so such a run reads above
the CLI's own final count by the size of the drop: about 0.06% on the one run that had one (astra
freeplay), and within about 0.1% of what was actually served. No snapshot caveat as under
claude-code.

The run page's "context" for a codex run is the prompt of the turn's LAST API call, not the turn's
tokens: a harness turn is a whole `codex exec` of many calls, so its own prompt total can be
hundreds of times the window. The CLI's event stream does not carry that figure; its rollout file
(`$CODEX_HOME/sessions/**/rollout-*-<thread_id>.jsonl`) does, in its last `token_count` event. The
driver reads only the tail of that file when a turn completes and lands the result on the turn's last
`response` as `lastCall` (`runner/src/codex-rollout.ts`); a failure leaves it absent and is noted once
per run. The viewer shows the latest `lastCall` and holds it while a turn is in flight. Runs from
before the driver logged it have none, so they show no context at all rather than the tally.

There is no cost figure at all: the CLI reports none on a
subscription, so a codex cost is only ever the list-price estimate over its tokens, marked
as-if-metered. The rate for that estimate comes from the OpenRouter sync, under the vendor
prefix the Codex CLI's own slug omits: the lane records `gpt-6-astra` and the catalogue carries
OpenAI's published list price as `openai/gpt-6-astra`. It is the same synced row an OpenRouter
run would read; only what it means differs, and `codexPrice` in `runner/viewer/pricing.ts` says
so — an OpenRouter run meters the operator's balance, a codex run bills a flat ChatGPT
subscription, so the figure there is a comparison and not a bill. It is the operator's decision:
without it a codex run would have no cost reading at all and would be absent from
every ladder chart, whose x-axis is cost.

**Why Sonnet-on-subscription is the cost outlier, in numbers:** it is not that the tokens are
cheap per-unit — a fresh 200k-token context at list price would be expensive — it's that almost
all of that 200k is a cache **read**, not a cache write. In the same `roster-sonnet-20260822`
segment, summed to the first `episode-limit`: 68.8M cumulative `prompt_tokens` over 444 responses,
of which 68.5M (99.6%) were `cached_tokens`; only 291k tokens were fresh input and 291k were cache
writes. `roster-opus-20260822`: 21.85M cumulative prompt tokens, 21.7M (99.3%) cached, 145k fresh,
144k cache-write. The context grows every turn, but each turn re-reads yesterday's context off the
cache instead of re-paying for it — and because this harness bills against a flat Claude Code
subscription rather than metered API tokens, the operator's marginal cost is $0 regardless of how
large that cache-read number gets. The as-metered figure for a whole episode (§1 has when the
CLI emits one): `fleet-nav-probe-sonnet-20260822-c2` (a full 6h e360, ended cleanly),
`costUsd: $43.90` for 201.6M cumulative prompt tokens (201.1M cached, 99.75%), 186,646 output
tokens, 905 turns.
