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
import type {
  ApiInfoResponse,
  CampaignsResponse,
  ComparabilityView,
  CostFigure,
  CostView,
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
  projectTrack,
} from "../viewer/public-projection";

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
    items: [smuggle({ name: SURVIVES.itemName, count: 1, equipped: true })],
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
        effort: "high",
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
  "runId",
  "model",
  "driver",
  "harness",
  "shakeout",
  "objective",
  "campaign",
  "cell",
  "extra",
  "character",
  "race",
  "raceName",
  "class",
  "className",
  "characterLabel",
  "platform",
  "resolvedModel",
  "cliVersion",
  "apiBase",
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
  "mtime",
  "bytes",
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
const COST_FIGURE_KEYS = [
  "usd",
  "basis",
  "asIfMetered",
  "breakdown",
  ...under("breakdown", ["input", "output", "cacheRead", "cacheWrite"]),
  "priceId",
  "asOf",
  "note",
];
const COST_VIEW_KEYS = [
  ...COST_FIGURE_KEYS,
  "actual",
  ...under("actual", COST_FIGURE_KEYS),
  "expected",
  ...under("expected", COST_FIGURE_KEYS),
];
const RUN_LIST_ROW_KEYS = [
  ...RUN_ROW_KEYS,
  "tokens",
  ...under("tokens", TOKENS_KEYS),
  "tps",
  ...under("tps", TPS_KEYS),
  "cost",
  ...under("cost", COST_VIEW_KEYS),
  "firstTs",
  "lastTs",
  "playtimeMs",
  "modelResponses",
  // no `snapshot`: only the renderer stamps it, after projection
];
const STATE_KEYS = ["ts", "level", "xp", "map", "x", "y", "z", "eventCount", "lastSeq", "turn",
  // The player frame's numbers (item 104): public on every surface that
  // carries a state sample, as they are on the positions feed.
  "health", "maxHealth", "power", "maxPower", "powerType", "nextLevelXp"];
const RESULT_RUN_KEYS = [
  "runId",
  "model",
  "resolvedModel",
  "cliVersion",
  "platform",
  "harnessVersion",
  "harnessSeries",
  "extra",
  "race",
  "raceName",
  "class",
  "className",
  "characterLabel",
  "campaign",
  "cell",
  "effort",
  "harness",
  "promptHash",
  "serverBuild",
  "wikiCoords",
  "wiki",
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
  "tokens",
  ...under("tokens", TOKENS_KEYS),
  "actualCost",
  ...under("actualCost", COST_FIGURE_KEYS),
  "expectedCost",
  ...under("expectedCost", COST_FIGURE_KEYS),
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

describe("projectRuns", () => {
  test("emits exactly the allowlist and none of the poisoned values", () => {
    const input: RunsResponse = smuggle<RunsResponse>({ runs: [runListRowFixture()] });
    const out = projectRuns(input);
    expect(keyPaths(out)).toEqual(allow(["runs", ...under("runs[]", RUN_LIST_ROW_KEYS)]));
    assertClean(JSON.stringify(out));
  });

  test("withholds by value, not by renaming: the fields read null", () => {
    const row = projectRuns({ runs: [runListRowFixture()] }).runs[0]!;
    expect(row.items).toEqual([{ name: SURVIVES.itemName, count: 1, equipped: true }]);
    expect(row.objective).toBeNull();
    expect(row.apiBase).toBeNull();
    expect(row.terminationDetail).toBe(SURVIVES.terminationDetail);
    // The paused signal survives as a fixed token, never as the free text.
    expect(row.pauseReason).toBe("paused");
    // What the label layer needs survives — and so does the name itself.
    expect(row.character).toBe(CHARACTER_NAME);
    expect(row.characterLabel).toBe("Dwarf Hunter");
    expect(row.raceName).toBe("Dwarf");
    expect(row.terminationReason).toBe("episode-limit");
  });

  test("a run that never paused stays null: the token marks paused runs only", () => {
    const input = { runs: [{ ...runListRowFixture(), pauseReason: null }] };
    expect(projectRuns(input).runs[0]!.pauseReason).toBeNull();
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

  test("emits exactly the allowlist and none of the poisoned values", () => {
    const input: RunDetailResponse = smuggle<RunDetailResponse>({
      run: runRowFixture(),
      states: [
        smuggle({ ts: 1000, level: 1, xp: 0, map: 0, x: -6240, y: 380, z: 385, eventCount: 12, lastSeq: 99, turn: 1 }),
      ],
      total: 3,
      tokens: tokensFixture(),
      cost: costViewFixture(),
      playtimeMs: 1000,
      achievements: { earned: 2, points: 20, ids: [6, 12] },
      taxi: { flights: 1 },
      tps: { overall: 12.5, recent: 20, replies: 4, recentReplies: 2 },
      reflections: [smuggle({ fromTurn: 5, toTurn: 9 }), smuggle({ fromTurn: 12, toTurn: null })],
    });
    const out = projectRunDetail(input);
    expect(keyPaths(out)).toEqual(
      allow([
        "run",
        ...under("run", RUN_ROW_KEYS),
        "states",
        ...under("states[]", STATE_KEYS),
        "total",
        "tokens",
        ...under("tokens", TOKENS_KEYS),
        "cost",
        ...under("cost", COST_VIEW_KEYS),
        "playtimeMs",
        "achievements",
        ...under("achievements", ["earned", "points", "ids"]),
        "taxi",
        "taxi.flights",
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
    });
    const out = projectRunDetail(input);
    expect(out.spells).toBeNull();
    expect(out.talents).toBeNull();
    expect(out.trades).toBeNull();
  });
});

describe("projectResults", () => {
  test("emits exactly the allowlist and none of the poisoned values", () => {
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
          items: [smuggle({ name: SURVIVES.itemName, count: 1, equipped: false })],
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
          "harnessVersion",
          "health", "maxHealth", "power", "maxPower", "powerType", "nextLevelXp",
          "class",
          "move",
          "status",
          ...under("status", ["turn", "level", "zone", "text", "ts"]),
          "reflecting",
        ]),
        ...under("positions[].move", ["ts", "map", "x", "y", "z", "target", "status"]),
      ]),
    );
    assertClean(JSON.stringify(out));
    expect(out.positions[0]!.character).toBe(CHARACTER_NAME);
    expect(out.positions[0]!.items).toEqual([{ name: SURVIVES.itemName, count: 1, equipped: false }]);
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
    expect(out.positions[0]!.move).toEqual({ ts: 1200, map: 0, x: -6200, y: 400, z: 380, target: SURVIVES.targetName, status: null });
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
        }),
      ],
      moves: [
        smuggle({ ts: 1200, map: 0, x: -6200, y: 400, z: 380, target: SURVIVES.targetName, status: "arrived" }),
      ],
      // The character's neighbours (item 119): run ids and two counters, each
      // already public on every runs row, and nothing smuggled beside them.
      character: smuggle({ characterId: "a1", attempt: 2, attempts: 3, previous: "a1", next: "a3" }),
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
        ]),
        "moves",
        ...under("moves[]", ["ts", "map", "x", "y", "z", "target", "status"]),
        "character",
        ...under("character", ["characterId", "attempt", "attempts", "previous", "next"]),
      ]),
    );
    assertClean(JSON.stringify(out));
    expect(out.characterName).toBe(CHARACTER_NAME);
    expect(out.moves![0]!.target).toBe(SURVIVES.targetName);
    expect(out.points[0]).toMatchObject({ health: 140, maxHealth: 220, powerType: 3, nextLevelXp: 2100 });
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
  test("emits exactly the allowlist; the config path is withheld", () => {
    const input: CampaignsResponse = smuggle<CampaignsResponse>({
      campaigns: [
        smuggle({
          campaign: "sweep-1",
          config: smuggle({
            enabled: true,
            runsPerCell: 2,
            cells: ["cell-a"],
            models: 3,
            complete: false,
            account: "PROBE",
          }),
          runs: 4,
          live: 1,
          models: ["test/model"],
          cells: [smuggle({ cell: "cell-a", declared: true, runs: 4, models: ["test/model"], bestLevel: 5 })],
          newestRunId: "fixture-run-1",
          newestAt: 1000,
        }),
      ],
      orphans: 0,
      configPath: POISON.configPath,
      now: 5000,
    });
    const out = projectCampaigns(input);
    expect(keyPaths(out)).toEqual(
      allow([
        "campaigns",
        ...under("campaigns[]", [
          "campaign",
          "config",
          ...under("config", ["enabled", "runsPerCell", "cells", "models", "complete"]),
          "runs",
          "live",
          "models",
          "cells",
          ...under("cells[]", ["cell", "declared", "runs", "models", "bestLevel"]),
          "newestRunId",
          "newestAt",
        ]),
        "orphans",
        "configPath",
        "now",
      ]),
    );
    assertClean(JSON.stringify(out));
    expect(out.configPath).toBeNull();
    // The pinned account's name is the lab's naming scheme; gone, not blanked.
    expect(JSON.stringify(out)).not.toContain("PROBE");
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
      "otherSeries",
      "target",
      "bestLevel",
      "reachedL5",
      "lastEnded",
      "lastReason",
      "runIds",
    ];
    const MODEL_RUN_KEYS = [
      "runId",
      "episode",
      "episodeOverride",
      "harnessVersion",
      "harnessSeries",
      "extra",
      "race",
      "raceName",
      "class",
      "className",
      "characterLabel",
      "resolvedModel",
      "startedAt",
      "endedAt",
      "durationMs",
      "bestLevel",
      "terminationReason",
      "live",
      "counted",
      "cost",
      ...under("cost", COST_VIEW_KEYS),
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
        prevBuild: "harness-0.5-1",
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
        ...under("server", ["phase", "since", "build", "prevBuild", "detail", "updatedAt"]),
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
        smuggle({ i: 5, t: "state", ts: 6, start: 51, end: 60, turn: 2, level: 2, zone: 12, area: 9, items: [smuggle({ name: SURVIVES.itemName, count: 2, equipped: false })] }),
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
    expect(keyPaths(out.entries[0])).toEqual(allow(["i", "t", "ts", "start", "end", "runId", "harnessVersion", "startedAt"]));
    expect(keyPaths(out.entries[1])).toEqual(allow(["i", "t", "ts", "start", "end", "driver", "harness", "systemPromptChars"]));
    expect(keyPaths(out.entries[2])).toEqual(allow(["i", "t", "ts", "start", "end", "turn", "type", "subtype", "estimated_tokens"]));
    // The batch itself never ships; the tally does.
    expect(keyPaths(out.entries[3])).toEqual(allow(["i", "t", "ts", "start", "end", "via", "count", "opcodes"]));
    expect(keyPaths(out.entries[4])).toEqual(allow(["i", "t", "ts", "start", "end", "reason", "episodeElapsedMs"]));
    expect(out.entries[5]).toMatchObject({ level: 2, zone: 12, items: [{ name: SURVIVES.itemName, count: 2, equipped: false }] });
    expect(keyPaths(out.entries[7])).toEqual(allow(["i", "t", "ts", "start", "end", "turn"]));
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
        "i", "t", "ts", "start", "end", "kind", "leashChanged",
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
});
