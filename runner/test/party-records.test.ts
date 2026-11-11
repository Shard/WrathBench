/**
 * The party records (docs/proposals/GROUP-PLAY.md §6): `group`, `instance`
 * and `kill` milestones. The stack records the transitions off the packets
 * the server sends (`@wrathbench/mcp/record`, the session record's `events`
 * stream, after its write gate), the runner's host hands them to the loop
 * (`SandboxHost.partySignals`, through `RecordSignals`), and the loop writes
 * them on its state sample.
 *
 * The watcher over a hand-built cache is the stack's and is tested there
 * (`wrath-mcp/mcp/test/record-party-watch.test.ts`), as is the gate
 * (`record-gate.test.ts`). Here: one real child with the run's session record,
 * end to end, and the loop writing what a fake sandbox hands it. Frames are
 * written from wrath-mcp/module/PROTOCOL.md's tables (and, for the two the
 * module has not tapped yet, the shapes the design gives them: `instanceType`
 * on `WB_AREA`, `killerGuid`/`victimGuid` on `SMSG_PARTYKILLLOG`). Guids,
 * positions and names are invented; nothing is captured from a running game.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { PartySignal } from "@wrathbench/mcp/record";
import { loadRunConfig } from "../src/config";
import { ContextBuilder } from "../src/loop";
import { SandboxHost } from "../src/sandbox/host";
import { openSessionRecord } from "../src/session-record";
import { Scratchpad } from "@wrathbench/mcp";
import { Trajectory, readTrajectory } from "../src/trajectory";
import { Watchdogs } from "../src/watchdogs";
import { openTestSession, recordDrain } from "./fixtures/v1-session";
import { tempDirs } from "./fixtures/temp-dirs";

const tempDir = tempDirs();

// ------------------------------------------------------- the sandbox child

const hosts: SandboxHost[] = [];
afterEach(async () => {
  await Promise.all(hosts.splice(0, hosts.length).map((h) => h.stop()));
});

/**
 * A real runner host with the run's session record, in a runs directory
 * where a sibling run's session is the character with guid "12": that member
 * is the deployment's own, the other three are foreign.
 */
async function makeHost(): Promise<SandboxHost> {
  const runsDir = tempDir("wrathbench-party-");
  const sibling = openTestSession(join(runsDir, "sibling-run"), Date.now());
  sibling.writer.ingest(recordDrain({ character: { guid: "12", name: "Corvin", race: 1, class: 1 } }));
  await sibling.writer.close();
  const host = new SandboxHost({
    moduleUrl: "http://worldserver:8086",
    token: "test-token",
    scratchpad: new Scratchpad(join(runsDir, "scratchpad.md")),
    snippetTimeoutMs: 5_000,
    pingGraceMs: 1_000,
    session: openSessionRecord({ runDir: join(runsDir, "run-party"), runsDir, token: "test-token", scrub: (t) => t }),
  });
  hosts.push(host);
  return host;
}

/**
 * Enter the world as guid "7". `WB_SESSION_STATE` 0xFF03,
 * `SMSG_GROUP_LIST` 0x07D (PROTOCOL.md's shape), `WB_AREA` 0xFF07 with the
 * `instanceType` the module's phase-1 change adds, `SMSG_UPDATE_OBJECT`
 * 0x0A9, `SMSG_CREATURE_QUERY_RESPONSE` 0x061, and `SMSG_PARTYKILLLOG` 0x1F5
 * in the shape the design gives it (`u64 killer, u64 victim`).
 */
const PRELUDE = `
globalThis.seq = 1;
globalThis.feed = (opcode, opcodeId, data) => {
  events.ingest(JSON.stringify({ seq: seq++, opcode, opcodeId, ts: 1000 + seq, data }));
};
const member = (name, guid) => ({ name, guid, online: true, subGroup: 0, flags: 0, roles: 0 });
globalThis.groupList = (leaderGuid) => feed("SMSG_GROUP_LIST", 0x7d, {
  groupType: 0, left: false, raid: false, subGroup: 0, memberFlags: 0, roles: 0, groupGuid: "9001", counter: 1,
  members: [member("Brenna", "11"), member("Corvin", "12"), member("Dagny", "13"), member("Edrin", "14")], leaderGuid,
});
globalThis.area = (mapId, instanceType) => feed("WB_AREA", 0xff07, { mapId, instanceType, zoneId: 40, zoneName: "", areaId: 20, areaName: "" });
feed("WB_SESSION_STATE", 0xff03, {
  character: "Aldric", guid: "7", inWorld: true,
  map: 0, x: -10986, y: 1542, z: 44, o: 1.7, level: 20,
  zoneId: 40, zoneName: "", areaId: 20, areaName: "",
});
`;

describe("the runner's host hands the loop the party records the stack wrote", () => {
  test("the login group list, the portal and a boss kill come back in order, as written, drained once", async () => {
    const host = await makeHost();
    expect((await host.evalSnippet(PRELUDE)).ok).toBe(true);
    await host.evalSnippet(`
      groupList("7");
      area(0, 0);
      area(36, 1);
      feed("SMSG_UPDATE_OBJECT", 0xa9, { blocks: 1, objects: [{ update: "create", guid: "4000", objectType: "unit",
        pos: { x: -80, y: -800, z: 20, o: 0 }, fields: { entry: 639, health: 0, maxHealth: 5000, level: 21 } }] });
      feed("SMSG_CREATURE_QUERY_RESPONSE", 0x061, { entry: 639, found: true, name: "Invented Boss", subname: "", type: 7, rank: 1 });
      feed("SMSG_PARTYKILLLOG", 0x1f5, { killerGuid: "12", victimGuid: "4000" });
      feed("SMSG_PARTYKILLLOG", 0x1f5, { killerGuid: "13", victimGuid: "4000" });
      "fed";
    `);
    const got = await host.partySignals();
    expect(got.map((s) => s.kind)).toEqual(["group", "instance", "kill", "kill"]);
    // What the gate wrote: the sibling run's character is a member by guid,
    // the three foreign players are only counted (`foreign`, which the signal
    // does not carry), and the count still says five.
    expect(got[0]).toMatchObject({ event: "joined", groupGuid: "9001", leaderGuid: "7", members: ["12"], count: 5 });
    expect(got[1]).toMatchObject({ event: "entered", map: 36, instanceType: 1 });
    expect(got[2]).toMatchObject({ killerGuid: "12", victimGuid: "4000", entry: 639, rank: 1, self: false, member: true });
    // A foreign member's kill: its guid is never written, and the signal says so with "" while `member` stands.
    expect(got[3]).toMatchObject({ killerGuid: "", victimGuid: "4000", entry: 639, rank: 1, self: false, member: true });
    expect(await host.partySignals()).toEqual([]);
  });
});

// ------------------------------------------------------------ the loop

function fakeSandbox(queue: PartySignal[][]): SandboxHost {
  const fake = {
    evalSnippet: () => Promise.resolve({ ok: true, value: "", logs: [], durationMs: 1 }),
    recentEvents: () => Promise.resolve([]),
    stateSnapshot: () => Promise.resolve({ self: { guid: "7" }, lastSeq: 1, eventCount: 1 }),
    partySignals: () => Promise.resolve(queue.shift() ?? []),
    totalRestarts: 0,
    consecutiveRestarts: 0,
    drainNotices: () => [],
    stop: () => Promise.resolve(),
  };
  return fake as unknown as SandboxHost;
}

function builder(queue: PartySignal[][], o: { drain?: boolean; watchdogs?: Watchdogs } = {}) {
  const dir = tempDir("wrathbench-party-loop-");
  let clock = 1_000_000;
  const config = { ...loadRunConfig({ driver: "stub", stateIntervalMs: 60_000 }), runId: "run-test", token: "run-test" };
  const trajectory = new Trajectory(dir);
  trajectory.writeMeta({ runId: "run-test", harnessVersion: "t", startedAt: Date.now(), config });
  const ctx = new ContextBuilder({
    config,
    sandbox: o.drain === false ? (({ partySignals: _p, ...rest }) => rest)(fakeSandbox(queue) as unknown as Record<string, unknown>) as unknown as SandboxHost : fakeSandbox(queue),
    scratchpad: new Scratchpad(join(dir, "scratchpad.md")),
    trajectory,
    watchdogs: o.watchdogs ?? new Watchdogs(config.watchdogs),
    now: () => clock,
  });
  return {
    dir,
    sample: async (): Promise<void> => {
      clock += 60_000;
      await ctx.sampleState();
    },
    /** A tick `ms` after the last: inside the `stateIntervalMs` gate when `ms` is under 60 s. */
    sampleAfter: async (ms: number): Promise<void> => {
      clock += ms;
      await ctx.sampleState();
    },
  };
}

const joinedSignal = (ts: number): PartySignal => ({ kind: "group", event: "joined", groupGuid: "9001", leaderGuid: "7", members: ["11", "12", "13", "14"], count: 5, ts, seq: ts });

describe("the loop writes what its host hands it", () => {
  test("each record carries the packet's own timestamp; a restarted child's re-read login list is not a second join", async () => {
    const { dir, sample } = builder([
      [joinedSignal(4000), { kind: "instance", event: "entered", map: 36, instanceType: 1, from: { map: 0, instanceType: 0 }, ts: 4100, seq: 41 }],
      // The child restarted: its first reading of the same party is `joined` again.
      [joinedSignal(5000), { kind: "kill", killerGuid: "7", victimGuid: "4000", entry: 639, rank: 1, self: true, member: true, ts: 5100, seq: 51 }],
      [{ kind: "group", event: "left", members: [], count: 0, ts: 6000, seq: 60 }],
    ]);
    await sample();
    await sample();
    await sample();
    const ms = readTrajectory(dir).filter((r) => r.t === "milestone");
    expect(ms.map((r) => [r["kind"], r["event"] ?? null])).toEqual([
      ["group", "joined"],
      ["instance", "entered"],
      ["kill", null],
      ["group", "left"],
    ]);
    expect(ms[0]).toMatchObject({ observedTs: 4000, count: 5, members: ["11", "12", "13", "14"] });
    expect(ms[1]).toMatchObject({ map: 36, instanceType: 1, from: { map: 0, instanceType: 0 }, observedTs: 4100 });
    expect(ms[2]).toMatchObject({ victimGuid: "4000", entry: 639, rank: 1, self: true, observedTs: 5100 });
  });

  test("a kill end is met by a member's kill the child latched, and not by a non-member's", async () => {
    const kill = (killerGuid: string, member: boolean, ts: number): PartySignal => ({
      kind: "kill",
      killerGuid,
      victimGuid: "17379390972743385188",
      entry: 639,
      rank: 1,
      self: killerGuid === "7",
      member,
      ts,
      seq: ts,
    });
    const config = loadRunConfig({ driver: "stub" });
    const outsider = new Watchdogs(config.watchdogs, Date.now, 0, { end: [{ kill: { entry: 639 } }] });
    const a = builder([[joinedSignal(4000), kill("99", false, 4100)]], { watchdogs: outsider });
    await a.sample();
    expect(outsider.check()).toBeNull();
    const ours = new Watchdogs(config.watchdogs, Date.now, 0, { end: [{ kill: { entry: 639 } }] });
    const b = builder([[joinedSignal(4000), kill("12", true, 4100)]], { watchdogs: ours });
    await b.sample();
    expect(ours.check()).toEqual({ reason: "kill-target", detail: "entry 639 killed (killer party member 12)" });
    expect(readTrajectory(b.dir).find((r) => r.t === "milestone" && r["kind"] === "kill")).toMatchObject({ member: true, entry: 639 });
  });

  test("a kill latched mid-row is written and read by the end check at the next tick, not the next state row", async () => {
    // A five-member run's boss kill: the packet reached every member at once,
    // but the kill was written on each member's own 60 s row phase, so the
    // members ended up to 22 s apart and the last after the roster had stopped it.
    const config = loadRunConfig({ driver: "stub" });
    const watchdogs = new Watchdogs(config.watchdogs, Date.now, 0, { end: [{ kill: { entry: 639 } }] });
    const boss: PartySignal = { kind: "kill", killerGuid: "12", victimGuid: "17379390972743385188", entry: 639, rank: 1, self: false, member: true, ts: 5_100, seq: 51 };
    const { dir, sample, sampleAfter } = builder([[joinedSignal(4000)], [boss]], { watchdogs });
    await sample(); // a state row, and the login group list
    expect(watchdogs.check()).toBeNull();
    await sampleAfter(5_000); // one tick later, well inside the row gate
    expect(watchdogs.check()).toEqual({ reason: "kill-target", detail: "entry 639 killed (killer party member 12)" });
    const records = readTrajectory(dir);
    // The record is the one a row-cadence drain wrote: same shape, the packet's own instant.
    expect(records.filter((r) => r.t === "milestone" && r["kind"] === "kill")).toEqual([
      expect.objectContaining({ killerGuid: "12", victimGuid: "17379390972743385188", entry: 639, rank: 1, self: false, member: true, observedTs: 5_100 }),
    ]);
    // ...and the row cadence itself did not move: still the one state row.
    expect(records.filter((r) => r.t === "state")).toHaveLength(1);
  });

  test("a kill the stack wrote without a foreign killer's guid still meets a kill end as a member's", async () => {
    const config = loadRunConfig({ driver: "stub" });
    const watchdogs = new Watchdogs(config.watchdogs, Date.now, 0, { end: [{ kill: { entry: 639 } }] });
    const kill: PartySignal = { kind: "kill", killerGuid: "", victimGuid: "17379390972743385188", entry: 639, rank: 1, self: false, member: true, ts: 4100, seq: 41 };
    const { dir, sample } = builder([[joinedSignal(4000), kill]], { watchdogs });
    await sample();
    expect(watchdogs.check()).toEqual({ reason: "kill-target", detail: "entry 639 killed (killer a party member)" });
    expect(readTrajectory(dir).find((r) => r.t === "milestone" && r["kind"] === "kill")).toMatchObject({ member: true, self: false, entry: 639 });
  });

  test("a sandbox without the drain writes no party record", async () => {
    const { dir, sample } = builder([], { drain: false });
    await sample();
    expect(readTrajectory(dir).filter((r) => r.t === "milestone" && ["group", "instance", "kill"].includes(String(r["kind"])))).toEqual([]);
  });
});
