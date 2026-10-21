/**
 * The fleet's party mode (docs/proposals/GROUP-PLAY.md, phase 4), all
 * fixture-based: the shared-fate state machine over fake member handles, the
 * party's spawn and its five entries, pinned party campaigns and their account
 * rules, all-or-nothing admission under the caps, campaign squares tallied by
 * party, a paused party planned whole, and the stager's command contract.
 * Nothing here launches a run, talks to a module or writes a store.
 */

import { describe, expect, test } from "bun:test";
import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { campaignSquares, partyAttempt, type ProbeRun } from "../runner/src/campaigns";
import { loadRunConfig } from "../runner/src/config";
import { DEFAULT_POLICY, modelStates, readRunFacts, type RunFact } from "../runner/src/models";
import { Trajectory } from "../runner/src/trajectory";
import { defsBlock, joined, PARTY_MEMBERS, partyDefinition, definition } from "../runner/test/fixtures/campaigns";
import { runParty, type MemberHandle, type MemberVerdict, type PartyFateDeps, type PartyMemberRun } from "./party-fate";
import { commandStager, type StageRequest } from "./party-stager";
import { parseFleet, pinnedCampaignJobs, probeRunsOf, rosterModels, type FleetConfig, type FleetJob, type FleetRosterEntry } from "./run-fleet-config";
import { diffJobs, fillEntries, finishesOnExit, jobSpawn, partyAdmission, planResumes, planTick, withTakenRunIds } from "./run-fleet-plan";
import { jobArgv, rosterResumes } from "./run-fleet-state";
import { formatArgvBlock } from "./run-fleet-status";
import { partyOfRoster, resolve, stageRequestOf } from "./run-roster";
import { tempDirs } from "./temp-dirs";

const tempDir = tempDirs();
const ACCOUNTS = ["PARTY1", "PARTY2", "PARTY3", "PARTY4", "PARTY5"];
const LANE2 = "CLAUDE_CODE_OAUTH_TOKEN_2";
const STAMP = "20261020";
const party = partyDefinition();
const MEMBERS = PARTY_MEMBERS.map((m) => m.id);

// ------------------------------------------------------- the fate machine

interface FakeMember {
  m: PartyMemberRun;
  handle: MemberHandle<string>;
  /** End the member's episode with this verdict, as its runner would. */
  exit(v: MemberVerdict): void;
  stops: number;
  verdict: MemberVerdict | undefined;
}

/**
 * Five members whose episodes the test ends by hand. A stop is SIGTERM: a
 * member still running pauses as operator-pause, as run.ts does, unless the
 * test has already ended it.
 */
function fakeParty(resume = false): { members: FakeMember[]; runs: PartyMemberRun[] } {
  const members = MEMBERS.map((id): FakeMember => {
    let done: (exit: string) => void = () => {};
    const exited = new Promise<string>((res) => {
      done = res;
    });
    const f: FakeMember = {
      m: { member: id, runId: `fleet-deadmines-party-base-sonnet-${STAMP}-${id}`, resume },
      handle: {
        exited,
        stop: () => {
          f.stops++;
          if (f.verdict === undefined) f.exit({ kind: "paused", reason: "operator-pause" });
        },
      },
      exit: (v) => {
        if (f.verdict !== undefined) return;
        f.verdict = v;
        done(id);
      },
      stops: 0,
      verdict: undefined,
    };
    return f;
  });
  return { members, runs: members.map((f) => f.m) };
}

function deps(fake: FakeMember[], over: Partial<PartyFateDeps<string>> = {}): PartyFateDeps<string> & { lines: string[]; writes: string[]; staged: number } {
  const byRun = new Map(fake.map((f) => [f.m.runId, f]));
  const lines: string[] = [];
  const writes: string[] = [];
  const d = {
    lines,
    writes,
    staged: 0,
    log: (line: string) => void lines.push(line),
    stage: async () => {
      d.staged++;
      return { ok: true as const };
    },
    launch: async (m: PartyMemberRun) => byRun.get(m.runId)!.handle,
    verdict: (m: PartyMemberRun) => byRun.get(m.runId)!.verdict!,
    end: (m: PartyMemberRun, reason: string, detail: string) => void writes.push(`${m.member} end ${reason} (${detail})`),
    repause: (m: PartyMemberRun, detail: string) => void writes.push(`${m.member} pause party-paused (${detail})`),
    launchFailed: (m: PartyMemberRun, detail: string) => void writes.push(`${m.member} launch-failed (${detail})`),
    endOwnPause: (m: PartyMemberRun) => {
      writes.push(`${m.member} end attempt-failed`);
      return "attempt-failed";
    },
    stopping: () => false,
    resumeOnPause: true,
    graceMs: 90_000,
    ...over,
  };
  return d;
}

/** Let the machine's awaits run. */
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe("shared fate", () => {
  test("a member that dies in the game is no fate event: nothing is stopped until a member's episode exits", async () => {
    const { members, runs } = fakeParty();
    const d = deps(members);
    const done = runParty(runs, d);
    await tick();
    // The mage dies, is a ghost at the Westfall graveyard, runs back: its run
    // records death, release and resurrect milestones and plays on. None of it
    // is an exit, so the machine has nothing to react to.
    await tick();
    expect(members.every((f) => f.stops === 0)).toBe(true);
    // Four hours later the clocks run out, the tank's a tick first.
    members[0]!.exit({ kind: "terminated", reason: "episode-limit", detail: undefined });
    for (const f of members.slice(1, 3)) f.exit({ kind: "terminated", reason: "episode-limit", detail: undefined });
    const out = await done;
    expect(out.fate).toBe("ended");
    expect(out.trigger).toEqual({ member: "tank", reason: "episode-limit" });
    // The two that reached their own verdict keep it; the two the stop paused are ended with the party.
    expect(d.writes).toEqual(["rogue end party-ended (tank: episode-limit)", "paladin end party-ended (tank: episode-limit)"]);
    expect(members.slice(1).every((f) => f.stops === 1)).toBe(true);
    expect(members[0]!.stops).toBe(0);
  });

  test("a member's watchdog trips: the other four are ended party-ended, naming it", async () => {
    const { members, runs } = fakeParty();
    const d = deps(members);
    const done = runParty(runs, d);
    await tick();
    members[2]!.exit({ kind: "terminated", reason: "idle", detail: "no model output for 20m" });
    const out = await done;
    expect(out.fate).toBe("ended");
    expect(d.writes).toEqual(["tank", "healer", "rogue", "paladin"].map((m) => `${m} end party-ended (mage: idle)`));
    expect(d.staged).toBe(1);
  });

  test("a member's run meets the kill end: all five end kill-target together, counted and reached", async () => {
    const { members, runs } = fakeParty();
    const d = deps(members);
    const done = runParty(runs, d);
    await tick();
    // The rogue's kill credit named VanCleef; its watchdog ended its run, and
    // the paladin's own watchdog read the same packet before the stop came.
    members[3]!.exit({ kind: "terminated", reason: "kill-target", detail: "entry 639 killed (killer party member 980)" });
    members[4]!.exit({ kind: "terminated", reason: "kill-target", detail: "entry 639 killed (killer party member 980)" });
    const out = await done;
    expect(out.fate).toBe("ended");
    expect(out.trigger).toEqual({ member: "rogue", reason: "kill-target" });
    expect(d.writes).toEqual(["tank", "healer", "mage"].map((m) => `${m} end kill-target (rogue: kill-target)`));
    expect(out.written.map((w) => w.wrote)).toEqual(["kill-target", "kill-target", "kill-target"]);
    // On disk, every member's own verdict counts, so the attempt does, and it reached its end.
    const runsOnDisk: ProbeRun[] = MEMBERS.map((m) => probe(m, { terminationReason: "kill-target", counted: true }));
    expect(partyAttempt(runsOnDisk)).toEqual({ live: false, counted: true, reached: true });
  });

  test("a member's level end ends the rest on level-target, the same way", async () => {
    const { members, runs } = fakeParty();
    const d = deps(members);
    const done = runParty(runs, d);
    await tick();
    members[0]!.exit({ kind: "terminated", reason: "level-target", detail: "level 21 observed (target 21)" });
    await done;
    expect(d.writes).toEqual(["healer", "mage", "rogue", "paladin"].map((m) => `${m} end level-target (tank: level-target)`));
  });

  test("one member's adapter-error ends the party, and the attempt is not counted", async () => {
    const { members, runs } = fakeParty();
    const d = deps(members);
    const done = runParty(runs, d);
    await tick();
    members[1]!.exit({ kind: "terminated", reason: "adapter-error", detail: "401" });
    const out = await done;
    expect(out.trigger).toEqual({ member: "healer", reason: "adapter-error" });
    expect(d.writes.filter((w) => w.includes("party-ended (healer: adapter-error)"))).toHaveLength(4);
    // The square's tally: the healer's own verdict is the party's, and it does not count.
    const runsOnDisk: ProbeRun[] = MEMBERS.map((m) => probe(m, m === "healer" ? { terminationReason: "adapter-error", counted: false } : { terminationReason: "party-ended", counted: true }));
    expect(partyAttempt(runsOnDisk)).toEqual({ live: false, counted: false, reached: false });
  });

  test("one member pauses: the others are paused party-paused, and one that paused on its own keeps its reason", async () => {
    const { members, runs } = fakeParty();
    const d = deps(members);
    const done = runParty(runs, d);
    await tick();
    members[3]!.exit({ kind: "paused", reason: "rate-limited" });
    // The paladin hit the same limit on its own before the stop reached it.
    members[4]!.exit({ kind: "paused", reason: "rate-limited" });
    const out = await done;
    expect(out.fate).toBe("paused");
    expect(out.trigger).toEqual({ member: "rogue", reason: "rate-limited" });
    expect(d.writes).toEqual(["tank", "healer", "mage"].map((m) => `${m} pause party-paused (rogue: rate-limited)`));
  });

  test("a pause that finds another member already ended cannot come back whole: the party is ended, that member its cause", async () => {
    const { members, runs } = fakeParty();
    const d = deps(members);
    const done = runParty(runs, d);
    await tick();
    members[0]!.exit({ kind: "paused", reason: "quota-exhausted" });
    members[4]!.exit({ kind: "terminated", reason: "tool-call-limit", detail: undefined });
    const out = await done;
    expect(out.fate).toBe("ended");
    expect(out.trigger).toEqual({ member: "paladin", reason: "tool-call-limit" });
    expect(d.writes).toEqual(["tank", "healer", "mage", "rogue"].map((m) => `${m} end party-ended (paladin: tool-call-limit)`));
  });

  test("a pause in a lane that does not resume ends the attempt: the member's own pause by the lane's rule, the rest party-ended", async () => {
    const { members, runs } = fakeParty();
    const d = deps(members, { resumeOnPause: false });
    const done = runParty(runs, d);
    await tick();
    members[1]!.exit({ kind: "paused", reason: "rate-limited" });
    await done;
    expect(d.writes[1]).toBe("healer end attempt-failed");
    expect(d.writes.filter((w) => w.includes("party-ended (healer: rate-limited)"))).toHaveLength(4);
  });

  test("a member's pod killed with no row is a termination: the whole party is ended, none left half", async () => {
    const { members, runs } = fakeParty();
    const d = deps(members);
    const done = runParty(runs, d);
    await tick();
    members[2]!.exit({ kind: "unknown", detail: "exit 137, run row has neither termination nor pause" });
    const out = await done;
    expect(out.fate).toBe("ended");
    expect(d.writes).toHaveLength(5);
    expect(d.writes[2]).toContain("mage end party-ended (mage: exited without a verdict");
    expect(d.writes[0]).toBe("tank end party-ended (mage: exited without a verdict)");
  });

  test("a fresh member that never became a run is its own launch-failed attempt, and ends the rest", async () => {
    const { members, runs } = fakeParty();
    const d = deps(members);
    const done = runParty(runs, d);
    await tick();
    members[4]!.exit({ kind: "launch-failed", detail: "image would not pull" });
    await done;
    expect(d.writes).toEqual([
      ...["tank", "healer", "mage", "rogue"].map((m) => `${m} end party-ended (paladin: launch-failed)`).slice(0, 4),
      "paladin launch-failed (image would not pull)",
    ]);
  });

  test("a failed staging launches nobody: every member is a launch-failed attempt naming why", async () => {
    const { members, runs } = fakeParty();
    let launched = 0;
    const d = deps(members, { stage: async () => ({ ok: false as const, reason: "SOAP refused STAGER" }), launch: async (m) => (launched++, members.find((f) => f.m.runId === m.runId)!.handle) });
    const out = await runParty(runs, d);
    expect(out.fate).toBe("staging-failed");
    expect(launched).toBe(0);
    expect(d.writes).toEqual(MEMBERS.map((m) => `${m} launch-failed (staging failed: SOAP refused STAGER)`));
  });

  test("a shared stop is no fate: every member keeps the operator-pause its own runner wrote", async () => {
    const { members, runs } = fakeParty();
    let stopping = false;
    const d = deps(members, { stopping: () => stopping });
    const done = runParty(runs, d);
    await tick();
    // The roster's SIGTERM path stops every handle (requestStop over the party's episodes).
    stopping = true;
    for (const f of members) void f.handle.stop(90_000);
    const out = await done;
    expect(out.fate).toBe("stopped");
    expect(d.writes).toEqual([]);
    expect(Object.values(out.verdicts).every((v) => v.kind === "paused" && v.reason === "operator-pause")).toBe(true);
  });

  test("a shared stop that lands inside the grace after a member ended on its own still ends the party", async () => {
    const { members, runs } = fakeParty();
    let stopping = false;
    const d = deps(members, { stopping: () => stopping });
    const done = runParty(runs, d);
    await tick();
    // The tank's clock runs out first; the machine starts stopping the rest
    // with the grace, and a deploy window's SIGTERM reaches the roster then.
    members[0]!.exit({ kind: "terminated", reason: "episode-limit", detail: undefined });
    await tick();
    // The roster's SIGTERM path stops every party handle it holds.
    stopping = true;
    for (const f of members) void f.handle.stop(90_000);
    const out = await done;
    expect(out.fate).toBe("ended");
    expect(d.writes).toEqual(["healer", "mage", "rogue", "paladin"].map((m) => `${m} end party-ended (tank: episode-limit)`));
  });

  test("a stop that lands while the stager works launches nobody", async () => {
    const { members, runs } = fakeParty();
    let stopping = false;
    let launched = 0;
    const d = deps(members, {
      stopping: () => stopping,
      stage: async () => {
        stopping = true;
        return { ok: true as const };
      },
      launch: async (m) => (launched++, members.find((f) => f.m.runId === m.runId)!.handle),
    });
    const out = await runParty(runs, d);
    expect(out.fate).toBe("stopped");
    expect(launched).toBe(0);
    expect(d.writes).toEqual([]);
  });

  test("a resumed party is never staged, and its members launch as resumes", async () => {
    const { members, runs } = fakeParty(true);
    const d = deps(members);
    const resumes: boolean[] = [];
    d.launch = async (m) => (resumes.push(m.resume), members.find((f) => f.m.runId === m.runId)!.handle);
    const done = runParty(runs, d);
    await tick();
    members[0]!.exit({ kind: "terminated", reason: "episode-limit", detail: undefined });
    await done;
    expect(d.staged).toBe(0);
    expect(resumes).toEqual([true, true, true, true, true]);
  });
});

// --------------------------------------------------------- the config

const ROSTER = {
  son2: { tier: "t1", model: "sonnet", driver: "claude-code", effort: "max" },
  glm: { tier: "t1", model: "z-ai/glm-5.2:free" },
};

function fleet(row: Record<string, unknown> = {}, over: Record<string, unknown> = {}): FleetConfig {
  return parseFleet({
    _notes: ["n"],
    accounts: { pool: ["RUNNER", "RUNNER2"] },
    roster: ROSTER,
    policy: { subscriptions: ["CLAUDE_CODE_OAUTH_TOKEN", LANE2] },
    "campaign-defs": defsBlock(party, definition({ id: "solo" })),
    campaigns: { deadmines: { version: 1, assignments: [{ model: "son2" }], accounts: ACCOUNTS, subscription: LANE2, ...row } },
    queue: [],
    ...over,
  });
}

describe("a party campaign's row", () => {
  test("is pinned to its members' accounts, the leader's standing for the pin", () => {
    const cfg = fleet();
    const c = cfg.campaigns.find((x) => x.name === "deadmines")!;
    expect(c.accounts).toEqual(ACCOUNTS);
    expect(c.account).toBe("PARTY1");
    for (const a of ACCOUNTS) expect(cfg.accounts.pinned[a]).toBe("campaign deadmines");
  });

  test("is refused by name with too few accounts, a shared one, a single account, or none; and a list off a party is refused too", () => {
    const why = (row: Record<string, unknown>, rows?: Record<string, unknown>): string => {
      const cfg = parseFleet({
        _notes: ["n"],
        accounts: { pool: ["RUNNER"] },
        roster: ROSTER,
        policy: { subscriptions: ["CLAUDE_CODE_OAUTH_TOKEN", LANE2] },
        "campaign-defs": defsBlock(party, definition({ id: "solo" })),
        campaigns: rows ?? { deadmines: { version: 1, assignments: [{ model: "son2" }], ...row } },
        queue: [],
      });
      return cfg.campaignRefusals.map((r) => r.reason).join("; ");
    };
    expect(why({ accounts: ACCOUNTS.slice(0, 4) })).toContain("needs 5 accounts");
    expect(why({ accounts: ["PARTY1", "PARTY1", "PARTY3", "PARTY4", "PARTY5"] })).toContain("share an account");
    expect(why({ account: "PARTY1" })).toContain("not account");
    expect(why({})).toContain("give accounts");
    expect(why({}, { solo: { version: 1, assignments: [{ model: "glm" }], accounts: ["PARTY1"] } })).toContain("no party");
  });

  test("loses its pin whole when any member's account is another pin's or in an account class", () => {
    const clash = fleet({}, { accounts: { pool: ["RUNNER", "PARTY3"] } });
    expect(clash.campaigns.find((c) => c.name === "deadmines")!.enabled).toBe(false);
    expect(clash.refusals.map((r) => r.why).join(" ")).toContain("PARTY3 is in accounts.pool");
    const queued = fleet({}, { queue: [{ ref: "glm", episode: "e90", account: "PARTY5" }] });
    expect(queued.campaigns.find((c) => c.name === "deadmines")!.enabled).toBe(false);
    expect(queued.refusals.map((r) => r.why).join(" ")).toContain("PARTY5 is already");
  });
});

describe("a party's spawn", () => {
  const cfg = fleet();
  const [job] = pinnedCampaignJobs(cfg, []);

  test("is one pinned job holding all five accounts, its first attempt", () => {
    expect(job).toMatchObject({ name: "deadmines-party-base", account: "PARTY1", accounts: ACCOUNTS, attempt: 1, source: "pinned" });
  });

  test("materialises one entry per member: its run id off one stem, its account, start, lane and campaign file", () => {
    const spawn = jobSpawn(job!, cfg.roster, "PARTY1", STAMP, undefined, cfg.campaigns);
    expect(spawn.accounts).toEqual(ACCOUNTS);
    const entries = fillEntries(spawn, STAMP);
    const stem = `fleet-deadmines-party-base-sonnet-max-${STAMP}`;
    expect(entries.map((e) => [e.runId, e.account, e.race, e.class, e.tokenEnv, e.party?.member])).toEqual(
      PARTY_MEMBERS.map((m, i) => [`${stem}-${m.id}`, ACCOUNTS[i], m.race, m.class, LANE2, m.id]),
    );
    expect(entries.every((e) => e.campaignFile!.party!.id === stem)).toBe(true);
    // The roster reads it back as one party, and asks the stager for exactly these five.
    const specs = resolve(entries, STAMP);
    expect(partyOfRoster(specs)).toEqual({ id: stem, size: 5 });
    const req: StageRequest = stageRequestOf(specs);
    expect(req).toMatchObject({ party: stem, campaign: "deadmines", version: 1, scenario: "moonbrook-mine", level: 20 });
    expect(req.members.map((m) => [m.member, m.character, m.account, m.race, m.class])).toEqual(PARTY_MEMBERS.map((m, i) => [m.id, m.character, ACCOUNTS[i]!, m.race, m.class]));
  });

  test("a later attempt is its own stem, and no fresh attempt is planned while one is live or paused", () => {
    const tried: ProbeRun[] = MEMBERS.map((m) => probe(m, { terminationReason: "party-ended", counted: false }));
    tried[0] = { ...tried[0]!, terminationReason: "adapter-error" };
    const [next] = pinnedCampaignJobs(cfg, tried);
    expect(next!.attempt).toBe(2);
    expect(fillEntries(jobSpawn(next!, cfg.roster, "PARTY1", STAMP, undefined, cfg.campaigns), STAMP)[0]!.runId).toBe(`fleet-deadmines-party-base-sonnet-max-${STAMP}-a2-tank`);
    const paused = MEMBERS.map((m) => probe(m, { live: true }));
    expect(pinnedCampaignJobs(cfg, paused)).toEqual([]);
  });

  test("a single run's spawn is what it was: no accounts, its account on every entry, no party", () => {
    const solo = parseFleet({
      _notes: ["n"],
      accounts: { pool: ["RUNNER"] },
      roster: ROSTER,
      "campaign-defs": defsBlock(definition({ id: "solo" })),
      campaigns: { solo: { version: 1, assignments: [{ model: "glm" }], account: "PROBE" } },
      queue: [],
    });
    const [j] = pinnedCampaignJobs(solo, []);
    expect(j).not.toHaveProperty("accounts");
    expect(j).not.toHaveProperty("attempt");
    const spawn = jobSpawn(j!, solo.roster, "PROBE", STAMP, undefined, solo.campaigns);
    expect(Object.keys(spawn).sort()).toEqual(["account", "enabled", "entries", "loop", "name"]);
    const [e] = fillEntries(spawn, STAMP);
    expect(e!.runId).toBe(`fleet-solo-a-base-glm-5-2-${STAMP}`);
    expect(e!.account).toBe("PROBE");
    expect(e).not.toHaveProperty("party");
    expect(e!.campaignFile).not.toHaveProperty("party");
  });
});

// --------------------------------------------- a fresh attempt's run ids

describe("a fresh attempt never reuses a run id", () => {
  const stem = `fleet-deadmines-party-base-sonnet-max-${STAMP}`;
  const idsOf = (s: string): string[] => MEMBERS.map((m) => `${s}-${m}`);
  /** The five members of one attempt the operator stopped: ended `manual`, not counted. */
  const stopped = (version: number, s: string): ProbeRun[] => MEMBERS.map((m) => probe(m, { version, terminationReason: "manual", counted: false }, s));
  /** The row at `version`, with v1 and v2 of the definition published (v2 does not resume). */
  const at = (version: number): FleetConfig =>
    fleet({ version }, { "campaign-defs": defsBlock(party, partyDefinition({ version: 2, resume: false }), definition({ id: "solo" })) });
  const spawnOf = (cfg: FleetConfig, runs: ProbeRun[], taken: ReadonlySet<string>) => {
    const [job] = withTakenRunIds(pinnedCampaignJobs(cfg, runs), taken);
    const spawn = jobSpawn(job!, cfg.roster, "PARTY1", STAMP, undefined, cfg.campaigns);
    return { job: job!, spawn, entries: fillEntries(spawn, STAMP) };
  };

  test("an operator-stopped attempt on v1, the row moved to v2: the next launch gets new ids and a fresh roster", () => {
    const cfg = at(2);
    const runs = stopped(1, stem);
    const taken = new Set(idsOf(stem));
    // v2 counts its own attempts, so its tally starts again at nothing...
    const sq = campaignSquares(cfg.campaigns.find((c) => c.name === "deadmines")!, Object.keys(cfg.roster), runs)[0]!;
    expect(sq).toMatchObject({ version: 2, attempts: 0, done: 0 });
    const { job, spawn, entries } = spawnOf(cfg, runs, taken);
    expect(job).toMatchObject({ attempt: 1, probe: { version: 2 } });
    // ...and the stem numbers past v1's ended ids instead of landing on them.
    expect(entries.map((e) => e.runId)).toEqual(idsOf(`${stem}-a2`));
    expect(entries.every((e) => e.campaignFile!.party!.id === `${stem}-a2`)).toBe(true);
    expect(stageRequestOf(resolve(entries, STAMP))).toMatchObject({ party: `${stem}-a2`, version: 2 });
    // A fresh party never resumes the day's roster, though v1's jsonl is on disk.
    expect(spawn.resumeRunId).toBeUndefined();
    expect(rosterResumes(spawn, true)).toBe(false);
    expect(jobArgv(spawn, { stamp: STAMP, until: undefined, resumeRoster: rosterResumes(spawn, true) })).not.toContain("--resume-roster");
    // The dry-run plans the same ids and the same argv.
    const plan = planTick(cfg, [], () => undefined, STAMP, [], runs, undefined, new Map(), taken);
    expect(fillEntries(plan.pinned[0]!.spawn, STAMP).map((e) => e.runId)).toEqual(idsOf(`${stem}-a2`));
    const argv = formatArgvBlock(plan.pinned, { stamp: STAMP, until: undefined, jsonlExists: () => true });
    expect(argv.join("\n")).not.toContain("--resume-roster");
  });

  test("a same-version retry after an operator stop is -a2, and goes past any id already on disk", () => {
    const cfg = at(1);
    const runs = stopped(1, stem);
    const { job, entries } = spawnOf(cfg, runs, new Set(idsOf(stem)));
    expect(job.attempt).toBe(2);
    expect(entries.map((e) => e.runId)).toEqual(idsOf(`${stem}-a2`));
    // One member of -a2 already on disk (archived, say) takes the whole stem.
    const past = spawnOf(cfg, runs, new Set([...idsOf(stem), `${stem}-a2-mage`]));
    expect(past.entries.map((e) => e.runId)).toEqual(idsOf(`${stem}-a3`));
    // A first attempt with nothing on disk keeps the bare stem.
    expect(spawnOf(cfg, [], new Set()).entries.map((e) => e.runId)).toEqual(idsOf(stem));
  });

  test("the attempt cap still counts this version's launches, not the ids", () => {
    const tried = [...stopped(1, stem), ...stopped(1, `${stem}-a2`), ...stopped(1, `${stem}-a3`)];
    const taken = new Set([stem, `${stem}-a2`, `${stem}-a3`].flatMap(idsOf));
    // v1 has had its three launches: nothing more.
    expect(pinnedCampaignJobs(at(1), tried)).toEqual([]);
    // v2 has had none, and its first launch is -a4.
    expect(spawnOf(at(2), tried, taken).entries[0]!.runId).toBe(`${stem}-a4-tank`);
  });

  test("a paused party's resume keeps its own ids and resumes its roster", () => {
    const resumed: FleetJob = { ...pinnedCampaignJobs(at(1), [])[0]!, partyId: stem, resume: { runId: `${stem}-tank`, model: "sonnet", effort: "max" } };
    const [job] = withTakenRunIds([resumed], new Set(idsOf(stem)));
    const spawn = jobSpawn(job!, at(1).roster, "PARTY1", STAMP, undefined, at(1).campaigns);
    expect(fillEntries(spawn, STAMP).map((e) => e.runId)).toEqual(idsOf(stem));
    expect(rosterResumes(spawn, false)).toBe(true);
  });

  test("a solo square is consistent: its bare id first, and a same-day retry numbered past it", () => {
    const solo = parseFleet({
      _notes: ["n"],
      accounts: { pool: ["RUNNER"] },
      roster: ROSTER,
      "campaign-defs": defsBlock(definition({ id: "solo" })),
      campaigns: { solo: { version: 1, assignments: [{ model: "glm" }], account: "PROBE" } },
      queue: [],
    });
    const bare = `fleet-solo-a-base-glm-5-2-${STAMP}`;
    const first = (taken: ReadonlySet<string>) => fillEntries(jobSpawn(withTakenRunIds(pinnedCampaignJobs(solo, []), taken)[0]!, solo.roster, "PROBE", STAMP, undefined, solo.campaigns), STAMP)[0]!.runId;
    expect(first(new Set())).toBe(bare);
    expect(first(new Set([bare]))).toBe(`${bare}-a2`);
    expect(first(new Set([bare, `${bare}-a2`]))).toBe(`${bare}-a3`);
    // A solo roster's same-day respawn still resumes its jsonl, as it always has.
    const spawn = jobSpawn(pinnedCampaignJobs(solo, [])[0]!, solo.roster, "PROBE", STAMP, undefined, solo.campaigns);
    expect(rosterResumes(spawn, true)).toBe(true);
    expect(rosterResumes(spawn, false)).toBe(false);
  });

  test("a party job whose roster exits undrained is started again; a solo square and an operator's pinned job stay finished", () => {
    const [job] = pinnedCampaignJobs(at(2), stopped(1, stem));
    expect(finishesOnExit(job)).toBe(false);
    expect(finishesOnExit({ source: "policy" })).toBe(false);
    expect(finishesOnExit({ source: "pinned" })).toBe(true);
    expect(finishesOnExit(undefined)).toBe(true);
    // A solo square is still yielded while its run is paused, so its exit stays parked.
    const solo = { source: "pinned" as const, probe: { campaign: "solo", version: 1, cell: "a", arm: "base" } };
    expect(finishesOnExit(solo)).toBe(true);
    // The fate of a reap: this mirrors the loop body in run-fleet.ts, which is not under test itself.
    // The square is yielded again while v1's roster unwinds, which undrains
    // it; its exit must not keep the name out of the next start.
    const spawn = jobSpawn(job!, at(2).roster, "PARTY1", STAMP, undefined, at(2).campaigns);
    const sets = { running: new Set([job!.name]), draining: new Set([job!.name]), finished: new Set<string>() };
    expect(diffJobs([spawn], sets).undrain).toEqual([job!.name]);
    sets.draining.delete(job!.name);
    sets.running.delete(job!.name);
    if (finishesOnExit(job)) sets.finished.add(job!.name);
    expect(diffJobs([spawn], sets).start.map((s) => s.name)).toEqual([job!.name]);
  });
});

// ------------------------------------------------------------ the lane pin

describe("a campaign's own lane (campaigns.<id>.subscription)", () => {
  test("every member of the campaign's launches bills it, and the same entry's scored evals keep their own lane", () => {
    const cfg = fleet({}, { queue: [{ ref: "son2", episode: "e90", account: "SHAKEOUT" }] });
    expect(cfg.roster["son2"]!.subscription).toBeUndefined();
    const [job] = pinnedCampaignJobs(cfg, []);
    expect(job!.subscription).toBe(LANE2);
    expect(jobSpawn(job!, cfg.roster, "PARTY1", STAMP, undefined, cfg.campaigns).entries.map((e) => e.tokenEnv)).toEqual([LANE2, LANE2, LANE2, LANE2, LANE2]);
    // The e90 of the same roster entry: a pinned queue job, and the policy's own pick.
    const e90 = cfg.jobs.find((j) => j.name === "son2-e90")!;
    expect(e90.subscription).toBeUndefined();
    expect(jobSpawn(e90, cfg.roster, "SHAKEOUT", STAMP).entries[0]!.tokenEnv).toBeUndefined();
    // With the party not holding the model (one character per model), the policy places its e90 by its own rules.
    const open = fleet({ enabled: false });
    const states = modelStates({ runsDir: "/nonexistent", roster: rosterModels(open.roster), runs: [], sidecar: { version: 1, cleared: {} }, now: 1_800_000_000_000, policy: open.policy });
    const plan = planTick(open, states, () => undefined, STAMP);
    const pick = plan.policy.find((p) => p.job.ref === "son2" && p.job.episode === "e90");
    expect(pick).toBeDefined();
    expect(pick!.job.subscription).not.toBe(LANE2);
  });

  test("a lane the policy does not list, an unpinned campaign, or an assignment that bills no lane refuses the campaign", () => {
    const refused = (row: Record<string, unknown>, policy: Record<string, unknown> = { subscriptions: ["CLAUDE_CODE_OAUTH_TOKEN", LANE2] }): string => {
      const cfg = fleet(row, { policy });
      expect(cfg.campaigns.find((c) => c.name === "deadmines")!.enabled).toBe(false);
      return cfg.refusals.map((r) => r.why).join("; ");
    };
    expect(refused({ subscription: "CLAUDE_CODE_OAUTH_TOKEN_3" })).toContain("not in policy.subscriptions");
    expect(refused({}, { subscriptions: ["CLAUDE_CODE_OAUTH_TOKEN"] })).toContain("not in policy.subscriptions");
    expect(refused({ subscription: "CODEX_HOME" }, { subscriptions: ["CLAUDE_CODE_OAUTH_TOKEN", LANE2, "CODEX_HOME"] })).toContain("is a Codex home");
    expect(refused({ assignments: [{ model: "glm" }] })).toContain("bills no subscription lane");
    const unpinned = parseFleet({
      _notes: ["n"],
      accounts: { pool: ["RUNNER"] },
      roster: ROSTER,
      policy: { subscriptions: ["CLAUDE_CODE_OAUTH_TOKEN", LANE2] },
      "campaign-defs": defsBlock(definition({ id: "solo" })),
      campaigns: { solo: { version: 1, assignments: [{ model: "son2" }], subscription: LANE2 } },
      queue: [],
    });
    expect(unpinned.campaigns[0]!.enabled).toBe(false);
    expect(unpinned.refusals.map((r) => r.why).join(" ")).toContain("a lane pin is a pinned campaign's");
  });
});

// ------------------------------------------------------------ admission

describe("admission: a party starts whole or not at all", () => {
  test("the cap on the lane, the claude total and the paid cap each hold the whole party", () => {
    const keys = [`claude-code:${LANE2}`, "claude-code"];
    expect(partyAdmission({ size: 5, keys, running: new Map(), max: {} })).toBeUndefined();
    expect(partyAdmission({ size: 5, keys, running: new Map([[`claude-code:${LANE2}`, 1]]), max: { [`claude-code:${LANE2}`]: 6 } })).toBeUndefined();
    expect(partyAdmission({ size: 5, keys, running: new Map([[`claude-code:${LANE2}`, 2]]), max: { [`claude-code:${LANE2}`]: 6 } })).toContain("needs 5 sessions");
    expect(partyAdmission({ size: 5, keys, running: new Map([["claude-code", 1]]), max: { "claude-code": 5 } })).toContain("claude-code");
    expect(partyAdmission({ size: 5, keys: ["openrouter"], running: new Map(), max: {}, paid: { running: 1, cap: 5 } })).toContain("paid slots");
  });

  test("planTick holds a pinned party the lane has no room for, with the reason, and plans it when there is", () => {
    const tight = fleet({}, { policy: { subscriptions: ["CLAUDE_CODE_OAUTH_TOKEN", LANE2], maxConcurrent: { [`claude-code:${LANE2}`]: 4 } } });
    const held = planTick(tight, [], () => undefined, STAMP);
    expect(held.pinned).toEqual([]);
    expect(held.heldPicks.find((h) => h.name === "deadmines-party-base")?.why).toContain("a party of 5 needs 5 sessions on claude-code:CLAUDE_CODE_OAUTH_TOKEN_2");
    const room = fleet({}, { policy: { subscriptions: ["CLAUDE_CODE_OAUTH_TOKEN", LANE2], maxConcurrent: { [`claude-code:${LANE2}`]: 5 } } });
    const planned = planTick(room, [], () => undefined, STAMP);
    expect(planned.pinned.map((p) => p.spawn.entries.length)).toEqual([5]);
  });
});

// ------------------------------------------------------------- squares

function probe(member: string, over: Partial<ProbeRun> = {}, id = `fleet-deadmines-party-base-sonnet-max-${STAMP}`): ProbeRun {
  return {
    campaign: "deadmines",
    version: 1,
    cell: "party",
    ref: "son2",
    arm: "base",
    counted: true,
    live: false,
    party: { id, size: 5 },
    terminationReason: "episode-limit",
    ...over,
  };
}

describe("campaign squares tally parties, not runs", () => {
  const c = fleet().campaigns.find((x) => x.name === "deadmines")!;
  const square = (runs: ProbeRun[]) => campaignSquares(c, ["son2"], runs)[0]!;

  test("five members are one attempt; it counts when the verdict that ended it counts", () => {
    const one = MEMBERS.map((m, i) => probe(m, i === 0 ? {} : { terminationReason: "party-ended" }));
    expect(square(one)).toMatchObject({ attempts: 1, done: 1, live: 0, settled: "done" });
  });

  test("a party that reached its kill end is done and reached; one that did not is done, not reached", () => {
    const reached = MEMBERS.map((m) => probe(m, { terminationReason: "kill-target" }));
    expect(square(reached)).toMatchObject({ attempts: 1, done: 1, reached: 1, live: 0, settled: "done" });
    const spent = MEMBERS.map((m, i) => probe(m, i === 0 ? {} : { terminationReason: "party-ended" }));
    expect(square(spent)).toMatchObject({ attempts: 1, done: 1, reached: 0 });
    // A kill end met while a member's adapter failed counts nothing: not done, not reached.
    const broken = MEMBERS.map((m, i) => probe(m, i === 1 ? { terminationReason: "adapter-error", counted: false } : { terminationReason: "kill-target" }));
    expect(square(broken)).toMatchObject({ attempts: 1, done: 0, reached: 0 });
  });

  test("a live member makes the party live; a missing or launch-failed member keeps it from counting", () => {
    expect(square(MEMBERS.map((m, i) => probe(m, { live: i === 2 })))).toMatchObject({ attempts: 1, live: 1, done: 0 });
    expect(square(MEMBERS.slice(0, 4).map((m) => probe(m)))).toMatchObject({ attempts: 1, done: 0 });
    expect(square(MEMBERS.map((m, i) => probe(m, i === 4 ? { terminationReason: "launch-failed", counted: false } : { terminationReason: "party-ended" })))).toMatchObject({ attempts: 1, done: 0 });
  });

  test("two parties are two attempts, and the cap is on parties", () => {
    const a = MEMBERS.map((m) => probe(m, { terminationReason: "party-ended", counted: false }));
    a[0] = { ...a[0]!, terminationReason: "adapter-error", counted: false };
    const b = MEMBERS.map((m) => probe(m, { terminationReason: "launch-failed", counted: false }, `fleet-deadmines-party-base-sonnet-max-${STAMP}-a2`));
    const c3 = MEMBERS.map((m) => probe(m, { terminationReason: "launch-failed", counted: false }, `fleet-deadmines-party-base-sonnet-max-${STAMP}-a3`));
    expect(square([...a, ...b])).toMatchObject({ attempts: 2, done: 0, settled: null });
    expect(square([...a, ...b, ...c3])).toMatchObject({ attempts: 3, done: 0, settled: "capped" });
  });

  test("a single run's square counts runs exactly as before", () => {
    const solo = joined([definition({ id: "solo" })], { solo: { version: 1, assignments: [{ model: "glm" }] } }).campaigns[0]!;
    const runs: ProbeRun[] = [
      { campaign: "solo", version: 1, cell: "a", ref: "glm", arm: "base", counted: true, live: false },
      { campaign: "solo", version: 1, cell: "a", ref: "glm", arm: "base", counted: false, live: true },
    ];
    expect(campaignSquares(solo, ["glm"], runs)[0]).toMatchObject({ attempts: 2, done: 1, live: 1 });
  });

  test("on disk: four members the stop paused and the party ended on the trigger's kill-target read as counted, and the square as done and reached", () => {
    const runs = tempDir("wb-party-kill-end-");
    const stem = `fleet-deadmines-party-base-sonnet-max-${STAMP}`;
    const records = PARTY_MEMBERS.map((m, i) => ({ member: m.id, role: m.role, runId: `${stem}-${m.id}`, account: ACCOUNTS[i]!, character: m.character }));
    for (const [i, m] of PARTY_MEMBERS.entries()) {
      const runId = `${stem}-${m.id}`;
      const t = new Trajectory(join(runs, runId));
      const config = {
        ...loadRunConfig({ runId, driver: "claude-code", model: "claude-sonnet-5-5" }),
        episode: "probing",
        campaign: "deadmines",
        campaignVersion: 1,
        cell: "party",
        arm: "base",
        ref: "son2",
        party: { id: stem, member: m.id, role: m.role, size: 5, members: records },
      };
      const meta = { runId, harnessVersion: "harness-0.5-1-gabc", startedAt: 1000, config: config as never, comparability: { episode: "probing" } as never };
      t.writeMeta(meta);
      t.append({ t: "response", turn: 1, message: { role: "assistant", content: "…" } });
      if (m.id === "rogue") {
        t.setTermination(runId, "kill-target", "entry 639 killed (killer party member 980)");
      } else {
        // The roster's stop: SIGTERM pauses the runner, with its mark in meta.json …
        t.pauseWithMark(runId, { reason: "operator-pause", detail: "SIGTERM", at: 2000 + i, episodeElapsedMs: 60_000 }, meta);
        // … and the party's end is written through the runner's own writer (`endMember`).
        t.setTermination(runId, "kill-target", "rogue: kill-target");
      }
      t.close();
    }
    const facts = readRunFacts(runs, 10_000_000);
    expect(facts.map((f) => [f.terminationReason, f.pause])).toEqual(PARTY_MEMBERS.map(() => ["kill-target", null]));
    const c = fleet().campaigns.find((x) => x.name === "deadmines")!;
    expect(campaignSquares(c, ["son2"], probeRunsOf(facts))[0]).toMatchObject({ attempts: 1, done: 1, reached: 1, live: 0, settled: "done" });
  });

  test("a single run that met its kill end is done and reached", () => {
    const solo = joined([definition({ id: "solo", stopAtLevel: null, end: [{ kill: { entry: 639 } }] })], { solo: { version: 1, assignments: [{ model: "glm" }] } }).campaigns[0]!;
    const runs: ProbeRun[] = [{ campaign: "solo", version: 1, cell: "a", ref: "glm", arm: "base", counted: true, live: false, terminationReason: "kill-target" }];
    expect(campaignSquares(solo, ["glm"], runs)[0]).toMatchObject({ attempts: 1, done: 1, reached: 1, settled: "done" });
  });
});

// -------------------------------------------------------------- resumes

describe("a paused party is planned whole", () => {
  const NOW = 1_800_000_000_000;
  const cfg = fleet();
  const stem = `fleet-deadmines-party-base-sonnet-max-${STAMP}`;
  const fileOf = (runId: string) => {
    const spawn = jobSpawn(pinnedCampaignJobs(cfg, [])[0]!, cfg.roster, "PARTY1", STAMP, undefined, cfg.campaigns);
    return fillEntries(spawn, STAMP).find((e) => e.runId === runId)?.campaignFile ?? null;
  };
  const fact = (member: string, i: number, over: Partial<RunFact> = {}): RunFact => ({
    runId: `${stem}-${member}`,
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
    pause: { reason: member === "rogue" ? "rate-limited" : "party-paused", at: NOW - 30 * 60_000, count: member === "rogue" ? 1 : 0, episodeElapsedMs: 50 * 60_000 },
    account: ACCOUNTS[i]!,
    character: PARTY_MEMBERS[i]!.character,
    episodeMs: 14_400_000,
    campaign: "deadmines",
    cell: "party",
    campaignVersion: 1,
    ref: "son2",
    arm: "base",
    subscription: LANE2,
    driver: "claude-code",
    party: { id: stem, member, size: 5 },
    ...over,
  });
  const facts = (over: (m: string, i: number) => Partial<RunFact> = () => ({})): RunFact[] => MEMBERS.map((m, i) => fact(m, i, over(m, i)));
  const plan = (runs: RunFact[], o: { held?: (a: string) => string | undefined; hold?: (f: RunFact) => string | undefined; running?: Map<string, string> } = {}) =>
    planResumes({
      runs,
      config: { ...cfg, policy: { ...DEFAULT_POLICY, ...cfg.policy } },
      running: o.running ?? new Map(),
      held: o.held ?? (() => undefined),
      now: NOW,
      campaignFileOf: fileOf,
      ...(o.hold !== undefined ? { subscriptionHold: o.hold } : {}),
    });

  test("one resume of all five, on the party's own run ids and accounts, under its pinned job", () => {
    const p = plan(facts());
    expect(p.end).toEqual([]);
    expect(p.listed).toEqual([]);
    expect(p.resume).toHaveLength(1);
    const r = p.resume[0]!;
    expect(r.job).toMatchObject({ name: "deadmines-party-base", account: "PARTY1", accounts: ACCOUNTS, partyId: stem, resume: { runId: `${stem}-tank` } });
    expect(r.why).toContain("rogue rate-limited");
    const spawn = jobSpawn(r.job, cfg.roster, r.account, "20261021", undefined, cfg.campaigns);
    expect(spawn.resumeRunId).toBe(`${stem}-tank`);
    expect(fillEntries(spawn, "20261021").map((e) => e.runId)).toEqual(MEMBERS.map((m) => `${stem}-${m}`));
  });

  test("a party of a version the operator concluded is listed whole, never resumed, whichever version the row names", () => {
    const concluded = { ...cfg, campaigns: cfg.campaigns.map((c) => ({ ...c, version: 4, concluded: [1, 2, 3] })) };
    const p = planResumes({ runs: facts(), config: { ...concluded, policy: { ...DEFAULT_POLICY, ...cfg.policy } }, running: new Map(), held: () => undefined, now: NOW, campaignFileOf: fileOf });
    expect(p.resume).toEqual([]);
    expect(p.end).toEqual([]);
    expect(p.listed).toHaveLength(5);
    expect(p.listed.every((l) => l.why === `party ${stem}: campaign deadmines@1 is concluded — it owes nothing; resume by hand or archive`)).toBe(true);
  });

  test("a party with a member that ended is listed, never half-resumed", () => {
    const p = plan(facts((m) => (m === "paladin" ? { pause: null, terminationReason: "episode-limit", endedAt: NOW - 1000 } : {})));
    expect(p.resume).toEqual([]);
    expect(p.listed).toHaveLength(4);
    expect(p.listed[0]!.why).toContain("a party resumes whole");
  });

  test("it waits on the slowest member's own pause, the usage gate on any member's lane, and every account", () => {
    const cooling = plan(facts((m) => (m === "rogue" ? { pause: { reason: "rate-limited", at: NOW - 30_000, count: 2, episodeElapsedMs: 1 } } : {})));
    expect(cooling.resume).toEqual([]);
    expect(cooling.listed[0]!.why).toContain("rogue rate-limited: resuming after");
    const gated = plan(facts(), { hold: (f) => (f.party?.member === "mage" ? "lane CLAUDE_CODE_OAUTH_TOKEN_2 at 82% of its window" : undefined) });
    expect(gated.resume).toEqual([]);
    expect(gated.listed.every((l) => l.why.includes("82%"))).toBe(true);
    const busy = plan(facts(), { held: (a) => (a === "PARTY4" ? "fleet-other-run" : undefined) });
    expect(busy.resume).toEqual([]);
    expect(busy.listed[0]!.why).toContain("PARTY4 is held by run fleet-other-run");
  });

  test("a party campaign that does not resume ends each paused member by the lane's rule", () => {
    const noResume = partyDefinition({ resume: false });
    const nr = parseFleet({
      _notes: ["n"],
      accounts: { pool: ["RUNNER"] },
      roster: ROSTER,
      policy: { subscriptions: ["CLAUDE_CODE_OAUTH_TOKEN", LANE2] },
      "campaign-defs": defsBlock(noResume),
      campaigns: { deadmines: { version: 1, assignments: [{ model: "son2" }], accounts: ACCOUNTS } },
      queue: [],
    });
    const p = planResumes({ runs: facts(), config: nr, running: new Map(), held: () => undefined, now: NOW });
    expect(p.resume).toEqual([]);
    expect(p.end.map((e) => e.reason).sort()).toEqual(["attempt-failed", "manual", "manual", "manual", "manual"]);
  });
});

// --------------------------------------------------------------- stager

describe("the stager's command contract", () => {
  const req: StageRequest = { party: "p", campaign: "deadmines", version: 1, scenario: "moonbrook-mine", level: 20, members: [] };

  test("a stager script that is not installed is a refusal naming it, not a crash", async () => {
    const r = await commandStager({ cwd: tempDir("wb-stager-none-") }).stage(req);
    expect(r).toEqual({ ok: false, reason: "the party stager infra/fixtures/stage-party.ts is not installed in this image" });
  });

  test("the roster's stop kills a staging in flight", async () => {
    const dir = tempDir("wb-stager-slow-");
    const script = join(dir, "slow.ts");
    writeFileSync(script, "await Bun.stdin.text(); await Bun.sleep(60_000);\n");
    const abort = new AbortController();
    const started = Date.now();
    const pending = commandStager({ cwd: dir, command: ["bun", script] }).stage(req, abort.signal);
    setTimeout(() => abort.abort(), 200);
    expect(await pending).toEqual({ ok: false, reason: "staging stopped: the roster was signalled" });
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  test("the request arrives on stdin; exit 0 is staged, anything else is the stderr's last line", async () => {
    const dir = tempDir("wb-stager-");
    const script = join(dir, "stage.ts");
    writeFileSync(
      script,
      [
        "const req = JSON.parse(await Bun.stdin.text());",
        'if (req.party === "bad") { console.error("loading"); console.error("SOAP: STAGER refused"); process.exit(3); }',
        'console.log("staging " + req.scenario);',
        "console.log(JSON.stringify({ ok: true, detail: `${req.members.length} staged for ${req.party}` }));",
      ].join("\n"),
    );
    chmodSync(script, 0o755);
    const stager = commandStager({ cwd: dir, command: ["bun", script] });
    expect(await stager.stage(req)).toEqual({ ok: true, detail: "0 staged for p" });
    expect(await stager.stage({ ...req, party: "bad" })).toEqual({ ok: false, reason: "staging failed (exit 3): SOAP: STAGER refused" });
  });
});

describe("the defer ladder", () => {
  test("members another member's verdict ended are no rungs: one early party death does not cool the model's evals", () => {
    const NOW = 1_800_000_000_000;
    const base = (i: number, over: Partial<RunFact>): RunFact => ({
      runId: `fleet-deadmines-party-base-sonnet-max-${STAMP}-${MEMBERS[i]}`,
      model: "sonnet",
      effort: "max",
      episode: "probing",
      episodeOverride: false,
      harnessVersion: null,
      harnessSeries: null,
      extra: false,
      startedAt: NOW - 60_000,
      endedAt: NOW - 30_000,
      terminationReason: "party-ended",
      modelResponses: 0,
      bestLevel: null,
      live: false,
      pause: null,
      account: ACCOUNTS[i]!,
      character: null,
      episodeMs: 14_400_000,
      campaign: "deadmines",
      cell: "party",
      subscription: LANE2,
      ...over,
    });
    // The paladin's pod never pulled; the other four were ended with it before a response.
    const runs = MEMBERS.map((_, i) => base(i, i === 4 ? { terminationReason: "launch-failed" } : {}));
    const [state] = modelStates({ runsDir: "/nonexistent", roster: [{ name: "son2", model: "sonnet", effort: "max", driver: "claude-code", tier: "t1" } as never], runs, sidecar: { version: 1, cleared: {} }, now: NOW });
    expect(state!.ladder).toBe(0);
    expect(state!.cooling).toBeUndefined();
  });
});

// Keep the job type in use for readers of this file's helpers.
export type { FleetJob, FleetRosterEntry };
