/**
 * The fleet table's contract: the columns it shows, in the order it shows them,
 * the state each row reads as, and the click-through into the run it is about.
 *
 * The header renders from `FLEET_COLUMNS` and the body from `fleetRows`, so
 * asserting on those is asserting on the table — which is what keeps this in
 * the pure layer instead of a DOM harness (dashboard/README.md).
 */

import { describe, expect, test } from "bun:test";
import type { FleetJobView, FleetResponse, FleetServerView, RunListRow } from "../../runner/viewer/api-types";
import type { FleetRow } from "../src/lib/fleet";
import {
  FLEET_COLUMNS,
  HEARTBEAT_STALE_MS,
  deployWindowOpen,
  fleetRows,
  gateVerdict,
  jobModelLabel,
  pausedLabel,
  progressLabel,
  progressTitle,
  rowProgress,
  rowStateLabel,
  runHref,
  serverBanner,
  supervisorAlive,
} from "../src/lib/fleet";

const REST: FleetServerView = { phase: "running", since: 0, build: "", detail: "", updatedAt: 0 };

function job(over: Partial<FleetJobView> = {}): FleetJobView {
  return {
    name: "ox-alpha-e90",
    ref: "ox-alpha",
    episode: "e90",
    account: "RUNNER",
    accountClass: "pool",
    source: "policy",
    attempt: 2,
    models: ["stealth/ox-alpha"],
    runId: "fleet-ox-alpha-e90-20260823",
    model: "stealth/ox-alpha",
    pid: 13,
    spawnedAt: 1,
    exitCode: null,
    draining: false,
    alive: true,
    ...over,
  };
}

function fleet(over: Partial<FleetResponse> = {}): FleetResponse {
  return {
    present: true,
    server: REST,
    jobs: [job()],
    accounts: [
      { account: "RUNNER", class: "pool", job: "ox-alpha-e90" },
      { account: "RUNNER2", class: "pool", job: null },
      { account: "BOX", class: "local", job: null },
      { account: "PAID", class: "paid", job: null },
      { account: "SHAKEOUT", class: "pinned", job: "nav-probe-freeplay" },
    ],
    paused: [],
    ended: [],
    session: { finished: 1, ok: 1, retried: 0 },
    now: 1000,
    ...over,
  };
}

function run(over: Partial<RunListRow> = {}): RunListRow {
  return {
    runId: "fleet-ox-alpha-e90-20260823",
    level: 4,
    xp: 546,
    playtimeMs: 60_000,
    tokens: { totalTokens: 103_744 },
    cost: { actual: { usd: 0.42, basis: "reported", note: "" } },
    ...over,
  } as unknown as RunListRow;
}

describe("columns", () => {
  test("state leads; one table carries the job, its account and the run it is driving", () => {
    expect([...FLEET_COLUMNS]).toEqual(["state", "job", "model", "episode", "account", "attempt", "run", "lvl / xp", "tokens", "cost", "elapsed"]);
    // The process is bookkeeping, not something an operator scans a table for;
    // the source (file, queue, policy) maps to the account class and says nothing more.
    expect(FLEET_COLUMNS).not.toContain("pid");
    expect(FLEET_COLUMNS).not.toContain("lane");
    expect(FLEET_COLUMNS).not.toContain("source");
    expect(FLEET_COLUMNS).not.toContain("tier");
  });
});

describe("the model cell", () => {
  test("one model reads as itself; a long rotation is truncated with the rest in the title", () => {
    expect(jobModelLabel(job())).toBe("stealth/ox-alpha");
    expect(jobModelLabel(job({ models: ["a", "b", "c", "d"] }))).toBe("a, b +2");
    expect(jobModelLabel(job({ models: ["a", "b"] }))).toBe("a, b");
  });

  test("a job with no models resolved falls back to the ref it was called by", () => {
    expect(jobModelLabel(job({ ref: "a+b", models: [] }))).toBe("a+b");
  });
});

describe("row state", () => {
  // The table is ordered by state, so pick the job row out rather than trusting an index.
  const stateOf = (over: Partial<FleetJobView>): string => fleetRows(fleet({ jobs: [job(over)] }), []).find((r) => r.job !== null)!.state;

  test("a job driving a run is running; between episodes it is idle", () => {
    expect(stateOf({})).toBe("running");
    expect(stateOf({ runId: null })).toBe("idle");
  });

  test("a spawn that has not picked its paused run back up yet is resuming", () => {
    expect(stateOf({ runId: null, resuming: "fleet-ox-alpha-e90-20260823-a1" })).toBe("resuming");
    // Once the run is live it is just running, whatever it was spawned for.
    expect(stateOf({ resuming: "fleet-ox-alpha-e90-20260823-a1" })).toBe("running");
  });

  test("a dead process reads as exited, and draining outranks running", () => {
    expect(stateOf({ alive: false })).toBe("exited");
    expect(stateOf({ draining: true })).toBe("draining");
    expect(stateOf({ alive: false, draining: true })).toBe("exited");
  });
});

describe("an unnamed episode", () => {
  test("a job whose episode the supervisor could not name carries null, not a guess", () => {
    // Commit 95908d5: unknown is written as null. The row keeps it null, and
    // the page distinguishes that from an account row, which has no episode at all.
    const rows = fleetRows(fleet({ jobs: [job({ episode: null })] }), []);
    expect(rows[0]!.episode).toBeNull();
    expect(rows[0]!.job).toBe("ox-alpha-e90");
    const account = rows.find((r) => r.job === null);
    expect(account?.episode ?? null).toBeNull();
  });
});

describe("the rows", () => {
  test("a job row carries its account's class, its attempt, and the run's level/xp, tokens, actual cost and elapsed", () => {
    const rows = fleetRows(fleet(), [run()]);
    expect(rows[0]).toMatchObject({
      job: "ox-alpha-e90",
      episode: "e90",
      account: "RUNNER",
      accountClass: "pool",
      attempt: 2,
      runId: "fleet-ox-alpha-e90-20260823",
      level: 4,
      xp: 546,
      tokens: 103_744,
      costUsd: 0.42,
      elapsedMs: 60_000,
    });
    // A run the runs feed has not caught up with still gets its row.
    expect(fleetRows(fleet(), [])[0]).toMatchObject({ level: null, xp: null, tokens: null, costUsd: null, elapsedMs: null });
  });

  test("cost is the actual figure only: an unreported or absent cost is null, never the estimate", () => {
    const at = (r: RunListRow): number | null => fleetRows(fleet(), [r])[0]!.costUsd;
    expect(at(run({ cost: { usd: 0.5, actual: { usd: null, basis: "none", note: "provider reports no cost" } } } as unknown as Partial<RunListRow>))).toBeNull();
    expect(at(run({ cost: null } as Partial<RunListRow>))).toBeNull();
    expect(at(run({ tokens: null } as Partial<RunListRow>))).toBe(0.42);
  });

  test("accounts holding nothing are idle rows below the working ones, grouped by class", () => {
    const rows = fleetRows(fleet(), [run()]);
    // State rank puts the running job first; the idle accounts follow in class
    // order: pool, paid, local, pinned. The rank list is asserted in "the row order".
    expect(rows.map((r) => r.key)).toEqual(["ox-alpha-e90", "account:RUNNER2", "account:PAID", "account:BOX", "account:SHAKEOUT"]);
    // The account a job is on never doubles as an idle row.
    expect(rows.filter((r) => r.account === "RUNNER")).toHaveLength(1);
    expect(rows[1]).toMatchObject({ state: "idle", job: null, accountClass: "pool", episode: null });
    // A pinned account whose job holds nothing says which job is parked on it.
    expect(rows[4]!.note).toBe("job nav-probe-freeplay holds nothing right now");
  });

  test("a paused run shows against the account it paused on: it holds nothing, so it is not a job", () => {
    const f = fleet({
      jobs: [],
      paused: [
        {
          runId: "fleet-hy3-e90-20260823-a5",
          model: "hy3-free",
          account: "RUNNER2",
          reason: "rate-limited",
          since: 1,
          pauseCount: 2,
          resumeAfter: null,
          elapsedMs: 1_410_000,
          budgetMs: 5_400_000,
          why: "waiting: account RUNNER2 is busy",
        },
      ],
    });
    const row = fleetRows(f, [])!.find((r) => r.account === "RUNNER2")!;
    expect(row).toMatchObject({ state: "paused", job: null, models: "hy3-free", runId: "fleet-hy3-e90-20260823-a5", elapsedMs: 1_410_000 });
    expect(row.note).toBe("rate-limited (pause 2) — waiting: account RUNNER2 is busy");
  });
});

describe("the row order", () => {
  test("state ranks the table, then account name — one row of every state", () => {
    // The rank list lives in STATE_RANK: running, resuming, draining,
    // paused-deploy, paused, idle, exited. A deploy window is open so that
    // paused-deploy and exited can both be on the table at once.
    const f = fleet({
      server: { ...REST, phase: "swapping" },
      jobs: [
        job({ name: "j-zz", account: "ZZ" }),
        job({ name: "j-aa", account: "AA" }),
        job({ name: "j-res", account: "BB", runId: null, resuming: "fleet-r-a1" }),
        job({ name: "j-dra", account: "CC", draining: true }),
        job({ name: "j-dep", account: "DD", alive: false, runId: null }),
        job({ name: "j-exi", account: "EE", alive: false }),
      ],
      accounts: [
        { account: "FF", class: "pool", job: null },
        { account: "GG", class: "pool", job: null },
        { account: "AH", class: "local", job: null },
      ],
      paused: [
        {
          runId: "fleet-p-a5",
          model: "m",
          account: "FF",
          reason: "rate-limited",
          since: 1,
          pauseCount: 1,
          resumeAfter: null,
          elapsedMs: null,
          budgetMs: null,
          why: "w",
        },
      ],
    });
    expect(fleetRows(f, []).map((r) => [r.state, r.account])).toEqual([
      ["running", "AA"],
      ["running", "ZZ"],
      ["resuming", "BB"],
      ["draining", "CC"],
      ["paused-deploy", "DD"],
      ["paused", "FF"],
      // Inside idle the classes stay grouped: pool before local, name second.
      ["idle", "GG"],
      ["idle", "AH"],
      ["exited", "EE"],
    ]);
  });
});

describe("the --status indicators", () => {
  test("the supervisor is alive by heartbeat inside three ticks; no heartbeat is not running", () => {
    expect(supervisorAlive({ heartbeatAt: 1000 }, 1000 + HEARTBEAT_STALE_MS - 1)).toBe(true);
    expect(supervisorAlive({ heartbeatAt: 1000 }, 1000 + HEARTBEAT_STALE_MS)).toBe(false);
    expect(supervisorAlive({}, 1000)).toBe(false);
  });

  test("the gate verdict is the CLI's word: PASS, FAIL, SKIPPED, or none recorded", () => {
    const rec = { at: 1, serverIdentity: "build:x@1", ok: true, results: [] };
    expect(gateVerdict(undefined)).toBe("none");
    expect(gateVerdict(rec)).toBe("PASS");
    expect(gateVerdict({ ...rec, ok: false })).toBe("FAIL");
    expect(gateVerdict({ ...rec, skipped: true })).toBe("SKIPPED");
  });

  test("a paused run is labelled with its reason, pause count and resume-after time", () => {
    const p = { runId: "r", model: "m", account: "A", reason: "quota-exhausted", since: 1, pauseCount: 3, resumeAfter: null, elapsedMs: null, budgetMs: null, why: "w" };
    expect(pausedLabel(p)).toBe("quota-exhausted (pause 3)");
    const at = new Date(2026, 7, 23, 17, 21).getTime();
    expect(pausedLabel({ ...p, resumeAfter: at })).toBe(`quota-exhausted (pause 3), resumes after ${new Date(at).toLocaleTimeString()}`);
  });
});

describe("the run link", () => {
  test("only a row with a run has somewhere to click through to, and the id is encoded", () => {
    expect(runHref("fleet-ox-alpha-20260822")).toBe("/run/fleet-ox-alpha-20260822");
    expect(runHref("a b/c")).toBe("/run/a%20b%2Fc");
    expect(runHref(null)).toBeNull();
  });

  test("a resuming job links to the run it is coming back to", () => {
    const rows = fleetRows(fleet({ jobs: [job({ runId: null, resuming: "fleet-ox-alpha-e90-20260823-a1" })] }), []);
    expect(rows[0]!.runId).toBe("fleet-ox-alpha-e90-20260823-a1");
    expect(rows[0]!.note).toBe("resuming fleet-ox-alpha-e90-20260823-a1");
  });
});

describe("the deploy window (server-state.json)", () => {
  const at = new Date(2026, 7, 23, 18, 52).getTime();
  const hhmm = new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const server = (over: Partial<FleetServerView>): FleetServerView => ({ ...REST, since: at, build: "harness-0.4-52", ...over });

  test("at rest there is no banner; a rest detail (what was last deployed) is a dim line", () => {
    expect(serverBanner(REST)).toBeNull();
    expect(serverBanner(server({ detail: "deployed harness-0.4-52 at 19:03, verified by 2 direct smoke(s); fleet resumed" }))).toEqual({
      text: "server running: deployed harness-0.4-52 at 19:03, verified by 2 direct smoke(s); fleet resumed",
      tone: "dim",
    });
  });

  test("each window phase is one plain line, with the script's detail verbatim after the colon", () => {
    const d = "fleet stopped, 7 job(s) paused and will resume";
    expect(serverBanner(server({ phase: "draining", detail: d }))).toEqual({
      text: `Deploy window since ${hhmm} — stopping the fleet for harness-0.4-52, runs are pausing: ${d}`,
      tone: "info",
    });
    expect(serverBanner(server({ phase: "swapping", detail: d }))).toEqual({
      text: `Deploy window since ${hhmm} — swapping the worldserver to harness-0.4-52: ${d}`,
      tone: "info",
    });
    expect(serverBanner(server({ phase: "verifying", detail: "full-arc smoke infra/smoke/module-quest.ts (1 of 1) running since 18:58, 600s left of its budget; " + d }))).toEqual({
      text: `Deploy window since ${hhmm} — swapped to harness-0.4-52, verifying: full-arc smoke infra/smoke/module-quest.ts (1 of 1) running since 18:58, 600s left of its budget; ${d}`,
      tone: "info",
    });
    expect(serverBanner(server({ phase: "resuming", detail: "x" }))).toEqual({
      text: `Deploy window since ${hhmm} — harness-0.4-52 verified, starting the fleet; paused runs resume: x`,
      tone: "info",
    });
  });

  test("a verdict is red and names the builds; an unnamed build is said to be unnamed", () => {
    expect(serverBanner(server({ phase: "rolled-back", prevBuild: "harness-0.4-3", detail: "gate smoke failed" }))).toEqual({
      text: `Deploy of harness-0.4-52 FAILED at ${hhmm} and was rolled back to harness-0.4-3: gate smoke failed`,
      tone: "bad",
    });
    expect(serverBanner(server({ phase: "failed", build: "", detail: "no :prev" }))).toEqual({
      text: `Deploy of an unnamed build FAILED at ${hhmm}: no :prev`,
      tone: "bad",
    });
  });

  test("only the four window phases open the window; verdicts do not", () => {
    for (const phase of ["draining", "swapping", "verifying", "resuming"] as const) expect(deployWindowOpen({ phase })).toBe(true);
    for (const phase of ["running", "rolled-back", "failed"] as const) expect(deployWindowOpen({ phase })).toBe(false);
  });

  test("a job whose process is gone and whose run is not held reads 'paused for deploy' inside the window, 'exited' outside it", () => {
    const gone = job({ alive: false, runId: null, model: null, exitCode: 0 });
    const jobRow = (f: FleetResponse): FleetRow => fleetRows(f, []).find((r) => r.job !== null)!;
    const inWindow = jobRow(fleet({ server: server({ phase: "swapping" }), jobs: [gone] }));
    expect(inWindow.state).toBe("paused-deploy");
    expect(rowStateLabel(inWindow.state)).toBe("paused for deploy");
    expect(inWindow.note).toContain("resumes it when the fleet starts");
    expect(jobRow(fleet({ jobs: [gone] })).state).toBe("exited");
    // A gone process still holding a run is not a paused run, whatever the phase.
    expect(jobRow(fleet({ server: server({ phase: "swapping" }), jobs: [job({ alive: false })] })).state).toBe("exited");
    expect(rowStateLabel("running")).toBe("running");
  });
});

describe("episode progress in the state cell", () => {
  // A run's own recorded watchdog is the denominator, so a run is built with one.
  const budgeted = (episodeMs: number | null, over: Partial<RunListRow> = {}): RunListRow =>
    run({ comparability: { budget: { episodeMs } }, ...over } as unknown as Partial<RunListRow>);
  const rowFor = (f: FleetResponse, runs: RunListRow[]): FleetRow => fleetRows(f, runs).find((r) => r.job !== null)!;

  test("a running row reads its percentage off the run's own recorded budget, with the ETA in the title", () => {
    const row = rowFor(fleet(), [budgeted(90 * 60_000, { playtimeMs: 45 * 60_000 })]);
    expect(row.budgetMs).toBe(5_400_000);
    const p = rowProgress(row);
    expect(p).toEqual({ pct: 50, remainingMs: 45 * 60_000, overMs: null });
    expect(progressLabel(p)).toBe("50%");
    expect(progressTitle(p, row)).toBe("ETA: 45m00s — 45m00s of 1h30m");
  });

  test("a draining row is still being driven, so it shows progress too", () => {
    const row = rowFor(fleet({ jobs: [job({ draining: true })] }), [budgeted(90 * 60_000, { playtimeMs: 30 * 60_000 })]);
    expect(row.state).toBe("draining");
    expect(progressLabel(rowProgress(row))).toBe("33%");
  });

  test("a freeplay row with a real recorded clock shows progress against it", () => {
    // The discriminator is the RUN's recorded budget, not the episode id. A
    // session launched under `idle: "unlimited"` records an enforced six hours
    // and a watchdog ends it there, so the percentage is a fact about this run.
    // Measured: four of the eight freeplay runs on disk carry 21_600_000.
    const row = rowFor(
      fleet({ jobs: [job({ episode: "freeplay" })] }),
      [budgeted(6 * 3_600_000, { playtimeMs: 3 * 3_600_000 })],
    );
    expect(row.budgetMs).toBe(21_600_000);
    expect(rowProgress(row)).toEqual({ pct: 50, remainingMs: 3 * 3_600_000, overMs: null });
    expect(progressLabel(rowProgress(row))).toBe("50%");
    expect(progressTitle(rowProgress(row), row)).toBe("ETA: 3h00m — 3h00m of 6h00m");
  });

  test("a freeplay row with no recorded clock still shows nothing", () => {
    // The other four. Genuinely uncapped: there is no budget to be a percentage
    // OF, and inventing one from a tier nominal is the thing this must never do
    // (docs/EPISODES.md). Deleting the `budget === null` guard turns this red.
    const row = rowFor(
      fleet({ jobs: [job({ episode: "freeplay" })] }),
      [budgeted(null, { playtimeMs: 3 * 3_600_000 })],
    );
    expect(row.budgetMs).toBeNull();
    expect(rowProgress(row)).toBeNull();
    expect(progressLabel(rowProgress(row))).toBe("");
    expect(progressTitle(rowProgress(row), row)).toBe("");
  });

  test("a probing row shows real progress: unscored is not uncapped", () => {
    // The gate is capped-ness, not scored-ness. A campaign sets an enforced
    // clock and the run ends on it (ADR-0041), so the percentage is a fact
    // about that run — nav-probe's six hours is this row, not the freeplay one.
    const row = rowFor(
      fleet({ jobs: [job({ episode: "probing" })] }),
      [budgeted(6 * 3_600_000, { playtimeMs: 3 * 3_600_000 })],
    );
    expect(row.budgetMs).toBe(21_600_000);
    const p = rowProgress(row);
    expect(p).toEqual({ pct: 50, remainingMs: 3 * 3_600_000, overMs: null });
    expect(progressLabel(p)).toBe("50%");
    expect(progressTitle(p, row)).toBe("ETA: 3h00m — 3h00m of 6h00m");
  });

  test("a run past its budget shows the real figure over 100 and says how far past it is", () => {
    // fleet-deepseek-flash-e90-…-a3: 114 minutes against a 90-minute budget.
    const row = rowFor(fleet(), [budgeted(90 * 60_000, { playtimeMs: 114 * 60_000 })]);
    const p = rowProgress(row);
    expect(p).toEqual({ pct: 127, remainingMs: null, overMs: 24 * 60_000 });
    expect(progressLabel(p)).toBe("127%");
    expect(progressTitle(p, row)).toBe("ETA: past due — 1h54m of 1h30m, over by 24m00s");
    // Never a negative duration in the title, whatever the overrun.
    expect(progressTitle(p, row)).not.toContain("-");
  });

  test("a paused row carries its budget but shows no progress: nothing is advancing", () => {
    const f = fleet({
      jobs: [],
      paused: [
        {
          runId: "fleet-ox-alpha-e90-20260823",
          model: "stealth/ox-alpha",
          account: "RUNNER",
          reason: "rate-limited",
          since: 1,
          pauseCount: 2,
          resumeAfter: null,
          elapsedMs: 30 * 60_000,
          budgetMs: 90 * 60_000,
          why: "waiting on the window",
        },
      ],
    });
    const row = fleetRows(f, []).find((r) => r.account === "RUNNER")!;
    expect(row.state).toBe("paused");
    expect(row.budgetMs).toBe(5_400_000);
    expect(rowProgress(row)).toBeNull();
  });

  test("a resuming row shows nothing even though it carries a run id", () => {
    const row = rowFor(fleet({ jobs: [job({ runId: null, resuming: "fleet-ox-alpha-e90-20260823" })] }), [
      budgeted(90 * 60_000, { playtimeMs: 30 * 60_000 }),
    ]);
    expect(row.state).toBe("resuming");
    expect(row.runId).toBe("fleet-ox-alpha-e90-20260823");
    expect(rowProgress(row)).toBeNull();
  });

  test("an idle account row, and an exited job, show nothing", () => {
    const rows = fleetRows(fleet({ jobs: [job({ alive: false })] }), [budgeted(90 * 60_000, { playtimeMs: 30 * 60_000 })]);
    for (const r of rows.filter((x) => x.state === "idle" || x.state === "exited")) {
      expect(rowProgress(r)).toBeNull();
    }
    const free = rows.find((r) => r.account === "RUNNER2")!;
    expect(free.state).toBe("idle");
    expect(free.budgetMs).toBeNull();
  });

  test("a run with no recorded budget shows nothing rather than a tier's nominal one", () => {
    // A run assembled flag-by-flag, or one whose metadata predates the stamp.
    const row = rowFor(fleet(), [run({ playtimeMs: 30 * 60_000 })]);
    expect(row.episode).toBe("e90");
    expect(row.budgetMs).toBeNull();
    expect(rowProgress(row)).toBeNull();
    // A recorded null episodeMs (the watchdog disabled) is the same nothing.
    expect(rowProgress(rowFor(fleet(), [budgeted(null, { playtimeMs: 30 * 60_000 })]))).toBeNull();
  });
});
