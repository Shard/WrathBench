/**
 * Terminated runs' facts kept on disk across processes (`readRunFacts`'
 * `facts`). The fleet supervisor's boot counted every trajectory in the tree
 * before its first spawn; with the cache it reads in full only the runs that
 * have not ended. What has to hold is that the cache is never a different
 * answer: a warm read is the cold read, a run that changed is read again, and
 * a cache file that cannot be trusted is a cold read.
 *
 * The runs are written by the runner's own `Trajectory`, so the files are the
 * files a run leaves. Every read passes a clock past the settle rule
 * (`RUN_FACT_SETTLE_MS`), because the fixtures were written a moment ago.
 */
import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { comparabilityOf } from "../src/comparability";
import { loadRunConfig, newSessionToken, type TerminationReason } from "../src/config";
import { readRunFacts, runFactCache, runFactKey, RUN_FACT_SETTLE_MS, type RunFact } from "../src/models";
import { HEARTBEAT_FILE, Trajectory } from "../src/trajectory";
import { tempDirs } from "./fixtures/temp-dirs";

const tempDir = tempDirs();
const HARNESS = "harness-0.5-1068-g0000000";

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
    model: "z-ai/glm-5.2:free",
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

const RUNS: Fixture[] = [
  { runId: "fleet-glm-e90-glm-5-2-20261016", responses: 40, level: 5, account: "RUNNER", end: "episode-limit" },
  { runId: "fleet-glm-e90-glm-5-2-20261016-a2", responses: 0, level: 1, account: "RUNNER", end: "adapter-error" },
  { runId: "fleet-glm-freeplay-glm-5-2-20261016", episode: "freeplay", responses: 12, level: 3, account: "RUNNER2", end: "idle" },
  { runId: "fleet-glm-freeplay-glm-5-2-20261016-a2", episode: "freeplay", responses: 7, level: 4, account: "RUNNER2", pause: true },
  { runId: "fleet-glm-e90-glm-5-2-20261016-a3", responses: 3, level: 2, account: "RUNNER3", live: true },
];
const ARCHIVED: Fixture = { runId: "fleet-glm-e90-glm-5-2-20261015", responses: 0, level: 1, account: "RUNNER", end: "adapter-error" };

function runsDirWithRuns(): string {
  const dir = tempDir("wb-fact-cache-");
  for (const r of RUNS) writeRun(dir, r);
  writeRun(join(dir, "archive"), ARCHIVED);
  return dir;
}

/** A clock past the settle rule for files written just now, short of the heartbeat going cold. */
const settled = (): number => Date.now() + RUN_FACT_SETTLE_MS + 1_000;
const cold = (dir: string, now: number): RunFact[] => readRunFacts(dir, now, { includeArchived: true });
const cached = (dir: string, cachePath: string, now: number) => {
  const facts = runFactCache(cachePath);
  return { runs: readRunFacts(dir, now, { includeArchived: true, facts }), facts };
};
const keptIds = (cachePath: string): string[] => Object.keys((JSON.parse(readFileSync(cachePath, "utf8")) as { entries: Record<string, unknown> }).entries).sort();
/** Rewrite one kept fact in place, under its key: what a warm read serves without touching the run. */
const tamper = (cachePath: string, rel: string, over: Partial<RunFact>): void => {
  const doc = JSON.parse(readFileSync(cachePath, "utf8")) as { entries: Record<string, { fact: RunFact }> };
  doc.entries[rel]!.fact = { ...doc.entries[rel]!.fact, ...over };
  writeFileSync(cachePath, JSON.stringify(doc));
};

describe("the run-fact cache is never a different answer", () => {
  test("a warm read, in a new process's view of the file, is the cold read; only terminated runs are kept", () => {
    const dir = runsDirWithRuns();
    const cachePath = join(dir, "run-facts.cache.json");
    const now = settled();
    const plain = cold(dir, now);
    const byId = new Map(plain.map((f) => [f.runId, [f.terminationReason, f.pause?.reason ?? null, f.live, f.archived === true]]));
    expect(Object.fromEntries(byId)).toEqual({
      [ARCHIVED.runId]: ["adapter-error", null, false, true],
      [RUNS[0]!.runId]: ["episode-limit", null, false, false],
      [RUNS[1]!.runId]: ["adapter-error", null, false, false],
      [RUNS[2]!.runId]: ["idle", null, false, false],
      [RUNS[3]!.runId]: [null, "operator-pause", false, false],
      [RUNS[4]!.runId]: [null, null, true, false],
    });
    expect(cached(dir, cachePath, now).runs).toStrictEqual(plain);
    expect(keptIds(cachePath)).toEqual([`archive/${ARCHIVED.runId}`, RUNS[0]!.runId, RUNS[1]!.runId, RUNS[2]!.runId].sort());
    // A fresh instance reads the file: what it serves is the cold read, strictly.
    expect(cached(dir, cachePath, now).runs).toStrictEqual(plain);
    // And it is served from the file, not re-read: a kept fact rewritten under its key comes back as written.
    tamper(cachePath, RUNS[0]!.runId, { bestLevel: 99 });
    expect(cached(dir, cachePath, now).runs.find((f) => f.runId === RUNS[0]!.runId)?.bestLevel).toBe(99);
    // A chmod or chown moves only ctime, which the fleet pod's fsGroup does to
    // every file at every start: still a hit, or every boot would read cold.
    for (const name of ["meta.json", "trajectory.jsonl", "run.sqlite"]) chmodSync(join(dir, RUNS[0]!.runId, name), 0o640);
    expect(cached(dir, cachePath, now).runs.find((f) => f.runId === RUNS[0]!.runId)?.bestLevel).toBe(99);
    // The write left nothing beside it.
    expect(readdirSync(dir).filter((n) => n.endsWith(".tmp"))).toEqual([]);
  });

  test("a run that changed after it was kept is read again", () => {
    const dir = runsDirWithRuns();
    const cachePath = join(dir, "run-facts.cache.json");
    cached(dir, cachePath, settled());
    // Each kept fact is poisoned, so a stale serve would show.
    for (const rel of keptIds(cachePath)) tamper(cachePath, rel, { bestLevel: 99, modelResponses: 99 });
    // Reclassified by hand: a termination written over the old one.
    const t0 = new Trajectory(join(dir, RUNS[1]!.runId));
    t0.setTermination(RUNS[1]!.runId, "manual");
    t0.close();
    // A record appended to an ended run's trajectory.
    const t2 = new Trajectory(join(dir, RUNS[2]!.runId));
    t2.append({ t: "response", text: "late" });
    t2.close();
    // Moved into the archive.
    renameSync(join(dir, RUNS[0]!.runId), join(dir, "archive", RUNS[0]!.runId));
    const now = settled();
    const { runs } = cached(dir, cachePath, now);
    const changed = (fs: RunFact[]) => fs.filter((f) => f.runId !== ARCHIVED.runId);
    expect(changed(runs)).toStrictEqual(changed(cold(dir, now)));
    expect(runs.find((f) => f.runId === RUNS[1]!.runId)?.terminationReason).toBe("manual");
    expect(runs.find((f) => f.runId === RUNS[2]!.runId)?.modelResponses).toBe(13);
    expect(runs.find((f) => f.runId === RUNS[0]!.runId)).toMatchObject({ archived: true, bestLevel: 5, modelResponses: 40 });
    // The untouched one is still served as kept; the moved run's old entry is gone, its new one kept.
    expect(runs.find((f) => f.runId === ARCHIVED.runId)?.bestLevel).toBe(99);
    expect(keptIds(cachePath)).toEqual([`archive/${ARCHIVED.runId}`, `archive/${RUNS[0]!.runId}`, RUNS[1]!.runId, RUNS[2]!.runId].sort());
  });

  test("a corrupt cache file, or one another reader wrote, is a cold read, and is replaced", () => {
    const dir = runsDirWithRuns();
    const cachePath = join(dir, "run-facts.cache.json");
    const now = settled();
    const plain = cold(dir, now);
    writeFileSync(cachePath, '{"version":"');
    const torn = cached(dir, cachePath, now);
    expect(torn.runs).toStrictEqual(plain);
    expect(torn.facts.failure).toBeUndefined(); // the replacement was written
    expect(keptIds(cachePath)).toHaveLength(4);
    // Another reader's file, with a key that matches: not served.
    const doc = JSON.parse(readFileSync(cachePath, "utf8")) as { version: string; entries: Record<string, { fact: RunFact }> };
    doc.entries[RUNS[0]!.runId]!.fact.bestLevel = 99;
    writeFileSync(cachePath, JSON.stringify({ ...doc, version: "another-reader" }));
    expect(cached(dir, cachePath, now).runs).toStrictEqual(plain);
    // An entry that is not a terminated run under its own id: not served either.
    doc.entries[RUNS[0]!.runId]!.fact.runId = RUNS[1]!.runId;
    writeFileSync(cachePath, JSON.stringify(doc));
    expect(cached(dir, cachePath, now).runs).toStrictEqual(plain);
    // Garbage that is not even an object.
    writeFileSync(cachePath, "null");
    expect(cached(dir, cachePath, now).runs).toStrictEqual(plain);
  });

  test("nothing is kept until a run's files have been still for the settle time, or while its database has a write in flight", () => {
    const dir = runsDirWithRuns();
    const cachePath = join(dir, "run-facts.cache.json");
    // Read at the time the fixtures were written: every file moved within the minute.
    const now = Date.now();
    expect(cached(dir, cachePath, now).runs).toStrictEqual(cold(dir, now));
    expect(existsSync(cachePath) ? keptIds(cachePath) : []).toEqual([]);
    // A rollback journal beside the database: a write is in flight, so the run has no key.
    writeFileSync(join(dir, RUNS[0]!.runId, "run.sqlite-journal"), "");
    expect(runFactKey(join(dir, RUNS[0]!.runId))).toBeNull();
    const later = settled();
    expect(cached(dir, cachePath, later).runs).toStrictEqual(cold(dir, later));
    expect(keptIds(cachePath)).not.toContain(RUNS[0]!.runId);
    expect(keptIds(cachePath)).toContain(RUNS[1]!.runId);
  });

  test("a cache that cannot be written costs nothing but the next cold read", () => {
    const dir = runsDirWithRuns();
    const now = settled();
    const { runs, facts } = cached(dir, join(dir, "no-such-dir", "run-facts.cache.json"), now);
    expect(runs).toStrictEqual(cold(dir, now));
    expect(facts.failure).toContain("could not write");
  });
});
