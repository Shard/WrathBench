/**
 * The entrypoint loop's wake policy (`src/wake.ts`), pure and on a fake clock:
 * when a sleeping model is due — the coalescing window, the minimum sleep, the
 * fallback, a reason shown once never waking it again — and the `[wake]` block
 * rendered as the same bytes from the same view.
 */
import { describe, expect, test } from "bun:test";
import type { ProgramReport } from "../src/sandbox/ipc";
import {
  FALLBACK_WAKE_MS,
  MIN_SLEEP_MS,
  WAKE_COALESCE_MS,
  WAKE_MEMORY_CHARS,
  WakeLog,
  clock,
  duration,
  money,
  renderWake,
  sleepUntilWake,
  stateDelta,
  type WakeView,
} from "../src/wake";

function report(over: Partial<ProgramReport> = {}): ProgramReport {
  return {
    deploy: 1,
    ticks: 0,
    longestTickMs: 0,
    overruns: 0,
    errors: [],
    requests: [],
    milestones: [],
    logs: [],
    logLines: 0,
    hints: [],
    ...over,
  };
}

const T0 = Date.UTC(2026, 8, 25, 12, 31, 2);

function errorNote(isNew: boolean, count = 1) {
  return {
    signature: "loop() TypeError at loop (main.ts:9:17)",
    hook: "loop()",
    kind: "thrown" as const,
    text: "TypeError: Cannot read properties of undefined (reading 'guid')\n    at pickTarget (lib/combat.ts:14:22)\n    at loop (main.ts:9:17)",
    count,
    isNew,
    deploy: 7,
    firstTs: T0 + 128_000,
    lastTs: T0 + 245_000,
  };
}

describe("when a sleeping model is due", () => {
  test("with nothing to report, the fallback five minutes after the yield", () => {
    const log = new WakeLog();
    log.yielded(T0, false);
    expect(log.due()).toEqual({ at: T0 + FALLBACK_WAKE_MS, reasons: ["fallback"] });
  });

  test("the first reason opens the coalescing window, and later ones ride it", () => {
    const log = new WakeLog();
    log.yielded(T0, false);
    log.noteReport(report({ errors: [errorNote(true)] }), T0 + 60_000);
    log.noteReport(report({ requests: [{ reason: "bags full", from: "on.SMSG_X", count: 1, firstTs: 0, lastTs: 0 }] }), T0 + 61_000);
    expect(log.due()).toEqual({ at: T0 + 60_000 + WAKE_COALESCE_MS, reasons: ["error", "requested"] });
  });

  test("never sooner than the minimum sleep after the yield", () => {
    const log = new WakeLog();
    log.yielded(T0, false);
    log.noteReport(report({ milestones: [{ fact: "level", level: 5, ts: 0 }] }), T0 + 1_000);
    expect(log.due().at).toBe(T0 + MIN_SLEEP_MS);
  });

  test("a repeat of a known signature is counted and wakes no one", () => {
    const log = new WakeLog();
    log.yielded(T0, false);
    log.noteReport(report({ errors: [errorNote(false, 38)] }), T0 + 1_000);
    expect(log.due().reasons).toEqual(["fallback"]);
  });

  test("a reason shown in a request never wakes the model again; one that arrived after the last request does", () => {
    const log = new WakeLog();
    log.noteReport(report({ errors: [errorNote(true)] }), T0);
    log.markShown();
    log.noteReport(report({ milestones: [{ fact: "death", ts: 0 }] }), T0 + 500);
    log.yielded(T0 + 1_000, false);
    expect(log.due()).toEqual({ at: T0 + 1_000 + MIN_SLEEP_MS, reasons: ["milestone"] });
  });

  test("what arrived after the last render carries across the yield: the reason, and the rows it is about", () => {
    const log = new WakeLog();
    log.noteReport(report({ errors: [errorNote(true, 2)] }), T0);
    log.markShown();
    // The model's reply is in flight: a new signature, one more of the old, a death.
    const other = { ...errorNote(true), signature: "on.SMSG_X RangeError", hook: "on.SMSG_X", text: "RangeError: late\n    at h (main.ts:3:1)" };
    log.noteReport(report({ errors: [other, errorNote(false, 3)], milestones: [{ fact: "death", ts: 0 }], logs: [{ level: "log", ts: 0, text: "late line" }], logLines: 1 }), T0 + 500);
    log.yielded(T0 + 1_000, false);
    expect(log.due().reasons).toEqual(["error", "milestone"]);
    const v = log.view({ wake: 2, request: 1, asleepMs: 5_000, wokeFor: ["error"], program: { state: "running", deploy: 7, deployedAt: T0, editsSinceDeploy: false, mainExists: true }, delta: null, memory: null });
    // The late signature whole, and only the unshown part of the shown one.
    expect(v.errors.map((e) => [e.signature, e.count, e.text.split("\n")[0]])).toEqual([
      ["loop() TypeError at loop (main.ts:9:17)", 3, "TypeError: Cannot read properties of undefined (reading 'guid')"],
      ["on.SMSG_X RangeError", 1, "RangeError: late"],
    ]);
    expect(log.facts()).toEqual([{ fact: "death", ts: 0 }]);
    expect(v.console).toEqual({ lines: 1, entries: [{ level: "log", ts: 0, text: "late line" }] });
  });

  test("a failed sdk call the program caught wakes the model like a throw, once, and the ledger keeps its kind", () => {
    const log = new WakeLog();
    log.yielded(T0, false);
    const failed = {
      signature: "loop() sdk.trainerList EventTimeoutError",
      hook: "loop()",
      kind: "failed" as const,
      text: "sdk.trainerList() threw EventTimeoutError: timed out after 10000ms waiting for SMSG_TRAINER_LIST\n    at doTrain (lib/brain.ts:212:15)",
      count: 1,
      isNew: true,
      deploy: 3,
      firstTs: T0 + 10_000,
      lastTs: T0 + 10_000,
    };
    log.noteReport(report({ deploy: 3, errors: [failed] }), T0 + 10_000);
    expect(log.due()).toEqual({ at: T0 + 10_000 + WAKE_COALESCE_MS, reasons: ["error"] });
    log.noteReport(report({ deploy: 3, errors: [{ ...failed, isNew: false, count: 49, firstTs: T0 + 20_000, lastTs: T0 + 500_000 }] }), T0 + 500_000);
    const v = log.view({ wake: 4, request: 1, asleepMs: 12_000, wokeFor: ["error"], program: { state: "running", deploy: 3, deployedAt: T0, editsSinceDeploy: false, mainExists: true }, delta: null, memory: null });
    expect(v.errors).toEqual([expect.objectContaining({ kind: "failed", count: 50 })]);
    expect(renderWake(v)).toContain(
      "errors:\n- loop() sdk.trainerList() threw EventTimeoutError: timed out after 10000ms waiting for SMSG_TRAINER_LIST ×50 (first 12:31:12, last 12:39:22)\n    at doTrain (lib/brain.ts:212:15)",
    );
    expect([...log.drainLedger().errors.values()]).toEqual([
      { signature: "loop() sdk.trainerList EventTimeoutError", hook: "loop()", kind: "failed", deploy: 3, count: 50 },
    ]);
  });

  test("the ledger counts every occurrence once, whatever the block showed or carried", () => {
    const log = new WakeLog();
    log.noteReport(report({ ticks: 10, longestTickMs: 40, overruns: 1, errors: [errorNote(true, 2)] }), T0);
    log.markShown();
    log.noteReport(report({ ticks: 5, longestTickMs: 90, errors: [errorNote(false, 3)] }), T0 + 500);
    log.noteHost({ kind: "halted", deploy: 7, at: T0 }, T0);
    const first = log.drainLedger();
    log.yielded(T0 + 1_000, false);
    log.noteReport(report({ ticks: 2, errors: [errorNote(false, 1)] }), T0 + 2_000);
    const second = log.drainLedger();
    expect([...first.errors.values()].map((e) => e.count)).toEqual([5]);
    expect([first.ticks, first.longestTickMs, first.overruns, first.halts, first.restarts]).toEqual([15, 90, 1, 1, 0]);
    expect([...second.errors.values()].map((e) => e.count)).toEqual([1]);
    expect(second.ticks).toBe(2);
  });

  test("a failed deploy at the yield, a halt and a restart are reasons of their own", () => {
    const log = new WakeLog();
    log.yielded(T0, false);
    log.noteDeploy({ deploy: 2, version: 3, ok: false, error: "BuildMessage: x", action: "load" }, T0);
    log.noteHost({ kind: "halted", deploy: 1, at: T0 }, T0);
    log.noteHost({ kind: "restart", cause: "exit", at: T0, detail: "exited" }, T0);
    expect(log.due().reasons).toEqual(["load", "halted", "restart"]);
  });
});

describe("sleepUntilWake", () => {
  test("sleeps in checked steps to the fallback, then wakes for it", async () => {
    let now = T0;
    const log = new WakeLog();
    log.yielded(now, false);
    let checks = 0;
    const out = await sleepUntilWake({
      log,
      now: () => now,
      sleep: async (ms) => {
        now += ms;
      },
      check: () => {
        checks++;
        return null;
      },
    });
    expect(out).toEqual({ kind: "woke", reasons: ["fallback"], sleptMs: FALLBACK_WAKE_MS });
    expect(checks).toBe(FALLBACK_WAKE_MS / 1_000 + 1);
  });

  test("a report mid-sleep wakes it at the end of the coalescing window", async () => {
    let now = T0;
    const log = new WakeLog();
    log.yielded(now, false);
    const out = await sleepUntilWake({
      log,
      now: () => now,
      sleep: async (ms) => {
        now += ms;
        if (now === T0 + 30_000) log.noteReport(report({ errors: [errorNote(true)] }), now);
      },
      check: () => null,
    });
    expect(out).toEqual({ kind: "woke", reasons: ["error"], sleptMs: 30_000 + WAKE_COALESCE_MS });
  });

  test("a stop or a watchdog ends the sleep with its own outcome", async () => {
    let now = T0;
    const log = new WakeLog();
    log.yielded(now, false);
    const out = await sleepUntilWake({
      log,
      now: () => now,
      sleep: async (ms) => {
        now += ms;
      },
      check: () => (now >= T0 + 10_000 ? "stopped" : null),
    });
    expect(out).toEqual({ kind: "ended", outcome: "stopped" });
  });

  test("an abort ends a real sleep at once rather than at the next step", async () => {
    const log = new WakeLog();
    log.yielded(Date.now(), false);
    const ac = new AbortController();
    const started = Date.now();
    setTimeout(() => ac.abort(), 20);
    const out = await sleepUntilWake({
      log,
      now: Date.now,
      sleep: (ms) => Bun.sleep(ms),
      signal: ac.signal,
      check: () => (ac.signal.aborted ? "stopped" : null),
      checkMs: 60_000,
    });
    expect(out).toEqual({ kind: "ended", outcome: "stopped" });
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});

describe("the [wake] block", () => {
  function view(over: Partial<WakeView> = {}): WakeView {
    return {
      wake: 12,
      request: 1,
      asleepMs: 245_000,
      wokeFor: ["error", "requested"],
      lastWakeCapped: false,
      program: { state: "running", deploy: 7, deployedAt: T0, editsSinceDeploy: false, mainExists: true },
      ticks: 243,
      longestTickMs: 31_200,
      overruns: 0,
      loads: [],
      host: [],
      errors: [
        {
          signature: "loop() TypeError at pickTarget (lib/combat.ts:14:22)",
          hook: "loop()",
          kind: "thrown",
          text: "TypeError: Cannot read properties of undefined (reading 'guid')\n    at pickTarget (lib/combat.ts:14:22)\n    at loop (main.ts:9:17)",
          count: 38,
          deploy: 7,
          firstTs: T0 + 128_000,
          lastTs: T0 + 245_000,
        },
      ],
      requests: [{ reason: "bags full", from: "on.SMSG_INVENTORY_CHANGE_FAILURE", count: 1 }],
      delta: { levelFrom: 4, levelTo: 5, xpGained: 830, moneyDelta: 112, quests: [33], deaths: 0, zoneFrom: "Elwynn Forest", zoneTo: "Elwynn Forest" },
      hints: [],
      console: { lines: 1_204, entries: [{ level: "log", ts: T0, text: "pulling Kobold ×3" }] },
      memory: '{"phase":"grind","target":"Kobold"}',
      memoryUnchanged: false,
      ...over,
    };
  }

  test("renders the design's shape, byte for byte", () => {
    expect(renderWake(view())).toBe(
      [
        "[wake 12 · request 1 of this wake · asleep 4m05s · woke for: error, requested]",
        "program: main.ts deploy 7 (12:31:02), running · 243 ticks since you ended your turn, longest 31.2s, 0 overruns · no edits since deploy",
        "errors:",
        "- loop() TypeError: Cannot read properties of undefined (reading 'guid') ×38 (first 12:33:10, last 12:35:07)",
        "    at pickTarget (lib/combat.ts:14:22)",
        "    at loop (main.ts:9:17)",
        'requested: "bags full" ×1 (on.SMSG_INVENTORY_CHANGE_FAILURE)',
        "since you ended your turn: level 4 → 5 · xp +830 · money +1s 12c · quests turned in 1 (#33) · deaths 0 · zone unchanged",
        "[program console: 1,204 lines, last 1 shown, repeats folded]",
        "pulling Kobold ×3",
        "[memory.json, 35 chars]",
        '{"phase":"grind","target":"Kobold"}',
      ].join("\n"),
    );
  });

  test("the same view is the same bytes, every time", () => {
    expect(renderWake(view())).toBe(renderWake(JSON.parse(JSON.stringify(view())) as WakeView));
  });

  test("the first wake has no sleep and no delta; a program not yet written says how one starts", () => {
    const text = renderWake(
      view({
        wake: 1,
        asleepMs: null,
        wokeFor: ["start"],
        program: { state: "none", editsSinceDeploy: false, mainExists: false },
        errors: [],
        requests: [],
        delta: null,
        console: { lines: 0, entries: [] },
        memory: null,
      }),
    );
    expect(text).toBe("[wake 1 · request 1 of this wake · woke for: start]\nprogram: none · write main.ts; it loads when you end your turn");
  });

  test("a failed load names the deploy still running, a cap is said, and the caps hold", () => {
    const errors = Array.from({ length: 10 }, (_, i) => ({
      signature: `loop() E${i}`,
      hook: "loop()",
      kind: "thrown" as const,
      text: `E${i}: x`,
      count: 1,
      deploy: 7,
      firstTs: T0,
      lastTs: T0,
    }));
    const text = renderWake(
      view({
        lastWakeCapped: true,
        program: { state: "running", deploy: 7, deployedAt: T0, editsSinceDeploy: true, mainExists: true },
        loads: [{ deploy: 8, ok: false, action: "load", error: "BuildMessage: Unexpected ; at main.ts:3:13 — const x = ;", at: T0 }],
        errors,
        console: { lines: 60, entries: Array.from({ length: 60 }, (_, i) => ({ level: "log" as const, ts: T0, text: `line ${i}` })) },
        memory: `{"blob":"${"x".repeat(3_000)}"}`,
      }),
    );
    expect(text).toContain("(your last wake ended at the 20-request cap, not by a reply; end a turn by replying without a tool call)");
    expect(text).toContain("edits since deploy: yes, they load when you end your turn");
    expect(text).toContain("deploy 8 failed to load (12:31:02); deploy 7 keeps running:\n    BuildMessage: Unexpected ; at main.ts:3:13 — const x = ;");
    expect(text).toContain("- +2 more signatures");
    expect(text).toContain("[program console: 60 lines, last 40 shown, repeats folded]\nline 20\n");
    expect(text).not.toContain("line 19\n");
  });

  test("memory.json over the cap shows its last characters, and one line when this wake already showed it", () => {
    const log = Array.from({ length: 200 }, (_, i) => `"entry ${String(i).padStart(3, "0")}"`).join(",");
    const memory = `{"log":[${log}]}`;
    expect(memory.length).toBeGreaterThan(WAKE_MEMORY_CHARS);
    const text = renderWake(view({ memory }));
    const tail = text.slice(text.indexOf("[memory.json"));
    expect(tail).toBe(
      [
        `[memory.json, ${memory.length.toLocaleString("en-US")} chars]`,
        `… (${(memory.length - WAKE_MEMORY_CHARS).toLocaleString("en-US")} chars before)`,
        memory.slice(-WAKE_MEMORY_CHARS),
      ].join("\n"),
    );
    // The newest entry is the one shown; the oldest is not.
    expect(tail).toContain('"entry 199"]}');
    expect(tail).not.toContain('"entry 000"');
    // Unchanged since the previous request of the wake: one line, whatever its size.
    expect(renderWake(view({ memory, memoryUnchanged: true })).endsWith(`[memory.json unchanged, ${memory.length.toLocaleString("en-US")} chars]`)).toBe(true);
    expect(renderWake(view({ memoryUnchanged: true })).endsWith("[memory.json unchanged, 35 chars]")).toBe(true);
    // Up to the cap it is shown whole.
    const whole = `{"blob":"${"x".repeat(WAKE_MEMORY_CHARS - 11)}"}`;
    expect(whole.length).toBe(WAKE_MEMORY_CHARS);
    expect(renderWake(view({ memory: whole })).endsWith(`[memory.json, 2,000 chars]\n${whole}`)).toBe(true);
  });

  test("formats: clock in UTC, durations, money", () => {
    expect(clock(T0)).toBe("12:31:02");
    expect([duration(31_200), duration(245_000), duration(7_380_000)]).toEqual(["31.2s", "4m05s", "2h03m"]);
    expect([money(112), money(-5), money(10_000 + 203), money(0)]).toEqual(["+1s 12c", "-5c", "+1g 2s 3c", "+0c"]);
  });
});

describe("stateDelta", () => {
  const snap = (level: number, xp: number, next: number, copper: number, zone: string) => ({
    self: { level: { value: level }, zone: { value: { id: 1, name: zone } } },
    xp: { value: xp },
    nextLevelXp: { value: next },
    money: { value: copper },
  });

  test("xp across one level-up uses the bar's size at the yield; deaths and turn-ins come from the facts", () => {
    const d = stateDelta(snap(4, 1_000, 1_400, 50, "Elwynn Forest"), snap(5, 430, 2_000, 162, "Westfall"), [
      { fact: "quest", questId: 33, ts: 0 },
      { fact: "death", ts: 0 },
    ]);
    expect(d).toEqual({
      levelFrom: 4,
      levelTo: 5,
      xpGained: 830,
      moneyDelta: 112,
      quests: [33],
      deaths: 1,
      zoneFrom: "Elwynn Forest",
      zoneTo: "Westfall",
    });
  });

  test("xp across two level-ups is left out rather than guessed; no snapshot is no delta", () => {
    expect(stateDelta(snap(4, 10, 1_400, 0, "a"), snap(6, 20, 3_000, 0, "a"), [])?.xpGained).toBeUndefined();
    expect(stateDelta(null, snap(4, 10, 1_400, 0, "a"), [])).toBeNull();
  });
});
