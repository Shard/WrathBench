/**
 * Sleeping and waking on the program loop (`loop: "program"`; operator,
 * 2026-11-12, adopted 2026-11-14).
 *
 * On the program loop the model's routines run in the sandbox whether it is
 * awake or not (the stack's `ProgramHost`), so a reply with no tool call puts
 * the model to sleep instead of re-prompting it after the step interval, and
 * on a `yield` arm the `yield` tool sleeps the same way inside a turn. A sleep
 * ends on the first wake reason, a two-second window after it so that a
 * cascade is one wake, never sooner than the step interval, and after five
 * minutes at the latest.
 *
 * The wake set is fixed by the harness and the same for every model:
 *
 *  - from the program (`ProgramFact`, the stack's): a routine ending, the
 *    first error or refusal of each signature since the last load, a
 *    `wake(reason)` call, and a sandbox restart the program came back from;
 *  - from the runner: a death (the session record's `death` row), the event
 *    stream closing (the state sample), and a harness notice.
 *
 * A pre-emption, a load and a save's own result never wake: the first is
 * reported in the next wake, the others are the model's own tool results.
 * Gaining a level or completing a quest never wakes either; the next wake
 * reports it. Nothing here holds, backs off or stops the model's code.
 *
 * What a wake shows is facts only (`renderWake`, pure): why it woke, every
 * routine as it stands, new errors with the lines of the model's files,
 * refusals with their hints unchanged, moves that replaced one another,
 * `wake` calls, what changed for the character, and the routines' last
 * console lines. No advice and no judgement of stalls: "last action 3s ago"
 * and "no routine is running" are the two stall facts.
 *
 * Every sleep writes one `wake` record (`via`, `turn`, `fired`, `sleptMs`,
 * `maxMs`), every fact a `deploy`, `routine` or `program_error` record as it
 * happens, and every wake the repeats it counted, so `bun wb inspect requests`
 * measures wakes per hour, requests per wake and the share of the run asleep
 * from the trajectory alone.
 */

import { renderRoutines, type ActionHintNote, type MoveOwner, type ProgramFact, type ProgramFacts, type ProgramLogLine, type RoutineRow } from "@wrathbench/mcp";
import type { HarnessNotice } from "./sandbox/host";

/** The program loop's workspace, in the run directory: files, versions, registry and memory. */
export const PROGRAM_DIR = "program";

/** The longest one sleep lasts, turn-end or `yield`: five minutes. A constant, not a knob. */
export const WAKE_CAP_MS = 300_000;
/**
 * A CLI scaffold's MCP tool timeout on the program loop: twice the longest
 * `yield` hold, so a held call, and a call queued behind it on the one
 * serialised connection, both answer before the CLI gives up on them.
 */
export const PROGRAM_TOOL_TIMEOUT_MS = 2 * WAKE_CAP_MS;
/** The window the first wake reason opens, so a cascade (a restart and the ends it caused) is one wake. */
export const WAKE_COALESCE_MS = 2_000;
/** How often a sleep looks at its reasons: a wake is never later than this. */
export const WAKE_TICK_MS = 250;
/** Error and refusal signatures shown in one wake; past it they are counted. */
export const WAKE_SIGNATURES_SHOWN = 8;
/** Console entries (log calls, repeats folded) shown in one wake, at most. */
export const WAKE_CONSOLE_SHOWN = 20;
/**
 * Characters of console shown in one wake, at most: one log call can print an
 * object over many lines (a pretty-printed move result), so the entry cap
 * alone does not hold the block's size. The newest entries that fit are
 * shown; a newest entry longer than this alone is cut to its head.
 */
export const WAKE_CONSOLE_CHARS = 2_000;
/** Pre-emptions and `wake` calls shown in one wake, each. */
export const WAKE_EVENTS_SHOWN = 8;
/** Wake reasons named in a wake's header; past it they are counted. */
const WAKE_REASONS_SHOWN = 4;
/** Workspace frames shown under an error. */
const ERROR_FRAMES_SHOWN = 3;

/** What can wake a sleeping model. */
export type WakeKey = "routine_ended" | "error" | "refusal" | "wake" | "died" | "stream_closed" | "sandbox_restart" | "notice";
/** What ended a sleep: a reason, the five minutes (or a `yield`'s own seconds), or the run ending under it. */
export type WakeFired = WakeKey | "cap" | "stopped";

/** One reason to wake, as it arrived. */
export interface WakeReason {
  key: WakeKey;
  ts: number;
  /** How the header names it, e.g. `routine ended (trip, returned)`. */
  text: string;
  /**
   * Shown to the model in every turn's context already (a death and a closed
   * stream in the HUD, a notice in `[harness notices]`): such a reason that
   * arrived before the last context was assembled is no reason to wake.
   */
  inContext: boolean;
  /** A refusal's signature (`routine|character|action|status`): how a delivered hint is matched to it. */
  signature?: string | undefined;
  /** The routine a `wake(reason)` came from, when a routine called it. */
  routine?: { name: string; character?: string | undefined } | undefined;
}

const label = (o: object): string => {
  const r = o as { name?: string | undefined; routine?: string | undefined; character?: string | undefined };
  const name = r.name ?? r.routine ?? "your program";
  return r.character === undefined ? name : `${name} (${r.character})`;
};

/** The reason a program fact wakes the model for, or null for one that does not. Pure. */
export function wakeReasonOf(fact: ProgramFact): WakeReason | null {
  switch (fact.kind) {
    case "ended":
      return { key: "routine_ended", ts: fact.ts, text: `routine ended (${label(fact.routine)}, ${fact.routine.state})`, inContext: false };
    case "error":
      return { key: "error", ts: fact.ts, text: `new error (${label(fact)}: ${fact.error.name})`, inContext: false };
    case "refusal":
      return { key: "refusal", ts: fact.ts, text: `new refusal (${label(fact)}: ${fact.action} ${fact.status})`, inContext: false, signature: fact.signature };
    case "wake":
      return {
        key: "wake",
        ts: fact.ts,
        text: `wake(${JSON.stringify(fact.reason)}) from ${label(fact)}`,
        inContext: false,
        ...(fact.routine !== undefined ? { routine: { name: fact.routine, ...(fact.character !== undefined ? { character: fact.character } : {}) } } : {}),
      };
    case "restart":
      return { key: "sandbox_restart", ts: fact.ts, text: "sandbox restart", inContext: false };
    case "restarted":
    case "preempted":
    case "loaded":
    case "load_failed":
      return null;
  }
}

/** The reasons pending since the model was last shown a wake, in arrival order. */
export class Waker {
  private pending: WakeReason[] = [];
  /** Per key, the newest moment the model has been shown its reasons up to (`forget`). */
  private readonly seenUntil = new Map<WakeKey, number>();
  /** Refusal signatures a tool result has carried the hint of since the last load (`deliver`). */
  private readonly delivered = new Set<string>();

  note(reason: WakeReason): void {
    // A reason from before the model was shown its key's news is not news, however late its fact arrives.
    if (reason.ts <= (this.seenUntil.get(reason.key) ?? -Infinity)) return;
    // Nor a refusal whose hint a result has already carried, however late its fact arrives.
    if (reason.signature !== undefined && this.delivered.has(reason.signature)) return;
    this.pending.push(reason);
    // A program that throws on a tight loop must not grow this without bound.
    if (this.pending.length > 200) this.pending.splice(0, this.pending.length - 200);
  }

  /** The first reason still pending, or undefined. */
  first(): WakeReason | undefined {
    return this.pending[0];
  }

  /** Every reason pending, oldest first. */
  peek(): readonly WakeReason[] {
    return this.pending;
  }

  /** A context was just assembled: the reasons it showed are no longer news. */
  shown(): void {
    this.pending = this.pending.filter((r) => !r.inContext);
  }

  /** Drop the reasons of `key` from at or before `ts`, pending or still to arrive. */
  forget(key: WakeKey, ts: number): void {
    this.seenUntil.set(key, Math.max(ts, this.seenUntil.get(key) ?? -Infinity));
    this.pending = this.pending.filter((r) => r.key !== key || r.ts > ts);
  }

  /** Drop the pending reasons `drop` picks. */
  forgetWhere(drop: (r: WakeReason) => boolean): void {
    this.pending = this.pending.filter((r) => !drop(r));
  }

  /** A tool result carried the hint of this refusal signature: it is no reason to wake, now or when its fact lands, until the next load. */
  deliver(signature: string): void {
    if (this.delivered.size > 1_000) this.delivered.clear();
    this.delivered.add(signature);
    this.pending = this.pending.filter((r) => r.signature !== signature);
  }

  /** A load: a signature's first refusal on the new code is news again. */
  loaded(): void {
    this.delivered.clear();
  }

  /** The reasons a wake reports, cleared. */
  take(): WakeReason[] {
    return this.pending.splice(0, this.pending.length);
  }
}

export interface SleepOptions {
  waker: Waker;
  /** The longest this sleep lasts: `WAKE_CAP_MS`, or a `yield`'s own seconds. */
  capMs: number;
  /** The floor: the step interval, slept whatever happens (capped by `capMs`). */
  floorMs: number;
  coalesceMs?: number;
  tickMs?: number;
  /** True once the run is ending: a stop request or a watchdog verdict. */
  stopped: () => boolean;
  /** A notice queued for the next message that no notice hook saw (the driver's own). */
  queuedNotices?: () => number;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

export interface SleepResult {
  fired: WakeFired;
  sleptMs: number;
}

/**
 * Sleep until a wake reason has been pending for the coalescing window, the
 * run stops or the cap passes. A reason already pending when the sleep
 * starts wakes it once the floor is slept. Reads the waker and never clears
 * it: what woke the model is the wake's to take (`ProgramWake.sleep`).
 */
export async function sleepUntilWake(o: SleepOptions): Promise<SleepResult> {
  const start = o.now();
  const cap = Math.max(0, o.capMs);
  const floor = Math.min(Math.max(0, o.floorMs), cap);
  const coalesce = o.coalesceMs ?? WAKE_COALESCE_MS;
  const tick = o.tickMs ?? WAKE_TICK_MS;
  const slept = (): number => o.now() - start;
  for (;;) {
    if (o.stopped()) return { fired: "stopped", sleptMs: slept() };
    const now = o.now();
    if ((o.queuedNotices?.() ?? 0) > 0 && o.waker.first() === undefined) {
      o.waker.note({ key: "notice", ts: now, text: "a harness notice", inContext: true });
    }
    const first = o.waker.first();
    if (first !== undefined) {
      const at = Math.max(start + floor, Math.max(first.ts, start) + coalesce);
      if (now >= at) return { fired: first.key, sleptMs: slept() };
      if (now - start >= cap) return { fired: first.key, sleptMs: slept() };
      await o.sleep(Math.max(1, Math.min(tick, at - now, cap - (now - start))));
      continue;
    }
    const left = cap - (now - start);
    if (left <= 0) return { fired: "cap", sleptMs: slept() };
    await o.sleep(Math.max(1, Math.min(tick, left)));
  }
}

// ------------------------------------------------------------------ render

/** What changed for the character over the sleep. */
export interface WakeProgress {
  level?: { from: number; to: number };
  /** XP gained at an unchanged level; absent across a level change or when unobserved. */
  xp?: number;
  quests: number;
  deaths: number;
}

/** Everything a wake block says, as data. */
export interface WakeView {
  /** This run's wake count, from 1. */
  n: number;
  sleptMs: number;
  fired: WakeFired;
  /** The `yield` call's own seconds, when that is what ended it. */
  capMs: number;
  reasons: readonly WakeReason[];
  /** The program since the last wake (`mergeFacts`). */
  facts: ProgramFacts;
  /** Every error and refusal signature seen this run, by signature: how a repeat of an earlier one is named. */
  signatures: ReadonlyMap<string, SignatureLine>;
  progress: WakeProgress | null;
  now: number;
  /** The routine errors and values the model was already shown (the stack's `ProgramHost.shownDetails`): their lines refer to them. */
  shown?: ReadonlySet<string> | undefined;
}

/** How an error or refusal signature reads in a wake. */
export interface SignatureLine {
  kind: "error" | "refusal";
  text: string;
  /** An error's workspace frames, innermost first. */
  frames: readonly string[];
}

/** "45s", "4m05s", "1h05m". */
export function sleptWords(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m`;
}

const owner = (o: MoveOwner): string => ("routine" in o ? `routine ${o.routine}` : "your snippet");
const point = (p: { x: number; y: number; z: number }): string => `(${p.x.toFixed(1)}, ${p.y.toFixed(1)}, ${p.z.toFixed(1)})`;
const ago = (now: number, ts: number): string => `${sleptWords(now - ts)} ago`;

/** The line an error or refusal signature reads as, from its fresh fact. */
export function signatureLineOf(fact: ProgramFact): { signature: string; line: SignatureLine } | null {
  if (fact.kind === "error") {
    return { signature: fact.error.signature, line: { kind: "error", text: `${label(fact)} ${fact.error.text}`, frames: fact.error.frames } };
  }
  if (fact.kind === "refusal") {
    return { signature: fact.signature, line: { kind: "refusal", text: `${label(fact)} ${fact.action} ${fact.status} — ${fact.hint}`, frames: [] } };
  }
  if (fact.kind === "ended" && fact.routine.state === "threw" && fact.routine.error !== undefined) {
    const e = fact.routine.error;
    return { signature: e.signature, line: { kind: "error", text: `${label(fact.routine)} ${e.text}`, frames: e.frames } };
  }
  return null;
}

/**
 * The [wake] block. Pure: the same view renders the same bytes, so a replay
 * of the request that carried it is byte-identical. Capped everywhere: eight
 * signatures, twenty console entries in at most `WAKE_CONSOLE_CHARS`, eight of
 * each event, no file contents.
 */
export function renderWake(v: WakeView): string {
  const why =
    v.fired === "cap"
      ? v.capMs >= WAKE_CAP_MS
        ? "five minutes passed"
        : `${sleptWords(v.capMs)} passed`
      : v.fired === "stopped"
        ? "the run is ending"
        : namedReasons(v.reasons);
  const lines: string[] = [`[wake ${v.n} · slept ${sleptWords(v.sleptMs)} · woke for: ${why}]`];

  // Every routine as it stands, in the stack's own words, and the stall fact.
  lines.push(renderRoutines(v.facts.routines, v.now, v.shown));
  if (!v.facts.routines.some((r) => r.state === "running")) lines.push("no routine is running");

  const facts = v.facts.facts;
  // What happened to the program that the model did not do itself: a restart, and the load it brought.
  for (const f of facts) {
    if (f.kind === "restart") {
      const parts = [f.blamed ? "sandbox restarted: its event loop was blocked while no snippet was running" : "sandbox restarted"];
      if (f.restarted.length > 0) parts.push(`started again from the top: ${f.restarted.map(label).join(", ")}`);
      if (f.interrupted.length > 0) parts.push(`not started again: ${f.interrupted.map((r: RoutineRow) => `${label(r)}${r.note !== undefined ? ` (${r.note})` : ""}`).join(", ")}`);
      lines.push(`${parts.join(" · ")}`);
    } else if (f.kind === "load_failed" && f.by === "restart") {
      lines.push(`load after the restart failed: ${f.error}`);
    } else if (f.kind === "load_failed" && f.by === "carried") {
      // A continuation's files, loaded at the first start: nothing restarted.
      lines.push(`the carried files did not load: ${f.error}`);
    }
  }

  // Errors and refusals: each signature once, the newest first, ×N past one.
  const counts = new Map<string, { n: number; ts: number }>();
  const bump = (sig: string, n: number, ts: number): void => {
    const c = counts.get(sig);
    if (c === undefined) counts.set(sig, { n, ts });
    else {
      c.n += n;
      c.ts = Math.max(c.ts, ts);
    }
  };
  for (const f of facts) {
    const s = signatureLineOf(f);
    if (s !== null && (f.kind !== "ended" || f.fresh === true)) bump(s.signature, 1, f.ts);
  }
  for (const r of v.facts.repeats) bump(r.signature, r.count, r.ts);
  const shown = [...counts.entries()]
    .map(([sig, c]) => ({ sig, ...c, line: v.signatures.get(sig) }))
    .filter((x): x is { sig: string; n: number; ts: number; line: SignatureLine } => x.line !== undefined)
    .sort((a, b) => b.ts - a.ts);
  for (const kind of ["error", "refusal"] as const) {
    const rows = shown.filter((x) => x.line.kind === kind);
    if (rows.length === 0) continue;
    lines.push(kind === "error" ? "errors:" : "refusals:");
    for (const x of rows.slice(0, WAKE_SIGNATURES_SHOWN)) {
      lines.push(`  ${x.line.text}${x.n > 1 ? ` ×${x.n}` : ""}`);
      for (const frame of x.line.frames.slice(0, ERROR_FRAMES_SHOWN)) lines.push(`      ${frame}`);
    }
    if (rows.length > WAKE_SIGNATURES_SHOWN) lines.push(`  and ${rows.length - WAKE_SIGNATURES_SHOWN} more`);
  }

  const preempted = facts.filter((f): f is Extract<ProgramFact, { kind: "preempted" }> => f.kind === "preempted");
  if (preempted.length > 0) {
    lines.push("moves replaced:");
    for (const p of preempted.slice(-WAKE_EVENTS_SHOWN)) {
      lines.push(`  ${owner(p.of)}'s move${p.character !== undefined ? ` for ${p.character}` : ""} to ${point(p.to)} was replaced by ${owner(p.by)}, ${ago(v.now, p.ts)}`);
    }
    if (preempted.length > WAKE_EVENTS_SHOWN) lines.push(`  and ${preempted.length - WAKE_EVENTS_SHOWN} earlier`);
  }

  const wakes = facts.filter((f): f is Extract<ProgramFact, { kind: "wake" }> => f.kind === "wake");
  if (wakes.length > 0) {
    lines.push("wake calls:");
    for (const w of wakes.slice(-WAKE_EVENTS_SHOWN)) lines.push(`  ${label(w)}: ${JSON.stringify(w.reason)}, ${ago(v.now, w.ts)}`);
    if (wakes.length > WAKE_EVENTS_SHOWN) lines.push(`  and ${wakes.length - WAKE_EVENTS_SHOWN} earlier`);
  }

  if (v.progress !== null) {
    const p = v.progress;
    const parts: string[] = [];
    if (p.level !== undefined && p.level.from !== p.level.to) parts.push(`level ${p.level.from} → ${p.level.to}`);
    else if (p.xp !== undefined) parts.push(`xp +${p.xp}`);
    parts.push(`quests completed ${p.quests}`, `deaths ${p.deaths}`);
    lines.push(`since you slept: ${parts.join(" · ")}`);
  }

  if (v.facts.factsDropped > 0) lines.push(`${v.facts.factsDropped} older program events were not kept`);

  const con = v.facts.console;
  if (con.total > 0) {
    const tail = consoleTail(con.lines);
    lines.push(`program console: ${con.total.toLocaleString("en-US")} line${con.total === 1 ? "" : "s"}, last ${tail.length} shown, repeats folded`);
    lines.push(...tail);
  }
  return lines.join("\n");
}

/**
 * The console entries a wake shows, oldest first: the newest that fit in
 * `WAKE_CONSOLE_CHARS`, at most `WAKE_CONSOLE_SHOWN`. The newest entry is
 * always shown, cut to its head when it alone is over the cap.
 */
function consoleTail(entries: readonly ProgramLogLine[]): string[] {
  const out: string[] = [];
  let left = WAKE_CONSOLE_CHARS;
  for (let k = entries.length - 1; k >= 0 && out.length < WAKE_CONSOLE_SHOWN; k--) {
    const l = entries[k]!;
    const head = `  [${label(l)}]${l.level === "log" || l.level === "info" ? "" : ` ${l.level}:`} `;
    const tail = l.count > 1 ? ` ×${l.count}` : "";
    if (head.length + l.text.length + tail.length <= left) {
      out.unshift(`${head}${l.text}${tail}`);
      left -= head.length + l.text.length + tail.length;
      continue;
    }
    if (out.length > 0) break;
    const keep = Math.max(0, left - head.length - tail.length);
    out.unshift(`${head}${l.text.slice(0, keep)}… (${(l.text.length - keep).toLocaleString("en-US")} more chars)${tail}`);
    break;
  }
  return out;
}

function namedReasons(reasons: readonly WakeReason[]): string {
  const texts: string[] = [];
  for (const r of reasons) if (!texts.includes(r.text)) texts.push(r.text);
  if (texts.length === 0) return "nothing";
  const shown = texts.slice(0, WAKE_REASONS_SHOWN).join("; ");
  return texts.length > WAKE_REASONS_SHOWN ? `${shown}; and ${texts.length - WAKE_REASONS_SHOWN} more` : shown;
}

/** Two drains as one span: facts in order, repeats summed by signature, the console's tail, the routines as they stand now. */
export function mergeFacts(a: ProgramFacts | null, b: ProgramFacts): ProgramFacts {
  if (a === null) return b;
  const repeats = new Map<string, { signature: string; count: number; ts: number }>();
  for (const r of [...a.repeats, ...b.repeats]) {
    const prev = repeats.get(r.signature);
    if (prev === undefined) repeats.set(r.signature, { ...r });
    else {
      prev.count += r.count;
      prev.ts = Math.max(prev.ts, r.ts);
    }
  }
  const lines: ProgramLogLine[] = [...a.console.lines, ...b.console.lines];
  return {
    deploy: b.deploy,
    routines: b.routines,
    facts: [...a.facts, ...b.facts],
    factsDropped: a.factsDropped + b.factsDropped,
    repeats: [...repeats.values()],
    console: { lines: lines.slice(-200), total: a.console.total + b.console.total },
  };
}

// ------------------------------------------------------------------- wiring

/** What a wake needs of the stack's program host (`SandboxHost.program`). */
export interface WakeProgram {
  beat(): Promise<void>;
  drainFacts(): ProgramFacts;
  /** The routine errors and values the model was already shown, and how a wake marks what it showed. */
  shownDetails(): ReadonlySet<string>;
  markShown(rows: readonly RoutineRow[]): void;
}

/** A state sample, as far as a wake reads it. */
export interface WakeSample {
  self?: { level?: { value?: unknown } } | null | undefined;
  xp?: { value?: unknown } | null | undefined;
  observation?: { connected?: boolean } | undefined;
}

/** The run's trajectory, as far as the wake writes to it. */
export interface WakeTrajectory {
  append(record: { t: string; [key: string]: unknown }): void;
  scrub(text: string): string;
}

/** Counts of the session record's rows (`RecordSignals.counts`). */
export interface WakeCounts {
  deaths: number;
  quests: number;
}

/** What `ProgramWake.sleep` is asked. */
export interface WakeSleepOptions {
  via: "turn-end" | "yield";
  turn: number;
  capMs: number;
  floorMs: number;
  /** True once the run is ending; checked on every tick. */
  stopped: () => boolean;
  queuedNotices?: () => number;
  /** The watchdogs' idle clock, held while asleep (`Watchdogs.noteAsleep`). */
  idle?: { noteAsleep(): void; noteAwake(): void } | undefined;
  /**
   * Whether the block stays in the model's conversation: a `yield` result
   * does, and so does a codex turn's message; the fixed loop's turn-end
   * message is never kept. Only a kept block marks the routine errors and
   * values it showed as shown, so a later line never refers to text the
   * model no longer has.
   */
  kept: boolean;
}

/**
 * One run's program-loop waking: the reasons as they arrive, the records as
 * they happen, and the wake block at each wake. Made before the sandbox (its
 * `onFact` is the program's), handed to the loop, which sleeps through it.
 */
export class ProgramWake {
  readonly waker = new Waker();
  private n = 0;
  /** What the sleep-start drain took, carried into the next wake. */
  private held: ProgramFacts | null = null;
  private readonly signatures = new Map<string, SignatureLine>();
  private lastSample: WakeSample | null = null;
  private connected: boolean | undefined;
  /** Restarts the program was blamed for: each counts toward `snippet-runaway` (`takeBlamedRestarts`). */
  private blamed = 0;
  private readonly now: () => number;
  private readonly sleepFn: (ms: number) => Promise<void>;

  constructor(
    private readonly o: {
      trajectory: WakeTrajectory;
      /** The session record's counts; absent counts nothing. */
      counts?: (() => WakeCounts) | undefined;
      now?: () => number;
      sleep?: (ms: number) => Promise<void>;
      tickMs?: number;
      coalesceMs?: number;
    },
  ) {
    this.now = o.now ?? Date.now;
    this.sleepFn = o.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  }

  /** `ProgramOptions.onFact`: record the fact, remember how its signature reads, and wake for it if it wakes. */
  readonly onFact = (fact: ProgramFact): void => {
    const s = signatureLineOf(fact);
    if (s !== null && !this.signatures.has(s.signature)) {
      this.signatures.set(s.signature, s.line);
      if (this.signatures.size > 1_000) this.signatures.delete(this.signatures.keys().next().value as string);
    }
    if (fact.kind === "restart" && fact.blamed) this.blamed++;
    if (fact.kind === "loaded") this.waker.loaded();
    try {
      this.o.trajectory.append(factRecord(fact));
    } catch {
      // A record that could not be written must not cost the sandbox its IPC.
    }
    const reason = wakeReasonOf(fact);
    if (reason !== null) this.waker.note(reason);
  };

  /** The sandbox's `onNotice`, beside the trajectory's: a notice wakes. */
  onNotice(n: Pick<HarnessNotice, "kind" | "ts">): void {
    this.waker.note(
      n.kind === "sandbox_restarted"
        ? { key: "sandbox_restart", ts: n.ts, text: "sandbox restart", inContext: true }
        : { key: "notice", ts: n.ts, text: "a harness notice", inContext: true },
    );
  }

  /** A `death` row of the session record. */
  onDeath(ts: number): void {
    this.waker.note({ key: "died", ts, text: "your character died", inContext: true });
  }

  /** Every state sample: the stream closing wakes, and the last reading is what progress is measured from. */
  onSample(snap: WakeSample): void {
    this.lastSample = snap;
    const connected = snap.observation?.connected;
    if (connected === false && this.connected === true) {
      this.waker.note({ key: "stream_closed", ts: this.now(), text: "the event stream closed", inContext: true });
    }
    if (connected !== undefined) this.connected = connected;
  }

  /** A context was just assembled and is about to be sent: what it showed is no reason to wake. */
  shown(): void {
    this.waker.shown();
  }

  /**
   * A routine tool just answered with every routine's state (`rows`, as its
   * lines showed them): a routine that ended before it is news the model
   * has, so it no longer wakes a sleep that starts after. Nor does a
   * `wake(reason)` from a run those lines show as over: one that has ended,
   * or that a newer run of the same name has replaced. A still-running
   * routine's call stays pending. Both are still in the next wake's lines.
   */
  routinesShown(rows: readonly RoutineRow[] = []): void {
    this.waker.forget("routine_ended", this.now());
    this.waker.forgetWhere((r) => {
      if (r.key !== "wake" || r.routine === undefined) return false;
      const run = rows.find((x) => x.name === r.routine!.name && x.character === r.routine!.character);
      return run !== undefined && (run.state !== "running" || run.startedAt > r.ts);
    });
  }

  /**
   * A tool result is carrying these action hints (the stack's
   * `onHintsDelivered`, called as the result is built): a routine's refusal
   * whose hint it carries is delivered, by signature, and no longer wakes a
   * sleep, nor does its fact when it lands late, until the next load. A hint
   * whose status is `dead` tells the model its character is dead, so a death
   * from before it no longer wakes either. Both still show in the next wake.
   */
  hintsDelivered(hints: readonly ActionHintNote[]): void {
    for (const h of hints) {
      if (h.routine !== undefined) this.waker.deliver(`${h.routine}|${h.character ?? ""}|${h.action}|${h.status}`);
      if (h.status === "dead") this.waker.forget("died", h.ts);
    }
  }

  /** Restarts the program was blamed for since the last call. */
  takeBlamedRestarts(): number {
    const n = this.blamed;
    this.blamed = 0;
    return n;
  }

  private reading(): { level?: number; xp?: number; counts: WakeCounts } {
    const level = this.lastSample?.self?.level?.value;
    const xp = this.lastSample?.xp?.value;
    return {
      ...(typeof level === "number" ? { level } : {}),
      ...(typeof xp === "number" ? { xp } : {}),
      counts: this.o.counts?.() ?? { deaths: 0, quests: 0 },
    };
  }

  /**
   * Sleep, then build the wake: drain the program once as the sleep starts
   * (held for this wake), sleep until a reason, beat and drain again, and
   * render everything since the previous wake. Writes the `wake` record and
   * the repeats; returns the block, scrubbed of the run's secrets, which the
   * program's facts and console have not passed through.
   */
  async sleep(program: WakeProgram, o: WakeSleepOptions): Promise<{ block: string; fired: WakeFired; sleptMs: number }> {
    this.held = mergeFacts(this.held, program.drainFacts());
    const before = this.reading();
    o.idle?.noteAsleep();
    let woke: SleepResult;
    try {
      woke = await sleepUntilWake({
        waker: this.waker,
        capMs: o.capMs,
        floorMs: o.floorMs,
        stopped: o.stopped,
        ...(o.queuedNotices !== undefined ? { queuedNotices: o.queuedNotices } : {}),
        now: this.now,
        sleep: this.sleepFn,
        ...(this.o.tickMs !== undefined ? { tickMs: this.o.tickMs } : {}),
        ...(this.o.coalesceMs !== undefined ? { coalesceMs: this.o.coalesceMs } : {}),
      });
    } finally {
      o.idle?.noteAwake();
    }
    try {
      await program.beat();
    } catch {
      // A beat that failed leaves the registry as the last one left it.
    }
    const facts = mergeFacts(this.held, program.drainFacts());
    this.held = null;
    const reasons = this.waker.take();
    this.n++;
    const after = this.reading();
    const now = this.now();
    const progress: WakeProgress = {
      ...(before.level !== undefined && after.level !== undefined ? { level: { from: before.level, to: after.level } } : {}),
      ...(before.level !== undefined && before.level === after.level && before.xp !== undefined && after.xp !== undefined ? { xp: Math.max(0, after.xp - before.xp) } : {}),
      quests: Math.max(0, after.counts.quests - before.counts.quests),
      deaths: Math.max(0, after.counts.deaths - before.counts.deaths),
    };
    const block = this.o.trajectory.scrub(
      renderWake({
        n: this.n,
        sleptMs: woke.sleptMs,
        fired: woke.fired,
        capMs: o.capMs,
        reasons,
        facts,
        signatures: this.signatures,
        progress,
        now,
        shown: program.shownDetails(),
      }),
    );
    if (o.kept) program.markShown(facts.routines);
    // The block itself, as the model reads it: `bun wb inspect` shows a wake from its record alone.
    this.o.trajectory.append({
      t: "wake",
      via: o.via,
      turn: o.turn,
      fired: woke.fired,
      sleptMs: woke.sleptMs,
      maxMs: o.capMs,
      ...(reasons.length > 0 ? { reasons: [...new Set(reasons.map((r) => r.key))] } : {}),
      n: this.n,
      block,
    });
    for (const r of facts.repeats) this.o.trajectory.append({ t: "program_error", kind: "repeat", signature: r.signature, count: r.count });
    return { block, fired: woke.fired, sleptMs: woke.sleptMs };
  }
}

/** The trajectory record of one program fact: `deploy`, `routine` or `program_error`. */
export function factRecord(fact: ProgramFact): { t: string; [key: string]: unknown } {
  switch (fact.kind) {
    case "loaded":
      return { t: "deploy", ok: true, by: fact.by, deploy: fact.deploy, routines: fact.routines, restarted: fact.restarted, dropped: fact.dropped, at: fact.ts };
    case "load_failed":
      return { t: "deploy", ok: false, by: fact.by, error: fact.error, running: fact.running, at: fact.ts };
    case "ended":
      return {
        t: "routine",
        event: "ended",
        name: fact.routine.name,
        ...(fact.routine.character !== undefined ? { character: fact.routine.character } : {}),
        state: fact.routine.state,
        deploy: fact.routine.deploy,
        startedAt: fact.routine.startedAt,
        ...(fact.routine.endedAt !== undefined ? { endedAt: fact.routine.endedAt } : {}),
        ...(fact.routine.error !== undefined ? { signature: fact.routine.error.signature, error: fact.routine.error.text } : {}),
        ...(fact.fresh === true ? { fresh: true } : {}),
        at: fact.ts,
      };
    case "restarted":
      return { t: "routine", event: "restarted", name: fact.routine.name, ...(fact.routine.character !== undefined ? { character: fact.routine.character } : {}), deploy: fact.routine.deploy, at: fact.ts };
    case "restart":
      return {
        t: "routine",
        event: "restart",
        blamed: fact.blamed,
        restarted: fact.restarted.map(label),
        interrupted: fact.interrupted.map((r) => ({ name: label(r), ...(r.note !== undefined ? { note: r.note } : {}) })),
        at: fact.ts,
      };
    case "wake":
      return { t: "routine", event: "wake", reason: fact.reason, ...(fact.routine !== undefined ? { name: fact.routine } : {}), ...(fact.character !== undefined ? { character: fact.character } : {}), at: fact.ts };
    case "preempted":
      return { t: "routine", event: "preempted", by: fact.by, of: fact.of, ...(fact.character !== undefined ? { character: fact.character } : {}), at: fact.ts };
    case "error":
      return {
        t: "program_error",
        kind: "error",
        signature: fact.error.signature,
        ...("routine" in fact && fact.routine !== undefined ? { name: fact.routine } : {}),
        error: fact.error.text,
        frames: fact.error.frames,
        deploy: fact.deploy,
        at: fact.ts,
      };
    case "refusal":
      return { t: "program_error", kind: "refusal", signature: fact.signature, name: fact.routine, action: fact.action, status: fact.status, deploy: fact.deploy, at: fact.ts };
  }
}
