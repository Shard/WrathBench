# Phase 0: Control Surface and Liftoff

**Status (2026-08-29).** All four gates below passed on 2026-08-21 and every
build-list box is checked. Work since then has followed this document's own
rule — a capability enters when an organic run makes it the next obstacle — so
several items in "Deferred" have returned on that basis: the results pipeline
and dashboard, episode ids and the evidence ladder, the probe lane, and a
harness version series (tags now run to `harness-0.5`). The record of what
shipped when is `docs/WORKLOG.md`; what a run means is `docs/METHODOLOGY.md`.
This page is kept as the statement of the gate that was met, not as the current
task list — that is `docs/FOLLOW-UPS.md`.

## Goal

A harness any model can plug into. Small capable models create a character, complete quests, and gain levels. Frontier models go as far as they can with no harness errors in their trajectories.

## Gate

All of the following (status as of 2026-08-21, see docs/FOLLOW-UPS.md):
1. The smoke script completes one quest end to end through the SDK: create character, accept, kill objectives, loot, turn in, gain a level. **PASSED** (two consecutive runs).
2. A model, via the MCP tools, does the same unaided at least once. **PASSED** (gate2-ox-4, 2026-08-21: stealth/ox-alpha, one episode — accept at turn 9, 8/8 quest kill credits, loot, quest 7 turned in for 170 XP, level 3).
3. A frontier model runs for an hour and its trajectory contains no errors attributable to the module, SDK, runner, or sandbox. **PASSED** (gate2-ox-4: 2h06m, 123 turns, zero watchdog fires, zero sandbox restarts, zero harness notices; all 6 snippet errors model-attributable — two BigInt stringify, one API misuse, three in-snippet await timeouts where the abandoned-eval path behaved as documented. The gate-blocking sandbox-restart-notice defect from gate2-ox-3 was fixed and tested before this run.)
4. Everything runs from `infra/compose.yml` on a fresh machine given only the extracted client data in `data/`. **PASSED** (2026-08-21 rehearsal: `down -v` destroyed all state, fresh `up` re-imported the databases, bootstrap verified SRP6 round-trip, module-slice and session-state probes PASS, spectator ports green. Images were prebuilt; a truly fresh machine additionally compiles them from the pinned submodule — the state path was exercised from zero. README Quick Start reflects the validated steps.)

## Fixed for this phase

- AzerothCore: stock, pinned by commit in `infra/`. No playerbots fork.
- Bun: 1.4.x, exact version pinned. Bump patch releases deliberately.
- Rates: 1.0 for kill XP, quest XP, and respawn. Tweak during development if runs are too slow, keeping kill and quest XP equal.
- Character: class, race, and zone are run config. Default to a forgiving solo class (Hunter or Paladin). Death Knight excluded until phasing is verified.
- Reset: fresh level 1 character per episode.
- Loop context: last N events, a state summary, the scratchpad, and a search tool over the reference bundle. N and the summary format are fixed and written down once chosen.
- Episode limit: generous. The model runs as far as it can. Idle and no-XP watchdogs end stalled runs with named reasons.

## Build list

Roughly in order. Each item is small enough to be a day or two; the module is the exception.

### Infra
- [x] Compose: authserver, worldserver, database, runner. Volumes for `data/client`, `data/wiki`, `data/runs`.
- [x] Worldserver image that builds `module/` in.
- [x] Server data directory (`dbc/ maps/ vmaps/ mmaps/`) at `data/client`, supplied by the operator; production of it is out of repo scope.
- [x] Realm and account bootstrap so a session can create a character without manual steps.

### Module
- [x] Session management: token to character mapping, login, logout, create character.
- [x] Action endpoint: HTTP, JSON in, ack out, errors as events. Opcodes per `docs/CONTRACTS.md` Phase 0 set.
- [x] Event tap: filter outbound packets for the session to the observation contract, publish as JSON over WebSocket.
- [x] Movement: resolve move-to into client movement packets along an mmaps path.
- [x] Audit log to a file per session.

### SDK
- [x] Typed client for the module: actions and an async event stream.
- [x] State cache built from events: self, target, nearby objects, quest log, inventory.
- [x] First composed helpers as the smoke script needs them. No speculative helpers.
- [x] `bun test` coverage for the state cache and message schemas.

### Runner
- [x] Sandbox: separate process, persistent per session, network limited to the module, per-snippet timeout, stdout and errors captured.
- [x] MCP server: `run_snippet`, `recent_events`, `state_summary`, `search_reference`, `read_scratchpad`, `write_scratchpad`.
- [x] Agent loop: fixed prompt, fixed context policy, one OpenAI-compatible adapter, resumable from persisted scratchpad and summary.
- [x] Watchdogs with named termination reasons.
- [x] Trajectory JSONL and run sqlite under `data/runs/<id>/`.
- [x] Minimal terminal timeline viewer for a run (level, zone, XP delta, events per minute). Enough to read a stall in a few minutes.

### Wiki
- [x] Build a searchable bundle from a local dump. Plain text search is enough.

### Smoke
- [x] `infra/smoke/one-quest.ts`: the forty-line script that proves the loop. (125 lines incl. comments; two consecutive live passes 2026-08-21)

## The dev loop once the gate is close

1. Start a run with a model.
2. Let it go until it stalls or the watchdog ends it.
3. Read the trajectory with the viewer. Classify the stall: module, SDK, runner, sandbox, environment defect (broken quest etc.), or the model.
4. If harness: fix, note which run prompted the change, rerun.
5. If model: leave it. That is signal.
6. Track the furthest level reached per model over time. That curve is the harness maturity metric.

## Deferred (do not build in Phase 0)

As written on 2026-08-21. Several of these have since returned under the rule
below; see the status note at the top.

Character snapshots and mid-level starts. Multiple task definitions or level bands. Perturbed-twin tasks. Results pipeline, dashboards, leaderboard. Formal harness version scheme beyond git tags. Per-character credentials. Multi-agent anything. Scripted party (NPCBots or playerbots). Human ceiling scripts. Variance and latency studies. Skill library in the Voyager sense. Harbor image. Any public artefact.

Each comes back when an organic run makes it the next obstacle, or when publication requires it.

## Known risks to keep an eye on

- The module is the project. If packet synthesis into `WorldSession` turns out to be awkward for some opcode class, note it early.
- Long runs die to transient failures; resumability is not optional.
- Quest defects in the emulator look like model failures until classified. Keep an `environment-defect` termination reason and a list of quests known to be broken at the pinned commit.
- The agent loop's context policy moves scores more than most SDK changes. Fix it, write it down, resist tuning it per model.
- Bun 1.4 is days old and a fresh rewrite. Keep code plain enough that dropping to 1.3 is trivial if needed.
