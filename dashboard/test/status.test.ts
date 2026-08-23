/**
 * The service status badge's contract: which colour and word the feed's
 * state derives to, and which rows the popout lists. Pure, like the fleet
 * table's tests (dashboard/README.md), so the rules are asserted and not the
 * DOM.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { FleetResponse, FleetServerView } from "../../runner/viewer/api-types";
import { HEARTBEAT_STALE_MS } from "../src/lib/fleet";
import { accountsBusy, serviceStatus, statusRows } from "../src/lib/status";

const NOW = 10_000_000;
const REST: FleetServerView = { phase: "running", since: 0, build: "harness-0.4-73", detail: "", updatedAt: 0 };
const server = (over: Partial<FleetServerView>): FleetServerView => ({ ...REST, ...over });

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
      { account: "PAID", class: "paid", job: null },
      { account: "BOX", class: "local", job: null },
      { account: "PIN", class: "pinned", job: "x" },
    ],
    paused: [],
    ended: [],
    outstanding: { lower: 11, upper: 23, etaLowerMs: 4 * 3_600_000, etaUpperMs: 9 * 3_600_000, breakdown: [] },
    now: NOW,
    ...over,
  };
}

const status = (f: FleetResponse | undefined, error?: unknown) => serviceStatus({ fleet: f, error }, NOW);

describe("serviceStatus", () => {
  test("an API error is red and unreachable, whatever the last value said", () => {
    expect(status(fleet(), new Error("502"))).toEqual({ tone: "red", word: "unreachable" });
    expect(status(undefined, new Error("502"))).toEqual({ tone: "red", word: "unreachable" });
  });

  test("nothing yet is grey; a machine the fleet never ran on is down", () => {
    expect(status(undefined)).toEqual({ tone: "grey", word: "loading" });
    expect(status(fleet({ present: false }))).toEqual({ tone: "red", word: "down" });
  });

  test("a fresh heartbeat is green running; past three ticks it is stale; none at all is down", () => {
    expect(status(fleet())).toEqual({ tone: "green", word: "running" });
    expect(status(fleet({ heartbeatAt: NOW - HEARTBEAT_STALE_MS + 1 })).tone).toBe("green");
    expect(status(fleet({ heartbeatAt: NOW - HEARTBEAT_STALE_MS }))).toEqual({ tone: "red", word: "stale" });
    const { heartbeatAt: _, ...noHb } = fleet();
    expect(status(noHb)).toEqual({ tone: "red", word: "down" });
  });

  test("a deploy window is yellow with the phase word; once the fleet's heartbeat is gone it is paused for deploy", () => {
    for (const phase of ["draining", "swapping", "verifying", "resuming"] as const) {
      expect(status(fleet({ server: server({ phase }) }))).toEqual({ tone: "yellow", word: phase });
      expect(status(fleet({ server: server({ phase }), heartbeatAt: 0 }))).toEqual({ tone: "yellow", word: "paused for deploy" });
    }
  });

  test("a deploy verdict is red and outranks the heartbeat", () => {
    expect(status(fleet({ server: server({ phase: "failed" }) }))).toEqual({ tone: "red", word: "failed" });
    expect(status(fleet({ server: server({ phase: "rolled-back" }) }))).toEqual({ tone: "red", word: "rolled back" });
  });
});

describe("statusRows", () => {
  const labels = (rows: { label: string }[]): string[] => rows.map((r) => r.label);
  const value = (rows: { label: string; value: string }[], label: string): string => rows.find((r) => r.label === label)!.value;

  test("at rest: heartbeat, jobs, exhaust, uptime, harness, accounts — and nothing else", () => {
    const rows = statusRows({ fleet: fleet(), error: undefined }, undefined, NOW);
    expect(labels(rows)).toEqual(["heartbeat", "jobs", "exhaust", "uptime", "harness", "accounts"]);
    expect(value(rows, "heartbeat")).toBe("5s ago");
    expect(rows[0]!.title).toBe(new Date(NOW - 5_000).toLocaleString());
    expect(value(rows, "jobs")).toBe("1 / 11–23");
    expect(rows[1]!.labelTitle).toContain("outstanding scheduled runs");
    expect(value(rows, "exhaust")).toBe("4h–9h");
    expect(value(rows, "uptime")).toBe("1h00m");
    expect(value(rows, "harness")).toBe("harness-0.4-73");
    expect(rows.find((r) => r.label === "accounts")!.lines).toEqual(["pool 2/3", "paid 0/1", "local 0/1"]);
  });

  test("a stale heartbeat says so in the row; missing facts say unknown rather than vanish", () => {
    const { startedAt: _s, outstanding: _o, ...bare } = fleet({ heartbeatAt: NOW - HEARTBEAT_STALE_MS });
    const rows = statusRows({ fleet: bare, error: undefined }, undefined, NOW);
    expect(value(rows, "heartbeat")).toBe("3m00s ago (stale)");
    expect(value(rows, "jobs")).toBe("1 / unknown");
    expect(value(rows, "exhaust")).toBe("unknown");
    expect(value(rows, "uptime")).toBe("unknown");
    expect(value(statusRows({ fleet: fleet({ outstanding: { lower: 0, upper: 0, etaLowerMs: 0, etaUpperMs: 0, breakdown: [] } }), error: undefined }, undefined, NOW), "jobs")).toBe("1 / exhausted");
  });

  test("the deploy detail appears only while not running; the worldserver's build only when it differs", () => {
    const info = { service: "wrathbench-viewer" as const, publicMode: false, dashboard: true, worldserver: { build: "harness-0.4-73", startedAtMs: 1 }, now: NOW };
    expect(labels(statusRows({ fleet: fleet(), error: undefined }, info, NOW))).not.toContain("worldserver");
    const other = { ...info, worldserver: { build: "harness-0.4-70", startedAtMs: 1 } };
    const rows = statusRows({ fleet: fleet({ server: server({ phase: "verifying", detail: "smoke 1 of 2" }) }), error: undefined }, other, NOW);
    expect(labels(rows)).toEqual(["heartbeat", "jobs", "exhaust", "uptime", "harness", "worldserver", "verifying", "accounts"]);
    expect(value(rows, "verifying")).toBe("smoke 1 of 2");
    expect(value(rows, "worldserver")).toBe("harness-0.4-70");
  });

  test("with no fleet state the rows say why; an error is its own row", () => {
    expect(statusRows({ fleet: undefined, error: undefined }, undefined, NOW)).toEqual([{ label: "api", value: "loading" }]);
    expect(statusRows({ fleet: undefined, error: new Error("502") }, undefined, NOW)[0]!.value).toContain("502");
    const rows = statusRows({ fleet: fleet({ present: false, server: server({ build: "" }) }), error: undefined }, undefined, NOW);
    expect(labels(rows)).toEqual(["fleet", "harness"]);
    expect(value(rows, "harness")).toBe("unknown");
    expect(statusRows({ fleet: fleet(), error: new Error("502") }, undefined, NOW)[0]!.label).toBe("api");
  });

  test("accounts busy counts alive jobs per schedulable class; pinned is not a class here", () => {
    expect(accountsBusy({ accounts: [], jobs: [] })).toEqual(["none"]);
    expect(accountsBusy(fleet())).toEqual(["pool 2/3", "paid 0/1", "local 0/1"]);
  });
});

describe("the fleet page", () => {
  test("carries no stats strip: the table is the page and the badge carries the service", () => {
    const src = readFileSync(join(import.meta.dir, "../src/pages/Fleet.tsx"), "utf8");
    expect(src).not.toContain('class="strip"');
    expect(src).not.toContain("supervisorLabel");
    expect(src).not.toContain("outstandingLabel");
    expect(src).not.toContain("accountClassSummary");
    expect(src).toContain("useFeeds");
    expect(readFileSync(join(import.meta.dir, "../src/styles.css"), "utf8")).not.toContain(".strip");
  });
});
