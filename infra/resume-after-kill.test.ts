/**
 * The 2026-09-20 incident, replayed from disk.
 *
 * Node DiskPressure evicted the fleet pod; the kubelet SIGKILLed it two
 * seconds after SIGTERM, inside the runner's unwind. The freeplay run
 * `fleet-deepseek-v41-flash-freeplay-deepseek-v4-1-flash-20260919` (Aurelian,
 * guid 625, level 7) was left with `ended_at`, `termination_reason` and
 * `pause_reason` all null. On restart 9h25m later the planner saw nothing to
 * resume, the run was not the character head, the fresh policy pick got no
 * keep list, and hygiene deleted Aurelian. The nemotron run at the same
 * instant had a 12h15m gap and was ended `stale`, becoming "attempt 104
 * (continues a103)".
 *
 * This reconstructs both run directories as the runner actually leaves them
 * (meta.json and run.sqlite through `Trajectory`, the trajectory's mtime set
 * back), reads them with the real `readRunFacts`, and asserts the plan
 * resumes both under their own run ids and that a fresh launch on the account
 * — even one the supervisor told nothing — never issues a character-delete
 * for guid 625.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { comparabilityOf } from "../runner/src/comparability";
import { loadRunConfig, newSessionToken } from "../runner/src/config";
import { readRunFacts, DEFAULT_POLICY } from "../runner/src/models";
import { readTrajectory, Trajectory } from "../runner/src/trajectory";
import type { FleetConfig, FleetRosterEntry } from "./run-fleet-config";
import { charactersFrom, implicitPauses, keepFor, planContinuations, planResumes, planStaleRuns } from "./run-fleet-plan";

const RUN_TS = join(import.meta.dir, "..", "runner", "src", "run.ts");
const H = 3_600_000;
const NOW = Date.now();
const AURELIAN_RUN = "fleet-deepseek-v41-flash-freeplay-deepseek-v4-1-flash-20260919";
const NEMOTRON_RUN = "fleet-nemotron-ultra-freeplay-nvidia-nemotron-ultra-20260918-a103";

/** A freeplay run as the killed runner left it: a run row with no verdict at all. */
function killedFreeplayRun(runsDir: string, o: { runId: string; model: string; account: string; character: string; level: number; quietForMs: number }): void {
  const dir = join(runsDir, o.runId);
  mkdirSync(dir, { recursive: true });
  const traj = new Trajectory(dir);
  const config = loadRunConfig({
    runId: o.runId,
    token: newSessionToken(),
    driver: "openai",
    model: o.model,
    episode: "freeplay",
    extra: true,
    runsDir,
    moduleUrl: "http://127.0.0.1:9",
    account: o.account,
    character: o.character,
    race: 3,
    class: 2,
  });
  const startedAt = NOW - o.quietForMs - 20 * H;
  traj.writeMeta({ runId: o.runId, harnessVersion: "harness-0.5-776-g170e07de", startedAt, config, comparability: comparabilityOf(config, "harness-0.5-776-g170e07de") });
  for (let i = 0; i < 40; i++) traj.append({ t: "response", text: "…" });
  for (let l = 1; l <= o.level; l++) traj.recordState(o.runId, { level: l, xp: l * 100 });
  traj.close();
  const row = new Trajectory(dir).runRow(o.runId);
  expect(row?.["ended_at"]).toBeNull();
  expect(row?.["termination_reason"]).toBeNull();
  expect(row?.["pause_reason"]).toBeNull();
  const m = (NOW - o.quietForMs) / 1000;
  utimesSync(join(dir, "trajectory.jsonl"), m, m);
}

const roster: Record<string, FleetRosterEntry> = {
  "deepseek-v41-flash": { model: "deepseek/deepseek-v4.1-flash", tier: "t1", idle: "unlimited" },
  "nemotron-ultra": { model: "nvidia/nemotron-ultra", tier: "t1", idle: "unlimited" },
  ox: { model: "stealth/ox-alpha:free", tier: "t1", idle: "none" },
};
const config: Pick<FleetConfig, "jobs" | "roster" | "policy" | "accounts"> = {
  jobs: [],
  roster,
  policy: { ...DEFAULT_POLICY, series: "0.5" },
  accounts: { pinned: {}, pool: ["RUNNER2", "RUNNER3", "RUNNER4"], paid: [], local: [] },
};
const held = (): string | undefined => undefined;

function incidentRunsDir(): string {
  const runsDir = mkdtempSync(join(tmpdir(), "wrathbench-20260920-"));
  killedFreeplayRun(runsDir, { runId: AURELIAN_RUN, model: "deepseek/deepseek-v4.1-flash", account: "RUNNER2", character: "Aurelian", level: 7, quietForMs: 9 * H + 25 * 60_000 });
  killedFreeplayRun(runsDir, { runId: NEMOTRON_RUN, model: "nvidia/nemotron-ultra", account: "RUNNER3", character: "Thessaly", level: 11, quietForMs: 12 * H + 15 * 60_000 });
  return runsDir;
}

describe("2026-09-20: the evicted pod's freeplay runs come back where they left off", () => {
  test("both verdict-less runs are resumed under their own run ids on the first tick; nothing is ended", () => {
    const runsDir = incidentRunsDir();
    const raw = readRunFacts(runsDir, NOW, { includeArchived: true });
    expect(raw.map((f) => f.runId).sort()).toEqual([AURELIAN_RUN, NEMOTRON_RUN]);
    for (const f of raw) {
      expect(f.live).toBe(false);
      expect(f.pause).toBeNull();
      expect(f.terminationReason).toBeNull();
    }
    const runs = implicitPauses({ runs: raw, now: NOW });
    expect(runs.find((f) => f.runId === AURELIAN_RUN)?.pause).toMatchObject({ reason: "offline", count: 1 });
    // The nemotron gap is past the twelve-hour fallback; freeplay does not go stale.
    expect(planStaleRuns({ runs, refs: Object.keys(roster), now: NOW })).toEqual([]);
    const plan = planResumes({ runs, config, running: new Map(), held, now: NOW });
    expect(plan.end).toEqual([]);
    expect(plan.listed).toEqual([]);
    expect(plan.resume.map((r) => [r.runId, r.account]).sort()).toEqual([
      [AURELIAN_RUN, "RUNNER2"],
      [NEMOTRON_RUN, "RUNNER3"],
    ]);
    for (const r of plan.resume) {
      expect(r.job.resume?.runId).toBe(r.runId);
      expect(r.job.continueFrom).toBeUndefined();
    }
  });

  test("a verdict-less run somebody archived is read as archived and left out of the resumes", () => {
    const runsDir = incidentRunsDir();
    const stray = "fleet-deepseek-v41-flash-freeplay-deepseek-v4-1-flash-20260920-a2";
    killedFreeplayRun(join(runsDir, "archive"), { runId: stray, model: "deepseek/deepseek-v4.1-flash", account: "RUNNER2", character: "Novice", level: 1, quietForMs: 2 * H });
    const raw = readRunFacts(runsDir, NOW, { includeArchived: true });
    expect(raw.find((f) => f.runId === stray)?.archived).toBe(true);
    expect(raw.find((f) => f.runId === AURELIAN_RUN)?.archived).toBeUndefined();
    const runs = implicitPauses({ runs: raw, now: NOW });
    expect(runs.find((f) => f.runId === stray)?.pause).toBeNull();
    // The newer archived run does not shadow the real one for the same model.
    const plan = planResumes({ runs, config, running: new Map(), held, now: NOW });
    expect(plan.resume.map((r) => r.runId).sort()).toEqual([AURELIAN_RUN, NEMOTRON_RUN]);
    // Nor does it displace Aurelian as the head.
    expect(charactersFrom(runs, roster).get("deepseek-v41-flash")?.runId).toBe(AURELIAN_RUN);
  });

  test("Aurelian's run is its ref's character head, and any other launch on RUNNER2 is told to keep Aurelian", () => {
    const runsDir = incidentRunsDir();
    const runs = readRunFacts(runsDir, NOW, { includeArchived: true });
    const characters = charactersFrom(runs, roster);
    expect(characters.get("deepseek-v41-flash")).toEqual({ runId: AURELIAN_RUN, account: "RUNNER2", character: "Aurelian" });
    expect(characters.get("nemotron-ultra")).toEqual({ runId: NEMOTRON_RUN, account: "RUNNER3", character: "Thessaly" });
    expect(keepFor("RUNNER2", characters, "ox")).toEqual(["Aurelian"]);
    // Had the policy picked deepseek fresh on RUNNER2 anyway, it would continue Aurelian, not start over.
    const pick = { job: { refs: ["deepseek-v41-flash"], ref: "deepseek-v41-flash", episode: "freeplay" as const, repeat: 1, name: "deepseek-v41-flash-freeplay", enabled: true, source: "policy" as const, attempt: 2 }, account: "RUNNER2", why: "extra" };
    expect(planContinuations([pick], characters, roster).picks[0]!.job.continueFrom).toBe(AURELIAN_RUN);
  });

  test("a fresh launch on RUNNER2 that was told nothing still never issues a character-delete for guid 625", async () => {
    const runsDir = incidentRunsDir();
    // The module as the incident's launch saw it: Aurelian standing at level
    // 7, and a level-1 leftover of an ended run next to it.
    let chars = [
      { name: "Aurelian", guid: "625", race: 3, class: 2, gender: 0, level: 7 },
      { name: "Novice", guid: "631", race: 3, class: 2, gender: 0, level: 1 },
    ];
    const deleted: string[] = [];
    const server = Bun.serve({
      port: 0,
      fetch: async (req) => {
        const path = new URL(req.url).pathname;
        if (path === "/characters") return Response.json({ ok: true, token: "t", enum: { count: chars.length, characters: chars } });
        if (path === "/character-delete") {
          const body = (await req.json()) as { character: string };
          deleted.push(body.character);
          chars = chars.filter((c) => c.name !== body.character);
          return Response.json({ ok: true, token: "t", character: body.character, deleted: true });
        }
        return new Response("not found", { status: 404 });
      },
    });
    try {
      const script = join(runsDir, "stub.json");
      writeFileSync(script, JSON.stringify([{ content: "hello", toolCalls: [] }]));
      // The worst case: a scored launch of another ref, with no
      // --keep-characters — exactly the a2 launch, before the supervisor knew.
      const runId = "fleet-ox-e90-stealth-ox-alpha-free-20260920-a2";
      const proc = Bun.spawn({
        cmd: [
          process.execPath, RUN_TS,
          "--driver", "stub", "--stub", script,
          "--run-id", runId, "--episode", "e90",
          "--runs-dir", runsDir, "--module-url", `http://127.0.0.1:${server.port}`,
          "--account", "RUNNER2", "--race", "3", "--class", "2",
          "--step-interval-ms", "0", "--max-turns", "1",
        ],
        cwd: runsDir,
        env: { ...process.env, WRATHBENCH_MODULE_URL: `http://127.0.0.1:${server.port}`, WRATHBENCH_MODULE_SECRET: undefined },
        stdout: "ignore",
        stderr: "pipe",
      });
      const stderr = await new Response(proc.stderr).text();
      await proc.exited;
      expect(deleted).toEqual(["Novice"]);
      expect(chars.map((c) => c.guid)).toEqual(["625"]);
      expect(stderr).toContain("KEPT Aurelian (guid 625, level 7)");
      expect(stderr).toContain(`belongs to run ${AURELIAN_RUN}, which has not ended`);
      const kept = readTrajectory(join(runsDir, runId)).find((r) => r.t === "harness" && r["kind"] === "hygiene-kept");
      expect(kept?.["guid"]).toBe("625");
    } finally {
      server.stop(true);
    }
  }, 30_000);
});
