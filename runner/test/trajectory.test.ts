import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadRunConfig } from "../src/config";
import { Trajectory, readMeta, readTrajectory } from "../src/trajectory";
import { tempDirs } from "./fixtures/temp-dirs";

const tempDir = tempDirs();

function tempRunDir(): string {
  return tempDir("wrathbench-traj-");
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

  test("meta round-trips, and the run row is read back off meta.json", () => {
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

  test("the module session token is kept in meta.json only: the record and config_json carry the rest of the config", () => {
    const dir = tempRunDir();
    const traj = new Trajectory(dir);
    const token = "tok-0123456789abcdef0123456789abcdef";
    const config = loadRunConfig({ runId: "run-t", driver: "stub", model: "irrelevant", token });
    traj.writeMeta({ runId: "run-t", harnessVersion: "0.0.0-test", startedAt: 5, config });
    // A pause mark rewrites both through the same writer.
    traj.pauseWithMark("run-t", { reason: "operator-pause", at: 9, episodeElapsedMs: 4 }, { runId: "run-t", harnessVersion: "0.0.0-test", startedAt: 5, config });
    // `--resume`, the roster's session release and the viewer's error scrub read it here.
    expect(readMeta(dir)?.config.token).toBe(token);
    const metas = readTrajectory(dir).filter((r) => r.t === "meta");
    expect(metas).toHaveLength(2);
    for (const m of metas) {
      expect((m["config"] as Record<string, unknown>)["model"]).toBe("irrelevant");
      expect("token" in (m["config"] as Record<string, unknown>)).toBe(false);
    }
    const configJson = String(traj.runRow("run-t")?.["config_json"]);
    expect((JSON.parse(configJson) as Record<string, unknown>)["model"]).toBe("irrelevant");
    expect(configJson.includes(token)).toBe(false);
    expect(readFileSync(join(dir, "trajectory.jsonl"), "utf8").includes(token)).toBe(false);
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

  test("a v1 run directory holds no run.sqlite: the trajectory, and meta.json for the row", () => {
    const dir = tempRunDir();
    const traj = new Trajectory(dir);
    const config = loadRunConfig({ runId: "run-v1", driver: "stub", model: "irrelevant" });
    traj.writeMeta({ runId: "run-v1", harnessVersion: "0.0.0-test", startedAt: 5, config });
    traj.setPause("run-v1", "operator-pause", "x");
    traj.clearPause("run-v1");
    traj.setTermination("run-v1", "no-xp", "nothing");
    traj.close();
    expect(readdirSync(dir).sort()).toEqual(["meta.json", "trajectory.jsonl"]);
  });

  test("maxTurn is the run's turns so far, read off its requests, cumulative across a resume", () => {
    const dir = tempRunDir();
    const traj = new Trajectory(dir);
    expect(traj.maxTurn("run-t2")).toBe(0);
    traj.append({ t: "request", turn: 1 });
    traj.append({ t: "response", turn: 1 });
    traj.append({ t: "request", turn: 4 });
    expect(traj.maxTurn("run-t2")).toBe(4);
    // A resume states the offset it continues from, and its driver counts from 1 again.
    traj.append({ t: "resume", turnOffset: 4 });
    traj.append({ t: "request", turn: 1 });
    traj.append({ t: "request", turn: 2 });
    expect(traj.maxTurn("run-t2")).toBe(6);
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
    expect(row?.["termination_detail"]).toBe("45m of nothing");
    expect(typeof row?.["ended_at"]).toBe("number");
    expect(row?.["pause_reason"]).toBeNull();
    // A relaunch's meta write keeps the verdict, as the row's conflict path did.
    traj.writeMeta({ runId: "run-z", harnessVersion: "v2", startedAt: 1, config });
    expect(traj.runRow("run-z")?.["termination_reason"]).toBe("no-xp");
    expect(traj.runRow("run-z")?.["harness_version"]).toBe("v2");
    // A repair writes only where there is no verdict.
    expect(traj.repairTermination("run-z", "idle", null, 9)).toBe(false);
    traj.close();
  });

  test("the supervisor's repair writes a verdict the trajectory holds into a meta.json without one", () => {
    const dir = tempRunDir();
    const traj = new Trajectory(dir);
    traj.writeMeta({ runId: "run-y", harnessVersion: "v", startedAt: 1, config: loadRunConfig({}) });
    expect(traj.repairTermination("run-y", "idle", "cold", 42)).toBe(true);
    expect(traj.runRow("run-y")).toMatchObject({ termination_reason: "idle", termination_detail: "cold", ended_at: 42 });
    expect(readTrajectory(dir).filter((r) => r.t === "termination")).toHaveLength(0);
    traj.close();
  });

  test("a reflection window is mirrored into meta.json, and a process boundary clears it", () => {
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

    // The transitions themselves stay where they were: meta.json's field is a
    // mirror, never the record.
    expect(readTrajectory(dir).filter((r) => r.t === "reflect_window")).toHaveLength(2);

    // A run killed mid-window must not read as reflecting when it comes back.
    t = 4000;
    traj.append({ t: "reflect_window", turn: 20, event: "open" });
    expect(traj.runRow("run-r")?.["reflecting_since"]).toBe(4000);
    traj.writeMeta({ runId: "run-r", harnessVersion: "0.0.0-test", startedAt: 5, config });
    expect(traj.runRow("run-r")?.["reflecting_since"]).toBeNull();
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
  test("a stop that lands on a run already paused moves nothing: the first pause keeps its reason and its instant", async () => {
    const dir = tempRunDir();
    const traj = new Trajectory(dir);
    const config = loadRunConfig({});
    const meta = { runId: "run-q", harnessVersion: "v", startedAt: 1, config };
    traj.writeMeta(meta);
    // The provider pause, marked at its own instant…
    expect(await traj.pauseWithMark("run-q", { reason: "quota-exhausted", detail: "quota", at: 1_000_000, episodeElapsedMs: 4000 }, meta)).toBe(true);
    // …then SIGTERM while the process is on its way out.
    expect(await traj.pauseWithMark("run-q", { reason: "operator-pause", detail: "SIGTERM: supervisor stop", at: 9_000_000, episodeElapsedMs: 9000 }, readMeta(dir)!)).toBe(false);
    expect(traj.runRow("run-q")?.["pause_reason"]).toBe("quota-exhausted");
    expect(readMeta(dir)?.pause).toEqual({ reason: "quota-exhausted", detail: "quota", at: 1_000_000, episodeElapsedMs: 4000 });
    expect(readTrajectory(dir).filter((r) => r.t === "pause")).toHaveLength(1);
    traj.close();
  });

  test("a second setPause in the same segment is a no-op; a resume clears the row and the next pause records again", async () => {
    const dir = tempRunDir();
    const traj = new Trajectory(dir);
    const config = loadRunConfig({});
    traj.writeMeta({ runId: "run-p", harnessVersion: "v", startedAt: 1, config });
    // The signal handler's write, then the driver's unwind reaching the same call.
    expect(await traj.setPause("run-p", "operator-pause", "SIGTERM: supervisor stop", 1000)).toBe(true);
    expect(await traj.setPause("run-p", "rate-limited", "429", 1200)).toBe(false);
    expect(traj.runRow("run-p")?.["pause_reason"]).toBe("operator-pause");
    expect(readTrajectory(dir).filter((r) => r.t === "pause")).toHaveLength(1);
    // --resume consumes the pause; the next segment's pause is a new record.
    traj.clearPause("run-p");
    expect(await traj.setPause("run-p", "quota-exhausted", "quota", 5000)).toBe(true);
    expect(traj.runRow("run-p")?.["pause_reason"]).toBe("quota-exhausted");
    expect(readTrajectory(dir).filter((r) => r.t === "pause")).toHaveLength(2);
    traj.close();
  });
});
