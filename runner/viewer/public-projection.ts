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
 * The rule (docs/DATA-AND-LEGAL.md, "Trajectory logs", operator 2026-08-30):
 * published trajectories keep NAMES and IDS — items, quests, NPCs, zones,
 * spells, the runner-generated character name and its race/class labels — and
 * redact game PROSE: quest, gossip, item and mail body text. So `items[].name`,
 * a move's `target`, a position's episodic `status` (the model's own words
 * under a zone name) and `terminationDetail` pass through; entry summaries
 * cross `projectEntry` (an allowlist per entry type) and `redactGameProse`
 * (`redact-prose.ts`, the prose fields enumerated by opcode); the scratchpad
 * is the model's own notes and ships whole.
 *
 * What is still withheld, and why:
 * - Wiki text is never published: a `search_reference` tool result goes whole.
 * - Free text that can quote the operator's machine is dropped: the operator
 *   `objective`, the model last-error `message` (its enum-ish `reason` stays),
 *   a run row's read-`error`, the fleet `configRejected.error`, and the
 *   preflight scripts' output `tail` (smoke output embeds paths).
 *   `pauseReason` keeps only the fixed token `"paused"` (see `pausedToken`),
 *   and the `pause` entry's `detail` goes with it.
 * - No local filesystem path leaves: `configPath`, the roster `path`, the wiki
 *   bundle annotation (whose `source` is the operator's dump filename), and
 *   the `meta`/`driver`/`claude_system` entries' config, binaries and paths.
 *   The one path that survives is made repo-relative rather than withheld:
 *   every exported projector's output crosses `scrubPathsValue`
 *   (`scrub-paths.ts`), which strips the runner image's `/wrathbench` install
 *   prefix wherever a string carries it — a sandbox stack trace or a console
 *   line in model- and harness-authored text — so it reads as the repository
 *   path it already is (operator, 2026-09-11).
 * - Nothing host-like leaves: `apiBase` (a LAN base URL is topology), and the
 *   supervisor's pids.
 * - Minimap tiles are Blizzard bytes and never leave through a snapshot.
 * The rule when a field is arguable: withhold.
 */

import type {
  AchievementFacts,
  CharacterStatus,
  ItemSample,
  AgentPosition,
  ApiInfoResponse,
  AreaFacts,
  CampaignRowView,
  CampaignsResponse,
  ComparabilityView,
  CostFigure,
  CostView,
  EntriesResponse,
  EntrySummary,
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
  SpellFacts,
  StatePoint,
  CharacterAttempt,
  CharacterResponse,
  CharacterTotals,
  CharacterView,
  TalentFacts,
  TaxiFacts,
  TierView,
  TokenTotals,
  ToolsResponse,
  TpsFacts,
  TrackPoint,
  TradeFacts,
  MoveIntentView,
  TrackResponse,
} from "./api-types";
import { EPISODE_IDS } from "../src/episodes";
import { redactGameProse } from "./redact-prose";
import { scrubPathsValue } from "./scrub-paths";

/**
 * The attribution line every published artifact carries.
 * Wording is the operator's (approved verbatim, 2026-08-30; docs/DATA-AND-LEGAL.md,
 * "Scale and framing"): change it only with the operator's sign-off.
 */
export const PUBLIC_ATTRIBUTION =
  "WrathBench is a fan-made research project, not affiliated with or endorsed by Blizzard Entertainment. World of Warcraft is a trademark of Blizzard Entertainment, Inc.";

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

/**
 * The paused *signal* without the prose. The private field is free text (a
 * rate-limit message, an operator's note) that can quote the world or the
 * operator's machine — but the dashboard derives a run's "paused" status from
 * the field's non-nullness, so nulling it would misreport paused runs as
 * something else. A fixed token keeps the status honest while withholding the
 * words; null stays null.
 */
function pausedToken(reason: string | null): string | null {
  return reason === null || reason === "" ? null : "paused";
}

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
    ...(c.wiki === false ? { wiki: false as const } : {}),
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
    // The player frame's numbers, as on the positions feed and the track.
    health: s.health ?? null,
    maxHealth: s.maxHealth ?? null,
    power: s.power ?? null,
    maxPower: s.maxPower ?? null,
    powerType: s.powerType ?? null,
    nextLevelXp: s.nextLevelXp ?? null,
  };
}

function projectAchievements(a: AchievementFacts): AchievementFacts {
  return { earned: a.earned, points: a.points, ids: [...a.ids] };
}

function projectTaxi(t: TaxiFacts): TaxiFacts {
  return { flights: t.flights };
}

/**
 * Spells, talents and trades. Numbers only — spell and talent ids,
 * counts, turn indices and the timestamps the run's own rows already carry.
 * Nothing here can name anything: the record never held a spell name, a talent
 * name or a trading partner, which is why these can be projected whole while
 * `deaths` (corpse positions) is not projected at all.
 */
function projectSpells(f: SpellFacts): SpellFacts {
  return {
    learned: f.learned,
    atLogin: f.atLogin,
    ids: [...f.ids],
    marks: f.marks.map((m) => ({ id: m.id, ts: m.ts, turn: m.turn })),
  };
}

function projectTalents(f: TalentFacts): TalentFacts {
  return {
    spends: f.spends,
    talents: f.talents,
    marks: f.marks.map((m) => ({ id: m.id, points: m.points, ts: m.ts, turn: m.turn })),
  };
}

function projectTrades(f: TradeFacts): TradeFacts {
  const mark = (m: { ts: number; turn: number | null }): { ts: number; turn: number | null } => ({
    ts: m.ts,
    turn: m.turn,
  });
  return {
    trades: f.trades,
    first: f.first === null ? null : mark(f.first),
    last: f.last === null ? null : mark(f.last),
    marks: f.marks.map(mark),
  };
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

/**
 * Item names are names (operator, 2026-08-30); each row is still built by hand.
 *
 * Where a row sits (`slot`, `bag`) and what it is (`itemId`, `quality`) pass
 * with the name: ids are already published material, and none of it is prose.
 * Each is copied only when it is there, so a row that carried none keeps the
 * three keys it was stored with rather than gaining four undefined ones.
 */
function projectItems(items: ItemSample[] | null): ItemSample[] | null {
  const opt = (key: "itemId" | "quality" | "slot" | "bag", v: number | undefined): { [k: string]: number } =>
    typeof v === "number" ? { [key]: v } : {};
  return items === null
    ? null
    : items.map((i) => ({
        name: i.name,
        count: i.count,
        equipped: i.equipped,
        ...opt("itemId", i.itemId),
        ...opt("quality", i.quality),
        ...opt("slot", i.slot),
        ...opt("bag", i.bag),
      }));
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
    character: r.character,
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
    // Names of NPCs, quests and places, at most — never prose (operator, 2026-08-30).
    terminationDetail: r.terminationDetail,
    pauseReason: pausedToken(r.pauseReason),
    // A run id, which every public listing already carries; the lineage is the
    // only thing that makes a freeplay character legible as one character.
    continuedFrom: r.continuedFrom,
    level: r.level,
    xp: r.xp,
    money: r.money,
    questsCompleted: r.questsCompleted,
    items: projectItems(r.items),
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
    ...(r.driver !== undefined ? { driver: r.driver } : {}),
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
    ...(r.wiki !== undefined ? { wiki: r.wiki } : {}),
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
    character: r.character,
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
    ...(r.spells !== undefined ? { spells: r.spells === null ? null : projectSpells(r.spells) } : {}),
    ...(r.talents !== undefined ? { talents: r.talents === null ? null : projectTalents(r.talents) } : {}),
    ...(r.trades !== undefined ? { trades: r.trades === null ? null : projectTrades(r.trades) } : {}),
    // The token, never the prose; same rule as the run row's.
    pauseReason: pausedToken(r.pauseReason),
    continuedFrom: r.continuedFrom,
    stillborn: r.stillborn,
  };
}

/* ----------------------------------------------------------- responses --- */

export function projectInfo(i: ApiInfoResponse): ApiInfoResponse {
  return scrubPathsValue<ApiInfoResponse>({
    service: "wrathbench-viewer",
    // Forced, whatever the source viewer ran as: a snapshot IS the public mode.
    publicMode: true,
    dashboard: i.dashboard,
    // Withheld: this would be the operator's PRIVATE dashboard build id, and
    // the shell's stale-build banner compares it against the build a tab first
    // saw — a lab rebuild would nag every public tab to reload for a bundle it
    // is not running. Null reads as "cannot tell" and never nags.
    dashboardBuild: null,
    worldserver:
      i.worldserver === null ? null : { build: i.worldserver.build, startedAtMs: i.worldserver.startedAtMs },
    ...(i.harnessSeries !== undefined
      ? { harnessSeries: i.harnessSeries.map((s) => ({ series: s.series, runs: s.runs })) }
      : {}),
    now: i.now,
  });
}

export function projectRuns(r: RunsResponse): RunsResponse {
  return scrubPathsValue<RunsResponse>({ runs: r.runs.map(projectRunListRow) });
}

/**
 * One movement intention, field by field. The target is a unit's NAME, which
 * the rule keeps. Named and explicit rather than a spread — every projection
 * in this file is an allowlist, and a spread would carry whatever a future
 * field, or a smuggled key, happened to be sitting on the object.
 */
function projectMove(m: MoveIntentView): MoveIntentView {
  return { ts: m.ts, map: m.map, x: m.x, y: m.y, z: m.z, target: m.target, status: m.status };
}

/**
 * The episodic entry: the model's own words about what it is doing, under the
 * harness's stamps and a zone NAME. Model-authored text is published as
 * written (it may quote the world — the documented residual).
 */
function projectStatus(s: CharacterStatus): CharacterStatus {
  return { turn: s.turn, level: s.level, zone: s.zone, text: s.text, ts: s.ts };
}

export function projectPositions(p: PositionsResponse): PositionsResponse {
  return scrubPathsValue<PositionsResponse>({
    positions: p.positions.map(
      (a: AgentPosition): AgentPosition => ({
        runId: a.runId,
        character: a.character,
        model: a.model,
        // Already public on the run row it comes from (`comparability.effort`).
        effort: a.effort ?? null,
        map: a.map,
        x: a.x,
        y: a.y,
        ts: a.ts,
        level: a.level,
        xp: a.xp,
        money: a.money,
        questsCompleted: a.questsCompleted,
        items: projectItems(a.items),
        harnessVersion: a.harnessVersion,
        // The player frame's numbers: what any onlooker's client would show
        // above a character it can see, and nothing about the host or the run.
        health: a.health ?? null,
        maxHealth: a.maxHealth ?? null,
        power: a.power ?? null,
        maxPower: a.maxPower ?? null,
        powerType: a.powerType ?? null,
        nextLevelXp: a.nextLevelXp ?? null,
        // Already public on the run row it comes from (`projectRunRow.class`).
        class: a.class ?? null,
        move: a.move == null ? null : projectMove(a.move),
        status: a.status == null ? null : projectStatus(a.status),
        // A harness fact about this run's own loop, with nothing of the world
        // in it: whether the model is spending this turn thinking.
        reflecting: a.reflecting ?? false,
      }),
    ),
  });
}

export function projectResults(r: ResultsResponse): ResultsResponse {
  return scrubPathsValue<ResultsResponse>({
    runs: r.runs.map(projectResultRun),
    episode: r.episode,
    harness: r.harness,
    includeOverrides: r.includeOverrides,
    filteredOut: r.filteredOut,
    overridesExcluded: r.overridesExcluded,
    now: r.now,
  });
}

export function projectEpisodes(e: EpisodesResponse): EpisodesResponse {
  return scrubPathsValue<EpisodesResponse>({
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
  });
}

/**
 * `/api/tools` is harness text by construction (runner/src/tools.ts and the
 * examples beside the route); the projection still names every field.
 */
export function projectTools(t: ToolsResponse): ToolsResponse {
  return scrubPathsValue<ToolsResponse>({
    tools: t.tools.map((x) => ({
      name: x.name,
      description: x.description,
      inputSchema: x.inputSchema,
      example: x.example,
      returns: x.returns,
    })),
  });
}

/** A campaign row whose config names no account: the pin is the lab's, the class the reader's. */
export type PublicCampaignRowView = Omit<CampaignRowView, "config"> & {
  config: Omit<NonNullable<CampaignRowView["config"]>, "account"> | null;
};
export interface PublicCampaignsResponse extends Omit<CampaignsResponse, "campaigns"> {
  campaigns: PublicCampaignRowView[];
}

export function projectCampaigns(c: CampaignsResponse): PublicCampaignsResponse {
  return scrubPathsValue<PublicCampaignsResponse>({
    campaigns: c.campaigns.map(
      (row: CampaignRowView): PublicCampaignRowView => ({
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
  });
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
  return scrubPathsValue<ModelsResponse>({
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
  });
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

/**
 * Account names (`WB03`, `PROBE`, an operator's naming scheme) are the lab's
 * and never public; the class is what a reader needs. The name is a join key
 * the fleet page's row builder still needs — a job sits on an account, a
 * paused run parks against one, an idle account is a row of its own — so each
 * name becomes a per-response ordinal (`account-1`, `account-2`, …), the same
 * one everywhere it appears in this response, and the real name is gone.
 */
function accountAlias(): (name: string) => string {
  const seen = new Map<string, string>();
  return (name: string): string => {
    let alias = seen.get(name);
    if (alias === undefined) {
      alias = `account-${seen.size + 1}`;
      seen.set(name, alias);
    }
    return alias;
  };
}

function projectFleetJob(j: FleetJobView, alias: (name: string) => string): PublicFleetJobView {
  return {
    name: j.name,
    ref: j.ref,
    episode: j.episode,
    account: alias(j.account),
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
  const alias = accountAlias();
  return scrubPathsValue<PublicFleetResponse>({
    present: f.present,
    server: projectServer(f.server),
    ...(f.startedAt !== undefined ? { startedAt: f.startedAt } : {}),
    ...(f.heartbeatAt !== undefined ? { heartbeatAt: f.heartbeatAt } : {}),
    ...(f.containerized !== undefined ? { containerized: f.containerized } : {}),
    ...(f.stamp !== undefined ? { stamp: f.stamp } : {}),
    ...(f.configLoadedAt !== undefined ? { configLoadedAt: f.configLoadedAt } : {}),
    // The rejection error is a raw exception message: a fs failure embeds the
    // config's filesystem path and a schema failure can echo config values, so
    // only the fact and the time survive, like lastError.message above.
    ...(f.configRejected !== undefined ? { configRejected: { since: f.configRejected.since, error: "" } } : {}),
    ...(f.preflight !== undefined ? { preflight: projectPreflight(f.preflight) } : {}),
    jobs: f.jobs.map((j) => projectFleetJob(j, alias)),
    accounts: f.accounts.map(
      (a: FleetAccountView): FleetAccountView => ({ account: alias(a.account), class: a.class, job: a.job }),
    ),
    paused: f.paused.map(
      (p: FleetPausedView): FleetPausedView => ({
        runId: p.runId,
        model: p.model,
        account: p.account === null ? null : alias(p.account),
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
  });
}

/**
 * A freeplay character, field by field.
 *
 * Everything here is already public elsewhere: run ids and the lineage between
 * them ride on every listing (`projectRunRow.continuedFrom`), and the figures
 * are the same levels, playtime, tokens and cost `projectResultRun` ships per
 * attempt. Two things are withheld, and both for a reason this file already
 * states: a pause reason becomes the fixed token, and the death figures are
 * dropped whole — `RunDetailResponse.deaths` is not projected at all (corpse
 * positions), so the character does not open a second door onto the same fact.
 */
function projectCharacterAttempt(a: CharacterAttempt): CharacterAttempt {
  return {
    runId: a.runId,
    startedAt: a.startedAt,
    endedAt: a.endedAt,
    terminationReason: a.terminationReason,
    pauseReason: pausedToken(a.pauseReason),
    live: a.live,
    level: a.level,
    xpEarned: a.xpEarned,
    questsCompleted: a.questsCompleted,
    playtimeMs: a.playtimeMs,
    tokens: a.tokens === null ? null : projectTokenTotals(a.tokens),
    actualCost: a.actualCost === null ? null : projectCostFigure(a.actualCost),
    expectedCost: a.expectedCost === null ? null : projectCostFigure(a.expectedCost),
    flights: a.flights,
    levels: a.levels.map(projectLevelMark),
  };
}

function projectCharacterTotals(t: CharacterTotals): CharacterTotals {
  return {
    attempts: t.attempts,
    startedAt: t.startedAt,
    endedAt: t.endedAt,
    playtimeMs: t.playtimeMs,
    questsCompleted: t.questsCompleted,
    xpEarned: t.xpEarned,
    tokens: t.tokens === null ? null : projectTokenTotals(t.tokens),
    cost: {
      actualUsd: t.cost.actualUsd,
      actualAttempts: t.cost.actualAttempts,
      expectedUsd: t.cost.expectedUsd,
      expectedAttempts: t.cost.expectedAttempts,
      attempts: t.cost.attempts,
      asIfMetered: t.cost.asIfMetered,
    },
    level: t.level,
    money: t.money,
    achievements: t.achievements === null ? null : projectAchievements(t.achievements),
    taxi: t.taxi === null ? null : projectTaxi(t.taxi),
    spells: t.spells === null || t.spells === undefined ? null : projectSpells(t.spells),
    talents: t.talents === null || t.talents === undefined ? null : projectTalents(t.talents),
    trades: t.trades === null || t.trades === undefined ? null : projectTrades(t.trades),
    toolCalls: t.toolCalls,
    snippets: t.snippets,
    modelResponses: t.modelResponses,
  };
}

function projectCharacter(s: CharacterView): CharacterView {
  return {
    characterId: s.characterId,
    // Identity: every field here is already on the public runs row
    // (`projectResultRun`), so passing it through opens no door.
    model: s.model,
    effort: s.effort,
    driver: s.driver,
    harnessVersion: s.harnessVersion,
    name: s.name,
    characterLabel: s.characterLabel,
    attempt: s.attempt,
    attempts: s.attempts,
    previous: s.previous,
    next: s.next,
    truncated: s.truncated,
    runs: s.runs.map(projectCharacterAttempt),
    totals: projectCharacterTotals(s.totals),
  };
}

/**
 * `GET /api/character/<id>` in public mode.
 *
 * Nothing new is decided here: the view goes through `projectCharacter`, which
 * the run page's own card already crosses, and every sample goes through
 * `projectStatePoint`, which `projectRunDetail` already applies to one
 * attempt's series. A character is the same run detail read across a chain, so
 * a fact public on one attempt's page cannot become private by being counted
 * twelve times — and none can become public either.
 */
export function projectCharacterResponse(c: CharacterResponse): CharacterResponse {
  return scrubPathsValue<CharacterResponse>({
    character: projectCharacter(c.character),
    states: c.states.map((s) => ({ ...projectStatePoint(s), runId: s.runId, attempt: s.attempt })),
  });
}

export function projectRunDetail(d: RunDetailResponse): RunDetailResponse {
  return scrubPathsValue<RunDetailResponse>({
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
    ...(d.spells !== undefined ? { spells: d.spells === null ? null : projectSpells(d.spells) } : {}),
    ...(d.talents !== undefined ? { talents: d.talents === null ? null : projectTalents(d.talents) } : {}),
    ...(d.trades !== undefined ? { trades: d.trades === null ? null : projectTrades(d.trades) } : {}),
    ...(d.tps !== undefined ? { tps: d.tps === null ? null : projectTps(d.tps) } : {}),
    // Turn indices about this harness's own loop.
    ...(d.reflections !== undefined
      ? { reflections: d.reflections.map((w) => ({ fromTurn: w.fromTurn, toTurn: w.toTurn })) }
      : {}),
    ...(d.character !== undefined ? { character: projectCharacter(d.character) } : {}),
  });
}

export function projectTrack(t: TrackResponse): TrackResponse {
  return scrubPathsValue<TrackResponse>({
    runId: t.runId,
    characterName: t.characterName,
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
        // As on the live feed.
        health: p.health ?? null,
        maxHealth: p.maxHealth ?? null,
        power: p.power ?? null,
        maxPower: p.maxPower ?? null,
        powerType: p.powerType ?? null,
        nextLevelXp: p.nextLevelXp ?? null,
        // Only where the sample changed, as the track serves it: the field's
        // absence is "unchanged", so filling it in on every point here would
        // be a different claim as well as a much larger file.
        ...(p.items === undefined ? {} : { items: projectItems(p.items) ?? [] }),
      }),
    ),
    // As on the live feed.
    moves: (t.moves ?? []).map(projectMove),
    // The character's neighbours: run ids and two counters, every one of them
    // already public on `runs.json` and on the run page's attempt strip. Field
    // by field, so a shape that grows here does not ship by accident.
    ...(t.character === undefined
      ? {}
      : {
          character: {
            characterId: t.character.characterId,
            attempt: t.character.attempt,
            attempts: t.character.attempts,
            previous: t.character.previous,
            next: t.character.next,
          },
        }),
  });
}

/* ------------------------------------------------------------- entries --- */

/**
 * The fields each entry type may carry into a public window, by name. Every
 * list was read off the records the runner writes (`runner/src/*.ts`) and off
 * what `summarize` (tail.ts) makes of them; a type not listed here ships as
 * its skeleton — index, type, stamps — so the feed still shows a row where
 * something happened without saying what the unlisted record held.
 *
 * A listed field that carries a comparability tuple (`harness` entries of kind
 * `comparability_restamped`, in `before` and `after`) is not copied whole: it
 * goes through `projectComparability`, so the tuple's own withheld fields —
 * `wikiBundle`, whose `source` is the operator's dump file — stay withheld here
 * too.
 *
 * Absent by decision, per type:
 * - `meta`: the run config (`apiBase`, the objective, the operator's paths,
 *   the wiki bundle source) — every public fact from it is on the run row.
 * - `driver` / `claude_system`: the CLI binary, its args, cwd, config dirs,
 *   socket and memory paths, session ids.
 * - `pause` / `watchdog`: `detail` is free text (a provider's rate-limit
 *   message, a process's stderr) — the same rule as `pauseReason`.
 * - `claude_result`: `sessionId` and the raw usage block (the derived
 *   `claudeTurn` carries the numbers).
 * - `events_served`: the raw batch, which the summary never carries; the
 *   opcode tally is the public fact.
 */
const ENTRY_FIELDS: Readonly<Record<string, readonly string[]>> = {
  request: ["adapter", "messageCount", "systemChars", "promptChars", "usage"],
  events_served: ["via", "count", "opcodes", "ambient", "moreOpcodes", "folded"],
  response: ["text", "tools", "outChars", "usage"],
  snippet: ["code"],
  tool_call: ["name", "args", "dispatchTs"],
  snippet_result: ["name", "isError", "text", "reflect"],
  tool_result: ["name", "isError", "text", "reflect"],
  state: [
    "level", "xp", "map", "x", "y", "z", "eventCount", "lastSeq", "money", "questsCompleted", "zone", "area",
    "items", "health", "maxHealth", "power", "maxPower", "powerType", "nextLevelXp",
  ],
  move: ["moveId", "map", "x", "y", "z", "target", "status"],
  milestone: [
    "kind", "from", "to", "ids", "points", "xp", "observedTs", "position", "zone", "area", "graveyard", "released",
    "id", "name", "categoryId",
  ],
  quest_complete: ["questId"],
  episodic: ["level", "zone", "text"],
  character: ["character"],
  harness: ["kind", "cleared", "model", "cliVersion", "text", "leashChanged", "before", "after"],
  reflect_window: ["event", "reason"],
  termination: ["reason", "detail"],
  pause: ["reason", "episodeElapsedMs"],
  resume: ["harnessVersion", "after", "episodeElapsedMs"],
  "wind-down": ["reason", "outcome", "graceMs", "waitedMs"],
  watchdog: ["reason"],
  claude_result: ["subtype", "isError", "numTurns", "durationMs", "durationApiMs", "costUsd", "usage", "claudeTurn", "text"],
  claude_system: ["type", "subtype", "estimated_tokens", "estimated_tokens_delta"],
  meta: ["runId", "harnessVersion", "startedAt", "resumedFresh"],
  driver: ["driver", "harness", "systemPromptChars"],
};

/** A JSON deep copy: the value as parsed from the file, with nothing added. */
function plain(v: unknown): unknown {
  return v === undefined ? undefined : (JSON.parse(JSON.stringify(v)) as unknown);
}

/**
 * Whether a copied field is a comparability tuple, by its shape.
 *
 * A `harness` entry of kind `comparability_restamped` carries the whole tuple
 * in `before` and `after`, so a by-name copy ships the whole tuple a layer
 * below the run row — which is how the operator's wiki dump filename reached the public
 * bucket. The test is structural rather than keyed on
 * the entry kind so a future record that embeds a tuple is covered the day it
 * is written; `budget` is part of it because the other `after` in this file
 * (a `resume` entry's pause reason) is a plain string, and must stay one.
 */
function isComparabilityTuple(v: unknown): v is ComparabilityView {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return false;
  const o = v as Record<string, unknown>;
  return (
    "harnessVersion" in o &&
    typeof o["budget"] === "object" &&
    o["budget"] !== null &&
    !Array.isArray(o["budget"])
  );
}

/**
 * One entry summary, projected then redacted. The skeleton is what
 * `summarize` stamps on every record; the rest is the type's list above,
 * copied by name; then `redactGameProse` replaces the game prose the copied
 * fields can carry (tool result text).
 *
 * A copied field that is itself a comparability tuple crosses
 * `projectComparability` — the same allowlist the run row's tuple crosses —
 * rather than being copied whole, so the tuple's withheld fields are withheld
 * at every depth.
 */
export function projectEntry(e: EntrySummary): EntrySummary {
  const out: EntrySummary = { i: e.i, t: e.t, ts: e.ts, start: e.start, end: e.end };
  if (typeof e["turn"] === "number") out["turn"] = e["turn"];
  if (typeof e["call"] === "number") out["call"] = e["call"];
  if (e.clipped === true) out.clipped = true;
  for (const k of ENTRY_FIELDS[e.t] ?? []) {
    if (!(k in e) || e[k] === undefined) continue;
    const v = e[k];
    out[k] =
      k === "items" && e.t === "state"
        ? projectItems(v as ItemSample[] | null)
        : isComparabilityTuple(v)
          ? projectComparability(v)
          : plain(v);
  }
  return scrubPathsValue<EntrySummary>(redactGameProse(out));
}

export function projectEntries(r: EntriesResponse): EntriesResponse {
  return scrubPathsValue<EntriesResponse>({ from: r.from, total: r.total, entries: r.entries.map((e) => projectEntry(e as EntrySummary)) as EntriesResponse["entries"] });
}
