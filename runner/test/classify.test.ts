/**
 * `classify.ts` is how an operator ends a run by hand, which is also how a
 * pinned character is released. A run with no termination and no pause may
 * still be playing, so ending it is refused unless forced; a run id with no
 * run behind it is refused outright rather than created.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLASSIFY_REFUSED_EXIT, classifyRefusal, readVerdict } from "../src/classify";
import { loadRunConfig } from "../src/config";
import { Trajectory } from "../src/trajectory";

const CLASSIFY = join(import.meta.dir, "..", "src", "classify.ts");
let runs: string;

beforeAll(() => {
  runs = mkdtempSync(join(tmpdir(), "wb-classify-"));
});

afterAll(() => {
  rmSync(runs, { recursive: true, force: true });
});

function writeRun(runId: string, verdict: "live" | "paused" | "ended"): void {
  const t = new Trajectory(join(runs, runId));
  t.writeMeta({ runId, harnessVersion: "harness-0.5-1-gabc", startedAt: 1_000, config: loadRunConfig({ runId, driver: "openai", model: "m/free", episode: "freeplay" }) });
  if (verdict === "paused") t.setPause(runId, "rate-limited", "429");
  if (verdict === "ended") t.setTermination(runId, "idle", "fixture");
  t.close();
}

async function classify(...args: string[]): Promise<{ code: number; stderr: string }> {
  const proc = Bun.spawn({ cmd: [process.execPath, CLASSIFY, ...args], env: { ...process.env, WRATHBENCH_RUNS_DIR: runs }, stdout: "pipe", stderr: "pipe" });
  const stderr = await new Response(proc.stderr).text();
  return { code: await proc.exited, stderr };
}

describe("the classify guard", () => {
  test("the predicate: no row is refused always, no verdict is refused unless forced", () => {
    expect(classifyRefusal("r", null, true)).toContain("no run r");
    const live = { terminationReason: null, pauseReason: null };
    expect(classifyRefusal("r", live, false)).toContain("may still be live");
    expect(classifyRefusal("r", live, true)).toBeNull();
    expect(classifyRefusal("r", { terminationReason: null, pauseReason: "rate-limited" }, false)).toBeNull();
    expect(classifyRefusal("r", { terminationReason: "idle", pauseReason: null }, false)).toBeNull();
  });

  test("the verdict is read off the run's own row", () => {
    writeRun("v-live", "live");
    writeRun("v-paused", "paused");
    expect(readVerdict(runs, "v-live")).toEqual({ terminationReason: null, pauseReason: null });
    expect(readVerdict(runs, "v-paused")).toEqual({ terminationReason: null, pauseReason: "rate-limited" });
    expect(readVerdict(runs, "no-such-run")).toBeNull();
  });

  test("a run that may be live is refused and left untouched; --force ends it", async () => {
    writeRun("c-live", "live");
    const refused = await classify("c-live", "manual", "release", "the", "character");
    expect(refused.code).toBe(CLASSIFY_REFUSED_EXIT);
    expect(refused.stderr).toContain("--force");
    expect(readVerdict(runs, "c-live")).toEqual({ terminationReason: null, pauseReason: null });

    const forced = await classify("--force", "c-live", "manual", "release");
    expect(forced.code).toBe(0);
    expect(readVerdict(runs, "c-live")).toEqual({ terminationReason: "manual", pauseReason: null });
  }, 20_000);

  test("a paused run is ended without --force, and its pause goes with it", async () => {
    writeRun("c-paused", "paused");
    expect((await classify("c-paused", "manual")).code).toBe(0);
    expect(readVerdict(runs, "c-paused")).toEqual({ terminationReason: "manual", pauseReason: null });
  }, 20_000);

  test("a mistyped run id is refused, and no directory is made for it", async () => {
    const r = await classify("--force", "no-such-run", "manual");
    expect(r.code).toBe(CLASSIFY_REFUSED_EXIT);
    expect(existsSync(join(runs, "no-such-run"))).toBe(false);
  }, 20_000);
});
