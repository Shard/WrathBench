# ADR-0044: Cache misses are provider weather — log the provider, don't pin it

Status: Accepted. Date: 2026-08-24. Resolves FOLLOW-UPS 78.

## Context

A paid-lane deepseek run (`fleet-deepseek-flash-e90-…-20260824-a4`, OpenRouter)
showed `cached_tokens` alternating between 0 and 5–13k across near-identical
13–17k-token prompts, with stretches stuck at 128, and `prompt_tokens` dropping
mid-run — a ~2x per-call cost swing that looked like the context policy's
"byte-stable prefix" promise (ADR-0012) failing in the field.

Measurement said otherwise. Replaying the trajectory, all 139 non-trim
consecutive request pairs were byte-identical up to the append point; the 11
`prompt_tokens` drops were exactly the designed one-miss-per-block trims.
Correlating each call's generation id with OpenRouter's generation API: every
`cached_tokens: 128` stretch was OpenRouter routing the slug to a different
backend (one that caches ~128 tokens flat), and ~1/3 of the mid-block zeros
happened on the *same* backend, on a byte-identical prefix, seconds after a
hit — replica-level cache lottery inside that provider.

## Decision

Two things, and deliberately not a third:

1. **Log the serving provider.** The loop copies the response body's top-level
   `provider` (what OpenRouter names there) onto the trajectory `response`
   record. Cache-miss attribution was impossible from the trajectory alone;
   now a sweep can separate "backend switched" from "backend missed" without
   replaying generation-API lookups. Model-agnostic: any body that names no
   provider logs nothing.

2. **Pin the harness's half with a test.** A loop-level test asserts that the
   serialized request for turn N+1 extends turn N's byte-for-byte up to the
   append point, across a trim. The prefix promise is now enforced where the
   bytes leave, not only in the window arithmetic.

3. **No provider pinning.** OpenRouter accepts `provider.order` /
   `allow_fallbacks` preferences, and we are not sending them. Routing
   explains only the minority miss class (the 128-stretches); the dominant
   class is replica lottery *inside* the majority backend, which pinning
   cannot fix. The price of pinning is real — losing fallback turns one
   backend's bad hour into pauses across the lane — and the absolute stake
   today is ~$0.02 per 35-minute episode. If a future paid model shows
   routing-dominated misses at real cost, the knob belongs in run config
   (platform-level, next to `apiBase`), not in the adapter.

## Consequences

- `response` records from harness-0.5.x onward may carry `provider`; older
  runs don't, and sweeps must treat absence as "not recorded", not "not
  routed".
- The COSTS.md §2 claim that open-model `cached_tokens` sporadicity was about
  missing `cache_control` is corrected: implicit caching works, the prefix is
  stable, and the variance is the provider's, not ours.
- Expected-cost models should not assume cache hits on aggregator lanes even
  with a perfect prefix; COSTS.md already prices candidates cache-free.
