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
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { campaignSquares, type ProbeRun } from "../runner/src/campaigns";
import { campaignLaunch } from "../runner/src/campaign-launch";
import { CAMPAIGN_FILE, writeCampaignFile } from "../runner/src/campaign-file";
import { accountsOfRun, DEFAULT_POLICY, type RunFact } from "../runner/src/models";
import { defsBlock, ONE_AGENT_IMAGE, oneAgentDefinition, PARTY_MEMBERS } from "../runner/test/fixtures/campaigns";
import { parseFleet, pinnedCampaignJobs, type FleetConfig } from "./run-fleet-config";
import { fillEntries, finishesOnExit, jobSpawn, planResumes, planStaleRuns, planTick, sessionsOf, unownedLiveRuns } from "./run-fleet-plan";
import { liveRunStuck, rosterResumes, runProgress } from "./run-fleet-state";
import { FANOUT_RUN, writeFanoutRun } from "../runner/test/fixtures/fanout";
import { accountHolderIn, episodeFlags, fanoutStageRequestOf, resolve, specAccounts, stagedFanoutFile } from "./run-roster";
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
    const planned = planTick(cfg, [], () => undefined, STAMP);
    expect(planned.heldPicks).toEqual([]);
    expect(planned.pinned.map((p) => p.job.name)).toEqual(["deadmines-party-one-agent"]);
    const capped = fleet({ over: { policy: { maxSessions: { "claude-code": 1 } } } });
    expect(planTick(capped, [], () => undefined, STAMP).pinned).toHaveLength(1);
  });

  test("waits, with the reason, when its credential has no slot, and starts on none of its accounts", () => {
    const none = fleet({ slots: 1 });
    // The slot is held by a live run of another job on the same credential.
    const held = planTick(none, [], () => undefined, STAMP, [], [], undefined, new Map([["son2", CRED2]]), new Set(), [
      { name: "other", account: "RUNNER", refs: ["son2"], placed: { son2: { id: CRED2, env: LANE2 } } },
    ]);
    expect(held.pinned).toEqual([]);
    expect(held.heldPicks.find((h) => h.name === "deadmines-party-one-agent")?.why).toContain("one agent on 5 accounts");
  });

  test("its spawn is one entry on the leader's account, every account held, a campaign file naming each character", () => {
    const spawn = planTick(cfg, [], () => undefined, STAMP).pinned[0]!.spawn;
    expect(spawn.account).toBe("PARTY1");
    expect(spawn.accounts).toEqual(ACCOUNTS);
    expect(spawn.resumeRunId).toBeUndefined();
    expect(rosterResumes(spawn, true)).toBe(false);
    const entries = fillEntries(spawn, STAMP);
    expect(entries).toHaveLength(1);
    const e = entries[0]!;
    expect([e.runId, e.account, e.party, e.placedOn?.id]).toEqual([STEM, "PARTY1", undefined, CRED2]);
    expect(e.campaignFile!.fanout!.members.map((m) => [m.member, m.account, m.character])).toEqual(PARTY_MEMBERS.map((m, i) => [m.id, ACCOUNTS[i]!, m.character]));
  });

  test("the roster waits on every account, stages the party as this one run, and launches it with no --character", () => {
    const spawn = planTick(cfg, [], () => undefined, STAMP).pinned[0]!.spawn;
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

  test("a later attempt is one stem, -a2", () => {
    const tried: ProbeRun = { campaign: "deadmines", version: 5, cell: "party", ref: "son2", arm: "one-agent", counted: false, live: false, party: null, terminationReason: "adapter-error" };
    const [next] = pinnedCampaignJobs(cfg, [tried]);
    expect(fillEntries(jobSpawn(next!, cfg.roster, "PARTY1", STAMP, undefined, cfg.campaigns), STAMP).map((e) => e.runId)).toEqual([`${STEM}-a2`]);
  });

  test("its job finishes as a party's does: the campaign's tally decides", () => {
    expect(finishesOnExit(job)).toBe(false);
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

  test("the five-agent arm's job is still a party's: five sessions, five entries", () => {
    const [job] = pinnedCampaignJobs(cfg, []);
    expect(job).toMatchObject({ name: "deadmines-party-party", accounts: ACCOUNTS });
    expect(job!.fanout).toBeUndefined();
    expect(sessionsOf(job!)).toBe(5);
    expect(fillEntries(jobSpawn(job!, cfg.roster, "PARTY1", STAMP, undefined, cfg.campaigns), STAMP)).toHaveLength(5);
  });

  test("both arms pin the same build", () => {
    expect(both.arms.map((a) => a.image)).toEqual([ONE_AGENT_IMAGE, ONE_AGENT_IMAGE]);
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
  test("every account of its grant, and the one account of any other run", () => {
    expect(accountsOfRun(fact())).toEqual(ACCOUNTS);
    expect(accountsOfRun(fact({ fanoutAccounts: null, account: "RUNNER" }))).toEqual(["RUNNER"]);
    expect(accountsOfRun(fact({ fanoutAccounts: undefined, account: null }))).toEqual([]);
  });

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

  test("a fan-out run the fleet did not launch as a one-agent arm is listed for a hand resume", () => {
    const hand = fact({ live: false, campaign: null, cell: null, arm: null, ref: null, episode: "freeplay", pause: { reason: "operator-pause", at: NOW - 60_000, count: 0, episodeElapsedMs: 1 } });
    const p = plan({ runs: [hand] });
    expect(p.resume).toEqual([]);
  });
});

/** The campaign file a paused one-agent run would have on disk: its spawn's. */
function pinnedFile(cfg: FleetConfig) {
  const [job] = pinnedCampaignJobs(cfg, []);
  return fillEntries(jobSpawn(job!, cfg.roster, "PARTY1", STAMP, undefined, cfg.campaigns), STAMP)[0]!.campaignFile ?? null;
}

describe("fleet status reads a fan-out run", () => {
  test("its progress is its lead character's level and xp, and a run with no heartbeat is never flagged stuck", async () => {
    const root = tempDir("wb-fanout-progress-");
    await writeFanoutRun(root);
    expect(runProgress(FANOUT_RUN, root)).toMatchObject({ level: 5, xp: 900 });
    // No heartbeat: not live, so no stuck flag either way.
    expect(liveRunStuck(FANOUT_RUN, Date.now(), root)).toBeUndefined();
  });
});
