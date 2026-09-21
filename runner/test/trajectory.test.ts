import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadRunConfig } from "../src/config";
import { Trajectory, readMeta, readTrajectory } from "../src/trajectory";

function tempRunDir(): string {
  return mkdtempSync(join(tmpdir(), "wrathbench-traj-"));
}

describe("Trajectory", () => {
  test("appends JSONL records with timestamps and survives bigints", () => {
    const dir = tempRunDir();
    let t = 100;
    const traj = new Trajectory(dir, { now: () => t });
    traj.append({ t: "snippet", code: "1n + 1n", guid: 123456789012345678901n });
    t = 200;
    traj.append({ t: "snippet_result", ok: true });
    traj.close();
    const records = readTrajectory(dir);
    expect(records).toHaveLength(2);
    expect(records[0]!.ts).toBe(100);
    expect(records[0]!["guid"]).toBe("123456789012345678901");
    expect(records[1]!.ts).toBe(200);
  });

  test("meta round-trips and lands in sqlite", () => {
    const dir = tempRunDir();
    const traj = new Trajectory(dir);
    const config = loadRunConfig({ runId: "run-x", driver: "stub", model: "irrelevant" });
    traj.writeMeta({ runId: "run-x", harnessVersion: "0.0.0-test", startedAt: 5, config });
    const meta = readMeta(dir);
    expect(meta?.runId).toBe("run-x");
    expect(meta?.config.driver).toBe("stub");
    const row = traj.runRow("run-x");
    expect(row?.["harness_version"]).toBe("0.0.0-test");
    traj.close();
  });

  test("setCharacter records the name the model actually created", () => {
    // The launch config carries only the harness's suggestion. Three readers,
    // three places: the runs page and the positions feed read `run.character`,
    // a resumed runner reads meta.json before any database is open, and the
    // trajectory is the record of when it changed.
    const dir = tempRunDir();
    const traj = new Trajectory(dir);
    const config = loadRunConfig({ runId: "run-c", driver: "stub", model: "irrelevant", character: "Fleetsonnet" });
    traj.writeMeta({ runId: "run-c", harnessVersion: "0.0.0-test", startedAt: 5, config });
    traj.setCharacter("run-c", "Grimjaw");
    expect(traj.runRow("run-c")?.["character"]).toBe("Grimjaw");
    expect(readMeta(dir)?.config.character).toBe("Grimjaw");
    // The rest of the stored config is untouched, and startedAt is not restamped.
    expect(readMeta(dir)?.startedAt).toBe(5);
    expect(readMeta(dir)?.config.driver).toBe("stub");
    expect(readTrajectory(dir).some((r) => r.t === "character" && r["character"] === "Grimjaw")).toBe(true);
    traj.close();
  });

  // both were derivable from config_json; a column means the
  // listing reads a fact rather than re-deriving a rule that could drift.
  test("writes the character and the platform as run columns", () => {
    const dir = tempRunDir();
    const traj = new Trajectory(dir);
    const config = loadRunConfig({
      runId: "run-p",
      driver: "openai",
      model: "some/model",
      character: "Grimbold",
      apiBase: "https://openrouter.ai/api/v1",
    });
    traj.writeMeta({ runId: "run-p", harnessVersion: "0.0.0-test", startedAt: 5, config });
    const row = traj.runRow("run-p");
    expect(row?.["character"]).toBe("Grimbold");
    expect(row?.["platform"]).toBe("openrouter");
    traj.close();
  });

  // The one migration left: a 0.4-1..0.4-5 run.sqlite predates these two columns.
  test("adds character and platform to a run table written without them", () => {
    const dir = tempRunDir();
    const db = new Database(join(dir, "run.sqlite"));
    db.exec(`CREATE TABLE run (
      run_id TEXT PRIMARY KEY, harness_version TEXT NOT NULL, started_at INTEGER NOT NULL,
      ended_at INTEGER, driver TEXT, shakeout TEXT, model TEXT, objective TEXT,
      termination_reason TEXT, termination_detail TEXT, pause_reason TEXT, config_json TEXT NOT NULL)`);
    db.close();
    const traj = new Trajectory(dir);
    const config = loadRunConfig({ runId: "run-old", driver: "stub", model: "irrelevant", character: "Elsie" });
    traj.writeMeta({ runId: "run-old", harnessVersion: "0.0.0-test", startedAt: 5, config });
    expect(traj.runRow("run-old")?.["character"]).toBe("Elsie");
    traj.close();
  });

  test("periodic state goes to jsonl and sqlite", () => {
    const dir = tempRunDir();
    let t = 0;
    const traj = new Trajectory(dir, { now: () => ++t });
    traj.recordState("run-y", { level: 2, map: 0, x: 1, y: 2, z: 3, eventCount: 9, lastSeq: 8 });
    traj.recordState("run-y", { level: 3 });
    const rows = traj.stateRows("run-y");
    expect(rows).toHaveLength(2);
    expect(rows[0]!["level"]).toBe(2);
    expect(rows[1]!["level"]).toBe(3);
    expect(readTrajectory(dir).filter((r) => r.t === "state")).toHaveLength(2);
    traj.close();
  });

  test("money and quests completed are recorded, and stay null when unobserved", () => {
    const dir = tempRunDir();
    const traj = new Trajectory(dir);
    traj.recordState("run-m", { level: 4, money: 12345, questsCompleted: 2 });
    traj.recordState("run-m", { level: 4 });
    const rows = traj.stateRows("run-m");
    expect(rows[0]!["money"]).toBe(12345);
    expect(rows[0]!["quests_completed"]).toBe(2);
    // Never a guessed zero for something no event carried (docs/CONTRACTS.md).
    expect(rows[1]!["money"]).toBeNull();
    expect(rows[1]!["quests_completed"]).toBeNull();
    const line = readTrajectory(dir).find((r) => r.t === "state");
    expect(line?.["money"]).toBe(12345);
    expect(line?.["questsCompleted"]).toBe(2);
    traj.close();
  });

  test("items are recorded as JSON, null when the sample carried none, and the column migrates in", () => {
    const dir = tempRunDir();
    // A state table from before the `items` column (harness 0.4, earlier).
    const db = new Database(join(dir, "run.sqlite"));
    db.exec(`CREATE TABLE state (run_id TEXT NOT NULL, ts INTEGER NOT NULL, level INTEGER, xp INTEGER,
      map INTEGER, x REAL, y REAL, z REAL, event_count INTEGER, last_seq INTEGER, money INTEGER,
      quests_completed INTEGER, turn INTEGER, zone INTEGER, area INTEGER)`);
    db.close();
    const traj = new Trajectory(dir);
    // The whole row as the paperdoll needs it: where it sits, what it is.
    const items = [
      { name: "Worn Mace", count: 1, equipped: true, slot: 16, itemId: 5956, quality: 1 },
      { name: "Tough Jerky", count: 5, equipped: false, bag: 255, slot: 23, itemId: 117, quality: 1 },
      // An old-shape row: the three fields every sample has ever carried.
      { name: "Tunic", count: 1, equipped: true },
    ];
    traj.recordState("run-i", { level: 1, items });
    traj.recordState("run-i", { level: 1 });
    const rows = traj.stateRows("run-i");
    expect(JSON.parse(String(rows[0]!["items"]))).toEqual(items);
    // The column is JSON text: the new fields need no migration, and a row
    // that carries none keeps exactly the three keys it was written with.
    expect(Object.keys((JSON.parse(String(rows[0]!["items"])) as object[])[2]!)).toEqual([
      "name",
      "count",
      "equipped",
    ]);
    expect(rows[1]!["items"]).toBeNull();
    const line = readTrajectory(dir).find((r) => r.t === "state");
    expect(line?.["items"]).toEqual(items);
    traj.close();
  });

  test("the player frame's numbers round-trip, and the columns migrate into an old database", () => {
    const dir = tempRunDir();
    // A state table from before that: every column the 0.4 series had, and
    // none of the frame's. Opening it must add them rather than fail the insert.
    const db = new Database(join(dir, "run.sqlite"));
    db.exec(`CREATE TABLE state (run_id TEXT NOT NULL, ts INTEGER NOT NULL, level INTEGER, xp INTEGER,
      map INTEGER, x REAL, y REAL, z REAL, event_count INTEGER, last_seq INTEGER, money INTEGER,
      quests_completed INTEGER, turn INTEGER, zone INTEGER, area INTEGER, items TEXT)`);
    db.close();
    const traj = new Trajectory(dir);
    traj.recordState("run-hp", {
      level: 4,
      health: 140,
      maxHealth: 220,
      power: 30,
      maxPower: 100,
      powerType: 0,
      nextLevelXp: 2100,
    });
    // A sample that observed none of it writes NULL, never 0: unobserved is not
    // a dead character.
    traj.recordState("run-hp", { level: 4 });
    const rows = traj.stateRows("run-hp");
    expect(rows[0]).toMatchObject({
      health: 140,
      max_health: 220,
      power: 30,
      max_power: 100,
      power_type: 0,
      next_level_xp: 2100,
    });
    expect(rows[1]!["health"]).toBeNull();
    expect(rows[1]!["power_type"]).toBeNull();
    const line = readTrajectory(dir).find((r) => r.t === "state");
    expect(line?.["health"]).toBe(140);
    expect(line?.["nextLevelXp"]).toBe(2100);
    traj.close();
  });

  test("the turn index is recorded, and absent rather than zero before the first turn", () => {
    const dir = tempRunDir();
    const traj = new Trajectory(dir);
    traj.recordState("run-t", { level: 1 });
    traj.recordState("run-t", { level: 2, turn: 14 });
    const rows = traj.stateRows("run-t");
    expect(rows[0]!["turn"]).toBeNull();
    expect(rows[1]!["turn"]).toBe(14);
    expect(readTrajectory(dir).find((r) => r.t === "state" && r["turn"] !== undefined)?.["turn"]).toBe(14);
    traj.close();
  });

  test("maxTurn is the high-water mark a resume continues from", () => {
    const dir = tempRunDir();
    const traj = new Trajectory(dir);
    expect(traj.maxTurn("run-t2")).toBe(0);
    traj.recordState("run-t2", { level: 1, turn: 4 });
    traj.recordState("run-t2", { level: 1 });
    expect(traj.maxTurn("run-t2")).toBe(4);
    traj.close();
  });

  test("termination and pause reasons are recorded", () => {
    const dir = tempRunDir();
    const traj = new Trajectory(dir);
    const config = loadRunConfig({});
    traj.writeMeta({ runId: "run-z", harnessVersion: "v", startedAt: 1, config });
    traj.setPause("run-z", "quota-exhausted", "429 quota");
    expect(traj.runRow("run-z")?.["pause_reason"]).toBe("quota-exhausted");
    traj.setTermination("run-z", "no-xp", "45m of nothing");
    const row = traj.runRow("run-z");
    expect(row?.["termination_reason"]).toBe("no-xp");
    expect(row?.["pause_reason"]).toBeNull();
    traj.close();
  });

  test("a reflection window is mirrored onto the run row, and a process boundary clears it", () => {
    const dir = tempRunDir();
    let t = 1000;
    const traj = new Trajectory(dir, { now: () => t });
    const config = loadRunConfig({ runId: "run-r", driver: "stub", model: "irrelevant" });
    traj.writeMeta({ runId: "run-r", harnessVersion: "0.0.0-test", startedAt: 5, config });
    expect(traj.runRow("run-r")?.["reflecting_since"]).toBeNull();

    // The loop's own record, written exactly as it writes it.
    t = 2000;
    traj.append({ t: "reflect_window", turn: 7, event: "open" });
    expect(traj.runRow("run-r")?.["reflecting_since"]).toBe(2000);
    t = 3000;
    traj.append({ t: "reflect_window", turn: 12, event: "close", reason: "left_rest" });
    expect(traj.runRow("run-r")?.["reflecting_since"]).toBeNull();

    // The transitions themselves stay where they were: the column is a mirror,
    // never the record.
    expect(readTrajectory(dir).filter((r) => r.t === "reflect_window")).toHaveLength(2);

    // A run killed mid-window must not read as reflecting when it comes back.
    t = 4000;
    traj.append({ t: "reflect_window", turn: 20, event: "open" });
    expect(traj.runRow("run-r")?.["reflecting_since"]).toBe(4000);
    traj.writeMeta({ runId: "run-r", harnessVersion: "0.0.0-test", startedAt: 5, config });
    expect(traj.runRow("run-r")?.["reflecting_since"]).toBeNull();
    traj.close();
  });

  test("the reflecting column migrates into a run table written without it", () => {
    const dir = tempRunDir();
    const db = new Database(join(dir, "run.sqlite"));
    db.exec(`CREATE TABLE run (run_id TEXT PRIMARY KEY, harness_version TEXT, started_at INTEGER,
      ended_at INTEGER, driver TEXT, shakeout TEXT, model TEXT, objective TEXT,
      termination_reason TEXT, termination_detail TEXT, pause_reason TEXT, config_json TEXT)`);
    db.close();
    let t = 500;
    const traj = new Trajectory(dir, { now: () => t });
    const config = loadRunConfig({ runId: "run-old", driver: "stub", model: "irrelevant" });
    traj.writeMeta({ runId: "run-old", harnessVersion: "0.0.0-test", startedAt: 1, config });
    t = 600;
    traj.append({ t: "reflect_window", turn: 1, event: "open" });
    expect(traj.runRow("run-old")?.["reflecting_since"]).toBe(600);
    traj.close();
  });

  test("registered secrets are scrubbed from every line", () => {
    const dir = tempRunDir();
    const traj = new Trajectory(dir);
    traj.redact("sk-verysecretkey123");
    traj.append({ t: "response", text: "my key is sk-verysecretkey123 ok" });
    traj.close();
    const raw = readTrajectory(dir);
    expect(JSON.stringify(raw)).not.toContain("sk-verysecretkey123");
    expect(raw[0]!["text"]).toContain("[redacted]");
  });
});

describe("a freeplay continuation's lineage", () => {
  test("continued_from lands in the run row and meta, and dropContinuation clears every copy", () => {
    const dir = tempRunDir();
    const traj = new Trajectory(dir);
    const config = loadRunConfig({ runId: "run-a12", driver: "stub", episode: "freeplay", character: "Bromdir", race: 3, class: 2, continuedFrom: "run-a11" });
    traj.writeMeta({ runId: "run-a12", harnessVersion: "0.0.0-test", startedAt: 5, config });
    expect(traj.runRow("run-a12")?.["continued_from"]).toBe("run-a11");
    expect(readMeta(dir)?.config.continuedFrom).toBe("run-a11");
    traj.dropContinuation("run-a12", "Bromdir is gone");
    const row = traj.runRow("run-a12");
    expect(row?.["continued_from"]).toBeNull();
    expect(row?.["character"]).toBeNull();
    expect(readMeta(dir)?.config.continuedFrom).toBeUndefined();
    expect(readMeta(dir)?.config.character).toBeUndefined();
    traj.close();
    expect(readTrajectory(dir).some((r) => r["kind"] === "continue-dropped")).toBe(true);
  });
});

describe("one pause per segment", () => {
  test("a stop that lands on a run already paused moves nothing: the first pause keeps its reason and its instant", () => {
    const dir = tempRunDir();
    const traj = new Trajectory(dir);
    const config = loadRunConfig({});
    const meta = { runId: "run-q", harnessVersion: "v", startedAt: 1, config };
    traj.writeMeta(meta);
    // The provider pause, marked at its own instant…
    expect(traj.pauseWithMark("run-q", { reason: "quota-exhausted", detail: "quota", at: 1_000_000, episodeElapsedMs: 4000 }, meta)).toBe(true);
    // …then SIGTERM while the process is on its way out.
    expect(traj.pauseWithMark("run-q", { reason: "operator-pause", detail: "SIGTERM: supervisor stop", at: 9_000_000, episodeElapsedMs: 9000 }, readMeta(dir)!)).toBe(false);
    expect(traj.runRow("run-q")?.["pause_reason"]).toBe("quota-exhausted");
    expect(readMeta(dir)?.pause).toEqual({ reason: "quota-exhausted", detail: "quota", at: 1_000_000, episodeElapsedMs: 4000 });
    expect(readTrajectory(dir).filter((r) => r.t === "pause")).toHaveLength(1);
    traj.close();
  });

  test("a second setPause in the same segment is a no-op; a resume clears the row and the next pause records again", () => {
    const dir = tempRunDir();
    const traj = new Trajectory(dir);
    const config = loadRunConfig({});
    traj.writeMeta({ runId: "run-p", harnessVersion: "v", startedAt: 1, config });
    // The signal handler's write, then the driver's unwind reaching the same call.
    expect(traj.setPause("run-p", "operator-pause", "SIGTERM: supervisor stop", 1000)).toBe(true);
    expect(traj.setPause("run-p", "rate-limited", "429", 1200)).toBe(false);
    expect(traj.runRow("run-p")?.["pause_reason"]).toBe("operator-pause");
    expect(readTrajectory(dir).filter((r) => r.t === "pause")).toHaveLength(1);
    // --resume consumes the pause; the next segment's pause is a new record.
    traj.clearPause("run-p");
    expect(traj.setPause("run-p", "quota-exhausted", "quota", 5000)).toBe(true);
    expect(traj.runRow("run-p")?.["pause_reason"]).toBe("quota-exhausted");
    expect(readTrajectory(dir).filter((r) => r.t === "pause")).toHaveLength(2);
    traj.close();
  });
});
