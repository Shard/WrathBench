/**
 * The pause streak a paused run's resume cadence indexes: the ladder pauses
 * since the last segment of the run that made a turn, not every pause of its
 * life. A freeplay run never ends, so a lifetime count reached the end of the
 * ladder on nine pauses spread across weeks of good play and the character's
 * run never resumed again.
 *
 * Fixtures are run directories shaped as the runner leaves them: a `resume`
 * record between segments, each earlier segment's pause in the trajectory
 * only (a resume clears the row), and the standing pause on the row as well.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadRunConfig, type PauseReason } from "../src/config";
import { LADDER_EXEMPT_PAUSES, onPauseLadder, readRunFact, readRunFacts, tallyRecords, tallyRecordsCached, type CountCache } from "../src/models";
import { Trajectory, type RunMeta } from "../src/trajectory";

/** One segment: the turns it made, the pause that ended it, and a turn flushed after the pause. */
interface Seg {
  turns: number;
  pause?: PauseReason;
  flushedAfterPause?: boolean;
}

let runs: string;

beforeAll(() => {
  runs = mkdtempSync(join(tmpdir(), "wb-streak-"));
});

afterAll(() => {
  rmSync(runs, { recursive: true, force: true });
});

const response = (turn: number): { t: string; turn: number; message: { role: string; content: string } } => ({
  t: "response",
  turn,
  message: { role: "assistant", content: `turn ${turn}` },
});

function writeRun(runId: string, segs: Seg[]): void {
  const t = new Trajectory(join(runs, runId));
  t.writeMeta({
    runId,
    harnessVersion: "harness-0.5-1-gabc",
    startedAt: 1_000,
    config: loadRunConfig({ runId, driver: "openai", model: "m/free", episode: "freeplay", account: "RUNNER3" }),
    comparability: { episode: "freeplay" } as unknown as RunMeta["comparability"],
  });
  segs.forEach((s, i) => {
    if (i > 0) t.append({ t: "resume", after: segs[i - 1]!.pause });
    for (let n = 1; n <= s.turns; n++) t.append(response(n));
    if (s.pause !== undefined) {
      if (i === segs.length - 1) t.setPause(runId, s.pause, "fixture");
      else t.append({ t: "pause", reason: s.pause, detail: "fixture" });
    }
    if (s.flushedAfterPause === true) t.append(response(s.turns + 1));
  });
  t.close();
}

function countOf(runId: string, segs: Seg[]): number {
  writeRun(runId, segs);
  const f = readRunFact(runs, runId);
  expect(f?.pause).not.toBeNull();
  return f!.pause!.count;
}

describe("the pause streak", () => {
  test("nine pauses spread across good play are a streak of one, not ten", () => {
    const segs: Seg[] = Array.from({ length: 10 }, () => ({ turns: 40, pause: "rate-limited" as const }));
    expect(countOf("spread", segs)).toBe(1);
  });

  test("provider pauses in segments that made no turn climb the ladder", () => {
    expect(countOf("climb-1", [{ turns: 12, pause: "rate-limited" }])).toBe(1);
    expect(
      countOf("climb-3", [
        { turns: 12, pause: "rate-limited" },
        { turns: 0, pause: "rate-limited" },
        { turns: 0, pause: "quota-exhausted" },
      ]),
    ).toBe(3);
    // A run that never played at all: every pause is the streak.
    expect(countOf("stillborn", Array.from({ length: 11 }, () => ({ turns: 0, pause: "quota-exhausted" as const })))).toBe(11);
  });

  test("a segment that made a turn resets the count, and its own pause starts the next streak", () => {
    expect(
      countOf("reset", [
        { turns: 0, pause: "rate-limited" },
        { turns: 0, pause: "rate-limited" },
        { turns: 0, pause: "rate-limited" },
        { turns: 5, pause: "rate-limited" },
        { turns: 0, pause: "rate-limited" },
      ]),
    ).toBe(2);
  });

  test("a turn flushed after the pause record is still that segment's turn", () => {
    // A runner stopped mid-turn writes its pause first and its last response after.
    expect(
      countOf("flushed", [
        { turns: 0, pause: "rate-limited" },
        { turns: 0, pause: "rate-limited" },
        { turns: 0, pause: "rate-limited", flushedAfterPause: true },
      ]),
    ).toBe(1);
  });

  test("an operator pause is exempt: with no turn it neither counts nor resets, with turns it resets", () => {
    expect(
      countOf("operator-idle", [
        { turns: 8, pause: "rate-limited" },
        { turns: 0, pause: "operator-pause" },
        { turns: 0, pause: "rate-limited" },
      ]),
    ).toBe(2);
    expect(
      countOf("operator-played", [
        { turns: 0, pause: "rate-limited" },
        { turns: 0, pause: "rate-limited" },
        { turns: 30, pause: "operator-pause" },
        { turns: 0, pause: "rate-limited" },
      ]),
    ).toBe(1);
    // Standing on an operator pause itself: the streak it leaves reads, at least 1.
    expect(countOf("operator-standing", [{ turns: 3, pause: "operator-pause" }])).toBe(1);
  });

  test("every pause but the exempt ones is on the ladder", () => {
    expect([...LADDER_EXEMPT_PAUSES].sort()).toEqual(["offline", "operator-pause"]);
    expect(onPauseLadder("operator-pause")).toBe(false);
    expect(onPauseLadder("offline")).toBe(false);
    for (const reason of ["rate-limited", "quota-exhausted", "auth-failed"]) expect(onPauseLadder(reason)).toBe(true);
    expect(onPauseLadder(undefined)).toBe(false);
    expect(
      countOf("auth", [
        { turns: 0, pause: "auth-failed" },
        { turns: 0, pause: "rate-limited" },
      ]),
    ).toBe(2);
  });

  test("a segment with no pause of its own (a runner killed outright) still resets on its turns", () => {
    const runId = "killed";
    writeRun(runId, [
      { turns: 0, pause: "rate-limited" },
      { turns: 0, pause: "rate-limited" },
    ]);
    // Then: a segment that played and died without a verdict, and a
    // zero-turn provider pause on the row.
    const t = new Trajectory(join(runs, runId));
    t.clearPause(runId);
    t.append({ t: "resume" });
    for (let n = 1; n <= 4; n++) t.append(response(n));
    t.append({ t: "resume" });
    t.setPause(runId, "rate-limited", "fixture");
    t.close();
    expect(readRunFact(runs, runId)!.pause!.count).toBe(1);
  });
});

describe("the streak is a fold like the counts", () => {
  test("resuming across cuts, and through the scanner cache, gives the whole-file answer", () => {
    const lines = [
      JSON.stringify(response(1)),
      JSON.stringify({ t: "pause", reason: "rate-limited" }),
      JSON.stringify({ t: "resume" }),
      JSON.stringify({ t: "pause", reason: "rate-limited" }),
      JSON.stringify({ t: "resume" }),
      '{"t":"response", torn',
      JSON.stringify({ t: "events_served", note: 'says "resume" and "pause" in a value' }),
      JSON.stringify({ t: "pause", reason: "quota-exhausted" }),
    ];
    const whole = `${lines.join("\n")}\n`;
    const p = join(runs, "fold.jsonl");
    writeFileSync(p, whole);
    const once = tallyRecords(p, ["response"], { pauseStreak: true })!;
    expect(once.pauseStreak).toBe(3);
    expect(once.counts.get("response")).toBe(1);
    // Asked for counts only, no streak is folded.
    expect(tallyRecords(p, ["response"])!.pauseStreak).toBeNull();

    const cached = join(runs, "fold-cached.jsonl");
    const cache: CountCache = new Map();
    writeFileSync(cached, "");
    let at = 0;
    for (const cut of [5, whole.indexOf("resume") + 2, whole.indexOf("torn"), whole.length - 4, whole.length]) {
      appendFileSync(cached, whole.slice(at, cut));
      at = cut;
      tallyRecordsCached(cache, cached, ["response"], { pauseStreak: true });
    }
    expect(tallyRecordsCached(cache, cached, ["response"], { pauseStreak: true })).toEqual(once);
    // A final record with no newline yet counts as the one-shot counts it — and once.
    appendFileSync(cached, JSON.stringify({ t: "resume" }));
    appendFileSync(p, JSON.stringify({ t: "resume" }));
    expect(tallyRecordsCached(cache, cached, ["response"], { pauseStreak: true })!.pauseStreak).toBe(3);
    appendFileSync(cached, `\n${JSON.stringify(response(2))}\n`);
    appendFileSync(p, `\n${JSON.stringify(response(2))}\n`);
    expect(tallyRecordsCached(cache, cached, ["response"], { pauseStreak: true })).toEqual(tallyRecords(p, ["response"], { pauseStreak: true }));
    expect(tallyRecords(p, ["response"], { pauseStreak: true })!.pauseStreak).toBe(0);
  });

  test("readRunFacts answers the same streak with and without a scanner cache", () => {
    const NOW = Date.now();
    writeRun("cached-a", [
      { turns: 3, pause: "rate-limited" },
      { turns: 0, pause: "rate-limited" },
    ]);
    const counts: CountCache = new Map();
    const pick = (fs: ReturnType<typeof readRunFacts>): number | undefined => fs.find((f) => f.runId === "cached-a")?.pause?.count;
    expect(pick(readRunFacts(runs, NOW, { counts }))).toBe(2);
    expect(pick(readRunFacts(runs, NOW, { counts }))).toBe(2);
    expect(readRunFacts(runs, NOW, { counts })).toEqual(readRunFacts(runs, NOW));
  });
});
