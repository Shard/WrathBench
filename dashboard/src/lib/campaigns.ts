/**
 * The campaigns page's join: which runs of a campaign are live right now, and
 * what the supervisor is doing with each of them.
 *
 * Two feeds already on the page's hands, joined here rather than server-side.
 * `/api/runs` is the filesystem's view and is the one that carries campaign
 * attribution per run (`campaign`/`cell`, read off the run's own config), so
 * membership is decided there; `/api/fleet` is the supervisor's view and is
 * joined **by run id** for the state, the account and the attempt. Never by
 * job name: a pinned campaign's job is `<campaign>-<cell>` but a policy-
 * launched probe's is not, and a page that parsed either would be wrong about
 * half of them.
 *
 * Liveness is `terminationReason === null`, the same rule `campaignsResponse`
 * counts `live` with (runner/viewer/api.ts), so the rows here and the "· N
 * live" beside the heading cannot disagree. A run matching that rule which no
 * job holds keeps `state: null` — rendered as "no job", never defaulted to
 * running. That is the honest reading of an orphan and the only way one is
 * visible at all.
 */

import type { CampaignColumnView, CampaignRowView, CampaignSquareView, FleetResponse, RunListRow } from "@viewer/api-types";
import { fleetRows, type FleetRow, type FleetRowState } from "./fleet";

/** One live run of a campaign, as a pane lists it. */
export interface CampaignRunRow {
  runId: string;
  /** The cell it was commissioned for; null when the run recorded none. */
  cell: string | null;
  /** The character being driven, and the model driving it. */
  character: string | null;
  model: string | null;
  level: number | null;
  xp: number | null;
  /** Active time in the episode, and the run's own recorded watchdog. */
  elapsedMs: number | null;
  budgetMs: number | null;
  /** The supervisor's verdict on the job driving it; null when no job holds it. */
  state: FleetRowState | null;
  /** The account the job runs on, and which attempt this is; null with no job. */
  account: string | null;
  attempt: number | null;
}

/**
 * The key a campaign VERSION's pane is filed under: `race-probe@1`, or
 * `name@?` for a campaign no definition claims a version of. One spelling for
 * the panes, the live rows and the costs, so the three always line up.
 */
export function campaignRowKey(campaign: string, version: number | null | undefined): string {
  return `${campaign}@${version ?? "?"}`;
}

/** The shape `rowProgress` reads, so a campaign row reuses the fleet's ETA maths. */
export function progressOf(row: CampaignRunRow): Pick<FleetRow, "state" | "episode" | "elapsedMs" | "budgetMs"> | null {
  if (row.state === null) return null;
  // Every probe is a `probing` run; the episode is not read by `rowProgress`
  // (no name gate survives there — see lib/fleet.ts) and is carried only
  // because the shape asks for it.
  return { state: row.state, episode: "probing", elapsedMs: row.elapsedMs, budgetMs: row.budgetMs };
}

/**
 * Every live run, grouped by the campaign version it belongs to (`campaignRowKey`).
 *
 * `fleet` is optional and may be a response with `present: false` — the fleet
 * has never run on this machine, or has not been polled yet — in which case
 * there is nothing to join against and every row keeps `state: null`. The runs
 * feed alone is enough to list them.
 *
 * Rows sort by cell, then by run id, so a pane's order does not move under a
 * reader as the poll ticks.
 */
export function campaignLiveRuns(
  fleet: FleetResponse | undefined,
  runs: readonly RunListRow[],
): Map<string, CampaignRunRow[]> {
  const jobs = new Map<string, FleetRow>();
  if (fleet !== undefined && fleet.present === true) {
    // One derivation of the fleet table, reused: the campaign panes show fewer
    // columns of the same row, they do not compute a second version of it.
    for (const row of fleetRows(fleet, runs)) {
      if (row.runId !== null) jobs.set(row.runId, row);
    }
  }
  const out = new Map<string, CampaignRunRow[]>();
  for (const run of runs) {
    if (run.campaign === null || run.terminationReason !== null) continue;
    const job = jobs.get(run.runId);
    const row: CampaignRunRow = {
      runId: run.runId,
      cell: run.cell,
      character: run.character,
      model: run.model,
      level: run.level,
      xp: run.xp,
      elapsedMs: run.playtimeMs,
      budgetMs: run.comparability?.budget.episodeMs ?? null,
      state: job?.state ?? null,
      account: job?.account ?? null,
      attempt: job?.attempt ?? null,
    };
    const key = campaignRowKey(run.campaign, run.campaignVersion);
    const list = out.get(key);
    if (list === undefined) out.set(key, [row]);
    else list.push(row);
  }
  for (const list of out.values()) {
    list.sort((a, b) => (a.cell ?? "").localeCompare(b.cell ?? "") || a.runId.localeCompare(b.runId));
  }
  return out;
}

/**
 * What a campaign's runs were billed, as a sum with its coverage beside it.
 *
 * Summed over the `/api/runs` rows the page already polls, whose `cost` the
 * viewer builds off the stored per-run totals (`listWithTotals` in
 * runner/viewer/api.ts): no campaign query of its own, because a listing
 * query per campaign is the shape that ran the store out of memory.
 *
 * Only a provider's billed figure counts — `cost.actual` with a `reported`
 * basis, never `cost` itself, whose top-level fields are the list-price
 * estimate. A subscription run's reported figure is as-if-metered money that
 * nobody was charged, so it is counted beside the sum and never in it; a codex
 * run reports nothing at all and lands in neither. Null when no run reported a
 * charge, which is not the same claim as $0.
 */
export interface CampaignCost {
  actualUsd: number | null;
  /** Runs the sum covers. */
  reported: number;
  /** Runs whose only reported figure is a subscription's as-if-metered one. */
  asIfMetered: number;
  /** Every run recorded against the campaign — live, failed and re-swept included. */
  runs: number;
}

export function campaignCosts(runs: readonly RunListRow[]): Map<string, CampaignCost> {
  const out = new Map<string, CampaignCost>();
  for (const run of runs) {
    if (run.campaign === null) continue;
    const key = campaignRowKey(run.campaign, run.campaignVersion);
    let c = out.get(key);
    if (c === undefined) {
      c = { actualUsd: null, reported: 0, asIfMetered: 0, runs: 0 };
      out.set(key, c);
    }
    c.runs += 1;
    const actual = run.cost?.actual ?? null;
    if (actual === null || actual.basis !== "reported" || actual.usd === null) continue;
    if (actual.asIfMetered) {
      c.asIfMetered += 1;
      continue;
    }
    c.reported += 1;
    c.actualUsd = (c.actualUsd ?? 0) + actual.usd;
  }
  return out;
}

/* ------------------------------------------------------------------ the grid */

/**
 * A campaign version's state word and its class, from the row alone. A
 * finished sweep reads quieter than a running one (same green, faded), so the
 * vivid word on the page always means something is happening there.
 */
export function campaignState(row: CampaignRowView): { label: string; cls: string } {
  if (row.definition === null) return { label: "retired", cls: "dim" };
  if (row.definition.status === "closed") return { label: "closed", cls: "dim" };
  if (row.config === null || row.config.want === 0) return { label: "unassigned", cls: "dim" };
  if (row.config.complete) return { label: "complete", cls: "ok-muted" };
  if (!row.config.enabled) return { label: "off", cls: "warn" };
  return { label: "sweeping", cls: "ok" };
}

/** `3/19 runs` when the store row says what it wants; `5 runs` when nothing does. */
export function campaignCoverage(row: CampaignRowView): string {
  const plural = (n: number): string => (n === 1 ? "run" : "runs");
  if (row.config === null || row.config.want === 0) return `${row.runs} ${plural(row.runs)}`;
  return `${row.runs}/${row.config.want} ${plural(row.config.want)}`;
}

/** A grid column's heading: the model as the rest of the dashboard shows it, its effort and its compaction window. */
export function columnLabel(col: CampaignColumnView, display: (model: string) => string): string {
  return [display(col.model), col.effort, col.compactWindow].filter((x): x is string => x !== null && x !== undefined).join(" ");
}

/** Its hover: the identity the column keys on, and the assignment that owns it. */
export function columnTitle(col: CampaignColumnView): string {
  return [
    col.model,
    col.effort === null ? null : `effort ${col.effort}`,
    col.compactWindow === null || col.compactWindow === undefined ? null : `compact window ${col.compactWindow}`,
    col.harness,
    col.series === null ? null : `series ${col.series}`,
    col.assignment === null ? "not assigned" : `assigned as ${col.assignment}`,
  ]
    .filter((x): x is string => x !== null)
    .join(" · ");
}

/**
 * What one cell × model square says, as text. With a stop level: counted runs
 * that reached it out of counted runs, then the median minutes of play to it.
 * Without one: the best level. `*` marks a square holding a run whose recorded
 * start is not the cell's declared one.
 */
export function squareText(sq: CampaignSquareView | null, target: number | null): string {
  if (sq === null) return "";
  const mark = sq.mismatched > 0 ? "*" : "";
  if (sq.runs === 0 && sq.live === 0) return "·";
  if (sq.runs === 0) return "live";
  if (target !== null) {
    const head = `${sq.reached ?? 0}/${sq.counted}`;
    return sq.minutesToTarget === null ? `${head}${mark}` : `${head} ${sq.minutesToTarget.median}m${mark}`;
  }
  return sq.bestLevel === null ? `—${mark}` : `L${sq.bestLevel}${mark}`;
}

/** The square's hover: every number it rests on, one line. */
export function squareTitle(sq: CampaignSquareView | null, target: number | null): string {
  if (sq === null) return "not assigned";
  if (sq.runs === 0 && sq.live === 0) return "assigned, not run yet";
  const parts: string[] = [];
  if (target !== null) parts.push(`${sq.reached ?? 0} of ${sq.counted} counted ${sq.counted === 1 ? "run" : "runs"} reached L${target}`);
  if (sq.minutesToTarget !== null) {
    const m = sq.minutesToTarget;
    parts.push(`${m.min}/${m.median}/${m.max} min to L${target} (min/median/max)`);
  }
  if (sq.bestLevel !== null) parts.push(`best L${sq.bestLevel}`);
  if (sq.runs > sq.counted) parts.push(`${sq.runs - sq.counted} not counted`);
  if (sq.live > 0) parts.push(`${sq.live} live`);
  if (sq.mismatched > 0) parts.push(`${sq.mismatched} ran as another start`);
  return parts.join(" · ");
}

/** The class a square's text takes: green once the target was reached, dim while nothing counts yet. */
export function squareClass(sq: CampaignSquareView | null, target: number | null): string {
  if (sq === null || sq.counted === 0) return "right mono dim";
  if (target !== null && (sq.reached ?? 0) > 0) return "right mono ok";
  return "right mono";
}
