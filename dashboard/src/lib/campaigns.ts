/**
 * The campaigns page's words: what each figure `/api/campaigns` serves reads
 * as on the page.
 *
 * Nothing here derives what the API already decided. A campaign's state, its
 * progress, which squares are live and what it cost arrive computed by the
 * counting the scheduler also uses, so the page cannot disagree with the
 * supervisor about whether a campaign is done, and it never joins `/api/runs`
 * or the fleet to find out. This module labels: a class for a state, a string
 * and a hover for a square, header spans for the grid.
 *
 * Nothing is ranked either. Cells keep the definition's order, columns the
 * assignments' and then the arms', and the arm comparison lists arms as the
 * definition does: `probing` has no comparability group (docs/METHODOLOGY.md),
 * so control and treatment sit side by side and the reader compares them.
 */

import { characterLabel } from "@viewer/characters";
import type { ArmSummary, CampaignsResponse, CampaignView, Square } from "@viewer/api-types";
import { effortLabel, fmtDuration, fmtTokens, fmtUsd, modelDisplay, shortHarness } from "./format";

export type CampaignState = CampaignView["state"];
export type CampaignArm = CampaignView["arms"][number];
export type CampaignCell = CampaignView["cells"][number];
export type CampaignColumn = CampaignView["columns"][number];
type Progress = CampaignView["progress"];

/** `1 run` / `3 runs`. */
function plural(n: number, word: string): string {
  return `${n} ${n === 1 ? word : `${word}s`}`;
}

/* ----------------------------------------------------------------- routes */

/** A campaign's own page. The version is a path segment, so two versions are two addresses. */
export function campaignHref(c: Pick<CampaignView, "id" | "version">): string {
  return `/campaigns/${encodeURIComponent(c.id)}/${c.version}`;
}

/** The campaign a `/campaigns/:id/:version` route names, or undefined when none is published under it. */
export function findCampaign(body: CampaignsResponse, id: string, version: string): CampaignView | undefined {
  return body.campaigns.find((c) => c.id === id && String(c.version) === version);
}

/* ------------------------------------------------------------------ state */

/**
 * A state word's class. Something happening is the vivid green; a finished
 * sweep is the same green faded, so the vivid word always means motion; an
 * operator's off switch is the warning; a campaign nothing is assigned to is
 * dim. Queued is plain: enabled and owed, nothing wrong with it.
 */
export function stateClass(state: CampaignState): string {
  switch (state) {
    case "running":
      return "ok";
    case "complete":
      return "ok-muted";
    case "disabled":
      return "warn";
    case "unassigned":
      return "dim";
    case "queued":
      return "";
  }
}

/** The state word's hover. */
export function stateTitle(state: CampaignState): string {
  switch (state) {
    case "running":
      return "a run of it is live";
    case "queued":
      return "enabled, with runs owed and none live";
    case "complete":
      return "every square has its counted runs or has spent its attempts";
    case "disabled":
      return "the store row is switched off";
    case "unassigned":
      return "no store row names this version, or the row assigns no model";
  }
}

/**
 * `12/40`, or the bare count when nothing is wanted (an unassigned campaign).
 * What the attempt cap settled is named beside it: a capped square is settled
 * without its counted runs, so a complete campaign can read `10/12`, and
 * without the `· 2 capped` that would look like a stalled one.
 */
export function progressText(p: Progress): string {
  const capped = p.capped > 0 ? ` · ${p.capped} capped` : "";
  if (p.want === 0) return p.done === 0 ? `—${capped}` : `${p.done}${capped}`;
  return `${p.done}/${p.want}${capped}`;
}

/** Every number the progress figure rests on, one line. */
export function progressTitle(p: Progress): string {
  const parts = [`${p.done} of ${plural(p.want, "counted run")} done`, `${p.attempted} attempted`];
  if (p.capped > 0) parts.push(`${p.capped} capped: settled by the attempt cap without the runs owed`);
  if (p.live > 0) parts.push(`${p.live} live`);
  return parts.join(" · ");
}

/**
 * The cost figure's hover. The API sums what providers billed and nothing
 * else, so the hover says which figures are left out; nothing here re-sums it.
 */
export const COST_TITLE =
  "what the providers billed for this campaign's runs: reported charges only, never a list-price estimate or a subscription's as-if-metered figure; a dash when no run reported a charge";

/* ------------------------------------------------------------ text helpers */

/** A line cut to `max` characters with an ellipsis; the whole text belongs in the hover. */
export function truncate(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

/** The store rows a campaign is swept by, as roster names; a dash with no row. */
export function assignmentsText(c: Pick<CampaignView, "config">): string {
  if (c.config === null) return "—";
  if (c.config.assignments.length === 0) return "none";
  return c.config.assignments.map((a) => a.ref).join(", ");
}

/** Each assignment's runs owed per cell, for the hover. */
export function assignmentsTitle(c: Pick<CampaignView, "config">): string {
  if (c.config === null) return "no store row names this version";
  return c.config.assignments.map((a) => `${a.ref} · ${a.model} · ${a.runsPerCell}/cell`).join("\n");
}

/* ------------------------------------------------------------------- arms */

/**
 * An image ref without its registry and repository path, and with a digest
 * cut to twelve hex digits: `runner:harness-0.5-920`, `runner@sha256:0123456789ab`.
 * An arm with no image runs the fleet's release image, and says so.
 */
export function shortImage(image: string | null): string {
  if (image === null) return "release";
  const name = image.slice(image.lastIndexOf("/") + 1);
  return name.replace(/@(sha256:)([0-9a-f]{12})[0-9a-f]+$/i, "@$1$2");
}

/** The image's hover: the full ref, or what a missing one means. */
export function imageTitle(image: string | null): string {
  return image ?? "the fleet's release image at launch";
}

/** An argv as one line, quoting the words that would not survive a split. Dash when empty or absent. */
export function argvText(argv: readonly string[] | null): string {
  if (argv === null || argv.length === 0) return "—";
  return argv.map((a) => (a === "" || /[\s"'\\]/.test(a) ? JSON.stringify(a) : a)).join(" ");
}

/** One arm's hover in the grid header: its note, image and args. */
export function armTitle(arm: CampaignArm | undefined): string {
  if (arm === undefined) return "";
  return [arm.note ?? null, imageTitle(arm.image), arm.args.length > 0 ? argvText(arm.args) : null]
    .filter((x): x is string => x !== null)
    .join("\n");
}

/* ------------------------------------------------------------------- grid */

/** An assignment's heading: the model as the rest of the dashboard shows it, then its effort and compaction window. */
export function columnLabel(col: Pick<CampaignColumn, "model" | "effort" | "compactWindow">): string {
  const extra = effortLabel(col.effort, col.compactWindow);
  return extra === null ? modelDisplay(col.model) : `${modelDisplay(col.model)} · ${extra}`;
}

/** Its hover: the roster name the column belongs to and every part of the identity. */
export function assignmentTitle(col: Pick<CampaignColumn, "ref" | "model" | "effort" | "compactWindow" | "harness">): string {
  return [
    col.ref,
    col.model,
    col.effort === null ? null : `effort ${col.effort}`,
    col.compactWindow === null ? null : `compact window ${col.compactWindow}`,
    col.harness,
  ]
    .filter((x): x is string => x !== null)
    .join(" · ");
}

/** The assignment heading a comparison group reads under, from its columns; the bare ref when no column names it. */
export function assignmentLabel(c: Pick<CampaignView, "columns">, ref: string): { label: string; title: string } {
  const col = c.columns.find((x) => x.ref === ref);
  return col === undefined ? { label: ref, title: ref } : { label: columnLabel(col), title: assignmentTitle(col) };
}

/** One header span: an assignment over its arms. */
export interface ColumnGroup {
  ref: string;
  first: CampaignColumn;
  span: number;
}

/**
 * The grid's first header row: consecutive columns of one assignment under one
 * heading. Columns arrive grouped by assignment, so this is a run-length pass;
 * a ref that came back later would get a second heading rather than be pulled
 * out of the order it was served in.
 */
export function columnGroups(columns: readonly CampaignColumn[]): ColumnGroup[] {
  const out: ColumnGroup[] = [];
  for (const col of columns) {
    const last = out[out.length - 1];
    if (last !== undefined && last.ref === col.ref) last.span += 1;
    else out.push({ ref: col.ref, first: col, span: 1 });
  }
  return out;
}

/** One grid row: the cell, its start, and its squares aligned to the columns. */
export interface GridRow {
  cell: CampaignCell;
  /** "Dwarf Warrior". */
  start: string;
  squares: (Square | null)[];
}

/**
 * The grid's body, one row per cell in the definition's order. Squares are
 * matched to columns by `column` key, not by position, so a square the API
 * left out is a gap in its own column rather than a shift of every square
 * after it.
 */
export function gridRows(c: Pick<CampaignView, "cells" | "columns" | "grid">): GridRow[] {
  return c.cells.map((cell) => {
    const row = c.grid.find((r) => r.cell === cell.id);
    const byColumn = new Map((row?.squares ?? []).map((sq) => [sq.column, sq]));
    return {
      cell,
      start: characterLabel(cell.race, cell.class) ?? "—",
      squares: c.columns.map((col) => byColumn.get(col.key) ?? null),
    };
  });
}

/**
 * What a square says. With a stop level: the counted runs that reached it out
 * of the counted runs, then the median minutes of play to it. Without one: the
 * best level. `·` is owed and not started; a square whose only run is live
 * says nothing, because its live marker already does. `*` marks a run whose
 * recorded start is not the cell's.
 *
 * Two settled states say so in words, because neither is owed any more and
 * a figure would read as a sweep still going: `refused` is a pair that cannot
 * launch as configured and has not run, `capped` a square that spent its
 * attempts without a counted run.
 *
 * `runs` is the square's ended runs, counted or not, and `live` the ones in
 * flight.
 */
export function squareText(sq: Square | null, stop: number | null): string {
  if (sq === null) return "";
  if (isRefused(sq) && sq.runs === 0 && sq.live === 0) return "refused";
  if (sq.settled === "capped" && sq.counted === 0) return "capped";
  if (sq.runs === 0) return sq.live > 0 ? "" : "·";
  const mark = sq.mismatchedStart > 0 ? "*" : "";
  if (stop !== null) {
    const head = `${sq.reached}/${sq.counted}`;
    return sq.minutesToStop === null ? `${head}${mark}` : `${head} ${sq.minutesToStop.median}m${mark}`;
  }
  return sq.bestLevel === null ? `—${mark}` : `L${sq.bestLevel}${mark}`;
}

/** Whether a square's (assignment, arm) pair is refused before launch. */
function isRefused(sq: Square): sq is Square & { refused: string } {
  return typeof sq.refused === "string";
}

/** The square's hover: a refusal first, then every number it rests on, then its builds. */
export function squareTitle(sq: Square | null, stop: number | null): string {
  if (sq === null) return "no square served for this column";
  const refusal = isRefused(sq) ? `refused: ${sq.refused}` : null;
  const wanted = sq.want === undefined ? null : `${sq.want} counted ${sq.want === 1 ? "run" : "runs"} wanted`;
  if (sq.runs === 0 && sq.live === 0 && sq.settled !== "capped") {
    const owed = refusal === null ? (wanted === null ? "owed, not run yet" : `owed: ${wanted}`) : null;
    return [refusal, owed].filter((x): x is string => x !== null).join("\n");
  }
  const parts: string[] = [];
  if (stop !== null) parts.push(`${sq.reached} of ${plural(sq.counted, "counted run")} reached L${stop}`);
  if (sq.minutesToStop !== null) {
    const m = sq.minutesToStop;
    parts.push(`${m.min}/${m.median}/${m.max} min to L${stop} (min/median/max)`);
  }
  if (sq.bestLevel !== null) parts.push(`best L${sq.bestLevel}`);
  if (sq.runs > sq.counted) parts.push(`${sq.runs - sq.counted} not counted`);
  if (sq.live > 0) parts.push(`${sq.live} live`);
  if (sq.mismatchedStart > 0) parts.push(`${sq.mismatchedStart} ran as another start`);
  if (sq.costUsd !== null) parts.push(`${fmtUsd(sq.costUsd)} billed`);
  if (sq.settled === "capped") parts.push("capped: its attempts are spent without the counted runs it wanted");
  if (wanted !== null) parts.push(wanted);
  const lines = refusal === null ? [parts.join(" · ")] : [refusal, parts.join(" · ")];
  if (sq.builds.length > 0) lines.push(`${sq.builds.length === 1 ? "build" : "builds"} ${sq.builds.map(shortHarness).join(", ")}`);
  return lines.join("\n");
}

/** A square's class: green once its stop level was reached, the error colour while refused with nothing run, dim while nothing counts. */
export function squareClass(sq: Square | null, stop: number | null): string {
  if (sq !== null && isRefused(sq) && sq.runs === 0 && sq.live === 0) return "right mono err";
  if (sq === null || sq.counted === 0) return "right mono dim";
  if (stop !== null && sq.reached > 0) return "right mono ok";
  return "right mono";
}

/**
 * Where a square leads. One run is that run's page. Several are a list on the
 * campaign's own page (`?cell=&column=`), because no runs-page filter narrows
 * to one cell of one arm and the order of `runIds` promises no "newest" to
 * pick. None is nowhere.
 */
export function squareHref(c: Pick<CampaignView, "id" | "version">, cell: string, sq: Square | null): string | null {
  if (sq === null || sq.runIds.length === 0) return null;
  if (sq.runIds.length === 1) return `/run/${encodeURIComponent(sq.runIds[0]!)}`;
  return `${campaignHref(c)}?${new URLSearchParams({ cell, column: sq.column }).toString()}`;
}

/** The square a `?cell=&column=` query names, when it names one with runs to list. */
export function selectedSquare(
  c: Pick<CampaignView, "cells" | "columns" | "grid">,
  cell: string | undefined,
  column: string | undefined,
): { cell: string; column: CampaignColumn; square: Square } | null {
  if (cell === undefined || column === undefined) return null;
  const col = c.columns.find((x) => x.key === column);
  const sq = c.grid.find((r) => r.cell === cell)?.squares.find((s) => s.column === column);
  if (col === undefined || sq === undefined || sq.runIds.length === 0) return null;
  return { cell, column: col, square: sq };
}

/* ------------------------------------------------------------ comparison */

/** How an arm's runs ended, most common first: `level-target 3 · episode-limit 1`. */
export function terminationMix(t: Readonly<Record<string, number>>): string {
  const rows = Object.entries(t)
    .filter(([, n]) => n > 0)
    .sort(([a, x], [b, y]) => y - x || a.localeCompare(b));
  return rows.length === 0 ? "—" : rows.map(([k, n]) => `${k} ${n}`).join(" · ");
}

/** The harness builds an arm's runs were stamped with, short. */
export function buildsText(builds: readonly string[]): string {
  return builds.length === 0 ? "—" : builds.map(shortHarness).join(", ");
}

/** One arm's comparison cells as text, in the table's column order after the arm id. */
export interface ArmRowText {
  runs: string;
  reached: string;
  minutes: string;
  turns: string;
  cost: string;
  /** Says how many of the figures behind the median are a subscription's as-if-metered one; "" when none are. */
  costTitle: string;
  promptTokens: string;
  terminations: string;
  builds: string;
}

export function armRowText(a: ArmSummary): ArmRowText {
  const whole = (n: number | null): string => (n === null ? "—" : String(Math.round(n)));
  return {
    runs: String(a.runs),
    reached: String(a.reached),
    minutes: a.medianMinutesToStop === null ? "—" : `${Math.round(a.medianMinutesToStop)}m`,
    turns: whole(a.medianTurnsToStop),
    // Unlike the campaign's billed total, the median takes a subscription's
    // as-if-metered figure (the only cost such an arm has), and is marked when
    // it did: the same `*` a partly reconstructed cost wears elsewhere.
    cost: `${fmtUsd(a.medianCostToStop)}${(a.costAsIfMetered ?? 0) > 0 && a.medianCostToStop !== null ? "*" : ""}`,
    costTitle:
      (a.costAsIfMetered ?? 0) > 0
        ? `* ${a.costAsIfMetered} of the figures behind this median ${a.costAsIfMetered === 1 ? "is" : "are"} a subscription's as-if-metered cost, which nobody was billed`
        : "",
    promptTokens: a.medianPromptTokensToStop === null ? "—" : fmtTokens(a.medianPromptTokensToStop),
    terminations: terminationMix(a.terminations),
    builds: buildsText(a.builds),
  };
}

/** The hover on a comparison median's heading. */
export function medianTitle(what: string, stop: number | null): string {
  return stop === null
    ? `median ${what}: this campaign sets no stop level`
    : `median ${what} to L${stop}, over the runs that reached it`;
}

/**
 * The refusals that belong to one campaign version: its pairs
 * (`<id>@<v>:<ref>:<arm>`), its definition (`campaign-defs/<id>@<v>`) and the
 * store row for its id (`campaigns/<id>`), which names some version of it.
 */
export function refusalsFor(body: Pick<CampaignsResponse, "refused">, c: Pick<CampaignView, "id" | "key">): CampaignsResponse["refused"] {
  return (body.refused ?? []).filter(
    (r) => r.key.startsWith(`${c.key}:`) || r.key === `campaign-defs/${c.key}` || r.key === `campaigns/${c.id}`,
  );
}

/** Where a definition was published from: path, short commit, and the branches that held it. */
export function sourceText(source: CampaignView["source"]): string {
  if (source === null) return "—";
  const branches = source.branch !== undefined && source.branch.length > 0 ? ` (${source.branch.join(", ")})` : "";
  return `${source.path} @ ${source.commit.slice(0, 8)}${branches}`;
}

/* ------------------------------------------------------------------ shape */

/** The play clock: ceiling, idle leash, no-XP leash. */
export function clockText(shape: Pick<CampaignView["shape"], "episodeMs" | "idleMs" | "noXpMs">): string {
  return [
    `${fmtDuration(shape.episodeMs)} play`,
    `${fmtDuration(shape.idleMs)} idle`,
    shape.noXpMs === null ? "no-xp off" : `${fmtDuration(shape.noXpMs)} no-xp`,
  ].join(" · ");
}

/** The wiki channel: off, on, or on with coordinates. */
export function wikiText(shape: Pick<CampaignView["shape"], "wiki" | "wikiCoords">): string {
  if (!shape.wiki) return "off";
  return shape.wikiCoords ? "on · coords" : "on";
}
