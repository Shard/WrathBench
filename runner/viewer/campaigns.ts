/**
 * `/api/campaigns`, built: the probe lane grouped by campaign VERSION, each
 * annotated with its checked-in definition and its store row, with the
 * cells × models grid the page draws.
 *
 * Built from the RUN DIRECTORY and only annotated from the definitions and the
 * store, which is the property that matters: a version that has been completed,
 * switched off and dropped from the store still has a row, because its runs
 * are what happened and its definition still attributes them. A row whose
 * campaign no definition claims is shown too — pretending a run did not happen
 * is worse than showing one with no home.
 *
 * The grid is a reading, never a ranking (docs/METHODOLOGY.md: `probing` has
 * no comparability group). A column is one model identity — model, effort,
 * harness tag and harness series — so a square never pools runs a ladder row
 * would keep apart; cells keep the definition's order and columns keep the
 * assignments' order, and nothing is sorted by a result.
 *
 * Pure over its inputs, so the page's numbers are testable without a server.
 */

import { CAMPAIGN_DEFS, cellOf, startMismatch, type CampaignDef } from "../src/campaign-defs";
import { campaignComplete, type Campaign, type ProbeRun } from "../src/campaigns";
import { sameRosterIdentity } from "../src/models";
import type {
  CampaignCellView,
  CampaignColumnView,
  CampaignRowView,
  CampaignSquareView,
  ResultRun,
} from "./api-types";
import { characterLabel } from "./characters";

/**
 * The roster as this builder needs it: names for assignments, and each entry's
 * identity — model, effort, claude-code compaction window — to map a run back
 * to one (`sameRosterIdentity`, the rule every other run→entry match uses).
 */
export interface CampaignsRoster {
  campaigns: readonly Campaign[];
  models: readonly { name: string; model: string; effort?: string | undefined; compactWindow?: string | undefined }[];
}

/** The page's whole body, minus the envelope `api.ts` adds. */
export interface CampaignsView {
  campaigns: CampaignRowView[];
  orphans: number;
}

/** The lower of two middles on an even count: a minute some run actually took, never an interpolation. */
function median(xs: readonly number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor((s.length - 1) / 2)]!;
}

/** Minutes of play to the first observed level at or above `target`, or null when the run never got there. */
function minutesTo(r: ResultRun, target: number): number | null {
  const mark = r.levels.find((l) => l.level >= target);
  if (mark === undefined || mark.playtimeMs === null) return null;
  return Math.round(mark.playtimeMs / 60_000);
}

function rowKey(campaign: string, version: number | null): string {
  return `${campaign}@${version ?? "?"}`;
}

function columnKey(r: { model: string; effort: string | null; compactWindow: string | null; harness: string | null; series: string | null }): string {
  return [r.model, r.effort ?? "", r.compactWindow ?? "", r.harness ?? "", r.series ?? ""].join("\u0000");
}

/** A result row's column identity. */
function identityOf(r: ResultRun & { model: string }): { model: string; effort: string | null; compactWindow: string | null; harness: string | null; series: string | null } {
  return { model: r.model, effort: r.effort ?? null, compactWindow: r.compactWindow ?? null, harness: r.harness ?? null, series: r.harnessSeries ?? null };
}

/**
 * Every campaign version with runs, a definition or a store row, in page
 * order: store rows first (the operator's own priority), then every other
 * checked-in version in registry order, then any campaign only the runs
 * remember.
 */
export function campaignsView(
  all: readonly ResultRun[],
  roster: CampaignsRoster,
  /** Whether a run counts toward its cell — the scheduler's own `isCounted`, over a result row. */
  counted: (r: ResultRun) => boolean,
  defs: readonly CampaignDef[] = CAMPAIGN_DEFS,
): CampaignsView {
  const probes = all.filter((r) => r.campaign !== null);
  const catalog = roster.models.map((m) => m.name);
  const refOf = (r: ResultRun): string | null => roster.models.find((m) => sameRosterIdentity(m, r))?.name ?? null;

  const order: { campaign: string; version: number | null }[] = [];
  const seen = new Set<string>();
  const add = (campaign: string, version: number | null): void => {
    const k = rowKey(campaign, version);
    if (seen.has(k)) return;
    seen.add(k);
    order.push({ campaign, version });
  };
  for (const c of roster.campaigns) add(c.name, c.version);
  for (const d of defs) add(d.id, d.version);
  for (const r of probes) add(r.campaign!, r.campaignVersion ?? null);

  const rows = order.map(({ campaign, version }): CampaignRowView => {
    const def = version === null ? undefined : defs.find((d) => d.id === campaign && d.version === version);
    const c = roster.campaigns.find((x) => x.name === campaign && x.version === version);
    const mine = probes.filter((r) => r.campaign === campaign && (r.campaignVersion ?? null) === version);
    const ended = mine.filter((r) => r.terminationReason !== null);
    const probeRuns: ProbeRun[] = ended.map((r) => ({
      campaign: r.campaign,
      version: r.campaignVersion ?? null,
      cell: r.cell,
      ref: refOf(r),
      counted: counted(r),
    }));
    const declared = def?.cells ?? [];
    const cellIds = [
      ...declared.map((x) => x.id),
      ...[...new Set(mine.map((r) => r.cell).filter((x): x is string => x !== null))].filter((id) => !declared.some((x) => x.id === id)),
    ];

    // Columns: every model identity that ran it, in the order the store row
    // assigns them where it does, first run otherwise; then each assignment
    // that has not run yet, so the grid shows what is owed as well as done.
    const assignmentOf = (id: { model: string; effort: string | null; compactWindow: string | null }): string | null =>
      c?.assignments.find((a) => {
        const e = roster.models.find((m) => m.name === a.model);
        return e !== undefined && sameRosterIdentity(e, id);
      })?.model ?? null;
    const columns: CampaignColumnView[] = [];
    for (const r of [...mine].sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0))) {
      if (r.model === null) continue;
      const col = identityOf(r as ResultRun & { model: string });
      const key = columnKey(col);
      if (columns.some((x) => x.key === key)) continue;
      columns.push({ key, ...col, assignment: assignmentOf(col) });
    }
    for (const a of c?.assignments ?? []) {
      if (columns.some((x) => x.assignment === a.model)) continue;
      const e = roster.models.find((m) => m.name === a.model);
      if (e === undefined) continue;
      const col = { model: e.model, effort: e.effort ?? null, compactWindow: e.compactWindow ?? null, harness: null, series: null };
      columns.push({ key: columnKey(col), ...col, assignment: a.model });
    }
    const assignmentIndex = (col: CampaignColumnView): number => {
      const i = c?.assignments.findIndex((a) => a.model === col.assignment) ?? -1;
      return i < 0 ? Number.MAX_SAFE_INTEGER : i;
    };
    // Stable: unassigned columns keep their first-run order behind the assigned ones.
    columns.sort((a, b) => assignmentIndex(a) - assignmentIndex(b));

    const target = def?.status === "open" ? def.stopAtLevel : null;
    const cells: CampaignCellView[] = [];
    const grid: (CampaignSquareView | null)[][] = [];
    for (const id of cellIds) {
      const decl = def === undefined ? undefined : cellOf(def, id);
      const runs = mine.filter((r) => r.cell === id);
      const mismatchedOf = (rs: readonly ResultRun[]): number =>
        rs.filter((r) => startMismatch(decl, { race: r.race, class: r.class })).length;
      const levels = runs.map((r) => r.maxLevel).filter((l): l is number => l !== null);
      cells.push({
        cell: id,
        declared: decl !== undefined,
        race: decl?.race ?? null,
        class: decl?.class ?? null,
        characterLabel: decl === undefined ? null : characterLabel(decl.race, decl.class),
        note: decl?.note ?? null,
        runs: runs.length,
        models: [...new Set(runs.map((r) => r.model).filter((m): m is string => m !== null))].sort(),
        bestLevel: levels.length > 0 ? Math.max(...levels) : null,
        mismatched: mismatchedOf(runs),
      });
      grid.push(
        columns.map((col): CampaignSquareView | null => {
          const sq = runs.filter((r) => r.model !== null && columnKey(identityOf(r as ResultRun & { model: string })) === col.key);
          if (sq.length === 0) return col.assignment !== null && decl !== undefined ? EMPTY_SQUARE(target) : null;
          const done = sq.filter((r) => r.terminationReason !== null);
          const good = done.filter(counted);
          const minutes = target === null ? [] : good.map((r) => minutesTo(r, target)).filter((m): m is number => m !== null);
          const lv = sq.map((r) => r.maxLevel).filter((l): l is number => l !== null);
          return {
            runs: done.length,
            live: sq.length - done.length,
            counted: good.length,
            reached: target === null ? null : good.filter((r) => (r.maxLevel ?? 0) >= target).length,
            minutesToTarget: minutes.length === 0 ? null : { min: Math.min(...minutes), median: median(minutes), max: Math.max(...minutes) },
            bestLevel: lv.length > 0 ? Math.max(...lv) : null,
            mismatched: mismatchedOf(sq),
          };
        }),
      );
    }

    const newest = mine.reduce<ResultRun | null>((a, b) => ((a?.startedAt ?? 0) >= (b.startedAt ?? 0) ? a : b), null);
    return {
      campaign,
      version,
      definition:
        def === undefined
          ? null
          : {
              status: def.status,
              question: def.question,
              stopAtLevel: def.status === "open" ? def.stopAtLevel : null,
              episodeMs: def.status === "open" ? def.budget.episodeMs : null,
            },
      config:
        c === undefined
          ? null
          : {
              enabled: c.enabled,
              assignments: c.assignments.map((a) => ({ model: a.model, runsPerCell: a.runsPerCell })),
              want: c.cells.length * c.assignments.filter((a) => catalog.includes(a.model)).reduce((n, a) => n + a.runsPerCell, 0),
              // Ended runs only, which is deliberately NOT the question the
              // scheduler asks: it counts a live probe as done so it does not
              // launch the same cell twice, but a page must not announce a
              // sweep complete while one of its runs could still end `manual`
              // and re-open the cell. No `eligible` predicate either: `blocked`
              // also covers running and paused, which are facts about this
              // second, not about the sweep.
              complete: campaignComplete(c, catalog, probeRuns),
              account: c.account ?? null,
            },
      runs: cappedCounted(c, catalog, probeRuns),
      live: mine.length - ended.length,
      models: [...new Set(mine.map((r) => r.model).filter((m): m is string => m !== null))].sort(),
      cells,
      columns,
      grid,
      newestRunId: newest?.runId ?? null,
      newestAt: newest?.startedAt ?? null,
    };
  });

  return {
    // A version with no runs, no store row and nothing assigned is a
    // definition nobody has commissioned yet; it still gets its row, so the
    // page lists every campaign a launch could name.
    campaigns: rows,
    orphans: all.filter((r) => r.episode === "probing" && r.campaign === null).length,
  };
}

/** An assigned cell nothing has run yet: owed, not empty. */
function EMPTY_SQUARE(target: number | null): CampaignSquareView {
  return { runs: 0, live: 0, counted: 0, reached: target === null ? null : 0, minutesToTarget: null, bestLevel: null, mismatched: 0 };
}

/**
 * The numerator of the page's `runs/want`: the counted runs `campaignComplete`
 * credits — on a declared cell, by an assignment the row names, never more per
 * (assignment, cell) than it asks for. Without a store row there is no `want`,
 * so the count is every counted run.
 */
function cappedCounted(c: Campaign | undefined, catalog: readonly string[], probeRuns: readonly ProbeRun[]): number {
  const counted = probeRuns.filter((r) => r.counted);
  if (c === undefined) return counted.length;
  const wants = new Map(c.assignments.filter((a) => catalog.includes(a.model)).map((a) => [a.model, a.runsPerCell]));
  const cells = new Set(c.cells.map((x) => x.id));
  const tally = new Map<string, number>();
  for (const r of counted) {
    if (r.ref === null || r.cell === null || !wants.has(r.ref) || !cells.has(r.cell)) continue;
    const k = `${r.ref}\u0000${r.cell}`;
    tally.set(k, Math.min(wants.get(r.ref)!, (tally.get(k) ?? 0) + 1));
  }
  let n = 0;
  for (const v of tally.values()) n += v;
  return n;
}
