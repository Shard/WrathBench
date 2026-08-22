# Architecture

## Components

```
 model  <--MCP-->  runner (Bun)  <--SDK calls-->  sdk (Bun)  <--HTTP/WS-->  module (C++ in worldserver)
                      |                                                            |
                      v                                                            v
              data/runs/<id>/  (trajectory JSONL, sqlite)                 AzerothCore worldserver + DBs
```

### module/ (C++, AGPL, in-process with worldserver)

A thin bridge. It does two things and should never learn to do a third.

- Actions: accepts typed requests over HTTP, constructs the corresponding client opcode (`CMSG_*`), and pushes it through the character's `WorldSession` handler. Every server-side check a real client is subject to (range, facing, GCD, cooldowns, reagents, quest prerequisites, gossip state) applies unchanged.
- Events: taps the outbound packet stream for the session (`SMSG_*`), filters it to the observation contract, and publishes it over a WebSocket as JSON.
- Session management: creates or logs in a character for a session token, logs out on release.
- Audit log: every action dispatched and every observation served, with a timestamp and the session id.

It knows about opcodes and sessions. It does not know what a quest, a rotation, or a route is.

### sdk/ (Bun/TypeScript, MIT)

The surface the model programs against. Thin typed wrappers over module actions, a typed event stream, and a small set of composed helpers that emerged from real runs (for example `moveTo`, `killTarget`, `lootNearby`, `acceptQuestFrom`). Helpers are added because a run needed them, not in anticipation.

The SDK is versioned. Its surface is part of the harness version.

### runner/ (Bun/TypeScript, MIT)

- MCP server exposing tools to the model: run snippet, read recent events, query state summary, search reference bundle, read and write scratchpad.
- Snippet sandbox: a persistent runtime per session so snippets share state and can leave routines running. Executes in a separate process with network access only to the module. Hard per-snippet timeout.
- Agent loop: model-agnostic. Fixed prompt, fixed event window and state summary, fixed retry policy. Persists scratchpad and summary so a session can resume after a process failure.
- Watchdogs: idle timeout, no-XP timeout, episode time limit, snippet runaway. Each ends the episode with a named termination reason.
- Trajectory log: JSONL per run containing every snippet, its result, every event batch the model saw, and a periodic state line (level, zone, XP, position).
- Model adapter: one OpenAI-compatible chat layer. Provider and model are run config.

### runner/viewer/ + dashboard/ (Bun/TypeScript, MIT)

The operator's read-only window on runs, live and finished. Split in two along
one line (ADR-0022): the Bun process owns everything that needs the filesystem,
the SPA owns everything that is UI.

- `runner/viewer/` serves a read-only JSON API under `/api` (run listing, run
  detail and state series, summarised trajectory entries, the position feed, the
  fleet supervisor's published lane state), an SSE tail per run, minimap tiles
  from `data/minimap/`, and the built SPA as static files. Every database is
  opened readonly, so a run being written inside the container is never
  disturbed. Bearer tokens are stripped from anything that forwards a raw
  record. `WRATHBENCH_VIEWER_PUBLIC=1` withholds raw entries, scratchpads and
  tiles — the three routes that carry verbatim game text or Blizzard bytes.
- `dashboard/` is a SolidJS SPA: fleet overview, run detail, and the ADR-0019
  map. It imports two modules from the viewer rather than copying them — the API
  wire types and the world→tile transform — so drift between the two sides is a
  compile error. It is the only place in the repository with a dependency graph;
  the harness itself still runs with no build step.
- Loopback by default. Trajectories carry game-derived text, so a non-loopback
  bind fails at startup unless `WRATHBENCH_VIEWER_LAN=1` opts a trusted private
  network in (docs/DATA-AND-LEGAL.md). Public hosting is intended but not yet
  decided; ADR-0022 carries the constraints.

### wiki/ (Bun/TypeScript, MIT)

Tooling to turn a locally held wiki dump into a searchable bundle the runner can serve. The dump and the bundle live in `data/` and are never committed.

### infra/

Compose file for worldserver, authserver, database, module build, and runner. Extraction scripts for client data (run once, on the host, output into `data/`). Smoke script that drives one quest end to end through the SDK.

## Data flow for one action

1. Model calls `run_snippet` via MCP with TypeScript.
2. Runner executes it in the session's sandbox; snippet calls `sdk.castSpell(id)`.
3. SDK posts `{action: "cast", spellId}` to the module.
4. Module builds `CMSG_CAST_SPELL` and hands it to the session's handler, as if the client had sent it.
5. Server applies its normal validation and effects.
6. Outbound `SMSG_SPELL_GO` or `SMSG_CAST_FAILED` is tapped, filtered, and published on the WebSocket.
7. SDK surfaces it as a typed event; the snippet or the model reacts.
8. Runner appends the snippet, result, and events to the trajectory.

## Reset

Phase 0: every episode starts with a freshly created character at level 1 in its starting zone. Character creation is a client action the module supports. Character snapshots (DB save and restore for mid-level starts) are deferred.

## Persistence

- Run metadata and periodic state in `bun:sqlite` under `data/runs/`.
- Trajectories as JSONL next to it.
- Server state in the AzerothCore databases; the server is authoritative for XP, level, deaths, quests, gold.

## What is deliberately absent in Phase 0

Results pipeline, perturbation tooling, snapshot/restore, per-character credentials, multi-agent support, concurrency beyond a few sequential or lightly parallel characters on one server.
