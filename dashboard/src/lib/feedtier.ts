/**
 * The run feed's two tiers: what the model decided, and what it then did.
 *
 * A long run's feed is mostly things done: a move record a step, a routine's
 * action log a minute, state reads, served batches, subzones crossed. Drawn a
 * card each they bury the rows a reader came for, so the feed draws two
 * tiers. A **decision** keeps its own row: the model's reply, a snippet, a
 * reflection or a log entry, a level, a death, the run's end. An **action**
 * is minimised, and consecutive actions between two decisions are one
 * collapsed line of counts ("23 moves · 4 loots · 2 reads") that opens to a
 * line each.
 *
 * This file is the whole of that judgement, and it is tables: which kind a
 * tool, a record type, a milestone or a dispatched action is (`TOOLS`,
 * `RECORDS`, `MILESTONES`, `ACTIONS`), and which tier a kind is on (`KINDS`).
 * A tool or record this build has never heard of is a decision, so a new one
 * shows in full until someone files it; filing it is one line here.
 *
 * `lib/feedgroup.ts` decides which entries are one row; `tierFeed` takes its
 * rows and folds the runs of actions; `lib/feedview.ts` says how a row reads.
 * All pure: the components that draw them are `components/FeedRows.tsx`.
 */

import type { ActionNoteView, ActionsEntry, FeedEntry } from "@viewer/api-types";
import { anchorOf, type CallGroup, type FeedGroup } from "./feedgroup";
import { HARNESS_RULE } from "./feedview";

export type Tier = "decision" | "action";

/** What a row is: its icon, its tier, and the noun the collapsed line counts it under. */
export type FeedKind =
  // decisions
  | "turn"
  | "response"
  | "snippet"
  | "reflect"
  | "log"
  | "pad"
  | "program"
  | "routine"
  | "roster"
  | "level"
  | "death"
  | "quest"
  | "milestone"
  | "notice"
  | "end"
  | "meta"
  | "unknown"
  // actions
  | "move"
  | "combat"
  | "loot"
  | "interact"
  | "errand"
  | "trade"
  | "item"
  | "say"
  | "read"
  | "events"
  | "state"
  | "area"
  | "sleep"
  | "repeat"
  | "record"
  | "other";

interface KindDef {
  tier: Tier;
  /** The collapsed line's noun, singular and plural. */
  one: string;
  many: string;
}

const d = (one: string, many = `${one}s`): KindDef => ({ tier: "decision", one, many });
const a = (one: string, many = `${one}s`): KindDef => ({ tier: "action", one, many });

/** Every kind, in the order the collapsed line lists its counts. */
const KINDS: Readonly<Record<FeedKind, KindDef>> = {
  turn: d("turn"),
  response: d("response"),
  snippet: d("snippet"),
  reflect: d("reflection"),
  log: d("log entry", "log entries"),
  pad: d("scratchpad write"),
  program: d("program edit"),
  routine: d("routine change"),
  roster: d("roster change"),
  level: d("level"),
  death: d("death"),
  quest: d("turn-in"),
  milestone: d("milestone"),
  notice: d("notice"),
  end: d("stop"),
  meta: d("record"),
  unknown: d("record"),

  move: a("move"),
  combat: a("combat action"),
  loot: a("loot"),
  interact: a("interaction"),
  errand: a("quest action"),
  trade: a("trade"),
  item: a("item action"),
  say: a("chat line"),
  read: a("read"),
  events: a("event batch", "event batches"),
  state: a("state sample"),
  area: a("area change"),
  sleep: a("wait"),
  repeat: a("repeated failure"),
  record: a("record"),
  other: a("other action"),
};

export function tierOf(kind: FeedKind): Tier {
  return KINDS[kind].tier;
}

/* ------------------------------------------------------------ the tables */

/** A tool call, by the tool's name as the trajectory records it (the CLI drivers' `mcp__…__` prefix already cut). */
const TOOLS: Readonly<Record<string, FeedKind>> = {
  run_snippet: "snippet",
  reflect: "reflect",
  log_status: "log",
  write_scratchpad: "pad",
  edit_scratchpad: "pad",
  // The program loop's equivalents of a snippet: the model writing what will run.
  write_file: "program",
  edit_file: "program",
  delete_file: "program",
  start_routine: "routine",
  stop_routine: "routine",
  login_character: "roster",
  logout_character: "roster",

  state_summary: "read",
  recent_events: "read",
  read_log: "read",
  read_file: "read",
  search_reference: "read",
  list_characters: "read",
  yield: "sleep",
};

/**
 * Where a run's surface files a tool differently from `TOOLS`: by its loop
 * (`program`, `snippet`) or its harness (`claude-code`, `codex`, `pi`,
 * `wrathbench`), the harness winning. Empty while every tool means the same
 * thing wherever it is served; a tool that does not is one line here.
 */
export const SURFACE_TOOLS: Readonly<Record<string, Readonly<Record<string, FeedKind>>>> = {};

/** What a run was driven with, as far as the classification cares. */
export interface Surface {
  loop?: "program" | "snippet" | undefined;
  harness?: string | null | undefined;
}

/** A plain record, by its `t`. Milestones, harness records and responses are read further below. */
const RECORDS: Readonly<Record<string, FeedKind>> = {
  meta: "meta",
  character: "meta",
  driver: "meta",
  continue: "meta",
  termination: "end",
  pause: "end",
  resume: "end",
  watchdog: "end",
  limit: "end",
  "wind-down": "end",
  quest_complete: "quest",
  // A fresh error or refusal; a wake's count of repeats of one is read further below.
  program_error: "notice",
  // A CLI's own reasoning summary is the model's text.
  codex_reasoning: "response",

  move: "move",
  state: "state",
  events_served: "events",
  actions: "other",
  // A codex turn-end wake; a yield's is on its card (`lib/feedgroup.ts`), so a wait is counted once.
  wake: "sleep",
  // A deploy no write in the window set off; one that a write did is on that write's card.
  deploy: "record",
  routine: "record",
  episodic: "record",
  reflect_window: "record",
  program_init: "record",
  program_load: "record",
  program_version: "record",
  claude_system: "record",
  claude_result: "record",
  claude_stderr: "record",
  claude_unparseable: "record",
  codex_item: "record",
  codex_tool_call: "record",
  codex_result: "record",
  codex_thread: "record",
  codex_stderr: "record",
  codex_unparseable: "record",
  codex_retry: "record",
  codex_tool_error: "record",
  pi_stderr: "record",
  pi_unparseable: "record",
  pi_retry: "record",
  pi_error: "record",
  pi_tool_result_truncated: "record",
};

/** The records above that say something went wrong, counted as failures on a collapsed line. */
export const FAILED_RECORDS: ReadonlySet<string> = new Set(["codex_tool_error", "pi_error", "claude_unparseable", "codex_unparseable", "pi_unparseable"]);

/** A `milestone` record, by its `kind`. One this build does not know is a milestone, in full. */
const MILESTONES: Readonly<Record<string, FeedKind>> = {
  level: "level",
  death: "death",
  quest: "quest",
  // Crossed constantly on foot, and bookkeeping at a login: not turning points.
  area: "area",
  taxi_landed: "area",
  release: "record",
  spell: "record",
  talent: "record",
  spells_at_login: "record",
  achievements_at_login: "record",
};

/** A dispatched action (`ActionNoteView.action`), for the counts of an action log. One not listed is `other`. */
const ACTIONS: Readonly<Record<string, FeedKind>> = {
  move_to: "move",
  stop: "move",
  face: "move",
  set_target: "combat",
  clear_target: "combat",
  attack_start: "combat",
  attack_stop: "combat",
  cast_spell: "combat",
  cancel_cast: "combat",
  loot: "loot",
  loot_all: "loot",
  loot_item: "loot",
  loot_money: "loot",
  loot_release: "loot",
  interact: "interact",
  gossip_hello: "interact",
  gossip_select: "interact",
  quest_list: "errand",
  quest_details: "errand",
  quest_accept: "errand",
  quest_complete: "errand",
  quest_choose_reward: "errand",
  quest_abandon: "errand",
  quest_query: "errand",
  questgiver_status_query: "errand",
  questgiver_status_multiple_query: "errand",
  vendor_list: "trade",
  buy_item: "trade",
  sell_item: "trade",
  repair_all: "trade",
  trainer_list: "trade",
  trainer_buy_spell: "trade",
  equip_item: "item",
  use_item: "item",
  destroy_item: "item",
  say: "say",
};

/**
 * How a `move` record's verdict reads. A refusal is a failure the collapsed
 * line counts; an arrival or a move something else replaced is not; the rest
 * (a fall, a knock-back, a status this build does not know) is shown as it is
 * and counted as neither.
 */
const MOVE_REFUSED: ReadonlySet<string> = new Set([
  "too_far",
  "no_mesh",
  "target_off_mesh",
  "start_off_mesh",
  "path_incomplete",
  "cannot_fly",
  "rooted",
  "stunned",
]);

export function moveRefused(status: unknown): boolean {
  return typeof status === "string" && MOVE_REFUSED.has(status);
}

/** How many occurrences a wake's `program_error` repeat record counts, or null for any other record. */
export function repeatCount(entry: FeedEntry): number | null {
  const e = entry as unknown as Record<string, unknown>;
  if (entry.t !== "program_error" || e["kind"] !== "repeat") return null;
  const n = e["count"];
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? n : 1;
}

/* -------------------------------------------------------- classification */

export function toolKind(name: string | null | undefined, surface: Surface = {}, overrides: typeof SURFACE_TOOLS = SURFACE_TOOLS): FeedKind {
  if (name === null || name === undefined) return "unknown";
  const by = (key: string | null | undefined): FeedKind | undefined => (typeof key === "string" ? overrides[key]?.[name] : undefined);
  return by(surface.harness) ?? by(surface.loop) ?? TOOLS[name] ?? "unknown";
}

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

export function entryKind(entry: FeedEntry): FeedKind {
  const e = entry as unknown as Record<string, unknown>;
  switch (entry.t) {
    case "milestone":
      return MILESTONES[str(e["kind"]) ?? ""] ?? "milestone";
    case "harness":
    case "notice":
      // The harness speaking to the model is never folded away; its bookkeeping is.
      return (str(e["text"]) ?? "").length > 0 ? "notice" : "record";
    case "program_error":
      // Each wake writes how many more times every known error and refusal
      // happened since the last: a rollup of failures already shown, not news.
      // A public window ships the record's skeleton alone, which says nothing
      // a reader could act on, so it folds with the actions around it.
      if (e["kind"] === "repeat") return "repeat";
      return e["kind"] === undefined ? "record" : "notice";
    default:
      return RECORDS[entry.t] ?? "unknown";
  }
}

/** The name a call group goes by, whichever of its halves is in the window. */
export function callName(g: CallGroup): string | undefined {
  return g.call?.name ?? g.result?.name ?? (g.snippet !== null ? "run_snippet" : undefined);
}

/** What one feed row is. */
export function kindOf(g: FeedGroup, surface: Surface = {}): FeedKind {
  switch (g.kind) {
    case "turn":
      return "turn";
    case "response":
      // A reply with no text is the envelope of its tool calls, which have rows of their own.
      return (g.entry.text ?? "").trim().length > 0 ? "response" : "record";
    case "call":
      return toolKind(callName(g), surface);
    default:
      return entryKind(g.entry);
  }
}

/* ------------------------------------------------------------------ tally */

/** What a run of actions comes to: counts by kind, and what must not be hidden in it. */
export interface Tally {
  /** Kinds with a count, in `KINDS` order. */
  counts: { kind: FeedKind; n: number }[];
  /** Refused or errored: a tool call, a dispatch, a move's verdict, a driver's error record. */
  failed: number;
  /** Lines the harness added to a tool result in the run. */
  hints: number;
}

class Counter {
  private readonly by = new Map<FeedKind, number>();
  failed = 0;
  hints = 0;
  add(kind: FeedKind, n = 1): void {
    if (n > 0) this.by.set(kind, (this.by.get(kind) ?? 0) + n);
  }
  get(kind: FeedKind): number {
    return this.by.get(kind) ?? 0;
  }
  done(): Tally {
    const order = Object.keys(KINDS) as FeedKind[];
    return { counts: order.filter((k) => this.by.has(k)).map((k) => ({ kind: k, n: this.by.get(k)! })), failed: this.failed, hints: this.hints };
  }
}

const noteFailed = (n: ActionNoteView): boolean => n.status === 0 || n.status < 200 || n.status >= 300;
const noteCount = (n: ActionNoteView): number => (typeof n.count === "number" && n.count > 1 ? n.count : 1);

function countNotes(c: Counter, records: readonly ActionsEntry[], skipMoves: boolean): void {
  for (const r of records) {
    for (const n of r.actions ?? []) {
      const failed = noteFailed(n);
      if (failed) c.failed += noteCount(n);
      // The SDK's own client-parity traffic is listed, not counted: nobody asked for it.
      if (n.auto === true) continue;
      const kind = ACTIONS[n.action] ?? "other";
      // A move the window holds a record of is counted there, once; a refused dispatch has no record.
      if (kind === "move" && skipMoves && !failed && n.action === "move_to") continue;
      c.add(kind, noteCount(n));
    }
    for (const [action, n] of Object.entries(r.dropped ?? {})) if (typeof n === "number") c.add(ACTIONS[action] ?? "other", n);
  }
}

/** One action log's counts: a snippet's own, on its card. */
export function tallyNotes(records: readonly ActionsEntry[]): Tally {
  const c = new Counter();
  countNotes(c, records, false);
  return c.done();
}

/** How many lines the harness added under a result (`lib/feedview.ts`, `splitNotices`), without building them. */
function hintCount(text: string | undefined): number {
  if (text === undefined) return 0;
  const at = text.lastIndexOf(HARNESS_RULE);
  if (at === -1 || (at > 0 && text[at - 1] !== "\n")) return 0;
  return text
    .slice(at + HARNESS_RULE.length)
    .split("\n")
    .filter((l) => l.trim().length > 0).length;
}

const isActions = (e: FeedEntry): e is ActionsEntry => e.t === "actions" && Array.isArray((e as { actions?: unknown }).actions);

/**
 * A run's counts. Moves are counted from the `move` records, one per move id
 * (a move writes a row at its dispatch and another at its verdict), and from
 * the action logs only where the run holds no such record: the same walk is
 * in both, and "24 moves" for twelve would be wrong.
 */
export function tallyRun(items: readonly FeedGroup[], surface: Surface = {}): Tally {
  const c = new Counter();
  const moves = new Set<unknown>();
  let anonymous = 0;
  const logs: ActionsEntry[] = [];
  for (const g of items) {
    if (g.kind === "plain" && g.entry.t === "move") {
      const e = g.entry as unknown as Record<string, unknown>;
      if (typeof e["moveId"] === "number") moves.add(e["moveId"]);
      else if (e["status"] === null || e["status"] === undefined) anonymous++;
      if (moveRefused(e["status"])) c.failed++;
      continue;
    }
    if (g.kind === "plain" && isActions(g.entry)) {
      logs.push(g.entry);
      continue;
    }
    // A repeat record counts its occurrences, never as failed: the first of each was its own notice row.
    c.add(kindOf(g, surface), g.kind === "plain" ? (repeatCount(g.entry) ?? 1) : 1);
    if (g.kind === "call") {
      if (g.result?.isError === true) c.failed++;
      c.hints += hintCount(g.result?.text);
    } else if (g.kind === "plain" && FAILED_RECORDS.has(g.entry.t)) c.failed++;
  }
  const recorded = moves.size + anonymous;
  c.add("move", recorded);
  countNotes(c, logs, recorded > 0);
  return c.done();
}

/** "23 moves", "1 loot". */
export function countLabel(kind: FeedKind, n: number): string {
  return `${n} ${n === 1 ? KINDS[kind].one : KINDS[kind].many}`;
}

/** A tally in words, for a title and for a reader without the icons. */
export function tallyLabel(t: Tally): string {
  const parts = t.counts.map((x) => countLabel(x.kind, x.n));
  if (t.failed > 0) parts.push(`${t.failed} failed`);
  if (t.hints > 0) parts.push(`${t.hints} ${t.hints === 1 ? "hint" : "hints"}`);
  return parts.join(" · ");
}

/* --------------------------------------------------------------- grouping */

/** Consecutive actions between two decisions, as one row. */
export interface ActionRun {
  kind: "run";
  /** The first item's anchor entry: the run's identity while it grows at its end. */
  anchor: number;
  items: FeedGroup[];
  tally: Tally;
  /** The span the run covers, for its clock cell; 0 where no item carried a time. */
  fromTs: number;
  toTs: number;
}

export type FeedRow = FeedGroup | ActionRun;

export function tsOf(g: FeedGroup): number {
  switch (g.kind) {
    case "turn":
      return g.request.ts;
    case "response":
      return g.entry.ts;
    case "call":
      return g.call?.ts ?? g.snippet?.ts ?? g.result?.ts ?? 0;
    default:
      return g.entry.ts;
  }
}

function sameItems(x: readonly FeedGroup[], y: readonly FeedGroup[]): boolean {
  return x.length === y.length && x.every((g, i) => g === y[i]);
}

/**
 * Fold each run of consecutive actions into one row; a decision passes
 * through as it is, and ends the run before it.
 *
 * A failure does not end a run: twenty refused moves in a row are one line
 * that says "20 failed", where twenty broken-out cards would be the wall this
 * exists to remove. It is counted on the line instead (`Tally.failed`), and
 * the row draws the failures themselves under its counts without being opened.
 *
 * Pure over `groups`; `prev` only recycles identity, as `groupFeed`'s does: a
 * run whose items are the same objects as last time is the same object, so a
 * settled run is not redrawn when the live tail appends below it.
 */
export function tierFeed(groups: readonly FeedGroup[], surface: Surface = {}, prev: readonly FeedRow[] = []): FeedRow[] {
  const recycled = new Map<number, ActionRun>();
  for (const r of prev) if (r.kind === "run") recycled.set(r.anchor, r);

  const out: FeedRow[] = [];
  let run: FeedGroup[] = [];
  const flush = (): void => {
    if (run.length === 0) return;
    const anchor = anchorOf(run[0]!);
    const old = recycled.get(anchor);
    if (old !== undefined && sameItems(old.items, run)) out.push(old);
    else {
      const stamps = run.map(tsOf).filter((ts) => ts > 0);
      out.push({ kind: "run", anchor, items: run, tally: tallyRun(run, surface), fromTs: stamps[0] ?? 0, toTs: stamps[stamps.length - 1] ?? 0 });
    }
    run = [];
  };
  for (const g of groups) {
    if (tierOf(kindOf(g, surface)) === "action") run.push(g);
    else {
      flush();
      out.push(g);
    }
  }
  flush();
  return out;
}

/**
 * The lines a run opens to: its items, less a move's dispatch row where the
 * same move's verdict row is in the run too. The verdict row says where the
 * move went and how it ended, so the pair is one line.
 */
export function runLines(items: readonly FeedGroup[]): FeedGroup[] {
  const settled = new Set<unknown>();
  for (const g of items) {
    if (g.kind !== "plain" || g.entry.t !== "move") continue;
    const e = g.entry as unknown as Record<string, unknown>;
    if (typeof e["moveId"] === "number" && typeof e["status"] === "string") settled.add(e["moveId"]);
  }
  return items.filter((g) => {
    if (g.kind !== "plain" || g.entry.t !== "move") return true;
    const e = g.entry as unknown as Record<string, unknown>;
    return typeof e["status"] === "string" || !settled.has(e["moveId"]);
  });
}
