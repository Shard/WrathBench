/**
 * `--status` and `--dry-run` read every run once (`readReportFacts`), through
 * the supervisor's kept facts opened read-only, where they used to read the
 * whole tree cold: three times for `--status`, twice for `--dry-run`. What has
 * to hold is that nothing either prints could change, and that the
 * supervisor's cache is never written by a reader beside it:
 *
 * - the one read is the cold read, with or without a cache file;
 * - the archive-less facts the paused-run planners read are the archive-less
 *   read, and the projection and the characters are what their own reads gave;
 * - the cache file is left exactly as it was, even where a writer would have
 *   kept, dropped or replaced entries.
 *
 * The runs are written by the runner's own `Trajectory`. Every read passes a
 * clock past the settle rule (`RUN_FACT_SETTLE_MS`), because the fixtures
 * were written a moment ago.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type FleetRosterEntry, rosterModels } from "./run-fleet-config";
import { charactersFrom } from "./run-fleet-plan";
import { readReportFacts, unarchived } from "./run-fleet-state";
import { tempDirs } from "./temp-dirs";
import { comparabilityOf } from "../runner/src/comparability";
import { loadRunConfig, newSessionToken, type TerminationReason } from "../runner/src/config";
import { modelStates, readRunFacts, runFactCache, RUN_FACT_SETTLE_MS, type RunFact } from "../runner/src/models";
import { HEARTBEAT_FILE, Trajectory } from "../runner/src/trajectory";

const tempDir = tempDirs();
const HARNESS = "harness-0.5-1068-g0000000";
const MODEL = "z-ai/glm-5.2:free";

interface Fixture {
  runId: string;
  episode?: "e90" | "freeplay";
  responses: number;
  level: number;
  account: string;
  end?: TerminationReason;
  pause?: boolean;
  /** A runner still beating: a fresh heartbeat and no verdict. */
  live?: boolean;
}

function writeRun(dir: string, o: Fixture): void {
  const runDir = join(dir, o.runId);
  mkdirSync(runDir, { recursive: true });
  const traj = new Trajectory(runDir);
  const config = loadRunConfig({
    runId: o.runId,
    token: newSessionToken(),
    driver: "openai",
    model: MODEL,
    episode: o.episode ?? "e90",
    ...(o.episode === "freeplay" ? { extra: true } : {}),
    runsDir: dir,
    moduleUrl: "http://127.0.0.1:9",
    account: o.account,
    character: "Thalvorn",
    race: 3,
    class: 2,
  });
  traj.writeMeta({ runId: o.runId, harnessVersion: HARNESS, startedAt: Date.now() - 3_600_000, config, comparability: comparabilityOf(config, HARNESS) });
  for (let i = 0; i < o.responses; i++) traj.append({ t: "response", text: "…" });
  for (let l = 1; l <= o.level; l++) traj.recordState(o.runId, { level: l, xp: l * 100 });
  if (o.end !== undefined) traj.setTermination(o.runId, o.end);
  if (o.pause === true) traj.setPause(o.runId, "operator-pause");
  traj.close();
  if (o.live === true) writeFileSync(join(runDir, HEARTBEAT_FILE), "host 4242\n");
}

// Every kind of run a report reads: ended (kept by a writer), paused, live,
// and one put away in the archive.
const RUNS: Fixture[] = [
  { runId: "fleet-glm-e90-glm-5-2-20261016", responses: 40, level: 5, account: "RUNNER", end: "episode-limit" },
  { runId: "fleet-glm-e90-glm-5-2-20261016-a2", responses: 0, level: 1, account: "RUNNER", end: "adapter-error" },
  { runId: "fleet-glm-freeplay-glm-5-2-20261016", episode: "freeplay", responses: 12, level: 3, account: "RUNNER2", end: "idle" },
  { runId: "fleet-glm-freeplay-glm-5-2-20261016-a2", episode: "freeplay", responses: 7, level: 4, account: "RUNNER2", pause: true },
  { runId: "fleet-glm-e90-glm-5-2-20261016-a3", responses: 3, level: 2, account: "RUNNER3", live: true },
];
const ARCHIVED: Fixture = { runId: "fleet-glm-e90-glm-5-2-20261015", responses: 0, level: 1, account: "RUNNER", end: "adapter-error" };
const LATE: Fixture = { runId: "fleet-glm-e90-glm-5-2-20261017", responses: 9, level: 3, account: "RUNNER", end: "episode-limit" };

const roster: Record<string, FleetRosterEntry> = { glm: { model: MODEL, tier: "t1", idle: "unlimited" } };

function runsDirWithRuns(): { dir: string; cachePath: string } {
  const dir = tempDir("wb-report-facts-");
  for (const r of RUNS) writeRun(dir, r);
  writeRun(join(dir, "archive"), ARCHIVED);
  return { dir, cachePath: join(dir, "run-facts.cache.json") };
}

/** A clock past the settle rule for files written just now, short of the heartbeat going cold. */
const settled = (): number => Date.now() + RUN_FACT_SETTLE_MS + 1_000;
const cold = (dir: string, now: number): RunFact[] => readRunFacts(dir, now, { includeArchived: true });
/** What the supervisor does each tick: a read that keeps what it may and writes the file. */
const supervisorRead = (dir: string, cachePath: string, now: number): void => {
  readRunFacts(dir, now, { includeArchived: true, facts: runFactCache(cachePath) });
};
/** The cache file as a reader can tell it apart: its bytes and its stat. */
const fileState = (path: string) => {
  const st = statSync(path);
  return { bytes: readFileSync(path, "utf8"), mtimeMs: st.mtimeMs, ino: st.ino, size: st.size };
};
const tmpsBeside = (dir: string): string[] => readdirSync(dir).filter((n) => n.endsWith(".tmp"));

describe("a report reads every run once, and the answer is the cold read", () => {
  test("with no cache file, and with the supervisor's: the same facts; no file is made", () => {
    const { dir, cachePath } = runsDirWithRuns();
    const now = settled();
    const plain = cold(dir, now);
    expect(plain.map((f) => f.runId).sort()).toEqual([...RUNS, ARCHIVED].map((r) => r.runId).sort());

    expect(readReportFacts(now, dir, cachePath)).toStrictEqual(plain);
    expect(existsSync(cachePath)).toBe(false);

    supervisorRead(dir, cachePath, now);
    expect(existsSync(cachePath)).toBe(true);
    expect(readReportFacts(now, dir, cachePath)).toStrictEqual(plain);
  });

  test("it is served from the supervisor's file: a kept fact rewritten under its key comes back as written", () => {
    // What makes the report fast: an ended run's trajectory is not counted again.
    const { dir, cachePath } = runsDirWithRuns();
    const now = settled();
    supervisorRead(dir, cachePath, now);
    const doc = JSON.parse(readFileSync(cachePath, "utf8")) as { entries: Record<string, { fact: RunFact }> };
    doc.entries[RUNS[0]!.runId]!.fact.modelResponses = 999;
    writeFileSync(cachePath, JSON.stringify(doc));
    expect(readReportFacts(now, dir, cachePath).find((f) => f.runId === RUNS[0]!.runId)?.modelResponses).toBe(999);
  });

  test("the archive-less facts, the projection and the characters are what their own reads gave", () => {
    const { dir, cachePath } = runsDirWithRuns();
    const now = settled();
    supervisorRead(dir, cachePath, now);
    const facts = readReportFacts(now, dir, cachePath);
    // The paused-run planners' input: `readRunFacts(RUNS_DIR)`, which skips the archive.
    const runsDirOnly = readRunFacts(dir, now);
    expect(unarchived(facts)).toStrictEqual(runsDirOnly);
    expect(runsDirOnly.some((f) => f.runId === ARCHIVED.runId)).toBe(false);
    // The models table and the job progress: the projection's own read.
    const models = rosterModels(roster);
    expect(modelStates({ runsDir: dir, roster: models, now, runs: facts })).toStrictEqual(modelStates({ runsDir: dir, roster: models, now }));
    // The freeplay characters: their own archive-inclusive read.
    const characters = charactersFrom(facts, roster);
    expect(characters).toEqual(charactersFrom(cold(dir, now), roster));
    expect(characters.get("glm")?.runId).toBe(RUNS[3]!.runId);
  });
});

describe("a report never writes the supervisor's cache", () => {
  test("not where a writer would keep a new ended run, or drop one that is gone", () => {
    const { dir, cachePath } = runsDirWithRuns();
    supervisorRead(dir, cachePath, settled());
    const before = fileState(cachePath);
    writeRun(dir, LATE); // a writer would keep it
    rmSync(join(dir, RUNS[1]!.runId), { recursive: true }); // a writer would drop it
    const now = settled();
    expect(readReportFacts(now, dir, cachePath)).toStrictEqual(cold(dir, now));
    expect(fileState(cachePath)).toEqual(before);
    expect(tmpsBeside(dir)).toEqual([]);
  });

  test("not where a writer would replace a file from another reader version", () => {
    const { dir, cachePath } = runsDirWithRuns();
    writeFileSync(cachePath, JSON.stringify({ version: "another-reader", entries: {} }));
    const before = fileState(cachePath);
    const now = settled();
    expect(readReportFacts(now, dir, cachePath)).toStrictEqual(cold(dir, now));
    expect(fileState(cachePath)).toEqual(before);
    expect(tmpsBeside(dir)).toEqual([]);
  });
});
