/**
 * A routine running hot wakes the model (operator, 2026-11-20): more than
 * `HOT_PER_MINUTE` refusals and errors in a minute while it sleeps, once per
 * start of that routine. A routine below the bar never does.
 */

import { describe, expect, test } from "bun:test";
import type { ProgramFacts, RoutineRow } from "@wrathbench/mcp";
import { HOT_DRAIN_MS, HOT_PER_MINUTE, HotMeter, ProgramWake, WAKE_CAP_MS, type WakeProgram } from "../src/wake";

function fakeClock(start = 1_000_000) {
  let t = start;
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
    },
  };
}

const emptyFacts = (o: Partial<ProgramFacts> = {}): ProgramFacts => ({ deploy: 7, routines: [], facts: [], factsDropped: 0, repeats: [], console: { lines: [], total: 0 }, ...o });

/**
 * A program whose routine fails `perMinute` times a minute with one
 * signature, the repeats counted as the stack's beat would hand them over:
 * whatever accrued since the last drain.
 */
function failingProgram(now: () => number, perMinute: number, signature = "exploreHunt||moveTo|target_off_mesh"): WakeProgram & { routines: RoutineRow[]; perMinute: number } {
  let last = now();
  let carry = 0;
  const p = {
    perMinute,
    routines: [{ name: "exploreHunt", deploy: 7, startedAt: now() - 60_000, state: "running" } as RoutineRow],
    beat: async () => {},
    drainFacts: () => {
      const t = now();
      carry += ((t - last) / 60_000) * p.perMinute;
      last = t;
      const count = Math.floor(carry);
      carry -= count;
      return emptyFacts({ routines: p.routines, repeats: count > 0 ? [{ signature, count, ts: t }] : [] });
    },
    shownDetails: () => new Set<string>(),
    markShown: () => {},
  };
  return p;
}

const quiet = { append: () => {}, scrub: (t: string) => t };
const yieldFor = (wake: ProgramWake, p: WakeProgram, capMs = WAKE_CAP_MS) => wake.sleep(p, { via: "yield", turn: 1, capMs, floorMs: 3_000, stopped: () => false, kept: true, hud: true });

describe("a routine running hot", () => {
  test("wakes the model once, naming the routine, the count and the signature; not again for the same start", async () => {
    const c = fakeClock();
    const wake = new ProgramWake({ trajectory: quiet, now: c.now, sleep: c.sleep });
    // GLM's exploreHunt: 4,130 target_off_mesh moves in about two minutes.
    const p = failingProgram(c.now, 2_000);
    const hot = await yieldFor(wake, p);
    expect(hot.fired).toBe("running_hot");
    // It passes the bar at the first drain that crosses it, a beat or two in, not after the five minutes.
    expect(hot.sleptMs).toBeLessThan(3 * HOT_DRAIN_MS);
    expect(hot.block.split("\n")[0]).toMatch(/^\[wake 1 · slept \d+s · woke for: routine running hot \(exploreHunt: [\d,]+ refusals and errors in the last minute, [\d,]+ of them moveTo target_off_mesh\)\]$/);
    // Still spinning, same start: the next sleep runs to its cap.
    const next = await yieldFor(wake, p);
    expect(next.fired).toBe("cap");
    // A new start of the routine re-arms it.
    p.routines = [{ name: "exploreHunt", deploy: 8, startedAt: c.now(), state: "running" } as RoutineRow];
    expect((await yieldFor(wake, p)).fired).toBe("running_hot");
  });

  test("a routine below the bar never wakes the model, however long it runs", async () => {
    const c = fakeClock();
    const wake = new ProgramWake({ trajectory: quiet, now: c.now, sleep: c.sleep });
    // At the bar itself, held: a rotation hitting cooldowns runs far below it.
    const p = failingProgram(c.now, HOT_PER_MINUTE, "grind||castSpell|not_ready");
    for (let k = 0; k < 6; k++) expect((await yieldFor(wake, p)).fired).toBe("cap");
  });

  test("the meter counts per routine and per character over a sliding minute", () => {
    const m = new HotMeter();
    const rows = [{ name: "party", deploy: 1, startedAt: 5, state: "running" } as RoutineRow];
    const at = (k: number) => 1_000_000 + k * HOT_DRAIN_MS;
    // Two characters, each under the bar: no reason, though their sum is over it.
    for (let k = 0; k < 12; k++) {
      expect(m.count([{ signature: "party|Alfa|castSpell|not_ready", count: 4, ts: at(k) }, { signature: "party|Bravo|castSpell|not_ready", count: 4, ts: at(k) }], rows, at(k))).toEqual([]);
    }
    // Errors outside every routine and the memory's are no routine's.
    expect(m.count([{ signature: "|TypeError|main.ts:3", count: 500, ts: at(12) }, { signature: "memory|save", count: 500, ts: at(12) }], rows, at(12))).toEqual([]);
    // Alfa alone past it: one reason naming Alfa.
    const hot = m.count([{ signature: "party|Alfa|castSpell|not_ready", count: 40, ts: at(13) }], rows, at(13));
    expect(hot.map((r) => r.text)).toEqual(["routine running hot (party (Alfa): 80 refusals and errors in the last minute, 80 of them castSpell not_ready)"]);
  });
});
