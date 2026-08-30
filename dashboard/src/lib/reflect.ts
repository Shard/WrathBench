/**
 * The two pure pieces of the reflection surface: how a status stamp reads, and
 * where the rest glyph sits on a given frame.
 *
 * Both live here rather than in `MapPage.tsx` for the reason every other
 * `lib/` module does — the page is a canvas loop and a `<For>`, neither of
 * which is worth a test, while a format and a curve are.
 *
 * The vocabulary is the harness's own (`runner/src/episodic.ts` and
 * `runner/src/reflect.ts`): an entry the model wrote, stamped by the harness
 * with the turn, level and zone it observed, and a window that is open or not.
 *
 * The run feed's half is here too, for the same reason: which turns fall inside
 * a reflection window, and which tool calls belong to the surface, are two pure
 * questions worth pinning with tests, and the components that ask them are not.
 */

import type { CharacterStatus, ReflectionWindowView } from "@viewer/api-types";
import type { FeedGroup } from "./feedgroup";

/**
 * The stamp line above an entry's text: `turn 12 · L4 · Kharanos`.
 *
 * Unobserved stamps render as `L?` and `?`, exactly as `read_log` prints them
 * to the model — the same entry should not read one way to the operator and
 * another to the character, and a missing level is never quietly dropped.
 */
export function statusStamp(status: CharacterStatus): string {
  const level = status.level === null ? "L?" : `L${status.level}`;
  const zone = status.zone === null || status.zone.length === 0 ? "?" : status.zone;
  return `turn ${status.turn} · ${level} · ${zone}`;
}

/** One period of the rest glyph's drift, in ms. Slow: this is a snore, not a blink. */
export const REST_PERIOD_MS = 2600;

/** How far the glyph rises over one period, in css pixels. */
export const REST_RISE_PX = 5;

/** Where the rest glyph sits, and how strongly it shows, on one frame. */
export interface RestPhase {
  /** Pixels ABOVE the glyph's resting spot (positive is up). */
  rise: number;
  alpha: number;
}

/**
 * The rest glyph's drift at a moment.
 *
 * A single sine over `REST_PERIOD_MS`, so the glyph rises and fades back
 * rather than looping with a seam. `reduced` is the honest answer to
 * `prefers-reduced-motion`: the glyph is still drawn, at its mid position and
 * full strength, because it carries meaning the legend names — the animation
 * is decoration on top of it, and only the decoration is dropped.
 */
export function restPhase(nowMs: number, reduced = false): RestPhase {
  if (reduced) return { rise: REST_RISE_PX / 2, alpha: 0.9 };
  // 0 → 1 → 0 across the period.
  const t = ((nowMs % REST_PERIOD_MS) + REST_PERIOD_MS) % REST_PERIOD_MS;
  const wave = Math.sin((t / REST_PERIOD_MS) * Math.PI);
  return { rise: wave * REST_RISE_PX, alpha: 0.45 + wave * 0.45 };
}

/* ------------------------------------------------ the run feed's accent --- */

/**
 * The three tools that exist only inside the reflection surface
 * (`runner/src/tools.ts`): the one that opens a window, the one that writes the
 * episodic log, and the one that reads it back. Labelled in the feed so a
 * reader can find them without knowing the tool names by heart.
 */
export const REFLECT_TOOLS: ReadonlySet<string> = new Set(["reflect", "log_status", "read_log"]);

export function isReflectTool(name: string | null | undefined): boolean {
  return name !== null && name !== undefined && REFLECT_TOOLS.has(name);
}

/**
 * Whether a turn falls inside one of the run's reflection windows.
 *
 * `[fromTurn, toTurn)`, and a null `toTurn` runs to the end of the run — see
 * `runner/viewer/tail.ts`, which owns the convention and the reason for it. A
 * feed row with no turn at all (the claude driver's out-of-band records, the
 * MCP server's) is never accented: "we do not know" is not "reflecting".
 */
export function reflectingAt(
  windows: readonly ReflectionWindowView[] | undefined,
  turn: number | null | undefined,
): boolean {
  if (windows === undefined || typeof turn !== "number") return false;
  return windows.some((w) => turn >= w.fromTurn && (w.toTurn === null || turn < w.toTurn));
}

/**
 * The turn a feed row belongs to, whichever of the composite shapes it is.
 *
 * A call group is asked in the order `lib/feedgroup.ts` pairs it — call, then
 * snippet, then result — because any one of the three can be the half that is
 * in-window.
 */
export function groupTurn(g: FeedGroup): number | undefined {
  switch (g.kind) {
    case "turn":
      return g.request.turn;
    case "response":
      return g.entry.turn;
    case "call":
      return (g.call ?? g.snippet ?? g.result)?.turn;
    default:
      return g.entry.turn;
  }
}
