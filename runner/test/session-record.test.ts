/**
 * The run's session record as the runner opens it (`runner/src/session-record.ts`):
 * `RecordSignals`, the bridge that turns the event rows the stack wrote into
 * the death, flight and party signals the loop drains and hands each written
 * movement intention to the trajectory's mirror; and `openSessionRecord`, which
 * puts the record inside the run, names it by the token's fingerprint, never
 * writes the token, and knows the deployment's own characters from the
 * sibling runs' records.
 *
 * Rows are hand-written in the record's shapes (`@wrathbench/mcp/record`);
 * guids and names are invented.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tokenFingerprint } from "@wrathbench/mcp/module-auth";
import { SessionReader, type CallRow, type EventRow, type NearbyRow, type SessionFile, type TraceRow } from "@wrathbench/mcp/record";
import { RecordSignals, SESSION_DIR, openSessionRecord, removeSessionRing, sessionDirOf, type RecordedMoveRow } from "../src/session-record";
import { openTestSession, recordDrain, recordedMove } from "./fixtures/v1-session";
import { tempDirs } from "./fixtures/temp-dirs";

const tempDir = tempDirs();

const T = 1_760_000_100_000;
const POS = { map: 0, x: -6572, y: 405, z: 387 };

describe("RecordSignals", () => {
  test("death, release and resurrect rows come out as the loop's death signals, in order", () => {
    const s = new RecordSignals();
    s.onRows("events", [
      { ts: T, kind: "death", seq: 9, position: { ...POS, source: "death_spot" }, zone: 1, area: 132, released: false },
      { ts: T + 10, kind: "release", seq: 12, graveyard: { map: 0, x: -6164, y: 336, z: 399 } },
      { ts: T + 20, kind: "resurrect", seq: 20 },
      // A death the recorder knew less about: only what it had is carried.
      { ts: T + 30, kind: "death", seq: 31 },
    ] satisfies EventRow[]);
    expect(s.drainDeath()).toEqual([
      { kind: "death", ts: T, seq: 9, position: { ...POS, source: "death_spot" }, zone: 1, area: 132, released: false },
      { kind: "release", ts: T + 10, seq: 12, graveyard: { map: 0, x: -6164, y: 336, z: 399 } },
      { kind: "resurrect", ts: T + 20, seq: 20 },
      { kind: "death", ts: T + 30, seq: 31 },
    ]);
    // Destructive, and nothing leaked into the other queues.
    expect(s.drainDeath()).toEqual([]);
    expect(s.drainFlight()).toEqual([]);
    expect(s.drainParty()).toEqual([]);
  });

  test("taxi rows are flight signals with the flip's own position and area; a row with no seq says -1", () => {
    const s = new RecordSignals();
    s.onRows("events", [
      { ts: T, kind: "taxi", seq: 3, position: POS, zone: 1537, area: 1537 },
      { ts: T + 60_000, kind: "taxi_landed", position: { map: 0, x: -5421, y: -2930, z: 351.5 }, area: 38 },
    ] satisfies EventRow[]);
    expect(s.drainFlight()).toEqual([
      { kind: "taxi", ts: T, seq: 3, position: POS, zone: 1537, area: 1537 },
      { kind: "taxi_landed", ts: T + 60_000, seq: -1, position: { map: 0, x: -5421, y: -2930, z: 351.5 }, area: 38 },
    ]);
    expect(s.drainFlight()).toEqual([]);
  });

  test("group, instance and kill rows are party signals; a foreign killer's missing guid is \"\", whose kill it was still said", () => {
    const s = new RecordSignals();
    s.onRows("events", [
      { ts: T, kind: "group", seq: 4, event: "joined", groupGuid: "9001", leaderGuid: "7", members: ["12"], foreign: 3, count: 5 },
      // A foreign leader is not written: absent, not invented.
      { ts: T + 1, kind: "group", seq: 5, event: "changed", groupGuid: "9001", members: ["12"], foreign: 3, count: 5 },
      { ts: T + 2, kind: "instance", seq: 6, event: "entered", map: 36, instanceType: 1, from: { map: 0, instanceType: 0 } },
      { ts: T + 3, kind: "kill", seq: 7, killerGuid: "12", victimGuid: "4000", entry: 639, rank: 1, self: false, member: true },
      { ts: T + 4, kind: "kill", seq: 8, victimGuid: "4001", entry: 639, rank: 1, self: false, member: true },
      { ts: T + 5, kind: "group", event: "left", members: [], foreign: 0, count: 0 },
    ] satisfies EventRow[]);
    expect(s.drainParty()).toEqual([
      { kind: "group", event: "joined", groupGuid: "9001", leaderGuid: "7", members: ["12"], count: 5, ts: T, seq: 4 },
      { kind: "group", event: "changed", groupGuid: "9001", members: ["12"], count: 5, ts: T + 1, seq: 5 },
      { kind: "instance", event: "entered", map: 36, instanceType: 1, from: { map: 0, instanceType: 0 }, ts: T + 2, seq: 6 },
      { kind: "kill", killerGuid: "12", victimGuid: "4000", entry: 639, rank: 1, self: false, member: true, ts: T + 3, seq: 7 },
      { kind: "kill", killerGuid: "", victimGuid: "4001", entry: 639, rank: 1, self: false, member: true, ts: T + 4, seq: 8 },
      { kind: "group", event: "left", members: [], count: 0, ts: T + 5, seq: -1 },
    ]);
    expect(s.drainParty()).toEqual([]);
  });

  test("every other event kind, and every other stream, gives no signal", () => {
    const s = new RecordSignals();
    s.onRows("events", [
      { ts: T, kind: "level", from: 4, to: 5, xp: 0 },
      { ts: T, kind: "zone", to: 40 },
      { ts: T, kind: "quest", id: 4100 },
    ] satisfies EventRow[]);
    s.onRows("trace", [{ ts: T, kind: "pos", map: 0, x: 1, y: 2, z: 3, o: 0 }] satisfies TraceRow[]);
    s.onRows("nearby", [{ ts: T, kind: "tick" }] satisfies NearbyRow[]);
    expect([s.drainDeath(), s.drainFlight(), s.drainParty()]).toEqual([[], [], []]);
  });

  test("onMove is handed each move row of the calls stream, and nothing else", () => {
    const s = new RecordSignals();
    const moves: RecordedMoveRow[] = [];
    // With no handler set, a move row is simply dropped.
    const move: RecordedMoveRow = { ts: T, kind: "move", origin: { type: "tool", call: T - 5 }, at: T, moveId: null, map: 0, x: 7, y: 8, z: 9, target: null, status: null };
    s.onRows("calls", [move]);
    s.onMove = (m) => moves.push(m);
    s.onRows("calls", [
      { ts: T - 5, kind: "call", id: T - 5, origin: { type: "tool" }, tool: "run_snippet", args: {} },
      move,
      { ts: T + 900, kind: "move", origin: { type: "routine", call: T - 5 }, at: T, moveId: 4, map: 0, x: 7, y: 8, z: 9, target: null, status: "arrived" },
      { ts: T + 1000, kind: "result", id: T - 5, text: "ok", error: false, durationMs: 1005 },
    ] satisfies CallRow[]);
    // A row in another stream that happens to say "move" is not one.
    s.onRows("events", [{ ts: T, kind: "move" } as unknown as EventRow]);
    expect(moves.map((m) => [m.ts, m.moveId, m.status])).toEqual([
      [T, null, null],
      [T + 900, 4, "arrived"],
    ]);
  });

  test("an undrained backlog keeps the newest 256 of each", () => {
    const s = new RecordSignals();
    const rows: EventRow[] = [];
    for (let i = 0; i < 300; i++) rows.push({ ts: T + i, kind: "resurrect", seq: i }, { ts: T + i, kind: "taxi", seq: i }, { ts: T + i, kind: "trade", seq: i });
    for (let i = 0; i < 300; i++) rows.push({ ts: T + i, kind: "instance", seq: i, event: "entered", map: 36, instanceType: 1, from: { map: 0, instanceType: 0 } });
    s.onRows("events", rows);
    for (const drained of [s.drainDeath(), s.drainFlight(), s.drainParty()]) {
      expect(drained).toHaveLength(256);
      expect(drained[0]!.seq).toBe(44);
      expect(drained.at(-1)!.seq).toBe(299);
    }
  });
});

/** Every file under `dir`, recursively. */
function filesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...filesUnder(p));
    else out.push(p);
  }
  return out;
}

describe("openSessionRecord", () => {
  const TOKEN = "tok-3f9a1c0b7e2d4a61-invented-session-token";

  test("the record is the run's session/, named by the token's fingerprint, and the token is in no file", () => {
    const runsDir = tempDir("wrathbench-session-record-");
    const runDir = join(runsDir, "run-a");
    // The run's scrub strikes another secret; the token is struck by the record
    // itself, because openSessionRecord hands it to the writer, not by this.
    const LEASED = "leased-secret-0a1b2c3d4e5f";
    const scrub = (text: string): string => text.split(LEASED).join("[redacted]");
    const { writer, signals } = openSessionRecord({ runDir, runsDir, token: TOKEN, scrub });
    expect(writer.dir).toBe(join(runDir, SESSION_DIR));
    expect(sessionDirOf(runDir)).toBe(join(runDir, "session"));
    expect(signals).toBeInstanceOf(RecordSignals);
    const session = JSON.parse(readFileSync(join(runDir, "session", "session.json"), "utf8")) as SessionFile;
    expect(session.id).toBe(tokenFingerprint(TOKEN));
    expect(session.id).toMatch(/^[0-9a-f]{16}$/);

    // A call whose arguments and answer both carry the token, a drain with a move: everything written is scrubbed.
    const id = writer.call("run_snippet", { code: `console.log("${TOKEN}")` });
    writer.result(id, { text: `printed ${TOKEN} ${LEASED}` });
    writer.ingest(recordDrain({ moves: [recordedMove({ ts: Date.now(), x: 1, y: 2, z: 3 })] }));
    const calls = new SessionReader(writer.dir).rows("calls");
    expect(calls.map((r) => r.kind)).toEqual(["key", "call", "result", "move"]);
    expect((calls[2] as Extract<CallRow, { kind: "result" }>).text).toBe("printed [redacted] [redacted]");
    const files = filesUnder(writer.dir);
    expect(files.map((f) => f.slice(writer.dir.length + 1)).sort()).toEqual(expect.arrayContaining(["live.json", "session.json"]));
    for (const f of files) expect([f, readFileSync(f, "utf8").includes(TOKEN)]).toEqual([f, false]);
  });

  test("the move rows written reach onMove after the gate, as run.ts mirrors them", () => {
    const runsDir = tempDir("wrathbench-session-record-move-");
    const { writer, signals } = openSessionRecord({ runDir: join(runsDir, "run-a"), runsDir, token: TOKEN, scrub: (t) => t });
    const seen: RecordedMoveRow[] = [];
    signals.onMove = (m) => seen.push(m);
    const now = Date.now();
    writer.ingest(recordDrain({ moves: [recordedMove({ ts: now, moveId: 3, map: 0, x: 7, y: 8, z: 9 }), recordedMove({ ts: now + 400, at: now, moveId: 3, map: 0, x: 7, y: 8, z: 9, status: "arrived" })] }));
    expect(seen.map((m) => [m.ts, m.at, m.moveId, m.status, m.x])).toEqual([
      [now, now, 3, null, 7],
      [now + 400, now, 3, "arrived", 7],
    ]);
  });

  test("own: a sibling run's character is a member by guid; any other player is only counted, and a foreign killer has no guid", async () => {
    const runsDir = tempDir("wrathbench-session-record-own-");
    // The sibling: another run of this deployment, its character "12".
    const sibling = openTestSession(join(runsDir, "run-sibling"), Date.now());
    sibling.writer.ingest(recordDrain({ character: { guid: "12", name: "Corvin", race: 1, class: 1 } }));
    await sibling.writer.close();
    // Not a run's record: a stray session.json elsewhere names nobody.
    mkdirSync(join(runsDir, "not-a-run"), { recursive: true });
    writeFileSync(join(runsDir, "not-a-run", "session.json"), JSON.stringify({ format: "wrath-session/1", character: { guid: "13" } }));

    const { writer, signals } = openSessionRecord({ runDir: join(runsDir, "run-a"), runsDir, token: TOKEN, scrub: (t) => t });
    const now = Date.now();
    writer.ingest(
      recordDrain({
        events: [
          { ts: now, kind: "group", seq: 1, event: "joined", groupGuid: "9001", leaderGuid: "13", members: ["12", "13"], foreign: 0, count: 3 },
          { ts: now + 1, kind: "kill", seq: 2, killerGuid: "12", victimGuid: "4000", entry: 639, rank: 1, self: false, member: true },
          { ts: now + 2, kind: "kill", seq: 3, killerGuid: "13", victimGuid: "4001", entry: 639, rank: 1, self: false, member: true },
        ],
      }),
    );
    const written = new SessionReader(writer.dir).rows("events").filter((r) => r.kind !== "key");
    expect(written).toEqual([
      // The foreign leader is left out, the foreign member counted.
      { ts: now, kind: "group", seq: 1, event: "joined", groupGuid: "9001", members: ["12"], foreign: 1, count: 3 },
      { ts: now + 1, kind: "kill", seq: 2, killerGuid: "12", victimGuid: "4000", entry: 639, rank: 1, self: false, member: true },
      { ts: now + 2, kind: "kill", seq: 3, victimGuid: "4001", entry: 639, rank: 1, self: false, member: true },
    ]);
    // And the loop is handed exactly what was written.
    expect(signals.drainParty()).toEqual([
      { kind: "group", event: "joined", groupGuid: "9001", members: ["12"], count: 3, ts: now, seq: 1 },
      { kind: "kill", killerGuid: "12", victimGuid: "4000", entry: 639, rank: 1, self: false, member: true, ts: now + 1, seq: 2 },
      { kind: "kill", killerGuid: "", victimGuid: "4001", entry: 639, rank: 1, self: false, member: true, ts: now + 2, seq: 3 },
    ]);
    expect(readFileSync(join(writer.dir, "events", readdirSync(join(writer.dir, "events"))[0]!), "utf8")).not.toContain('"13"');
  });
});

describe("removeSessionRing", () => {
  test("removes the run's session/nearby and nothing else; never throws", () => {
    const runsDir = tempDir("wrathbench-session-ring-");
    const runDir = join(runsDir, "run-a");
    const { writer } = openSessionRecord({ runDir, runsDir, token: "tok-ring", scrub: (t) => t });
    const now = Date.now();
    writer.ingest(
      recordDrain({
        trace: [{ ts: now, kind: "pos", map: 0, x: 1, y: 2, z: 3, o: 0 }],
        nearby: [{ ts: now, kind: "key", self: { guid: "7", map: 0, target: null, down: false }, units: [] }],
        through: now,
      }),
    );
    expect(existsSync(join(runDir, "session", "nearby"))).toBe(true);
    removeSessionRing(runDir);
    expect(existsSync(join(runDir, "session", "nearby"))).toBe(false);
    expect(existsSync(join(runDir, "session", "trace"))).toBe(true);
    expect(existsSync(join(runDir, "session", "session.json"))).toBe(true);
    // Again, and on a run with no record at all.
    expect(() => removeSessionRing(runDir)).not.toThrow();
    expect(() => removeSessionRing(join(runsDir, "no-such-run"))).not.toThrow();
  });
});
