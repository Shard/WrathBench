# Worklog

The narrative record of what shipped and what broke, one file per day under
`docs/worklogs/`. The trajectory data and the commits are the primary sources; the day
files are what a future session reads instead of drilling the commit log — root cause,
why, and what shipped, with commit hashes.

Convention:

- Date-keyed, never feature-keyed: `docs/worklogs/YYYY-MM-DD.md`, chronological within
  the day, opening with a 3–6 line summary of what the day was about.
- Completed work goes in the day file it shipped on. It never stays in
  `docs/FOLLOW-UPS.md`, which holds open items only; when an item closes, the day file
  gets a one-line `shipped: item N — commit — where it lives` and the number simply
  leaves FOLLOW-UPS. The day file is where a citation to a closed number resolves, so
  that line is not optional — it is the only bridge.
- Agents append to today's day file (create it if absent). This index gets one line per
  day.
- Decisions that shape results go in `docs/METHODOLOGY.md` (edited in place, kept
  consolidated); component-level why goes in the doc that owns the component. A day
  file records that the decision was made and where it landed, it does not restate
  it. (Before 2026-08-25 decisions were numbered ADRs under `docs/decisions/`; day
  files cite those numbers, which resolve through the table at the end of this
  file.)

## Days

- [2026-08-21](worklogs/2026-08-21.md) — Phase 0 gates 1–4 passed, `harness-0.1`
  tagged; context compaction deferred behind an evidence gate (item 8a).
- [2026-08-22](worklogs/2026-08-22.md) — most of the 0.3 surface: four overnight
  post-mortems (death, sandbox crash, loot, turnInQuest), failure-surface audit,
  trainers, the ergonomics passes, questgiver markers and quest objectives deployed,
  dashboard SPA, preflight gate and verified deploys, run dimensions,
  spellbook and raw escape hatch, navigation N1, cooperative
  abort. Bundle rebuilt to schema 3; deploy script and roster scheduler fixed.
- [2026-08-23](worklogs/2026-08-23.md) — `harness-0.3-68` deployed behind a 62s gate;
  wiki coords withheld from scored runs; night-report SDK softenings
  (`equipItem`, `reclaimCorpse`, `moveTo(unit)`, `sleep` reasons, `events.off`); bundle
  schema 4; episode tiers, runner pool, scheduling policy, stillborn runs,
  Models page, COSTS.md; fleet on the pool/queue shape.
- [2026-08-24](worklogs/2026-08-24.md) — run view redesign: two-column layout (feed
  left, meta/comparability/tokens/cost/inventory/controls right), autoscroll fixed to
  the log column with scroll-driven on/off, a full-width cumulative-XP chart with level
  bands on the y-axis, inventory folded into the sidebar.
- [2026-08-25](worklogs/2026-08-25.md) — ladder scatter: cost per run against xp earned,
  one point per model per tier; `all`/overridden/harness controls and the filter note
  dropped from the ladder; episodes counts lead to the ladder; viewer `xpEarned` and
  `expectedCost` on `ResultRun` (restart owed). Model logos across the dashboard:
  `infra/model-lineup.json` as the data-driven identity catalog with a
  `bun run model-logos` CLI fetching pinned, committed SVG assets; icon pucks replace
  anonymous pips on the map. The 50 ADRs consolidated into `docs/METHODOLOGY.md`
  and the owning component docs; `docs/decisions/` deleted; every ADR citation
  outside the worklogs replaced or removed.
- [2026-08-26](worklogs/2026-08-26.md) — lane-2 overnight review (Fable e360 the
  cleanest long-horizon run so far; every model drains the starter zone in 1–3 h and
  grinds after); the class-probe attempt cap, where a failed launch left no trace and
  the fan-out re-picked the same cell forever.
- [2026-08-27](worklogs/2026-08-27.md) — the `idle: "unlimited"` freeplay session
  survives a supervisor restart: `planResumes` admits `freeplay`, and the ref a run id
  names is the authority for both lookups. Resume argv carries the leash.
- [2026-08-28](worklogs/2026-08-28.md) — the free-billing allowlist emptied after its
  one stealth id was revealed and repriced; roster refresh (three dead slugs out, GLM
  Flash 5.3 in under its own name); the price table's lag is item 88.
- [2026-08-29](worklogs/2026-08-29.md) — see the day file.
- [2026-08-30](worklogs/2026-08-30.md) — reflect and the episodic log ship; quest-start items (build 310); the gated public site opens up (tiles, names, redacted feed, legal) and passes three review sweeps
  run (reputation, item-stats) were smoke bugs: a fold race and a chest piece the fixture
  never wears; both pass live, no module change owed.
- [2026-08-31](worklogs/2026-08-31.md) — lane-2 freeplay swap: fable paused at ~90% weekly quota, sonnet-low resumed; item 107 filed (`idle: "none"` alone does not stop a live session)
- [2026-09-01](worklogs/2026-09-01.md) — pre-share copy review: blockers shipped, run ids out of the UI, models freeplay column; items 107 and 19 in flight
- [2026-09-03](worklogs/2026-09-03.md) — gemini-38-flash and muse-spark-13 added at t0 (OpenRouter; OpenCode Spark endpoint down), price sync + windowed-test fix
- [2026-09-04](worklogs/2026-09-04.md) — Cerebras added at t0 (qwen-3.8-27b, first non-OpenRouter paid provider); no cache discount, so an e90 is ~$5–8; muse-spark stream paused to free the paid lane
- [2026-09-05](worklogs/2026-09-05.md) — freeplay stream stats aggregated at read time (`stream` on `/api/run/<id>`); the run page is the stream, not the session
- [2026-09-08](worklogs/2026-09-08.md) — the codex subscription lane in the Helm chart; then the NuSphere cutover: runs, world and lane moved onto the cluster, both streams resumed there
- [2026-09-11](worklogs/2026-09-11.md) — public-release day. Inventory of everything
  outstanding (history unscrubbed and verified so, two dangling VISION.md references,
  fleet-update.sh compose drift); minimap ships, the legal opinion is no longer a gate;
  item 38 closed on Fable's unaided rung 4 in freeplay. Shipped: lean CI (PR checks on
  the pinned Bun plus chart lint/render; item 117 then closed — Flux plus the
  workstation build is the release contract), the issue #31 bucket readback and its
  verifier, the wiki dump filename found leaking into published entries and fixed
  (item 123), container paths made repo-relative, the persisted viewer fact cache
  (item 115), the map's play bar stepping between a stream's attempts (item 119), the
  SDK connect leak (item 114), the repository link behind `VITE_WRATHBENCH_REPO_URL`
  (item 109), ops scripts on kubectl, the two orphaned stream heads ended (item 122).
  Deployed as harness-0.5-552-gb6fff52 — the pin deployed itself out of the shared
  cluster-repo checkout before the images existed, recovered, readback clean. Then the
  pre-public audit nits, the status text read as a public repo, and the community
  files (SECURITY, CONTRIBUTING, Code of Conduct, issue and PR templates). And the
  repository side of the Open shape (items 85 and 111): the gate Worker deleted, two
  hostnames on `shard.page`, a permissive `robots.txt`, `publish-accept --base`, and
  minimap tiles wrongly treated as a new operator decision (they had been decided
  public on 2026-08-30; corrected the same night, tiles uploaded and live). Then the cutover
  itself, to the operator's own Cloudflare account: bucket, data domain, cache rules,
  CORS, the cluster publisher re-pointed and refilling, the SPA deployed at
  `wrathbench.shard.page`, readback and browser pass clean — items 85 and 111 closed
  and issue #31 with them. The EarlyBird copy's retirement is the operator's.

## Resolving a cited item number

`docs/FOLLOW-UPS.md` holds open items only. A number cited elsewhere in the docs
that is not in that file is a *closed* item: it resolves through the
`shipped: item N — commit — where it lives` line in the day file it shipped on
(`grep -r 'shipped: item N' docs/worklogs/`). A closed number is never reused.

## Where the former ADRs went

The first five days of the project recorded decisions as numbered ADRs under
`docs/decisions/`; on 2026-08-25 they were consolidated into
`docs/METHODOLOGY.md` and the owning component docs, and the directory was
deleted. The day files above, commits and old branches still cite the
numbers — this table is where those citations resolve. Full texts: git
history of `docs/decisions/`.

| ADR | Decision | Now lives |
|---|---|---|
| 0001 | WoW 3.3.5a on AzerothCore | METHODOLOGY.md — What WrathBench measures |
| 0002 | Server-side module, client-fidelity contracts | METHODOLOGY.md — Client fidelity; docs/CONTRACTS.md |
| 0003 | Script-and-supervise | METHODOLOGY.md — What WrathBench measures |
| 0004 | Fixed harness, model the only variable | METHODOLOGY.md — What WrathBench measures |
| 0005 | Bun + thin C++ module | CLAUDE.md (toolchain); docs/ARCHITECTURE.md |
| 0006 | Fresh character reset | METHODOLOGY.md — Episodes, lanes, and evidence |
| 0007 | Stock AzerothCore, no playerbots fork | docs/ARCHITECTURE.md (infra) |
| 0008 | Worldserver image from upstream's Dockerfile | docs/ARCHITECTURE.md (infra) |
| 0009 | Headless session on a parked socket | docs/ARCHITECTURE.md (module); METHODOLOGY.md — Client fidelity |
| 0010 | Synthesized movement, update decoding | METHODOLOGY.md — Client fidelity; docs/ARCHITECTURE.md, module/PROTOCOL.md |
| 0011 | Game outcomes are values | METHODOLOGY.md — The model surface |
| 0012 | Runner context policy | METHODOLOGY.md — Context policy |
| 0013 | Quest/combat client-local judgment calls | METHODOLOGY.md — Client fidelity; module/PROTOCOL.md |
| 0014 | Synthetic session-state event on reattach | module/PROTOCOL.md |
| 0015 | SDK surface: simple by default, escape hatch | METHODOLOGY.md — The model surface |
| 0016 | API surface softening | METHODOLOGY.md — The model surface |
| 0017 | Guids are opaque decimal strings | METHODOLOGY.md — The model surface |
| 0018 | Signals recorded, scores derived offline | METHODOLOGY.md — Scoring |
| 0019 | Map view: client minimap tiles, one renderer | docs/ARCHITECTURE.md (dashboard) |
| 0020 | Fleet supervisor as a compose service | docs/OPERATIONS.md |
| 0021 | Client-parity queries in the SDK | METHODOLOGY.md — Client fidelity |
| 0022 | Dashboard SPA over read-only viewer API | docs/ARCHITECTURE.md (dashboard) |
| 0023 | Deploy-window smoke as a supervisor gate | docs/OPERATIONS.md (preflight gate) |
| 0024 | Objective and watchdog overrides are run dimensions | superseded same-day by 0033 — METHODOLOGY.md — Episodes, lanes, and evidence |
| 0026 | The comparability tuple | superseded same-day by 0033 — METHODOLOGY.md — Episodes, lanes, and evidence |
| 0028 | Wiki coordinates are a run dimension | superseded same-day by 0033 — METHODOLOGY.md — Episodes, lanes, and evidence (`wikiCoords`) |
| 0030 | Episode tiers and promotion | superseded same-day by 0033/0034 — METHODOLOGY.md — Episodes, lanes, and evidence; docs/EPISODES.md |
| 0031 | Runner pool and job queue | superseded same-day by 0034 — docs/OPERATIONS.md (scheduling) |
| 0032 | Scheduling policy from run history | superseded same-day by 0034 — docs/OPERATIONS.md (scheduling) |
| 0025 | Raw escape hatch as an opcode allowlist | METHODOLOGY.md — The model surface; module/PROTOCOL.md |
| 0027 | Navigation is the module's | METHODOLOGY.md — Client fidelity; docs/CONTRACTS.md, module/PROTOCOL.md |
| 0029 | Bundle states the ender and the era | METHODOLOGY.md — The reference bundle; wiki/README.md |
| 0033 | Run dimensions and the comparability tuple | METHODOLOGY.md — Episodes, lanes, and evidence (incl. the 2026-08-25 `resolvedModel` addendum) |
| 0034 | Account pool, scheduling from run history | docs/OPERATIONS.md (scheduling) |
| 0035 | Harness and driver are separate words | METHODOLOGY.md — What WrathBench measures |
| 0036 | A fleet stop pauses runs | METHODOLOGY.md — Episodes, lanes, and evidence (what a lapse means for evidence); docs/OPERATIONS.md (the pause mechanics) |
| 0037 | SDK-side outcomes, caller budget | METHODOLOGY.md — The model surface |
| 0038 | The deploy owns the window | docs/OPERATIONS.md (deploy window) |
| 0039 | Run data storage (proposed) | docs/ARCHITECTURE.md (persistence) |
| 0040 | The bundle is a Wrath snapshot | METHODOLOGY.md — The reference bundle; wiki/README.md |
| 0041 | Probe campaigns are the third lane | METHODOLOGY.md — Episodes, lanes, and evidence; docs/EPISODES.md |
| 0042 | The build may ask the world DB about ids | METHODOLOGY.md — The reference bundle; wiki/README.md |
| 0043 | The tier is the evidence budget | METHODOLOGY.md — Episodes, lanes, and evidence |
| 0044 | Cache misses are provider weather | docs/COSTS.md |
| 0045 | Model lineup is the identity catalog | docs/ARCHITECTURE.md (dashboard) |
| 0046 | The harness series is one shell-wide filter | docs/ARCHITECTURE.md (dashboard) |
| 0047 | The runs page is the runs grain, episodes the episodes | docs/ARCHITECTURE.md (dashboard) |
| 0048 | Achievements and flight use are observed, not inferred | METHODOLOGY.md — Client fidelity, Scoring; module/PROTOCOL.md |
| 0049 | A scored run that pauses is a failed attempt | METHODOLOGY.md — Episodes, lanes, and evidence; docs/OPERATIONS.md, docs/EPISODES.md (the mechanics) |
| 0050 | The model names its character | METHODOLOGY.md — Episodes, lanes, and evidence; docs/OPERATIONS.md (the roster's suggestion, account affinity) |
