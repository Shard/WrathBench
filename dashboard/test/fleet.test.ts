/**
 * The fleet table's contract: the columns it shows (never an account's name),
 * the state each row reads as, a cost marked when it is an estimate, the
 * heartbeat aged on the response's own clock, and progress only against a
 * run's own recorded budget.
 *
 * The header renders from `FLEET_COLUMNS` and the body from `fleetRows`, so
 * asserting on those is asserting on the table — which is what keeps this in
 * the pure layer instead of a DOM harness (dashboard/README.md).
 */

import { describe, expect, test } from "bun:test";
import type { RunListRow } from "../../viewer/api-types";
import type { FleetJobView, FleetResponse, FleetServerView } from "../../viewer/api-types-runner";
import type { FleetRow } from "../src/lib/fleet";
import {
  FLEET_COLUMNS,
  HEARTBEAT_STALE_MS,
  fleetRows,
  heartbeatAge,
  progressLabel,
  progressTitle,
  rowProgress,
  rowStateLabel,
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
      { account: "BOX", class: "pool", job: null },
      { account: "PAID", class: "pool", job: null },
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
    tps: { overall: 41.5, recent: 128.4, replies: 60, recentReplies: 10 },
    cost: { actual: { usd: 0.42, basis: "reported", note: "" } },
    ...over,
  } as unknown as RunListRow;
}

describe("columns", () => {
  test("state leads; one table carries the job, its account and the run it is driving", () => {
    expect([...FLEET_COLUMNS]).toEqual(["state", "job", "model", "episode", "account from", "attempt", "run", "lvl / xp", "tokens", "tok/s", "cost", "elapsed"]);
    // The process is bookkeeping, not something an operator scans a table for;
    // the source (file, queue, policy) maps to where its account came from and says nothing more.
    expect(FLEET_COLUMNS).not.toContain("pid");
    expect(FLEET_COLUMNS).not.toContain("lane");
    expect(FLEET_COLUMNS).not.toContain("source");
    expect(FLEET_COLUMNS).not.toContain("tier");
    // The name itself is never a column: the class is what a reader needs and
    // the name is an operator credential.
    expect(FLEET_COLUMNS).not.toContain("account");
  });
});

describe("row state", () => {
  // The table is ordered by state, so pick the job row out rather than trusting an index.
  const stateOf = (over: Partial<FleetJobView>): string => fleetRows(fleet({ jobs: [job(over)] }), []).find((r) => r.job !== null)!.state;

  test("a job driving a run is running; between episodes it is idle", () => {
    expect(stateOf({})).toBe("running");
    expect(stateOf({ runId: null })).toBe("idle");
  });

  test("a dead process reads as exited, and draining outranks running", () => {
    expect(stateOf({ alive: false })).toBe("exited");
    expect(stateOf({ draining: true })).toBe("draining");
    expect(stateOf({ alive: false, draining: true })).toBe("exited");
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
      cost: { usd: 0.42, text: "$0.420" },
      elapsedMs: 60_000,
    });
    // A run the runs feed has not caught up with still gets its row.
    expect(fleetRows(fleet(), [])[0]).toMatchObject({ level: null, xp: null, tokens: null, cost: { usd: null, text: "—" }, elapsedMs: null, tps: null });
  });

  test("cost is the actual where there is one, else the marked list-price estimate, else a blank", () => {
    const at = (r: RunListRow) => fleetRows(fleet(), [r])[0]!.cost;
    const none = { usd: null, basis: "none", note: "a subscription endpoint, so no actual" };
    // An OpenCode Go or codex run: no actual, the estimate with its tilde and the run page's line.
    expect(
      at(run({ cost: { actual: none, expected: { usd: 0.5, basis: "list-price", asIfMetered: true, asOf: "2026-11-01" } } } as unknown as Partial<RunListRow>)),
    ).toMatchObject({ usd: 0.5, estimate: true, text: "~$0.500", title: "expected, as-if-metered, 2026-11 prices · no actual\na subscription endpoint, so no actual" });
    // An unpriced model, or a row from a viewer that sent no estimate: a blank.
    expect(at(run({ cost: { actual: none } } as unknown as Partial<RunListRow>))).toMatchObject({ usd: null, estimate: false, text: "—" });
    expect(at(run({ cost: null } as Partial<RunListRow>))).toMatchObject({ usd: null, text: "—" });
    // A claude-code run's own figure is as-if-metered: an estimate, though reported.
    expect(
      at(run({ cost: { actual: { usd: 0.031, basis: "reported", asIfMetered: true, note: "the CLI's own" } } } as unknown as Partial<RunListRow>)),
    ).toMatchObject({ usd: 0.031, estimate: true, text: "~$0.031", title: "as-if-metered, the CLI's own total_cost_usd · no charge\nthe CLI's own" });
    // A reported actual shows as it always has.
    expect(at(run({ tokens: null } as Partial<RunListRow>))).toMatchObject({ usd: 0.42, estimate: false, text: "$0.420" });
  });
});

describe("the --status indicators", () => {
  /*
   * The clock the verdict is read on. Both readings come out of one response,
   * so a browser hours out of step — or a snapshot pushed a minute ago and
   * read from a CDN — sees the fleet the way the server saw it.
   */
  test("the heartbeat's age is the response's own clock, not the reader's", () => {
    /*
     * A healthy fleet, rendered once and then read late: a snapshot pushed a
     * minute ago, a CDN that held it another thirty seconds, a browser clock
     * an hour out of step. None of that is in the response, so none of it can
     * age the heartbeat — five seconds of silence stays five seconds however
     * long the reading takes to arrive. Ageing it against `Date.now()` in the
     * browser is what used to read a live fleet as dead.
     */
    const fresh = { heartbeatAt: 1_000_000 - 5_000, now: 1_000_000 };
    expect(heartbeatAge(fresh)).toBe(5_000);
    expect(supervisorAlive(fresh)).toBe(true);
    /*
     * A supervisor that really did stop is still caught: the viewer's clock
     * runs on and writes a newer `now` into every response while the
     * heartbeat stands still, so the gap widens inside the body.
     */
    const stopped = { heartbeatAt: 1_000_000, now: 1_000_000 + HEARTBEAT_STALE_MS };
    expect(heartbeatAge(stopped)).toBe(HEARTBEAT_STALE_MS);
    expect(supervisorAlive(stopped)).toBe(false);
    expect(heartbeatAge({ now: 1_000_000 })).toBe(null);
  });
});

describe("the deploy window (server-state.json)", () => {
  const at = new Date(2026, 7, 23, 18, 52).getTime();
  const server = (over: Partial<FleetServerView>): FleetServerView => ({ ...REST, since: at, build: "harness-0.4-52", ...over });

  test("a job whose process is gone and whose run is not held reads 'paused for deploy' inside the window, 'exited' outside it", () => {
    const gone = job({ alive: false, runId: null, model: null, exitCode: 0 });
    const jobRow = (f: FleetResponse): FleetRow => fleetRows(f, []).find((r) => r.job !== null)!;
    const inWindow = jobRow(fleet({ server: server({ phase: "waiting" }), jobs: [gone] }));
    expect(inWindow.state).toBe("paused-deploy");
    expect(rowStateLabel(inWindow.state)).toBe("paused for deploy");
    expect(inWindow.note).toContain("resumes it when the fleet starts");
    expect(jobRow(fleet({ jobs: [gone] })).state).toBe("exited");
    // A gone process still holding a run is not a paused run, whatever the phase.
    expect(jobRow(fleet({ server: server({ phase: "waiting" }), jobs: [job({ alive: false })] })).state).toBe("exited");
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
