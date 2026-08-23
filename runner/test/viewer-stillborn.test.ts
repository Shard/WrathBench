/**
 * Stillborn runs: the definition, the listings that hide them, and the archive
 * that parks them.
 *
 * The tests that matter most are the two negatives. A run that answered once
 * and called no tool is a real run — the model spoke — and must never be swept
 * up; and a run whose files are warm is never moved, however stillborn it
 * looks, because the fleet may still be writing to it.
 */

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, existsSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApi } from "../viewer/api";
import { listRuns } from "../viewer/runs";
import { isStillborn, ARCHIVE_DIR } from "../viewer/stillborn";
import { scanRunTotals } from "../viewer/tail";
import { archiveRun, planStillborn, recentFleetRunIds } from "../src/archive";

const OLD = 1_600_000_000; // seconds; well outside any liveness window

/**
 * Write one run directory. `lines` is its whole trajectory. `warm` backdates it
 * five minutes: past the viewer's two-minute liveness window (so the run reads
 * as stillborn) but inside the archive's ten-minute hold (so it must not move).
 * That gap is exactly what the two thresholds are for.
 */
function run(runs: string, id: string, lines: object[], opts: { warm?: boolean } = {}): string {
  const dir = join(runs, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "meta.json"),
    JSON.stringify({
      runId: id,
      harnessVersion: "harness-test",
      startedAt: 1000,
      config: { model: "test/model", character: "Fixturely" },
      comparability: {
        harnessVersion: "harness-test",
        promptHash: "abc",
        promptChars: 10,
        harness: "wrathbench",
        effort: null,
        budget: {
          maxTurns: null,
          maxToolCalls: 1,
          idleMs: null,
          noXpMs: null,
          episodeMs: 5_400_000,
          maxSandboxRestarts: 1,
        },
        objective: false,
        episode: "e90",
        serverBuild: null,
      },
    }),
  );
  const path = join(dir, "trajectory.jsonl");
  writeFileSync(path, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  const when = opts.warm === true ? (Date.now() - 5 * 60_000) / 1000 : OLD;
  utimesSync(path, when, when);
  utimesSync(join(dir, "meta.json"), when, when);
  return dir;
}

const META = { ts: 1000, t: "meta", runId: "x" };
const RESPONSE = { ts: 1100, t: "response", turn: 1, message: { role: "assistant", content: "hi" } };

function fixture(): string {
  const runs = join(mkdtempSync(join(tmpdir(), "stillborn-")), "runs");
  mkdirSync(runs, { recursive: true });
  // Never answered: the provider was dead on the first request.
  run(runs, "dead-on-arrival", [META, { ts: 1050, t: "termination", reason: "adapter-error" }]);
  // Answered once, called nothing. A real run, and the case most easily broken.
  run(runs, "spoke-only", [META, RESPONSE]);
  // Answered and acted.
  run(runs, "worked", [META, RESPONSE, { ts: 1200, t: "tool_call", turn: 1, name: "eval_snippet" }]);
  return runs;
}

describe("the definition", () => {
  test("zero responses on a finished run is stillborn; live is not", () => {
    expect(isStillborn({ modelResponses: 0, live: false })).toBe(true);
    // A run launched thirty seconds ago has no response *yet*.
    expect(isStillborn({ modelResponses: 0, live: true })).toBe(false);
    expect(isStillborn({ modelResponses: 1, live: false })).toBe(false);
  });

  test("a response with no tool calls counts — snippets are not the signal", async () => {
    const runs = fixture();
    const spoke = await scanRunTotals(join(runs, "spoke-only", "trajectory.jsonl"));
    expect(spoke.modelResponses).toBe(1);
    expect(spoke.toolCalls).toBe(0);
    expect(isStillborn({ modelResponses: spoke.modelResponses, live: false })).toBe(false);
  });

  test("the claude driver's per-content-block records still count as one or more", async () => {
    const runs = fixture();
    // One API reply, two envelopes sharing a message id (adapter-claude.ts).
    run(runs, "claude-blocks", [
      META,
      { ts: 1100, t: "response", turn: 1, message: { role: "assistant", content: "thinking" } },
      { ts: 1101, t: "response", turn: 1, message: { role: "assistant", content: "acting" } },
    ]);
    const totals = await scanRunTotals(join(runs, "claude-blocks", "trajectory.jsonl"));
    expect(totals.modelResponses).toBeGreaterThanOrEqual(1);
    expect(isStillborn({ modelResponses: totals.modelResponses, live: false })).toBe(false);
  });
});

describe("the listings", () => {
  const get = async (runs: string, path: string): Promise<Record<string, unknown>> => {
    const handle = createApi({ runsDir: runs, tilesDir: join(runs, "..", "minimap"), moduleUrl: "http://127.0.0.1:1" });
    const res = await handle(new Request(`http://x${path}`));
    return (await res.json()) as Record<string, unknown>;
  };

  test("/api/runs hides stillborn by default and says how many", async () => {
    const runs = fixture();
    const body = await get(runs, "/api/runs");
    const rows = body["runs"] as { runId: string; stillborn: boolean; modelResponses: number | null }[];
    expect(rows.map((r) => r.runId).sort()).toEqual(["spoke-only", "worked"]);
    expect(body["stillbornExcluded"]).toBe(1);
    expect(rows.find((r) => r.runId === "spoke-only")?.modelResponses).toBe(1);
  });

  test("?includeStillborn=1 reveals them, flagged", async () => {
    const runs = fixture();
    const body = await get(runs, "/api/runs?includeStillborn=1");
    const rows = body["runs"] as { runId: string; stillborn: boolean }[];
    expect(rows.length).toBe(3);
    expect(rows.find((r) => r.runId === "dead-on-arrival")?.stillborn).toBe(true);
    expect(body["stillbornExcluded"]).toBe(1);
  });

  test("/api/eval and /api/episodes drop them from the counts", async () => {
    const runs = fixture();
    const ev = await get(runs, "/api/eval?episode=e90");
    expect((ev["runs"] as { runId: string }[]).map((r) => r.runId).sort()).toEqual([
      "spoke-only",
      "worked",
    ]);
    expect(ev["stillbornExcluded"]).toBe(1);
    const withThem = await get(runs, "/api/eval?episode=e90&includeStillborn=1");
    expect((withThem["runs"] as unknown[]).length).toBe(3);

    const eps = await get(runs, "/api/episodes");
    const e90 = (eps["episodes"] as { id: string; members: number }[]).find((e) => e.id === "e90");
    expect(e90?.members).toBe(2);
    expect(eps["stillbornExcluded"]).toBe(1);
  });
});

describe("the archive", () => {
  test("a dry-run plan names every stillborn run and only those", async () => {
    const runs = fixture();
    const plans = await planStillborn(runs);
    expect(plans.map((p) => p.runId)).toEqual(["dead-on-arrival"]);
    expect(plans[0]!.held).toBe(false);
    expect(plans[0]!.reason).toContain("0 model responses");
    // Planning is pure reading: nothing moved.
    expect(existsSync(join(runs, "dead-on-arrival"))).toBe(true);
    expect(existsSync(join(runs, ARCHIVE_DIR))).toBe(false);
  });

  test("a run whose files are warm is refused, with the reason", async () => {
    const runs = fixture();
    run(runs, "just-launched", [META], { warm: true });
    const plans = await planStillborn(runs);
    const held = plans.find((p) => p.runId === "just-launched");
    expect(held?.held).toBe(true);
    expect(held?.reason).toContain("may still be live");
  });

  test("a run a fleet lane named inside the window is refused", async () => {
    const runs = fixture();
    const now = Date.now();
    writeFileSync(
      join(runs, "fleet-lane-a.jsonl"),
      JSON.stringify({ ts: now - 60_000, runId: "dead-on-arrival", outcome: "started" }) + "\n",
    );
    expect(recentFleetRunIds(runs, now)).toContain("dead-on-arrival");
    const plans = await planStillborn(runs, now);
    expect(plans.find((p) => p.runId === "dead-on-arrival")?.held).toBe(true);
  });

  test("an old lane record does not hold a run forever", async () => {
    const runs = fixture();
    const now = Date.now();
    const log = join(runs, "fleet-lane-a.jsonl");
    writeFileSync(log, JSON.stringify({ ts: now - 86_400_000, runId: "dead-on-arrival" }) + "\n");
    expect(recentFleetRunIds(runs, now).size).toBe(0);
  });

  test("archiving moves the directory out of the listing and never overwrites", async () => {
    const runs = fixture();
    archiveRun(runs, "dead-on-arrival");
    expect(existsSync(join(runs, ARCHIVE_DIR, "dead-on-arrival", "trajectory.jsonl"))).toBe(true);
    // The archive directory itself is not a run, and what is inside it is gone
    // from every listing the viewer makes.
    expect(listRuns(runs).map((r) => r.runId).sort()).toEqual(["spoke-only", "worked"]);
    run(runs, "dead-on-arrival", [META]);
    expect(() => archiveRun(runs, "dead-on-arrival")).toThrow(/already archived/);
  });
});
