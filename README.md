# WrathBench (working name)

An LLM evaluation harness built on World of Warcraft 3.3.5a via AzerothCore. A model drives a character through a versioned TypeScript SDK; the game server is the source of truth for what happened.

Status: Phase 0, pre-alpha. Private repository. See `docs/PHASE-0.md`.

## Documents

- `CLAUDE.md`: working instructions for agents and contributors
- `docs/VISION.md`: what this is, what it measures, what it is not
- `docs/ARCHITECTURE.md`: components and data flow
- `docs/CONTRACTS.md`: what the agent may observe and do
- `docs/PHASE-0.md`: current scope, task list, and the gate
- `docs/DATA-AND-LEGAL.md`: data handling posture
- `docs/decisions/`: architecture decision records

## Quick start

Not yet. The first milestone is the smoke script in `infra/smoke/` completing one quest through the SDK. When that works, this section will tell you how to run it.

## Licence

`module/` is AGPL-3.0 (it is an AzerothCore module). `sdk/`, `runner/`, `wiki/`, and `infra/` are MIT. No Blizzard-owned material is included or distributed; see `docs/DATA-AND-LEGAL.md`.
