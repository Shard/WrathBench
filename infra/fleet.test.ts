import { describe, expect, test } from "bun:test";
import {
  DEFAULT_PREFLIGHT,
  bootMarker,
  diffJobs,
  formatGate,
  gateDecision,
  gateOpen,
  healthDigest,
  parsePreflight,
  preflightAccounts,
  runPreflight,
  serverIdentity,
  smokePath,
  tailOf,
  fillEntries,
  isAllowlistedFree,
  isClaudeFamily,
  isSharedFreePool,
  jobArgv,
  fleetComplete,
  resolveStatePath,
  parseFleet,
  rereadFleet,
  formatConfigBanner,
  loadConfigForRead,
  nextConfigRejection,
  validateEntries,
  episodeDimensions,
  formatAccounts,
  formatQueue,
  liveJobsFromState,
  jobsByAccount,
  type StateJob,
  stateJobFacts,
  pinnedJobs,
  poolJobs,
  policyRefs,
  policyExclusion,
  planTick,
  jobSpawn,
  planResumes,
  formatPaused,
  formatEnded,
  endRuns,
  refOfRunId,
  resumeNotBefore,
  withResume,
  planQueue,
  planPolicy,
  policyJob,
  rosterModels,
  eligibleFrom,
  formatModels,
  isExtraJob,
  runnableRefs,
  type FleetJob,
  type FleetRosterEntry,
  type FleetConfig,
  type JobSpawn,
  type FleetPreflight,
  type JobSets,
  type PreflightRecord,
  type PreflightSmoke,
  type ConfigRejection,
  currentSeries,
  classPoolsOf,
  formatRefusals,
  planPolicyHeld,
  formatPaidClass,
  formatLocalClass,
  formatAccountClasses,
  formatHeld,
  unpinnedCampaigns,
  pinnedCampaignJobs,
  probeRunsOf,
} from "./run-fleet";
import { DEFAULT_POLICY, IDLE_MODES, TIERS, TIER_TABLE, modelStates, rosterClass, type ModelState, type RosterModel, type RunFact, type SchedulingPolicy } from "../runner/src/models";
import type { EpisodeId } from "../runner/src/episodes";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Trajectory } from "../runner/src/trajectory";
import { loadRunConfig } from "../runner/src/config";

/**
 * The fleet is config, and the config's whole job is to become a set of
 * run-roster invocations. No spawning here: everything below the spawn
 * boundary is run-roster's, already covered by roster.test.ts.
 */

function spawn(over: Partial<JobSpawn> = {}): JobSpawn {
  return {
    name: "l",
    enabled: true,
    account: "RUNNER",
    loop: false,
    entries: [{ model: "z-ai/glm-5.2:free" }],
    ...over,
  };
}

/** A minimal 0.4 file: a roster, a pool, and the jobs given. */
function fleetJson(queue: unknown[], over: Record<string, unknown> = {}): unknown {
  return {
    _notes: ["n"],
    accounts: { pool: ["RUNNER", "RUNNER2"] },
    roster: { glm: { tier: "t1", model: "z-ai/glm-5.2:free" }, son: { tier: "t1", model: "sonnet", driver: "claude-code" }, ox: { tier: "t1", model: "stealth/ox-alpha" } },
    queue,
    ...over,
  };
}

describe("parseFleet", () => {
  test("the shipped shape parses and keeps job order", () => {
    const config = parseFleet(fleetJson([{ ref: "son", episode: "freeplay", account: "SHAKEOUT", repeat: "loop" }, { ref: "glm", episode: "e90" }]));
    expect(config.jobs.map((l) => l.name)).toEqual(["son-freeplay", "glm-e90"]);
    expect(config.jobs[0]).toMatchObject({ account: "SHAKEOUT", repeat: "loop", source: "pinned", enabled: true });
    expect(jobSpawn(config.jobs[0]!, config.roster, "SHAKEOUT", "20260101")).toMatchObject({ name: "son-freeplay", account: "SHAKEOUT", loop: true });
  });

  test("two enabled jobs sharing an account: the LATER one is refused, the file survives", () => {
    // Item 66. This used to take the whole config down, and because a rejected
    // re-read keeps the last good one, every other `enabled:` flag in the file
    // went inert with it. The rule stands — one live session per account — but
    // it is enforced against the pin, in file order, so the first keeps it.
    const config = parseFleet(
      fleetJson([{ ref: "glm", episode: "e90", account: "S" }, { ref: "ox", episode: "e90", account: "s" }]),
    );
    expect(config.jobs.map((j) => [j.name, j.enabled])).toEqual([["glm-e90", true], ["ox-e90", false]]);
    expect(config.refusals).toEqual([
      { pin: "ox-e90", why: "account s is already glm-e90's — one enabled job per account", jobs: ["ox-e90"] },
    ]);
  });

  test("a disabled job may sit on a running job's account — that is the burn switch", () => {
    const config = parseFleet(fleetJson([{ ref: "glm", episode: "e90", account: "SHAKEOUT" }, { ref: "ox", episode: "e90", account: "SHAKEOUT", enabled: false }]));
    expect(config.jobs).toHaveLength(2);
    expect(config.accounts.pinned).toEqual({ SHAKEOUT: "glm-e90" });
  });

  test("a pin on the preflight account is refused; a listed account clashing with it still fails", () => {
    // Where there IS a pin to name, it loses and the gate keeps its account —
    // ADR-0023 runs before anything else does. Where there is not, the loser
    // would be an account list, so the file still fails: nothing to disable.
    const onGate = parseFleet(
      fleetJson([{ ref: "glm", episode: "e90", account: "SMOKE" }], {
        preflight: { enabled: true, account: "SMOKE", smokes: ["x.ts"] },
      }),
    );
    expect(onGate.jobs[0]!.enabled).toBe(false);
    expect(onGate.refusals[0]).toMatchObject({ pin: "glm-e90", jobs: ["glm-e90"] });
    expect(onGate.refusals[0]!.why).toMatch(/account SMOKE is the preflight gate's/);
    expect(() =>
      parseFleet(fleetJson([], { accounts: { pool: ["SMOKE"] }, preflight: { enabled: true, account: "SMOKE", smokes: ["x.ts"] } })),
    ).toThrow(/also in accounts.pool/);
  });

  test("a refused pin names the jobs it suppresses, so a live run is not drained for it", () => {
    // The regression that mattered. A refused pin is `enabled: false`, and
    // `diffJobs` drains a running job whose spawn is gone or disabled — so
    // adding one queue job on an account a campaign already holds would have
    // SIGTERMed that campaign's probe at the next episode boundary. Under the
    // whole-file rejection it replaced, the live run was never touched. A
    // refusal must suppress SCHEDULING only, so the tick needs to tell a run
    // under a refused pin apart from one the operator parked: that is `jobs`.
    const config = parseFleet(
      fleetJson([{ ref: "glm", episode: "e90", account: "S" }], {
        campaigns: { probe1: { cells: [{ id: "c1" }, { id: "c2" }], account: "s" } },
      }),
    );
    expect(config.refusals[0]!.jobs).toEqual(["probe1-c1", "probe1-c2"]);
    // What the tick does with them: the live probe survives the diff.
    const live = { running: new Set(["probe1-c1"]), draining: new Set<string>(), finished: new Set<string>() };
    const drain = diffJobs(pinnedJobs(config).map((j) => ({ ...j, refs: j.refs })) as never, live).drain;
    expect(drain).toEqual(["probe1-c1"]);
    const refused = new Set(config.refusals.flatMap((r) => r.jobs));
    expect(drain.filter((n) => !refused.has(n))).toEqual([]);
  });

  test("a clean config refuses nothing, and the refusal block stays silent", () => {
    expect(parseFleet(fleetJson([{ ref: "glm", episode: "e90" }])).refusals).toEqual([]);
    expect(formatRefusals([])).toEqual([]);
    expect(formatRefusals([{ pin: "a-e90", why: "because", jobs: ["a-e90"] }])).toEqual([
      "! 1 pin(s) refused by the account rules — the rest of the file IS in effect:",
      "   a-e90 REFUSED and left disabled: because",
      "   a live run under a refused pin is left alone; it just will not respawn",
    ]);
    // Under a REJECTED banner the block must not claim the file is in effect.
    expect(formatRefusals([{ pin: "a-e90", why: "because", jobs: ["a-e90"] }], false)[0]).toMatch(/IN THE FILE — see the banner above/);
  });

  test("pre-0.4 keys are refused by name, naming the 0.4 shape", () => {
    expect(() => parseFleet([])).toThrow(/must be a JSON object/);
    expect(() => parseFleet(fleetJson([], { lanes: [] }))).toThrow(/`lanes` is not a 0.4 key — a job goes in `queue`/);
    expect(() => parseFleet(fleetJson([], { accounts: { pinned: { S: "x" }, pool: [] } }))).toThrow(/accounts.pinned is not a 0.4 key/);
    expect(() => parseFleet(fleetJson([], { roster: { old: { tier: "t1", model: "sonnet", driver: "claude-subscription" } } }))).toThrow(/unknown driver claude-subscription \(openai \| claude-code\)/);
  });
});

describe("campaigns (ADR-0041)", () => {
  test("a campaigns section parses", () => {
    const config = parseFleet(fleetJson([], { campaigns: { probe1: { cells: [{ id: "c1" }] } } }));
    expect(config.campaigns).toHaveLength(1);
    expect(config.campaigns[0]).toMatchObject({ name: "probe1", enabled: true, models: "all", runsPerCell: 1 });
    expect(config.campaigns[0]!.cells).toEqual([{ id: "c1" }]);
  });

  test("a bad campaign is refused with a useful message", () => {
    expect(() => parseFleet(fleetJson([], { campaigns: { probe1: { cells: [] } } }))).toThrow(/campaigns:/);
  });

  test("a pinned campaign sharing an account with an enabled job is refused, not the file", () => {
    // Jobs come before campaigns in the pin order, so the job keeps the account.
    const config = parseFleet(
      fleetJson([{ ref: "glm", episode: "e90", account: "S" }], {
        campaigns: { probe1: { cells: [{ id: "c1" }], account: "s" } },
      }),
    );
    expect(config.jobs[0]!.enabled).toBe(true);
    expect(config.campaigns[0]!.enabled).toBe(false);
    // A campaign's `jobs` are one per declared cell — what a live probe runs under.
    expect(config.refusals[0]).toMatchObject({ pin: "campaign probe1", jobs: ["probe1-c1"] });
    expect(config.refusals[0]!.why).toMatch(/^account s is already glm-e90's/);
  });

  test("a disabled pinned campaign may park on a listed account", () => {
    const config = parseFleet(fleetJson([], { campaigns: { probe1: { cells: [{ id: "c1" }], account: "RUNNER", enabled: false } } }));
    expect(config.campaigns[0]).toMatchObject({ name: "probe1", enabled: false, account: "RUNNER" });
  });

  test("a pinned campaign is NOT passed to the scheduler while an unpinned enabled one is", () => {
    const config = parseFleet(
      fleetJson([], {
        campaigns: {
          pinned1: { cells: [{ id: "c1" }], account: "CAMPACCT" },
          free1: { cells: [{ id: "c1" }] },
        },
      }),
    );
    expect(config.campaigns.map((c) => c.name)).toEqual(["pinned1", "free1"]);
    expect(unpinnedCampaigns(config).map((c) => c.name)).toEqual(["free1"]);
  });

  test("a pinned campaign becomes a job on its own account, one cell at a time", () => {
    const config = parseFleet(
      fleetJson([], {
        campaigns: {
          nav: { cells: [{ id: "coldridge" }, { id: "loch" }], account: "SHAKEOUT", models: ["son"], objective: "walk" },
        },
      }),
    );
    const jobs = pinnedCampaignJobs(config, []);
    // One job, not one per cell: an account runs a single live session, so
    // offering it the whole sweep would only queue behind itself.
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      ref: "son",
      episode: "probing",
      account: "SHAKEOUT",
      enabled: true,
      probe: { campaign: "nav", cell: "coldridge" },
    });
  });

  test("a pinned campaign whose cells are all done offers no job", () => {
    const config = parseFleet(
      fleetJson([], { campaigns: { nav: { cells: [{ id: "coldridge" }], account: "SHAKEOUT", models: ["son"] } } }),
    );
    expect(pinnedCampaignJobs(config, [{ campaign: "nav", cell: "coldridge", ref: "son" }])).toEqual([]);
  });

  test("an unpinned campaign is never built into a job here", () => {
    const config = parseFleet(fleetJson([], { campaigns: { free1: { cells: [{ id: "c1" }] } } }));
    expect(pinnedCampaignJobs(config, [])).toEqual([]);
  });

  test("a probe spawn carries the campaign and drops the catalog entry's own task shape", () => {
    // The load-bearing precedence rule: the campaign owns the task, the entry
    // owns only the credentials. An entry that happens to carry an objective
    // must not smuggle it into a sweep that named its own.
    const config = parseFleet(
      fleetJson([], {
        roster: { son: { tier: "t1", model: "sonnet", driver: "claude-code", maxToolCalls: 99 } },
        campaigns: {
          nav: {
            cells: [{ id: "coldridge", race: 3, class: 2 }],
            account: "SHAKEOUT",
            models: ["son"],
            objective: "walk to Ironforge",
            maxToolCalls: 2500,
            wikiCoords: true,
          },
        },
      }),
    );
    const job = pinnedCampaignJobs(config, [])[0]!;
    const spawn = jobSpawn(job, config.roster, "SHAKEOUT", "20260824", undefined, config.campaigns);
    expect(spawn.entries[0]).toMatchObject({
      model: "sonnet",
      episode: "probing",
      campaign: "nav",
      cell: "coldridge",
      objective: "walk to Ironforge",
      maxToolCalls: 2500,
      race: 3,
      class: 2,
    });
    // The entry asked for a 99-call ceiling; the campaign's 2500 stands, and
    // the entry's number does not leak in. A campaign is the whole authority on
    // its task shape, and coordinates come from it rather than from the catalog
    // (which may no longer ask for them at all).
    expect(spawn.entries[0]!.wikiCoords).toBe(true);
    expect(spawn.entries[0]!.maxToolCalls).toBe(2500);
  });

  test("two cells of one campaign are two job names, so nothing collides", () => {
    // The job name is what run ids, log paths and the defer sidecar hang off,
    // so the cell has to be in it — otherwise a whole sweep accumulates under
    // one name and no run id says which cell it was.
    const config = parseFleet(
      fleetJson([], {
        campaigns: { nav: { cells: [{ id: "coldridge" }, { id: "loch" }], account: "SHAKEOUT", models: ["son"] } },
      }),
    );
    const first = pinnedCampaignJobs(config, [])[0]!;
    const second = pinnedCampaignJobs(config, [{ campaign: "nav", cell: "coldridge", ref: "son" }])[0]!;
    expect(first.name).toBe("nav-coldridge");
    expect(second.name).toBe("nav-loch");
    expect(policyJob({ name: "son", episode: "probing", account: "R1", attempt: 1, why: "w", probe: { campaign: "nav", cell: "loch" } }).name).toBe(
      "son-nav-loch",
    );
  });

  test("probeRunsOf recovers the roster ref from model+effort, and nulls it when nothing matches", () => {
    const roster: Record<string, FleetRosterEntry> = {
      glm: { model: "z-ai/glm-5.2:free", tier: "t1", idle: "none" },
    };
    const fact = (over: Partial<RunFact>): RunFact => ({
      runId: "r",
      model: "z-ai/glm-5.2:free",
      effort: null,
      episode: "probing",
      episodeOverride: false,
      harnessVersion: null,
      harnessSeries: null,
      extra: false,
      startedAt: 0,
      endedAt: 1,
      terminationReason: "episode-limit",
      modelResponses: 5,
      bestLevel: 1,
      live: false,
      pause: null,
      account: null,
      episodeMs: null,
      campaign: "probe1",
      cell: "c1",
      ...over,
    });
    const matched = fact({});
    const unmatched = fact({ runId: "r2", model: "unknown/model" });
    // A run that never produced a response is not counted, so it never reaches probeRunsOf's output.
    const stillborn = fact({ runId: "r3", modelResponses: 0 });
    expect(probeRunsOf([matched, unmatched, stillborn], roster)).toEqual([
      { campaign: "probe1", cell: "c1", ref: "glm" },
      { campaign: "probe1", cell: "c1", ref: null },
    ]);
  });
});

describe("roster policy", () => {
  test.each(["sonnet", "opus", "haiku", "claude-4-opus", "anthropic/claude-3.5-sonnet:free"])(
    "%s is claude-family",
    (m) => expect(isClaudeFamily(m)).toBe(true),
  );
  test.each(["z-ai/glm-5.2:free", "poolside/laguna-s-2.1:free", "deepseek-v4-flash-free"])(
    "%s is not claude-family",
    (m) => expect(isClaudeFamily(m)).toBe(false),
  );

  test("a claude model on an openai-driver entry is refused, citing the roster policy", () => {
    expect(() => validateEntries("roster:x", [{ model: "sonnet" }])).toThrow(/roster policy/);
    expect(() => validateEntries("roster:x", [{ model: "anthropic/claude-3.5-sonnet:free", driver: "openai" }])).toThrow(
      /roster policy/,
    );
  });

  test("the claude-code driver carries claude models only", () => {
    expect(() => validateEntries("roster:x", [{ model: "z-ai/glm-5.2:free", driver: "claude-code" }])).toThrow(
      /roster policy/,
    );
  });

  test("a driver outside the vocabulary is refused by name — the pre-0.4 spelling included", () => {
    expect(() => validateEntries("roster:x", [{ model: "sonnet", driver: "claude-subscription" as never }])).toThrow(/unknown driver claude-subscription/);
    expect(() => validateEntries("roster:x", [{ model: "sonnet", driver: "claude-thing" as never }])).toThrow(/unknown driver/);
  });

  test("a character the runner would refuse is a config error at load, not a respawn loop", () => {
    // `Fleetsonnetlo` (13 chars) passed the fleet, failed the runner's Zod
    // boundary every launch, and the roster exited 0 — so the policy retried
    // it every tick for two hours (2026-08-24). The name dies here now.
    expect(() => validateEntries("roster:x", [{ model: "sonnet", driver: "claude-code", character: "Fleetsonnetlo" }])).toThrow(
      /character must be 2-12 letters/,
    );
    expect(() => validateEntries("roster:x", [{ model: "sonnet", driver: "claude-code", character: "X" }])).toThrow(/character/);
    expect(() => validateEntries("roster:x", [{ model: "sonnet", driver: "claude-code", character: "Benchy1" }])).toThrow(/character/);
    expect(() => validateEntries("roster:x", [{ model: "sonnet", driver: "claude-code", character: "Fleetsonnlo" }])).not.toThrow();
  });

  test("a suffixless model on a shared free pool is refused unless allowlisted", () => {
    // A paid-looking id with no free suffix on OpenRouter is a roster-policy error.
    expect(() => validateEntries("roster:x", [{ model: "z-ai/glm-5.2" }])).toThrow(/roster policy/);
    // The verified-free stealth id is allowlisted and passes.
    expect(isAllowlistedFree("stealth/ox-alpha")).toBe(true);
    expect(() => validateEntries("roster:x", [{ model: "stealth/ox-alpha" }])).not.toThrow();
    // Allowlist membership does not leak to other suffixless ids.
    expect(isAllowlistedFree("stealth/anything-else")).toBe(false);
  });

  test("a suffixless model on a shared pool passes when it declares billing paid", () => {
    expect(() => validateEntries("roster:x", [{ model: "deepseek/deepseek-v4-flash" }])).toThrow(/roster policy/);
    expect(() =>
      validateEntries("roster:x", [{ model: "deepseek/deepseek-v4-flash", billing: "paid" }]),
    ).not.toThrow();
  });

  test.each([
    [undefined, true], // absent -> run-roster's OpenRouter default -> shared pool
    ["https://openrouter.ai/api/v1", true],
    ["https://opencode.ai/zen/v1", true],
    ["http://192.168.1.20:1234/v1", false], // local LM Studio box on the LAN
    ["http://localhost:1234/v1", false],
  ] as const)("isSharedFreePool(%s) === %s", (base, expected) => {
    expect(isSharedFreePool(base)).toBe(expected);
  });

  test("a shared free-cloud pool still requires a free model id", () => {
    // No apiBase -> OpenRouter default -> shared pool -> suffix required.
    expect(() => validateEntries("roster:x", [{ model: "z-ai/glm-5.2" }])).toThrow(/free models only/);
    expect(() =>
      validateEntries("roster:x", [{ model: "deepseek-v4-flash", apiBase: "https://opencode.ai/zen/v1" }]),
    ).toThrow(/free models only/);
    // A properly suffixed model on the pool is fine.
    expect(validateEntries("roster:x", [{ model: "z-ai/glm-5.2:free" }])).toHaveLength(1);
  });

  test("a local/self-hosted openai entry is exempt from the free-suffix rule", () => {
    expect(
      validateEntries("roster:x", [
        { model: "qwen/qwen3.8-27b", driver: "openai", apiBase: "http://192.168.1.20:1234/v1", apiKeyEnv: "LMSTUDIO_KEY" },
      ]),
    ).toHaveLength(1);
  });

  test("a claude-* id is barred on any openai entry, local or shared", () => {
    // Shared pool.
    expect(() => validateEntries("roster:x", [{ model: "anthropic/claude-3.5-sonnet:free" }])).toThrow(/roster policy/);
    // Local entry: exempt from the free-suffix rule but never from the claude bar.
    expect(() =>
      validateEntries("roster:x", [{ model: "claude-4-opus", apiBase: "http://192.168.1.20:1234/v1" }]),
    ).toThrow(/roster policy/);
  });
});

describe("rereadFleet", () => {
  const good: FleetConfig = parseFleet(fleetJson([{ ref: "glm", episode: "e90" }]));

  test("a malformed re-read keeps the last good config and reports the error", () => {
    const r = rereadFleet("fleet.json", good, () => "{not json");
    expect(r.config).toBe(good);
    expect(r.error).toBeDefined();
  });

  test("a re-read that violates a WHOLE-FILE guard keeps the last good config too", () => {
    // A duplicate job name leaves the file ambiguous — there is no losing pin to
    // pick — so it is still fatal, and the last good config stays in effect.
    const dupe = JSON.stringify(fleetJson([{ ref: "glm", episode: "e90" }, { ref: "glm", episode: "e90" }]));
    const r = rereadFleet("fleet.json", good, () => dupe);
    expect(r.config).toBe(good);
    expect(r.error).toMatch(/two jobs would share the name/);
  });

  test("a re-read violating an ACCOUNT rule takes effect, minus the pin it refused", () => {
    // The point of item 66. Before, this re-read was rejected and every other
    // `enabled:` flag in the new file went inert behind the old config; now the
    // file loads, one job is disabled, and the operator is told which.
    const clash = JSON.stringify(fleetJson([{ ref: "glm", episode: "e90", account: "X" }, { ref: "ox", episode: "e90", account: "X" }]));
    const r = rereadFleet("fleet.json", good, () => clash);
    expect(r.error).toBeUndefined();
    expect(r.config).not.toBe(good);
    expect(r.config.jobs.map((j) => [j.name, j.enabled])).toEqual([["glm-e90", true], ["ox-e90", false]]);
    expect(r.config.refusals).toHaveLength(1);
  });

  test("a valid re-read replaces the config", () => {
    const next = JSON.stringify(fleetJson([{ ref: "ox", episode: "e360" }]));
    const r = rereadFleet("fleet.json", good, () => next);
    expect(r.error).toBeUndefined();
    expect(r.config.jobs[0]!.name).toBe("ox-e360");
  });
});

describe("fillEntries", () => {
  test("entries get the job's account and a fleet-scoped run id", () => {
    const [e] = fillEntries(spawn({ name: "free-openrouter", account: "RUNNER" }), "20260822");
    expect(e!.account).toBe("RUNNER");
    expect(e!.runId).toBe("fleet-free-openrouter-glm-5-2-20260822");
  });

  test("effort is part of the derived run id, and an explicit runId wins", () => {
    const specs = fillEntries(
      spawn({
        name: "sub",
        account: "SHAKEOUT",
        entries: [
          { model: "sonnet", driver: "claude-code", effort: "low" },
          { model: "sonnet", driver: "claude-code", runId: "pinned" },
        ],
      }),
      "20260822",
    );
    expect(specs[0]!.runId).toBe("fleet-sub-sonnet-low-20260822");
    expect(specs[1]!.runId).toBe("pinned");
  });
});

describe("jobArgv", () => {
  test("a loop job builds the full roster argv: file, log, date, loop, until", () => {
    const argv = jobArgv(spawn({ name: "sub-sonnet", loop: true }), { stamp: "20260822", until: "18:00" });
    expect(argv[0]).toEndWith("run-roster.sh");
    expect(argv[1]).toEndWith("fleet-sub-sonnet-20260822.roster.json");
    expect(argv[argv.indexOf("--log") + 1]).toEndWith("fleet-sub-sonnet-20260822.jsonl");
    expect(argv[argv.indexOf("--date") + 1]).toBe("20260822");
    expect(argv).toContain("--loop");
    expect(argv[argv.indexOf("--until") + 1]).toBe("18:00");
  });

  test("a respawn resumes the materialized roster", () => {
    const argv = jobArgv(spawn(), { stamp: "20260822", until: undefined, resumeRoster: true });
    expect(argv).toContain("--resume-roster");
    expect(argv).not.toContain("--loop");
  });

  test("a loop job with no stop condition loops forever — the fleet-service shape", () => {
    // ADR-0020: the supervisor has no deadline; steering is fleet.json.
    expect(jobArgv(spawn({ loop: true }), { stamp: "20260822", until: undefined })).not.toContain("--until");
  });
});

describe("diffJobs", () => {
  const sets = (over: Partial<JobSets> = {}): JobSets => ({
    running: new Set(),
    draining: new Set(),
    finished: new Set(),
    ...over,
  });

  test("startup: every enabled job starts, disabled jobs do not", () => {
    const a = diffJobs([spawn({ name: "on" }), spawn({ name: "off", enabled: false, account: "B" })], sets());
    expect(a.start.map((l) => l.name)).toEqual(["on"]);
    expect(a.drain).toEqual([]);
  });

  test("flipping a running job to enabled:false drains it, exactly once", () => {
    const disabled = [spawn({ name: "l", enabled: false })];
    expect(diffJobs(disabled, sets({ running: new Set(["l"]) })).drain).toEqual(["l"]);
    expect(diffJobs(disabled, sets({ running: new Set(["l"]), draining: new Set(["l"]) })).drain).toEqual([]);
  });

  test("a job deleted from the config drains like a disabled one", () => {
    expect(diffJobs([], sets({ running: new Set(["gone"]) })).drain).toEqual(["gone"]);
  });

  test("re-enabling a draining job keeps it running instead of respawning", () => {
    const a = diffJobs([spawn({ name: "l" })], sets({ running: new Set(["l"]), draining: new Set(["l"]) }));
    expect(a.undrain).toEqual(["l"]);
    expect(a.start).toEqual([]);
  });

  test("a finished job is not respawned while enabled, and is rearmed by disabling", () => {
    expect(diffJobs([spawn({ name: "l" })], sets({ finished: new Set(["l"]) })).start).toEqual([]);
    const a = diffJobs([spawn({ name: "l", enabled: false })], sets({ finished: new Set(["l"]) }));
    expect(a.rearm).toEqual(["l"]);
    // ...after which enabling starts it again
    expect(diffJobs([spawn({ name: "l" })], sets()).start.map((l) => l.name)).toEqual(["l"]);
  });

  test("a newly added enabled job starts on the tick that sees it", () => {
    const a = diffJobs([spawn({ name: "old" }), spawn({ name: "new", account: "B" })], sets({ running: new Set(["old"]) }));
    expect(a.start.map((l) => l.name)).toEqual(["new"]);
  });
});

describe("the shipped fleet files", () => {
  // Durable invariants only. `fleet.json` is the LIVE file: the supervisor
  // hot-reloads it, the operator prunes and adds roster models daily, and
  // `enabled` is a steering knob — none of that may turn the suite red. What
  // is durable: the shape, the pinned accounts, the probe's leash, and the
  // roster policy (claude models only through the claude-code harness,
  // ADR-0035; shared free pools carry free ids only unless an entry declares
  // `billing: "paid"` on purpose, ADR-0034's paid policy).
  const rosterPolicy = (config: FleetConfig): void => {
    for (const e of Object.values(config.roster)) {
      const driver = e.driver ?? "openai";
      expect(["openai", "claude-code"]).toContain(driver);
      if (isClaudeFamily(e.model)) expect(driver).toBe("claude-code");
      if (driver === "claude-code") expect(isClaudeFamily(e.model)).toBe(true);
      if (driver === "openai" && isSharedFreePool(e.apiBase)) {
        expect(/(-free$|:free$)/.test(e.model) || isAllowlistedFree(e.model) || e.billing === "paid").toBe(true);
      }
    }
  };

  test("fleet.json: every model's evidence budget is its tier and its idle axis, and nothing else sets a run count", async () => {
    const NOW = Date.parse("2027-01-15T08:00:00.000Z");
    const raw = (await Bun.file(new URL("./fleet.json", import.meta.url).pathname).json()) as unknown;
    const config = parseFleet(raw);

    /*
     * THE invariant this test exists for (ADR-0043). It is not a snapshot of
     * the shipped file — the operator retiers models nightly and that must not
     * break CI. It is the one property the refactor bought: how much a model
     * runs is the word `tier` on its entry, full stop. No per-entry override,
     * no per-billing table, no policy target, no queue job standing in for a
     * budget. If any of those come back, this fails and says which.
     */
    for (const [name, e] of Object.entries(config.roster)) {
      // Every entry states exactly one budget, and it is a tier from the code
      // table. There is no steered-entry exception left to make: since
      // ADR-0041 an entry cannot carry an objective, so it is always in the
      // policy and always states a tier.
      expect(TIERS).toContain(e.tier);
      expect(IDLE_MODES).toContain(e.idle);
      const asAny = e as unknown as Record<string, unknown>;
      expect(asAny["runsPerEpisode"], `${name} must not carry a run count of its own`).toBeUndefined();
      expect(asAny["tiers"], `${name} must not carry the retired force`).toBeUndefined();
    }
    // The policy block says only where runs execute and how many at once.
    const policyAny = (raw as { policy: Record<string, unknown> }).policy;
    expect(policyAny["runsPerEpisode"]).toBeUndefined();
    expect(policyAny["extras"]).toBeUndefined();
    expect(config.policy.paid).toEqual({ maxConcurrent: 1 });
    expect(config.maxConcurrent).toEqual({ "claude-code": 2, openrouter: 1, opencode: 1 });

    // A trial is one line and one line only: tier t0, and nothing else in the
    // file arranges it — no queue job, no account pin, no billing flip. This is
    // the acceptance test for the whole refactor.
    for (const name of ["gpt-luna", "gemini-flash", "deepseek-flash"]) {
      const e = config.roster[name]!;
      expect(e.tier).toBe("t0");
      expect(e.idle).toBe("none");
      expect(poolJobs(config).some((j) => j.refs.includes(name))).toBe(false);
      expect(Object.values(config.accounts.pinned)).not.toContain(`${name}-e90`);
      // And a t0 model that plays well keeps its witness without spending it.
      const witness: RunFact = {
        runId: `${name}-1`,
        model: e.model,
        effort: null,
        episode: "e90",
        episodeOverride: false,
        harnessVersion: null,
        harnessSeries: config.policy.series,
        extra: false,
        startedAt: NOW - 2 * 3_600_000,
        endedAt: NOW - 3_600_000,
        terminationReason: "episode-limit",
        modelResponses: 20,
        bestLevel: 6,
        live: false,
        pause: null,
        account: null,
        episodeMs: null,
        campaign: null,
        cell: null,
      };
      const st = modelStatesOf(rosterModels(config.roster), [witness], NOW, config.policy).find((x) => x.name === name)!;
      expect(st.earnedRung1).toBe(true);
      expect(st.tier).toBe("t0");
      expect(st.eligible).toEqual(["e90"]);
      expect(st.status).not.toBe("promoted");
    }

    // Account classes, which billing still governs — and only these.
    expect(config.accounts.pool).toEqual(["RUNNER", "RUNNER2", "RUNNER3", "RUNNER5", "RUNNER6"]);
    expect(config.accounts.paid).toEqual(["SHAKEOUT2"]);
    expect(classPoolsOf(config).paid).toEqual(["SHAKEOUT2"]);
    expect(config.accounts.local).toEqual(["RUNNER4"]);
    expect(rosterModels(config.roster).filter((r) => rosterClass(r) === "local").map((r) => r.name)).toEqual(["qwen3-8-27b"]);
    // Whatever it is called, the job parked on the paid account is disabled —
    // an enabled one would HOLD SHAKEOUT2 and starve the paid class.
    expect(config.jobs.find((j) => j.account === "SHAKEOUT2")!.enabled).toBe(false);
    // SHAKEOUT is spoken for by the nav-probe CAMPAIGN now, not by a queue job.
    expect(Object.keys(config.accounts.pinned).sort()).toEqual(["SHAKEOUT", "SHAKEOUT2"]);
    expect(config.accounts.pinned["SHAKEOUT"]).toBe("campaign nav-probe");

    // The roster is a CATALOG (ADR-0041): every entry is a model and nothing
    // else, so nothing in it carries an objective or wiki coords, and the two
    // probes that used to live there are campaigns.
    for (const [n, e] of Object.entries(config.roster)) {
      expect(e.objective, `${n} carries an objective`).toBeUndefined();
      expect(e.wikiCoords, `${n} carries wikiCoords`).toBeUndefined();
      expect(e.tier, `${n} has no tier`).toBeDefined();
    }

    // nav-probe: the navigation probe, pinned to its own account, 6h episodes,
    // no-xp disabled, the only thing serving wiki coords. It borrows `sonnet`'s
    // credentials and owns its whole task shape.
    const nav = config.campaigns.find((c) => c.name === "nav-probe")!;
    expect(nav).toMatchObject({ enabled: true, account: "SHAKEOUT", models: ["sonnet"], wikiCoords: true, maxToolCalls: 2500 });
    expect(nav.objective).toContain("Ironforge");
    expect(nav.watchdogs).toEqual({ episodeMs: 21_600_000, noXpMs: null, idleMs: 1_200_000 });
    expect(nav.cells.map((c) => c.id)).toEqual(["coldridge"]);
    const navJob = pinnedCampaignJobs(config, [])[0]!;
    expect(navJob).toMatchObject({ name: "nav-probe-coldridge", account: "SHAKEOUT", episode: "probing", ref: "sonnet" });
    const probeSpawn = jobSpawn(navJob, config.roster, "SHAKEOUT", "20260101", undefined, config.campaigns);
    expect(probeSpawn.entries[0]).toMatchObject({
      episode: "probing",
      campaign: "nav-probe",
      cell: "coldridge",
      wikiCoords: true,
      maxToolCalls: 2500,
      character: "Navprobe",
      watchdogs: { episodeMs: 21_600_000, noXpMs: null, idleMs: 1_200_000 },
    });

    // class-probe: the race/class sweep that used to be `idle: "characters"`.
    // Eight cells named in the file rather than a code-side cycle indexed by a
    // counter that meant something else, and unscored where it belongs.
    const classes = config.campaigns.find((c) => c.name === "class-probe")!;
    expect(classes.cells).toHaveLength(8);
    expect(classes.account).toBeUndefined();
    expect(classes.models).toEqual(["ox-alpha", "x-preview-f", "muse-spark"]);
    for (const c of classes.cells) {
      expect(c.race, `${c.id} names a race`).toBeDefined();
      expect(c.class, `${c.id} names a class`).toBeDefined();
    }
    // Every campaign model is a real catalog entry.
    for (const c of config.campaigns) {
      if (c.models === "all") continue;
      for (const m of c.models) expect(config.roster[m], `${c.name} names ${m}`).toBeDefined();
    }

    // Manual pool jobs are operator steering; each must be a real roster ref.
    for (const j of poolJobs(config)) expect(config.roster[j.ref]).toBeDefined();
    rosterPolicy(config);

    // With an empty run history every policy model is e90-only, whatever its
    // tier: no tier grants an e360 that has not been earned or declared.
    const states = modelStatesOf(rosterModels(config.roster));
    for (const st of states) {
      expect(st.status).toBe("new");
      expect(st.eligible).toEqual(["e90"]);
    }
    const plan = planTick(config, states, () => undefined, "20260101");
    expect(plan.pinned.map((p) => p.job.name)).toEqual(["nav-probe-coldridge"]);
    /*
     * The cap is what matters, not which bucket spends it. Every claude-code
     * stream counts against `maxConcurrent["claude-code"]` wherever it is
     * scheduled from — the pinned probe, a manual queue job, or the policy.
     */
    const isClaude = (ref: string): boolean => config.roster[ref]?.driver === "claude-code";
    const claudeStreams = [...plan.pinned, ...plan.queue.assign, ...plan.policy].filter((p) => isClaude(p.job.ref));
    expect(claudeStreams.length).toBeLessThanOrEqual(config.maxConcurrent["claude-code"]!);
    expect(claudeStreams.length).toBeGreaterThan(0);
    /*
     * Under the free-key caps (openrouter <= 1, opencode <= 1) the pool does
     * not fill every account: one openrouter free model and one opencode free
     * model take two pool accounts, one claude-code model takes a third, and
     * the rest go idle for want of an uncapped free model — that is the cap
     * working. A paid model lands on SHAKEOUT2 and the local one on RUNNER4;
     * neither ever takes a pool account.
     */
    const freeOnPool = [...plan.queue.assign, ...plan.policy].filter(
      (p) => config.accounts.pool.includes(p.account) && config.roster[p.job.ref]!.driver !== "claude-code",
    );
    expect(freeOnPool).toHaveLength(2);
    const onPool = plan.policy.filter((p) => config.accounts.pool.includes(p.account)).map((p) => p.job.ref);
    expect(onPool).not.toContain("qwen3-8-27b");
    for (const p of plan.policy) {
      const ref = p.job.ref;
      if (rosterClass(rosterModels(config.roster).find((m) => m.name === ref)!) === "local") expect(p.account).toBe("RUNNER4");
    }
  });

});

describe("jobs, pinned and pool (ADR-0034)", () => {
  const nextShape = (over: Record<string, unknown> = {}): unknown => ({
    _notes: ["n"],
    accounts: { pool: ["RUNNER", "RUNNER2", "RUNNER3"] },
    roster: {
      "nav-probe": { tier: "t1", model: "sonnet", driver: "claude-code" },
      glm: { tier: "t1", model: "z-ai/glm-5.2:free" },
      ox: { model: "stealth/ox-alpha", tier: "t2" },
      qwen: { model: "qwen/q", driver: "openai", apiBase: "http://10.0.0.1:1234/v1", apiKeyEnv: "K", tier: "t1" },
    },
    queue: [
      { ref: "nav-probe", episode: "freeplay", account: "SHAKEOUT", repeat: "loop" },
      { ref: "glm", episode: "e90", repeat: "loop" },
      { ref: "ox", episode: "e360", repeat: 2 },
      { ref: "qwen", episode: "e360" },
      { ref: ["glm", "qwen"], episode: "e360" },
    ],
    ...over,
  });

  test("the job shape: a job with an account is pinned, the rest are the pool's", () => {
    const config = parseFleet(nextShape());
    expect(pinnedJobs(config).map((j) => [j.name, j.account])).toEqual([["nav-probe-freeplay", "SHAKEOUT"]]);
    expect(config.accounts.pinned).toEqual({ SHAKEOUT: "nav-probe-freeplay" });
    expect(config.accounts.pool).toEqual(["RUNNER", "RUNNER2", "RUNNER3"]);
    // The tier is the entry's whole budget; idle defaults to none, so no entry
    // buys extra work merely by not mentioning it.
    expect(config.roster["glm"]!.tier).toBe("t1");
    expect(config.roster["glm"]!.idle).toBe("none");
    expect(config.policy).toMatchObject({ promoteAtLevel: 5, paid: null });
    // The series is the checkout's, never the file's.
    expect(config.policy.series).toBe(currentSeries());
    expect(config.maxConcurrent).toEqual({});
    // Names are derived, never authored.
    expect(poolJobs(config).map((j) => j.name)).toEqual(["glm-e90", "ox-e360", "qwen-e360", "glm-e360"]);
    expect(poolJobs(config)[0]).toMatchObject({ refs: ["glm"], ref: "glm", repeat: "loop", enabled: true, source: "queue" });
    expect(poolJobs(config)[2]).toMatchObject({ repeat: 1 });
    expect(poolJobs(config)[3]).toMatchObject({ refs: ["glm", "qwen"], ref: "glm+qwen" });
  });

  test("the job shape: a job with an account is pinned, accounts.pinned is derived, a probe is a campaign", () => {
    const config = parseFleet({
      accounts: { pool: ["RUNNER", "RUNNER2"] },
      roster: {
        son: { tier: "t1", model: "sonnet", driver: "claude-code" },
        glm: { tier: "t1", model: "z-ai/glm-5.2:free" },
      },
      policy: { maxConcurrent: { "claude-code": 2 } },
      campaigns: {
        probe: {
          account: "SHAKEOUT",
          models: ["son"],
          objective: "walk to Ironforge",
          wikiCoords: true,
          watchdogs: { episodeMs: 21_600_000 },
          cells: [{ id: "ironforge" }],
        },
      },
      queue: [{ ref: "glm", episode: "e90", repeat: 2 }],
    });
    expect(config.accounts.pinned).toEqual({ SHAKEOUT: "campaign probe" });
    expect(config.maxConcurrent).toEqual({ "claude-code": 2 });
    expect(config.jobs.map((j) => [j.name, j.source])).toEqual([["glm-e90", "queue"]]);
    // The campaign materialises with its own dimensions over the episode's.
    const job = pinnedCampaignJobs(config, [])[0]!;
    const l = jobSpawn(job, config.roster, "SHAKEOUT", "20260101", undefined, config.campaigns);
    expect(l).toMatchObject({ name: "probe-ironforge", account: "SHAKEOUT" });
    expect(fillEntries(l, "20260101")[0]).toMatchObject({
      runId: "fleet-probe-ironforge-sonnet-20260101",
      objective: "walk to Ironforge",
      wikiCoords: true,
      episode: "probing",
      campaign: "probe",
      cell: "ironforge",
      watchdogs: { episodeMs: 21_600_000, idleMs: 1_200_000, noXpMs: null },
    });
    // Both entries are in the policy: a campaign borrows a model rather than
    // taking it out of the schedule, which is the point of the catalog cut.
    expect([...policyRefs(config)]).toEqual(["son", "glm"]);
    expect(policyExclusion(config, "son")).toBeUndefined();
    // Account rules refuse the PIN and keep the file (item 66); shape errors
    // still take the file down, because there is no losing pin to name.
    const pin = (over: Record<string, unknown>) => ({ accounts: { pool: ["RUNNER"] }, roster: { glm: { tier: "t1", model: "z-ai/glm-5.2:free" }, ox: { tier: "t1", model: "stealth/ox-alpha" } }, ...over });
    const shared = parseFleet(pin({ queue: [{ ref: "glm", episode: "e90", account: "S" }, { ref: "ox", episode: "e90", account: "s" }] }));
    expect(shared.jobs.map((j) => j.enabled)).toEqual([true, false]);
    expect(shared.refusals).toHaveLength(1);
    expect(parseFleet(pin({ queue: [{ ref: "glm", episode: "e90", account: "S" }, { ref: "ox", episode: "e90", account: "s", enabled: false }] })).accounts.pinned).toEqual({ S: "glm-e90" });
    const parked = parseFleet(pin({ queue: [{ ref: "glm", episode: "e90", account: "RUNNER" }] }));
    expect(parked.jobs[0]!.enabled).toBe(false);
    expect(parked.refusals[0]!.why).toMatch(/account RUNNER is in accounts.pool/);
    expect(() => parseFleet(pin({ queue: [{ ref: "glm", episode: "e90" }, { ref: "glm", episode: "e90" }] }))).toThrow(/share the name glm-e90/);
    expect(() => parseFleet(pin({ policy: { maxConcurrent: { warp: 1 } } }))).toThrow(/unknown concurrency key warp/);
    expect(() => parseFleet(pin({ policy: { maxConcurrent: { openai: 0 } } }))).toThrow(/positive integer/);
    // The free-pool lanes are accepted alongside the drivers (ADR-0034 key cap).
    expect(parseFleet(pin({ policy: { maxConcurrent: { "claude-code": 2, openrouter: 1, opencode: 1 } } })).maxConcurrent).toEqual({ "claude-code": 2, openrouter: 1, opencode: 1 });
  });

  test("guards: pool/pinned overlap, bad refs, bad tiers, name collisions", () => {
    // Not a throw since item 66: the pin is refused, the rest of the file loads.
    const overlap = parseFleet(nextShape({ accounts: { pool: ["SHAKEOUT"] } }));
    expect(overlap.jobs.every((j) => !j.enabled || j.account?.toUpperCase() !== "SHAKEOUT")).toBe(true);
    expect(overlap.refusals[0]!.why).toMatch(/account SHAKEOUT is in accounts.pool/);
    expect(() => parseFleet(nextShape({ queue: [{ ref: "nope", episode: "e90" }] }))).toThrow(/ref nope is not in roster/);
    expect(() => parseFleet(nextShape({ queue: [{ ref: "glm", episode: "e9000" }] }))).toThrow(/episode must be one of/);
    expect(() => parseFleet(nextShape({ roster: { glm: { tier: "t1", model: "z-ai/glm-5.2:free", tiers: ["e45"] } }, queue: [] }))).toThrow(/tiers is not a 0.5 key/);
    expect(() => parseFleet(nextShape({ roster: { glm: { tier: "t1", model: "z-ai/glm-5.2:free", account: "RUNNER" } }, queue: [] }))).toThrow(/must not pin an account/);
    expect(() => parseFleet(nextShape({ queue: [{ ref: "glm", episode: "e90" }], accounts: { pool: [] } }))).toThrow(/pool is empty/);
    expect(() => parseFleet(nextShape({ roster: { glm: { tier: "t1", model: "z-ai/glm-5.2:free", runsPerEpisode: { e45: 1 } } }, queue: [] }))).toThrow(/runsPerEpisode is not a 0.5 key/);
    expect(() => parseFleet(nextShape({ roster: { glm: { model: "z-ai/glm-5.2:free" } }, queue: [] }))).toThrow(/every entry states its tier/);
    expect(() => parseFleet(nextShape({ roster: { glm: { tier: "t9", model: "z-ai/glm-5.2:free" } }, queue: [] }))).toThrow(/tier must be one of t0, t1, t2/);
    expect(() => parseFleet(nextShape({ roster: { glm: { tier: "t1", idle: "sometimes", model: "z-ai/glm-5.2:free" } }, queue: [] }))).toThrow(/idle must be one of/);
    // The roster is a catalog: steering cannot enter it at all (ADR-0041), so
    // an objective is refused rather than making the entry a second kind of
    // thing that every scored surface then needs a branch for.
    expect(() => parseFleet(nextShape({ roster: { p: { tier: "t1", model: "sonnet", driver: "claude-code", objective: "ride" } }, queue: [] }))).toThrow(/must not carry an objective/);
    expect(() => parseFleet(nextShape({ roster: { p: { tier: "t1", model: "sonnet", wikiCoords: true } }, queue: [] }))).toThrow(/must not carry wikiCoords/);
    expect(() => parseFleet(nextShape({ policy: { runsPerEpisode: { e90: 3 } } }))).toThrow(/policy.runsPerEpisode is not a 0.5 key/);
    expect(() => parseFleet(nextShape({ policy: { extras: { characters: [] } } }))).toThrow(/policy.extras is not a 0.5 key/);
    expect(() => parseFleet(nextShape({ policy: { paid: { runsPerEpisode: { e90: 3 } } } }))).toThrow(/policy.paid.runsPerEpisode is not a 0.5 key/);
    // What the policy block still carries: where runs execute, and how many.
    expect(parseFleet(nextShape({ policy: { paid: { maxConcurrent: 2 } } })).policy.paid).toEqual({ maxConcurrent: 2 });
    expect(() => parseFleet(nextShape({ queue: [{ ref: "glm", episode: "e90" }, { ref: "glm", episode: "e90" }] }))).toThrow(/share the name/);
    // The roster policy applies to every entry.
    expect(() => parseFleet(nextShape({ roster: { bad: { tier: "t1", model: "sonnet" } }, queue: [] }))).toThrow(/roster policy/);
    // The gate may not borrow a pool account.
    expect(() =>
      parseFleet(nextShape({ preflight: { enabled: true, account: "RUNNER", smokes: ["x.ts"] } })),
    ).toThrow(/also in accounts.pool/);
  });

  const roster: Record<string, FleetRosterEntry> = {
    glm: { model: "z-ai/glm-5.2:free", tier: "t1", idle: "none" },
    ox: { model: "stealth/ox-alpha", tier: "t2", idle: "none" },
    mimo: { model: "mimo-v2.5-free", tier: "t1", idle: "none" },
  };
  const job = (over: Partial<FleetJob> & { ref: string }): FleetJob => ({
    refs: [over.ref],
    episode: "e90",
    repeat: "loop",
    name: `${over.ref}-${over.episode ?? "e90"}`,
    enabled: true,
    source: "queue",
    ...over,
  });
  const base = { roster, pool: ["RUNNER", "RUNNER2"], finished: new Set<string>(), held: () => undefined, cooling: () => undefined };

  test("pool assignment: the next runnable job takes the next FREE account, in queue and pool order", () => {
    const queue = [job({ ref: "glm" }), job({ ref: "ox" }), job({ ref: "mimo" })];
    const plan = planQueue({ ...base, queue, running: new Map() });
    expect(plan.assign.map((a) => [a.job.name, a.account])).toEqual([["glm-e90", "RUNNER"], ["ox-e90", "RUNNER2"]]);
    expect(plan.waiting.map((j) => j.name)).toEqual(["mimo-e90"]);
    // An account a running job holds, or one held live by anything (the
    // roster's account-busy inference), is not free.
    const plan2 = planQueue({ ...base, queue, running: new Map([["glm-e90", "RUNNER"]]), held: (a) => (a === "RUNNER2" ? "hand-run" : undefined) });
    expect(plan2.assign).toEqual([]);
    expect(plan2.waiting.map((j) => j.name)).toEqual(["ox-e90", "mimo-e90"]);
  });

  test("queue drains in order: as accounts come free the next jobs take them; finished jobs are not restarted", () => {
    const queue = [job({ ref: "glm", repeat: 1 }), job({ ref: "ox", repeat: 1 }), job({ ref: "mimo", repeat: 1 })];
    const running = new Map<string, string>();
    const finished = new Set<string>();
    const order: string[] = [];
    // Tick 1: two accounts, two jobs.
    let plan = planQueue({ ...base, queue, running, finished });
    for (const a of plan.assign) {
      running.set(a.job.name, a.account);
      order.push(a.job.name);
    }
    expect(order).toEqual(["glm-e90", "ox-e90"]);
    // glm exits: its account frees, mimo takes it.
    running.delete("glm-e90");
    finished.add("glm-e90");
    plan = planQueue({ ...base, queue, running, finished });
    expect(plan.assign.map((a) => [a.job.name, a.account])).toEqual([["mimo-e90", "RUNNER"]]);
    for (const a of plan.assign) running.set(a.job.name, a.account);
    // Everything running or finished: nothing to do, nothing waiting.
    plan = planQueue({ ...base, queue, running, finished });
    expect(plan.assign).toEqual([]);
    expect(plan.waiting).toEqual([]);
  });

  test("tiers gate: a job whose episode the model is not promoted into is skipped with a reason; freeplay bypasses", () => {
    const queue = [job({ ref: "glm", episode: "e360" }), job({ ref: "ox", episode: "e360" }), job({ ref: "glm", episode: "freeplay" })];
    const plan = planQueue({ ...base, queue, running: new Map() });
    expect(plan.skipped.map((s) => s.job.name)).toEqual(["glm-e360"]);
    expect(plan.skipped[0]!.reason).toMatch(/not eligible for e360/);
    expect(plan.skipped[0]!.reason).toMatch(/level-5 e90/);
    expect(plan.assign.map((a) => a.job.name)).toEqual(["ox-e360", "glm-freeplay"]);
    // A multi-ref job runs with the promoted subset; the gated ref is dropped.
    const pair = job({ ref: "glm", refs: ["glm", "ox"], episode: "e360", name: "pair" });
    expect(runnableRefs(pair, roster)).toEqual(["ox"]);
    expect(jobSpawn(pair, roster, "RUNNER", "20260101").entries.map((e) => e.model)).toEqual(["stealth/ox-alpha"]);
  });

  test("one stream per model: a ref already running under one job is not started under another", () => {
    const queue = [job({ ref: "ox", episode: "e90" }), job({ ref: "ox", episode: "e360" })];
    const plan = planQueue({ ...base, queue, running: new Map([["ox-e90", "RUNNER"]]) });
    expect(plan.skipped.map((s) => s.reason)).toEqual([expect.stringMatching(/already running under another job/)]);
  });

  test("the defer ladder is honoured: a cooling or tainted job does not take an account", () => {
    const queue = [job({ ref: "glm" }), job({ ref: "ox" })];
    const plan = planQueue({ ...base, queue, running: new Map(), cooling: (j) => (j.ref === "glm" ? "glm cooling until 03:00" : undefined) });
    expect(plan.skipped.map((s) => s.job.name)).toEqual(["glm-e90"]);
    expect(plan.assign.map((a) => [a.job.name, a.account])).toEqual([["ox-e90", "RUNNER"]]);
  });

  test("a disabled job is neither assigned nor skipped — it is simply not in the plan", () => {
    const plan = planQueue({ ...base, queue: [job({ ref: "glm", enabled: false })], running: new Map() });
    expect(plan).toEqual({ assign: [], waiting: [], skipped: [] });
  });

  test("a job materialises: episode dimensions fold in, repeat n is n run ids, loop is --loop, tiers never reach the roster", () => {
    const l = jobSpawn(job({ ref: "ox", episode: "e360", repeat: 3, name: "ox-long" }), roster, "RUNNER2", "20260101");
    expect(l).toMatchObject({ name: "ox-long", account: "RUNNER2", loop: false, enabled: true });
    const filled = fillEntries(l, "20260101");
    expect(filled.map((e) => e.runId)).toEqual([
      "fleet-ox-long-ox-alpha-20260101",
      "fleet-ox-long-ox-alpha-20260101-r2",
      "fleet-ox-long-ox-alpha-20260101-r3",
    ]);
    expect(filled[0]).toMatchObject({ episode: "e360", account: "RUNNER2", maxToolCalls: 12000, watchdogs: { episodeMs: 21_600_000, idleMs: 1_200_000, noXpMs: null } });
    expect((filled[0] as unknown as Record<string, unknown>)["tiers"]).toBeUndefined();
    expect(jobArgv(jobSpawn(job({ ref: "ox" }), roster, "RUNNER", "20260101"), { stamp: "20260101", until: undefined })).toContain("--loop");
    expect(jobArgv(l, { stamp: "20260101", until: undefined })).not.toContain("--loop");
    // An entry's own watchdog tightening wins key by key over the tier's.
    const tight = jobSpawn(job({ ref: "glm" }), { glm: { model: "z-ai/glm-5.2:free", tier: "t1", idle: "none", watchdogs: { idleMs: 60_000 } } }, "RUNNER", "20260101");
    expect(tight.entries[0]!.watchdogs).toEqual({ episodeMs: 5_400_000, idleMs: 60_000, noXpMs: 1_200_000 });
  });

  test("episode ids map to today's runner flags until the runner owns --episode", () => {
    expect(episodeDimensions("e90")).toEqual({ episode: "e90", watchdogs: { episodeMs: 5_400_000, idleMs: 1_200_000, noXpMs: 1_200_000 }, maxToolCalls: 3000 });
    expect(episodeDimensions("e360").watchdogs).toEqual({ episodeMs: 21_600_000, idleMs: 1_200_000, noXpMs: null });
    expect(episodeDimensions("freeplay").watchdogs!.episodeMs).toBeNull();
  });

  test("a pinned job and a pool job are the same thing to diffJobs: one set of drain/rearm semantics", () => {
    const config = parseFleet(nextShape());
    const pinned = jobSpawn(pinnedJobs(config)[0]!, config.roster, "SHAKEOUT", "20260101");
    const jobs = poolJobs(config).slice(0, 1).map((j) => jobSpawn(j, config.roster, "RUNNER", "20260101"));
    const sets: JobSets = { running: new Set(), draining: new Set(), finished: new Set() };
    expect(diffJobs([pinned, ...jobs], sets).start.map((l) => [l.name, l.account])).toEqual([["nav-probe-freeplay", "SHAKEOUT"], ["glm-e90", "RUNNER"]]);
    // The pinned job finishes (exit 0): not respawned while enabled, rearmed by disabling.
    sets.finished.add("nav-probe-freeplay");
    expect(diffJobs([pinned, ...jobs], sets).start.map((l) => l.name)).toEqual(["glm-e90"]);
    expect(diffJobs([{ ...pinned, enabled: false }, ...jobs], sets).rearm).toEqual(["nav-probe-freeplay"]);
    // A running job that is disabled drains.
    sets.running.add("glm-e90");
    expect(diffJobs([pinned, { ...jobs[0]!, enabled: false }], sets).drain).toEqual(["glm-e90"]);
  });

  test("--status: the accounts table (pinned first, what runs where, free/cooling) and the queue block", () => {
    const lines = formatAccounts([
      { account: "SHAKEOUT", kind: "pinned", job: { name: "probe-freeplay", models: ["sonnet"], episode: "freeplay", runId: "fleet-probe-freeplay-sonnet-20260101", level: 5, xp: 120, elapsedMs: 3_900_000 } },
      { account: "RUNNER", kind: "pool", job: { name: "glm-e90", models: ["z-ai/glm-5.2:free"], episode: "e90", attempt: 2, runId: "r", cooling: "cooling until 03:00 (429)" } },
      { account: "RUNNER2", kind: "pool", free: true },
      { account: "RUNNER3", kind: "pool", free: true, note: "held by run x — not fleet-managed" },
    ]).join("\n");
    expect(lines).toContain("accounts: 1 pinned, 3 pool");
    expect(lines).toMatch(/SHAKEOUT +pinned +probe-freeplay: sonnet freeplay — fleet-probe-freeplay-sonnet-20260101 — L5 120xp, 1h05m/);
    expect(lines).toMatch(/RUNNER +pool +glm-e90: z-ai\/glm-5.2:free e90 attempt 2 — r — no state rows yet — cooling until 03:00/);
    expect(lines).toMatch(/RUNNER2 +pool +free$/m);
    expect(lines).toMatch(/RUNNER3 +pool +free — held by run x/);
    // The queue block exists only when a manual queue does.
    expect(formatQueue([], undefined)).toEqual([]);
    const config = parseFleet(nextShape());
    const q = formatQueue(poolJobs(config), { depth: 4, running: ["glm-e90"], waiting: ["glm-e360"], finished: [], skipped: [{ name: "qwen-e360", reason: "qwen is not promoted into e360" }] }).join("\n");
    expect(q).toContain("queue: 4 enabled manual job(s) of 4");
    expect(q).toMatch(/glm-e90 .*RUNNING/);
    expect(q).toMatch(/qwen-e360 .*skipped: qwen is not promoted/);
    expect(q).toMatch(/glm-e360 .*waiting/);
  });

  test("a state row's job facts come from the job, and an unknown job says so rather than guessing freeplay", () => {
    const job = {
      refs: ["deepseek-flash"],
      ref: "deepseek-flash",
      episode: "e90" as const,
      repeat: 1,
      name: "deepseek-flash-e90",
      enabled: true,
      source: "policy" as const,
      attempt: 2,
    };
    expect(stateJobFacts("deepseek-flash-e90", job)).toEqual({ ref: "deepseek-flash", episode: "e90", source: "policy", attempt: 2 });
    // No job behind the row (a build that lost it, a spawn nothing claimed):
    // the episode is unknown, and unknown is written, never "freeplay" — a
    // guess here is how an e90 run was read as a freeplay one all morning.
    expect(stateJobFacts("muse-spark-e90", undefined)).toEqual({ ref: "muse-spark-e90", episode: null, source: "pinned" });
    // And --status prints the gap as a gap.
    expect(
      formatAccounts([{ account: "RUNNER5", kind: "pool", job: { name: "muse-spark-e90", models: ["muse-spark-1.2"], episode: null } }]).join("\n"),
    ).toMatch(/RUNNER5 +pool +muse-spark-e90: muse-spark-1.2 episode unknown/);
  });

  test("--status reads the state file's jobs as written; a state without them is nobody's", () => {
    const jobs = {
      "glm-e90": { ref: "glm", episode: "e90" as const, account: "RUNNER", source: "queue" as const, models: ["z-ai/glm-5.2:free"], pid: 2, rosterPath: "", jsonl: "", log: "", spawnedAt: 0, exitCode: null, draining: false, alive: true },
    };
    expect([...liveJobsFromState({ jobs }).entries()]).toEqual([["glm-e90", jobs["glm-e90"]]]);
    expect(liveJobsFromState(undefined).size).toBe(0);
    expect(liveJobsFromState({ jobs: undefined as never }).size).toBe(0);
  });

  test("jobsByAccount: a dead job never masks the live run on its account, however late it was inserted", () => {
    const job = (over: Partial<StateJob> & Pick<StateJob, "account" | "spawnedAt" | "alive">): StateJob => ({
      ref: "x", episode: "e90", source: "policy", models: ["m"], pid: 2, rosterPath: "", jsonl: "", log: "",
      exitCode: null, draining: false, ...over,
    });
    // The shape found on disk 2026-08-24: `hy3-e90` was inserted first and is
    // live; `muse-spark-e90` was inserted later, on the same account, and
    // exited. Last-write-wins over insertion order picked the dead one, so
    // --status named a finished job where --live-runs named the running one.
    const jobs = {
      "hy3-e90": job({ account: "RUNNER2", spawnedAt: 13_15, alive: true }),
      "north-mini-code-e90": job({ account: "RUNNER3", spawnedAt: 12_40, alive: true }),
      "muse-spark-e90": job({ account: "RUNNER2", spawnedAt: 12_30, alive: false, exitCode: 0 }),
      "nemotron-nano-e90": job({ account: "RUNNER3", spawnedAt: 12_00, alive: false, exitCode: 0 }),
    };
    const alive = (j: StateJob): boolean => j.alive;
    const by = jobsByAccount(liveJobsFromState({ jobs }), alive);
    expect(by.get("RUNNER2")?.name).toBe("hy3-e90");
    expect(by.get("RUNNER3")?.name).toBe("north-mini-code-e90");
    // Liveness outranks recency, and must: a job named onto an account by the
    // file (pinned, or a queue entry) is spawned there whatever else holds it,
    // so it can die at 13:30 on top of a run that has been going since 12:40.
    // Newest-wins alone would then report the corpse.
    const stillborn = {
      "north-mini-code-e90": job({ account: "RUNNER3", spawnedAt: 12_40, alive: true }),
      "probe-e90": job({ account: "RUNNER3", spawnedAt: 13_30, alive: false, exitCode: 1 }),
    };
    expect(jobsByAccount(liveJobsFromState({ jobs: stillborn }), alive).get("RUNNER3")?.name).toBe("north-mini-code-e90");
    // Recency only decides among equals in liveness, so an account whose jobs
    // have all exited still reports the last one that ran there, not the first.
    const spent = { a: job({ account: "RUNNER", spawnedAt: 1, alive: false }), b: job({ account: "RUNNER", spawnedAt: 9, alive: false }) };
    expect(jobsByAccount(liveJobsFromState({ jobs: spent }), alive).get("RUNNER")?.name).toBe("b");
    // With the supervisor down every `alive` flag is stale, and the caller says
    // so: the ranking then falls back to recency rather than trusting the flag.
    expect(jobsByAccount(liveJobsFromState({ jobs }), () => false).get("RUNNER2")?.name).toBe("hy3-e90");
    // Two live jobs on one account is a double-lease: named, not resolved.
    const both = { "a-e90": job({ account: "RUNNER", spawnedAt: 1, alive: true }), "b-e90": job({ account: "RUNNER", spawnedAt: 9, alive: true }) };
    const clash = jobsByAccount(liveJobsFromState({ jobs: both }), alive).get("RUNNER");
    expect(clash?.name).toBe("b-e90");
    expect(clash?.clash).toMatch(/also live here: a-e90/);
    // And an operator reading the table sees it.
    expect(
      formatAccounts([{ account: "RUNNER", kind: "pool", job: { name: "b-e90", models: ["m"], episode: "e90", clash: clash!.clash } }]).join("\n"),
    ).toMatch(/!! also live here: a-e90/);
  });

  test("planTick: pinned jobs spawn on their accounts, the queue then the policy fill the pool, per-driver cap counts the pinned stream", () => {
    const config = parseFleet({
      accounts: { pool: ["RUNNER", "RUNNER2", "RUNNER3"] },
      roster: {
        son: { tier: "t1", model: "sonnet", driver: "claude-code" },
        sonlo: { tier: "t1", model: "sonnet", driver: "claude-code", effort: "low" },
        glm: { tier: "t1", model: "z-ai/glm-5.2:free" },
      },
      policy: { maxConcurrent: { "claude-code": 2 } },
      campaigns: { probe: { account: "SHAKEOUT", models: ["son"], objective: "x", cells: [{ id: "c1" }] } },
    });
    const states = modelStatesOf(rosterModels(config.roster));
    const plan = planTick(config, states, () => undefined, "20260101");
    // The campaign's pinned cell shows up HERE, not only in the live loop:
    // `--status` and `--dry-run` read this planner, and a probe the supervisor
    // would spawn but its own report never mentions is the disagreement this
    // whole shape exists to prevent.
    expect(plan.pinned.map((p) => [p.job.name, p.spawn.account])).toEqual([["probe-c1", "SHAKEOUT"]]);
    expect(plan.queue.assign).toEqual([]);
    // The campaign holds `son`, so the second claude-code stream is `sonlo` —
    // and the cap counts the probe's stream wherever it was scheduled from.
    expect(plan.policy.map((p) => [p.job.ref, p.account])).toEqual([["sonlo", "RUNNER"], ["glm", "RUNNER2"]]);
    // Without the cap, the other sonnet goes too.
    const uncapped = planTick({ ...config, maxConcurrent: {} }, states, () => undefined, "20260101");
    expect(uncapped.policy.map((p) => p.job.ref)).toEqual(["sonlo", "glm"]);
    // A disabled campaign does not spawn and does not count against the cap.
    const off = { ...config, campaigns: config.campaigns.map((c) => ({ ...c, enabled: false })) };
    const held = planTick(off, states, (a) => (a === "RUNNER" ? "hand" : undefined), "20260101");
    expect(held.pinned).toEqual([]);
    expect(held.policy.map((p) => [p.job.ref, p.account])).toEqual([["son", "RUNNER2"], ["sonlo", "RUNNER3"]]);
  });

  test("planTick: the openrouter free key caps at one; a paid openrouter model runs beside it (ADR-0034 key cap)", () => {
    const config = parseFleet({
      accounts: { pool: ["RUNNER", "RUNNER2"], paid: ["PAID"] },
      roster: {
        or1: { tier: "t1", model: "a-model:free" },
        or2: { tier: "t1", model: "b-model:free" },
        dsp: { tier: "t1", model: "deepseek/v4-flash", billing: "paid" },
      },
      // openrouter capped at one in flight; paid governed by its own cap.
      policy: { maxConcurrent: { openrouter: 1 }, paid: { maxConcurrent: 1 } },
    });
    const states = modelStatesOf(rosterModels(config.roster), [], 1_800_000_000_000, config.policy);
    const plan = planTick(config, states, () => undefined, "20260101");
    const scheduled = plan.policy.map((p) => p.job.ref);
    // One free OpenRouter model runs, the paid one runs beside it on its paid account.
    expect(scheduled).toContain("dsp");
    expect(plan.policy.find((p) => p.job.ref === "dsp")!.account).toBe("PAID");
    expect(scheduled.filter((r) => r === "or1" || r === "or2")).toHaveLength(1);
    // The second free OpenRouter ref is held on the key cap, not scheduled.
    const heldRef = ["or1", "or2"].find((r) => !scheduled.includes(r))!;
    expect(plan.heldPicks.find((h) => h.name === heldRef)!.why).toMatch(/cap: openrouter <= 1/);
  });

});

// ------------------------------------------------------------ ADR-0032 policy

/** The projection over an in-memory history, so no run directory is needed. */
function modelStatesOf(roster: RosterModel[], runs: RunFact[] = [], now = 1_800_000_000_000, policy?: SchedulingPolicy): ModelState[] {
  return modelStates({ runsDir: "/nonexistent", roster, runs, sidecar: { version: 1, cleared: {} }, now, ...(policy !== undefined ? { policy } : {}) });
}

describe("scheduling policy (ADR-0032)", () => {
  const NOW = 1_800_000_000_000;
  const run = (model: string, episode: EpisodeId, i: number, over: Partial<RunFact> = {}): RunFact => ({
    runId: `${model}-${episode}-${i}`,
    model,
    effort: null,
    episode,
    episodeOverride: false,
    harnessVersion: null,
    harnessSeries: null,
    extra: false,
    startedAt: NOW - (50 - i) * 3_600_000,
    endedAt: NOW - (49 - i) * 3_600_000,
    terminationReason: "episode-limit",
    modelResponses: 20,
    bestLevel: 3,
    live: false,
    pause: null,
    account: null,
    episodeMs: null,
    campaign: null,
    cell: null,
    ...over,
  });
  const roster: Record<string, FleetRosterEntry> = {
    glm: { model: "z-ai/glm-5.2:free", tier: "t1", idle: "none" },
    ox: { model: "stealth/ox-alpha", tier: "t1", idle: "none" },
    mimo: { model: "mimo-v2.5-free", tier: "t1", idle: "none" },
  };
  const job = (over: Partial<FleetJob> & { ref: string }): FleetJob => ({
    refs: [over.ref],
    episode: "e90",
    repeat: 1,
    name: `${over.ref}-${over.episode ?? "e90"}`,
    enabled: true,
    source: "queue",
    ...over,
  });
  const empty = { assign: [], waiting: [], skipped: [] };

  test("e90 is every model's on arrival; e360 is earned by a level-5 e90 run or forced by tiers", () => {
    const states = modelStatesOf(rosterModels(roster), [run("stealth/ox-alpha", "e90", 1, { bestLevel: 5 })]);
    const eligible = eligibleFrom(states);
    expect(eligible("glm", "e90")).toBe(true);
    expect(eligible("glm", "e360")).toBe(false);
    expect(eligible("ox", "e360")).toBe(true);
    expect(eligible("nobody", "freeplay")).toBe(true);
    // The queue's gate reads the same answer.
    const queue = [job({ ref: "glm", episode: "e360" }), job({ ref: "ox", episode: "e360" })];
    const plan = planQueue({ queue, roster, pool: ["RUNNER", "RUNNER2"], running: new Map(), finished: new Set(), held: () => undefined, cooling: () => undefined, eligible });
    expect(plan.assign.map((a) => a.job.name)).toEqual(["ox-e360"]);
    expect(plan.skipped.map((s) => s.job.name)).toEqual(["glm-e360"]);
    // Without the projection, only a forced tier opens e360.
    expect(runnableRefs(job({ ref: "glm", episode: "e360" }), roster)).toEqual([]);
    expect(runnableRefs(job({ ref: "glm", episode: "e360" }), roster, eligibleFrom([{ ...states[0]!, name: "glm", eligible: ["e90", "e360"] }]))).toEqual(["glm"]);
    expect(runnableRefs(job({ ref: "glm" }), roster)).toEqual(["glm"]);
  });

  test("the policy fills the accounts the queue leaves free, never while a manual job waits, never a second stream", () => {
    const states = modelStatesOf(rosterModels(roster));
    // Two accounts, one taken by a manual job: the policy gets the other.
    let picks = planPolicy({ states, pool: ["RUNNER", "RUNNER2"], running: new Map([["glm-e90", "RUNNER"]]), held: () => undefined, queuePlan: empty, runningRefs: new Set(["glm"]) });
    expect(picks.map((p) => [p.job.name, p.account, p.job.attempt])).toEqual([["ox-e90", "RUNNER2", 1]]);
    // A manual job waiting outranks the policy even with accounts free.
    picks = planPolicy({ states, pool: ["RUNNER", "RUNNER2"], running: new Map(), held: () => undefined, queuePlan: { ...empty, waiting: [job({ ref: "mimo" })] }, runningRefs: new Set() });
    expect(picks).toEqual([]);
    // Accounts the queue just assigned this tick, or held live by anything, are not free.
    picks = planPolicy({ states, pool: ["RUNNER", "RUNNER2", "RUNNER3"], running: new Map(), held: (a) => (a === "RUNNER3" ? "hand-run" : undefined), queuePlan: { ...empty, assign: [{ job: job({ ref: "glm" }), account: "RUNNER" }] }, runningRefs: new Set() });
    expect(picks.map((p) => [p.job.ref, p.account])).toEqual([["ox", "RUNNER2"]]);
  });

  test("a waiting manual job reserves the pool only — the paid and local classes still pick, and the reservation is named", () => {
    const raw = {
      accounts: { pool: ["RUNNER"], paid: ["PAID"], local: ["LOCALBOX"] },
      roster: {
        glm: { tier: "t1", model: "z-ai/glm-5.2:free" },
        big: { tier: "t1", model: "vendor/big", apiBase: "https://api.vendor.example/v1", apiKeyEnv: "K" },
        local: { tier: "t1", model: "qwen/q", driver: "openai", apiBase: "http://192.168.1.20:1234/v1", apiKeyEnv: "K", race: 1, class: 2 },
      },
      policy: { paid: {} },
    };
    const config = parseFleet(raw);
    const states = modelStatesOf(rosterModels(config.roster), [], NOW, config.policy);
    const args = {
      states,
      pool: config.accounts.pool,
      classPools: classPoolsOf(config),
      running: new Map<string, string>(),
      held: () => undefined,
      runningRefs: new Set<string>(),
      policy: config.policy,
    };
    // Nothing waiting: every class picks, the pool included.
    const open = planPolicyHeld({ ...args, queuePlan: empty });
    expect(open.picks.map((p) => [p.job.ref, p.account]).sort()).toEqual([
      ["big", "PAID"],
      ["glm", "RUNNER"],
      ["local", "LOCALBOX"],
    ]);
    // A manual job waiting for a pool account must not stop the paid pick or
    // the local box: it could never have run on either. Only `glm` is displaced.
    const held = planPolicyHeld({ ...args, queuePlan: { ...empty, waiting: [job({ ref: "mimo" })] } });
    expect(held.picks.map((p) => [p.job.ref, p.account]).sort()).toEqual([
      ["big", "PAID"],
      ["local", "LOCALBOX"],
    ]);
    // And it says so, rather than dropping the pool pick in silence.
    expect(held.held.map((h) => h.name)).toEqual(["glm"]);
    expect(held.held[0]!.why).toBe("pool reserved for waiting manual job(s): mimo-e90");
  });

  test("a policy job is a one-run job named <ref>-<episode>; attempts after the first suffix the run id", () => {
    const first = policyJob({ name: "ox", episode: "e90", account: "RUNNER", attempt: 1, why: "" });
    expect(first).toMatchObject({ refs: ["ox"], ref: "ox", episode: "e90", repeat: 1, name: "ox-e90", enabled: true, source: "policy", attempt: 1 });
    const l1 = jobSpawn(first, roster, "RUNNER", "20260101");
    expect(fillEntries(l1, "20260101").map((e) => e.runId)).toEqual(["fleet-ox-e90-ox-alpha-20260101"]);
    expect(jobArgv(l1, { stamp: "20260101", until: undefined })).not.toContain("--loop");
    const l3 = jobSpawn(policyJob({ name: "ox", episode: "e360", account: "RUNNER", attempt: 3, why: "" }), roster, "RUNNER", "20260101");
    expect(fillEntries(l3, "20260101")[0]).toMatchObject({ runId: "fleet-ox-e360-ox-alpha-20260101-a3", episode: "e360", maxToolCalls: 12000 });
  });

  test("priority and the ladder flow through: stillborn attempts cool a model, a promoted model gets e360 after the fresh ones", () => {
    const runs = [
      // ox: promoted, e90 target met.
      run("stealth/ox-alpha", "e90", 1, { bestLevel: 5 }),
      run("stealth/ox-alpha", "e90", 2),
      run("stealth/ox-alpha", "e90", 3),
      // glm: one stillborn attempt a minute ago -> cooling rung 1.
      run("z-ai/glm-5.2:free", "e90", 1, { modelResponses: 0, terminationReason: "adapter-error", endedAt: NOW - 30_000 }),
    ];
    const states = modelStatesOf(rosterModels(roster), runs);
    const picks = planPolicy({ states, pool: ["RUNNER", "RUNNER2", "RUNNER3"], running: new Map(), held: () => undefined, queuePlan: empty, runningRefs: new Set() });
    expect(picks.map((p) => [p.job.name, p.account])).toEqual([["mimo-e90", "RUNNER"], ["ox-e360", "RUNNER2"]]);
    const text = formatModels(states, new Set(), NOW).join("\n");
    expect(text).toMatch(/ox +free +t1>t2 +promoted +3\/3 L5 +0\/1 +0 +yes: schedulable on e360/);
    expect(text).toMatch(/glm +free +t1 +cooling +0\/3\+1sb L3 +- +0 +no: cooling rung 1\/9/);
    expect(text).toMatch(/mimo +free +t1 +new +0\/3 +- +0 +yes/);
    expect(text).toContain("billing tier");
    expect(text).toContain("extras schedulable");
    // A pinned or probe entry is outside the policy and says so instead of a verdict.
    expect(formatModels(states, new Set(), NOW, new Map([["ox", "pinned to X by job ox-freeplay"]])).join("\n")).toMatch(/ox +free +t1>t2 +pinned .*no: pinned to X by job ox-freeplay/);
  });

  test("paid and free (ADR-0034 amendment): the paid cap holds a pick and says so; an idle pick is an unlimited session", () => {
    const raw = {
      accounts: { pool: ["RUNNER", "RUNNER2", "RUNNER3"], paid: ["PAID"], local: ["LOCALBOX"] },
      roster: {
        big: { tier: "t1", model: "vendor/big", apiBase: "https://api.vendor.example/v1", apiKeyEnv: "K" },
        bigger: { tier: "t1", model: "vendor/bigger", apiBase: "https://api.vendor.example/v1", apiKeyEnv: "K" },
        glm: { tier: "t1", idle: "unlimited", model: "z-ai/glm-5.2:free" },
        local: { tier: "t1", idle: "unlimited", model: "qwen/q", driver: "openai", apiBase: "http://192.168.1.20:1234/v1", apiKeyEnv: "K", race: 1, class: 2 },
        forced: { tier: "t1", model: "z-ai/other:free", billing: "paid" },
      },
      policy: { paid: {} },
    };
    const config = parseFleet(raw);
    // The paid block is a throttle and nothing else now: no targets in it.
    expect(config.policy.paid).toEqual({ maxConcurrent: 1 });
    expect(rosterModels(config.roster).find((m) => m.name === "forced")!.billing).toBe("paid");
    // glm and local have met every target; local is promoted. big/bigger/forced are paid and new.
    // Stamped with this checkout's series: the policy counts only those (a null series counts everything).
    const runs = [
      ...[1, 2, 3].map((i) => run("z-ai/glm-5.2:free", "e90", i)),
      ...[1, 2, 3].map((i) => run("qwen/q", "e90", i, { bestLevel: 6 })),
      ...[4, 5, 6].map((i) => run("qwen/q", "e360", i)),
      run("qwen/q", "e90", 7, { extra: true, modelResponses: 5 }),
    ].map((r) => ({ ...r, harnessSeries: config.policy.series }));
    const states = modelStatesOf(rosterModels(config.roster), runs, NOW, config.policy);
    const by = Object.fromEntries(states.map((st) => [st.name, st]));
    expect(by["big"]).toMatchObject({ billing: "paid", status: "new", tier: "t1" });
    // t1 buys no e360 until it is earned — the same for paid and free.
    expect(by["big"]!.perEpisode.e360!.target).toBe(0);
    expect(by["glm"]!.billing).toBe("free");
    expect(by["local"]!.perEpisode.e90).toMatchObject({ counted: 3, attempts: 4, extras: 1 });
    const plan = planTick(config, states, () => undefined, "20260101");
    // One paid model (roster order) on the PAID account, then idle sessions for
    // the free ones; bigger and forced are held by the cap. A paid pick never
    // takes a pool account, an idle session never takes a paid one, and the
    // local model's takes the box rather than a pool account. The idle job is
    // named for `freeplay` now: an idle pick is an unlimited session, since the
    // race/class cycle that used to make it a scored e90 extra is a campaign.
    expect(plan.policy.map((p) => [p.job.name, p.account, p.job.extra !== undefined])).toEqual([
      ["big-e90", "PAID", false],
      ["glm-freeplay", "RUNNER", false],
      ["local-freeplay", "LOCALBOX", false],
    ]);
    expect(plan.heldPicks.map((h) => h.name)).toEqual(["bigger", "forced"]);
    // PAID went to `big` in this same round, so the honest reason for `bigger`
    // is the account, named with who has it — the cap is what a SECOND paid
    // account would run into (asserted below).
    expect(formatHeld(plan.heldPicks)[0]).toMatch(/bigger: HELD — e90 wanted, paid account\(s\) busy: PAID held by big/);
    // Both idle picks are unlimited freeplay sessions now: the race/class cycle
    // that used to make them scored e90 extras is a probe campaign (ADR-0041),
    // where an unscored question belongs.
    expect(plan.policy[1]!.job.extra).toBeUndefined();
    expect(plan.policy[2]!.job.extra).toBeUndefined();
    const extraSpawn = jobSpawn(plan.policy[2]!.job, config.roster, "LOCALBOX", "20260101");
    expect(extraSpawn.entries[0]).toMatchObject({ episode: "freeplay" });
    expect((extraSpawn.entries[0] as unknown as Record<string, unknown>)["billing"]).toBeUndefined();
    // A paid model already in flight fills the cap before any pick.
    const paidStates = states.filter((st) => st.billing === "paid");
    const none = planPolicyHeld({ states: paidStates, pool: ["RUNNER"], classPools: { paid: ["PAID"] }, running: new Map(), held: () => undefined, queuePlan: empty, runningRefs: new Set(), policy: config.policy, paidRunning: 1 });
    expect(none.picks).toEqual([]);
    expect(none.held.map((h) => h.name)).toEqual(["big", "bigger", "forced"]);
    // PAID is free here and the cap is what stops them: the cap wording, not
    // the busy one. The two reasons never blur into each other.
    expect(none.held[0]!.why).toBe("paid cap: 1/1 paid model(s) already in flight");
    // The account exists and a live run holds it: "busy", with the holder — the
    // operator has nothing to add to accounts.paid, so we never say they do.
    const heldByRun = planPolicyHeld({
      states: paidStates,
      pool: ["RUNNER"],
      classPools: { paid: ["SHAKEOUT2"] },
      running: new Map(),
      held: (a) => (a === "SHAKEOUT2" ? "fleet-deepseek-flash-e90-20260823-a2" : undefined),
      queuePlan: empty,
      runningRefs: new Set(),
      policy: config.policy,
    });
    expect(heldByRun.picks).toEqual([]);
    expect(heldByRun.held[0]!.why).toBe("paid account(s) busy: SHAKEOUT2 held by fleet-deepseek-flash-e90-20260823-a2");
    // A fleet job on it is named by job when no run id is known yet.
    const heldByJob = planPolicyHeld({
      states: paidStates,
      pool: ["RUNNER"],
      classPools: { paid: ["SHAKEOUT2"] },
      running: new Map([["deepseek-flash-e90", "SHAKEOUT2"]]),
      held: () => undefined,
      queuePlan: empty,
      runningRefs: new Set(),
      policy: config.policy,
    });
    expect(heldByJob.held[0]!.why).toBe("paid account(s) busy: SHAKEOUT2 held by deepseek-flash-e90");
    // Same for the local class, one box and two local models: the second is
    // busy-by-the-first, never "no local account configured".
    const twoLocal = parseFleet({
      ...raw,
      accounts: { pool: ["RUNNER"], local: ["LOCALBOX"] },
      roster: { local: raw.roster.local, local2: { ...raw.roster.local, model: "qwen/q2" } },
      policy: {},
    });
    const twoLocalPlan = planTick(twoLocal, modelStatesOf(rosterModels(twoLocal.roster), [], NOW, twoLocal.policy), () => undefined, "20260101");
    expect(twoLocalPlan.policy.map((p) => [p.job.name, p.account])).toEqual([["local-e90", "LOCALBOX"]]);
    expect(twoLocalPlan.heldPicks.map((h) => [h.name, h.why])).toEqual([["local2", "local account(s) busy: LOCALBOX held by local"]]);
    // policy.paid with no accounts.paid: held for the actionable reason, never
    // spilled into the free pool, and --status says so.
    const noAccount = parseFleet({ ...raw, accounts: { pool: ["RUNNER", "RUNNER2", "RUNNER3"] } });
    expect(classPoolsOf(noAccount).paid).toEqual([]);
    const heldPlan = planTick(noAccount, states, () => undefined, "20260101");
    // No paid account AND no local account: both classes hold, the free pool
    // model still runs, and neither held class spills onto a pool account.
    expect(heldPlan.policy.map((p) => p.job.name)).toEqual(["glm-freeplay"]);
    expect(heldPlan.heldPicks.map((h) => [h.name, h.why])).toEqual([
      ["big", "no paid account configured — add one to accounts.paid"],
      ["bigger", "no paid account configured — add one to accounts.paid"],
      ["forced", "no paid account configured — add one to accounts.paid"],
    ]);
    expect(formatPaidClass(noAccount)[0]).toMatch(/NO PAID ACCOUNT CONFIGURED/);
    expect(formatPaidClass(config)[0]).toMatch(/paid class: PAID — paid models only \(big, bigger, forced\); at most 1 in flight/);
    expect(formatLocalClass(noAccount)[0]).toMatch(/NO LOCAL ACCOUNT CONFIGURED — local held/);
    expect(formatLocalClass(config)[0]).toMatch(/local class: LOCALBOX — local models only \(local\)/);
    // No local model in the roster and no local accounts: the line stays quiet.
    expect(formatLocalClass(parseFleet({ ...raw, accounts: { pool: ["RUNNER"] }, roster: { glm: { tier: "t1", model: "z-ai/glm-5.2:free" } } }))).toEqual([]);
    expect(formatAccountClasses(config)).toEqual([...formatPaidClass(config), ...formatLocalClass(config)]);
    // The row shape: a paid row reads like a pool row, under the same header.
    const acctLines = formatAccounts([
      { account: "RUNNER", kind: "pool", free: true },
      { account: "PAID", kind: "paid", job: { name: "big-e90", models: ["vendor/big"], episode: "e90" } },
      { account: "LOCALBOX", kind: "local", job: { name: "local-e90", models: ["qwen/q"], episode: "e90" } },
    ]);
    expect(acctLines[0]).toBe("accounts: 0 pinned, 1 pool, 1 paid, 1 local");
    expect(acctLines[2]).toMatch(/PAID +paid +big-e90: vendor\/big e90/);
    expect(acctLines[3]).toMatch(/LOCALBOX +local +local-e90: qwen\/q e90/);
    // An account belongs to exactly one class, and the gate keeps its own.
    expect(() => parseFleet({ ...raw, accounts: { pool: ["RUNNER"], paid: ["runner"] } })).toThrow(/already in another class/);
    expect(() => parseFleet({ ...raw, accounts: { pool: ["RUNNER"], paid: ["P"], local: ["p"] } })).toThrow(/accounts.local: p is already in another class/);
    expect(() => parseFleet({ ...raw, accounts: { pool: ["RUNNER"], local: ["L", "l"] } })).toThrow(/accounts.local: l listed twice/);
    expect(() =>
      parseFleet({ ...raw, accounts: { pool: ["RUNNER"], paid: ["SMOKE"] }, preflight: { enabled: true, account: "SMOKE", smokes: ["x.ts"] } }),
    ).toThrow(/also in accounts.paid/);
    expect(() =>
      parseFleet({ ...raw, accounts: { pool: ["RUNNER"], local: ["SMOKE"] }, preflight: { enabled: true, account: "SMOKE", smokes: ["x.ts"] } }),
    ).toThrow(/also in accounts.local/);
    // Coexistence holds for the local class too: only a disabled job may park.
    // Since item 66 the enforcement is a refusal of that job, not of the file.
    const onBox = parseFleet({ ...raw, accounts: { pool: ["RUNNER"], local: ["LOCALBOX"] }, queue: [{ ref: "local", episode: "e90", account: "LOCALBOX" }] });
    expect(onBox.jobs[0]!.enabled).toBe(false);
    expect(onBox.refusals[0]!.why).toMatch(/account LOCALBOX is in accounts.local/);
    // Coexistence: a DISABLED pinned job may park on a listed account, and says
    // nothing; an ENABLED one is disabled on the spot and named.
    const parked = { ...raw, accounts: { pool: ["RUNNER"], paid: ["PAID"] }, queue: [{ ref: "big", episode: "e90", account: "PAID", enabled: false }] };
    expect(parseFleet(parked).accounts.paid).toEqual(["PAID"]);
    expect(parseFleet(parked).refusals).toEqual([]);
    const onPaid = parseFleet({ ...parked, queue: [{ ref: "big", episode: "e90", account: "PAID" }] });
    expect(onPaid.jobs[0]!.enabled).toBe(false);
    expect(onPaid.refusals[0]!.why).toMatch(/account PAID is in accounts.paid/);
    // Without the blocks, today's behaviour: no cap, 3/3 for everyone, no extras.
    const plain = parseFleet({ ...raw, accounts: { pool: ["RUNNER", "RUNNER2", "RUNNER3"] }, policy: {} });
    const plainStates = modelStatesOf(rosterModels(plain.roster), runs, NOW, plain.policy);
    const plainPlan = planTick(plain, plainStates, () => undefined, "20260101");
    // No policy.paid and no accounts.paid — the configuration item 65 was
    // about. The paid class is split ANYWAY, so the paid models are held and
    // named rather than quietly taking a free pool account and billing on it.
    // The pool model still runs: an unconfigured class holds its own picks and
    // nobody else's.
    expect(classPoolsOf(plain).paid).toEqual([]);
    expect(plainPlan.policy.map((p) => [p.job.name, p.account])).toEqual([["glm-freeplay", "RUNNER"]]);
    expect(plainPlan.heldPicks.map((h) => h.name)).toEqual(["big", "bigger", "forced"]);
    for (const h of plainPlan.heldPicks) expect(h.why).toMatch(/no paid account configured/);
    // The local class works the same way, and always did — this is the pair
    // being symmetric now rather than one class having an escape hatch.
    const noBox = parseFleet({ ...raw, accounts: { pool: ["RUNNER", "RUNNER2"] }, roster: { local: raw.roster.local }, policy: {} });
    const noBoxPlan = planTick(noBox, modelStatesOf(rosterModels(noBox.roster), [], NOW, noBox.policy), () => undefined, "20260101");
    expect(noBoxPlan.policy).toEqual([]);
    expect(noBoxPlan.heldPicks.map((h) => [h.name, h.why])).toEqual([["local", "no local account configured — add one to accounts.local"]]);
    expect(() => parseFleet({ ...raw, policy: { paid: { maxConcurrent: -1 } } })).toThrow(/paid.maxConcurrent/);
    expect(() => parseFleet({ ...raw, policy: { extras: { characters: [{ race: 0, class: 1 }] } } })).toThrow(/policy.extras is not a 0.5 key/);
    expect(() => parseFleet({ ...raw, roster: { ...raw.roster, glm: { tier: "t1", model: "z-ai/glm-5.2:free", billing: "cheap" } } })).toThrow(/billing/);
  });

  test("idle: unlimited — the box past its tier gets one 6h freeplay session at a time (ADR-0043)", () => {
    const raw = {
      accounts: { pool: ["RUNNER"], local: ["LOCALBOX"] },
      roster: {
        glm: { tier: "t1", model: "z-ai/glm-5.2:free" },
        local: { tier: "t1", idle: "unlimited", model: "qwen/q", driver: "openai", apiBase: "http://192.168.1.20:1234/v1", apiKeyEnv: "K", character: "Qwenlocal", race: 1, class: 2 },
      },
      policy: {},
    };
    const config = parseFleet(raw);
    expect(config.roster["local"]!.idle).toBe("unlimited");
    expect(() => parseFleet({ ...raw, roster: { ...raw.roster, local: { ...raw.roster.local, idle: "e90" } } })).toThrow(/idle must be one of/);

    // 1/3 counted on e90: the scheduled runs come first, freeplay is not reached.
    const one = [run("qwen/q", "e90", 1)].map((r) => ({ ...r, harnessSeries: config.policy.series }));
    const partial = planTick(config, modelStatesOf(rosterModels(config.roster), one, NOW, config.policy), () => undefined, "20260101");
    expect(partial.policy.find((p) => p.account === "LOCALBOX")!.job).toMatchObject({ name: "local-e90", episode: "e90" });

    // 3/3 and unpromoted (no counted run reached L5): the extra is freeplay.
    const met = [1, 2, 3].map((i) => run("qwen/q", "e90", i, { bestLevel: 3 })).map((r) => ({ ...r, harnessSeries: config.policy.series }));
    const states = modelStatesOf(rosterModels(config.roster), met, NOW, config.policy);
    expect(states.find((st) => st.name === "local")!.eligible).toEqual(["e90"]);
    const plan = planTick(config, states, () => undefined, "20260101");
    const pick = plan.policy.find((p) => p.account === "LOCALBOX")!;
    expect(pick.job).toMatchObject({ name: "local-freeplay", episode: "freeplay", attempt: 1, source: "policy" });
    expect(pick.job.extra).toBeUndefined();
    expect(isExtraJob(pick.job)).toBe(true);
    expect(pick.why).toContain("unlimited session");
    // The spawn: stamped an extra, the entry's own start, and a SIX-HOUR clock
    // the freeplay id does not pin — a session that never ends would hold its
    // account past a series bump and starve the scored targets behind it.
    const spawn = jobSpawn(pick.job, config.roster, "LOCALBOX", "20260101");
    expect(spawn.entries[0]).toMatchObject({
      model: "qwen/q",
      race: 1,
      class: 2,
      extra: true,
      episode: "freeplay",
      watchdogs: { episodeMs: 21_600_000, idleMs: 1_200_000, noXpMs: null },
    });
    expect(spawn.loop).toBe(false);
    expect(jobArgv(spawn, { stamp: "20260101", until: undefined }).join(" ")).toContain("local-freeplay");
    // A manual freeplay job (the nav probe) is not an extra.
    expect(isExtraJob({ episode: "freeplay", attempt: undefined, extra: undefined })).toBe(false);
    // --status shows it as an extra, on the freeplay row and in the extras column.
    expect(formatAccounts([{ account: "LOCALBOX", kind: "local", job: { name: "local-freeplay", models: ["qwen/q"], episode: "freeplay", attempt: 1 } }])[1]).toMatch(
      /LOCALBOX +local +local-freeplay: qwen\/q freeplay extra/,
    );
    const after = [...met, run("qwen/q", "freeplay", 4, { extra: true })].map((r) => ({ ...r, harnessSeries: config.policy.series }));
    const afterStates = modelStatesOf(rosterModels(config.roster), after, NOW, config.policy);
    const line = formatModels(afterStates, new Set(), NOW, new Map(), config.policy).find((l) => l.trimStart().startsWith("local"))!;
    // counted/target on e90, no e360, then the extras column: the freeplay run.
    expect(line).toMatch(/local\s+free\s+t1\s+active\s+3\/3 L3\s+-\s+1\s+free: targets met on e90 — unlimited sessions/);
    expect(formatModels(afterStates, new Set(), NOW, new Map(), config.policy)[0]).toContain("unlimited 6h");
    // The next freeplay run is attempt 2, so its run id cannot collide with the first.
    const next = planTick(config, afterStates, () => undefined, "20260101").policy.find((p) => p.account === "LOCALBOX")!;
    expect(next.job).toMatchObject({ name: "local-freeplay", attempt: 2 });
    expect(jobSpawn(next.job, config.roster, "LOCALBOX", "20260101").entries[0]!.runId).toContain("-a2");
  });
});

describe("pause and resume across a fleet stop (ADR-0036)", () => {
  const NOW = 1_800_000_000_000;
  const H = 3_600_000;
  const roster: Record<string, FleetRosterEntry> = {
    glm: { model: "z-ai/glm-5.2:free", tier: "t1", idle: "none" },
    ox: { model: "stealth/ox-alpha", tier: "t1", idle: "none" },
    nav: { model: "sonnet", driver: "claude-code", tier: "t1", idle: "none" },
  };
  const paused = (over: Partial<RunFact> & { runId: string; model: string; account: string }): RunFact => ({
    effort: null,
    episode: "e90",
    episodeOverride: false,
    harnessVersion: "0.0.0-phase0+gharness-0.3-1-gabc",
    harnessSeries: "0.3",
    extra: false,
    startedAt: NOW - 2 * H,
    endedAt: NOW - H,
    terminationReason: null,
    modelResponses: 30,
    bestLevel: 3,
    live: false,
    pause: { reason: "operator-pause", at: NOW - 5 * 60_000, count: 1, episodeElapsedMs: 41 * 60_000 },
    episodeMs: 90 * 60_000,
    campaign: null,
    cell: null,
    ...over,
  });
  const config = (jobs: FleetJob[] = []): Pick<FleetConfig, "jobs" | "roster" | "policy" | "accounts"> => ({
    jobs,
    roster,
    policy: DEFAULT_POLICY,
    accounts: { pinned: Object.fromEntries(jobs.filter((j) => j.account !== undefined).map((j) => [j.account!, j.name])), pool: ["RUNNER3", "RUNNER4"], paid: [], local: [] },
  });
  const held = (): string | undefined => undefined;

  test("boot: a policy model's paused run resumes on its own account, ahead of the policy, with its run id", () => {
    const run = paused({ runId: "fleet-glm-e90-z-ai-glm-5-2-free-20260823-a2", model: "z-ai/glm-5.2:free", account: "RUNNER4" });
    const plan = planResumes({ runs: [run], config: config(), running: new Map(), held, now: NOW });
    expect(plan.listed).toEqual([]);
    expect(plan.resume).toHaveLength(1);
    const r = plan.resume[0]!;
    expect(r.account).toBe("RUNNER4");
    expect(r.job).toMatchObject({ name: "glm-e90", source: "policy", attempt: 2, resume: { runId: run.runId, model: "z-ai/glm-5.2:free" } });
    expect(r.why).toContain("operator-pause, 41m elapsed of 1h30m");
    // The spawn: the paused run id on the first entry, the roster told to reattach.
    const resumeSpawn = jobSpawn(r.job, roster, "RUNNER4", "20260823");
    expect(resumeSpawn.resumeRunId).toBe(run.runId);
    expect(resumeSpawn.entries[0]?.runId).toBe(run.runId);
    expect(jobArgv(resumeSpawn, { stamp: "20260823", until: undefined })).toContain("--resume-roster");
    // Ordering: the tick's plan gives the resume its account before the queue or the policy can.
    const states = modelStatesOf(rosterModels(roster), [run], NOW);
    const cfg: FleetConfig = { ...config(), notes: [], preflight: DEFAULT_PREFLIGHT, campaigns: [], maxConcurrent: {}, refusals: [] };
    const tick = planTick(cfg, states, held, "20260823", plan.resume);
    expect(tick.policy.map((p) => p.account)).toEqual(["RUNNER3"]);
    expect(tick.policy.map((p) => p.job.ref)).toEqual(["ox"]); // glm is held by its paused run, never rescheduled
  });

  test("a pinned job's paused run replaces the job's spawn with a resume spawn on the pinned account", () => {
    const job: FleetJob = { refs: ["nav"], ref: "nav", episode: "freeplay", repeat: "loop", name: "nav-freeplay", enabled: true, account: "RUNNER", source: "pinned" };
    const run = paused({ runId: "fleet-nav-freeplay-sonnet-20260823", model: "sonnet", account: "RUNNER", episode: "freeplay", episodeMs: null, pause: { reason: "operator-pause", at: NOW - 60_000, count: 1, episodeElapsedMs: 3 * H } });
    const plan = planResumes({ runs: [run], config: config([job]), running: new Map(), held, now: NOW });
    expect(plan.resume.map((r) => [r.job.name, r.account, r.runId])).toEqual([["nav-freeplay", "RUNNER", run.runId]]);
    expect(plan.resume[0]!.why).toContain("3h00m elapsed");
    const pinnedSpawn = jobSpawn(plan.resume[0]!.job, roster, "RUNNER", "20260823");
    expect(pinnedSpawn.loop).toBe(true);
    expect(pinnedSpawn.entries[0]).toMatchObject({ model: "sonnet", runId: run.runId });
    // Disabled: stays paused, listed with the reason.
    const off = planResumes({ runs: [run], config: config([{ ...job, enabled: false }]), running: new Map(), held, now: NOW });
    expect(off.resume).toEqual([]);
    expect(off.listed[0]?.why).toContain("job nav-freeplay is disabled");
  });

  test("not in config: listed for the operator, never resumed, never counted", () => {
    const run = paused({ runId: "fleet-gone-e90-old-model-20260823", model: "gone/model", account: "RUNNER3" });
    const plan = planResumes({ runs: [run], config: config(), running: new Map(), held, now: NOW });
    expect(plan.resume).toEqual([]);
    expect(plan.listed).toHaveLength(1);
    expect(plan.listed[0]!.why).toBe("paused, not in config — resume by hand or archive");
    expect(formatPaused(plan.listed)[1]).toContain("fleet-gone-e90-old-model-20260823 — gone/model on RUNNER3: operator-pause, 41m elapsed of 1h30m");
    // And the account it sits on is free for the policy: a not-in-config run holds nothing.
    const states = modelStatesOf(rosterModels(roster), [run], NOW);
    const cfg: FleetConfig = { ...config(), notes: [], preflight: DEFAULT_PREFLIGHT, campaigns: [], maxConcurrent: {}, refusals: [] };
    expect(planTick(cfg, states, held, "20260823", plan.resume).policy.map((p) => p.account)).toEqual(["RUNNER3", "RUNNER4"]);
  });

  test("a stale pause (older than twice the budget) is listed, not resumed; the model is free again", () => {
    const run = paused({ runId: "fleet-glm-e90-z-ai-glm-5-2-free-20260822", model: "z-ai/glm-5.2:free", account: "RUNNER3", pause: { reason: "operator-pause", at: NOW - 4 * H, count: 1, episodeElapsedMs: 10 * 60_000 } });
    const plan = planResumes({ runs: [run], config: config(), running: new Map(), held, now: NOW });
    expect(plan.resume).toEqual([]);
    expect(plan.listed[0]!.why).toContain("stale: paused 4h00m ago, past twice its 1h30m budget — resume by hand (--resume fleet-glm-e90-z-ai-glm-5-2-free-20260822) or archive");
    const states = modelStatesOf(rosterModels(roster), [run], NOW);
    expect(states.find((s) => s.name === "glm")?.paused).toBeUndefined();
  });

  test("provider pauses resume on the roster's defer ladder by pause count; past the ladder they are listed", () => {
    const base = paused({ runId: "fleet-ox-e90-stealth-ox-alpha-20260823", model: "stealth/ox-alpha", account: "RUNNER3" });
    const at = NOW - 2 * 60_000;
    // First rate-limited pause: 1m rung, already due.
    let plan = planResumes({ runs: [{ ...base, pause: { reason: "rate-limited", at, count: 1, episodeElapsedMs: 0 } }], config: config(), running: new Map(), held, now: NOW });
    expect(plan.resume.map((r) => r.runId)).toEqual([base.runId]);
    expect(plan.resume[0]!.why).toContain("rate-limited, 0m elapsed of 1h30m");
    // Fourth pause: 10m rung, not yet due.
    plan = planResumes({ runs: [{ ...base, pause: { reason: "rate-limited", at, count: 4, episodeElapsedMs: 0 } }], config: config(), running: new Map(), held, now: NOW });
    expect(plan.resume).toEqual([]);
    expect(plan.listed[0]!.why).toContain("rate-limited, pause 4: resuming after");
    expect(resumeNotBefore({ reason: "rate-limited", at, count: 4, episodeElapsedMs: 0 })).toBe(at + 10 * 60_000);
    // Past the ladder: by hand.
    plan = planResumes({ runs: [{ ...base, pause: { reason: "quota-exhausted", at, count: 10, episodeElapsedMs: 0 } }], config: config(), running: new Map(), held, now: NOW });
    expect(plan.listed[0]!.why).toContain("past the defer ladder");
    expect(resumeNotBefore({ reason: "operator-pause", at, count: 10, episodeElapsedMs: 0 })).toBeNull();
  });

  test("a resume waits for its own account — never a different one — and a running job handles its own pause", () => {
    const run = paused({ runId: "fleet-glm-e90-z-ai-glm-5-2-free-20260823", model: "z-ai/glm-5.2:free", account: "RUNNER3" });
    let plan = planResumes({ runs: [run], config: config(), running: new Map([["ox-e90", "RUNNER3"]]), held, now: NOW });
    expect(plan.resume).toEqual([]);
    expect(plan.listed[0]!.why).toBe("waiting: account RUNNER3 is busy (ox-e90)");
    plan = planResumes({ runs: [run], config: config(), running: new Map(), held: (a) => (a === "RUNNER3" ? "run-by-hand" : undefined), now: NOW });
    expect(plan.listed[0]!.why).toBe("waiting: account RUNNER3 is held by run run-by-hand");
    // The job's own roster is running (mid-retry): nothing to do, nothing to list.
    plan = planResumes({ runs: [run], config: config(), running: new Map([["glm-e90", "RUNNER3"]]), held, now: NOW });
    expect(plan).toEqual({ resume: [], listed: [], end: [] });
  });

  test("a paused run whose ref now names another model is ENDED by the supervisor, never resumed or listed", () => {
    // `ox` was re-pointed from stealth/ox-alpha to stealth/ox-beta; the paused ox-alpha run has no job to come back under.
    const repointed = { ...roster, ox: { model: "stealth/ox-beta", tier: "t1", idle: "none" } satisfies FleetRosterEntry };
    const run = paused({ runId: "fleet-ox-e90-ox-alpha-20260823-a2", model: "stealth/ox-alpha", account: "RUNNER3" });
    const plan = planResumes({ runs: [run], config: { ...config(), roster: repointed }, running: new Map(), held, now: NOW });
    expect(plan.resume).toEqual([]);
    expect(plan.listed).toEqual([]);
    expect(plan.end).toEqual([{ runId: run.runId, model: "stealth/ox-alpha", ref: "ox", detail: "ended by the supervisor: model stealth/ox-alpha no longer under ref ox" }]);
    expect(formatEnded(plan.end, false)[1]).toContain("fleet-ox-e90-ox-alpha-20260823-a2 — ended by the supervisor: model stealth/ox-alpha no longer under ref ox");
    // An effort change is a different entry too.
    const lowRun = paused({ runId: "fleet-ox-e90-ox-alpha-20260823", model: "stealth/ox-alpha", account: "RUNNER3" });
    expect(planResumes({ runs: [lowRun], config: { ...config(), roster: { ...roster, ox: { model: "stealth/ox-alpha", effort: "low", tier: "t1", idle: "none" } satisfies FleetRosterEntry } }, running: new Map(), held, now: NOW }).end).toHaveLength(1);
    // The same model under the same ref resumes as before; a run launched outside the fleet (no ref prefix) is not this rule's.
    expect(planResumes({ runs: [run], config: config(), running: new Map(), held, now: NOW }).resume).toHaveLength(1);
    const hand = paused({ runId: "hand-ox-1", model: "stealth/ox-alpha", account: "RUNNER3" });
    expect(planResumes({ runs: [hand], config: { ...config(), roster: repointed }, running: new Map(), held, now: NOW }).end).toEqual([]);
    // The ref is read off the id's prefix; the longest matching ref wins.
    expect(refOfRunId("fleet-ox-e90-ox-alpha-20260823", "e90", ["ox", "o"])).toBe("ox");
    expect(refOfRunId("fleet-ox-long-e90-x-20260823", "e90", ["ox", "ox-long"])).toBe("ox-long");
    expect(refOfRunId("fleet-ox-e360-x-20260823", "e90", ["ox"])).toBeUndefined();
  });

  test("endRuns writes the termination through the runner's own writer: manual, the detail, the pause cleared", () => {
    const runsDir = mkdtempSync(join(tmpdir(), "wrathbench-fleet-end-"));
    const runId = "fleet-ox-e90-ox-alpha-20260823";
    const t = new Trajectory(join(runsDir, runId));
    t.writeMeta({ runId, harnessVersion: "harness-0.4-1-gabc", startedAt: NOW - H, config: loadRunConfig({ runId, driver: "openai", model: "stealth/ox-alpha", account: "RUNNER3" }) });
    t.setPause(runId, "rate-limited", "429", 41 * 60_000);
    t.close();
    const detail = "ended by the supervisor: model stealth/ox-alpha no longer under ref ox";
    expect(endRuns(runsDir, [{ runId, model: "stealth/ox-alpha", ref: "ox", detail }])).toEqual([{ runId }]);
    const after = new Trajectory(join(runsDir, runId));
    const row = after.runRow(runId)!;
    after.close();
    expect(row["termination_reason"]).toBe("manual");
    expect(row["termination_detail"]).toBe(detail);
    expect(row["pause_reason"]).toBeNull();
    expect(typeof row["ended_at"]).toBe("number");
    // A directory that is not there is reported, not thrown.
    expect(endRuns("/nonexistent/runs", [{ runId: "x", model: "m", ref: "r", detail }])[0]!.error).toBeDefined();
  });

  test("withResume puts the paused entry first so a rotation-mate's fresh launch cannot wipe its character", () => {
    const mix: JobSpawn = {
      name: "mix",
      enabled: true,
      account: "RUNNER",
      loop: false,
      entries: [
        { model: "a", runId: "fleet-mix-a-20260823" },
        { model: "b", effort: "low", runId: "fleet-mix-b-low-20260823" },
      ],
    };
    const out = withResume(mix, { runId: "fleet-mix-b-low-20260823", model: "b", effort: "low" });
    expect(out.entries?.map((e) => e.runId)).toEqual(["fleet-mix-b-low-20260823", "fleet-mix-a-20260823"]);
    expect(out.resumeRunId).toBe("fleet-mix-b-low-20260823");
  });
});
