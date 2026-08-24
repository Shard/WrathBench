/**
 * The guard on the one-way door between an episode and evidence.
 *
 * `targetFor` used to ask `ep === "freeplay"`, and a name check there is a
 * landmine: widening `EpisodeId` makes TypeScript demand *a* decision, and the
 * cheapest decision that compiles is to add the new id to a tier's
 * `runsPerEpisode` — which wires an exploratory episode into series-gated
 * evidence and tier promotion without anyone saying so out loud. So the rule is
 * asserted over the whole table rather than trusted to a reviewer: an episode
 * the harness will not score cannot be scheduled as evidence, cannot carry a
 * target, and cannot be bought by a tier.
 *
 * These assertions are deliberately written over `EPISODE_IDS` and not over a
 * list of names, so a new id is covered the day it is added.
 */

import { describe, expect, test } from "bun:test";
import { EPISODE_IDS, EPISODES, matchesTier, type EpisodeId } from "../src/episodes";
import { POLICY_EPISODES, TIER_TABLE, TIERS, projectModel, DEFAULT_POLICY, type RosterModel } from "../src/models";

const unscored: readonly EpisodeId[] = EPISODE_IDS.filter((id) => !EPISODES[id].scored);
const NOW = 1_800_000_000_000;

describe("an unscored episode is never evidence", () => {
  test("there is at least one, or these assertions prove nothing", () => {
    expect(unscored.length).toBeGreaterThan(0);
  });

  test("no unscored episode is a policy target", () => {
    for (const id of unscored) expect(POLICY_EPISODES).not.toContain(id);
  });

  test("no tier buys an unscored episode", () => {
    for (const tier of TIERS) {
      const bought = Object.keys(TIER_TABLE[tier].runsPerEpisode);
      for (const id of unscored) expect(bought).not.toContain(id);
    }
  });

  test("every tier's target for every unscored episode is zero", () => {
    for (const tier of TIERS) {
      const m: RosterModel = { name: "m", model: "m", tier };
      const s = projectModel(m, [], DEFAULT_POLICY, { now: NOW });
      for (const id of unscored) expect(s.perEpisode[id]?.target).toBe(0);
    }
  });

  test("every scored episode a tier can buy does have a target", () => {
    const scored = EPISODE_IDS.filter((id) => EPISODES[id].scored);
    expect(scored).toEqual(POLICY_EPISODES as EpisodeId[]);
    const m: RosterModel = { name: "m", model: "m", tier: "t2" };
    const s = projectModel(m, [], DEFAULT_POLICY, { now: NOW });
    for (const id of scored) expect(s.perEpisode[id]?.target).toBeGreaterThan(0);
  });

  test("an unscored tier states no budget, so no run of one reads as overridden", () => {
    // A campaign or an experiment sets the clock; the tier's own numbers are the
    // default it inherits. "Overridden" is a claim about falling out of a scored
    // comparison group, and an unscored episode has no group to fall out of.
    for (const id of unscored) {
      expect(matchesTier(EPISODES[id], { idleMs: 1, noXpMs: 2, episodeMs: 3, maxToolCalls: 4 })).toBe(true);
    }
  });

  test("a scored tier still reports a departure from its own leash", () => {
    expect(matchesTier(EPISODES.e90, { idleMs: 1, noXpMs: 2, episodeMs: 3 })).toBe(false);
  });
});
