/**
 * What a run pod's launcher reads from the other runs on its behalf
 * (`launch-context.ts`): built from a runs directory as the runner would read
 * it, written beside the run, and read back as untrusted.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadRunConfig, newSessionToken } from "../src/config";
import { buildLaunchContext, hygieneAccountsOf, LAUNCH_CONTEXT_FILE, launchOwners, readLaunchContext, writeLaunchContext } from "../src/launch-context";
import { holdsOnlyLaunchFiles } from "../src/launch-files";
import { SHARED_WORLD } from "../src/session-record";
import { Trajectory } from "../src/trajectory";
import { tempDirs } from "./fixtures/temp-dirs";

const tempDir = tempDirs();

/** A run directory on `account` that played `character`, with a usage reading and a recorded guid when given. */
function run(
  runsDir: string,
  runId: string,
  o: { account: string; character: string; startedAt: number; ended?: string; usage?: { credential: string; observedAt: number }; guid?: string; world?: string },
): void {
  const dir = join(runsDir, runId);
  mkdirSync(dir, { recursive: true });
  const traj = new Trajectory(dir);
  const config = loadRunConfig({ runId, token: newSessionToken(), driver: "stub", episode: "freeplay", runsDir, moduleUrl: "http://127.0.0.1:9", account: o.account, character: o.character, race: 3, class: 2 });
  traj.writeMeta({ runId, harnessVersion: "0.0.0-test", startedAt: o.startedAt, config });
  if (o.usage !== undefined) traj.recordSubscriptionUsage({ ...o.usage, windows: [{ usedPercent: 40, windowMinutes: 300, resetsAt: null }] });
  if (o.ended !== undefined) traj.setTermination(runId, o.ended as "manual", "test");
  traj.close();
  if (o.world !== undefined) writeFileSync(join(dir, "world.json"), JSON.stringify({ id: o.world }));
  if (o.guid !== undefined) {
    mkdirSync(join(dir, "session"), { recursive: true });
    writeFileSync(join(dir, "session", "session.json"), JSON.stringify({ format: "wrath-session/1", id: `s-${runId}`, character: { guid: o.guid } }));
  }
}

describe("buildLaunchContext", () => {
  function fixture(): string {
    const runsDir = tempDir("wrathbench-launch-context-");
    run(runsDir, "paused-freeplay", { account: "RUNNER2", character: "Aurelian", startedAt: 1, usage: { credential: "codex-1", observedAt: 10 }, guid: "12" });
    run(runsDir, "ended-episode", { account: "RUNNER2", character: "Novice", startedAt: 2, ended: "episode-limit", usage: { credential: "codex-1", observedAt: 20 }, guid: "13" });
    run(runsDir, "other-lane", { account: "RUNNER3", character: "Stranger", startedAt: 3, usage: { credential: "claude-2", observedAt: 30 }, guid: "14" });
    run(runsDir, "eval-world", { account: "RUNNER4", character: "Faraway", startedAt: 4, guid: "15", world: "wabcdefghij" });
    mkdirSync(join(runsDir, "me-now"), { recursive: true });
    return runsDir;
  }

  test("a fresh launch: its accounts' owners, its credential's newest reading, the own guids of its world and no other", () => {
    const runsDir = fixture();
    const ctx = buildLaunchContext({ runsDir, runId: "me-now", resume: false, accounts: ["runner2"], credentials: ["codex-1", "env:CODEX_HOME"], world: SHARED_WORLD });
    expect(ctx.characterOwners).toEqual({
      RUNNER2: { aurelian: { runId: "paused-freeplay", ended: false }, novice: { runId: "ended-episode", ended: true } },
    });
    expect(ctx.subscriptionUsage.map((u) => [u.credential, u.observedAt])).toEqual([["codex-1", 20]]);
    // The eval world's character is another world's guid, and not own here.
    expect(ctx.ownGuids).toEqual(["12", "13", "14"]);
    expect(buildLaunchContext({ runsDir, runId: "me-now", resume: false, accounts: [], credentials: null, world: "wabcdefghij" }).ownGuids).toEqual(["15"]);
  });

  test("a resume carries no owners (hygiene runs on a fresh launch only), and never names its own guid", () => {
    const runsDir = fixture();
    const ctx = buildLaunchContext({ runsDir, runId: "paused-freeplay", resume: true, accounts: ["RUNNER2"], credentials: ["codex-1"], world: SHARED_WORLD });
    expect(ctx.characterOwners).toBeUndefined();
    expect(ctx.ownGuids).toEqual(["13", "14"]);
  });

  test("written beside the run, it reads back whole, and the directory still holds only launch files", () => {
    const runsDir = fixture();
    const dir = join(runsDir, "me-now");
    const ctx = buildLaunchContext({ runsDir, runId: "me-now", resume: false, accounts: ["RUNNER2", "RUNNER9"], credentials: ["codex-1"], world: SHARED_WORLD });
    writeLaunchContext(dir, ctx);
    expect(readLaunchContext(dir)).toEqual(ctx);
    expect(holdsOnlyLaunchFiles(dir)).toBe(true);
    expect(launchOwners(readLaunchContext(dir), "runner2")?.get("aurelian")).toEqual({ runId: "paused-freeplay", ended: false });
    // An account the launcher read with nothing on it is an empty map, not a missing one.
    expect(launchOwners(readLaunchContext(dir), "RUNNER9")).toEqual(new Map());
    expect(launchOwners(readLaunchContext(dir), "RUNNER5")).toBeUndefined();
  });

  test("read as untrusted: a missing, torn or misshapen file is no context, and a bad usage reading is dropped", () => {
    const dir = tempDir("wrathbench-launch-context-bad-");
    expect(readLaunchContext(dir)).toBeUndefined();
    writeFileSync(join(dir, LAUNCH_CONTEXT_FILE), "{");
    expect(readLaunchContext(dir)).toBeUndefined();
    writeFileSync(join(dir, LAUNCH_CONTEXT_FILE), JSON.stringify({ subscriptionUsage: [], ownGuids: [12] }));
    expect(readLaunchContext(dir)).toBeUndefined();
    writeFileSync(join(dir, LAUNCH_CONTEXT_FILE), JSON.stringify({ characterOwners: { RUNNER: { x: { runId: "r", ended: "no" } } }, subscriptionUsage: [], ownGuids: [] }));
    expect(readLaunchContext(dir)).toBeUndefined();
    writeFileSync(join(dir, LAUNCH_CONTEXT_FILE), JSON.stringify({ subscriptionUsage: [{ credential: "codex-1" }], ownGuids: ["7"] }));
    expect(readLaunchContext(dir)).toEqual({ subscriptionUsage: [], ownGuids: ["7"] });
    expect(launchOwners(readLaunchContext(dir), "RUNNER")).toBeUndefined();
  });
});

describe("hygieneAccountsOf", () => {
  test("the launch's --account, the config's default without one, and a fan-out grant's --accounts, upper-cased once each", () => {
    expect(hygieneAccountsOf({ account: "runner2" })).toEqual(["RUNNER2"]);
    expect(hygieneAccountsOf({})).toEqual(["RUNNER"]);
    expect(hygieneAccountsOf({ "max-characters": "2", accounts: "FAN1, fan2", account: "FAN1" })).toEqual(["FAN1", "FAN2"]);
  });
});
