---
name: dev-loop
description: Which check proves which kind of WrathBench change, and the mechanics of a change to the agent stack in the `wrath-mcp/` submodule (two repositories, two PRs, a pointer bump). Use at the start of any development task in this repository, and before committing anything that touches `wrath-mcp/`.
---

# Dev loop

CLAUDE.md, "How to work", owns the test and typecheck commands; this is what
else each kind of change needs.

- **Any code**: `bun run test` and `bun run typecheck`, both; a green test run
  says nothing about types.
- **A dashboard or viewer change**: also look at it in a browser, skill
  `dashboard-shots`.
- **A question about a live or past run**: skill `run-forensics`, never an
  ad-hoc reader of the run's files.
- **Anything that reaches the cluster or the compose stack**: skill
  `fleet-readonly` first.
- **Anything a model sees, the scorer reads or the scheduler counts**: read
  `docs/METHODOLOGY.md` first. If the change would alter or contradict a
  decision there, stop and ask the operator.
- **A module change**: no local check proves it. It is verified by the
  release that carries its pointer bump and `bun wb smoke <name>` after it
  (`docs/RUNBOOK.md`, "Deploy window"), which the operator starts.
- `bun wb` lists every operator command; `bun wb <group>` shows what each runs
  and where.

## A change in the stack

The agent stack (`module/`, `sdk/`, `mcp/`) is the `wrath-mcp/` submodule, its
own repository with its own `CLAUDE.md`, and its `sdk/` and `mcp/` are
workspaces here.

- Edit `wrath-mcp/` in place: this repository's suite runs against the edit
  at once. Never run `bun install` inside `wrath-mcp/`; the suite refuses a
  `wrath-mcp/node_modules`.
- Commit inside `wrath-mcp/` on a named branch of that repository and open
  its PR there. Its CI runs `bun run typecheck`, `bun run boundary`,
  `bun run docs:api:check` and `bun test`; run them there first.
- Never stage `wrath-mcp` in this repository except in the pointer-bump
  commit, `wrath-mcp: <old>..<new> — <one line>`, made after the stack PR
  merges. A pin on master must be a commit on wrath-mcp's master: CI and
  `infra/build-images.sh` refuse otherwise. `infra/PINS.md` records the pin.
- Here, `bun run boundary` checks that nothing reaches into `wrath-mcp/` by
  path and that the shared pins agree.
