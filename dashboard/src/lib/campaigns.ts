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

import type { FleetResponse, RunListRow } from "@viewer/api-types";
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

/** The shape `rowProgress` reads, so a campaign row reuses the fleet's ETA maths. */
export function progressOf(row: CampaignRunRow): Pick<FleetRow, "state" | "episode" | "elapsedMs" | "budgetMs"> | null {
  if (row.state === null) return null;
  // Every probe is a `probing` run; the episode is not read by `rowProgress`
  // (no name gate survives there — see lib/fleet.ts) and is carried only
  // because the shape asks for it.
  return { state: row.state, episode: "probing", elapsedMs: row.elapsedMs, budgetMs: row.budgetMs };
}

/**
 * Every live run, grouped by the campaign that commissioned it.
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
    const list = out.get(run.campaign);
    if (list === undefined) out.set(run.campaign, [row]);
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
    let c = out.get(run.campaign);
    if (c === undefined) {
      c = { actualUsd: null, reported: 0, asIfMetered: 0, runs: 0 };
      out.set(run.campaign, c);
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
