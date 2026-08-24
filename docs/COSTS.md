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

`*` claude-code-harness token columns are **sums of per-turn `prompt_tokens`**, which is the raw
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
long the episode runs. `cached_tokens` on these lanes is sporadic, and as of 2026-08-24 the
sporadicity is measured, not assumed (FOLLOW-UPS 78, run
`fleet-deepseek-flash-e90-deepseek-v4-flash-0731-20260824-a4`, 150 calls). The harness's side is
clean: replaying every consecutive request pair from the trajectory, the serialized message array
was byte-identical up to the append point in all 139 non-trim pairs — the prefix the context
policy promises (ADR-0012) is the prefix that goes over the wire, and a loop-level test now pins
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

**claude-code harness (Sonnet/Opus via the Claude Code CLI on a subscription; ADR-0035):** no trimming
— the full conversation replays every turn and grows essentially unbounded. `roster-sonnet-20260822`
(e90, episode-limit segment): `prompt_tokens` 4,092 → 66,685 → 126,748 → 160,932 → 206,116 over the
turn window, ending near 200k right before the 500-tool-call cap. `roster-opus-20260822` similarly
grows into the six-figure range. This is a genuinely different context policy, not a tuning
difference — it is what makes `claude-code` a harness of its own in the run's tag (ADR-0035), and
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
tokens, 905 turns. §3 derives the e90 figures the same way for the two episode-limit segments that
have no `claude_result`.

## 3. Pricing table

Approximate list prices, marked. Claude figures come from this session's `claude-api` skill (its
cached model table, dated 2026-06-24, current as of this write-up) rather than recalled from
training — verify against `shared/models.md` / the Models API before budgeting off this table if
much time has passed.

| model | $/M input | $/M output | cached-read $/M | cached-write $/M (5m) | notes |
|---|--:|--:|--:|--:|---|
| Claude Sonnet 5 (API, intro pricing thru 2026-08-31) | 2.00 | 10.00 | ~0.20 | ~2.50 | claude-code harness pays $0 marginal; this is the as-metered reference below. Standard pricing after 2026-08-31: $3/$15, ~$0.30/~$3.75 |
| Claude Opus 5 (API) | 5.00 | 25.00 | ~0.50 | ~6.25 | same harness, no intro pricing listed for Opus |
| Claude Haiku 4.5 (API) | 1.00 | 5.00 | ~0.10 | ~1.25 | not in current fleet, listed for reference |
| OpenRouter free models (glm-5.2, nemotron-3-ultra/super, north-mini-code, inkling, gemma-4-31b, gpt-oss-20b, laguna-s-2.1, dots-3-note, nemotron-nano-9b) | 0 | 0 | 0 | request-capped, not token-capped (§1) |
| OpenCode Zen free models (hy3, mimo-v2.5, deepseek-v4-flash, x-preview-f) | 0 | 0 | 0 | same cap shape |
| deepseek/deepseek-v4-flash-0731 (paid roster) | 0.08 | 0.18 | 0.016 | 0.08 | synced 2026-08-24. Real bills come in ~1.7x under `expected` — implicit caching beyond what `cached_tokens` reports (see below) |
| openai/gpt-5.6-luna (paid roster, added 2026-08-24) | 0.20 | 1.20 | 0.02 | 0.25 | 1.05M ctx. `-pro` is the same price; `:batch` is half. There is no `chatgpt-luna`. Measured ~$1.46/e90 — fast, so ~8M prompt tokens per episode, not deepseek's 1.8M |
| google/gemini-3.7-flash (paid roster, added 2026-08-24) | 0.375 | 1.875 | 0.0375 | 0.0208 | 1.05M ctx, and what `~google/gemini-flash-latest` resolves to. A generational cut, not a sale: 3.6-flash is 0.75/3.75, 3.5-flash 1.50/9.00. Heavy reasoner — a one-word reply spent 85 of 86 completion tokens on reasoning, so budget output high |
| Other paid open models on OpenRouter, for reference (Kimi K2-class, Qwen3-max-class, MiniMax-class) | ~0.24–0.78 | ~0.96–3.90 | usually ~10% of input | not in fleet.json today; considered and deferred on 2026-08-24 for serial wall clock, not price |
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

### Actual vs expected (viewer, 2026-08-23)

The viewer now carries two dollar figures per run and never collapses them into
one, because they answer different questions:

- **actual** — what the provider says it charged. OpenRouter reports it per
  response as `usage.cost` (credits, which are dollars) under the `usage:
  {include: true}` opt-in the adapter sets for that host; the Claude Code driver
  reports it per session as `total_cost_usd` on a `claude_result`. The viewer
  sums whichever the run carries and uses it verbatim. Null for most runs, and a
  null says "provider reports no cost for this run" rather than quietly showing
  the estimate in its place. The runs table on the models page shows this figure
  and only this one.
- **expected** — the price table applied to the run's own tokens, dated, with
  its per-component breakdown. Computed even when an actual exists, so a gap
  between the two is visible: the nav-probe Sonnet e360 above reads $43.90
  actual against $158.97 expected, which is exactly the per-response-usage
  overcount this section measured, now on screen instead of in a footnote.

Two caveats on the corpus. First, `toUsage` in `runner/src/adapter.ts` parsed
`cost` out of the usage block and then dropped it, so **no OpenRouter-lane run
before 2026-08-23 carries an actual cost** however long it ran — the opt-in was
paying for a figure nothing recorded (fixed in `1fe3951`). Second, and because
the fleet resumes a run rather than recreating it, a run in flight across that
fix has responses from both sides of it: `fleet-ox-alpha-e90-ox-alpha-20260823-a4`
picked up the charge mid-trajectory when its process respawned. A sum over those
is a bill for part of the run in the shape of a bill for all of it, so the
viewer's `actual` note names it — "partial: N of M responses reported no cost" —
rather than letting the number pass as complete. A run started clean after the
fix has no such line.

A gap that closed on 2026-08-24, worth recording because the diagnosis in this
document was wrong. `expected` priced every cache **write** at zero, and the note
here used to say the cause was that no provider emits the counter. It does:
OpenRouter sends `cache_write_tokens` nested under `prompt_tokens_details`, never
at the top level, and `toUsage` (`runner/src/adapter.ts`) read only the flat key —
so the field arrived on every response and was dropped. It now flattens writes the
same way it already flattened reads, and `costOf` subtracts both from the prompt
before charging input, so nothing double-counts. This surfaced when
`openai/gpt-5.6-luna` (write at $0.25/M, 1.25x its input) and
`google/gemini-3.7-flash` (write at $0.0208/M, a storage-only rate well *below*
input) joined the paid roster — the first two roster models quoting a write tier.
Runs before this fix still carry no write counter, so their `expected` prices
writes at zero and always will; `actual` is unaffected, since OpenRouter reports
`usage.cost` for both models. Follow-up item 59, resolved same day.

**`expected` also overstates where a provider discounts beyond what it reports.**
Fitting the synced rates to the real bills on the deepseek runs: `...-a2` $0.0543
actual against $0.1017 expected (1.88x), `...-a3` $0.0717 against $0.1188 (1.66x).
To reproduce the real bill at listed rates ~70% of prompt tokens must have been
cache reads, but `cached_tokens` logs only 12–30%. The consequence for choosing
models is the one that matters: **deepseek's $0.07/e90 is a floor produced by
implicit caching, not a yardstick candidates must approach.** Price a candidate
assuming no caching — `1.8M x $/M-in + 54k x $/M-out`, the token shape of a full
e90 (`...-a3`) — and treat anything better as upside.

### Where the prices come from

Claude rows stay hand-kept in `runner/viewer/pricing.ts`: they are subscription
as-if-metered figures and this document verified them against a real `costUsd`.
Everything else is synced, not typed:

```
bun run sync-prices     # infra/sync-prices.ts
```

It GETs `https://openrouter.ai/api/v1/models` and writes
`runner/viewer/prices.openrouter.json` — dollars per million, one `asOf` for the
file, `cacheWrite` falling back to the input rate where OpenRouter quotes no
write tier. Scope is the roster in `infra/fleet.json`, every model any run under
`data/runs` was launched on, and a hand-kept `PIN` list in the script; the other
~410 catalogue rows are noise. A model the catalogue does not carry stays
unpriced and the run page says `no synced price — run bun infra/sync-prices.ts`
rather than guessing. Free slugs and LAN models never reach the table: they are
priced $0 by rule (`runner/src/model-cost.ts`), which is why a `:free` row in the
synced file is inert.

Re-run it when a model joins the roster, when a provider changes a rate, or when
the run page starts saying a price is missing — and commit the JSON, so the
figure on screen is one anybody can diff.

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

Filter: the e360 promotion gate (ADR-0034; at the time of this report it was the earlier
two-run rule of ADR-0030 — now one counted `e90` episode reaching rung 1 / level 5).

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
5. **The paid track (updated 2026-08-24)** — `deepseek-flash` met its 3/3 e90 target
   with a best run of **level 3**, short of the rung-1 gate, so it earned no e360.
   `openai/gpt-5.6-luna` and `google/gemini-3.7-flash` joined beside it. The
   Both sit on **`tier: "t0"`** — the trial rung: one e90, and the ladder is held
   so a good run cannot promote them into an e360 nobody approved (ADR-0043; this
   started as a per-entry `runsPerEpisode {e90: 1, e360: 0}` cap, which said the
   same thing in a way the board then contradicted with `promoted 1/1 0/0`).
   Measuring luna in flight had moved the estimate by 3.5x. Two constraints, and
   money turned out to be the tighter one:
   `accounts.paid` is one account at `maxConcurrent: 1` (a full e90 is ~90–114 min,
   so runs are strictly serial), and a *full* paid quota on luna — 3 e90 plus one
   e360 — prices at roughly **$10**, which is the whole daily budget for one model.
   One scored e90 each first; move a model that earns it to `t1`, and the rung it
   already earned on trial promotes it to `t2` at once, with nothing re-run.

   Note the deliberate boundary (ADR-0043): a tier is denominated in **runs**, not
   dollars. The reasoning above is in dollars and run counts are the proxy; hard
   cost control is external to the fleet by decision (2026-08-24), and a money
   budget, if one is ever wanted in-fleet, belongs beside `policy.paid.maxConcurrent`
   rather than as a new tier.

   **Do not size a run by token count alone — size it by the model's speed.** The
   `1.8M prompt / 54k completion` shape of a deepseek e90 is not a harness
   constant, it is what a *slow* model produces in 90 minutes. Luna runs ~7x more
   snippets per minute (107 in 15.8 min against deepseek's 139 in 114 min), so it
   burns ~8M prompt tokens in the same 90-minute window. Measured against
   provider-reported cost: **$0.2562 at 15.8 min, projecting to ~$1.46 for a full
   e90** — against the ~$0.42 this document estimated from deepseek's token shape.
   The estimate was wrong by 3.5x in the direction that matters, and the fix is to
   take a real `usage.cost` reading from the first 15 minutes of a new model's
   first run rather than to extrapolate from another model's episode.
6. **Sonnet/Opus subscription** — hold at current usage. Not "expensive," structurally: $0
   marginal, but every e90 episode is ~$22–38 of as-metered value and an e360 is ~$44, so it's the
   lane to reserve for confirmed promotion candidates or the nav-probe travel experiment, not
   volume sampling.
7. **Prune, don't retry:** glm-5.2:free, gemma-4-31b:free, gpt-oss-20b:free, north-mini-code:free,
   inkling:free, mimo-v2.5-free, deepseek-v4-flash-free all show 0 recorded snippets/tokens in this
   window (dead on first request or provider-pulled, per fleet.json's curation notes) — confirm
   they're still worth a lane slot before the next roster edit.
