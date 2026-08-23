/**
 * The fleet table's contract: the columns it shows, in the order it shows them,
 * the state each row reads as, and the click-through into the run it is about.
 *
 * The header renders from `FLEET_COLUMNS` and the body from `fleetRows`, so
 * asserting on those is asserting on the table — which is what keeps this in
 * the pure layer instead of a DOM harness (dashboard/README.md).
 */

import { describe, expect, test } from "bun:test";
import type { FleetJobView, FleetOutstandingView, FleetResponse, FleetServerView, RunListRow } from "../../runner/viewer/api-types";
import {
  outstandingLabel,
  outstandingTitle,
  FLEET_COLUMNS,
  HEARTBEAT_STALE_MS,
  accountClassSummary,
  deployWindowOpen,
  fleetRows,
  gateVerdict,
  jobModelLabel,
  pausedLabel,
  rowStateLabel,
  runHref,
  serverBanner,
  supervisorAlive,
  supervisorLabel,
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
  return { runId: "fleet-ox-alpha-e90-20260823", level: 4, xp: 546, playtimeMs: 60_000, ...over } as unknown as RunListRow;
}

describe("columns", () => {
  test("state leads; one table carries the job, its account and the run it is driving", () => {
    expect([...FLEET_COLUMNS]).toEqual(["state", "job", "models", "tier", "account", "source", "attempt", "run", "lvl / xp", "elapsed"]);
    // The process is bookkeeping, not something an operator scans a table for.
    expect(FLEET_COLUMNS).not.toContain("pid");
    expect(FLEET_COLUMNS).not.toContain("lane");
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
  const stateOf = (over: Partial<FleetJobView>): string => fleetRows(fleet({ jobs: [job(over)] }), [])[0]!.state;

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

describe("an unnamed tier", () => {
  test("a job whose episode the supervisor could not name carries null, not a guess", () => {
    // Commit 95908d5: unknown is written as null. The row keeps it null, and
    // the page distinguishes that from an account row, which has no tier at all.
    const rows = fleetRows(fleet({ jobs: [job({ episode: null })] }), []);
    expect(rows[0]!.tier).toBeNull();
    expect(rows[0]!.job).toBe("ox-alpha-e90");
    const account = rows.find((r) => r.job === null);
    expect(account?.tier ?? null).toBeNull();
  });
});

describe("the rows", () => {
  test("a job row carries its account's class, its attempt, and the run's level/xp and elapsed", () => {
    const rows = fleetRows(fleet(), [run()]);
    expect(rows[0]).toMatchObject({
      job: "ox-alpha-e90",
      tier: "e90",
      account: "RUNNER",
      accountClass: "pool",
      source: "policy",
      attempt: 2,
      runId: "fleet-ox-alpha-e90-20260823",
      level: 4,
      xp: 546,
      elapsedMs: 60_000,
    });
    // A run the runs feed has not caught up with still gets its row.
    expect(fleetRows(fleet(), [])[0]).toMatchObject({ level: null, xp: null, elapsedMs: null });
  });

  test("accounts holding nothing are idle rows at the bottom, grouped by class", () => {
    const rows = fleetRows(fleet(), [run()]);
    // Jobs first, then idle accounts in class order: pool, paid, local, pinned.
    expect(rows.map((r) => r.key)).toEqual(["ox-alpha-e90", "account:RUNNER2", "account:PAID", "account:BOX", "account:SHAKEOUT"]);
    // The account a job is on never doubles as an idle row.
    expect(rows.filter((r) => r.account === "RUNNER")).toHaveLength(1);
    expect(rows[1]).toMatchObject({ state: "idle", job: null, accountClass: "pool", tier: null });
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

  test("the accounts line counts each class that has a row, in class order", () => {
    expect(accountClassSummary(fleet().accounts)).toBe("1 pinned, 2 pool, 1 paid, 1 local");
    expect(accountClassSummary([])).toBe("");
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

  test("a dead heartbeat inside the window is the deploy's doing; outside it the supervisor is NOT RUNNING", () => {
    const dead = { heartbeatAt: 0 };
    expect(supervisorLabel({ ...dead, server: server({ phase: "verifying" }) }, HEARTBEAT_STALE_MS + 1)).toBe("fleet stopped for the deploy window");
    expect(supervisorLabel({ ...dead, server: REST }, HEARTBEAT_STALE_MS + 1)).toBe("supervisor NOT RUNNING");
    expect(supervisorLabel({ heartbeatAt: 1000, server: server({ phase: "verifying" }) }, 2000)).toBe("supervisor ALIVE");
  });

  test("a job whose process is gone and whose run is not held reads 'paused for deploy' inside the window, 'exited' outside it", () => {
    const gone = job({ alive: false, runId: null, model: null, exitCode: 0 });
    const inWindow = fleetRows(fleet({ server: server({ phase: "swapping" }), jobs: [gone] }), [])[0]!;
    expect(inWindow.state).toBe("paused-deploy");
    expect(rowStateLabel(inWindow.state)).toBe("paused for deploy");
    expect(inWindow.note).toContain("resumes it when the fleet starts");
    expect(fleetRows(fleet({ jobs: [gone] }), [])[0]!.state).toBe("exited");
    // A gone process still holding a run is not a paused run, whatever the phase.
    expect(fleetRows(fleet({ server: server({ phase: "swapping" }), jobs: [job({ alive: false })] }), [])[0]!.state).toBe("exited");
    expect(rowStateLabel("running")).toBe("running");
  });
});

describe("outstandingLabel", () => {
  const o = (over: Partial<FleetOutstandingView> = {}): FleetOutstandingView => ({
    lower: 11,
    upper: 23,
    etaLowerMs: 4 * 3_600_000,
    etaUpperMs: 9 * 3_600_000,
    breakdown: [{ group: "pool", concurrency: 5, lowerRuns: 11, upperRuns: 23, lowerMinutes: 990, upperMinutes: 2070 }],
    ...over,
  });

  test("the bounded pair and its eta, in --status's own words", () => {
    expect(outstandingLabel(o())).toBe("outstanding: 11\u201323 scheduled runs, \u2248 4h\u20139h to exhaust");
    expect(outstandingLabel(o({ lower: 5, upper: 5, etaLowerMs: 3_600_000, etaUpperMs: 3_600_000 }))).toBe(
      "outstanding: 5 scheduled runs, \u2248 1h to exhaust",
    );
    expect(outstandingLabel(o({ lower: 0, upper: 0 }))).toBe("outstanding: exhausted");
    // Work with nowhere to run has no eta rather than a made-up one.
    expect(outstandingLabel(o({ etaLowerMs: null }))).toContain("eta unknown");
    // The tooltip carries the formula and the per-class arithmetic behind it.
    expect(outstandingTitle(o())).toContain("pool: 11\u201323 runs, 990\u20132070 min at 5 at a time");
    expect(outstandingTitle(o())).toContain("ETA =");
  });
});
