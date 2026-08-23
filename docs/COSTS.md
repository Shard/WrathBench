# Costs

A reference for judging which models to try next, built from `data/runs/fleet-*-2026082[2-3]-c*`
(post-fleet-as-a-service) plus `data/runs/roster-{sonnet,opus}*-20260822` (pre-fleet subscription
episodes, included only for the context-growth and pricing sections). Not a scored comparison —
see `docs/EPISODES.md` for what makes runs comparable. Figures are medians/sums over ~120 run dirs
spanning 2026-08-22 to 2026-08-23; many free-lane dirs are resumed segments of one paused episode
(a `rate-limited` pause is not an end, per EPISODES.md), so "n" below counts dirs, not distinct
characters.

## 1. Per-episode resource shape

Token columns come from `t:"response"` records' `usage.{prompt,completion}_tokens` (summed per
episode); `has_usage` = episodes where the driver actually recorded a `usage` block, out of n.
**No tokens recorded** for: `mimo-v2.5-free`, `deepseek-v4-flash-free`, `cohere/north-mini-code`,
`thinkingmachines/inkling`, `google/gemma-4-31b-it`, `openai/gpt-oss-20b` — these either 404'd/
died before a response landed, or the provider omits `usage`. Say so plainly rather than
interpolating.

| lane | model | n | med snippets | max snippets | med requests | med wall (min) | med tok in | med tok out | usage recorded |
|---|---|--:|--:|--:|--:|--:|--:|--:|--:|
| free-oc-a | hy3-free | 5 | 174 | 215 | 179 | 190 | 2,275,911 | 327,147 | 5/5 |
| free-oc-a | mimo-v2.5-free | 23 | 0 | — | 1 | 0.3 | — | — | 0/23 |
| free-oc-a | deepseek-v4-flash-free | 2 | 0 | — | 5 | 318 | — | — | 0/2 |
| free-oc-b | laguna-s-2.1-free | 2 | 124 | 227 | 140 | 416 | 2,298,562 | 80,032 | 2/2 |
| free-oc-b | x-preview-f-free | 7 | 60 | 112 | 62 | 91 | 802,735 | 79,282 | 7/7 |
| free-or-a | nemotron-3-ultra-550b-a55b:free | 5 | 187 | 258 | 188 | 47 | 2,532,684 | 78,591 | 5/5 |
| free-or-a | glm-5.2:free | 16 | 0 | 1 | 1 | 0.5 | 3,192 | 60 | 2/16 |
| free-or-a | north-mini-code:free | 1 | 0 | — | 2 | 12 | — | — | 0/1 |
| free-or-a | inkling:free | 2 | 0 | — | 1 | 0 | — | — | 0/2 |
| free-or-b | gemma-4-31b-it:free | 11 | 0 | — | 1 | 0.3 | — | — | 0/11 |
| free-or-b | gpt-oss-20b:free | 11 | 0 | — | 1 | 0.3 | — | — | 0/11 |
| local-qwen | qwen3.8-27b | 12 | 78 | 117 | 83 | 90 | 1,185,267 | 111,944 | 11/12 |
| ox-alpha | stealth/ox-alpha | 13 | 39 | 73 | 44 | 60 | 547,734 | 65,954 | 12/13 |
| nav-probe (e360) | sonnet, subscription | 3 | 516 | 1148 | — | 131 | 94,406,796* | 7,495* | 3/3 |
| roster (pre-fleet e90) | sonnet, subscription | 4 | 400 | 832 | — | 72 | 48,210,462* | 7,646* | 4/4 |
| roster (pre-fleet e90) | opus, subscription | 3 | 241 | 252 | — | 90 | 13,251,160* | 4,647* | 3/3 |

`*` subscription-driver token columns are **sums of per-turn `prompt_tokens`**, which is the raw
replayed-context volume, not net consumption — see §2. Subscription lane has no separate
"request" counter comparable to the OpenRouter/OpenCode HTTP-request count (its `t:"response"`
records are per tool-call, not per outbound HTTP call, and it isn't rate-capped the same way), so
that column is blank rather than misleading.

**Termination reason mix** (dirs, includes in-progress/resumed segments as `(none/running)`):

| lane | episode-limit | no-xp | manual | adapter-error | tool-call-limit | (none/running, i.e. paused mid-episode) |
|---|--:|--:|--:|--:|--:|--:|
| free-oc-a | 0 | 1 | 3 | 0 | 0 | 26 |
| free-oc-b | 2 | 0 | 3 | 2 | 0 | 2 |
| free-or-a | 0 | 3 | 2 | 2 | 0 | 17 |
| free-or-b | 0 | 0 | 1 | 0 | 0 | 21 |
| local-qwen | 7 | 0 | 2 | 2 | 0 | 1 |
| ox-alpha | 3 | 2 | 3 | 5 | 0 | 0 |
| roster (sonnet/opus, pre-fleet) | 3 | 0 | 2 | 0 | 2 | 0 |

Free-lane rows are dominated by `(none/running)`: most free-oc/free-or dirs are one paused segment
of a longer resumed stream, not a completed episode — the resume-not-recreate fix (`728e157`)
keeps that from becoming a hammering loop, but it means "episodes" in this table over-counts
distinct attempts and under-counts wall-clock completeness. `ox-alpha` is the outlier with 5/13
`adapter-error` (all "body read failed: the operation timed out") despite zero rate-limit pauses —
a different failure mode than the free lanes' 429/5xx (§4).

**Requests against the OpenRouter 1000/day/key cap:** `free-or-a` made all 957 of its window's
requests on 2026-08-22 alone (verified by splitting `started_at` per run by UTC day — every one
landed on the same day) — that is 95.7% of the daily cap on ordinary usage, before any retry
storm. Other lanes for reference (sums over the ~2-day window, not day-split): `free-oc-a` 694,
`free-oc-b` 765, `local-qwen` (LM Studio, uncapped) 987, `ox-alpha` 552, `free-or-b` 22 (its two
models die in the first snippet, so almost no requests are spent — the low count is model failure,
not headroom). `free-or-a` is not "close to" the cap, it is effectively already at it: adding
another active model to that lane, or a bad day of 429 retries, tips it over before the 00:00 UTC
reset.

## 2. Context growth across an episode

**openai-adapter driver (OpenRouter/OpenCode/local, fixed-context policy):** prompt tokens climb
for the first several turns then plateau — confirmed both in this window (`ox-alpha` turns 1→61:
3,292 → 7,321 → 11,414 → 12,533 → 13,241; `qwen3.8-27b` turns 1→71: 3,466 → 10,185 → 17,955 →
18,343) and in `docs/worklogs/2026-08-21.md` ("requests plateau at roughly 8–12k tokens regardless
of episode length"). The runner trims older conversation aggressively (system prompt: "the
scratchpad is your memory, not the chat history"), so cost per turn is bounded regardless of how
long the episode runs. `cached_tokens` on these lanes is mostly 0 or sporadic — no `cache_control`
is set for the OpenRouter/OpenAI-compatible path (memory: "Anthropic via OpenRouter needs
cache_control (0%→89% measured)"; the free models here are not Anthropic so this doesn't apply
directly, but it confirms caching is opt-in per adapter, not automatic).

**subscription driver (Claude Agent SDK, Sonnet/Opus via Claude Code subscription):** no trimming
— the full conversation replays every turn and grows essentially unbounded. `roster-sonnet-20260822`
(e90, episode-limit segment): `prompt_tokens` 4,092 → 66,685 → 126,748 → 160,932 → 206,116 over the
turn window, ending near 200k right before the 500-tool-call cap. `roster-opus-20260822` similarly
grows into the six-figure range. This is a genuinely different context policy, not a tuning
difference — nothing compacts the subscription-driver conversation today (docs/worklogs/2026-08-21.md: the
compaction gate wasn't tripped by the fixed-context lanes, but "the subscription-lane amendment of
2026-08-22 arguably trips them already").

**Why Sonnet-on-subscription is the cost outlier, in numbers:** it is not that the tokens are
cheap per-unit — a fresh 200k-token context at list price would be expensive — it's that almost
all of that 200k is a cache **read**, not a cache write. In the same `roster-sonnet-20260822`
segment, summed to the first `episode-limit`: 68.8M cumulative `prompt_tokens` over 444 responses,
of which 68.5M (99.6%) were `cached_tokens`; only 291k tokens were fresh input and 291k were cache
writes. `roster-opus-20260822`: 21.85M cumulative prompt tokens, 21.7M (99.3%) cached, 145k fresh,
144k cache-write. The context grows every turn, but each turn re-reads yesterday's context off the
cache instead of re-paying for it — and because this driver bills against a flat Claude Code
subscription rather than metered API tokens, the operator's marginal cost is $0 regardless of how
large that cache-read number gets. `usageRaw`/`costUsd` are only emitted by the SDK on a clean
`claude_result` (natural turn-loop completion); a hard watchdog kill (episode-limit,
tool-call-limit) cuts the stream before that record lands, so an as-metered $ figure exists for
only one run in this window: `fleet-nav-probe-sonnet-20260822-c2` (a full 6h e360, ended cleanly),
`costUsd: $43.90` for 201.6M cumulative prompt tokens (201.1M cached, 99.75%), 186,646 output
tokens, 905 turns. §3 derives the e90 figures the same way for the two episode-limit segments that
have no `claude_result`.

## 3. Pricing table

Approximate list prices, marked. Claude figures come from this session's `claude-api` skill (its
cached model table, dated 2026-06-24, current as of this write-up) rather than recalled from
training — verify against `shared/models.md` / the Models API before budgeting off this table if
much time has passed.

| model | $/M input | $/M output | cached-read $/M | cached-write $/M (5m) | notes |
|---|--:|--:|--:|--:|---|
| Claude Sonnet 5 (API, intro pricing thru 2026-08-31) | 2.00 | 10.00 | ~0.20 | ~2.50 | subscription driver pays $0 marginal; this is the as-metered reference below. Standard pricing after 2026-08-31: $3/$15, ~$0.30/~$3.75 |
| Claude Opus 5 (API) | 5.00 | 25.00 | ~0.50 | ~6.25 | same driver, no intro pricing listed for Opus |
| Claude Haiku 4.5 (API) | 1.00 | 5.00 | ~0.10 | ~1.25 | not in current fleet, listed for reference |
| OpenRouter free models (glm-5.2, nemotron-3-ultra/super, north-mini-code, inkling, gemma-4-31b, gpt-oss-20b, laguna-s-2.1, dots-3-note, nemotron-nano-9b) | 0 | 0 | 0 | request-capped, not token-capped (§1) |
| OpenCode Zen free models (hy3, mimo-v2.5, deepseek-v4-flash, x-preview-f) | 0 | 0 | 0 | same cap shape |
| Typical paid open models on OpenRouter, for reference (DeepSeek V3-class, Qwen2.5-72B-class, GLM-4-class, Kimi K2-class) | ~0.25–0.60 | ~1.00–2.50 | usually ~10% of input | none currently in fleet.json — all current entries are `:free` per lane policy |
| local-qwen (qwen3.8-27b via LM Studio, 192.168.1.20) | 0 | 0 | 0 | zero marginal $; hardware operator to fill (not in any log or memory note found) |

**Estimated $ per episode, as-if-metered.** The only ground truth we have is a real `costUsd` on a
*naturally completed* subscription episode — `usageRaw`/`costUsd` are emitted by the Claude Agent
SDK only on a clean `claude_result`, and every e90 subscription run in this window ended on a hard
watchdog kill (`episode-limit`/`tool-call-limit`) that cuts the stream before that record lands.
So there is no e90 `claude_result` to price directly, and a first attempt at reconstructing one
from summed per-response `usage` blocks did not reproduce it (cross-checked below) — rather than
publish a formula that's shown to be wrong, this section gives the one verified number and a
frankly-labeled order-of-magnitude estimate for e90:

- **Sonnet e360** (`fleet-nav-probe-sonnet-20260822-c2`, natural completion, real `costUsd`):
  **$43.90 as-metered** — the SDK's own figure. Cross-check against the intro Sonnet 5 table above,
  applied to its `usageRaw` (input 1,810; cache_creation 451,039; cache_read 201,137,815; output
  186,646): 1,810×$2/M + 451,039×$2.50/M + 201,137,815×$0.20/M + 186,646×$10/M ≈ $0.004 + $1.13 +
  $40.23 + $1.87 = **$43.23**, within 1.5% of the reported $43.90 — good confirmation the intro
  Sonnet 5 rates (not the $3/$15 standard rates) are what's actually billing, and that
  `cache_read_input_tokens` at ~0.1× input is the right read multiplier.
- **Sonnet e90 (order of magnitude only):** $43.90 over 360 wall-clock minutes is $0.122/min
  as-metered; naively over the 90-minute watchdog window that's **~$11**. This is a rough linear
  scaling, likely an *underestimate*: context (and so cache-read volume) is smallest in an
  episode's first minutes and grows through the run, so an e90 spends proportionally more time in
  the cheaper early phase than the linear split credits it for, but not by a huge factor since
  reads dominate the bill even early (§2 shows cache-read already >99% of prompt tokens well
  before the 90-minute mark in the roster segments). Treat **$10–20** as the working e90 range
  until a real `claude_result` lands for one (the promotion gate in §5 is exactly the kind of run
  that would produce one).
- **Why not sum per-response `usage`, tried and discarded:** summing `usage.{prompt,cached,output}
  _tokens` over every `t:"response"` record in `fleet-nav-probe-sonnet-20260822-c2` gives 783.6M
  cumulative prompt tokens (782.8M "cached") and only 27,585 output tokens — versus the real
  201.6M/186,646 from `costUsd`'s own `usageRaw`. Applying the pricing table to the summed numbers
  overshoots to over $160, and the summed output figure alone undercounts real output by ~6.8×
  (`completion_tokens` on this driver's per-response log excludes some content, likely thinking
  tokens). The per-response `usage` blocks are useful for the *shape* of context growth (§2, where
  relative growth across turns is what matters) but are not a safe basis for absolute $ — don't
  reuse this method without reconciling it against a `costUsd` first, the way this section just did.
- **Free-lane models (all rows in §1's free-oc/free-or lanes, plus local-qwen):** $0 regardless of
  episode length or token volume — the constraint is the request cap (§1), not $.

This is the numeric shape of "Sonnet subscription is an outlier": unbounded context growth would
be ruinous under a naive per-token metered lane with no caching (compare the openai-adapter lanes'
flat ~12k-token plateau, which exists specifically because that driver trims context instead of
relying on cache economics) — but under >99% cache-read and a flat subscription, the operator's
real marginal cost stays $0 regardless of context size.

## 4. Platform reliability notes (hidden cost)

| lane | rate-limit/5xx pauses (sum) | adapter-error terminations | dominant failure text |
|---|--:|--:|---|
| free-oc-a | 61 (30 dirs) | 0 in window | `persistent 5xx after 5 attempts: HTTP 500/503` |
| free-oc-b | 20 (9 dirs) | 2 | `network error: the operation timed out` (model API failed after 5 attempts) |
| free-or-a | 20 (24 dirs) | 2 | `HTTP 429 ... temporarily rate-limited upstream`; one `HTTP 404` (gpt-oss-20b's free slug pulled by provider, since pruned per fleet.json `_notes`) |
| free-or-b | 21 (22 dirs) | 0 in window | mixed 429/5xx, low sample (most dirs die in <1 snippet) |
| local-qwen | 0 | 2 | LM Studio-side errors, not a shared-pool rate limit |
| ox-alpha | 0 | 5 | `body read failed: the operation timed out` — no 429s at all, so this looks like a stalled-connection issue specific to this provider/route, not quota pressure |

Every free-lane pause is "not an end" per EPISODES.md — the roster resumes in place rather than
restarting the character, but each pause still burns wall clock and (per §1) a chunk of the
request budget on retries before the 5-attempt give-up. `ox-alpha`'s pattern (zero pauses, five
adapter-errors, all timeouts) is worth flagging separately from the free lanes' 429/5xx churn —
it did not show up as a capacity signal, it showed up as dead connections.

## 5. What to try next (cheap+reliable first)

Filter: the e360 promotion gate from `docs/EPISODES.md` — two `e90` episodes on the current
harness version reaching rung 1 / level 5, ending neither `adapter-error` nor `harness-error`.

1. **local-qwen (qwen3.8-27b)** — already reliable (0 pauses, only 2 adapter-errors across 12
   dirs, 7 clean `episode-limit` endings), $0 marginal, no request cap. Push it toward the e90
   promotion gate first: it's the only lane with both signal and zero platform noise.
2. **nemotron-3-ultra-550b-a55b:free (free-or-a)** — highest snippet/token throughput of any free
   lane (med 187 snippets, 2.5M tok in) when it isn't paused; worth watching whether it clears
   rung 1 before free-or-a's request budget becomes the constraint.
3. **hy3-free / x-preview-f-free (OpenCode)** — both post real usage and moderate snippet counts;
   x-preview-f has zero adapter-errors in-window and a shorter median wall clock (91 min) than hy3
   (190 min), so it's the cheaper one to iterate on.
4. **ox-alpha** — was the Phase-0 gate passer (gate2-ox-4) and still free, but the timeout-only
   adapter-error pattern (5/13 dirs) needs a root cause before spending more cycles: it isn't
   quota, so retries alone won't fix it.
5. **Sonnet/Opus subscription** — hold at current usage. Not "expensive," structurally: $0
   marginal, but every e90 episode is ~$22–38 of as-metered value and an e360 is ~$44, so it's the
   lane to reserve for confirmed promotion candidates or the nav-probe travel experiment, not
   volume sampling.
6. **Prune, don't retry:** glm-5.2:free, gemma-4-31b:free, gpt-oss-20b:free, north-mini-code:free,
   inkling:free, mimo-v2.5-free, deepseek-v4-flash-free all show 0 recorded snippets/tokens in this
   window (dead on first request or provider-pulled, per fleet.json's curation notes) — confirm
   they're still worth a lane slot before the next roster edit.
