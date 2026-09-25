/**
 * The entrypoint loop's program runtime, in the sandbox child (a probing
 * spike; `loop: "entrypoint"`). The model writes `main.ts` exporting
 * `loop(ctx)`, an `on` map of event handlers, or both; the host asks this
 * runtime to deploy it when the model ends a turn, and drains what it did on a
 * one-second report that doubles as the host's liveness check.
 *
 *  - Deploy: main.ts is imported through the sandbox's versioned workspace
 *    import at the version the host names, so a running deploy never picks up a
 *    half-edited file. A failed load (a syntax error, an import error, neither
 *    export) leaves the previous deploy running. A good one replaces it: the old
 *    deploy's in-flight tick and handlers are aborted, and the timers and
 *    listeners it registered are removed (`owners.ts`).
 *  - Ticks: `loop(ctx)` starts 1s after the previous tick started, or as soon as
 *    it settles if it ran longer; two never overlap. A tick has 120s, a handler
 *    10s: past that its `ctx.signal` is aborted and the overrun is reported
 *    like an error. Nothing is killed for running long.
 *  - Errors: a throw or rejection from a hook is caught and counted under a
 *    signature (hook, error name, first workspace frame); a signature's first
 *    occurrence in a deploy is marked new, and that is what wakes the model.
 *    The program keeps being called.
 *  - Memory: one plain-JSON object, `ctx.memory` (and `memory` in a snippet),
 *    serialized after every tick, handler and snippet; a change is sent to the
 *    host, which alone writes memory.json.
 *  - Facts: a level gained, a quest turned in and a death are noted once each,
 *    here, where every event arrives — independently of the death signals the
 *    host drains for the trajectory.
 *
 * Deliberately free of module-level side effects and of the entry module's
 * internals: everything it needs arrives through `ProgramDeps`, so the host can
 * import its constants and a test can reason about it in isolation.
 */

import { existsSync, readFileSync } from "node:fs";
import { MEMORY_MAX_CHARS, MEMORY_PATH } from "../workspace";
import { HarnessStop, isHarnessStop, Owner, type Ownership } from "./owners";
import type {
  ActionHintNote,
  ChildToHost,
  DeployAnswer,
  LogEntry,
  ProgramErrorNote,
  ProgramMilestoneNote,
  ProgramReport,
  WakeRequestNote,
} from "./ipc";

/** The program's file, at the workspace root and only that name. */
export const MAIN_PATH = "main.ts";

/** The program's limits. Operator-owned constants; tests shorten them through the child's env. */
export interface ProgramLimits {
  /** A tick starts this long after the previous one started. */
  tickMs: number;
  /** A tick's budget: past it, its signal is aborted and the overrun reported. */
  tickBudgetMs: number;
  /** An event handler's budget. */
  eventBudgetMs: number;
  /** How long a deploy waits for a closed event stream to reopen before loading anyway. */
  deployConnectMs: number;
}

export const PROGRAM_LIMITS: ProgramLimits = {
  tickMs: 1_000,
  tickBudgetMs: 120_000,
  eventBudgetMs: 10_000,
  deployConnectMs: 5_000,
};

/** The env names the host sets the limits through (always explicitly, in the entrypoint loop). */
export const PROGRAM_LIMITS_ENV: Readonly<Record<keyof ProgramLimits, string>> = {
  tickMs: "WRATHBENCH_PROGRAM_TICK_MS",
  tickBudgetMs: "WRATHBENCH_PROGRAM_TICK_BUDGET_MS",
  eventBudgetMs: "WRATHBENCH_PROGRAM_EVENT_BUDGET_MS",
  deployConnectMs: "WRATHBENCH_PROGRAM_CONNECT_MS",
};

/** The limits as the child's environment states them, defaults for anything unset or malformed. */
export function programLimitsFromEnv(env: Record<string, string | undefined>): ProgramLimits {
  const read = (k: keyof ProgramLimits): number => {
    const n = Number(env[PROGRAM_LIMITS_ENV[k]]);
    return Number.isFinite(n) && n > 0 ? n : PROGRAM_LIMITS[k];
  };
  return { tickMs: read("tickMs"), tickBudgetMs: read("tickBudgetMs"), eventBudgetMs: read("eventBudgetMs"), deployConnectMs: read("deployConnectMs") };
}

/** How many program console lines are kept between two reports (the wake block shows the last 40). */
export const PROGRAM_LOG_KEEP = 200;
/** How many workspace frames an error shows. */
export const STACK_FRAMES_SHOWN = 4;
/** Distinct error signatures (and wake reasons) one report carries at most. */
const REPORT_ROWS_MAX = 50;
/** A `ctx.wake` reason is cut to this many characters. */
const WAKE_REASON_MAX_CHARS = 200;

/** A deploy was replaced, unloaded or halted: its calls are aborted with this. */
class ProgramStopped extends HarnessStop {
  override name = "ProgramStopped";
}

/** A call ran past its budget: its signal is aborted with this. */
class ProgramBudget extends HarnessStop {
  override name = "ProgramBudget";
}

/** What `ctx` is. The SDK objects are the same ones a snippet sees. */
export interface ProgramCtx {
  sdk: unknown;
  state: unknown;
  events: unknown;
  memory: Record<string, unknown>;
  signal: AbortSignal;
  tick: number;
  deploy: number;
  wake(reason?: unknown): void;
}

type Hook = (ctx: ProgramCtx) => unknown;
type Handler = (event: unknown, ctx: ProgramCtx) => unknown;

/** The async context a program call runs in; the entry module's `EvalStore`, structurally. */
export interface ProgramStore {
  signal: AbortSignal;
  deadline?: number;
  source?: "snippet" | "program";
  owner?: Owner;
}

/** The slice of the SDK client the runtime reads for its facts and its reconnect. */
export interface ProgramClient {
  state: {
    self: { level?: { value?: unknown } | undefined };
    questCompletions: readonly { questId: number; ts: number }[];
  };
  events: {
    connected: boolean;
    connect(): Promise<void>;
    onAny(handler: (event: { opcode: string }) => void): () => void;
  };
}

export interface ProgramDeps {
  /** The workspace directory, absolute. */
  workspace: string;
  client: ProgramClient;
  /** The ambient `sdk`, `state`, `events` — handed to `ctx` as they are. */
  sdk: unknown;
  /** The sandbox's versioned workspace import. */
  importModule: (absPath: string) => Promise<unknown>;
  /** Move the sandbox's import version before a deploy imports. */
  setVersion: (version: number) => void;
  run: <T>(store: ProgramStore, fn: () => T) => T;
  /** Run with no async context: SDK plumbing that belongs to nobody. */
  exit: <T>(fn: () => T) => T;
  ownership: Ownership;
  /** An error's `Name: message`, workspace-relative. */
  renderHead: (err: unknown) => string;
  /** Text with workspace paths made relative and version stamps removed. */
  relative: (text: string) => string;
  send: (msg: ChildToHost) => void;
  drainHints: () => ActionHintNote[];
  /** Snippet evaluations in flight; hints are left for their results while any are. */
  snippetsInFlight: () => number;
  limits: ProgramLimits;
  now?: () => number;
}

interface Deploy {
  number: number;
  version: number;
  loop: Hook | undefined;
  on: Record<string, Handler> | undefined;
  owner: Owner;
  /** Aborted when the deploy ends; the signal its top-level code ran under. */
  controller: AbortController;
  /** In-flight ticks and handlers. */
  calls: Set<AbortController>;
  tick: number;
  /** Error signatures already seen in this deploy: a repeat is only counted. */
  seen: Set<string>;
  retired: boolean;
}

// ------------------------------------------------------------------ errors

/** One `at …` line of a stack, and whether it points into the workspace. */
interface Frame {
  text: string;
  workspace: boolean;
}

function stackFrames(err: unknown, workspace: string, relative: (s: string) => string): Frame[] {
  const stack = (err as { stack?: unknown } | null)?.stack;
  if (typeof stack !== "string") return [];
  const out: Frame[] = [];
  for (const line of stack.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("at ")) continue;
    const inWorkspace = t.includes(`${workspace}/`);
    out.push({ text: inWorkspace ? relative(t.replace(/file:\/\//g, "")) : t, workspace: inWorkspace });
  }
  return out;
}

/** An error's name, whatever was thrown. */
function errorName(err: unknown): string {
  if (err instanceof Error) return err.name;
  const n = (err as { name?: unknown } | null)?.name;
  if (typeof n === "string") return n;
  return err === null ? "null" : typeof err;
}

/**
 * An error as the model reads it — `Name: message`, then up to four frames
 * inside the workspace and a count of the SDK and harness frames left out —
 * plus the first workspace frame, which is what makes two occurrences the same.
 */
export function renderProgramError(
  err: unknown,
  deps: Pick<ProgramDeps, "workspace" | "renderHead" | "relative">,
): { name: string; text: string; frame: string | undefined } {
  const frames = stackFrames(err, deps.workspace, deps.relative);
  const mine = frames.filter((f) => f.workspace);
  const hidden = frames.length - mine.length;
  const lines = [deps.renderHead(err)];
  for (const f of mine.slice(0, STACK_FRAMES_SHOWN)) lines.push(`    ${f.text}`);
  if (mine.length > STACK_FRAMES_SHOWN) lines.push(`    (${mine.length - STACK_FRAMES_SHOWN} more workspace frames)`);
  if (hidden > 0) lines.push(`    (${hidden} SDK/harness frame${hidden === 1 ? "" : "s"} hidden)`);
  const first = mine[0]?.text.replace(/^at /, "");
  return { name: errorName(err), text: lines.join("\n"), frame: first };
}

/**
 * A load error's head. A syntax error in a workspace module arrives as Bun's
 * BuildMessage with a position in that file — named here as the file and line
 * the model wrote, which the snippet renderer (which corrects for its own
 * wrapper line) would misplace by one.
 */
function loadHead(err: unknown, deps: Pick<ProgramDeps, "renderHead" | "relative">): string {
  const one = (e: unknown): string | undefined => {
    const x = e as { name?: unknown; message?: unknown; position?: { file?: unknown; line?: unknown; column?: unknown; lineText?: unknown } | null };
    const p = x?.position;
    if (p === null || p === undefined || typeof p.line !== "number") return undefined;
    const file = typeof p.file === "string" ? deps.relative(p.file.replace(/^file:\/\//, "")) : MAIN_PATH;
    const col = typeof p.column === "number" ? `:${p.column}` : "";
    const text = typeof p.lineText === "string" && p.lineText.trim().length > 0 ? ` — ${p.lineText.trim()}` : "";
    return `${String(x.name ?? "Error")}: ${String(x.message ?? "parse error")} at ${file}:${p.line}${col}${text}`;
  };
  if (err instanceof AggregateError && Array.isArray(err.errors) && err.errors.length > 0) {
    const subs = err.errors.map((e) => one(e));
    if (subs.every((s) => s !== undefined)) return `${err.name}: ${err.message}\n${subs.map((s) => `  ${s}`).join("\n")}`;
  }
  return one(err) ?? deps.renderHead(err);
}

/** Whether a stack has a frame inside the workspace — the program's code, somewhere. */
function touchesWorkspace(err: unknown, workspace: string): boolean {
  const stack = (err as { stack?: unknown } | null)?.stack;
  return typeof stack === "string" && stack.includes(`${workspace}/`);
}

// ------------------------------------------------------------------ memory

/** Where a value stops being plain JSON, as `memory.a.b` and what it is. */
function plainJsonProblem(v: unknown, path: string, onPath: Set<object>): { kind: string; path: string } | null {
  if (v === null || v === undefined) return null;
  const t = typeof v;
  if (t === "string" || t === "number" || t === "boolean") return null;
  if (t === "bigint") return { kind: "BigInt", path };
  if (t === "function") return { kind: "function", path };
  if (t === "symbol") return { kind: "symbol", path };
  const o = v as object;
  if (onPath.has(o)) return { kind: "cycle", path };
  if (o instanceof Map) return { kind: "Map", path };
  if (o instanceof Set) return { kind: "Set", path };
  if (typeof (o as { toJSON?: unknown }).toJSON === "function") return null;
  onPath.add(o);
  try {
    if (Array.isArray(o)) {
      for (let i = 0; i < o.length; i++) {
        const p = plainJsonProblem(o[i], `${path}[${i}]`, onPath);
        if (p !== null) return p;
      }
      return null;
    }
    for (const k of Object.keys(o)) {
      const key = /^[A-Za-z_$][\w$]*$/.test(k) ? `.${k}` : `[${JSON.stringify(k)}]`;
      const p = plainJsonProblem((o as Record<string, unknown>)[k], `${path}${key}`, onPath);
      if (p !== null) return p;
    }
    return null;
  } finally {
    onPath.delete(o);
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v) as unknown;
  return proto === Object.prototype || proto === null;
}

/**
 * The program's memory: a live plain object the model mutates, and the JSON
 * last handed to the host for memory.json. Loaded from memory.json when the
 * child starts; a file that cannot be read starts it empty and says why.
 */
export class ProgramMemory {
  value: Record<string, unknown> = {};
  private saved = "{}";
  /** Why the file on disk could not be loaded, when it could not. */
  readonly loadError: string | undefined;

  constructor(json: string | undefined) {
    if (json === undefined) return;
    try {
      const parsed = JSON.parse(json) as unknown;
      if (!isPlainObject(parsed)) throw new TypeError("it does not hold a JSON object");
      this.value = parsed;
      this.saved = JSON.stringify(parsed);
    } catch (err) {
      this.loadError = `${MEMORY_PATH} could not be loaded (${err instanceof Error ? err.message : String(err)}); memory starts empty, and the next save replaces the file`;
    }
  }

  /** `memory = …` from a snippet or `ctx.memory = …`: a plain object, or a TypeError that says so. */
  replace(v: unknown): void {
    if (!isPlainObject(v)) {
      const got = v === null ? "null" : Array.isArray(v) ? "an array" : typeof v;
      throw new TypeError(`memory must be a plain object, e.g. memory = { phase: "grind" } — got ${got}`);
    }
    this.value = v;
  }

  /** Null when nothing changed since the last save; the JSON to send; or why it cannot be saved. */
  check(): null | { json: string } | { kind: string; error: string } {
    const problem = plainJsonProblem(this.value, "memory", new Set());
    if (problem !== null) {
      const what =
        problem.kind === "cycle"
          ? `${problem.path} refers back to an object that contains it`
          : `${problem.path} is a ${problem.kind}`;
      return {
        kind: problem.kind,
        error:
          `memory was not saved: ${what}, and memory holds only plain JSON (objects, arrays, strings, numbers, ` +
          `booleans, null) — store a plain object or an array instead. The last saved memory stays.`,
      };
    }
    const json = JSON.stringify(this.value);
    if (json.length > MEMORY_MAX_CHARS) {
      return {
        kind: "too large",
        error: `memory was not saved: it would be ${json.length} chars of JSON, over its ${MEMORY_MAX_CHARS}-char limit; keep less in memory, or move detail to a workspace file. The last saved memory stays.`,
      };
    }
    return json === this.saved ? null : { json };
  }

  markSaved(json: string): void {
    this.saved = json;
  }
}

// ------------------------------------------------------------------ console

/** The program's console between two reports: consecutive repeats folded "×N", the newest kept. */
class ProgramLog {
  private buf: LogEntry[] = [];
  private last: { entry: LogEntry; base: string; repeats: number } | null = null;
  lines = 0;

  push(level: LogEntry["level"], text: string, now: number): void {
    this.lines++;
    const t = text.slice(0, 4_000);
    const l = this.last;
    if (l !== null && this.buf[this.buf.length - 1] === l.entry && l.entry.level === level && l.base === t) {
      l.repeats++;
      l.entry.ts = now;
      l.entry.text = `${t} ×${l.repeats}`;
      return;
    }
    const entry: LogEntry = { level, ts: now, text: t };
    this.last = { entry, base: t, repeats: 1 };
    this.buf.push(entry);
    if (this.buf.length > PROGRAM_LOG_KEEP) this.buf.splice(0, this.buf.length - PROGRAM_LOG_KEEP);
  }

  drain(): { logs: LogEntry[]; lines: number } {
    const out = { logs: this.buf, lines: this.lines };
    this.buf = [];
    this.last = null;
    this.lines = 0;
    return out;
  }
}

// ------------------------------------------------------------------ runtime

export class ProgramRuntime {
  readonly memory: ProgramMemory;
  private current: Deploy | null = null;
  /** Bumped by every deploy request, so a slow import that lost the race is discarded. */
  private deploySeq = 0;
  private readonly now: () => number;
  private readonly log = new ProgramLog();
  private ticks = 0;
  private longestTickMs = 0;
  private overruns = 0;
  private readonly errors = new Map<string, ProgramErrorNote>();
  private readonly requests = new Map<string, WakeRequestNote>();
  private milestones: ProgramMilestoneNote[] = [];
  /** Signatures seen while no program ran (a snippet's memory): each wakes once per process. */
  private readonly seenWithoutDeploy = new Set<string>();
  private lastLevel: number | undefined;
  private questsSeen = 0;

  constructor(private readonly deps: ProgramDeps) {
    this.now = deps.now ?? Date.now;
    const file = `${deps.workspace}/${MEMORY_PATH}`;
    this.memory = new ProgramMemory(existsSync(file) ? readFileSync(file, "utf8") : undefined);
    if (this.memory.loadError !== undefined) {
      this.noteError(null, "memory", "memory could not be loaded", "Error", this.memory.loadError);
    }
    // Registered with no async context, so it is nobody's to remove; after the
    // client's own state fold (registration order), so every read below and
    // every handler sees a cache that already holds the event.
    deps.client.events.onAny((event) => {
      this.watchFacts();
      this.dispatch(event);
    });
  }

  /** The deploy running now, if any. */
  get deployed(): number | null {
    return this.current?.number ?? null;
  }

  /**
   * The context of a deploy whose main.ts is being imported right now. Bun
   * evaluates an imported module's top-level code outside the importer's
   * async context, so a timer or listener main.ts starts at load would belong
   * to no one; `owners.ts` gives it to this deploy instead when the call comes
   * from workspace code (`ProgramRuntime.loadingOwner`).
   */
  private loading: ProgramStore | null = null;

  /** The loading deploy's context and the marker of its code's frames, while an import is in flight. */
  loadingOwner(): { store: ProgramStore; marker: string } | undefined {
    return this.loading === null ? undefined : { store: this.loading, marker: `${this.deps.workspace}/` };
  }

  // -------------------------------------------------------------- deploy

  async deploy(version: number, number: number): Promise<DeployAnswer> {
    const seq = ++this.deploySeq;
    this.deps.setVersion(version);
    await this.reconnect();
    if (seq !== this.deploySeq) return { ok: false, deploy: number, error: "superseded by a later deploy" };
    const main = `${this.deps.workspace}/${MAIN_PATH}`;
    if (!existsSync(main)) {
      return { ok: false, deploy: number, error: `${MAIN_PATH} does not exist; write it with write_file to start a program` };
    }
    const owner = new Owner(`deploy ${number}`);
    const controller = new AbortController();
    const store: ProgramStore = { signal: controller.signal, source: "program", owner };
    const discard = (why: string): void => {
      controller.abort(new ProgramStopped(why));
      this.deps.ownership.close(owner);
    };
    let mod: Record<string, unknown>;
    this.loading = store;
    try {
      mod = (await this.deps.run(store, () => this.deps.importModule(main))) as Record<string, unknown>;
    } catch (err) {
      discard("load failed");
      const rendered = renderProgramError(err, { ...this.deps, renderHead: (e) => loadHead(e, this.deps) });
      return { ok: false, deploy: number, error: rendered.text };
    } finally {
      this.loading = null;
    }
    if (seq !== this.deploySeq) {
      discard("superseded");
      return { ok: false, deploy: number, error: "superseded by a later deploy" };
    }
    const shape = programShape(mod);
    if ("error" in shape) {
      discard("load failed");
      return { ok: false, deploy: number, error: shape.error };
    }
    if (this.current !== null) this.retire(this.current, `replaced by deploy ${number}`);
    const d: Deploy = {
      number,
      version,
      loop: shape.loop,
      on: shape.on,
      owner,
      controller,
      calls: new Set(),
      tick: 0,
      seen: new Set(),
      retired: false,
    };
    this.current = d;
    void this.runTicks(d);
    return {
      ok: true,
      deploy: number,
      exports: [...(shape.loop !== undefined ? ["loop"] : []), ...Object.keys(shape.on ?? {}).map((k) => `on.${k}`)],
    };
  }

  /** Stop the program: abort what is in flight, remove what it registered. */
  unload(why = "unloaded"): void {
    this.deploySeq++;
    if (this.current !== null) this.retire(this.current, why);
  }

  private retire(d: Deploy, why: string): void {
    d.retired = true;
    const stop = new ProgramStopped(why);
    d.controller.abort(stop);
    for (const c of d.calls) c.abort(stop);
    d.calls.clear();
    this.deps.ownership.close(d.owner);
    if (this.current === d) this.current = null;
  }

  /** A closed event stream reopened, bounded: plumbing, owned by no one, never a reason not to load. */
  private async reconnect(): Promise<void> {
    const events = this.deps.client.events;
    if (events.connected) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const wait = new Promise<void>((r) => {
      timer = this.deps.ownership.real.setTimeout(r, this.deps.limits.deployConnectMs);
    });
    const attempt = this.deps.exit(() => events.connect()).catch(() => undefined);
    await Promise.race([attempt, wait]);
    this.deps.ownership.real.clearTimeout(timer);
  }

  // -------------------------------------------------------------- calls

  private async runTicks(d: Deploy): Promise<void> {
    const loop = d.loop;
    if (loop === undefined) return;
    while (this.current === d) {
      const started = this.now();
      d.tick++;
      await this.call(d, "loop()", this.deps.limits.tickBudgetMs, (ctx) => loop(ctx), true);
      if (this.current !== d) return;
      const wait = Math.max(0, started + this.deps.limits.tickMs - this.now());
      await new Promise<void>((r) => this.deps.ownership.real.setTimeout(r, wait));
    }
  }

  private dispatch(event: { opcode: string }): void {
    const d = this.current;
    if (d === null || d.on === undefined) return;
    if (!Object.prototype.hasOwnProperty.call(d.on, event.opcode)) return;
    const h = d.on[event.opcode];
    if (typeof h !== "function") return;
    void this.call(d, `on.${event.opcode}`, this.deps.limits.eventBudgetMs, (ctx) => h(event, ctx), false);
  }

  /**
   * One tick or one handler, inside the deploy's owner and its own signal. The
   * budget aborts the signal and is reported once; the echo of that abort (and
   * of a deploy being replaced) is not an error of its own.
   */
  private async call(d: Deploy, hook: string, budgetMs: number, invoke: Hook, isTick: boolean): Promise<void> {
    const controller = new AbortController();
    d.calls.add(controller);
    const started = this.now();
    const store: ProgramStore = { signal: controller.signal, deadline: started + budgetMs, source: "program", owner: d.owner };
    const timer = this.deps.ownership.real.setTimeout(() => {
      if (this.current === d) {
        this.overruns++;
        this.noteError(
          d,
          hook,
          `${hook} overran its budget`,
          "overrun",
          `${hook} ran past its ${budgetMs} ms budget: its signal was aborted, so pending SDK waits rejected with ` +
            `EventAbortedError${isTick ? "; the next tick starts when this one settles" : ""}. Long work belongs in ` +
            `a tick, one step per tick; a walk longer than the budget is sdk.moveToAsync(target), followed on a later tick.`,
        );
      }
      controller.abort(new ProgramBudget(`${hook} ran past its ${budgetMs} ms budget`));
    }, budgetMs);
    try {
      await this.deps.run(store, () => invoke(this.ctx(d, store, hook)));
    } catch (err) {
      if (this.current === d && !d.retired && !isHarnessStop(err)) this.error(d, hook, err);
    } finally {
      this.deps.ownership.real.clearTimeout(timer);
      d.calls.delete(controller);
      if (isTick && this.current === d) {
        this.ticks++;
        this.longestTickMs = Math.max(this.longestTickMs, this.now() - started);
      }
      this.saveMemory();
    }
  }

  private ctx(d: Deploy, store: ProgramStore, hook: string): ProgramCtx {
    const memory = this.memory;
    return {
      sdk: this.deps.sdk,
      state: (this.deps.sdk as { state?: unknown }).state,
      events: (this.deps.sdk as { events?: unknown }).events,
      get memory(): Record<string, unknown> {
        return memory.value;
      },
      set memory(v: Record<string, unknown>) {
        memory.replace(v);
      },
      signal: store.signal,
      tick: d.tick,
      deploy: d.number,
      wake: (reason?: unknown): void => this.requestWake(d, reason, hook),
    };
  }

  private requestWake(d: Deploy, reason: unknown, from: string): void {
    if (this.current !== d || d.retired) return;
    const raw = typeof reason === "string" ? reason : reason === undefined ? "" : String(reason);
    const text = raw.trim().slice(0, WAKE_REASON_MAX_CHARS) || "(no reason given)";
    const key = `${text}\u0000${from}`;
    const now = this.now();
    const row = this.requests.get(key);
    if (row !== undefined) {
      row.count++;
      row.lastTs = now;
      return;
    }
    if (this.requests.size >= REPORT_ROWS_MAX) return;
    this.requests.set(key, { reason: text, from, count: 1, firstTs: now, lastTs: now });
  }

  // -------------------------------------------------------------- errors

  private error(d: Deploy | null, hook: string, err: unknown): void {
    const r = renderProgramError(err, this.deps);
    const signature = r.frame === undefined ? `${hook} ${r.name}` : `${hook} ${r.name} at ${r.frame}`;
    this.noteError(d, hook, signature, r.name, r.text);
  }

  private noteError(d: Deploy | null, hook: string, signature: string, _name: string, text: string): void {
    const seen = d?.seen ?? this.seenWithoutDeploy;
    const isNew = !seen.has(signature);
    seen.add(signature);
    const now = this.now();
    // Keyed by deploy as well: the same signature in the next deploy is its
    // own row, first occurrence and all.
    const key = `${d?.number ?? "-"}\u0000${signature}`;
    const row = this.errors.get(key);
    if (row !== undefined) {
      row.count++;
      row.lastTs = now;
      row.isNew ||= isNew;
      return;
    }
    if (this.errors.size >= REPORT_ROWS_MAX && !isNew) return;
    this.errors.set(key, {
      signature,
      hook,
      text,
      count: 1,
      isNew,
      deploy: d?.number ?? null,
      firstTs: now,
      lastTs: now,
    });
  }

  /**
   * An unhandled rejection or uncaught exception from the program's own code
   * (its stack runs through the workspace) becomes one of its error
   * signatures; anything else is left to the sandbox's fault report.
   */
  claimBackgroundError(kind: string, err: unknown): boolean {
    const d = this.current;
    if (d === null || !touchesWorkspace(err, this.deps.workspace)) return false;
    this.error(d, kind, err);
    return true;
  }

  // -------------------------------------------------------------- memory

  /** Serialize memory and send it home if it changed; a memory that cannot be saved is an error. */
  saveMemory(): void {
    const r = this.memory.check();
    if (r === null) return;
    if ("json" in r) {
      this.memory.markSaved(r.json);
      this.deps.send({ t: "memory", json: r.json });
      return;
    }
    this.noteError(this.current, "memory", `memory not saved: ${r.kind}`, r.kind, r.error);
  }

  // -------------------------------------------------------------- facts

  private watchFacts(): void {
    const level = this.deps.client.state.self.level?.value;
    if (typeof level === "number") {
      if (this.lastLevel !== undefined && level > this.lastLevel) this.milestones.push({ fact: "level", level, ts: this.now() });
      this.lastLevel = level;
    }
    const done = this.deps.client.state.questCompletions;
    if (done.length < this.questsSeen) this.questsSeen = 0;
    for (const q of done.slice(this.questsSeen)) this.milestones.push({ fact: "quest", questId: q.questId, ts: q.ts });
    this.questsSeen = done.length;
  }

  /** The child's death watcher saw own health reach zero. */
  noteDeath(ts: number): void {
    this.milestones.push({ fact: "death", ts });
  }

  // -------------------------------------------------------------- console + report

  /** A console line printed from the program's async context. */
  logLine(level: LogEntry["level"], text: string): void {
    this.log.push(level, text, this.now());
  }

  /** Everything since the last report, and reset. */
  report(): ProgramReport {
    const { logs, lines } = this.log.drain();
    const out: ProgramReport = {
      deploy: this.deployed,
      ticks: this.ticks,
      longestTickMs: this.longestTickMs,
      overruns: this.overruns,
      errors: [...this.errors.values()],
      requests: [...this.requests.values()],
      milestones: this.milestones,
      logs,
      logLines: lines,
      hints: this.deps.snippetsInFlight() === 0 ? this.deps.drainHints() : [],
    };
    this.ticks = 0;
    this.longestTickMs = 0;
    this.overruns = 0;
    this.errors.clear();
    this.requests.clear();
    this.milestones = [];
    return out;
  }
}

/** What main.ts exported, checked: at least one of `loop` (a function) and `on` (an object of functions). */
function programShape(
  mod: Record<string, unknown>,
): { loop: Hook | undefined; on: Record<string, Handler> | undefined } | { error: string } {
  const loop = mod["loop"];
  const on = mod["on"];
  if (loop === undefined && on === undefined) {
    return {
      error:
        `${MAIN_PATH} exports neither loop nor on; export async function loop(ctx) { … } for a tick, ` +
        `export const on = { SMSG_ATTACKSTART(e, ctx) { … } } for events, or both`,
    };
  }
  if (loop !== undefined && typeof loop !== "function") {
    return { error: `${MAIN_PATH} exports loop, but it is ${describe(loop)}, not a function; export async function loop(ctx) { … }` };
  }
  if (on !== undefined) {
    if (typeof on !== "object" || on === null || Array.isArray(on)) {
      return {
        error: `${MAIN_PATH} exports on, but it is ${describe(on)}, not an object of handlers; export const on = { SMSG_ATTACKSTART(e, ctx) { … } }`,
      };
    }
    for (const [k, v] of Object.entries(on)) {
      if (typeof v !== "function") {
        return { error: `${MAIN_PATH}: on.${k} is ${describe(v)}, not a function; each key of on maps an event name to a handler (e, ctx) => …` };
      }
    }
  }
  return {
    loop: loop as Hook | undefined,
    on: on as Record<string, Handler> | undefined,
  };
}

function describe(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "an array";
  const t = typeof v;
  return t === "object" ? "an object" : `a ${t}`;
}
