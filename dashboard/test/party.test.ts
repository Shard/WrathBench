/**
 * A party attempt read as one (`lib/party.ts`): its rows grouped in the runs
 * table, the party view the party page draws from the members' rows and
 * details, and the group replay's map state (`createMapState` with a group).
 *
 * Membership is the stamp's party id, never a parse of a run id: the fixtures
 * below give two attempts whose ids sort the other way round from their start.
 * Every value is invented.
 */

import { describe, expect, test } from "bun:test";
import type { AgentPosition, ResultRun, RunDetailResponse, TrackPoint, TrackResponse } from "../../runner/viewer/api-types";
import { createRoot, createSignal } from "solid-js";
import { createMapState } from "../src/lib/mapstate";
import {
  BOSS_ENTRIES,
  groupParties,
  groupTrack,
  loadParty,
  mapAt,
  memberClass,
  partyRowsOf,
  partyViewOf,
  whereLabel,
} from "../src/lib/party";

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
      sites: deaths.map((ts) => ({ ts, turn: 1, position: null, zone: null, area: null, released: null })),
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

  test("partyRowsOf finds one party's rows in member order", () => {
    const rows = [...partyRows("dm-zz"), ...partyRows(STEM)].reverse();
    expect(partyRowsOf(rows, STEM).map((r) => r.party!.member)).toEqual([...ROLES]);
  });

  test("a member's colour class follows its place, the leader first", () => {
    expect([0, 1, 4, 5].map(memberClass)).toEqual(["member-1", "member-2", "member-5", "member-1"]);
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

  test("the timeline merges every member's records oldest first, a tie in member order", () => {
    const rows = partyRows(STEM);
    const d = new Map(rows.map((r) => [r.runId, detail(r)]));
    d.set(rows[1]!.runId, detail(rows[1]!, { chat: [{ ts: 500, text: "healer here" }], instances: [{ ts: 400, event: "entered", map: 36, from: 0 }] }, [450]));
    d.set(rows[0]!.runId, detail(rows[0]!, { chat: [{ ts: 500, text: "tank here" }], groups: [{ ts: 50, event: "joined", count: 5 }, { ts: 8000, event: "left", count: 0 }] }));
    const v = partyViewOf(STEM, rows, d)!;
    const lines = v.events.filter((e) => e.kind !== "end").map((e) => `${e.ts}:${e.kind}:${e.member ?? "-"}`);
    expect(lines).toEqual(["400:enter:healer", "450:death:healer", "500:chat:tank", "500:chat:healer", "8000:left:tank"]);
    // A death with no position (the public build's) is placed by the member's own transfers.
    expect(v.events.find((e) => e.kind === "death")).toMatchObject({ map: 36 });
    expect(v.events.filter((e) => e.kind === "end")).toHaveLength(5);
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

  test("live while any member is, with no end and no verdict", () => {
    const rows = partyRows(STEM);
    rows[4] = member(STEM, "paladin", 4, { live: true, terminationReason: null, endedAt: null });
    const v = partyViewOf(STEM, rows, new Map())!;
    expect(v.status).toBe("live");
    expect(v.endedAt).toBeNull();
    expect(v.endedBy).toBeNull();
  });

  test("a place one member was never served a name for takes the name another member was", () => {
    const rows = partyRows(STEM);
    const d = new Map(rows.map((r) => [r.runId, detail(r)]));
    d.set(rows[0]!.runId, detail(rows[0]!, { where: { ts: 1, map: 0, zone: 40, zoneName: null, area: 20, areaName: null } }));
    d.set(rows[3]!.runId, detail(rows[3]!, { where: { ts: 1, map: 0, zone: 40, zoneName: "Fixture Hills", area: 21, areaName: "A Farm" } }));
    const v = partyViewOf(STEM, rows, d)!;
    expect(v.members[0]!.where).toMatchObject({ zoneName: "Fixture Hills", areaName: null });
    expect(whereLabel(v.members[0]!.where, (m) => `map-${m}`)).toBe("map-0 · Fixture Hills");
    expect(whereLabel({ ts: 1, map: 36, zone: 1, zoneName: "Mine", area: 1, areaName: "Mine" }, () => "Mine")).toBe("Mine");
    expect(whereLabel(null, () => "x")).toBe("—");
  });

  test("a party the listing does not hold is null", () => {
    expect(partyViewOf("nope", partyRows(STEM), new Map())).toBeNull();
  });

  test("mapAt reads a member's map off its transfers", () => {
    const marks = [
      { ts: 100, event: "entered" as const, map: 36, from: 0 },
      { ts: 200, event: "left" as const, map: 0, from: 36 },
    ];
    expect([50, 100, 150, 250].map((t) => mapAt(marks, t))).toEqual([0, 36, 36, 0]);
    expect(mapAt([], 10)).toBeNull();
  });

  test("loadParty reads the unfiltered listing and each member's detail; one failed detail leaves that member to its row", async () => {
    const rows = [...partyRows(STEM), row("solo")];
    const asked: string[] = [];
    const client = {
      results: async (episode?: unknown, overrides?: unknown, harness?: unknown) => {
        asked.push(`results:${String(episode)}:${String(overrides)}:${String(harness)}`);
        return { runs: rows } as never;
      },
      run: async (id: string) => {
        asked.push(id);
        if (id.endsWith("-mage")) throw new Error("404");
        return detail(rows.find((r) => r.runId === id)!) as never;
      },
    };
    const v = (await loadParty(client as never, STEM))!;
    expect(asked[0]).toBe("results:all:true:all");
    expect(v.members.map((m) => [m.member, m.character, m.level])).toEqual([
      ["tank", "tank-char", 20],
      ["healer", "healer-char", 20],
      ["mage", "mage-char", 20],
      ["rogue", "rogue-char", 20],
      ["paladin", "paladin-char", 20],
    ]);
    expect(await loadParty(client as never, "nope")).toBeNull();
  });
});

describe("the group replay", () => {
  const point = (ts: number, map: number): TrackPoint => ({ ts, map, x: ts, y: ts, level: 20, xp: 0, money: 0, questsCompleted: 0, turn: 1 });
  const track = (runId: string, points: TrackPoint[]): TrackResponse => ({ runId, characterName: runId, model: "m", harnessVersion: "h", points });
  const pos = (runId: string, map: number): AgentPosition =>
    ({ runId, character: runId, model: "m", map, x: 0, y: 0, ts: 0, level: 20, xp: 0, money: 0, questsCompleted: 0, harnessVersion: "h" }) as AgentPosition;

  test("the transport's track is every member's points on one clock under the party's key", () => {
    const g = groupTrack(STEM, [track("a", [point(10, 0), point(30, 36)]), track("b", [point(20, 0)])]);
    expect(g.runId).toBe(`party:${STEM}`);
    expect(g.points.map((p) => p.ts)).toEqual([10, 20, 30]);
  });

  test("the map follows the member picked, the leader until one is, and each chip counts the members on it", () => {
    createRoot((dispose) => {
      const tracks = [track("tank", [point(1, 0), point(2, 36)]), track("healer", [point(1, 36)])];
      const [feed, setFeed] = createSignal<readonly AgentPosition[]>([pos("tank", 0), pos("healer", 36)]);
      const [selectedId, setSelectedId] = createSignal<string | null>(null);
      const followed = (): TrackResponse | undefined => tracks.find((t) => t.runId === selectedId()) ?? tracks[0];
      const s = createMapState({ feed, track: followed, group: () => tracks, pinned: () => null, selectedId });
      expect(s.selected()?.runId).toBe("tank");
      expect(s.activeMap()).toBe(0);
      expect(s.maps()).toEqual([
        [0, 1],
        [36, 1],
      ]);
      setSelectedId("healer");
      expect(s.selected()?.runId).toBe("healer");
      expect(s.activeMap()).toBe(36);
      // Everyone inside: the outdoor map is still a chip, with nobody on it.
      setFeed([pos("tank", 36), pos("healer", 36)]);
      expect(s.maps()).toEqual([
        [0, 0],
        [36, 2],
      ]);
      dispose();
    });
  });
});
