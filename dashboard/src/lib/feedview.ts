/**
 * The run feed's presentation layer: what is expanded, and how the two entry
 * kinds that are not part of the model↔tool cycle read.
 *
 * `lib/feedgroup.ts` decides which entries belong to one row; this decides what
 * a row shows. Kept pure and separate for the same reason as that file — it is
 * the half worth pinning with tests, and the components around it are `<For>`
 * loops that are not.
 *
 * Three jobs:
 *
 * 1. **The whole-feed expand preset.** Every long block folds to a few lines
 *    with its own toggle; the preset is the starting point for all of them at
 *    once, remembered in `localStorage`. Per-block folding still wins
 *    underneath — the preset sets the default, a click overrides it, and
 *    changing the preset returns every block to the new default.
 *
 * 2. **State samples.** `{ t: "state", … }` is written every few seconds by
 *    the loop's ticker (`runner/src/trajectory.ts` `StateLine`), so a run feed
 *    carries hundreds of them and each was rendering as a pretty-printed JSON
 *    object. `stateLine` reduces one to a single scannable line; the JSON is
 *    still one click away.
 *
 * 3. **Harness notices.** What the harness itself says, as opposed to what
 *    the game said. They arrive two ways and both are drawn as one callout:
 *
 *    - As a `{ t: "harness", kind, text? }` record. `runner/src/run.ts` and
 *      `runner/src/mcp.ts` append the sandbox's `HarnessNotice` verbatim
 *      (`sandbox_restarted`, `sandbox_started`, `session_note`,
 *      `provider_truncated`), and the same type carries bookkeeping with no
 *      text at all (`hygiene`, `resolved_model`, `token_regenerated`). Text is
 *      what separates the two: a record with something to say says it.
 *    - Appended to a snippet result, under a `--- harness ---` rule
 *      (`runner/src/tools.ts` `renderActionHints`), deduped per (action,
 *      status) with counts: `moveTo too_far ×21: a single moveTo covers
 *      ~250y — …`. `splitNotices` lifts that block out of the result body so
 *      it is not buried at the bottom of a console dump.
 *
 * The record contract: **required** — `t` is `harness` (or `notice`, which
 * `api-types.ts` names as a future type and nothing writes yet); **tolerated**
 * — `kind`, `text` and a numeric `count`, each read defensively because
 * `OtherEntry`'s index signature makes every field `unknown`; **ignored** —
 * everything else, which still reaches the reader through the expanded detail.
 * A writer landing with a different shape costs a line here, not a redesign.
 */

import type { FeedEntry } from "@viewer/api-types";
import { fmtMoney, num } from "./format";
import { readChoicePref, writeChoicePref } from "./prefs";

/* ---------------------------------------------------------------- presets */

export const EXPAND_PRESETS = ["minimal", "responses", "snippets", "all"] as const;
export type ExpandPreset = (typeof EXPAND_PRESETS)[number];

/**
 * The kinds of block a preset decides for. Coarser than the entry types on
 * purpose: the preset is four choices a reader makes in one click, not a
 * per-type matrix.
 */
export type BlockKind =
  /** The model's own reply text. */
  | "response"
  /** A tool call's input and its result — snippet code, args, output. */
  | "call"
  /** The long form of everything else: a state sample, a generic entry. */
  | "detail";

const OPENS: Record<ExpandPreset, ReadonlySet<BlockKind>> = {
  minimal: new Set(),
  responses: new Set<BlockKind>(["response"]),
  snippets: new Set<BlockKind>(["response", "call"]),
  all: new Set<BlockKind>(["response", "call", "detail"]),
};

/** Whether a block of this kind starts expanded under this preset. */
export function expandedBy(preset: ExpandPreset, kind: BlockKind): boolean {
  return OPENS[preset].has(kind);
}

/** What the control calls each choice. */
export const EXPAND_LABELS: Record<ExpandPreset, string> = {
  minimal: "minimal",
  responses: "responses",
  snippets: "snippets",
  all: "all",
};

/**
 * The default when nothing is remembered: the model's reasoning open, the
 * multi-KB snippet bodies still folded. It is the reading a visitor wants
 * without scrolling past console dumps to find it, and it is one click from
 * either neighbour.
 */
export const EXPAND_DEFAULT: ExpandPreset = "responses";

const EXPAND_KEY = "wrathbench.runview.expand";

function asPreset(v: string | null): ExpandPreset | null {
  return (EXPAND_PRESETS as readonly string[]).includes(v ?? "") ? (v as ExpandPreset) : null;
}

/**
 * The remembered preset. A stored value this build no longer honours resolves
 * to the default rather than to nothing — the rule `prefs.ts` states: a
 * remembered choice must never leave a reader looking at an empty or
 * inexplicable page.
 */
export function readExpandPref(): ExpandPreset {
  return asPreset(readChoicePref(EXPAND_KEY)) ?? EXPAND_DEFAULT;
}

export function writeExpandPref(v: ExpandPreset): void {
  writeChoicePref(EXPAND_KEY, v);
}

/* ----------------------------------------------------------- state sample */

/**
 * One state sample as one line: what the character was, where, and when.
 *
 * Zone and area are ids, not names — the sample records ids by design (names
 * are client text) and nothing client-side maps them — so they are labelled
 * rather than printed bare. Every field is optional: samples written before a
 * column existed have none, and an absent field is dropped rather than shown
 * as a zero.
 */
export function stateLine(entry: FeedEntry): string {
  const e = entry as unknown as Record<string, unknown>;
  const n = (k: string): number | undefined => (typeof e[k] === "number" ? (e[k] as number) : undefined);
  const parts: string[] = [];

  const level = n("level");
  const xp = n("xp");
  if (level !== undefined) parts.push(`level ${level}`);
  if (xp !== undefined) parts.push(`${num(xp)} xp`);

  const zone = n("zone");
  const area = n("area");
  if (zone !== undefined || area !== undefined) {
    parts.push(`zone ${zone ?? "?"} · area ${area ?? "?"}`);
  }

  const money = n("money");
  if (money !== undefined) parts.push(fmtMoney(money));

  const quests = n("questsCompleted");
  if (quests !== undefined) parts.push(`${quests} quests`);

  const map = n("map");
  const x = n("x");
  const y = n("y");
  const z = n("z");
  if (x !== undefined && y !== undefined && z !== undefined) {
    const at = `(${x.toFixed(0)}, ${y.toFixed(0)}, ${z.toFixed(0)})`;
    parts.push(map === undefined ? at : `map ${map} ${at}`);
  }

  return parts.length > 0 ? parts.join(" · ") : "no fields recorded";
}

/* ---------------------------------------------------------------- notices */

/** The marker `runner/src/tools.ts` puts above the harness's own lines. */
export const HARNESS_RULE = "--- harness ---";

/**
 * Split a tool result into what the tool said and what the harness added.
 *
 * The harness block is written last and only once, so the LAST occurrence of
 * the rule is the split point: a snippet that prints the rule itself takes its
 * own console output into the callout, which is the model's doing and visible
 * as such, and no real harness line is ever lost to it. Empty lines are
 * dropped; nothing else about the text is altered.
 */
export function splitNotices(text: string): { body: string; notices: string[] } {
  const at = text.lastIndexOf(`\n${HARNESS_RULE}`);
  const from = at === -1 ? (text.startsWith(`${HARNESS_RULE}`) ? 0 : -1) : at + 1;
  if (from === -1) return { body: text, notices: [] };
  const notices = text
    .slice(from + HARNESS_RULE.length)
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (notices.length === 0) return { body: text, notices: [] };
  return { body: from === 0 ? "" : text.slice(0, from - 1), notices };
}

/** The entry types this build draws as a harness row. */
export function isHarnessEntry(entry: FeedEntry): boolean {
  return entry.t === "harness" || entry.t === "notice";
}

/** A harness record, read defensively; see the record contract above. */
export interface NoticeView {
  kind: string;
  /** What the harness said, empty when the record is bookkeeping. */
  text: string;
  /** The dedupe count when the writer recorded one; null otherwise. */
  count: number | null;
  /**
   * True when there is nothing addressed to anyone in it — `resolved_model`,
   * `hygiene`, a token regeneration. Same record type, different voice, and a
   * page that shouted them all would make the ones that matter unfindable.
   */
  bookkeeping: boolean;
}

/**
 * The fields a bookkeeping record carries, on one line: `cleared: 1`,
 * `model: x/y:free`. The head row is the whole row for those, and the
 * pretty-printed JSON the generic renderer produces is several lines — this is
 * the same content with the bookkeeping and the head's own fields dropped.
 */
export function harnessFields(entry: FeedEntry): string {
  const skip = new Set(["i", "t", "ts", "start", "end", "clipped", "turn", "kind", "text", "count"]);
  const parts: string[] = [];
  for (const [k, v] of Object.entries(entry as unknown as Record<string, unknown>)) {
    if (skip.has(k) || v === null || v === undefined) continue;
    parts.push(`${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`);
  }
  return parts.join(" · ");
}

export function noticeView(entry: FeedEntry): NoticeView {
  const e = entry as unknown as Record<string, unknown>;
  const str = (k: string): string | undefined => (typeof e[k] === "string" ? (e[k] as string) : undefined);
  const count = typeof e["count"] === "number" ? (e["count"] as number) : null;
  const text = str("text") ?? "";
  return {
    kind: str("kind") ?? entry.t,
    text,
    count: count !== null && count > 1 ? count : null,
    bookkeeping: text.length === 0,
  };
}
