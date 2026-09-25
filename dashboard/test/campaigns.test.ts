/**
 * The campaigns page's live-run join: which runs belong to a campaign, what
 * the supervisor says about each, and what happens when the two feeds disagree.
 *
 * The pane renders straight off `campaignLiveRuns`, so asserting on it is
 * asserting on what the page lists (dashboard/README.md keeps the components
 * out of the tests and the maths in here).
 */

import { describe, expect, test } from "bun:test";
import type { CostFigure, CostView, FleetJobView, FleetResponse, RunListRow } from "../../runner/viewer/api-types";
import { campaignCosts, campaignLiveRuns, progressOf } from "../src/lib/campaigns";
import { rowProgress } from "../src/lib/fleet";

function job(over: Partial<FleetJobView> = {}): FleetJobView {
  return {
    name: "nav-probe-coldridge",
    ref: "sonnet",
    episode: "probing",
    account: "SHAKEOUT",
    accountClass: "pinned",
    source: "pinned",
    attempt: 1,
    models: ["sonnet"],
    runId: "fleet-nav-probe-coldridge-sonnet-20260824",
    model: "sonnet",
    pid: 97,
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
    server: { phase: "running", since: 0, build: "", detail: "", updatedAt: 0 },
    jobs: [job()],
    accounts: [{ account: "SHAKEOUT", class: "pinned", job: "nav-probe-coldridge" }],
    paused: [],
    ended: [],
    session: { finished: 0, ok: 0, retried: 0 },
    now: 1000,
    ...over,
  };
}

function run(over: Partial<RunListRow> = {}): RunListRow {
  return {
    runId: "fleet-nav-probe-coldridge-sonnet-20260824",
    model: "sonnet",
    character: "Grimbold",
    campaign: "nav-probe",
    cell: "coldridge",
    level: 6,
    xp: 1200,
    playtimeMs: 600_000,
    terminationReason: null,
    comparability: { budget: { episodeMs: 1_200_000 } },
    ...over,
  } as unknown as RunListRow;
}

describe("membership", () => {
  test("a live probe is listed under its campaign, with what the supervisor says about it", () => {
    const by = campaignLiveRuns(fleet(), [run()]);
    expect([...by.keys()]).toEqual(["nav-probe"]);
    expect(by.get("nav-probe")![0]).toEqual({
      runId: "fleet-nav-probe-coldridge-sonnet-20260824",
      cell: "coldridge",
      character: "Grimbold",
      model: "sonnet",
      level: 6,
      xp: 1200,
      elapsedMs: 600_000,
      budgetMs: 1_200_000,
      state: "running",
      account: "SHAKEOUT",
      attempt: 1,
    });
  });

  test("a pinned campaign's job carries no attempt, which is a null and not a gap", () => {
    // What the supervisor actually serves for a pinned probe: `attempt` is a
    // policy job's retry counter and a pinned campaign has none.
    const pinned = job();
    delete pinned.attempt;
    const row = campaignLiveRuns(fleet({ jobs: [pinned] }), [run()]).get("nav-probe")![0]!;
    expect(row.attempt).toBeNull();
    expect(row.state).toBe("running");
  });

  test("an ended run is not live, whatever the fleet still remembers — the same rule the header's count uses", () => {
    const by = campaignLiveRuns(fleet(), [run({ terminationReason: "episode-limit" })]);
    expect(by.size).toBe(0);
  });

  test("a run with no campaign is not a probe and reaches no pane", () => {
    expect(campaignLiveRuns(fleet(), [run({ campaign: null, cell: null })]).size).toBe(0);
  });

  test("the join is by run id, never by job name: a probe launched by policy carries neither campaign nor cell in its job name", () => {
    const f = fleet({ jobs: [job({ name: "sonnet-probing", ref: "sonnet", source: "policy" })] });
    expect(campaignLiveRuns(f, [run()]).get("nav-probe")![0]!.state).toBe("running");
  });

  test("each campaign gets its own list, and the rows sort by cell then run id", () => {
    const by = campaignLiveRuns(fleet(), [
      run({ runId: "b", cell: "loch", campaign: "nav-probe", terminationReason: null }),
      run({ runId: "a", cell: "loch", campaign: "nav-probe", terminationReason: null }),
      run({ runId: "c", cell: "coldridge", campaign: "nav-probe", terminationReason: null }),
      run({ runId: "d", cell: "gnome-mage", campaign: "class-probe", terminationReason: null }),
    ]);
    expect(by.get("nav-probe")!.map((r) => r.runId)).toEqual(["c", "a", "b"]);
    expect(by.get("class-probe")!.map((r) => r.runId)).toEqual(["d"]);
  });
});

describe("a run no job holds", () => {
  // The honest reading of an orphan: the runs feed says it never terminated,
  // the supervisor has no process for it. Defaulting it to "running" would be
  // a claim the fleet is not making.
  test("keeps state null rather than reading as running", () => {
    const by = campaignLiveRuns(fleet({ jobs: [] }), [run()]);
    expect(by.get("nav-probe")![0]).toMatchObject({ state: null, account: null, attempt: null });
  });

  test("and has no progress to show, because nothing says its clock is advancing", () => {
    const row = campaignLiveRuns(fleet({ jobs: [] }), [run()]).get("nav-probe")![0]!;
    expect(progressOf(row)).toBeNull();
  });
});

describe("no fleet to join against", () => {
  // The page must still list what the runs feed knows: a first paint before the
  // shared fleet poll has answered, or a machine the fleet has never run on.
  test("an unpolled or absent fleet lists the runs with no state", () => {
    for (const f of [undefined, { present: false } as unknown as FleetResponse]) {
      const rows = campaignLiveRuns(f, [run()]).get("nav-probe")!;
      expect(rows).toHaveLength(1);
      expect(rows[0]!.state).toBeNull();
      expect(rows[0]!.level).toBe(6);
    }
  });
});

describe("progress", () => {
  test("reuses the fleet's ETA maths: elapsed against the run's own recorded watchdog", () => {
    const row = campaignLiveRuns(fleet(), [run()]).get("nav-probe")![0]!;
    expect(rowProgress(progressOf(row)!)).toEqual({ pct: 50, remainingMs: 600_000, overMs: null });
  });

  test("a draining probe is still advancing; a run with no recorded budget shows none", () => {
    const draining = campaignLiveRuns(fleet({ jobs: [job({ draining: true })] }), [run()]).get("nav-probe")![0]!;
    expect(draining.state).toBe("draining");
    expect(rowProgress(progressOf(draining)!)!.pct).toBe(50);

    const noBudget = campaignLiveRuns(fleet(), [run({ comparability: null })]).get("nav-probe")![0]!;
    expect(rowProgress(progressOf(noBudget)!)).toBeNull();
  });
});

/*
 * The pane header's cost: provider-billed `actual` figures summed per campaign,
 * with the coverage beside them. Typed figures rather than a cast, so a renamed
 * field breaks the typecheck instead of quietly summing nothing.
 */
function figure(over: Partial<CostFigure> = {}): CostFigure {
  return { usd: null, basis: "none", asIfMetered: false, breakdown: null, priceId: null, asOf: null, note: "", ...over };
}

/** A cost view whose top level is the list-price estimate, as the viewer serves it. */
function costView(actual: CostFigure, expectedUsd = 9.99): CostView {
  const expected = figure({ usd: expectedUsd, basis: "list-price", priceId: "p", asOf: "2026-09-01" });
  return { ...expected, actual, expected };
}

const billed = (usd: number): CostView => costView(figure({ usd, basis: "reported" }));

describe("campaign cost", () => {
  test("billed figures are summed, and the coverage counts every run of the campaign", () => {
    const c = campaignCosts([
      run({ runId: "a", cost: billed(1.25) }),
      run({ runId: "b", cost: billed(0.5), terminationReason: "episode-limit" }),
      run({ runId: "c", cost: costView(figure()) }),
    ]).get("nav-probe")!;
    expect(c).toEqual({ actualUsd: 1.75, reported: 2, asIfMetered: 0, runs: 3 });
  });

  test("the estimate on the view's top level is never read: an unreported run adds nothing", () => {
    const c = campaignCosts([run({ cost: costView(figure(), 42) })]).get("nav-probe")!;
    expect(c.actualUsd).toBeNull();
    expect(c.reported).toBe(0);
  });

  test("a subscription's as-if-metered figure is counted beside the sum, never in it", () => {
    const c = campaignCosts([
      run({ runId: "a", cost: billed(2) }),
      run({ runId: "b", cost: costView(figure({ usd: 30, basis: "reported", asIfMetered: true })) }),
    ]).get("nav-probe")!;
    expect(c).toEqual({ actualUsd: 2, reported: 1, asIfMetered: 1, runs: 2 });
  });

  test("a codex run's as-if-metered estimate lives on `expected` and reaches neither count", () => {
    const codex: CostView = {
      ...figure({ usd: 12, basis: "list-price", asIfMetered: true }),
      actual: figure(),
      expected: figure({ usd: 12, basis: "list-price", asIfMetered: true }),
    };
    expect(campaignCosts([run({ cost: codex })]).get("nav-probe")).toEqual({
      actualUsd: null,
      reported: 0,
      asIfMetered: 0,
      runs: 1,
    });
  });

  test("an unreadable run counts in the denominator only", () => {
    const c = campaignCosts([run({ runId: "a", cost: null }), run({ runId: "b", cost: billed(3) })]).get("nav-probe")!;
    expect(c).toEqual({ actualUsd: 3, reported: 1, asIfMetered: 0, runs: 2 });
  });

  test("no report is null, and a reported $0 is zero — two different claims", () => {
    expect(campaignCosts([run({ cost: costView(figure()) })]).get("nav-probe")!.actualUsd).toBeNull();
    expect(campaignCosts([run({ cost: billed(0) })]).get("nav-probe")!.actualUsd).toBe(0);
  });

  test("each campaign sums its own runs, and a run with no campaign reaches none", () => {
    const by = campaignCosts([
      run({ runId: "a", campaign: "nav-probe", cost: billed(1) }),
      run({ runId: "b", campaign: "class-probe", cost: billed(4) }),
      run({ runId: "c", campaign: null, cell: null, cost: billed(100) }),
    ]);
    expect([...by.keys()].sort()).toEqual(["class-probe", "nav-probe"]);
    expect(by.get("nav-probe")!.actualUsd).toBe(1);
    expect(by.get("class-probe")!.actualUsd).toBe(4);
  });
});
