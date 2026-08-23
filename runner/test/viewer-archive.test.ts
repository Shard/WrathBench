/**
 * The archive: what the runner parks as it exits, what the series floor parks
 * afterwards, and what the listings do about it.
 *
 * The tests that matter most are the negatives. A run that answered once and
 * called no tool is a real run — the model spoke — and must never be moved; a
 * run that is *paused* with no response yet is a launch still in progress, and
 * moving it would bury resumable work; and a run whose files are warm is never
 * moved by the CLI, because the fleet may still be writing to it.
 */

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, existsSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApi } from "../viewer/api";
import { listRuns } from "../viewer/runs";
import { ARCHIVE_DIR } from "../viewer/archive-dir";
import { scanRunTotals } from "../viewer/tail";
import { archiveIfNoResponses, archiveRun, inSeries, planPreSeries, recentFleetRunIds } from "../src/archive";
import { readRunFacts } from "../src/models";

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

describe("the runner's own archive (zero responses at termination)", () => {
  test("a terminated run with no response is moved; one that spoke is not", async () => {
    const runs = fixture();
    expect(archiveIfNoResponses(runs, "dead-on-arrival")).toBe(join(runs, ARCHIVE_DIR, "dead-on-arrival"));
    expect(existsSync(join(runs, ARCHIVE_DIR, "dead-on-arrival", "trajectory.jsonl"))).toBe(true);
    // Answered once, called nothing: a real run, and the case most easily broken.
    const spoke = await scanRunTotals(join(runs, "spoke-only", "trajectory.jsonl"));
    expect(spoke.modelResponses).toBe(1);
    expect(spoke.toolCalls).toBe(0);
    expect(archiveIfNoResponses(runs, "spoke-only")).toBeNull();
    // The claude driver writes one record per content block: still not zero.
    run(runs, "claude-blocks", [
      META,
      { ts: 1100, t: "response", turn: 1, message: { role: "assistant", content: "thinking" } },
      { ts: 1101, t: "response", turn: 1, message: { role: "assistant", content: "acting" } },
    ]);
    expect(archiveIfNoResponses(runs, "claude-blocks")).toBeNull();
    // A trajectory that cannot be read is not a claim that nothing happened.
    expect(archiveIfNoResponses(runs, "no-such-run")).toBeNull();
  });

  test("the listings never see it; the scheduler's projection still does", () => {
    const runs = fixture();
    archiveIfNoResponses(runs, "dead-on-arrival");
    expect(listRuns(runs).map((r) => r.runId).sort()).toEqual(["spoke-only", "worked"]);
    // The ladder is made of launches that did not happen, and the attempt
    // numbers have to stay unique on disk, so the projection reads the archive.
    expect(readRunFacts(runs).map((f) => f.runId).sort()).toEqual(["spoke-only", "worked"]);
    expect(readRunFacts(runs, Date.now(), { includeArchived: true }).map((f) => f.runId).sort()).toEqual([
      "dead-on-arrival",
      "spoke-only",
      "worked",
    ]);
  });
});

describe("the listings", () => {
  const get = async (runs: string, path: string): Promise<Record<string, unknown>> => {
    const handle = createApi({ runsDir: runs, tilesDir: join(runs, "..", "minimap"), moduleUrl: "http://127.0.0.1:1" });
    const res = await handle(new Request(`http://x${path}`));
    return (await res.json()) as Record<string, unknown>;
  };

  test("every run on disk is listed — there is no zero-response filter left", async () => {
    const runs = fixture();
    const body = await get(runs, "/api/runs");
    const rows = body["runs"] as { runId: string; modelResponses: number | null }[];
    expect(rows.map((r) => r.runId).sort()).toEqual(["dead-on-arrival", "spoke-only", "worked"]);
    expect(rows.find((r) => r.runId === "spoke-only")?.modelResponses).toBe(1);
    expect("stillbornExcluded" in body).toBe(false);
  });

  test("/api/eval and /api/episodes count what is on disk, and skip the archive", async () => {
    const runs = fixture();
    archiveIfNoResponses(runs, "dead-on-arrival");
    const ev = await get(runs, "/api/eval?episode=e90");
    expect((ev["runs"] as { runId: string }[]).map((r) => r.runId).sort()).toEqual(["spoke-only", "worked"]);
    const eps = await get(runs, "/api/episodes");
    const e90 = (eps["episodes"] as { id: string; members: number }[]).find((e) => e.id === "e90");
    expect(e90?.members).toBe(2);
  });
});

describe("the archive directory", () => {
  test("archiving moves the directory out of the listing and never overwrites", () => {
    const runs = fixture();
    archiveRun(runs, "dead-on-arrival");
    expect(existsSync(join(runs, ARCHIVE_DIR, "dead-on-arrival", "trajectory.jsonl"))).toBe(true);
    expect(listRuns(runs).map((r) => r.runId).sort()).toEqual(["spoke-only", "worked"]);
    run(runs, "dead-on-arrival", [META]);
    expect(() => archiveRun(runs, "dead-on-arrival")).toThrow(/already archived/);
  });

  test("a fleet job log names what it recently started; an old record holds nothing", () => {
    const runs = fixture();
    const now = Date.now();
    const log = join(runs, "fleet-job-a.jsonl");
    writeFileSync(log, JSON.stringify({ ts: now - 60_000, runId: "dead-on-arrival", outcome: "started" }) + "\n");
    expect(recentFleetRunIds(runs, now)).toContain("dead-on-arrival");
    writeFileSync(log, JSON.stringify({ ts: now - 86_400_000, runId: "dead-on-arrival" }) + "\n");
    expect(recentFleetRunIds(runs, now).size).toBe(0);
  });
});

describe("the series floor", () => {
  test("only a clean build of the series is in it", () => {
    expect(inSeries("harness-0.4", "0.4")).toBe(true);
    expect(inSeries("harness-0.4-25-g1fe3951", "0.4")).toBe(true);
    expect(inSeries("harness-0.4-25-g1fe3951-dirty", "0.4")).toBe(true);
    expect(inSeries("harness-0.3-145-gd75e9f4", "0.4")).toBe(false);
    expect(inSeries("harness-0.40", "0.4")).toBe(false);
    expect(inSeries("3c4a124-dirty", "0.4")).toBe(false);
    expect(inSeries("0.0.0-phase0-unversioned", "0.4")).toBe(false);
    expect(inSeries(null, "0.4")).toBe(false);
  });

  test("a plan parks what is below the floor, and releases a parked pause only when asked", () => {
    const runs = fixture();
    const stamp = (id: string, harnessVersion: string, pause?: object) => {
      const path = join(runs, id, "meta.json");
      const meta = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
      const { mtimeMs } = statSync(path);
      writeFileSync(path, JSON.stringify({ ...meta, harnessVersion, ...(pause ? { pause } : {}) }));
      // Restamping is not activity: keep whatever age the fixture gave it.
      utimesSync(path, mtimeMs / 1000, mtimeMs / 1000);
    };
    stamp("worked", "harness-0.4-3-gabc");
    stamp("spoke-only", "harness-0.3-9-gdef");
    run(runs, "parked", [META], { warm: true });
    stamp("parked", "harness-0.3-7-gfed-dirty", { reason: "rate-limited", at: 1 });

    const plans = planPreSeries(runs, "0.4");
    const byId = new Map(plans.map((p) => [p.runId, p]));
    expect(byId.has("worked")).toBe(false);
    expect(byId.get("spoke-only")).toMatchObject({ held: false });
    expect(byId.get("spoke-only")!.reason).toContain("below harness-0.4");
    expect(byId.get("parked")).toMatchObject({ held: true });

    const released = planPreSeries(runs, "0.4", Date.now(), true);
    expect(released.find((p) => p.runId === "parked")).toMatchObject({ held: false });
    // Warm but not paused: still held, the release is for parked runs only.
    expect(released.find((p) => p.runId === "dead-on-arrival")).toMatchObject({ held: false });
    run(runs, "warm-live", [META], { warm: true });
    stamp("warm-live", "harness-0.3");
    expect(planPreSeries(runs, "0.4", Date.now(), true).find((p) => p.runId === "warm-live")).toMatchObject({ held: true });
  });
});
