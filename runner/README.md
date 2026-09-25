# @wrathbench/runner

The fixed harness: agent loop, snippet sandbox, MCP server,
watchdogs, trajectory. Everything here is model-agnostic — the only per-run
variables are the adapter config (base URL, key env var, model id) and the
character. The context policy is fixed in `src/context.ts` and explained in
`docs/METHODOLOGY.md` ("Context policy"); changing it re-baselines results.

## Entry points

The operator entry point is `infra/run-episode.sh`, which loads `.env`,
computes the harness version on the host (the container has no git) and execs
the runner inside the `runner` service of whichever deployment it is pointed
at — the Kubernetes cluster or the local compose stack:

```bash
./infra/run-episode.sh --model <id> [--driver openai|claude-code|codex|stub] [flags...]
./infra/run-episode.sh --resume <run-id>
./infra/run-episode.sh --model <id> --local     # run on the host instead
```

Underneath it is just the runner:

```bash
# a run driven by an OpenAI-compatible model (key read from env, never stored)
bun runner/src/run.ts --driver openai --model <id> --api-base <url> [--api-key-env OPENROUTER_KEY]

# the same loop driven by a scripted stub — harness testing without a model
bun runner/src/run.ts --driver stub --stub runner/test/fixtures/stub-live-check.json

# bound a run: --max-turns caps driver turns, --max-tool-calls caps tool calls
# for the whole episode (default 500; the meaningful bound for an external
# scaffold that owns its own tool loop). `0` disables the ceiling outright.
bun runner/src/run.ts --driver claude-code --model opus --max-tool-calls 200

# the same shape on the OpenAI Codex CLI (a ChatGPT subscription; lane $CODEX_HOME)
bun runner/src/run.ts --driver codex --model gpt-6-astra --effort high

# resume a killed or paused run (same token, same workspace, same trajectory)
bun runner/src/run.ts --resume <run-id>

# MCP over stdio for an external MCP-capable agent
bun runner/src/mcp.ts [--run-id <id>] [--token <token>]

# read a run in minutes
bun runner/src/timeline.ts <run-id>

# manual classification, chiefly environment-defect
bun runner/src/classify.ts <run-id> <reason> [note]
```

Runs live under `data/runs/<run-id>/`. The rest of what `run.ts` reads off
argv (`configFromArgs`) overrides the defaults in `src/config.ts` for that run.

## Drivers

`--driver` picks how the runner reaches the model; the **harness** — what owns
the loop and the context — follows from it. The former spellings `--adapter`
and `claude-subscription` are refused with a message naming the current one,
rather than silently translated.

| driver | harness | what runs the loop | scores? |
| --- | --- | --- | --- |
| `openai` (default) | `wrathbench` | the fixed loop in `src/loop.ts` over an OpenAI-compatible endpoint | yes |
| `stub` | `wrathbench` | the fixed loop over a scripted response file | no |
| `claude-code` | `claude-code` | the `claude` CLI, driven per turn by `src/adapter-claude.ts` | yes, tagged |
| `codex` | `codex` | the `codex` CLI (OpenAI, ChatGPT subscription), one `codex exec` / `exec resume` process per turn, `src/adapter-codex.ts` | yes, tagged |

The harness is stamped into the comparability tuple and shown on every run,
results, ladder and models row. It is a tag, not a partition: claude-code and
codex rows sit in the same charts as wrathbench rows, and `?harness=` on the
API narrows to one when wanted. `harnessVersion`
is a different word — the `git describe` of this repo, which applies to every
harness, since the SDK, tools, prompt and sandbox each CLI drives are ours.
Each CLI scaffold is its own group because each is a different unversioned
summarizer (docs/METHODOLOGY.md).

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

What is *not* a gap: with `--tools ""` the request carries only our tools,
as `mcp__wrathbench__<tool>` — no built-in Bash/Read/Edit/Task at all. And the
system prompt, tool implementations, sandbox, workspace, watchdogs, named
termination/pause reasons and trajectory are the same objects the fixed loop
uses; there is no second sandbox and no second session.

### How it drives

One long-lived `claude -p --input-format stream-json --output-format
stream-json` process for the whole episode. Each driver turn writes the
harness's context message (the same `assembleContext` output the fixed loop
sends) to its stdin and reads stream-json until the `result` line that closes
the turn; in between, the CLI runs its own tool loop against our MCP server.
Per-turn `--continue` is not needed.

Tools reach the runner over a loopback TCP MCP server plus `src/mcp-bridge.ts`,
because `--mcp-config` can only launch a stdio child — running `mcp.ts` as that
child would create a second sandbox and a second session on the same token.

The flags are `claudeArgs`, all present in `claude -p --help` for the pinned
CLI (`--settings` carries the compaction hook, below).
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
  rows and `no-xp` has XP data to measure. Progress is read from `state.xp` as
  well as level.
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
only the workspace — which is the promise the harness makes anyway: the
workspace, not the chat history, is the durable memory.

### The workspace inside the CLI

Three CLI features would otherwise put the scaffold between the model and the
workspace, so each is switched off or bridged:

- **Tool search.** The pinned CLI defers MCP tools behind its own search tool
  unless the server is marked `alwaysLoad` — which ours is, in the generated
  `claude-mcp.json` (`claudeMcpConfig`). A tool the model has to search for
  first is not the fixed tool list both harness groups are promised.
- **Automatic memory.** `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` is always in the
  child's environment: the CLI's own notes would be a second, unversioned memory
  the harness never sees.
- **Compaction.** The whole episode is often one CLI turn, so when the CLI
  compacts its conversation the context message that carried the listing and
  notes.md can go with it. A SessionStart hook with the `compact` matcher, in
  the generated `claude-settings.json` passed as `--settings`, runs
  `src/workspace.ts` on the run's workspace and prints the same block
  `assembleContext` ends each turn with, which the CLI adds back to the model's
  context. That hooks from `--settings` run in `-p` stream-json mode, and that
  `compact` is the event's matcher value, were checked against the pinned CLI;
  a compaction itself needs a model call and has not been observed firing it.

A result served over MCP is capped at `MCP_RESULT_MAX_CHARS` (48,000
characters, `src/mcp.ts`), with the cut stated in the result and the served
text in the trajectory. The CLI truncates past 25,000 tokens and offers an
oversized result as a file the model has no tool to read; the cap keeps every
result under both, and only a snippet's console output can reach it.

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
lane it schedules, see docs/RUNBOOK.md.

The runner refuses to start this driver without the chosen lane's token, and
the refusal names that variable. Note that the
compose `runner` service runs `oven/bun` and has no `claude` binary: install it
into that service, or use `--local` with a module URL the host can reach
(`WRATHBENCH_MODULE_URL`) — the module's port is not published to the host by
default.

## The codex driver

The same shape as claude-code on the OpenAI Codex CLI (`codex-cli` 0.153.4,
pinned in `infra/docker/runner.Dockerfile`), logged in with a ChatGPT
subscription. `src/adapter-codex.ts` mirrors `adapter-claude.ts` invariant for
invariant — one `SandboxHost`, tools over the loopback MCP bridge, the tool-call
ceiling and the watchdogs enforced at every dispatch, a wind-down instead of a
kill mid-turn, a process-group kill on stop, a constructed child environment —
and differs only where the CLI does:

- **One process per turn.** `codex exec --json` runs one turn and exits; the
  next turn is `codex exec resume <thread_id>` on the thread the CLI persisted
  under `$CODEX_HOME/sessions`. The trajectory's `driver` record carries the
  first turn's argv, a `codex_thread` record names the thread, every `request`
  after the first names it too, and one `codex_result` per turn carries the
  turn's status and usage. `codex app-server` (JSON-RPC over stdio, a
  long-lived process, rate-limit and token-usage notifications, typed
  misalignment steers) is the upgrade path once it is no longer marked
  experimental.
- **The prompt goes in on stdin, and stdin is closed.** The positional is `-`;
  the context message is written and stdin ended. argv has a per-argument
  ceiling a turn's context can approach, and an *open* pipe is what hung the
  CLI for 180 s (it reads a piped stdin to EOF as a `<stdin>`
  block).
- **The fixed prompt replaces the CLI's base instructions** via
  `-c model_instructions_file=<run-dir>/codex-instructions.md` — verified to
  replace, not supplement (1.9k input tokens against 14.7k with the default
  preamble). `developer_instructions` would have added a message on top, so it
  is not used. The bytes are `CODEX_SYSTEM_PROMPT`, identical to the
  claude-code render: the one per-harness sentence names "the CLI", never
  which.
- **Flags** are `codexArgs`. `-s`/`-C` are exec-only
  in this version, so the sandbox rides on `sandbox_mode` and the cwd (a temp
  dir, so no AGENTS.md is found) on the process; that keeps the first turn and
  a resumed one identical apart from the `resume <id>` words.
  `--ignore-user-config` keeps the operator's `~/.codex/config.toml` out of the
  run; auth still comes from `CODEX_HOME`. What stays built in —
  `request_user_input`, `view_image`, `apply_patch` — has no config switch in
  0.153.4 and is inert under read-only in an empty cwd.
- **MCP approval.** With `approval_policy="never"` an MCP call that needs
  approval *fails* ("MCP tool call requires approval, but approval policy is
  never" — observed); `default_tools_approval_mode="approve"` on the server is
  what lets ours through (`"auto"` still gates on the tool's readOnlyHint
  and refused). Codex presents the tools to the model as
  `mcp__wrathbench.<tool>` and calls our server with the plain name. The CLI
  runs MCP servers inside its sandbox with a private `/tmp`, which is why the
  bridge is addressed by its repository path.
- **Effort** is `-c model_reasoning_effort=<low|medium|high|xhigh|max|ultra>`;
  `none` and `minimal` are not Codex levels and the driver refuses them by
  name rather than mapping them.
- **Failure vocabulary.** `turn.completed` carries usage only — no cost (a
  subscription; cost stays absent as on the Claude lanes) and, in exec mode,
  no rate-limit window. Exhaustion is a failed turn: `detectCodexFailure`
  maps a usage limit to the `quota-exhausted` pause, a rate limit to
  `rate-limited`, a dead login ("Your access token could not be refreshed",
  401) to `auth-failed`, a blown context window to the `context-limit`
  termination, and the provider's own policy monitor stopping the task (GPT-6
  Astra's misalignment monitor; nobody is there to approve in exec mode) to
  `provider-policy`, with the CLI's message recorded verbatim and no automatic
  steer — the operator's call. An unclassified failed turn is a session note
  and the thread resumes; three in a row end the run as `adapter-error`.

### Billing: the lane's CODEX_HOME or nothing

The CLI's auth precedence is `CODEX_API_KEY`, then `CODEX_ACCESS_TOKEN`, then
the ChatGPT login persisted in `$CODEX_HOME/auth.json`; `OPENAI_API_KEY` is
not read for auth but is the `openai` driver's credential. So the child
environment drops every `OPENAI_*` and `CODEX_*` variable and the whole
Anthropic/Bedrock/Vertex set the claude driver drops, then sets one thing back:
`CODEX_HOME`, to the directory named by the run's lane (`config.subscription`,
an env var whose VALUE is a Codex home; default `CODEX_HOME`). The directory
is never copied per run and `auth.json` is never read or logged: a copied
refresh token is spent by whichever process refreshes first and the other side
then fails with "refresh token was already used" (seen on this host). One
directory per lane, shared by that lane's runs, one live session per lane —
the rule the fleet applies to the Claude lanes.

### Setup, once

```bash
codex login                                   # a ChatGPT subscription; lands in ~/.codex/auth.json
echo 'CODEX_HOME=/home/<you>/.codex' >> .env  # the lane; .env is gitignored
WRATHBENCH_MODULE_URL=http://127.0.0.1:8086 ./infra/run-episode.sh --driver codex --model gpt-6-astra --effort high --local
```

A second subscription is a second directory under a second variable
(`CODEX_HOME_2=/path/to/other-home`) and `--token-env CODEX_HOME_2` names it.
The runner refuses to start without the chosen lane's `auth.json`, naming the
variable. The compose `runner` image installs the CLI; `--local` with a
reachable module URL is the alternative.

## The sandbox

One long-lived Bun child process per session (`src/sandbox/entry.ts`), holding
one SDK client. Snippets share it: `setInterval` routines keep running between
snippets, and top-level bindings persist too (`src/sandbox/rewrite.ts` has the
exact semantics), though the prompt teaches the workspace instead — a binding
dies with the process, a file does not. The ambient surface is documented
once, in the entry file's header, and told to the model in the system prompt.

Imports: a snippet's top-level import statements name workspace files
(`./x`, `x`, `x.ts`, nested paths; a specifier with a scheme such as `node:fs`
passes through). `rewrite.ts` lifts them out of the snippet and turns each into
an awaited dynamic import of the resolved absolute path, checking every named
export so a missing one is an error naming the file; the bindings are the
snippet's own and never copied back. A string-literal `import("./lib/x")` in
the snippet body — often inside a background routine — takes the same path,
resolved when the call runs rather than when the snippet compiled; left alone,
it would resolve against the sandbox's own entry module and fail naming the
harness's path. Scheme specifiers (`node:fs`), absolute paths and computed
arguments are left as written. Only code and JSON files resolve
(`isImportable` in `workspace.ts`); notes.md and other text are read, not
imported. An edited file must load fresh, and so must a file it imports: the
host sends the child the import version after every write, edit or delete of
an importable file, and a Bun runtime plugin in `entry.ts` loads each
workspace module as `<path>?v=<version>`. Bun consults the plugin's
`onResolve` for the snippet's own dynamic import but not for the static
imports inside the module it loads (Bun 1.4.0: a nested `./b` resolved
natively and stayed cached across an edit), so the plugin's `onLoad` carries
the stamp instead, rewriting a workspace module's relative imports to the
version it was loaded at (`stampWorkspaceImports`). A version is a whole fresh
module graph, which is why a module's own state starts over after a code
change, and why the child's memory grows with every version it imports (about
95 KB per edit-then-import of a five-module graph, measured); old graphs are
never asked for again but are not freed. That cost is why the version moves
only when importable code does: notes.md is edited far more often than code,
and an edit to it leaves the loaded modules in place. Query-string versioning also meets a Bun
1.4.0 fault: now and then a freshly loaded graph loses an import binding and
the importing module fails with "x is not defined" (7 in 40,000 graphs with no
plugin involved; none in 20,000 graphs from plain distinct paths). The failed
graph stays cached at that version, so `importWorkspaceModule` in `entry.ts`
retries exactly that error — a name a loaded workspace module really imports —
once, as a fresh graph under a new stamp; a module's own reference to a name it
never imported is its bug and is reported as it happened.

Timeouts, precisely: a snippet that exceeds the per-snippet timeout is
abandoned but the runtime survives; a snippet that blocks the event loop gets
the process killed and respawned, and the state loss is surfaced to the model
as a harness notice. Repeats trip the `snippet-runaway` watchdog. The first
snippet result from any new sandbox process — after a restart, an unexpected
exit, or on a resumed run — begins with a one-line state-reset notice, so the
model reads that its bindings are gone in the result it is looking at, not a
turn later.

Network posture: the real boundary is the deployment's network topology — the
compose network, or whatever the cluster gives the runner pod — under which the
runner reaches `worldserver` and nothing else. In-process, `fetch` and
`WebSocket` are additionally replaced with versions that refuse any host but the
module's — best-effort hardening, not a security boundary.

Filesystem posture: the child is exec'd under a Linux Landlock ruleset
(`src/sandbox/confine.ts`, which holds the read allowlist), so
`.env`, the repo root and the home directory answer `EACCES` from the kernel
however a snippet reaches for them, and nothing anywhere is writable. The
run's workspace is on the allowlist for reads only, so imports resolve; the
grant binds to the directory's inode, which is why the runner creates it once
and empties it in place rather than replacing it. It fails closed, and it
covers the filesystem only — the network posture is the paragraph above.

## The workspace

`data/runs/<id>/workspace/`, owned by `src/workspace.ts`: notes.md, the
model's memory, and whatever other files it writes — usually TypeScript
modules its snippets import. Four tools reach it (`read_file`, `write_file`,
`edit_file`, `delete_file`), and inside a snippet the ambient `files` object
does the same over the IPC hostcall, answered by the same `Workspace` in the
runner process: the child never writes the directory itself. Every turn's
context ends with a listing (path, size, first line of every file) and then
notes.md verbatim, so the notes need no read tool and the other files are
seen without being loaded. On the fixed loop, the message window caps each
message at `WINDOW_MESSAGE_CHARS` (4,000 characters) — except a `read_file`
result, which reaches the model whole: it is a file the model wrote, already
bounded by the per-file limit, and one cut short would have the model editing
against text it was never shown. Snippet output keeps the cap.

Limits are 32,000 characters for notes.md and for any other file and 1 MiB for
the whole workspace. A write or edit that would exceed one is refused with the
size it would have had, the limit and a target, and nothing is written — the
old scratchpad cut the text and appended a marker, which lost the end of the
notes silently from the model's point of view. One that lands above 80% of a
limit succeeds with a warning, and every successful write ends with a usage
line, so the room left is visible before it runs out. `edit_file` is exact
substring replacement with no fuzzy fallback and no argument coercion: a miss,
or a second match without `replace_all`, is refused with the line numbers of
every occurrence.

A `--continue-from` continuation copies the predecessor's whole workspace; a
predecessor from before the workspace hands over its `scratchpad.md` as
notes.md, and so does a resumed run of that age the first time it opens.

## The entrypoint loop (spike)

`--loop entrypoint` (config `loop`; absent is the snippet loop) is a probing
spike of a different agent loop, Screeps-style: the model writes `main.ts` in
its workspace, the harness runs it, and the model is woken to revise it. It is
refused unless the episode is `probing` or `freeplay` (unscored), and on the
claude-code and codex drivers, whose turns a wake would have to become
(`loopRefusal`, `src/config.ts`). A run carries `loop: "entrypoint"` in its
comparability tuple, absent otherwise (the `wiki: false` pattern), and its
prompt hash differs. The snippet loop is unchanged byte for byte:
`test/snippet-mode-pin.test.ts` pins its prompts, tools, context, compiler,
config, tuple and child environment against a fixture captured from the head
the spike was built on.

```bash
./infra/run-episode.sh --driver openai --model <id> --api-base <url> --episode probing --loop entrypoint [--objective "..."]
```

- **The program** (`src/sandbox/program.ts`, in the child). main.ts exports
  `loop(ctx)` — a tick every second, never two at once, 120 s budget — and/or
  an `on` map of handlers keyed by event name, 10 s each. A budget aborts
  `ctx.signal` and is reported once; nothing is killed for running long. A
  throw is caught and counted under a signature (hook, error name, first
  workspace frame, rendered through `workspaceRelative`); its first occurrence
  in a deploy wakes the model, and the program keeps being called. An `sdk`
  call from the program that throws, rejects or answers `ok: false` is counted
  the same way whether or not the program catches it — signature: hook, helper,
  status or error name; text: the helper's own words and the workspace lines
  of the call — because a program that catches everything otherwise stalls
  where nothing can see it. `observeSdk` wraps the client once, at the ambient
  boundary rather than in each helper; a snippet's calls pass through, and two
  call sites of one helper and status share a signature.
- **Deploy on yield** (`SandboxHost.deployAtYield`). When the model ends a
  turn, main.ts loads at the current import version if a code or JSON file
  changed, the program is halted or stopped, or nothing was tried at this
  version; a failed load leaves the running deploy running and is not retried
  until something changes, and a deleted main.ts unloads. On yield because
  edits spread over several tool calls must never load half-applied, and
  because each load is a module graph that is never freed. An `on` key that
  is not an event name (`PROGRAM_EVENT_NAMES`: the SDK's opcodes, the
  stream's `stream_gap` and `stream_error`, and `WB_AREATRIGGER`, which the
  SDK passes through without a schema — a test holds the set to every event
  row of module/PROTOCOL.md) loads, since dispatch is by exact name and it is
  merely never called; the deploy carries a warning naming the key and, when
  one to three names start with it (or it overruns one by up to three
  characters), those names, shown in the next `[wake]` block.
- **Ownership** (`src/sandbox/owners.ts`). Timers and event listeners belong
  to the async context that created them: a snippet's go when it returns (its
  signal is aborted too), a deploy's when it is replaced. Keyed on the async
  context, never on stack frames, which Bun drops for strict-mode tail calls;
  SDK plumbing (the socket and the timers it arms while ingesting) runs with no
  context and is nobody's. Bun evaluates an imported module's top level outside
  the importer's context, so while a deploy imports, a call whose stack runs
  through the workspace is given to that deploy.
- **Memory.** `ctx.memory` (`memory` in a snippet) is one plain-JSON object of
  at most 32,000 characters, saved after every tick, handler and snippet; the
  host writes `memory.json` (`Workspace.writeMemory`), which is never
  importable, so a save never moves the import version, and which the file
  tools refuse by name. Not "just files", because a `.json` write each tick
  would mint a module graph every second.
- **Heartbeat.** The host drains a program report every second, and ten
  seconds without an answer is a blocked event loop. A snippet in flight is
  blamed and the program comes back by itself — unless files changed since
  its deploy, in which case it stays stopped until the yield rather than run
  code the model has not ended its turn on; otherwise the program halts until
  the next yield. Every restart counts toward `snippet-runaway`, asleep or
  awake. On this loop the count is cleared by a sleep that ends with the
  program running and no restart since the yield (or, with no program
  deployed, by a good snippet) — never by ticks alone, so a program that runs
  a few ticks and then blocks on every deploy still ends the run.
- **Waking** (`src/wake.ts`). A reply with no tool call, or the 20th request,
  ends a wake. The model then sleeps until a new error signature, a failed
  load, a halt, a restart, `ctx.wake(reason)`, a level, a quest turn-in or a
  death — coalesced over 2 s, never sooner than 5 s after the yield — or five
  minutes pass; a reason already shown in a request never wakes it again, and
  whatever arrived after the last request was rendered (a report landing
  while the reply was in flight) carries into the next wake rather than being
  cleared unseen.
  Asleep, the stop signal and the watchdogs are checked every second (`idle`
  does not fire on a sleeping model) and the state ticker keeps writing rows.
  Every request of a wake carries a `[wake]` block after the goal line,
  headed "request N of 20 in this wake" so the cap is known before it is met,
  rendered by the pure `renderWake`: the program's deploy and tick counts,
  failed loads, halts, errors with their workspace frames, `ctx.wake` calls,
  the level/xp/money/quest/death/zone delta, action hints, the last 40 lines of
  the program's console and memory.json — whole up to 2,000 characters, else
  its last 2,000 after a count of what comes before (a program appends, so the
  newest entries are at the end), and one line on a later request of the wake
  while it is unchanged. A turn is still one model request. The pre-trim
  `log_status` ask (`TRIM_PENDING_NOTICE_ENTRYPOINT`) names ending the turn as
  the other way through it, since on this loop the call is a tool call and so
  continues the wake.
- **Trajectory.** `wake`, `wake_end`, `deploy` and `program_error` records,
  and `wake` on every `request` and `response` (`EntrypointRecord`,
  `src/trajectory.ts`); a `program_error`'s `kind` is `failed` for an `sdk`
  call and `thrown` for everything else. Each `wake_end` carries the
  program's ticks, longest tick, overruns, halts and restarts since the
  previous one, and the `program_error` rows written just before it count
  each occurrence once; a final `wake_end` (`run_end`) flushes the last
  period. Wake, deploy and version numbers start again in each process, so a
  resumed run is read per segment.
- **What the model is told.** A second prompt body, built from the snippet
  body by exact replacements — a target that is not found throws at load — so
  the SDK surface is the same bytes on both loops: "## Your program" and
  "## Snippets" replace the REPL paragraph, "## Each wake" replaces
  "## Each turn", and the last sentences say a turn ends with a reply without
  a tool call, and that a reply containing any tool call continues the turn
  whatever its text says, until the request cap. `run_snippet`'s description
  becomes "run once, now; nothing it starts outlives it", the goal line adds
  "end your turn by replying without a tool call", and the restart, timeout,
  reset and resume texts say what this loop keeps. None of it names the snippet loop's bindings or routines.

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
them once per turn, which is once per tool batch. The claude-code and codex
drivers check them at every tool dispatch and on a 5s timer, because one of
their turns can run for tens of minutes (see Drivers above).

### Winding a claude-code episode down, rather than killing it

Under `claude-code` the whole episode is usually ONE CLI turn, and the finished
output count, the metered cost and the turn clock exist in exactly one place:
the stream-json `result` envelope that closes it. Killing the CLI the moment a
watchdog fired threw all three away — 6 of 9 runs in one batch fell
back to `tokens.source: "snapshot"` (the API's `message_start` figures, ~300×
low) with no cost at all. So a watchdog or the tool-call ceiling firing mid-turn
records the termination and then *winds down* instead of signalling: every
further tool call is refused with an error telling the model the episode is over
and to stop calling tools — nothing is dispatched, so no observation or action
reaches the game after the termination — while the driver reads the CLI's stream
for a bounded grace (`windDownGraceMs`, default 90s) in the hope of that
`result`. It ends on the `result`, on the CLI exiting, or on the grace expiring,
and a single `wind-down` trajectory record says which and how long it waited. The grace is not playtime: the `termination` record that
closes the active segment was written before the wind-down began. An operator
stop or pause still kills immediately — that is intent, not a measurement
opportunity.

## Tests

`bun test runner` — needs one `bun install` at the repo root first: that links
the wiki workspace package, and without it anything importing
`@wrathbench/wiki/bundle` (searchmemo, wiki, tools) fails with a bare
module-resolution error that reads like a missing dump but is not. The
claude-code driver is tested against a scripted fake `claude` on PATH (`test/fixtures/fake-claude.ts`, which really
speaks MCP back through the bridge). No live stack, no real CLI, no
subscription quota. The codex driver has the same arrangement
(`test/fixtures/fake-codex.ts`, which exits per turn and honours `exec resume`,
plus `test/fixtures/codex-exec-sample.jsonl`, real event lines captured from
codex-cli 0.153.4). The live check is the stub run above, executed inside the
compose runner service.
