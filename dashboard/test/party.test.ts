/**
 * A party attempt read as one (`lib/party.ts`): its rows grouped in the runs
 * table, and the party view the party page draws from the members' rows and
 * details: who ended it, whether it reached its end, and what it killed.
 *
 * Membership is the stamp's party id, never a parse of a run id: the fixtures
 * below give two attempts whose ids sort the other way round from their start.
 * Every value is invented.
 */

import { describe, expect, test } from "bun:test";
import type { ResultRun, RunDetailResponse } from "../../viewer/api-types";
import { END_REASONS as RUNNER_END_REASONS } from "../../runner/src/end-conditions";
import { BOSS_ENTRIES, END_REASONS, groupParties, partyViewOf } from "../src/lib/party";

const STEM = "fixture-party-a1";
const ROLES = ["tank", "healer", "mage", "rogue", "paladin"] as const;

function row(id: string, over: Partial<ResultRun> = {}): ResultRun {
  return {
    runId: id,
    model: "claude-sonnet-5-5",
    harness: "claude-code",
    harnessVersion: "harness-0.5-1",
    harnessSeries: "0.5",
    campaign: null,
    cell: null,
    startedAt: 1000,
    endedAt: 9000,
    live: false,
    terminationReason: "episode-limit",
    pauseReason: null,
    maxLevel: 20,
    xp: 100,
    levels: [],
    ...over,
  } as unknown as ResultRun;
}

function member(stem: string, m: (typeof ROLES)[number], index: number, over: Partial<ResultRun> = {}): ResultRun {
  return row(`${stem}-${m}`, {
    campaign: "deadmines",
    cell: "party",
    campaignVersion: 3,
    arm: "base",
    party: { id: stem, member: m, size: 5, role: m === "tank" || m === "healer" ? m : "damage", index },
    ...over,
  });
}

const partyRows = (stem: string, over: Partial<ResultRun> = {}): ResultRun[] => ROLES.map((m, i) => member(stem, m, i, over));

function detail(r: ResultRun, party: Partial<NonNullable<RunDetailResponse["party"]>> = {}, deaths: number[] = []): RunDetailResponse {
  return {
    run: { runId: r.runId, character: `${r.party!.member}-char`, level: 20, xp: 150, terminationDetail: null },
    deaths: {
      deaths: deaths.length,
      releases: 0,
      resurrects: 0,
      first: null,
      last: null,
      // The public build's sites: a turn and nothing else. The times are the party block's.
      sites: deaths.map(() => ({ turn: 1 })),
    },
    leveling: null,
    party: {
      id: r.party!.id,
      member: r.party!.member,
      role: r.party!.role!,
      size: 5,
      members: ROLES.map((m) => ({ member: m, role: m, runId: `${r.party!.id}-${m}`, character: `${m}-char` })),
      instances: [],
      kills: [],
      chat: [],
      groups: [],
      deaths,
      where: null,
      ...party,
    },
  } as unknown as RunDetailResponse;
}

describe("the runs table's grouping", () => {
  test("a party's rows sit together, in member order, where the first of them sorted; nothing else moves", () => {
    // Started a second apart in reverse order, with an unrelated run between two members.
    const sorted = [
      row("solo-1"),
      member(STEM, "rogue", 3),
      row("solo-2"),
      member(STEM, "tank", 0),
      member(STEM, "paladin", 4),
      member(STEM, "healer", 1),
      member(STEM, "mage", 2),
      row("solo-3"),
    ];
    expect(groupParties(sorted).map((r) => r.runId)).toEqual([
      "solo-1",
      `${STEM}-tank`,
      `${STEM}-healer`,
      `${STEM}-mage`,
      `${STEM}-rogue`,
      `${STEM}-paladin`,
      "solo-2",
      "solo-3",
    ]);
  });

  test("two parties stay two blocks, keyed by the stamp's id and not by the run id", () => {
    const a = partyRows("dm-zz");
    const b = partyRows("dm-aa");
    const out = groupParties([b[4]!, a[0]!, b[0]!, a[1]!]);
    expect(out.map((r) => r.party!.id)).toEqual(["dm-aa", "dm-aa", "dm-zz", "dm-zz"]);
    expect(groupParties([])).toEqual([]);
  });
});

describe("the party view", () => {
  const boss = [...BOSS_ENTRIES][0]!;

  test("kills are one per victim, named by whichever member knew it, the killer a member only when one says so", () => {
    const rows = partyRows(STEM);
    const d = new Map(rows.map((r) => [r.runId, detail(r)]));
    const kill = (victimGuid: string, ts: number, entry: number | null, name: string | null, self: boolean) => ({ ts, victimGuid, entry, name, self });
    d.set(rows[0]!.runId, detail(rows[0]!, { kills: [kill("v1", 120, null, null, false), kill("v2", 300, 1729, "An Evoker", false)] }));
    d.set(rows[3]!.runId, detail(rows[3]!, { kills: [kill("v1", 100, boss, "The Boss", true)] }));
    d.set(rows[1]!.runId, detail(rows[1]!, { kills: [kill("v2", 310, 1729, "An Evoker", false)] }));
    const v = partyViewOf(STEM, rows, d)!;
    const kills = v.events.filter((e) => e.kind === "kill");
    expect(kills).toEqual([
      { kind: "kill", ts: 100, member: "rogue", entry: boss, name: "The Boss", boss: true, seenBy: ["tank", "rogue"] },
      { kind: "kill", ts: 300, member: null, entry: 1729, name: "An Evoker", boss: false, seenBy: ["tank", "healer"] },
    ]);
    expect(v.bosses).toEqual([{ entry: boss, name: "The Boss", ts: 100 }]);
  });

  test("the verdict is the member whose own reason ended it; the rest were ended by the party", () => {
    const rows = partyRows(STEM, { terminationReason: "party-ended", endedAt: 9000 });
    rows[2] = member(STEM, "mage", 2, { terminationReason: "idle", endedAt: 8000 });
    const v = partyViewOf(STEM, rows, new Map())!;
    expect(v.status).toBe("ended");
    expect(v.endedBy).toEqual({ member: "mage", reason: "idle", detail: null });
    expect(v.startedAt).toBe(1000);
    expect(v.endedAt).toBe(9000);
  });

  test("a party that reached its end says so, naming the member whose run reached it", () => {
    const rows = partyRows(STEM, { terminationReason: "kill-target", endedAt: 9000 });
    rows[3] = member(STEM, "rogue", 3, { terminationReason: "kill-target", endedAt: 8000 });
    const details = new Map(
      rows.map((r) => {
        const d = detail(r);
        d.run.terminationDetail = r.party!.member === "rogue" ? "entry 639 killed (killer party member 980)" : "rogue: kill-target";
        return [r.runId, d] as const;
      }),
    );
    const v = partyViewOf(STEM, rows, details)!;
    expect(v.reached).toBe(true);
    expect(v.endedBy).toEqual({ member: "rogue", reason: "kill-target", detail: "entry 639 killed (killer party member 980)" });
    // The public build serves no detail: the reason alone, still reached.
    const bare = partyViewOf(STEM, rows, new Map())!;
    expect(bare).toMatchObject({ reached: true, endedBy: { member: null, reason: "kill-target" } });
    // A party the clock ended is not one that reached its end.
    expect(partyViewOf(STEM, partyRows(STEM, { terminationReason: "episode-limit" }), new Map())!.reached).toBe(false);
  });

  test("the end reasons are the runner's", () => {
    expect([...END_REASONS].sort()).toEqual([...RUNNER_END_REASONS].sort());
  });

  test("five stopped the same way at once name nobody: the reason alone", () => {
    const v = partyViewOf(STEM, partyRows(STEM, { terminationReason: "manual", endedAt: 9000 }), new Map())!;
    expect(v.endedBy).toEqual({ member: null, reason: "manual", detail: null });
  });
});
