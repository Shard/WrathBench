import { describe, expect, test } from "bun:test";
import { Watchdogs } from "../src/watchdogs";
import { watchdogConfigSchema } from "../src/config";

const cfg = watchdogConfigSchema.parse({
  idleMs: 1_000,
  noXpMs: 5_000,
  episodeMs: 60_000,
  maxSandboxRestarts: 3,
});

function clock(start = 0): { now: () => number; tick: (ms: number) => void } {
  let t = start;
  return { now: () => t, tick: (ms) => (t += ms) };
}

describe("Watchdogs", () => {
  test("idle fires when no model output within idleMs", () => {
    const c = clock();
    const w = new Watchdogs(cfg, c.now);
    expect(w.check()).toBeNull();
    c.tick(999);
    expect(w.check()).toBeNull();
    w.noteModelOutput();
    c.tick(999);
    expect(w.check()).toBeNull();
    c.tick(2);
    expect(w.check()?.reason).toBe("idle");
  });

  test("no-xp fires only after progress was first observed", () => {
    const c = clock();
    const w = new Watchdogs(cfg, c.now);
    // no session/progress yet: never fires no-xp, but keep idle at bay
    c.tick(4_000);
    w.noteModelOutput();
    c.tick(2_000);
    w.noteModelOutput();
    expect(w.check()).toBeNull();
    // first observation arms the timer
    w.noteProgress(1, 0);
    c.tick(4_999);
    w.noteModelOutput();
    expect(w.check()).toBeNull();
    c.tick(2);
    expect(w.check()?.reason).toBe("no-xp");
  });

  test("progress in level or xp resets the no-xp timer", () => {
    const c = clock();
    const w = new Watchdogs(cfg, c.now);
    w.noteProgress(1, 0);
    c.tick(4_000);
    w.noteModelOutput();
    w.noteProgress(1, 25); // xp gained
    c.tick(4_000);
    w.noteModelOutput();
    expect(w.check()).toBeNull();
    w.noteProgress(2, 0); // level up resets even though xp went down
    c.tick(4_000);
    w.noteModelOutput();
    expect(w.check()).toBeNull();
    c.tick(1_001);
    w.noteModelOutput();
    expect(w.check()?.reason).toBe("no-xp");
  });

  test("episode wall clock", () => {
    const c = clock();
    const w = new Watchdogs(cfg, c.now);
    for (let i = 0; i < 59; i++) {
      c.tick(1_000);
      w.noteModelOutput();
      w.noteProgress(1, i);
    }
    expect(w.check()).toBeNull();
    c.tick(1_000);
    expect(w.check()?.reason).toBe("episode-limit");
  });

  test("snippet-runaway counts consecutive restarts; success resets", () => {
    const c = clock();
    const w = new Watchdogs(cfg, c.now);
    w.noteSandboxRestart();
    w.noteSandboxRestart();
    expect(w.check()).toBeNull();
    w.noteSnippetSuccess();
    w.noteSandboxRestart();
    w.noteSandboxRestart();
    expect(w.check()).toBeNull();
    w.noteSandboxRestart();
    expect(w.check()?.reason).toBe("snippet-runaway");
  });
});
