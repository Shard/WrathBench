/**
 * Sleeping and waking on the program loop (`loop: "program"`; operator,
 * 2026-11-12, adopted 2026-11-14).
 *
 * On the program loop the model's routines run in the sandbox whether it is
 * awake or not (the stack's `ProgramHost`), so a reply with no tool call puts
 * the model to sleep instead of re-prompting it after the step interval, and
 * on a `yield` arm the `yield` tool sleeps the same way inside a turn. A sleep
 * ends on the first wake reason, a window after it so that what lands
 * together is one wake, never sooner than the step interval, and after five
 * minutes at the latest. The window is two seconds (a restart and the ends
 * it caused), and ten for a death or a refusal (`WAKE_SETTLE_MS`, operator,
 * 2026-11-18), so a wipe's deaths and the refusals they bring reach the model
 * as one wake; a reason with a shorter window that lands inside a settle
 * wakes at its own and carries what is pending. A `wake(reason)` call, the
 * model's own timer, keeps its two seconds, and the cap (or a `yield`'s own
 * seconds) is never moved. Each window counts from when the sleep learned of
 * the reason, so a death row that reaches the runner late still settles.
 *
 * The wake set is fixed by the harness and the same for every model:
 *
 *  - from the program (`ProgramFact`, the stack's): a routine ending, the
 *    first error of each signature since the last load, the first refusal of
 *    each character, action and status in the run whatever routine made it
 *    (`Waker`), a `wake(reason)` call, and a sandbox restart the program came
 *    back from. What the stack does not count as a refusal never arrives
 *    as one: a move the code itself replaced or stopped, a note on a move
 *    that went ahead, and a call the character's death refused or cut short
 *    (operator, 2026-11-18);
 *  - from the runner: a death (the session record's `death` row), the event
 *    stream closing (the state sample), a harness notice, and a routine
 *    running hot: more than `HOT_PER_MINUTE` refusals and errors in a minute
 *    while the model sleeps, once per start of that routine (`HotMeter`,
 *    operator, 2026-11-20). Its reason names the routine, the count and the
 *    signature most of them were.
 *
 * At fan-out (one agent driving several characters) the program is one and
 * its routines are per character: every line names the character, a
 * refusal's the character whose client was refused (the fact's `seat`),
 * any character's death wakes, and so does any one's stream closing. What
 * changed over a sleep names only the characters whose level moved, the
 * stack's roll-up rule of one line per exception rather than per character.
 *
 * A pre-emption, a load and a save's own result never wake: the first is
 * reported in the next wake, the others are the model's own tool results.
 * Gaining a level or completing a quest never wakes either; the next wake
 * reports it. Nothing here holds, backs off or stops the model's code.
 *
 * What a wake shows is facts only (`renderWake`, pure): why it woke, every
 * routine as it stands, new errors with the lines of the model's files,
 * refusals with their hints unchanged (each signature in its newest
 * occurrence's words, not its first's), moves that replaced one another,
 * `wake` calls, what changed for the character, and the routines' last
 * console lines. No advice and no judgement of stalls: "last action 3s ago"
 * and "no routine is running" are the two stall facts. Deaths and quests
 * count from the previous block, so a death in the awake turn before a sleep
 * is counted by the wake its reason brings; and a death's cause is taken
 * from the child as its row lands, so a sandbox restart before the wake does
 * not lose it.
 *
 * Two lines are on the failure path only (operator delegated, 2026-11-15),
 * so a character that never dies and keeps its gear sees neither. A wake that
 * carries a death says what landed the last hit and the damage taken in the
 * ten seconds before it (`deathLine`, in the snippet delta's words). And a
 * `yield`'s block, which no HUD follows on a CLI driver, says when the
 * character is dead or a ghost and for how long, and the HUD's own
 * durability line when worn gear is broken or low (`conditionLines`); where
 * a fresh HUD rides with the block (a turn's message, any fixed-loop
 * request) it would say it twice, so it is left out there. At fan-out both
 * are per character, each line naming it (operator, 2026-11-18): a death
 * line for every character that died since the last wake, from its own
 * seat's latch (`fanoutDeathLines`), and the characters dead or a ghost
 * where no HUD follows, and each one's durability line on every block,
 * since the fan-out roll-up says who is dead but nothing of gear
 * (`fanoutConditionLines`).
 *
 * A worn item crossing into low or broken is reported at the next wake, one
 * entry per item and character, the level and the reading (`wornCrossings`,
 * operator, 2026-11-18), against what the last wake reported, so a crossing
 * while the model was awake is not lost. It never wakes by itself, as a
 * level or a quest does not. The thresholds are the HUD durability line's
 * (`durabilityLevel`).
 *
 * A routine row that ended more than five minutes ago and that a kept block
 * or a routine tool already showed ended is left out of the routine lines,
 * counted on one line (`ROUTINE_ROW_STALE_MS`, operator, 2026-11-18): an idle
 * run's wakes otherwise repeat hours-old ends whose value they refer back to.
 *
 * Every sleep writes one `wake` record (`via`, `turn`, `fired`, `sleptMs`,
 * `maxMs`), every fact a `deploy`, `routine` or `program_error` record as it
 * happens, and every wake the repeats it counted, so `bun wb inspect requests`
 * measures wakes per hour, requests per wake and the share of the run asleep
 * from the trajectory alone.
 */

import { renderRoutines, routineDetailKey, routinesInView, type ActionHintNote, type MoveOwner, type ProgramFact, type ProgramFacts, type ProgramLogLine, type ProgramRepeat, type RepeatNewest, type RoutineRow } from "@wrathbench/mcp";
import { corpseHostiles, durabilityLine, PLAYER_FLAGS_GHOST, renderNotices, wornReadings, type DurabilityLevel, type SnapshotLike } from "./context";
import type { HarnessNotice } from "./sandbox/host";
import { damageTaken, DEATH_WINDOW_MS, type DeathCause } from "./sandbox/snippet-delta";

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
/**
 * The window a death or a refusal opens (operator, 2026-11-18): a wipe's
 * deaths, and the refusals that fall in it, are one wake. A constant, not a knob.
 */
export const WAKE_SETTLE_MS = 10_000;
/** The reasons that open the settle window rather than the two-second one. */
const SETTLE_KEYS: ReadonlySet<WakeKey> = new Set<WakeKey>(["died", "refusal"]);
/**
 * How long ago a routine must have ended for its row, once shown, to be left
 * out of a wake's routine lines (operator, 2026-11-18). A constant, not a knob.
 */
export const ROUTINE_ROW_STALE_MS = 300_000;
/** Durability crossings named in one wake; past it they are counted. */
const WAKE_WORN_SHOWN = 8;
/** A fan-out death line's longest, in characters: five of them stay readable. */
const FANOUT_DEATH_LINE_CHARS = 200;
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
/** Refusal signatures a `Waker` remembers as told, by character, action and status; past it the oldest is forgotten. */
const KNOWN_SIGNATURES_KEPT = 5_000;
/** Characters a grouped refusal line names before it counts the rest, as the stack's hint lines do. */
const WAKE_SEATS_SHOWN = 4;
/** Wake reasons named in a wake's header; past it they are counted. */
const WAKE_REASONS_SHOWN = 4;
/** Workspace frames shown under an error. */
const ERROR_FRAMES_SHOWN = 3;

/** What can wake a sleeping model. */
export type WakeKey = "routine_ended" | "error" | "refusal" | "running_hot" | "wake" | "died" | "stream_closed" | "sandbox_restart" | "notice";
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
  /**
   * The routine a `wake(reason)` came from, when a routine called it; for a
   * routine's end, the run that ended, by its start (`routinesShown`).
   */
  routine?: { name: string; character?: string | undefined; startedAt?: number | undefined } | undefined;
  /** At fan-out, the character a death or a closed stream is one of. */
  character?: string | undefined;
}

/**
 * The part of a refusal signature (`routine|character|action|status`) a
 * refusal is told once per run by: the character, the action and the status.
 * The routine is left out, so the same refusal from a routine started under
 * a new name is not news again.
 */
export function refusalPairOf(signature: string): string {
  const at = signature.indexOf("|");
  return at < 0 ? signature : signature.slice(at + 1);
}

/** A routine's name and character as one key. */
const runKey = (name: string, character: string | undefined): string => (character === undefined ? name : `${name}\u0000${character}`);

/**
 * Whether routine lines that showed `shown` told the model a run started at
 * `startedAt` is over: they showed that run ended, or a newer run of its name.
 */
const shownOver = (shown: Pick<RoutineRow, "startedAt" | "state"> | undefined, startedAt: number | undefined): boolean =>
  shown !== undefined && startedAt !== undefined && (shown.startedAt > startedAt || (shown.startedAt === startedAt && shown.state !== "running"));

/** At fan-out, the character a refusal's client belongs to, as the stack's hint lines name it: ` [Alfa]`. */
const seatTag = (seat: string | undefined): string => (seat === undefined ? "" : ` [${seat}]`);

/** The key a reason's "shown up to" moment is kept under: its key, and at fan-out its character. */
const seenKey = (key: WakeKey, character: string | undefined): string => (character === undefined ? key : `${key}\u0000${character}`);

const label = (o: object): string => {
  const r = o as { name?: string | undefined; routine?: string | undefined; character?: string | undefined };
  const name = r.name ?? r.routine ?? "your program";
  return r.character === undefined ? name : `${name} (${r.character})`;
};

/** The reason a program fact wakes the model for, or null for one that does not. Pure. */
export function wakeReasonOf(fact: ProgramFact): WakeReason | null {
  switch (fact.kind) {
    case "ended":
      return {
        key: "routine_ended",
        ts: fact.ts,
        text: `routine ended (${label(fact.routine)}, ${fact.routine.state})`,
        inContext: false,
        routine: { name: fact.routine.name, ...(fact.routine.character !== undefined ? { character: fact.routine.character } : {}), startedAt: fact.routine.startedAt },
      };
    case "error":
      return { key: "error", ts: fact.ts, text: `new error (${label(fact)}: ${fact.error.name})`, inContext: false };
    case "refusal":
      return {
        key: "refusal",
        ts: fact.ts,
        text: `new refusal (${label(fact)}: ${fact.action} ${fact.status}${seatTag(fact.seat)})`,
        inContext: false,
        signature: fact.signature,
      };
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
  /** Per key (and character, `seenKey`), the newest moment the model has been shown its reasons up to (`forget`). */
  private readonly seenUntil = new Map<string, number>();
  /**
   * Refusals the model has been told of this run, by character, action and
   * status (`refusalPairOf`): one that woke it, or was pending when it woke,
   * and one whose hint a tool result carried (`deliver`). A refusal wakes
   * once per run, not once per load and not once per routine name: an edit
   * reloads the program, a model that starts a routine per task names a new
   * one every few minutes, and a combat routine's ordinary refusals
   * (`not_ready`, `out_of_range`) would otherwise each wake it again. Later
   * ones still show, counted, in the next wake. A resumed process starts a
   * new conversation, and this with it.
   */
  private readonly known = new Set<string>();

  note(reason: WakeReason): void {
    // A reason from before the model was shown its key's news is not news, however late its fact arrives.
    if (reason.ts <= (this.seenUntil.get(reason.key) ?? -Infinity)) return;
    if (reason.character !== undefined && reason.ts <= (this.seenUntil.get(seenKey(reason.key, reason.character)) ?? -Infinity)) return;
    // Nor a refusal of a signature the model was already told of this run, however late its fact arrives.
    if (reason.signature !== undefined) {
      const pair = refusalPairOf(reason.signature);
      if (this.known.has(pair)) return;
      this.remember(pair);
    }
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

  /** Drop the reasons of `key` from at or before `ts`, pending or still to arrive; with `character`, only that character's. */
  forget(key: WakeKey, ts: number, character?: string): void {
    const k = seenKey(key, character);
    this.seenUntil.set(k, Math.max(ts, this.seenUntil.get(k) ?? -Infinity));
    this.pending = this.pending.filter((r) => r.key !== key || r.ts > ts || (character !== undefined && r.character !== character));
  }

  /** Drop the pending reasons `drop` picks. */
  forgetWhere(drop: (r: WakeReason) => boolean): void {
    this.pending = this.pending.filter((r) => !drop(r));
  }

  /** A tool result carried the hint of this refusal signature: it is no reason to wake, now or when its fact lands, for the rest of the run. */
  deliver(signature: string): void {
    const pair = refusalPairOf(signature);
    this.remember(pair);
    this.pending = this.pending.filter((r) => r.signature === undefined || refusalPairOf(r.signature) !== pair);
  }

  /** Keep a refusal (`refusalPairOf`) as told; past the cap the oldest is forgotten, so a program minting signatures cannot grow this without bound. */
  private remember(pair: string): void {
    this.known.add(pair);
    if (this.known.size > KNOWN_SIGNATURES_KEPT) this.known.delete(this.known.values().next().value as string);
  }

  /** The reasons a wake reports, cleared. */
  take(): WakeReason[] {
    return this.pending.splice(0, this.pending.length);
  }
}

/**
 * A routine's refusals and errors in a minute past which it is running hot
 * (operator, 2026-11-20): one a second, held for a minute. A call a routine
 * awaits takes longer than that when it does anything (a cast's global
 * cooldown, a walk), so past it the routine is retrying without waiting.
 * Over five runs' repeat counts the busiest healthy routine, a combat
 * rotation hitting cooldowns, ran at about 7 a minute; routines that kept
 * retrying failing moves ran at 40 to 106; the spinners at 300 to 2,000. A
 * constant, not a knob.
 */
export const HOT_PER_MINUTE = 60;
/** The window `HOT_PER_MINUTE` counts over. */
const HOT_WINDOW_MS = 60_000;
/** How often a sleep drains the program to measure it: the stack's beat, which is when its repeat counts arrive. */
export const HOT_DRAIN_MS = 5_000;
/** Routine runs remembered as told hot; past it the oldest is forgotten. */
const HOT_TOLD_KEPT = 2_000;

/**
 * The routine a signature is of, with the character a refusal names, or
 * null for one that is no routine's: an error outside every routine
 * (`|TypeError|…`) or the program's memory (`memory|save`).
 */
function routineOfSignature(signature: string): { name: string; character: string } | null {
  const parts = signature.split("|");
  if (parts.length < 3 || parts[0] === "") return null;
  const refusal = refusalOfSignature(signature);
  return { name: parts[0]!, character: "action" in refusal ? parts.slice(1, -2).join("|") : "" };
}

/** A signature as a hot wake names it: a refusal's action and status, an error's name and place. */
function signatureWords(signature: string): string {
  const refusal = refusalOfSignature(signature);
  if ("action" in refusal) return `${refusal.action} ${refusal.status}`;
  const [, name, where] = signature.split("|");
  return where !== undefined && where !== "" ? `${name} at ${where}` : (name ?? signature);
}

/**
 * Each routine's refusals and errors over the last minute, from the repeat
 * counts a sleep drains: a routine run past `HOT_PER_MINUTE` is one wake
 * reason, once per start of that routine (a new start, a restart, re-arms
 * it), so it cannot flap. Counts only what the sleep drained itself: the
 * drain as a sleep starts covers the awake span before it, whose length is
 * not a minute's.
 */
export class HotMeter {
  /** By routine and character: the counts drained in the window, each at its drain, by signature. */
  private readonly window = new Map<string, { at: number; signature: string; n: number }[]>();
  /** Routine runs already told hot, by routine, character and start. */
  private readonly told = new Set<string>();

  /** Count a drain's repeats at `now`; the reason for each routine run that just passed the bar. */
  count(repeats: ProgramFacts["repeats"], routines: readonly RoutineRow[], now: number): WakeReason[] {
    const touched = new Set<string>();
    for (const r of repeats) {
      const who = routineOfSignature(r.signature);
      if (who === null || r.count <= 0) continue;
      const key = runKey(who.name, who.character === "" ? undefined : who.character);
      const list = this.window.get(key) ?? [];
      list.push({ at: now, signature: r.signature, n: r.count });
      this.window.set(key, list);
      touched.add(key);
    }
    const out: WakeReason[] = [];
    for (const [key, list] of this.window) {
      while (list.length > 0 && list[0]!.at <= now - HOT_WINDOW_MS) list.shift();
      if (list.length === 0) {
        this.window.delete(key);
        continue;
      }
      if (!touched.has(key)) continue;
      const total = list.reduce((n, x) => n + x.n, 0);
      if (total <= HOT_PER_MINUTE) continue;
      const [name, character] = key.split("\u0000") as [string, string | undefined];
      // The run: the routine's row by name, and by character where the row has one.
      const row = routines.find((x) => x.name === name && (x.character === undefined || character === undefined || x.character === character));
      const run = `${key}\u0000${row?.startedAt ?? ""}`;
      if (this.told.has(run)) continue;
      this.told.add(run);
      if (this.told.size > HOT_TOLD_KEPT) this.told.delete(this.told.values().next().value as string);
      const bySig = new Map<string, number>();
      for (const x of list) bySig.set(x.signature, (bySig.get(x.signature) ?? 0) + x.n);
      const [top, topN] = [...bySig].sort((a, b) => b[1] - a[1])[0]!;
      const who = character === undefined || character === "" ? name : `${name} (${character})`;
      out.push({
        key: "running_hot",
        ts: now,
        text: `routine running hot (${who}: ${total.toLocaleString("en-US")} refusals and errors in the last minute, ${topN.toLocaleString("en-US")} of them ${signatureWords(top)})`,
        inContext: false,
      });
    }
    return out;
  }
}

export interface SleepOptions {
  waker: Waker;
  /** The longest this sleep lasts: `WAKE_CAP_MS`, or a `yield`'s own seconds. */
  capMs: number;
  /** The floor: the step interval, slept whatever happens (capped by `capMs`). */
  floorMs: number;
  coalesceMs?: number;
  /** The window a death or a refusal opens: `WAKE_SETTLE_MS` unless a test says. */
  settleMs?: number;
  tickMs?: number;
  /** True once the run is ending: a stop request or a watchdog verdict. */
  stopped: () => boolean;
  /** A notice queued for the next message that no notice hook saw (the driver's own). */
  queuedNotices?: () => number;
  /** Called on every tick before the reasons are read: where a sleep looks at the program meanwhile (`ProgramWake`'s hot meter). */
  onTick?: (now: number) => void;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

export interface SleepResult {
  fired: WakeFired;
  sleptMs: number;
}

/**
 * Sleep until a wake reason has been pending for its window, the run stops
 * or the cap passes. Each pending reason's window (`WAKE_SETTLE_MS` for a
 * death or a refusal, else the coalescing window) counts from when this
 * sleep first saw it, and the sleep ends at the earliest of them, so a
 * reason with a two-second window that lands inside a death's ten seconds
 * wakes at its own, carrying the death. A reason already pending when the
 * sleep starts counts from the start, and wakes it once the floor is slept.
 * Reads the waker and never clears it: what woke the model is the wake's to
 * take (`ProgramWake.sleep`).
 */
export async function sleepUntilWake(o: SleepOptions): Promise<SleepResult> {
  const start = o.now();
  const cap = Math.max(0, o.capMs);
  const floor = Math.min(Math.max(0, o.floorMs), cap);
  const coalesce = o.coalesceMs ?? WAKE_COALESCE_MS;
  const settle = Math.max(coalesce, o.settleMs ?? WAKE_SETTLE_MS);
  const tick = o.tickMs ?? WAKE_TICK_MS;
  const slept = (): number => o.now() - start;
  /** When this sleep first saw each pending reason. */
  const seen = new Map<WakeReason, number>();
  for (;;) {
    if (o.stopped()) return { fired: "stopped", sleptMs: slept() };
    const now = o.now();
    o.onTick?.(now);
    // A driver's queued notice is its own reason, so it keeps its two seconds while a death settles.
    if ((o.queuedNotices?.() ?? 0) > 0 && !o.waker.peek().some((r) => r.key === "notice")) {
      o.waker.note({ key: "notice", ts: now, text: "a harness notice", inContext: true });
    }
    let due: { at: number; key: WakeKey } | undefined;
    for (const r of o.waker.peek()) {
      let from = seen.get(r);
      // Seen at the start (pending as it began) or within a tick of its note: a late fact's own ts would spend its window.
      if (from === undefined) seen.set(r, (from = now));
      const at = from + (SETTLE_KEYS.has(r.key) ? settle : coalesce);
      if (due === undefined || at < due.at) due = { at, key: r.key };
    }
    if (due !== undefined) {
      const at = Math.max(start + floor, due.at);
      if (now >= at) return { fired: due.key, sleptMs: slept() };
      if (now - start >= cap) return { fired: due.key, sleptMs: slept() };
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
  /** At fan-out: the characters whose level moved, by name. */
  levels?: readonly { character: string; from: number; to: number }[];
  /** XP gained at an unchanged level; absent across a level change or when unobserved. */
  xp?: number;
  quests: number;
  deaths: number;
}

/** Everything a wake block says, as data. */
export interface WakeView {
  /** The failure-path lines under what changed: the last death's cause, the character's condition (`deathLine`, `conditionLines`). */
  condition?: readonly string[] | undefined;
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
  /** Ended runs the model was shown ended (`endedRunKey`): once stale, their rows are left out (`ROUTINE_ROW_STALE_MS`). */
  endedShown?: ReadonlySet<string> | undefined;
  /** Worn items that crossed into low or broken since the last wake, as entries (`wornCrossings`). */
  worn?: readonly string[] | undefined;
}

/** An ended run as `ProgramWake` remembers it shown: name, character and start. */
export const endedRunKey = (r: Pick<RoutineRow, "name" | "character" | "startedAt">): string => `${r.name}\u0000${r.character ?? ""}\u0000${r.startedAt}`;

/**
 * The routine rows a wake lists: every row but those that ended more than
 * `ROUTINE_ROW_STALE_MS` ago and that the model was already shown ended (a
 * kept block or a routine tool showed the run's end, or the stack marked its
 * error or value shown). `dropped` counts what was left out. Pure.
 */
export function freshRoutines(rows: readonly RoutineRow[], now: number, shown: ReadonlySet<string> = new Set(), endedShown: ReadonlySet<string> = new Set()): { rows: RoutineRow[]; dropped: number } {
  const kept = rows.filter((r) => {
    if (r.state === "running" || r.endedAt === undefined || now - r.endedAt <= ROUTINE_ROW_STALE_MS) return true;
    const detail = routineDetailKey(r);
    return !(endedShown.has(endedRunKey(r)) || (detail !== undefined && shown.has(detail)));
  });
  return { rows: kept, dropped: rows.length - kept.length };
}

/** How an error or refusal signature reads in a wake. */
export interface SignatureLine {
  kind: "error" | "refusal";
  text: string;
  /** An error's workspace frames, innermost first. */
  frames: readonly string[];
  /**
   * At fan-out, a refusal's parts: `head` (routine, action, status), the
   * character whose client was refused and the hint. Lines alike in all but
   * the character are one line naming each, as the stack's hint lines are.
   */
  seat?: { head: string; character: string; hint: string } | undefined;
  /**
   * What the line says before the occurrence's own words: an error's routine,
   * a refusal's routine, action and status. A later occurrence of the
   * signature keeps it and says its own words after it (`withNewest`).
   */
  lead?: string | undefined;
}

/**
 * `line` as a later occurrence of its signature says it (the stack's
 * `ProgramRepeat.newest`): the same lead, the newest occurrence's words, and
 * for an error its frames. A line from before `lead` was kept is left as it
 * stood. Pure.
 */
export function withNewest(line: SignatureLine, newest: RepeatNewest): SignatureLine {
  if (line.lead === undefined) return line;
  if (line.kind === "error") return { ...line, text: `${line.lead} ${newest.text}`, frames: newest.frames ?? line.frames };
  return {
    ...line,
    text: `${line.lead} — ${newest.text}`,
    ...(line.seat !== undefined ? { seat: { ...line.seat, hint: newest.text } } : {}),
  };
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
    return { signature: fact.error.signature, line: { kind: "error", text: `${label(fact)} ${fact.error.text}`, frames: fact.error.frames, lead: label(fact) } };
  }
  if (fact.kind === "refusal") {
    const head = `${label(fact)} ${fact.action} ${fact.status}`;
    return {
      signature: fact.signature,
      line: { kind: "refusal", text: `${head} — ${fact.hint}`, frames: [], lead: head, ...(fact.seat !== undefined ? { seat: { head, character: fact.seat, hint: fact.hint } } : {}) },
    };
  }
  if (fact.kind === "ended" && fact.routine.state === "threw" && fact.routine.error !== undefined) {
    const e = fact.routine.error;
    return { signature: e.signature, line: { kind: "error", text: `${label(fact.routine)} ${e.text}`, frames: e.frames, lead: label(fact.routine) } };
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

  // Every routine as it stands, in the stack's own words, but for ends long past that the model was shown; and the stall fact.
  const fresh = freshRoutines(v.facts.routines, v.now, v.shown, v.endedShown);
  if (fresh.dropped === 0) lines.push(renderRoutines(v.facts.routines, v.now, v.shown));
  else if (fresh.rows.length > 0) lines.push(`${renderRoutines(fresh.rows, v.now, v.shown)}\nand ${fresh.dropped} that ended earlier, shown before`);
  else lines.push(`routines: ${fresh.dropped} that ended earlier, shown before`);
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
    const rows = groupSeats(shown.filter((x) => x.line.kind === kind));
    if (rows.length === 0) continue;
    lines.push(kind === "error" ? "errors:" : "refusals:");
    for (const x of rows.slice(0, WAKE_SIGNATURES_SHOWN)) {
      lines.push(`  ${x.text}${x.n > 1 ? ` ×${x.n}` : ""}`);
      for (const frame of x.frames.slice(0, ERROR_FRAMES_SHOWN)) lines.push(`      ${frame}`);
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
    for (const l of p.levels ?? []) if (l.from !== l.to) parts.push(`${l.character} level ${l.from} → ${l.to}`);
    parts.push(`quests completed ${p.quests}`, `deaths ${p.deaths}`);
    lines.push(`since you slept: ${parts.join(" · ")}`);
  }
  if (v.worn !== undefined && v.worn.length > 0) {
    const more = v.worn.length > WAKE_WORN_SHOWN ? `; and ${v.worn.length - WAKE_WORN_SHOWN} more` : "";
    lines.push(`worn down since you slept: ${v.worn.slice(0, WAKE_WORN_SHOWN).join("; ")}${more}`);
  }
  if (v.condition !== undefined) lines.push(...v.condition);

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
 * Signature rows as the block lists them, newest first. A fan-out refusal
 * row (one with `seat`) joins the first row alike in head and hint, which
 * names each character in brackets after the status, as the stack's hint
 * lines do (`party castSpell not_ready [Alfa, Bravo] — …`), counts summed.
 * Every other row is its own line, its text unchanged.
 */
function groupSeats(rows: readonly { n: number; line: SignatureLine }[]): { text: string; n: number; frames: readonly string[] }[] {
  const out: { text: string; n: number; frames: readonly string[]; names?: string[]; seat?: NonNullable<SignatureLine["seat"]> }[] = [];
  const byKey = new Map<string, (typeof out)[number]>();
  for (const x of rows) {
    const seat = x.line.seat;
    if (seat === undefined) {
      out.push({ text: x.line.text, n: x.n, frames: x.line.frames });
      continue;
    }
    const key = `${seat.head}\n${seat.hint}`;
    const g = byKey.get(key);
    if (g !== undefined) {
      g.n += x.n;
      if (!g.names!.includes(seat.character)) g.names!.push(seat.character);
      continue;
    }
    const row = { text: "", n: x.n, frames: [], names: [seat.character], seat };
    byKey.set(key, row);
    out.push(row);
  }
  return out.map((r) => {
    if (r.seat === undefined || r.names === undefined) return r;
    const names = r.names.slice(0, WAKE_SEATS_SHOWN).join(", ") + (r.names.length > WAKE_SEATS_SHOWN ? ` +${r.names.length - WAKE_SEATS_SHOWN}` : "");
    return { text: `${r.seat.head} [${names}] — ${r.seat.hint}`, n: r.n, frames: r.frames };
  });
}

/**
 * The console entries a wake shows, oldest first: the newest that fit in
 * `WAKE_CONSOLE_CHARS`, at most `WAKE_CONSOLE_SHOWN`. The newest entry is
 * always shown, cut to its head when it alone is over the cap.
 */
function consoleTail(lines: readonly ProgramLogLine[]): string[] {
  const entries = foldConsole(lines);
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

/**
 * The console with every repeat of a line as one entry, wherever it fell: the
 * stack folds only a line that repeats the one before it, and each beat starts
 * its log afresh, so one line printed on every pass of a loop comes as an
 * entry per beat. Alike is the stack's own test (routine, character, level,
 * text); the entry stands where the line last fell, counts summed, at its
 * newest time. Order and entries are otherwise as they came. Pure.
 */
export function foldConsole(lines: readonly ProgramLogLine[]): ProgramLogLine[] {
  const last = new Map<string, number>();
  const sums = new Map<string, { count: number; ts: number }>();
  const keyOf = (l: ProgramLogLine): string => JSON.stringify([l.routine, l.character ?? null, l.level, l.text]);
  lines.forEach((l, k) => {
    const key = keyOf(l);
    last.set(key, k);
    const s = sums.get(key);
    if (s === undefined) sums.set(key, { count: l.count, ts: l.ts });
    else {
      s.count += l.count;
      s.ts = Math.max(s.ts, l.ts);
    }
  });
  if (last.size === lines.length) return [...lines];
  return lines.flatMap((l, k) => {
    const key = keyOf(l);
    if (last.get(key) !== k) return [];
    return [{ ...l, ...sums.get(key)! }];
  });
}

function namedReasons(reasons: readonly WakeReason[]): string {
  const texts: string[] = [];
  // At fan-out, the characters that died are one reason, where the first of them stands: a wipe names every one.
  const died = [...new Set(reasons.flatMap((r) => (r.key === "died" && r.character !== undefined ? [r.character] : [])))];
  for (const r of reasons) {
    const text = died.length > 1 && r.key === "died" && r.character !== undefined ? `${died.join(", ")} died` : r.text;
    if (!texts.includes(text)) texts.push(text);
  }
  if (texts.length === 0) return "nothing";
  const shown = texts.slice(0, WAKE_REASONS_SHOWN).join("; ");
  return texts.length > WAKE_REASONS_SHOWN ? `${shown}; and ${texts.length - WAKE_REASONS_SHOWN} more` : shown;
}

/** Two drains as one span: facts in order, repeats summed by signature, the console's tail with repeats folded (`foldConsole`), the routines as they stand now. */
export function mergeFacts(a: ProgramFacts | null, b: ProgramFacts): ProgramFacts {
  if (a === null) return b;
  const repeats = new Map<string, ProgramRepeat>();
  for (const r of [...a.repeats, ...b.repeats]) {
    const prev = repeats.get(r.signature);
    if (prev === undefined) repeats.set(r.signature, { ...r });
    else {
      prev.count += r.count;
      // The newest occurrence is the later drain's.
      if (r.newest !== undefined && r.ts >= prev.ts) prev.newest = r.newest;
      prev.ts = Math.max(prev.ts, r.ts);
    }
  }
  const lines = foldConsole([...a.console.lines, ...b.console.lines]);
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
  self?:
    | {
        level?: { value?: unknown };
        /** The player frame's `{ current, max }`: zero is dead. */
        health?: { value?: unknown };
        /** Read for `playerFlags`, the ghost bit. */
        fields?: Record<string, { value?: unknown } | undefined>;
        /** A ghost's own position and its corpse's, for the hostiles round the corpse (`corpseHostiles`). */
        position?: { value?: unknown };
        corpse?: { value?: unknown };
      }
    | null
    | undefined;
  /** Worn and carried items, as the HUD's durability line reads them. */
  inventory?: SnapshotLike["inventory"];
  /** The objects in view, as the HUD's ghost line reads them for the hostiles round the corpse. */
  units?: SnapshotLike["units"];
  xp?: { value?: unknown } | null | undefined;
  observation?: { connected?: boolean } | undefined;
  /** A fan-out run's sample: each character's level, whether its stream is open, and whether it is dead or a ghost (the loop's digests). */
  seats?: readonly { character: string; level: number | null; connected: boolean; dead?: boolean | undefined; ghost?: boolean | undefined }[] | undefined;
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
   * Whether a fresh HUD rides with the block: a turn's message on every
   * driver, and on the fixed loop the request right after a `yield` result.
   * Only a block without one says the character's condition (`conditionLines`);
   * absent reads as without. At fan-out it holds back only who is dead or a
   * ghost, which the roll-up says: its durability lines show either way.
   */
  hud?: boolean | undefined;
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
  /** Each routine's refusals and errors over the last minute while asleep: running hot wakes, once per start. */
  private readonly hot = new HotMeter();
  /** The run's wakes so far, this process's and those before a resume. */
  private n: number;
  /** What the sleep-start drain took, carried into the next wake. */
  private held: ProgramFacts | null = null;
  /**
   * When the facts the next wake reports began to gather: the previous
   * wake's, or this process's start before its first. A wake's repeat
   * records cover from here to the wake (`since`, `at`).
   */
  private drainedAt: number;
  /** Every error and refusal signature seen this run, as its newest occurrence says it, and that occurrence's time. */
  private readonly signatures = new Map<string, SignatureLine>();
  private readonly signatureTs = new Map<string, number>();
  private lastSample: WakeSample | null = null;
  /** The session record's counts as the last wake block read them: what the next block's deaths and quests count from. */
  private countsShown: WakeCounts | null = null;
  private connected: boolean | undefined;
  /** At fan-out, whether each character's stream was open at the last sample. */
  private readonly connectedOf = new Map<string, boolean>();
  /** Each routine's row as a routine tool's answer last showed it, by name and character (`routinesShown`). */
  private readonly rowsShown = new Map<string, RoutineRow>();
  /** Restarts the program was blamed for: each counts toward `snippet-runaway` (`takeBlamedRestarts`). */
  private blamed = 0;
  /** The last death's time, of a single character (`onDeath`): how long it has been dead. */
  private lastDeathTs: number | undefined;
  /** At fan-out, each character's last death's time: how long it has been dead. */
  private readonly deathTsOf = new Map<string, number>();
  /** At fan-out, the characters that died since the last wake, by their last death's time: each gets a death line. */
  private diedSince = new Map<string, number>();
  /** The child's latched cause of the last death (`SandboxHost.deathCause`), at fan-out of a character's seat, once the sandbox exists (`useDeathCause`). */
  private deathCause: ((character?: string) => Promise<DeathCause | null>) | undefined;
  /** Causes taken from the latch as their death rows landed, by character ("" for a single one): kept across a sandbox restart (`keepCause`). */
  private readonly causeKept = new Map<string, DeathCause>();
  /** The latch read in flight per character, so the wake's own read waits for it. */
  private readonly causeReads = new Map<string, Promise<void>>();
  /** At fan-out, every seat's worn items (`SandboxHost.wornDurabilityAll`), once the sandbox exists (`useWorn`). */
  private wornRead: (() => Promise<Record<string, SnapshotLike["inventory"]>>) | undefined;
  /** Each worn item's level as the last wake reported it, by character ("" for a single one) and `slot:item`: what a crossing is measured from. */
  private readonly wornReported = new Map<string, Map<string, DurabilityLevel>>();
  /** Ended runs the model was shown ended, in a kept block or a routine tool's answer (`endedRunKey`). */
  private readonly endedShown = new Set<string>();
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
      /** The wakes the run had before this process (`Trajectory.wakeCount`): a resume's count continues from them. */
      wakesBefore?: number;
    },
  ) {
    this.n = o.wakesBefore ?? 0;
    this.now = o.now ?? Date.now;
    this.drainedAt = this.now();
    this.sleepFn = o.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  }

  /** `ProgramOptions.onFact`: record the fact, remember how its signature reads, and wake for it if it wakes. */
  readonly onFact = (fact: ProgramFact): void => {
    // Every occurrence that arrives as a fact is the signature's newest: a later wake names it as it last happened.
    const s = signatureLineOf(fact);
    if (s !== null) this.noteSignature(s.signature, s.line, fact.ts);
    if (fact.kind === "restart" && fact.blamed) this.blamed++;
    try {
      this.o.trajectory.append(factRecord(fact));
    } catch {
      // A record that could not be written must not cost the sandbox its IPC.
    }
    const reason = wakeReasonOf(fact);
    if (reason === null) return;
    // An end that lands after the routine lines that showed its run over is not news.
    if (reason.key === "routine_ended" && reason.routine !== undefined && shownOver(this.rowsShown.get(runKey(reason.routine.name, reason.routine.character)), reason.routine.startedAt)) return;
    this.waker.note(reason);
  };

  /**
   * Keep `line` as how `signature` reads, unless an occurrence newer than `ts`
   * already set it. Bounded: past a thousand signatures the least recently
   * seen is forgotten.
   */
  private noteSignature(signature: string, line: SignatureLine, ts: number): void {
    const was = this.signatureTs.get(signature);
    if (was !== undefined && ts < was) return;
    this.signatures.delete(signature);
    this.signatures.set(signature, line);
    this.signatureTs.set(signature, ts);
    if (this.signatures.size > 1_000) {
      const oldest = this.signatures.keys().next().value as string;
      this.signatures.delete(oldest);
      this.signatureTs.delete(oldest);
    }
  }

  /** The sandbox's `onNotice`, beside the trajectory's: a notice wakes. */
  onNotice(n: Pick<HarnessNotice, "kind" | "ts">): void {
    this.waker.note(
      n.kind === "sandbox_restarted"
        ? { key: "sandbox_restart", ts: n.ts, text: "sandbox restart", inContext: true }
        : { key: "notice", ts: n.ts, text: "a harness notice", inContext: true },
    );
  }

  /** Where a death wake reads what killed the character: the sandbox, made after this. At fan-out it is asked per character. */
  useDeathCause(read: (character?: string) => Promise<DeathCause | null>): void {
    this.deathCause = read;
  }

  /** Where a fan-out wake reads every character's worn items: the sandbox, made after this. */
  useWorn(read: () => Promise<Record<string, SnapshotLike["inventory"]>>): void {
    this.wornRead = read;
  }

  /** A `death` row of the session record: at fan-out, of `character`'s. */
  onDeath(ts: number, character?: string): void {
    if (character === undefined) this.lastDeathTs = Math.max(ts, this.lastDeathTs ?? -Infinity);
    else {
      this.deathTsOf.set(character, Math.max(ts, this.deathTsOf.get(character) ?? -Infinity));
      this.diedSince.set(character, Math.max(ts, this.diedSince.get(character) ?? -Infinity));
    }
    this.waker.note(
      character === undefined
        ? { key: "died", ts, text: "your character died", inContext: true }
        : { key: "died", ts, text: `${character} died`, inContext: true, character },
    );
    this.keepCause(character);
  }

  /**
   * Take the child's latched cause as a death row lands and keep it here, so
   * a sandbox restart between the death and its wake (the child and its
   * latch gone) does not cost the wake its death line. Reads for one
   * character queue behind each other; a read that finds nothing leaves the
   * wake's own read to find it.
   */
  private keepCause(character?: string): void {
    const read = this.deathCause;
    if (read === undefined) return;
    const key = character ?? "";
    const next = (this.causeReads.get(key) ?? Promise.resolve()).then(async () => {
      try {
        const cause = await read(character);
        if (cause !== null) this.causeKept.set(key, cause);
      } catch {
        // A latch that failed costs the kept cause only.
      }
    });
    this.causeReads.set(key, next);
  }

  /**
   * The newest cause of a death of `character` (a single character's with
   * none): the child's latch now, else the one kept as the death row landed.
   * Taken: a cause is one death line's.
   */
  private async takeCause(character?: string): Promise<DeathCause | null> {
    const key = character ?? "";
    await this.causeReads.get(key);
    try {
      const live = (await this.deathCause?.(character)) ?? null;
      if (live !== null) this.causeKept.set(key, live);
    } catch {
      // A latch that failed leaves the kept cause.
    }
    const cause = this.causeKept.get(key) ?? null;
    this.causeKept.delete(key);
    return cause;
  }

  /** Every state sample: the stream closing wakes, and the last reading is what progress is measured from. */
  onSample(snap: WakeSample): void {
    this.lastSample = snap;
    // A single character's first worn reading is what its first crossing is measured from (`wornCrossings`).
    if (snap.seats === undefined && !this.wornReported.has("")) {
      const first = wornReadings(snap.inventory);
      if (first.length > 0) this.wornReported.set("", new Map(first.map((w) => [`${w.slot}:${w.item}`, w.level] as const)));
    }
    if (snap.seats !== undefined) {
      // At fan-out each character's stream is its own: any one closing wakes, by name.
      for (const c of snap.seats) {
        if (!c.connected && this.connectedOf.get(c.character) === true) {
          this.waker.note({ key: "stream_closed", ts: this.now(), text: `${c.character}'s event stream closed`, inContext: true, character: c.character });
        }
        this.connectedOf.set(c.character, c.connected);
      }
      return;
    }
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
   * lines showed them). A run's end those lines showed is news the model
   * has, so it no longer wakes a sleep that starts after, nor does it when
   * its fact lands after them: the lines showed the run ended, or a newer
   * run of its name. An end the lines did not show (a routine that threw a
   * millisecond after the start that answered, its row still "running 0s")
   * still wakes. Nor does a `wake(reason)` from a run those lines show as
   * over: one that has ended, or that a newer run of the same name has
   * replaced. A still-running routine's call stays pending. Both are still
   * in the next wake's lines.
   */
  routinesShown(all: readonly RoutineRow[]): void {
    // What the lines showed: the older ended routines they count but do not show are not news the model has.
    const rows = routinesInView(all).rows;
    for (const r of rows) this.rowsShown.set(runKey(r.name, r.character), r);
    this.markEndedShown(rows);
    this.waker.forgetWhere((r) => {
      if (r.routine === undefined) return false;
      const run = rows.find((x) => x.name === r.routine!.name && x.character === r.routine!.character);
      if (r.key === "routine_ended") return shownOver(run, r.routine.startedAt);
      if (r.key !== "wake") return false;
      return run !== undefined && (run.state !== "running" || run.startedAt > r.ts);
    });
  }

  /**
   * A tool result is carrying these action hints (the stack's
   * `onHintsDelivered`, called as the result is built): a routine's refusal
   * whose hint it carries is delivered, by signature, and no longer wakes a
   * sleep, nor does its fact when it lands late, for the rest of the run
   * (at fan-out its signature names the client's character, as the stack's
   * fact does). A hint
   * whose status is `dead` tells the model its character is dead, so a death
   * from before it no longer wakes either. Both still show in the next wake.
   */
  hintsDelivered(hints: readonly ActionHintNote[]): void {
    for (const h of hints) {
      if (h.routine !== undefined) this.waker.deliver(`${h.routine}|${h.character ?? ""}|${h.action}|${h.status}`);
      if (h.status === "dead") this.waker.forget("died", h.ts, h.character);
    }
  }

  /**
   * A `yield`'s answer: its wake block, then every harness notice queued for
   * the next turn message, the driver's (`queued`, emptied here) and the
   * sandbox's (`drain`), in that message's `[harness notices]` form. A turn
   * message is the only other place a notice reaches the model, and on a
   * scaffold whose turn runs for hours between `yield`s that is hours late.
   * What it carries is taken from the queues, so the next message does not
   * repeat it, and a notice's reason no longer wakes a later sleep. Scrubbed
   * of the run's secrets, as the turn message is.
   */
  yieldAnswer(block: string, queued: HarnessNotice[], drain: () => HarnessNotice[]): string {
    const notices = [...queued.splice(0, queued.length), ...drain()];
    if (notices.length === 0) return block;
    const now = this.now();
    // The reasons a notice raised (`onNotice`, a queued notice in `sleepUntilWake`), never a program fact's.
    this.waker.forgetWhere((r) => r.inContext && (r.key === "notice" || r.key === "sandbox_restart") && r.ts <= now);
    return `${block}\n\n${this.o.trajectory.scrub(renderNotices(notices))}`;
  }

  /**
   * The cause of the death this wake carries, as the child latched it, or
   * nothing: a latch from another death than the record's last (a child
   * restarted between) is not this one's cause. Taken only by a death wake,
   * so a wake with none leaves it for the one the death row brings. The
   * cause kept as the death row landed stands in for a latch a sandbox
   * restart emptied (`keepCause`).
   */
  private async deathLines(): Promise<string[]> {
    if (this.deathCause === undefined) return [];
    const cause = await this.takeCause();
    if (cause === null) return [];
    if (this.lastDeathTs !== undefined && Math.abs(cause.ts - this.lastDeathTs) > DEATH_MATCH_MS) return [];
    const line = deathLine(cause);
    return line === undefined ? [] : [line];
  }

  /**
   * A death line for every character that died since the last wake, from its
   * seat's latch, oldest death first; a latch from another death than the
   * record's last for that character is not this one's cause. `diedSince`
   * is taken as the wake takes its reasons, so the next wake has only the
   * deaths after it. Fan-out only.
   */
  private async fanoutDeaths(diedSince: ReadonlyMap<string, number>): Promise<string[]> {
    const died = [...diedSince].sort((a, b) => a[1] - b[1]);
    if (died.length === 0) return [];
    const lines = await Promise.all(
      died.map(async ([character, ts]) => {
        // A latch that failed costs the cause only.
        const cause = await this.takeCause(character);
        return fanoutDeathLine(character, cause !== null && Math.abs(cause.ts - ts) <= DEATH_MATCH_MS ? cause : null);
      }),
    );
    return ["deaths:", ...lines.map((l) => `  ${l}`)];
  }

  /**
   * Every character's worn items now, by character ("" for a single one):
   * a fan-out run's from its seats (`useWorn`), a single character's from the
   * last state sample. Empty when there is no reading.
   */
  private async wornNow(): Promise<Map<string, SnapshotLike["inventory"]>> {
    if (this.lastSample?.seats !== undefined) {
      if (this.wornRead === undefined) return new Map();
      try {
        return new Map(Object.entries(await this.wornRead()));
      } catch {
        return new Map();
      }
    }
    const inv = this.lastSample?.inventory;
    return inv === undefined ? new Map() : new Map([["", inv]]);
  }

  /**
   * The worn items whose level is worse than the last wake reported it (ok
   * to low, ok or low to broken), as entries naming the character at
   * fan-out, the item, its level and reading; and that reading becomes the
   * one reported. An item first seen (the run's first reading, a resume, a
   * swap into its slot) is taken as it stands, silently, and a repair
   * re-arms it the same way. A character with no worn reading keeps the last.
   */
  private wornCrossings(worn: ReadonlyMap<string, SnapshotLike["inventory"]>): string[] {
    const out: string[] = [];
    for (const [character, inv] of worn) {
      const readings = wornReadings(inv);
      if (readings.length === 0) continue;
      const before = this.wornReported.get(character);
      const now = new Map<string, DurabilityLevel>();
      for (const w of readings) {
        const key = `${w.slot}:${w.item}`;
        now.set(key, w.level);
        const was = before?.get(key);
        if (was !== undefined && LEVEL_RANK[w.level] > LEVEL_RANK[was]) out.push(`${character === "" ? "" : `${character} `}${w.label} ${w.level} (${w.current}/${w.max})`);
      }
      this.wornReported.set(character, now);
    }
    return out;
  }

  /**
   * The conversation lost what it was shown (a CLI compaction, a new
   * session or thread, a trim, a result the window cut): ended runs are no
   * longer known shown, so their rows are listed again until a kept block
   * shows them. Beside every `ProgramHost.forgetShown`.
   */
  forgetShown(): void {
    this.endedShown.clear();
  }

  /** Remember the ended runs among `rows` as shown ended; bounded, the oldest forgotten first. */
  private markEndedShown(rows: readonly RoutineRow[]): void {
    for (const r of rows) if (r.state !== "running") this.endedShown.add(endedRunKey(r));
    while (this.endedShown.size > ENDED_SHOWN_KEPT) this.endedShown.delete(this.endedShown.values().next().value as string);
  }

  /** Restarts the program was blamed for since the last call. */
  takeBlamedRestarts(): number {
    const n = this.blamed;
    this.blamed = 0;
    return n;
  }

  private reading(): { level?: number; xp?: number; levels?: ReadonlyMap<string, number>; counts: WakeCounts } {
    const level = this.lastSample?.self?.level?.value;
    const xp = this.lastSample?.xp?.value;
    const chars = this.lastSample?.seats;
    return {
      ...(typeof level === "number" ? { level } : {}),
      ...(typeof xp === "number" ? { xp } : {}),
      ...(chars !== undefined ? { levels: new Map(chars.flatMap((c) => (c.level !== null ? [[c.character, c.level] as const] : []))) } : {}),
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
    // While asleep, the program is drained at its beat's pace and each routine's refusals and errors measured (`HotMeter`); what is drained is held for the wake as the first drain is.
    let measuredAt = this.now();
    const measure = (now: number): void => {
      if (now - measuredAt < HOT_DRAIN_MS) return;
      measuredAt = now;
      const drained = program.drainFacts();
      this.held = mergeFacts(this.held, drained);
      for (const r of this.hot.count(drained.repeats, drained.routines, now)) this.waker.note(r);
    };
    o.idle?.noteAsleep();
    let woke: SleepResult;
    try {
      woke = await sleepUntilWake({
        waker: this.waker,
        capMs: o.capMs,
        floorMs: o.floorMs,
        stopped: o.stopped,
        onTick: measure,
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
    // A repeat names its signature as its newest occurrence said it.
    for (const r of facts.repeats) {
      const line = this.signatures.get(r.signature);
      if (r.newest !== undefined && line !== undefined) this.noteSignature(r.signature, withNewest(line, r.newest), r.ts);
    }
    const reasons = this.waker.take();
    // Taken with the reasons, before any await: a death row landing during one waits, line and reason alike, for the next wake.
    const died = this.diedSince;
    this.diedSince = new Map();
    this.n++;
    const after = this.reading();
    // Deaths and quests count from the last block, not the sleep's start: a death in the awake turn before it is this wake's to count, as its reason is.
    const counted = this.countsShown ?? before.counts;
    const now = this.now();
    const levels = [...(after.levels ?? [])].flatMap(([character, to]) => {
      const from = before.levels?.get(character);
      return from !== undefined && from !== to ? [{ character, from, to }] : [];
    });
    const progress: WakeProgress = {
      ...(before.level !== undefined && after.level !== undefined ? { level: { from: before.level, to: after.level } } : {}),
      ...(levels.length > 0 ? { levels } : {}),
      ...(before.level !== undefined && before.level === after.level && before.xp !== undefined && after.xp !== undefined ? { xp: Math.max(0, after.xp - before.xp) } : {}),
      quests: Math.max(0, after.counts.quests - counted.quests),
      deaths: Math.max(0, after.counts.deaths - counted.deaths),
    };
    this.countsShown = after.counts;
    const seats = this.lastSample?.seats;
    const worn = await this.wornNow();
    const crossings = this.wornCrossings(worn);
    const condition =
      seats === undefined
        ? [
            ...(reasons.some((r) => r.key === "died") || progress.deaths > 0 ? await this.deathLines() : []),
            ...(o.hud === true ? [] : conditionLines(this.lastSample, this.lastDeathTs, now)),
          ]
        : [...(await this.fanoutDeaths(died)), ...fanoutConditionLines(seats, worn, this.deathTsOf, now, o.hud === true)];
    const shownDetails = program.shownDetails();
    const fresh = freshRoutines(facts.routines, now, shownDetails, this.endedShown);
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
        shown: shownDetails,
        ...(this.endedShown.size > 0 ? { endedShown: this.endedShown } : {}),
        ...(crossings.length > 0 ? { worn: crossings } : {}),
        ...(condition.length > 0 ? { condition } : {}),
      }),
    );
    if (o.kept) {
      program.markShown(facts.routines);
      this.markEndedShown(routinesInView(fresh.rows).rows);
    }
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
    // `count` is the occurrences since the previous wake, not a running total: `since` and `at` say which span.
    for (const r of facts.repeats) this.o.trajectory.append({ t: "program_error", kind: "repeat", signature: r.signature, ...refusalOfSignature(r.signature), count: r.count, since: this.drainedAt, at: now });
    this.drainedAt = now;
    return { block, fired: woke.fired, sleptMs: woke.sleptMs };
  }
}

/** How far a latched death's time may sit from the record's death row and still be that death. */
const DEATH_MATCH_MS = 30_000;
/** Ended runs remembered as shown; a program that starts a routine per task cannot grow it without bound. */
const ENDED_SHOWN_KEPT = 2_000;
/** How bad each durability level is: a crossing is a move up this. */
const LEVEL_RANK: Readonly<Record<DurabilityLevel, number>> = { ok: 0, low: 1, broken: 2 };

/**
 * One character's line under a fan-out wake's `deaths:`: "Alfa: killed by
 * Defias Miner, took 355 in the 10s before: Defias Miner 260 (melee ×3), …",
 * "Alfa: no hit in the 10s before" (a fall, a drowning), or "Alfa: cause not
 * seen" when its seat latched none for this death. Cut at
 * `FANOUT_DEATH_LINE_CHARS`. Pure.
 */
function fanoutDeathLine(character: string, cause: DeathCause | null): string {
  const window = `${Math.round(DEATH_WINDOW_MS / 1000)}s`;
  const taken = cause === null ? undefined : damageTaken(cause.damage);
  const line =
    cause === null
      ? `${character}: cause not seen`
      : cause.killer === undefined || taken === undefined
        ? `${character}: no hit in the ${window} before`
        : `${character}: killed by ${cause.killer}, took ${taken.total} in the ${window} before: ${taken.text}`;
  return line.length > FANOUT_DEATH_LINE_CHARS ? `${line.slice(0, FANOUT_DEATH_LINE_CHARS - 1).trimEnd()}…` : line;
}

/**
 * A fan-out wake's condition lines, each naming its character: where no HUD
 * rides with the block, one line of the characters dead or a ghost and for
 * how long ("characters: Alfa ghost, died 3m10s ago; Bravo dead, died 40s
 * ago"); and on every block each character's durability line when its worn
 * gear is broken or low ("Alfa durability: broken main hand …"), which the
 * fan-out roll-up never carries. Pure.
 */
export function fanoutConditionLines(
  seats: NonNullable<WakeSample["seats"]>,
  worn: ReadonlyMap<string, SnapshotLike["inventory"]>,
  diedAt: ReadonlyMap<string, number>,
  now: number,
  hud: boolean,
): string[] {
  const out: string[] = [];
  if (!hud) {
    const down = seats.flatMap((c) => {
      if (c.ghost !== true && c.dead !== true) return [];
      const at = diedAt.get(c.character);
      return [`${c.character} ${c.ghost === true ? "ghost" : "dead"}${at !== undefined ? `, died ${sleptWords(now - at)} ago` : ""}`];
    });
    if (down.length > 0) out.push(`characters: ${down.join("; ")}`);
  }
  const names = [...new Set([...seats.map((c) => c.character), ...worn.keys()])];
  for (const name of names) {
    const line = durabilityLine(worn.get(name));
    if (line !== undefined) out.push(`${name} ${line}`);
  }
  return out;
}
/** A death line's longest, in characters; past it, cut and ended with "…". */
const DEATH_LINE_CHARS = 240;

/**
 * "last death: killed by Defias Miner, took 355 in the 10s before: Defias
 * Miner 260 (melee ×3), …", the damage in the snippet delta's
 * own words (`damageTaken`), or undefined when no hit landed in the window
 * (a fall, a drowning). Pure.
 */
export function deathLine(cause: DeathCause): string | undefined {
  const taken = damageTaken(cause.damage);
  if (cause.killer === undefined || taken === undefined) return undefined;
  const line = `last death: killed by ${cause.killer}, took ${taken.total} in the ${Math.round(DEATH_WINDOW_MS / 1000)}s before: ${taken.text}`;
  return line.length > DEATH_LINE_CHARS ? `${line.slice(0, DEATH_LINE_CHARS - 1).trimEnd()}…` : line;
}

/**
 * The character's condition when something is wrong, in the HUD's own
 * reading, or nothing: "character: ghost, died 7m42s ago" (or dead) off the
 * player frame's health and the ghost bit, a ghost's ending with the
 * hostiles round its corpse (`corpseHostiles`), and the HUD's durability line
 * when worn gear is broken or low (`durabilityLine`). Nothing at fan-out,
 * whose sample is the characters' digests: there it is
 * `fanoutConditionLines`. Pure.
 */
export function conditionLines(sample: WakeSample | null, diedAt: number | undefined, now: number): string[] {
  if (sample === null || sample.seats !== undefined) return [];
  const out: string[] = [];
  const self = sample.self ?? undefined;
  const health = self?.health?.value as { current?: unknown } | null | undefined;
  const flags = self?.fields?.["playerFlags"]?.value;
  const ghost = typeof flags === "number" && (flags & PLAYER_FLAGS_GHOST) !== 0;
  const dead = health !== null && typeof health === "object" && health.current === 0;
  // A ghost's line ends as the HUD's ghost line does, with the hostiles round its corpse (operator, 2026-11-20).
  const hostiles = ghost ? corpseHostiles(sample) : undefined;
  if (ghost || dead)
    out.push(`character: ${ghost ? "ghost" : "dead"}${diedAt !== undefined ? `, died ${sleptWords(now - diedAt)} ago` : ""}${hostiles === undefined ? "" : `; ${hostiles}`}`);
  const worn = durabilityLine(sample.inventory);
  if (worn !== undefined) out.push(worn);
  return out;
}

/**
 * A refusal's action and status, read off its signature, so a repeat carries
 * them as its own fields as a fresh refusal does: the stack counts repeats by
 * signature alone. A refusal's signature ends in the SDK's action and status
 * (`<routine>|<character or seat>|<action>|<status>`), both plain words; an
 * error's ends in a `file:line` or nothing and a memory signature has two
 * parts, so neither reads as one. Read from the right, so a routine or seat
 * whose name holds a `|` still yields only those two words.
 */
export function refusalOfSignature(signature: string): { action: string; status: string } | Record<string, never> {
  const parts = signature.split("|");
  const [action, status] = parts.slice(-2);
  const word = /^[A-Za-z0-9_]+$/;
  return parts.length >= 4 && action !== undefined && status !== undefined && word.test(action) && word.test(status) ? { action, status } : {};
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
        ...("character" in fact && fact.character !== undefined ? { character: fact.character } : {}),
        error: fact.error.text,
        frames: fact.error.frames,
        deploy: fact.deploy,
        at: fact.ts,
      };
    case "refusal":
      return {
        t: "program_error",
        kind: "refusal",
        signature: fact.signature,
        name: fact.routine,
        ...(fact.character !== undefined ? { character: fact.character } : {}),
        ...(fact.seat !== undefined ? { seat: fact.seat } : {}),
        action: fact.action,
        status: fact.status,
        deploy: fact.deploy,
        at: fact.ts,
      };
  }
}
