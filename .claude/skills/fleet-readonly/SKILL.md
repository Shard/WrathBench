---
name: fleet-readonly
description: What is safe to run against the live WrathBench fleet while runs are in flight, and what never is. Use before any kubectl, `bun wb` or docker command that touches the cluster or the compose stack, and whenever a task says "check the fleet" or "look at the live run".
---

# Fleet: read-only while runs are live

Live runs are evidence. A restart, a drain or a write in the wrong place costs
a run its attempt or its record. First see what is live, fast:

```
bun wb inspect live          # runs with a heartbeat, in well under a second
bun wb fleet status          # the supervisor's full report (slower)
```

If `inspect live` answers "not in the runner pod", the deployed image predates
it: run this checkout's copy from stdin (skill `run-forensics`, "When the
pod's image predates the file").

## Safe while runs are live

- `bun wb inspect live|run|trajectory|tools|pad|audit|publisher` (skill
  `run-forensics`), from the runner image that reads ClickHouse on: an older
  one walks a live run's `run.sqlite`, so point it only at runs that ended
- `bun wb fleet status`, `bun wb fleet dry-run`, `bun wb fleet state`
- `bun wb config get [key]`, `bun wb config audit [n]`, `bun wb config export`
- `bun wb server health`; `bun wb server log-retention` without `--apply`
- `kubectl get …`, `kubectl logs --tail=N …`, and `kubectl exec … -- cat|ls|stat|du`
  of files that hold no secret (never `meta.json` whole, never the audit directory)
- Anything local: `bun test`, `bun run typecheck`, `bun wb dashboard shots`

## Never, unless the operator asked for exactly that

- **Restart, recreate or delete the worldserver while a run is live.** Module
  changes ship in a release: `bun wb release run`, whose deploy window drains
  the fleet to zero runs before the worldserver is replaced (`docs/RUNBOOK.md`,
  "Deploy window").
- `bun wb fleet graceful|force|drain|resume|clear-model`
- `bun wb release run|deploy`, `bun wb server restart-viewer`, `--apply` on log retention
- `bun wb config set|patch|delete|seed`, `bun wb campaign publish`: the
  supervisor acts on the store within a minute
- `bun wb run episode`, `bun wb accounts …`, `bun wb smoke …`: they log game
  accounts in
- `kubectl rollout restart|scale|delete|apply|cp`, `docker compose up|restart|down`
- Writing anything under a run directory, or `runner/src/classify.ts` on a run
  that may be live
- Printing env, `.env`, Secrets, a session token or an audit file name

When in doubt, the read-only path is the answer; put the question to the
operator rather than reaching for a write.
