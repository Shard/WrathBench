/**
 * The runs table's pure layer: its columns, the sort, the filters, and the
 * one-word readings a row shows.
 *
 * The page is a spreadsheet of every run the viewer knows about — probe,
 * campaign, freeplay, scored, live, paused, ended, any series — and the one
 * thing this file must get right is that nothing here decides what a run *is
 * worth*. Scorability, tier membership and the harness series all arrive
 * decided from `/api/results`; the table shows them and lets the reader sort
 * and narrow. Aggregates over runs are the ladder's business.
 *
 * Everything is pure so the sort and the readings can be tested without a DOM
 * (dashboard/README.md), and so the header and the body cannot drift: the page
 * renders both off `RUN_COLUMNS`.
 */

import type { ResultRun } from "@viewer/api-types";

/**
 * The table, left to right, as the header prints it. Keys, not labels — the
 * sort in the URL names one of these, so renaming a column is renaming a link.
 */
export const RUN_COLUMNS = [
  "started",
  "run",
  "model",
  "harness",
  "effort",
  "kind",
  "episode",
  "character",
  "status",
  "level",
  "turns",
  "duration",
  "cost",
] as const;

export type RunColumn = (typeof RUN_COLUMNS)[number];

/** Numbers are right-aligned; the header has to say so too, or it drifts off its column. */
export function columnClass(column: RunColumn): string {
  return column === "level" || column === "turns" || column === "duration" || column === "cost" ? "right" : "";
}

/** The header's hover: what the column actually counts. */
export const COLUMN_TITLES: Partial<Record<RunColumn, string>> = {
  started: "when the run was launched; the default order, newest first",
  harness: "which loop owned the run, and the harness series it ran on",
  kind: "what the run was for: a scored tier attempt, a probe cell, freeplay, or a steered objective",
  episode: "the episode this run was launched under; (labeled) is the reader's guess at an older run, never membership",
  status: "live, paused (with why), stalled, or how it ended",
  level: "the highest level any state sample observed",
  turns: "driver turns the provider reported usage for; model responses where nothing reported",
  duration: "active time: the stretches between a pause and its resume are not charged",
  cost: "what the provider says it charged; blank where nothing was reported, never the estimate",
};

/* -------------------------------------------------------------- readings */

/**
 * The public projection replaces a pause reason's free text with the fixed
 * `paused` token, so the detail there restates the status. Dropped rather
 * than printed: `paused (paused)` reads as a defect, not as a withheld field.
 */
export const OPAQUE_PAUSE_REASON = "paused";

/**
 * The pause a run takes when its observation stops arriving — `STALL_PAUSE` in
 * `runner/src/lapse.ts`, spelled out because the alias does not reach
 * `runner/src` (dashboard/test/runs.test.ts pins the two). The public
 * projection passes it through as itself, so both surfaces read it here.
 */
export const STALL_PAUSE_REASON = "observation-stalled";

/**
 * `stalled` is a pause with its own word: the run stopped because the world
 * it was recording stopped arriving, and until it is resumed its last rows
 * are a frozen reading, which "paused" alone would not tell a reader.
 */
export type RunStatus = "live" | "paused" | "stalled" | "ended";

/**
 * Live, paused, stalled, or ended.
 *
 * `live` is the viewer's own reading (the file is still being written) and is
 * trusted when present. A viewer that predates the field is read off what the
 * run recorded: a pause reason is a pause, a termination reason is an end, and
 * a run with neither is still going — which is what "neither" means, since the
 * runner writes one or the other on the way out.
 */
export function statusOf(r: Pick<ResultRun, "live" | "pauseReason" | "terminationReason">): RunStatus {
  if (r.pauseReason === STALL_PAUSE_REASON) return "stalled";
  if (r.pauseReason !== null) return "paused";
  if (r.live === true) return "live";
  if (r.terminationReason !== null) return "ended";
  return r.live === false ? "ended" : "live";
}

/** The status cell's text: the state, and the reason when there is one. */
export function statusText(r: Pick<ResultRun, "live" | "pauseReason" | "terminationReason">): string {
  const s = statusOf(r);
  // The public projection replaces the reason with the fixed `paused` token;
  // printing it would read "paused: paused", a defect rather than a withheld field.
  if (s === "paused") return r.pauseReason === OPAQUE_PAUSE_REASON ? "paused" : `paused: ${r.pauseReason}`;
  if (s === "stalled") return "stalled";
  if (s === "ended") return r.terminationReason ?? "ended";
  return "live";
}

/** The class a status is drawn in, on every surface that shows one. */
export function statusTone(s: RunStatus): "ok" | "warn" | "dim" {
  return s === "live" ? "ok" : s === "ended" ? "dim" : "warn";
}

/** The hover a status carries: only `stalled` needs one, the word being new. */
export function statusTitle(s: RunStatus): string | undefined {
  return s === "stalled"
    ? "paused because the event stream closed and the recorded state stopped moving"
    : undefined;
}

/**
 * What the run was for, in a word.
 *
 * A probe names its campaign and cell; freeplay is its own tier; an
 * objective run was steered and says so; anything else the server could not
 * score reads as `unscored` with the reason on hover; and a run the server
 * can score is `scored`, with `extra` marking one past the policy target.
 * The kind is a reading of fields the server decided, not a fifth way of
 * deciding them.
 */
export function kindOf(r: Pick<ResultRun, "campaign" | "cell" | "episode" | "unscored" | "extra">): string {
  if (r.campaign !== null) return `probe ${r.campaign}${r.cell === null ? "" : `/${r.cell}`}`;
  if (r.episode === "freeplay") return "freeplay";
  if (r.unscored !== null) return /objective/.test(r.unscored) ? "objective" : "unscored";
  return r.extra ? "scored (extra)" : "scored";
}

/** The turns column: reported usage turns first, model responses as the fallback. */
export function turnsOf(r: Pick<ResultRun, "tokens" | "modelResponses">): number | null {
  const t = r.tokens?.turns ?? null;
  return t !== null && t > 0 ? t : r.modelResponses;
}

/** The actual cost in dollars, or null for every kind of nothing. */
export function costOf(r: Pick<ResultRun, "actualCost">): number | null {
  const c = r.actualCost;
  if (c === null || c.basis === "none") return null;
  return c.usd;
}

/* ------------------------------------------------------------------ sort */

export type SortDir = "asc" | "desc";

export interface RunSort {
  column: RunColumn;
  dir: SortDir;
}

/** Newest first: the order the operator asked the page to open in. */
export const DEFAULT_SORT: RunSort = { column: "started", dir: "desc" };

/**
 * The `?sort=` and `?dir=` params, defaulted and validated. Anything that is
 * not a column falls back to the default rather than blanking the table over
 * a typo in a shared link.
 */
export function sortParam(sort: string | string[] | undefined, dir: string | string[] | undefined): RunSort {
  const s = Array.isArray(sort) ? sort[0] : sort;
  const d = Array.isArray(dir) ? dir[0] : dir;
  const column = (RUN_COLUMNS as readonly string[]).includes(s ?? "") ? (s as RunColumn) : DEFAULT_SORT.column;
  return { column, dir: d === "asc" || d === "desc" ? d : column === DEFAULT_SORT.column ? DEFAULT_SORT.dir : "asc" };
}

/**
 * The sort a header click produces: the same column flips direction, a new
 * column opens the way a reader expects — newest first for time, largest first
 * for a number, A to Z for a word.
 */
export function nextSort(current: RunSort, column: RunColumn): RunSort {
  if (current.column === column) return { column, dir: current.dir === "asc" ? "desc" : "asc" };
  return { column, dir: NUMERIC.has(column) || column === "started" ? "desc" : "asc" };
}

const NUMERIC = new Set<RunColumn>(["level", "turns", "duration", "cost"]);

/** The sort as URL params; the default spells as nothing, so the plain link is the plain view. */
export function sortQuery(sort: RunSort): Record<string, string | null> {
  const isDefault = sort.column === DEFAULT_SORT.column && sort.dir === DEFAULT_SORT.dir;
  return isDefault ? { sort: null, dir: null } : { sort: sort.column, dir: sort.dir };
}

/** The value a column sorts on. Null is "not recorded" and always sorts last. */
export function sortKey(r: ResultRun, column: RunColumn): number | string | null {
  switch (column) {
    case "started":
      return r.startedAt;
    case "run":
      return r.runId;
    case "model":
      return r.model;
    case "harness":
      return r.harnessSeries === null ? (r.harnessVersion ?? null) : `${r.harnessSeries} ${r.harness ?? ""}`;
    case "effort":
      return r.effort;
    case "kind":
      return kindOf(r);
    case "episode":
      return r.episode;
    case "character":
      // Sorts the way the column reads: the name first, the race/class label
      // beneath it (and alone when a run has no name recorded).
      return r.character ?? r.characterLabel;
    case "status":
      return statusText(r);
    case "level":
      return r.maxLevel;
    case "turns":
      return turnsOf(r);
    case "duration":
      return r.playtimeMs;
    case "cost":
      return costOf(r);
  }
}

/**
 * Sort a copy. Stable: ties fall through to start time (newest first) and then
 * the run id, so two polls of the same data produce the same table and a
 * column with many equal values does not reshuffle under the reader.
 */
export function sortRuns(runs: readonly ResultRun[], sort: RunSort): ResultRun[] {
  const sign = sort.dir === "asc" ? 1 : -1;
  return [...runs].sort((a, b) => {
    const ka = sortKey(a, sort.column);
    const kb = sortKey(b, sort.column);
    if (ka !== kb) {
      if (ka === null) return 1;
      if (kb === null) return -1;
      const c = typeof ka === "number" && typeof kb === "number" ? ka - kb : String(ka).localeCompare(String(kb));
      if (c !== 0) return c * sign;
    }
    if (a.startedAt !== b.startedAt) {
      if (a.startedAt === null) return 1;
      if (b.startedAt === null) return -1;
      return b.startedAt - a.startedAt;
    }
    return a.runId.localeCompare(b.runId);
  });
}

/* --------------------------------------------------------------- filters */

/**
 * The narrowing a link may carry. Every one is a plain equality on a field
 * the row shows, and every one is optional: the page opens on all runs.
 * `effort` is only meaningful with `model`, because `(model, effort)` is the
 * pair the roster matches runs on (`runFilterQuery` in `lib/models.ts`).
 */
export interface RunFilter {
  model: string | null;
  effort: string | null;
  episode: string | null;
  harness: string | null;
  character: string | null;
  campaign: string | null;
}

function str(v: string | string[] | undefined): string | null {
  const s = Array.isArray(v) ? v[0] : v;
  return s === undefined || s === "" || s === "all" ? null : s;
}

export function filterParams(params: Record<string, string | string[] | undefined>): RunFilter {
  return {
    model: str(params.model),
    effort: str(params.effort),
    episode: str(params.episode),
    harness: str(params.harness),
    character: str(params.character),
    campaign: str(params.campaign),
  };
}

export function isFiltered(f: RunFilter): boolean {
  return Object.values(f).some((v) => v !== null);
}

/** The filter, as `field: value` pairs, for the "filtered to …" line. */
export function filterLabel(f: RunFilter): string {
  return (Object.entries(f) as [keyof RunFilter, string | null][])
    .filter((e): e is [keyof RunFilter, string] => e[1] !== null)
    .map(([k, v]) => `${k}=${v}`)
    .join(" ");
}

/**
 * Apply the filter. An absent `effort` under a present `model` means "the
 * entry with no effort", never "any effort" — the same reading the models page
 * links with, so its `2/3` lands on exactly those runs.
 */
export function filterRuns(runs: readonly ResultRun[], f: RunFilter): ResultRun[] {
  return runs.filter(
    (r) =>
      (f.model === null || (r.model === f.model && (r.effort ?? null) === f.effort)) &&
      (f.episode === null || r.episode === f.episode) &&
      (f.harness === null || r.harness === f.harness) &&
      (f.character === null || r.characterLabel === f.character) &&
      (f.campaign === null || r.campaign === f.campaign),
  );
}

/** The runs page, filtered and sorted — one spelling for every page that links here. */
export function runsHref(f: Partial<RunFilter> & { sort?: RunSort } = {}): string {
  const q = new URLSearchParams();
  for (const k of ["episode", "model", "effort", "harness", "character", "campaign"] as const) {
    const v = f[k];
    if (v !== undefined && v !== null && v !== "" && v !== "all") q.set(k, v);
  }
  if (f.sort !== undefined) {
    for (const [k, v] of Object.entries(sortQuery(f.sort))) if (v !== null) q.set(k, v);
  }
  const s = q.toString();
  return s === "" ? "/runs" : `/runs?${s}`;
}
