/**
 * The fleet table's contract: the columns it shows, in the order it shows them,
 * the state each row reads as, and the click-through into the run it is about.
 *
 * The header renders from `FLEET_COLUMNS` and the body from `fleetRows`, so
 * asserting on those is asserting on the table — which is what keeps this in
 * the pure layer instead of a DOM harness (dashboard/README.md).
 */

import { describe, expect, test } from "bun:test";
import type { FleetJobView, FleetResponse, RunListRow } from "../../runner/viewer/api-types";
import { FLEET_COLUMNS, fleetRows, jobModelLabel, runHref } from "../src/lib/fleet";

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
    lanes: [],
    jobs: [job()],
    accounts: [
      { account: "RUNNER", class: "pool", job: "ox-alpha-e90" },
      { account: "RUNNER2", class: "pool", job: null },
      { account: "BOX", class: "local", job: null },
      { account: "PAID", class: "paid", job: null },
      { account: "SHAKEOUT", class: "pinned", job: "nav-probe-freeplay" },
    ],
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
          elapsedMs: 1_410_000,
          budgetMs: 5_400_000,
          why: "waiting: account RUNNER2 is busy",
        },
      ],
    });
    const row = fleetRows(f, [])!.find((r) => r.account === "RUNNER2")!;
    expect(row).toMatchObject({ state: "paused", job: null, models: "hy3-free", runId: "fleet-hy3-e90-20260823-a5", elapsedMs: 1_410_000 });
    expect(row.note).toBe("rate-limited — waiting: account RUNNER2 is busy");
  });

  test("a supervisor that published no accounts block gets job rows and nothing invented", () => {
    const { accounts: _dropped, ...noAccounts } = fleet();
    const rows = fleetRows(noAccounts, []);
    expect(rows.map((r) => r.job)).toEqual(["ox-alpha-e90"]);
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
