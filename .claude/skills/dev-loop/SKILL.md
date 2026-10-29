---
name: dev-loop
description: The fast loop for changing WrathBench code — which check proves which kind of change, and where each one lives. Use at the start of any development task in this repository, to pick the tests, typecheck, render rig or read-only fleet view the change needs.
---

# Dev loop

- **Tests and typecheck**: CLAUDE.md, "How to work", is the source; follow it
  as written there. A green `bun test` says nothing about types.
- **A dashboard or viewer change**: also look at it in a browser,
  `bun wb dashboard shots` (skill `dashboard-shots`).
- **A question about live or past runs**: `bun wb inspect …` (skill
  `run-forensics`), never an ad-hoc reader of `trajectory.jsonl` or the audit
  directory.
- **Anything that touches the cluster**: skill `fleet-readonly` first.
- **The checkout**: the agent stack (`module/`, `sdk/`, `mcp/`) is the
  `wrath-mcp/` submodule (Shard/wrath-mcp), and its `sdk/` and `mcp/` are
  workspaces here. A fresh worktree needs `git submodule update --init
  wrath-mcp` before `bun install --frozen-lockfile`; never run `bun install`
  inside `wrath-mcp/` (the suite refuses a `wrath-mcp/node_modules`).
- **A change in the stack**: edit `wrath-mcp/` in place; this repository's
  suite runs against the edit at once. It is two commits in two repositories:
  commit inside `wrath-mcp/` on a named branch of that repository and open its
  PR there (its own CI runs its typecheck, inside boundary, `docs:api:check`
  and tests; `bun run test` and `bun run typecheck` there for the stack alone).
  Never stage `wrath-mcp` in this repository except in the pointer-bump
  commit, `wrath-mcp: <old>..<new> — <one line>`, made after the stack PR
  merges: a pin on master must be a commit on wrath-mcp's master
  (`build-images.sh` and CI refuse otherwise), and `infra/PINS.md` records it.
  Here, `bun run boundary` checks nothing reaches into `wrath-mcp/` by path and
  that the shared pins agree. A change a model can see is a harness change too.
- **A module change**: verified only through a pointer-bump release here: the
  smoke scripts, `bun wb smoke <name>`, after the release; never a worldserver
  restart while a run is live.
- `bun wb` lists every operator command; `bun wb <group>` shows what each runs
  and where.
