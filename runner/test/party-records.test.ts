/**
 * The party records (docs/proposals/GROUP-PLAY.md §6): `group`, `instance`
 * and `kill` milestones, latched in the sandbox child off the packets the
 * server sends and drained by the loop's state sample.
 *
 * Three halves, all fixture-based, in the shape of `flight.test.ts`. The
 * watcher alone over a hand-built cache; the real sandbox child fed frames
 * written from module/PROTOCOL.md's tables (and, for the two the module has
 * not tapped yet, the shapes the design gives them: `instanceType` on
 * `WB_AREA`, `killerGuid`/`victimGuid` on `SMSG_PARTYKILLLOG`); and the loop
 * writing what a fake sandbox hands it. Guids, positions and names are
 * invented; nothing is captured from a running game.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { loadRunConfig } from "../src/config";
import { ContextBuilder } from "../src/loop";
import { SandboxHost } from "../src/sandbox/host";
import { PartyWatcher, type PartySignal, type PartyWatchState } from "../src/sandbox/party-watch";
import { Scratchpad } from "../src/scratchpad";
import { Trajectory, readTrajectory } from "../src/trajectory";
import { Watchdogs } from "../src/watchdogs";
import { tempDirs } from "./fixtures/temp-dirs";

const tempDir = tempDirs();

// ------------------------------------------------------------ the watcher

/** A cache the test sets by hand. */
function fakeState(): PartyWatchState & {
  g: ReturnType<PartyWatchState["group"]>;
  objects: Map<string, { entry: number | undefined; type: string | undefined }>;
  ranks: Map<number, number>;
} {
  const s = {
    g: undefined as ReturnType<PartyWatchState["group"]>,
    objects: new Map<string, { entry: number | undefined; type: string | undefined }>(),
    ranks: new Map<number, number>(),
    group: () => s.g,
    selfGuid: () => "7",
    objectOf: (guid: string) => s.objects.get(guid),
    rankOf: (entry: number) => s.ranks.get(entry),
  };
  return s;
}

let seq = 0;
const ev = (opcode: string, data: unknown = {}): { opcode: string; ts: number; seq: number; data: unknown } => ({ opcode, ts: 1000 + ++seq, seq, data });
const inGroup = (members: string[], leader = "7", groupGuid = "9001") => ({
  inGroup: true,
  groupGuid,
  leaderGuid: leader,
  members: members.map((guid) => ({ guid })),
});

describe("the party watcher", () => {
  test("a login list is joined; a new member or leader is changed; leaving is left; nothing repeats", () => {
    const st = fakeState();
    const w = new PartyWatcher(st);
    st.g = inGroup(["11", "12", "13", "14"]);
    w.observe(ev("SMSG_GROUP_LIST"));
    w.observe(ev("SMSG_GROUP_LIST")); // the same list again: nothing
    st.g = inGroup(["11", "12", "13", "14"], "11");
    w.observe(ev("SMSG_GROUP_SET_LEADER"));
    st.g = { inGroup: false, groupGuid: undefined, leaderGuid: undefined, members: [] };
    w.observe(ev("SMSG_GROUP_DESTROYED"));
    const got = w.drain();
    expect(got.map((s) => (s.kind === "group" ? s.event : s.kind))).toEqual(["joined", "changed", "left"]);
    expect(got[0]).toMatchObject({ kind: "group", groupGuid: "9001", leaderGuid: "7", members: ["11", "12", "13", "14"], count: 5 });
    expect(got[1]).toMatchObject({ leaderGuid: "11" });
    expect(got[2]).toMatchObject({ members: [], count: 0 });
    expect(got[2]).not.toHaveProperty("groupGuid");
    expect(w.drain()).toEqual([]);
  });

  test("a first reading outside a group seeds silently", () => {
    const st = fakeState();
    const w = new PartyWatcher(st);
    st.g = { inGroup: false, groupGuid: undefined, leaderGuid: undefined, members: [] };
    w.observe(ev("SMSG_GROUP_LIST"));
    expect(w.drain()).toEqual([]);
  });

  test("an instance is a map change whose instance type changed, seeded silently, and silent with no instanceType", () => {
    const st = fakeState();
    const w = new PartyWatcher(st);
    // No instanceType: a module that does not serve it yet.
    w.observe(ev("WB_AREA", { mapId: 0, zoneId: 40, zoneName: "", areaId: 20, areaName: "" }));
    w.observe(ev("WB_AREA", { mapId: 36, zoneId: 1581, zoneName: "", areaId: 1581, areaName: "" }));
    expect(w.drain()).toEqual([]);
    // Seeded in Moonbrook, a subzone change on the same map, then the portal.
    w.observe(ev("WB_AREA", { mapId: 0, instanceType: 0, zoneId: 40, zoneName: "", areaId: 20, areaName: "" }));
    w.observe(ev("WB_AREA", { mapId: 0, instanceType: 0, zoneId: 40, zoneName: "", areaId: 21, areaName: "" }));
    w.observe(ev("WB_AREA", { mapId: 36, instanceType: 1, zoneId: 1581, zoneName: "", areaId: 1581, areaName: "" }));
    // Out by the far trigger, and a reattach that says where the character is.
    w.observe(ev("WB_SESSION_STATE", { map: 0, instanceType: 0, x: 0, y: 0, z: 0 }));
    const got = w.drain();
    expect(got).toEqual([
      expect.objectContaining({ kind: "instance", event: "entered", map: 36, instanceType: 1, from: { map: 0, instanceType: 0 } }),
      expect.objectContaining({ kind: "instance", event: "left", map: 0, instanceType: 0, from: { map: 36, instanceType: 1 } }),
    ]);
  });

  test("a map change inside one instance type writes nothing (a tram, a continent hop)", () => {
    const st = fakeState();
    const w = new PartyWatcher(st);
    w.observe(ev("WB_AREA", { mapId: 0, instanceType: 0 }));
    w.observe(ev("WB_AREA", { mapId: 1, instanceType: 0 }));
    w.observe(ev("WB_AREA", { mapId: 369, instanceType: 0 }));
    expect(w.drain()).toEqual([]);
  });

  test("a kill of rank 1 or above is recorded with its entry and rank; rank 0 and players are not; an unanswered rank is", () => {
    const st = fakeState();
    const w = new PartyWatcher(st);
    st.objects.set("4000", { entry: 639, type: "unit" });
    st.ranks.set(639, 1);
    st.objects.set("4001", { entry: 299, type: "unit" });
    st.ranks.set(299, 0);
    st.objects.set("4002", { entry: 657, type: "unit" }); // no creature query answered
    st.objects.set("42", { entry: undefined, type: "player" });
    w.observe(ev("SMSG_PARTYKILLLOG", { killerGuid: "7", victimGuid: "4000" }));
    w.observe(ev("SMSG_PARTYKILLLOG", { killerGuid: "11", victimGuid: "4001" }));
    w.observe(ev("SMSG_PARTYKILLLOG", { killer: 11, victim: "4002" }));
    w.observe(ev("SMSG_PARTYKILLLOG", { killerGuid: "11", victimGuid: "42" }));
    w.observe(ev("SMSG_PARTYKILLLOG", { killerGuid: "not a guid" }));
    const got = w.drain() as Extract<PartySignal, { kind: "kill" }>[];
    expect(got.map((k) => [k.victimGuid, k.entry, k.rank, k.self])).toEqual([
      ["4000", 639, 1, true],
      ["4002", 657, undefined, false],
    ]);
    expect(got[1]!.killerGuid).toBe("11");
  });
});

// ------------------------------------------------------- the sandbox child

const hosts: SandboxHost[] = [];
afterEach(async () => {
  await Promise.all(hosts.splice(0, hosts.length).map((h) => h.stop()));
});

function makeHost(): SandboxHost {
  const dir = tempDir("wrathbench-party-");
  const host = new SandboxHost({
    moduleUrl: "http://worldserver:8086",
    token: "test-token",
    scratchpad: new Scratchpad(join(dir, "scratchpad.md")),
    snippetTimeoutMs: 5_000,
    pingGraceMs: 1_000,
  });
  hosts.push(host);
  return host;
}

/**
 * Enter the world as guid "7" in Moonbrook. `WB_SESSION_STATE` 0xFF03,
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

describe("sandbox child: the party records latched from the events", () => {
  test("the login group list, the portal and a boss kill come back in order, drained once", async () => {
    const host = makeHost();
    expect((await host.evalSnippet(PRELUDE)).ok).toBe(true);
    await host.evalSnippet(`
      groupList("7");
      area(0, 0);
      area(36, 1);
      feed("SMSG_UPDATE_OBJECT", 0xa9, { blocks: 1, objects: [{ update: "create", guid: "4000", objectType: "unit",
        pos: { x: -80, y: -800, z: 20, o: 0 }, fields: { entry: 639, health: 0, maxHealth: 5000, level: 21 } }] });
      feed("SMSG_CREATURE_QUERY_RESPONSE", 0x061, { entry: 639, found: true, name: "Invented Boss", subname: "", type: 7, rank: 1 });
      feed("SMSG_PARTYKILLLOG", 0x1f5, { killerGuid: "12", victimGuid: "4000" });
      "fed";
    `);
    const got = await host.partySignals();
    expect(got.map((s) => s.kind)).toEqual(["group", "instance", "kill"]);
    expect(got[0]).toMatchObject({ event: "joined", groupGuid: "9001", leaderGuid: "7", members: ["11", "12", "13", "14"], count: 5 });
    expect(got[1]).toMatchObject({ event: "entered", map: 36, instanceType: 1 });
    expect(got[2]).toMatchObject({ killerGuid: "12", victimGuid: "4000", entry: 639, rank: 1, self: false });
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

function builder(queue: PartySignal[][], o: { drain?: boolean } = {}) {
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
    watchdogs: new Watchdogs(config.watchdogs),
    now: () => clock,
  });
  return {
    dir,
    sample: async (): Promise<void> => {
      clock += 60_000;
      await ctx.sampleState();
    },
  };
}

const joinedSignal = (ts: number): PartySignal => ({ kind: "group", event: "joined", groupGuid: "9001", leaderGuid: "7", members: ["11", "12", "13", "14"], count: 5, ts, seq: ts });

describe("the loop writes what the child latched", () => {
  test("each record carries the packet's own timestamp; a restarted child's re-read login list is not a second join", async () => {
    const { dir, sample } = builder([
      [joinedSignal(4000), { kind: "instance", event: "entered", map: 36, instanceType: 1, from: { map: 0, instanceType: 0 }, ts: 4100, seq: 41 }],
      // The child restarted: its first reading of the same party is `joined` again.
      [joinedSignal(5000), { kind: "kill", killerGuid: "7", victimGuid: "4000", entry: 639, rank: 1, self: true, ts: 5100, seq: 51 }],
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

  test("a sandbox without the drain writes no party record", async () => {
    const { dir, sample } = builder([], { drain: false });
    await sample();
    expect(readTrajectory(dir).filter((r) => r.t === "milestone" && ["group", "instance", "kill"].includes(String(r["kind"])))).toEqual([]);
  });
});
