/**
 * The condition a run was played under, and the one key that names it.
 *
 * A ladder row is one condition (operator, 2026-11-14): the harness series,
 * the episode, the harness, the reasoning effort, the requested routing,
 * whether the reference wiki was served, the compaction window, the agent loop
 * and its `yield` tool. Two runs that differ in any of these are two rows,
 * never one. The prompt hash is deliberately not in the key: every in-series
 * prompt patch moves it, the series already absorbs those, and a fix commit
 * does not restart evidence (docs/METHODOLOGY.md, "Fixed harness, frozen per
 * version").
 *
 * The key is read off the stamped tuple and never recomputed: an absent field
 * reads as its default, which is what an absent field has always meant on the
 * tuple (`runner/src/comparability.ts` keeps every default absent so old
 * tuples stay byte-identical): the snippet loop, no `yield`, the wiki served,
 * the CLI's own window and no routing to state.
 *
 * A *chart group* is coarser: the dimensions on which METHODOLOGY says runs do
 * not share a chart at all. Effort and the compaction window are comparable
 * rows on one chart ("`opus at low` and `opus at high` are two comparable
 * rows", "a recorded run dimension like effort"), and so is the harness, a
 * tag on every row. The loop, pinned against unpinned routing, and the wiki
 * are not.
 *
 * Import-free on purpose, like `lineage.ts`: the dashboard derives a row's
 * condition with these same functions when a viewer predates the field.
 */

/** What a reader labels a run's condition with, beside the key. Public. */
export interface RunCondition {
  /**
   * Equal ids are one condition. Opaque: the private viewer's id spells the
   * whole key, and the public projection renumbers it per response so the
   * requested routing, which names providers, never leaves.
   */
  id: string;
  /** The agent loop: the program loop, or the persistent-snippet loop it replaced. */
  loop: "program" | "snippet";
  /** Whether the program loop offered its `yield` tool. */
  yield: boolean;
  /**
   * False only when the request let the aggregator fall back to any backend
   * (`routing.allowFallbacks`), as an OpenCode Go run always does. A run with
   * no routing to state (a CLI, a direct provider) is served by one backend.
   */
  pinned: boolean;
  /** False when the run had no reference wiki (`wiki: false`). */
  wiki: boolean;
}

/** The stamped tuple, as far as the key reads it. Every field as it is stored. */
export interface ConditionTuple {
  effort?: string | null;
  routing?: { allowFallbacks?: boolean } & Record<string, unknown>;
  wiki?: boolean;
  compactWindow?: string | null;
  loop?: string;
  yield?: boolean;
}

/** A run's facts the key is made of: its tuple, and the four the reader already holds apart from it. */
export interface ConditionFacts {
  series: string | null;
  episode: string | null;
  harness: string | null;
  tuple: ConditionTuple | null;
}

/** Keys sorted at every depth, so two equal routing blocks spell one string. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

/** The condition key: one string per condition, equal exactly when every dimension is. */
export function conditionKey(f: ConditionFacts): string {
  const t = f.tuple ?? {};
  return canonical({
    series: f.series,
    episode: f.episode,
    harness: f.harness,
    effort: t.effort ?? null,
    routing: t.routing ?? null,
    wiki: t.wiki !== false,
    compactWindow: t.compactWindow ?? null,
    loop: t.loop === "program" ? "program" : "snippet",
    yield: t.yield === true,
  });
}

/** A run's condition, with the key as its id. */
export function conditionOf(f: ConditionFacts): RunCondition {
  const t = f.tuple ?? {};
  return {
    id: conditionKey(f),
    loop: t.loop === "program" ? "program" : "snippet",
    yield: t.yield === true,
    pinned: t.routing?.allowFallbacks !== true,
    wiki: t.wiki !== false,
  };
}

/** One set of conditions that may share a chart. */
export interface ChartGroup {
  /** Stable and URL-safe: `snippet`, `program`, `program-unpinned`, `snippet-nowiki`. */
  id: string;
  /** What the page prints for it. */
  label: string;
}

/** The chart a condition belongs on. */
export function chartGroupOf(c: Pick<RunCondition, "loop" | "pinned" | "wiki">): ChartGroup {
  const id = [c.loop, ...(c.pinned ? [] : ["unpinned"]), ...(c.wiki ? [] : ["nowiki"])].join("-");
  const label = [`${c.loop} loop`, ...(c.pinned ? [] : ["unpinned"]), ...(c.wiki ? [] : ["no wiki"])].join(" · ");
  return { id, label };
}
