/**
 * The eval pool (`EVAL01`…, the chart's `worlds.pool.size`): the accounts a
 * party campaign that draws its own (`accounts: "evals"`) takes per attempt,
 * so two parties run side by side, each on a world of its own. Pinned:
 * the draw is the same for the tick and `planTick`, disjoint across
 * parties, held with a reason when the pool is short or worlds are off;
 * an eval account is never pinned, listed or a gate's; a paused party comes
 * back on the accounts it drew; and the chart puts the pool on no allowlist
 * of the long-lived world's.
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { evalPoolAccountNames, isEvalPoolAccountName } from "../runner/src/account-pool";
import { defsBlock, definition, PARTY_MEMBERS, partyDefinition } from "../runner/test/fixtures/campaigns";
import { parseFleet, pinnedCampaignJobs, type FleetConfig, type FleetJob } from "./run-fleet-config";
import { evalPoolDraw, evalPoolTaken, fillEntries, jobSpawn, planResumes, planTick } from "./run-fleet-plan";
import { DEFAULT_POLICY, type RunFact } from "../runner/src/models";

const STAMP = "20261114";
const ROSTER = {
  son2: { tier: "t1", model: "sonnet", driver: "claude-code", effort: "max" },
  glm: { tier: "t1", model: "z-ai/glm-5.2:free" },
};
const CREDENTIALS = {
  "claude-2": { provider: "claude", secretEnv: "CLAUDE_CODE_OAUTH_TOKEN_2", slots: 20, billing: "paid", enabled: true },
  "or-free": { provider: "openrouter", secretEnv: "OPENROUTER_KEY", slots: 1, billing: "free", enabled: true },
};
const ENV = { WRATHBENCH_EVAL_POOL_SIZE: "10" };

/** Party campaigns `ids`, each drawing its accounts, with worlds `worlds`. */
function fleet(ids: string[], o: { worlds?: string; env?: Record<string, string>; extra?: Record<string, unknown> } = {}): FleetConfig {
  return parseFleet(
    {
      _notes: ["n"],
      accounts: { pool: ["RUNNER", "RUNNER2"] },
      roster: ROSTER,
      credentials: CREDENTIALS,
      policy: { worlds: o.worlds ?? "evals" },
      "campaign-defs": defsBlock(...ids.map((id) => partyDefinition({ id }))),
      campaigns: Object.fromEntries(ids.map((id) => [id, { version: 1, assignments: [{ model: "son2" }], accounts: "evals", credential: "claude-2" }])),
      queue: [],
      ...o.extra,
    },
    { env: o.env ?? ENV },
  );
}

const drawFor = (cfg: FleetConfig, runs: Pick<RunFact, "account" | "fanoutAccounts" | "terminationReason">[] = [], held: (a: string) => string | undefined = () => undefined) =>
  evalPoolDraw({ mode: cfg.policy.worlds, pool: cfg.accounts.evalPool ?? [], taken: evalPoolTaken(runs, []), held });

describe("the eval pool", () => {
  test("is EVAL01 … EVALnn from the deployment's size, and only the deployment says so", () => {
    expect(evalPoolAccountNames(3)).toEqual(["EVAL01", "EVAL02", "EVAL03"]);
    expect(isEvalPoolAccountName("eval07")).toBe(true);
    expect(isEvalPoolAccountName("EVAL7")).toBe(false);
    expect(fleet(["a"]).accounts.evalPool).toEqual(evalPoolAccountNames(10));
    expect(fleet(["a"], { env: {} }).accounts.evalPool).toBeUndefined();
    expect(() => fleet(["a"], { env: { WRATHBENCH_EVAL_POOL_SIZE: "100" } })).toThrow(/WRATHBENCH_EVAL_POOL_SIZE/);
  });

  test("an eval account is never pinned on a job or a campaign, listed in the pool, or the gate's", () => {
    const pinnedJob = fleet([], { extra: { queue: [{ ref: "glm", episode: "e90", account: "EVAL03" }] } });
    expect(pinnedJob.refusals.map((r) => r.why).join(" ")).toContain("EVAL03 is an eval pool account");
    const pinnedParty = parseFleet(
      {
        _notes: ["n"],
        accounts: { pool: ["RUNNER"] },
        roster: ROSTER,
        credentials: CREDENTIALS,
        "campaign-defs": defsBlock(partyDefinition()),
        campaigns: { deadmines: { version: 1, assignments: [{ model: "son2" }], accounts: ["EVAL01", "EVAL02", "EVAL03", "EVAL04", "EVAL05"], credential: "claude-2" } },
        queue: [],
      },
      { env: ENV },
    );
    expect(pinnedParty.campaigns.find((c) => c.name === "deadmines")!.enabled).toBe(false);
    expect(() => parseFleet({ _notes: ["n"], accounts: { pool: ["RUNNER", "EVAL02"] }, roster: ROSTER, queue: [] }, { env: ENV })).toThrow(/eval pool account/);
    expect(() => parseFleet({ _notes: ["n"], accounts: { pool: ["RUNNER"] }, roster: ROSTER, queue: [], preflight: { enabled: true, account: "EVAL01", smokes: [{ script: "infra/smoke/preflight.ts", account: "EVAL01" }] } }, { env: ENV })).toThrow(/eval pool account/);
  });

  test("a party row may draw its accounts; a campaign that is no party may not", () => {
    const c = fleet(["deadmines"]).campaigns[0]!;
    expect(c).toMatchObject({ drawsAccounts: true, enabled: true });
    expect(c.account).toBeUndefined();
    const solo = parseFleet(
      { _notes: ["n"], accounts: { pool: ["RUNNER"] }, roster: ROSTER, credentials: CREDENTIALS, "campaign-defs": defsBlock(definition({ id: "solo" })), campaigns: { solo: { version: 1, assignments: [{ model: "glm" }], accounts: "evals" } }, queue: [] },
      { env: ENV },
    );
    expect(solo.campaignRefusals.map((r) => r.reason).join(" ")).toContain("no party");
  });
});

describe("parties side by side", () => {
  test("two parties each draw five eval accounts, disjoint, and both spawn on a world each; the third is held on the pool", () => {
    const cfg = fleet(["deadmines", "stockades", "wailing"]);
    const plan = planTick(cfg, [], () => undefined, STAMP, [], [], undefined, new Map(), new Set(), [], [], undefined, true, [], [], undefined, undefined, { max: 2 }, drawFor(cfg));
    const spawned = plan.pinned.map((p) => p.spawn);
    expect(spawned.map((s) => s.name).sort()).toEqual(["deadmines-party-base", "stockades-party-base"]);
    const accounts = spawned.map((s) => s.accounts!);
    for (const a of accounts) {
      expect(a).toHaveLength(5);
      expect(a.every(isEvalPoolAccountName)).toBe(true);
    }
    expect(new Set(accounts.flat()).size).toBe(10);
    const third = plan.heldPicks.find((h) => h.name === "wailing-party-base");
    expect(third?.why).toContain("eval pool: 0 of 5 accounts free");
  });

  test("with the world cap full, a party that drew its accounts waits on the world key", () => {
    const cfg = fleet(["deadmines", "stockades"]);
    const plan = planTick(cfg, [], () => undefined, STAMP, [], [], undefined, new Map(), new Set(), [], [], undefined, true, [], [], undefined, undefined, { max: 1 }, drawFor(cfg));
    expect(plan.pinned).toHaveLength(1);
    expect(plan.heldPicks.map((h) => h.why).join(" ")).toContain("worlds 1/1");
  });

  test("accounts a run without a verdict holds, or a live session, are never drawn", () => {
    const cfg = fleet(["deadmines", "stockades"]);
    const paused = ["EVAL01", "EVAL02", "EVAL03"].map((account) => ({ account, fanoutAccounts: null, terminationReason: null }));
    const ended = [{ account: "EVAL04", fanoutAccounts: null, terminationReason: "episode-limit" }];
    const draw = drawFor(cfg, [...paused, ...ended], (a) => (a === "EVAL05" ? "run-live" : undefined));
    const held: { job: FleetJob; why: string }[] = [];
    const jobs = pinnedCampaignJobs(cfg, [], undefined, draw, held);
    expect(jobs[0]!.accounts).toEqual(["EVAL04", "EVAL06", "EVAL07", "EVAL08", "EVAL09"]);
    expect(held.map((h) => h.why)).toEqual(["eval pool: 1 of 5 accounts free (10 in the pool, the chart's worlds.pool.size) — waits for a party to end"]);
  });

  test("a running job keeps the accounts it drew", () => {
    const cfg = fleet(["deadmines"]);
    const own = ["EVAL06", "EVAL07", "EVAL08", "EVAL09", "EVAL10"];
    const draw = evalPoolDraw({ mode: "evals", pool: cfg.accounts.evalPool!, taken: evalPoolTaken([], own), held: () => undefined, running: (n) => (n === "deadmines-party-base" ? own : undefined) });
    expect(pinnedCampaignJobs(cfg, [], undefined, draw)[0]!.accounts).toEqual(own);
  });

  test("with worlds off, a party that draws its accounts is held with the reason, never moved to a pinned list", () => {
    const cfg = fleet(["deadmines"], { worlds: "off" });
    const held: { job: FleetJob; why: string }[] = [];
    expect(pinnedCampaignJobs(cfg, [], undefined, drawFor(cfg), held)).toEqual([]);
    expect(held[0]!.why).toContain('policy.worlds is "off"');
    // And without a draw at all (a reader that has none), it yields nothing either.
    expect(pinnedCampaignJobs(cfg, [])).toEqual([]);
  });
});

describe("the chart", () => {
  const helm = Bun.which("helm");
  const chart = join(import.meta.dir, "chart", "wrathbench");
  const render = (extra: string[]) => {
    const r = Bun.spawnSync([helm!, "template", "wrathbench", chart, "--namespace", "wrathbench", "--set", "image.registry=r/w", "--set", "image.tag=t", ...extra], { stdout: "pipe", stderr: "pipe" });
    expect(r.exitCode, r.stderr.toString()).toBe(0);
    return r.stdout.toString();
  };
  test.skipIf(helm === null)("creates the eval pool and hands its size to config readers, with worlds on only; it is on no allowlist of the long-lived world's", () => {
    expect(render([])).not.toContain("WRATHBENCH_EVAL_POOL_SIZE");
    const on = render(["--set", "worlds.enabled=true", "--set", "worlds.pool.size=12", "--set", "hosted.enabled=true"]);
    expect(on).toContain('name: WRATHBENCH_EVAL_POOL_SIZE\n              value: "12"');
    // Parsed, so a comment that names the pool does not count: no allowlist and no reserved list carries one.
    const docs = on.split(/^---$/m).map((d) => Bun.YAML.parse(d) as Record<string, unknown> | null);
    const values = JSON.stringify(docs).match(/"AC_WRATH_BENCH_ACCOUNTS","value":"[^"]*"/g) ?? [];
    expect(values.length).toBeGreaterThan(0);
    for (const v of values) expect(v).not.toMatch(/EVAL\d\d/);
    const hosted = docs.find((d) => (d as { metadata?: { name?: string } } | null)?.metadata?.name === "wrathbench-hosted") as { data: Record<string, string> } | undefined;
    expect(hosted?.data["reserved-accounts"]).not.toMatch(/EVAL\d\d/);
  }, 30_000);
});

describe("a paused party that drew its accounts", () => {
  const NOW = 1_800_000_000_000;
  const cfg = fleet(["deadmines"]);
  const DRAWN = ["EVAL03", "EVAL04", "EVAL05", "EVAL06", "EVAL07"];
  const stem = `fleet-deadmines-party-base-sonnet-max-${STAMP}`;
  const draw = evalPoolDraw({ mode: "evals", pool: cfg.accounts.evalPool!, taken: new Set(["EVAL01", "EVAL02"]), held: () => undefined });
  const job = pinnedCampaignJobs(cfg, [], undefined, draw)[0]!;
  const fileOf = (runId: string) => fillEntries(jobSpawn(job, cfg.roster, job.account!, STAMP, undefined, cfg.campaigns), STAMP).find((e) => e.runId === runId)?.campaignFile ?? null;
  const facts = (accounts: string[]): RunFact[] =>
    PARTY_MEMBERS.map((m, i) => ({
      runId: `${stem}-${m.id}`,
      model: "sonnet",
      effort: "max",
      episode: "probing",
      episodeOverride: false,
      harnessVersion: `harness-${cfg.policy.series ?? "0.9"}-1-gabc`,
      harnessSeries: cfg.policy.series ?? "0.9",
      extra: false,
      startedAt: NOW - 3_600_000,
      endedAt: null,
      terminationReason: null,
      modelResponses: 40,
      bestLevel: 20,
      live: false,
      pause: { reason: "party-paused", at: NOW - 30 * 60_000, count: 0, episodeElapsedMs: 50 * 60_000 },
      account: accounts[i]!,
      character: m.character,
      episodeMs: 14_400_000,
      campaign: "deadmines",
      cell: "party",
      campaignVersion: 1,
      ref: "son2",
      arm: "base",
      credential: "claude-2",
      driver: "claude-code",
      party: { id: stem, member: m.id, size: 5 },
    }));

  test("comes back whole on the accounts it drew, with no pin to match", () => {
    expect(job.accounts).toEqual(DRAWN);
    const p = planResumes({ runs: facts(DRAWN), config: { ...cfg, policy: { ...DEFAULT_POLICY, ...cfg.policy } }, running: new Map(), held: () => undefined, now: NOW, campaignFileOf: fileOf });
    expect(p.listed).toEqual([]);
    expect(p.resume[0]!.job).toMatchObject({ name: "deadmines-party-base", account: "EVAL03", accounts: DRAWN, partyId: stem });
  });

  test("is listed when the accounts it ran on are not the eval pool's", () => {
    const named = ["PARTY1", "PARTY2", "PARTY3", "PARTY4", "PARTY5"];
    const other = pinnedCampaignJobs(cfg, [], undefined, evalPoolDraw({ mode: "evals", pool: named, taken: new Set(), held: () => undefined }))[0]!;
    const otherFile = (runId: string) => fillEntries(jobSpawn(other, cfg.roster, other.account!, STAMP, undefined, cfg.campaigns), STAMP).find((e) => e.runId === runId)?.campaignFile ?? null;
    const p = planResumes({ runs: facts(named), config: { ...cfg, policy: { ...DEFAULT_POLICY, ...cfg.policy } }, running: new Map(), held: () => undefined, now: NOW, campaignFileOf: otherFile });
    expect(p.resume).toEqual([]);
    expect(JSON.stringify(p.listed)).toContain("draws its accounts from the eval pool");
  });
});
