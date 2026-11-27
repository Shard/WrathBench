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

});

const DEFIAS: DeathCause["damage"] = [{ name: "Defias Miner", total: 260, hits: [{ what: "melee", count: 3, total: 260 }] }];

describe("a death wake counts the death it wakes for", () => {
  test("a death in the awake turn before the sleep is counted by the wake it brings, and once", async () => {
    const c = fakeClock();
    let deaths = 0;
    const wake = new ProgramWake({ trajectory: quiet, now: c.now, sleep: c.sleep, counts: () => ({ deaths, quests: 0 }) });
    const p = fakeProgram();
    const sleep = () => wake.sleep(p, { via: "yield", turn: 1, capMs: 60_000, floorMs: 3_000, stopped: () => false, kept: true, hud: true });
    expect((await sleep()).block).toContain("deaths 0");
    // The model is awake (a snippet, a tool call) when the character dies; then it yields.
    c.advance(5_000);
    deaths++;
    wake.onDeath(c.now());
    const died = await sleep();
    expect(died.fired).toBe("died");
    expect(died.block).toContain("woke for: your character died");
    expect(died.block).toContain("deaths 1");
    // The next block counts from this one.
    expect((await sleep()).block).toContain("deaths 0");
  });

  test("the last death's cause survives a sandbox restart between the death and its wake", async () => {
    const c = fakeClock();
    let deaths = 0;
    const wake = new ProgramWake({ trajectory: quiet, now: c.now, sleep: c.sleep, counts: () => ({ deaths, quests: 0 }) });
    const p = fakeProgram();
    let latch: DeathCause | null = null;
    wake.useDeathCause(async () => {
      const d = latch;
      latch = null;
      return d;
    });
    c.schedule(20_000, () => {
      latch = { ts: c.now(), killer: "Defias Miner", damage: DEFIAS };
      deaths++;
      wake.onDeath(c.now());
    });
    // The child restarts a second later, before the wake reads it: a new child, an empty latch.
    c.schedule(21_000, () => {
      latch = null;
    });
    const died = await wake.sleep(p, { via: "yield", turn: 1, capMs: 60_000, floorMs: 3_000, stopped: () => false, kept: true, hud: true });
    expect(died.block).toContain("last death: killed by Defias Miner, took 260 in the 10s before: Defias Miner 260 (melee ×3)");
    // Taken: a later death wake with no cause of its own does not reuse it.
    c.schedule(20_000, () => {
      deaths++;
      wake.onDeath(c.now());
    });
    expect((await wake.sleep(p, { via: "yield", turn: 2, capMs: 60_000, floorMs: 3_000, stopped: () => false, kept: true, hud: true })).block).not.toContain("last death");
  });
});
