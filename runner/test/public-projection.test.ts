/**
 * The public projection IS the legal boundary (docs/DATA-AND-LEGAL.md,
 * issue #10), so this suite is written the way the boundary is argued:
 *
 * - **Key sets, exactly.** Every projector's output is compared against a
 *   written-out allowlist of deep key paths. A field nobody wrote down here
 *   cannot ship — including keys smuggled through parsed-JSON objects that
 *   carry more than their declared type (the `EntrySummary` lesson).
 * - **Values, not key names.** Every poisoned value planted in the fixtures —
 *   game-text item and target names, free-text details, filesystem
 *   paths, secrets, host URLs — is asserted absent from the *serialized*
 *   output, the same way viewer-api.test.ts checks its bearer token. A
 *   "no field called X" check would pass while the value sat under another key.
 *
 * The fixtures are maximal on purpose: every optional present, every nullable
 * non-null, so the allowlists exercise every branch of the projectors.
 */

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type {
  ApiInfoResponse,
  CampaignsResponse,
  ComparabilityView,
  CostFigure,
  CostView,
  DeathFacts,
  EpisodesResponse,
  FleetAccountView,
  FleetJobView,
  FleetResponse,
  FleetServerView,
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
  TokenTotals,
  TrackResponse,
  TraceIndexResponse,
  TraceSegment,
} from "../viewer/api-types";
import {
  PUBLIC_ATTRIBUTION,
  projectCampaigns,
  projectEpisodes,
  projectFleet,
  projectInfo,
  projectModels,
  projectPositions,
  projectResults,
  projectRunDetail,
  projectRuns,
  projectEntries,
  projectEntry,
  projectTrack,
  projectTraceIndex,
  projectTraceSegment,
} from "../viewer/public-projection";
import { summarize } from "../viewer/tail";
import { STALL_PAUSE } from "../src/lapse";

/* ------------------------------------------------------------- poisons --- */

// One distinctive value per thing the projection must withhold. Each appears
// somewhere in the fixtures below, and none may appear in any serialized output.
const POISON = {
  objective: "poison-objective: walk to Goldshire",
  apiBase: "http://10.66.66.66:1234/v1-poison",
  pauseReason: "poison-pause-free-text",
  rowError: "poison ENOENT /home/operator/data/runs",
  configPath: "/home/operator/wrathbench/infra/fleet.json",
  rosterPath: "/home/operator/wrathbench/infra/roster.json",
  lastErrorMessage: "poison 401 unauthorized bearer sk-poison-123",
  configRejectedError: "poison ENOENT open '/home/operator/wrathbench/infra/fleet.json'",
  preflightTail: "poison-smoke-tail: Fixturely says hello",
  wikiSource: "poison-wowdump-20100901.xml.bz2",
  smuggled: "poison-smuggled-value",
  // Game prose, as the entry window can carry it (docs/DATA-AND-LEGAL.md,
  // "Trajectory logs"): every field the redactor enumerates gets one.
  questDetails: "prose-quest-details: the kobolds have grown bold",
  questObjectives: "prose-quest-objectives: slay ten of them",
  questRequestText: "prose-request-items: have you brought them",
  questOfferText: "prose-offer-reward: well done adventurer",
  questGreeting: "prose-questgiver-greeting: welcome traveller",
  gossipOption: "prose-gossip-option: tell me about the mine",
  trainerGreeting: "prose-trainer-greeting: ready to learn",
  itemDescription: "prose-item-description: a rusty blade of no renown",
  pageText: "prose-page-text: dear reader, beware",
  itemText: "prose-item-text: a letter written in haste",
  mailBody: "prose-mail-body: your order is ready",
  chatMessage: "prose-chat-message: begone from my mine",
  objectiveText: "prose-objective-text: Kobold Vermin slain",
  wikiText: "prose-wiki-text: Northshire Valley is the human starting area",
  pauseDetail: "poison-pause-detail: 429 rate limited by provider",
  driverBin: "/home/operator/.bun/bin/claude",
  claudeCwd: "/home/operator/wrathbench/runner",
} as const;

/**
 * Names and ids are published, not withheld (operator, 2026-08-30): each of
 * these must SURVIVE every projection it is planted in.
 */
const SURVIVES = {
  itemName: "Worn Shortsword",
  targetName: "Marshal McBride",
  terminationDetail: "episode limit reached near Goldshire",
  statusText: "turned in Kobold Camp Cleanup to Marshal McBride",
  statusZone: "Elwynn Forest",
  questTitle: "Kobold Camp Cleanup",
  npcName: "Marshal McBride",
  zoneName: "Northshire Valley",
  spellName: "Charge",
} as const;

/**
 * The character name is published, not withheld: the runner generates it at
 * character creation, so it is not game text. It is a fixture value here, and
 * the projections assert it survives.
 */
const CHARACTER_NAME = "Fixturely";

/** A pid must not survive either; checked as its decimal string. */
const POISON_PID = 987654321;

/** Plant an undeclared key on a typed object, the way parsed JSON can carry one. */
function smuggle<T extends object>(o: T): T {
  return { ...o, smuggledKey: POISON.smuggled } as T;
}

function assertClean(serialized: string): void {
  for (const [name, value] of Object.entries(POISON)) {
    expect(`${name}: ${serialized}`).not.toContain(value);
  }
  expect(serialized).not.toContain(String(POISON_PID));
  expect(serialized).not.toContain("smuggledKey");
}

/* ------------------------------------------------- deep key-path helper --- */

/**
 * Every key path in a JSON value, arrays collapsed to `[]`, sorted and unique.
 * `{a: {b: 1}, c: [{d: 2}]}` → ["a", "a.b", "c", "c[].d"].
 */
function keyPaths(v: unknown, prefix = ""): string[] {
  const out = new Set<string>();
  const walk = (value: unknown, at: string): void => {
    if (Array.isArray(value)) {
      for (const item of value) walk(item, `${at}[]`);
      return;
    }
    if (value !== null && typeof value === "object") {
      for (const [k, item] of Object.entries(value)) {
        const path = at === "" ? k : `${at}.${k}`;
        out.add(path);
        walk(item, path);
      }
    }
  };
  walk(v, prefix);
  return [...out].sort();
}

const under = (prefix: string, keys: readonly string[]): string[] => keys.map((k) => `${prefix}.${k}`);
const allow = (keys: readonly string[]): string[] => [...new Set(keys)].sort();

/* ------------------------------------------------------------- fixtures --- */

function comparabilityFixture(): ComparabilityView {
  return smuggle<ComparabilityView>({
    harnessVersion: "harness-0.5-1-gabc",
    promptHash: "sha256:0123456789abcdef",
    promptChars: 4242,
    harness: "wrathbench",
    effort: "high",
    budget: smuggle({
      maxTurns: null,
      maxToolCalls: 3000,
      idleMs: 600_000,
      noXpMs: null,
      episodeMs: 5_400_000,
      maxSandboxRestarts: 3,
    }),
    objective: true,
    wikiCoords: true,
    // Off, so the projection has a value to carry (issue #61).
    wiki: false,
    // Set, so the projection has a value to carry (a run dimension like effort).
    compactWindow: "100k",
    // The dump filename must not survive projection.
    wikiBundle: { schemaVersion: "1", builtAt: "2026-08-01", source: POISON.wikiSource, eraCutoff: "2010-09-01" },
    episode: "e90",
    episodeOverride: false,
    serverBuild: { build: "harness-0.5-1-gdef", startedAtMs: 12_345 },
    resolvedModel: "some/model-served",
  });
}

function runRowFixture(): RunRow {
  return smuggle<RunRow>({
    runId: "fixture-run-1",
    model: "test/model",
    driver: "openai",
    harness: "wrathbench",
    shakeout: "shakeout",
    objective: POISON.objective,
    campaign: "sweep-1",
    cell: "cell-a",
    campaignVersion: 2,
    arm: "base",
    // A roster name and a requested image (with its registry host) never reach a public row.
    ref: "fixture-roster-name",
    image: "registry.lab.internal/wb/runner:t1",
    continuedFrom: "fixture-run-0",
    extra: false,
    character: CHARACTER_NAME,
    race: 3,
    raceName: "Dwarf",
    class: 3,
    className: "Hunter",
    characterLabel: "Dwarf Hunter",
    platform: "openrouter",
    resolvedModel: "some/model-served",
    cliVersion: "9.9.9",
    apiBase: POISON.apiBase,
    harnessVersion: "harness-0.5-1-gabc",
    comparability: comparabilityFixture(),
    startedAt: 1000,
    endedAt: 2000,
    terminationReason: "episode-limit",
    terminationDetail: SURVIVES.terminationDetail,
    pauseReason: POISON.pauseReason,
    level: 4,
    xp: 500,
    money: 1234,
    questsCompleted: 2,
    items: [
      smuggle({ name: SURVIVES.itemName, count: 1, equipped: true, itemId: 5956, quality: 1, slot: 16 }),
      smuggle({ name: SURVIVES.itemName, count: 2, equipped: false, itemId: 2589, quality: 1, slot: 23, bag: 255 }),
      // A row as every sample carried it before the paperdoll fields existed.
      smuggle({ name: SURVIVES.itemName, count: 3, equipped: false }),
    ],
    mtime: 3000,
    bytes: 4096,
    live: false,
    error: POISON.rowError,
  });
}

function tokensFixture(): TokenTotals {
  return smuggle<TokenTotals>({
    source: "reported",
    contextTokens: 10,
    promptTokens: 20,
    completionTokens: 30,
    totalTokens: 50,
    cacheReadTokens: 5,
    cacheWriteTokens: 6,
    turns: 7,
  });
}

function costFigureFixture(): CostFigure {
  return smuggle<CostFigure>({
    usd: 1.5,
    basis: "list-price",
    asIfMetered: true,
    breakdown: { input: 1, output: 0.3, cacheRead: 0.1, cacheWrite: 0.1 },
    priceId: "openrouter:test/model",
    asOf: "2026-08-20",
    note: "computed at list price",
  });
}

function costViewFixture(): CostView {
  return smuggle<CostView>({
    ...costFigureFixture(),
    actual: costFigureFixture(),
    expected: costFigureFixture(),
  });
}

function runListRowFixture(): RunListRow {
  return smuggle<RunListRow>({
    ...runRowFixture(),
    tokens: tokensFixture(),
    tps: { overall: 12.5, recent: 20, replies: 4, recentReplies: 2 },
    cost: costViewFixture(),
    firstTs: 1000,
    lastTs: 2000,
    playtimeMs: 1000,
    modelResponses: 3,
    // An input claiming snapshot paths must not have them believed.
    snapshot: { detail: "v1/run/liar/000/detail.json", track: "v1/run/liar/000/track.json" },
  });
}

function resultsFixture(): ResultsResponse {
  return smuggle<ResultsResponse>({
    runs: [
      smuggle<ResultRun>({
        runId: "fixture-run-1",
        model: "test/model",
        resolvedModel: "some/model-served",
        cliVersion: "9.9.9",
        driver: "openai",
        platform: "openrouter",
        harnessVersion: "harness-0.5-1-gabc",
        harnessSeries: "0.5",
        extra: false,
        race: 3,
        raceName: "Dwarf",
        class: 3,
        className: "Hunter",
        characterLabel: "Dwarf Hunter",
        campaign: "sweep-1",
        cell: "cell-a",
        campaignVersion: 2,
        arm: "base",
        ref: "fixture-roster-name",
        image: "registry.lab.internal/wb/runner:t1",
        effort: "high",
        compactWindow: "100k",
        harness: "wrathbench",
        promptHash: "sha256:0123456789abcdef",
        serverBuild: "harness-0.5-1-gdef",
        wikiCoords: true,
        wiki: false,
        episode: "e90",
        episodeSource: "stamped",
        episodeOverride: false,
        toolCalls: 12,
        snippets: 8,
        modelResponses: 3,
        unscored: "operator objective",
        startedAt: 1000,
        endedAt: 2000,
        live: false,
        terminationReason: "episode-limit",
        levels: [smuggle({ level: 2, ts: 1500, turn: 1, playtimeMs: 500 })],
        maxLevel: 2,
        xp: 150,
        xpEarned: 350,
        money: 1234,
        questsCompleted: 2,
        maps: [0, 1],
        character: CHARACTER_NAME,
        playtimeMs: 1000,
        sessions: [smuggle({ start: 1000, end: 2000 }), smuggle({ start: 9000, end: null })],
        tokens: tokensFixture(),
        actualCost: costFigureFixture(),
        expectedCost: costFigureFixture(),
        billing: "paid",
        areas: { startArea: 9, distinctAreas: 3, leftStartArea: true, capitalZone: 1519, zoneMarks: 4, areaMarks: 5 },
        achievements: { earned: 2, points: 20, ids: [6, 12] },
        taxi: { flights: 1 },
        pauseReason: POISON.pauseReason,
        continuedFrom: "fixture-run-0",
        stillborn: false,
      }),
    ],
    episode: "all",
    harness: "all",
    includeOverrides: true,
    filteredOut: 0,
    overridesExcluded: 0,
    now: 5000,
  });
}

/* ------------------------------------------------------------ allowlists --- */

const BUDGET_KEYS = ["maxTurns", "maxToolCalls", "idleMs", "noXpMs", "episodeMs", "maxSandboxRestarts"];
const COMPARABILITY_KEYS = [
  "harnessVersion",
  "promptHash",
  "promptChars",
  "harness",
  "effort",
  "budget",
  ...under("budget", BUDGET_KEYS),
  "objective",
  "wikiCoords",
  "wiki",
  "compactWindow",
  // no wikiBundle: withheld (its `source` is the operator's dump filename)
  "episode",
  "episodeOverride",
  "serverBuild",
  "serverBuild.build",
  "serverBuild.startedAtMs",
  "resolvedModel",
];
const RUN_ROW_KEYS = [
  "items[].name",
  "items[].count",
  "items[].equipped",
  // Where a row sits and what it is: ids and names are published, prose is not.
  "items[].itemId",
  "items[].quality",
  "items[].slot",
  "items[].bag",
  "runId",
  "model",
  "driver",
  "harness",
  "shakeout",
  // no `objective`, `apiBase`, `mtime`, `bytes`, `raceName`, `className`: the
  // first two are always null on a public row, the next two are the file's,
  // the last two repeat `characterLabel`; no public page reads any of them.
  "campaign",
  "cell",
  "campaignVersion",
  "arm",
  "extra",
  "character",
  "race",
  "class",
  "characterLabel",
  "platform",
  "resolvedModel",
  "cliVersion",
  "harnessVersion",
  "comparability",
  ...under("comparability", COMPARABILITY_KEYS),
  "startedAt",
  "endedAt",
  "terminationReason",
  "terminationDetail",
  "pauseReason",
  "continuedFrom",
  "level",
  "xp",
  "money",
  "questsCompleted",
  "items",
  "live",
  // no `error`: a caught exception's message can carry paths
];
const TOKENS_KEYS = [
  "source",
  "contextTokens",
  "promptTokens",
  "completionTokens",
  "totalTokens",
  "cacheReadTokens",
  "cacheWriteTokens",
  "turns",
];
const TPS_KEYS = ["overall", "recent", "replies", "recentReplies"];
// No `breakdown`: no public page reads the per-component dollars.
const COST_FIGURE_KEYS = ["usd", "basis", "asIfMetered", "priceId", "asOf", "note"];
// No top-level mirror of `expected`: the pages read `actual` and `expected`.
const COST_VIEW_KEYS = ["actual", ...under("actual", COST_FIGURE_KEYS), "expected", ...under("expected", COST_FIGURE_KEYS)];
// What the fleet table reads of a run (`fleetRows`), and the pointers: the
// published `runs.json` row, nothing more.
const RUN_LIST_ROW_KEYS = [
  "runId",
  "resolvedModel",
  "level",
  "xp",
  "playtimeMs",
  "tokens",
  "tokens.totalTokens",
  "tps",
  ...under("tps", TPS_KEYS),
  "cost",
  "cost.actual",
  ...under("cost.actual", ["usd", "basis", "note"]),
  "comparability",
  "comparability.budget",
  "comparability.budget.episodeMs",
  // no `snapshot`: only the renderer stamps it, after projection
];
// The run page's chart reads three fields of a sample; the character route
// (`STATE_KEYS`) serves the whole frame.
const CHART_SAMPLE_KEYS = ["ts", "level", "xp"];
const STATE_KEYS = ["ts", "level", "xp", "map", "x", "y", "z", "eventCount", "lastSeq", "turn",
  // The player frame's numbers: public on every surface that
  // carries a state sample, as they are on the positions feed.
  "health", "maxHealth", "power", "maxPower", "powerType", "nextLevelXp",
  // Already public as the run row's count; per sample it totals a run
  // resumed in place across its restart.
  "questsCompleted"];
const RESULT_RUN_KEYS = [
  "runId",
  "model",
  "resolvedModel",
  // Which CLI drove the run: already public on `RunRow.driver`, and the
  // character view's header reads it from here.
  "driver",
  "harnessVersion",
  "harnessSeries",
  "extra",
  "race",
  "class",
  "characterLabel",
  "campaign",
  "cell",
  "campaignVersion",
  "arm",
  "effort",
  "compactWindow",
  "harness",
  // no `platform`, `cliVersion`, `promptHash`, `serverBuild`, `wikiCoords`,
  // `wiki`, `raceName`, `className`: the run page reads the first six off the
  // run's own row and tuple, and none is read off a result row.
  "episode",
  "episodeSource",
  "episodeOverride",
  "toolCalls",
  "snippets",
  "modelResponses",
  "unscored",
  "startedAt",
  "endedAt",
  "live",
  "terminationReason",
  "levels",
  ...under("levels[]", ["level", "ts", "turn", "playtimeMs"]),
  "maxLevel",
  "xp",
  "xpEarned",
  "money",
  "questsCompleted",
  "maps",
  "character",
  "playtimeMs",
  // Two timestamps per session, on the clock every row already carries.
  "sessions",
  ...under("sessions[]", ["start", "end"]),
  "tokens",
  ...under("tokens", TOKENS_KEYS),
  "actualCost",
  ...under("actualCost", ["usd", "basis", "asIfMetered", "note"]),
  "expectedCost",
  ...under("expectedCost", ["usd", "basis", "asIfMetered"]),
  "billing",
  "areas",
  ...under("areas", ["startArea", "distinctAreas", "leftStartArea", "capitalZone", "zoneMarks", "areaMarks"]),
  "achievements",
  ...under("achievements", ["earned", "points", "ids"]),
  "taxi",
  "taxi.flights",
  "pauseReason",
  "continuedFrom",
  "stillborn",
];

/* ---------------------------------------------------------------- tests --- */

describe("the attribution line", () => {
  test("is the operator's fan-made / trademark statement, verbatim", () => {
    // The operator's wording, verbatim (2026-08-30): pinned whole.
    expect(PUBLIC_ATTRIBUTION).toBe(
      "WrathBench is a fan-made research project, not affiliated with or endorsed by Blizzard Entertainment. World of Warcraft is a trademark of Blizzard Entertainment, Inc.",
    );
  });
});

/** A run row as the published detail carries it: where the row-level withholdings are checked. */
function runRowOf(over: Partial<RunRow> = {}): RunRow {
  return projectRunDetail(
    smuggle<RunDetailResponse>({
      run: { ...runRowFixture(), ...over },
      states: [],
      total: 0,
      tokens: tokensFixture(),
      cost: costViewFixture(),
      playtimeMs: 1,
    }),
  ).run;
}

function fixtureBudget(): ComparabilityView["budget"] {
  return runRowFixture().comparability!.budget;
}

describe("projectRuns", () => {
  test("emits exactly the allowlist and none of the poisoned values (projectRuns)", () => {
    const input: RunsResponse = smuggle<RunsResponse>({ runs: [runListRowFixture()] });
    const out = projectRuns(input);
    expect(keyPaths(out)).toEqual(allow(["runs", ...under("runs[]", RUN_LIST_ROW_KEYS)]));
    assertClean(JSON.stringify(out));
  });

  test("a listing row is the fleet table's join and nothing else: no field a page reads off another object", () => {
    const row = projectRuns({ runs: [runListRowFixture()] }).runs[0]!;
    expect(row.runId).toBeDefined();
    for (const gone of ["items", "objective", "apiBase", "terminationDetail", "pauseReason", "character", "characterLabel", "model", "mtime", "bytes", "firstTs", "lastTs", "modelResponses", "driver", "harnessVersion"]) {
      expect(gone in row).toBe(false);
    }
    // The estimate and the per-component dollars stay on the run's own page.
    expect(Object.keys(row.cost!)).toEqual(["actual"]);
    expect(row.comparability).toEqual({ budget: { episodeMs: fixtureBudget().episodeMs } });
  });

  test("withholds by value, not by renaming: the fields read null", () => {
    const row = runRowOf();
    expect(row.items).toEqual([
      { name: SURVIVES.itemName, count: 1, equipped: true, itemId: 5956, quality: 1, slot: 16 },
      { name: SURVIVES.itemName, count: 2, equipped: false, itemId: 2589, quality: 1, slot: 23, bag: 255 },
      { name: SURVIVES.itemName, count: 3, equipped: false },
    ]);
    // Back-compat: an old-shape row keeps its three keys rather than gaining
    // four undefined ones — absence is what "unobserved" looks like on the wire.
    expect(Object.keys(row.items![2]!)).toEqual(["name", "count", "equipped"]);
    // Always-null on a public row, so not emitted at all.
    expect("objective" in row).toBe(false);
    expect("apiBase" in row).toBe(false);
    expect(row.terminationDetail).toBe(SURVIVES.terminationDetail);
    // The paused signal survives as a fixed token, never as the free text.
    expect(row.pauseReason).toBe("paused");
    // What the label layer needs survives — and so does the name itself.
    expect(row.character).toBe(CHARACTER_NAME);
    expect(row.characterLabel).toBe("Dwarf Hunter");
    // The label already names the pair.
    expect("raceName" in row).toBe(false);
    expect("className" in row).toBe(false);
    expect(row.terminationReason).toBe("episode-limit");
  });

  test("a backfilled claude-code actual crosses with its parts, so the public figure wears the same *", () => {
    const backfill = { reportedUsd: 839.38, usd: 748.7, turns: 2 };
    const fixture = runListRowFixture();
    const row = { ...fixture, cost: { ...fixture.cost!, actual: { ...fixture.cost!.actual, backfill: smuggle<typeof backfill>({ ...backfill }) } } };
    const out = projectRuns({ runs: [row] }).runs[0]!;
    expect(out.cost?.actual.backfill).toEqual(backfill);
    assertClean(JSON.stringify(out));
  });

  test("a launch-failed stub's detail is the launcher's text, registry host and API URL included: withheld, the reason crosses", () => {
    const detail = "run pod create refused: POST https://kubernetes.default.svc/api/v1/namespaces/wrathbench/pods: 403 Forbidden — harbor.example/library/wrathbench-runner:harness-0.5-1";
    const row = runRowOf({ terminationReason: "launch-failed", terminationDetail: detail });
    expect(row.terminationReason).toBe("launch-failed");
    expect(row.terminationDetail).toBeNull();
    expect(JSON.stringify(row)).not.toContain("harbor.example");
    expect(JSON.stringify(row)).not.toContain("kubernetes.default.svc");
  });

  test("a run that never paused stays null: the token marks paused runs only", () => {
    expect(runRowOf({ pauseReason: null }).pauseReason).toBeNull();
  });

  test("the stall pause crosses as itself, so the public site can say stalled; every other reason is still the token", () => {
    expect(runRowOf({ terminationReason: null, pauseReason: STALL_PAUSE }).pauseReason).toBe("observation-stalled");
    for (const other of ["rate-limited", "operator-pause", `${STALL_PAUSE}: with words after it`]) {
      expect(runRowOf({ terminationReason: null, pauseReason: other }).pauseReason).toBe("paused");
    }
    const results = resultsFixture();
    results.runs[0]!.pauseReason = STALL_PAUSE;
    expect(projectResults(results).runs[0]!.pauseReason).toBe("observation-stalled");
  });
});

describe("projectRunDetail", () => {
  test("a disabled tool-call ceiling survives projection as null", () => {
    // The projection copies the budget key by key, so a value it cannot
    // represent would land as undefined and the page would render nothing at
    // all where it should say "unlimited". The policy freeplay lane is the
    // only run that carries this, and it is exactly the run an operator opens
    // the page to check on.
    const run = runRowFixture();
    const input: RunDetailResponse = smuggle<RunDetailResponse>({
      run: smuggle({
        ...run,
        comparability: smuggle({ ...run.comparability!, budget: smuggle({ ...run.comparability!.budget, maxToolCalls: null }) }),
      }),
      states: [],
      total: 0,
      tokens: tokensFixture(),
      cost: costViewFixture(),
      playtimeMs: 1000,
      achievements: { earned: 0, points: 0, ids: [] },
      taxi: { flights: 0 },
      tps: { overall: 0, recent: 0, replies: 0, recentReplies: 0 },
    });
    expect(projectRunDetail(input).run.comparability!.budget.maxToolCalls).toBeNull();
  });

  test("emits exactly the allowlist and none of the poisoned values (projectRunDetail)", () => {
    const input: RunDetailResponse = smuggle<RunDetailResponse>({
      run: runRowFixture(),
      states: [
        smuggle({ ts: 1000, level: 1, xp: 0, map: 0, x: -6240, y: 380, z: 385, eventCount: 12, lastSeq: 99, turn: 1 }),
      ],
      total: 3,
      tokens: tokensFixture(),
      cost: costViewFixture(),
      playtimeMs: 1000,
      sessions: [smuggle({ start: 1000, end: 2000 }), smuggle({ start: 9000, end: null })],
      achievements: { earned: 2, points: 20, ids: [6, 12] },
      taxi: { flights: 1 },
      deaths: smuggle({
        deaths: 1,
        releases: 1,
        resurrects: 1,
        first: null,
        last: null,
        sites: [
          smuggle({
            ts: 1500, turn: 3, position: { map: 0, x: -6230, y: 381, z: 385, source: "death_spot" as const },
            zone: 1, area: 132, released: false,
          }),
        ],
      }),
      tps: { overall: 12.5, recent: 20, replies: 4, recentReplies: 2 },
      reflections: [smuggle({ fromTurn: 5, toTurn: 9 }), smuggle({ fromTurn: 12, toTurn: null })],
    });
    const out = projectRunDetail(input);
    expect(keyPaths(out)).toEqual(
      allow([
        "run",
        ...under("run", RUN_ROW_KEYS),
        "states",
        ...under("states[]", CHART_SAMPLE_KEYS),
        "total",
        "tokens",
        ...under("tokens", TOKENS_KEYS),
        "cost",
        ...under("cost", COST_VIEW_KEYS),
        "playtimeMs",
        "sessions",
        ...under("sessions[]", ["start", "end"]),
        "achievements",
        ...under("achievements", ["earned", "points", "ids"]),
        "taxi",
        "taxi.flights",
        // Deaths are public (operator, 2026-10-18): the counts and the turns
        // the milestones row prints, and nothing of a site no page reads.
        "deaths",
        ...under("deaths", ["deaths", "releases", "resurrects", "sites"]),
        "deaths.sites[].turn",
        "tps",
        ...under("tps", TPS_KEYS),
        "reflections",
        ...under("reflections[]", ["fromTurn", "toTurn"]),
      ]),
    );
    assertClean(JSON.stringify(out));
    // Turn indices are a fact about the harness's own loop, so they travel —
    // unlike the episodic entry the same window is about.
    expect(out.reflections).toEqual([
      { fromTurn: 5, toTurn: 9 },
      { fromTurn: 12, toTurn: null },
    ]);
    expect(out.deaths).toEqual({ deaths: 1, releases: 1, resurrects: 1, sites: [{ turn: 3 }] } as DeathFacts);
  });

  test("spells, talents and trades project whole: ids, counts and turns, nothing nameable", () => {
    const input: RunDetailResponse = smuggle<RunDetailResponse>({
      run: runRowFixture(),
      states: [],
      total: 0,
      tokens: tokensFixture(),
      cost: costViewFixture(),
      playtimeMs: 1000,
      spells: smuggle({ learned: 1, atLogin: 3, ids: [772], marks: [smuggle({ id: 772, ts: 1200, turn: 5 })] }),
      talents: smuggle({ spends: 1, talents: 1, marks: [smuggle({ id: 1683, points: 1, ts: 1300, turn: 7 })] }),
      trades: smuggle({
        trades: 1,
        first: smuggle({ ts: 4444, turn: 9 }),
        last: smuggle({ ts: 4444, turn: 9 }),
        marks: [smuggle({ ts: 4444, turn: 9 })],
      }),
    });
    const out = projectRunDetail(input);
    expect(out.spells).toEqual({ learned: 1, atLogin: 3, ids: [772], marks: [{ id: 772, ts: 1200, turn: 5 }] });
    expect(out.talents).toEqual({ spends: 1, talents: 1, marks: [{ id: 1683, points: 1, ts: 1300, turn: 7 }] });
    expect(out.trades).toEqual({
      trades: 1,
      first: { ts: 4444, turn: 9 },
      last: { ts: 4444, turn: 9 },
      marks: [{ ts: 4444, turn: 9 }],
    });
    assertClean(JSON.stringify(out));
  });

  test("a run that recorded none keeps the null: the public reader must not read it as zero", () => {
    const input: RunDetailResponse = smuggle<RunDetailResponse>({
      run: runRowFixture(),
      states: [],
      total: 0,
      tokens: tokensFixture(),
      cost: costViewFixture(),
      playtimeMs: 1000,
      spells: null,
      talents: null,
      trades: null,
      deaths: null,
    });
    const out = projectRunDetail(input);
    expect(out.spells).toBeNull();
    expect(out.talents).toBeNull();
    expect(out.trades).toBeNull();
    expect(out.deaths).toBeNull();
    // A body from before deaths were public has none, and re-projects to itself.
    const { deaths: _gone, ...older } = input;
    const again = projectRunDetail(older as RunDetailResponse);
    expect("deaths" in again).toBe(false);
    expect(projectRunDetail(again)).toEqual(again);
  });
});

describe("projectResults", () => {
  test("emits exactly the allowlist and none of the poisoned values (projectResults)", () => {
    const out = projectResults(resultsFixture());
    expect(keyPaths(out)).toEqual(
      allow([
        "runs",
        ...under("runs[]", RESULT_RUN_KEYS),
        "episode",
        "harness",
        "includeOverrides",
        "filteredOut",
        "overridesExcluded",
        "now",
      ]),
    );
    assertClean(JSON.stringify(out));
    expect(out.runs[0]!.character).toBe(CHARACTER_NAME);
    expect(out.runs[0]!.pauseReason).toBe("paused");
  });
});

describe("projectPositions and projectTrack", () => {
  test("positions: exactly the allowlist; names survive, the episodic status ships whole", () => {
    const input: PositionsResponse = smuggle<PositionsResponse>({
      positions: [
        smuggle({
          runId: "fixture-run-1",
          character: CHARACTER_NAME,
          model: "test/model",
          effort: "low",
          map: 0,
          x: -6240,
          y: 380,
          ts: 1000,
          level: 3,
          xp: 400,
          money: 1234,
          questsCompleted: 2,
          items: [smuggle({ name: SURVIVES.itemName, count: 1, equipped: false, itemId: 6948, quality: 1, slot: 23, bag: 255 })],
          harnessVersion: "harness-0.5-1-gabc",
          health: 140,
          maxHealth: 220,
          power: 30,
          maxPower: 100,
          powerType: 3,
          nextLevelXp: 2100,
          class: 4,
          status: smuggle({ turn: 11, level: 3, zone: SURVIVES.statusZone, text: SURVIVES.statusText, ts: 1300 }),
          reflecting: true,
          move: smuggle({ ts: 1200, map: 0, x: -6200, y: 400, z: 380, target: SURVIVES.targetName, status: null }),
        }),
      ],
    });
    const out = projectPositions(input);
    expect(keyPaths(out)).toEqual(
      allow([
        "positions",
        ...under("positions[]", [
          "runId",
          "character",
          "model",
          "effort",
          "map",
          "x",
          "y",
          "ts",
          "level",
          "xp",
          "money",
          "questsCompleted",
          "items",
          "items[].name", "items[].count", "items[].equipped",
          "items[].itemId", "items[].quality", "items[].slot", "items[].bag",
          "harnessVersion",
          "health", "maxHealth", "power", "maxPower", "powerType", "nextLevelXp",
          "class",
          "move",
          "status",
          ...under("status", ["turn", "level", "zone", "text", "ts"]),
          "reflecting",
        ]),
        ...under("positions[].move", ["ts", "map", "x", "y", "target", "status"]),
      ]),
    );
    assertClean(JSON.stringify(out));
    expect(out.positions[0]!.character).toBe(CHARACTER_NAME);
    expect(out.positions[0]!.items).toEqual([
      { name: SURVIVES.itemName, count: 1, equipped: false, itemId: 6948, quality: 1, slot: 23, bag: 255 },
    ]);
    // The model's own words and the zone name ship (names and model text are
    // published); the smuggled key beside them does not.
    expect(out.positions[0]!.status).toEqual({ turn: 11, level: 3, zone: SURVIVES.statusZone, text: SURVIVES.statusText, ts: 1300 });
    expect(out.positions[0]!.reflecting).toBe(true);
    // The player frame's numbers are public: what any onlooker's client shows.
    expect(out.positions[0]).toMatchObject({
      health: 140,
      maxHealth: 220,
      power: 30,
      maxPower: 100,
      powerType: 3,
      nextLevelXp: 2100,
      class: 4,
    });
    // The destination and the unit's name both travel.
    expect<unknown>(out.positions[0]!.move).toEqual({ ts: 1200, map: 0, x: -6200, y: 400, target: SURVIVES.targetName, status: null });
  });

  test("track: exactly the allowlist; the character name survives", () => {
    const input: TrackResponse = smuggle<TrackResponse>({
      runId: "fixture-run-1",
      characterName: CHARACTER_NAME,
      model: "test/model",
      harnessVersion: "harness-0.5-1-gabc",
      points: [
        smuggle({
          ts: 1000, map: 0, x: -6240, y: 380, level: 1, xp: 0, money: 0, questsCompleted: 0, turn: 1,
          health: 140, maxHealth: 220, power: 30, maxPower: 100, powerType: 3, nextLevelXp: 2100,
          items: [smuggle({ name: SURVIVES.itemName, count: 1, equipped: true, itemId: 5956, quality: 1, slot: 16 })],
        }),
        // A point the inventory did not change on carries no `items` at all.
        smuggle({
          ts: 2000, map: 0, x: -6230, y: 381, level: 1, xp: 5, money: 0, questsCompleted: 0, turn: 2,
          health: 140, maxHealth: 220, power: 30, maxPower: 100, powerType: 3, nextLevelXp: 2100,
        }),
      ],
      moves: [
        smuggle({ ts: 1200, map: 0, x: -6200, y: 400, z: 380, target: SURVIVES.targetName, status: "arrived" }),
      ],
      // The character's neighbours: run ids and two counters, each
      // already public on every runs row, and nothing smuggled beside them.
      character: smuggle({ characterId: "a1", attempt: 2, attempts: 3, previous: "a1", next: "a3" }),
      // Flights, hearths and releases as kinds and timestamps; a kind the
      // projection does not know stays behind.
      travel: [
        smuggle({ kind: "taxi", ts: 1300 }),
        smuggle({ kind: "taxi_landed", ts: 1400 }),
        smuggle({ kind: "release", ts: 1500 }),
        smuggle({ kind: "hearth", ts: 1600 }),
        smuggle({ kind: "portal" as "taxi", ts: 1700 }),
      ],
    });
    const out = projectTrack(input);
    expect(keyPaths(out)).toEqual(
      allow([
        "runId",
        "characterName",
        "model",
        "harnessVersion",
        "points",
        ...under("points[]", [
          "ts", "map", "x", "y", "level", "xp", "money", "questsCompleted", "turn",
          "health", "maxHealth", "power", "maxPower", "powerType", "nextLevelXp",
          "items", "items[].name", "items[].count", "items[].equipped",
          "items[].itemId", "items[].quality", "items[].slot",
        ]),
        "moves",
        ...under("moves[]", ["ts", "map", "x", "y", "target", "status"]),
        "character",
        ...under("character", ["characterId", "attempt", "attempts", "previous", "next"]),
        "travel",
        ...under("travel[]", ["kind", "ts"]),
      ]),
    );
    assertClean(JSON.stringify(out));
    expect(out.characterName).toBe(CHARACTER_NAME);
    expect(out.moves![0]!.target).toBe(SURVIVES.targetName);
    // Deaths are public (operator, 2026-10-18), so the graveyard release ships.
    expect(out.travel).toEqual([
      { kind: "taxi", ts: 1300 },
      { kind: "taxi_landed", ts: 1400 },
      { kind: "release", ts: 1500 },
      { kind: "hearth", ts: 1600 },
    ]);
    expect(out.points[0]).toMatchObject({ health: 140, maxHealth: 220, powerType: 3, nextLevelXp: 2100 });
    // The inventory is published where it changed, and "unchanged" stays the
    // absence of the field rather than an empty list the reader would misread.
    expect(out.points[0]!.items).toEqual([
      { name: SURVIVES.itemName, count: 1, equipped: true, itemId: 5956, quality: 1, slot: 16 },
    ]);
    expect("items" in out.points[1]!).toBe(false);
    expect(out.character).toEqual({ characterId: "a1", attempt: 2, attempts: 3, previous: "a1", next: "a3" });
  });

  test("track: a run with no character carries no field at all, as an older track does", () => {
    const out = projectTrack({
      runId: "fixture-run-1",
      characterName: CHARACTER_NAME,
      model: "test/model",
      harnessVersion: "harness-0.5-1-gabc",
      points: [],
    });
    expect("character" in out).toBe(false);
    // Nor travel marks: absent is what an older track says, not "none".
    expect("travel" in out).toBe(false);
    // Nor a trace: a run from before the recorder keeps its bytes, and its key.
    expect("trace" in out).toBe(false);
  });

  test("track: the trace window list ships as numbers, and nothing smuggled beside it", () => {
    const out = projectTrack(
      smuggle<TrackResponse>({
        runId: "fixture-run-1",
        characterName: CHARACTER_NAME,
        model: "test/model",
        harnessVersion: "harness-0.5-1-gabc",
        points: [],
        trace: smuggle({ segMs: 300_000, segs: [[1_760_000_100_000, 3, POISON.smuggled] as unknown as [number, number]] }),
      }),
    );
    expect(out.trace).toEqual({ segMs: 300_000, segs: [[1_760_000_100_000, 3]] });
    assertClean(JSON.stringify(out));
  });
});

/* -------------------------------------------------------------- trace --- */

/** A private segment as the viewer encodes it, poisoned everywhere a key can hide. */
function traceSegmentFixture(): TraceSegment {
  const t0 = 1_760_000_100_000;
  const full = {
    hp: 1200, hpMax: 1200, pw: 900, pwMax: 1000, pwType: 0, level: 14, xp: 3200, xpMax: 9800,
    auras: [[1126, 1, t0 + 1_500_000, 19, POISON.smuggled]],
    combat: true, mounted: false, taxi: false, dead: false, ghost: false, resting: false,
    target: smuggle({ kind: "player", entry: 7, hpPct: 55 }),
    cast: smuggle({ spellId: 133, endsAt: t0 + 3000 }),
    smuggledKey: POISON.smuggled,
  };
  return smuggle<TraceSegment>({
    v: 1,
    run: "fixture-run-1",
    t0,
    t1: t0 + 300_000,
    q: smuggle({ p: 10, o: 1024 }),
    k: smuggle({ p: [0, -94604, 621, 563, 195], pt: -400, s: full, f: [0, -90000, 0, 600, 60_000] }) as unknown as TraceSegment["k"],
    dt: [400, 1000, 1000],
    x: [26, 26, 22],
    y: [65, 65, 63],
    z: [1, -1, 2],
    o: [-1, 5, 13],
    cuts: [[2, 0, POISON.smuggled] as unknown as [number, number]],
    flights: [[1, 0, 1000, 2000, 30, 120_000, 99] as unknown as [number, number, number, number, number, number]],
    ev: [
      [100, "target", { kind: "creature", entry: 299, hpPct: 100 }],
      [200, "mood", POISON.smuggled],
      [300, "hp", 1100],
      [400, "auras", [[1126, 1, t0 + 1_500_000, 21]]],
      [500, "cast", null],
    ],
  });
}

describe("projectTraceSegment", () => {
  test("emits exactly the allowlist: positions, cuts, flights and the public state, deaths included; target never", () => {
    const out = projectTraceSegment(traceSegmentFixture());
    const PUBLIC_STATE = ["hp", "hpMax", "pw", "pwMax", "pwType", "level", "xp", "xpMax", "auras", "combat", "mounted", "taxi", "dead", "ghost", "resting", "cast"];
    expect(keyPaths(out)).toEqual(
      allow([
        "v", "run", "t0", "t1", "q", "q.p", "q.o",
        "k", "k.p", "k.pt", "k.s", "k.f",
        ...under("k.s", PUBLIC_STATE),
        "k.s.cast.spellId", "k.s.cast.endsAt",
        "dt", "x", "y", "z", "o", "cuts", "flights", "ev",
      ]),
    );
    assertClean(JSON.stringify(out));
    expect(out.k.s).toMatchObject({ hp: 1200, combat: true, dead: false, ghost: false, cast: { spellId: 133, endsAt: 1_760_000_103_000 } });
    // An aura's flags stay behind, and so does the element smuggled after them.
    expect(out.k.s.auras).toEqual([[1126, 1, 1_760_001_600_000]]);
    // A cut carries its map and never a reason; a flight its six numbers.
    expect(out.cuts).toEqual([[2, 0]]);
    expect(out.flights).toEqual([[1, 0, 1000, 2000, 30, 120_000]]);
    expect(out.k.p).toEqual([0, -94604, 621, 563, 195]);
    // The target event and the unknown kind are gone; an aura change that only
    // moved the flags says nothing new in public, so it is gone too.
    expect(out.ev).toEqual([
      [300, "hp", 1100],
      [500, "cast", null],
    ]);
    for (const withheld of ['"target"', '"mood"', "player"]) expect(JSON.stringify(out)).not.toContain(withheld);
  });

  test("a death is published: the flags, the gauges at the corpse, and the Ghost aura and Resurrection Sickness", () => {
    const seg = traceSegmentFixture();
    const t0 = seg.t0;
    const sickness = [15007, 1, t0 + 640_000, 0x80];
    seg.ev = [
      [2000, "hp", 0],
      [2000, "dead", true],
      [2000, "target", { kind: "player", hpPct: 40 }],
      [4000, "hp", 1],
      [4000, "auras", [[8326, 1, 0, 0x80]]],
      [4000, "dead", false],
      [4000, "ghost", true],
      [6000, "hp", 600],
      [6000, "auras", [sickness]],
      [6000, "ghost", false],
    ];
    const out = projectTraceSegment(seg);
    expect(out.ev).toEqual([
      [2000, "hp", 0],
      [2000, "dead", true],
      [4000, "hp", 1],
      [4000, "auras", [[8326, 1, 0]]],
      [4000, "dead", false],
      [4000, "ghost", true],
      [6000, "hp", 600],
      [6000, "auras", [[15007, 1, t0 + 640_000]]],
      [6000, "ghost", false],
    ]);
    // A segment that opens down says so, gauges and all.
    const downAtStart = traceSegmentFixture();
    downAtStart.k.s = { ...downAtStart.k.s, hp: 1, ghost: true, auras: [[8326, 1, 0]] };
    expect(projectTraceSegment(downAtStart).k.s).toMatchObject({ hp: 1, hpMax: 1200, dead: false, ghost: true, auras: [[8326, 1, 0]] });
    expect(JSON.stringify(out)).not.toContain('"target"');
  });

  test("a segment published before deaths were public re-projects to itself", () => {
    // What the bucket already holds, immutable for a year: no `dead` or
    // `ghost` anywhere, and the gauges blanked over a down window. The
    // release's verifier re-projects every one of them.
    const old = {
      v: 1,
      run: "fixture-run-1",
      t0: 1_760_000_100_000,
      t1: 1_760_000_400_000,
      q: { p: 10, o: 1024 },
      k: {
        p: [0, -94604, 621, 563, 195],
        s: {
          hp: 1200, hpMax: 1200, pw: 900, pwMax: 1000, pwType: 0, level: 14, xp: 3200, xpMax: 9800,
          auras: [[1126, 1, 1_760_001_600_000]], combat: false, mounted: false, taxi: false, resting: false, cast: null,
        },
      },
      dt: [400],
      x: [26],
      y: [65],
      z: [1],
      o: [-1],
      cuts: [],
      flights: [],
      ev: [
        [2000, "hp", null],
        [2000, "hpMax", null],
        [6000, "hp", 600],
        [6000, "hpMax", 1200],
      ],
    } as unknown as TraceSegment;
    expect(projectTraceSegment(old)).toEqual(old);
  });

  test("is a fixed point on its own output, as publish-accept's re-projection requires", () => {
    const once = projectTraceSegment(traceSegmentFixture());
    expect(projectTraceSegment(once)).toEqual(once);
    const seg = traceSegmentFixture();
    seg.ev = [[2000, "hp", 0], [2000, "dead", true], [6000, "hp", 600], [6000, "dead", false]];
    const down = projectTraceSegment(seg);
    expect(projectTraceSegment(down)).toEqual(down);
  });

  test("the same allowlist reaches the position feed's tail and the index's", () => {
    const tail = traceSegmentFixture();
    const positions = projectPositions({
      positions: [
        {
          runId: "fixture-run-1", character: CHARACTER_NAME, model: "test/model", map: 0, x: 1, y: 2, ts: 1000,
          level: 3, xp: 4, money: 5, questsCompleted: 6, items: null, harnessVersion: "harness-0.5-1-gabc",
          trace: smuggle({ segMs: 300_000, recent: [1, 2, POISON.smuggled as unknown as number], tail }),
        },
      ],
    });
    expect(positions.positions[0]!.trace).toEqual({ segMs: 300_000, recent: [1, 2, 0], tail: projectTraceSegment(tail) });
    assertClean(JSON.stringify(positions));
    const idx = projectTraceIndex(smuggle<TraceIndexResponse>({ segMs: 300_000, segs: [[1, 2]], tail, now: 9 }));
    expect(keyPaths(idx).filter((k) => !k.startsWith("tail."))).toEqual(allow(["segMs", "segs", "tail", "now"]));
    expect(idx.tail).toEqual(projectTraceSegment(tail));
    assertClean(JSON.stringify(idx));
  });
});

describe("projectEpisodes", () => {
  test("emits exactly the allowlist", () => {
    const input: EpisodesResponse = smuggle<EpisodesResponse>({
      episodes: [
        smuggle<EpisodesResponse["episodes"][number]>({
          id: "e90",
          minutes: 90,
          idleMinutes: 10,
          noXpMinutes: null,
          toolCalls: 3000,
          objectiveAllowed: false,
          scored: true,
          summary: "ninety minutes",
          members: 1,
          overrides: 0,
          lapsed: 0,
          derived: 0,
        }),
      ],
      untiered: 0,
      now: 5000,
    });
    const out = projectEpisodes(input);
    expect(keyPaths(out)).toEqual(
      allow([
        "episodes",
        ...under("episodes[]", [
          "id",
          "minutes",
          "idleMinutes",
          "noXpMinutes",
          "toolCalls",
          "objectiveAllowed",
          "scored",
          "summary",
          "members",
          "overrides",
          "lapsed",
          "derived",
        ]),
        "untiered",
        "now",
      ]),
    );
    assertClean(JSON.stringify(out));
  });
});

describe("projectCampaigns", () => {
  test("emits exactly the allowlist; the pinned account, the objective's text and the registry host are withheld", () => {
    const square = smuggle({
      column: "codex-sol-61/base",
      runs: 4,
      counted: 4,
      reached: 3,
      live: 1,
      minutesToStop: smuggle({ min: 287, median: 301, max: 350 }),
      bestLevel: 10,
      costUsd: 1.25,
      mismatchedStart: 0,
      builds: ["harness-0.5-931"],
      runIds: ["fixture-run-1"],
      want: 1,
      settled: "done" as const,
      refused: null,
    });
    const input: CampaignsResponse = smuggle<CampaignsResponse>({
      now: 5000,
      campaigns: [
        smuggle({
          id: "race-probe",
          version: 1,
          key: "race-probe@1",
          hash: "sha256:0123456789abcdef",
          source: smuggle({ commit: "0123456789abcdef0123456789abcdef01234567", path: "runner/campaigns/race-probe@1.json", branch: ["master"] }),
          publishedAt: 1000,
          question: "q",
          note: "why",
          shape: smuggle({
            objective: POISON.objective,
            stopAtLevel: 10,
            episodeMs: 43_200_000,
            idleMs: 1_200_000,
            noXpMs: null,
            maxToolCalls: 24_000,
            wiki: true,
            wikiCoords: false,
            resume: true,
            maxAttemptsPerCell: 3,
          }),
          cells: [smuggle({ id: "orc-warrior", race: 2, class: 1, note: "n" })],
          arms: [smuggle({ id: "base", note: "n", image: "registry.lab.internal:5000/wb/runner:harness-0.5-931", command: null, args: ["--compact-window", "200k"] })],
          config: smuggle({
            enabled: true,
            account: "PROBE",
            assignments: [smuggle({ ref: "codex-sol-61", model: "gpt-6.1-sol", effort: null, compactWindow: null, harness: "codex", runsPerCell: 1 })],
          }),
          state: "running" as const,
          progress: smuggle({ want: 10, done: 4, attempted: 5, capped: 0, live: 1 }),
          columns: [smuggle({ key: "codex-sol-61/base", ref: "codex-sol-61", arm: "base", model: "gpt-6.1-sol", effort: null, compactWindow: "200k", harness: "codex" })],
          grid: [smuggle({ cell: "orc-warrior", squares: [square] })],
          comparison: [
            smuggle({
              ref: "codex-sol-61",
              arms: [
                smuggle({
                  arm: "base",
                  runs: 4,
                  reached: 3,
                  medianMinutesToStop: 301,
                  medianTurnsToStop: 900,
                  medianCostToStop: 0.4,
                  medianPromptTokensToStop: 1_000_000,
                  terminations: { "level-target": 3, "episode-limit": 1 },
                  builds: ["harness-0.5-931"],
                  costAsIfMetered: 0,
                }),
              ],
            }),
          ],
          costUsd: 1.25,
          newestRunId: "fixture-run-1",
          newestAt: 1000,
        }),
      ],
      refused: [smuggle({ key: "campaigns/nav-probe", reason: "nav-probe@1 is not published" })],
    });
    const out = projectCampaigns(input);
    expect(keyPaths(out)).toEqual(
      allow([
        "now",
        "campaigns",
        ...under("campaigns[]", [
          "id",
          "version",
          "key",
          "hash",
          "source",
          ...under("source", ["commit", "path", "branch"]),
          "publishedAt",
          "question",
          "note",
          "shape",
          ...under("shape", ["objective", "stopAtLevel", "episodeMs", "idleMs", "noXpMs", "maxToolCalls", "wiki", "wikiCoords", "resume", "maxAttemptsPerCell"]),
          "cells",
          ...under("cells[]", ["id", "race", "class", "note"]),
          "arms",
          ...under("arms[]", ["id", "note", "image", "command", "args"]),
          "config",
          ...under("config", ["enabled", "assignments", ...under("assignments[]", ["ref", "model", "effort", "compactWindow", "harness", "runsPerCell"])]),
          "state",
          "progress",
          ...under("progress", ["want", "done", "attempted", "capped", "live"]),
          "columns",
          ...under("columns[]", ["key", "ref", "arm", "model", "effort", "compactWindow", "harness"]),
          "grid",
          ...under("grid[]", [
            "cell",
            "squares",
            ...under("squares[]", [
              "column",
              "runs",
              "counted",
              "reached",
              "live",
              "minutesToStop",
              ...under("minutesToStop", ["min", "median", "max"]),
              "bestLevel",
              "costUsd",
              "mismatchedStart",
              "builds",
              "runIds",
              "want",
              "settled",
              "refused",
            ]),
          ]),
          "comparison",
          ...under("comparison[]", [
            "ref",
            "arms",
            ...under("arms[]", [
              "arm",
              "runs",
              "reached",
              "medianMinutesToStop",
              "medianTurnsToStop",
              "medianCostToStop",
              "medianPromptTokensToStop",
              "terminations",
              "terminations.level-target",
              "terminations.episode-limit",
              "builds",
              "costAsIfMetered",
            ]),
          ]),
          "costUsd",
          "newestRunId",
          "newestAt",
        ]),
        "refused",
        ...under("refused[]", ["key", "reason"]),
      ]),
    );
    assertClean(JSON.stringify(out));
    // The pinned account's name is the lab's naming scheme; gone, not blanked.
    expect(JSON.stringify(out)).not.toContain("PROBE");
    expect(out.campaigns[0]!.shape.objective).toBeNull();
    // The build is named; the registry it lives on is not.
    expect(out.campaigns[0]!.arms[0]!.image).toBe("wb/runner:harness-0.5-931");
    expect(JSON.stringify(out)).not.toContain("registry.lab.internal");
    // The version and the arm travel, which is what lets a public run row find its pane.
    expect(out.campaigns[0]!.key).toBe("race-probe@1");
    expect(out.refused).toEqual([{ key: "campaigns/nav-probe", reason: "nav-probe@1 is not published" }]);
  });
});

describe("projectModels", () => {
  test("emits exactly the allowlist; the roster path and error prose are withheld", () => {
    const input: ModelsResponse = smuggle<ModelsResponse>({
      models: [
        smuggle<ModelRowView>({
          name: "sonnet",
          model: "test/model",
          effort: "high",
          platform: "openrouter",
          harness: "wrathbench",
          billing: "paid",
          declaredTier: "t0",
          tier: "t1",
          earnedRung1: true,
          idle: "none",
          status: "active",
          eligible: ["e90", "e360"],
          perEpisode: {
            e90: smuggle({
              counted: 2,
              attempts: 3,
              extras: 0,
              otherSeries: 1,
              target: 3,
              bestLevel: 5,
              reachedL5: true,
              lastEnded: 2000,
              lastReason: "episode-limit",
              runIds: ["fixture-run-1"],
            }),
          },
          cooling: { until: 9000, rung: 2, reason: "rate-limited" },
          retired: { at: 9500, reason: "operator" },
          ladder: 2,
          schedulable: smuggle({ ok: false, why: "cooling until 9000", extras: false }),
          resolvedModels: ["some/model-served"],
          runs: [
            smuggle<ModelRunView>({
              runId: "fixture-run-1",
              episode: "e90",
              episodeOverride: false,
              harnessVersion: "harness-0.5-1-gabc",
              harnessSeries: "0.5",
              extra: false,
              race: 3,
              raceName: "Dwarf",
              class: 3,
              className: "Hunter",
              characterLabel: "Dwarf Hunter",
              resolvedModel: "some/model-served",
              startedAt: 1000,
              endedAt: 2000,
              durationMs: 1000,
              bestLevel: 5,
              terminationReason: "episode-limit",
              live: false,
              counted: true,
              cost: costViewFixture(),
            }),
          ],
          newestRunId: "fixture-run-1",
          lastError: smuggle({
            runId: "fixture-run-1",
            reason: "http-401",
            message: POISON.lastErrorMessage,
            at: 2000,
          }),
        }),
      ],
      roster: smuggle<ModelsResponse["roster"]>({
        path: POISON.rosterPath,
        shape: "roster",
        count: 2,
        excluded: [smuggle({ name: "probe-x", reason: "pinned job holds it" })],
      }),
      policy: smuggle<ModelsResponse["policy"]>({
        promoteAtLevel: 5,
        series: "0.5",
        paid: { maxConcurrent: 2 },
        tiers: {
          t0: { runsPerEpisode: { e90: 1, e360: 0 }, promotesTo: "t1", label: "one look" },
          t1: { runsPerEpisode: { e90: 3, e360: 1 }, promotesTo: "t2", label: "evidence" },
          t2: { runsPerEpisode: { e90: 5, e360: 3 }, promotesTo: null, label: "full" },
        },
        maxConcurrent: { "claude-code": 3, "claude-code:MAX20": 1 },
      }),
      ladderMs: [60_000, 300_000],
      harness: "all",
      now: 5000,
    });
    const MODEL_EPISODE_KEYS = [
      "counted",
      "attempts",
      "extras",
      "target",
      "bestLevel",
      // no `otherSeries`, `reachedL5`, `lastEnded`, `lastReason`, `runIds`: the roster table prints
      // the counts and the target, and the run list under it is `runs`.
    ];
    const MODEL_RUN_KEYS = [
      "runId",
      "episode",
      "episodeOverride",
      "characterLabel",
      "endedAt",
      "durationMs",
      "bestLevel",
      "terminationReason",
      "live",
      "counted",
      "cost",
      // the panel prints the provider's figure; the estimate is on the run's page
      ...under("cost", ["actual", ...under("actual", COST_FIGURE_KEYS)]),
    ];
    const tierKeys = (t: string): string[] => [
      `policy.tiers.${t}`,
      `policy.tiers.${t}.runsPerEpisode`,
      `policy.tiers.${t}.runsPerEpisode.e90`,
      `policy.tiers.${t}.runsPerEpisode.e360`,
      `policy.tiers.${t}.promotesTo`,
      `policy.tiers.${t}.label`,
    ];
    const out = projectModels(input);
    expect(keyPaths(out)).toEqual(
      allow([
        "models",
        ...under("models[]", [
          "name",
          "model",
          "effort",
          "platform",
          "harness",
          "billing",
          "declaredTier",
          "tier",
          "earnedRung1",
          "idle",
          "status",
          "eligible",
          "perEpisode",
          "perEpisode.e90",
          ...under("perEpisode.e90", MODEL_EPISODE_KEYS),
          "cooling",
          ...under("cooling", ["until", "rung", "reason"]),
          "retired",
          ...under("retired", ["at", "reason"]),
          "ladder",
          "schedulable",
          ...under("schedulable", ["ok", "why", "extras"]),
          "resolvedModels",
          "runs",
          ...under("runs[]", MODEL_RUN_KEYS),
          "newestRunId",
          "lastError",
          ...under("lastError", ["runId", "reason", "message", "at"]),
        ]),
        "roster",
        ...under("roster", ["path", "shape", "count", "excluded"]),
        ...under("roster.excluded[]", ["name", "reason"]),
        "policy",
        "policy.promoteAtLevel",
        "policy.series",
        "policy.paid",
        "policy.paid.maxConcurrent",
        "policy.tiers",
        ...tierKeys("t0"),
        ...tierKeys("t1"),
        ...tierKeys("t2"),
        "policy.maxConcurrent",
        "policy.maxConcurrent.claude-code",
        "policy.maxConcurrent.claude-code:MAX20",
        "ladderMs",
        "harness",
        "now",
      ]),
    );
    assertClean(JSON.stringify(out));
    const row = out.models[0]!;
    expect(row.lastError!.reason).toBe("http-401");
    expect(row.lastError!.message).toBe("");
    expect(out.roster.path).toBeNull();
  });
});

describe("projectFleet", () => {
  test("emits exactly the allowlist; pids and smoke tails are withheld", () => {
    const input: FleetResponse = smuggle<FleetResponse>({
      present: true,
      server: smuggle<FleetServerView>({
        phase: "verifying",
        since: 1,
        build: "harness-0.5-2",
        detail: "gate smoke x (1 of 2)",
        updatedAt: 2,
      }),
      fleetPid: POISON_PID,
      startedAt: 1,
      heartbeatAt: 2,
      containerized: true,
      stamp: "20260825",
      configLoadedAt: 3,
      configRejected: smuggle({ since: 9, error: POISON.configRejectedError }),
      preflight: smuggle({
        at: 5,
        serverIdentity: "build:x@1",
        build: "harness-0.5-2",
        ok: false,
        skipped: false,
        results: [smuggle({ script: "infra/smoke/a.ts", ok: false, ms: 20_000, tail: POISON.preflightTail })],
      }),
      jobs: [
        smuggle<FleetJobView>({
          name: "job-a",
          ref: "a",
          episode: "e90",
          account: "RUNNER",
          accountClass: "pool",
          source: "policy",
          attempt: 2,
          resuming: "old-run-1",
          models: ["test/model"],
          runId: "fixture-run-1",
          model: "test/model",
          pid: POISON_PID,
          spawnedAt: 1,
          exitCode: null,
          draining: false,
          alive: true,
        }),
      ],
      accounts: [smuggle<FleetAccountView>({ account: "RUNNER", class: "pool", job: "job-a" })],
      paused: [
        smuggle({
          runId: "p-1",
          model: "test/model",
          account: "RUNNER2",
          reason: "rate-limited",
          since: 1,
          pauseCount: 2,
          resumeAfter: 9000,
          elapsedMs: 2,
          budgetMs: 3,
          why: "resuming after 17:00",
        }),
      ],
      ended: [smuggle({ runId: "e-1", model: "m", ref: "r", detail: "ended by the supervisor" })],
      session: smuggle({ finished: 12, ok: 11, retried: 3 }),
      outstanding: smuggle({
        lower: 1,
        upper: 4,
        etaLowerMs: 60_000,
        etaUpperMs: 240_000,
        breakdown: [
          smuggle({ group: "pool", concurrency: 2, lowerRuns: 1, upperRuns: 4, lowerMinutes: 90, upperMinutes: 360 }),
        ],
      }),
      now: 5000,
    });
    const out = projectFleet(input);
    expect(keyPaths(out)).toEqual(
      allow([
        "present",
        "server",
        ...under("server", ["phase", "since", "build", "detail", "updatedAt"]),
        "startedAt",
        "heartbeatAt",
        "containerized",
        "stamp",
        "configLoadedAt",
        "configRejected",
        "configRejected.since",
        "configRejected.error",
        "preflight",
        ...under("preflight", ["at", "serverIdentity", "build", "ok", "skipped", "results"]),
        ...under("preflight.results[]", ["script", "ok", "ms", "tail"]),
        "jobs",
        ...under("jobs[]", [
          "name",
          "ref",
          "episode",
          "account",
          "accountClass",
          "attempt",
          "resuming",
          "models",
          "runId",
          "model",
          "draining",
          "alive",
        ]),
        "accounts",
        ...under("accounts[]", ["account", "class", "job"]),
        "paused",
        ...under("paused[]", [
          "runId",
          "model",
          "account",
          "reason",
          "since",
          "pauseCount",
          "resumeAfter",
          "elapsedMs",
          "budgetMs",
          "why",
        ]),
        "ended",
        ...under("ended[]", ["runId", "model", "ref", "detail"]),
        "session",
        ...under("session", ["finished", "ok", "retried"]),
        "outstanding",
        ...under("outstanding", ["lower", "upper", "etaLowerMs", "etaUpperMs", "breakdown"]),
        ...under("outstanding.breakdown[]", [
          "group",
          "concurrency",
          "lowerRuns",
          "upperRuns",
          "lowerMinutes",
          "upperMinutes",
        ]),
        "now",
      ]),
    );
    assertClean(JSON.stringify(out));
    expect(out.preflight!.results[0]!.tail).toBe("");
    // A rejection error is a raw exception message (paths, config values); only
    // the fact and the time may survive.
    expect(out.configRejected!.error).toBe("");
  });
});

describe("projectInfo", () => {
  test("emits exactly the allowlist and forces publicMode", () => {
    const input: ApiInfoResponse = smuggle<ApiInfoResponse>({
      service: "wrathbench-viewer",
      publicMode: false,
      dashboard: true,
      dashboardBuild: "app-abc123.js",
      worldserver: smuggle({ build: "harness-0.5-2", startedAtMs: 12_345 }),
      harnessSeries: [smuggle({ series: "0.5", runs: 3 })],
      now: 5000,
    });
    const out = projectInfo(input);
    expect(keyPaths(out)).toEqual(
      allow([
        "service",
        "publicMode",
        "dashboard",
        "dashboardBuild",
        "worldserver",
        "worldserver.build",
        "worldserver.startedAtMs",
        "harnessSeries",
        ...under("harnessSeries[]", ["series", "runs"]),
        "now",
      ]),
    );
    expect(out.publicMode).toBe(true);
    // The private dashboard's build id must not ride along: the shell's
    // stale-build banner would compare public tabs against the lab's bundle.
    expect(out.dashboardBuild).toBeNull();
    expect(JSON.stringify(out)).not.toContain("app-abc123.js");
    assertClean(JSON.stringify(out));
  });
});

/* ------------------------------------------------------------- entries --- */

describe("projectEntries", () => {
  /** A raw `events_served` batch as `EntrySummary` never carries it — planted to prove the allowlist drops it. */
  const batch = [
    {
      opcode: "SMSG_QUESTGIVER_QUEST_DETAILS",
      seq: 1,
      data: { questId: 7, title: SURVIVES.questTitle, details: POISON.questDetails, objectives: POISON.questObjectives },
    },
  ];

  test("every listed type keeps its fields, unlisted types keep the skeleton, smuggled keys never pass", () => {
    const input = {
      from: 0,
      total: 6,
      entries: [
        smuggle({ i: 0, t: "meta", ts: 1, start: 0, end: 10, runId: "r", harnessVersion: "h", startedAt: 1,
          config: { apiBase: POISON.apiBase, objective: POISON.objective }, comparability: { wikiBundle: { source: POISON.wikiSource } } }),
        smuggle({ i: 1, t: "driver", ts: 2, start: 11, end: 20, driver: "claude-code", harness: "wrathbench", bin: POISON.driverBin, cwd: POISON.claudeCwd, systemPromptChars: 12 }),
        smuggle({ i: 2, t: "claude_system", ts: 3, start: 21, end: 30, turn: 1, type: "system", subtype: "init", cwd: POISON.claudeCwd, memory_paths: [POISON.claudeCwd], estimated_tokens: 5 }),
        smuggle({ i: 3, t: "events_served", ts: 4, start: 31, end: 40, via: "tool", count: 1, opcodes: ["SMSG_QUESTGIVER_QUEST_DETAILS×1"], events: batch }),
        smuggle({ i: 4, t: "pause", ts: 5, start: 41, end: 50, reason: "rate-limit", detail: POISON.pauseDetail, episodeElapsedMs: 9 }),
        smuggle({ i: 5, t: "state", ts: 6, start: 51, end: 60, turn: 2, level: 2, zone: 12, area: 9, items: [smuggle({ name: SURVIVES.itemName, count: 2, equipped: false, itemId: 2589, quality: 1, slot: 24, bag: 255 })] }),
        smuggle({ i: 6, t: "termination", ts: 7, start: 61, end: 70, reason: "episode-limit", detail: SURVIVES.terminationDetail }),
        smuggle({ i: 7, t: "some_future_type", ts: 8, start: 71, end: 80, turn: 3, payload: POISON.smuggled }),
        smuggle({ i: 8, t: "episodic", ts: 9, start: 81, end: 90, turn: 3, level: 2, zone: SURVIVES.zoneName, text: SURVIVES.statusText }),
        smuggle({ i: 9, t: "move", ts: 10, start: 91, end: 100, moveId: 4, map: 0, x: 1, y: 2, z: 3, target: SURVIVES.npcName, status: "arrived" }),
      ],
    };
    const out = projectEntries(input as never);
    const text = JSON.stringify(out);
    assertClean(text);
    // Names, the model's episodic text and the termination detail all survive.
    for (const v of [SURVIVES.itemName, SURVIVES.terminationDetail, SURVIVES.zoneName, SURVIVES.statusText, SURVIVES.npcName]) {
      expect(text).toContain(v);
    }
    expect(keyPaths(out.entries[0])).toEqual(allow(["i", "t", "ts", "runId", "harnessVersion", "startedAt"]));
    expect(keyPaths(out.entries[1])).toEqual(allow(["i", "t", "ts", "driver", "harness", "systemPromptChars"]));
    expect(keyPaths(out.entries[2])).toEqual(allow(["i", "t", "ts", "turn", "type", "subtype", "estimated_tokens"]));
    // The batch itself never ships; the tally does.
    expect(keyPaths(out.entries[3])).toEqual(allow(["i", "t", "ts", "via", "count", "opcodes"]));
    expect(keyPaths(out.entries[4])).toEqual(allow(["i", "t", "ts", "reason", "episodeElapsedMs"]));
    expect(out.entries[5]).toMatchObject({
      level: 2,
      zone: 12,
      items: [{ name: SURVIVES.itemName, count: 2, equipped: false, itemId: 2589, quality: 1, slot: 24, bag: 255 }],
    });
    expect(keyPaths(out.entries[7])).toEqual(allow(["i", "t", "ts", "turn"]));
    expect(out.from).toBe(0);
    expect(out.total).toBe(6);
  });

  test("a restamped comparability tuple inside an entry crosses the run row's allowlist", () => {
    const before = comparabilityFixture();
    const input = {
      from: 0,
      total: 2,
      entries: [
        smuggle({
          i: 0, t: "harness", ts: 1, start: 0, end: 10,
          kind: "comparability_restamped", leashChanged: false,
          before, after: comparabilityFixture(),
        }),
        // A restamp on a run that had no tuple to compare against: `before` is
        // null on the way in and must stay null on the way out.
        { i: 1, t: "harness", ts: 2, start: 11, end: 20,
          kind: "comparability_restamped", leashChanged: true, before: null, after: comparabilityFixture() },
      ],
    };
    const out = projectEntries(input as never);
    assertClean(JSON.stringify(out));
    expect(keyPaths(out.entries[0])).toEqual(
      allow([
        "i", "t", "ts", "kind", "leashChanged",
        "before", ...under("before", COMPARABILITY_KEYS),
        "after", ...under("after", COMPARABILITY_KEYS),
      ]),
    );
    // Everything the run row keeps is still here, field for field.
    expect(out.entries[0]).toMatchObject({
      before: { harnessVersion: before.harnessVersion, effort: "high", objective: true, wikiCoords: true,
        budget: { maxToolCalls: 3000, episodeMs: 5_400_000 }, serverBuild: { build: "harness-0.5-1-gdef" },
        episode: "e90", resolvedModel: "some/model-served" },
    });
    expect((out.entries[1] as unknown as { before: unknown }).before).toBeNull();
  });

  // A CLI compaction ships its numbers; the summary the CLI wrote (model text
  // about the run, in a field named apart from `text` for this reason), its
  // timing and what it retained stay private, as does the ask's arithmetic.
  test("a CLI compaction ships its token counts only; the summary stays private", () => {
    const summary = "This session is being continued from a previous conversation. PRIVATE-SUMMARY";
    const input = {
      from: 0,
      total: 2,
      entries: [
        { i: 0, t: "harness", ts: 1, start: 0, end: 10, turn: 36, kind: "compaction", trigger: null, preTokens: 447_305,
          postTokens: 77_759, durationMs: 118_938, at: 1_791_801_361_085, summary, summaryEncrypted: true,
          encryptedChars: 40_000, retainedTurns: [28, 29], window: 1 },
        { i: 1, t: "harness", ts: 2, start: 11, end: 20, turn: 35, kind: "compaction_ask", ask: "before",
          context: 436_000, threshold: 450_000, growth: 14_000 },
      ],
    };
    const out = projectEntries(input as never);
    expect(JSON.stringify(out)).not.toContain("PRIVATE-SUMMARY");
    expect(keyPaths(out.entries[0])).toEqual(
      allow(["i", "t", "ts", "turn", "kind", "trigger", "preTokens", "postTokens", "durationMs"]),
    );
    expect(out.entries[0]).toMatchObject({ preTokens: 447_305, postTokens: 77_759, durationMs: 118_938 });
    expect(keyPaths(out.entries[1])).toEqual(allow(["i", "t", "ts", "turn", "kind"]));
  });

  // The feed times a call from its writer's dispatch stamp; without it here the
  // public feed would fall back to guessing the writer from the record's shape.
  test("a tool call keeps its dispatch stamp, its call index and nothing smuggled", () => {
    const input = {
      from: 0,
      total: 1,
      entries: [
        smuggle({ i: 0, t: "tool_call", ts: 900, start: 0, end: 1, turn: 1, call: 7, name: "run_snippet",
          args: { code: "1" }, dispatchTs: 400 }),
      ],
    };
    const out = projectEntries(input as never);
    assertClean(JSON.stringify(out));
    expect(keyPaths(out.entries[0])).toEqual(
      allow(["i", "t", "ts", "turn", "call", "name", "args", "args.code", "dispatchTs"]),
    );
    expect(out.entries[0]).toMatchObject({ call: 7, dispatchTs: 400 });
  });

  test("tool results cross the redactor; the reference tool's text goes whole; model text passes", () => {
    const input = {
      from: 3,
      total: 9,
      entries: [
        { i: 3, t: "tool_result", ts: 1, start: 0, end: 1, turn: 1, call: 2, name: "recent_events",
          text: `#5 SMSG_QUESTGIVER_QUEST_LIST {"guid":"1","greeting":"${POISON.questGreeting}","quests":[{"questId":7,"title":"${SURVIVES.questTitle}"}]}` },
        { i: 4, t: "tool_result", ts: 2, start: 2, end: 3, turn: 1, call: 3, name: "search_reference", text: POISON.wikiText },
        { i: 5, t: "snippet_result", ts: 3, start: 4, end: 5, turn: 1, call: 4, name: "run_snippet", isError: false,
          text: `ok (12ms)\n=> {"mailId":1,"subject":"${SURVIVES.questTitle}","body":"${POISON.mailBody}"}` },
        { i: 6, t: "response", ts: 4, start: 6, end: 7, turn: 1, text: `I will talk to ${SURVIVES.npcName} and cast ${SURVIVES.spellName}`, tools: ["run_snippet"] },
        { i: 7, t: "snippet", ts: 5, start: 8, end: 9, turn: 1, call: 5, code: `await sdk.talk("${SURVIVES.npcName}")` },
      ],
    };
    const out = projectEntries(input as never);
    const text = JSON.stringify(out);
    assertClean(text);
    for (const v of [SURVIVES.questTitle, SURVIVES.npcName, SURVIVES.spellName]) expect(text).toContain(v);
    expect(out.entries[1]).toMatchObject({ name: "search_reference", text: "[redacted]" });
    expect((out.entries[2] as { text: string }).text).toContain('"body":"[redacted]"');
  });

  /*
   * A response record carries the provider's raw usage object (`usageRaw`)
   * beside the normalised `usage`. It is for the operator reconciling a bill,
   * so it stays private: the summary rebuilds `usage` from the normalised
   * block and copies nothing else, and the allowlist would drop it anyway.
   * Driven from the raw record through `summarize`, the path the snapshot
   * renderer takes (`/entries`, then `projectEntries`).
   */
  test("a response's raw provider usage stays out of the summary and out of the public entry", () => {
    const record = {
      t: "response",
      ts: 4,
      turn: 1,
      message: { role: "assistant", content: "on my way" },
      usage: { prompt_tokens: 1200, completion_tokens: 34, cached_tokens: 1024, cost: 0.002 },
      provider: "SomeBackend",
    };
    const usageRaw = {
      prompt_tokens: 1200,
      completion_tokens: 34,
      prompt_cache_hit_tokens: 1024,
      prompt_cache_miss_tokens: 176,
      cost: 0.002,
      cost_details: { upstream_inference_prompt_cost: 0.0019 },
    };
    const withRaw = summarize({ ...record, usageRaw }, 6, 6, 7);
    const plain = summarize(record, 6, 6, 7);
    expect(withRaw).not.toHaveProperty("usageRaw");
    expect(withRaw).toEqual(plain);

    const out = projectEntry(withRaw);
    expect(out).toEqual(projectEntry(plain));
    expect(keyPaths(out)).toEqual(
      allow(["i", "t", "ts", "turn", "text", "tools"]),
    );
    const text = JSON.stringify(out);
    for (const k of ["usageRaw", "prompt_cache_hit_tokens", "prompt_cache_miss_tokens", "cost_details"]) expect(text).not.toContain(k);
  });
});

describe("the action log in a public window", () => {
  test("an actions record ships its notes field by field: names and ids stay, smuggled and secret keys go", () => {
    const record = {
      t: "actions",
      ts: 50,
      turn: 4,
      callTs: 40,
      routine: true,
      actions: [
        smuggle({
          ts: 41,
          action: "cast_spell",
          args: smuggle({ spellId: 635, targetGuid: "9", token: POISON.smuggled, nested: { x: POISON.objective } }),
          status: 409,
          ms: 3,
          error: "spell_not_known",
          hint: "the spellbook has no spell 635",
          names: smuggle({ spell: "Holy Light", target: SURVIVES.targetName }),
          count: 2,
          lastTs: 45,
        }),
        { ts: 46, action: "quest_query", args: { questId: 7 }, status: 200, ms: 1, auto: true, names: { quest: SURVIVES.questTitle } },
        { action: "no_ts_is_dropped", status: 200 },
        { ts: 47, action: "stop", status: 0, ms: 9, error: `transport: TypeError: fetch failed ${POISON.apiBase}` },
      ],
      dropped: { say: 10, poison: POISON.smuggled },
      [POISON.smuggled]: 1,
    };
    const out = projectEntry(summarize(record, 3, 0, 10));
    const text = JSON.stringify(out);
    assertClean(text);
    expect(text).toContain(SURVIVES.targetName);
    expect(text).toContain(SURVIVES.questTitle);
    expect(keyPaths(out)).toEqual(
      allow([
        "i", "t", "ts", "turn", "callTs", "routine", "dropped", "dropped.say", "actions",
        ...under("actions[]", ["ts", "action", "args", "status", "ms", "error", "hint", "names", "count", "lastTs", "auto"]),
        ...under("actions[].args", ["spellId", "targetGuid", "questId"]),
        ...under("actions[].names", ["spell", "target", "quest"]),
      ]),
    );
    const notes = out["actions"] as Record<string, unknown>[];
    expect(notes.length).toBe(3);
    // A module code passes; a runtime failure string becomes a fixed token.
    expect(notes[0]!["error"]).toBe("spell_not_known");
    expect(notes[2]!["error"]).toBe("transport");
  });
});

/* ------------------------------------------------------ what is published --- */

describe("a snippet call's code is published once", () => {
  const entry = (over: Record<string, unknown>): never => ({ ts: 1, start: 0, end: 1, ...over }) as never;
  const window = (entries: unknown[]): Record<string, unknown>[] =>
    projectEntries({ from: 0, total: entries.length, entries: entries as never }).entries as unknown as Record<string, unknown>[];

  test("the call keeps its name, stamps and dispatch time, and loses the copy of the code the snippet record beside it says", () => {
    const out = window([
      entry({ i: 0, t: "tool_call", turn: 3, call: 1, name: "run_snippet", args: { code: "return 1" }, dispatchTs: 40 }),
      entry({ i: 1, t: "snippet", turn: 3, call: 1, code: "return 1" }),
    ]);
    expect(out[0]).toEqual({ i: 0, t: "tool_call", ts: 1, turn: 3, call: 1, name: "run_snippet", dispatchTs: 40 });
    expect(out[1]!["code"]).toBe("return 1");
  });

  test("a call whose snippet is not next, differs, or belongs to another turn or call keeps its code", () => {
    const call = { i: 0, t: "tool_call", turn: 3, name: "run_snippet", args: { code: "return 1" } };
    // No snippet after it (the window ends, or the next record is something else).
    expect(window([entry(call)])[0]!["args"]).toEqual({ code: "return 1" });
    expect(window([entry(call), entry({ i: 1, t: "state", level: 1 })])[0]!["args"]).toEqual({ code: "return 1" });
    // A snippet that says something else.
    expect(window([entry(call), entry({ i: 1, t: "snippet", turn: 3, code: "return 2" })])[0]!["args"]).toEqual({ code: "return 1" });
    // The dashboard's own pairing rule: a turn or call index that disagrees is no pair.
    expect(window([entry(call), entry({ i: 1, t: "snippet", turn: 4, code: "return 1" })])[0]!["args"]).toEqual({ code: "return 1" });
    expect(window([entry({ ...call, call: 1 }), entry({ i: 1, t: "snippet", turn: 3, call: 2, code: "return 1" })])[0]!["args"]).toEqual({ code: "return 1" });
  });

  test("a call's summary clip of the snippet's code is the same copy: dropped when the clip is of that code, kept when it is not", () => {
    const code = "x".repeat(2500);
    const clip = `${code.slice(0, 2000)}\n… 500 more characters`;
    const call = { i: 0, t: "tool_call", turn: 3, name: "run_snippet", clipped: true };
    const kept = window([entry({ ...call, args: { code: clip } }), entry({ i: 1, t: "snippet", turn: 3, code })]);
    expect(kept[0]!["args"]).toBeUndefined();
    expect(kept[0]!["clipped"]).toBe(true);
    // A clip of other code, or with the wrong count, is not this snippet's.
    const other = window([entry({ ...call, args: { code: clip } }), entry({ i: 1, t: "snippet", turn: 3, code: "y".repeat(2500) })]);
    expect(other[0]!["args"]).toEqual({ code: clip });
    const miscount = window([entry({ ...call, args: { code: clip } }), entry({ i: 1, t: "snippet", turn: 3, code: code + "z" })]);
    expect(miscount[0]!["args"]).toEqual({ code: clip });
  });

  test("a call's other arguments still ship, and a tool with no snippet is untouched", () => {
    const out = window([
      entry({ i: 0, t: "tool_call", turn: 3, name: "run_snippet", args: { code: "x", timeoutMs: 5 } }),
      entry({ i: 1, t: "snippet", turn: 3, code: "x" }),
      entry({ i: 2, t: "tool_call", turn: 4, name: "edit_scratchpad", args: { old: "a", new: "b" } }),
      entry({ i: 3, t: "tool_result", turn: 4, name: "edit_scratchpad", text: "ok" }),
    ]);
    expect(out[0]!["args"]).toEqual({ timeoutMs: 5 });
    expect(out[2]!["args"]).toEqual({ old: "a", new: "b" });
  });

  test("the published window is a fixed point of its own projection", () => {
    const once = projectEntries({
      from: 0,
      total: 2,
      entries: [
        entry({ i: 0, t: "tool_call", turn: 3, name: "run_snippet", args: { code: "return 1" } }),
        entry({ i: 1, t: "snippet", turn: 3, code: "return 1" }),
      ] as never,
    });
    expect(projectEntries(once)).toEqual(once);
  });

  test("the raw line's byte range, a request's and a reply's bookkeeping and an events batch's tallies are not published", () => {
    const out = window([
      entry({ i: 0, t: "request", turn: 1, adapter: "openai", messageCount: 4, systemChars: 90, promptChars: 1200, usage: { prompt: 9 } }),
      entry({ i: 1, t: "response", turn: 1, text: "hi", tools: ["run_snippet"], outChars: 2, usage: { completion: 3, cost: 0.1 } }),
      entry({ i: 2, t: "events_served", via: "tool", count: 2, opcodes: ["SMSG_X×2"], ambient: 5, moreOpcodes: 1, folded: 3 }),
    ]);
    expect(Object.keys(out[0]!).sort()).toEqual(["i", "messageCount", "promptChars", "t", "ts", "turn"]);
    expect(Object.keys(out[1]!).sort()).toEqual(["i", "t", "text", "tools", "ts", "turn"]);
    expect(Object.keys(out[2]!).sort()).toEqual(["count", "i", "moreOpcodes", "opcodes", "t", "ts", "via"]);
  });
});

describe("no public page reads what the projection leaves out", () => {
  // Fields whose names appear nowhere in the dashboard's source as a property
  // read, at the audit (docs/PUBLIC-DASHBOARD.md, "What is published"). A page
  // that starts to read one has to put it back in the projection first, and
  // this fails until it does. Names that other objects also carry are not
  // listed: a name scan cannot tell them apart, and the types
  // (`PublicRunListRow`, `ChartSample`) carry those.
  const LEFT_OUT = [
    "raceName", "className", "outChars", "systemChars", "adapter", "ambient", "folded",
    "reachedL5", "lastEnded", "lastReason", "otherSeries", "mtime", "firstTs",
  ];

  function sources(dir: string): string[] {
    const out: string[] = [];
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) out.push(...sources(path));
      else if (/\.(ts|tsx)$/.test(name) && !/\.test\./.test(name)) out.push(path);
    }
    return out;
  }

  test("the dashboard's source does not read them", () => {
    const text = sources(join(import.meta.dir, "../../dashboard/src")).map((f) => [f, readFileSync(f, "utf8")] as const);
    const reads: string[] = [];
    for (const key of LEFT_OUT) {
      const read = new RegExp(`(\\.\\??${key}\\b|\\b${key}\\??:|\\["${key}"\\]|[{,]\\s*${key}\\s*[,}=])`);
      for (const [f, t] of text) if (read.test(t)) reads.push(`${key} in ${f}`);
    }
    expect(reads).toEqual([]);
  });
});
