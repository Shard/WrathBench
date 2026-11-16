/**
 * The camera director keeps its client in the world on its own
 * (`infra/camera/director.ts`): a client that leaves the world while there is
 * nothing to follow, or mid-follow, is taken back in through the same login
 * and the same invisibility check; a client that cannot get back in says
 * `STUCK:`; a client found visible is logged out and stays out. A scripted
 * client and a fake clock: no game client, no world.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CameraClient, INVISIBLE_LUA, type ClientStatus, type LuaResult } from "./camera/client";
import { BLANK_RELOG_MS, Director, MIN_FRAME_BYTES, SKIP_CINEMATIC_LUA, STUCK_MS } from "./camera/director";
import { DEFAULT_LEAD_MS, DEFAULT_RING_MS, DEFAULT_TAIL_MS, Shutter } from "./camera/shutter";

const IN_WORLD: ClientStatus = { state: "InWorld", in_world: true, ui_ready: true };
const CHAR_SELECT: ClientStatus = { state: "CharSelect", in_world: false, ui_ready: true };
const LOGIN: ClientStatus = { state: "Login", in_world: false, ui_ready: true };

/** A camera client as its control port answers, scripted: what it is, and every Lua line it was sent, in order. */
class ScriptedClient extends CameraClient {
  st: ClientStatus | null = CHAR_SELECT;
  /** The answers the invisibility check reads, oldest first; the last one stands once the rest are spent. */
  invisible: unknown[] = [true];
  /** The subject's distance in the camera's view. */
  distance = -1;
  /**
   * The intro cinematic, as the client has it: latched (it starts once the
   * world is up), playing, or none. A stop sent while it is only latched leaves
   * the screen black for good, as the real client does.
   */
  cinematic: "none" | "latched" | "playing" = "none";
  /** The screen is stuck black: a fade nobody lifts until the client leaves the world. */
  black = false;
  /** How big a frame is while the screen is not black. */
  frameBytes = 0;
  /** When set, the size of each drawn frame in turn (a dark scene's, under the blank threshold). */
  sizes: (() => number) | null = null;
  readonly sent: string[] = [];

  constructor() {
    super("http://127.0.0.1:1", () => "", (() => Promise.reject(new Error("no network in a test"))) as unknown as typeof fetch);
  }

  /** Status polls the client stays down for after a quit, before its container has it at character select again. */
  restartPolls = 0;
  /** Quit()s it obeys; after these it ignores Quit() (a client that will not exit). */
  quitsObeyed = Number.POSITIVE_INFINITY;

  override async status(): Promise<ClientStatus | null> {
    if (this.restartPolls > 0 && --this.restartPolls === 0) this.st = { ...CHAR_SELECT };
    return this.st === null ? null : { ...this.st };
  }

  override async lua(src: string): Promise<LuaResult> {
    if (this.st === null) return { ok: false, error: "connection refused" };
    this.sent.push(src);
    if (src.includes("EnterWorld()") && this.st.state === "CharSelect") this.st = { ...IN_WORLD };
    if (src.startsWith("ForceQuit()") || (src.startsWith("Quit()") && this.quitsObeyed-- > 0)) {
      // The process exits; its container starts it again.
      this.st = null;
      this.distance = -1;
      this.black = false;
      this.restartPolls = 5;
      return { ok: true, values: [true] };
    }
    if (src.startsWith("Logout()")) {
      this.st = { ...CHAR_SELECT };
      this.black = false;
    }
    // A bare stop, sent without asking whether a cinematic plays.
    if (src.includes("StopCinematic") && src !== SKIP_CINEMATIC_LUA && this.cinematic === "latched") {
      this.cinematic = "none";
      this.black = true;
    }
    if (src.includes(".appear ")) this.distance = 5;
    const value = ((): unknown => {
      if (src === INVISIBLE_LUA) return this.invisible.length > 1 ? this.invisible.shift() : this.invisible[0];
      if (src === SKIP_CINEMATIC_LUA) {
        if (this.cinematic !== "playing") return false;
        this.cinematic = "none";
        return true;
      }
      if (src.includes("GetNumCharacters")) return 1;
      if (src.includes("GetZoneText")) return "Elwynn Forest";
      if (src.includes("UIParent:IsShown")) return false;
      if (src.includes("AgentNearby")) return this.distance;
      return true;
    })();
    return { ok: true, values: [value] };
  }

  override async screenshot(): Promise<Uint8Array | null> {
    if (this.st?.in_world !== true || this.frameBytes === 0) return null;
    return new Uint8Array(this.black ? 25_827 : (this.sizes?.() ?? this.frameBytes));
  }

  /** The GM commands it said, in order. */
  gmSent(): string[] {
    return this.sent.filter((s) => s.startsWith("SendChatMessage")).map((s) => /SendChatMessage\("([^"]*)"/.exec(s)?.[1] ?? s);
  }

  count(needle: string): number {
    return this.sent.filter((s) => s.includes(needle)).length;
  }
}

interface Rig {
  client: ScriptedClient;
  director: Director;
  logs: string[];
  /** Fake time since the start, ms. */
  elapsed: () => number;
  /** Run `fn` once fake time reaches `at` ms. */
  at: (at: number, fn: () => void) => void;
}

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A director over a scripted client, with a clock that moves only by its sleeps, stopping at `untilMs`. */
function rig(o: { untilMs: number; runsDir?: string; onTick?: (now: number) => void; restartAfterMs?: number }): Rig {
  const runsDir = o.runsDir ?? mkdtempSync(join(tmpdir(), "wb-camera-director-"));
  if (o.runsDir === undefined) dirs.push(runsDir);
  const start = Date.now();
  let now = start;
  const timers: { at: number; fn: () => void }[] = [];
  const logs: string[] = [];
  const client = new ScriptedClient();
  const director = new Director({
    client,
    runsDir,
    world: "shared",
    intervalMs: 10_000,
    race: 1,
    createOnly: false,
    ...(o.restartAfterMs !== undefined ? { restartAfterMs: o.restartAfterMs } : {}),
    stopping: () => now - start >= o.untilMs,
    log: (l) => logs.push(`${Math.round((now - start) / 1000)}s ${l}`),
    now: () => now,
    sleep: async (ms) => {
      now += ms;
      for (const t of timers.filter((t) => now - start >= t.at)) {
        timers.splice(timers.indexOf(t), 1);
        t.fn();
      }
      o.onTick?.(now);
    },
  });
  return { client, director, logs, elapsed: () => now - start, at: (at, fn) => timers.push({ at, fn }) };
}

/** A live freeplay run on the shared world, its heartbeat kept fresh by the fake clock. */
function liveRun(): { runsDir: string; run: string; beat: (now: number) => void } {
  const runsDir = mkdtempSync(join(tmpdir(), "wb-camera-director-runs-"));
  dirs.push(runsDir);
  const run = join(runsDir, "freeplay-run");
  mkdirSync(join(run, "session"), { recursive: true });
  writeFileSync(join(run, "meta.json"), JSON.stringify({ startedAt: Date.now(), config: { character: "Subjectone" } }));
  writeFileSync(join(run, "session", "session.json"), JSON.stringify({ id: "freeplay-run" }));
  writeFileSync(join(run, "heartbeat"), "host 1");
  const beat = (now: number): void => utimesSync(join(run, "heartbeat"), now / 1000, now / 1000);
  beat(Date.now());
  return { runsDir, run, beat };
}

/** Every `.appear` (and every other GM command) came after an invisibility check that read true, with no login in between. */
function appearsOnlyWhileInvisible(c: ScriptedClient): void {
  let checked = false;
  for (const s of c.sent) {
    if (s === INVISIBLE_LUA) checked = true;
    if (s.includes("EnterWorld()") || s.startsWith("Logout()")) checked = false;
    if (s.startsWith("SendChatMessage")) expect(checked, s).toBe(true);
  }
}

describe("a client that leaves the world while there is nothing to follow", () => {
  test("is taken back in, through the invisibility check, and the log says so", async () => {
    const r = rig({ untilMs: 10 * 60_000 });
    // In the world, then its process falls over and comes back at character select (what v1's shared camera did).
    r.at(2 * 60_000, () => (r.client.st = null));
    r.at(2 * 60_000 + 30_000, () => (r.client.st = { ...CHAR_SELECT }));
    await r.director.live();
    expect(r.client.count("EnterWorld()")).toBe(2);
    expect(r.client.st?.in_world).toBe(true);
    expect(r.logs.some((l) => l.includes("no live run on shared to follow"))).toBe(true);
    expect(r.logs.some((l) => l.includes("the client left the world while idle (no answer from the client)"))).toBe(true);
    expect(r.logs.some((l) => /in the world, invisible, after \d+ s out/.test(l))).toBe(true);
    expect(r.logs.some((l) => l.includes("STUCK"))).toBe(false);
    expect(r.client.gmSent()).toEqual([".morph target 11686", ".morph target 11686"]);
    appearsOnlyWhileInvisible(r.client);
  });

  test("that cannot get back in is STUCK, every few minutes, with where it is", async () => {
    const r = rig({ untilMs: 3 * STUCK_MS });
    r.at(60_000, () => (r.client.st = { ...LOGIN }));
    await r.director.live();
    const stuck = r.logs.filter((l) => l.includes("STUCK: the client has been out of the world"));
    expect(stuck.length).toBeGreaterThanOrEqual(2);
    expect(stuck[0]).toContain("(Login)");
    // Where it is is said once, not every poll.
    expect(r.logs.filter((l) => l.includes("the client is not in the world (Login)"))).toHaveLength(1);
    expect(r.client.count("EnterWorld()")).toBe(1);
  });
});

describe("a client that leaves the world mid-follow", () => {
  test("leaves the subject, is taken back in, and follows again", async () => {
    const runsDir = mkdtempSync(join(tmpdir(), "wb-camera-director-runs-"));
    dirs.push(runsDir);
    const run = join(runsDir, "freeplay-run");
    mkdirSync(join(run, "session"), { recursive: true });
    writeFileSync(join(run, "meta.json"), JSON.stringify({ startedAt: Date.now(), config: { character: "Subjectone" } }));
    writeFileSync(join(run, "session", "session.json"), JSON.stringify({ id: "freeplay-run" }));
    writeFileSync(join(run, "heartbeat"), "host 1");
    const beat = (now: number): void => utimesSync(join(run, "heartbeat"), now / 1000, now / 1000);
    beat(Date.now());
    const r = rig({ untilMs: 5 * 60_000, runsDir, onTick: beat });
    // A worldserver restart: the client's session is gone for a while, then it is back at character select.
    r.at(90_000, () => {
      r.client.st = null;
      r.client.distance = -1;
    });
    r.at(150_000, () => (r.client.st = { ...CHAR_SELECT }));
    await r.director.live();
    expect(r.logs.filter((l) => l.includes("following freeplay-run (Subjectone)")).length).toBe(2);
    expect(r.logs.some((l) => l.includes("the client is not in the world; logging in again"))).toBe(true);
    expect(r.client.count("EnterWorld()")).toBe(2);
    expect(r.client.gmSent().filter((g) => g === ".appear Subjectone").length).toBe(2);
    appearsOnlyWhileInvisible(r.client);
  });
});

describe("invisibility", () => {
  test("a camera found visible logs out, sends no GM command, and stays out", async () => {
    const r = rig({ untilMs: 10 * 60_000 });
    r.client.invisible = [false];
    await r.director.live();
    expect(r.logs.some((l) => l.includes("REFUSED: the camera entered the world without GM invisibility"))).toBe(true);
    expect(r.client.count("Logout()")).toBe(1);
    expect(r.client.count("EnterWorld()")).toBe(1);
    expect(r.client.gmSent()).toEqual([]);
    expect(r.director.refusedForGood).toBe(true);
  });
});

describe("a new character's intro cinematic", () => {
  test("is skipped only once it plays, so the screen never sticks black", async () => {
    const r = rig({ untilMs: 60_000 });
    // A first login: the server triggers the intro, which the client starts a moment after the zone text is up.
    r.client.cinematic = "latched";
    r.at(2_000, () => (r.client.cinematic = "playing"));
    await r.director.live();
    expect(r.client.black).toBe(false);
    expect(r.client.cinematic as string).toBe("none");
    expect(r.logs.filter((l) => l.includes("skipped the intro cinematic"))).toHaveLength(1);
    expect(r.client.sent.filter((s) => s.includes("StopCinematic") && s !== SKIP_CINEMATIC_LUA)).toEqual([]);
  });

  test("with none, the login goes on after a short look", async () => {
    const r = rig({ untilMs: 60_000 });
    await r.director.live();
    expect(r.logs.some((l) => l.includes("skipped the intro cinematic"))).toBe(false);
    const entered = r.logs.find((l) => l.includes("in the world, invisible"));
    expect(entered).toBeDefined();
    expect(Number(/^(\d+)s/.exec(entered!)?.[1])).toBeLessThanOrEqual(10);
  });

  test("one that starts after the login looked is skipped while following", async () => {
    const { runsDir, beat } = liveRun();
    const r = rig({ untilMs: 2 * 60_000, runsDir, onTick: beat });
    r.client.frameBytes = 120_000;
    r.at(30_000, () => (r.client.cinematic = "playing"));
    await r.director.live();
    expect(r.client.cinematic as string).toBe("none");
    expect(r.logs.filter((l) => l.includes("skipped the intro cinematic"))).toHaveLength(1);
  });
});

describe("a screen stuck black", () => {
  test("is cleared by logging out and in again, and frames are kept after", async () => {
    const { runsDir, run, beat } = liveRun();
    const r = rig({ untilMs: BLANK_RELOG_MS + 3 * 60_000, runsDir, onTick: beat });
    r.client.frameBytes = MIN_FRAME_BYTES * 4;
    r.client.black = true;
    await r.director.live();
    expect(r.logs.filter((l) => l.includes("the screen is stuck; logging out and in again"))).toHaveLength(1);
    expect(r.client.count("Logout()")).toBe(1);
    expect(r.client.count("EnterWorld()")).toBe(2);
    expect(r.logs.filter((l) => l.includes("following freeplay-run (Subjectone)"))).toHaveLength(2);
    // Frames once the screen is back, none of them blank.
    const index = readFileSync(join(run, "camera", "frames.jsonl"), "utf8").trim().split("\n");
    expect(index.length).toBeGreaterThan(0);
    appearsOnlyWhileInvisible(r.client);
  });

  test("a dark scene's small frames, each a different size, are never taken for one", async () => {
    const { runsDir, beat } = liveRun();
    const r = rig({ untilMs: BLANK_RELOG_MS + 3 * 60_000, runsDir, onTick: beat });
    let n = 0;
    r.client.frameBytes = MIN_FRAME_BYTES * 4;
    r.client.sizes = () => 24_000 + (n++ % 50) * 100;
    await r.director.live();
    expect(r.logs.some((l) => l.includes("skip: a blank frame"))).toBe(true);
    expect(r.client.count("Logout()")).toBe(0);
  });

  test("a frame between blanks restarts the count: no logout", async () => {
    const { runsDir, beat } = liveRun();
    const r = rig({ untilMs: BLANK_RELOG_MS + 2 * 60_000, runsDir, onTick: beat });
    r.client.frameBytes = MIN_FRAME_BYTES * 4;
    r.client.black = true;
    // A drawn frame now and then (a dark spell, not a stuck screen).
    for (let t = 60_000; t < BLANK_RELOG_MS + 2 * 60_000; t += 2 * 60_000) {
      r.at(t, () => (r.client.black = false));
      r.at(t + 2_000, () => (r.client.black = true));
    }
    await r.director.live();
    expect(r.client.count("Logout()")).toBe(0);
  });
});

/** A session event, appended to the run's session record as the recorder writes it. */
function writeEvent(run: string, row: Record<string, unknown>): void {
  const dir = join(run, "session", "events");
  mkdirSync(dir, { recursive: true });
  // Any segment name on the 5-minute grid.
  appendFileSync(join(dir, "1699999800000.jsonl"), `${JSON.stringify(row)}\n`);
}

describe("the scheduled restart", () => {
  const HOUR = 60 * 60_000;

  test("quits the client after the interval, logs it as scheduled, and it is taken back in and follows again", async () => {
    const { runsDir, beat } = liveRun();
    const r = rig({ untilMs: HOUR + 5 * 60_000, runsDir, onTick: beat, restartAfterMs: HOUR });
    r.client.frameBytes = MIN_FRAME_BYTES * 4;
    await r.director.live();
    const restarts = r.logs.filter((l) => l.includes("scheduled restart: the client has been in the world 60 min"));
    expect(restarts).toHaveLength(1);
    expect(r.client.count("Quit()")).toBe(1);
    expect(r.client.count("ForceQuit()")).toBe(0);
    expect(r.client.count("EnterWorld()")).toBe(2);
    expect(r.logs.filter((l) => l.includes("following freeplay-run (Subjectone)"))).toHaveLength(2);
    // At the interval, give or take a tick.
    const at = Number(/^(\d+)s/.exec(restarts[0]!)?.[1]);
    expect(at * 1000).toBeGreaterThanOrEqual(HOUR);
    expect(at * 1000).toBeLessThan(HOUR + 20_000);
    appearsOnlyWhileInvisible(r.client);
  });

  test("waits out an event's burst: never mid-event", async () => {
    const { runsDir, run, beat } = liveRun();
    // The rig's clock starts at the wall clock (to the millisecond) and moves only by its sleeps.
    const wall0 = Date.now();
    const r = rig({ untilMs: HOUR + 5 * 60_000, runsDir, onTick: beat, restartAfterMs: HOUR });
    r.client.frameBytes = MIN_FRAME_BYTES * 4;
    // A level-up just before the restart falls due.
    r.at(HOUR - 5_000, () => writeEvent(run, { ts: wall0 + r.elapsed(), kind: "level", from: 4, to: 5 }));
    await r.director.live();
    expect(r.logs.some((l) => l.includes("event level: reached level 5"))).toBe(true);
    const restart = r.logs.find((l) => l.includes("scheduled restart:"));
    expect(restart).toBeDefined();
    const at = Number(/^(\d+)s/.exec(restart!)?.[1]) * 1000;
    // Not before the event's tail has left the ring.
    expect(at).toBeGreaterThanOrEqual(HOUR - 5_000 + DEFAULT_TAIL_MS + DEFAULT_RING_MS);
  });

  test("an interval of 0 never restarts the client", async () => {
    const { runsDir, beat } = liveRun();
    const r = rig({ untilMs: 3 * HOUR, runsDir, onTick: beat, restartAfterMs: 0 });
    r.client.frameBytes = MIN_FRAME_BYTES * 4;
    await r.director.live();
    expect(r.client.count("Quit()")).toBe(0);
    expect(r.logs.some((l) => l.includes("scheduled restart"))).toBe(false);
  });

  test("while idle, the client is restarted at the interval all the same", async () => {
    const r = rig({ untilMs: HOUR + 5 * 60_000, restartAfterMs: HOUR });
    await r.director.live();
    expect(r.logs.filter((l) => l.includes("scheduled restart:"))).toHaveLength(1);
    expect(r.client.count("EnterWorld()")).toBe(2);
  });

  test("a client that does not exit on Quit() is force-quit", async () => {
    const r = rig({ untilMs: HOUR + 5 * 60_000, restartAfterMs: HOUR });
    r.client.quitsObeyed = 0;
    await r.director.live();
    expect(r.logs.some((l) => l.includes("did not exit on Quit(); ForceQuit()"))).toBe(true);
    expect(r.client.count("ForceQuit()")).toBe(1);
    expect(r.client.count("EnterWorld()")).toBe(2);
  });
});

describe("the shutter's quiet moment", () => {
  test("is not quiet while an event's frames are being kept, and is once its tail has left the ring", () => {
    const sh = new Shutter({ intervalMs: 10_000 });
    const t0 = 1_000_000;
    expect(sh.quiet(t0)).toBe(true);
    sh.event({ ts: t0, type: "quest", detail: "turned in quest 1" });
    expect(sh.quiet(t0 - DEFAULT_LEAD_MS)).toBe(false);
    expect(sh.quiet(t0 + DEFAULT_TAIL_MS)).toBe(false);
    expect(sh.quiet(t0 + DEFAULT_TAIL_MS + DEFAULT_RING_MS - 1)).toBe(false);
    expect(sh.quiet(t0 + DEFAULT_TAIL_MS + DEFAULT_RING_MS + 1)).toBe(true);
  });

  test("start and end marks never hold it", () => {
    const sh = new Shutter({ intervalMs: 10_000 });
    sh.event({ ts: 5_000, type: "start", detail: "camera attached" });
    sh.event({ ts: 5_000, type: "end", detail: "run ended" });
    expect(sh.quiet(5_000)).toBe(true);
  });
});
