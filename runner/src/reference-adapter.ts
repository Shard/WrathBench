/**
 * The `reference` driver's transport: the scripted reference run, played
 * through the fixed loop exactly as a model is (operator, 2026-10-19; issue
 * #79).
 *
 * It stands where a model's adapter stands. Every turn it answers with one
 * `run_snippet` call, and that snippet runs in the run's one sandbox, against
 * the run's one SDK client and session, under the same `snippetTimeoutMs`, the
 * same contracts and the same logging as any model's: the trajectory holds a
 * `request`, a `response`, a `tool_call`, a `snippet` and a `snippet_result`
 * per turn, the action log ties every action to its snippet, and the watchdogs
 * see a run like any other. There is no second path to the world.
 *
 * What it reads is the latest tool result in the messages the loop hands it —
 * the same text a model reads — and nothing else: no SDK of its own, no
 * fetch, no run directory. The one fact it keeps is which step of the route it
 * is on; every decision about the world is the program's, made inside the
 * snippet from what the state cache observed. A sandbox restart loses the
 * program's binding, the next snippet says so, and the adapter loads it again;
 * a resume starts from step 0 and the program's own scratchpad note puts it
 * back where it was.
 *
 * The program itself — the tick and its route — is not in this repository: it
 * is a private build input loaded at launch (`reference-program.ts`). This
 * module is the public half, the protocol it is played under, so what the run
 * can observe and do stays reviewable here whatever program it plays.
 *
 * It never ends a run on its own (`stub-complete` is the stub's): the route's
 * last step hunts until the episode's clock does, so the verdict is the
 * episode's, as it is for a model.
 */

import type { StateCache, WrathClient } from "@wrathbench/sdk";
import type { AdapterOutcome, ChatAdapter, ChatRequest } from "./adapter";
import type { ChatMessage } from "./context";
import type { ReferenceProgram } from "./reference-program";

// ------------------------------------------------------------ the tick protocol

/**
 * The ambient snippet surface a tick is handed (mcp/src/sandbox/child.ts):
 * what any model's snippet sees, and nothing more.
 */
export interface ReferenceEnv {
  sdk: WrathClient;
  state: StateCache;
  connect: () => Promise<unknown>;
  sleep: (ms: number, options?: { wake?: boolean }) => Promise<string>;
  scratchpad: { read: () => Promise<unknown>; write: (content: string) => Promise<unknown> };
  /** Memory across ticks, held on the sandbox's global; lost on a restart, and nothing depends on it surviving. */
  mem: Record<string, unknown>;
}

export interface TickArgs {
  /** The route step the adapter is on. */
  cursor: number;
  /** Wall-clock ms this tick may spend before it must return. */
  budgetMs: number;
  race: number;
  class: number;
}

/** What one tick says back. Small: it rides one console line of the snippet result. */
export interface TickReport {
  v: 1;
  cursor: number;
  /** The step is done (or does not apply); the adapter moves to the next. */
  advance: boolean;
  /** What the tick did, in a few words each. */
  did: string[];
  level?: number;
  xp?: number;
  hp?: number;
  /** The cursor the scratchpad held at login: where a resumed or restarted run picks up. */
  restored?: number;
  /** The tick had no session and logged in (or tried to). */
  login?: boolean;
}

/** The global the program is bound to in the sandbox. */
export const REFERENCE_GLOBAL = "__wbReference";
/** The console line a tick reports on. */
export const REPORT_PREFIX = "REF ";

/**
 * How much of the snippet timeout a tick leaves unspent: the margin between a
 * tick's own deadline and the host abandoning the snippet, which covers the
 * report, the IPC and a wait that answers late.
 */
export const TICK_MARGIN_MS = 6_000;

/** After this many ticks on one step that failed without a report, the step is skipped. */
export const MAX_FAILED_TICKS = 6;

/** The report a snippet sends when the program is not bound (a fresh child). */
export interface UnloadedReport {
  v: 1;
  unloaded: true;
}

/** The latest tool result in the window, or undefined before the first. */
export function lastToolResult(messages: readonly ChatMessage[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role === "assistant") return undefined;
    if (m.role === "tool") return m.content ?? "";
  }
  return undefined;
}

/** The program's report out of a snippet result's console, or undefined when the tick made none. */
export function parseReport(text: string | undefined): TickReport | UnloadedReport | undefined {
  if (text === undefined) return undefined;
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = /^\[log\] REF (\{.*\})\s*$/.exec(lines[i]!);
    if (m === null) continue;
    try {
      const o = JSON.parse(m[1]!) as { v?: unknown };
      if (o.v === 1) return o as TickReport | UnloadedReport;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

// ------------------------------------------------------------------ the adapter

export interface ReferenceAdapterOptions {
  /** The loaded program: its route, and its tick as source text. */
  program: ReferenceProgram;
  snippetTimeoutMs: number;
  race: number;
  class: number;
}

export class ReferenceAdapter implements ChatAdapter {
  readonly label = "reference";
  private cursor = 0;
  private failedTicks = 0;
  private turn = 0;

  constructor(private readonly opts: ReferenceAdapterOptions) {}

  /** The step the next tick plays. */
  get step(): number {
    return this.cursor;
  }

  complete(req: ChatRequest): Promise<AdapterOutcome> {
    this.turn++;
    const last = lastToolResult(req.messages);
    const report = parseReport(last);
    let load = false;
    if (last === undefined) {
      // The first turn of this process: a fresh run, or a resume whose window
      // starts empty. The program is loaded; the pad says where it was.
      load = true;
    } else if (report === undefined) {
      // The tick threw, or the snippet was abandoned: replay the step, and
      // skip it once it has failed this often, so no step can wedge the run.
      this.failedTicks++;
      if (this.failedTicks >= MAX_FAILED_TICKS) {
        this.cursor++;
        this.failedTicks = 0;
      }
    } else if ("unloaded" in report) {
      load = true;
    } else {
      this.failedTicks = 0;
      if (report.restored !== undefined && report.restored > this.cursor) this.cursor = report.restored;
      if (report.advance && report.cursor === this.cursor) this.cursor++;
    }
    const route = this.opts.program.route;
    const lastStep = route.steps.length - 1;
    this.cursor = Math.min(this.cursor, lastStep);
    const args: TickArgs = {
      cursor: this.cursor,
      budgetMs: Math.max(5_000, this.opts.snippetTimeoutMs - TICK_MARGIN_MS),
      race: this.opts.race,
      class: this.opts.class,
    };
    const step = route.steps[this.cursor]!;
    const label = `reference ${route.id}@${route.version}: step ${this.cursor + 1}/${lastStep + 1} (${step.kind})`;
    const code = load ? this.loadSnippet(label, args) : tickSnippet(label, args);
    return Promise.resolve({
      kind: "ok",
      turn: {
        content: label,
        toolCalls: [{ id: `reference-${this.turn}`, name: "run_snippet", arguments: JSON.stringify({ code }) }],
      },
    });
  }

  /** The program and the route, bound on the sandbox's global, then the first tick. */
  private loadSnippet(label: string, args: TickArgs): string {
    return [
      `// ${label} — loading the program`,
      `globalThis.${REFERENCE_GLOBAL} = { tick: (${this.opts.program.source}), route: ${JSON.stringify(this.opts.program.route)}, mem: {} };`,
      tickBody(args),
    ].join("\n");
  }
}

function tickBody(args: TickArgs): string {
  return [
    `const __wbRef = globalThis.${REFERENCE_GLOBAL};`,
    `if (__wbRef === undefined) console.log(${JSON.stringify(REPORT_PREFIX)} + JSON.stringify({ v: 1, unloaded: true }));`,
    `else console.log(${JSON.stringify(REPORT_PREFIX)} + JSON.stringify(await __wbRef.tick({ sdk, state, connect, sleep, scratchpad, mem: __wbRef.mem }, __wbRef.route, ${JSON.stringify(args)})));`,
  ].join("\n");
}

/** A tick on the program already bound; a fresh child answers `unloaded`. */
export function tickSnippet(label: string, args: TickArgs): string {
  return [`// ${label}`, tickBody(args)].join("\n");
}
