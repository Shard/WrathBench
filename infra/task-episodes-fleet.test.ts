/**
 * The task episodes in the fleet (operator, 2026-11-14): `t3` buys three
 * `deadmines-solo` attempts, once a counted `e360` reached level 8 (operator,
 * 2026-11-15), the five-agent `deadmines` only where the roster
 * entry opts in (`deadmines: true`), and the policy holds the five-agent id
 * and any codex row until a rehearsal clears it (`policy.rehearsed`) — all of
 * it behind the scored-episode hold. A pick draws its party from the eval
 * pool, plays on a world of its own, and launches with the id's file.
 */

import { describe, expect, test } from "bun:test";
import { DEFAULT_POLICY, projectModel, rehearsalHold, type SchedulingPolicy } from "../runner/src/models";
import type { RosterModel } from "../runner/src/roster-entry";
import type { RunFact } from "../runner/src/run-fact";
import { loadRunConfig } from "../runner/src/config";
import { taskHash, taskDefinition } from "../runner/src/task-episodes";
import { parseFleet, type FleetConfig } from "./run-fleet-config";
import { planOf } from "./fixtures/tick";
import { episodeFlags, resolve } from "./run-roster";
import { stagingHash, taskLaunchFile } from "./task-launch";
import { comparabilityOf } from "../runner/src/comparability";
import { fillEntries, jobSpawn } from "./run-fleet-plan";
import { configFromArgs } from "../runner/src/run";
import { writeCampaignFile } from "../runner/src/campaign-file";
import { tempDirs } from "../runner/test/fixtures/temp-dirs";
import { countedFact } from "../runner/test/fixtures/counted-fact";

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

/** A model's level evals all counted, one e360 at level 8, so a Deadmines id is what it owes; with `solo`, its three solo attempts too. */
function owing(entry: RosterModel, policy: SchedulingPolicy, solo = false): RunFact[] {
  const series = policy.series ?? undefined;
  const of = (episode: "e90" | "e360" | "deadmines-solo", n: number) => Array.from({ length: n }, (_, i) => countedFact(entry, episode, 8, { i: i + 1, now: NOW, series: series! }));
  return [...of("e90", 3), ...of("e360", 1), ...(solo ? of("deadmines-solo", 3) : [])];
}

/** The tick over those runs, with four worlds and `scoredGate` closing scored episodes. */
function plan(cfg: FleetConfig, runs: RunFact[], scoredGate?: string) {
  return planOf(cfg, { runs, now: NOW, stamp: STAMP, worlds: { max: 4 }, ...(scoredGate !== undefined ? { scoredWait: scoredGate } : {}) });
}
/** A hold as the policy's own pick: name, episode, why. */
const held = (p: ReturnType<typeof plan>) => p.holds.map((h) => ({ name: h.name, episode: h.episode, why: h.why }));

const SON = { tier: "t3", model: "sonnet", driver: "claude-code", effort: "max" };

describe("what buys an attempt", () => {
  test("t3 buys three deadmines-solo attempts once a counted e360 reached level 8; the five-agent id only with the entry's opt-in", () => {
    const son = { name: "s", model: "sonnet", driver: "claude-code" } as const;
    const l8 = [countedFact(son, "e360", 8, { now: NOW })];
    const plain = projectModel({ ...son, tier: "t3" }, l8, DEFAULT_POLICY, { now: NOW });
    expect(plain.eligible).toEqual(["e90", "e360", "deadmines-solo"]);
    expect(plain.perEpisode["deadmines-solo"]!.target).toBe(3);
    expect(plain.perEpisode.deadmines!.target).toBe(0);
    const opted = projectModel({ ...son, tier: "t3", deadmines: true }, l8, DEFAULT_POLICY, { now: NOW });
    expect(opted.eligible).toEqual(["e90", "e360", "deadmines-solo", "deadmines"]);
    expect(opted.perEpisode.deadmines!.target).toBe(3);
    // No witness, no attempt: a hand-placed t3 buys none, opted in or not.
    const bare = projectModel({ ...son, tier: "t3", deadmines: true }, [], DEFAULT_POLICY, { now: NOW });
    expect(bare.eligible).toEqual(["e90", "e360"]);
    expect(bare.perEpisode["deadmines-solo"]!.target).toBe(0);
    expect(bare.perEpisode.deadmines!.target).toBe(0);
    for (const tier of ["t0", "t1"] as const) {
      const s = projectModel({ ...son, tier, deadmines: true }, l8, DEFAULT_POLICY, { now: NOW });
      expect(s.perEpisode["deadmines-solo"]!.target).toBe(0);
      expect(s.perEpisode.deadmines!.target).toBe(0);
    }
  });

  test("a campaignOnly entry, which runs no scored episode, cannot opt into the five-agent id", () => {
    expect(() => fleet({ son: { ...SON, deadmines: true, campaignOnly: true } })).toThrow("campaignOnly entry runs no scored episode");
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

  test("a scored-episode hold holds both ids", () => {
    // None is set today (SCORED_EPISODES_WAIT is null); the mechanism under an explicit reason.
    const HOLD = "scored episodes are held for this test";
    const cfg = fleet({ son: { ...SON, deadmines: true } }, { worlds: "evals", rehearsed: ["deadmines"] });
    const entry: RosterModel = { name: "son", model: "sonnet", driver: "claude-code", effort: "max", tier: "t3", deadmines: true };
    const p = plan(cfg, owing(entry, cfg.policy), HOLD);
    expect(p.picks).toEqual([]);
    expect(held(p)).toEqual([{ name: "son", episode: "deadmines-solo", why: HOLD }]);
    const five = plan(cfg, owing(entry, cfg.policy, true), HOLD);
    expect(five.picks).toEqual([]);
    expect(held(five)).toEqual([{ name: "son", episode: "deadmines", why: HOLD }]);
  });

  test("an unrehearsed five-agent attempt is said and passed over; the one-agent id still goes", () => {
    const cfg = fleet({ son: { ...SON, deadmines: true } });
    const p = plan(cfg, owing({ name: "son", model: "sonnet", driver: "claude-code", effort: "max", tier: "t3", deadmines: true }, cfg.policy));
    expect(p.holds.map((h) => [h.episode, h.why])).toEqual([["deadmines", expect.stringContaining("program-loop rehearsal")]]);
    expect(p.picks.map((x) => x.job.episode)).toEqual(["deadmines-solo"]);
  });
});

describe("a deadmines-solo pick", () => {
  const cfg = fleet({ son: SON });
  const runs = owing({ name: "son", model: "sonnet", driver: "claude-code", effort: "max", tier: "t3" }, cfg.policy);

  test("draws five eval accounts and spawns one fan-out run with the id's file", () => {
    const p = plan(cfg, runs);
    expect(p.holds).toEqual([]);
    const pick = p.picks[0]!;
    expect(pick.job).toMatchObject({ episode: "deadmines-solo", fanout: true, accounts: ["EVAL01", "EVAL02", "EVAL03", "EVAL04", "EVAL05"], account: "EVAL01" });
    expect(pick.account).toBe("EVAL01");
  });

  test("is held, not moved to the shared world, while worlds are off", () => {
    const off = fleet({ son: SON }, { worlds: "off" });
    const p = plan(off, owing({ name: "son", model: "sonnet", driver: "claude-code", effort: "max", tier: "t3" }, off.policy));
    expect(p.picks).toEqual([]);
    expect(p.holds.map((h) => h.why).join(" ")).toContain("--episode deadmines-solo draws its party's accounts from the eval pool");
  });

  test("launches as the id: its file, its accounts, and an argv run.ts takes", async () => {
    const { jobSpawn } = await import("./run-fleet-plan");
    const pick = plan(cfg, runs).picks[0]!;
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

describe("a deadmines-solo pick, the tick after it spawned", () => {
  const cfg = fleet({ son: SON });
  const runs = owing({ name: "son", model: "sonnet", driver: "claude-code", effort: "max", tier: "t3" }, cfg.policy);
  const pick = plan(cfg, runs).picks[0]!;
  const party = ["EVAL01", "EVAL02", "EVAL03", "EVAL04", "EVAL05"];
  // The job exactly as the spawning tick planned it: it carries an account,
  // the first it drew, and is still the policy's.
  const runId = fillEntries(jobSpawn(pick.job, cfg.roster, pick.account, STAMP), STAMP)[0]!.runId!;
  const live = { name: pick.job.name, account: pick.account, refs: pick.job.refs, job: pick.job, runIds: [runId] };
  // Its run before it is on disk (the launch is still staging), and once it is.
  const playing: RunFact = {
    ...countedFact({ model: "sonnet", driver: "claude-code", effort: "max" }, "deadmines-solo", null, { now: NOW, series: cfg.policy.series! }),
    runId,
    account: "EVAL01",
    fanoutAccounts: party,
    startedAt: NOW - 60_000,
    endedAt: null,
    terminationReason: null,
  };
  for (const [when, facts] of [["staging", runs], ["playing", [...runs, playing]]] as const) {
    test(`is kept on the party it drew, never drained as gone from the config (${when})`, () => {
      const p = planOf(cfg, { runs: facts, now: NOW, stamp: STAMP, worlds: { max: 4 }, running: [live] });
      expect(p.drainReasons.get(pick.job.name)).toBeUndefined();
      const spawns = p.spawns.filter((s) => s.name === pick.job.name);
      expect(spawns).toHaveLength(1);
      expect(spawns[0]).toMatchObject({ enabled: true, account: "EVAL01", accounts: party });
      // No second party drawn for it, and nothing re-planned for its model.
      expect(p.picks).toEqual([]);
      expect(p.holds.filter((h) => h.name === "son")).toEqual([]);
      expect(p.spawns.flatMap((s) => s.accounts ?? [s.account]).filter((a) => a.startsWith("EVAL"))).toEqual(party);
    });
  }
});

describe("a five-agent pick, once rehearsed", () => {
  test("is five member runs on one credential, each with the id's file", async () => {
    const { jobSpawn } = await import("./run-fleet-plan");
    const cfg = fleet({ son: { ...SON, deadmines: true } }, { worlds: "evals", rehearsed: ["deadmines"] });
    const p = plan(cfg, owing({ name: "son", model: "sonnet", driver: "claude-code", effort: "max", tier: "t3", deadmines: true }, cfg.policy, true));
    const pick = p.picks.find((x) => x.job.episode === "deadmines")!;
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
    const p = plan(small, owing({ name: "son", model: "sonnet", driver: "claude-code", effort: "max", tier: "t3", deadmines: true }, small.policy, true));
    expect(p.picks).toEqual([]);
    expect(p.holds.find((h) => h.episode === "deadmines")?.why).toContain("claude-2 0/4");
  });
});

describe("the scored Deadmines groups' pins", () => {
  // Golden values: the definition and staging hashes are comparability keys, so
  // a change to either splits the scored group and must be deliberate, never a side effect.
  const PINS = {
    deadmines: { definition: "sha256:372bc06840e0ba5d", staging: "sha256:cbaccd62b7f6e2b1", agents: 5, characters: 1, runs: 5 },
    "deadmines-solo": { definition: "sha256:875505ed52060e76", staging: "sha256:cbaccd62b7f6e2b1", agents: 1, characters: 5, runs: 1 },
  } as const;

  test("hold for both ids, from the definition through the fleet's launch file to the stamped tuple", () => {
    const cfg = fleet({ son: { ...SON, deadmines: true } }, { worlds: "evals", rehearsed: ["deadmines"] });
    const entry: RosterModel = { name: "son", model: "sonnet", driver: "claude-code", effort: "max", tier: "t3", deadmines: true };
    for (const id of ["deadmines", "deadmines-solo"] as const) {
      const pin = PINS[id];
      expect(taskHash(id)).toBe(pin.definition);
      expect(stagingHash(taskDefinition(id))).toBe(pin.staging);
      expect(taskLaunchFile(id)).toMatchObject({ episode: id, hash: pin.definition, staging: pin.staging });
      const pick = plan(cfg, owing(entry, cfg.policy, id === "deadmines")).picks.find((x) => x.job.episode === id)!;
      const spawn = jobSpawn(pick.job, cfg.roster, pick.account, STAMP);
      expect(spawn.entries).toHaveLength(pin.runs);
      const specs = resolve(spawn.entries, STAMP);
      for (const [i, e] of spawn.entries.entries()) {
        expect(e.campaignFile).toMatchObject({ episode: id, hash: pin.definition, staging: pin.staging });
        const path = writeCampaignFile(tempDir("wb-task-pins-"), e.campaignFile!);
        const argv = episodeFlags(specs[i]!, false).map((a) => (a.endsWith("campaign.json") ? path : a));
        const tuple = comparabilityOf(configFromArgs(argv, {}), "harness-1.0-1");
        expect(tuple).toMatchObject({ episode: id, agents: pin.agents, characters: pin.characters, task: { definition: pin.definition, staging: pin.staging } });
        expect(tuple.task).toEqual({ definition: pin.definition, staging: pin.staging });
      }
    }
  });
});
