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

describe("Watchdogs episode clock across a pause", () => {
  test("elapsedBeforeMs continues the budget instead of restarting it", () => {
    const c = clock(1_000_000);
    // A run that had already spent 50s of its 60s budget before it paused.
    const w = new Watchdogs({ ...cfg, idleMs: null }, c.now, 50_000);
    expect(w.elapsedMs()).toBe(50_000);
    c.tick(9_999);
    expect(w.check()).toBeNull();
    c.tick(1);
    expect(w.check()?.reason).toBe("episode-limit");
    expect(w.elapsedMs()).toBe(60_000);
  });

  test("the idle clock starts at this process's start, not at the carried offset", () => {
    const c = clock();
    const w = new Watchdogs(cfg, c.now, 50_000);
    c.tick(999);
    expect(w.check()).toBeNull();
  });
});

describe("Watchdogs fresh-character precondition", () => {
  test("not armed: a level-6 first sight is fine (resumed run)", () => {
    const w = new Watchdogs(cfg, clock().now);
    w.noteFirstLive({ guid: "294", level: 6 });
    expect(w.check()).toBeNull();
  });

  test("armed: a guid hygiene listed trips stale-character whatever the level", () => {
    const w = new Watchdogs(cfg, clock().now);
    w.expectFreshCharacter(new Set(["294"]));
    w.noteFirstLive({ guid: "294", level: 1 });
    expect(w.check()?.reason).toBe("stale-character");
    expect(w.check()?.detail).toContain("294");
  });

  test("armed: level > 1 on first sight trips even with an unknown guid", () => {
    const w = new Watchdogs(cfg, clock().now);
    w.expectFreshCharacter(new Set());
    w.noteFirstLive({ guid: "301", level: 6 });
    expect(w.check()?.reason).toBe("stale-character");
  });

  test("armed: a fresh level-1 character passes, and later sightings are not re-judged", () => {
    const w = new Watchdogs(cfg, clock().now);
    w.expectFreshCharacter(new Set(["294"]));
    w.noteFirstLive({ guid: "301", level: 1 });
    expect(w.check()).toBeNull();
    w.noteFirstLive({ guid: "301", level: 4 });
    expect(w.check()).toBeNull();
  });
});

describe("level-target: a probe campaign's stopping rule", () => {
  test("ends the run on the first observed level at or above stopAtLevel, and not before", () => {
    const c = clock();
    const w = new Watchdogs(cfg, c.now, 0, { stopAtLevel: 10 });
    w.noteProgress(9, 6_400);
    w.noteModelOutput();
    expect(w.check()).toBeNull();
    w.noteProgress(10, 30);
    const v = w.check();
    expect(v?.reason).toBe("level-target");
    expect(v?.detail).toContain("level 10");
    // It stays ended: a later sample cannot un-reach the target.
    w.noteProgress(10, 400);
    expect(w.check()?.reason).toBe("level-target");
  });

  test("outranks the clock: a run that got there in the tick its time ran out ended because it got there", () => {
    const c = clock();
    const w = new Watchdogs(cfg, c.now, 0, { stopAtLevel: 10 });
    c.tick(60_000);
    w.noteModelOutput();
    w.noteProgress(11, 0);
    expect(w.check()?.reason).toBe("level-target");
  });

  test("an xp-only reading never trips it", () => {
    const w = new Watchdogs(cfg, clock().now, 0, { stopAtLevel: 10 });
    w.noteModelOutput();
    w.noteProgress(undefined, 99_999);
    expect(w.check()).toBeNull();
  });
});

describe("idle: a model that answers wakes without acting (operator, 2026-11-18)", () => {
  const MIN = 60_000;
  const tier = watchdogConfigSchema.parse({ idleMs: 20 * MIN, noXpMs: 0, episodeMs: 240 * MIN, maxSandboxRestarts: 3 });
  /** One wake answered in words alone: the reply, then the program loop's next sleep. */
  const talk = (w: Watchdogs): void => {
    w.noteModelOutput();
    w.noteWakeAnswered();
  };

  test("four five-minute wakes answered with text alone, twenty minutes after the last tool call, end the run idle", () => {
    // The Deadmines pattern: a turn that acted, then a few words at every five-minute wake.
    const c = clock();
    const w = new Watchdogs(tier, c.now);
    w.noteToolCall();
    w.noteModelOutput();
    w.noteWakeAnswered();
    for (let k = 1; k <= 3; k++) {
      c.tick(5 * MIN);
      talk(w);
      expect(w.check()).toBeNull();
    }
    c.tick(5 * MIN);
    talk(w);
    expect(w.check()).toEqual({ reason: "idle", detail: `no tool call and no level/xp progress for ${20 * MIN}ms: 4 wakes in a row answered without either` });
  });

  test("the replies keep the output clock fresh: without the no-action rule the run would hold its world to the limit", () => {
    const c = clock();
    const w = new Watchdogs(tier, c.now);
    w.noteToolCall();
    w.noteWakeAnswered();
    // Asleep between wakes: the output clock is held, as the program loop holds it.
    for (let k = 0; k < 3; k++) {
      w.noteAsleep();
      c.tick(5 * MIN);
      w.noteAwake();
      w.noteModelOutput();
      expect(w.check()).toBeNull();
      w.noteWakeAnswered();
    }
    w.noteAsleep();
    c.tick(5 * MIN);
    w.noteAwake();
    w.noteModelOutput();
    w.noteWakeAnswered();
    expect(w.check()?.reason).toBe("idle");
  });

  test("a burst of fast wakes answered without acting is not twenty minutes of it", () => {
    // Deaths and refusals woke the Sonnet run seconds apart; it answered in words and acted again later.
    const c = clock();
    const w = new Watchdogs(tier, c.now);
    w.noteToolCall();
    w.noteWakeAnswered();
    for (let k = 0; k < 12; k++) {
      c.tick(10_000);
      talk(w);
    }
    expect(w.check()).toBeNull();
    c.tick(MIN);
    w.noteToolCall();
    w.noteWakeAnswered();
    c.tick(5 * MIN);
    talk(w);
    expect(w.check()).toBeNull();
  });

  test("twenty minutes without a tool call is not enough on fewer wakes than fit the window", () => {
    const c = clock();
    const w = new Watchdogs(tier, c.now);
    w.noteToolCall();
    w.noteWakeAnswered();
    c.tick(5 * MIN);
    talk(w);
    // One long awake stretch of talk, under the output clock's own limit at every reply.
    c.tick(15 * MIN);
    w.noteModelOutput();
    c.tick(MIN);
    talk(w);
    expect(w.check()).toBeNull();
  });

  test("a yield is acting: a model that yields every five minutes while its routine plays never goes idle", () => {
    const c = clock();
    const w = new Watchdogs(tier, c.now);
    // Three hours and twenty minutes of it, inside the four-hour clock.
    for (let k = 0; k < 40; k++) {
      // The call is noted at dispatch, before the sleep it starts.
      w.noteToolCall();
      w.noteWakeAnswered();
      w.noteAsleep();
      c.tick(5 * MIN);
      w.noteAwake();
      w.noteModelOutput();
      expect(w.check()).toBeNull();
    }
  });

  test("any tool call resets the count and the clock", () => {
    const c = clock();
    const w = new Watchdogs(tier, c.now);
    w.noteToolCall();
    w.noteWakeAnswered();
    for (let k = 0; k < 3; k++) {
      c.tick(5 * MIN);
      talk(w);
    }
    c.tick(MIN);
    w.noteToolCall();
    w.noteWakeAnswered();
    for (let k = 0; k < 3; k++) {
      c.tick(5 * MIN);
      talk(w);
    }
    expect(w.check()).toBeNull();
    c.tick(5 * MIN);
    talk(w);
    expect(w.check()?.reason).toBe("idle");
  });

  test("the count is the idle window over the wake cap: two wakes at a ten-minute window", () => {
    const c = clock();
    const w = new Watchdogs(watchdogConfigSchema.parse({ idleMs: 10 * MIN, noXpMs: 0, episodeMs: 240 * MIN, maxSandboxRestarts: 3 }), c.now);
    w.noteToolCall();
    w.noteWakeAnswered();
    c.tick(5 * MIN);
    talk(w);
    expect(w.check()).toBeNull();
    c.tick(5 * MIN);
    talk(w);
    expect(w.check()?.detail).toBe(`no tool call and no level/xp progress for ${10 * MIN}ms: 2 wakes in a row answered without either`);
  });

  test("off with the idle watchdog", () => {
    const c = clock();
    const w = new Watchdogs(watchdogConfigSchema.parse({ idleMs: 0, noXpMs: 0, episodeMs: 0, maxSandboxRestarts: 3 }), c.now);
    w.noteToolCall();
    w.noteWakeAnswered();
    for (let k = 0; k < 40; k++) {
      c.tick(5 * MIN);
      talk(w);
    }
    expect(w.check()).toBeNull();
  });
});

describe("idle: a model whose character is still progressing has acted (operator, 2026-11-20)", () => {
  const MIN = 60_000;
  const tier = watchdogConfigSchema.parse({ idleMs: 20 * MIN, noXpMs: 0, episodeMs: 360 * MIN, maxSandboxRestarts: 3 });
  /**
   * One five-minute sleep, sampled once a minute as the state ticker samples
   * it through the sleep, then the wake answered in words alone. `xpAt` is the
   * xp each sample reads, by minute of the sleep.
   */
  const sleepAndTalk = (w: Watchdogs, c: ReturnType<typeof clock>, level: number, xpAt: (minute: number) => number): void => {
    w.noteAsleep();
    for (let m = 1; m <= 5; m++) {
      c.tick(MIN);
      w.noteProgress(level, xpAt(m));
    }
    w.noteAwake();
    w.noteModelOutput();
    w.noteWakeAnswered();
  };

  test("text-only wakes while a routine gains xp never end idle", () => {
    // The GPT-6.2 Sol e360s: codex has no yield, so a reply is its sleep, while its routine gained 300-800 xp a wake.
    const c = clock();
    const w = new Watchdogs(tier, c.now);
    w.noteProgress(20, 0);
    w.noteToolCall();
    w.noteWakeAnswered();
    let xp = 0;
    for (let k = 0; k < 60; k++) {
      sleepAndTalk(w, c, 20, () => (xp += 100));
      expect(w.check()).toBeNull();
    }
  });

  test("a level-up with xp back near zero is progress", () => {
    const c = clock();
    const w = new Watchdogs(tier, c.now);
    w.noteProgress(20, 9_000);
    w.noteToolCall();
    w.noteWakeAnswered();
    for (let k = 0; k < 3; k++) sleepAndTalk(w, c, 20, () => 9_000);
    sleepAndTalk(w, c, 21, (m) => (m === 5 ? 50 : 9_000));
    expect(w.check()).toBeNull();
    // Counted from the level-up: four more flat wakes are the window again.
    for (let k = 0; k < 3; k++) sleepAndTalk(w, c, 21, () => 50);
    expect(w.check()).toBeNull();
    sleepAndTalk(w, c, 21, () => 50);
    expect(w.check()?.reason).toBe("idle");
  });

  test("text-only wakes with no progress still end idle at four wakes and twenty minutes; a flat sample, the first included, is not progress", () => {
    // Haiku's run: routines stopped, "xp +0" wakes answered in a few words.
    const c = clock();
    const w = new Watchdogs(tier, c.now);
    w.noteToolCall();
    w.noteWakeAnswered();
    // The first sample (a resume's too) is where progress is measured from, not a rise.
    for (let k = 1; k <= 3; k++) {
      sleepAndTalk(w, c, 12, () => 4_000);
      expect(w.check()).toBeNull();
    }
    sleepAndTalk(w, c, 12, () => 4_000);
    expect(w.check()).toEqual({
      reason: "idle",
      detail: `no tool call and no level/xp progress for ${20 * MIN}ms: 4 wakes in a row answered without either`,
    });
  });

  test("a wake whose sleep progressed resets the count and the clock between flat ones", () => {
    const c = clock();
    const w = new Watchdogs(tier, c.now);
    w.noteProgress(15, 1_000);
    w.noteToolCall();
    w.noteWakeAnswered();
    for (let k = 0; k < 3; k++) sleepAndTalk(w, c, 15, () => 1_000);
    expect(w.check()).toBeNull();
    // One sleep the routine gained in.
    sleepAndTalk(w, c, 15, (m) => 1_000 + 100 * m);
    for (let k = 0; k < 3; k++) {
      sleepAndTalk(w, c, 15, () => 1_500);
      expect(w.check()).toBeNull();
    }
    sleepAndTalk(w, c, 15, () => 1_500);
    expect(w.check()?.reason).toBe("idle");
  });

  test("progress late in the window restarts its clock: a burst of flat wakes after it is not twenty minutes", () => {
    const c = clock();
    const w = new Watchdogs(tier, c.now);
    w.noteProgress(15, 1_000);
    w.noteToolCall();
    w.noteWakeAnswered();
    c.tick(19 * MIN);
    w.noteProgress(15, 1_200);
    for (let k = 0; k < 6; k++) {
      c.tick(10_000);
      w.noteModelOutput();
      w.noteWakeAnswered();
    }
    expect(w.check()).toBeNull();
  });
});
