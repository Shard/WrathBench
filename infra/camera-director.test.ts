/**
 * The camera director keeps its client in the world on its own
 * (`infra/camera/director.ts`): a client that leaves the world while there is
 * nothing to follow, or mid-follow, is taken back in through the same login
 * and the same invisibility check; a client that cannot get back in says
 * `STUCK:`; a client found visible is logged out and stays out. A scripted
 * client and a fake clock: no game client, no world.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CameraClient, INVISIBLE_LUA, type ClientStatus, type LuaResult } from "./camera/client";
import { Director, STUCK_MS } from "./camera/director";

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
  readonly sent: string[] = [];

  constructor() {
    super("http://127.0.0.1:1", () => "", (() => Promise.reject(new Error("no network in a test"))) as unknown as typeof fetch);
  }

  override async status(): Promise<ClientStatus | null> {
    return this.st === null ? null : { ...this.st };
  }

  override async lua(src: string): Promise<LuaResult> {
    if (this.st === null) return { ok: false, error: "connection refused" };
    this.sent.push(src);
    if (src.includes("EnterWorld()") && this.st.state === "CharSelect") this.st = { ...IN_WORLD };
    if (src.startsWith("Logout()")) this.st = { ...CHAR_SELECT };
    if (src.includes(".appear ")) this.distance = 5;
    const value = ((): unknown => {
      if (src === INVISIBLE_LUA) return this.invisible.length > 1 ? this.invisible.shift() : this.invisible[0];
      if (src.includes("GetNumCharacters")) return 1;
      if (src.includes("GetZoneText")) return "Elwynn Forest";
      if (src.includes("UIParent:IsShown")) return false;
      if (src.includes("AgentNearby")) return this.distance;
      return true;
    })();
    return { ok: true, values: [value] };
  }

  override async screenshot(): Promise<Uint8Array | null> {
    return null;
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
function rig(o: { untilMs: number; runsDir?: string; onTick?: (now: number) => void }): Rig {
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

  test("one visible reading while the auras arrive is read again, not a refusal", async () => {
    const r = rig({ untilMs: 60_000 });
    r.client.invisible = [false, true];
    await r.director.live();
    expect(r.director.refusedForGood).toBe(false);
    expect(r.client.count("Logout()")).toBe(0);
    expect(r.client.gmSent()).toEqual([".morph target 11686"]);
    appearsOnlyWhileInvisible(r.client);
  });
});
