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
- **A module change**: the smoke scripts, `bun wb smoke <name>`, and a release
  to ship it; never a worldserver restart while a run is live.
- `bun wb` lists every operator command; `bun wb <group>` shows what each runs
  and where.
