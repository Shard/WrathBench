# Costs

How cost is measured in this harness, and the rules learned measuring it. The
hard numbers that used to live here (per-episode resource tables, a pricing
table, platform reliability counts, a what-to-try-next list) were a snapshot of
2026-08-22/23 and went stale the moment the 0.5 series re-armed; they were
removed on 2026-08-24 rather than left to mislead — `git show d752ef7:docs/COSTS.md`
is the last revision that carries them. Cost surfaces belong in the UI
(episode cost, campaign rollups, estimates from accumulated baselines): that
arc is GitHub issue #13, and until it lands, the per-call data below is the
record.

## 1. Where the data lives

- Every `t:"response"` trajectory record carries the provider-reported
  `usage` block when the provider sends one: `prompt_tokens`,
  `completion_tokens`, `cached_tokens`, `cache_write_tokens`,
  `reasoning_tokens`, and OpenRouter's own `cost` in credits. Since `d752ef7`
  it also names the serving `provider` when the body reports one.
- The claude-code harness emits `usageRaw`/`costUsd` only on a clean
  `claude_result` (natural completion). Until 2026-08-25 a watchdog kill cut the
  stream before that record landed, so most subscription episodes had no
  as-metered figure at all; the driver now winds down instead — it records the
  termination, refuses every further tool call, and reads the CLI's stream for
  up to 90s so the closing `result` can land (runner/README.md, "Winding a
  claude-code episode down"). Runs from then on should read `source:
  "reported"` and carry a cost; a run whose CLI never closed its turn still
  reads `snapshot`, and its `wind-down` record says `grace-expired`. Runs before
  that date are unchanged and stay `snapshot`.
- A `claude_result` lands once per harness TURN, and its two halves do not cover
  the same thing: `usage` is that turn's, so a run's output is the sum over the
  records, while `total_cost_usd` is CUMULATIVE for the CLI session, so a
  session's cost is its LAST record and never the sum. Since 2026-08-25 the
  record also carries `sessionId` (the boundary a pause and resume crosses) and
  `duration_api_ms` (time inside API calls, as against `duration_ms`'s whole
  turn).
- **2026-08-25:** every claude-code completion-token figure the viewer showed
  before this date was wrong low by roughly 300×, and so was its tokens/second.
  Per-response `usage.completion_tokens` under that driver is the API's
  `message_start` snapshot, not the finished count; the input side was and is
  correct. Output now comes off `claude_result.usageRaw.output_tokens`. Actual
  cost (`costUsd`) never depended on it; EXPECTED cost, which prices
  `completionTokens`, does. A run whose turns never emitted a `claude_result` at
  all keeps the snapshot figures and is labelled `source: "snapshot"` rather
  than `"reported"`, in the API and on the run page both.
- **2026-08-25, same pass:** as-metered cost for a claude-code run was the SUM
  of its `claude_result.costUsd` figures, which triangle-counts a cumulative
  series — the haiku run read $69.30 for a session that charged $4.35. It is now
  the last figure per CLI session, summed across sessions. Only runs with more
  than one result record moved; the common case (a watchdog kill leaves none or
  one) never did.
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
  figures are opening snapshots, so on the 2026-08-25 haiku run they undercount
  by ~300×. Per-response blocks are good for the SHAPE of context growth, never
  for absolute $, and on the output side not even for shape.
- **Cost control is external to the fleet by decision** (operator, 2026-08-24): a tier is
  denominated in runs, dollars are the operator's reasoning. If an in-fleet
  money budget is ever wanted, it belongs beside `policy.paid.maxConcurrent`,
  not as a new tier.
- **Subscription episodes are $0 marginal but not free in value**: ~99.5%+ of
  their prompt volume is cache reads, and the one clean e360 measurement
  as-metered was ~$44 — reserve the lane for confirmed candidates, not volume
  sampling.

## 3. Context growth across an episode

**openai-adapter driver (OpenRouter/OpenCode/local, fixed-context policy):** prompt tokens climb
for the first several turns then plateau — confirmed both in this window (`ox-alpha` turns 1→61:
3,292 → 7,321 → 11,414 → 12,533 → 13,241; `qwen3.8-27b` turns 1→71: 3,466 → 10,185 → 17,955 →
18,343) and in `docs/worklogs/2026-08-21.md` ("requests plateau at roughly 8–12k tokens regardless
of episode length"). The runner trims older conversation aggressively (system prompt: "the
scratchpad is your memory, not the chat history"), so cost per turn is bounded regardless of how
long the episode runs. `cached_tokens` on these lanes is sporadic, and as of 2026-08-24 the
sporadicity is measured, not assumed (closed item 78, `docs/worklogs/2026-08-24.md`; run
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
mid-run `prompt_tokens` drop this item flagged is class 1 — the trim working as designed.
Separately: Anthropic models via OpenRouter still need explicit `cache_control` breakpoints
(memory: 0%→89% measured); the open models cache implicitly, no opt-in involved.

**claude-code harness (Sonnet/Opus via the Claude Code CLI on a subscription):** no trimming
— the full conversation replays every turn and grows essentially unbounded. `roster-sonnet-20260822`
(e90, episode-limit segment): `prompt_tokens` 4,092 → 66,685 → 126,748 → 160,932 → 206,116 over the
turn window, ending near 200k right before the 500-tool-call cap. `roster-opus-20260822` similarly
grows into the six-figure range. This is a genuinely different context policy, not a tuning
difference — it is what makes `claude-code` a harness of its own in the run's tag, and
it explains these numbers rather than unscoring the rows. Nothing compacts the claude-code conversation today (docs/worklogs/2026-08-21.md: the
compaction gate wasn't tripped by the fixed-context lanes, but "the subscription-lane amendment of
2026-08-22 arguably trips them already").

**Why Sonnet-on-subscription is the cost outlier, in numbers:** it is not that the tokens are
cheap per-unit — a fresh 200k-token context at list price would be expensive — it's that almost
all of that 200k is a cache **read**, not a cache write. In the same `roster-sonnet-20260822`
segment, summed to the first `episode-limit`: 68.8M cumulative `prompt_tokens` over 444 responses,
of which 68.5M (99.6%) were `cached_tokens`; only 291k tokens were fresh input and 291k were cache
writes. `roster-opus-20260822`: 21.85M cumulative prompt tokens, 21.7M (99.3%) cached, 145k fresh,
144k cache-write. The context grows every turn, but each turn re-reads yesterday's context off the
cache instead of re-paying for it — and because this harness bills against a flat Claude Code
subscription rather than metered API tokens, the operator's marginal cost is $0 regardless of how
large that cache-read number gets. `usageRaw`/`costUsd` are only emitted by the SDK on a clean
`claude_result` (natural turn-loop completion); a hard watchdog kill (episode-limit,
tool-call-limit) cuts the stream before that record lands, so an as-metered $ figure exists for
only one run in this window: `fleet-nav-probe-sonnet-20260822-c2` (a full 6h e360, ended cleanly),
`costUsd: $43.90` for 201.6M cumulative prompt tokens (201.1M cached, 99.75%), 186,646 output
tokens, 905 turns.
