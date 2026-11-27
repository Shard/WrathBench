/**
 * The operator's wake changes of 2026-11-18: a settle window for deaths and
 * refusals, the death cause and the condition lines per character at
 * fan-out, durability crossings reported at the next wake, and routine rows
 * long ended and already shown left out of the routine lines.
 */

import { describe, expect, test } from "bun:test";
import type { ProgramFact, ProgramFacts, RoutineRow } from "@wrathbench/mcp";
import { routineDetailKey } from "@wrathbench/mcp";
import type { SnapshotLike } from "../src/context";
import type { DeathCause } from "../src/sandbox/snippet-delta";
import {
  endedRunKey,
  fanoutConditionLines,
  freshRoutines,
  ProgramWake,
  renderWake,
  ROUTINE_ROW_STALE_MS,
  sleepUntilWake,
  WAKE_CAP_MS,
  WAKE_SETTLE_MS,
  Waker,
  type WakeProgram,
  type WakeReason,
  type WakeSample,
  type WakeView,
} from "../src/wake";

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

const reason = (key: WakeReason["key"], ts: number, character?: string): WakeReason => ({ key, ts, text: character === undefined ? key : `${character} ${key}`, inContext: false, ...(character !== undefined ? { character } : {}) });
const emptyFacts = (o: Partial<ProgramFacts> = {}): ProgramFacts => ({ deploy: 7, routines: [], facts: [], factsDropped: 0, repeats: [], console: { lines: [], total: 0 }, ...o });
const row = (o: Partial<RoutineRow> & { name: string }): RoutineRow => ({ deploy: 7, startedAt: 0, state: "running", ...o }) as RoutineRow;

function fakeProgram(): WakeProgram & { routines: RoutineRow[]; shown: Set<string> } {
  const p = {
    routines: [] as RoutineRow[],
    shown: new Set<string>(),
    beat: async () => {},
    drainFacts: () => emptyFacts({ routines: p.routines }),
    shownDetails: () => new Set(p.shown),
    markShown: (rows: readonly RoutineRow[]) => {
      for (const r of rows) {
        const k = routineDetailKey(r);
        if (k !== undefined) p.shown.add(k);
      }
    },
  };
  return p;
}

const sleepOpts = { capMs: WAKE_CAP_MS, floorMs: 3_000, stopped: () => false };

describe("the settle window: deaths and refusals that land together are one wake", () => {
  test("a lone death or refusal wakes ten seconds after it, not two and not later", async () => {
    for (const key of ["died", "refusal"] as const) {
      const c = fakeClock();
      const w = new Waker();
      c.schedule(60_000, () => w.note(reason(key, c.now())));
      const r = await sleepUntilWake({ waker: w, ...sleepOpts, now: c.now, sleep: c.sleep });
      expect(r).toEqual({ fired: key, sleptMs: 60_000 + WAKE_SETTLE_MS });
    }
  });

  test("five deaths inside the window are one wake, the first's window not moved by the later ones", async () => {
    const c = fakeClock();
    const w = new Waker();
    ["Alfa", "Bravo", "Charlie", "Delta", "Echo"].forEach((name, k) => c.schedule(60_000 + k * 2_000, () => w.note(reason("died", c.now(), name))));
    const r = await sleepUntilWake({ waker: w, ...sleepOpts, now: c.now, sleep: c.sleep });
    expect(r).toEqual({ fired: "died", sleptMs: 70_000 });
    expect(w.peek().map((x) => x.character)).toEqual(["Alfa", "Bravo", "Charlie", "Delta", "Echo"]);
  });

  test("a reason with the two-second window that lands inside a settle wakes at its own and carries the deaths", async () => {
    for (const key of ["routine_ended", "wake", "error"] as const) {
      const c = fakeClock();
      const w = new Waker();
      c.schedule(60_000, () => w.note(reason("died", c.now(), "Alfa")));
      c.schedule(63_000, () => w.note(reason(key, c.now())));
      const r = await sleepUntilWake({ waker: w, ...sleepOpts, now: c.now, sleep: c.sleep });
      expect(r).toEqual({ fired: key, sleptMs: 65_000 });
      expect(w.peek().map((x) => x.key)).toEqual(["died", key]);
    }
  });

  test("a driver's queued notice keeps its own two seconds while a death settles", async () => {
    const c = fakeClock();
    const w = new Waker();
    let queued = 0;
    c.schedule(60_000, () => w.note(reason("died", c.now(), "Alfa")));
    c.schedule(62_000, () => (queued = 1));
    const r = await sleepUntilWake({ waker: w, ...sleepOpts, queuedNotices: () => queued, now: c.now, sleep: c.sleep });
    expect(r).toEqual({ fired: "notice", sleptMs: 64_000 });
    expect(w.peek().map((x) => x.key)).toEqual(["died", "notice"]);
  });

  test("the cap, or a yield's own seconds, is never moved by a settle", async () => {
    const c = fakeClock();
    const w = new Waker();
    c.schedule(15_000, () => w.note(reason("died", c.now(), "Alfa")));
    const r = await sleepUntilWake({ waker: w, capMs: 20_000, floorMs: 3_000, stopped: () => false, now: c.now, sleep: c.sleep });
    expect(r).toEqual({ fired: "died", sleptMs: 20_000 });
  });

  test("the window counts from when the sleep learned of the reason: a death row that reached the runner late still settles", async () => {
    const c = fakeClock();
    const w = new Waker();
    c.schedule(60_000, () => w.note(reason("died", c.now() - 6_000, "Alfa")));
    const r = await sleepUntilWake({ waker: w, ...sleepOpts, now: c.now, sleep: c.sleep });
    expect(r.sleptMs).toBe(70_000);
  });

  test("a death pending as the sleep starts settles from the start; a wake call pending keeps the floor", async () => {
    const c = fakeClock();
    const w = new Waker();
    w.note(reason("died", c.now() - 4_000, "Alfa"));
    expect((await sleepUntilWake({ waker: w, ...sleepOpts, now: c.now, sleep: c.sleep })).sleptMs).toBe(WAKE_SETTLE_MS);
    const v = new Waker();
    v.note(reason("wake", c.now() - 4_000));
    expect((await sleepUntilWake({ waker: v, ...sleepOpts, now: c.now, sleep: c.sleep })).sleptMs).toBe(3_000);
  });
});

const DEFIAS: DeathCause["damage"] = [{ name: "Defias Miner", total: 260, hits: [{ what: "melee", count: 3, total: 260 }] }];
const FIVE = ["Tankpartyb", "Palapartyf", "Roguepartye", "Healpartyc", "Magepartyd"];

describe("fan-out: each character's death cause and condition", () => {
  test("a five-character wipe is one wake carrying five death lines with their causes", async () => {
    const c = fakeClock();
    const wake = new ProgramWake({ trajectory: { append: () => {}, scrub: (t) => t }, now: c.now, sleep: c.sleep, counts: () => ({ deaths: 0, quests: 0 }) });
    const latch = new Map<string, DeathCause>();
    const asked: (string | undefined)[] = [];
    wake.useDeathCause(async (character) => {
      asked.push(character);
      const d = latch.get(character ?? "") ?? null;
      latch.delete(character ?? "");
      return d;
    });
    wake.onSample({ seats: FIVE.map((character) => ({ character, level: 18, connected: true })) });
    const KILLERS = ["Rhahk'Zor", "Defias Miner", "Defias Miner", "Goblin Woodcarver", "Defias Miner"];
    FIVE.forEach((name, k) =>
      c.schedule(30_000 + k * 1_500, () => {
        latch.set(name, { ts: c.now(), killer: KILLERS[k]!, damage: DEFIAS });
        wake.onDeath(c.now(), name);
      }),
    );
    const woke = await wake.sleep(fakeProgram(), { via: "yield", turn: 1, ...sleepOpts, kept: true, hud: true });
    expect(woke.fired).toBe("died");
    const lines = woke.block.split("\n");
    expect(lines[0]).toBe(`[wake 1 · slept 40s · woke for: ${FIVE.join(", ")} died]`);
    const at = lines.indexOf("deaths:");
    expect(lines.slice(at, at + 6)).toEqual([
      "deaths:",
      "  Tankpartyb: killed by Rhahk'Zor, took 260 in the 10s before: Defias Miner 260 (melee ×3)",
      "  Palapartyf: killed by Defias Miner, took 260 in the 10s before: Defias Miner 260 (melee ×3)",
      "  Roguepartye: killed by Defias Miner, took 260 in the 10s before: Defias Miner 260 (melee ×3)",
      "  Healpartyc: killed by Goblin Woodcarver, took 260 in the 10s before: Defias Miner 260 (melee ×3)",
      "  Magepartyd: killed by Defias Miner, took 260 in the 10s before: Defias Miner 260 (melee ×3)",
    ]);
    // Each seat's latch is read as its death row lands (kept across a restart) and again at the wake.
    expect(asked.sort()).toEqual([...FIVE, ...FIVE].sort());
    // Taken: the next wake, with no death, has no death lines and reads no latch.
    asked.length = 0;
    const next = await wake.sleep(fakeProgram(), { via: "yield", turn: 2, capMs: 20_000, floorMs: 3_000, stopped: () => false, kept: true, hud: true });
    expect(next.block).not.toContain("deaths:");
    expect(asked).toEqual([]);
  });

  test("every character that died has its line: a fall says no hit landed, a seat that latched nothing says the cause was not seen", async () => {
    const c = fakeClock();
    const wake = new ProgramWake({ trajectory: { append: () => {}, scrub: (t) => t }, now: c.now, sleep: c.sleep });
    wake.useDeathCause(async (character) => (character === "Alfa" ? { ts: c.now(), damage: [] } : null));
    wake.onSample({ seats: [{ character: "Alfa", level: 4, connected: true }, { character: "Bravo", level: 4, connected: true }] });
    c.schedule(10_000, () => {
      wake.onDeath(c.now(), "Alfa");
      wake.onDeath(c.now() + 1, "Bravo");
    });
    const woke = await wake.sleep(fakeProgram(), { via: "yield", turn: 1, ...sleepOpts, kept: true });
    expect(woke.block).toContain("deaths:\n  Alfa: no hit in the 10s before\n  Bravo: cause not seen");
  });

  test("a latch from another death than the character's last on the record is not its cause", async () => {
    const c = fakeClock();
    const wake = new ProgramWake({ trajectory: { append: () => {}, scrub: (t) => t }, now: c.now, sleep: c.sleep });
    wake.useDeathCause(async () => ({ ts: c.now() - 120_000, killer: "Defias Evoker", damage: DEFIAS }));
    wake.onSample({ seats: [{ character: "Alfa", level: 4, connected: true }] });
    c.schedule(10_000, () => wake.onDeath(c.now(), "Alfa"));
    const woke = await wake.sleep(fakeProgram(), { via: "yield", turn: 1, ...sleepOpts, kept: true });
    expect(woke.block).toContain("  Alfa: cause not seen");
  });

  const WORN: SnapshotLike["inventory"] = [
    { slot: 4, name: "Patched Vest", durability: { current: 48, max: 60 } },
    { slot: 15, name: "Rusted Cleaver", durability: { current: 0, max: 40 } },
  ];

  test("the characters dead or a ghost where no HUD follows, and each one's durability line on every block", () => {
    const now = 10_000_000;
    const seats = [
      { character: "Alfa", level: 18, connected: true, ghost: true, dead: false },
      { character: "Bravo", level: 18, connected: true, ghost: false, dead: true },
      { character: "Charlie", level: 18, connected: true, ghost: false, dead: false },
    ];
    const worn = new Map([
      ["Alfa", WORN],
      ["Charlie", [{ slot: 15, name: "Rusted Cleaver", durability: { current: 40, max: 40 } }]],
    ]);
    const died = new Map([
      ["Alfa", now - 190_000],
      ["Bravo", now - 40_000],
    ]);
    const durability = "Alfa durability: broken main hand Rusted Cleaver (0/40) — a broken item gives no stats";
    expect(fanoutConditionLines(seats, worn, died, now, false)).toEqual(["characters: Alfa ghost, died 3m10s ago; Bravo dead, died 40s ago", durability]);
    // A HUD rides with it: the roll-up says who is dead, never what is worn.
    expect(fanoutConditionLines(seats, worn, died, now, true)).toEqual([durability]);
    expect(fanoutConditionLines(seats.slice(2), new Map(), died, now, false)).toEqual([]);
  });

  test("a wake reads each seat's gear, and a block with a HUD still says what is broken", async () => {
    const c = fakeClock();
    const wake = new ProgramWake({ trajectory: { append: () => {}, scrub: (t) => t }, now: c.now, sleep: c.sleep, counts: () => ({ deaths: 0, quests: 0 }) });
    wake.useWorn(async () => ({ Alfa: WORN }));
    wake.onSample({ seats: [{ character: "Alfa", level: 18, connected: true }] });
    const woke = await wake.sleep(fakeProgram(), { via: "turn-end", turn: 1, capMs: 20_000, floorMs: 3_000, stopped: () => false, kept: false, hud: true });
    expect(woke.block.split("\n").at(-1)).toBe("Alfa durability: broken main hand Rusted Cleaver (0/40) — a broken item gives no stats");
  });
});

describe("durability crossings are reported at the next wake", () => {
  const inv = (vest: number, cleaver: number): SnapshotLike["inventory"] => [
    { slot: 4, name: "Patched Vest", durability: { current: vest, max: 60 } },
    { slot: 15, name: "Rusted Cleaver", itemId: 1, durability: { current: cleaver, max: 40 } },
  ];
  const self = { level: { value: 4 }, health: { value: { current: 120, max: 120 } }, fields: { playerFlags: { value: 0 } } };
  const sample = (vest: number, cleaver: number): WakeSample => ({ self, inventory: inv(vest, cleaver) });

  test("one entry per crossing, once; a crossing while awake is in the next wake; a repair re-arms it; it never wakes by itself", async () => {
    const c = fakeClock();
    const wake = new ProgramWake({ trajectory: { append: () => {}, scrub: (t) => t }, now: c.now, sleep: c.sleep, counts: () => ({ deaths: 0, quests: 0 }) });
    const p = fakeProgram();
    const opts = { via: "turn-end" as const, capMs: 20_000, floorMs: 3_000, stopped: () => false, kept: true, hud: true };
    wake.onSample(sample(48, 40));
    // Crossing while asleep: no wake for it, the cap ends the sleep, and the wake reports it.
    c.schedule(5_000, () => wake.onSample(sample(10, 0)));
    const first = await wake.sleep(p, { ...opts, turn: 1 });
    expect(first.fired).toBe("cap");
    expect(first.block).toContain("worn down since you slept: chest Patched Vest low (10/60); main hand Rusted Cleaver broken (0/40)");
    // Reported once.
    expect((await wake.sleep(p, { ...opts, turn: 2 })).block).not.toContain("worn down");
    // Repaired while the model was awake, then broken again: the next wake says so.
    wake.onSample(sample(60, 40));
    expect((await wake.sleep(p, { ...opts, turn: 3 })).block).not.toContain("worn down");
    wake.onSample(sample(60, 0));
    expect((await wake.sleep(p, { ...opts, turn: 4 })).block).toContain("worn down since you slept: main hand Rusted Cleaver broken (0/40)");
  });

  test("the first reading, and an item swapped into a slot, are taken as they stand", async () => {
    const c = fakeClock();
    const wake = new ProgramWake({ trajectory: { append: () => {}, scrub: (t) => t }, now: c.now, sleep: c.sleep });
    const p = fakeProgram();
    const opts = { via: "turn-end" as const, capMs: 20_000, floorMs: 3_000, stopped: () => false, kept: true, hud: true };
    wake.onSample(sample(10, 0));
    expect((await wake.sleep(p, { ...opts, turn: 1 })).block).not.toContain("worn down");
    wake.onSample({ self, inventory: [{ slot: 15, name: "Old Axe", itemId: 2, durability: { current: 0, max: 40 } }] });
    expect((await wake.sleep(p, { ...opts, turn: 2 })).block).not.toContain("worn down");
  });

});

describe("routine rows long ended and already shown are left out", () => {
  const NOW = 50_000_000;
  const old = NOW - ROUTINE_ROW_STALE_MS - 60_000;
  const view = (routines: RoutineRow[], endedShown: Set<string>, shown = new Set<string>()): WakeView => ({
    n: 9,
    sleptMs: WAKE_CAP_MS,
    fired: "cap",
    capMs: WAKE_CAP_MS,
    reasons: [],
    facts: emptyFacts({ routines }),
    signatures: new Map(),
    progress: null,
    now: NOW,
    shown,
    endedShown,
  });
  const party = row({ name: "party", startedAt: old - 600_000, endedAt: old, state: "stopped" });
  const ghost = row({ name: "ghost", character: "Healpartyc", startedAt: old - 600_000, endedAt: old, state: "returned", value: "ok" });
  const recent = row({ name: "recover", startedAt: NOW - 200_000, endedAt: NOW - 60_000, state: "returned", value: "ok" });
  const unseen = row({ name: "enter", startedAt: old - 600_000, endedAt: old, state: "stopped" });
  const grind = row({ name: "grind", startedAt: NOW - 30_000 });

  test("a stale row the model was shown is counted; a recent one or one not yet shown stays", () => {
    const shown = new Set([endedRunKey(party)]);
    const valueShown = new Set([routineDetailKey(ghost)!]);
    expect(freshRoutines([party, ghost, recent, unseen, grind], NOW, valueShown, shown)).toEqual({ rows: [recent, unseen, grind], dropped: 2 });
    const block = renderWake(view([party, ghost, recent, unseen, grind], shown, valueShown));
    expect(block.split("\n").slice(1, 6)).toEqual([
      "routines:",
      "recover returned 1m ago: ok",
      "enter stopped 6m ago",
      "grind running 30s, deploy 7, no action yet",
      "and 2 that ended earlier, shown before",
    ]);
  });

  test("when every row is stale and shown, one line counts them and none says no routine was started", () => {
    const block = renderWake(view([party], new Set([endedRunKey(party)])));
    expect(block.split("\n").slice(1, 3)).toEqual(["routines: 1 that ended earlier, shown before", "no routine is running"]);
    expect(block).not.toContain("none started");
  });

  test("a kept block marks what it showed, so the next wake drops it; a fixed-loop turn-end block, never kept, does not", async () => {
    for (const kept of [true, false]) {
      const c = fakeClock(NOW);
      const wake = new ProgramWake({ trajectory: { append: () => {}, scrub: (t) => t }, now: c.now, sleep: c.sleep });
      const p = fakeProgram();
      p.routines = [party];
      const opts = { via: "turn-end" as const, capMs: 20_000, floorMs: 3_000, stopped: () => false, kept };
      expect((await wake.sleep(p, { ...opts, turn: 1 })).block).toContain("party stopped");
      const second = (await wake.sleep(p, { ...opts, turn: 2 })).block;
      if (kept) expect(second).toContain("routines: 1 that ended earlier, shown before");
      else expect(second).toContain("party stopped");
    }
  });

  test("a conversation that lost what it was shown lists the row again, once, then counts it", async () => {
    const c = fakeClock(NOW);
    const wake = new ProgramWake({ trajectory: { append: () => {}, scrub: (t) => t }, now: c.now, sleep: c.sleep });
    const p = fakeProgram();
    p.routines = [party];
    const opts = { via: "turn-end" as const, capMs: 20_000, floorMs: 3_000, stopped: () => false, kept: true };
    await wake.sleep(p, { ...opts, turn: 1 });
    expect((await wake.sleep(p, { ...opts, turn: 2 })).block).not.toContain("party stopped");
    // A compaction, a new session or thread, a trim: what the model was shown is gone.
    wake.forgetShown();
    expect((await wake.sleep(p, { ...opts, turn: 3 })).block).toContain("party stopped");
    expect((await wake.sleep(p, { ...opts, turn: 4 })).block).toContain("routines: 1 that ended earlier, shown before");
  });

  test("a routine tool that showed a run ended counts as shown", async () => {
    const c = fakeClock(NOW);
    const wake = new ProgramWake({ trajectory: { append: () => {}, scrub: (t) => t }, now: c.now, sleep: c.sleep });
    const p = fakeProgram();
    p.routines = [party];
    wake.routinesShown([party]);
    expect((await wake.sleep(p, { via: "turn-end", turn: 1, capMs: 20_000, floorMs: 3_000, stopped: () => false, kept: false })).block).not.toContain("party stopped");
  });
});

// The refusals a wipe brings settle with its deaths, and the header names every character that died.
test("a wipe's refusals and deaths are one wake", async () => {
  const c = fakeClock();
  const wake = new ProgramWake({ trajectory: { append: () => {}, scrub: (t) => t }, now: c.now, sleep: c.sleep, counts: () => ({ deaths: 0, quests: 0 }) });
  wake.onSample({ seats: [{ character: "Alfa", level: 18, connected: true }, { character: "Bravo", level: 18, connected: true }] });
  const refusal = (ts: number, seat: string, status: string): ProgramFact => ({ kind: "refusal", ts, routine: "party", deploy: 6, action: "castSpell", status, hint: "h", signature: `party|${seat}|castSpell|${status}`, seat, fresh: true });
  c.schedule(10_000, () => wake.onFact(refusal(c.now(), "Alfa", "stunned")));
  c.schedule(13_000, () => wake.onDeath(c.now(), "Alfa"));
  c.schedule(17_000, () => wake.onFact(refusal(c.now(), "Bravo", "no_power")));
  c.schedule(19_000, () => wake.onDeath(c.now(), "Bravo"));
  const woke = await wake.sleep(fakeProgram(), { via: "yield", turn: 1, ...sleepOpts, kept: true });
  expect(woke.block.split("\n")[0]).toBe("[wake 1 · slept 20s · woke for: new refusal (party: castSpell stunned [Alfa]); Alfa, Bravo died; new refusal (party: castSpell no_power [Bravo])]");
});
