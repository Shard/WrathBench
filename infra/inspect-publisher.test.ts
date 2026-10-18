/**
 * `bun wb inspect publisher` over a fixture state file: the engine's own
 * parse, versions per run, the scan's withheld paths by rule, the log's pass
 * lines, and one run's detail, each line bounded.
 */

import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { SEG_MS } from "../runner/viewer/trace";
import { report, run } from "./inspect-publisher";
import { emptyState, serializeState } from "./publish-core";
import { tempDirs } from "./temp-dirs";

const tmp = tempDirs();
const NOW = Date.UTC(2030, 0, 2, 12, 0, 0);
const T0 = Date.UTC(2030, 0, 2, 10, 0, 0);

function stateText(): string {
  const s = emptyState();
  s.runVersions = { "run-a": ["v1a", "v2a"], "run-b": ["v1b"] };
  s.uploaded = {
    "v1/run/run-a/v1a/detail.json": "h1",
    "v1/run/run-a/v2a/detail.json": "h2",
    "v1/run/run-a/v2a/entries.json": "h3",
    "v1/run/run-b/v1b/detail.json": "h4",
    "v1/manifest.json": "h5",
  };
  s.gens = ["g1", "g2"];
  s.lastGen = "g2";
  s.lastFlipAt = NOW - 120_000;
  s.traceSegs = { "run-a": [[T0, 3], [T0 + 10 * SEG_MS, 1]] };
  const withheld = Array.from({ length: 12 }, (_, i) => ({ path: `v1/run/run-${i === 0 ? "a" : `x${i}`}/v/detail.json`, findings: [{ rule: "known:session-token", count: 1 }] }));
  return serializeState({ ...s, secretScan: { at: NOW - 60_000, scanned: 40, withheld } });
}

const LOG = [
  "2030-01-02T11:50:00.000Z publish: gen g0 — 30 put, 10.0 KiB, 5 unchanged, 30 scanned clean, no flip",
  "2030-01-02T11:55:00.000Z publish: pass failed: a network error",
  "2030-01-02T11:58:00.000Z publish: gen g2 — 31 put, 11.0 KiB, 4 unchanged, 31 scanned clean, manifest flipped",
];

describe("the report", () => {
  test("says when, what flipped, versions per run, objects, traces and the scan", () => {
    const out = report(stateText(), NOW - 120_000, LOG, null, NOW);
    const at = (label: string): string => out.find((l) => l.startsWith(`${label} `)) ?? "";
    expect(at("state")).toContain("written 2030-01-02T11:58:00Z (2m ago)");
    expect(at("manifest")).toContain("gen g2");
    expect(at("manifest")).toContain("2 flip(s) on record");
    expect(at("runs")).toContain("2 with a published version (1 version 1, 2 versions 1)");
    expect(at("runs")).toContain("5 objects uploaded, 4 under v1/run/");
    expect(at("traces")).toContain("1 run(s) with trace segments, 4 window(s)");
    expect(at("scan")).toContain("40 bodies scanned, 12 withheld");
    expect(out.filter((l) => l.includes("withheld v1/run/")).length).toBe(10);
    expect(out.some((l) => l.includes("+2 more withheld"))).toBe(true);
    expect(out.some((l) => l.includes("known:session-token ×1"))).toBe(true);
    expect(out.filter((l) => l.includes("publish: gen")).length).toBe(2);
    expect(out.some((l) => l.includes("pass failed"))).toBe(true);
    for (const l of out) expect(l.length).toBeLessThanOrEqual(200);
  });

  test("one run: its versions, its objects, its trace windows and what was withheld of it", () => {
    const out = report(stateText(), null, [], "run-a", NOW);
    const at = (label: string): string => out.find((l) => l.startsWith(`${label} `)) ?? "";
    expect(at("run")).toContain("2 version(s), current v2a (older v1a)");
    expect(at("objects")).toContain("3 under v1/run/run-a/, 2 of them the current version's");
    expect(at("trace")).toContain("4 window(s), 2030-01-02T10:00:00Z → 2030-01-02T10:55:00Z, in 2 run(s)");
    expect(at("withheld")).toContain("v/detail.json: known:session-token ×1");
    expect(report(stateText(), null, [], "run-none", NOW).some((l) => l.includes("nothing published"))).toBe(true);
  });

  test("a state file that does not parse says so", () => {
    expect(report("{", null, [], null, NOW)).toEqual(["publisher: the state file does not parse"]);
  });

  test("--state reads a file here", async () => {
    const path = join(tmp("inspect-publisher-"), "state.json");
    writeFileSync(path, stateText());
    const out: string[] = [];
    const code = await run(["--state", path, "--passes", "0"], { out: (l) => out.push(l), err: () => {}, env: {} }, NOW);
    expect(code).toBe(0);
    expect(out[0]).toStartWith("state");
    expect(out.some((l) => l.startsWith("passes"))).toBe(false);
  });
});
