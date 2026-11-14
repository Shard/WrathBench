/**
 * The task episodes in the fleet (operator, 2026-11-14): `t2` buys three
 * `deadmines-solo` attempts, the five-agent `deadmines` only where the roster
 * entry opts in (`deadmines: true`), and the policy holds the five-agent id
 * and any codex row until a rehearsal clears it (`policy.rehearsed`) — all of
 * it behind the scored-episode hold. A pick draws its party from the eval
 * pool, plays on a world of its own, and launches with the id's file.
 */

import { describe, expect, test } from "bun:test";
import { DEFAULT_POLICY, parsePolicyBlock, projectModel, rehearsalHold, type ModelState, type RosterModel, type SchedulingPolicy } from "../runner/src/models";
import { SCORED_EPISODES_WAIT, loadRunConfig } from "../runner/src/config";
import { taskHash } from "../runner/src/task-episodes";
import { taskDefinition } from "../runner/src/task-episodes";
import { parseFleet, type FleetConfig } from "./run-fleet-config";
import { evalPoolDraw, evalPoolTaken, planTick } from "./run-fleet-plan";
import { episodeFlags, resolve } from "./run-roster";
import { stagingHash, taskLaunchFile } from "./task-launch";
import { configFromArgs } from "../runner/src/run";
import { writeCampaignFile } from "../runner/src/campaign-file";
import { tempDirs } from "../runner/test/fixtures/temp-dirs";

const tempDir = tempDirs();
const STAMP = "20261114";
const NOW = Date.UTC(2026, 10, 14, 12);
const CREDENTIALS = {
  "claude-2": { provider: "claude", secretEnv: "CLAUDE_CODE_OAUTH_TOKEN_2", slots: 5, billing: "paid", enabled: true },
  "chatgpt-1": { provider: "chatgpt", secretEnv: "CODEX_HOME_1", slots: 5, billing: "paid", enabled: true },
};
const ENV = { WRATHBENCH_EVAL_POOL_SIZE: "10" };

function fleet(roster: Record<string, unknown>, policy: Record<string, unknown> = { worlds: "evals" }): FleetConfig {
  return parseFleet({ _notes: ["n"], accounts: { pool: ["RUNNER"] }, roster, credentials: CREDENTIALS, policy, queue: [] }, { env: ENV });
}

/** A model whose level evals are all counted, so a Deadmines id is what it owes. */
function owing(entry: RosterModel, policy: SchedulingPolicy): ModelState {
  const s = projectModel(entry, [], policy, { now: NOW });
  for (const ep of ["e90", "e360"] as const) s.perEpisode[ep]!.counted = s.perEpisode[ep]!.target;
  return s;
}

function plan(cfg: FleetConfig, states: ModelState[], scoredGate?: string) {
  const draw = evalPoolDraw({ mode: cfg.policy.worlds, pool: cfg.accounts.evalPool ?? [], taken: evalPoolTaken([], []), held: () => undefined });
  return planTick(cfg, states, () => undefined, STAMP, [], [], undefined, new Map(), new Set(), [], [], undefined, true, [], [], { max: 4 }, scoredGate, undefined, draw);
}

const SON = { tier: "t2", model: "sonnet", driver: "claude-code", effort: "max" };

describe("what buys an attempt", () => {
  test("t2 buys three deadmines-solo attempts; the five-agent id only with the entry's opt-in", () => {
    const plain = projectModel({ name: "s", model: "sonnet", driver: "claude-code", tier: "t2" }, [], DEFAULT_POLICY, { now: NOW });
    expect(plain.eligible).toEqual(["e90", "e360", "deadmines-solo"]);
    expect(plain.perEpisode["deadmines-solo"]!.target).toBe(3);
    expect(plain.perEpisode.deadmines!.target).toBe(0);
    const opted = projectModel({ name: "s", model: "sonnet", driver: "claude-code", tier: "t2", deadmines: true }, [], DEFAULT_POLICY, { now: NOW });
    expect(opted.eligible).toEqual(["e90", "e360", "deadmines-solo", "deadmines"]);
    expect(opted.perEpisode.deadmines!.target).toBe(3);
    for (const tier of ["t0", "t1"] as const) {
      const s = projectModel({ name: "s", model: "sonnet", driver: "claude-code", tier, deadmines: true }, [], DEFAULT_POLICY, { now: NOW });
      expect(s.perEpisode["deadmines-solo"]!.target).toBe(0);
      expect(s.perEpisode.deadmines!.target).toBe(0);
    }
  });

  test("the roster key is true or absent, and never on a campaignOnly entry", () => {
    const opted = fleet({ son: { ...SON, deadmines: true } });
    expect(opted.roster["son"]!.deadmines).toBe(true);
    expect(opted.refusals).toEqual([]);
    expect(fleet({ son: SON }).roster["son"]!.deadmines).toBeUndefined();
    expect(() => fleet({ son: { ...SON, deadmines: false } })).toThrow("deadmines is true or absent");
    expect(() => fleet({ son: { ...SON, deadmines: "yes" } })).toThrow("deadmines is true or absent");
    expect(() => fleet({ son: { ...SON, deadmines: true, campaignOnly: true } })).toThrow("campaignOnly entry runs no scored episode");
  });

  test("policy.rehearsed names only what a rehearsal can clear, once each; absent clears nothing", () => {
    expect(parsePolicyBlock(undefined).rehearsed).toEqual([]);
    expect(parsePolicyBlock({ rehearsed: ["deadmines", "codex"] }).rehearsed).toEqual(["deadmines", "codex"]);
    expect(() => parsePolicyBlock({ rehearsed: ["deadmines-solo"] })).toThrow("policy.rehearsed must be a list of");
    expect(() => parsePolicyBlock({ rehearsed: "deadmines" })).toThrow("policy.rehearsed must be a list of");
    expect(() => parsePolicyBlock({ rehearsed: ["codex", "codex"] })).toThrow("names an entry twice");
  });

  test("a queue job never names a task episode", () => {
    expect(() => parseFleet({ _notes: ["n"], accounts: { pool: ["RUNNER"] }, roster: { son: SON }, credentials: CREDENTIALS, queue: [{ ref: "son", episode: "deadmines-solo" }] }, { env: ENV })).toThrow(
      "--episode deadmines-solo is the policy's",
    );
  });
});

describe("the holds", () => {
  test("the five-agent id waits on its rehearsal, and a codex row on either id", () => {
    expect(rehearsalHold("deadmines", "claude-code", { rehearsed: [] })).toContain("program-loop rehearsal");
    expect(rehearsalHold("deadmines", "claude-code", { rehearsed: ["deadmines"] })).toBeNull();
    expect(rehearsalHold("deadmines-solo", "claude-code", { rehearsed: [] })).toBeNull();
    expect(rehearsalHold("deadmines-solo", "codex", { rehearsed: [] })).toContain('does not name "codex"');
    expect(rehearsalHold("deadmines-solo", "codex", { rehearsed: ["codex"] })).toBeNull();
    expect(rehearsalHold("e90", "codex", { rehearsed: [] })).toBeNull();
  });

  test("the scored-episode hold holds both ids", () => {
    const cfg = fleet({ son: { ...SON, deadmines: true } }, { worlds: "evals", rehearsed: ["deadmines"] });
    const s = owing({ name: "son", model: "sonnet", driver: "claude-code", tier: "t2", deadmines: true }, cfg.policy);
    const p = plan(cfg, [s], SCORED_EPISODES_WAIT!);
    expect(p.policy).toEqual([]);
    expect(p.heldPicks).toEqual([{ name: "son", episode: "deadmines-solo", why: SCORED_EPISODES_WAIT! }]);
    s.perEpisode["deadmines-solo"]!.counted = 3;
    const five = plan(cfg, [s], SCORED_EPISODES_WAIT!);
    expect(five.policy).toEqual([]);
    expect(five.heldPicks).toEqual([{ name: "son", episode: "deadmines", why: SCORED_EPISODES_WAIT! }]);
    expect(SCORED_EPISODES_WAIT).not.toBeNull();
  });

  test("an unrehearsed five-agent attempt is said and passed over; the one-agent id still goes", () => {
    const cfg = fleet({ son: { ...SON, deadmines: true } });
    const p = plan(cfg, [owing({ name: "son", model: "sonnet", driver: "claude-code", tier: "t2", deadmines: true }, cfg.policy)]);
    expect(p.heldPicks.map((h) => [h.episode, h.why])).toEqual([["deadmines", expect.stringContaining("program-loop rehearsal")]]);
    expect(p.policy.map((x) => x.job.episode)).toEqual(["deadmines-solo"]);
  });

  test("a model that owes only held attempts does what a model owing nothing does", () => {
    const cfg = fleet({ cx: { tier: "t2", model: "gpt-6.1", driver: "codex", idle: "unlimited" } });
    const s = owing({ name: "cx", model: "gpt-6.1", driver: "codex", tier: "t2", idle: "unlimited" }, cfg.policy);
    const p = plan(cfg, [s]);
    expect(p.heldPicks.map((h) => h.episode)).toEqual(["deadmines-solo"]);
    expect(p.policy.map((x) => x.job.episode)).toEqual(["freeplay"]);
  });
});

describe("a deadmines-solo pick", () => {
  const cfg = fleet({ son: SON });
  const state = owing({ name: "son", model: "sonnet", driver: "claude-code", tier: "t2" }, cfg.policy);

  test("draws five eval accounts and spawns one fan-out run with the id's file", () => {
    const p = plan(cfg, [state]);
    expect(p.heldPicks).toEqual([]);
    const pick = p.policy[0]!;
    expect(pick.job).toMatchObject({ episode: "deadmines-solo", fanout: true, accounts: ["EVAL01", "EVAL02", "EVAL03", "EVAL04", "EVAL05"], account: "EVAL01" });
    expect(pick.account).toBe("EVAL01");
  });

  test("is held, not moved to the shared world, while worlds are off", () => {
    const off = fleet({ son: SON }, { worlds: "off" });
    const p = plan(off, [owing({ name: "son", model: "sonnet", driver: "claude-code", tier: "t2" }, off.policy)]);
    expect(p.policy).toEqual([]);
    expect(p.heldPicks.map((h) => h.why).join(" ")).toContain("--episode deadmines-solo draws its party's accounts from the eval pool");
  });

  test("launches as the id: its file, its accounts, and an argv run.ts takes", async () => {
    const { jobSpawn } = await import("./run-fleet-plan");
    const pick = plan(cfg, [state]).policy[0]!;
    const spawn = jobSpawn(pick.job, cfg.roster, pick.account, STAMP);
    expect(spawn.accounts).toEqual(["EVAL01", "EVAL02", "EVAL03", "EVAL04", "EVAL05"]);
    expect(spawn.entries).toHaveLength(1);
    const entry = spawn.entries[0]!;
    expect(entry.campaignFile).toMatchObject({ episode: "deadmines-solo", hash: taskHash("deadmines-solo"), staging: stagingHash(taskDefinition("deadmines-solo")) });
    expect(entry.campaignFile!.fanout!.members.map((m) => m.account)).toEqual(spawn.accounts!);
    expect(entry.launch).toBeUndefined();
    expect(entry.resumeOnPause).toBe(false);
    const [spec] = resolve(spawn.entries, STAMP);
    const argv = episodeFlags(spec!, false);
    expect(argv).toContain("--campaign-file");
    expect(argv[argv.indexOf("--episode") + 1]).toBe("deadmines-solo");
    // The argv the roster writes is one run.ts accepts, over the file it writes.
    const dir = tempDir("wb-task-fleet-");
    const path = writeCampaignFile(dir, entry.campaignFile!);
    const c = configFromArgs(argv.map((a) => (a.endsWith("campaign.json") ? path : a)), {});
    expect(c).toMatchObject({ episode: "deadmines-solo", ref: "son" });
    expect(loadRunConfig(c).fanout?.accounts).toEqual(spawn.accounts!);
  });
});

describe("a five-agent pick, once rehearsed", () => {
  test("is five member runs on one credential, each with the id's file", async () => {
    const { jobSpawn } = await import("./run-fleet-plan");
    const cfg = fleet({ son: { ...SON, deadmines: true } }, { worlds: "evals", rehearsed: ["deadmines"] });
    const s = owing({ name: "son", model: "sonnet", driver: "claude-code", tier: "t2", deadmines: true }, cfg.policy);
    s.perEpisode["deadmines-solo"]!.counted = 3;
    const p = plan(cfg, [s]);
    const pick = p.policy.find((x) => x.job.episode === "deadmines")!;
    expect(pick.job.fanout).toBeUndefined();
    const spawn = jobSpawn(pick.job, cfg.roster, pick.account, STAMP);
    expect(spawn.entries.map((e) => e.party?.member)).toEqual(["tank", "healer", "mage", "rogue", "paladin"]);
    for (const e of spawn.entries) expect(e.campaignFile).toMatchObject({ episode: "deadmines", hash: taskHash("deadmines") });
    expect(spawn.entries.map((e) => e.objective)).toEqual(taskDefinition("deadmines").party!.members.map((m) => m.objective));
  });

  test("needs five sessions on one credential", () => {
    const small = parseFleet(
      { _notes: ["n"], accounts: { pool: ["RUNNER"] }, roster: { son: { ...SON, deadmines: true } }, credentials: { "claude-2": { ...CREDENTIALS["claude-2"], slots: 4 } }, policy: { worlds: "evals", rehearsed: ["deadmines"] }, queue: [] },
      { env: ENV },
    );
    const s = owing({ name: "son", model: "sonnet", driver: "claude-code", tier: "t2", deadmines: true }, small.policy);
    s.perEpisode["deadmines-solo"]!.counted = 3;
    const p = plan(small, [s]);
    expect(p.policy).toEqual([]);
    expect(p.heldPicks.find((h) => h.episode === "deadmines")?.why).toContain("claude-2 0/4");
  });
});

test("the launch file's staging hash is the fixtures the stager uses", () => {
  const f = taskLaunchFile("deadmines-solo");
  expect(f.staging).toMatch(/^sha256:[0-9a-f]{16}$/);
  expect(taskLaunchFile("deadmines").staging).toBe(f.staging);
});
