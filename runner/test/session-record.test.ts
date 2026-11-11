/**
 * The run's session record as the runner opens it (`runner/src/session-record.ts`):
 * `RecordSignals`, which hands the loop each kill row the stack wrote, for the
 * watchdogs' kill end; and `openSessionRecord`, which
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
import { RecordSignals, SESSION_DIR, openSessionRecord, removeSessionRing, sessionDirOf } from "../src/session-record";
import { partyConfigSchema, partyOwnGuids, type PartyConfig } from "../src/party";
import { openTestSession, recordDrain, recordedMove } from "./fixtures/v1-session";
import { tempDirs } from "./fixtures/temp-dirs";

const tempDir = tempDirs();

const T = 1_760_000_100_000;
const POS = { map: 0, x: -6572, y: 405, z: 387 };

describe("RecordSignals", () => {
  test("kill rows are the loop's kill signals, in order; a foreign killer's missing guid is \"\", whose kill it was still said", () => {
    const s = new RecordSignals();
    s.onRows("events", [
      { ts: T, kind: "group", seq: 4, event: "joined", groupGuid: "9001", leaderGuid: "7", members: ["12"], foreign: 3, count: 5 },
      { ts: T + 3, kind: "kill", seq: 7, killerGuid: "12", victimGuid: "4000", entry: 639, rank: 1, self: false, member: true },
      { ts: T + 4, kind: "kill", seq: 8, victimGuid: "4001", entry: 639, rank: 1, self: false, member: true },
      { ts: T + 5, kind: "kill", victimGuid: "4002", self: true, member: true },
    ] satisfies EventRow[]);
    expect(s.drainKills()).toEqual([
      { kind: "kill", killerGuid: "12", victimGuid: "4000", entry: 639, rank: 1, self: false, member: true, ts: T + 3, seq: 7 },
      { kind: "kill", killerGuid: "", victimGuid: "4001", entry: 639, rank: 1, self: false, member: true, ts: T + 4, seq: 8 },
      { kind: "kill", killerGuid: "", victimGuid: "4002", self: true, member: true, ts: T + 5, seq: -1 },
    ]);
    expect(s.drainKills()).toEqual([]);
  });

  test("every other event kind, and every other stream, gives no signal", () => {
    const s = new RecordSignals();
    s.onRows("events", [
      { ts: T, kind: "level", from: 4, to: 5, xp: 0 },
      { ts: T, kind: "death", seq: 9, position: { ...POS, source: "death_spot" } },
      { ts: T, kind: "quest", id: 4100 },
    ] satisfies EventRow[]);
    s.onRows("trace", [{ ts: T, kind: "pos", map: 0, x: 1, y: 2, z: 3, o: 0 }] satisfies TraceRow[]);
    s.onRows("nearby", [{ ts: T, kind: "tick" }] satisfies NearbyRow[]);
    s.onRows("calls", [{ ts: T, kind: "move", origin: { type: "tool", call: T - 5 }, at: T, moveId: null, map: 0, x: 7, y: 8, z: 9, target: null, status: null }] satisfies CallRow[]);
    expect(s.drainKills()).toEqual([]);
  });

  test("an undrained backlog keeps the newest 256", () => {
    const s = new RecordSignals();
    const rows: EventRow[] = [];
    for (let i = 0; i < 300; i++) rows.push({ ts: T + i, kind: "kill", seq: i, victimGuid: String(4000 + i), self: true, member: true });
    s.onRows("events", rows);
    const drained = s.drainKills();
    expect(drained).toHaveLength(256);
    expect(drained[0]!.seq).toBe(44);
    expect(drained.at(-1)!.seq).toBe(299);
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
    // And the loop is handed exactly the kills written.
    expect(signals.drainKills()).toEqual([
      { kind: "kill", killerGuid: "12", victimGuid: "4000", entry: 639, rank: 1, self: false, member: true, ts: now + 1, seq: 2 },
      { kind: "kill", killerGuid: "", victimGuid: "4001", entry: 639, rank: 1, self: false, member: true, ts: now + 2, seq: 3 },
    ]);
    expect(readFileSync(join(writer.dir, "events", readdirSync(join(writer.dir, "events"))[0]!), "utf8")).not.toContain('"13"');
  });
});

describe("openSessionRecord: a party's members are own from the first row", () => {
  const MEMBERS = ["tank", "healer", "rogue", "mage", "priest"];
  // The guids the stager reported and the launch carried into each member's config.
  const GUIDS = ["4100", "4101", "4102", "4103", "4104"];
  const FOREIGN = "9999";
  const config: PartyConfig = partyConfigSchema.parse({
    id: "party-stem",
    member: "tank",
    role: "tank",
    size: 5,
    members: MEMBERS.map((m, i) => ({ member: m, role: i === 0 ? "tank" : i === 1 ? "healer" : "damage", runId: `party-stem-${m}`, account: `PARTY${i + 1}`, character: `Member${"abcde"[i]}`, guid: GUIDS[i] })),
  });

  /** Member `i` opens its record, names its character, and writes a group row naming every other member and one stranger. */
  function memberWrites(runsDir: string, i: number, ownGuids: readonly string[], now: number): EventRow[] {
    const { writer } = openSessionRecord({ runDir: join(runsDir, `party-stem-${MEMBERS[i]}`), runsDir, ownGuids, token: `tok-party-member-${i}-invented`, scrub: (t) => t });
    writer.ingest(recordDrain({ character: { guid: GUIDS[i]!, name: `Member${"abcde"[i]}`, race: 1, class: 1 } }));
    const others = GUIDS.filter((_, j) => j !== i);
    writer.ingest(recordDrain({ events: [{ ts: now, kind: "group", seq: 1, event: "joined", groupGuid: "9001", leaderGuid: GUIDS[0]!, members: [...others, FOREIGN], foreign: 0, count: 6 }] }));
    return new SessionReader(writer.dir).rows("events").filter((r) => r.kind === "group");
  }

  test("staggered starts: each member's group row, written before the later members have a session.json, keeps all four others and counts the stranger", () => {
    const runsDir = tempDir("wrathbench-session-record-party-");
    const seed = partyOwnGuids(config);
    expect(seed).toEqual(GUIDS);
    const now = Date.now();
    for (let i = 0; i < MEMBERS.length; i++) {
      // Members after i have not launched: no run directory, no session.json.
      for (let j = i + 1; j < MEMBERS.length; j++) expect(existsSync(join(runsDir, `party-stem-${MEMBERS[j]}`, SESSION_DIR, "session.json"))).toBe(false);
      const rows = memberWrites(runsDir, i, seed, now + i);
      expect(rows).toEqual([
        { ts: now + i, kind: "group", seq: 1, event: "joined", groupGuid: "9001", leaderGuid: GUIDS[0]!, members: GUIDS.filter((_, j) => j !== i), foreign: 1, count: 6 },
      ]);
    }
  });

  test("a resumed member's seed comes from its config as meta.json kept it", () => {
    const runsDir = tempDir("wrathbench-session-record-party-resume-");
    const reloaded = partyConfigSchema.parse(JSON.parse(JSON.stringify(config)));
    const rows = memberWrites(runsDir, 2, partyOwnGuids(reloaded), Date.now());
    expect(rows[0]).toMatchObject({ members: ["4100", "4101", "4103", "4104"], foreign: 1 });
  });

  test("without the seed the first member counts the others foreign, which is what the seed is for", () => {
    const runsDir = tempDir("wrathbench-session-record-party-unseeded-");
    const rows = memberWrites(runsDir, 0, [], Date.now());
    expect(rows[0]).toMatchObject({ members: [], foreign: 5 });
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
