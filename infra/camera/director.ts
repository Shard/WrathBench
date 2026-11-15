/**
 * The camera director (docs/ARCHITECTURE.md, "Camera"; docs/RUNBOOK.md,
 * "Camera"). One per camera client, in the same pod: it logs the client in,
 * checks it is invisible, picks a subject on this world, keeps the client on
 * it with GM movement commands, and keeps frames per the layout in
 * `layout.ts`; when the subject's run ends it assembles the clips.
 *
 * What it may do in the world is fixed here and nowhere else: `.appear
 * <subject>` to move to the subject, `.morph target 11686` to hide the
 * camera's own body, and, once, `.gm on` and `.gm visible off` should the
 * world's config not have applied them. It never targets, says, casts or
 * moves otherwise, and it never moves while the client is visible: every
 * `.appear` is preceded by the invisibility check, and a camera found
 * visible logs out and stays out.
 *
 *   bun infra/camera/director.ts [--run <id>] [--create-only] [--forward-world host:port [--forward-only]]
 *
 * Environment: CAMERA_WORLD (a world id, or `shared`), CAMERA_INTERVAL_SECONDS
 * (10), CAMERA_PORT (17980), CAMERA_RUN_DIR (/run/camera: the client's token),
 * CAMERA_RUNS_DIR (data/runs), CAMERA_RACE (1, Human).
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { StoredSessionHandle } from "@wrathbench/inspector";
import { DEADMINES_BOSSES } from "../../runner/viewer/dungeons";
import { assembleRun } from "./assemble";
import { CameraClient, INVISIBLE_LUA, luaString, subjectDistanceLua, WORLD_ONLY_LUA } from "./client";
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
const SWEEP_EVERY_MS = 10 * 60_000;
/**
 * A 1280×720 JPEG at q75 under this is a flat field (a black frame is about
 * 25 KB; a scene is 100 KB and up): a frame not drawn yet, never kept.
 */
export const MIN_FRAME_BYTES = 32_000;

export interface DirectorOptions {
  client: CameraClient;
  runsDir: string;
  world: string;
  intervalMs: number;
  race: number;
  pinnedRun?: string;
  createOnly: boolean;
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

  constructor(o: DirectorOptions) {
    this.o = o;
    this.now = o.now ?? Date.now;
    this.sleep = o.sleep ?? ((ms) => Bun.sleep(ms));
  }

  private log(line: string): void {
    this.o.log(line);
  }

  /** Logged in and in the world, or never (a refusal leaves the client logged out). */
  async enterWorld(): Promise<boolean> {
    const c = this.o.client;
    for (;;) {
      const st = await c.status();
      if (st?.in_world === true) break;
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
        await c.lua("SelectCharacter(1) EnterWorld() return true");
        await this.sleep(5_000);
        continue;
      }
      await this.sleep(2_000);
    }
    // The world's own config makes the camera a GM and invisible before it is
    // on the map (GM.LoginState = 1, GM.Visible = 0); check, never assume.
    for (let i = 0; i < 30 && String((await c.value("return GetZoneText()")) ?? "") === ""; i++) await this.sleep(1_000);
    await c.lua("pcall(StopCinematic) return true");
    if ((await this.visibility()) !== "invisible") {
      this.log("REFUSED: the camera entered the world without GM invisibility; the world's GM.Visible is not 0. Logging out; nothing else is sent");
      await c.lua("Logout() return true");
      this.refused = true;
      return false;
    }
    await c.lua(WORLD_ONLY_LUA);
    await this.hideBody();
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
      this.lost = true;
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
      // Stay on the subject.
      const map = this.subjectMap(subject);
      const crossMap = map !== null && appearMap !== null && map !== appearMap;
      if (tick >= loadingUntil) {
        const d = await this.distance(subject);
        if ((d < 0 || d > REJOIN_YARDS || crossMap) && tick - lastAppear >= APPEAR_COOLDOWN_MS) {
          if (!(await this.appear(subject))) continue;
          const changing = crossMap || appearMap === null;
          lastAppear = tick;
          appearMap = map;
          if (changing) {
            // A new map is a loading screen, after which the morph and the view are gone.
            loadingUntil = tick + LOADING_WAIT_MS;
            needSetup = true;
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
          } else if (bytes !== null) {
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
      this.log(`${subject.runId}: ${doc?.clips.length ?? 0} clip(s)`);
    } catch (e) {
      this.log(`${subject.runId}: assembly failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /** The director's life: in, then subject after subject. Never returns while the camera may act. */
  async run(): Promise<void> {
    this.lost = false;
    if (!(await this.enterWorld())) {
      if (this.refused) this.log("the camera stays logged out");
      return;
    }
    for (;;) {
      if (this.refused || this.lost || this.o.stopping?.() === true) return;
      const subject = this.pick();
      if (subject === null) {
        await this.sleep(15_000);
        continue;
      }
      try {
        await this.follow(subject);
      } catch (e) {
        this.log(`follow ${subject.runId}: ${e instanceof Error ? e.message : String(e)}`);
        await this.sleep(5_000);
      }
      if (this.o.pinnedRun !== undefined) return;
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
  let stopping = false;
  // A parked world's pod gets its grace: keep what the ring holds, then go.
  for (const sig of ["SIGTERM", "SIGINT"] as const) process.on(sig, () => (stopping = true));
  const world = env["CAMERA_WORLD"] ?? "shared";
  const runsDir = env["CAMERA_RUNS_DIR"] ?? join("data", "runs");
  // The shared world's director also sweeps the runs no camera follows any
  // more (sweep.ts): a world per eval's pod is gone at the verdict, with no
  // grace, before its own director can assemble. A child process, so the
  // follow loop never waits on an encode.
  if (world === "shared" && fwd === undefined) {
    let sweeping = false;
    const sweep = () => {
      if (sweeping) return;
      sweeping = true;
      const p = Bun.spawn(["bun", join(import.meta.dir, "sweep.ts"), runsDir, "--interval-seconds", String(intervalS)], { stdout: "inherit", stderr: "inherit" });
      void p.exited.finally(() => (sweeping = false));
    };
    setTimeout(sweep, 60_000);
    setInterval(sweep, SWEEP_EVERY_MS);
  }
  const director = new Director({
    client: new CameraClient(`http://127.0.0.1:${env["CAMERA_PORT"] ?? "17980"}`, token),
    runsDir,
    world,
    intervalMs: (Number.isFinite(intervalS) && intervalS > 0 ? intervalS : 10) * 1000,
    race: Number(env["CAMERA_RACE"] ?? 1),
    ...(flag(args, "--run") !== undefined ? { pinnedRun: flag(args, "--run")! } : {}),
    createOnly: args.includes("--create-only"),
    stopping: () => stopping,
    log,
  });
  // A world pod never restarts a container: the director outlives its own failures.
  for (;;) {
    try {
      await director.run();
    } catch (e) {
      log(`director: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (stopping || args.includes("--create-only") || flag(args, "--run") !== undefined) break;
    // Refused once (found visible), the camera never logs in again in this process.
    if (director.refusedForGood) await new Promise(() => {});
    await Bun.sleep(30_000);
  }
  if (fwd === undefined) process.exit(0);
  // The forwarder keeps a hand-run camera's world connection; stop with the pod.
  await new Promise(() => {});
}
