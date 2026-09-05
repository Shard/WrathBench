/**
 * The harness *series* selection: one global filter, in the top bar.
 *
 * A series is the `major.minor` of a harness version stamp — `harness-0.5-12-gabc`
 * is series `0.5`. This is the comparability group: a minor bump changes what
 * a run measures and restarts the evidence, a fix commit does not. Every page
 * that shows runs is therefore a view of one series, and the operator decided
 * that choice belongs once in the shell rather than on each page.
 *
 * Not to be confused with the `?harness=` filter (`wrathbench`, `claude-code`
 * or `codex`), which selects which *loop* owned a run. Different dimension,
 * unfortunate shared word; both filters coexist.
 *
 * Everything here is pure so it can be tested without a DOM (dashboard/README.md).
 * `harnessSeries` is re-derived rather than imported: `runner/src/comparability.ts`
 * is not one of the import-free modules the `@viewer/*` alias may cross.
 */

/**
 * The series of a version stamp, or null when the stamp names none.
 *
 * Mirrors `harnessSeries` in `runner/src/comparability.ts`; the cases in
 * `dashboard/test/harness.test.ts` are the ones that file's own test pins, so a
 * drift shows up as a failing test on this side rather than as two surfaces
 * quietly disagreeing about which group a run is in.
 */
export function seriesOf(version: string | null | undefined): string | null {
  if (version === null || version === undefined) return null;
  let v = version.trim();
  const wrapped = /^0\.0\.0-phase0\+g(.+)$/.exec(v);
  if (wrapped !== null) v = wrapped[1]!;
  if (v.startsWith("0.0.0")) return null;
  const m = /^(?:harness-)?v?(\d+)\.(\d+)(?:[.-]|$)/.exec(v);
  return m === null ? null : `${m[1]}.${m[2]}`;
}

/** Newest first: major descending, then minor descending. `0.10` outranks `0.9`. */
export function compareSeriesDesc(a: string, b: string): number {
  const pa = a.split(".").map((n) => Number.parseInt(n, 10));
  const pb = b.split(".").map((n) => Number.parseInt(n, 10));
  return (pb[0]! - pa[0]!) || (pb[1]! - pa[1]!);
}

/** The distinct series present in some run data, newest first. Nulls drop out. */
export function seriesPresent(
  rows: readonly { harnessSeries?: string | null; harnessVersion?: string | null }[],
): string[] {
  const seen = new Set<string>();
  for (const r of rows) {
    const s = r.harnessSeries ?? seriesOf(r.harnessVersion);
    if (s !== null && s !== undefined) seen.add(s);
  }
  return [...seen].sort(compareSeriesDesc);
}

/** The newest of a list of series, or null when there are none. */
export function latestSeries(available: readonly string[]): string | null {
  return available.length === 0 ? null : [...available].sort(compareSeriesDesc)[0]!;
}

/**
 * The selection. `latest` is stored as the token, never as the series it
 * resolves to today: the operator asked for "latest", which must follow a
 * minor bump rather than freeze on the series that was newest when they picked.
 */
export type SeriesChoice = "all" | "latest" | (string & {});

export const SERIES_ALL = "all";
export const SERIES_LATEST = "latest";

/**
 * The `?series=` search param: shape-checked, not membership-checked.
 *
 * Deliberately not validated against the available list. That list arrives on a
 * poll, so a link to `?series=0.4` opened cold would otherwise be rejected in
 * the first frame and silently rewritten to something else. Whether a series
 * has any runs is `resolveSeries`'s question — it falls back to latest there,
 * because a filter that selects nothing looks exactly like a broken page.
 * Anything not shaped like a choice reads as "unset" so the caller falls back.
 */
export function seriesParam(raw: string | string[] | undefined): SeriesChoice | null {
  const v = Array.isArray(raw) ? raw[0] : raw;
  if (v === undefined || v === "") return null;
  if (v === SERIES_ALL || v === SERIES_LATEST) return v;
  return /^\d+\.\d+$/.test(v) ? v : null;
}

/** What a choice actually filters to: a series, or null for "no filter". */
export function resolveSeries(choice: SeriesChoice, available: readonly string[]): string | null {
  if (choice === SERIES_ALL) return null;
  if (choice === SERIES_LATEST) return latestSeries(available);
  return available.includes(choice) ? choice : latestSeries(available);
}

/**
 * The choice the control should *display*, which is not always the one stored.
 *
 * A link to `?series=0.3` opened when no run carries 0.3 resolves to `latest`
 * (see `resolveSeries`), and a control still reading "0.3" over a page showing
 * 0.5 would be lying about what the reader is looking at. An empty list is
 * "availability not known yet", where the link is taken at its word.
 */
export function displayedChoice(choice: SeriesChoice, available: readonly string[]): SeriesChoice {
  if (choice === SERIES_ALL || choice === SERIES_LATEST) return choice;
  if (available.length === 0) return choice;
  return available.includes(choice) ? choice : SERIES_LATEST;
}

export interface SeriesOption {
  value: SeriesChoice;
  label: string;
}

/**
 * The dropdown's options, in the order the operator asked for: all first, then
 * latest, then the series descending. Latest carries the series it currently
 * means, so the reader is never guessing which one they are on.
 *
 * The newest series appears *both* as `latest` and under its own number, which
 * looks redundant and is not: `latest` tracks the next minor bump, its number
 * pins. A link that means "0.5 specifically" has to survive a bump, and a
 * selection the option list cannot represent renders as a blank control.
 */
export function seriesOptions(available: readonly string[], current?: SeriesChoice): SeriesOption[] {
  const all = [...available];
  // A selection the list does not (yet) hold still has to be an option, or the
  // control renders blank: the list arrives on a poll, and a viewer that
  // predates it serves none at all.
  if (current !== undefined && current !== SERIES_ALL && current !== SERIES_LATEST && !all.includes(current)) {
    all.push(current);
  }
  const sorted = all.sort(compareSeriesDesc);
  const latest = sorted[0];
  const out: SeriesOption[] = [{ value: SERIES_ALL, label: "all" }];
  out.push({ value: SERIES_LATEST, label: latest === undefined ? "latest" : `latest (${latest})` });
  for (const s of sorted) out.push({ value: s, label: s });
  return out;
}

/**
 * Keep only the rows in a series. `null` keeps everything.
 *
 * A run whose stamp names no series is a member of no group, so it survives
 * only under "all" — the same rule applies to untiered runs.
 */
export function filterBySeries<T extends { harnessSeries?: string | null; harnessVersion?: string | null }>(
  rows: readonly T[],
  series: string | null,
): T[] {
  if (series === null) return [...rows];
  return rows.filter((r) => (r.harnessSeries ?? seriesOf(r.harnessVersion)) === series);
}

/**
 * The series a page should filter to, given the shell's choice.
 *
 * The shell learns the available series from `/api/info`, but a viewer process
 * that predates that field serves none — and the dashboard has to keep working
 * against it until the operator restarts the viewer. So a page unions what the
 * shell knows with what its own rows carry: with the field absent, "latest"
 * still resolves, off the data on screen.
 */
export function pageSeries(
  choice: SeriesChoice,
  shellAvailable: readonly string[],
  rows: readonly { harnessSeries?: string | null; harnessVersion?: string | null }[],
): string | null {
  const available = [...new Set([...shellAvailable, ...seriesPresent(rows)])];
  return resolveSeries(choice, available);
}

/**
 * What the series filter removed, so a page can say so.
 *
 * A chart that silently drops rows is a lie of omission — the rule the episode
 * filter already follows (`EpisodeFilterNote`), applied to this filter too.
 */
export function seriesFilteredOut(total: number, kept: number): number {
  return Math.max(0, total - kept);
}

const PREF_KEY = "wrathbench.harnessSeries";

/** The remembered choice, or null. Blocked storage reads as "nothing remembered". */
export function readSeriesPref(): SeriesChoice | null {
  try {
    const v = localStorage.getItem(PREF_KEY);
    return v === null || v === "" ? null : v;
  } catch {
    return null;
  }
}

export function writeSeriesPref(value: SeriesChoice): void {
  try {
    localStorage.setItem(PREF_KEY, value);
  } catch {
    /* see readSeriesPref: not persisting is the only consequence */
  }
}
