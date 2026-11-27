/**
 * run.ts in a run pod, which mounts only its own run directory: hygiene takes
 * the owners its launcher read and handed over (`launch-context.ts`), and a fresh launch with
 * none is refused before anything is written, never run on an empty map.
 * run.ts runs as a subprocess with the stub driver against a fake module that
 * answers only the character listing and delete.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { RUN_POD_STAMP_ENV } from "../src/drivers";
import { encodeLaunchContext, LAUNCH_CONTEXT_ENV, type LaunchContext } from "../src/launch-context";
import { tempDirs } from "./fixtures/temp-dirs";

const tempDir = tempDirs();
const RUN_TS = join(import.meta.dir, "..", "src", "run.ts");

function fakeModule(chars: { name: string; guid: string; level?: number }[]) {
  const deleted: string[] = [];
  const server = Bun.serve({
    port: 0,
    fetch: async (req) => {
      const path = new URL(req.url).pathname;
      if (path === "/characters") return Response.json({ ok: true, enum: { count: chars.length, characters: chars } });
      if (path === "/character-delete") {
        const body = (await req.json()) as { character: string };
        deleted.push(body.character);
        chars = chars.filter((c) => c.name !== body.character);
        return Response.json({ ok: true, character: body.character, deleted: true });
      }
      return new Response("not found", { status: 404 });
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, deleted, stop: () => server.stop(true) };
}

async function launchInPod(runsDir: string, moduleUrl: string, runId: string, context?: LaunchContext): Promise<{ code: number; stderr: string }> {
  const script = join(runsDir, "..", "stub.json");
  writeFileSync(script, JSON.stringify([{ content: "hello", toolCalls: [] }]));
  const proc = Bun.spawn({
    cmd: [process.execPath, RUN_TS, "--driver", "stub", "--stub", script, "--runs-dir", runsDir, "--module-url", moduleUrl, "--account", "RUNNER2", "--race", "3", "--class", "2", "--step-interval-ms", "0", "--episode", "freeplay", "--run-id", runId],
    cwd: runsDir,
    env: { ...process.env, WRATHBENCH_MODULE_URL: moduleUrl, WRATHBENCH_MODULE_SECRET: undefined, [RUN_POD_STAMP_ENV]: "1", [LAUNCH_CONTEXT_ENV]: context === undefined ? undefined : encodeLaunchContext(context) },
    stdout: "pipe",
    stderr: "pipe",
  });
  const stderr = await new Response(proc.stderr).text();
  return { code: await proc.exited, stderr };
}

describe("run.ts in a run pod", () => {
  test("a fresh launch with no owners from its launcher is refused before anything is written", async () => {
    const runsDir = join(tempDir("wrathbench-run-pod-ctx-"), "runs");
    mkdirSync(join(runsDir, "pod-run"), { recursive: true });
    const mod = fakeModule([{ name: "Novice", guid: "311", level: 1 }]);
    try {
      const { code, stderr } = await launchInPod(runsDir, mod.url, "pod-run");
      expect(code).toBe(2);
      expect(stderr).toContain("left no character owners for RUNNER2");
      expect(existsSync(join(runsDir, "pod-run", "meta.json"))).toBe(false);
      expect(mod.deleted).toEqual([]);
    } finally {
      mod.stop();
    }
  }, 60_000);

  test("hygiene keeps what the launcher's owners say an un-ended run still plays", async () => {
    const runsDir = join(tempDir("wrathbench-run-pod-ctx-"), "runs");
    mkdirSync(join(runsDir, "pod-run"), { recursive: true });
    // The sibling that owns Novice is not in this pod's runs directory at all: only the launcher saw it.
    const context: LaunchContext = { characterOwners: { RUNNER2: { novice: { runId: "paused-sibling", ended: false } } }, subscriptionUsage: [], ownGuids: [] };
    // Novice alone: a level-1 character nobody accounts for would be deleted,
    // so keeping it proves the handed-over owners reached hygiene. No other
    // character, so hygiene deletes nothing and skips its 5 s re-list
    // (clearing the rest is hygiene.test.ts's).
    const mod = fakeModule([{ name: "Novice", guid: "311", level: 1 }]);
    try {
      const { stderr } = await launchInPod(runsDir, mod.url, "pod-run", context);
      expect(mod.deleted).toEqual([]);
      expect(stderr).toContain("Novice");
      expect(existsSync(join(runsDir, "pod-run", "meta.json"))).toBe(true);
    } finally {
      mod.stop();
    }
  }, 60_000);
});
