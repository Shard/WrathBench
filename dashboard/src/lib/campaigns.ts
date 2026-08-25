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
