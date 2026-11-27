/**
 * The camera director's one promise that matters outside the video
 * (`infra/camera/director.ts`): the camera is a GM in a live world, so it
 * sends a GM command only after the invisibility check read true, on every
 * login, re-logins included, and a client found visible is logged out and
 * stays out. A scripted client and a fake clock: no game client, no world.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CameraClient, INVISIBLE_LUA, type ClientStatus, type LuaResult } from "./camera/client";
import { Director, SKIP_CINEMATIC_LUA } from "./camera/director";
import { tempDirs } from "./temp-dirs";

const tempDir = tempDirs();
const IN_WORLD: ClientStatus = { state: "InWorld", in_world: true, ui_ready: true };
const CHAR_SELECT: ClientStatus = { state: "CharSelect", in_world: false, ui_ready: true };

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

/** A director over a scripted client, with a clock that moves only by its sleeps, stopping at `untilMs`. */
function rig(o: { untilMs: number; runsDir?: string; onTick?: (now: number) => void; restartAfterMs?: number }): Rig {
  const runsDir = o.runsDir ?? tempDir("wb-camera-director-");
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

/** Every `.appear` (and every other GM command) came after an invisibility check that read true, with no login in between. */
function appearsOnlyWhileInvisible(c: ScriptedClient): void {
  let checked = false;
  for (const s of c.sent) {
    if (s === INVISIBLE_LUA) checked = true;
    if (s.includes("EnterWorld()") || s.startsWith("Logout()")) checked = false;
    if (s.startsWith("SendChatMessage")) expect(checked, s).toBe(true);
  }
}

describe("a client that leaves the world mid-follow", () => {
  test("leaves the subject, is taken back in through the invisibility check, and follows again", async () => {
    const runsDir = tempDir("wb-camera-director-runs-");
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
    expect(r.client.count("Logout()")).toBe(1);
    expect(r.client.count("EnterWorld()")).toBe(1);
    expect(r.client.gmSent()).toEqual([]);
    expect(r.director.refusedForGood).toBe(true);
  });
});
