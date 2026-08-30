# @wrathbench/runner

The fixed harness: agent loop, snippet sandbox, MCP server,
watchdogs, trajectory. Everything here is model-agnostic — the only per-run
variables are the adapter config (base URL, key env var, model id) and the
character. The context policy is fixed in `src/context.ts` and explained in
`docs/METHODOLOGY.md` ("Context policy"); changing it re-baselines results.

## Entry points

The operator entry point is `infra/run-episode.sh`, which loads `.env`,
computes the harness version on the host (the container has no git) and execs
the runner inside the compose `runner` service:

```bash
./infra/run-episode.sh --model <id> [--driver openai|claude-code|stub] [flags...]
./infra/run-episode.sh --resume <run-id>
./infra/run-episode.sh --model <id> --local     # run on the host instead
```

Underneath it is just the runner:

```bash
# a run driven by an OpenAI-compatible model (key read from env, never stored)
bun runner/src/run.ts --driver openai --model <id> --api-base <url> [--api-key-env OPENROUTER_KEY]

# the same loop driven by a scripted stub — harness testing without a model
bun runner/src/run.ts --driver stub --stub runner/fixtures/stub-live-check.json

# bound a run: --max-turns caps driver turns, --max-tool-calls caps tool calls
# for the whole episode (default 500; the meaningful bound for an external
# scaffold that owns its own tool loop). `0` disables the ceiling outright.
bun runner/src/run.ts --driver claude-code --model opus --max-tool-calls 200

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

## Drivers

`--driver` picks how the runner reaches the model; the **harness** — what owns
the loop and the context — follows from it. The former spellings `--adapter`
and `claude-subscription` are now refused with a message naming the current
one, rather than silently translated.

| driver | harness | what runs the loop | scores? |
| --- | --- | --- | --- |
| `openai` (default) | `wrathbench` | the fixed loop in `src/loop.ts` over an OpenAI-compatible endpoint | yes |
| `stub` | `wrathbench` | the fixed loop over a scripted response file | no |
| `claude-code` | `claude-code` | the `claude` CLI, driven per turn by `src/adapter-claude.ts` | yes, tagged |

The harness is stamped into the comparability tuple and shown on every run,
results, ladder and models row. It is a tag, not a partition: claude-code rows sit
in the same charts as wrathbench rows (the operator's choice for now),
and `?harness=` on the API narrows to one when wanted. `harnessVersion` is a
different word — the `git describe` of this repo, which applies to both
harnesses, since the SDK, tools, prompt and sandbox Claude Code drives are ours.

### Why claude-code is its own harness

Measured against claude 2.1.238 with a local capture proxy (no model calls):

- **Claude Code keeps its own conversation history and compacts it itself.**
  Turn 2's request carries turn 1 verbatim plus its own `context_management`
  edits. The context policy's 24-message window is therefore not in force, and an
  unversioned model-side summarizer sits inside the scaffold — which is why it
  is a different harness and not a `wrathbench` row (see COSTS.md for what
  that does to the token curve).
- Two system blocks precede our prompt: a billing header and "You are a Claude
  agent, built on Anthropic's Claude Agent SDK."
- Each turn's first user message is prefixed with a `<system-reminder>` block.
- Skills and subagents stay registered as slash commands.
- This CLI version has no `--max-turns`, so `--max-turns` on the runner bounds
  only *driver* turns (context injections). For this driver that is not the
  control that matters — see below.

What is *not* a gap: with `--tools ""` the request carries only our eight tools,
as `mcp__wrathbench__<tool>` — no built-in Bash/Read/Edit/Task at all. And the
system prompt, tool implementations, sandbox, scratchpad, watchdogs, named
termination/pause reasons and trajectory are the same objects the fixed loop
uses; there is no second sandbox and no second session.

### How it drives

One long-lived `claude -p --input-format stream-json --output-format
stream-json` process for the whole episode. Each driver turn writes the
harness's context message (the same `assembleContext` output the fixed loop
sends) to its stdin and reads stream-json until the `result` line that closes
the turn; in between, the CLI runs its own tool loop against our MCP server.
Per-turn `--continue` was the fallback and is not needed.

Tools reach the runner over a loopback TCP MCP server plus `src/mcp-bridge.ts`,
because `--mcp-config` can only launch a stdio child — running `mcp.ts` as that
child would create a second sandbox and a second session on the same token.

Exact flags (all present in `claude -p --help` for 2.1.238; see `claudeArgs`):
`-p --verbose --input-format stream-json --output-format stream-json
--system-prompt <the fixed prompt> --mcp-config <run-dir>/claude-mcp.json
--strict-mcp-config --tools "" [--model <id>] --allowed-tools mcp__wrathbench__*`.
`--verbose` is not optional: this CLI rejects `-p --output-format stream-json`
without it. `--allowed-tools` is the whole permission story — verified against
the real CLI (with a local capture proxy standing in for the model, so nothing
was billed) that it dispatches an MCP tool call in headless mode without
`--permission-mode`.

### Bounding the inner loop — the real control

The first real subscription run made this concrete: **one** driver turn ran 143
snippets and 168 tool calls over 40+ minutes. With `maxTurns` counting driver
turns and watchdogs checked only between them, `--max-turns 2` and every
watchdog were inert for the whole run.

So for this driver the enforcement point is the MCP boundary, where control
actually returns to the runner:

- **Every tool dispatch** re-checks the watchdogs and the tool-call ceiling,
  before and after the call (a single snippet can burn minutes).
- **`--max-tool-calls` / `maxToolCallsPerEpisode`** (default 500) caps tool
  calls for the whole episode and terminates as `tool-call-limit`. It is a
  runaway guard, not a task budget. The fixed loop ignores it; its bound is
  `maxTurns`. **`--max-tool-calls 0` disables the ceiling**, and nothing else
  does: leaving the flag off means the 500, on a launch and on a `--resume`
  alike. Argv cannot carry a null, so `0` is the transport spelling and the
  runner normalises it to `null` on read — the config, `meta.json`, the
  comparability tuple and the API only ever hold `null` or a positive number.
  A run with the ceiling off is still bounded by its watchdogs, the
  snippet-runaway guard and every fatal path; the only lane that asks for it is
  the policy's `idle: "unlimited"` freeplay session (`docs/EPISODES.md`).
- A tool call counts as model output, so `idle` means what it says here too: a
  turn that streams tool calls for twenty minutes without a word of assistant
  text is working, not idle.
- A **coarse timer** (5s) covers a turn that makes no tool calls at all, and
  samples the world on `stateIntervalMs` so a long turn still produces state
  rows and `no-xp` has XP data to measure. Progress is now read from
  `state.xp` as well as level.
- When any of these fire, the named termination is written to the trajectory
  **first**, then the CLI is torn down (SIGTERM, SIGKILL after 5s), and the
  episode returns that reason. Tool calls arriving during teardown are refused
  with an explicit "run terminated by the harness" result rather than executed.
- **SIGINT/SIGTERM to the runner** takes the same path and ends the run as
  `manual`, so an externally killed run always leaves a finalised termination
  record instead of an open trajectory.

Subscription window exhaustion (`Claude AI usage limit reached|<epoch>`, or
limit wording on stderr with a non-zero exit) is a **pause**
(`quota-exhausted`) with the reset time in the detail, not a termination —
resume with `--resume <run-id>` when the window resets. A resumed run starts a
fresh `claude` process: the CLI's own accumulated history does not come back,
only the scratchpad — which is the promise the harness makes anyway: the
scratchpad, not the chat history, is the durable memory.

### Billing: subscription or nothing

The child environment is constructed, not inherited. Every `ANTHROPIC_*`,
`AWS_*`, `GOOGLE_*`, `GCLOUD_*`, `CLOUDSDK_*` variable and the Bedrock/Vertex
switches are dropped, and so is every `CLAUDE_CODE_OAUTH_TOKEN*` variable —
the one the run's own lane names is then copied back onto
`CLAUDE_CODE_OAUTH_TOKEN`, the only name the CLI knows. So the CLI sees exactly
one credential, the subscription it was scheduled on: it bills that or it
refuses, it can never fall back to API credits, and it never sees another
subscription's token. (The CLI reports `apiKeySource: "ANTHROPIC_API_KEY"`
whenever that variable is set, which is exactly the fallback being prevented.)
There is no CLI flag that pins the auth source, so this is done with the
environment. For the same reason `CLAUDE_CONFIG_DIR` is redirected to
`<run-dir>/claude-config` — a user-level settings file could reintroduce a key
via `apiKeyHelper` — and the process runs in a fresh temp cwd so no `CLAUDE.md`
(including this repo's) is discovered.

### Setup, once

```bash
claude setup-token                 # prints a long-lived OAuth token
echo 'CLAUDE_CODE_OAUTH_TOKEN=...' >> .env    # .env is gitignored
./infra/run-episode.sh --model opus --driver claude-code
```

A second subscription is a second variable, never a second spelling of the
first, and `--token-env` names it:

```bash
echo 'CLAUDE_CODE_OAUTH_TOKEN_2=...' >> .env
./infra/run-episode.sh --model opus --driver claude-code --token-env CLAUDE_CODE_OAUTH_TOKEN_2
```

The run records the NAME (`config.subscription` in `meta.json`), never the
value, so a reader can tell which subscription paid for it and `--resume` goes
back to the same one. The fleet sets this flag itself — a subscription is a
lane it schedules, see docs/OPERATIONS.md.

The runner refuses to start this driver without the chosen lane's token, and
the refusal names that variable. Note that the
compose `runner` service runs `oven/bun` and has no `claude` binary: install it
into that service, or use `--local` with a module URL the host can reach
(`WRATHBENCH_MODULE_URL`) — the module's port is not published to the host by
default.

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
observed), `episode-limit`, `snippet-runaway`, plus the config ceilings
`turn-limit` (driver turns) and `tool-call-limit` (tool calls per episode).
`environment-defect` is never auto-detected — it is applied by a human via
`classify.ts` after reading the trajectory. Model-API quota exhaustion is a
*pause* (`quota-exhausted`), not a termination: the run resumes when the budget
does. So is any HTTP 429 that survives the retries (`rate-limited`), whatever
the response body says.

Where they are checked depends on who owns the tool loop. The fixed loop checks
them once per turn, which is once per tool batch. The claude-code
driver checks them at every tool dispatch and on a 5s timer, because one of its
turns can run for tens of minutes (see Drivers above).

### Winding a claude-code episode down, rather than killing it

Under `claude-code` the whole episode is usually ONE CLI turn, and the finished
output count, the metered cost and the turn clock exist in exactly one place:
the stream-json `result` envelope that closes it. Killing the CLI the moment a
watchdog fired threw all three away — 6 of the 9 lane-2 runs of 2026-08-25 fell
back to `tokens.source: "snapshot"` (the API's `message_start` figures, ~300×
low) with no cost at all. So a watchdog or the tool-call ceiling firing mid-turn
now records the termination exactly as before and then *winds down* instead of
signalling: every further tool call is refused with an error telling the model
the episode is over and to stop calling tools — nothing is dispatched, so no
observation or action reaches the game after the termination — while the driver
reads the CLI's stream for a bounded grace (`windDownGraceMs`, default 90s) in
the hope of that `result`. It ends on the `result`, on the CLI exiting, or on
the grace expiring, and a single `wind-down` trajectory record says which and
how long it waited. The grace is not playtime: the `termination` record that
closes the active segment was written before the wind-down began. An operator
stop or pause still kills immediately — that is intent, not a measurement
opportunity.

## Tests

`bun test runner` — needs one `bun install` at the repo root first: that links
the wiki workspace package, and without it anything importing
`@wrathbench/wiki/bundle` (searchmemo, wiki, tools) fails with a bare
module-resolution error that reads like a missing dump but is not. The suite
covers sandbox eval semantics against the real child process, MCP
dispatch with fixture JSON-RPC, byte-identical context assembly, watchdogs on a
fake clock, trajectory writer, and the claude-code driver against a
scripted fake `claude` on PATH (`test/fixtures/fake-claude.ts`, which really
speaks MCP back through the bridge). No live stack, no real CLI, no
subscription quota. The live check is the stub run above, executed inside the
compose runner service.
