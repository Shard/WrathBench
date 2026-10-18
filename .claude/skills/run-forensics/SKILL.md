---
name: run-forensics
description: Inspect WrathBench runs read-only with `bun wb inspect` — whether a run is live or paused, its level and xp, its snippets and errors, its trace, the module audit log (move verdicts by op) and what the publisher last did. Use before writing any throwaway script that reads run.sqlite, trajectory.jsonl, audit files or the publisher's state.
---

# Run forensics

Every command is read-only, bounded by default, and strikes the run's session
token from what it prints. Run them from the repository root; they reach the
cluster through the runner pod (or the worldserver and publisher pods) the way
`bun wb` always does, and the compose quickstart with `bun wb --local …`.
Reference: `docs/RUNBOOK.md`, "Inspect a run".

```
bun wb inspect live                                   # every run with a heartbeat: live, or ownerless
bun wb inspect run <run-id> [--since 2h]              # verdict, model, level/xp, quests across restarts, counts, errors by class, sizes, trace, nearby
bun wb inspect trajectory <run-id> --last 20          # one line per snippet or tool call with its result
bun wb inspect trajectory <run-id> --errors --last 10
bun wb inspect trajectory <run-id> --grep 'moveTo|too_far' --since 30m
bun wb inspect trajectory <run-id> --all --last 50    # every record kind; big ones by size only
bun wb inspect audit <run-id>                         # counts per kind, op/opcode and status
bun wb inspect audit <run-id> --op WB_MOVE_RESULT --status target_off_mesh --last 20
bun wb inspect audit <run-id> --summary --op move_path,WB_MOVE_RESULT   # move verdicts by op
bun wb inspect audit <run-id> --since 1h              # a big audit is bisected, not read from the top
bun wb inspect publisher [<run-id>]                   # last flip, versions per run, the secret scan, last passes
```

`--since`/`--until` take `90s`, `30m`, `2h`, `1d`, epoch ms or an ISO time.

## Rules

- **The live rule.** A run is live when its row has neither a termination nor
  a pause; a paused run is unterminated too, so check both. An unterminated,
  unpaused run whose heartbeat is older than two minutes has lost its process:
  `inspect` says `ownerless`.
- **Never read a whole trajectory line.** `trajectory.jsonl` lines run to
  megabytes (the `request` records, old `messages`). Use `inspect trajectory`,
  which caps every field; if you must script, read the head of each line only.
- **The audit files are named after the session token.** Never print a file
  name or a token, never put either in argv, and never `ls` the audit
  directory. `inspect audit` takes a run id, reads the token from `meta.json`,
  hands it on stdin to the reducer in the worldserver, and prints only counts
  or struck records.
- **Never print `meta.json` whole**: `config.token` is the session token.
- Do not print env, `.env` or Secrets while investigating.

## When the pod's image predates the file

`live`, `run` and `trajectory` run `infra/inspect-run.ts` in the runner pod. A
checkout ahead of the deployed image gets "not in the runner pod"; the file
imports only `bun:sqlite` and `node:*`, so run this checkout's copy from stdin:

```
kubectl -n <ns> exec -i deploy/<release>-runner -- bun run - run <run-id> < infra/inspect-run.ts
```

`audit` and `publisher` run on this machine and need no release.

## Offline, against a copy

```
bun infra/inspect-run.ts run <run-id> --runs-dir <dir>
bun infra/inspect-audit.ts <run-id> --audit-dir <dir> --runs-dir <dir>
bun infra/inspect-publisher.ts --state <file>
```

A missing view is a change to these files with a fixture test beside them
(`infra/inspect-*.test.ts`), not a scratch script.
