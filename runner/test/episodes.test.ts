/**
 * Episode tiers (ADR-0030).
 *
 * The load-bearing claims: `--episode` sets the whole leash from one flag, an
 * explicit threshold on top of it still wins but costs the run its tier
 * membership, the id reaches the comparability tuple, and a run that predates
 * the tiers is *labeled* by the reader without ever becoming a member of the
 * group it resembles.
 */

import { describe, expect, test } from "bun:test";
import { comparabilityOf } from "../src/comparability";
import { episodeOverrideOf, loadRunConfig } from "../src/config";
import { EPISODES, EPISODE_IDS, matchesTier, watchdogsFor } from "../src/episodes";
import { configFromArgs } from "../src/run";
import type { EvalRun, RunRow } from "../viewer/api-types";
import { episodeOf, isTierMember, unscoredReason } from "../viewer/eval";

const M = 60_000;

function runRow(over: Partial<RunRow> = {}): RunRow {
  return {
    runId: "r", model: "m", driver: "openai", adapter: "openai", harness: "wrathbench", shakeout: null,
    objective: null, character: "c", platform: "p", apiBase: null, harnessVersion: "v",
    comparability: null, startedAt: 1, endedAt: null, terminationReason: null,
    terminationDetail: null, pauseReason: null, level: null, xp: null, money: null,
    questsCompleted: null, mtime: null, bytes: null, live: false,
    ...over,
  };
}

function evalRun(over: Partial<EvalRun> = {}): EvalRun {
  return {
    runId: "r", model: "m", platform: null, harnessVersion: "v", effort: null,
    harness: null, promptHash: null, serverBuild: null, wikiCoords: null,
    toolCalls: null, snippets: null, modelResponses: null, stillborn: false,
    episode: null, episodeSource: "none", episodeOverride: false, unscored: null,
    startedAt: null, terminationReason: null, levels: [], maxLevel: null,
    questsCompleted: null, maps: [],
    ...over,
  };
}

describe("the table", () => {
  test("every id is its own key, and the numbers are the ones EPISODES.md states", () => {
    for (const id of EPISODE_IDS) expect(EPISODES[id].id).toBe(id);
    expect(EPISODES.e90).toMatchObject({
      minutes: 90, idleMinutes: 20, noXpMinutes: 20, toolCalls: 3000,
      objectiveAllowed: false, scored: true,
    });
    expect(EPISODES.e360).toMatchObject({
      minutes: 360, idleMinutes: 20, noXpMinutes: null, objectiveAllowed: false, scored: true,
    });
    // The same rate — 1000 calls per 30 minutes — held across four times the clock.
    expect(EPISODES.e360.toolCalls).toBe(12_000);
    // freeplay pins nothing: the lane's own ceiling stands.
    expect(EPISODES.freeplay.toolCalls).toBeNull();
    expect(EPISODES.freeplay).toMatchObject({
      minutes: null, noXpMinutes: null, objectiveAllowed: true, scored: false,
    });
  });

  test("watchdogsFor carries a disabled watchdog through as null, not zero", () => {
    expect(watchdogsFor(EPISODES.e90)).toEqual({ idleMs: 20 * M, noXpMs: 20 * M, episodeMs: 90 * M });
    expect(watchdogsFor(EPISODES.e360)).toEqual({ idleMs: 20 * M, noXpMs: null, episodeMs: 360 * M });
    expect(watchdogsFor(EPISODES.freeplay)).toEqual({ idleMs: 20 * M, noXpMs: null, episodeMs: null });
  });

  test("a ceiling the tier does not pin cannot be departed from", () => {
    const leash = { idleMs: 20 * M, noXpMs: null, episodeMs: null };
    // freeplay pins no ceiling, so no ceiling can take a run out of it.
    expect(matchesTier(EPISODES.freeplay, { ...leash, maxToolCalls: 2500 })).toBe(true);
    expect(matchesTier(EPISODES.e90, { idleMs: 20 * M, noXpMs: 20 * M, episodeMs: 90 * M, maxToolCalls: 2500 })).toBe(false);
  });
});

describe("--episode sets the leash", () => {
  test("e90 supplies both watchdogs, the wall clock and the tool-call ceiling", () => {
    const c = configFromArgs(["--episode", "e90", "--model", "m"]);
    expect(c.episode).toBe("e90");
    expect(c.watchdogs).toMatchObject({ idleMs: 20 * M, noXpMs: 20 * M, episodeMs: 90 * M });
    expect(c.maxToolCallsPerEpisode).toBe(3000);
    expect(episodeOverrideOf(c)).toBe(false);
  });

  test("e360 disables no-xp and supplies the 12000-call ceiling", () => {
    const c = configFromArgs(["--episode", "e360"]);
    expect(c.watchdogs.noXpMs).toBeNull();
    expect(c.watchdogs.episodeMs).toBe(360 * M);
    expect(c.maxToolCallsPerEpisode).toBe(12_000);
    expect(episodeOverrideOf(c)).toBe(false);
    // A different ceiling is an override, same as a different watchdog.
    expect(episodeOverrideOf(configFromArgs(["--episode", "e360", "--max-tool-calls", "2500"]))).toBe(true);
  });

  test("freeplay has no wall clock, keeps only idle, and pins no ceiling", () => {
    const c = configFromArgs(["--episode", "freeplay"]);
    expect(c.maxToolCallsPerEpisode).toBe(500); // the config default, not a tier pin
    expect(c.watchdogs.episodeMs).toBeNull();
    expect(c.watchdogs.noXpMs).toBeNull();
    expect(c.watchdogs.idleMs).toBe(20 * M);
  });

  test("no --episode leaves the bare defaults exactly as they were", () => {
    const c = configFromArgs(["--model", "m"]);
    expect(c.episode).toBeUndefined();
    expect(c.watchdogs).toMatchObject({ idleMs: 10 * M, noXpMs: 45 * M, episodeMs: 6 * 60 * M });
    expect(episodeOverrideOf(c)).toBe(false);
  });
});

describe("overrides cost membership, not the flag", () => {
  test("an explicit threshold wins and stamps episodeOverride", () => {
    const c = configFromArgs(["--episode", "e90", "--no-xp-ms", "0"]);
    expect(c.watchdogs.noXpMs).toBeNull();
    expect(c.watchdogs.episodeMs).toBe(90 * M); // the rest of the tier still applies
    expect(episodeOverrideOf(c)).toBe(true);
    expect(comparabilityOf(c, "v").episodeOverride).toBe(true);
  });

  test("--watchdogs-json is an override too", () => {
    const c = configFromArgs(["--episode", "e360", "--watchdogs-json", '{"episodeMs":120000}']);
    expect(c.watchdogs.episodeMs).toBe(120_000);
    expect(episodeOverrideOf(c)).toBe(true);
  });

  test("spelling out the tier's own value is not an override", () => {
    const c = configFromArgs(["--episode", "e90", "--idle-ms", String(20 * M)]);
    expect(episodeOverrideOf(c)).toBe(false);
  });

  test("a tighter leash applied on the resume path reads as an override too", () => {
    // Resume rebuilds config from stored meta, never from argv: the predicate
    // has to be over the effective leash, or a restamp would lie (ADR-0026).
    const launched = configFromArgs(["--episode", "e90"]);
    const resumed = loadRunConfig({
      ...launched,
      watchdogs: { ...launched.watchdogs, episodeMs: 5 * M },
    });
    expect(episodeOverrideOf(resumed)).toBe(true);
    expect(comparabilityOf(resumed, "v").episode).toBe("e90");
  });
});

describe("the tuple", () => {
  test("the id is stamped, and a run with no tier stamps null", () => {
    expect(comparabilityOf(configFromArgs(["--episode", "e360"]), "v").episode).toBe("e360");
    expect(comparabilityOf(configFromArgs([]), "v").episode).toBeNull();
  });

  test("two tiers are never the same tuple", () => {
    const a = comparabilityOf(configFromArgs(["--episode", "e90"]), "v");
    const b = comparabilityOf(configFromArgs(["--episode", "e360"]), "v");
    expect(a).not.toEqual(b);
  });
});

describe("the reader labels, it does not enroll", () => {
  test("a stamped tier is read straight off the tuple", () => {
    const c = comparabilityOf(configFromArgs(["--episode", "e90"]), "v");
    expect(episodeOf(runRow({ comparability: c }))).toEqual({
      episode: "e90", source: "stamped", override: false,
    });
  });

  test("a ninety-minute run with no objective is labeled e90, as derived", () => {
    const c = comparabilityOf(loadRunConfig({ watchdogs: { episodeMs: 90 * M } }), "v");
    expect(episodeOf(runRow({ comparability: c }))).toEqual({
      episode: "e90", source: "derived", override: false,
    });
  });

  test("an objective run is labeled freeplay whatever its tuple says", () => {
    expect(episodeOf(runRow({ objective: "walk to Ironforge" }))).toEqual({
      episode: "freeplay", source: "derived", override: false,
    });
  });

  test("a run with no tuple at all is labeled nothing — never guessed at", () => {
    expect(episodeOf(runRow())).toEqual({ episode: null, source: "none", override: false });
    const sixHours = comparabilityOf(loadRunConfig({}), "v");
    expect(episodeOf(runRow({ comparability: sixHours })).episode).toBeNull();
  });

  test("only a stamped, un-overridden run is a member of its tier's group", () => {
    expect(isTierMember(evalRun({ episode: "e90", episodeSource: "stamped" }))).toBe(true);
    expect(isTierMember(evalRun({ episode: "e90", episodeSource: "derived" }))).toBe(false);
    expect(
      isTierMember(evalRun({ episode: "e90", episodeSource: "stamped", episodeOverride: true })),
    ).toBe(false);
    expect(isTierMember(evalRun())).toBe(false);
  });
});

describe("scorability", () => {
  test("freeplay is unscored, stamped or derived", () => {
    const c = comparabilityOf(configFromArgs(["--episode", "freeplay"]), "v");
    expect(unscoredReason(runRow({ comparability: c }))).toBe("unscored (episode freeplay)");
    expect(unscoredReason(runRow({ objective: "go" }))).toBe("unscored (operator objective)");
  });

  test("a scored tier stays scored; an override is a membership question, not a stamp", () => {
    const clean = comparabilityOf(configFromArgs(["--episode", "e90"]), "v");
    expect(unscoredReason(runRow({ comparability: clean }))).toBeNull();
    const over = comparabilityOf(configFromArgs(["--episode", "e90", "--no-xp-ms", "0"]), "v");
    expect(unscoredReason(runRow({ comparability: over }))).toBeNull();
  });

  test("a derived e90 label never flips an old run to unscored", () => {
    const c = comparabilityOf(loadRunConfig({ watchdogs: { episodeMs: 90 * M } }), "v");
    expect(unscoredReason(runRow({ comparability: c }))).toBeNull();
  });
});
