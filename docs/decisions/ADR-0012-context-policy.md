# ADR-0012: Runner context policy

Status: Accepted. Date: 2026-08-21.

## Context

PHASE-0 fixes the loop context as "last N events, a state summary, the scratchpad, and a search tool", with N and the summary format written down once chosen. This policy moves scores more than most SDK changes and is therefore part of the harness version (ADR-0004): one policy for every model, never tuned per model. The authoritative encoding is `runner/src/context.ts` (`CONTEXT_POLICY` and `assembleContext`); this ADR is the why.

## Decision

Every model request is rebuilt as:

1. The fixed system prompt (`runner/src/prompt.ts`).
2. A rolling window of at most **24 messages** of recent assistant output and tool results, kept verbatim, trimmed only at assistant-message boundaries so a tool call is never separated from its results.
3. One fresh user message assembled deterministically from: a goal/turn line, pending harness notices (sandbox restarts, resume notes), the fixed-format state summary, the last **64 events** (data truncated at 220 chars per event), and the full scratchpad.

Old per-turn user messages are dropped, never accumulated: the context message is regenerated each turn, so events and state are always current and the token cost per turn is roughly constant. The scratchpad is the only durable memory; the system prompt says so explicitly, which makes writing it part of the task rather than a harness kindness.

The state summary format is a fixed line-oriented template (`formatStateSummary`): seq/eventCount header, session status, character/level, position with the seq it was observed at, health/power, nearby count, stream-gap status, a 10-line chat tail and 5-line notification tail. Fields no event has carried read `unobserved` — never a default value — per docs/CONTRACTS.md.

Numbers chosen, and why they are these and not others:

- **N = 64 events.** Big enough to span a combat sequence plus its loot/quest updates at Phase-0 event rates; small enough that a busy window does not drown the summary. Not tuned per model — revisiting it is a harness version bump.
- **24 messages ≈ 8–12 tool exchanges.** Enough short-term memory to carry a multi-step interaction (gossip → accept → move), small enough to force real use of the scratchpad.
- **Determinism.** `assembleContext` is pure; the test suite requires byte-identical output for identical inputs, so a trajectory replays into exactly the context the model saw.

Resume semantics follow from the policy: a restarted runner starts with an empty message window, a harness notice saying so, and the persisted scratchpad — nothing else, because nothing else is promised to survive.

## Alternatives

- Growing conversation with summarization: cheaper to build, but the summarizer becomes an unversioned model-dependent part of the harness — exactly what ADR-0004 forbids.
- Events only since the last turn: no repetition, but any dropped or unlucky turn loses events forever; a sliding window is idempotent across retries and resumes.
- Larger windows: more context is not free — it dilutes the scratchpad discipline the benchmark wants to measure and multiplies token cost over six-hour episodes.

## Consequences

- Scores are comparable across models because context handling cannot be a scaffold advantage.
- Models with weak note-taking will underperform models with strong note-taking at equal reasoning strength. That is signal, not bias: long-horizon memory management is part of what WrathBench measures.
- Changing any constant in `CONTEXT_POLICY`, the summary template, or the system prompt is a harness version change and re-baselines results.
