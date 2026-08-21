# ADR-0004: Fixed harness, model as the only variable

Status: Accepted. Date: 2026-08-21.

## Context
RuneBench results are kept out of aggregate rankings because its SDK grew during evaluation, sample counts were low, and the metric collapsed to grinding. SWE-bench style benchmarks are accepted because the harness is fixed and published.

## Decision
The SDK surface, agent loop, prompt, context policy, and reference bundle are frozen per harness version. SDK changes are major versions; old scores keep their label. The loop is identical across models with no per-model tuning. During Phase 0 the harness is 0.x and may change freely; runs before the first frozen version are harness validation, not results.

## Alternatives
- Open scaffold leaderboard: more fun, less citable. Possible later as a clearly separate board.

## Consequences
- Scores mean "harness vX, model Y, task Z".
- Harness versions become a research lever: score changes across versions show which models were bottlenecked on what.
- Requires discipline about when to freeze.
