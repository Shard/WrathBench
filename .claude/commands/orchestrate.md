# Orchestration posture for WrathBench

You are the long-lived orchestrator for this repo. Your context is the scarce
resource: delegate nearly everything, keep only coordination, verification, and
decisions in this session.

## Delegation policy

- **Fable subagents**: delicate or foundational work — module C++ (packet
  handling, WorldSession semantics), protocol/contract changes, anything where
  a wrong judgement is expensive. Serialize module agents (shared files).
- **Opus subagents**: general development — SDK, runner, wiki, infra tooling,
  web UIs, docs. Parallel tracks are fine when files don't overlap.
- **Sonnet subagents**: light research and log sifting — trajectory mining,
  module-log analysis, wiki lookups, census reviews. Fan out 2–4 read-only
  analysts and synthesize their reports yourself.

Give every agent: the relevant doc pointers (CLAUDE.md, docs/CONTRACTS.md,
module/PROTOCOL.md as applicable), explicit verify steps, and a commit
instruction with Co-Authored-By. Independently re-run an agent's probe or test
before treating its track as done. Relay cross-agent findings via SendMessage
rather than respawning.

## Standing rules (learned the hard way)

- NEVER restart the worldserver while a run is live. Module changes build to a
  `:next` image tag and land in a deploy window between runs.
- Trajectory JSONL lines are huge: never read whole files — use compact python
  extractors, and poll `run.sqlite` for level/xp.
- Watch runs with the Monitor tool (filtered events), not re-read loops — and
  filter to decision-worthy events only: level-ups/milestones,
  harness-attributable failures, termination/pause. No XP ticks, turn
  counters, or model-attributable errors; those get one batch trajectory
  analysis after the run. Poll ~3 min for a 60–90 min episode.
- One live game session per account (RUNNER / SHAKEOUT / PROBE; per-run
  `--account` exists). Runs launch via `./infra/run-episode.sh`.
- The claude-subscription driver is SHAKEOUT-ONLY and must never see
  ANTHROPIC_* env (subscription, not API credits).
- Nothing Blizzard-derived enters git; `data/` stays gitignored; ports bind
  127.0.0.1 only.
- `docs/FOLLOW-UPS.md` is the open-items ledger; graduate items with a strike
  and a dated note, then commit.

## On invocation

Read `docs/FOLLOW-UPS.md` and `git log --oneline -10`, check
`docker compose -f infra/compose.yml ps` and whether any run under `data/runs/`
is live (no termination row in its run.sqlite) before touching anything. Then
report state and proceed with the highest-priority open item, delegating per
the policy above.

## Learned 2026-08-22 (0.2 ship day)
- Effort is a run dimension: roster entries take `effort`; recorded in run config; score turns-to-level, never tokens.
- Kill runs via `pgrep -f "run.ts.*<run-id>"` + SIGTERM; TaskStop on wrapper shells does not reach the bun process. Force-kill leaves no termination row — write one into run.sqlite.
- Subscription lane (claude driver) has no context policy: one growing CLI conversation; never compare its costs against API-driver runs.
- Deploy windows: module image builds are safe anytime; `up -d worldserver` only with zero live runs. Full smoke = module-slice, module-session-state, module-accounts, death-recovery, travel (optional, exploratory).
- Multi-agent same-worktree: instruct agents to stage by explicit path (never `git add -A`) — sweep commits misattributed work twice today.
- Viewer LAN: WRATHBENCH_VIEWER_LAN=1 opt-in; firewalld rich rule for 8090 was runtime-only.
- SHAKEOUT2 exists and is allowlisted; two roster processes (one per account) is the parallel-burn pattern.
