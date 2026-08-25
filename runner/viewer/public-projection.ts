/**
 * The legal boundary for public snapshots: what of the viewer API may leave
 * the operator's machine.
 *
 * Every projector here builds a FRESH object naming every field it emits — an
 * allowlist by construction. Nothing spreads its input and nothing deletes:
 * several wire shapes (`EntrySummary`, and anything parsed from JSON) can carry
 * keys the type does not declare, so a copy-and-delete projection is unbounded
 * where this one cannot emit a field nobody wrote down.
 *
 * What is withheld, and why (docs/DATA-AND-LEGAL.md; issue #10):
 * - Verbatim game text must not be published. `ItemSample.name` is client
 *   game text, so the `items` array is dropped everywhere it appears; entry
 *   summaries, raw lines and scratchpads are never rendered into a snapshot at
 *   all (the renderer requests none of those routes); minimap tiles are
 *   Blizzard bytes and never leave.
 * - Character names are dropped (`character` reads null); the resolved
 *   race/class labels (`characterLabel`, `raceName`, `className`) stay — they
 *   are this repo's own tables, not game strings.
 * - Free-text fields that can quote the world or the operator's machine are
 *   dropped: `terminationDetail`, `pauseReason`, the operator `objective`, the
 *   model last-error `message` (its enum-ish `reason` stays), a run row's
 *   read-`error`, and the preflight scripts' output `tail`.
 * - No local filesystem path leaves: `configPath`, the roster `path`, and the
 *   wiki bundle annotation (whose `source` is the operator's dump filename).
 * - Nothing host-like leaves: `apiBase` (a LAN base URL is topology), and the
 *   supervisor's pids.
 * The rule when a field is arguable: withhold.
 */

import type {
  AchievementFacts,
  AgentPosition,
  ApiInfoResponse,
  AreaFacts,
  CampaignRowView,
  CampaignsResponse,
  ComparabilityView,
  CostFigure,
  CostView,
  EpisodeIdView,
  EpisodesResponse,
  FleetAccountView,
  FleetEndedView,
  FleetJobView,
  FleetPausedView,
  FleetPreflightView,
  FleetResponse,
  FleetServerView,
  LevelMark,
  ModelEpisodeView,
  ModelRowView,
  ModelRunView,
  ModelsResponse,
  PositionsResponse,
  ResultRun,
  ResultsResponse,
  RunDetailResponse,
  RunListRow,
  RunRow,
  RunsResponse,
  StatePoint,
  TaxiFacts,
  TierView,
  TokenTotals,
  TpsFacts,
  TrackPoint,
  TrackResponse,
} from "./api-types";
import { EPISODE_IDS } from "../src/episodes";

/**
 * The attribution line every published artifact carries.
 * Wording is the operator's to review (docs/DATA-AND-LEGAL.md, "Scale and
 * framing"): change it only with the operator's sign-off.
 */
export const PUBLIC_ATTRIBUTION =
  "WrathBench runs on AzerothCore, the community open-source reconstruction of the 3.3.5a server. Nothing Blizzard-owned is distributed by this site.";

/**
 * A fleet job without its process facts: pid, spawn time and exit code are the
 * operator's host, and `source` (file/queue/policy) is scheduling detail the
 * public table does not render — its `accountClass` already says where it ran.
 */
export type PublicFleetJobView = Omit<FleetJobView, "pid" | "spawnedAt" | "exitCode" | "source">;

/** A fleet response without the supervisor's pid, over the public job rows. */
export interface PublicFleetResponse extends Omit<FleetResponse, "fleetPid" | "jobs"> {
  jobs: PublicFleetJobView[];
}

/* ---------------------------------------------------------- sub-shapes --- */

function projectComparability(c: ComparabilityView): ComparabilityView {
  return {
    harnessVersion: c.harnessVersion,
    promptHash: c.promptHash,
    promptChars: c.promptChars,
    harness: c.harness,
    effort: c.effort,
    budget: {
      maxTurns: c.budget.maxTurns,
      maxToolCalls: c.budget.maxToolCalls,
      idleMs: c.budget.idleMs,
      noXpMs: c.budget.noXpMs,
      episodeMs: c.budget.episodeMs,
      maxSandboxRestarts: c.budget.maxSandboxRestarts,
    },
    objective: c.objective,
    ...(c.wikiCoords !== undefined ? { wikiCoords: c.wikiCoords } : {}),
    // `wikiBundle` is withheld: its `source` names the operator's local dump
    // file, and no public page reads the annotation.
    ...(c.episode !== undefined ? { episode: c.episode } : {}),
    ...(c.episodeOverride !== undefined ? { episodeOverride: c.episodeOverride } : {}),
    serverBuild:
      c.serverBuild === null ? null : { build: c.serverBuild.build, startedAtMs: c.serverBuild.startedAtMs },
    ...(c.resolvedModel !== undefined ? { resolvedModel: c.resolvedModel } : {}),
  };
}

function projectTokenTotals(t: TokenTotals): TokenTotals {
  return {
    source: t.source,
    contextTokens: t.contextTokens,
    promptTokens: t.promptTokens,
    completionTokens: t.completionTokens,
    totalTokens: t.totalTokens,
    cacheReadTokens: t.cacheReadTokens,
    cacheWriteTokens: t.cacheWriteTokens,
    turns: t.turns,
  };
}

function projectTps(t: TpsFacts): TpsFacts {
  return { overall: t.overall, recent: t.recent, replies: t.replies, recentReplies: t.recentReplies };
}

function projectCostFigure(c: CostFigure): CostFigure {
  return {
    usd: c.usd,
    basis: c.basis,
    asIfMetered: c.asIfMetered,
    breakdown:
      c.breakdown === null
        ? null
        : {
            input: c.breakdown.input,
            output: c.breakdown.output,
            cacheRead: c.breakdown.cacheRead,
            cacheWrite: c.breakdown.cacheWrite,
          },
    priceId: c.priceId,
    asOf: c.asOf,
    // The pricing layer's own sentence ("no price on file", ...), never game text.
    note: c.note,
  };
}

function projectCostView(c: CostView): CostView {
  // Spreading here is safe: the spread source is itself a freshly built allowlist.
  return { ...projectCostFigure(c), actual: projectCostFigure(c.actual), expected: projectCostFigure(c.expected) };
}

function projectStatePoint(s: StatePoint): StatePoint {
  return {
    ts: s.ts,
    level: s.level,
    xp: s.xp,
    map: s.map,
    x: s.x,
    y: s.y,
    z: s.z,
    eventCount: s.eventCount,
    lastSeq: s.lastSeq,
    turn: s.turn,
  };
}

function projectAchievements(a: AchievementFacts): AchievementFacts {
  return { earned: a.earned, points: a.points, ids: [...a.ids] };
}

function projectTaxi(t: TaxiFacts): TaxiFacts {
  return { flights: t.flights };
}

function projectAreas(a: AreaFacts): AreaFacts {
  return {
    startArea: a.startArea,
    distinctAreas: a.distinctAreas,
    leftStartArea: a.leftStartArea,
    capitalZone: a.capitalZone,
    zoneMarks: a.zoneMarks,
    areaMarks: a.areaMarks,
  };
}

function projectRunRow(r: RunRow): RunRow {
  return {
    runId: r.runId,
    model: r.model,
    driver: r.driver,
    harness: r.harness,
    shakeout: r.shakeout,
    // The operator objective is withheld: free prose that can quote the world.
    // Its existence still shows — `shakeout` and `comparability.objective` say
    // why the run is unscored without saying what it was told.
    objective: null,
    campaign: r.campaign,
    cell: r.cell,
    extra: r.extra,
    // Character names are withheld; the race/class labels below stand in.
    character: null,
    race: r.race,
    raceName: r.raceName,
    class: r.class,
    className: r.className,
    characterLabel: r.characterLabel,
    platform: r.platform,
    resolvedModel: r.resolvedModel,
    cliVersion: r.cliVersion,
    // The raw base URL is withheld: a LAN endpoint is host topology. The
    // derived `platform` label above is what public pages render.
    apiBase: null,
    harnessVersion: r.harnessVersion,
    comparability: r.comparability === null ? null : projectComparability(r.comparability),
    startedAt: r.startedAt,
    endedAt: r.endedAt,
    terminationReason: r.terminationReason,
    // Free-text detail can quote NPCs, quests and places; the enum-ish reason
    // above is the public fact.
    terminationDetail: null,
    pauseReason: null,
    level: r.level,
    xp: r.xp,
    money: r.money,
    questsCompleted: r.questsCompleted,
    // ItemSample.name is verbatim client game text: the whole array goes.
    items: null,
    mtime: r.mtime,
    bytes: r.bytes,
    live: r.live,
    // `error` (a caught exception's message) is withheld: it can carry paths.
  };
}

function projectRunListRow(r: RunListRow): RunListRow {
  return {
    ...projectRunRow(r),
    tokens: r.tokens === null ? null : projectTokenTotals(r.tokens),
    ...(r.tps !== undefined ? { tps: r.tps === null ? null : projectTps(r.tps) } : {}),
    cost: r.cost === null ? null : projectCostView(r.cost),
    firstTs: r.firstTs,
    lastTs: r.lastTs,
    playtimeMs: r.playtimeMs,
    modelResponses: r.modelResponses,
    // `snapshot` is not carried over: the renderer stamps its own paths after
    // projection, and an input claiming some is not to be believed.
  };
}

function projectLevelMark(l: LevelMark): LevelMark {
  return { level: l.level, ts: l.ts, turn: l.turn, playtimeMs: l.playtimeMs };
}

function projectResultRun(r: ResultRun): ResultRun {
  return {
    runId: r.runId,
    model: r.model,
    ...(r.resolvedModel !== undefined ? { resolvedModel: r.resolvedModel } : {}),
    ...(r.cliVersion !== undefined ? { cliVersion: r.cliVersion } : {}),
    platform: r.platform,
    harnessVersion: r.harnessVersion,
    harnessSeries: r.harnessSeries,
    extra: r.extra,
    race: r.race,
    raceName: r.raceName,
    class: r.class,
    className: r.className,
    characterLabel: r.characterLabel,
    campaign: r.campaign,
    cell: r.cell,
    effort: r.effort,
    harness: r.harness,
    promptHash: r.promptHash,
    serverBuild: r.serverBuild,
    wikiCoords: r.wikiCoords,
    episode: r.episode,
    episodeSource: r.episodeSource,
    episodeOverride: r.episodeOverride,
    toolCalls: r.toolCalls,
    snippets: r.snippets,
    modelResponses: r.modelResponses,
    unscored: r.unscored,
    startedAt: r.startedAt,
    ...(r.endedAt !== undefined ? { endedAt: r.endedAt } : {}),
    ...(r.live !== undefined ? { live: r.live } : {}),
    terminationReason: r.terminationReason,
    levels: r.levels.map(projectLevelMark),
    maxLevel: r.maxLevel,
    xp: r.xp,
    ...(r.xpEarned !== undefined ? { xpEarned: r.xpEarned } : {}),
    money: r.money,
    questsCompleted: r.questsCompleted,
    maps: [...r.maps],
    // Character name withheld here as everywhere; the label fields stand in.
    character: null,
    playtimeMs: r.playtimeMs,
    tokens: r.tokens === null ? null : projectTokenTotals(r.tokens),
    actualCost: r.actualCost === null ? null : projectCostFigure(r.actualCost),
    ...(r.expectedCost !== undefined
      ? { expectedCost: r.expectedCost === null ? null : projectCostFigure(r.expectedCost) }
      : {}),
    ...(r.billing !== undefined ? { billing: r.billing } : {}),
    ...(r.areas !== undefined ? { areas: r.areas === null ? null : projectAreas(r.areas) } : {}),
    ...(r.achievements !== undefined
      ? { achievements: r.achievements === null ? null : projectAchievements(r.achievements) }
      : {}),
    ...(r.taxi !== undefined ? { taxi: r.taxi === null ? null : projectTaxi(r.taxi) } : {}),
    // Free text; same rule as the run row's.
    pauseReason: null,
  };
}

/* ----------------------------------------------------------- responses --- */

export function projectInfo(i: ApiInfoResponse): ApiInfoResponse {
  return {
    service: "wrathbench-viewer",
    // Forced, whatever the source viewer ran as: a snapshot IS the public mode.
    publicMode: true,
    dashboard: i.dashboard,
    dashboardBuild: i.dashboardBuild,
    worldserver:
      i.worldserver === null ? null : { build: i.worldserver.build, startedAtMs: i.worldserver.startedAtMs },
    ...(i.harnessSeries !== undefined
      ? { harnessSeries: i.harnessSeries.map((s) => ({ series: s.series, runs: s.runs })) }
      : {}),
    now: i.now,
  };
}

export function projectRuns(r: RunsResponse): RunsResponse {
  return { runs: r.runs.map(projectRunListRow) };
}

export function projectPositions(p: PositionsResponse): PositionsResponse {
  return {
    positions: p.positions.map(
      (a: AgentPosition): AgentPosition => ({
        runId: a.runId,
        // The name is withheld; the map labels a pip by run id instead.
        character: null,
        model: a.model,
        map: a.map,
        x: a.x,
        y: a.y,
        ts: a.ts,
        level: a.level,
        xp: a.xp,
        money: a.money,
        questsCompleted: a.questsCompleted,
        // Verbatim game text; see the module comment.
        items: null,
        harnessVersion: a.harnessVersion,
      }),
    ),
  };
}

export function projectResults(r: ResultsResponse): ResultsResponse {
  return {
    runs: r.runs.map(projectResultRun),
    episode: r.episode,
    harness: r.harness,
    includeOverrides: r.includeOverrides,
    filteredOut: r.filteredOut,
    overridesExcluded: r.overridesExcluded,
    now: r.now,
  };
}

export function projectEpisodes(e: EpisodesResponse): EpisodesResponse {
  return {
    episodes: e.episodes.map((t) => ({
      id: t.id,
      minutes: t.minutes,
      idleMinutes: t.idleMinutes,
      noXpMinutes: t.noXpMinutes,
      toolCalls: t.toolCalls,
      objectiveAllowed: t.objectiveAllowed,
      scored: t.scored,
      // This repo's own tier description, not game text.
      summary: t.summary,
      members: t.members,
      overrides: t.overrides,
      lapsed: t.lapsed,
      derived: t.derived,
    })),
    untiered: e.untiered,
    now: e.now,
  };
}

export function projectCampaigns(c: CampaignsResponse): CampaignsResponse {
  return {
    campaigns: c.campaigns.map(
      (row: CampaignRowView): CampaignRowView => ({
        campaign: row.campaign,
        config:
          row.config === null
            ? null
            : {
                enabled: row.config.enabled,
                runsPerCell: row.config.runsPerCell,
                cells: [...row.config.cells],
                models: row.config.models,
                complete: row.config.complete,
                account: row.config.account,
              },
        runs: row.runs,
        live: row.live,
        models: [...row.models],
        cells: row.cells.map((cell) => ({
          cell: cell.cell,
          declared: cell.declared,
          runs: cell.runs,
          models: [...cell.models],
          bestLevel: cell.bestLevel,
        })),
        newestRunId: row.newestRunId,
        newestAt: row.newestAt,
      }),
    ),
    orphans: c.orphans,
    // A local path; the public page has no missing-config to explain with it.
    configPath: null,
    now: c.now,
  };
}

const TIER_IDS: readonly TierView[] = ["t0", "t1", "t2"];

function projectModelRun(r: ModelRunView): ModelRunView {
  return {
    runId: r.runId,
    episode: r.episode,
    episodeOverride: r.episodeOverride,
    harnessVersion: r.harnessVersion,
    harnessSeries: r.harnessSeries,
    extra: r.extra,
    ...(r.race !== undefined ? { race: r.race } : {}),
    ...(r.raceName !== undefined ? { raceName: r.raceName } : {}),
    ...(r.class !== undefined ? { class: r.class } : {}),
    ...(r.className !== undefined ? { className: r.className } : {}),
    ...(r.characterLabel !== undefined ? { characterLabel: r.characterLabel } : {}),
    ...(r.resolvedModel !== undefined ? { resolvedModel: r.resolvedModel } : {}),
    startedAt: r.startedAt,
    endedAt: r.endedAt,
    durationMs: r.durationMs,
    bestLevel: r.bestLevel,
    terminationReason: r.terminationReason,
    live: r.live,
    counted: r.counted,
    ...(r.cost !== undefined ? { cost: r.cost === null ? null : projectCostView(r.cost) } : {}),
  };
}

function projectModelRow(row: ModelRowView): ModelRowView {
  const perEpisode: Partial<Record<EpisodeIdView, ModelEpisodeView>> = {};
  // Keyed off the known tier ids, not the object's own keys: an input parsed
  // from JSON could carry any key, and only the four tiers are speakable.
  for (const id of EPISODE_IDS) {
    const e = row.perEpisode[id];
    if (e === undefined) continue;
    perEpisode[id] = {
      counted: e.counted,
      attempts: e.attempts,
      extras: e.extras,
      otherSeries: e.otherSeries,
      target: e.target,
      bestLevel: e.bestLevel,
      reachedL5: e.reachedL5,
      lastEnded: e.lastEnded,
      lastReason: e.lastReason,
      runIds: [...e.runIds],
    };
  }
  return {
    name: row.name,
    model: row.model,
    effort: row.effort,
    platform: row.platform,
    harness: row.harness,
    billing: row.billing,
    declaredTier: row.declaredTier,
    tier: row.tier,
    earnedRung1: row.earnedRung1,
    idle: row.idle,
    status: row.status,
    eligible: [...row.eligible],
    perEpisode,
    ...(row.cooling !== undefined
      ? { cooling: { until: row.cooling.until, rung: row.cooling.rung, reason: row.cooling.reason } }
      : {}),
    ...(row.retired !== undefined ? { retired: { at: row.retired.at, reason: row.retired.reason } } : {}),
    ladder: row.ladder,
    schedulable: { ok: row.schedulable.ok, why: row.schedulable.why, extras: row.schedulable.extras },
    ...(row.resolvedModels !== undefined ? { resolvedModels: [...row.resolvedModels] } : {}),
    runs: row.runs.map(projectModelRun),
    newestRunId: row.newestRunId,
    lastError:
      row.lastError === null
        ? null
        : {
            runId: row.lastError.runId,
            reason: row.lastError.reason,
            // The provider's error prose is withheld — it has carried request
            // bodies and hosts before. The reason above is the public fact.
            message: "",
            at: row.lastError.at,
          },
  };
}

export function projectModels(m: ModelsResponse): ModelsResponse {
  const tiers = {} as ModelsResponse["policy"]["tiers"];
  for (const id of TIER_IDS) {
    const t = m.policy.tiers[id];
    tiers[id] = {
      runsPerEpisode: { e90: t.runsPerEpisode.e90, e360: t.runsPerEpisode.e360 },
      promotesTo: t.promotesTo,
      label: t.label,
    };
  }
  const maxConcurrent: Record<string, number> = {};
  for (const [key, v] of Object.entries(m.policy.maxConcurrent)) {
    if (typeof v === "number") maxConcurrent[key] = v;
  }
  return {
    models: m.models.map(projectModelRow),
    roster: {
      // The roster file's location is the operator's filesystem.
      path: null,
      shape: m.roster.shape,
      count: m.roster.count,
      excluded: m.roster.excluded.map((e) => ({ name: e.name, reason: e.reason })),
    },
    policy: {
      promoteAtLevel: m.policy.promoteAtLevel,
      series: m.policy.series,
      paid: m.policy.paid === null ? null : { maxConcurrent: m.policy.paid.maxConcurrent },
      tiers,
      maxConcurrent,
    },
    ladderMs: [...m.ladderMs],
    harness: m.harness,
    now: m.now,
  };
}

function projectServer(s: FleetServerView): FleetServerView {
  return {
    phase: s.phase,
    since: s.since,
    build: s.build,
    ...(s.prevBuild !== undefined ? { prevBuild: s.prevBuild } : {}),
    // The deploy script's own sentence; the fleet page prints it verbatim.
    detail: s.detail,
    updatedAt: s.updatedAt,
  };
}

function projectPreflight(p: FleetPreflightView): FleetPreflightView {
  return {
    at: p.at,
    serverIdentity: p.serverIdentity,
    ...(p.build !== undefined ? { build: p.build } : {}),
    ok: p.ok,
    ...(p.skipped !== undefined ? { skipped: p.skipped } : {}),
    results: p.results.map((r) => ({
      script: r.script,
      ok: r.ok,
      ms: r.ms,
      // A smoke script's output tail can quote the live world; withheld.
      tail: "",
    })),
  };
}

function projectFleetJob(j: FleetJobView): PublicFleetJobView {
  return {
    name: j.name,
    ref: j.ref,
    episode: j.episode,
    account: j.account,
    accountClass: j.accountClass,
    ...(j.attempt !== undefined ? { attempt: j.attempt } : {}),
    ...(j.resuming !== undefined ? { resuming: j.resuming } : {}),
    models: [...j.models],
    runId: j.runId,
    model: j.model,
    draining: j.draining,
    alive: j.alive,
  };
}

export function projectFleet(f: FleetResponse): PublicFleetResponse {
  return {
    present: f.present,
    server: projectServer(f.server),
    ...(f.startedAt !== undefined ? { startedAt: f.startedAt } : {}),
    ...(f.heartbeatAt !== undefined ? { heartbeatAt: f.heartbeatAt } : {}),
    ...(f.containerized !== undefined ? { containerized: f.containerized } : {}),
    ...(f.stamp !== undefined ? { stamp: f.stamp } : {}),
    ...(f.configLoadedAt !== undefined ? { configLoadedAt: f.configLoadedAt } : {}),
    ...(f.configRejected !== undefined
      ? { configRejected: { since: f.configRejected.since, error: f.configRejected.error } }
      : {}),
    ...(f.preflight !== undefined ? { preflight: projectPreflight(f.preflight) } : {}),
    jobs: f.jobs.map(projectFleetJob),
    accounts: f.accounts.map(
      (a: FleetAccountView): FleetAccountView => ({ account: a.account, class: a.class, job: a.job }),
    ),
    paused: f.paused.map(
      (p: FleetPausedView): FleetPausedView => ({
        runId: p.runId,
        model: p.model,
        account: p.account,
        reason: p.reason,
        since: p.since,
        pauseCount: p.pauseCount,
        resumeAfter: p.resumeAfter,
        elapsedMs: p.elapsedMs,
        budgetMs: p.budgetMs,
        // The supervisor's own sentence about its own scheduling; rendered
        // verbatim by the fleet page and never sourced from the world.
        why: p.why,
      }),
    ),
    ended: f.ended.map(
      (e: FleetEndedView): FleetEndedView => ({ runId: e.runId, model: e.model, ref: e.ref, detail: e.detail }),
    ),
    ...(f.session !== undefined
      ? { session: { finished: f.session.finished, ok: f.session.ok, retried: f.session.retried } }
      : {}),
    ...(f.outstanding !== undefined
      ? {
          outstanding: {
            lower: f.outstanding.lower,
            upper: f.outstanding.upper,
            etaLowerMs: f.outstanding.etaLowerMs,
            etaUpperMs: f.outstanding.etaUpperMs,
            breakdown: f.outstanding.breakdown.map((b) => ({
              group: b.group,
              concurrency: b.concurrency,
              lowerRuns: b.lowerRuns,
              upperRuns: b.upperRuns,
              lowerMinutes: b.lowerMinutes,
              upperMinutes: b.upperMinutes,
            })),
          },
        }
      : {}),
    now: f.now,
  };
}

export function projectRunDetail(d: RunDetailResponse): RunDetailResponse {
  return {
    run: projectRunRow(d.run),
    states: d.states.map(projectStatePoint),
    total: d.total,
    tokens: projectTokenTotals(d.tokens),
    cost: projectCostView(d.cost),
    playtimeMs: d.playtimeMs,
    ...(d.achievements !== undefined
      ? { achievements: d.achievements === null ? null : projectAchievements(d.achievements) }
      : {}),
    ...(d.taxi !== undefined ? { taxi: d.taxi === null ? null : projectTaxi(d.taxi) } : {}),
    ...(d.tps !== undefined ? { tps: d.tps === null ? null : projectTps(d.tps) } : {}),
  };
}

export function projectTrack(t: TrackResponse): TrackResponse {
  return {
    runId: t.runId,
    // The name is withheld everywhere it appears; replay labels by run id.
    character: null,
    model: t.model,
    harnessVersion: t.harnessVersion,
    points: t.points.map(
      (p: TrackPoint): TrackPoint => ({
        ts: p.ts,
        map: p.map,
        x: p.x,
        y: p.y,
        level: p.level,
        xp: p.xp,
        money: p.money,
        questsCompleted: p.questsCompleted,
        turn: p.turn,
      }),
    ),
  };
}
