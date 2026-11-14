/**
 * How a Deadmines attempt counts (operator, 2026-11-14): on the five-agent id
 * the attempt is the party, so five member runs are one attempt, one count and
 * at most one rung of the model's cooling ladder; a member that went idle or
 * reached its call ceiling makes a counted attempt that is not cleared; and
 * staging that failed numbers an attempt and neither counts nor cools.
 */

import { describe, expect, test } from "bun:test";
import { DEFAULT_POLICY, isPartyEpisode, partyAttempts, projectModel, type RosterModel, type RunFact } from "../src/models";

const NOW = Date.UTC(2026, 10, 14, 12);
const ENTRY: RosterModel = { name: "son", model: "sonnet", driver: "claude-code", tier: "t2", deadmines: true };
const MEMBERS = ["tank", "healer", "mage", "rogue", "paladin"];

function fact(over: Partial<RunFact>): RunFact {
  return {
    runId: "fleet-son-x",
    model: "sonnet",
    effort: null,
    episode: "deadmines",
    episodeOverride: false,
    harnessVersion: null,
    harnessSeries: null,
    loop: "program",
    yield: true,
    extra: false,
    startedAt: NOW - 3 * 3_600_000,
    endedAt: NOW - 3_600_000,
    terminationReason: "episode-limit",
    modelResponses: 40,
    bestLevel: 20,
    live: false,
    pause: null,
    account: null,
    character: null,
    episodeMs: 14_400_000,
    campaign: null,
    cell: null,
    credential: null,
    driver: "claude-code",
    ...over,
  } as RunFact;
}

/** One five-agent attempt: `first` ended on its own verdict, the rest `party-ended`, unless `each` says otherwise. */
function party(id: string, first: string, each?: (member: string) => Partial<RunFact>): RunFact[] {
  return MEMBERS.map((member, i) =>
    fact({
      runId: `fleet-son-deadmines-sonnet-20261114-${id}-${member}`,
      party: { id, member, size: 5 },
      terminationReason: i === 0 ? first : "party-ended",
      ...(each?.(member) ?? {}),
    }),
  );
}

const stats = (runs: RunFact[], episode: "deadmines" | "deadmines-solo" = "deadmines") => projectModel(ENTRY, runs, DEFAULT_POLICY, { now: NOW }).perEpisode[episode]!;
const ladder = (runs: RunFact[]): number => projectModel(ENTRY, runs, DEFAULT_POLICY, { now: NOW }).ladder;

describe("a five-agent attempt", () => {
  test("is its party: five member runs are one attempt and one count", () => {
    expect(isPartyEpisode("deadmines")).toBe(true);
    expect(isPartyEpisode("deadmines-solo")).toBe(false);
    const runs = [...party("p1", "kill-target"), ...party("p2", "episode-limit")];
    expect(partyAttempts(runs)).toHaveLength(2);
    expect(stats(runs)).toMatchObject({ attempts: 2, counted: 2, target: 3 });
  });

  test("a member that went idle or reached its call ceiling: counted, and no rung", () => {
    for (const reason of ["idle", "tool-call-limit"]) {
      expect(stats(party("p1", reason))).toMatchObject({ attempts: 1, counted: 1 });
      expect(ladder(party("p1", reason))).toBe(0);
    }
  });

  test("a provider's refusal is one rung of the cooling ladder, however many members met it", () => {
    const at = (p: number) => (m: string) => ({ terminationReason: "attempt-failed", terminationDetail: "quota-exhausted", endedAt: NOW - p * 3_600_000 + MEMBERS.indexOf(m) }) as Partial<RunFact>;
    const refused = party("p1", "attempt-failed", at(2));
    expect(stats(refused)).toMatchObject({ attempts: 1, counted: 0 });
    expect(ladder(refused)).toBe(1);
    expect(ladder([...refused, ...party("p2", "attempt-failed", at(1))])).toBe(2);
  });

  test("staging that failed numbers an attempt, and neither counts nor cools", () => {
    const stub = party("p1", "launch-failed", () => ({ terminationReason: "launch-failed", modelResponses: null }));
    expect(stats(stub)).toMatchObject({ attempts: 1, counted: 0 });
    expect(ladder(stub)).toBe(0);
  });

  test("an attempt still in flight, or missing a member, does not count yet", () => {
    const live = party("p1", "kill-target").map((f, i) => (i === 2 ? { ...f, live: true, terminationReason: null, endedAt: null } : f));
    expect(stats(live)).toMatchObject({ attempts: 1, counted: 0 });
    expect(stats(party("p1", "kill-target").slice(0, 4))).toMatchObject({ attempts: 1, counted: 0 });
  });
});

describe("the cooling walk", () => {
  test("a party whose five members failed on their own is one rung, not five", () => {
    const failed = party("p1", "adapter-error", (m) => ({ terminationReason: "adapter-error", endedAt: NOW - 3_600_000 + MEMBERS.indexOf(m) }));
    expect(projectModel(ENTRY, failed, DEFAULT_POLICY, { now: NOW }).ladder).toBe(1);
    const two = [...failed, ...party("p2", "adapter-error", () => ({ terminationReason: "adapter-error", endedAt: NOW - 1_000 }))];
    expect(projectModel(ENTRY, two, DEFAULT_POLICY, { now: NOW }).ladder).toBe(2);
  });
});

describe("the one-agent id", () => {
  test("is one run per attempt", () => {
    const solo = (n: number, terminationReason: string): RunFact => fact({ episode: "deadmines-solo", runId: `fleet-son-deadmines-solo-sonnet-20261114-a${n}`, terminationReason });
    const runs = [solo(1, "kill-target"), solo(2, "attempt-failed"), ...party("p1", "attempt-failed", () => ({ terminationReason: "attempt-failed" }))];
    expect(stats(runs, "deadmines-solo")).toMatchObject({ attempts: 2, counted: 1 });
    expect(stats(runs, "deadmines")).toMatchObject({ attempts: 1, counted: 0 });
  });
});
