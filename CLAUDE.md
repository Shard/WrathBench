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
- SDK surface is simple by default, flexible via the raw-action escape hatch: helpers are earned by observed need in trajectories, never speculative, and there is no convenience middle tier (docs/METHODOLOGY.md, "The model surface").
- Pinned versions are pinned. AzerothCore commit, Bun version, and the module build are changed deliberately and documented.
- Original WrathBench material outside `module/` is MIT-licensed under the root `LICENSE`. `module/` is GPL-2.0-or-later under `module/LICENSE`. Third-party works retain their own terms; see `THIRD-PARTY-NOTICES.md`.

## Repository layout

```
module/        C++ AzerothCore module: HTTP/WS bridge into WorldSession (GPL-2.0-or-later)
sdk/           Bun/TypeScript SDK over the module (MIT)
runner/        Agent loop, snippet sandbox, MCP server, trajectory logging (MIT)
dashboard/     SolidJS SPA over the viewer's read-only /api (MIT)
wiki/          Tooling to build the wiki bundle from a local dump (MIT); the dump itself is in data/
minimap/       Local minimap extraction tooling; generated assets stay in data/ (MIT)
infra/         Compose files, Dockerfiles, fleet and smoke scripts (original WrathBench portions MIT)
docs/          Documentation (MIT)
data/          Gitignored. Server data directory, wiki dump, runs, sqlite stores
```

## Toolchain

- Bun 1.4.x pinned in `.bun-version` and `package.json`. Use Bun built-ins before adding dependencies: `bun:sqlite`, `Bun.serve` (HTTP + WebSocket), `Bun.JSONL`, `Bun.markdown`, `bun test`.
- TypeScript strict. Zod only at external boundaries (module messages, model output, config).
- C++ follows AzerothCore's module conventions and builds inside the worldserver image.
- Everything runs in containers via `infra/compose.yml`. The only host-side prerequisite is the AzerothCore server data directory at `data/client`.

## How to work
- Read the relevant doc before touching a component. `docs/ARCHITECTURE.md` for structure, `docs/CONTRACTS.md` for what the agent may see and do, `docs/METHODOLOGY.md` for the decisions that shape what results mean — check it before changing anything the model sees, the scorer reads, or the scheduler counts.
- Log at the module boundary (every observation served, every action dispatched) and in the runner (every snippet, result, and event batch the model saw). Trajectory logs are JSONL under `data/runs/<run-id>/`.
- Tests: `bun test` at the root runs every workspace's suite (sdk, runner, wiki, minimap, dashboard, infra) — all of it fixture-based, green from a bare clone with no `data/` — and `bun run typecheck` for every project including `infra/`. Bun strips types without checking them, so a green `bun test` says nothing about types — run both. Module changes are verified by the smoke scripts in `infra/smoke/`, which do need the live stack.
- Working memory lives in three places and nowhere else: completed work goes in the day file `docs/worklogs/YYYY-MM-DD.md` (append to today's, create it if absent; `docs/WORKLOG.md` is only the index), open items go in `docs/FOLLOW-UPS.md` (open items only, stable numbers, and nothing else — no archive), decisions go in `docs/METHODOLOGY.md` or the owning component doc. When an item ships, add a `shipped: item N — commit — where it lives` line to the day file and delete the item from FOLLOW-UPS. That line is the only thing that makes an old citation resolve, so it is not optional. An item with no next action and no trigger goes to a GitHub issue instead of sitting in the file.

## Style
- Plain prose in docs. Bullets where they aid scanning. Keep things concise and focused on why not what.

## Decisions
Methodological decisions — anything that shapes what a result means — live in `docs/METHODOLOGY.md`, organized by principle and edited in place: fold a new decision into the section it belongs to, prune what it obsoletes, and let git history hold the past. Component-level "why" (build, ops, protocol) lives in the doc that owns the component. If you are about to make a choice a future contributor would ask "why did they do that" about, record it in the right one of those two places; do not start a new append-only record series.

**Methodology changes are the operator's, explicitly.** An agent never changes a methodological decision — anything in `docs/METHODOLOGY.md` — on its own initiative. Edit that document only to record a decision the operator has explicitly made, citing when. If work in flight would require changing or contradicting one, stop and put the question to the operator instead of proceeding. Wording fixes that change no meaning are fine; when in doubt, ask.

