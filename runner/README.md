# @wrathbench/runner

The fixed harness (ADR-0004): agent loop, snippet sandbox, MCP server,
watchdogs, trajectory. Everything here is model-agnostic — the only per-run
variables are the adapter config (base URL, key env var, model id) and the
character. The context policy is fixed in `src/context.ts` and explained in
`docs/decisions/ADR-0012-context-policy.md`; changing it re-baselines results.

## Entry points

```bash
# a run driven by an OpenAI-compatible model (key read from env, never stored)
bun runner/src/run.ts --adapter openai --model <id> --api-base <url> [--api-key-env OPENROUTER_KEY]

# the same loop driven by a scripted stub — harness testing without a model
bun runner/src/run.ts --adapter stub --stub runner/fixtures/stub-live-check.json

# resume a killed or paused run (same token, same scratchpad, same trajectory)
bun runner/src/run.ts --resume <run-id>

# MCP over stdio for an external MCP-capable agent (Phase-0 gate 2)
bun runner/src/mcp.ts [--run-id <id>] [--token <token>]

# read a run in minutes
bun runner/src/timeline.ts <run-id>

# manual classification, chiefly environment-defect
bun runner/src/classify.ts <run-id> <reason> [note]
```

Runs live under `data/runs/<run-id>/`: `trajectory.jsonl` (every model
request/response, snippet + result, event batch served, periodic state line),
`run.sqlite` (metadata + state rows for cross-run queries), `meta.json` (config
for resume), `scratchpad.md`.

## The sandbox

One long-lived Bun child process per session (`src/sandbox/entry.ts`), holding
one SDK client. Snippets share it: top-level bindings persist (simple
initialized declarations become real globals so routines can keep mutating
them; functions/classes/destructurings are copied onto `globalThis` at snippet
end — `src/sandbox/rewrite.ts` has the exact semantics), and `setInterval`
routines keep running between snippets. Ambient surface: `sdk`, `state`,
`events`, `connect()`, `sleep(ms)`, `scratchpad` — documented once, in the
entry file's header, and told to the model in the system prompt.

Timeouts, precisely: a snippet that exceeds the per-snippet timeout is
abandoned but the runtime survives; a snippet that blocks the event loop gets
the process killed and respawned, and the state loss is surfaced to the model
as a harness notice. Repeats trip the `snippet-runaway` watchdog.

Network posture, honestly: the real boundary is compose topology (the runner
service can only reach `worldserver`). In-process, `fetch` and `WebSocket` are
additionally replaced with versions that refuse any host but the module's —
best-effort hardening, not a security boundary.

## Watchdogs

Named termination reasons, thresholds in one place (`src/config.ts`): `idle`
(no model output), `no-xp` (no level/XP progress once progress was first
observed), `episode-limit`, `snippet-runaway`. `environment-defect` is never
auto-detected — it is applied by a human via `classify.ts` after reading the
trajectory. Model-API quota exhaustion is a *pause* (`window-exhausted`), not a
termination: the run resumes when the window does.

## Tests

`bun test runner` — sandbox eval semantics against the real child process, MCP
dispatch with fixture JSON-RPC, byte-identical context assembly, watchdogs on a
fake clock, trajectory writer. No live stack needed. The live check is the stub
run above, executed inside the compose runner service.
