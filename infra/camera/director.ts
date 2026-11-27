/**
 * The camera director (docs/ARCHITECTURE.md, "Camera"; docs/RUNBOOK.md,
 * "Camera"). One per camera client, in the same pod: it logs the client in,
 * checks it is invisible, picks a subject on this world, keeps the client on
 * it with GM movement commands, and keeps frames per the layout in
 * `layout.ts`; when the subject's run ends it assembles the run's video.
 *
 * What it may do in the world is fixed here and nowhere else: `.appear
 * <subject>` to move to the subject, `.morph target 11686` to hide the
 * camera's own body, skip its own character's intro cinematic, and log
 * itself out (found visible, or its screen stuck black). It never targets,
 * says, casts or moves otherwise, and it never moves while the client is
 * visible: every `.appear` is preceded by the invisibility check, and a
 * camera found visible logs out and stays out.
 *
 * It keeps the client in the world on its own: a client that leaves it (its
 * process restarted after a crash, a worldserver restart, a lost session) is
 * found at its next tick, idle or following, and taken back in through the
 * same login and the same invisibility check. A client that cannot get back
 * in says so: `STUCK:` every few minutes while it is out, with where it is.
 *
 * It restarts the client on a schedule (`CAMERA_RESTART_MINUTES`, 60; 0 is
 * off): the client's heap grows with the ground it streams and is not given
 * back, and a cgroup OOM is otherwise what restarts it. After that long in the
 * world, at a moment no event's frames are being kept (or while idle), it
 * quits the client, which its container starts again; the same recovery then
 * takes it back in. Each one logs `scheduled restart:`, so it never reads as a
 * crash or an OOM.
 *
 *   bun infra/camera/director.ts [--run <id>] [--create-only] [--forward-world host:port [--forward-only]]
 *
 * Environment: CAMERA_WORLD (a world id, or `shared`), CAMERA_INTERVAL_SECONDS
 * (10), CAMERA_PORT (17980), CAMERA_RUN_DIR (/run/camera: the client's token),
 * CAMERA_RUNS_DIR (data/runs), CAMERA_RACE (1, Human), CAMERA_RESTART_MINUTES
 * (60; 0 is off).
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { StoredSessionHandle } from "@wrathbench/inspector";
import { DEADMINES_BOSSES } from "../../viewer/deadmines";
import { assembleRun } from "./assemble";
import { CameraClient, INVISIBLE_LUA, luaString, subjectDistanceLua, WORLD_ONLY_LUA, type ClientStatus } from "./client";
import { forwardLoopback } from "./forward";
import { cameraDir, FRAMES_DIR, FRAMES_INDEX, frameFile, JPEG_QUALITY, parseFrames, type FrameLine } from "./layout";
import { cameraEventOf, Shutter, type Kept, type SessionEventRow } from "./shutter";
import { notLive, subjectOf, subjectsOn, type Subject } from "./subjects";

/** A display with no model: the body vanishes. */
export const HIDDEN_DISPLAY = 11686;
const CAPTURE_EVERY_MS = 1_000;
/** Beyond this the subject is re-joined. Inside visibility range, so the client still streams it. */
const REJOIN_YARDS = 25;
/** The least time between two `.appear`s on one map. */
const APPEAR_COOLDOWN_MS = 3_000;
/** A cross-map `.appear` sent during the loading screen is lost: wait it out before trying again. */
const LOADING_WAIT_MS = 12_000;
const SUBJECT_CHECK_MS = 10_000;
/** With no subject, how often the client is checked to be still in the world. */
export const IDLE_CHECK_MS = 15_000;
/** With no subject, how often the director says it is idle, so a quiet log reads as idle and not as hung. */
export const IDLE_LOG_MS = 30 * 60_000;
/** Out of the world this long and still not back in: `STUCK:`, and again each time this long passes. */
const STUCK_MS = 5 * 60_000;
/** Between a left `run()` and the next login attempt. */
export const RETRY_MS = 15_000;
/** The default for `CAMERA_RESTART_MINUTES`: the shortest OOM seen on the reference node was 76 min after a client start. */
export const DEFAULT_RESTART_MINUTES = 60;
/** After `Quit()`, how long the client gets to log out and exit before `ForceQuit()`. */
export const QUIT_WAIT_MS = 30_000;
/**
 * A 1280×720 JPEG at q75 under this is a flat field (a black frame is about
 * 25 KB; a scene is 100 KB and up): a frame not drawn yet, never kept.
 */
const MIN_FRAME_BYTES = 32_000;
/**
 * After the zone text is up, how long to watch for the intro cinematic a new
 * character's first login plays. It starts a fade and a frame after the loading
 * screen clears, which is when the zone text appears.
 */
export const CINEMATIC_WAIT_MS = 5_000;
/**
 * The same blank frame, byte for byte in size, with the subject in range, for
 * this long: the client's screen is stuck black (a fade it never lifted).
 * Leaving the world clears it, so the camera logs out and back in. A dark or
 * foggy scene under the blank threshold varies in size from frame to frame,
 * so it never counts.
 */
const BLANK_RELOG_MS = 3 * 60_000;
/**
 * Stops a cinematic only while one plays. `StopCinematic()` on a cinematic the
 * client has latched but not yet started leaves its fade-out at black for good,
 * so it is never sent blind.
 */
export const SKIP_CINEMATIC_LUA = "if InCinematic() then StopCinematic() return true end return false";

export interface DirectorOptions {
  client: CameraClient;
  runsDir: string;
  world: string;
  intervalMs: number;
  race: number;
  pinnedRun?: string;
  createOnly: boolean;
  /** Restart the client after this long in the world, at a quiet moment; 0 or absent is never. */
  restartAfterMs?: number;
  /** Set when the process is asked to stop: the follow loop keeps what the ring holds and returns. */
  stopping?: () => boolean;
  log: (line: string) => void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/** A name the server takes: letters only, capitalised, unlikely to be anyone's. */
export function cameraName(random: () => number = Math.random): string {
  const c = "bdfgklmnprstvz";
  const v = "aeiou";
  let s = "";
  for (let i = 0; i < 4; i++) s += c[Math.floor(random() * c.length)]! + v[Math.floor(random() * v.length)]!;
  return `${s[0]!.toUpperCase()}${s.slice(1)}`;
}

export class Director {
  private readonly o: DirectorOptions;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly bosses = new Set(DEADMINES_BOSSES);
  private refused = false;
  /** The client left the world under the director (a disconnect, a world restart). */
  private lost = false;
  /** Since when the client has been out of the world while the director wanted it in; null while it is in. */
  private outSince: number | null = null;
  private lastStuckLog = 0;
  /** Since when the client has been in the world, for the scheduled restart; null while it is out. */
  private inWorldSince: number | null = null;

  constructor(o: DirectorOptions) {
    this.o = o;
    this.now = o.now ?? Date.now;
    this.sleep = o.sleep ?? ((ms) => Bun.sleep(ms));
  }

  private log(line: string): void {
    this.o.log(line);
  }

  /** Where the client is, for a log line: its state, or `no answer` when its port does not answer. */
  private static where(st: ClientStatus | null): string {
    if (st === null) return "no answer from the client";
    return `${st.state ?? "unknown state"}${st.ui_ready === true ? "" : ", UI not ready"}`;
  }

  /** The client is out of the world under the director: `run()` returns, and the clock for `STUCK:` starts. */
  private markLost(): void {
    this.lost = true;
    if (this.outSince === null) {
      this.outSince = this.now();
      this.lastStuckLog = this.outSince;
    }
  }

  /** `STUCK:` once the client has been out of the world for `STUCK_MS`, and every `STUCK_MS` after. */
  private stuckCheck(where: string): void {
    const now = this.now();
    if (this.outSince === null) {
      this.outSince = now;
      this.lastStuckLog = now;
      return;
    }
    if (now - this.lastStuckLog >= STUCK_MS) {
      this.lastStuckLog = now;
      this.log(`STUCK: the client has been out of the world for ${Math.round((now - this.outSince) / 60_000)} min (${where}); still trying`);
    }
  }

  /**
   * Logged in and in the world, true; false when it did not get there: refused
   * (the client is left logged out), asked to stop, `--create-only`, or the
   * client dropped out again before the check (`lost`; the caller tries again).
   */
  async enterWorld(): Promise<boolean> {
    const c = this.o.client;
    let last = "";
    let entering = false;
    for (;;) {
      if (this.o.stopping?.() === true) return false;
      const st = await c.status();
      if (st?.in_world === true) break;
      const where = Director.where(st);
      if (where !== last) {
        this.log(`the client is not in the world (${where}); waiting for character select`);
        last = where;
      }
      this.stuckCheck(where);
      if (st?.ui_ready === true && st.state === "CharSelect") {
        const n = Number(await c.value("return GetNumCharacters()"));
        if (!(n > 0)) {
          const name = cameraName();
          this.log(`creating the camera character ${name}`);
          await c.lua(`SetGlueScreen("charcreate") return true`);
          await this.sleep(1_500);
          await c.lua(`SetSelectedRace(${this.o.race}) SetSelectedClass(1) CreateCharacter(${luaString(name)}) return true`);
          await this.sleep(3_000);
          continue;
        }
        if (this.o.createOnly) {
          this.log(`a camera character exists (${String(await c.value("return GetCharacterInfo(1)"))}); --create-only: not entering the world`);
          return false;
        }
        // Said once; a client that stays at character select is `STUCK:` in time.
        if (!entering) this.log("entering the world");
        entering = true;
        await c.lua("SelectCharacter(1) EnterWorld() return true");
        await this.sleep(5_000);
        continue;
      }
      await this.sleep(2_000);
    }
    // The world's own config makes the camera a GM and invisible before it is
    // on the map (GM.LoginState = 1, GM.Visible = 0); check, never assume.
    for (let i = 0; i < 30 && String((await c.value("return GetZoneText()")) ?? "") === ""; i++) await this.sleep(1_000);
    // A new character's first login plays its race's intro: skip it once it is playing.
    for (let waited = 0; waited < CINEMATIC_WAIT_MS; waited += 1_000) {
      if ((await this.skipCinematic()) || (await c.status())?.in_world !== true) break;
      await this.sleep(1_000);
    }
    const v = await this.visibility();
    if (v === "unknown") {
      // Out again before it could be checked (a crash, a disconnect): nothing was sent; try again.
      this.log("the client left the world before its invisibility could be checked; logging in again");
      this.markLost();
      return false;
    }
    if (v === "visible") {
      this.log("REFUSED: the camera entered the world without GM invisibility; the world's GM.Visible is not 0. Logging out; nothing else is sent");
      await c.lua("Logout() return true");
      this.refused = true;
      return false;
    }
    await c.lua(WORLD_ONLY_LUA);
    await this.hideBody();
    if (this.outSince !== null) this.log(`in the world, invisible, after ${Math.round((this.now() - this.outSince) / 1000)} s out`);
    else this.log("in the world, invisible");
    this.outSince = null;
    this.inWorldSince = this.now();
    return true;
  }

  /** Whether the camera carries GM invisibility; `unknown` when the client cannot say (not in the world, no answer). */
  async visibility(): Promise<"invisible" | "visible" | "unknown"> {
    const st = await this.o.client.status();
    if (st?.in_world !== true) return "unknown";
    const v = await this.o.client.value(INVISIBLE_LUA);
    return v === true ? "invisible" : v === false ? "visible" : "unknown";
  }

  /** True once the camera has refused to act: it stays logged out for the life of the process. */
  get refusedForGood(): boolean {
    return this.refused;
  }

  /** The client has been in the world for its scheduled restart's interval. */
  private restartDue(): boolean {
    const after = this.o.restartAfterMs ?? 0;
    return after > 0 && this.inWorldSince !== null && this.now() - this.inWorldSince >= after;
  }

  /**
   * The scheduled restart: `Quit()` (a GM logs out at once, then the client
   * exits), `ForceQuit()` should it still answer after `QUIT_WAIT_MS`. Its
   * container starts it again; the caller returns and the recovery logs it
   * back in.
   */
  private async restartClient(): Promise<void> {
    const c = this.o.client;
    const mins = Math.round((this.now() - (this.inWorldSince ?? this.now())) / 60_000);
    this.log(`scheduled restart: the client has been in the world ${mins} min; quitting it to give its memory back (not a crash or an OOM)`);
    this.inWorldSince = null;
    await c.lua("Quit() return true");
    let gone = false;
    for (let waited = 0; waited < QUIT_WAIT_MS; waited += 2_000) {
      await this.sleep(2_000);
      if ((await c.status()) === null) {
        gone = true;
        break;
      }
    }
    if (!gone) {
      this.log("scheduled restart: the client did not exit on Quit(); ForceQuit()");
      await c.lua("ForceQuit() return true");
    }
    this.markLost();
  }

  /** Skips a cinematic that is playing; true when there was one. */
  private async skipCinematic(): Promise<boolean> {
    if ((await this.o.client.value(SKIP_CINEMATIC_LUA)) !== true) return false;
    this.log("skipped the intro cinematic");
    return true;
  }

  private async hideBody(): Promise<void> {
    await this.o.client.gm(`.morph target ${HIDDEN_DISPLAY}`);
  }

  /** The client-only chase view behind the subject (`AgentViewSubject`), where the camera client has it; it survives a map change. */
  private async chase(subject: Subject): Promise<void> {
    await this.o.client.lua(`if type(AgentViewSubject)=="function" then AgentViewSubject(${luaString(subject.character)}) end return true`);
  }

  /** `.appear`, only while invisible. False when it was not sent. */
  private async appear(subject: Subject): Promise<boolean> {
    const v = await this.visibility();
    if (v === "visible") {
      this.log("REFUSED .appear: the camera is not invisible; logging out");
      await this.o.client.lua("Logout() return true");
      this.refused = true;
      return false;
    }
    if (v === "unknown") {
      this.log("the client is not in the world; logging in again");
      this.markLost();
      return false;
    }
    return this.o.client.gm(`.appear ${subject.character}`);
  }

  private async distance(subject: Subject): Promise<number> {
    const d = Number(await this.o.client.value(subjectDistanceLua(subject.character)));
    return Number.isFinite(d) ? d : -1;
  }

  /** The subject's map from its session's last reading. */
  private subjectMap(subject: Subject): number | null {
    try {
      const live = JSON.parse(readFileSync(join(subject.sessionDir, "live.json"), "utf8")) as { map?: unknown };
      return typeof live.map === "number" ? live.map : null;
    } catch {
      return null;
    }
  }

  private pick(): Subject | null {
    if (this.o.pinnedRun !== undefined) return subjectOf(this.o.runsDir, this.o.pinnedRun);
    return subjectsOn(this.o.runsDir, this.o.world, this.now())[0] ?? null;
  }

  /** Follow one subject until its run stops being live. */
  async follow(subject: Subject): Promise<void> {
    const c = this.o.client;
    const dir = cameraDir(subject.runDir);
    mkdirSync(join(dir, FRAMES_DIR), { recursive: true });
    const index = join(dir, FRAMES_INDEX);
    let seq = existsSync(index) ? Math.max(0, ...parseFrames(readFileSync(index, "utf8")).map((f) => f.seq + 1)) : 0;
    const keep = (k: Kept) => {
      const file = frameFile(seq);
      writeFileSync(join(dir, `${file}.tmp`), k.frame.bytes);
      renameSync(join(dir, `${file}.tmp`), join(dir, file));
      const line: FrameLine = { seq, t: new Date(k.frame.ts).toISOString(), file, kind: k.kind, ...(k.event !== undefined ? { event: k.event } : {}) };
      appendFileSync(index, `${JSON.stringify(line)}\n`);
      seq++;
    };
    const shutter = new Shutter({ intervalMs: this.o.intervalMs });
    const session = new StoredSessionHandle(subject.runId, subject.sessionDir);
    let cursor = await session.end("events");
    // The run's `camera` label is the runner's to write, from the frame index (runner/src/trajectory.ts); never written here into a live run's meta.json.
    this.log(`following ${subject.runId} (${subject.character})`);

    let lastAppear = 0;
    let appearMap: number | null = null;
    let loadingUntil = 0;
    let needSetup = true;
    let lastCheck = this.now();
    let started = false;
    let skips = 0;
    /** Since when every frame in range has been the same blank frame; null after a kept one. */
    let blankSince: number | null = null;
    let blankBytes = 0;
    for (;;) {
      if (this.refused || this.lost || this.o.stopping?.() === true) break;
      const tick = this.now();
      // Events since the last tick.
      try {
        const batch = await session.tail("events", cursor);
        cursor = batch.cursor ?? cursor;
        for (const row of batch.rows as unknown as SessionEventRow[]) {
          const e = cameraEventOf(row, this.bosses);
          if (e !== null) {
            shutter.event(e);
            this.log(`event ${e.type}: ${e.detail}`);
          }
        }
      } catch (e) {
        this.log(`events: ${e instanceof Error ? e.message : String(e)}`);
      }
      // The scheduled restart, only while no event's frames are being kept; the ring's frames are kept below.
      if (this.restartDue() && shutter.quiet(tick)) {
        await this.restartClient();
        break;
      }
      // Stay on the subject.
      const map = this.subjectMap(subject);
      const crossMap = map !== null && appearMap !== null && map !== appearMap;
      if (tick >= loadingUntil) {
        const d = await this.distance(subject);
        if ((d < 0 || d > REJOIN_YARDS || crossMap) && tick - lastAppear >= APPEAR_COOLDOWN_MS) {
          // Not sent (refused, lost, or the command failed): the tick still waits out its second below.
          if (await this.appear(subject)) {
            const changing = crossMap || appearMap === null;
            lastAppear = tick;
            appearMap = map;
            if (changing) {
              // A new map is a loading screen, after which the morph and the view are gone.
              loadingUntil = tick + LOADING_WAIT_MS;
              needSetup = true;
            }
          }
        } else if (d >= 0 && d <= REJOIN_YARDS) {
          if (needSetup) {
            await this.hideBody();
            await c.lua(WORLD_ONLY_LUA);
            await this.chase(subject);
            needSetup = false;
          }
          const bytes = await c.screenshot(JPEG_QUALITY);
          if (bytes !== null && bytes.length < MIN_FRAME_BYTES) {
            if (++skips % 30 === 1) this.log(`skip: a blank frame (${bytes.length} bytes)`);
            if (blankSince === null || bytes.length !== blankBytes) {
              blankSince = tick;
              blankBytes = bytes.length;
            }
            if (tick - blankSince >= BLANK_RELOG_MS) {
              this.log(`only blank frames for ${Math.round((tick - blankSince) / 60_000)} min with ${subject.character} in view: the screen is stuck; logging out and in again`);
              await c.lua("Logout() return true");
              this.markLost();
              break;
            }
          } else if (bytes !== null) {
            blankSince = null;
            const ts = this.now();
            if (!started) {
              shutter.event({ ts, type: "start", detail: "camera attached" });
              started = true;
            }
            shutter.add({ ts, bytes });
          }
        } else if (++skips % 30 === 1) this.log(`skip: ${subject.character} not in view (${d})`);
      }
      for (const k of shutter.due(this.now())) keep(k);
      // Still live?
      if (tick - lastCheck >= SUBJECT_CHECK_MS) {
        lastCheck = tick;
        // A client that came back in the world on its own (a silent reconnect) has a new interface: shown again, the morph gone.
        if (!needSetup && (await c.value("return UIParent:IsShown() and true or false")) === true) needSetup = true;
        // An intro that started after `enterWorld` stopped watching for it.
        if (await this.skipCinematic()) needSetup = true;
        let meta: Parameters<typeof notLive>[1] = null;
        try {
          meta = JSON.parse(readFileSync(join(subject.runDir, "meta.json"), "utf8"));
        } catch {
          /* gone */
        }
        const why = this.o.pinnedRun !== undefined && meta !== null && meta.termination == null ? null : notLive(subject.runDir, meta, tick);
        if (why !== null) {
          this.log(`${subject.runId}: ${why}; leaving it`);
          shutter.event({ ts: this.now(), type: "end", detail: why === "ended" ? "run ended" : `run ${why}` });
          for (const k of shutter.flush()) keep(k);
          this.assemble(subject);
          return;
        }
      }
      const wait = CAPTURE_EVERY_MS - (this.now() - tick);
      if (wait > 0) await this.sleep(wait);
    }
    for (const k of shutter.flush()) keep(k);
  }

  assemble(subject: Subject): void {
    try {
      const doc = assembleRun(subject.runDir, { intervalMs: this.o.intervalMs, log: (l) => this.log(l) });
      this.log(`${subject.runId}: ${doc?.parts.length ?? 0} part(s), ${doc?.chapters.length ?? 0} chapter(s)`);
    } catch (e) {
      this.log(`${subject.runId}: assembly failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /** The director's life: in, then subject after subject. Returns when the client leaves the world, or for good. */
  async run(): Promise<void> {
    this.lost = false;
    if (!(await this.enterWorld())) {
      if (this.refused) this.log("the camera stays logged out");
      return;
    }
    let idleSince: number | null = null;
    let lastIdleLog = 0;
    for (;;) {
      if (this.refused || this.lost || this.o.stopping?.() === true) return;
      const subject = this.pick();
      if (subject === null) {
        const now = this.now();
        if (idleSince === null || now - lastIdleLog >= IDLE_LOG_MS) {
          this.log(idleSince === null ? `no live run on ${this.o.world} to follow; waiting` : `idle ${Math.round((now - idleSince) / 60_000)} min: no live run on ${this.o.world}; the client is in the world`);
          idleSince ??= now;
          lastIdleLog = now;
        }
        await this.sleep(IDLE_CHECK_MS);
        if (this.restartDue()) {
          await this.restartClient();
          return;
        }
        // Nothing else looks at the client while there is no subject: a client
        // that left the world (a crash and restart, a world restart) would sit
        // at character select until a subject came.
        const st = await this.o.client.status();
        if (st?.in_world !== true) {
          this.log(`the client left the world while idle (${Director.where(st)}); logging in again`);
          this.markLost();
          return;
        }
        continue;
      }
      idleSince = null;
      try {
        await this.follow(subject);
      } catch (e) {
        this.log(`follow ${subject.runId}: ${e instanceof Error ? e.message : String(e)}`);
        await this.sleep(5_000);
      }
      if (this.o.pinnedRun !== undefined) return;
    }
  }

  /**
   * `run()` again and again, for the life of the process: after the client
   * left the world, after a failure of the director's own, never after a
   * refusal (the camera stays logged out; this waits for the stop).
   */
  async live(): Promise<void> {
    const stopping = (): boolean => this.o.stopping?.() === true;
    for (;;) {
      try {
        await this.run();
      } catch (e) {
        this.log(`director: ${e instanceof Error ? e.message : String(e)}`);
      }
      if (stopping()) return;
      if (this.refused) {
        while (!stopping()) await this.sleep(60_000);
        return;
      }
      await this.sleep(RETRY_MS);
    }
  }
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

if (import.meta.main) {
  const args = Bun.argv.slice(2);
  const env = process.env;
  const log = (line: string) => console.log(`${new Date().toISOString()} camera: ${line}`);
  const runDir = env["CAMERA_RUN_DIR"] ?? "/run/camera";
  const tokenFile = join(runDir, "token");
  const token = () => {
    try {
      return readFileSync(tokenFile, "utf8").trim();
    } catch {
      return "";
    }
  };
  const fwd = flag(args, "--forward-world");
  if (fwd !== undefined) {
    const [host, port] = fwd.split(":");
    forwardLoopback(8085, { host: host!, port: Number(port ?? 8085) }, log);
    // A hand-run camera's pod: the forwarder alone, for the client's whole life; the director is run beside it.
    if (args.includes("--forward-only")) await new Promise(() => {});
  }
  const intervalS = Number(env["CAMERA_INTERVAL_SECONDS"] ?? 10);
  const restartMin = Number(env["CAMERA_RESTART_MINUTES"] ?? DEFAULT_RESTART_MINUTES);
  let stopping = false;
  // A parked world's pod gets its grace: keep what the ring holds, then go.
  for (const sig of ["SIGTERM", "SIGINT"] as const) process.on(sig, () => (stopping = true));
  const world = env["CAMERA_WORLD"] ?? "shared";
  const runsDir = env["CAMERA_RUNS_DIR"] ?? join("data", "runs");
  const director = new Director({
    client: new CameraClient(`http://127.0.0.1:${env["CAMERA_PORT"] ?? "17980"}`, token),
    runsDir,
    world,
    intervalMs: (Number.isFinite(intervalS) && intervalS > 0 ? intervalS : 10) * 1000,
    race: Number(env["CAMERA_RACE"] ?? 1),
    ...(flag(args, "--run") !== undefined ? { pinnedRun: flag(args, "--run")! } : {}),
    createOnly: args.includes("--create-only"),
    restartAfterMs: (Number.isFinite(restartMin) && restartMin > 0 ? restartMin : 0) * 60_000,
    stopping: () => stopping,
    log,
  });
  // The director outlives its own failures and the client's rather than restart the client's pod.
  if (args.includes("--create-only") || flag(args, "--run") !== undefined) {
    try {
      await director.run();
    } catch (e) {
      log(`director: ${e instanceof Error ? e.message : String(e)}`);
    }
  } else {
    await director.live();
  }
  if (stopping || fwd === undefined) process.exit(0);
  // The forwarder keeps a hand-run camera's world connection; stop with the pod.
  await new Promise(() => {});
}
