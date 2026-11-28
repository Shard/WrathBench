/**
 * A party campaign's one-agent arm in the fleet (Shard/wrath-mcp#29, decision
 * 2): one run, one agent, every member's character. What the fleet holds for
 * it — every one of the party's accounts, one credential slot and one driver
 * session, for the run's whole life, paused or live, all at launch or none —
 * its spawn and staging, and the holds read back off the runs on disk, so a
 * restarted supervisor or another job never takes one of its accounts.
 * Fixture-based: nothing launches a run, talks to a module or writes a store.
 */

import { describe, expect, test } from "bun:test";
import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { campaignSquares, type ProbeRun } from "../runner/src/campaigns";
import { campaignLaunch } from "../runner/src/campaign-launch";
import { CAMPAIGN_FILE, writeCampaignFile } from "../runner/src/campaign-file";
import { DEFAULT_POLICY } from "../runner/src/models";
import type { RunFact } from "../runner/src/run-fact";
import { checkedIn, defsBlock, oneAgentDefinition, PARTY_MEMBERS } from "../runner/test/fixtures/campaigns";
import { fanoutLaunchOf } from "../runner/src/party";
import type { CampaignFile } from "../runner/src/campaign-file";
import { checkStageRequest } from "./fixtures/stage-party";
import { parseFleet, pinnedCampaignJobs, type FleetConfig } from "./run-fleet-config";
import { planOf } from "./fixtures/tick";
import { fillEntries, jobSpawn, planResumes, planStaleRuns, sessionsOf, unownedLiveRuns } from "./run-fleet-plan";
import { rosterResumes } from "./run-fleet-state";
import { accountHolderIn, accountHoldersIn, episodeFlags, fanoutStageRequestOf, resolve, specAccounts, stagedFanoutFile } from "./run-roster";
import { tempDirs } from "./temp-dirs";

const tempDir = tempDirs();
const ACCOUNTS = ["PARTY1", "PARTY2", "PARTY3", "PARTY4", "PARTY5"];
const LANE2 = "CLAUDE_CODE_OAUTH_TOKEN_2";
const CRED2 = "claude-2";
const STAMP = "20261112";
const ROSTER = {
  son2: { tier: "t1", model: "sonnet", driver: "claude-code", effort: "max" },
  glm: { tier: "t1", model: "z-ai/glm-5.2:free" },
};
/** The one-agent arm alone, floating on the release image: the fleet's side does not care which build it is. */
const solo = oneAgentDefinition({ arms: [{ id: "one-agent", agents: 1 }] });
const both = oneAgentDefinition();

function fleet(o: { slots?: number; def?: typeof solo; over?: Record<string, unknown> } = {}): FleetConfig {
  return parseFleet({
    _notes: ["n"],
    accounts: { pool: ["RUNNER", "RUNNER2"] },
    roster: ROSTER,
    credentials: {
      "claude-1": { provider: "claude", secretEnv: "CLAUDE_CODE_OAUTH_TOKEN", slots: 1, billing: "paid", enabled: true },
      [CRED2]: { provider: "claude", secretEnv: LANE2, slots: o.slots ?? 1, billing: "paid", enabled: true },
    },
    "campaign-defs": defsBlock(o.def ?? solo),
    campaigns: { deadmines: { version: 5, assignments: [{ model: "son2" }], accounts: ACCOUNTS, credential: CRED2 } },
    queue: [],
    ...o.over,
  });
}

const STEM = `fleet-deadmines-party-one-agent-sonnet-max-${STAMP}`;

describe("a one-agent arm's job", () => {
  const cfg = fleet();
  const [job] = pinnedCampaignJobs(cfg, []);

  test("holds every one of the party's accounts, and takes one session", () => {
    expect(job).toMatchObject({ name: "deadmines-party-one-agent", account: "PARTY1", accounts: ACCOUNTS, fanout: true, source: "pinned" });
    expect(sessionsOf(job!)).toBe(1);
    // A party holds as many as it has members; the one-agent run, one.
    expect(sessionsOf({ accounts: ACCOUNTS })).toBe(5);
  });

  test("starts on a credential with one slot and a driver cap of one, where a party of five could not", () => {
    const planned = planOf(cfg, { stamp: STAMP });
    expect(planned.holds.filter((h) => h.by === "pinned")).toEqual([]);
    expect(planned.pinned.map((p) => p.job.name)).toEqual(["deadmines-party-one-agent"]);
    const capped = fleet({ over: { policy: { maxSessions: { "claude-code": 1 } } } });
    expect(planOf(capped, { stamp: STAMP }).pinned).toHaveLength(1);
  });

  test("waits, with the reason, when its credential has no slot, and starts on none of its accounts", () => {
    const none = fleet({ slots: 1 });
    // The slot is held by a live run of another job on the same credential.
    const held = planOf(none, { stamp: STAMP, running: [{ name: "other", account: "RUNNER", refs: ["son2"], placed: { son2: { id: CRED2, env: LANE2 } } }] });
    expect(held.pinned).toEqual([]);
    expect(held.holds.find((h) => h.name === "deadmines-party-one-agent")?.why).toContain("one agent on 5 accounts");
  });

  test("the roster waits on every account, stages the party as this one run, and launches it with no --character", () => {
    const spawn = planOf(cfg, { stamp: STAMP }).pinned[0]!.spawn;
    const [spec] = resolve(fillEntries(spawn, STAMP), STAMP);
    expect(specAccounts(spec!)).toEqual(ACCOUNTS);
    const req = fanoutStageRequestOf(spec!);
    expect(req).toMatchObject({ party: STEM, campaign: "deadmines", version: 5, scenario: "moonbrook-mine", level: 20 });
    expect(req.members.map((m) => [m.member, m.character, m.account, m.runId])).toEqual(PARTY_MEMBERS.map((m, i) => [m.id, m.character, ACCOUNTS[i]!, STEM]));
    const flags = episodeFlags(spec!, false);
    expect(flags).toContain("--campaign-file");
    expect(flags).not.toContain("--character");
    expect(flags.slice(flags.indexOf("--account"), flags.indexOf("--account") + 2)).toEqual(["--account", "PARTY1"]);
    // The stager's guids reach the run's grant through its campaign file.
    const guids = PARTY_MEMBERS.map((m, i) => ({ member: m.id, guid: String(4100 + i) }));
    const dir = tempDir("wb-fanout-file-");
    writeCampaignFile(dir, stagedFanoutFile(spec!.campaignFile!, guids));
    const raw = campaignLaunch({ "campaign-file": join(dir, CAMPAIGN_FILE), episode: "probing" }, {})!;
    expect(raw["fanout"]).toEqual({ characters: 5, accounts: ACCOUNTS, staged: PARTY_MEMBERS.map((m, i) => ({ character: m.character, account: ACCOUNTS[i]!, guid: String(4100 + i) })) });
    expect(raw["party"]).toBeUndefined();
  });
});

describe("two arms on one party's accounts", () => {
  const cfg = fleet({ def: both, over: { policy: { runPods: "probes" } } });
  const c = cfg.campaigns.find((x) => x.name === "deadmines")!;
  const run = (arm: string, over: Partial<ProbeRun> = {}): ProbeRun => ({
    campaign: "deadmines",
    version: 5,
    cell: "party",
    ref: "son2",
    arm,
    counted: true,
    live: false,
    party: null,
    terminationReason: "kill-target",
    ...over,
  });

  test("run one at a time: while the one-agent run is live, nothing fresh is planned on the accounts", () => {
    expect(pinnedCampaignJobs(cfg, [run("one-agent", { live: true, terminationReason: null })])).toEqual([]);
  });

  test("the one-agent run is one attempt of its own square", () => {
    const squares = campaignSquares(c, ["son2"], [run("one-agent")]);
    expect(squares.find((s) => s.arm.id === "one-agent")).toMatchObject({ done: 1, reached: 1, attempts: 1, live: 0 });
    expect(squares.find((s) => s.arm.id === "party")).toMatchObject({ done: 0, attempts: 0 });
  });
});

// ------------------------------------------------------------ holds off disk

const NOW = 1_900_000_000_000;
/** The series this supervisor runs, which a paused run must share to come back. */
const SERIES = fleet().policy.series ?? "0.9";

function fact(over: Partial<RunFact> = {}): RunFact {
  return {
    runId: STEM,
    model: "sonnet",
    effort: "max",
    episode: "probing",
    episodeOverride: false,
    harnessVersion: `harness-${SERIES}-1-gabc`,
    harnessSeries: SERIES,
    extra: false,
    startedAt: NOW - 3_600_000,
    endedAt: null,
    terminationReason: null,
    modelResponses: 40,
    bestLevel: 20,
    live: true,
    pause: null,
    account: "PARTY1",
    fanoutAccounts: ACCOUNTS,
    character: null,
    episodeMs: 14_400_000,
    campaign: "deadmines",
    cell: "party",
    campaignVersion: 5,
    ref: "son2",
    arm: "one-agent",
    credential: CRED2,
    driver: "claude-code",
    party: null,
    ...over,
  };
}

describe("a fan-out run's holds, read back off the runs", () => {
  test("a live run no job owns holds all of its accounts: another run on one of them is its, not a second unowned run", () => {
    const cfg = fleet();
    const other = fact({ runId: "fleet-other-sonnet-20261112", account: "PARTY4", fanoutAccounts: null, campaign: null, cell: null, arm: null, episode: "freeplay" });
    const unowned = unownedLiveRuns({ runs: [fact(), other], roster: cfg.roster, campaigns: cfg.campaigns, running: new Set(), busyAccounts: new Set() });
    expect(unowned.map((u) => [u.runId, u.accounts])).toEqual([[STEM, ACCOUNTS]]);
  });

  test("a cold run on any account a live job holds is never ended from under it", () => {
    const cfg = fleet();
    const cold = fact({ live: false, heartbeatAt: null, endedAt: null });
    const ended = (busy: string[]) => planStaleRuns({ runs: [cold], campaigns: cfg.campaigns, running: new Set(), busyAccounts: new Set(busy), now: NOW + 86_400_000 });
    expect(ended(["PARTY4"])).toEqual([]);
    expect(ended([]).map((e) => e.runId)).toEqual([STEM]);
  });

  test("on disk, the runs directory names it the holder of every account while any character is live, and of none once it ended", () => {
    const root = tempDir("wb-fanout-holds-");
    const dir = join(root, STEM);
    mkdirSync(join(dir, "sessions", "Aldric"), { recursive: true });
    const meta = { runId: STEM, startedAt: NOW, config: { account: "PARTY1", fanout: { characters: 5, accounts: ACCOUNTS } } };
    writeFileSync(join(dir, "meta.json"), JSON.stringify(meta));
    // Only a character's live record is warm: the run's own files are not written yet.
    writeFileSync(join(dir, "sessions", "Aldric", "live.json"), "{}");
    for (const a of ACCOUNTS) expect(accountHolderIn(root, a, "")).toBe(STEM);
    expect(accountHolderIn(root, "PARTY6", "")).toBeUndefined();
    expect(accountHolderIn(root, "PARTY3", STEM)).toBeUndefined();
    writeFileSync(join(dir, "meta.json"), JSON.stringify({ ...meta, run: { terminationReason: "kill-target" }, terminationReason: "kill-target" }));
    // A pool account works the same: what holds it is the run's grant, not a pin.
    const pool = join(root, "hand-fanout");
    mkdirSync(pool, { recursive: true });
    writeFileSync(join(pool, "meta.json"), JSON.stringify({ runId: "hand-fanout", startedAt: NOW, config: { account: "POOL01", fanout: { characters: 2, accounts: ["POOL01", "POOL02"] } } }));
    writeFileSync(join(pool, "heartbeat"), "x");
    expect(accountHolderIn(root, "POOL02", "")).toBe("hand-fanout");
  });
});

describe("a paused one-agent run comes back whole", () => {
  const resumable = oneAgentDefinition({ arms: [{ id: "one-agent", agents: 1 }], resume: true });
  const rcfg = fleet({ def: resumable });
  const fileOf = (): ReturnType<typeof pinnedFile> => pinnedFile(rcfg);
  const paused = fact({ live: false, pause: { reason: "rate-limited", at: NOW - 3_600_000, count: 1, episodeElapsedMs: 600_000 } });
  const plan = (o: { held?: (a: string) => string | undefined; running?: Map<string, string>; runs?: RunFact[] } = {}) =>
    planResumes({ runs: o.runs ?? [paused], config: { ...rcfg, policy: { ...DEFAULT_POLICY, ...rcfg.policy } }, running: o.running ?? new Map(), held: o.held ?? (() => undefined), now: NOW, campaignFileOf: fileOf });

  test("on every account it holds and its own run id, as one session", () => {
    const p = plan();
    expect(p.listed).toEqual([]);
    expect(p.resume).toHaveLength(1);
    const r = p.resume[0]!;
    expect(r.job).toMatchObject({ name: "deadmines-party-one-agent", account: "PARTY1", accounts: ACCOUNTS, fanout: true, resume: { runId: STEM } });
    expect(sessionsOf(r.job)).toBe(1);
    const spawn = jobSpawn(r.job, rcfg.roster, r.account, "20261113", undefined, rcfg.campaigns);
    expect(spawn.resumeRunId).toBe(STEM);
    expect(spawn.accounts).toEqual(ACCOUNTS);
    expect(rosterResumes(spawn, false)).toBe(true);
    expect(fillEntries(spawn, "20261113").map((e) => e.runId)).toEqual([STEM]);
  });

  test("waits while any one of its accounts is held, or busy under another job", () => {
    const held = plan({ held: (a) => (a === "PARTY4" ? "fleet-other-run" : undefined) });
    expect(held.resume).toEqual([]);
    expect(held.listed[0]!.why).toContain("PARTY4 is held by run fleet-other-run");
    const busy = plan({ running: new Map([["someone", "PARTY3"]]) });
    expect(busy.resume).toEqual([]);
    expect(busy.listed[0]!.why).toContain("PARTY3 is busy (someone)");
  });
});

/** The campaign file a paused one-agent run would have on disk: its spawn's. */
function pinnedFile(cfg: FleetConfig) {
  const [job] = pinnedCampaignJobs(cfg, []);
  return fillEntries(jobSpawn(job!, cfg.roster, "PARTY1", STAMP, undefined, cfg.campaigns), STAMP)[0]!.campaignFile ?? null;
}

describe("every account's holder in one pass", () => {
  test("accountHoldersIn answers what accountHolderIn answers, account by account", () => {
    const root = tempDir("wb-holders-");
    const write = (id: string, o: { account: string; fanout?: string[]; warm?: boolean; termination?: string; pause?: string }): void => {
      const dir = join(root, id);
      mkdirSync(dir, { recursive: true });
      const meta = {
        runId: id,
        startedAt: Date.now() - 60_000,
        config: { account: o.account, ...(o.fanout !== undefined ? { fanout: { characters: o.fanout.length, accounts: o.fanout } } : {}) },
        ...(o.termination !== undefined ? { termination: { reason: o.termination, detail: null } } : {}),
        ...(o.pause !== undefined ? { pauseReason: o.pause } : {}),
      };
      writeFileSync(join(dir, "meta.json"), JSON.stringify(meta));
      writeFileSync(join(dir, "heartbeat"), "x");
      // Cold: every artefact older than the three-minute rule.
      if (o.warm === false) for (const f of ["meta.json", "heartbeat"]) utimesSync(join(dir, f), new Date(Date.now() - 10 * 60_000), new Date(Date.now() - 10 * 60_000));
    };
    write("a-warm", { account: "RUNNER" });
    write("b-cold", { account: "RUNNER2", warm: false });
    write("c-ended", { account: "RUNNER3", termination: "episode-limit" });
    write("d-paused", { account: "RUNNER4", pause: "operator-pause" });
    write("e-fanout", { account: "POOL01", fanout: ["POOL01", "POOL02", "POOL03"] });
    // Two warm runs on one account: the first in the directory's order holds it, as the one-account read says.
    write("f-first", { account: "SHARED" });
    write("g-second", { account: "shared" });
    // An ended run before a live one on the same account: the live one holds it.
    write("h-ended", { account: "POOL04", termination: "manual" });
    write("i-live", { account: "POOL04" });
    const all = accountHoldersIn(root);
    for (const a of ["RUNNER", "RUNNER2", "RUNNER3", "RUNNER4", "POOL01", "POOL02", "POOL03", "POOL04", "SHARED", "NOBODY"]) {
      expect(all.get(a)).toBe(accountHolderIn(root, a, "") as string);
    }
    expect([...all.entries()].sort()).toEqual([
      ["POOL01", "e-fanout"],
      ["POOL02", "e-fanout"],
      ["POOL03", "e-fanout"],
      ["POOL04", "i-live"],
      ["RUNNER", "a-warm"],
      ["SHARED", accountHolderIn(root, "SHARED", "")!],
    ]);
    expect(accountHoldersIn(join(root, "missing")).size).toBe(0);
  });
});

describe("a raid's one-agent staging", () => {
  test("the roster hands the stager each member's spec, and a member without one gets no key at all", () => {
    const def = checkedIn("onyxia@1");
    const accounts = Array.from({ length: 10 }, (_, i) => `EVAL${String(i + 1).padStart(2, "0")}`);
    const file = { campaign: def.id, version: def.version, definition: def, fanout: fanoutLaunchOf(def.party!, accounts) } as unknown as CampaignFile;
    const req = fanoutStageRequestOf({ runId: "onyxia-r1", campaignFile: file });
    expect(req).toMatchObject({ campaign: "onyxia", version: 1, scenario: "dustwallow-lair", level: 80 });
    expect(req.members.map((m) => [m.member, m.spec, m.account])).toEqual(def.party!.members.map((m, i) => [m.id, m.spec, accounts[i]!]));
    // What the roster sends is what the stager takes.
    expect(checkStageRequest(req)).toEqual([]);
    const five = fanoutStageRequestOf(resolve(fillEntries(planOf(fleet(), { stamp: STAMP }).pinned[0]!.spawn, STAMP), STAMP)[0]!);
    expect(five.members.some((m) => "spec" in m)).toBe(false);
  });
});
