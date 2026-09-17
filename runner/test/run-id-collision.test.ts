/**
 * The run id is a projection (`fleet-<job>-<model>[-effort]-<stamp>[-aN]`,
 * where the attempt counter counts the run facts the fleet can SEE), so a run
 * directory that yields no fact makes the next launch project an id that is
 * already on disk. Before this guard the launch mkdir'd into it and wrote a
 * second run through the first one's trajectory. Now it refuses, loudly, and a
 * resume — the one launch that is SUPPOSED to reopen a directory — still works.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertRunDirFree } from "../src/run";
import { ARCHIVE_DIR } from "../viewer/archive-dir";

const RUN_TS = join(import.meta.dir, "..", "src", "run.ts");
const RUN_ID = "fleet-sub-opus-low-e90-opus-low-20260917-a2";

function runsDirWith(where: "live" | "archive" | "nothing"): string {
  const runsDir = mkdtempSync(join(tmpdir(), "wrathbench-collision-"));
  if (where === "nothing") return runsDir;
  const dir = where === "live" ? join(runsDir, RUN_ID) : join(runsDir, ARCHIVE_DIR, RUN_ID);
  mkdirSync(dir, { recursive: true });
  // A run that left no readable fact: exactly what makes the counter reuse the id.
  writeFileSync(join(dir, "meta.json"), "{ truncated");
  return runsDir;
}

describe("assertRunDirFree", () => {
  test("a free run id passes", () => {
    expect(() => assertRunDirFree(runsDirWith("nothing"), RUN_ID)).not.toThrow();
  });

  test("a live run directory is refused, naming the path and the projection", () => {
    const runsDir = runsDirWith("live");
    expect(() => assertRunDirFree(runsDir, RUN_ID)).toThrow(/run id already on disk/);
    expect(() => assertRunDirFree(runsDir, RUN_ID)).toThrow(/the attempt counter projected an id that exists/);
    expect(() => assertRunDirFree(runsDir, RUN_ID)).toThrow(new RegExp(join(runsDir, RUN_ID).replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  });

  test("an ARCHIVED run holds its id too — parked is not gone", () => {
    expect(() => assertRunDirFree(runsDirWith("archive"), RUN_ID)).toThrow(/run id already on disk/);
  });
});

describe("a fresh launch onto a taken run id", () => {
  test("exits non-zero before it writes anything into the directory", async () => {
    const runsDir = runsDirWith("live");
    const proc = Bun.spawn({
      cmd: [
        process.execPath, RUN_TS,
        "--driver", "stub",
        "--run-id", RUN_ID,
        "--runs-dir", runsDir,
        "--module-url", "http://127.0.0.1:9",
        "--account", "RUNNER2",
        "--race", "3",
        "--class", "2",
      ],
      cwd: runsDir,
      env: { ...process.env, WRATHBENCH_MODULE_URL: "http://127.0.0.1:9", WRATHBENCH_MODULE_SECRET: undefined },
      stdout: "pipe",
      stderr: "pipe",
    });
    const stderr = await new Response(proc.stderr).text();
    const code = await proc.exited;
    expect(code).toBe(2);
    expect(stderr).toContain("run id already on disk");
    expect(stderr).toContain(`--resume ${RUN_ID}`);
    // The refusal comes before the stub driver's own argument check, which is
    // the evidence that nothing downstream of it ran.
    expect(stderr).not.toContain("--driver stub requires");
  }, 30_000);
});
