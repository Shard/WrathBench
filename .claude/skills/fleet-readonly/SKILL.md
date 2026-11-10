---
name: fleet-readonly
description: What is safe to run against the live WrathBench fleet while runs are in flight, and what never is without the operator asking for exactly that. Use before any kubectl, docker compose or cluster-reaching `bun wb` command (fleet, config, release, server, accounts, smoke, run, campaign, site), and whenever a task says "check the fleet", "is anything running" or "look at the live run".
---

# Fleet: read-only while runs are live

Live runs are evidence. A restart, a drain or a write in the wrong place costs
a run its attempt or its record, and the supervisor acts on the config store
within a minute of any write. So an agent reads, and the operator decides
every write. First see what is live:

```
bun wb inspect live          # runs with a heartbeat, in well under a second
bun wb fleet status          # the supervisor's full report (slower)
```

A run is live when it has neither a termination nor a pause (skill
`run-forensics`, "Rules").

## Safe while runs are live

- `bun wb inspect …`: every view (skill `run-forensics`)
- `bun wb fleet status|dry-run|state`, and `--dry-run` on `fleet graceful` and
  `release run`, which print the plan and change nothing
- `bun wb config get [key]`, `config audit [n]`, `config export` with no file
  argument
- `bun wb server health`; `bun wb server log-retention` without `--apply`
- `bun wb site verify`, which reads the public bucket back
- `kubectl get …`, `kubectl logs --tail=N …`, and `kubectl exec … -- cat|ls|stat|du`
  of files that hold no secret (never `meta.json` whole, never the audit
  directory)
- Anything that stays in the checkout: `bun run test`, `bun run typecheck`,
  `bun wb dashboard shots`, `bun wb chart check`, `bun wb export eee`

## Never, unless the operator asked for exactly that

- **Restart, recreate or delete the worldserver while a run is live.** A
  module change reaches it only in a release, whose window drains the fleet
  first.
- `bun wb fleet graceful|force|drain|resume|clear-model`
- `bun wb release run|deploy`, `bun wb server restart-viewer`, `--apply` on
  log retention. `release build --push` rolls nothing but publishes images:
  only as part of a release the operator asked for.
- `bun wb config set|patch|delete|seed|move-lane`, `bun wb campaign publish`:
  writes to the store
- `bun wb run episode`, `bun wb smoke …`, `bun wb accounts …`: they log game
  accounts in, create them, or move characters
- `bun wb site ship`, `bun wb site tiles --upload`: they change the public site
- `kubectl rollout restart|scale|delete|apply|cp`, `docker compose up|restart|down|stop`
- Writing anything under a run directory, and `runner/src/classify.ts`, which
  writes a run's verdict
- Printing env, `.env`, Secrets, a session token or an audit file name

When the operator does ask, the procedure is `docs/RUNBOOK.md`: "Stop it" and
"Updating the live fleet" for what each stop costs which runs, "Deploy window"
for a release, "Lapsed runs" before touching a run with no verdict. Follow it
rather than a remembered recipe.

When in doubt, the read-only path is the answer; put the question to the
operator rather than reaching for a write.
