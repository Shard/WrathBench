import { describe, expect, test } from "bun:test";
import {
  DEFAULT_PREFLIGHT,
  bootMarker,
  diffJobs,
  applyPause,
  parsePauseSidecar,
  formatPauseBanner,
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
  concurrencyKeyOfRef,
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
  formatConcurrency,
  jobSpawn,
  planResumes,
  planStaleRuns,
  retryNumbers,
  applyEnded,
  statesAfterSweep,
  failedAttemptsFor,
  formatEndedRun,
  formatPaused,
  formatEnded,
  endRuns,
  refOfRunId,
  resumeNotBefore,
  withResume,
  planQueue,
  planPolicy,
  affinityFrom,
  affinityOf,
  takeAccount,
  planNameSweeps,
  sweepNames,
  charactersFrom,
  characterKey,
  keepFor,
  characterAffinity,
  planContinuations,
  characterStanding,
  describeStanding,
  formatCharacters,
  pausesOnDrain,
  policyJobDropped,
  resumesInPlace,
  policyJob,
  rosterModels,
  eligibleFrom,
  formatModels,
  isExtraJob,
  runnableRefs,
  type FleetJob,
  type FleetRosterEntry,
  type JobSource,
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
  tripsBreaker,
  BREAKER_WINDOW_MS,
  BREAKER_TRIPS,
} from "./run-fleet";
import { billingOf, FREE_SUFFIXLESS_ALLOWLIST } from "../runner/src/model-cost";
import { DEFAULT_POLICY, IDLE_MODES, isOpenCodeGoBase, TIERS, TIER_TABLE, modelStates, planNextJobs, rosterClass, schedulability, type ModelState, type RosterModel, type RunFact, type SchedulingPolicy } from "../runner/src/models";
import type { Campaign } from "../runner/src/campaigns";
import type { EpisodeId } from "../runner/src/episodes";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Trajectory } from "../runner/src/trajectory";
import { loadRunConfig } from "../runner/src/config";
import { ConfigStore, readFleetText } from "../runner/src/config-store";
import { parseCampaigns } from "../runner/src/campaigns";
import { episodeArgv, resolve } from "./run-roster";

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
    roster: { glm: { tier: "t1", model: "z-ai/glm-5.2:free" }, son: { tier: "t1", model: "sonnet", driver: "claude-code" }, ox: { tier: "t1", model: "stealth/ox-alpha:free" } },
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
    expect(jobSpawn(config.jobs[0]!, config.roster, "SHAKEOUT", "20260101").entries[0]!.resumeOnPause).toBe(true);
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
    // the gate runs before anything else does. Where there is not, the loser
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
      "! 1 pin(s) refused by the config rules — the rest of the file IS in effect:",
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
    expect(() => parseFleet(fleetJson([], { roster: { old: { tier: "t1", model: "sonnet", driver: "claude-subscription" } } }))).toThrow(/unknown driver claude-subscription \(openai \| claude-code \| codex\)/);
  });

  test("a roster entry carrying a key the harness does not read is refused BY NAME, not ignored", () => {
    // 2026-08-30. `"enabled": false` was written onto a roster entry to pause a
    // freeplay character; the key is a queue job's, not an entry's, so it was
    // dropped in silence and the deploy's resume brought the character back.
    // An unknown key now refuses the entry and names the pause recipe.
    const config = parseFleet(
      fleetJson([], { roster: { glm: { tier: "t1", model: "z-ai/glm-5.2:free", idle: "unlimited", enabled: false } } }),
    );
    expect(config.refusals.map((r) => r.pin)).toEqual(["roster glm"]);
    expect(config.refusals[0]!.why).toMatch(/unknown key `enabled` on a roster entry/);
    expect(config.refusals[0]!.why).toMatch(/to pause a character set `idle: "none"`/);
    // Refused means scheduled by nothing — and the entry is still in the catalog.
    expect(Object.keys(config.roster)).toEqual(["glm"]);
    expect(policyExclusion(config, "glm")).toMatch(/unknown key/);
    expect([...policyRefs(config)]).toEqual([]);
    // A lane spelling that looks like it would work gets its own alternative.
    const lane = parseFleet(fleetJson([], { roster: { son: { tier: "t1", model: "sonnet", driver: "claude-code", tokenEnv: "CLAUDE_CODE_OAUTH_TOKEN_2" } } }));
    expect(lane.refusals[0]!.why).toMatch(/use `subscription`, the NAME of the env var/);
  });

  // Provider routing (issue #25, operator decision 2026-09-16). Pinned routing
  // is config: an entry may name the backend, the policy may set the fleet's
  // default, and neither may be written where nothing would read it.
  test("a roster entry may name the providers that serve it", () => {
    const config = parseFleet(
      fleetJson([], { roster: { glm: { tier: "t1", model: "z-ai/glm-5.2:free", routing: { order: ["Z.AI", "Together"] } } } }),
    );
    expect(config.refusals).toEqual([]);
    expect(config.roster["glm"]!.routing).toEqual({ order: ["Z.AI", "Together"], allowFallbacks: false });
  });

  test("routing is refused on an endpoint with one backend behind it", () => {
    // Cerebras is a base URL of its own, not an OpenRouter route: a routing
    // block there would be config that does nothing, and the operator who
    // wrote it believed the run was pinned.
    expect(() =>
      parseFleet(
        fleetJson([], {
          roster: {
            qwen: {
              tier: "t0",
              model: "qwen-3.8-27b",
              billing: "paid",
              apiBase: "https://api.cerebras.ai/v1",
              routing: { order: ["Cerebras"] },
            },
          },
        }),
      ),
    ).toThrow(/routing is an OpenRouter setting/);
    expect(() =>
      parseFleet(fleetJson([], { roster: { son: { tier: "t1", model: "sonnet", driver: "claude-code", routing: "Anthropic" } } })),
    ).toThrow(/routing is an OpenRouter setting/);
  });

  test("a malformed routing block takes the file down, like any other shape error", () => {
    expect(() =>
      parseFleet(fleetJson([], { roster: { glm: { tier: "t1", model: "z-ai/glm-5.2:free", routing: { only: ["Z.AI"] } } } })),
    ).toThrow(/routing has unknown key `only`/);
  });

  test("policy.routing is the fleet default, and an entry's own routing wins", () => {
    const config = parseFleet(
      fleetJson([], {
        policy: { routing: { sort: "throughput", allowFallbacks: true } },
        roster: {
          glm: { tier: "t1", model: "z-ai/glm-5.2:free" },
          ox: { tier: "t1", model: "stealth/ox-alpha:free", routing: ["Stealth"] },
          son: { tier: "t1", model: "sonnet", driver: "claude-code" },
        },
      }),
    );
    expect(config.policy.routing).toEqual({ sort: "throughput", allowFallbacks: true });
    expect(config.roster["glm"]!.routing).toEqual({ sort: "throughput", allowFallbacks: true });
    // Stated whole, never merged with the policy's.
    expect(config.roster["ox"]!.routing).toEqual({ order: ["Stealth"], allowFallbacks: false });
    // A CLI entry has no routing to default: it would be refused if it had one.
    expect(config.roster["son"]!.routing).toBeUndefined();
  });

  test("a refused roster entry names its jobs, so a live freeplay run is spared", () => {
    // The 2026-08-24 lesson, carried to the entry: a refusal suppresses
    // SCHEDULING. Without `jobs` the policy job `glm-freeplay` would simply
    // vanish from the diff and the live run would be drained for a typo.
    const config = parseFleet(fleetJson([], { roster: { glm: { tier: "t1", model: "z-ai/glm-5.2:free", nonsense: 1 } } }));
    expect(config.refusals[0]!.jobs).toContain("glm-freeplay");
    const live = { running: new Set(["glm-freeplay"]), draining: new Set<string>(), finished: new Set<string>() };
    const drain = diffJobs([], live).drain;
    expect(drain).toEqual(["glm-freeplay"]);
    const refused = new Set(config.refusals.flatMap((r) => r.jobs));
    expect(drain.filter((n) => !refused.has(n))).toEqual([]);
  });

  test("a queue job carrying an unknown key is refused, and the well-formed jobs are untouched", () => {
    const config = parseFleet(
      fleetJson([{ ref: "glm", episode: "e90", account: "S" }, { ref: "ox", episode: "e90", account: "S2", idle: "none" }]),
    );
    expect(config.jobs.map((j) => [j.name, j.enabled])).toEqual([["glm-e90", true], ["ox-e90", false]]);
    expect(config.refusals.map((r) => [r.pin, r.jobs])).toEqual([["ox-e90", ["ox-e90"]]]);
    expect(config.refusals[0]!.why).toMatch(/unknown key `idle` on a queue job/);
    // And it does not win the account: a job the harness cannot read must not
    // refuse a well-formed one behind it.
    const behind = parseFleet(
      fleetJson([{ ref: "ox", episode: "e90", account: "S", idle: "none" }, { ref: "glm", episode: "e90", account: "S" }]),
    );
    expect(behind.jobs.map((j) => [j.name, j.enabled])).toEqual([["ox-e90", false], ["glm-e90", true]]);
    expect(behind.refusals.map((r) => r.pin)).toEqual(["ox-e90"]);
  });
});

describe("campaigns: probe sweeps as the third lane", () => {
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
    expect(pinnedCampaignJobs(config, [{ campaign: "nav", cell: "coldridge", ref: "son", counted: true }])).toEqual([]);
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
    const second = pinnedCampaignJobs(config, [{ campaign: "nav", cell: "coldridge", ref: "son", counted: true }])[0]!;
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
      character: null,
      episodeMs: null,
      campaign: "probe1",
      cell: "c1",
      subscription: null,
      ...over,
    });
    const matched = fact({});
    const unmatched = fact({ runId: "r2", model: "unknown/model" });
    // A run that never produced a response is not counted — but it IS an
    // attempt, so it comes through carrying `counted: false`. That is what
    // `maxAttemptsPerCell` reads, and filtering it out here is what let a cell
    // that could never produce a counted run be relaunched indefinitely.
    const stillborn = fact({ runId: "r3", modelResponses: 0 });
    expect(probeRunsOf([matched, unmatched, stillborn], roster)).toEqual([
      { campaign: "probe1", cell: "c1", ref: "glm", counted: true },
      { campaign: "probe1", cell: "c1", ref: null, counted: true },
      { campaign: "probe1", cell: "c1", ref: "glm", counted: false },
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

  test("codex entries validate: OpenAI's catalogue only, never a claude id, and a lane may pin them", () => {
    expect(validateEntries("roster:x", [{ model: "gpt-6-astra", driver: "codex", effort: "high" }])).toHaveLength(1);
    expect(() => validateEntries("roster:x", [{ model: "sonnet", driver: "codex" }])).toThrow(/codex driver carries no claude models/);
    // Not a shared free pool: no `:free` suffix demanded of a subscription lane.
    expect(validateEntries("roster:x", [{ model: "gpt-5.5", driver: "codex" }])).toHaveLength(1);
    const config = parseFleet({
      accounts: { pool: ["R"] },
      roster: { astra: { tier: "t1", model: "gpt-6-astra", driver: "codex", subscription: "CODEX_HOME" } },
      policy: { subscriptions: ["CLAUDE_CODE_OAUTH_TOKEN", "CODEX_HOME"] },
    });
    expect(config.roster["astra"]).toMatchObject({ driver: "codex", subscription: "CODEX_HOME" });
    expect(config.refusals).toHaveLength(0);
  });

  test("the respawn breaker trips on repeated short-lived exits inside the window, and only then", () => {
    const NOW = 10_000_000;
    // Two short-lived exits: not a loop yet — a flaky provider gets its retry.
    expect(tripsBreaker([NOW - 120_000, NOW - 60_000], NOW)).toBe(false);
    // Three inside the window: the sonnet-low shape — every 60s tick, forever.
    expect(tripsBreaker([NOW - 180_000, NOW - 120_000, NOW - 60_000], NOW)).toBe(true);
    // Three, but history: exits older than the window never trip it.
    expect(tripsBreaker([NOW - BREAKER_WINDOW_MS - 3, NOW - BREAKER_WINDOW_MS - 2, NOW - BREAKER_WINDOW_MS - 1], NOW)).toBe(false);
    // Exactly at the threshold count, exactly at the window edge: still in.
    expect(tripsBreaker(Array.from({ length: BREAKER_TRIPS }, (_, i) => NOW - BREAKER_WINDOW_MS + i), NOW)).toBe(true);
  });

  test("a roster entry must not carry a character at all — the model names its own", () => {
    // History, and why the refusal is at LOAD. `Fleetsonnetlo` (13 chars)
    // passed the fleet, failed the runner's Zod boundary every launch, and the
    // roster exited 0 — so the policy retried it every tick for two hours
    // (2026-08-24); `Fleetsonnno` (a triple) took the whole file down on
    // 2026-08-25. A name the config does not carry cannot do either.
    const entry = (character: string) => ({
      accounts: { pool: ["RUNNER"] },
      roster: { x: { tier: "t1", model: "sonnet", driver: "claude-code", character } },
      policy: {},
    });
    expect(() => parseFleet(entry("Fleetsonnlo"))).toThrow(/character is not a key/);
    expect(() => parseFleet(entry("Fleetsonnetlo"))).toThrow(/the model names its own character/);
    // A cell may not carry one either, and it is refused by name rather than
    // as a generic unrecognized key.
    expect(() =>
      parseCampaigns({ probe: { cells: [{ id: "coldridge", character: "Navprobe" }] } }),
    ).toThrow(/cell coldridge: character is not a key/);
    expect(() => parseCampaigns({ probe: { character: "Navprobe", cells: [{ id: "coldridge" }] } })).toThrow(
      /campaign probe: character is not a key/,
    );
  });

  test("a suffixless model on a shared free pool is refused unless allowlisted", () => {
    // A paid-looking id with no free suffix on OpenRouter is a roster-policy error.
    expect(() => validateEntries("roster:x", [{ model: "z-ai/glm-5.2" }])).toThrow(/roster policy/);
    // A free suffix is the ordinary way through.
    expect(() => validateEntries("roster:x", [{ model: "z-ai/glm-5.2:free" }])).not.toThrow();
    // The allowlist is the other way through, and it is empty today (the one
    // entry it ever had, a stealth id, started billing) — so no suffixless id
    // gets in on it, and every member of it would.
    expect(FREE_SUFFIXLESS_ALLOWLIST.size).toBe(0);
    expect(isAllowlistedFree("stealth/anything-else")).toBe(false);
    expect(() => validateEntries("roster:x", [{ model: "stealth/anything-else" }])).toThrow(/roster policy/);
    for (const id of FREE_SUFFIXLESS_ALLOWLIST) {
      expect(isAllowlistedFree(id)).toBe(true);
      expect(() => validateEntries("roster:x", [{ model: id }])).not.toThrow();
    }
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

  /*
   * Item 127: the default read is the config-store seam, so an edit made
   * through the app is picked up by the same tick that picks up a file edit —
   * no restart, no second reload path. The scheduling semantics below the
   * seam are untouched, which is what "--status is unchanged for an unchanged
   * config" means: seed a store from a file and the supervisor parses the same
   * config out of either.
   */
  test("the default read prefers a seeded store, and the config is identical to the file's", () => {
    const root = mkdtempSync(join(tmpdir(), "fleet-config-store-"));
    const file = join(root, "fleet.json");
    const db = join(root, "config.sqlite");
    const env = { WRATHBENCH_CONFIG_DB: db };
    writeFileSync(file, JSON.stringify(fleetJson([{ ref: "glm", episode: "e90" }])));

    expect(parseFleet(JSON.parse(readFleetText(file, env)))).toEqual(good);

    const store = new ConfigStore(db);
    store.seedFromFile(file);
    expect(parseFleet(JSON.parse(readFleetText(file, env)))).toEqual(good);
    store.patch("roster/glm", { tier: "t2" }, { actor: "mark" });
    store.close();

    const fromStore = parseFleet(JSON.parse(readFleetText(file, env)));
    expect(fromStore.roster["glm"]!.tier).toBe("t2");
    // The file never moved: it is the seed and the export.
    expect(parseFleet(JSON.parse(readFileSync(file, "utf8"))).roster["glm"]!.tier).toBe("t1");
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
    // The supervisor has no deadline; steering is fleet.json.
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

describe("the pause switch", () => {
  const sets = (over: Partial<JobSets> = {}): JobSets => ({
    running: new Set(),
    draining: new Set(),
    finished: new Set(),
    ...over,
  });

  test("only `paused: true` is a pause; anything else is not, including a half-written file", () => {
    expect(parsePauseSidecar('{"paused":true,"why":"deploy","at":123}')).toEqual({ why: "deploy", at: 123 });
    expect(parsePauseSidecar('{"paused":false,"why":"deploy"}')).toBeUndefined();
    expect(parsePauseSidecar("{}")).toBeUndefined();
    expect(parsePauseSidecar('{"paused":tru')).toBeUndefined();
    expect(parsePauseSidecar("")).toBeUndefined();
    // A pause with no reason still pauses: the switch is the operator's stop
    // button, and a missing string must never make it a no-op.
    const p = parsePauseSidecar('{"paused":true}');
    expect(p?.why).toBe("no reason given");
    expect(typeof p?.at).toBe("number");
  });

  test("paused: nothing starts and everything running drains — the same path as enabled:false", () => {
    const spawns = [spawn({ name: "live" }), spawn({ name: "fresh", account: "B" })];
    const live = sets({ running: new Set(["live"]) });
    // Unpaused: the new job starts and the live one is left alone.
    const before = diffJobs(applyPause(spawns, false), live);
    expect(before.start.map((l) => l.name)).toEqual(["fresh"]);
    expect(before.drain).toEqual([]);
    // Paused: nothing starts, the live one drains (SIGTERM at its episode
    // boundary, which is what makes the update cost no run its attempt).
    const after = diffJobs(applyPause(spawns, true), live);
    expect(after.start).toEqual([]);
    expect(after.drain).toEqual(["live"]);
  });

  test("a resume spawn is suppressed too — it would launch an episode the recreate then kills", () => {
    const resume = spawn({ name: "sonnet-e90", resumeRunId: "fleet-sonnet-e90-20260825" });
    expect(diffJobs(applyPause([resume], false), sets()).start.map((l) => l.name)).toEqual(["sonnet-e90"]);
    expect(diffJobs(applyPause([resume], true), sets()).start).toEqual([]);
  });

  test("clearing the switch before a job drains keeps it running instead of respawning it", () => {
    const spawns = [spawn({ name: "live" })];
    const draining = sets({ running: new Set(["live"]), draining: new Set(["live"]) });
    const a = diffJobs(applyPause(spawns, false), draining);
    expect(a.undrain).toEqual(["live"]);
    expect(a.start).toEqual([]);
  });

  test("applyPause does not mutate its input, and is identity when nothing is paused", () => {
    const spawns = [spawn({ name: "live" })];
    const paused = applyPause(spawns, true);
    expect(spawns[0]!.enabled).toBe(true);
    expect(paused[0]!.enabled).toBe(false);
    expect(applyPause(spawns, false)).toBe(spawns);
  });

  test("the banner separates the switch on disk from the one the supervisor picked up", () => {
    const sw = { why: "supervisor update", at: Date.parse("2026-08-25T18:00:00Z") };
    expect(formatPauseBanner(undefined, undefined)).toEqual([]);
    expect(formatPauseBanner(sw, undefined).join(" ")).toContain("NOT picked it up yet");
    expect(formatPauseBanner(sw, sw).join(" ")).toContain("in effect");
    // The other order: the operator cleared the file and the supervisor has not
    // ticked yet. Saying nothing here would read as "the fleet is scheduling".
    expect(formatPauseBanner(undefined, sw).join(" ")).toContain("still in effect");
  });

  test("a config carrying an unknown top-level key is NOT rejected", () => {
    // Why the switch could have lived in fleet.json: `parseFleet` refuses only
    // the retired keys BY NAME, so the running supervisor ignores what it does
    // not know. It is a sidecar anyway (a typo in fleet.json makes every
    // `enabled` flag inert), but this is the fact that makes either delivery
    // safe against the code that is live right now.
    expect(() => parseFleet(fleetJson([], { paused: true, somethingNew: 1 }))).not.toThrow();
  });

  test("the drain an operator can do TODAY against the running supervisor: empty the account classes", () => {
    // The rollout paradox: the pause switch is supervisor code, so it is not
    // live until the supervisor is recreated. This is the escape — it needs no
    // new code, and it is what the first graceful update uses. Proven against
    // the SHIPPED file rather than a fixture, because that is what the operator
    // will edit.
    const raw = JSON.parse(readFileSync(new URL("./fleet.json", import.meta.url).pathname, "utf8")) as Record<string, unknown>;
    const drained = {
      ...raw,
      accounts: { pool: [], paid: [], local: [] },
      campaigns: Object.fromEntries(
        Object.entries(raw["campaigns"] as Record<string, Record<string, unknown>>).map(([k, v]) => [k, { ...v, enabled: false }]),
      ),
      queue: [],
    };
    // It parses (the empty-pool `fail()` fires only on an enabled pool JOB, and
    // the queue is empty), and the policy has nowhere to put a pick.
    const config = parseFleet(drained);
    expect(config.accounts.pool).toEqual([]);
    expect(pinnedJobs(config).filter((j) => j.enabled)).toEqual([]);
    expect(poolJobs(config).filter((j) => j.enabled)).toEqual([]);
    const states = modelStates({ runsDir: "data/runs", roster: rosterModels(config.roster), policy: config.policy, runs: [] });
    expect(planNextJobs(states, [], new Set(), { policy: config.policy, campaigns: config.campaigns }).jobs).toEqual([]);
  });
});

describe("the shipped fleet files", () => {
  // Durable invariants only. `fleet.json` is the LIVE file: the supervisor
  // hot-reloads it, the operator prunes and adds roster models daily, and
  // `enabled` is a steering knob — none of that may turn the suite red. What
  // is durable: the shape, the pinned accounts, the probe's leash, and the
  // roster policy (claude models only through the claude-code harness, the
  // codex harness on OpenAI ids and a configured lane;
  // shared free pools carry free ids only unless an entry declares
  // `billing: "paid"` on purpose, under the paid policy).
  const rosterPolicy = (config: FleetConfig): void => {
    for (const e of Object.values(config.roster)) {
      const driver = e.driver ?? "openai";
      expect(["openai", "claude-code", "codex"]).toContain(driver);
      if (isClaudeFamily(e.model)) expect(driver).toBe("claude-code");
      if (driver === "claude-code") expect(isClaudeFamily(e.model)).toBe(true);
      // The codex harness is the Codex CLI on a ChatGPT subscription: OpenAI's
      // catalogue only, and a lane it can actually bill.
      if (driver === "codex") {
        expect(isClaudeFamily(e.model)).toBe(false);
        expect(e.subscription === undefined || config.policy.subscriptions.includes(e.subscription)).toBe(true);
      }
      if (driver === "openai" && isSharedFreePool(e.apiBase)) {
        expect(/(-free$|:free$)/.test(e.model) || isAllowlistedFree(e.model) || e.billing === "paid").toBe(true);
      }
    }
  };

  test("fleet.json: the shipped file carries no key the harness would refuse", async () => {
    // The strict-key rule's own safety net. It is a REFUSAL, so a key outside
    // the declared set costs the operator a character rather than the file — and
    // that must never be discovered on a recreate.
    const config = parseFleet((await Bun.file(new URL("./fleet.json", import.meta.url).pathname).json()) as unknown);
    expect(config.refusals).toEqual([]);
  });

  test("fleet.json: the September OpenRouter cohort uses exact ids and the intended account classes", async () => {
    const config = parseFleet((await Bun.file(new URL("./fleet.json", import.meta.url).pathname).json()) as unknown);
    const expected = [
      ["deepseek-v41-flash", "deepseek/deepseek-v4.1-flash", "paid"],
      ["mercury-25", "inception/mercury-2.5", "paid"],
      ["nex-n25-pro", "nex-agi/nex-n2.5-pro:free", "pool"],
      ["nex-n25-mini", "nex-agi/nex-n2.5-mini:free", "pool"],
    ] as const;

    for (const [name, model, accountClass] of expected) {
      const entry = config.roster[name]!;
      expect(entry.model).toBe(model);
      expect(entry.tier).toBe("t0");
      expect(entry.idle).toBe("none");
      expect(rosterClass({ name, ...entry })).toBe(accountClass);
    }
  });

  test("fleet.json: a zen/go entry loads, keys apart from the free zen/v1 lane, and is capped", async () => {
    // The shipped file is edited daily, so this asserts the SHAPE the go
    // surface needs, over whatever entries happen to sit on it today.
    const config = parseFleet((await Bun.file(new URL("./fleet.json", import.meta.url).pathname).json()) as unknown);
    const goNames = Object.entries(config.roster)
      .filter(([, e]) => (e.driver ?? "openai") === "openai" && isOpenCodeGoBase(e.apiBase))
      .map(([n]) => n);
    for (const n of goNames) {
      // Paid by the RULE (no `-free`/`:free` suffix on a metered surface), and
      // that verdict is what puts it under policy.paid.
      const e = config.roster[n]!;
      expect(billingOf({ model: e.model, apiBase: e.apiBase, ...(e.driver !== undefined ? { driver: e.driver } : {}) })).toBe("paid");
      expect(concurrencyKeyOfRef(config.roster, n, "paid")).toBe("opencode-go");
      // Capped, and NOT sharing the free tier's key on the same host.
      expect(config.maxConcurrent["opencode-go"]).toBeGreaterThan(0);
    }
    // The free zen/v1 entries still key on `opencode`.
    for (const [n, e] of Object.entries(config.roster)) {
      if ((e.apiBase ?? "").startsWith("https://opencode.ai/zen/v1")) {
        expect(concurrencyKeyOfRef(config.roster, n, "free")).toBe("opencode");
      }
    }
  });

  test("fleet.json: every model's evidence budget is its tier and its idle axis, and nothing else sets a run count", async () => {
    const NOW = Date.parse("2027-01-15T08:00:00.000Z");
    const raw = (await Bun.file(new URL("./fleet.json", import.meta.url).pathname).json()) as unknown;
    const config = parseFleet(raw);

    /*
     * THE invariant this test exists for: the tier is the evidence budget. It is not a snapshot of
     * the shipped file — the operator retiers models nightly and that must not
     * break CI. It is the one property the refactor bought: how much a model
     * runs is the word `tier` on its entry, full stop. No per-entry override,
     * no per-billing table, no policy target, no queue job standing in for a
     * budget. If any of those come back, this fails and says which.
     */
    for (const [name, e] of Object.entries(config.roster)) {
      // Every entry states exactly one budget, and it is a tier from the code
      // table. There is no steered-entry exception left to make: an
      // entry cannot carry an objective, so it is always in the
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
    // Two paid models fleet-wide at once (raised from 1 on 2026-09-04 so the
    // OpenCode Go surface can run beside another paid model); `opencode-go: 1`
    // below still holds that surface to one of the two.
    expect(config.policy.paid).toEqual({ maxConcurrent: 2 });
    // Three Claude sessions at most, one on the operator's own subscription and
    // up to three on the partner's (67169fd): a run spends both its lane's key
    // and the total, so the total still caps the fleet at three.
    expect(config.maxConcurrent).toEqual({
      "claude-code": 3,
      "claude-code:CLAUDE_CODE_OAUTH_TOKEN": 1,
      "claude-code:CLAUDE_CODE_OAUTH_TOKEN_2": 3,
      // One live Codex session per ChatGPT subscription (2026-09-05).
      codex: 1,
      openrouter: 1,
      opencode: 1,
      // OpenCode Zen's pay-as-you-go zen/go surface, capped apart from the
      // free zen/v1 tier on the same host.
      "opencode-go": 1,
    });
    // CODEX_HOME is a lane too — and LAST, so a claude pick reaches it only
    // once both claude lanes are full, which the caps above forbid.
    expect(config.policy.subscriptions).toEqual(["CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN_2", "CODEX_HOME"]);

    // A trial is one line and one line only: tier t0, and nothing else in the
    // file arranges it — no queue job, no account pin, no billing flip. This is
    // the acceptance test for the whole refactor.
    {
      const name = "deepseek-pro";
      const e = config.roster[name]!;
      expect(e.tier).toBe("t0");
      expect(e.idle).toBe("none");
      expect(poolJobs(config).some((j) => j.refs.includes(name))).toBe(false);
      expect(Object.values(config.accounts.pinned)).not.toContain(`${name}-e90`);
      // A t0 model that plays well keeps its witness without spending it.
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
        character: null,
        episodeMs: null,
        campaign: null,
        cell: null,
        subscription: null,
      };
      const st = modelStatesOf(rosterModels(config.roster), [witness], NOW, config.policy).find((x) => x.name === name)!;
      expect(st.earnedRung1).toBe(true);
      expect(st.tier).toBe("t0");
      expect(st.eligible).toEqual(["e90"]);
      expect(st.status).not.toBe("promoted");
    }

    // deepseek-flash is now on the standard t1 budget: three e90 runs and no
    // e360 until its counted e90 evidence earns the next rung. The shipped
    // entry is the policy; no queue job or account pin supplements it.
    {
      const name = "deepseek-flash";
      const e = config.roster[name]!;
      expect(e.tier).toBe("t1");
      expect(e.idle).toBe("none");
      expect(TIER_TABLE[e.tier].runsPerEpisode).toEqual({ e90: 3, e360: 0 });
      expect(poolJobs(config).some((j) => j.refs.includes(name))).toBe(false);
      expect(Object.values(config.accounts.pinned)).not.toContain(`${name}-e90`);
      // A t1 model that reaches rung 1 is promoted to t2 by its existing
      // witness, rather than needing a re-run after the operator's retier.
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
        character: null,
        episodeMs: null,
        campaign: null,
        cell: null,
        subscription: null,
      };
      const st = modelStatesOf(rosterModels(config.roster), [witness], NOW, config.policy).find((x) => x.name === name)!;
      expect(st.declaredTier).toBe("t1");
      expect(st.earnedRung1).toBe(true);
      expect(st.tier).toBe("t2");
      expect(st.eligible).toEqual(["e90", "e360"]);
      expect(st.status).toBe("promoted");
    }

    // And leaving the trial is the same one line: gpt-luna went to t1 by
    // operator decision on 2026-08-25 (d183fbd). Everything else about it is
    // unchanged, which is the mechanism working rather than an exception to it.
    expect(config.roster["gpt-luna"]!.tier).toBe("t1");
    expect(poolJobs(config).some((j) => j.refs.includes("gpt-luna"))).toBe(false);
    expect(Object.values(config.accounts.pinned)).not.toContain("gpt-luna-e90");

    // Account classes, which billing still governs — and only these.
    expect(config.accounts.pool).toEqual(["RUNNER", "RUNNER2", "RUNNER3", "RUNNER5", "RUNNER6"]);
    expect(config.accounts.paid).toEqual(["SHAKEOUT2", "RUNNER7"]);
    expect(classPoolsOf(config).paid).toEqual(["SHAKEOUT2", "RUNNER7"]);
    expect(config.accounts.local).toEqual(["RUNNER4"]);
    expect(rosterModels(config.roster).filter((r) => rosterClass(r) === "local").map((r) => r.name)).toEqual(["qwen3-8-27b"]);
    // Nothing parks on the paid account any more: a pin there — even a disabled
    // one — is a job waiting to hold SHAKEOUT2 and starve the paid class, so
    // the queue is empty and the policy owns the account outright.
    expect(config.jobs.find((j) => j.account === "SHAKEOUT2")).toBeUndefined();
    // SHAKEOUT is spoken for by the nav-probe CAMPAIGN now, not by a queue job.
    expect(Object.keys(config.accounts.pinned).sort()).toEqual(["SHAKEOUT"]);
    expect(config.accounts.pinned["SHAKEOUT"]).toBe("campaign nav-probe");

    // The roster is a CATALOG: every entry is a model and nothing
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
      // The lane's resume rule travels with the spec: this campaign
      // does not ask to resume, so a pause ends the cell's run and it is swept
      // again. A scored spawn is false the same way; freeplay is true.
      resumeOnPause: false,
      wikiCoords: true,
      maxToolCalls: 2500,
      watchdogs: { episodeMs: 21_600_000, noXpMs: null, idleMs: 1_200_000 },
    });

    // class-probe: the race/class sweep that used to be `idle: "characters"`.
    // Eight cells named in the file rather than a code-side cycle indexed by a
    // counter that meant something else, and unscored where it belongs.
    const classes = config.campaigns.find((c) => c.name === "class-probe")!;
    expect(classes.cells).toHaveLength(8);
    expect(classes.account).toBeUndefined();
    // Item 90 (operator pick 2026-08-29): `nemotron-super` left the sweep so
    // its lane spends idle time on freeplay; the campaign idles on muse-spark
    // until another free lane meets its targets.
    expect(classes.models).toEqual(["muse-spark"]);
    // Item 87: a probe that pauses on a provider rate limit is resumed rather
    // than swept again as a failed attempt, and a cell whose launches keep
    // failing is abandoned instead of swept forever.
    expect(classes.resume).toBe(true);
    expect(classes.maxAttemptsPerCell).toBe(3);
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
     * run counts against its SUBSCRIPTION's key wherever it is scheduled
     * from — the pinned probe, a manual queue job, or the policy — and each
     * subscription inherits `maxConcurrent["claude-code"]`.
     */
    const isClaude = (ref: string): boolean => config.roster[ref]?.driver === "claude-code";
    const claudeRuns = [...plan.pinned, ...plan.queue.assign, ...plan.policy].filter((p) => isClaude(p.job.ref));
    const byLaneAll = claudeRuns.map((p) => p.job.subscription ?? "CLAUDE_CODE_OAUTH_TOKEN");
    expect(claudeRuns.length).toBeGreaterThan(0);
    expect(claudeRuns.length).toBeLessThanOrEqual(config.maxConcurrent["claude-code"]!);
    for (const lane of config.policy.subscriptions) {
      // A lane the file gives no `claude-code:` cap is uncapped, as every key
      // is — the codex lane has no claude sessions to limit.
      const cap = config.maxConcurrent[`claude-code:${lane}`];
      if (cap === undefined) continue;
      const on = byLaneAll.filter((l) => l === lane).length;
      expect(on).toBeLessThanOrEqual(cap);
    }

    /*
     * Under the free-key caps (openrouter <= 1, opencode <= 1) the pool does
     * not fill every account: one openrouter free model and one opencode free
     * model take two pool accounts, one claude-code model takes a third, and
     * the rest go idle for want of an uncapped free model — that is the cap
     * working. A paid model lands on SHAKEOUT2 and the local one on RUNNER4;
     * neither ever takes a pool account.
     *
     * The subscription drivers are counted apart: a claude-code run by its
     * lane keys above, and a codex run by `codex` (1 — one live Codex
     * session per ChatGPT subscription), which is the same shape and not a
     * free pool at all.
     */
    const isSub = (ref: string): boolean => {
      const d = config.roster[ref]!.driver;
      return d === "claude-code" || d === "codex";
    };
    const freeOnPool = [...plan.queue.assign, ...plan.policy].filter((p) => config.accounts.pool.includes(p.account) && !isSub(p.job.ref));
    expect(freeOnPool).toHaveLength(2);
    const codexRuns = [...plan.pinned, ...plan.queue.assign, ...plan.policy].filter((p) => config.roster[p.job.ref]?.driver === "codex");
    expect(codexRuns.length).toBeLessThanOrEqual(config.maxConcurrent["codex"]!);
    const onPool = plan.policy.filter((p) => config.accounts.pool.includes(p.account)).map((p) => p.job.ref);
    expect(onPool).not.toContain("qwen3-8-27b");
    for (const p of plan.policy) {
      const ref = p.job.ref;
      if (rosterClass(rosterModels(config.roster).find((m) => m.name === ref)!) === "local") expect(p.account).toBe("RUNNER4");
    }
  });

});

describe("jobs, pinned and pool: one unit of work over the account classes", () => {
  const nextShape = (over: Record<string, unknown> = {}): unknown => ({
    _notes: ["n"],
    accounts: { pool: ["RUNNER", "RUNNER2", "RUNNER3"] },
    roster: {
      "nav-probe": { tier: "t1", model: "sonnet", driver: "claude-code" },
      glm: { tier: "t1", model: "z-ai/glm-5.2:free" },
      ox: { model: "stealth/ox-alpha:free", tier: "t2" },
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
    const pin = (over: Record<string, unknown>) => ({ accounts: { pool: ["RUNNER"] }, roster: { glm: { tier: "t1", model: "z-ai/glm-5.2:free" }, ox: { tier: "t1", model: "stealth/ox-alpha:free" } }, ...over });
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
    // The free-pool lanes are accepted alongside the drivers (the per-key cap).
    expect(parseFleet(pin({ policy: { maxConcurrent: { "claude-code": 2, openrouter: 1, opencode: 1, "opencode-go": 1 } } })).maxConcurrent).toEqual({ "claude-code": 2, openrouter: 1, opencode: 1, "opencode-go": 1 });
  });

  test("an entry may switch the reference wiki off, and may not then ask for coords", () => {
    // Issue #61 / operator 2026-09-16: `wiki` is a roster-entry key (unlike
    // `wikiCoords`, which belongs to the campaign that asks for it).
    const off = parseFleet(nextShape({ roster: { p: { tier: "t1", model: "sonnet", driver: "claude-code", wiki: false } }, queue: [] }));
    expect(off.roster["p"]!.wiki).toBe(false);
    expect(parseFleet(nextShape({ roster: { p: { tier: "t1", model: "sonnet", driver: "claude-code" } }, queue: [] })).roster["p"]!.wiki).toBeUndefined();
    expect(() =>
      parseFleet(nextShape({ roster: { p: { tier: "t1", model: "sonnet", driver: "claude-code", wiki: "no" } }, queue: [] })),
    ).toThrow(/wiki must be a boolean/);
    // A roster entry cannot carry `wikiCoords` at all (it belongs to a
    // campaign), so the pairing is refused one layer down, where an entry
    // assembled from a campaign's dimensions is validated.
    expect(() => validateEntries("probe", [{ model: "sonnet", driver: "claude-code", wiki: false, wikiCoords: true }])).toThrow(
      /wikiCoords needs the reference wiki/,
    );
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
    // The roster is a catalog: steering cannot enter it at all, so
    // an objective is refused rather than making the entry a second kind of
    // thing that every scored surface then needs a branch for.
    expect(() => parseFleet(nextShape({ roster: { p: { tier: "t1", model: "sonnet", driver: "claude-code", objective: "ride" } }, queue: [] }))).toThrow(/must not carry an objective/);
    expect(() => parseFleet(nextShape({ roster: { p: { tier: "t1", model: "sonnet", wikiCoords: true } }, queue: [] }))).toThrow(/must not carry wikiCoords/);
    // Resuming is the lane's rule: neither an entry, a job nor the
    // policy may claim it, and each says so by name rather than ignoring it.
    expect(() => parseFleet(nextShape({ roster: { p: { tier: "t1", model: "sonnet", resume: true } }, queue: [] }))).toThrow(/must not carry resume/);
    expect(() => parseFleet(nextShape({ queue: [{ ref: "glm", episode: "e90", resume: true }] }))).toThrow(/must not carry resume/);
    expect(() => parseFleet(nextShape({ policy: { resume: true } }))).toThrow(/policy.resume is not a key/);
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
    ox: { model: "stealth/ox-alpha:free", tier: "t2", idle: "none" },
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
    expect(jobSpawn(pair, roster, "RUNNER", "20260101").entries.map((e) => e.model)).toEqual(["stealth/ox-alpha:free"]);
  });

  test("one character per model: a ref already running under one job is not started under another", () => {
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

  test("idle freeplay materializes with only its idle watchdog, not a six-hour episode cap", () => {
    const freeplayRoster = { ...roster, glm: { ...roster.glm!, idle: "unlimited" as const } };
    const freeplay = jobSpawn(job({ ref: "glm", episode: "freeplay", name: "glm-freeplay", attempt: 1 }), freeplayRoster, "RUNNER", "20260101");
    const resolved = resolve(fillEntries(freeplay, "20260101"), "20260101")[0]!;
    expect(resolved.episode).toBe("freeplay");
    expect(resolved.resumeOnPause).toBe(true);
    expect(resolved.watchdogs).toMatchObject({ idleMs: 1_200_000, noXpMs: null, episodeMs: null });
    expect(resolved.episodeMs).toBeNull();
    expect(episodeArgv(resolved, false)).not.toContain("--episode-ms");
  });

  test("episode ids map to today's runner flags until the runner owns --episode", () => {
    expect(episodeDimensions("e90")).toEqual({ episode: "e90", watchdogs: { episodeMs: 5_400_000, idleMs: 1_200_000, noXpMs: 1_200_000 }, maxToolCalls: 3000 });
    expect(episodeDimensions("e360").watchdogs).toEqual({ episodeMs: 21_600_000, idleMs: 1_200_000, noXpMs: null });
    expect(episodeDimensions("freeplay").watchdogs!.episodeMs).toBeNull();
    // Freeplay is the one id with no ceiling of its own to pin: null is "no
    // ceiling", and it is what the policy's unlimited lane materialises with.
    // Probing states nothing — undefined — so a probe keeps the runner's 500
    // unless its campaign or cell names a number.
    expect(episodeDimensions("freeplay").maxToolCalls).toBeNull();
    expect(episodeDimensions("probing").maxToolCalls).toBeUndefined();
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

  test("planTick: pinned jobs spawn on their accounts, the queue then the policy fill the pool, per-driver cap counts the pinned run", () => {
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
    // The campaign holds `son`, so the second claude-code run is `sonlo` —
    // and the cap counts the probe's run wherever it was scheduled from.
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

  test("planTick: the openrouter free key caps at one; a paid openrouter model runs beside it (per-key cap)", () => {
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

  test("planTick: two subscriptions are two lanes — one claude session each, and the third pick is held", () => {
    const base = {
      accounts: { pool: ["RUNNER", "RUNNER2", "RUNNER3"] },
      roster: {
        son: { tier: "t1", model: "sonnet", driver: "claude-code" },
        sonlo: { tier: "t1", model: "sonnet", driver: "claude-code", effort: "low" },
        hai: { tier: "t1", model: "claude-haiku-4-5", driver: "claude-code" },
      },
    };
    // One subscription, one session: today's behaviour, unchanged.
    const one = parseFleet({ ...base, policy: { maxConcurrent: { "claude-code": 1 } } });
    const oneStates = modelStatesOf(rosterModels(one.roster));
    const onePlan = planTick(one, oneStates, () => undefined, "20260101");
    expect(onePlan.policy.map((p) => p.job.ref)).toEqual(["son"]);
    // Nothing is stamped with a lane when there is only one.
    expect(onePlan.policy[0]!.job.subscription).toBeUndefined();
    expect(onePlan.heldPicks.find((h) => h.name === "sonlo")!.why).toMatch(/cap: claude-code <= 1/);

    // Two subscriptions, one session each: two lane keys, and the second lane
    // is named on the job so the spawn bills the right account.
    const two = parseFleet({
      ...base,
      policy: {
        maxConcurrent: { "claude-code": 2, "claude-code:CLAUDE_CODE_OAUTH_TOKEN": 1, "claude-code:CLAUDE_CODE_OAUTH_TOKEN_2": 1 },
        subscriptions: ["CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN_2"],
      },
    });
    const twoStates = modelStatesOf(rosterModels(two.roster));
    const twoPlan = planTick(two, twoStates, () => undefined, "20260101");
    expect(twoPlan.policy.map((p) => [p.job.ref, p.job.subscription])).toEqual([
      ["son", undefined],
      ["sonlo", "CLAUDE_CODE_OAUTH_TOKEN_2"],
    ]);
    // Both subscriptions busy: the third claude pick is held, and the reason
    // names every lane rather than one key.
    expect(twoPlan.heldPicks.find((h) => h.name === "hai")!.why).toMatch(
      /no claude session free \(claude-code:CLAUDE_CODE_OAUTH_TOKEN 1\/1, claude-code:CLAUDE_CODE_OAUTH_TOKEN_2 1\/1\)/,
    );
    // The lane reaches the runner as --token-env, on the claude entry only.
    const spawn = jobSpawn(twoPlan.policy[1]!.job, two.roster, "RUNNER2", "20260101");
    expect(spawn.entries[0]!.tokenEnv).toBe("CLAUDE_CODE_OAUTH_TOKEN_2");
    // The flag AND its value: a wrong lane here bills the wrong subscription
    // and nothing downstream would notice.
    const argv = episodeArgv(resolve([spawn.entries[0]!], "s")[0]!, false);
    expect(argv[argv.indexOf("--token-env") + 1]).toBe("CLAUDE_CODE_OAUTH_TOKEN_2");
    // The default lane emits no flag at all: a pre-lane argv is unchanged.
    const plainSpawn = jobSpawn(twoPlan.policy[0]!.job, two.roster, "RUNNER", "20260101");
    expect(episodeArgv(resolve([plainSpawn.entries[0]!], "s")[0]!, false)).not.toContain("--token-env");

    // A lane with room to spare still yields to the overall ceiling: two
    // sessions on the partner's subscription are allowed, three Claude sessions
    // in total are not, so the third pick is held even though its lane is free.
    const capped = parseFleet({
      ...base,
      policy: {
        maxConcurrent: { "claude-code": 2, "claude-code:CLAUDE_CODE_OAUTH_TOKEN": 1, "claude-code:CLAUDE_CODE_OAUTH_TOKEN_2": 2 },
        subscriptions: ["CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN_2"],
      },
    });
    const cappedPlan = planTick(capped, modelStatesOf(rosterModels(capped.roster)), () => undefined, "20260101");
    expect(cappedPlan.policy.map((p) => p.job.subscription)).toEqual([undefined, "CLAUDE_CODE_OAUTH_TOKEN_2"]);
    // Held on the TOTAL, and the reason says so rather than blaming the lane.
    expect(cappedPlan.heldPicks.find((h) => h.name === "hai")!.why).toMatch(/claude-code 2\/2/);
    // Raise only the total and the spare lane slot becomes reachable.
    const wide = { ...capped, maxConcurrent: { ...capped.maxConcurrent, "claude-code": 3 } };
    const widePlan = planTick(wide, modelStatesOf(rosterModels(wide.roster)), () => undefined, "20260101");
    expect(widePlan.policy.map((p) => p.job.subscription)).toEqual([
      undefined,
      "CLAUDE_CODE_OAUTH_TOKEN_2",
      "CLAUDE_CODE_OAUTH_TOKEN_2",
    ]);
  });

  test("planTick: a live run's own lane is what the count reads, so a restart does not double-book a subscription", () => {
    const config = parseFleet({
      accounts: { pool: ["RUNNER", "RUNNER2"] },
      roster: {
        son: { tier: "t1", model: "sonnet", driver: "claude-code" },
        sonlo: { tier: "t1", model: "sonnet", driver: "claude-code", effort: "low" },
      },
      policy: {
        maxConcurrent: { "claude-code": 2, "claude-code:CLAUDE_CODE_OAUTH_TOKEN": 1, "claude-code:CLAUDE_CODE_OAUTH_TOKEN_2": 1 },
        subscriptions: ["CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN_2"],
      },
    });
    const states = modelStatesOf(rosterModels(config.roster));
    // A fresh supervisor knows nothing but what the runs say: `son` is live on
    // the SECOND subscription, so the next pick must take the first.
    const resumeJob = { refs: ["son"], ref: "son", episode: "e90" as const, repeat: 1 as const, name: "son-e90", enabled: true, source: "policy" as const };
    const plan = planTick(
      config,
      states,
      () => undefined,
      "20260101",
      [{ job: resumeJob, account: "RUNNER", runId: "r1", pauseCount: 1, why: "resumed" }],
      [],
      undefined,
      new Map([["son", "CLAUDE_CODE_OAUTH_TOKEN_2"]]),
    );
    expect(plan.policy.map((p) => [p.job.ref, p.job.subscription])).toEqual([["sonlo", undefined]]);
    // Without the recorded lane the live run reads as the default one, and the
    // fresh pick is pushed onto the second — the same one-session-each rule.
    const blind = planTick(config, states, () => undefined, "20260101", [{ job: resumeJob, account: "RUNNER", runId: "r1", pauseCount: 1, why: "resumed" }]);
    expect(blind.policy.map((p) => p.job.subscription)).toEqual(["CLAUDE_CODE_OAUTH_TOKEN_2"]);
  });

  test("a queue job may pin a subscription, and refuses a token in place of the name", () => {
    const config = parseFleet({
      accounts: { pool: ["RUNNER"] },
      roster: { son: { tier: "t1", model: "sonnet", driver: "claude-code" } },
      queue: [{ ref: "son", episode: "e90", subscription: "CLAUDE_CODE_OAUTH_TOKEN_2" }],
    });
    expect(config.jobs[0]!.subscription).toBe("CLAUDE_CODE_OAUTH_TOKEN_2");
    expect(jobSpawn(config.jobs[0]!, config.roster, "RUNNER", "s").entries[0]!.tokenEnv).toBe("CLAUDE_CODE_OAUTH_TOKEN_2");
    expect(() =>
      parseFleet({
        accounts: { pool: ["RUNNER"] },
        roster: { son: { tier: "t1", model: "sonnet", driver: "claude-code" } },
        queue: [{ ref: "son", episode: "e90", subscription: "sk-ant-oat01-not-a-name" }],
      }),
    ).toThrow(/never the token/);
  });

  test("a roster entry may pin its subscription: it always bills that one, and is held when that one is busy", () => {
    const config = parseFleet({
      accounts: { pool: ["RUNNER", "RUNNER2", "RUNNER3"] },
      roster: {
        son: { tier: "t1", model: "sonnet", driver: "claude-code" },
        pinned1: { tier: "t1", model: "claude-opus-4-8", driver: "claude-code", subscription: "CLAUDE_CODE_OAUTH_TOKEN_2" },
        pinned2: { tier: "t1", model: "claude-opus-4-6", driver: "claude-code", subscription: "CLAUDE_CODE_OAUTH_TOKEN_2" },
      },
      policy: {
        maxConcurrent: { "claude-code": 2, "claude-code:CLAUDE_CODE_OAUTH_TOKEN": 1, "claude-code:CLAUDE_CODE_OAUTH_TOKEN_2": 1 },
        subscriptions: ["CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN_2"],
      },
    });
    const plan = planTick(config, modelStatesOf(rosterModels(config.roster)), () => undefined, "20260101");
    // The unpinned entry takes the free (default) lane; the first pinned entry
    // takes the one it named; the second is HELD rather than moved.
    expect(plan.policy.map((p) => [p.job.ref, p.job.subscription])).toEqual([
      ["son", undefined],
      ["pinned1", "CLAUDE_CODE_OAUTH_TOKEN_2"],
    ]);
    expect(plan.heldPicks.find((h) => h.name === "pinned2")!.why).toMatch(/pinned to this subscription/);
    // The lane reaches the runner even though nothing scheduled it here.
    expect(jobSpawn(plan.policy[1]!.job, config.roster, "RUNNER2", "s").entries[0]!.tokenEnv).toBe("CLAUDE_CODE_OAUTH_TOKEN_2");
  });

  test("an entry pinned to a subscription the file does not configure is refused — the entry, not the file", () => {
    const config = parseFleet({
      accounts: { pool: ["RUNNER"] },
      roster: {
        son: { tier: "t1", model: "sonnet", driver: "claude-code" },
        stray: { tier: "t1", model: "opus", driver: "claude-code", subscription: "CLAUDE_CODE_OAUTH_TOKEN_9" },
      },
    });
    // The rest of the file is in force.
    expect(Object.keys(config.roster).sort()).toEqual(["son", "stray"]);
    expect(config.refusals.map((r) => r.pin)).toEqual(["roster stray"]);
    expect(config.refusals[0]!.why).toMatch(/not in policy.subscriptions/);
    // And nothing schedules it: no pin survives, and the policy skips it.
    expect(config.roster["stray"]!.subscription).toBeUndefined();
    expect([...policyRefs(config)]).toEqual(["son"]);
    expect(policyExclusion(config, "stray")).toMatch(/not in policy.subscriptions/);
    const plan = planTick(config, modelStatesOf(rosterModels(config.roster)), () => undefined, "20260101");
    expect(plan.policy.map((p) => p.job.ref)).toEqual(["son"]);
    // The two shape errors are still the file's: a token where a name goes,
    // and a lane on a driver that has no subscription to bill.
    expect(() =>
      parseFleet({ accounts: { pool: ["R"] }, roster: { a: { tier: "t1", model: "opus", driver: "claude-code", subscription: "sk-ant-oat01-x" } } }),
    ).toThrow(/never the token/);
    expect(() =>
      parseFleet({ accounts: { pool: ["R"] }, roster: { a: { tier: "t1", model: "x:free", subscription: "CLAUDE_CODE_OAUTH_TOKEN_2" } } }),
    ).toThrow(/only an entry on those drivers bills a subscription/);
  });

  test("the concurrency line names the lanes only when there is more than one", () => {
    const max = { "claude-code": 1, openrouter: 1 };
    expect(formatConcurrency(max, { subscriptions: ["CLAUDE_CODE_OAUTH_TOKEN"] })).toBe(
      "concurrency: claude-code <= 1, openrouter <= 1 (every run on the key counts)",
    );
    const two = formatConcurrency({ ...max, "claude-code:CLAUDE_CODE_OAUTH_TOKEN_2": 2 }, {
      subscriptions: ["CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN_2"],
    })!;
    expect(two).toContain("claude-code:CLAUDE_CODE_OAUTH_TOKEN_2 <= 2");
    expect(two).toContain("2 subscriptions: CLAUDE_CODE_OAUTH_TOKEN, CLAUDE_CODE_OAUTH_TOKEN_2");
    expect(two).toContain("room on its own lane AND under claude-code");
    expect(formatConcurrency({}, { subscriptions: ["CLAUDE_CODE_OAUTH_TOKEN"] })).toBeUndefined();
  });

});

// ------------------------------------------------------ scheduling policy

/** The projection over an in-memory history, so no run directory is needed. */
function modelStatesOf(roster: RosterModel[], runs: RunFact[] = [], now = 1_800_000_000_000, policy?: SchedulingPolicy): ModelState[] {
  return modelStates({ runsDir: "/nonexistent", roster, runs, sidecar: { version: 1, cleared: {} }, now, ...(policy !== undefined ? { policy } : {}) });
}

describe("scheduling policy: defer ladder and retirement", () => {
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
    character: null,
    episodeMs: null,
    campaign: null,
    cell: null,
    subscription: null,
    ...over,
  });
  const roster: Record<string, FleetRosterEntry> = {
    glm: { model: "z-ai/glm-5.2:free", tier: "t1", idle: "none" },
    ox: { model: "stealth/ox-alpha:free", tier: "t1", idle: "none" },
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
    const states = modelStatesOf(rosterModels(roster), [run("stealth/ox-alpha:free", "e90", 1, { bestLevel: 5 })]);
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

  test("the policy fills the accounts the queue leaves free, never while a manual job waits, never a second run", () => {
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
      run("stealth/ox-alpha:free", "e90", 1, { bestLevel: 5 }),
      run("stealth/ox-alpha:free", "e90", 2),
      run("stealth/ox-alpha:free", "e90", 3),
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

  test("paid and free account classes: the paid cap holds a pick and says so; an idle pick is an unlimited session", () => {
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
    // that used to make them scored e90 extras is a probe campaign,
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

  test("paid cap 2: two paid models run at once and a third is held; the go surface still takes only one of them", () => {
    // The cap the shipped file carries since 2026-09-04. It is a global spend
    // posture, not a per-surface exemption: any two paid models may hold the
    // two slots, and `opencode-go: 1` is what keeps the OpenCode Go endpoint to
    // one of them. Two paid accounts, because the cap can only be the gate
    // under test when the account class is not the narrower one.
    const raw = {
      // THREE paid accounts and two slots: with only two, the third pick is
      // held on the account (that check is the more actionable one and comes
      // first), and the cap would never be the thing under test.
      accounts: { pool: ["RUNNER"], paid: ["PAID1", "PAID2", "PAID3"], local: [] },
      roster: {
        go: { tier: "t1", model: "omen-alpha", apiBase: "https://opencode.ai/zen/go/v1", apiKeyEnv: "OPENCODE_KEY", billing: "paid" },
        p1: { tier: "t1", model: "vendor/one", apiBase: "https://api.vendor.example/v1", apiKeyEnv: "K" },
        p2: { tier: "t1", model: "vendor/two", apiBase: "https://api.vendor.example/v1", apiKeyEnv: "K" },
      },
      policy: { maxConcurrent: { "opencode-go": 1 }, paid: { maxConcurrent: 2 } },
    };
    const config = parseFleet(raw);
    expect(config.policy.paid).toEqual({ maxConcurrent: 2 });
    const states = modelStatesOf(rosterModels(config.roster), [], NOW, config.policy);
    for (const st of states) expect(st.billing).toBe("paid");
    const plan = planTick(config, states, () => undefined, "20260101");
    // The go entry runs BESIDE another paid model — the thing the cap of 1
    // made impossible — and the third paid pick is refused by the cap, which
    // is what says this is a cap of 2 and not a cap removed.
    expect(plan.policy.map((p) => [p.job.name, p.account])).toEqual([
      ["go-e90", "PAID1"],
      ["p1-e90", "PAID2"],
    ]);
    expect(plan.heldPicks.find((h) => h.name === "p2")!.why).toBe("paid cap: 2/2 paid model(s) already in flight");
    // A second go run is still refused, by its own key and not the cap:
    // the budget is fleet-wide, the surface is bounded on its own.
    const twoGo = parseFleet({
      ...raw,
      roster: { go: raw.roster.go, go2: { ...raw.roster.go, model: "omen-beta" } },
    });
    const goPlan = planTick(twoGo, modelStatesOf(rosterModels(twoGo.roster), [], NOW, twoGo.policy), () => undefined, "20260101");
    expect(goPlan.policy.map((p) => p.job.name)).toEqual(["go-e90"]);
    expect(goPlan.heldPicks.find((h) => h.name === "go2")!.why).toMatch(/cap: opencode-go <= 1, 1 in flight/);
  });

  test("idle: unlimited — the box past its tier gets one continuous freeplay session at a time", () => {
    const raw = {
      accounts: { pool: ["RUNNER"], local: ["LOCALBOX"] },
      roster: {
        glm: { tier: "t1", model: "z-ai/glm-5.2:free" },
        local: { tier: "t1", idle: "unlimited", model: "qwen/q", driver: "openai", apiBase: "http://192.168.1.20:1234/v1", apiKeyEnv: "K", race: 1, class: 2 },
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
    // The spawn: stamped an extra and the entry's own start. Freeplay has no
    // episode wall clock, so the character/session continues until idle.
    const spawn = jobSpawn(pick.job, config.roster, "LOCALBOX", "20260101");
    expect(spawn.entries[0]).toMatchObject({
      model: "qwen/q",
      race: 1,
      class: 2,
      extra: true,
      episode: "freeplay",
      watchdogs: { episodeMs: null, idleMs: 1_200_000, noXpMs: null },
    });
    // And no tool-call ceiling either. A session with no wall clock cannot be
    // held to a guard sized for ninety minutes: four of the six historical
    // sub-opus-low freeplay runs ended `tool-call-limit` at 500 and the fleet
    // rolled a fresh level-1 character each time.
    expect(spawn.entries[0]!.maxToolCalls).toBeNull();
    const freshArgv = episodeArgv(resolve(fillEntries(spawn, "20260101"), "20260101")[0]!, false);
    // 0 is the argv spelling of "no ceiling"; run.ts normalises it to null.
    expect(freshArgv[freshArgv.indexOf("--max-tool-calls") + 1]).toBe("0");
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
    expect(formatModels(afterStates, new Set(), NOW, new Map(), config.policy)[0]).toContain("idle unlimited (idle watchdog only; no wall clock)");
    // The next freeplay run is attempt 2, so its run id cannot collide with the first.
    const next = planTick(config, afterStates, () => undefined, "20260101").policy.find((p) => p.account === "LOCALBOX")!;
    expect(next.job).toMatchObject({ name: "local-freeplay", attempt: 2 });
    expect(jobSpawn(next.job, config.roster, "LOCALBOX", "20260101").entries[0]!.runId).toContain("-a2");
  });
});

describe("pause and resume across a fleet stop", () => {
  const NOW = 1_800_000_000_000;
  const H = 3_600_000;
  const roster: Record<string, FleetRosterEntry> = {
    glm: { model: "z-ai/glm-5.2:free", tier: "t1", idle: "none" },
    ox: { model: "stealth/ox-alpha:free", tier: "t1", idle: "none" },
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
    character: null,
    episodeMs: 90 * 60_000,
    campaign: null,
    cell: null,
    subscription: null,
    ...over,
  });
  const config = (jobs: FleetJob[] = []): Pick<FleetConfig, "jobs" | "roster" | "policy" | "accounts"> => ({
    jobs,
    roster,
    policy: DEFAULT_POLICY,
    accounts: { pinned: Object.fromEntries(jobs.filter((j) => j.account !== undefined).map((j) => [j.account!, j.name])), pool: ["RUNNER3", "RUNNER4"], paid: [], local: [] },
  });
  const held = (): string | undefined => undefined;

  test("boot: a policy model's paused e90 run is ended as a failed attempt, never resumed", () => {
    const run = paused({ runId: "fleet-glm-e90-z-ai-glm-5-2-free-20260823-a2", model: "z-ai/glm-5.2:free", account: "RUNNER4", pause: { reason: "quota-exhausted", at: NOW - 5 * 60_000, count: 1, episodeElapsedMs: 41 * 60_000 } });
    const plan = planResumes({ runs: [run], config: config(), running: new Map(), held, now: NOW });
    expect(plan.resume).toEqual([]);
    expect(plan.listed).toEqual([]);
    expect(plan.end).toHaveLength(1);
    expect(plan.end[0]).toMatchObject({ runId: run.runId, episode: "e90", reason: "attempt-failed", counts: true, account: "RUNNER4" });
    expect(formatEndedRun(plan.end[0]!, 2)).toBe(
      "failed attempt: quota-exhausted: not resumed — a scored run that pauses is a failed attempt, retry 2/3",
    );
    // A sweep after an outage numbers the batch it is about to write, not the
    // projection it read before writing any of it: three failures of one model
    // in one tick read 1/3, 2/3, 3/3 — tainted — and not "retry 1/3" thrice.
    const batch = [plan.end[0]!, { ...plan.end[0]!, runId: "b" }, { ...plan.end[0]!, runId: "c" }];
    expect(retryNumbers(batch, () => 0)).toEqual([1, 2, 3]);
    expect(formatEndedRun(batch[2]!, 3)).toContain("retry 3/3 — tainted");
    // An operator-pause in the middle spends an attempt without advancing the count.
    expect(retryNumbers([batch[0]!, { ...batch[1]!, reason: "manual", counts: false }, batch[2]!], () => 0)).toEqual([1, 2, 2]);
    // An operator-pause is the harness's own doing: the attempt is spent, the model is not blamed.
    const stopped = planResumes({ runs: [{ ...run, pause: { reason: "operator-pause", at: NOW - 5 * 60_000, count: 1, episodeElapsedMs: 41 * 60_000 } }], config: config(), running: new Map(), held, now: NOW });
    expect(stopped.end[0]).toMatchObject({ reason: "manual", counts: false });
    // The tick still holds the model this pass — the pause fact is only gone
    // once the termination is written — and gives it a fresh attempt after.
    const states = modelStatesOf(rosterModels(roster), [run], NOW);
    const cfg: FleetConfig = { ...config(), notes: [], preflight: DEFAULT_PREFLIGHT, campaigns: [], maxConcurrent: {}, refusals: [] };
    const tick = planTick(cfg, states, held, "20260823", plan.resume);
    expect(tick.policy.map((p) => p.job.ref)).toEqual(["ox", "nav"]); // glm is held by its paused run for one more tick
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

  test("a policy freeplay run paused by a fleet restart resumes under a synthetic policy job — same account, same run id", () => {
    // 2026-08-25 live: fleet-sub-opus-low-freeplay-opus-low-20260825-a6 was
    // operator-paused by a forced fleet restart, listed as "not in config",
    // and the policy then launched a7/a8 on fresh characters — the whole point
    // of an unlimited session lost to a restart.
    const idleRoster: Record<string, FleetRosterEntry> = {
      ...roster,
      "sub-opus-low": { model: "opus", effort: "low", driver: "claude-code", tier: "t1", idle: "unlimited" },
    };
    const cfg = { ...config(), roster: idleRoster };
    const run = paused({
      runId: "fleet-sub-opus-low-freeplay-opus-low-20260825-a6",
      model: "opus",
      effort: "low",
      account: "RUNNER3",
      episode: "freeplay",
      episodeMs: null,
      pause: { reason: "operator-pause", at: NOW - 60_000, count: 1, episodeElapsedMs: 9 * H },
    });
    const plan = planResumes({ runs: [run], config: cfg, running: new Map(), held, now: NOW });
    expect(plan.end).toEqual([]);
    expect(plan.listed).toEqual([]);
    expect(plan.resume.map((r) => [r.job.name, r.job.source, r.job.attempt, r.account, r.runId])).toEqual([
      ["sub-opus-low-freeplay", "policy", 6, "RUNNER3", run.runId],
    ]);
    // The spawn reattaches that exact run, and freeplay keeps its no-wall-clock leash.
    const spawn = jobSpawn(plan.resume[0]!.job, idleRoster, "RUNNER3", "20260827");
    expect(spawn.resumeRunId).toBe(run.runId);
    expect(spawn.entries[0]).toMatchObject({ model: "opus", effort: "low", runId: run.runId, episode: "freeplay" });
    expect(jobArgv(spawn, { stamp: "20260827", until: undefined })).toContain("--resume-roster");
    const resolved = resolve(fillEntries(spawn, "20260827"), "20260827")[0]!;
    // What the roster actually execs for that entry: --resume, that run id, and
    // nothing that could re-impose a wall clock on it.
    const resumeArgv = episodeArgv(resolved, true);
    expect(resumeArgv.slice(1, 3)).toEqual(["--resume", run.runId]);
    expect(resumeArgv).not.toContain("--episode-ms");
    // And the leash is restated, or a run stored before the cap came off would
    // come back under its stored six hours: run.ts keeps meta.json's watchdogs
    // unless a flag overrides them, which is how the live a6 needed a hand.
    expect(JSON.parse(resumeArgv[resumeArgv.indexOf("--watchdogs-json") + 1]!)).toEqual({
      idleMs: 1_200_000,
      noXpMs: null,
      episodeMs: null,
    });
    // The tool-call ceiling is restated the same way and for the same reason:
    // a6 was stored with `maxToolCallsPerEpisode: 500` and had reached 410 of
    // it, so a resume that said nothing would have brought the run back under
    // the ceiling that has been resetting this lane all along.
    expect(resumeArgv[resumeArgv.indexOf("--max-tool-calls") + 1]).toBe("0");
    // Identity is still never restated — it comes back from meta.json.
    for (const identity of ["--model", "--driver", "--effort", "--account", "--race", "--class", "--episode", "--run-id"]) {
      expect(resumeArgv).not.toContain(identity);
    }
    // And the leash itself is off, so a relaunch of the same entry is unbounded too.
    expect(resolved.episodeMs).toBeNull();
    expect(resolved.watchdogs.episodeMs).toBeNull();
    expect(resolved.maxToolCalls).toBeNull();
    expect(episodeArgv(resolved, false)).not.toContain("--episode-ms");
    // Fail-closed still: a ref whose idle lane is off owes no freeplay session.
    const noIdle = { ...idleRoster, "sub-opus-low": { ...idleRoster["sub-opus-low"]!, idle: "none" as const } };
    const off = planResumes({ runs: [run], config: { ...cfg, roster: noIdle }, running: new Map(), held, now: NOW });
    expect(off.resume).toEqual([]);
    expect(off.listed[0]!.why).toBe("paused, not in config — resume by hand or archive");
  });

  test("the uncapped ceiling is the policy's unlimited lane only — an arbitrary freeplay job keeps the runner's default", () => {
    // The narrow contract. Removing the ceiling is a claim about the one
    // continuous session the policy grants an `idle: "unlimited"` ref, not
    // about the id: a hand-written freeplay experiment states its own leash
    // and inherits the runner's 500 when it states none, exactly as before.
    const mixed: Record<string, FleetRosterEntry> = {
      ...roster,
      "sub-opus-low": { model: "opus", effort: "low", driver: "claude-code", tier: "t1", idle: "unlimited" },
      "probe-opus": { model: "opus", effort: "high", driver: "claude-code", tier: "t1", idle: "none" },
      "capped-opus": { model: "opus", effort: "medium", driver: "claude-code", tier: "t1", idle: "none", maxToolCalls: 2500 },
      "idle-capped": { model: "opus", effort: "xhigh", driver: "claude-code", tier: "t1", idle: "unlimited", maxToolCalls: 1234 },
    };
    const freeplayJob = (ref: string, source: JobSource = "policy") => ({
      name: `${ref}-freeplay`,
      ref,
      refs: [ref],
      episode: "freeplay" as const,
      repeat: 1 as const,
      enabled: true,
      source,
      ...(source === "policy" ? { attempt: 1 } : {}),
    });
    // The unlimited lane: no ceiling, and the argv says so explicitly.
    const lane = jobSpawn(freeplayJob("sub-opus-low"), mixed, "RUNNER3", "20260827");
    expect(lane.entries[0]!.maxToolCalls).toBeNull();
    // But the lane is the POLICY's session, not a property of the ref. A
    // freeplay job written in the fleet file that happens to name the same
    // idle-capable ref is an operator's own experiment: it is not the one
    // continuous session the policy grants, so it keeps the runner's 500 and
    // its argv says nothing about a ceiling.
    for (const source of ["pinned", "queue"] as const) {
      const manual = jobSpawn(freeplayJob("sub-opus-low", source), mixed, "RUNNER3", "20260827");
      expect(manual.entries[0]!.maxToolCalls).toBeUndefined();
      const manualArgv = episodeArgv(resolve(fillEntries(manual, "20260827"), "20260827")[0]!, false);
      expect(manualArgv).not.toContain("--max-tool-calls");
      expect(manualArgv).not.toContain("0");
    }
    // A freeplay ref that is NOT in the unlimited lane: the flag is omitted
    // entirely, so run.ts applies its own 500 default.
    const arbitrary = jobSpawn(freeplayJob("probe-opus"), mixed, "RUNNER3", "20260827");
    expect(arbitrary.entries[0]!.maxToolCalls).toBeUndefined();
    expect(episodeArgv(resolve(fillEntries(arbitrary, "20260827"), "20260827")[0]!, false)).not.toContain("--max-tool-calls");
    // A numeric override on the entry is still a number, and still wins.
    const capped = jobSpawn(freeplayJob("capped-opus"), mixed, "RUNNER3", "20260827");
    expect(capped.entries[0]!.maxToolCalls).toBe(2500);
    const cappedArgv = episodeArgv(resolve(fillEntries(capped, "20260827"), "20260827")[0]!, false);
    expect(cappedArgv[cappedArgv.indexOf("--max-tool-calls") + 1]).toBe("2500");
    // An entry that names a number wins on both sides of the gate: the policy
    // session honours it (the tier's null is a default, not an override), and
    // so does a hand-written job on the same ref.
    expect(jobSpawn(freeplayJob("idle-capped"), mixed, "RUNNER3", "20260827").entries[0]!.maxToolCalls).toBe(1234);
    expect(jobSpawn(freeplayJob("idle-capped", "pinned"), mixed, "RUNNER3", "20260827").entries[0]!.maxToolCalls).toBe(1234);
  });

  test("a configured job for a SIBLING ref never captures a run launched under another — the run id is the authority on both paths", () => {
    // The authority rule was only enforced on the synthetic-policy path. Before
    // it, `fromFile` scanned every configured job for one whose refs intersect
    // *any* roster ref sharing the run's model+effort+episode — so a run
    // launched under ref A could be picked up by a pinned or queue job written
    // for ref B, taking B's job name, lane, account and credentials with it.
    // The run id names the ref; nothing else may overrule it.
    const twoRefs: Record<string, FleetRosterEntry> = {
      ...roster,
      "sub-opus-low": { model: "opus", effort: "low", driver: "claude-code", tier: "t1", idle: "unlimited" },
      "alt-opus-low": { model: "opus", effort: "low", driver: "claude-code", tier: "t1", idle: "none" },
    };
    // The decoy: a freeplay job in the file for whichever ref the run was NOT
    // launched under, on its own pinned account.
    const decoy = (ref: string, source: JobSource, account?: string): FleetJob => ({
      refs: [ref],
      ref,
      episode: "freeplay",
      repeat: 1,
      name: `${ref}-freeplay`,
      enabled: true,
      source,
      ...(account !== undefined ? { account } : {}),
    });
    const runUnder = (ref: string): RunFact =>
      paused({
        runId: `fleet-${ref}-freeplay-opus-low-20260825-a6`,
        model: "opus",
        effort: "low",
        account: "RUNNER3",
        episode: "freeplay",
        episodeMs: null,
        pause: { reason: "operator-pause", at: NOW - 60_000, count: 1, episodeElapsedMs: 9 * H },
      });

    for (const source of ["pinned", "queue"] as const) {
      const acct = source === "pinned" ? "RUNNER4" : undefined;

      // A: run launched under the unlimited ref, decoy job in the file for the
      // OTHER ref. The decoy is ignored outright; the run comes back under ITS
      // OWN synthetic policy job, its own account and its own run id — not the
      // decoy's name, and not the decoy's pinned account.
      const a = planResumes({
        runs: [runUnder("sub-opus-low")],
        config: { ...config([decoy("alt-opus-low", source, acct)]), roster: twoRefs },
        running: new Map(),
        held,
        now: NOW,
      });
      expect(a.end).toEqual([]);
      expect(a.listed).toEqual([]);
      expect(a.resume.map((r) => [r.job.name, r.job.ref, r.job.source, r.account, r.runId])).toEqual([
        ["sub-opus-low-freeplay", "sub-opus-low", "policy", "RUNNER3", "fleet-sub-opus-low-freeplay-opus-low-20260825-a6"],
      ]);

      // A': mirrored. The run was launched under the ref whose idle lane is
      // off and which has no job in the file; the decoy is for the unlimited
      // ref. It owes no freeplay session, so it is LISTED — never resumed
      // under the sibling's job just because that sibling is configured.
      const off = planResumes({
        runs: [runUnder("alt-opus-low")],
        config: { ...config([decoy("sub-opus-low", source, acct)]), roster: twoRefs },
        running: new Map(),
        held,
        now: NOW,
      });
      expect(off.resume).toEqual([]);
      expect(off.end).toEqual([]);
      expect(off.listed.map((l) => l.why)).toEqual(["paused, not in config — resume by hand or archive"]);
    }

    // And the rule does not break a rotation job that genuinely lists the
    // authoritative ref: one job over both refs still claims the run.
    const rotation: FleetJob = {
      refs: ["alt-opus-low", "sub-opus-low"],
      ref: "alt-opus-low",
      episode: "freeplay",
      repeat: 1,
      name: "rotation-freeplay",
      enabled: true,
      source: "queue",
    };
    const rot = planResumes({
      runs: [runUnder("sub-opus-low")],
      config: { ...config([rotation]), roster: twoRefs },
      running: new Map(),
      held,
      now: NOW,
    });
    expect(rot.resume.map((r) => [r.job.name, r.account])).toEqual([["rotation-freeplay", "RUNNER3"]]);
  });

  test("the ref a paused run id names is the authority, not the first roster entry sharing its model and effort", () => {
    // Two entries, one model and effort, different idle lanes. Matching by
    // model+effort would resume a run launched under the `none` ref as if it
    // were the `unlimited` one — a session continued under a ref that owes no
    // session, on a job name that is not the one it was launched as.
    const twoRefs: Record<string, FleetRosterEntry> = {
      ...roster,
      "sub-opus-low": { model: "opus", effort: "low", driver: "claude-code", tier: "t1", idle: "unlimited" },
      "alt-opus-low": { model: "opus", effort: "low", driver: "claude-code", tier: "t1", idle: "none" },
    };
    const cfg = { ...config(), roster: twoRefs };
    const freeplayRun = (ref: string): RunFact =>
      paused({
        runId: `fleet-${ref}-freeplay-opus-low-20260825-a6`,
        model: "opus",
        effort: "low",
        account: "RUNNER3",
        episode: "freeplay",
        episodeMs: null,
        pause: { reason: "operator-pause", at: NOW - 60_000, count: 1, episodeElapsedMs: 9 * H },
      });
    // Launched under the `none` ref: listed, never resumed under the other one.
    const wrongLane = planResumes({ runs: [freeplayRun("alt-opus-low")], config: cfg, running: new Map(), held, now: NOW });
    expect(wrongLane.resume).toEqual([]);
    expect(wrongLane.end).toEqual([]);
    expect(wrongLane.listed.map((l) => l.why)).toEqual(["paused, not in config — resume by hand or archive"]);
    // Launched under the `unlimited` ref: resumed under that ref's own job name.
    const rightLane = planResumes({ runs: [freeplayRun("sub-opus-low")], config: cfg, running: new Map(), held, now: NOW });
    expect(rightLane.resume.map((r) => [r.job.ref, r.job.name])).toEqual([["sub-opus-low", "sub-opus-low-freeplay"]]);
    // A run id no ref matches has no authority to read: model+effort is the fallback.
    const unnamed = { ...freeplayRun("sub-opus-low"), runId: "fleet-gone-freeplay-opus-low-20260825-a2" };
    const byModel = planResumes({ runs: [unnamed], config: cfg, running: new Map(), held, now: NOW });
    expect(byModel.resume.map((r) => [r.job.ref, r.job.attempt, r.runId])).toEqual([["sub-opus-low", 2, unnamed.runId]]);
  });

  test("a hand-launched paused run is the operator's: listed, never ended by the supervisor", () => {
    const run = paused({ runId: "roster-old-model-20260823", model: "gone/model", account: "RUNNER3" });
    const plan = planResumes({ runs: [run], config: config(), running: new Map(), held, now: NOW });
    expect(plan.resume).toEqual([]);
    expect(plan.end).toEqual([]);
    expect(plan.listed).toHaveLength(1);
    expect(plan.listed[0]!.why).toContain("hand-launched, so the supervisor leaves it");
    // A fleet run of a model the file no longer names is still the fleet's to end.
    const mine = paused({ runId: "fleet-gone-e90-old-model-20260823", model: "gone/model", account: "RUNNER3" });
    expect(planResumes({ runs: [mine], config: config(), running: new Map(), held, now: NOW }).end).toHaveLength(1);
    // And the account it sits on is free for the policy: a not-in-config run holds nothing.
    const states = modelStatesOf(rosterModels(roster), [run], NOW);
    const cfg: FleetConfig = { ...config(), notes: [], preflight: DEFAULT_PREFLIGHT, campaigns: [], maxConcurrent: {}, refusals: [] };
    expect(planTick(cfg, states, held, "20260823", plan.resume).policy.map((p) => p.account)).toEqual(["RUNNER3", "RUNNER4"]);
  });

  test("a stale run — the host slept, the fleet was down — is ended, not resumed", () => {
    const run = paused({ runId: "fleet-glm-e90-z-ai-glm-5-2-free-20260822", model: "z-ai/glm-5.2:free", account: "RUNNER3", pause: { reason: "operator-pause", at: NOW - 4 * H, count: 1, episodeElapsedMs: 10 * 60_000 } });
    const plan = planResumes({ runs: [run], config: config(), running: new Map(), held, now: NOW });
    expect(plan.resume).toEqual([]);
    expect(plan.listed).toEqual([]);
    // An offline gap is the harness's weather: ended `stale`, never counted.
    expect(plan.end[0]).toMatchObject({ reason: "stale", counts: false });
    expect(plan.end[0]!.detail).toContain("no activity for 4h00m");
    // Waiting on its provider when the lights went out: the model's problem after all.
    const onQuota = planResumes({ runs: [{ ...run, pause: { reason: "quota-exhausted", at: NOW - 4 * H, count: 1, episodeElapsedMs: 10 * 60_000 } }], config: config(), running: new Map(), held, now: NOW });
    expect(onQuota.end[0]).toMatchObject({ reason: "attempt-failed", counts: true });
    const states = modelStatesOf(rosterModels(roster), [run], NOW);
    expect(states.find((s) => s.name === "glm")?.paused).toBeUndefined();
    // A run with no pause record at all — the machine died under it — is the same case.
    const dead = { ...run, runId: "fleet-ox-e90-stealth-ox-alpha-20260822", model: "stealth/ox-alpha:free", pause: null, endedAt: NOW - 4 * H };
    const staleRuns = planStaleRuns({ runs: [dead], refs: Object.keys(roster), now: NOW });
    expect(staleRuns).toHaveLength(1);
    expect(staleRuns[0]).toMatchObject({ reason: "stale", counts: false, ref: "ox" });
    // Not while a live job holds its account.
    expect(planStaleRuns({ runs: [dead], busyAccounts: new Set(["RUNNER3"]), now: NOW })).toEqual([]);
  });

  test("provider pauses resume on the defer ladder — for the lanes that resume at all", () => {
    // The ladder is unchanged; what changed is who rides it. A
    // freeplay run under a pinned job still comes back on it.
    const job: FleetJob = { refs: ["nav"], ref: "nav", episode: "freeplay", repeat: "loop", name: "nav-freeplay", enabled: true, account: "RUNNER", source: "pinned" };
    const base = paused({ runId: "fleet-nav-freeplay-sonnet-20260823", model: "sonnet", account: "RUNNER", episode: "freeplay", episodeMs: null });
    const at = NOW - 2 * 60_000;
    // First rate-limited pause: 1m rung, already due.
    let plan = planResumes({ runs: [{ ...base, pause: { reason: "rate-limited", at, count: 1, episodeElapsedMs: 0 } }], config: config([job]), running: new Map(), held, now: NOW });
    expect(plan.resume.map((r) => r.runId)).toEqual([base.runId]);
    // Fourth pause: 10m rung, not yet due.
    plan = planResumes({ runs: [{ ...base, pause: { reason: "rate-limited", at, count: 4, episodeElapsedMs: 0 } }], config: config([job]), running: new Map(), held, now: NOW });
    expect(plan.resume).toEqual([]);
    expect(plan.listed[0]!.why).toContain("rate-limited, pause 4: resuming after");
    expect(resumeNotBefore({ reason: "rate-limited", at, count: 4, episodeElapsedMs: 0 })).toBe(at + 10 * 60_000);
    // Past the ladder: by hand.
    plan = planResumes({ runs: [{ ...base, pause: { reason: "quota-exhausted", at, count: 10, episodeElapsedMs: 0 } }], config: config([job]), running: new Map(), held, now: NOW });
    expect(plan.listed[0]!.why).toContain("past the defer ladder");
    expect(resumeNotBefore({ reason: "operator-pause", at, count: 10, episodeElapsedMs: 0 })).toBeNull();
    // A scored run never reaches the ladder at all: it is a failed attempt on the first pause.
    const eval90 = paused({ runId: "fleet-ox-e90-stealth-ox-alpha-20260823", model: "stealth/ox-alpha:free", account: "RUNNER3", pause: { reason: "rate-limited", at, count: 1, episodeElapsedMs: 0 } });
    expect(planResumes({ runs: [eval90], config: config(), running: new Map(), held, now: NOW }).end[0]).toMatchObject({ reason: "attempt-failed", counts: true });
  });

  test("a resume waits for its own account — never a different one — and a running job handles its own pause", () => {
    const job: FleetJob = { refs: ["nav"], ref: "nav", episode: "freeplay", repeat: "loop", name: "nav-freeplay", enabled: true, source: "queue" };
    const run = paused({ runId: "fleet-nav-freeplay-sonnet-20260823", model: "sonnet", account: "RUNNER3", episode: "freeplay", episodeMs: null });
    let plan = planResumes({ runs: [run], config: config([job]), running: new Map([["ox-e90", "RUNNER3"]]), held, now: NOW });
    expect(plan.resume).toEqual([]);
    expect(plan.listed[0]!.why).toBe("waiting: account RUNNER3 is busy (ox-e90)");
    plan = planResumes({ runs: [run], config: config([job]), running: new Map(), held: (a) => (a === "RUNNER3" ? "run-by-hand" : undefined), now: NOW });
    expect(plan.listed[0]!.why).toBe("waiting: account RUNNER3 is held by run run-by-hand");
    // The job's own roster is running (mid-retry): nothing to do, nothing to list.
    plan = planResumes({ runs: [run], config: config([job]), running: new Map([["nav-freeplay", "RUNNER3"]]), held, now: NOW });
    expect(plan).toEqual({ resume: [], listed: [], end: [] });
  });

  test("the strike a tick writes is in the projection that tick schedules from", () => {
    // The 2026-08-25 bug: the sweep logged `retry 3/3 — tainted` for
    // nemotron-ultra and the policy spawned its ninth attempt one second
    // later, because the projection behind the pick was built before the
    // terminations were written and still counted zero.
    const ended = (i: number): RunFact =>
      paused({
        runId: `fleet-ox-e90-stealth-ox-alpha-2026082${i}`,
        model: "stealth/ox-alpha:free",
        account: "RUNNER3",
        pause: null,
        terminationReason: "attempt-failed",
        endedAt: NOW - (10 - i) * H,
      });
    const third = paused({
      runId: "fleet-ox-e90-stealth-ox-alpha-20260825",
      model: "stealth/ox-alpha:free",
      account: "RUNNER3",
      pause: { reason: "quota-exhausted", at: NOW - 60_000, count: 1, episodeElapsedMs: 12 * 60_000 },
    });
    const runs = [ended(1), ended(2), third];
    const cfg: FleetConfig = { ...config(), notes: [], preflight: DEFAULT_PREFLIGHT, campaigns: [], maxConcurrent: {}, refusals: [] };
    const plan = planResumes({ runs, config: cfg, running: new Map(), held, now: NOW });
    expect(plan.end).toHaveLength(1);
    expect(retryNumbers(plan.end, (e) => failedAttemptsFor(modelStatesOf(rosterModels(roster), runs, NOW), e) ?? 0)).toEqual([3]);

    // Before the fix: the same tick's pre-sweep projection would schedule it.
    const before = modelStatesOf(rosterModels(roster), runs, NOW);
    expect(before.find((st) => st.name === "ox")!.perEpisode.e90).toMatchObject({ failed: 2, tainted: false });

    // After: the ends are applied, the third strike lands, and nothing spawns
    // for that model in this tick.
    const after = statesAfterSweep(cfg, runs, plan.end, NOW, { version: 1, cleared: {} });
    const ox = after.find((st) => st.name === "ox")!;
    expect(ox.perEpisode.e90).toMatchObject({ failed: 3, tainted: true });
    const v = schedulability(ox);
    expect(v.verdict).toBe("blocked");
    expect(v.why).toContain("tainted on e90 (3 failed attempts)");
    const tick = planTick(cfg, after, held, "20260825");
    expect(tick.policy.map((p) => p.job.ref)).not.toContain("ox");
    // The reverse race: the run the sweep ended holds neither its model nor
    // its account, so RUNNER3 is free for the next model in the same tick.
    expect(ox.paused).toBeUndefined();
    expect(tick.policy.map((p) => p.account).sort()).toEqual(["RUNNER3", "RUNNER4"]);
    expect(applyEnded(runs, plan.end, NOW).find((f) => f.runId === third.runId)).toMatchObject({
      terminationReason: "attempt-failed",
      pause: null,
      live: false,
    });
  });

  test("a paused run whose ref now names another model is ENDED by the supervisor, never resumed or listed", () => {
    // `ox` was re-pointed from stealth/ox-alpha:free to stealth/ox-beta; the paused ox-alpha run has no job to come back under.
    const repointed = { ...roster, ox: { model: "stealth/ox-beta", tier: "t1", idle: "none" } satisfies FleetRosterEntry };
    const run = paused({ runId: "fleet-ox-e90-ox-alpha-20260823-a2", model: "stealth/ox-alpha:free", account: "RUNNER3" });
    const plan = planResumes({ runs: [run], config: { ...config(), roster: repointed }, running: new Map(), held, now: NOW });
    expect(plan.resume).toEqual([]);
    expect(plan.listed).toEqual([]);
    expect(plan.end).toEqual([
      {
        runId: run.runId,
        model: "stealth/ox-alpha:free",
        effort: null,
        ref: "ox",
        episode: "e90",
        reason: "manual",
        detail: "ended by the supervisor: model stealth/ox-alpha:free no longer under ref ox",
        counts: false,
        account: "RUNNER3",
      },
    ]);
    expect(formatEnded(plan.end, false)[1]).toContain("fleet-ox-e90-ox-alpha-20260823-a2 — ended by the supervisor: model stealth/ox-alpha:free no longer under ref ox");
    expect(formatEnded(plan.end, false)[0]).toContain("lapsed runs the supervisor will end when it starts (1)");
    // An effort change is a different entry too.
    const lowRun = paused({ runId: "fleet-ox-e90-ox-alpha-20260823", model: "stealth/ox-alpha:free", account: "RUNNER3" });
    expect(planResumes({ runs: [lowRun], config: { ...config(), roster: { ...roster, ox: { model: "stealth/ox-alpha:free", effort: "low", tier: "t1", idle: "none" } satisfies FleetRosterEntry } }, running: new Map(), held, now: NOW }).end).toHaveLength(1);
    // The same model under the same ref is still ended — as a failed attempt
    // now, with a different reason: the re-pointed rule is about which run has
    // no job to come back to, not about whether a scored run resumes.
    expect(planResumes({ runs: [run], config: config(), running: new Map(), held, now: NOW }).end[0]).toMatchObject({ reason: "manual", counts: false });
    // A run launched outside the fleet is not this rule's, and not the supervisor's to end.
    const hand = paused({ runId: "hand-ox-1", model: "stealth/ox-alpha:free", account: "RUNNER3" });
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
    t.writeMeta({ runId, harnessVersion: "harness-0.4-1-gabc", startedAt: NOW - H, config: loadRunConfig({ runId, driver: "openai", model: "stealth/ox-alpha:free", account: "RUNNER3" }) });
    t.setPause(runId, "rate-limited", "429", 41 * 60_000);
    t.close();
    const detail = "ended by the supervisor: model stealth/ox-alpha:free no longer under ref ox";
    expect(endRuns(runsDir, [{ runId, model: "stealth/ox-alpha:free", effort: null, ref: "ox", episode: "e90", reason: "manual", detail, counts: false, account: "RUNNER3" }])).toEqual([{ runId }]);
    const after = new Trajectory(join(runsDir, runId));
    const row = after.runRow(runId)!;
    after.close();
    expect(row["termination_reason"]).toBe("manual");
    expect(row["termination_detail"]).toBe(detail);
    expect(row["pause_reason"]).toBeNull();
    expect(typeof row["ended_at"]).toBe("number");
    // A runsDir that cannot be reached is reported, not thrown. A path under a
    // plain file fails for every uid — `/nonexistent` is creatable by root.
    const blocked = join(runsDir, "not-a-dir");
    writeFileSync(blocked, "");
    expect(
      endRuns(join(blocked, "runs"), [
        { runId: "x", model: "m", effort: null, ref: "r", episode: "e90", reason: "manual", detail, counts: false, account: null },
      ])[0]!.error,
    ).toBeDefined();
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

// ---------------------------------------------- account affinity

describe("account affinity and cross-account name hygiene", () => {
  const NOW = 1_800_000_000_000;
  const roster: Record<string, FleetRosterEntry> = {
    glm: { model: "z-ai/glm-5.2:free", tier: "t1", idle: "none" },
    ox: { model: "stealth/ox-alpha:free", tier: "t1", idle: "none" },
    mimo: { model: "mimo-v2.5-free", tier: "t1", idle: "none" },
  };
  const fact = (model: string, over: Partial<RunFact> = {}): RunFact => ({
    runId: `${model}-${over.startedAt ?? 0}`,
    model,
    effort: null,
    episode: "e90",
    episodeOverride: false,
    harnessVersion: null,
    harnessSeries: null,
    extra: false,
    startedAt: NOW - 3_600_000,
    endedAt: NOW - 1_800_000,
    terminationReason: "episode-limit",
    modelResponses: 20,
    bestLevel: 3,
    live: false,
    pause: null,
    account: null,
    character: null,
    episodeMs: null,
    campaign: null,
    cell: null,
    subscription: null,
    ...over,
  });
  const job = (over: Partial<FleetJob> & { ref: string }): FleetJob => ({
    refs: [over.ref],
    episode: "e90",
    repeat: 1,
    name: `${over.ref}-${over.episode ?? "e90"}`,
    enabled: true,
    source: "queue",
    ...over,
  });
  const base = { roster, pool: ["RUNNER", "RUNNER2", "RUNNER3"], finished: new Set<string>(), held: () => undefined, cooling: () => undefined };
  const empty = { assign: [], waiting: [], skipped: [] };

  test("the latest run of a model names the account its character is standing on", () => {
    const runs = [
      fact("z-ai/glm-5.2:free", { startedAt: NOW - 7_200_000, account: "RUNNER", character: "Oldname" }),
      fact("z-ai/glm-5.2:free", { startedAt: NOW - 3_600_000, account: "RUNNER5", character: "Grimjaw" }),
      // No account recorded: no evidence, and it must not win on recency.
      fact("z-ai/glm-5.2:free", { startedAt: NOW - 60_000, character: "Ghost" }),
      fact("stealth/ox-alpha:free", { startedAt: NOW - 600_000, account: "RUNNER2", character: "Zeliana" }),
    ];
    const map = affinityFrom(runs, roster);
    expect(map.get("glm")).toEqual({ account: "RUNNER5", character: "Grimjaw" });
    expect(map.get("ox")).toEqual({ account: "RUNNER2", character: "Zeliana" });
    expect(map.get("mimo")).toBeUndefined();
    expect(affinityOf(map)("glm")).toBe("RUNNER5");
    expect(affinityOf(map)("mimo")).toBeUndefined();
  });

  test("takeAccount prefers the affine account and otherwise gives the first, as shift did", () => {
    const free = ["RUNNER", "RUNNER2", "RUNNER3"];
    expect(takeAccount(free, "runner2")).toBe("RUNNER2");
    expect(free).toEqual(["RUNNER", "RUNNER3"]);
    // A preference that is not free falls through to the first free account.
    expect(takeAccount(free, "RUNNER5")).toBe("RUNNER");
    expect(takeAccount([], "RUNNER")).toBeUndefined();
  });

  test("a queue job goes back to the free account its model's character is on", () => {
    const affinity = affinityOf(
      affinityFrom([fact("mimo-v2.5-free", { account: "RUNNER3", character: "Grimjaw" })], roster),
    );
    const plan = planQueue({ ...base, queue: [job({ ref: "glm" }), job({ ref: "mimo" })], running: new Map(), affinity });
    expect(plan.assign.map((a) => [a.job.name, a.account])).toEqual([["glm-e90", "RUNNER"], ["mimo-e90", "RUNNER3"]]);
    // Without affinity the pool order stands: mimo would have taken RUNNER2.
    const plain = planQueue({ ...base, queue: [job({ ref: "glm" }), job({ ref: "mimo" })], running: new Map() });
    expect(plain.assign.map((a) => a.account)).toEqual(["RUNNER", "RUNNER2"]);
  });

  test("an affine account that is busy is not waited for — the next free one is taken", () => {
    const affinity = affinityOf(
      affinityFrom([fact("z-ai/glm-5.2:free", { account: "RUNNER3", character: "Grimjaw" })], roster),
    );
    const plan = planQueue({
      ...base,
      queue: [job({ ref: "glm" })],
      running: new Map(),
      held: (a) => (a === "RUNNER3" ? "another run" : undefined),
      affinity,
    });
    expect(plan.assign.map((a) => a.account)).toEqual(["RUNNER"]);
    expect(plan.waiting).toEqual([]);
  });

  test("a policy pick keeps its own account too", () => {
    const states = modelStatesOf(rosterModels(roster));
    const affinity = affinityOf(
      affinityFrom([fact("stealth/ox-alpha:free", { account: "RUNNER3", character: "Zeliana" })], roster),
    );
    const picks = planPolicy({
      states: states.filter((s) => s.name === "ox"),
      pool: ["RUNNER", "RUNNER2", "RUNNER3"],
      running: new Map(),
      held: () => undefined,
      queuePlan: empty,
      runningRefs: new Set(),
      affinity,
    });
    expect(picks.map((p) => [p.job.ref, p.account])).toEqual([["ox", "RUNNER3"]]);
  });

  test("a sweep is planned only for a name on an account this tick calls free, never the launching one", () => {
    const affinity = affinityFrom(
      [
        fact("z-ai/glm-5.2:free", { account: "RUNNER5", character: "Grimjaw" }),
        fact("stealth/ox-alpha:free", { account: "RUNNER6", character: "Zeliana" }),
        fact("mimo-v2.5-free", { account: "RUNNER2", character: "Bramble" }),
      ],
      roster,
    );
    const sweeps = planNameSweeps({
      assign: [
        // glm launches on RUNNER3 while Grimjaw stands on a free RUNNER5.
        { ref: "glm", account: "RUNNER3" },
        // ox's old account is busy: nothing may be deleted there.
        { ref: "ox", account: "RUNNER4" },
        // mimo went back to its own account: its own hygiene owns it.
        { ref: "mimo", account: "RUNNER2" },
      ],
      affinity,
      isFree: (a) => a !== "RUNNER6",
    });
    expect(sweeps).toEqual([{ ref: "glm", account: "RUNNER5", character: "Grimjaw" }]);
    // A model with no recorded character sweeps nothing.
    expect(planNameSweeps({ assign: [{ ref: "mimo", account: "RUNNER" }], affinity: new Map(), isFree: () => true })).toEqual([]);
  });

  test("the sweep deletes through the module's client delete path, with a token the module will accept", async () => {
    const calls: { url: string; body: Record<string, unknown> }[] = [];
    const f = ((url: string, init?: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> });
      return Promise.resolve(new Response(JSON.stringify({ ok: true, deleted: true }), { status: 200 }));
    }) as unknown as typeof fetch;
    const said: string[] = [];
    await sweepNames([{ ref: "glm", account: "RUNNER5", character: "Grimjaw" }], (s) => said.push(s), f);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toEndWith("/character-delete");
    expect(calls[0]!.body["account"]).toBe("RUNNER5");
    expect(calls[0]!.body["character"]).toBe("Grimjaw");
    // The module refuses tokens under 32 characters (`weak_token`).
    expect(String(calls[0]!.body["token"]).length).toBeGreaterThanOrEqual(32);
    expect(said[0]).toContain("deleted Grimjaw on RUNNER5");
  });

  test("a refused delete is logged and never throws — the model can pick another name", async () => {
    const f = (() => Promise.resolve(new Response(JSON.stringify({ ok: false, error: "account_in_use" }), { status: 409 }))) as unknown as typeof fetch;
    const said: string[] = [];
    await sweepNames([{ ref: "glm", account: "RUNNER5", character: "Grimjaw" }], (s) => said.push(s), f);
    expect(said[0]).toContain("could not delete Grimjaw on RUNNER5 (account_in_use)");
    const boom = (() => Promise.reject(new Error("econnrefused"))) as unknown as typeof fetch;
    await sweepNames([{ ref: "glm", account: "RUNNER5", character: "Grimjaw" }], (s) => said.push(s), boom);
    expect(said[1]).toContain("could not reach the module");
  });
});

describe("a paused character head is not orphaned by a supervisor restart (2026-09-08)", () => {
  // The live shape. The k8s fleet pod stamped its runs "0.0.0-phase0" (no
  // git in the image; the fix is in run-roster's harnessVersion), so
  // nemotron-super's a12 — paused `operator-pause` by the drain three minutes
  // earlier — was out of the policy's series. planResumes dropped it before
  // the loop, so it was neither resumed nor listed, and the policy then
  // continued the character from a11, the ENDED attempt before it, leaving a12
  // orphaned off the chain on the same character.
  const NOW = 1_800_000_000_000;
  const H = 3_600_000;
  const REF = "nemotron-super";
  /** The synthetic policy job's name, which is also what the run ids hang off. */
  const JOB = `${REF}-freeplay`;
  const roster: Record<string, FleetRosterEntry> = {
    [REF]: { model: "nvidia/nemotron-3-super-120b-a12b:free", tier: "t1", idle: "unlimited" },
  };
  const config = (): Pick<FleetConfig, "jobs" | "roster" | "policy" | "accounts"> => ({
    jobs: [],
    roster,
    policy: { ...DEFAULT_POLICY, series: "0.5" },
    accounts: { pinned: {}, pool: ["RUNNER"], paid: [], local: [] },
  });
  const run = (over: Partial<RunFact> & { runId: string }): RunFact => ({
    model: "nvidia/nemotron-3-super-120b-a12b:free",
    effort: null,
    episode: "freeplay",
    episodeOverride: false,
    harnessVersion: "harness-0.5-506-gcee3e079",
    harnessSeries: "0.5",
    extra: true,
    startedAt: NOW - 6 * H,
    endedAt: NOW - 2 * H,
    terminationReason: "idle",
    modelResponses: 200,
    bestLevel: 5,
    live: false,
    pause: null,
    account: "RUNNER",
    character: "Aric",
    episodeMs: null,
    campaign: null,
    cell: null,
    subscription: null,
    ...over,
  });
  const a11 = run({ runId: `fleet-${JOB}-nemotron-3-super-120b-a12b-20260905-a11` });
  const a12 = run({
    runId: `fleet-${JOB}-nemotron-3-super-120b-a12b-20260905-a12`,
    harnessVersion: "0.0.0-phase0",
    harnessSeries: null,
    startedAt: NOW - 2 * H,
    endedAt: null,
    terminationReason: null,
    pause: { reason: "operator-pause", at: NOW - 3 * 60_000, count: 2, episodeElapsedMs: 93 * 60_000 },
  });
  const held = (): string | undefined => undefined;

  test("the newest paused attempt is the character head, so a fresh attempt continues from IT, not from the ended one", () => {
    expect(charactersFrom([a11, a12], roster).get(REF)).toEqual({ runId: a12.runId, account: "RUNNER", character: "Aric" });
    const picks = planContinuations(
      [{ job: { refs: [REF], ref: REF, episode: "freeplay", repeat: 1, name: JOB, enabled: true, source: "policy", attempt: 13 }, account: "RUNNER", why: "extra" }],
      charactersFrom([a11, a12], roster),
      roster,
    );
    expect(picks.picks[0]!.job.continueFrom).toBe(a12.runId);
  });

  test("a run from another series is listed, never resumed and never ENDED", () => {
    const plan = planResumes({ runs: [a11, a12], config: config(), running: new Map(), held, now: NOW });
    expect(plan.resume).toEqual([]);
    // The sweep must not reach it: on the live fleet 42 paused runs from older
    // series were sitting in data/runs, and ending them would have written a
    // termination on every one.
    expect(plan.end).toEqual([]);
    expect(plan.listed).toHaveLength(1);
    expect(plan.listed[0]!.runId).toBe(a12.runId);
    expect(plan.listed[0]!.why).toContain("paused under harness series unversioned, this supervisor runs 0.5");
    // A COLD one stays out of the listing, exactly as it was before: nobody is
    // waiting on a run that has shown no life for longer than its own budget.
    const cold = planResumes({
      runs: [{ ...a12, pause: { ...a12.pause!, at: NOW - 20 * H }, endedAt: NOW - 20 * H }],
      config: config(),
      running: new Map(),
      held,
      now: NOW,
    });
    expect(cold.listed).toEqual([]);
    expect(cold.end).toEqual([]);
  });

  test("with the stamp fixed, the same restart resumes it in place", () => {
    // What the harnessVersion fix restores: the pod's runs carry the image
    // tag's series again, so the paused head is the supervisor's to resume.
    const stamped = { ...a12, harnessVersion: "harness-0.5-513-g803bd42", harnessSeries: "0.5" };
    const plan = planResumes({ runs: [a11, stamped], config: config(), running: new Map(), held, now: NOW });
    expect(plan.listed).toEqual([]);
    expect(plan.end).toEqual([]);
    expect(plan.resume.map((r) => [r.job.name, r.job.source, r.job.attempt, r.account, r.runId])).toEqual([
      [JOB, "policy", 12, "RUNNER", stamped.runId],
    ]);
    expect(jobSpawn(plan.resume[0]!.job, roster, "RUNNER", "20260908").resumeRunId).toBe(stamped.runId);
  });
});

describe("freeplay characters are durable (operator ask, 2026-08-29)", () => {
  const NOW = 1_800_000_000_000;
  const roster: Record<string, FleetRosterEntry> = {
    opuslo: { model: "opus", effort: "low", driver: "claude-code", tier: "t1", idle: "unlimited" },
    sonlo: { model: "sonnet", effort: "low", driver: "claude-code", tier: "t1", idle: "unlimited" },
    glm: { model: "z-ai/glm-5.2:free", tier: "t1", idle: "none" },
  };
  const fact = (runId: string, over: Partial<RunFact>): RunFact => ({
    runId,
    model: "opus",
    effort: "low",
    episode: "freeplay",
    episodeOverride: false,
    harnessVersion: "0.5.3",
    harnessSeries: "0.5",
    extra: true,
    startedAt: NOW - 3_600_000,
    endedAt: NOW - 60_000,
    terminationReason: "manual",
    modelResponses: 40,
    bestLevel: 8,
    live: false,
    pause: null,
    account: "RUNNER2",
    character: "Bromdir",
    episodeMs: null,
    campaign: null,
    cell: null,
    subscription: "CLAUDE_CODE_OAUTH_TOKEN_2",
    ...over,
  });
  const policyFreeplay = (ref: string, attempt: number): FleetJob => ({
    refs: [ref],
    ref,
    episode: "freeplay",
    repeat: 1,
    name: ref,
    enabled: true,
    source: "policy",
    attempt,
  });

  test("a character is the ref's latest ENDED freeplay run with an account and a name", () => {
    // The 2026-08-29 shape: sub-opus-low's a11 (Bromdir, RUNNER2) was killed
    // by hand and terminated `manual`; the a10 before it ended `idle` on Bromdal.
    const runs = [
      fact("fleet-sub-opus-low-freeplay-opus-low-20260827-a10", { startedAt: NOW - 90_000_000, character: "Bromdal", terminationReason: "idle" }),
      fact("fleet-sub-opus-low-freeplay-opus-low-20260827-a11", {}),
      // A live one (no termination) is in flight, not a predecessor.
      fact("fleet-sonnet-low-freeplay-sonnet-low-20260827-a2", { model: "sonnet", startedAt: NOW - 1_000, account: "RUNNER3", character: "Ironvowen", terminationReason: null, live: true }),
      // A scored run of the same model is not the character, whatever it played.
      fact("fleet-sub-opus-low-e90-opus-low-20260829", { episode: "e90", extra: false, startedAt: NOW - 1000, account: "RUNNER5", character: "Brintor", terminationReason: "episode-limit" }),
    ];
    const characters = charactersFrom(runs, roster);
    expect(characters.get("opuslo")).toEqual({ runId: "fleet-sub-opus-low-freeplay-opus-low-20260827-a11", account: "RUNNER2", character: "Bromdir" });
    expect(characters.has("sonlo")).toBe(false);
    // …and a PAUSED attempt is a head, even though it has no termination: it is
    // the newest thing the character did, and the runs directory is all a fresh
    // supervisor has (2026-09-08). The live one above still is not.
    const withPause = charactersFrom(
      [
        ...runs,
        fact("fleet-sonnet-low-freeplay-sonnet-low-20260827", {
          model: "sonnet",
          startedAt: NOW - 2_000,
          account: "RUNNER3",
          character: "Bronwyra",
          terminationReason: null,
          pause: { reason: "operator-pause", at: NOW, count: 1, episodeElapsedMs: null },
        }),
      ],
      roster,
    );
    expect(withPause.get("sonlo")).toEqual({ runId: "fleet-sonnet-low-freeplay-sonnet-low-20260827", account: "RUNNER3", character: "Bronwyra" });
    // A ref that is not in the unlimited lane owes no character, even with runs.
    expect(charactersFrom([fact("x", { model: "z-ai/glm-5.2:free", effort: null })], roster).has("glm")).toBe(false);
  });

  test("the policy's freeplay pick continues its character on the character's account, and is held elsewhere", () => {
    const characters = new Map([["opuslo", { runId: "a11", account: "RUNNER2", character: "Bromdir" }]]);
    // Landed on RUNNER2 (affinity did its job): continue a11.
    const back = planContinuations([{ job: policyFreeplay("opuslo", 12), account: "RUNNER2", why: "extra" }], characters, roster);
    expect(back.waiting).toEqual([]);
    expect(back.picks[0]!.job.continueFrom).toBe("a11");
    // RUNNER2 busy, RUNNER5 offered: held, never a fresh character elsewhere.
    const away = planContinuations([{ job: policyFreeplay("opuslo", 12), account: "RUNNER5", why: "extra" }], characters, roster);
    expect(away.picks).toEqual([]);
    expect(away.waiting).toEqual([{ name: "opuslo", head: characters.get("opuslo")!, offered: "RUNNER5", why: expect.stringContaining("RUNNER2 is free") }]);
    // A ref with no character yet starts fresh, as before.
    const fresh = planContinuations([{ job: policyFreeplay("sonlo", 1), account: "RUNNER3", why: "extra" }], characters, roster);
    expect(fresh.picks[0]!.job.continueFrom).toBeUndefined();
    // The freeplay pick's account preference is its character's, not the model's last run's.
    expect(characterAffinity(characters, () => "RUNNER5")("opuslo")).toBe("RUNNER2");
    expect(characterAffinity(characters, () => "RUNNER5")("sonlo")).toBe("RUNNER5");
  });

  test("a character head on another ref's occupied account starts fresh elsewhere; a bounded or own occupant holds (item 94)", () => {
    // The 2026-08-29 shape: fable-none's two-minute head (Thorgrima) landed on
    // RUNNER2, then opus-low reclaimed RUNNER2 for Bromdir and stays there
    // indefinitely — an unlimited session has no boundary to wait for.
    const characters = new Map([
      ["opuslo", { runId: "a11", account: "RUNNER2", character: "Bromdir" }],
      ["sonlo", { runId: "f1", account: "RUNNER2", character: "Thorgrima" }],
    ]);
    const pick = [{ job: policyFreeplay("sonlo", 2), account: "RUNNER5", why: "extra" }];
    // Same-ref occupant (opus's own resume reserving RUNNER2): holds.
    const own = planContinuations([{ job: policyFreeplay("opuslo", 12), account: "RUNNER5", why: "extra" }], characters, roster, new Map([["RUNNER2", { ref: "opuslo", unlimited: true }]]));
    expect(own.picks).toEqual([]);
    expect(own.dropped).toEqual([]);
    expect(own.waiting[0]!.why).toContain("its own");
    // Different ref's unlimited session on the head's account: fresh on the offered account, with the record and no lineage.
    const occupied = planContinuations(pick, characters, roster, new Map([["RUNNER2", { ref: "opuslo", unlimited: true }]]));
    expect(occupied.waiting).toEqual([]);
    expect(occupied.dropped).toEqual([{ name: "sonlo", head: characters.get("sonlo")!, occupant: "opuslo", account: "RUNNER5" }]);
    expect(occupied.picks[0]!.account).toBe("RUNNER5");
    expect(occupied.picks[0]!.job.continueFrom).toBeUndefined();
    expect(occupied.picks[0]!.job.continueDropped).toEqual({ runId: "f1", reason: "account_occupied_by opuslo" });
    // A bounded occupant (a scored run) ends at its boundary: hold, as before.
    const bounded = planContinuations(pick, characters, roster, new Map([["RUNNER2", { ref: "glm", unlimited: false }]]));
    expect(bounded.picks).toEqual([]);
    expect(bounded.waiting[0]!.why).toContain("held by glm until its episode boundary");
    // No free account: no pick reaches here, and the standing names the reason --status prints.
    expect(characterStanding("sonlo", characters.get("sonlo")!, new Map([["RUNNER2", { ref: "opuslo", unlimited: true }]]))).toEqual({ kind: "occupied", occupant: "opuslo" });
    expect(describeStanding(characters.get("sonlo")!, { kind: "occupied", occupant: "opuslo" })).toContain("starts FRESH");
    // Head account free: continues there (the pick lands on it through affinity).
    const free = planContinuations([{ job: policyFreeplay("sonlo", 2), account: "RUNNER2", why: "extra" }], characters, roster, new Map());
    expect(free.picks[0]!.job.continueFrom).toBe("f1");
    expect(free.picks[0]!.job.continueDropped).toBeUndefined();
    expect(characterStanding("sonlo", characters.get("sonlo")!, new Map())).toEqual({ kind: "free" });
    // The --status rows, one per unlimited ref.
    const rows = formatCharacters(roster, characters, new Map([["RUNNER2", { ref: "opuslo", unlimited: true }]]), new Set(["opuslo"]));
    expect(rows).toEqual([
      expect.stringContaining("character opuslo: head a11 on RUNNER2 as Bromdir — in flight"),
      expect.stringContaining("character sonlo: head f1 on RUNNER2 as Thorgrima — occupied by opuslo's character: fresh-next"),
    ]);
  });

  test("another ref's freeplay character on the account is kept, and the name sweep never deletes one", () => {
    const characters = new Map([
      ["opuslo", { runId: "a11", account: "RUNNER2", character: "Bromdir" }],
      ["sonlo", { runId: "s2", account: "RUNNER2", character: "Ironvowen" }],
    ]);
    // A scored launch on RUNNER2 keeps both; opuslo's own continuation keeps only the other.
    expect(keepFor("RUNNER2", characters)).toEqual(["Bromdir", "Ironvowen"]);
    expect(keepFor("runner2", characters, "opuslo")).toEqual(["Ironvowen"]);
    expect(keepFor("RUNNER5", characters)).toEqual([]);
    const picked = planContinuations([{ job: policyFreeplay("opuslo", 12), account: "RUNNER2", why: "extra" }], characters, roster);
    expect(picked.picks[0]!.job.keepCharacters).toEqual(["Ironvowen"]);
    // The e90 of the same model launching on RUNNER5 while RUNNER2 is free
    // used to plan a delete of Bromdir there; a freeplay character is protected.
    const affinity = new Map([["opuslo", { account: "RUNNER2", character: "Bromdir" }]]);
    const protect = new Set([...characters.values()].map((s) => characterKey(s.account, s.character)));
    expect(planNameSweeps({ assign: [{ ref: "opuslo", account: "RUNNER5" }], affinity, isFree: () => true, protect })).toEqual([]);
    expect(planNameSweeps({ assign: [{ ref: "opuslo", account: "RUNNER5" }], affinity, isFree: () => true })).toEqual([
      { ref: "opuslo", account: "RUNNER2", character: "Bromdir" },
    ]);
  });

  test("the lineage rides the spawn only on the unlimited lane, and never from the file", () => {
    const job: FleetJob = { ...policyFreeplay("opuslo", 12), continueFrom: "a11", keepCharacters: ["Ironvowen"] };
    const spawn = jobSpawn(job, roster, "RUNNER2", "20260829");
    expect(spawn.entries[0]).toMatchObject({ continueFrom: "a11", keepCharacters: ["Ironvowen"], maxToolCalls: null });
    const argv = episodeArgv(resolve(fillEntries(spawn, "20260829"), "20260829")[0]!, false);
    expect(argv[argv.indexOf("--continue-from") + 1]).toBe("a11");
    expect(argv[argv.indexOf("--keep-characters") + 1]).toBe("Ironvowen");
    // A hand-written freeplay job on the same ref is the operator's experiment: no lineage.
    const manual: FleetJob = { ...job, source: "queue", attempt: undefined };
    expect(jobSpawn(manual, roster, "RUNNER2", "20260829").entries[0]!.continueFrom).toBeUndefined();
    // The file may not say it.
    const file = (extra: Record<string, unknown>) => ({
      accounts: { pool: ["RUNNER2"] },
      roster: { opuslo: { tier: "t1", model: "opus", effort: "low", driver: "claude-code" } },
      policy: {},
      queue: [{ ref: "opuslo", episode: "freeplay", ...extra }],
    });
    expect(() => parseFleet(file({ continueFrom: "a11" }))).toThrow(/must not carry continueFrom/);
    expect(() => parseFleet(file({ keepCharacters: ["x"] }))).toThrow(/must not carry keepCharacters/);
  });

  test("a disabled unlimited session pauses at once; everything else drains to its boundary", () => {
    expect(pausesOnDrain(policyFreeplay("opuslo", 12))).toBe(true);
    expect(pausesOnDrain({ source: "policy", episode: "e90" })).toBe(false);
    expect(pausesOnDrain({ source: "queue", episode: "freeplay" })).toBe(false);
    expect(pausesOnDrain(undefined)).toBe(false);
  });

  test("item 107: flipping a live character's ref to idle:\"none\" drops it from the projection", () => {
    // The gap: the supervisor hot-reloads fleet.json, the policy stops
    // generating the job, and before this the live roster process was never
    // signalled — it ran until an idle watchdog an active model never trips.
    const stopped: Record<string, FleetRosterEntry> = { ...roster, opuslo: { ...roster["opuslo"]!, idle: "none" } };
    expect(policyJobDropped(policyFreeplay("opuslo", 12), stopped["opuslo"])).toBe('idle: "none"');
    // The whole entry gone is the same drain, with its own reason.
    expect(policyJobDropped(policyFreeplay("opuslo", 12), undefined)).toBe("removed from the roster");
  });

  test("item 107: a character still in the unlimited lane is never dropped, whatever the plan did this tick", () => {
    // The distinction is the LOADED CONFIG, not the plan: the reasons a policy
    // pick is absent from a tick (account busy, a lane or paid cap, cooling,
    // eligibility) are transient and none of them reaches this predicate, so a
    // ref whose idle lane is still open keeps its live session.
    expect(policyJobDropped(policyFreeplay("opuslo", 12), roster["opuslo"])).toBeUndefined();
    // Scored policy jobs keep exactly the handling they had: `idle` says
    // nothing about what a tier bought, so idle:"none" does not drain an e90.
    expect(policyJobDropped({ source: "policy", episode: "e90" }, roster["glm"])).toBeUndefined();
    expect(policyJobDropped({ source: "policy", episode: "e90" }, undefined)).toBe("removed from the roster");
    // Not the policy's job, not this predicate's business.
    expect(policyJobDropped({ source: "queue", episode: "freeplay" }, undefined)).toBeUndefined();
    expect(policyJobDropped(undefined, roster["opuslo"])).toBeUndefined();
  });

  test("item 107: the dropped character's disabled stand-in reaches diffJobs as a drain", () => {
    // What the supervisor pushes for a dropped live policy job, and what
    // `diffJobs` does with it: the drain, and then `pausesOnDrain` makes it an
    // immediate SIGTERM rather than a wait for an episode boundary.
    const standIn = { name: "opuslo-freeplay", enabled: false, account: "RUNNER2", loop: false, entries: [{ model: "gone" }] };
    const sets: JobSets = { running: new Set(["opuslo-freeplay"]), draining: new Set(), finished: new Set() };
    expect(diffJobs([standIn], sets).drain).toEqual(["opuslo-freeplay"]);
    expect(pausesOnDrain(policyFreeplay("opuslo", 12))).toBe(true);
  });

  test("resumesInPlace: the freeplay character and a resume:true campaign come back; a scored run does not", () => {
    // What `infra/fleet-update.sh graceful` reads off each job row to decide
    // whether waiting on it buys anything (item 93). The campaign's
    // opt-in is the supervisor's to answer: the script must not re-derive it
    // from a fleet.json the supervisor may not be running.
    const campaigns = [
      { name: "class-probe", resume: true },
      { name: "nav-probe" },
    ] as unknown as Campaign[];
    const probe = (campaign: string) => ({ source: "policy" as const, episode: "probing" as const, probe: { campaign, cell: "gnome-mage" } });
    expect(resumesInPlace(policyFreeplay("opuslo", 12), campaigns)).toBe(true);
    expect(resumesInPlace(probe("class-probe"), campaigns)).toBe(true);
    expect(resumesInPlace(probe("nav-probe"), campaigns)).toBe(false);
    // The campaign was deleted from the file: nothing to resume under.
    expect(resumesInPlace(probe("class-probe"), [])).toBe(false);
    expect(resumesInPlace(probe("class-probe"), undefined)).toBe(false);
    // A scored attempt is spent by a recreate, so it is never parked.
    expect(resumesInPlace({ source: "policy", episode: "e90" }, campaigns)).toBe(false);
    expect(resumesInPlace({ source: "pinned", episode: "e360" }, campaigns)).toBe(false);
    expect(resumesInPlace(undefined, campaigns)).toBe(false);
  });
});
