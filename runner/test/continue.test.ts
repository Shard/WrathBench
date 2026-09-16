/**
 * `--continue-from`: a freeplay character coming back under a new run id on its
 * predecessor's account, character and scratchpad (operator ask, 2026-08-29:
 * a character the operator disables and re-enables must not lose Bromdir).
 *
 * `loadContinuation` is the refusal seam, tested pure. The launch itself runs
 * run.ts as a subprocess with the stub driver against a fake module that
 * answers only the character listing and delete — the sandbox never dials
 * the module for a stub that calls no tool.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadRunConfig, newSessionToken } from "../src/config";
import { loadContinuation } from "../src/run";
import { Trajectory, readMeta, readTrajectory } from "../src/trajectory";
import { ARCHIVE_DIR } from "../viewer/archive-dir";

const RUN_TS = join(import.meta.dir, "..", "src", "run.ts");

/** A freeplay launch on RUNNER2 continuing `from`. */
const cfgFor = (runsDir: string, from: string) =>
  ({ episode: "freeplay", account: "RUNNER2", runsDir, continuedFrom: from }) as Parameters<typeof loadContinuation>[0];

/** An ended freeplay run on RUNNER2 that played Bromdir to level 8, notes and all. */
function endedFreeplayRun(over: { episode?: "freeplay" | "e90"; account?: string; character?: string } = {}) {
  const runsDir = mkdtempSync(join(tmpdir(), "wrathbench-continue-"));
  const runId = "fleet-sub-opus-low-freeplay-opus-low-20260827-a11";
  const dir = join(runsDir, runId);
  mkdirSync(dir, { recursive: true });
  const traj = new Trajectory(dir);
  const config = loadRunConfig({
    runId,
    token: newSessionToken(),
    driver: "stub",
    episode: over.episode ?? "freeplay",
    runsDir,
    moduleUrl: "http://127.0.0.1:9",
    account: over.account ?? "RUNNER2",
    ...("character" in over ? (over.character !== undefined ? { character: over.character } : {}) : { character: "Bromdir" }),
    race: 3,
    class: 2,
  });
  traj.writeMeta({ runId, harnessVersion: "0.0.0-test", startedAt: 1, config });
  traj.recordState(runId, { level: 8, xp: 6410 });
  traj.setTermination(runId, "manual", "operator: killed");
  traj.close();
  writeFileSync(join(dir, "scratchpad.md"), "# Bromdir\nHARD FACT: the pass bends west first.\n");
  return { runsDir, runId, dir };
}

/** A module that knows one account's characters and deletes on request. */
function fakeModule(chars: { name: string; guid: string }[]) {
  const deleted: string[] = [];
  const server = Bun.serve({
    port: 0,
    fetch: async (req) => {
      const path = new URL(req.url).pathname;
      if (path === "/characters") {
        return Response.json({ ok: true, token: "t", enum: { count: chars.length, characters: chars } });
      }
      if (path === "/character-delete") {
        const body = (await req.json()) as { character: string };
        deleted.push(body.character);
        chars = chars.filter((c) => c.name !== body.character);
        return Response.json({ ok: true, token: "t", character: body.character, deleted: true });
      }
      return new Response("not found", { status: 404 });
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, deleted, stop: () => server.stop(true) };
}

async function launch(runsDir: string, moduleUrl: string, extra: string[]): Promise<string> {
  const script = join(runsDir, "stub.json");
  writeFileSync(script, JSON.stringify([{ content: "hello again", toolCalls: [] }]));
  const proc = Bun.spawn({
    cmd: [
      process.execPath,
      RUN_TS,
      "--driver",
      "stub",
      "--stub",
      script,
      "--runs-dir",
      runsDir,
      "--module-url",
      moduleUrl,
      "--account",
      "RUNNER2",
      "--race",
      "3",
      "--class",
      "2",
      "--step-interval-ms",
      "0",
      ...extra,
    ],
    cwd: runsDir,
    // Root `bun test` auto-loads the repo's .env, which carries the real module
    // secret; the fake module here issues no leases, so the child must not see it.
    env: { ...process.env, WRATHBENCH_MODULE_URL: moduleUrl, WRATHBENCH_MODULE_SECRET: undefined },
    stdout: "pipe",
    stderr: "pipe",
  });
  const stderr = await new Response(proc.stderr).text();
  await proc.exited;
  return stderr;
}

describe("loadContinuation", () => {
  const cfg = (runsDir: string, over: Record<string, unknown> = {}) =>
    ({ episode: "freeplay", account: "RUNNER2", runsDir, continuedFrom: "fleet-sub-opus-low-freeplay-opus-low-20260827-a11", ...over }) as Parameters<
      typeof loadContinuation
    >[0];

  test("takes the character's identity from the predecessor", () => {
    const { runsDir, runId, dir } = endedFreeplayRun();
    expect(loadContinuation(cfg(runsDir))).toEqual({ from: runId, character: "Bromdir", race: 3, class: 2, dir });
    // The account matches as the realm matches it.
    expect(loadContinuation(cfg(runsDir, { account: "runner2" }))?.character).toBe("Bromdir");
  });

  test("a PAUSED predecessor is a predecessor: the lineage is the newest attempt", () => {
    // `streamsFrom` takes a paused run as a chain head since 2026-09-08, so a
    // continuation can now name one. Nothing here reads a termination — the
    // account and the character are the whole question — and this pins that.
    const { runsDir, runId, dir } = endedFreeplayRun();
    const meta = JSON.parse(readFileSync(join(dir, "meta.json"), "utf8")) as Record<string, unknown>;
    meta["pause"] = { reason: "operator-pause", at: 2, episodeElapsedMs: 1000 };
    writeFileSync(join(dir, "meta.json"), JSON.stringify(meta));
    expect(loadContinuation(cfg(runsDir))).toEqual({ from: runId, character: "Bromdir", race: 3, class: 2, dir });
  });

  test("refuses everything that would make the lineage a lie", () => {
    const { runsDir } = endedFreeplayRun();
    // A scored launch is a fresh character by definition.
    expect(() => loadContinuation(cfg(runsDir, { episode: "e90" }))).toThrow(/freeplay continuation/);
    // Another account: the character is not there.
    expect(() => loadContinuation(cfg(runsDir, { account: "RUNNER5" }))).toThrow(/a character lives on one account/);
    // No such run anywhere: an absent lineage, not a lie about one — the
    // launch degrades to a fresh start rather than dying (see below).
    expect(loadContinuation(cfg(runsDir, { continuedFrom: "nope" }))).toBeNull();
    // A predecessor that is not freeplay, or never named a character.
    expect(() => loadContinuation(cfg(endedFreeplayRun({ episode: "e90" }).runsDir))).toThrow(/not freeplay/);
    expect(() => loadContinuation(cfg(endedFreeplayRun({ character: undefined }).runsDir))).toThrow(/never recorded a character/);
  });
});

describe("--continue-from", () => {
  test("the new run keeps the character, carries the scratchpad and records its lineage", async () => {
    const { runsDir, runId } = endedFreeplayRun();
    const mod = fakeModule([
      { name: "Bromdir", guid: "310" },
      { name: "Novice", guid: "311" },
    ]);
    try {
      const stderr = await launch(runsDir, mod.url, ["--episode", "freeplay", "--run-id", "a12", "--continue-from", runId, "--keep-characters", "Vespers"]);
      expect(stderr).toContain("continuing fleet-sub-opus-low-freeplay-opus-low-20260827-a11: Bromdir (guid 310) is on RUNNER2");
      // Hygiene cleared the stranger and left the character's own.
      expect(mod.deleted).toEqual(["Novice"]);
      const dir = join(runsDir, "a12");
      const meta = readMeta(dir);
      expect(meta?.config.continuedFrom).toBe(runId);
      expect(meta?.config.character).toBe("Bromdir");
      expect(meta?.config.race).toBe(3);
      expect(readFileSync(join(dir, "scratchpad.md"), "utf8")).toContain("the pass bends west first");
      const records = readTrajectory(dir);
      expect(records.find((r) => r.t === "continue")).toMatchObject({ from: runId, character: "Bromdir", guid: "310" });
      // The model is told it continues, with where the character was left
      // (the note rides the first turn's context, whatever record carries it).
      const all = JSON.stringify(records);
      expect(all).toContain("continues your earlier freeplay session");
      expect(all).toContain("level 8 with 6410 xp");
      // No freshness tripwire on a continued character: the run was not ended stale-character.
      expect(records.some((r) => r.t === "termination" && r["reason"] === "stale-character")).toBe(false);
    } finally {
      mod.stop();
    }
  }, 60_000);

  test("a character that is gone means a fresh start, and the lineage is dropped everywhere", async () => {
    const { runsDir, runId } = endedFreeplayRun();
    const mod = fakeModule([{ name: "Novice", guid: "311" }]);
    try {
      const stderr = await launch(runsDir, mod.url, ["--episode", "freeplay", "--run-id", "a12", "--continue-from", runId]);
      expect(stderr).toContain("Bromdir is not on RUNNER2 any more");
      const dir = join(runsDir, "a12");
      expect(readMeta(dir)?.config.continuedFrom).toBeUndefined();
      expect(readMeta(dir)?.config.character).toBeUndefined();
      expect(existsSync(join(dir, "scratchpad.md"))).toBe(false);
      const records = readTrajectory(dir);
      expect(records.some((r) => r.t === "harness" && r["kind"] === "continue-dropped")).toBe(true);
      expect(JSON.stringify(records)).toContain("name your character");
    } finally {
      mod.stop();
    }
  }, 60_000);

  test("an archived predecessor still continues: the archive parks a listing, not a character", async () => {
    const { runsDir, runId, dir } = endedFreeplayRun();
    // The freeplay ladder shows one character per model, so the dead sessions
    // behind it get parked. The character is untouched by that move.
    mkdirSync(join(runsDir, ARCHIVE_DIR), { recursive: true });
    renameSync(dir, join(runsDir, ARCHIVE_DIR, runId));
    expect(loadContinuation(cfgFor(runsDir, runId))).toMatchObject({
      from: runId,
      character: "Bromdir",
      dir: join(runsDir, ARCHIVE_DIR, runId),
    });
    const mod = fakeModule([{ name: "Bromdir", guid: "310" }]);
    try {
      const stderr = await launch(runsDir, mod.url, ["--episode", "freeplay", "--run-id", "a12", "--continue-from", runId]);
      expect(stderr).toContain(`continuing ${runId}: Bromdir (guid 310) is on RUNNER2`);
      const next = join(runsDir, "a12");
      expect(readMeta(next)?.config.continuedFrom).toBe(runId);
      // The predecessor's notes come along from the archive, too.
      expect(readFileSync(join(next, "scratchpad.md"), "utf8")).toContain("the pass bends west first");
    } finally {
      mod.stop();
    }
  }, 60_000);

  test("a predecessor that is nowhere on disk degrades to a fresh start, never a dead launch", async () => {
    const { runsDir } = endedFreeplayRun();
    const mod = fakeModule([]);
    try {
      const stderr = await launch(runsDir, mod.url, ["--episode", "freeplay", "--run-id", "a12", "--continue-from", "fleet-gone-freeplay-gone-20260101"]);
      expect(stderr).toContain("no such run under");
      const dir = join(runsDir, "a12");
      // The run happened, and no record claims a lineage it does not have.
      expect(existsSync(dir)).toBe(true);
      expect(readMeta(dir)?.config.continuedFrom).toBeUndefined();
      const records = readTrajectory(dir);
      const dropped = records.find((r) => r.t === "harness" && r["kind"] === "continue-dropped");
      expect(String(dropped?.["detail"])).toContain("fleet-gone-freeplay-gone-20260101");
    } finally {
      mod.stop();
    }
  }, 60_000);

  test("a scored launch may not continue anything", async () => {
    const { runsDir, runId } = endedFreeplayRun();
    const stderr = await launch(runsDir, "http://127.0.0.1:9", ["--episode", "e90", "--run-id", "a12", "--continue-from", runId]);
    expect(stderr).toContain("--continue-from is a freeplay continuation");
    expect(existsSync(join(runsDir, "a12"))).toBe(false);
  }, 30_000);
});
