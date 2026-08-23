/**
 * The lane table's contract: the columns it shows, in the order it shows them,
 * and the click-through into the run a lane is holding.
 *
 * The header renders from `FLEET_COLUMNS`, so asserting on the constant is
 * asserting on the table — which is what keeps this in the pure layer instead
 * of a DOM harness (dashboard/README.md).
 */

import { describe, expect, test } from "bun:test";
import type { FleetJobView, FleetLaneView } from "../../runner/viewer/api-types";
import { FLEET_COLUMNS, JOB_COLUMNS, jobModelLabel, laneModelLabel, laneModelTitle, laneRunHref, laneState } from "../src/lib/fleet";

function lane(over: Partial<FleetLaneView> = {}): FleetLaneView {
  return {
    name: "ox-alpha",
    pid: 13,
    account: "RUNNER",
    rosterPath: "data/runs/fleet-ox-alpha.roster.json",
    jsonl: "j",
    stdoutLog: "l",
    spawnedAt: 1,
    exitCode: null,
    draining: false,
    alive: true,
    runId: "fleet-ox-alpha-20260822",
    model: "stealth/ox-alpha",
    rosterModels: ["stealth/ox-alpha"],
    ...over,
  };
}

describe("columns", () => {
  test("state leads, then lane and model, and there is no pid column", () => {
    expect([...FLEET_COLUMNS]).toEqual(["state", "lane", "model", "account", "spawned", "exit"]);
    expect(FLEET_COLUMNS).not.toContain("pid");
  });
});

describe("the job table (FOLLOW-UPS 52)", () => {
  const job = (over: Partial<FleetJobView> = {}): FleetJobView => ({
    name: "sonnet-e90",
    ref: "sonnet",
    episode: "e90",
    account: "RUNNER",
    source: "policy",
    models: ["sonnet"],
    ...over,
  });

  test("the job name leads, and where the job came from is a column", () => {
    expect([...JOB_COLUMNS]).toEqual([
      "job", "models", "episode", "account", "source", "attempt", "resuming",
    ]);
  });

  test("the model cell truncates the way a lane's roster does", () => {
    expect(jobModelLabel(job())).toBe("sonnet");
    expect(jobModelLabel(job({ models: ["a", "b", "c", "d"] }))).toBe("a, b +2");
  });

  test("a job whose models did not resolve is called by its ref", () => {
    expect(jobModelLabel(job({ ref: "a+b", models: [] }))).toBe("a+b");
  });
});

describe("state", () => {
  test("a dead lane reads exited whatever else it says", () => {
    expect(laneState(lane({ alive: false, draining: true }))).toBe("exited");
  });
  test("draining outranks running", () => {
    expect(laneState(lane({ draining: true }))).toBe("draining");
  });
  test("a live lane holding no run is idle, not running", () => {
    expect(laneState(lane({ runId: null, model: null }))).toBe("idle");
  });
  test("a live lane holding a run is running", () => {
    expect(laneState(lane())).toBe("running");
  });
});

describe("the link into the held run", () => {
  test("a held run becomes a /run/:id href, encoded like the runs table", () => {
    expect(laneRunHref(lane())).toBe("/run/fleet-ox-alpha-20260822");
    expect(laneRunHref(lane({ runId: "a b/c" }))).toBe("/run/a%20b%2Fc");
  });
  test("an idle lane has nowhere to click through to", () => {
    expect(laneRunHref(lane({ runId: null }))).toBeNull();
  });
});

describe("the model cell", () => {
  test("a running lane shows its run's model, and names the run on hover", () => {
    expect(laneModelLabel(lane())).toBe("stealth/ox-alpha");
    expect(laneModelTitle(lane())).toBe("fleet-ox-alpha-20260822");
  });
  test("an idle lane shows its roster instead, truncated past two", () => {
    const idle = lane({ runId: null, model: null, rosterModels: ["a", "b", "c", "d"] });
    expect(laneModelLabel(idle)).toBe("a, b +2");
    expect(laneModelTitle(idle)).toBe("a, b, c, d");
    expect(laneModelLabel(lane({ runId: null, model: null, rosterModels: ["a", "b"] }))).toBe("a, b");
  });
  test("a lane with neither gets the dash every missing value gets", () => {
    expect(laneModelLabel(lane({ runId: null, model: null, rosterModels: [] }))).toBe("—");
  });
});
