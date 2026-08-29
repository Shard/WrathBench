/**
 * The public projection IS the legal boundary (docs/DATA-AND-LEGAL.md,
 * issue #10), so this suite is written the way the boundary is argued:
 *
 * - **Key sets, exactly.** Every projector's output is compared against a
 *   written-out allowlist of deep key paths. A field nobody wrote down here
 *   cannot ship — including keys smuggled through parsed-JSON objects that
 *   carry more than their declared type (the `EntrySummary` lesson).
 * - **Values, not key names.** Every poisoned value planted in the fixtures —
 *   game-text item names, character names, free-text details, filesystem
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
  projectTrack,
} from "../viewer/public-projection";

/* ------------------------------------------------------------- poisons --- */

// One distinctive value per thing the projection must withhold. Each appears
// somewhere in the fixtures below, and none may appear in any serialized output.
const POISON = {
  itemName: "Poisoned Worn Shortsword",
  character: "Poisonedcharname",
  objective: "poison-objective: walk to Goldshire",
  apiBase: "http://10.66.66.66:1234/v1-poison",
  terminationDetail: "poison-termination-detail quoting an NPC",
  pauseReason: "poison-pause-free-text",
  rowError: "poison ENOENT /home/operator/data/runs",
  configPath: "/home/operator/wrathbench/infra/fleet.json",
  rosterPath: "/home/operator/wrathbench/infra/roster.json",
  lastErrorMessage: "poison 401 unauthorized bearer sk-poison-123",
  configRejectedError: "poison ENOENT open '/home/operator/wrathbench/infra/fleet.json'",
  preflightTail: "poison-smoke-tail: Fixturely says hello",
  wikiSource: "poison-wowdump-20100901.xml.bz2",
  smuggled: "poison-smuggled-value",
} as const;

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
    character: POISON.character,
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
    terminationDetail: POISON.terminationDetail,
    pauseReason: POISON.pauseReason,
    level: 4,
    xp: 500,
    money: 1234,
    questsCompleted: 2,
    items: [{ name: POISON.itemName, count: 1, equipped: true }],
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
        character: POISON.character,
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
  // no wikiBundle: withheld (its `source` is the operator's dump filename)
  "episode",
  "episodeOverride",
  "serverBuild",
  "serverBuild.build",
  "serverBuild.startedAtMs",
  "resolvedModel",
];
const RUN_ROW_KEYS = [
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
  // The player frame's numbers (FOLLOW-UPS 104): public on every surface that
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
  test("names AzerothCore and disclaims Blizzard distribution", () => {
    expect(PUBLIC_ATTRIBUTION).toContain("AzerothCore");
    expect(PUBLIC_ATTRIBUTION).toContain("Nothing Blizzard-owned");
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
    expect(row.character).toBeNull();
    expect(row.items).toBeNull();
    expect(row.objective).toBeNull();
    expect(row.apiBase).toBeNull();
    expect(row.terminationDetail).toBeNull();
    // The paused signal survives as a fixed token, never as the free text.
    expect(row.pauseReason).toBe("paused");
    // What the label layer needs survives.
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
      ]),
    );
    assertClean(JSON.stringify(out));
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
    expect(out.runs[0]!.character).toBeNull();
    expect(out.runs[0]!.pauseReason).toBe("paused");
  });
});

describe("projectPositions and projectTrack", () => {
  test("positions: exactly the allowlist; names and items are gone", () => {
    const input: PositionsResponse = smuggle<PositionsResponse>({
      positions: [
        smuggle({
          runId: "fixture-run-1",
          character: POISON.character,
          model: "test/model",
          map: 0,
          x: -6240,
          y: 380,
          ts: 1000,
          level: 3,
          xp: 400,
          money: 1234,
          questsCompleted: 2,
          items: [{ name: POISON.itemName, count: 1, equipped: false }],
          harnessVersion: "harness-0.5-1-gabc",
          health: 140,
          maxHealth: 220,
          power: 30,
          maxPower: 100,
          powerType: 3,
          nextLevelXp: 2100,
          class: 4,
          move: smuggle({ ts: 1200, map: 0, x: -6200, y: 400, z: 380, target: POISON.character, status: null }),
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
          "map",
          "x",
          "y",
          "ts",
          "level",
          "xp",
          "money",
          "questsCompleted",
          "items",
          "harnessVersion",
          "health", "maxHealth", "power", "maxPower", "powerType", "nextLevelXp",
          "class",
          "move",
        ]),
        ...under("positions[].move", ["ts", "map", "x", "y", "z", "target", "status"]),
      ]),
    );
    assertClean(JSON.stringify(out));
    expect(out.positions[0]!.character).toBeNull();
    expect(out.positions[0]!.items).toBeNull();
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
    // The destination travels; the name of what it was aimed at does not.
    expect(out.positions[0]!.move).toEqual({ ts: 1200, map: 0, x: -6200, y: 400, z: 380, target: null, status: null });
  });

  test("track: exactly the allowlist; the character name is gone", () => {
    const input: TrackResponse = smuggle<TrackResponse>({
      runId: "fixture-run-1",
      character: POISON.character,
      model: "test/model",
      harnessVersion: "harness-0.5-1-gabc",
      points: [
        smuggle({
          ts: 1000, map: 0, x: -6240, y: 380, level: 1, xp: 0, money: 0, questsCompleted: 0, turn: 1,
          health: 140, maxHealth: 220, power: 30, maxPower: 100, powerType: 3, nextLevelXp: 2100,
        }),
      ],
      moves: [
        smuggle({ ts: 1200, map: 0, x: -6200, y: 400, z: 380, target: POISON.character, status: "arrived" }),
      ],
    });
    const out = projectTrack(input);
    expect(keyPaths(out)).toEqual(
      allow([
        "runId",
        "character",
        "model",
        "harnessVersion",
        "points",
        ...under("points[]", [
          "ts", "map", "x", "y", "level", "xp", "money", "questsCompleted", "turn",
          "health", "maxHealth", "power", "maxPower", "powerType", "nextLevelXp",
        ]),
        "moves",
        ...under("moves[]", ["ts", "map", "x", "y", "z", "target", "status"]),
      ]),
    );
    assertClean(JSON.stringify(out));
    expect(out.character).toBeNull();
    expect(out.points[0]).toMatchObject({ health: 140, maxHealth: 220, powerType: 3, nextLevelXp: 2100 });
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
          ...under("config", ["enabled", "runsPerCell", "cells", "models", "complete", "account"]),
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
