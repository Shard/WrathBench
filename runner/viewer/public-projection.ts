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
 * under a zone name) and `terminationDetail` pass through (but for a
 * `launch-failed` stub's, which is launcher text); entry summaries
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
 *   `pauseReason` keeps only a fixed token — `"paused"`, or the harness's
 *   own `observation-stalled` (see `pausedToken`) — and the `pause` entry's
 *   `detail` goes with it.
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
 * - No subscription usage figure leaves (operator, 2026-10-16): the drivers'
 *   `rate_limits` records carry their windows in fields no list here names,
 *   a paused row waiting on a usage window (`subscriptionWait`) ships without
 *   its `resumeAfter` and with a fixed `why`, and an errored `claude_result`
 *   ships without its text, which is the CLI's limit message.
 * - Minimap tiles are Blizzard bytes and never leave through a snapshot.
 * - From the trace (`projectTraceSegment`): the `target`, which names another
 *   unit — another player, with its health, is another player's whereabouts.
 *   A cut never says why. Deaths are public (operator, 2026-10-18). The
 *   character sheet ships as numbers and its items' template names (operator,
 *   2026-10-18), and never the bank, any item text, or a guid.
 * The rule when a field is arguable: withhold.
 */

import type {
  AchievementFacts,
  ActiveSegment,
  ActionNoteView,
  CharacterStatus,
  ItemSample,
  AgentPosition,
  ApiInfoResponse,
  AreaFacts,
  ArmSummary,
  CampaignView,
  CampaignsResponse,
  ComparabilityView,
  CostFigure,
  CostView,
  DeathFacts,
  DeathSite,
  EntriesResponse,
  EntrySummary,
  EpisodeIdView,
  EpisodesResponse,
  FleetAccountView,
  FleetEndedView,
  FleetJobView,
  FleetPausedView,
  FleetRunFacts,
  FleetPreflightView,
  FleetResponse,
  FleetServerView,
  LevelMark,
  ModelEpisodeView,
  ModelRowView,
  ModelRunView,
  ModelsResponse,
  PartyDetailView,
  PartyStampView,
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
  TrackInvEntry,
  TrackInvGone,
  TrackInvItem,
  TrackInventory,
  TrackInvRow,
  TrackResponse,
  TrackTravelMark,
  Square,
  PositionTrace,
  TraceAura,
  TraceCast,
  TraceEventWire,
  TraceIndexResponse,
  TraceSegment,
  TraceItemName,
  TraceQuestReq,
  TraceSegRuns,
  TraceState,
  TrackTrace,
  LiveNearby,
  NearbySelfView,
  NearbyStateView,
  NearbyWindow,
} from "./api-types";
import { EPISODE_IDS } from "../src/episodes";
import { STALL_PAUSE } from "../src/lapse";
import { redactGameProse } from "./redact-prose";
import { scrubPathsValue } from "./scrub-paths";
import { REDACTED } from "@wrathbench/mcp/redact";
import { maskCredentialShapes } from "../src/secret-scan";
import {
  applySheetPatch,
  CHAT,
  chatOf,
  isSheetKind,
  isStateKey,
  itemNameOf,
  QDONE,
  questReqOf,
  sanitizeStateValue,
  SHEET_KEY_LEN,
  SHEET_KEYS,
  sheetOf,
  sheetPatch,
  stateOf,
  type TraceSheetKey,
  type TraceStateKey,
} from "./trace";
import {
  NEARBY_VERSION,
  PUBLIC_NEARBY_SPAN_MS,
  emptyNearbyWindow,
  emptySelf,
  encodeNearby,
  windowRows,
  type NearbyRingMotion,
  type NearbyRingRow,
  type NearbyRingUnit,
  type NearbyStateKey,
  type NearbyUnitTypeName,
} from "./nearby";

/**
 * What is published is what the public dashboard reads (operator, 2026-10-18).
 *
 * A field no public page reads is not emitted, however harmless it looks: it
 * is bytes in the bucket and, as one leaked session token showed, a place for
 * something that should never have left to ride out. Where the shared type
 * (`api-types.ts`) still declares a field this file leaves out, the projector
 * builds its object through `lean`, so the object literal is still checked
 * against the shape's real field names while the omission is stated in one
 * place. The audit that chose each omission, and the readers it checked, is
 * `docs/PUBLIC-DASHBOARD.md` ("What is published"); a source scan in
 * `runner/test/public-projection.test.ts` fails the day a dashboard file starts
 * reading one of them.
 */
function lean<T>(v: Partial<T>): T {
  return v as T;
}

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
 *
 * The one reason that crosses as itself is the stall pause: it is a token the
 * harness writes, never text, and it is what lets the public dashboard say
 * "stalled" rather than "paused" about a run whose observation froze. The
 * fleet's own paused listing already publishes its reasons verbatim.
 */
/** What the public fleet page says about a paused run waiting on a subscription usage window: no figure, no time. */
export const SUBSCRIPTION_WAIT_WHY = "waiting for its subscription usage window to reset";

function pausedToken(reason: string | null): string | null {
  if (reason === null || reason === "") return null;
  return reason === STALL_PAUSE ? STALL_PAUSE : "paused";
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
    // A run dimension like effort, and a harness setting, never the world's.
    ...(c.compactWindow != null ? { compactWindow: c.compactWindow } : {}),
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
    ...(t.contextWindow !== undefined ? { contextWindow: t.contextWindow } : {}),
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
    // `breakdown` (per-component dollars) is not emitted: no page reads it.
    priceId: c.priceId,
    asOf: c.asOf,
    // The pricing layer's own sentence ("no price on file", ...), never game text.
    note: c.note,
    // Dollars and a turn count, so the public figure wears the same `*`.
    ...(c.backfill !== undefined
      ? { backfill: { reportedUsd: c.backfill.reportedUsd, usd: c.backfill.usd, turns: c.backfill.turns } }
      : {}),
  };
}

/**
 * `actual` and `expected`, the two figures every page reads. The top-level
 * fields the live API keeps beside them (a second copy of `expected`, for older
 * consumers) are not emitted: nothing public reads them, and on a list of every
 * run they were a third of the cost bytes.
 */
function projectCostView(c: CostView): CostView {
  return { actual: projectCostFigure(c.actual), expected: projectCostFigure(c.expected) };
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
    // Already public as the run row's count; per sample it is what lets a run
    // resumed in place be totalled across the restart.
    questsCompleted: s.questsCompleted ?? null,
  };
}

/**
 * The run page's XP chart samples: when, the level and the XP within it.
 * `ChartSample` in the dashboard is the type its readers are written against
 * (`lib/runview.ts`), so a field added there is a decision, not a drift. The
 * full sample (position, frame, turn) is `projectStatePoint`'s, and rides on
 * the character route, where the unit frame reads it.
 */
function projectChartSample(s: StatePoint): StatePoint {
  return lean<StatePoint>({ ts: s.ts, level: s.level, xp: s.xp });
}

/** A run's sessions: two timestamps each, the same clock every row already carries. */
function projectSessions(s: readonly ActiveSegment[]): ActiveSegment[] {
  return s.map((x) => ({ start: x.start, end: x.end }));
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
 * name or a trading partner, which is why these can be projected whole.
 */
function projectSpells(f: SpellFacts): SpellFacts {
  return {
    learned: f.learned,
    atLogin: f.atLogin,
    ids: [...f.ids],
    marks: f.marks.map((m) => ({ id: m.id, ts: m.ts, turn: m.turn })),
  };
}

/**
 * A run's deaths as the run page's milestones row prints them: the three
 * counts and each death's turn. Deaths are public (operator, 2026-10-18); a
 * site's position, zone and the `first`/`last` ends are left out because no
 * page reads them.
 */
function projectDeaths(f: DeathFacts): DeathFacts {
  return lean<DeathFacts>({
    deaths: f.deaths,
    releases: f.releases,
    resurrects: f.resurrects,
    sites: f.sites.map((s) => lean<DeathSite>({ turn: s.turn })),
  });
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

/**
 * A party member's stamp: the attempt's id (the run-id stem the members'
 * ids share), which member, its role and place, and the size. Ids and one
 * word of harness text each, field by field.
 */
function projectPartyStamp(p: PartyStampView): PartyStampView {
  return {
    id: p.id,
    member: p.member,
    size: p.size,
    ...(p.role !== undefined ? { role: p.role } : {}),
    ...(p.index !== undefined ? { index: p.index } : {}),
  };
}

/**
 * A party member's own records, which the party page and the group replay
 * merge. The member list never carried an account; the kills are guids,
 * entries and the creature's name, the deaths their times, the places ids and names, and the chat the
 * member's own lines, which its trace windows already publish as the map's
 * bubbles, with any credential shape masked as there (`projectTraceSegment`).
 * Struck for the session token like the rest of the detail.
 */
function projectPartyDetail(p: PartyDetailView): PartyDetailView {
  return {
    id: p.id,
    member: p.member,
    role: p.role,
    size: p.size,
    members: p.members.map((m) => ({ member: m.member, role: m.role, runId: m.runId, character: m.character })),
    instances: p.instances.map((i) => ({ ts: i.ts, event: i.event, map: i.map, from: i.from })),
    kills: p.kills.map((k) => ({ ts: k.ts, victimGuid: k.victimGuid, entry: k.entry, name: k.name, self: k.self })),
    chat: p.chat.map((c) => ({ ts: c.ts, text: maskCredentialShapes(c.text, REDACTED) })),
    groups: p.groups.map((g) => ({ ts: g.ts, event: g.event, count: g.count })),
    // When each death happened, for the party's timeline: the time only, a
    // site's position and zone staying off as on `projectDeaths`.
    deaths: p.deaths.filter((ts) => typeof ts === "number"),
    where:
      p.where === null
        ? null
        : {
            ts: p.where.ts,
            map: p.where.map,
            zone: p.where.zone,
            zoneName: p.where.zoneName,
            area: p.where.area,
            areaName: p.where.areaName,
          },
  };
}

function projectRunRow(r: RunRow): RunRow {
  return lean<RunRow>({
    runId: r.runId,
    model: r.model,
    driver: r.driver,
    harness: r.harness,
    shakeout: r.shakeout,
    // The operator objective is withheld: free prose that can quote the world.
    // Its existence still shows — `shakeout` and `comparability.objective` say
    // why the run is unscored without saying what it was told. The key itself
    // is not emitted either: a field that is always null says nothing, and
    // no page reads it.
    campaign: r.campaign,
    cell: r.cell,
    // The version and arm a probe was stamped with: without them a public
    // row cannot be matched to the campaign pane it belongs to. The roster
    // name and the image a pod asked for stay off a public row.
    ...(r.campaignVersion !== undefined ? { campaignVersion: r.campaignVersion } : {}),
    ...(r.arm !== undefined ? { arm: r.arm } : {}),
    // The run page's link to its party: absent on every run that is no member.
    ...(r.party !== undefined ? { party: projectPartyStamp(r.party) } : {}),
    extra: r.extra,
    character: r.character,
    // The ids; `characterLabel` is the name the pair resolves to, and
    // `raceName`/`className` would say it a second time.
    race: r.race,
    class: r.class,
    characterLabel: r.characterLabel,
    platform: r.platform,
    resolvedModel: r.resolvedModel,
    cliVersion: r.cliVersion,
    // The raw base URL (`apiBase`) is withheld: a LAN endpoint is host
    // topology. The derived `platform` label above is what public pages render.
    harnessVersion: r.harnessVersion,
    comparability: r.comparability === null ? null : projectComparability(r.comparability),
    startedAt: r.startedAt,
    endedAt: r.endedAt,
    terminationReason: r.terminationReason,
    // Names of NPCs, quests and places, at most — never prose (operator, 2026-08-30).
    // Except a `launch-failed` stub's, which is the launcher's own text: image
    // references with their registry host, the cluster API's URL and message,
    // node names. Host-like, so withheld; the reason itself crosses.
    terminationDetail: r.terminationReason === "launch-failed" ? null : r.terminationDetail,
    pauseReason: pausedToken(r.pauseReason),
    // A run id, which every public listing already carries; the lineage is the
    // only thing that makes a freeplay character legible as one character.
    continuedFrom: r.continuedFrom,
    level: r.level,
    xp: r.xp,
    money: r.money,
    questsCompleted: r.questsCompleted,
    items: projectItems(r.items),
    // `mtime` and `bytes` are the file's, for the private viewer's change
    // detection; no public page reads them. `live` is the fact they stand for.
    live: r.live,
    // `error` (a caught exception's message) is withheld: it can carry paths.
  });
}

/**
 * A `runs.json` row as published: a run's fleet-table figures
 * (`FleetRunFacts`) and the `snapshot` pointers the snapshot client follows to
 * a run's objects. The fleet table itself now reads the same figures off the
 * fleet feed (`live.json`), for the handful of runs it shows. Everything else
 * a listing row carries is on `results.json` and the run's own `detail.json`,
 * where the pages that show it read it; repeated here it was most of a
 * two-megabyte object that moves on every pass with a live run.
 */
export type PublicRunListRow = FleetRunFacts & Pick<RunListRow, "snapshot">;

export interface PublicRunsResponse extends Omit<RunsResponse, "runs"> {
  runs: PublicRunListRow[];
}

function projectRunListRow(r: RunListRow): PublicRunListRow {
  return projectRunFacts(r);
}

/**
 * A run's fleet-table figures, field by field: what a public `runs.json` row
 * is, and what the fleet feed carries per run (`FleetResponse.runFacts`) in
 * both builds. A listing row narrows to it, and so does an already-narrowed
 * one, so it is its own idempotent projection.
 */
export function projectRunFacts(r: FleetRunFacts): FleetRunFacts {
  return {
    runId: r.runId,
    resolvedModel: r.resolvedModel,
    level: r.level,
    xp: r.xp,
    playtimeMs: r.playtimeMs,
    tokens: r.tokens === null ? null : { totalTokens: r.tokens.totalTokens },
    ...(r.tps !== undefined ? { tps: r.tps === null ? null : projectTps(r.tps) } : {}),
    cost:
      r.cost === null
        ? null
        : {
            actual: {
              usd: r.cost.actual.usd,
              basis: r.cost.actual.basis,
              note: r.cost.actual.note,
              ...(r.cost.actual.backfill !== undefined
                ? { backfill: { reportedUsd: r.cost.actual.backfill.reportedUsd, usd: r.cost.actual.backfill.usd, turns: r.cost.actual.backfill.turns } }
                : {}),
            },
          },
    comparability: r.comparability === null ? null : { budget: { episodeMs: r.comparability.budget.episodeMs } },
    // `snapshot` is not carried over: the renderer stamps its own paths after
    // projection, and an input claiming some is not to be believed.
  };
}

function projectLevelMark(l: LevelMark): LevelMark {
  return { level: l.level, ts: l.ts, turn: l.turn, playtimeMs: l.playtimeMs };
}

/**
 * The two cost figures of a result row, to what the ladder, the runs table and
 * the character page read: the chart's reading takes `basis`, `usd`,
 * `asIfMetered` and the backfill mark from either (`runCostReading`), and the
 * runs table prints the actual figure's `note` in its tooltip. The list-price
 * date, the price row and the estimate's own note belong to a single run's page
 * (`detail.json`), and were about half of this object's cost bytes.
 */
function projectResultActual(c: CostFigure): CostFigure {
  return lean<CostFigure>({
    usd: c.usd,
    basis: c.basis,
    asIfMetered: c.asIfMetered,
    note: c.note,
    ...(c.backfill !== undefined
      ? { backfill: { reportedUsd: c.backfill.reportedUsd, usd: c.backfill.usd, turns: c.backfill.turns } }
      : {}),
  });
}

function projectResultExpected(c: CostFigure): CostFigure {
  return lean<CostFigure>({ usd: c.usd, basis: c.basis, asIfMetered: c.asIfMetered });
}

function projectResultRun(r: ResultRun): ResultRun {
  return lean<ResultRun>({
    runId: r.runId,
    model: r.model,
    ...(r.resolvedModel !== undefined ? { resolvedModel: r.resolvedModel } : {}),
    ...(r.driver !== undefined ? { driver: r.driver } : {}),
    harnessVersion: r.harnessVersion,
    harnessSeries: r.harnessSeries,
    extra: r.extra,
    race: r.race,
    class: r.class,
    characterLabel: r.characterLabel,
    campaign: r.campaign,
    cell: r.cell,
    ...(r.campaignVersion !== undefined ? { campaignVersion: r.campaignVersion } : {}),
    ...(r.arm !== undefined ? { arm: r.arm } : {}),
    // How the runs table groups a party and the party page finds its members.
    ...(r.party !== undefined ? { party: projectPartyStamp(r.party) } : {}),
    effort: r.effort,
    ...(r.compactWindow != null ? { compactWindow: r.compactWindow } : {}),
    harness: r.harness,
    // Not emitted: `platform`, `cliVersion`, `promptHash`, `serverBuild`,
    // `wikiCoords`, `wiki` and `raceName`/`className`. The run page reads the
    // first six off the run's own row and tuple, and `characterLabel` is the
    // pair's name; no page reads them off a result row.
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
    ...(r.sessions !== undefined ? { sessions: projectSessions(r.sessions) } : {}),
    tokens: r.tokens === null ? null : projectTokenTotals(r.tokens),
    actualCost: r.actualCost === null ? null : projectResultActual(r.actualCost),
    ...(r.expectedCost !== undefined
      ? { expectedCost: r.expectedCost === null ? null : projectResultExpected(r.expectedCost) }
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
  });
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

export function projectRuns(r: RunsResponse): PublicRunsResponse {
  return scrubPathsValue<PublicRunsResponse>({ runs: r.runs.map(projectRunListRow) });
}

/**
 * One movement intention, field by field. The target is a unit's NAME, which
 * the rule keeps. Named and explicit rather than a spread — every projection
 * in this file is an allowlist, and a spread would carry whatever a future
 * field, or a smuggled key, happened to be sitting on the object.
 */
function projectMove(m: MoveIntentView): MoveIntentView {
  // No `z`: the map marks a destination on the plane and the intent line names
  // the target or its x, y.
  return lean<MoveIntentView>({ ts: m.ts, map: m.map, x: m.x, y: m.y, target: m.target, status: m.status });
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
        ...(a.compactWindow != null ? { compactWindow: a.compactWindow } : {}),
        map: a.map,
        x: a.x,
        y: a.y,
        ts: a.ts,
        level: a.level,
        xp: a.xp,
        money: a.money,
        questsCompleted: a.questsCompleted,
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
        // The newest windows and the tail, the tail through the segment
        // projection. Absent stays absent: a run with no trace says nothing.
        ...(a.trace === undefined ? {} : { trace: projectPositionTrace(a.trace) }),
        // The cue to read the run's units out of `nearby.json`
        // (`projectLiveNearby`); a flag, nothing about the units themselves.
        ...(a.nearby === true ? { nearby: true as const } : {}),
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
    // The reference line, field by field: numbers and the route, never a run id.
    ...(r.scriptedReference === undefined
      ? {}
      : {
          scriptedReference: r.scriptedReference.map((l) => ({
            episode: l.episode,
            series: l.series,
            route: l.route,
            level: l.level,
            xp: l.xp,
          })),
        }),
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

/** A campaign whose config names no account: the pin is the lab's, the class the reader's. */
export type PublicCampaignView = Omit<CampaignView, "config"> & {
  config: (Omit<NonNullable<CampaignView["config"]>, "account">) | null;
};
export interface PublicCampaignsResponse extends Omit<CampaignsResponse, "campaigns"> {
  campaigns: PublicCampaignView[];
}

/**
 * An image reference without its registry host: `harbor.lab/wb/runner:t@sha256:…`
 * reads `wb/runner:t@sha256:…`. The tag and digest are what a reader needs to
 * name the build; the host is topology. A first path component is a host when
 * it holds a dot or a port, or is `localhost` — the reference grammar's own rule.
 */
export function publicImageRef(ref: string | null): string | null {
  if (ref === null) return null;
  const slash = ref.indexOf("/");
  if (slash < 0) return ref;
  const head = ref.slice(0, slash);
  return head.includes(".") || head.includes(":") || head === "localhost" ? ref.slice(slash + 1) : ref;
}

function projectSquare(sq: Square): Square {
  return {
    column: sq.column,
    runs: sq.runs,
    counted: sq.counted,
    reached: sq.reached,
    live: sq.live,
    minutesToStop: sq.minutesToStop === null ? null : { min: sq.minutesToStop.min, median: sq.minutesToStop.median, max: sq.minutesToStop.max },
    bestLevel: sq.bestLevel,
    costUsd: sq.costUsd,
    mismatchedStart: sq.mismatchedStart,
    builds: [...sq.builds],
    runIds: [...sq.runIds],
    // Run-id stems, as public as the run ids they group.
    ...(sq.parties !== undefined ? { parties: [...sq.parties] } : {}),
    ...(sq.want !== undefined ? { want: sq.want } : {}),
    ...(sq.settled !== undefined ? { settled: sq.settled } : {}),
    ...(sq.refused !== undefined ? { refused: sq.refused } : {}),
  };
}

function projectArmSummary(a: ArmSummary): ArmSummary {
  return {
    arm: a.arm,
    runs: a.runs,
    reached: a.reached,
    medianMinutesToStop: a.medianMinutesToStop,
    medianTurnsToStop: a.medianTurnsToStop,
    medianCostToStop: a.medianCostToStop,
    medianPromptTokensToStop: a.medianPromptTokensToStop,
    // Reason ids and counts; a value that is not a count is not carried.
    terminations: Object.fromEntries(Object.entries(a.terminations).filter(([, n]) => typeof n === "number")),
    builds: [...a.builds],
    ...(a.costAsIfMetered !== undefined ? { costAsIfMetered: a.costAsIfMetered } : {}),
  };
}

/**
 * The campaigns page, public. Kept: everything that says what a campaign asks
 * and what its runs did — the definition, its provenance, the arms, the grid,
 * the comparison and the refusals (store keys and reasons). Withheld: the
 * pinned account, the objective's text (free prose that can quote the world,
 * as on a run row; `shape.objective` reads null), and the registry host of an
 * arm's image.
 */
export function projectCampaigns(c: CampaignsResponse): PublicCampaignsResponse {
  return scrubPathsValue<PublicCampaignsResponse>({
    now: c.now,
    campaigns: c.campaigns.map(
      (v: CampaignView): PublicCampaignView => ({
        id: v.id,
        version: v.version,
        key: v.key,
        hash: v.hash,
        source:
          v.source === null
            ? null
            : { commit: v.source.commit, path: v.source.path, ...(v.source.branch !== undefined ? { branch: [...v.source.branch] } : {}) },
        publishedAt: v.publishedAt,
        question: v.question,
        ...(v.note !== undefined ? { note: v.note } : {}),
        shape: {
          objective: null,
          stopAtLevel: v.shape.stopAtLevel,
          end: v.shape.end.map((e) => ("level" in e ? { level: e.level } : { kill: { entry: e.kill.entry } })),
          episodeMs: v.shape.episodeMs,
          idleMs: v.shape.idleMs,
          noXpMs: v.shape.noXpMs,
          maxToolCalls: v.shape.maxToolCalls,
          wiki: v.shape.wiki,
          wikiCoords: v.shape.wikiCoords,
          resume: v.shape.resume,
          maxAttemptsPerCell: v.shape.maxAttemptsPerCell,
        },
        cells: v.cells.map((cell) => ({ id: cell.id, race: cell.race, class: cell.class, ...(cell.note !== undefined ? { note: cell.note } : {}) })),
        arms: v.arms.map((a) => ({
          id: a.id,
          ...(a.note !== undefined ? { note: a.note } : {}),
          image: publicImageRef(a.image),
          command: a.command === null ? null : [...a.command],
          args: [...a.args],
        })),
        config:
          v.config === null
            ? null
            : {
                enabled: v.config.enabled,
                assignments: v.config.assignments.map((a) => ({
                  ref: a.ref,
                  model: a.model,
                  effort: a.effort,
                  compactWindow: a.compactWindow,
                  harness: a.harness,
                  runsPerCell: a.runsPerCell,
                })),
              },
        state: v.state,
        concluded: v.concluded,
        progress: { want: v.progress.want, done: v.progress.done, attempted: v.progress.attempted, capped: v.progress.capped, live: v.progress.live },
        columns: v.columns.map((col) => ({
          key: col.key,
          ref: col.ref,
          arm: col.arm,
          model: col.model,
          effort: col.effort,
          compactWindow: col.compactWindow,
          harness: col.harness,
        })),
        grid: v.grid.map((line) => ({ cell: line.cell, squares: line.squares.map(projectSquare) })),
        comparison: v.comparison.map((cmp) => ({ ref: cmp.ref, arms: cmp.arms.map(projectArmSummary) })),
        costUsd: v.costUsd,
        newestRunId: v.newestRunId,
        newestAt: v.newestAt,
      }),
    ),
    refused: c.refused.map((r) => ({ key: r.key, reason: r.reason })),
  });
}

const TIER_IDS: readonly TierView[] = ["t0", "t1", "t2"];

/**
 * One run in a model's detail panel: the columns the panel prints. The version,
 * series and extra flag, the character's ids and its served model, and the
 * start time are on the run's own page and the results listing; the panel
 * lists the run, its character label, how it ended and what it cost. Of the
 * cost only `actual`, the figure the panel prints.
 */
function projectModelRun(r: ModelRunView): ModelRunView {
  return lean<ModelRunView>({
    runId: r.runId,
    episode: r.episode,
    episodeOverride: r.episodeOverride,
    ...(r.characterLabel !== undefined ? { characterLabel: r.characterLabel } : {}),
    endedAt: r.endedAt,
    durationMs: r.durationMs,
    bestLevel: r.bestLevel,
    terminationReason: r.terminationReason,
    live: r.live,
    counted: r.counted,
    ...(r.cost !== undefined ? { cost: r.cost === null ? null : { actual: projectCostFigure(r.cost.actual) } } : {}),
  });
}

function projectModelRow(row: ModelRowView): ModelRowView {
  const perEpisode: Partial<Record<EpisodeIdView, ModelEpisodeView>> = {};
  // Keyed off the known tier ids, not the object's own keys: an input parsed
  // from JSON could carry any key, and only the four tiers are speakable.
  for (const id of EPISODE_IDS) {
    const e = row.perEpisode[id];
    if (e === undefined) continue;
    // Not emitted: `otherSeries`, `reachedL5`, `lastEnded`, `lastReason` and
    // `runIds`. The roster table prints the counts and the target; the run
    // list under it is `runs`.
    perEpisode[id] = lean<ModelEpisodeView>({
      counted: e.counted,
      attempts: e.attempts,
      extras: e.extras,
      target: e.target,
      bestLevel: e.bestLevel,
    });
  }
  return {
    name: row.name,
    model: row.model,
    effort: row.effort,
    ...(row.compactWindow != null ? { compactWindow: row.compactWindow } : {}),
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
        // A subscription usage window's reset is the operator's (operator,
        // 2026-10-16): no reset time and no usage figure leaves the machine.
        resumeAfter: p.subscriptionWait === true ? null : p.resumeAfter,
        elapsedMs: p.elapsedMs,
        budgetMs: p.budgetMs,
        // The supervisor's own sentence about its own scheduling; rendered
        // verbatim by the fleet page and never sourced from the world — but
        // for a subscription wait, whose sentence names its reset.
        why: p.subscriptionWait === true ? SUBSCRIPTION_WAIT_WHY : p.why,
      }),
    ),
    ended: f.ended.map(
      (e: FleetEndedView): FleetEndedView => ({ runId: e.runId, model: e.model, ref: e.ref, detail: e.detail }),
    ),
    ...(f.session !== undefined
      ? { session: { finished: f.session.finished, ok: f.session.ok, retried: f.session.retried } }
      : {}),
    // The same figures `runs.json` publishes per row, for the runs the table shows.
    ...(f.runFacts !== undefined ? { runFacts: f.runFacts.map(projectRunFacts) } : {}),
    ...(typeof f.runCount === "number" ? { runCount: f.runCount } : {}),
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
 * attempt. A pause reason becomes the fixed token, for the reason this file
 * already states, and the attempt's death count is not emitted: no page reads
 * it, and the totals carry the character's.
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
    ...(a.sessions !== undefined ? { sessions: projectSessions(a.sessions) } : {}),
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
      ...(t.cost.actualBackfilled !== undefined ? { actualBackfilled: t.cost.actualBackfilled } : {}),
    },
    level: t.level,
    money: t.money,
    achievements: t.achievements === null ? null : projectAchievements(t.achievements),
    // The count the character card prints. Absent stays absent: an older
    // body has none, and a null in its place would be a different claim.
    ...(t.deaths !== undefined ? { deaths: t.deaths === null ? null : lean<DeathFacts>({ deaths: t.deaths.deaths }) } : {}),
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
    ...(s.compactWindow != null ? { compactWindow: s.compactWindow } : {}),
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
    states: d.states.map(projectChartSample),
    total: d.total,
    tokens: projectTokenTotals(d.tokens),
    cost: projectCostView(d.cost),
    playtimeMs: d.playtimeMs,
    ...(d.sessions !== undefined ? { sessions: projectSessions(d.sessions) } : {}),
    // A roster row's name, which `models.json` publishes for every row.
    ...(d.rosterName !== undefined ? { rosterName: typeof d.rosterName === "string" ? d.rosterName : null } : {}),
    ...(d.achievements !== undefined
      ? { achievements: d.achievements === null ? null : projectAchievements(d.achievements) }
      : {}),
    ...(d.taxi !== undefined ? { taxi: d.taxi === null ? null : projectTaxi(d.taxi) } : {}),
    ...(d.deaths !== undefined ? { deaths: d.deaths === null ? null : projectDeaths(d.deaths) } : {}),
    ...(d.spells !== undefined ? { spells: d.spells === null ? null : projectSpells(d.spells) } : {}),
    ...(d.talents !== undefined ? { talents: d.talents === null ? null : projectTalents(d.talents) } : {}),
    ...(d.trades !== undefined ? { trades: d.trades === null ? null : projectTrades(d.trades) } : {}),
    ...(d.tps !== undefined ? { tps: d.tps === null ? null : projectTps(d.tps) } : {}),
    // Turn indices about this harness's own loop.
    ...(d.reflections !== undefined
      ? { reflections: d.reflections.map((w) => ({ fromTurn: w.fromTurn, toTurn: w.toTurn })) }
      : {}),
    ...(d.character !== undefined ? { character: projectCharacter(d.character) } : {}),
    ...(d.party !== undefined ? { party: projectPartyDetail(d.party) } : {}),
  });
}

function publicTravel(m: TrackTravelMark): boolean {
  return m.kind === "taxi" || m.kind === "taxi_landed" || m.kind === "hearth" || m.kind === "release";
}

function projectTravel(m: TrackTravelMark): TrackTravelMark {
  return { kind: m.kind, ts: m.ts };
}

const intIn = (v: unknown, below: number): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0 && v < below;
const numOrNull = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const finiteOr0 = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/**
 * A track's inventory (`TrackInventory`) under the same rules as an item row
 * (`projectItems`): the name passes, and so do the id, the quality, where it
 * sits and how many, all numbers. Rebuilt field by field, so nothing rides a
 * tuple or an entry it was not part of. An entry on a point the track does not
 * have, or a patch row naming an item the table does not, is dropped.
 */
function projectInventory(inv: TrackInventory, points: number): TrackInventory {
  const items: TrackInvItem[] = (Array.isArray(inv.items) ? inv.items : []).map((d): TrackInvItem => {
    const [name, itemId, quality] = Array.isArray(d) ? d : [];
    return [typeof name === "string" ? name : "", numOrNull(itemId), numOrNull(quality)];
  });
  const row = (r: unknown): TrackInvRow | TrackInvGone | null => {
    if (!Array.isArray(r) || r.length < 2) return null;
    const at: TrackInvGone = [finiteOr0(r[0]), finiteOr0(r[1])];
    if (r.length === 2) return at;
    if (!intIn(r[2], items.length)) return null;
    return r.length === 3 ? [at[0], at[1], r[2]] : [at[0], at[1], r[2], finiteOr0(r[3])];
  };
  const at: TrackInvEntry[] = [];
  for (const e of Array.isArray(inv.at) ? inv.at : []) {
    if (!Array.isArray(e) || !intIn(e[0], points)) continue;
    if (e[1] === null) {
      const whole = Array.isArray(e[2]) ? e[2].filter((i) => typeof (i as Partial<ItemSample> | null)?.name === "string") : [];
      at.push([e[0], null, projectItems(whole as ItemSample[]) ?? []]);
    } else if (Array.isArray(e[1])) {
      at.push([e[0], e[1].map(row).filter((r): r is TrackInvRow | TrackInvGone => r !== null)]);
    }
  }
  return { items, at };
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
        // A track published before `inv` carries its inventory here, and
        // re-projects to itself; the viewer no longer writes it.
        ...(p.items === undefined ? {} : { items: projectItems(p.items) ?? [] }),
      }),
    ),
    // The inventory along the track, as patches; absent on a run that recorded none.
    ...(t.inv === undefined ? {} : { inv: projectInventory(t.inv, t.points.length) }),
    // As on the live feed.
    moves: (t.moves ?? []).map(projectMove),
    // Flights, hearths and graveyard releases, as kinds and timestamps: the
    // flight count already ships in the safe core, the hearthstone dispatch in
    // the action log, and the releases with the deaths (`projectRunDetail`).
    // Absent stays absent: it is what an older track says.
    ...(t.travel === undefined ? {} : { travel: t.travel.filter(publicTravel).map(projectTravel) }),
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
    // Which windows have a published segment. Absent stays absent: a run with
    // no trace keeps the bytes, and so the key, it had before the recorder.
    ...(t.trace === undefined ? {} : { trace: projectTrackTrace(t.trace) }),
  });
}

/* --------------------------------------------------------------- trace --- */

/**
 * The trace state keys a public segment carries, in the codec's order.
 * Withheld, by not being listed: `target` (another unit's identity, and
 * through a player target another player's whereabouts). Deaths are public
 * (operator, 2026-10-18): `dead`, `ghost`, the gauges at a corpse and the
 * Ghost aura all pass.
 */
const PUBLIC_TRACE_KEYS = [
  "hp",
  "hpMax",
  "pw",
  "pwMax",
  "pwType",
  "level",
  "xp",
  "xpMax",
  "auras",
  "combat",
  "mounted",
  "taxi",
  "dead",
  "ghost",
  "resting",
  "cast",
] as const satisfies readonly TraceStateKey[];
const PUBLIC_TRACE_KEY_SET: ReadonlySet<string> = new Set(PUBLIC_TRACE_KEYS);

/**
 * The keys a keyframe carries only where the segment it came from did. A
 * segment published before deaths were public has neither, it is immutable,
 * and its own re-projection must give it back as it is; the decoder reads the
 * missing key as false, which is what the older projection said.
 */
const TRACE_KEYS_IF_PRESENT: ReadonlySet<string> = new Set(["dead", "ghost"]);

/**
 * The character sheet a public segment carries (operator, 2026-10-18):
 * money, equipment, worn bags, what is carried, durability, the quest log's
 * ids, state and counters, visible reputation, skills and turn-ins, as
 * numbers, with the name and quality of each item it references and the
 * counts each of its quests needs. Published ahead of the page that will
 * read it, by the same decision: a segment cannot be amended once out, so a
 * window that closed without its sheet would never have one.
 *
 * Every row is rebuilt as integers no wider than its key's row, and kept only
 * at a position a character carries: equipment 0-18, worn bags 19-22, the
 * backpack (bag 255, slots 23-38), a worn bag's own slots, the keyring (bag
 * 255, slots 86-117) and the currency tokens (bag 255, slots 118-149). The
 * bank (slots 39-73, and anything in a bank bag) and the vendor buyback slots
 * (74-85) never pass, whoever put them there; the recorder reads neither.
 * Nothing in the sheet names anyone: no guid, no
 * creator, no text but an item's template name.
 */
const PUBLIC_SHEET_KEYS = SHEET_KEYS satisfies readonly TraceSheetKey[];
const SHEET_ROW_WIDTH: { readonly [K in Exclude<TraceSheetKey, "money">]: number } = { equip: 3, bags: 3, inv: 5, dur: 3, quests: 7, rep: 2, skills: 3 };
/** An item's name longer than this is not a name; the entry is withheld. */
const ITEM_NAME_MAX = 128;

const isInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v);

/**
 * Whether a sheet row sits where a character carries things: equipment, the
 * worn bags and their contents, the backpack (bag 255, 23-38), the keyring
 * (86-117) and the currency tokens (118-149). Never the bank (39-73) or the
 * vendor buyback slots (74-85).
 */
function carriedAt(key: Exclude<TraceSheetKey, "money">, row: readonly number[]): boolean {
  const [a, b] = row as [number, number | undefined];
  switch (key) {
    case "equip":
    case "dur":
      return a >= 0 && a <= 18;
    case "bags":
      return a >= 19 && a <= 22;
    case "inv":
      return b !== undefined && ((a === 255 && ((b >= 23 && b <= 38) || (b >= 86 && b <= 149))) || (a >= 19 && a <= 22 && b >= 0 && b < 36));
    case "quests":
      return a >= 0 && a < 25;
    case "rep":
    case "skills":
      return true;
  }
}

/** A list's public rows: integer tuples at most the key's width, at a carried position; null stays null. */
function publicSheetRows(key: Exclude<TraceSheetKey, "money">, v: unknown, patch: boolean): number[][] | null | undefined {
  if (v === null) return null;
  if (!Array.isArray(v)) return undefined;
  const keyLen = SHEET_KEY_LEN[key];
  const out: number[][] = [];
  for (const r of v as unknown[]) {
    if (!Array.isArray(r) || r.length < (patch ? keyLen : keyLen + 1)) continue;
    const row = (r as unknown[]).slice(0, SHEET_ROW_WIDTH[key]);
    if (row.every(isInt) && carriedAt(key, row as number[])) out.push(row as number[]);
  }
  return out;
}

/** The sheet's dictionaries for exactly the ids the public rows reference: numbers, and an item's quality and name. */
function publicSheetDicts(seg: TraceSegment, itemIds: Set<number>, questIds: Set<number>): Pick<TraceSegment, "items" | "qreq"> {
  const srcQ = seg.qreq !== null && typeof seg.qreq === "object" && !Array.isArray(seg.qreq) ? seg.qreq : {};
  const srcI = seg.items !== null && typeof seg.items === "object" && !Array.isArray(seg.items) ? seg.items : {};
  const qreq: Record<string, TraceQuestReq> = {};
  for (const id of [...questIds].sort((a, b) => a - b)) {
    const req = Object.hasOwn(srcQ, id) ? questReqOf(srcQ[id]) : undefined;
    if (req === undefined || !req.flat().every(isInt)) continue;
    qreq[id] = req;
    for (const p of req.slice(4) as [number, number][]) if (p[0] > 0) itemIds.add(p[0]);
  }
  const items: Record<string, TraceItemName> = {};
  for (const id of [...itemIds].sort((a, b) => a - b)) {
    const entry = Object.hasOwn(srcI, id) ? itemNameOf(srcI[id]) : undefined;
    if (entry === undefined || entry[1].length > ITEM_NAME_MAX || (entry[0] !== null && !isInt(entry[0]))) continue;
    items[id] = [entry[0], entry[1]];
  }
  return { ...(Object.keys(items).length > 0 ? { items } : {}), ...(Object.keys(qreq).length > 0 ? { qreq } : {}) };
}

/** The item and quest ids public sheet rows reference. */
function sheetRefs(key: TraceSheetKey, rows: readonly (readonly number[])[], itemIds: Set<number>, questIds: Set<number>): void {
  const at = key === "inv" ? 2 : key === "equip" || key === "bags" ? 1 : -1;
  for (const r of rows) {
    if (at >= 0 && r.length > at && r[at]! > 0) itemIds.add(r[at]!);
    if (key === "quests" && r.length > 1 && r[1]! > 0) questIds.add(r[1]!);
  }
}

/** One public key's value, rebuilt: an aura's flags and a cast's extras do not travel. */
function publicTraceValue(key: TraceStateKey, v: unknown): unknown {
  if (key === "auras") return (v as TraceAura[]).map((a): TraceAura => [a[0], a[1], a[2]]);
  if (key === "cast") return v === null ? null : { spellId: (v as TraceCast).spellId, endsAt: (v as TraceCast).endsAt };
  return v;
}

const finiteNums = (a: unknown): number[] =>
  Array.isArray(a) ? a.map((v) => (typeof v === "number" && Number.isFinite(v) ? v : 0)) : [];
/** A fixed-width numeric tuple, or null when `a` is not an array at all. */
function numTuple<T extends number[]>(a: unknown, width: number): T | null {
  if (!Array.isArray(a)) return null;
  return Array.from({ length: width }, (_, i) => {
    const v = (a as unknown[])[i];
    return typeof v === "number" && Number.isFinite(v) ? v : 0;
  }) as T;
}
const tupleList = <T extends number[]>(a: unknown, width: number): T[] =>
  Array.isArray(a) ? a.map((t) => numTuple<T>(t, width)).filter((t): t is T => t !== null) : [];

/**
 * One trace segment (`runner/viewer/trace.ts`), field by field.
 *
 * Positions, cuts and flights pass as numbers — a cut says that the character
 * did not travel there and never why. The state crosses `PUBLIC_TRACE_KEYS`:
 * the private keyframe and events are replayed in order, and an event that
 * would only repeat what the public stream already says (an aura change that
 * only moved its flags) is dropped. The character's chat lines pass as kind
 * and text, with any credential shape in the text masked. A fixed point on
 * its own output, like every projector here.
 */
export function projectTraceSegment(seg: TraceSegment): TraceSegment {
  const raw = seg.k?.s;
  const priv = stateOf(raw);
  const has = (key: string): boolean => raw !== null && typeof raw === "object" && Object.hasOwn(raw, key);
  const s: Partial<TraceState> = {};
  const said = new Map<string, string>();
  for (const key of PUBLIC_TRACE_KEYS) {
    if (TRACE_KEYS_IF_PRESENT.has(key) && !has(key)) continue;
    const v = publicTraceValue(key, priv[key]);
    (s as Record<string, unknown>)[key] = v;
    said.set(key, JSON.stringify(v));
  }
  // The sheet: the observed keys whole, as public rows. A public fold per key
  // turns each private patch into the one the public stream needs, and drops
  // a patch that changes nothing there (a row only at a withheld position).
  const sheet = sheetOf(raw);
  const pubSheet: Partial<Record<TraceSheetKey, number | number[][] | null>> = {};
  const itemIds = new Set<number>();
  const questIds = new Set<number>();
  for (const key of PUBLIC_SHEET_KEYS) {
    if (sheet[key] === null) continue;
    if (key === "money") {
      if (!isInt(sheet.money)) continue;
      pubSheet.money = sheet.money;
    } else {
      const rows = publicSheetRows(key, sheet[key], false) ?? [];
      pubSheet[key] = rows;
      sheetRefs(key, rows, itemIds, questIds);
    }
    (s as Record<string, unknown>)[key] = pubSheet[key];
  }
  const ev: TraceEventWire[] = [];
  for (const e of Array.isArray(seg.ev) ? seg.ev : []) {
    if (!Array.isArray(e) || typeof e[0] !== "number" || !Number.isFinite(e[0])) continue;
    if (e[1] === CHAT) {
      // Model-authored text, as `say` is in the action log. A credential's
      // shape is masked here, because a window is immutable once published
      // and the publisher's scan would refuse it every pass after; the
      // session token is struck by value at the route (`publicText`).
      const c = chatOf(e[2]);
      if (c !== undefined) ev.push([e[0], CHAT, [c[0], maskCredentialShapes(c[1], REDACTED)]]);
      continue;
    }
    if (isSheetKind(e[1])) {
      const kind = e[1];
      if (kind === QDONE) {
        const ids = Array.isArray(e[2]) ? (e[2] as unknown[]).filter((id): id is number => isInt(id) && id > 0) : [];
        // Turn-ins append: the same quest twice is two, so no repeat is dropped.
        if (ids.length > 0) ev.push([e[0], kind, ids]);
      } else if (kind === "money") {
        const v = e[2];
        if ((v !== null && !isInt(v)) || (Object.hasOwn(pubSheet, "money") && pubSheet.money === v)) continue;
        pubSheet.money = v;
        ev.push([e[0], kind, v]);
      } else {
        const patch = publicSheetRows(kind, e[2], true);
        if (patch === undefined) continue;
        const before = (pubSheet[kind] ?? null) as number[][] | null;
        const after = applySheetPatch(before, patch, SHEET_KEY_LEN[kind]);
        const eff = sheetPatch(before, after, SHEET_KEY_LEN[kind]);
        if (eff === undefined) continue;
        pubSheet[kind] = after;
        ev.push([e[0], kind, eff]);
        if (eff !== null) sheetRefs(kind, eff, itemIds, questIds);
      }
      continue;
    }
    if (!isStateKey(e[1])) continue;
    if (!PUBLIC_TRACE_KEY_SET.has(e[1])) continue;
    const v = sanitizeStateValue(e[1], e[2]);
    if (v === undefined) continue;
    const pub = publicTraceValue(e[1], v);
    const j = JSON.stringify(pub);
    if (said.get(e[1]) === j) continue;
    said.set(e[1], j);
    ev.push([e[0], e[1], pub]);
  }
  const k = seg.k ?? { p: null, s: {} };
  const p = numTuple<[number, number, number, number, number]>(k.p, 5);
  const f = numTuple<[number, number, number, number, number]>(k.f, 5);
  return scrubPathsValue<TraceSegment>({
    v: seg.v,
    run: seg.run,
    t0: seg.t0,
    t1: seg.t1,
    q: { p: seg.q.p, o: seg.q.o },
    k: {
      p,
      ...(typeof k.pt === "number" && Number.isFinite(k.pt) && k.pt !== 0 ? { pt: k.pt } : {}),
      s,
      ...(f === null ? {} : { f }),
    },
    dt: finiteNums(seg.dt),
    x: finiteNums(seg.x),
    y: finiteNums(seg.y),
    z: finiteNums(seg.z),
    o: finiteNums(seg.o),
    cuts: tupleList<[number, number]>(seg.cuts, 2),
    flights: tupleList<[number, number, number, number, number, number]>(seg.flights, 6),
    ev,
    ...publicSheetDicts(seg, itemIds, questIds),
  });
}

const projectSegRuns = (runs: TraceSegRuns): TraceSegRuns => tupleList<[number, number]>(runs, 2);

function projectTrackTrace(t: TrackTrace): TrackTrace {
  return { segMs: t.segMs, segs: projectSegRuns(t.segs) };
}

function projectPositionTrace(t: PositionTrace): PositionTrace {
  return { segMs: t.segMs, recent: finiteNums(t.recent), tail: t.tail === null ? null : projectTraceSegment(t.tail) };
}

/** `GET /api/run/<id>/trace` in public mode: the window list, and the tail through the segment projection. */
export function projectTraceIndex(i: TraceIndexResponse): TraceIndexResponse {
  return scrubPathsValue<TraceIndexResponse>({
    segMs: i.segMs,
    segs: projectSegRuns(i.segs),
    tail: i.tail === null ? null : projectTraceSegment(i.tail),
    now: i.now,
  });
}

/* -------------------------------------------------------------- nearby --- */

/**
 * The unit state keys a public nearby window carries. Withheld, by not being
 * listed: the subname (publicly a unit is its name), every guid (`tg`, `ow`,
 * `ch`: another unit's identity, and through a player another player's
 * whereabouts), the unit flags, and the 3D fields (display, scale, movement
 * flags, a player's race, class and gender) until a public reader exists.
 */
export const PUBLIC_NEARBY_KEYS = ["entry", "name", "ctype", "level", "hp", "df", "nf", "qg", "tgs"] as const satisfies readonly NearbyStateKey[];
/** Of the dynamic flags only "dead": "tapped" says another player is fighting it, "lootable" whose kill it was. */
const PUBLIC_DYNAMIC_FLAGS = 0x20;
/** `UNIT_FLAG_PLAYER_CONTROLLED`: a player is driving it (a pet, a charmed mob, a vehicle). */
const UNIT_FLAG_PLAYER_CONTROLLED = 0x8;

function guidHigh(guid: string): number | null {
  try {
    return Number(BigInt(guid) >> 48n);
  } catch {
    return null;
  }
}

function publicNearbyState(s: Partial<NearbyStateView>, delta = false): Partial<NearbyStateView> {
  const out: Record<string, unknown> = {};
  for (const key of PUBLIC_NEARBY_KEYS) {
    if (!Object.hasOwn(s, key)) continue;
    const v = s[key];
    if (v === undefined || (v === null && !delta)) continue;
    out[key] = key === "df" && typeof v === "number" ? v & PUBLIC_DYNAMIC_FLAGS : v;
  }
  return out as Partial<NearbyStateView>;
}

interface PrivateUnit {
  ty: NearbyUnitTypeName;
  s: Partial<NearbyStateView>;
  m: NearbyRingMotion | null;
}

/**
 * Whether one unit may be drawn publicly at this moment (`projectNearby`):
 * a creature or a vehicle no other player owns, charms or drives, whose target
 * is not another player or another player's pet. The character's own guid is
 * the only "own" there is; with none known, nothing owned or controlled passes.
 */
function nearbyUnitPublic(u: PrivateUnit, self: NearbySelfView, units: ReadonlyMap<string, PrivateUnit>): boolean {
  if (u.ty !== "creature" && u.ty !== "vehicle") return false;
  const me = self.guid;
  const mine = (g: string | null | undefined): boolean => g === undefined || g === null || (me !== null && g === me);
  if (!mine(u.s.ow) || !mine(u.s.ch)) return false;
  if (((u.s.uf ?? 0) & UNIT_FLAG_PLAYER_CONTROLLED) !== 0 && (me === null || u.s.ow !== me)) return false;
  const tg = u.s.tg;
  if (tg !== undefined && tg !== null && tg !== me) {
    const high = guidHigh(tg);
    if (high === 0x0000) return false;
    if (high === 0xf140) {
      const pet = units.get(tg);
      if (pet === undefined || me === null || pet.s.ow !== me) return false;
    }
  }
  return true;
}

/**
 * The private rows filtered to what the public may see, moment by moment:
 * each unit enters when the rules first let it and leaves the instant they
 * stop (an `out`, then an `in` with its whole public state and current motion
 * when they let it again). The character being down changes nothing here:
 * deaths are public (operator, 2026-10-18), spirit healers and all.
 */
function publicNearbyRows(rows: readonly NearbyRingRow[]): NearbyRingRow[] {
  const out: NearbyRingRow[] = [];
  let self = emptySelf();
  let units = new Map<string, PrivateUnit>();
  const shown = new Set<string>();
  const visible = (id: string): boolean => {
    const u = units.get(id);
    return u !== undefined && nearbyUnitPublic(u, self, units);
  };
  const pub = (id: string, u: PrivateUnit): NearbyRingUnit => ({ id, ty: u.ty, s: publicNearbyState(u.s), m: u.m });
  const publicSelf = (): NearbySelfView => ({ ...emptySelf(), map: self.map });
  /** Bring what is shown in line with the rules now, for every unit. */
  const reconcile = (ts: number): void => {
    for (const id of [...shown]) {
      if (visible(id)) continue;
      shown.delete(id);
      out.push({ ts, kind: "out", id });
    }
    for (const [id, u] of units) {
      if (shown.has(id) || !visible(id)) continue;
      shown.add(id);
      out.push({ ts, kind: "in", u: pub(id, u) });
    }
  };
  /** One unit changed: show it, drop it, or pass the public part of the change. */
  const settle = (ts: number, id: string, wasShown: boolean, delta: Partial<NearbyStateView> | null): void => {
    const now = visible(id);
    if (wasShown && !now) {
      shown.delete(id);
      out.push({ ts, kind: "out", id });
    } else if (!wasShown && now) {
      shown.add(id);
      out.push({ ts, kind: "in", u: pub(id, units.get(id)!) });
    } else if (now && delta !== null) {
      const d = publicNearbyState(delta, true);
      if (Object.keys(d).length > 0) out.push({ ts, kind: "st", id, s: d });
    }
  };
  for (const r of rows) {
    switch (r.kind) {
      case "key": {
        self = { ...r.self };
        units = new Map(r.units.map((u) => [u.id, { ty: u.ty, s: u.s, m: u.m }]));
        shown.clear();
        const list: NearbyRingUnit[] = [];
        for (const [id, u] of units) {
          if (!visible(id)) continue;
          shown.add(id);
          list.push(pub(id, u));
        }
        out.push({ ts: r.ts, kind: "key", self: publicSelf(), units: list });
        break;
      }
      case "in": {
        const wasShown = shown.has(r.u.id);
        units.set(r.u.id, { ty: r.u.ty, s: r.u.s, m: r.u.m });
        if (wasShown) shown.delete(r.u.id);
        settle(r.ts, r.u.id, false, null);
        if (r.u.ty === "pet") reconcile(r.ts);
        break;
      }
      case "mv":
      case "pos": {
        const u = units.get(r.id);
        if (u === undefined) break;
        u.m = r.m;
        if (shown.has(r.id)) out.push(r);
        break;
      }
      case "st":
      case "nm": {
        const u = units.get(r.id);
        if (u === undefined) break;
        const delta: Partial<NearbyStateView> = r.kind === "st" ? r.s : { name: r.name };
        const next: Record<string, unknown> = { ...u.s };
        for (const [k, v] of Object.entries(r.kind === "st" ? r.s : { name: r.name, ...(r.sub !== undefined ? { sub: r.sub } : {}) })) {
          if (v === null) delete next[k];
          else next[k] = v;
        }
        u.s = next as Partial<NearbyStateView>;
        settle(r.ts, r.id, shown.has(r.id), delta);
        if (u.ty === "pet") reconcile(r.ts);
        break;
      }
      case "out": {
        const u = units.get(r.id);
        units.delete(r.id);
        if (shown.delete(r.id)) out.push(r);
        if (u?.ty === "pet") reconcile(r.ts);
        break;
      }
      case "self": {
        const before = self.map;
        self = { ...self, ...r.self };
        if (self.map !== before) out.push({ ts: r.ts, kind: "self", self: { map: self.map } });
        reconcile(r.ts);
        break;
      }
      case "tick":
        out.push(r);
        break;
    }
  }
  return out;
}

/**
 * One nearby window (`runner/viewer/nearby.ts`) as the public may see it, by
 * the operator's decisions of 2026-10-18: creatures only — no other player,
 * no unit another player owns, charms or drives, and none while it targets
 * another player or their pet — with the state cut to `PUBLIC_NEARBY_KEYS`
 * (so the target only as "targets this character"). The self keeps only its
 * map. Creature guids and
 * entries stay: they are wire ids every client in range receives, and they
 * are what lets one NPC two characters see draw once.
 *
 * The private window is turned back into rows (`windowRows`), filtered moment
 * by moment, and encoded again over the same span, so a public window is a
 * window like any other and a fixed point of this function.
 */
export function projectNearby(w: NearbyWindow): NearbyWindow {
  const run = typeof w.run === "string" ? w.run : "";
  const t0 = typeof w.t0 === "number" && Number.isFinite(w.t0) ? w.t0 : 0;
  const t1 = typeof w.t1 === "number" && Number.isFinite(w.t1) ? w.t1 : t0;
  if (w.v !== NEARBY_VERSION) return scrubPathsValue<NearbyWindow>(emptyNearbyWindow(run, t0, t1));
  return scrubPathsValue<NearbyWindow>(encodeNearby(publicNearbyRows(windowRows(w)), { run, from: t0 }));
}

/**
 * `nearby.json`'s `nearby`: each live run's window through `projectNearby`, for
 * the runs whose position in `live.json` is flagged `nearby` and no other,
 * each cut to its last `PUBLIC_NEARBY_SPAN_MS`. That is what keeps the public
 * layer live only: a run that stops being live leaves the feed, and its
 * window goes with it on the next pass, and no window reaches back further
 * than the live map plays. A window filed under another run's id is dropped.
 * A fixed point, so the bucket's verifier re-projects it like any other body.
 */
export function projectLiveNearby(windows: unknown, positions: PositionsResponse): LiveNearby {
  const out: LiveNearby = {};
  if (windows === null || typeof windows !== "object" || Array.isArray(windows)) return out;
  const live = new Set(positions.positions.filter((p) => p.nearby === true).map((p) => p.runId));
  for (const id of Object.keys(windows).sort()) {
    const w = (windows as Record<string, unknown>)[id];
    if (!live.has(id) || w === null || typeof w !== "object" || (w as { run?: unknown }).run !== id) continue;
    let pub = projectNearby(w as NearbyWindow);
    if (pub.t1 - pub.t0 > PUBLIC_NEARBY_SPAN_MS) {
      pub = scrubPathsValue<NearbyWindow>(encodeNearby(windowRows(pub), { run: id, from: pub.t1 - PUBLIC_NEARBY_SPAN_MS }));
    }
    out[id] = pub;
  }
  return out;
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
 *
 * Left out because the run page reads nothing of them (operator, 2026-10-18):
 * the raw line's byte range (`start`, `end`), which only the private viewer's
 * raw links use; a request's `adapter`, `systemChars` and `usage` and a
 * response's `outChars` and `usage`, where the page prints the counts the turn
 * header names and the reply's text; an events batch's `ambient` and `folded`
 * tallies; and a snippet call's code, which the snippet record beside it
 * already says (`projectEntries`).
 */
const ENTRY_FIELDS: Readonly<Record<string, readonly string[]>> = {
  request: ["messageCount", "promptChars"],
  events_served: ["via", "count", "opcodes", "moreOpcodes"],
  response: ["text", "tools"],
  snippet: ["code"],
  tool_call: ["name", "args", "dispatchTs"],
  snippet_result: ["name", "isError", "text", "reflect"],
  tool_result: ["name", "isError", "text", "reflect"],
  state: [
    "level", "xp", "map", "x", "y", "z", "eventCount", "lastSeq", "money", "questsCompleted", "zone", "area",
    "items", "health", "maxHealth", "power", "maxPower", "powerType", "nextLevelXp",
  ],
  move: ["moveId", "map", "x", "y", "z", "target", "status"],
  // The notes themselves cross `projectActionNotes`, field by field.
  actions: ["callTs", "routine", "dropped", "actions"],
  milestone: [
    "kind", "from", "to", "ids", "points", "xp", "observedTs", "position", "zone", "area", "graveyard", "released",
    "id", "name", "categoryId",
  ],
  quest_complete: ["questId"],
  episodic: ["level", "zone", "text"],
  character: ["character"],
  harness: ["kind", "cleared", "model", "cliVersion", "text", "leashChanged", "before", "after", "trigger", "preTokens", "postTokens", "durationMs"],
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

/**
 * The action log's notes (`ActionNoteView`), rebuilt field by field. The
 * public facts are the ones the rule already passes elsewhere: action names,
 * ids, coordinates, the module's error codes and hints (harness text, not game
 * text), and the client-cache names `names` carries — "names and ids stay".
 * `args` is the request body the SDK built, copied by key against the union
 * of the body fields `ActionRequest` (`sdk/src/protocol.ts`) declares, scalar
 * (or array-of-scalar) values only. An action that grows a field ships without
 * it until it is listed here. Model-authored text in it (`say`'s text, a raw
 * payload) is the residual the content boundary already names for snippet
 * code.
 */
const ACTION_NOTE_SCALARS = ["ts", "action", "status", "ms", "error", "hint", "moveId", "count", "lastTs", "auto"] as const;
const ACTION_NAME_KEYS = ["target", "spell", "item", "quest"] as const;
const ACTION_ERROR_CODE = /^[a-z0-9_]+$/;
const ACTION_ARG_KEYS: ReadonlySet<string> = new Set([
  "text", "x", "y", "z", "guid", "orientation", "spellId", "targetGuid", "menuId", "optionId", "questId",
  "rewardIndex", "slot", "itemId", "count", "itemGuid", "bag", "talentId", "rank", "talents", "opcode", "payload",
]);

function scalarOrList(v: unknown): boolean {
  if (v === null || ["string", "number", "boolean"].includes(typeof v)) return true;
  return Array.isArray(v) && v.every(scalarOrList);
}

function projectActionNotes(v: unknown): ActionNoteView[] {
  if (!Array.isArray(v)) return [];
  const out: ActionNoteView[] = [];
  for (const raw of v) {
    if (raw === null || typeof raw !== "object") continue;
    const n = raw as Record<string, unknown>;
    const note: Record<string, unknown> = {};
    for (const k of ACTION_NOTE_SCALARS) {
      const x = n[k];
      if (typeof x === "string" || typeof x === "number" || typeof x === "boolean") note[k] = x;
    }
    if (typeof note["action"] !== "string" || typeof note["ts"] !== "number") continue;
    // The module's error codes are fixed words; anything else is a runtime
    // failure string (a fetch error can name the module host), which this
    // build withholds like every other free-text error.
    if (typeof note["error"] === "string" && !ACTION_ERROR_CODE.test(note["error"])) note["error"] = "transport";
    if (n["args"] !== null && typeof n["args"] === "object" && !Array.isArray(n["args"])) {
      const args: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(n["args"] as Record<string, unknown>)) {
        if (!ACTION_ARG_KEYS.has(k) || !scalarOrList(x)) continue;
        args[k] = plain(x);
      }
      if (Object.keys(args).length > 0) note["args"] = args;
    }
    if (n["names"] !== null && typeof n["names"] === "object") {
      const names: Record<string, string> = {};
      for (const k of ACTION_NAME_KEYS) {
        const x = (n["names"] as Record<string, unknown>)[k];
        if (typeof x === "string") names[k] = x;
      }
      if (Object.keys(names).length > 0) note["names"] = names;
    }
    out.push(note as unknown as ActionNoteView);
  }
  return out;
}

/** A name → count tally, numbers only. */
function projectCounts(v: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (v === null || typeof v !== "object" || Array.isArray(v)) return out;
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
    if (typeof x === "number" && Number.isFinite(x)) out[k] = x;
  }
  return out;
}

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
export function projectEntry(e: EntrySummary, codeIsRepeated = false): EntrySummary {
  const out = lean<EntrySummary>({ i: e.i, t: e.t, ts: e.ts });
  if (typeof e["turn"] === "number") out["turn"] = e["turn"];
  if (typeof e["call"] === "number") out["call"] = e["call"];
  if (e.clipped === true) out.clipped = true;
  for (const k of ENTRY_FIELDS[e.t] ?? []) {
    if (!(k in e) || e[k] === undefined) continue;
    // An errored turn's text is the CLI's own message, not the model's — a
    // spent subscription's names when it resets, which stays the operator's.
    if (e.t === "claude_result" && k === "text" && e["isError"] === true) continue;
    const v = e[k];
    if (codeIsRepeated && e.t === "tool_call" && k === "args") {
      // The call's `code` is the snippet record's own; what else the call
      // carried (nothing, for run_snippet) still ships.
      const rest = Object.entries(v as Record<string, unknown>).filter(([a]) => a !== "code");
      if (rest.length > 0) out[k] = plain(Object.fromEntries(rest));
      continue;
    }
    out[k] =
      k === "items" && e.t === "state"
        ? projectItems(v as ItemSample[] | null)
        : e.t === "actions" && k === "actions"
          ? projectActionNotes(v)
          : e.t === "actions" && k === "dropped"
            ? projectCounts(v)
            : isComparabilityTuple(v)
              ? projectComparability(v)
              : plain(v);
  }
  return scrubPathsValue<EntrySummary>(redactGameProse(out));
}

/**
 * Whether a tool call's `args.code` is the very text of the `snippet` record
 * that follows it, so publishing both says the code twice.
 *
 * `run_snippet` is a tool call whose only argument is the code, and the runner
 * writes the code again as the next record. The run page draws one card from
 * the two and prints the snippet's (`lib/feedgroup.ts`, `takeCall`: the record
 * strictly after the call, matched on turn and call index), reading the call's
 * args only when no snippet pairs with it. So a copy is dropped only where that
 * pairing holds in the window as published, the same test the page applies,
 * and the call's text is the snippet's own, or the summary's clip of it (the
 * first characters, then how many more: `clip` in `tail.ts`): a call whose
 * snippet is not next, or says something else, keeps its code. About a sixth
 * of an entries window was this copy.
 */
const CLIPPED_COPY = /^([\s\S]*)\n… (\d+) more characters$/;

function isCopyOf(copy: string, whole: string): boolean {
  if (copy === whole) return true;
  const m = CLIPPED_COPY.exec(copy);
  return m !== null && whole.startsWith(m[1]!) && m[1]!.length + Number(m[2]) === whole.length;
}

function codeRepeatedBy(call: EntrySummary, next: EntrySummary | undefined): boolean {
  if (call.t !== "tool_call" || next === undefined || next.t !== "snippet") return false;
  const args = call["args"];
  if (args === null || typeof args !== "object" || Array.isArray(args)) return false;
  const code = (args as Record<string, unknown>)["code"];
  if (typeof code !== "string" || typeof next["code"] !== "string" || !isCopyOf(code, next["code"])) return false;
  if (typeof call["turn"] === "number" && typeof next["turn"] === "number" && call["turn"] !== next["turn"]) return false;
  if (typeof call["call"] === "number" && typeof next["call"] === "number" && call["call"] !== next["call"]) return false;
  return true;
}

export function projectEntries(r: EntriesResponse): EntriesResponse {
  const raw = r.entries as EntrySummary[];
  return scrubPathsValue<EntriesResponse>({
    from: r.from,
    total: r.total,
    entries: raw.map((e, i) => projectEntry(e, codeRepeatedBy(e, raw[i + 1]))) as EntriesResponse["entries"],
  });
}
