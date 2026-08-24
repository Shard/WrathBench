/**
 * The campaigns page's live-run join: which runs belong to a campaign, what
 * the supervisor says about each, and what happens when the two feeds disagree.
 *
 * The pane renders straight off `campaignLiveRuns`, so asserting on it is
 * asserting on what the page lists (dashboard/README.md keeps the components
 * out of the tests and the maths in here).
 */

import { describe, expect, test } from "bun:test";
import type { FleetJobView, FleetResponse, RunListRow } from "../../runner/viewer/api-types";
import { campaignLiveRuns, progressOf } from "../src/lib/campaigns";
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
