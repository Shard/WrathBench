# ADR-0012: Runner context policy

Status: Accepted. Date: 2026-08-21. Amended 2026-08-21 (block trimming) and
2026-08-22 (HUD summary); both amendments are folded in below. Scope note
(ADR-0035, 2026-08-23): this policy is the `wrathbench` harness. The
`claude-code` harness owns its own history and compaction and does not apply
it; that is recorded as the run's `harness` tag, not as a reason to exclude it.

## Context
PHASE-0 fixes the loop context as "recent events, a state summary, the
scratchpad, and a search tool". This policy moves scores more than most SDK
changes and is therefore part of the harness version (ADR-0004): one policy for
every model, never tuned per model. The authoritative encoding is
`runner/src/context.ts`; this record is the why.

## Decision
Every request is rebuilt as: the fixed system prompt; a window of recent
assistant/tool messages kept verbatim; and one fresh user message assembled
deterministically from a goal line, harness notices, a fixed-format state
summary, the last 64 events and the full scratchpad. Old per-turn user messages
are dropped, never accumulated, so token cost per turn is roughly constant and
the scratchpad is the only durable memory — the prompt says so, which makes
writing it part of the task rather than a harness kindness.

Why these shapes:

- **64 events, ambient motion excluded.** Big enough to span a combat sequence
  plus its loot and quest updates; small enough not to drown the summary. The
  first frontier run showed 69% of served events were wandering-NPC movement
  and 1.8% combat/quest signal, so movement is folded into the state cache and
  annotated as a count rather than listed.
- **The message window oscillates between 24 and 48, cut in 24-message blocks.**
  Providers cache by longest byte-identical prefix; a window that slides one
  message per turn invalidates the prefix every call, block trimming invalidates
  it once per block. The cut is a pure function of the whole stored history, so
  a history rebuilt from disk cuts where the live one did, and the boundary
  snaps to an assistant message so a tool call is never separated from its
  result. Each rendered message is capped with an explicit truncation suffix so
  the model knows to print less, applied at render time because the trajectory
  stores results in full. The larger average window is the price of the cache.
- **The state summary is a client HUD.** A running client always shows XP, bags,
  the quest tracker, nameplates, the target frame and open windows; hiding them
  made the model re-derive from the stream what a client displays. The summary
  is presentation of already-observed fields, never new observation: a field no
  event carried reads `unobserved`, an observed zero is shown, mob health is
  never exact (CONTRACTS.md), and an open window is shown only when an honest
  event pair proves it — a truncated buffer yields "omit", never a false "open".
- **Determinism.** `assembleContext` is pure and tested byte-identical, so a
  trajectory replays into exactly the context the model saw.

Resume follows from the policy: a restarted runner starts with an empty message
window, a notice saying so, and the persisted scratchpad — nothing else is
promised to survive. Rebuilding history from the trajectory log would be a
different decision.

Rejected: a growing conversation with summarization makes the summarizer an
unversioned model-dependent part of the harness (ADR-0004); events-only-since-
last-turn loses events on any dropped turn, whereas a window is idempotent
across retries and resumes; larger windows dilute the scratchpad discipline the
benchmark wants to measure and multiply cost over six-hour episodes.

## Consequences
- Models with weak note-taking underperform at equal reasoning strength. That is
  signal, not bias: long-horizon memory management is part of what is measured.
- Any constant in the policy, the summary template or the system prompt is a
  harness version change and re-baselines results. Each amendment above was one.
