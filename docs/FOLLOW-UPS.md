# Follow-ups

Open items as of 2026-08-21, end of the first full build-and-run day. Ordered by
priority. Items graduate out of this file into commits; the dev loop
(docs/PHASE-0.md) decides when.

## Gate work

1. ~~Sandbox restart notice never reached the model~~ **Fixed 2026-08-21**:
   the notice only existed on the timeout→ping→kill path; a child that died on
   its own (gate2-ox-3's case) rejected the eval with a bare error, emitted no
   notice, counted no restart, and left the host holding a dead proc handle.
   `host.ts` now detects unexpected exits in `onExit`, emits the
   `sandbox_restarted` notice with recovery guidance, counts it for the
   runaway watchdog, and respawns lazily. Two tests cover mid-snippet and
   between-snippet death.
2. **Canonical gate-2 confirmation episode.** Every gate-2 element (create,
   accept, kill objectives, loot, turn in, level) happened unaided across
   today's runs, but not as one chain in one episode — gate2-ox-3 accepted its
   kill quest after its killing spree, so it never collected quest kill
   credits. One clean free-model episode on the current harness settles it.
3. **Gate 3 rerun**: after fix 1, one 60+ minute frontier episode with zero
   harness-attributable trajectory errors. gate2-ox-3 (1h01m, 51 turns, 6
   model-attributable errors, 1 harness) shows it is close.
4. **Gate 4 rehearsal**: fresh-machine bring-up from compose + `data/` only —
   clean volumes, rebuild, bootstrap, extraction skipped (data exists), smoke
   probe. Document as the quick-start in README.md.

## Harness quality

5. ~~WB_SESSION_STATE live verification~~ **Verified 2026-08-21** by
   `infra/smoke/module-session-state.ts`: reattach to an in-world session
   delivers one synthetic state event with the right character/guid/position/
   level, a pre-login subscriber gets none, and the event fans out to every
   subscriber with a shared seq.
6. ~~eventCount vs lastSeq +3 drift~~ **Fixed 2026-08-21**: not
   double-application — `lastSeq` was max'd, so after session-retry churn
   restarted the seq numbering it held the old session's max (+3 = the three
   events the aborted first session delivered). `StateCache.apply` now assigns
   `lastSeq` from every non-gap event; `eventCount` remains a lifetime counter
   across sessions by design.
7. ~~Whitelist census review~~ **Done 2026-08-21** over 11 runs (1,723
   drops): no dropped opcode showed a model demonstrably blocked — the
   ADR-0015 small-surface bar holds, all skipped. Two watch-items to
   re-check later, both flagged by the census rather than by a hurt run:
   - `SMSG_QUESTGIVER_STATUS_MULTIPLE`: agents currently get no passive
     quest-marker signal at all (the whitelisted singular STATUS only
     answers explicit queries) and compensate with wiki lookups; fine in
     Northshire's ~5-NPC hub, may not scale to bigger zones.
   - `SMSG_INITIAL_SPELLS`: CONTRACTS promises "known spells" as an
     observation but no opcode serves it; add when a spellcasting class
     first needs `cast_spell` against uncertain ids, not before.
8. Claude-driver ContextBuilder: state sampling and watchdog checks are solid
   now, but a `quota-exhausted` pause still loses the CLI's accumulated
   context on resume (documented; acceptable for shakeout).

8a. **Extractive digest — deferred behind an evidence gate** (2026-08-21
   research verdict, three-agent pass). Dynamic context compaction is not
   needed on current evidence: requests plateau at ~8–12k tokens under the
   fixed policy regardless of episode length. If either signal appears —
   (a) genuine context-size exhaustion in a run, or (b) trajectories showing
   a model re-querying facts it lost to a window trim — build the extractive
   digest: trimmed messages replaced by a deterministic one-line record
   (tool, truncated args, error flag) in a capped ring buffer inside the
   regenerated context message. Within the current harness version: no model
   summarization (conflates constructs, breaks replay) and no per-model
   context scaling (provider-declared context sizes drift for the same model
   id).

8b. **Context engine as a labeled run condition — operator direction,
   deliberately parked** (2026-08-21). When this is picked back up, the
   proposal to draft is: (a) stretch the window well beyond 24–48 in a
   future harness version — observed steady state is ~8–12k tokens against
   131k–200k model contexts, so a much longer stable prefix is nearly free
   under prompt caching and more compute/cost-efficient per run; (b) offer
   threshold-triggered model self-compaction ("grow to X% of budget, then
   the model compacts its own history") as a versioned **context engine**
   recorded in run metadata, the way shakeout runs are stamped — scores
   comparable within an engine, never silently across engines. Rationale:
   the harness is already opinionated in many ways; for end-user-relevant
   evaluation, grow-then-self-compact is the de-facto standard agents run
   under, and context management for games is a fraught problem where
   pinning one tweak of the current policy forever is unlikely to be the
   long-term answer. This supersedes the flat "no model summarization ever"
   phrasing of 8a: that verdict holds for unlabeled changes to the current
   engine, not for a future labeled one.

## Surface candidates (add when a run makes them the obstacle)

9. **Trainers** — every model so far has visited Brother Sammuel and probed
   for a train action (deferred in docs/CONTRACTS.md Phase 0 set). First
   candidate for the next action-surface widening; needs SMSG_TRAINER_LIST
   decode + CMSG_TRAINER_BUY_SPELL.
10. Per-character credentials (PHASE-0 deferred list) — required before any
    run parallelism beyond the current one-account-per-run scheme.

## Housekeeping

11. ~~data/runs/run-mcp-check~~ Deleted 2026-08-21 (pre-fix artifact, no
    termination record).
12. Harness version still reads `git describe --dirty` at run time; freeze to
    a tagged 0.1 once gates 3 and 4 close, per ADR-0004 (everything to date is
    harness validation, not results).
13. **Metric design against grind collapse** (before Phase-1 measurement):
    RuneBench's own site records that raw total-XP "punished exploration" and
    collapsed to "simple grind with as little stopping as possible"; they
    moved to peak XP-rate windows. Our furthest-level metric has the same
    exposure — decide the Phase-1 metric (quest weight, level-per-hour curve,
    or similar) deliberately and write the ADR before the first scored run,
    not after (their mid-eval metric change is half of why aggregators
    exclude their results).
