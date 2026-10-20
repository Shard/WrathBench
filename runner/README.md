# @wrathbench/runner

The agent loop. The runner sits between a model and the game: it hands the
model a fixed set of tools (a TypeScript snippet sandbox with the SDK loaded,
a scratchpad, the event and state views, the reference search), supervises
the episode with watchdogs, and records everything that happened as a
trajectory under `data/runs/<run-id>/`. The operator launches it through
`infra/run-episode.sh` or the fleet supervisor; the viewer (`runner/viewer/`)
reads what it wrote.

Everything here is model-agnostic. The only per-run variables are the driver
config (base URL, key env var, model id) and the character. The context policy
is fixed in `src/context.ts` and explained in `docs/METHODOLOGY.md` ("Context
policy"); changing it re-baselines results.

This file covers the entry points, the drivers and what each CLI harness
does, the context and the tools, the sandbox and the watchdogs, in that order.

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

# the scripted reference run: the route in src/reference/ played through
# run_snippet, stamped and never scored (docs/EPISODES.md)
bun runner/src/run.ts --driver reference --episode e90 --account PROBE

# bound a run: --max-turns caps driver turns, --max-tool-calls caps tool calls
# for the whole episode (default 500; the meaningful bound for an external
# scaffold that owns its own tool loop). `0` disables the ceiling outright.
bun runner/src/run.ts --driver claude-code --model opus --max-tool-calls 200

# the same shape on the OpenAI Codex CLI (a ChatGPT subscription; lane $CODEX_HOME)
bun runner/src/run.ts --driver codex --model gpt-6-astra --effort high

# resume a killed or paused run (same token, same scratchpad, same trajectory)
bun runner/src/run.ts --resume <run-id>

# MCP over stdio for an external MCP-capable agent
bun runner/src/mcp.ts [--run-id <id>] [--token <token>]

# read a run in minutes
bun runner/src/timeline.ts <run-id>

# rebuild every fixed-loop request from the trajectory and check it against
# the hash of what was sent; --line N prints one request rebuilt
bun runner/src/replay.ts <run-id> [--line N]

# manual classification, chiefly environment-defect
bun runner/src/classify.ts <run-id> <reason> [note]
```

Runs live under `data/runs/<run-id>/`. The rest of what `run.ts` reads off
argv (`configFromArgs`) overrides the defaults in `src/config.ts` for that run.

A party member (docs/proposals/GROUP-PLAY.md) is a probe whose campaign
file names its party: the fleet's roster launches it with `--character
<name>`, the character the stager made for it, which is accepted only on a
campaign launch whose definition starts `staged` and must be the member's
own. Hygiene keeps that character, the freshness tripwire stays off, the
launch note says it already exists, and `meta.config.party` names every
member's run, account and character. Its trajectory carries three more
milestone kinds, `group`, `instance` and `kill`, latched in the sandbox
child off `SMSG_GROUP_LIST`, the `instanceType` on the `WB_AREA` after a
transfer and `SMSG_PARTYKILLLOG` (`src/sandbox/party-watch.ts`).

## Drivers

`--driver` picks how the runner reaches the model; the **harness** — what owns
the loop and the context — follows from it. The former spellings `--adapter`
and `claude-subscription` are refused with a message naming the current one,
rather than silently translated.

| driver | harness | what runs the loop | scores? |
| --- | --- | --- | --- |
| `openai` (default) | `wrathbench` | the fixed loop in `src/loop.ts` over an OpenAI-compatible endpoint | yes |
| `stub` | `wrathbench` | the fixed loop over a scripted response file | no |
| `reference` | `wrathbench` | the fixed loop over the scripted reference program, `src/reference/`: one `run_snippet` per turn, branching on the world | no, a labelled line |
| `claude-code` | `claude-code` | the `claude` CLI, driven per turn by `src/adapter-claude.ts` | yes, tagged |
| `codex` | `codex` | the `codex` CLI (OpenAI, ChatGPT subscription), one `codex exec` / `exec resume` process per turn, `src/adapter-codex.ts` | yes, tagged |

The `reference` driver is a transport like the others, with a program in
place of a model. `src/reference/adapter.ts` answers each turn with one
`run_snippet` call and reads back only that call's result. The first snippet
binds the program (`src/reference/program.ts`, sent as its own source text)
and the route (`src/reference/route.ts`) on the sandbox's global. Every later
snippet runs one tick of it inside the snippet timeout, and the tick reports
on a `[log] REF {…}` console line. A sandbox restart drops the binding, the
next tick says `unloaded`, and the program is sent again. The program keeps
its character's name and its step in the scratchpad, so a restart or a resume
picks up where it was. The adapter never ends a run itself.

The harness is stamped into the comparability tuple and shown on every run,
results, ladder and models row. It is a tag, not a partition: claude-code and
codex rows sit in the same charts as wrathbench rows, and `?harness=` on the
API narrows to one when wanted. It can stay a tag because no row mixes two
harnesses: a run is mapped back to its roster entry by model id, and the
roster refuses one model id under two harnesses (`harnessClash` in
`src/config.ts`). A variant of a harness runs as a probe-campaign arm until
the operator promotes it (docs/METHODOLOGY.md, "Harness and driver are
separate words"). `harnessVersion`
is a different word — the `git describe` of this repo, which applies to every
harness, since the SDK, tools, prompt and sandbox each CLI drives are ours.
Each CLI scaffold is its own group because each is a different unversioned
summarizer (docs/METHODOLOGY.md).

The `openai` driver identifies itself the same way to every endpoint:
`User-Agent: WrathBench` and OpenRouter's attribution pair, `HTTP-Referer` and
`X-Title` (`src/adapter.ts`). One header is host-gated. To `opencode.ai` it
also sends `x-opencode-session: <run id>`, the stable per-conversation id that
OpenCode Go's docs ask of agents other than its own client. It never sends the
headers that identify OpenCode's own client.

### The driver contract

A driver is how the runner reaches a model, and nothing more: everything that
decides what a result means stays with the runner, so that adding a driver
adds a transport, not a second benchmark. This is what `openai`, `claude-code`
and `codex` already do, and what another driver would have to.

**The runner owns these, identically for every driver.**

- One `SandboxHost` per run: the SDK runtime, the module session, the
  confinement and the token. A driver never starts a second sandbox or
  session, which is why the CLI drivers reach the tools through a loopback MCP
  listener and `src/mcp-bridge.ts` rather than launching `src/mcp.ts`.
- The tools: `toolsFor` and `callTool` (`src/tools.ts`), the hint drain,
  secret redaction and the exact result text. A driver exposes exactly these
  tools under these names; a transport prefix (`mcp__wrathbench__`) is the
  only difference allowed.
- The prompt: the system prompt bytes `buildSystemPrompt` renders for the
  run's harness, and the per-turn context message from `ContextBuilder`.
  Where a scaffold lets its own base instructions be replaced, they are
  replaced, not supplemented.
- The termination and pause vocabulary (`src/config.ts`), the watchdog
  thresholds, the scratchpad, the episodic log, `reflect`, and the trim or
  compaction ask.
- Run identity: `meta.json`, and the comparability tuple stamped once at
  launch by `comparabilityOf`, with the harness taken from the driver's
  registry entry (`src/drivers.ts`); the unscored stamps; the resume rules.
- The child environment: the `CLI_BASE_ENV` allowlist, one lane credential and
  the run-controlled knobs, and nothing else.

**A driver owns these.**

- The transport and process model — an in-process request, one long-lived
  process, or one process per turn — and so what a "turn" is: one model
  response, or one scaffold turn with its own inner tool loop.
- Who owns history and compaction. The fixed loop applies the context policy;
  a CLI scaffold keeps and compacts its own conversation, which is what makes
  it a different harness, and `contextSentence` (`src/prompt.ts`) tells the
  model which regime it is in.
- How a run dimension maps onto the scaffold. **A level the driver cannot
  express is refused by name, never mapped to a neighbour**: the tuple would
  otherwise carry a level the run never had. codex refuses `none` and
  `minimal`; a dimension a driver has no setting for at all is refused at
  config time, as `compactWindow` is off claude-code and codex
  (`loadRunConfig`). A value the scaffold would silently cap to its own limit
  is refused too, at the first turn that reports the limit ("The compaction
  window", below).
  Reaching the same level by another mechanism is not a neighbour:
  claude-code's `none` is `MAX_THINKING_TOKENS=0`, because its `--effort` has
  no such level.
- Lane mechanics, and classifying the scaffold's failures into the shared
  pause and termination reasons.

**A scaffold driver must also:**

- Enforce the watchdogs and the tool-call ceiling where control actually comes
  back to the runner, which for a scaffold is every MCP `tools/call` — one
  claude-code turn has held 168 calls — and after a termination refuse every
  further call with the fixed wind-down text.
- Kill the process group with a bounded shutdown, run in a temp cwd outside
  the repository, read no user config, skills, hooks or instruction files, and
  run the CLI version pinned in the runner image.
- Remove every built-in that could observe or act outside our tools, and list
  here, in its own section, whatever it cannot remove or whatever the scaffold
  varies by model. That residue is part of what the harness label means
  (docs/METHODOLOGY.md, principle 3): codex's GPT-6 code mode and
  collaboration tools are the case today ("The codex driver", below).

**Harness settings.** A harness setting is a knob of one harness's machinery:
it has the harness's default, a roster entry may override it, and it is
recorded like effort. The compaction window (`compactWindow`), on claude-code
and codex, is the one that exists, and its shape is the pattern. Absent, or
`auto`, is the scaffold's own default and stamps nothing, so every run that says nothing
shares one tuple. A named value is a roster-entry field normalised to one
spelling. It keys the tuple, and it is part of `RosterIdentity`, so an entry
that differs from another only in it owns its own runs and its own row. A
resume keeps it, and a driver without the setting refuses it. An override set
this way is a run dimension, not a per-model prompt: the operator sets it, it
does the same thing to whichever model is given it, and the tuple says so.

**The trajectory records these, whatever the driver.**

- `meta.json` with the config and the tuple. A scaffold driver also writes a
  `driver` record at the start: driver, harness, binary, argv, cwd, the lane
  by env-var name, `systemPromptChars`, and any dimension that travels
  outside argv.
- A `request` record per turn carrying the fresh context message.
- A `response` record per model output. Normalised `usage` (`prompt_tokens`
  including cached, `completion_tokens`, and `cached_tokens`,
  `cache_write_tokens` and `reasoning_tokens` where reported) is attached at
  the finest grain the scaffold reports — per request, per API call or per
  turn — with the raw object beside it.
- For every call, a `tool_call` with its `dispatchTs`, and the `snippet_result`
  or `tool_result` holding the exact text the model saw.
- A `harness` record of kind `compaction` (`CompactionRecord`) for every
  scaffold compaction, with the summary where the scaffold leaves it readable.
- The served model, on first observation (`recordResolved`): what the
  endpoint or the CLI says actually answered, beside what was asked for.
- The termination or pause, a `wind-down` record when there was one, and the
  scaffold's stderr and unparseable lines, bounded.
- Cost as the provider or the CLI reported it, and absent otherwise, never a
  zero. An estimate is the viewer's, marked as-if-metered (`docs/COSTS.md`).

**What a new driver provides.** One adapter, one registry entry and its
fixtures. The runner, the viewer and the fleet read the entry rather than
compare names, so a driver's facts are stated once and the next harness does
not have to find every branch the last one added.
`test/driver-scatter.test.ts` fails on a driver id written as a literal in any
of the three outside the registry and the adapters.

- **The registry entry** (`src/drivers.ts`, `DriverEntry`; import-free so the
  viewer, `infra/` and the dashboard's wire types can read it). It says:
  - `harness`, the tag the tuple stamps, and `kind`: `loop` (our fixed loop
    and a `ChatAdapter`) or `scaffold` (a CLI with its own turn loop, which a
    resume starts fresh).
  - `stamp` for a driver that is not a model, and `route` for the scripted
    reference.
  - Whether a roster may name it (`roster`, `rosterRefusal`), whether
    `policy.maxConcurrent` caps it by id (`capKey`), and the claude-family
    rule it carries (`claudeModels`).
  - `endpoint`: whether it takes `apiBase`, `apiKeyEnv`, `routing` and a
    declared `billing`.
  - `bill` (metered, subscription or none) and, for a subscription, its
    `lane`: the lane key, the default variable, whether the variable holds a
    token or a home directory, whether the fleet places runs among several
    lanes, and the dry-run and container-preflight wording.
  - `cost`: where the actual figure comes from, which price table, the
    catalogue vendor for a bare slug, and the prefix that tells a model id
    from a CLI alias.
  - `compactWindow`, `usage` (how the trajectory carries usage), `rollouts`
    (session files the fleet sweeps), and `podVolumes`.
  A new field is earned the way an SDK helper is: by a branch the driver
  would otherwise need, not in advance.
- **The adapter** (`src/driver-adapters.ts`, `DriverAdapter`): `prepare`,
  the launch preflight that checks the key or lane, redacts the credential,
  names a CLI lane in the recorded config and builds a fixed-loop driver's
  `ChatAdapter`, refusing with exit 2 before the sandbox is up; and, for a
  scaffold, `runEpisode`, which owns everything listed under "A scaffold
  driver must also". The map is `Record<Driver, …>`, so a registry entry
  without an adapter fails typecheck.
- **The context sentence.** `contextSentence` (`src/prompt.ts`) is exhaustive
  over `Harness`, so a new harness fails typecheck until the operator decides
  what the model is told about its history. It changes the prompt hash, so it
  is the operator's call, never a default.
- **Tests and fixtures.** A scaffold gets a fake CLI under `test/fixtures/`
  (`fake-claude.ts`, `fake-codex.ts` are the pattern): a script that speaks
  the CLI's stream format and calls the MCP tools, so the driver test runs a
  whole episode with no model and no network. Add the entry's facts to
  `test/drivers.test.ts`.
- **The image pin.** A CLI is installed at a pinned version in
  `infra/docker/runner.Dockerfile` (`CLAUDE_CODE_VERSION`, `CODEX_VERSION`),
  and its section in this README names the version its behaviour was verified
  against. A pin bump is a deliberate change.
- **The docs.** This README gets the driver's own section: how it drives, what
  it cannot remove, billing and setup. `docs/RUNBOOK.md` gets its lane, its
  setup and anything an operator runs. `docs/COSTS.md` gets how its cost is
  read when the CLI reports one, and how it is estimated when it does not.

What the entry does not cover, because it carries no driver name for the
guard to see:

- A lane's kind is read off its variable's name (`laneHoldsOf`, by
  `isCodexHomeEnvName`), so a third kind of lane — neither a token nor a Codex
  home — changes that function, and with it the rollout sweep's list of homes
  (`infra/run-fleet-state.ts`).
- The fleet's lane placement (`claudeLanesOf`, `claudeKeysFor`,
  `CLAUDE_TOTAL_KEY` in `src/models.ts`) is written for the one `placed`
  driver, and takes any lane that is not a Codex home as its candidate. A
  second placed driver needs that code generalised first.
- The dashboard is outside the scan: it reads the wire, and its harness
  colours (`LadderChart.tsx`) and its reference test (`isScriptedReference`)
  name harnesses and drivers directly. A new harness gets a colour there.

The checklist, in order:

1. The entry in `DRIVERS` and `DRIVER_TABLE`, and `HARNESSES` if the harness is
   new.
2. The adapter in `DRIVER_ADAPTERS`, and the image pin for a CLI.
3. The context sentence, if the harness is new (the operator's call).
4. The fake CLI, the driver test and the registry test.
5. This README's section, RUNBOOK and COSTS.
6. Probe-campaign arms until the operator promotes it (docs/METHODOLOGY.md,
   "Harness and driver are separate words").

**Two asymmetries are deliberate.**

- `budget.maxToolCalls` is stamped into every tuple, but only the CLI drivers
  enforce it. The fixed loop owns its tool loop, so its bound is `maxTurns`.
  On a `wrathbench` run the field says what ceiling the run was given, not one
  it was held to.
- `resumedFresh` is stamped only by the CLI drivers. A CLI resume starts a
  fresh session and loses the whole conversation the scaffold had built, which
  can be hours of history. A fixed-loop resume rebuilds the bounded window: it
  loses about the 48 messages the window holds, which the context policy
  already treats as disposable, since the scratchpad is the only durable memory
  there with or without a resume.

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
system prompt, tool implementations, sandbox, scratchpad, watchdogs, named
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

The flags are `claudeArgs`, all present in `claude -p --help` for 2.1.238.
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
the pause waits for the window's reset when a `rate_limit_event` named it
(the fleet resumes a freeplay run then), or resume with `--resume <run-id>`
when the window resets. A resumed run starts a
fresh `claude` process: the CLI's own accumulated history does not come back,
only the scratchpad — which is the promise the harness makes anyway: the
scratchpad, not the chat history, is the durable memory.

### The compaction window

A harness setting of both CLI scaffolds since the operator's decision of
2026-10-11; this section is claude-code's mechanics, and "The codex driver"
below has codex's. The CLI summarises its own history once the prompt nears
its auto-compaction window, `CLAUDE_CODE_AUTO_COMPACT_WINDOW`: `auto` or
100k–1M tokens in 2.1.293.
`auto` sits near the model's whole context — with `--debug` the CLI logs
`autocompact: … effectiveWindow=980000` for Claude Haiku 5.5 — so a long run
replays close to a million tokens per call before anything is summarised, and
pays for it above a model's long-prompt price tier. `100k` logs
`effectiveWindow=80000`, and the CLI compacts about 13K below that.

A roster entry (`compactWindow`, docs/RUNBOOK.md), a campaign arm's
`--compact-window` (docs/EPISODES.md) or `--compact-window` by hand sets it
for a run (`RunConfig.compactWindow`); claude-code and codex take it, and
every other driver refuses it. It is a run dimension like effort:
canonicalised to `<n>k` or `1M`, recorded in `meta.json` and the
comparability tuple, matched on beside model and effort
wherever a run is mapped back to its roster entry (`sameRosterIdentity`), and
shown after the effort on the pages (`max · 100k`). Absent is the CLI's
`auto`: nothing is sent and the tuple carries no field, so every run from
before the field reads as `auto` and none restamps. It reaches the CLI only
through the constructed environment (`compactEnv`); a value in the runner's own
environment is dropped like `MAX_THINKING_TOKENS`, so nothing unrecorded can
move it. The CLI's `autoCompactWindow` setting cannot either: the config dir is
the run's own.

**A window the CLI would cap is refused.** The CLI applies the smaller of the
window and the model's context window, so a window at or above the model's
context is one it replaces by its own, and the run would be stamped with a
condition it never ran under. The model's context window is known only from
the CLI's own `modelUsage` (the provider's, not the pinned image's; the
repository keeps no per-model table), and the CLI reports it only on a
turn's `result`, so the driver checks the window at the first turn boundary
and, at or past it, ends the run as `harness-error` with both numbers in the
detail (`claudeWindowCapRefusal`, `src/cli-compaction.ts`). That is never
evidence, and it spends the first turn, however long that turn ran. On
today's all-1M Claude roster `1M` is therefore always refused.

Each compaction the CLI streams — a `system` envelope with subtype
`compact_boundary` and `compact_metadata` (`trigger`, `pre_tokens`, and when
known `post_tokens` and `duration_ms`: recorded by 2.1.239 runs, and the same
mapping is in the pinned 2.1.293 binary) — stays on the trajectory
raw as `claude_system` and is also written as a `harness` record of kind
`compaction` with `trigger`, `preTokens`, `postTokens`, `durationMs`, `at` and
`summary`, so a reader can count a run's compactions without knowing the CLI's
vocabulary. The summary is not on the stream: the CLI writes it into its
session transcript under the run's `claude-config/projects/`, as the first
`user` line flagged `isCompactSummary` after the boundary line with the
envelope's `uuid` (2.1.293 writes two attachment lines between them), and the
driver reads it from there (a bounded tail read, retried on the next few
envelopes) before appending the record. The codex driver writes the same
record off its rollout. It is trajectory only, and the public projection
passes its token counts and duration but never the summary.

**The episodic-log ask** (`src/cli-compaction.ts`; METHODOLOGY, "An episodic
log, asked for at each trim or compaction"). Neither CLI has our trim, so the
status entry the fixed loop asks for before each trim is asked for around the
CLI's compaction instead, through the next turn's harness notices. In the
pinned CLI the compaction starts at the window less `min(maxOutputTokens,
20000)` less 13,000, the window being `compactWindow` or the model's
`contextWindow` off the `result` envelope's `modelUsage` (`auto` on Claude
Haiku 5.5 compacted at a `pre_tokens` of 967,077). At each turn boundary the
driver compares the last API call's context against that threshold, capped by
the lowest context this run has been compacted at — `auto` can apply a
per-model default window the stream never names — and asks
(`compaction_pending`) when the context plus two turns of the cycle's largest
per-turn growth reaches it. A compaction no ask preceded is asked about on the
next turn (`compacted`). Since a claude-code turn can run for hours and a
notice can only ride a turn boundary, that after-ask is the usual case on long
turns. Each ask is a `harness` record of kind `compaction_ask` with the
context, threshold and growth it was decided on.

### Billing: subscription or nothing

The child environment is an allowlist, not the runner's own (`childEnv`): the
plumbing a process needs (`CLI_BASE_ENV` in `src/adapter-shared.ts` — PATH,
HOME, temp, locale, terminal, and proxy/CA variables when the deployment sets
them), `CLAUDE_CONFIG_DIR`, the run-controlled knobs, and one credential — the
token the run's own lane names, copied onto `CLAUDE_CODE_OAUTH_TOKEN`, the only
name the CLI knows. No `ANTHROPIC_*`, Bedrock or Vertex variable, no other
subscription's token, no other provider's key, no module secret and no
database or derived-store password reaches it. So the CLI bills the
subscription it was scheduled on or refuses; it can never fall back to API
credits. (The CLI reports `apiKeySource: "ANTHROPIC_API_KEY"` whenever that
variable is set, which is exactly the fallback being prevented.) The MCP
bridge the CLI launches inherits that environment and reads nothing from it —
it gets the runner's port on argv, and the MCP server it reaches lives in the
runner process — so the MCP config carries no `env` block.
There is no CLI flag that pins the auth source, so this is done with the
environment. For the same reason `CLAUDE_CONFIG_DIR` is redirected to
`<run-dir>/claude-config` — a user-level settings file could reintroduce a key
via `apiKeyHelper` — and the process runs in a fresh temp cwd so no `CLAUDE.md`
(including this repo's) is discovered.

The subscription's usage arrives on the stream: the pinned CLI emits a
`rate_limit_event` frame whenever its rate-limit status changes or a window's
rounded percent or reset does, carrying the five-hour and weekly windows'
utilization and reset (`claudeRateLimitWindows`). The driver records them on
change for the fleet's subscription usage gate, as the codex driver does —
used percent, length, reset; never the overage or credit fields beside them —
waits a spent quota's pause for the rejected window's reset, and stops a
freeplay run at its turn boundary at the freeplay threshold. The shape is read
off the pinned CLI's own bundle; until a frame arrives the lane has no reading
and nothing is held.

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

The same shape as claude-code on the OpenAI Codex CLI (the version
pinned as `CODEX_VERSION` in `infra/docker/runner.Dockerfile`), logged in with a ChatGPT
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
  turn's status and usage. Exec is itself a client of the CLI's in-process
  app server and drops most of what that server says; what the driver needs
  of it comes back from the thread's rollout instead (below). The CLI never
  deletes a rollout, so the driver does once that thread is done with — an
  old thread's after the turn that moved off it, every one at the episode's
  end after the last read — and names the thread it is on in
  `<run-dir>/codex-thread.json`, which the supervisor's hourly sweep keeps
  (docs/RUNBOOK.md, "The Codex lane"). Nothing resumes a thread across
  episodes: a resumed run starts a new one. The standalone
  `codex app-server` would add a long-lived process and typed errors
  (`codexErrorInfo`, a retry flag, misalignment steers); it stays parked while
  upstream marks it experimental and unsupported for production.
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
  run; auth still comes from `CODEX_HOME`. What stays built in follows
  the model's row in the ChatGPT catalogue, not these flags. `gpt-5.5` keeps
  `request_user_input`, `view_image`, `apply_patch` and the goal tools, inert
  under read-only in an empty cwd. GPT-6 models (`gpt-6-astra`, `gpt-6.1-sol`,
  `gpt-6-luna`) are also given the CLI's code mode (`functions.exec`, a
  JavaScript runtime with timers, a store and the clock, and `functions.wait`)
  and its collaboration tools (`spawn_agent` and the rest), with developer
  messages describing them, a skills list and an environment block carrying
  the date and timezone; `--disable multi_agent` does not remove them. That
  per-model surface cannot be configured out, so it is part of what the
  `codex` label means (docs/METHODOLOGY.md, principle 3), and the driver runs
  those models with it rather than refusing them. Every game action still goes through our MCP tools, under the
  tool-call ceiling and the watchdogs.
- **MCP approval.** With `approval_policy="never"` an MCP call that needs
  approval *fails* ("MCP tool call requires approval, but approval policy is
  never" — observed); `default_tools_approval_mode="approve"` on the server is
  what lets ours through (`"auto"` still gates on the tool's readOnlyHint
  and refused). Codex presents the tools to the model as
  `mcp__wrathbench__<tool>` (`mcp__wrathbench.<tool>` before 0.159) and calls
  our server with the plain name. The CLI
  runs MCP servers inside its sandbox with a private `/tmp`, which is why the
  bridge is addressed by its repository path.
- **Effort** is `-c model_reasoning_effort=<low|medium|high|xhigh|max|ultra>`;
  `none` and `minimal` are not Codex levels and the driver refuses them by
  name rather than mapping them.
- **Usage is the thread's, not the turn's.** `turn.completed` carries usage
  only — no cost (a subscription; cost stays absent as on the Claude lanes)
  and no rate-limit window — and that usage is the thread's
  running total: `exec resume` rebuilds the thread, counts included, from its
  rollout. The driver logs each turn's delta against the previous total of the
  same thread as `usage`, with the CLI's figure beside it as
  `usageCumulative`; a total that went backwards (a resume that lost turns
  whose rollout could not be written) counts zero and is the next baseline,
  noted as a `usage_regressed` harness record (`src/codex-usage.ts`). Records
  written before the driver did this carry the total as `usage`; the viewer
  derives the same delta for them at read time.
- **Compaction is in the rollout, not the stream.** The CLI compacts its own
  thread once the last call's tokens reach 90% of the model's catalogue window
  (the `model_context_window` it reports is 95% of that window, so 475,000
  reported is 450,000), mid-turn and usually right after the turn's first
  call; on GPT-6.1 Sol that froze the agent for about two minutes every 25
  turns. Exec mode reports none of it. After each turn the driver reads what
  the CLI appended to the thread's rollout (`CodexRolloutFollower` in
  `src/codex-rollout.ts`, `sessions/**` only) and writes each compaction as a
  `harness` record of kind `compaction`: when it started and how long it took
  (the `ContextCompaction` item), the tokens it compacted and the CLI's
  estimate after, and the summary. On a ChatGPT login the summary is not
  readable: the CLI compacts remotely and keeps only an encrypted item, so the
  record carries `summary: null`, `summaryEncrypted` with the item's length,
  and `retainedTurns`, the turns whose context messages the CLI kept verbatim.
  The same reading drives the episodic-log ask, with the threshold above
  (`src/cli-compaction.ts`; the claude-code section "The compaction window").
- **The compaction window is `model_auto_compact_token_limit`.** A run's
  `compactWindow` (operator, 2026-10-11; the claude-code section "The
  compaction window" has what it is as a run dimension) reaches the CLI as
  the integer `-c model_auto_compact_token_limit=<tokens>` (`codexArgs`):
  `200k` is `200000`, a bare TOML integer, which the pinned CLI reads as an
  `Option<i64>` (`codex-rs/core/src/config/mod.rs` at `rust-v0.159.3`). It
  replaces the catalogue's own limit for the model, and the CLI then compacts
  at the smaller of it and 90% of the catalogue window
  (`ModelInfo::auto_compact_token_limit`), measured against the full active
  context: the run sets neither `model_auto_compact_token_limit_scope`
  (default `total`) nor `model_context_window`, so the 90% cap stands. Unlike
  claude-code there is no summary reserve, so `200k` compacts at 200,000
  tokens, not 167,000; the two harnesses are separate comparability groups
  anyway. The episodic-log ask's threshold is the same minimum. A window at
  or above the 90% cap is one the CLI replaces by its own limit, and the
  catalogue window is the provider's, so the driver checks it at the first
  turn whose rollout reports the window and, at or past the cap, ends the run
  as `harness-error` with both numbers (`codexWindowCapRefusal`). On a
  272,000-token catalogue window (258,400 reported) that refuses `300k`;
  raising the cap would take `model_context_window`, a second dimension the
  run does not set. The window rides on the `driver` record's argv and, by
  name, as its `compactWindow`.
- **The subscription's usage window is in the rollout.** Exec's stdout never
  carries it (upstream declined to add it), but every `token_count` the CLI
  persists carries the account's `rate_limits`. After each turn the driver
  reads the newest one off the rollout and, when it changed, records it as a
  `harness` record of kind `rate_limits` and in meta.json's
  `subscriptionUsage`: per window the used percent, the window's length and
  its reset — never the plan type, credits or any other field. The fleet's
  subscription usage gate reads it (docs/RUNBOOK.md, "The subscription usage
  gate"); a freeplay run stops at its turn boundary once its lane reaches the
  freeplay threshold (`subscription-budget`), resumable at the reset. None of
  it reaches the model or a public page.
- **The model that ran is in the rollout too.** Each turn's `turn_context`
  names the model the CLI ran; the first one seen is promoted onto the run
  (`resolved.model`, the run row's `resolved_model`), as the other drivers
  record theirs. A server-side reroute (`model rerouted: A -> B (reason)`,
  which exec prints as an `error` item and the rollout does not keep) is a
  `harness` record of kind `model_rerouted` beside it; the resolved model
  stays the first one, by the first-observation rule.
- **Failure vocabulary.** Exhaustion is a failed turn, and exec prints a
  failure as words alone (`{"message": …}`, details in parentheses; the
  server's typed `codexErrorInfo` never reaches it), so the classification is
  the text: `detectCodexFailure` maps a usage limit to the `quota-exhausted`
  pause — waiting for the window's reset when the rollout named one, capped at
  seven days, and recording that window as spent so the lane gate holds the
  next attempt until then — a rate limit to
  `rate-limited`, a dead login ("Your access token could not be refreshed",
  401) to `auth-failed`, a blown context window to the `context-limit`
  termination, and the provider's own policy monitor stopping the task (GPT-6
  Astra's misalignment monitor; nobody is there to approve in exec mode) to
  `provider-policy`, with the CLI's message recorded verbatim and no automatic
  steer — the operator's call. The CLI failing on its host — "failed to record
  rollout items", "No space left on device", a thread store it cannot open —
  is the `infrastructure-failed` pause: the model can do nothing about it, and
  a run that kept going would play on a thread that is silently losing turns.
  An unclassified failed turn is a session note and the thread resumes; three
  in a row end the run as `adapter-error`. The model's note says only that the
  turn ended with an error from the CLI; the CLI's own words go to a `harness`
  record for the operator. A policy stop the server words without the CLI's
  own "misalignment policy violation" sentence is such an unclassified turn —
  the known limit of reading exec's words. A retry notice is not a failure:
  `{"type":"error","message":"Reconnecting... 2/5 (…)"}` is the CLI retrying
  (a retried 429 reads exactly like a rate limit), so it is recorded as
  `codex_retry` and never classified; retries that run out end in a
  `turn.failed`, which is.

### Billing: the lane's CODEX_HOME or nothing

The CLI's auth precedence is `CODEX_API_KEY`, then `CODEX_ACCESS_TOKEN`, then
the ChatGPT login persisted in `$CODEX_HOME/auth.json`; `OPENAI_API_KEY` is
not read for auth but is the `openai` driver's credential. So the child
environment is the same kind of allowlist as the claude driver's: the plumbing
(`CLI_BASE_ENV`) and one credential, `CODEX_HOME`, set to the directory named
by the run's lane (`config.subscription`, an env var whose VALUE is a Codex
home; default `CODEX_HOME`). No `OPENAI_*` or other `CODEX_*` variable, no
Claude token and none of the runner's other secrets reach it — which matters
twice over here, because the CLI writes snapshots of its environment under
`$CODEX_HOME/shell_snapshots`, on the lane's volume. The directory
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

## The context, the prompt and the scratchpad tools

The context policy is `docs/METHODOLOGY.md` ("Context policy"); its encoding
is `src/context.ts`. `assembleContext` is pure and tested byte-identical, and a
loop-level test pins the byte-stable prefix where the bytes leave the loop, at
the adapter (docs/COSTS.md measured that the prefix the policy promises is the
prefix that goes over the wire). The HUD state summary is a fixed-format
presentation of already-observed fields, never new observation; a field no
event carried reads `unobserved`.

The message window keeps up to `MESSAGE_WINDOW_MAX` (48) messages, each up to
`WINDOW_MESSAGE_CHARS` (4,000) characters, and trims the oldest
`MESSAGE_WINDOW_TRIM` (24) in one block. Once a trim has happened, the tool
results of the window's older block are folded (`messageWindowFold`,
`foldToolResult`; operator, 2026-10-19), each to one line:

```
[folded by harness] <tool> <args>: <ok|error>[, <n>ms], <m> chars
```

`<args>` is the call's argument string as sent, whitespace runs made one
space, cut at `FOLD_ARGS_CHARS` (80) with `…`; `<n>ms` is the duration a
snippet result opens with, and no other tool reports one; `<m>` is the length
of the whole result, which the trajectory keeps in full. The fold boundary is
the raw cut plus one trim block, snapped back to the start of a turn, so:

- It moves only on the request the cut moves on. Between trims the folded
  part is the same messages rendered the same way and the verbatim part only
  grows at its tail, so the request is byte-stable to the end of the window and
  the fold costs no cache miss beyond the trim's own.
- The raw cut leaves more than one block above it, so the boundary always falls
  in the turn before last or earlier, and the last two turns are verbatim on
  every request: a hint is read in full on the request it arrives in and the
  one after, the trim's included.

The assistant messages, snippet code included, stay as the model sent them.
Re-rendered over six local fixed-loop runs, the fold of results alone cuts
5–17% of the prompt characters per request, and the code in the folded block
is larger than the results beside it in four of the six, so folding it too
would take that to roughly 20–45%. It is kept because it is the model's own turn
— a call shown back truncated invites truncated calls — and because the
sandbox keeps a snippet's top-level bindings, so the code is the window's only
record of what has been defined. The fold is a harness rule, identical for
every model; nothing is summarised and nothing is scaled per model. The
history holds each result's `isError` for the line and never sends it. The
`trim_pending` and `window_trimmed` notices name the fold, the latter with how
many results it folded, and the prompt's context sentence says older tool
results are folded.

The CLI drivers (claude-code, codex) keep and compact their own conversation;
neither the trim nor the fold applies to them, and their prompt sentence
describes their own regime instead.

The system prompt states that this is the complete, unmodified 3.3.5a world —
every zone, city, road, flight path, boat and tram a player could use exists
and is reachable, and nothing has been walled off for the benchmark. It names
no destination, direction or timing, so it steers no play. Observed need: two
opus-low freeplay runs (e360, 2026-08-26, and a11, 2026-08-29) concluded from
local pathing failures that the starter valley was walled and wrote that into
the scratchpad as a hard fact, spending the rest of the episode inside it,
while fable and sonnet runs on the same build left the valley. What to do when
a move fails stays out of the prompt: that is strategy, and it was explicitly
rejected (operator, 2026-08-29).

The scratchpad is edited, not only rewritten (operator, 2026-09-01).
`edit_scratchpad` replaces an exact substring of the pad, taking its shape
from the string-replace edit tool models are trained on (Claude Code's): the
old text must match byte for byte and be unique unless the call says replace
all, and a miss or an ambiguity is refused with what to fix rather than
guessed at — the same refusal discipline referent resolution uses.
`write_scratchpad` stays, because full replacement is a different operation
and not a convenience wrapper over the edit. Observed need (issue #41): about
28% of a high-frequency writer's rewrites (sonnet-low, 26 writes in one run)
changed under 20% of the pad, which is a rewrite tax on the models least able
to afford the output tokens; the sample does not show it fleet-wide, so this
is the profile the evidence covers. There is no read tool: the pad is in
every turn's context already (docs/ARCHITECTURE.md, runner section).

The cap refuses rather than cuts (operator, 2026-10-14; `src/scratchpad.ts`).
It used to keep the head of an over-long write and drop the tail, so a
freeplay run that prepended a turn log lost its durable notes off the end, and
its appends at the cap vanished for eighty turns behind a `{ truncated }` it
never awaited. Now the write, the edit and the snippet's `scratchpad.write` /
`append` all refuse with the size the pad would have reached. On the snippet
side the promise rejects, and a snippet's result waits for the writes it made,
so a refusal it never awaited is still that snippet's error (a write from a
background routine is reported as a background fault). A pad already over the
cap — written before the refusal, or under a lowered cap — stays readable and
accepts any write that leaves it no larger, so the condensing the refusal asks
for is never itself refused. The old cut's marker is stripped on read and on
write. The context header shows the size against the cap every turn.

Three HUD lines were reworked by the same operator decision, under the
condition that they not grow the context much (`src/context.ts`). The quest
line names each quest's title (cut at 24 characters), grouped complete then
in progress so the per-quest state word is gone. The nearby line keeps six
entries but fills them in order with whatever has the character targeted, the
two nearest, then NPCs to act on (a quest to take or hand in, a vendor,
trainer, flight master, innkeeper or banker), then the rest; it was filled by
town guards on nearly every turn of that run. The bag line summarizes — free
slots, grey stacks, the biggest stacks and the uncommon-or-better items —
instead of naming the first eight slots, which never changed.

### The request record and the replay

The fixed loop's `request` record keeps only what nothing else in the
trajectory holds, and points at the rest (`src/request-record.ts`). A request
is `[system prompt, ...message window, fresh user message]`, and of those only
the user message — goal line, notices, HUD, events, scratchpad — is new each
turn. The window is a slice of messages already on the file: each assistant
message is its `response` record's `message`, each tool message its
`tool_result` / `snippet_result` record's `text`, with the `tool_call_id`
read positionally off the response it answers. So the record carries:

```json
{"ts":…,"t":"request","turn":30,"adapter":"openai-compatible:…","slim":2,
 "systemHash":"sha256:…16 hex","window":{"from":24,"to":49,"fromTurn":13,"cap":4000,"fold":24},
 "user":"[turn 30] Goal: …","requestHash":"sha256:…64 hex",
 "messageCount":27,"systemChars":15012,"promptChars":59321}
```

- `user` is the fresh user message, verbatim.
- `window` is `[from, to)` into this process segment's history; `to` is the
  history's length, so `to: 0` opens a segment (a resumed run starts with an
  empty history), read off the writer's own state rather than inferred from
  `resume` or `meta` records. `fromTurn` is the turn whose response opens the
  window; `cap` is the per-message cap it was cut with; `fold` is how many of
  the window's messages, from its start, lie in its folded part ("The context,
  the prompt and the scratchpad tools"). It counts from `from`, not from the
  history's start, because the viewer walks a window back from its request and
  holds nothing below it, and the replay takes it as recorded, never
  recomputed.
- `systemText` — the system prompt itself — rides on a segment's first request,
  and again whenever its hash changes; `systemHash` is `promptHash()`, the
  function the comparability tuple stamps, so it equals the run's
  `comparability.promptHash`. The text is recorded rather than regenerated from
  `prompt.ts` because the prompt moves on and a trajectory has to replay into
  what *its* build sent, across any number of resumes onto newer builds.
- `requestHash` is sha256 of `JSON.stringify(messages)` exactly as handed to
  the adapter — the bytes of the request body's `messages`. The tool list and
  whatever the adapter adds around the messages are outside it, as they were
  outside the full record.
- The counts are what a reader used to compute off the message array.

The writer rebuilds each request from its own history before writing it slim,
and if the rebuild would not reproduce the bytes it writes the whole message
array instead (with `slimFallback` naming why) plus a `harness` record of kind
`request_replay_mismatch`: a slim record is only written when it is known to
replay. A build that changes how a request is put together from these parts
(the cap's suffix, the fold's line or its constants, the message shapes)
writes a new `slim` version and keeps this one's rebuild: `slim: 1`, written
before the fold, has no `fold` and rebuilds as a window with nothing folded.

`src/replay.ts` rebuilds every slim request of a run from the trajectory alone,
streaming the file, and checks each against `requestHash`; a mismatch is
reported with its line, segment and turn and exits non-zero, because it is a
harness bug or an edited record. Records that carry their whole message array
— every fixed-loop request written before the slim shape, and every
claude-code and codex request, whose context the CLI owns and which keep
`messages: [user]` as before — are counted, not rebuilt. A file can hold both:
a run that started before the slim shape and resumed after it has full records
then slim ones, and every reader takes either (`runner/viewer/tail.ts` reads a
slim record's stored counts, and its raw view rebuilds the request through the
same code). Old trajectories are never rewritten.

Tool results and the context message are scrubbed of the secrets the
trajectory scrubs (`Trajectory.redact`) before a request is built ("The
sandbox"), so a request and its record carry the same `[redacted]`. A
registered secret that reached a message any other way would fail the replay
of every request whose prompt held it: the record has `[redacted]` where the
request had the secret. That was already true of a full record, which could
not reproduce those bytes either.

## The sandbox

One long-lived Bun child process per session (`src/sandbox/entry.ts`), holding
one SDK client. Snippets share it: top-level bindings persist
(`src/sandbox/rewrite.ts` has the exact semantics), and `setInterval`
routines keep running between snippets. The ambient surface is documented once,
in the entry file's header, and told to the model in the system prompt.

Timeouts, precisely: a snippet that exceeds the per-snippet timeout is
abandoned but the runtime survives; a snippet that blocks the event loop gets
the process killed and respawned, and the state loss is surfaced to the model
as a harness notice. The client's query answers are not part of that loss:
the host keeps them and seeds each new child before it is ready
(`src/sandbox/client-cache.ts`, `docs/ARCHITECTURE.md` "Persistence").
Repeats trip the `snippet-runaway` watchdog. The abandon
message also says what the snippet was awaiting when the abandoning wait can
say it: how far an awaited `moveTo` had walked, or that an awaited `sleep` was
asked for at least the time the snippet had left — with the ceiling, and that
it could never finish inside the snippet. Neither wait is shortened or refused
for it; the note explains.

The action log: the child's fetch (the one it hands the SDK client) notes
every `POST /action` with the module's answer and the cache names for its ids,
grouped by the snippet whose async context dispatched it, and pushes the notes
to the host — before the snippet's result, before a pong, and on a 60s timer
while no snippet runs. The host links them to the tool call (`EvalLink`:
the caller's `dispatchTs` as `callTs`, and the turn) and hands them to
`onActions`, which `run.ts` and `mcp.ts` write as `actions` records. The SDK's
client-parity queries, fired from the event fold outside every snippet, are
marked `auto`. Record-only; why and the size are in `docs/ARCHITECTURE.md`,
"The action log".

Confinement: the child is exec'd under a Linux Landlock ruleset
(`src/sandbox/confine.ts`, whose `confinementPlan` is the one place the rules
live) that the kernel enforces whatever API a snippet uses. Filesystem: reads
of the interpreter, `runner/`, `sdk/`, `node_modules/` and the manifests, the
child's own `/proc` entry and a few system-wide `/proc` files, and five `/dev`
nodes, so `.env`, the repo root, the home directory, `/tmp`, `/dev/shm` and
every other process's `/proc` entry answer `EACCES`. The last matters because
`/proc/<pid>/environ` is already refused across a Landlock domain but
`/proc/<pid>/cmdline` is not: without the narrowing a snippet could read the
argv of every process it can see, which on a desktop is every process on the
machine. Exec:
only the bun binary and its ELF loader, so `/bin/sh`, `curl` and every other
binary are `EACCES` at spawn (nothing in the sandbox needs to spawn). TCP:
connect only to the port in the run's module URL — the one port the SDK's HTTP
and `/events` WebSocket share — and bind nothing. Scope, on a kernel with
Landlock ABI 6 (Linux 6.12+): no signals to processes outside the domain, the
runner host included, and no abstract unix sockets. It fails closed: without
Landlock, or on an ABI below 4 (Linux 6.7+, the TCP rules), the wrapper exits
instead of exec'ing, and there is no opt-out. Missing scopes are announced on
stderr, not fatal — the fleet's kernel has them; CI's may not.

What that does not cover, plainly: Landlock's TCP rules name a port and no
host, so the child can dial the module's port on any address; UDP (DNS is its
legitimate use), raw sockets and other socket families are outside Landlock
entirely. Both are the deployment's network policy to close. In-process,
`fetch` and `WebSocket` are also replaced with versions that refuse any host
but the module's: a readable error ahead of the kernel's, and the one check
that does look at the host — a second layer, not the boundary.

The session secret in what a snippet prints: the child holds the run's leased
secret (`WRATHBENCH_SECRET`) and a snippet can print it. The model reads
`[redacted]` where it was. Every tool result, on every driver, and every
turn's context message is scrubbed against the secrets registered with the
trajectory before the model reads it (`callTool` in `src/tools.ts`,
`ContextBuilder.build`). That covers a secret a snippet returned, logged or
threw, the crash notice's stderr tail, a chat line that echoed it and the
scratchpad. The model loses nothing by it: the SDK holds the secret, and the
model never has to type it. The record of each result is that same text.
Everywhere else the runner writes the secret, it is `[redacted]` too:
- The trajectory scrubs every record against the same list
  (`leaseRunSecret` registers this one before the child exists).
- The host pipes the child's stdout and stderr and writes them to its own a
  line at a time with the secret replaced (`src/redact.ts`), so neither the
  job log nor the pod log carries it. It folds that log copy after the scrub:
  a line repeated back to back is written once and then as a count
  (`sandbox/log-fold.ts`), because a model's loop printing one line forever is
  what filled a job log to gigabytes. The stderr tail a crash notice quotes to
  the model is read before the fold, as the child wrote it.
- It scrubs the stderr tail the crash notice quotes before cutting it.
- It scrubs what a snippet writes to the scratchpad before storing it, so the
  pad the model is shown is the pad `edit_scratchpad` matches against.

That scrub is also what keeps the secret out of the CLI drivers' own session
files: the claude-code transcript under `<run-dir>/claude-config/projects/`
and the Codex rollout under `$CODEX_HOME/sessions/`. Those files hold the
CLI's record of each tool result and of each prompt, and the CLI writes them,
not the runner. What the runner reads back from them (a compaction summary)
reaches only the trajectory, scrubbed, and the files are never rewritten
(a Codex rollout is deleted once its thread is done with; "The codex driver", above). Neither CLI holds the secret in its environment (`childEnv` is an
allowlist, and the MCP server runs in the runner), so what the model is sent
was the only way in.

What no scrub catches is a piece of the secret: where a cut the child makes
before the host sees the text falls inside it (a logged line or a returned
value past 4,000 characters), or where a snippet prints it in parts. The
secret authenticates only its own run's session. A termination revokes it
(`releaseSessionSecret`); a pause does not, so a paused run's copy stays valid
until the resume re-leases the token, which rotates it.

## Watchdogs

Named termination reasons, thresholds in one place (`src/config.ts`): `idle`
(no model output), `no-xp` (no level/XP progress once progress was first
observed), `episode-limit`, `snippet-runaway`, plus the config ceilings
`turn-limit` (driver turns) and `tool-call-limit` (tool calls per episode).
`environment-defect` is never auto-detected — it is applied by a human via
`classify.ts` after reading the trajectory. Model-API quota exhaustion is a
*pause* (`quota-exhausted`), not a termination: the run resumes when the budget
does. So is any HTTP 429 that survives the retries (`rate-limited`), whatever
the response body says — except OpenCode Go's `GoUsageLimitError`, its spent
allowance, which is `quota-exhausted`. A fixed-loop run on a Go allowance (a Go
base, paid billing; `src/opencode-go.ts`) reads Go's usage endpoint at most
once a minute, never waiting on it at a turn: a spent allowance's pause waits
for the spent window's reset, and a freeplay run stops at its turn boundary at
the freeplay threshold (`subscription-budget`), as on the CLI lanes
(docs/RUNBOOK.md, "The subscription usage gate").

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
