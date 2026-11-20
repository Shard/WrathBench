/**
 * Wake blocks that said something untrue, as recent runs showed them: a
 * signature's line frozen at its first occurrence, a death wake reading
 * "deaths 0", and the last death's cause lost to a sandbox restart.
 */

import { describe, expect, test } from "bun:test";
import type { ProgramFact, ProgramFacts, RoutineRow } from "@wrathbench/mcp";
import type { DeathCause } from "../src/sandbox/snippet-delta";
import { ProgramWake, type WakeProgram } from "../src/wake";

function fakeClock(start = 1_000_000) {
  let t = start;
  const at: { ts: number; fn: () => void }[] = [];
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
      for (const e of at.filter((x) => x.ts <= t)) {
        at.splice(at.indexOf(e), 1);
        e.fn();
      }
    },
    schedule: (ms: number, fn: () => void) => at.push({ ts: t + ms, fn }),
    advance: (ms: number) => {
      t += ms;
    },
  };
}

const emptyFacts = (o: Partial<ProgramFacts> = {}): ProgramFacts => ({ deploy: 7, routines: [], facts: [], factsDropped: 0, repeats: [], console: { lines: [], total: 0 }, ...o });

/** A program whose drains hand back what the test queued: facts (also pushed to the wake as they happen) and repeats as the stack drains them. */
function fakeProgram(): WakeProgram & {
  routines: RoutineRow[];
  push(f: ProgramFact, wake: ProgramWake): void;
  repeat(r: ProgramFacts["repeats"][number] & { newest?: { text: string; frames?: string[] } }): void;
} {
  let pending = emptyFacts();
  const p = {
    routines: [] as RoutineRow[],
    push(f: ProgramFact, wake: ProgramWake) {
      pending = { ...pending, facts: [...pending.facts, f] };
      wake.onFact(f);
    },
    repeat(r: ProgramFacts["repeats"][number]) {
      pending = { ...pending, repeats: [...pending.repeats, r] };
    },
    beat: async () => {},
    drainFacts: () => {
      const out = { ...pending, routines: p.routines };
      pending = emptyFacts();
      return out;
    },
    shownDetails: () => new Set<string>(),
    markShown: () => {},
  };
  return p;
}

const quiet = { append: () => {}, scrub: (t: string) => t };
const refusal = (ts: number, hint: string): ProgramFact => ({
  kind: "refusal",
  ts,
  routine: "grind",
  deploy: 3,
  action: "castSpell",
  status: "not_ready",
  hint,
  signature: "grind||castSpell|not_ready",
  fresh: true,
});

describe("a later report of a signature names its newest occurrence", () => {
  test("repeats carrying the newest hint replace the first occurrence's words, wake after wake", async () => {
    const c = fakeClock();
    const wake = new ProgramWake({ trajectory: quiet, now: c.now, sleep: c.sleep });
    const p = fakeProgram();
    p.routines = [{ name: "grind", deploy: 3, startedAt: c.now(), state: "running" } as RoutineRow];
    const sleep = () => wake.sleep(p, { via: "yield", turn: 1, capMs: 60_000, floorMs: 3_000, stopped: () => false, kept: true });
    p.push(refusal(c.now(), "Judgement of Light on Frostmane Troll Whelp: it last went off 9.3s ago"), wake);
    const first = await sleep();
    expect(first.block).toContain("grind castSpell not_ready — Judgement of Light on Frostmane Troll Whelp: it last went off 9.3s ago");
    // Hours later, elsewhere: the stack's repeat carries the newest occurrence.
    c.advance(3_600_000);
    p.repeat({ signature: "grind||castSpell|not_ready", count: 40, ts: c.now() - 2_000, newest: { text: "Judgement of Light on Crag Boar: it last went off 1.1s ago" } });
    const later = await sleep();
    expect(later.block).toContain("grind castSpell not_ready — Judgement of Light on Crag Boar: it last went off 1.1s ago ×40");
    expect(later.block).not.toContain("Frostmane");
    // A wake whose drain had no newer occurrence keeps the newest it knows.
    p.repeat({ signature: "grind||castSpell|not_ready", count: 2, ts: c.now() });
    expect((await sleep()).block).toContain("Crag Boar: it last went off 1.1s ago ×2");
  });

  test("a fresh fact after a reload or a restart replaces the line too, and an older repeat never undoes a newer fact", async () => {
    const c = fakeClock();
    const wake = new ProgramWake({ trajectory: quiet, now: c.now, sleep: c.sleep });
    const p = fakeProgram();
    const sleep = () => wake.sleep(p, { via: "yield", turn: 1, capMs: 60_000, floorMs: 3_000, stopped: () => false, kept: true });
    const error = (ts: number, text: string): ProgramFact => ({
      kind: "error",
      ts,
      routine: "grind",
      deploy: 3,
      error: { name: "TypeError", text, frames: ["at grind (main.ts:9)"], signature: "grind|TypeError|main.ts:9" },
      fresh: true,
    });
    p.push(error(c.now(), "TypeError: a is undefined"), wake);
    await sleep();
    c.advance(10_000);
    // The repeat's newest is older than the fact the reload brought.
    p.repeat({ signature: "grind|TypeError|main.ts:9", count: 3, ts: c.now() - 5_000, newest: { text: "TypeError: b is undefined", frames: ["at grind (main.ts:9)"] } });
    p.push(error(c.now(), "TypeError: c is undefined"), wake);
    const block = (await sleep()).block;
    expect(block).toContain("grind TypeError: c is undefined ×4");
    expect(block).not.toContain("a is undefined");
    expect(block).not.toContain("b is undefined");
  });
});
