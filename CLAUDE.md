# CLAUDE.md
Working instructions for agents developing this repository.

## What this is

WrathBench  an LLM evaluation harness built on World of Warcraft 3.3.5a via AzerothCore. A model writes and supervises TypeScript against a versioned SDK; a character in a live game world is the thing being driven; the server is the source of truth for what happened.
It measures how well a model drives a fixed toolkit toward long-horizon goals in a live world. It is not a direct-play benchmark and does not pretend to be one.

## Current phase

Phase 0: build the control surface and get any model to liftoff. See `docs/PHASE-0.md` for the exact scope and the gate.

## Hard constraints

- Nothing Blizzard-derived ever enters git: no client files, no MPQ/DBC, no extracted maps/vmaps/mmaps, no wiki dumps containing game text, no trajectory logs. These live in volumes under `data/` which is gitignored at the directory level.
- The agent observes only what a real game client could observe. The action path goes through the same server opcode handlers a client would hit. See `docs/CONTRACTS.md`. If you find yourself reaching for a server-side shortcut that a client could not do, that is the signal to stop.
- The C++ module stays thin: packet bridge and event tap only. Game semantics live in TypeScript.
- The agent loop is model-agnostic. No per-model prompts, retries, or tuning.
- SDK surface is simple by default, flexible via the raw-action escape hatch: helpers are earned by observed need in trajectories, never speculative, and there is no convenience middle tier (ADR-0015).
- Pinned versions are pinned. AzerothCore commit, Bun version, and the module build are changed deliberately and documented.

## Repository layout

```
module/        C++ AzerothCore module: HTTP/WS bridge into WorldSession (AGPL-3.0)
sdk/           Bun/TypeScript SDK over the module (MIT)
runner/        Agent loop, snippet sandbox, MCP server, trajectory logging (MIT)
dashboard/     SolidJS SPA over the viewer's read-only /api; see ADR-0022 (MIT)
wiki/          Tooling to build the wiki bundle from a local dump (MIT); the dump itself is in data/
infra/         Compose files, Dockerfiles, fleet and smoke scripts
docs/          Documentation
data/          Gitignored. Server data directory, wiki dump, runs, sqlite stores
```

## Toolchain

- Bun 1.4.x pinned in `.bun-version` and `package.json`. Use Bun built-ins before adding dependencies: `bun:sqlite`, `Bun.serve` (HTTP + WebSocket), `Bun.JSONL`, `Bun.markdown`, `bun test`.
- TypeScript strict. Zod only at external boundaries (module messages, model output, config).
- C++ follows AzerothCore's module conventions and builds inside the worldserver image.
- Everything runs in containers via `infra/compose.yml`. The only host-side prerequisite is the AzerothCore server data directory at `data/client`.

## How to work
- Read the relevant doc before touching a component. `docs/ARCHITECTURE.md` for structure, `docs/CONTRACTS.md` for what the agent may see and do.
- Log at the module boundary (every observation served, every action dispatched) and in the runner (every snippet, result, and event batch the model saw). Trajectory logs are JSONL under `data/runs/<run-id>/`.
- Tests: `bun test` for sdk/ and runner/. Module changes are verified by the smoke script in `infra/smoke/`.

## Style
- Plain prose in docs. Bullets where they aid scanning. Keep things concise and focused on why not what.

## Decisions
Architectural decisions are recorded in `docs/decisions/` as short ADRs. If you are about to make a choice that a future contributor would ask "why did they do that" about, write one.

