/**
 * A party member's records on its run page (`RunDetailResponse.party`,
 * `runner/viewer/party-marks.ts`): the member list without accounts, the map
 * transfers, the kills named from the run's own client cache, the group
 * changes, the member's own party chat off its trace, and where it last was
 * with the names the client was served. And the party stamp's role and place
 * on the listings, which is how the dashboard groups a party's runs.
 *
 * Every value is invented; nothing is captured from a running game.
 */

import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CLIENT_CACHE_FILE } from "../src/sandbox/client-cache";
import type { ResultsResponse, RunDetailResponse } from "../viewer/api-types";
import { createApi } from "../viewer/api";
import { localRunStore } from "../viewer/clickhouse";
import { CLIENT_CACHE_NAME } from "../viewer/party-marks";
import { tempDirs } from "./fixtures/temp-dirs";

const tempDir = tempDirs();

const STEM = "fixture-party-a1";
const T0 = 1_792_500_000_000;
const MEMBERS = [
  { member: "tank", role: "tank", runId: `${STEM}-tank`, account: "PARTYACCT1", character: "Aldric" },
  { member: "healer", role: "healer", runId: `${STEM}-healer`, account: "PARTYACCT2", character: "Brenna" },
];

function writeRun(runs: string, runId: string, config: Record<string, unknown>, lines: object[], opts: { trace?: boolean; cache?: boolean } = {}): void {
  const dir = join(runs, runId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "meta.json"), JSON.stringify({ runId, harnessVersion: "harness-0.5-1", startedAt: T0, config }));
  writeFileSync(join(dir, "trajectory.jsonl"), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  const db = new Database(join(dir, "run.sqlite"));
  db.run(
    `CREATE TABLE run (run_id TEXT, model TEXT, driver TEXT, shakeout TEXT, harness_version TEXT, started_at INTEGER,
       ended_at INTEGER, termination_reason TEXT, termination_detail TEXT, pause_reason TEXT, config_json TEXT)`,
  );
  db.run(`INSERT INTO run VALUES (?,?,?,?,?,?,?,?,?,?,?)`, [runId, "test/model", "claude-code", null, "harness-0.5-1", T0, T0 + 600_000, "episode-limit", null, null, JSON.stringify(config)]);
  db.run(
    `CREATE TABLE state (run_id TEXT, ts INTEGER, level INTEGER, xp INTEGER, map INTEGER, x REAL, y REAL, z REAL,
       event_count INTEGER, last_seq INTEGER, money INTEGER, quests_completed INTEGER, turn INTEGER, zone INTEGER, area INTEGER)`,
  );
  db.run(`INSERT INTO state VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [runId, T0 + 1000, 20, 100, 0, -11200, 1670, 30, 1, 1, 0, 0, 1, 40, 20]);
  db.run(`INSERT INTO state VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [runId, T0 + 5000, 20, 300, 36, -40, -370, 56, 2, 2, 0, 0, 1, 1581, 1581]);
  if (opts.trace === true) {
    db.run(`CREATE TABLE trace (run_id TEXT NOT NULL, ts INTEGER NOT NULL, kind TEXT NOT NULL, map INTEGER, x REAL, y REAL, z REAL, o REAL, data TEXT)`);
    const row = (ts: number, data: unknown): void => {
      db.run(`INSERT INTO trace VALUES (?,?,?,?,?,?,?,?,?)`, [runId, ts, "state", null, null, null, null, null, JSON.stringify(data)]);
    };
    row(T0 + 2000, { chat: [["party", "Tank ready at the portal."]] });
    row(T0 + 2100, { hp: 800 });
    row(T0 + 3000, { chat: [["say", "a line not for the party"], ["party", "Inside. Wait for me."]] });
  }
  db.close();
  if (opts.cache === true) {
    writeFileSync(
      join(dir, CLIENT_CACHE_NAME),
      JSON.stringify({
        v: 1,
        frames: [
          { seq: 1, opcode: "SMSG_CREATURE_QUERY_RESPONSE", ts: T0, data: { entry: 644, found: true, name: "Fixture Boss" } },
          { seq: 2, opcode: "SMSG_CREATURE_QUERY_RESPONSE", ts: T0, data: { entry: 999, found: true, name: "Not Killed" } },
          { seq: 3, opcode: "SMSG_GAMEOBJECT_QUERY_RESPONSE", ts: T0, data: { entry: 644, found: true, name: "An Object" } },
        ],
      }),
    );
  }
}

function fixture(): string {
  const runs = join(tempDir("viewer-party-"), "runs");
  for (const m of MEMBERS) {
    const config = {
      runId: m.runId,
      model: "test/model",
      driver: "claude-code",
      campaign: "deadmines",
      cell: "party",
      campaignVersion: 1,
      arm: "base",
      party: { id: STEM, member: m.member, role: m.role, size: 2, members: MEMBERS },
    };
    const tank = m.member === "tank";
    const lines = [
      { ts: T0, t: "meta", runId: m.runId, harnessVersion: "harness-0.5-1", config },
      { ts: T0 + 100, t: "response", turn: 1 },
      { ts: T0 + 1000, t: "milestone", kind: "group", event: "joined", groupGuid: "9", leaderGuid: "1", members: ["2"], count: 2, observedTs: T0 + 900, turn: 1 },
      { ts: T0 + 1000, t: "milestone", kind: "level", to: 20, xp: 100, turn: 1 },
      // The served events of a turn, as the trajectory keeps them: the client was told this zone's name.
      { ts: T0 + 1500, t: "events_served", events: [{ seq: 5, ts: T0 + 1400, opcode: "WB_AREA", data: { mapId: 36, mapName: "Deadmines", instanceType: 1, zoneId: 1581, zoneName: "The Fixture Mine", areaId: 1581, areaName: "The Fixture Mine" } }] },
      { ts: T0 + 4000, t: "milestone", kind: "instance", event: "entered", map: 36, instanceType: 1, from: { map: 0, instanceType: 0 }, observedTs: T0 + 3900, turn: 1 },
      { ts: T0 + 4500, t: "milestone", kind: "kill", killerGuid: "1", victimGuid: "7001", entry: 644, rank: 1, self: tank, observedTs: T0 + 4400, turn: 1 },
      ...(tank ? [{ ts: T0 + 4600, t: "milestone", kind: "kill", killerGuid: "2", victimGuid: "7002", rank: 1, self: false, turn: 1 }] : []),
    ];
    writeRun(runs, m.runId, config, lines, { trace: tank, cache: tank });
  }
  // A run that is no party member: its page keeps its shape.
  writeRun(runs, "fixture-solo", { runId: "fixture-solo", model: "test/model", driver: "openai" }, [{ ts: T0, t: "meta", runId: "fixture-solo" }, { ts: T0 + 100, t: "response", turn: 1 }]);
  return runs;
}

function api(runs: string, publicMode = false) {
  return createApi({ runsDir: runs, tilesDir: join(runs, "..", "no-tiles"), publicMode, moduleUrl: "http://127.0.0.1:1", store: localRunStore(runs) });
}

async function detail(handle: ReturnType<typeof api>, id: string): Promise<RunDetailResponse> {
  const res = await handle(new Request(`http://127.0.0.1/api/run/${id}`));
  expect(res.status).toBe(200);
  return (await res.json()) as RunDetailResponse;
}

describe("a party member's run page", () => {
  test("serves its party block: members without accounts, transfers, named kills, group, chat and place", async () => {
    const runs = fixture();
    const d = await detail(api(runs), `${STEM}-tank`);
    expect(d.run.party).toEqual({ id: STEM, member: "tank", size: 2, role: "tank", index: 0 });
    const p = d.party!;
    expect(p).toMatchObject({ id: STEM, member: "tank", role: "tank", size: 2 });
    expect(p.members).toEqual(MEMBERS.map(({ member, role, runId, character }) => ({ member, role, runId, character })));
    expect(JSON.stringify(p)).not.toContain("PARTYACCT");
    expect(p.instances).toEqual([{ ts: T0 + 3900, event: "entered", map: 36, from: 0 }]);
    // Named by the run's own client cache, from the creature query alone; a victim the unit cache never knew stays unnamed.
    expect(p.kills).toEqual([
      { ts: T0 + 4400, victimGuid: "7001", entry: 644, name: "Fixture Boss", self: true },
      { ts: T0 + 4600, victimGuid: "7002", entry: null, name: null, self: false },
    ]);
    expect(p.groups).toEqual([{ ts: T0 + 900, event: "joined", count: 2 }]);
    // The party's lines only, the say left out.
    expect(p.chat).toEqual([
      { ts: T0 + 2000, text: "Tank ready at the portal." },
      { ts: T0 + 3000, text: "Inside. Wait for me." },
    ]);
    expect(p.where).toEqual({ ts: T0 + 5000, map: 36, zone: 1581, zoneName: "The Fixture Mine", area: 1581, areaName: "The Fixture Mine" });
  });

  test("a member with no trace and no cache still has its block, with nothing invented", async () => {
    const d = await detail(api(fixture()), `${STEM}-healer`);
    expect(d.party!.chat).toEqual([]);
    expect(d.party!.kills).toEqual([{ ts: T0 + 4400, victimGuid: "7001", entry: 644, name: null, self: false }]);
  });

  test("a run that is no party member has no block and no stamp", async () => {
    const d = await detail(api(fixture()), "fixture-solo");
    expect(d).not.toHaveProperty("party");
    expect(d.run).not.toHaveProperty("party");
  });

  test("the public handle serves the same block, still without accounts", async () => {
    const d = await detail(api(fixture(), true), `${STEM}-tank`);
    expect(d.party!.kills[0]!.name).toBe("Fixture Boss");
    expect(d.party!.chat).toHaveLength(2);
    expect(JSON.stringify(d)).not.toContain("PARTYACCT");
  });

  test("the listing's rows carry each member's role and place, which is how a party's runs are grouped", async () => {
    const res = await api(fixture())(new Request("http://127.0.0.1/api/results?episode=all&includeOverrides=1"));
    const rows = ((await res.json()) as ResultsResponse).runs;
    const party = rows.filter((r) => r.party !== undefined).map((r) => [r.runId, r.party]);
    expect(party.sort()).toEqual([
      [`${STEM}-healer`, { id: STEM, member: "healer", size: 2, role: "healer", index: 1 }],
      [`${STEM}-tank`, { id: STEM, member: "tank", size: 2, role: "tank", index: 0 }],
    ]);
    expect(rows.find((r) => r.runId === "fixture-solo")).not.toHaveProperty("party");
  });

  test("the cache's file name is the sandbox's", () => {
    expect(CLIENT_CACHE_NAME).toBe(CLIENT_CACHE_FILE);
  });
});
