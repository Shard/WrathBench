/**
 * Old runs read identically: the viewer's answers over three frozen 0.5 runs
 * (`fixtures/legacy05/`), each compared whole with the answer the 0.5 viewer
 * gave (`fixtures/legacy05/golden/`).
 *
 * A 0.5 run keeps its trace, its movement intentions and its state series in
 * `run.sqlite` and its nearby ring in `nearby/`, and those writers are going
 * away. Their readers must not: every run recorded before then stays readable
 * through the viewer for as long as it exists. These goldens are what makes
 * that a test rather than an intention. They pin reading, not comparability:
 * an old run is read as it was recorded, not relabelled as a new one.
 *
 * The clock is frozen at `LEGACY05_NOW` with `setSystemTime` (the viewer reads
 * `Date.now()` throughout and takes no clock of its own), and the materialised
 * files carry the mtimes the runs would have left, so liveness, the ring's
 * freshness and the trace's open windows come out the same on every machine.
 * No body is normalised: none carries a wall-clock time, a temp path or an
 * mtime other than those pinned ones.
 *
 * Regenerating: `LEGACY05_REGENERATE_GOLDENS=1 bun test runner/test/legacy05-golden.test.ts`
 * rewrites every golden from the viewer as it now stands. That is legitimate
 * only when an API change is being made on purpose and the diff of every
 * golden it touches has been read and is that change. It is never the fix for
 * a failure here: a golden that differs is an old run that now reads
 * differently, which is the regression this file exists to catch. The fixture
 * runs themselves are never regenerated (`fixtures/legacy05/README.md`).
 */

import { afterAll, beforeAll, describe, expect, setSystemTime, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  LEGACY05_DIR,
  LEGACY05_GOLDEN_DIR,
  LEGACY05_NOW,
  LEGACY05_RUNS,
  LEGACY05_WINDOWS,
  legacy05Api,
  legacy05Get,
  materialiseLegacy05,
  type Legacy05Answer,
} from "./fixtures/legacy05";
import { tempDirs } from "./fixtures/temp-dirs";

const REGENERATE = process.env["LEGACY05_REGENERATE_GOLDENS"] === "1";
const tempDir = tempDirs();

type Mode = "private" | "public";
const LIVE = "l05-freeplay-2";

/** How many records a run's trajectory holds, for its last `/raw/<n>`. */
const recordCount = (runId: string): number =>
  readFileSync(join(LEGACY05_DIR, runId, "trajectory.jsonl"), "utf8").split("\n").filter((l) => l.length > 0).length;

/** Every request this file asks of each handle. */
function paths(mode: Mode): string[] {
  // Every tier, as the results page asks once its filter is cleared: the default is e90, which none of these is.
  const out = ["/api/runs", "/api/positions", "/api/results?episode=all", `/api/character/${LIVE}`];
  for (const id of LEGACY05_RUNS) {
    const run = `/api/run/${id}`;
    out.push(run, `${run}/track`, `${run}/trace`);
    for (const t0 of LEGACY05_WINDOWS[id]) out.push(`${run}/trace/${t0}`);
    out.push(`${run}/nearby`, `${run}/scratchpad`);
    // The feed whole, on the run that has every record kind.
    if (id === "l05-party-a1") out.push(`${run}/entries`);
    // The raw lines are withheld from a public handle: one 403 says so.
    if (mode === "private") out.push(`${run}/raw/1`, `${run}/raw/${recordCount(id) - 1}`);
  }
  // A page of the feed, and the whole ring rather than its last minute.
  out.push("/api/run/l05-party-a1/entries?from=40&limit=5", `/api/run/${LIVE}/nearby?span=900000`);
  if (mode === "public") out.push(`/api/run/${LIVE}/raw/0`, `/api/run/${LIVE}/stream`);
  out.push("/api/run/l05-no-such-run");
  return out;
}

/**
 * A golden as written: indented, with anything that holds only plain values,
 * or is short, on one line, so a trace segment's numbers and a state sample's
 * fields do not take a line each.
 * Read back with `JSON.parse`, so the layout never takes part in the comparison.
 */
function goldenText(value: unknown): string {
  const flat = (v: unknown): boolean => Object.values(v as object).every((x) => x === null || typeof x !== "object");
  const out = (v: unknown, pad: string): string => {
    if (v === null || typeof v !== "object" || flat(v) || JSON.stringify(v).length + pad.length <= 160) return JSON.stringify(v);
    const inner = `${pad} `;
    if (Array.isArray(v)) return v.length === 0 ? "[]" : `[\n${v.map((x) => inner + out(x, inner)).join(",\n")}\n${pad}]`;
    const entries = Object.entries(v as Record<string, unknown>).filter(([, x]) => x !== undefined);
    if (entries.length === 0) return "{}";
    return `{\n${entries.map(([k, x]) => `${inner}${JSON.stringify(k)}: ${out(x, inner)}`).join(",\n")}\n${pad}}`;
  };
  return `${out(value, "")}\n`;
}

const goldenName = (mode: Mode, path: string): string => `${mode}/${path.replace(/^\/api\//, "").replace(/[^A-Za-z0-9._-]+/g, "_")}.json`;

let runsDir = "";
const handles = {} as Record<Mode, ReturnType<typeof legacy05Api>>;
const answers = new Map<string, Legacy05Answer>();

beforeAll(() => {
  setSystemTime(new Date(LEGACY05_NOW));
  runsDir = join(tempDir("legacy05-"), "runs");
  mkdirSync(runsDir, { recursive: true });
  materialiseLegacy05(runsDir);
  handles.private = legacy05Api(runsDir, false);
  handles.public = legacy05Api(runsDir, true);
});

// Bun runs a worker's files in one process: the clock must not outlive this file.
afterAll(() => {
  setSystemTime();
});

for (const mode of ["private", "public"] as const) {
  describe(`0.5 runs through the ${mode} viewer`, () => {
    for (const path of paths(mode)) {
      const name = goldenName(mode, path);
      test(path, async () => {
        const got = await legacy05Get(handles[mode], path);
        answers.set(`${mode} ${path}`, got);
        const text = goldenText(got);
        expect(text).not.toContain(runsDir);
        const file = join(LEGACY05_GOLDEN_DIR, name);
        if (REGENERATE) {
          mkdirSync(join(LEGACY05_GOLDEN_DIR, mode), { recursive: true });
          writeFileSync(file, text);
          return;
        }
        // A missing golden is a failure, never a file this run writes.
        expect(existsSync(file)).toBe(true);
        expect(got).toEqual(JSON.parse(readFileSync(file, "utf8")) as Legacy05Answer);
      });
    }
  });
}

describe("the goldens", () => {
  test("every golden on disk is one this file asks for", () => {
    const wanted = new Set((["private", "public"] as const).flatMap((m) => paths(m).map((p) => goldenName(m, p))));
    const onDisk = (["private", "public"] as const).flatMap((m) =>
      existsSync(join(LEGACY05_GOLDEN_DIR, m)) ? readdirSync(join(LEGACY05_GOLDEN_DIR, m)).map((f) => `${m}/${f}`) : [],
    );
    expect(onDisk.filter((f) => !wanted.has(f))).toEqual([]);
    expect(onDisk.length).toBe(wanted.size);
  });

  /*
   * What the goldens must have captured, asserted apart from them: a golden
   * regenerated over a reader that had quietly stopped reading would agree
   * with itself and say nothing. Each of these is a 0.5 record kind reaching
   * a body.
   */
  test("they hold the session data, not an empty reading of it", async () => {
    // Off the answers the goldens were compared with, or asked now when this test runs alone.
    const answer = async (mode: Mode, path: string): Promise<Legacy05Answer> => answers.get(`${mode} ${path}`) ?? (await legacy05Get(handles[mode], path));
    const got = new Map<string, Record<string, unknown>>();
    for (const mode of ["private", "public"] as const) {
      for (const path of paths(mode)) got.set(`${mode} ${path}`, (await answer(mode, path)).body as Record<string, unknown>);
    }
    const body = (mode: Mode, path: string): Record<string, unknown> => got.get(`${mode} ${path}`)!;
    const status = async (path: string): Promise<number> => (await answer("private", path)).status;
    // The trace's three windows, and the live run's closed window and tail.
    expect((body("private", "/api/run/l05-party-a1/trace")["segs"] as unknown[]).length).toBeGreaterThan(0);
    expect(body("private", `/api/run/${LIVE}/trace`)["tail"]).not.toBeNull();
    for (const t0 of LEGACY05_WINDOWS["l05-party-a1"]) expect(await status(`/api/run/l05-party-a1/trace/${t0}`)).toBe(200);
    expect(await status(`/api/run/l05-freeplay-1/trace/${LEGACY05_WINDOWS["l05-freeplay-1"][0]}`)).toBe(404);
    // The moves, the item samples and the state series.
    const track = body("private", "/api/run/l05-party-a1/track");
    expect((track["moves"] as unknown[]).length).toBe(4);
    expect((track["inv"] as { at: unknown[] }).at.length).toBe(2);
    expect((body("private", "/api/run/l05-freeplay-1")["states"] as unknown[]).length).toBe(4);
    // The party block: chat off the trace, kills named from the client cache.
    const party = body("private", "/api/run/l05-party-a1")["party"] as { chat: unknown[]; kills: { name: string | null }[] };
    expect(party.chat.length).toBeGreaterThan(0);
    expect(party.kills.map((k) => k.name)).toContain("Hollow Regent");
    // The live run on the map, with its trace and its ring flagged.
    const positions = body("private", "/api/positions")["positions"] as { runId: string; trace?: unknown; nearby?: boolean; move: unknown; reflecting: boolean }[];
    expect(positions.map((p) => p.runId)).toEqual([LIVE]);
    expect(positions[0]).toMatchObject({ nearby: true, reflecting: true });
    expect(positions[0]!.trace).toBeDefined();
    expect(positions[0]!.move).not.toBeNull();
    // The ring: a player and its pet privately, creatures only publicly.
    const ring = JSON.stringify(body("private", `/api/run/${LIVE}/nearby?span=900000`));
    for (const name of ["Wendlerook", "Cinderpaw", "Ashen Prowler", "Bog Lurker"]) expect(ring).toContain(name);
    const publicRing = JSON.stringify(body("public", `/api/run/${LIVE}/nearby?span=900000`));
    expect(publicRing).toContain("Ashen Prowler");
    expect(publicRing).not.toContain("Wendlerook");
    expect(publicRing).not.toContain("Cinderpaw");
    // The character across the pre-recorder attempt and the live one.
    expect((body("private", `/api/character/${LIVE}`)["character"] as { attempts: number }).attempts).toBe(2);
    expect((body("private", "/api/run/l05-freeplay-1")["character"] as { attempts: number }).attempts).toBe(2);
  });
});
