/**
 * The entrypoint loop's wake policy (a probing spike; `loop: "entrypoint"`).
 *
 * The model ends its turn by replying without a tool call; its program keeps
 * running and the model sleeps until something it should know about happens,
 * or at the latest `FALLBACK_WAKE_MS` later. This module owns three things:
 *
 *  - `WakeLog`: everything since the model last ended its turn — the program's
 *    reports (ticks, errors, `ctx.wake` requests, facts, console, hints), what
 *    the host said about it (halts, restarts, reloads), and the deploy made at
 *    the yield — and which of it is a reason to wake. A deploy made by a save
 *    is not in it: the save's own result reports it (`renderSaveDeploy`), and a
 *    failed one wakes no one.
 *  - `sleepUntilWake`: the sleep itself, with its timing rules — the first
 *    reason opens a `WAKE_COALESCE_MS` window so a cascade is one wake, no wake
 *    comes sooner than `MIN_SLEEP_MS` after the yield, a reason already shown
 *    in a request never wakes the model again — while the stop signal and the
 *    watchdogs are checked every second.
 *  - `renderWake`: the `[wake]` block, a pure function of a `WakeView`, so a
 *    trajectory replays into the same bytes. It is re-rendered on every
 *    request of a wake, because the user message it lives in is never kept.
 *
 * The constants are the design's and operator-owned; nothing here tunes them.
 */

import type { SnapshotLike } from "./context";
import type { DeployRecord, ProgramHostEvent, ProgramState } from "./sandbox/host";
import type { ActionHintNote, ProgramErrorNote, ProgramLogEntry, ProgramMilestoneNote, ProgramReport, TickInFlight } from "./sandbox/ipc";

/** Asleep this long with no other reason: wake anyway. */
export const FALLBACK_WAKE_MS = 300_000;
/** The first reason opens a window this long, so a cascade becomes one wake. */
export const WAKE_COALESCE_MS = 2_000;
/** No wake sooner than this after the model ended its turn. */
export const MIN_SLEEP_MS = 5_000;
/** A wake ends after this many requests even if the model keeps calling tools. */
export const WAKE_MAX_REQUESTS = 20;
/** How often a sleeping loop checks the stop signal, the watchdogs and the log. */
export const SLEEP_CHECK_MS = 1_000;

/** The block's caps. */
export const WAKE_CONSOLE_LINES = 40;
export const WAKE_CONSOLE_CHARS = 4_000;
export const WAKE_ERRORS_SHOWN = 8;
export const WAKE_MEMORY_CHARS = 2_000;
const WAKE_HINTS_SHOWN = 4;
const WAKE_HINT_CHARS = 320;
/** Console entries the log keeps between two wakes (the block shows the last 40). */
const CONSOLE_KEEP = 200;

/** Why the model was woken. */
export type WakeKind = "start" | "error" | "load" | "halted" | "restart" | "requested" | "milestone" | "fallback";

/** The order reasons are listed in, whatever order they arrived in. */
const KIND_ORDER: readonly WakeKind[] = ["start", "error", "load", "halted", "restart", "requested", "milestone", "fallback"];

interface Reason {
  kind: WakeKind;
  at: number;
  shown: boolean;
}

/**
 * One error signature since the yield, as the block lists it — a throw and a
 * failed `sdk` call under `errors:`, an `sdk` call that answered `ok: false`
 * (`kind` outcome) under `outcomes:`.
 */
export interface WakeErrorRow {
  signature: string;
  hook: string;
  kind: ProgramErrorNote["kind"];
  text: string;
  count: number;
  deploy: number | null;
  firstTs: number;
  lastTs: number;
}

export interface WakeRequestRow {
  reason: string;
  from: string;
  count: number;
}

/** A host event since the yield, one line each in the block. */
export interface WakeHostRow {
  kind: "halted" | "restart" | "stopped" | "reload";
  at: number;
  detail: string;
}

/** A deploy since the yield: the yield's own, or a reload after a restart. */
export interface WakeLoadRow {
  deploy: number;
  ok: boolean;
  action: "load" | "unload";
  error?: string | undefined;
  /** A load that went through with `on` keys that are not event names. */
  warnings?: string[] | undefined;
  at: number;
}

/** What changed in the world since the model ended its turn. */
export interface StateDelta {
  levelFrom?: number | undefined;
  levelTo?: number | undefined;
  xpGained?: number | undefined;
  moneyDelta?: number | undefined;
  quests: number[];
  deaths: number;
  zoneFrom?: string | undefined;
  zoneTo?: string | undefined;
}

/** Everything `renderWake` reads. Pure data: the same view renders the same bytes. */
export interface WakeView {
  wake: number;
  request: number;
  /** Null on the first wake of a process: there was no sleep before it. */
  asleepMs: number | null;
  wokeFor: WakeKind[];
  /** The previous wake ended at the request cap rather than at a reply. */
  lastWakeCapped: boolean;
  program: {
    state: ProgramState["kind"];
    deploy?: number | undefined;
    deployedAt?: number | undefined;
    /** main.ts or a file it imports differs from what the current deploy loaded. */
    editsSinceDeploy: boolean;
    /** The deploy that already failed to load main.ts and its imports as they are now (the yield does not try them again). */
    failedDeploy?: number | null | undefined;
    mainExists: boolean;
  };
  ticks: number;
  longestTickMs: number;
  /** The tick running at the latest report, which `ticks` does not count yet; null when none was. */
  tickInFlight: TickInFlight | null;
  overruns: number;
  loads: WakeLoadRow[];
  host: WakeHostRow[];
  /** Every signature since the yield; the block splits `errors:` from `outcomes:` by `kind`. */
  errors: WakeErrorRow[];
  requests: WakeRequestRow[];
  delta: StateDelta | null;
  hints: ActionHintNote[];
  /** The program's console since the yield: a line printed again right after itself is one entry, `repeats` its count. */
  console: { lines: number; entries: ProgramLogEntry[] };
  /** memory.json as it is on disk; null when there is none. */
  memory: string | null;
  /** memory.json is what the previous request of this wake showed: one line instead of the text. */
  memoryUnchanged: boolean;
}

// ----------------------------------------------------------------- the log

/**
 * Everything since the model last ended its turn, and the reasons among it.
 * Fed by the host's reports and events and by the yield's deploy; read by the
 * sleep (when to wake) and by `view` (what the block shows).
 */
export class WakeLog {
  private yieldedAt: number | null = null;
  private reasons: Reason[] = [];
  private errors = new Map<string, WakeErrorRow>();
  private requests = new Map<string, WakeRequestRow>();
  private milestones: ProgramMilestoneNote[] = [];
  private loads: WakeLoadRow[] = [];
  private host: WakeHostRow[] = [];
  private ticks = 0;
  private longestTickMs = 0;
  /** As the latest report found it: a tick that began before the yield is still running after it. */
  private tickInFlight: TickInFlight | null = null;
  private overruns = 0;
  private console: ProgramLogEntry[] = [];
  private consoleLines = 0;
  private hints = new Map<string, ActionHintNote>();
  private capped = false;
  /**
   * What the last rendered request showed, by position and count. The yield
   * clears only that: rows that arrived after the last render — a report
   * landing while the model's reply was in flight — carry into the next wake,
   * or the model would be woken for an error it is never shown.
   */
  private shown: Shown = emptyShown();
  /**
   * The trajectory's ledger, kept apart from what the block shows: every
   * occurrence counted once, drained as each wake ends (`drainLedger`).
   */
  private ledger: WakeLedger = emptyLedger();

  /** When the model last ended its turn; null before the first yield of this process. */
  get asleepSince(): number | null {
    return this.yieldedAt;
  }

  private reason(kind: WakeKind, at: number): void {
    this.reasons.push({ kind, at, shown: false });
  }

  /** A drained program report. */
  noteReport(r: ProgramReport, now: number): void {
    this.ticks += r.ticks;
    this.longestTickMs = Math.max(this.longestTickMs, r.longestTickMs);
    this.tickInFlight = r.tickInFlight ?? null;
    this.overruns += r.overruns;
    this.ledger.ticks += r.ticks;
    this.ledger.longestTickMs = Math.max(this.ledger.longestTickMs, r.longestTickMs);
    this.ledger.overruns += r.overruns;
    for (const e of r.errors) {
      const key = `${e.deploy ?? "-"}\u0000${e.signature}`;
      const row = this.errors.get(key);
      if (row !== undefined) {
        row.count += e.count;
        row.lastTs = Math.max(row.lastTs, e.lastTs);
      } else {
        this.errors.set(key, {
          signature: e.signature,
          hook: e.hook,
          kind: e.kind,
          text: e.text,
          count: e.count,
          deploy: e.deploy,
          firstTs: e.firstTs,
          lastTs: e.lastTs,
        });
      }
      const booked = this.ledger.errors.get(key);
      if (booked !== undefined) booked.count += e.count;
      else this.ledger.errors.set(key, { signature: e.signature, hook: e.hook, kind: e.kind, deploy: e.deploy, count: e.count });
      if (e.isNew) this.reason("error", now);
    }
    for (const q of r.requests) {
      const key = `${q.reason}\u0000${q.from}`;
      const row = this.requests.get(key);
      if (row !== undefined) row.count += q.count;
      else this.requests.set(key, { reason: q.reason, from: q.from, count: q.count });
      this.reason("requested", now);
    }
    for (const m of r.milestones) {
      this.milestones.push(m);
      this.reason("milestone", now);
    }
    this.consoleLines += r.logLines;
    // A report's first line may be the last one's repeat: the child folds
    // within one report, and this keeps folding across them.
    for (const e of r.logs) {
      const last = this.console[this.console.length - 1];
      if (last !== undefined && last.level === e.level && last.text === e.text) {
        last.repeats = (last.repeats ?? 1) + (e.repeats ?? 1);
        last.ts = e.ts;
      } else this.console.push({ ...e });
    }
    if (this.console.length > CONSOLE_KEEP) {
      const drop = this.console.length - CONSOLE_KEEP;
      this.console.splice(0, drop);
      this.shown.console = Math.max(0, this.shown.console - drop);
    }
    for (const h of r.hints) {
      const key = `${h.action}\u0000${h.status}`;
      const prev = this.hints.get(key);
      this.hints.set(key, prev === undefined ? { ...h } : { ...h, count: prev.count + h.count });
    }
  }

  /** What the host said about the program between reports. */
  noteHost(e: ProgramHostEvent, now: number): void {
    // The child that ran the tick is gone; the next report says what runs now.
    if (e.kind === "halted" || e.kind === "restart" || e.kind === "stopped") this.tickInFlight = null;
    switch (e.kind) {
      case "report":
        this.noteReport(e.report, now);
        return;
      case "halted":
        this.host.push({
          kind: "halted",
          at: e.at,
          detail: `your program (deploy ${e.deploy}) blocked the event loop; the sandbox restarted, and main.ts loads again when you save a change to it or end your turn`,
        });
        this.ledger.halts++;
        this.reason("halted", now);
        return;
      case "restart":
        this.host.push({ kind: "restart", at: e.at, detail: `${e.detail}; the sandbox restarted` });
        this.ledger.restarts++;
        this.reason("restart", now);
        return;
      case "stopped":
        this.host.push({
          kind: "stopped",
          at: e.at,
          detail: `files changed since deploy ${e.deploy}, so it was not reloaded after the restart; main.ts loads again when you save a change to it or end your turn`,
        });
        return;
      case "reload":
        this.loads.push({
          deploy: e.deploy,
          ok: e.answer.ok,
          action: "load",
          ...(e.answer.ok ? (e.answer.warnings !== undefined ? { warnings: e.answer.warnings } : {}) : { error: e.answer.error }),
          at: e.at,
        });
        if (!e.answer.ok) this.reason("load", now);
        return;
    }
  }

  /** The deploy made as the model ended its turn: the first thing the next wake sees. */
  noteDeploy(rec: DeployRecord, now: number): void {
    this.loads.push({
      deploy: rec.deploy,
      ok: rec.ok,
      action: rec.action,
      ...(rec.error !== undefined ? { error: rec.error } : {}),
      ...(rec.warnings !== undefined ? { warnings: rec.warnings } : {}),
      at: now,
    });
    if (!rec.ok) this.reason("load", now);
  }

  /**
   * The model ended its turn. What it was shown is behind it; what arrived
   * after the last render — reasons and rows alike — carries into the next
   * wake, where it is shown and, for a reason, wakes it.
   */
  yielded(now: number, capped: boolean): void {
    const s = this.shown;
    this.yieldedAt = now;
    this.capped = capped;
    this.reasons = this.reasons.filter((r) => !r.shown);
    const errors = new Map<string, WakeErrorRow>();
    for (const [key, row] of this.errors) {
      const seen = s.errors.get(key) ?? 0;
      if (row.count > seen) errors.set(key, seen === 0 ? row : { ...row, count: row.count - seen, firstTs: row.lastTs });
    }
    this.errors = errors;
    const requests = new Map<string, WakeRequestRow>();
    for (const [key, row] of this.requests) {
      const seen = s.requests.get(key) ?? 0;
      if (row.count > seen) requests.set(key, { ...row, count: row.count - seen });
    }
    this.requests = requests;
    const hints = new Map<string, ActionHintNote>();
    for (const [key, h] of this.hints) {
      const seen = s.hints.get(key) ?? 0;
      if (h.count > seen) hints.set(key, { ...h, count: h.count - seen });
    }
    this.hints = hints;
    this.milestones = this.milestones.slice(s.milestones);
    this.loads = this.loads.slice(s.loads);
    this.host = this.host.slice(s.host);
    // The last line shown may have been printed again since: those prints carry over, as one entry.
    const tail = s.console > 0 ? this.console[s.console - 1] : undefined;
    const unseen = tail === undefined ? 0 : (tail.repeats ?? 1) - s.consoleTail;
    const rest = this.console.slice(s.console);
    this.console = tail !== undefined && unseen > 0 ? [{ ...tail, repeats: unseen }, ...rest] : rest;
    this.consoleLines = Math.max(0, this.consoleLines - s.consoleLines);
    this.ticks = 0;
    this.longestTickMs = 0;
    this.overruns = 0;
    this.shown = emptyShown();
  }

  /** When the sleeping model is due to wake, and why. */
  due(): { at: number; reasons: WakeKind[] } {
    const since = this.yieldedAt ?? 0;
    const pending = this.reasons.filter((r) => !r.shown);
    if (pending.length === 0) return { at: since + FALLBACK_WAKE_MS, reasons: ["fallback"] };
    const first = Math.min(...pending.map((r) => r.at));
    return { at: Math.max(first + WAKE_COALESCE_MS, since + MIN_SLEEP_MS), reasons: kindsOf(pending) };
  }

  /** A request just showed the model everything logged so far: none of it wakes it again, and the yield clears it. */
  markShown(): void {
    for (const r of this.reasons) r.shown = true;
    this.shown = {
      errors: new Map([...this.errors].map(([k, r]) => [k, r.count])),
      requests: new Map([...this.requests].map(([k, r]) => [k, r.count])),
      hints: new Map([...this.hints].map(([k, h]) => [k, h.count])),
      milestones: this.milestones.length,
      loads: this.loads.length,
      host: this.host.length,
      console: this.console.length,
      consoleTail: this.console[this.console.length - 1]?.repeats ?? 1,
      consoleLines: this.consoleLines,
    };
  }

  /** Everything counted since the last drain, for the trajectory; and reset. */
  drainLedger(): WakeLedger {
    const out = this.ledger;
    this.ledger = emptyLedger();
    return out;
  }

  /** The facts since the yield: the state delta counts deaths and turn-ins from them. */
  facts(): readonly ProgramMilestoneNote[] {
    return this.milestones;
  }

  /** The view `renderWake` draws, given what only the caller knows. */
  view(o: {
    wake: number;
    request: number;
    asleepMs: number | null;
    wokeFor: WakeKind[];
    program: WakeView["program"];
    delta: StateDelta | null;
    memory: string | null;
    memoryUnchanged?: boolean;
  }): WakeView {
    return {
      wake: o.wake,
      request: o.request,
      asleepMs: o.asleepMs,
      wokeFor: o.wokeFor,
      lastWakeCapped: this.capped,
      program: o.program,
      ticks: this.ticks,
      longestTickMs: this.longestTickMs,
      tickInFlight: this.tickInFlight === null ? null : { ...this.tickInFlight },
      overruns: this.overruns,
      loads: [...this.loads],
      host: [...this.host],
      errors: [...this.errors.values()],
      requests: [...this.requests.values()],
      delta: o.delta,
      hints: [...this.hints.values()],
      // Copies: the log goes on folding repeats into its entries, and a view is data.
      console: { lines: this.consoleLines, entries: this.console.map((e) => ({ ...e })) },
      memory: o.memory,
      memoryUnchanged: o.memoryUnchanged ?? false,
    };
  }
}

/**
 * What the trajectory records as each wake ends: every error signature and the
 * program's tick, overrun, halt and restart counts since the previous drain,
 * each occurrence exactly once — independent of what the block showed.
 */
export interface WakeLedger {
  errors: Map<string, { signature: string; hook: string; kind: ProgramErrorNote["kind"]; deploy: number | null; count: number }>;
  ticks: number;
  longestTickMs: number;
  overruns: number;
  halts: number;
  restarts: number;
}

/** What a rendered request showed, by position and count (`WakeLog.markShown`). */
interface Shown {
  errors: Map<string, number>;
  requests: Map<string, number>;
  hints: Map<string, number>;
  milestones: number;
  loads: number;
  host: number;
  console: number;
  /** The repeats of the last console entry shown: later prints of that line fold into it and are not yet seen. */
  consoleTail: number;
  consoleLines: number;
}

function emptyShown(): Shown {
  return { errors: new Map(), requests: new Map(), hints: new Map(), milestones: 0, loads: 0, host: 0, console: 0, consoleTail: 0, consoleLines: 0 };
}

function emptyLedger(): WakeLedger {
  return { errors: new Map(), ticks: 0, longestTickMs: 0, overruns: 0, halts: 0, restarts: 0 };
}

function kindsOf(reasons: readonly { kind: WakeKind }[]): WakeKind[] {
  const set = new Set(reasons.map((r) => r.kind));
  return KIND_ORDER.filter((k) => set.has(k));
}

// ----------------------------------------------------------------- sleep

export interface SleepOptions<T> {
  log: WakeLog;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  /** The stop signal: aborting it ends a sleep at once rather than at the next check. */
  signal?: AbortSignal | undefined;
  /** The stop request and the watchdogs; a non-null answer ends the sleep with it. */
  check: () => T | null;
  /** Bookkeeping on every check (restarts to count, for one). */
  onCheck?: () => void;
  checkMs?: number;
}

export type SleepOutcome<T> = { kind: "woke"; reasons: WakeKind[]; sleptMs: number } | { kind: "ended"; outcome: T };

/**
 * Sleep until the log says the model is due, checking the stop signal and the
 * watchdogs every `checkMs`. The state ticker and the program keep running
 * meanwhile; nothing here touches them.
 */
export async function sleepUntilWake<T>(o: SleepOptions<T>): Promise<SleepOutcome<T>> {
  // Slept since the yield, not since this call: the deploy at the yield comes
  // between the two, and the minimum sleep is counted from the yield.
  const started = o.log.asleepSince ?? o.now();
  const step = o.checkMs ?? SLEEP_CHECK_MS;
  for (;;) {
    o.onCheck?.();
    const ended = o.check();
    if (ended !== null) return { kind: "ended", outcome: ended };
    const due = o.log.due();
    const now = o.now();
    if (now >= due.at) return { kind: "woke", reasons: due.reasons, sleptMs: now - started };
    await raceAbort(o.sleep(Math.max(1, Math.min(step, due.at - now))), o.signal);
  }
}

function raceAbort(p: Promise<void>, signal: AbortSignal | undefined): Promise<void> {
  if (signal === undefined) return p;
  if (signal.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const done = (): void => {
      signal.removeEventListener("abort", done);
      resolve();
    };
    signal.addEventListener("abort", done, { once: true });
    p.then(done, done);
  });
}

// ----------------------------------------------------------------- delta

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function zoneName(s: SnapshotLike | null): string | undefined {
  const z = s?.self?.zone?.value as { name?: unknown } | undefined;
  return typeof z?.name === "string" && z.name.length > 0 ? z.name : undefined;
}

/**
 * What changed between the snapshot taken when the model ended its turn and
 * now, with the deaths and turn-ins the child saw happen. XP across a level-up
 * is counted only when the bar's size at the yield was observed; across two or
 * more it is left out rather than guessed.
 */
export function stateDelta(
  before: SnapshotLike | null,
  after: SnapshotLike | null,
  facts: readonly ProgramMilestoneNote[],
): StateDelta | null {
  if (before === null || after === null) return null;
  const l0 = num(before.self?.level?.value);
  const l1 = num(after.self?.level?.value);
  const x0 = num(before.xp?.value);
  const x1 = num(after.xp?.value);
  const next0 = num(before.nextLevelXp?.value);
  let xpGained: number | undefined;
  if (l0 !== undefined && l1 !== undefined && x0 !== undefined && x1 !== undefined) {
    if (l1 === l0) xpGained = x1 - x0;
    else if (l1 === l0 + 1 && next0 !== undefined) xpGained = next0 - x0 + x1;
  }
  const m0 = num(before.money?.value);
  const m1 = num(after.money?.value);
  return {
    levelFrom: l0,
    levelTo: l1,
    xpGained,
    moneyDelta: m0 !== undefined && m1 !== undefined ? m1 - m0 : undefined,
    quests: facts.filter((f) => f.fact === "quest" && typeof f.questId === "number").map((f) => f.questId as number),
    deaths: facts.filter((f) => f.fact === "death").length,
    zoneFrom: zoneName(before),
    zoneTo: zoneName(after),
  };
}

// ----------------------------------------------------------------- render

/** `HH:MM:SS`, UTC: the same instant renders the same bytes on every host. */
export function clock(ms: number): string {
  return new Date(ms).toISOString().slice(11, 19);
}

/** `4m05s`, `31.2s`, `2h03m`. */
export function duration(ms: number): string {
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const total = Math.floor(s);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const sec = total % 60;
  if (h > 0) return `${h}h${String(m).padStart(2, "0")}m`;
  return `${m}m${String(sec).padStart(2, "0")}s`;
}

/** Copper as the client writes it: `+1g 2s 12c`, `-5c`. */
export function money(copper: number): string {
  const sign = copper < 0 ? "-" : "+";
  let c = Math.abs(copper);
  const g = Math.floor(c / 10_000);
  c -= g * 10_000;
  const s = Math.floor(c / 100);
  c -= s * 100;
  const parts = [...(g > 0 ? [`${g}g`] : []), ...(s > 0 ? [`${s}s`] : []), ...(c > 0 || (g === 0 && s === 0) ? [`${c}c`] : [])];
  return `${sign}${parts.join(" ")}`;
}

const count = (n: number): string => n.toLocaleString("en-US");

function programLine(v: WakeView): string {
  const p = v.program;
  // Ticks finished since the yield, the longest only when one did, and the one still running, which they do not count.
  const done = `${count(v.ticks)} tick${v.ticks === 1 ? "" : "s"} since you ended your turn${v.ticks > 0 ? `, longest ${duration(v.longestTickMs)}` : ""}`;
  const running = v.tickInFlight === null ? "" : `, tick ${count(v.tickInFlight.tick)} running for ${duration(v.tickInFlight.runningMs)}`;
  const stats = `${done}${running}, ${count(v.overruns)} overrun${v.overruns === 1 ? "" : "s"}`;
  const failed = p.failedDeploy ?? null;
  // Edits a save already tried and failed to load are not tried again at the yield; any others are.
  const edits = !p.editsSinceDeploy
    ? "no edits since deploy"
    : failed !== null
      ? `edits since deploy: yes, they failed to load as deploy ${failed}`
      : "edits since deploy: yes, they load when you end your turn";
  switch (p.state) {
    case "none":
      if (!p.mainExists) return "program: none · write main.ts; it loads when you save it";
      return failed !== null
        ? `program: none running · main.ts failed to load as deploy ${failed}; it loads when you save a change to it`
        : "program: none running · main.ts loads when you end your turn";
    case "running":
      return `program: main.ts deploy ${p.deploy ?? "?"} (${p.deployedAt === undefined ? "?" : clock(p.deployedAt)}), running · ${stats} · ${edits}`;
    case "halted":
      return `program: main.ts deploy ${p.deploy ?? "?"}, halted (it blocked the event loop) · loads again when you save a change to it or end your turn`;
    case "stopped":
      return `program: main.ts deploy ${p.deploy ?? "?"}, stopped by a sandbox restart · loads again when you save a change to it or end your turn`;
  }
}

function errorLines(e: WakeErrorRow): string[] {
  const [head, ...frames] = e.text.split("\n");
  const when = e.count > 1 ? `×${count(e.count)} (first ${clock(e.firstTs)}, last ${clock(e.lastTs)})` : `(at ${clock(e.firstTs)})`;
  const prefix = head !== undefined && head.startsWith(e.hook) ? "" : `${e.hook} `;
  return [`- ${prefix}${head ?? e.signature} ${when}`, ...frames.filter((f) => f.trim().length > 0).map((f) => `    ${f.trim()}`)];
}

/** A heading and its rows, most recent occurrence first, so the cap never hides the newest signature. */
function errorBlock(heading: string, rows: readonly WakeErrorRow[]): string[] {
  if (rows.length === 0) return [];
  const lines = [heading];
  const newest = [...rows].sort((a, b) => b.lastTs - a.lastTs || a.signature.localeCompare(b.signature));
  for (const e of newest.slice(0, WAKE_ERRORS_SHOWN)) lines.push(...errorLines(e));
  if (rows.length > WAKE_ERRORS_SHOWN) lines.push(`- +${rows.length - WAKE_ERRORS_SHOWN} more signatures`);
  return lines;
}

function deltaLine(d: StateDelta): string {
  const parts: string[] = [];
  if (d.levelTo !== undefined) {
    parts.push(d.levelFrom !== undefined && d.levelFrom !== d.levelTo ? `level ${d.levelFrom} → ${d.levelTo}` : `level ${d.levelTo}`);
  }
  if (d.xpGained !== undefined) parts.push(`xp ${d.xpGained >= 0 ? "+" : ""}${count(d.xpGained)}`);
  if (d.moneyDelta !== undefined) parts.push(`money ${money(d.moneyDelta)}`);
  parts.push(`quests turned in ${d.quests.length}${d.quests.length > 0 ? ` (${d.quests.map((q) => `#${q}`).join(", ")})` : ""}`);
  parts.push(`deaths ${d.deaths}`);
  if (d.zoneTo !== undefined) {
    parts.push(d.zoneFrom === undefined || d.zoneFrom === d.zoneTo ? "zone unchanged" : `zone ${d.zoneFrom} → ${d.zoneTo}`);
  }
  return `since you ended your turn: ${parts.join(" · ")}`;
}

function consoleBlock(c: WakeView["console"]): string[] {
  if (c.lines === 0 && c.entries.length === 0) return [];
  let shown = c.entries.slice(-WAKE_CONSOLE_LINES).map((e) => {
    const text = e.repeats !== undefined && e.repeats > 1 ? `${e.text} ×${e.repeats}` : e.text;
    return e.level === "log" || e.level === "info" ? text : `[${e.level}] ${text}`;
  });
  while (shown.length > 1 && shown.join("\n").length > WAKE_CONSOLE_CHARS) shown = shown.slice(1);
  if (shown.length === 1 && shown[0]!.length > WAKE_CONSOLE_CHARS) shown = [`${shown[0]!.slice(0, WAKE_CONSOLE_CHARS - 1)}…`];
  return [`[program console: ${count(c.lines)} line${c.lines === 1 ? "" : "s"}, last ${shown.length} shown, repeats folded]`, ...shown];
}

/**
 * memory.json: whole up to `WAKE_MEMORY_CHARS`, otherwise its last that many
 * characters — a program appends, so the newest entries are at the end — and
 * one line when it is what the previous request of this wake showed.
 */
function memoryBlock(memory: string | null, unchanged: boolean): string[] {
  if (memory === null) return [];
  if (unchanged) return [`[memory.json unchanged, ${count(memory.length)} chars]`];
  const head = `[memory.json, ${count(memory.length)} chars]`;
  if (memory.length <= WAKE_MEMORY_CHARS) return [head, memory];
  return [head, `… (${count(memory.length - WAKE_MEMORY_CHARS)} chars before)`, memory.slice(-WAKE_MEMORY_CHARS)];
}

/**
 * A deploy a save made, as the lines the save's tool result ends with: the
 * [wake] block's wording for a deploy, with the version and what the program
 * exports, so the model learns from the save itself whether its change is
 * running. `state` is the program after the deploy. Pure.
 */
export function renderSaveDeploy(rec: DeployRecord, at: number, state: ProgramState): string {
  if (rec.action === "unload") return `deploy ${rec.deploy} unloaded (${clock(at)}): main.ts is gone, so no program runs`;
  const when = `(${clock(at)}, version ${rec.version})`;
  if (!rec.ok) {
    const keeps = state.kind === "running" ? `deploy ${state.deploy} keeps running` : "no program is running";
    return [`deploy ${rec.deploy} failed to load ${when}; ${keeps}:`, ...(rec.error ?? "").split("\n").map((t) => `    ${t.trim()}`)].join("\n");
  }
  const exports = rec.exports !== undefined && rec.exports.length > 0 ? rec.exports.join(", ") : "an on with no handlers";
  const w = rec.warnings ?? [];
  const head = `deploy ${rec.deploy} loaded ${when} and runs now; exports ${exports}`;
  return w.length === 0 ? head : [`${head}; ${w.length} warning${w.length === 1 ? "" : "s"}:`, ...w.map((t) => `    ${t}`)].join("\n");
}

/**
 * The `[wake]` block. Pure: every input is in the view, times render in UTC,
 * and numbers render with a fixed locale, so a replay produces the same bytes.
 */
export function renderWake(v: WakeView): string {
  // The cap is stated on every request, so a model can plan the end of its turn rather than meet it.
  const head = [`wake ${v.wake}`, `request ${v.request} of ${WAKE_MAX_REQUESTS} in this wake`];
  if (v.asleepMs !== null) head.push(`asleep ${duration(v.asleepMs)}`);
  head.push(`woke for: ${v.wokeFor.join(", ")}`);
  const lines = [`[${head.join(" · ")}]`];
  if (v.lastWakeCapped) {
    lines.push(`(your last wake ended at the ${WAKE_MAX_REQUESTS}-request cap, not by a reply; end a turn by replying without a tool call)`);
  }
  lines.push(programLine(v));
  for (const l of v.loads) {
    if (l.action === "unload") lines.push(`deploy ${l.deploy} unloaded (${clock(l.at)}): main.ts is gone, so no program runs`);
    else if (l.ok) {
      const w = l.warnings ?? [];
      if (w.length === 0) continue;
      lines.push(`deploy ${l.deploy} loaded (${clock(l.at)}) with ${w.length} warning${w.length === 1 ? "" : "s"}:`);
      for (const t of w) lines.push(`    ${t}`);
    } else {
      const keeps = v.program.state === "running" ? `deploy ${v.program.deploy ?? "?"} keeps running` : "no program is running";
      lines.push(`deploy ${l.deploy} failed to load (${clock(l.at)}); ${keeps}:`);
      for (const t of (l.error ?? "").split("\n")) lines.push(`    ${t.trim()}`);
    }
  }
  for (const h of v.host) lines.push(`${h.kind} ${clock(h.at)}: ${h.detail}`);
  // What wakes the model, and apart from it the ok:false answers, which never do.
  lines.push(...errorBlock("errors:", v.errors.filter((e) => e.kind !== "outcome")));
  lines.push(...errorBlock("outcomes:", v.errors.filter((e) => e.kind === "outcome")));
  if (v.requests.length > 0) {
    lines.push(`requested: ${v.requests.map((r) => `${JSON.stringify(r.reason)} ×${count(r.count)} (${r.from})`).join("; ")}`);
  }
  if (v.delta !== null) lines.push(deltaLine(v.delta));
  if (v.hints.length > 0) {
    const shown = [...v.hints].sort((a, b) => b.ts - a.ts || a.status.localeCompare(b.status)).slice(0, WAKE_HINTS_SHOWN);
    for (const h of shown) {
      const hint = h.hint.length > WAKE_HINT_CHARS ? `${h.hint.slice(0, WAKE_HINT_CHARS - 1).trimEnd()}…` : h.hint;
      lines.push(`action hint: ${h.action} ${h.status}${h.count > 1 ? ` ×${h.count}` : ""} — ${hint}`);
    }
    if (v.hints.length > shown.length) lines.push(`(+${v.hints.length - shown.length} other failure statuses)`);
  }
  lines.push(...consoleBlock(v.console));
  lines.push(...memoryBlock(v.memory, v.memoryUnchanged));
  return lines.join("\n");
}
