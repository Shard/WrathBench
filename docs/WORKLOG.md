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
- Decisions go in `docs/decisions/` as ADRs; a day file cites the ADR, it does not
  restate it.

## Days

- [2026-08-21](worklogs/2026-08-21.md) — Phase 0 gates 1–4 passed, `harness-0.1`
  tagged; context compaction deferred behind an evidence gate (item 8a).
- [2026-08-22](worklogs/2026-08-22.md) — most of the 0.3 surface: four overnight
  post-mortems (death, sandbox crash, loot, turnInQuest), failure-surface audit,
  trainers, the ergonomics passes, questgiver markers and quest objectives deployed,
  dashboard SPA, preflight gate and verified deploys, run dimensions (ADR-0024/0026),
  spellbook and raw escape hatch (ADR-0025), navigation N1 (ADR-0027), cooperative
  abort. Bundle rebuilt to schema 3; deploy script and roster scheduler fixed.
- [2026-08-23](worklogs/2026-08-23.md) — `harness-0.3-68` deployed behind a 62s gate;
  wiki coords withheld from scored runs (ADR-0028); night-report SDK softenings
  (`equipItem`, `reclaimCorpse`, `moveTo(unit)`, `sleep` reasons, `events.off`); bundle
  schema 4 (ADR-0029); episode tiers, runner pool, scheduling policy, stillborn runs,
  Models page, COSTS.md (ADR-0030/0031/0032); fleet on the pool/queue shape.
- [2026-08-24](worklogs/2026-08-24.md) — run view redesign: two-column layout (feed
  left, meta/comparability/tokens/cost/inventory/controls right), autoscroll fixed to
  the log column with scroll-driven on/off, a full-width cumulative-XP chart with level
  bands on the y-axis, inventory folded into the sidebar.
- [2026-08-25](worklogs/2026-08-25.md) — ladder scatter: cost per run against xp earned,
  one point per model per tier; `all`/overridden/harness controls and the filter note
  dropped from the ladder; episodes counts lead to the ladder; viewer `xpEarned` and
  `expectedCost` on `ResultRun` (restart owed). Model logos across the dashboard:
  `infra/model-lineup.json` as the data-driven identity catalog (ADR-0045) with a
  `bun run model-logos` CLI fetching pinned, committed SVG assets; icon pucks replace
  anonymous pips on the map. Run feed composite rows: turn headers, merged tool-call
  cards (call/snippet/result as one), latency figures with honest suppression for
  post-hoc writers; pairing pure over the window so live tails and edges self-heal.
