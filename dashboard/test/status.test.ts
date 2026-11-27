/**
 * The service status badge's contract: which colour and word the feed's
 * state derives to, and that its ages are read inside the response. Pure, so
 * the rules are asserted and not the DOM.
 */

import { describe, expect, test } from "bun:test";
import type { FleetResponse, FleetServerView } from "../../viewer/api-types-runner";
import { HEARTBEAT_STALE_MS } from "../src/lib/fleet";
import { serviceStatus, statusRows } from "../src/lib/status";

const NOW = 10_000_000;
const REST: FleetServerView = { phase: "running", since: 0, build: "harness-0.4-73", detail: "", updatedAt: 0 };

function fleet(over: Partial<FleetResponse> = {}): FleetResponse {
  return {
    present: true,
    server: REST,
    startedAt: NOW - 3_600_000,
    heartbeatAt: NOW - 5_000,
    jobs: [
      { name: "a", ref: "a", episode: "e90", account: "RUNNER", accountClass: "pool", source: "policy", models: ["m"], runId: "r1", model: "m", pid: 1, spawnedAt: 0, exitCode: null, draining: false, alive: true },
      { name: "b", ref: "b", episode: "e90", account: "RUNNER2", accountClass: "pool", source: "policy", models: ["m"], runId: null, model: null, pid: 2, spawnedAt: 0, exitCode: null, draining: false, alive: true },
      { name: "c", ref: "c", episode: "e90", account: "RUNNER3", accountClass: "pool", source: "policy", models: ["m"], runId: null, model: null, pid: 3, spawnedAt: 0, exitCode: 0, draining: false, alive: false },
    ],
    accounts: [
      { account: "RUNNER", class: "pool", job: "a" },
      { account: "RUNNER2", class: "pool", job: "b" },
      { account: "RUNNER3", class: "pool", job: null },
      { account: "PAID", class: "pool", job: null },
      { account: "BOX", class: "pool", job: null },
      { account: "PIN", class: "pinned", job: "x" },
    ],
    paused: [],
    ended: [],
    outstanding: { lower: 11, upper: 23, etaLowerMs: 4 * 3_600_000, etaUpperMs: 9 * 3_600_000, breakdown: [] },
    now: NOW,
    ...over,
  };
}

const status = (f: FleetResponse | undefined, error?: unknown) => serviceStatus({ fleet: f, error, stalled: false });

describe("serviceStatus", () => {
  test("an API error is red and unreachable, whatever the last value said", () => {
    expect(status(fleet(), new Error("502"))).toEqual({ tone: "red", word: "unreachable" });
    expect(status(undefined, new Error("502"))).toEqual({ tone: "red", word: "unreachable" });
  });

  test("a fresh heartbeat is green running; past three ticks it is stale; none at all is down", () => {
    expect(status(fleet())).toEqual({ tone: "green", word: "running" });
    expect(status(fleet({ heartbeatAt: NOW - HEARTBEAT_STALE_MS + 1 })).tone).toBe("green");
    expect(status(fleet({ heartbeatAt: NOW - HEARTBEAT_STALE_MS }))).toEqual({ tone: "red", word: "stale" });
    const { heartbeatAt: _, ...noHb } = fleet();
    expect(status(noHb)).toEqual({ tone: "red", word: "down" });
  });

  /*
   * The stall is the hole the two clocks leave between them: a fetch that
   * never settles produces neither a value nor an error, and every age the
   * badge shows is inside the frozen response — so without this state the last
   * word would stand forever. Its own word, not "stale": that one is the
   * supervisor's heartbeat, measured on the server's clock, and the two must
   * not be conflated.
   */
  test("a stalled feed is red and says so, whatever the frozen value would derive to", () => {
    expect(serviceStatus({ fleet: fleet(), error: undefined, stalled: true })).toEqual({ tone: "red", word: "stalled" });
    // A hanging FIRST fetch is a stall too, not an eternal "loading".
    expect(serviceStatus({ fleet: undefined, error: undefined, stalled: true })).toEqual({ tone: "red", word: "stalled" });
    // A settled failure is the reachability rule's, which outranks it.
    expect(serviceStatus({ fleet: fleet(), error: new Error("502"), stalled: true })).toEqual({ tone: "red", word: "unreachable" });
  });
});

describe("statusRows", () => {
  const value = (rows: { label: string; value: string }[], label: string): string => rows.find((r) => r.label === label)!.value;

  /*
   * Every age in the popout is a span between two readings taken on the
   * server. A response the reader gets late — a snapshot pushed a minute ago
   * and served from a CDN — must not read as a minute more silence and an
   * extra minute of uptime.
   */
  test("the heartbeat and uptime rows are spans inside the response, not against the reader's clock", () => {
    // The fixture's heartbeat is 5s old and its supervisor an hour up, both
    // measured against the body's own `now`. Nothing outside the body moves them.
    const rows = statusRows({ fleet: fleet(), error: undefined, stalled: false }, undefined);
    expect(value(rows, "heartbeat")).toBe("5s ago");
    expect(value(rows, "uptime")).toBe("1h00m");
    /*
     * Advancing only the response's clock is what real silence looks like: the
     * viewer keeps stamping a newer `now` while the supervisor's heartbeat
     * stands still, so the gap widens inside the body and the badge says so.
     */
    const late = fleet({ now: NOW + 600_000 });
    expect(value(statusRows({ fleet: late, error: undefined, stalled: false }, undefined), "heartbeat")).toBe("10m05s ago (stale)");
    expect(serviceStatus({ fleet: late, error: undefined, stalled: false })).toEqual({ tone: "red", word: "stale" });
  });
});
