# Decisions

Architecture decision records: one file per decision, numbered, never deleted or
renumbered. The bar for writing one (CLAUDE.md): a choice a future contributor
would ask "why did they do that?" about. Each record is Context / Decision /
Consequences, why over what; mechanics live in the doc that owns the component
(`docs/ARCHITECTURE.md`, `module/PROTOCOL.md`, `docs/OPERATIONS.md`, `docs/EPISODES.md`).

## How to read these

Read the **current** records; a superseded or demoted file is a stub that points
at where the decision now lives, kept only so commits, worklogs and memory that
cite its number still resolve. A consolidating record states the whole decision,
so nobody has to read both. Dates are the day the choice was made, not the day
the file was last edited; an amendment folded into a record is noted at its top.

## Index

| ADR | Title | Status | Why |
|---|---|---|---|
| 0001 | Game and server | current | WoW 3.3.5a on AzerothCore: the richest decision space with an open engine and no established harness. |
| 0002 | Server-side control module with client-fidelity contracts | current | No headless client exists; an in-process module pushing real client opcodes gets client validation for free. |
| 0003 | Script-and-supervise agent model | current | The game is real-time; per-action model decisions would measure latency, so the model writes and supervises routines. |
| 0004 | Fixed harness, model as the only variable | current | Scores are citable only if the harness is frozen per version and identical across models. |
| 0005 | Bun 1.4 and a thin C++ module | current | The module must be C++; everything else is TypeScript on Bun built-ins so the C++ never grows semantics. |
| 0006 | Fresh character reset for Phase 0 | current | A new level-1 character per episode is the simplest reset and uses a client action; snapshots wait for a task that needs them. |
| 0007 | Stock AzerothCore, no playerbots fork | current | One dependency tree; the party question is answered with data from real runs. |
| 0008 | Worldserver image adapted from upstream's Dockerfile | demoted: ARCHITECTURE.md | An implementation note, not a choice a contributor would question. |
| 0009 | Headless WorldSession on a parked loopback socket | current | The core gates both packet paths on a live socket; a parked real socket passes them without a fork. |
| 0010 | Synthesized client movement and update-object decoding | current | Movement is real client packets with server-confirmed arrival; observation decodes the wire's own delta shape instead of a C++ world model. |
| 0011 | Game outcomes are return values, not exceptions | current | "You cannot walk there" is an ordinary answer; only transport errors and absent answers throw. |
| 0012 | Runner context policy | current | One fixed context for every model; the scratchpad is the only memory, and that is part of what is measured. |
| 0013 | Quest/combat surface — the client-local judgment calls | current | Four places where the contracts needed a call: loot replay, spline reduction, parked character delete, raw update fields. |
| 0014 | Synthetic session-state event on WebSocket reattach | demoted: module/PROTOCOL.md | Event-stream mechanics, documented where the stream is. |
| 0015 | SDK surface: simple by default, flexible by escape hatch | current | A small earned primary tier plus a supported raw tier, and deliberately no convenience middle tier. |
| 0016 | API surface softening | current | Repair only what is deterministic, make every rejection actionable, never behave silently wrong. |
| 0017 | Guids are opaque decimal strings at the model surface | current | BigInt was the top error and never load-bearing where models touch it. |
| 0018 | Broad goal, recorded signals, scores derived offline | current | A named metric gets Goodharted; record a signal vector and derive scores later, versioned. |
| 0019 | Map view: minimap tiles from the client, one renderer | current | A position-feed seam so replay reuses the live renderer; tiles stay in `data/`. |
| 0020 | The fleet supervisor is a compose service | current | A host process died at its deadline and crossed the container boundary twice per episode. |
| 0021 | Client-parity queries live in the SDK, except cache-miss lookups | current | The module sends what is needed to read packets; the SDK sends what is needed to show the client's screen. |
| 0022 | Dashboard as a SolidJS SPA over a read-only viewer API | current | Live fleet state needs a component model; the one deliberate dependency exception, with a public-deploy posture designed in. |
| 0023 | The deploy-window smoke is a supervisor gate | current | A worldserver that answers `/health` can still be unable to play; self-restarts must be gated too. |
| 0024 | Objective and watchdog overrides are run dimensions | superseded by 0033 | — |
| 0025 | The raw-action escape hatch is an allowlist of ordinary client opcodes | current | Raw opcodes let a trajectory show need before a surface exists, bounded by "what a stock client sends". |
| 0026 | The comparability tuple is stamped, never recomputed | superseded by 0033 | — |
| 0027 | Navigation is the module's: typed causes, triggers, transports | proposed (gate run pending) | Pathing recovery, areatriggers and transports are what a client does locally, so the module does them. |
| 0028 | Wiki coordinates are a run dimension, withheld in scored runs | superseded by 0033 | — |
| 0029 | The reference bundle states the quest's ender and the wiki's era | current, non-deletion rule retracted by 0040 | The facts were in the wikitext and the strip destroyed them; lift them, and never infer the ender from the giver. |
| 0030 | Episode tiers and promotion | superseded by 0033, 0034 | — |
| 0031 | Runner pool and job queue | superseded by 0034 | — |
| 0032 | Scheduling policy from run history | superseded by 0034 | — |
| 0033 | Run dimensions and the comparability tuple | current | A per-run, recorded, same-shape-for-everyone knob is a dimension, not tuning; the tuple is stamped once and never recomputed. |
| 0034 | Account pool and a scheduling policy from run history | current | Lanes stop owning accounts; the schedule, including promotion, is derived from run history by one rule for every model. |
| 0035 | Harness and driver are separate words | current | What runs the loop and what answers the prompt are two dimensions; conflating them made a driver gap read as a harness one. |
| 0036 | A fleet stop pauses runs | current | Stopping the supervisor used to end live episodes; a stop pauses and a start resumes, on the run's own account. |
| 0037 | SDK-side move outcomes and the caller budget | current | The SDK may answer before the wire when nothing was dispatched, and a passed-in deadline explains a result without ever capping a wait. |
| 0038 | The deploy owns the window | current | One command drains (runs pause), swaps, verifies, resumes — and publishes its phase so the page states what the server is doing instead of guessing. |
| 0039 | Run data storage | proposed | Files stay the record; Parquet + DuckDB next for analysis and a snapshot publisher for the dashboard; ClickHouse only on a named trigger. |
| 0040 | The bundle is a Wrath snapshot | current | Nothing is labelled by era because what is not 3.3.5 is not in the bundle: the cutoff, the page rules and the section rules drop it, with counts in meta. |
