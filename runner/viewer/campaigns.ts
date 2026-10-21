/**
 * `/api/campaigns`, built: every published campaign version with its store
 * row, the cells × (assignment × arm) grid of what has run, and the arm
 * comparison per assignment.
 *
 * The published definitions say what exists; the run directory says what
 * happened. A run belongs to a square only by its own stamps — campaign,
 * version, cell, the roster name it was launched as and the arm — so a run
 * from before arms belongs to none and stays on the runs pages. Progress and
 * state come from `campaignSquares`, the same tally the scheduler derives its
 * work from, so "complete" and the numbers beside it cannot disagree.
 *
 * The grid is a reading, never a ranking (docs/METHODOLOGY.md: `probing` has
 * no comparability group): cells keep the definition's order, columns the
 * assignments' and the arms', and nothing is sorted by a result.
 *
 * Pure over its inputs, so the page's numbers are testable without a server.
 */

import { cellOf, startMismatch, type CampaignArm } from "../src/campaign-def";
import {
  armArg,
  campaignProgress,
  campaignSquares,
  partyAttempt,
  type Campaign,
  type CampaignRefusal,
  type CampaignSquare,
  type ProbeRun,
  type PublishedCampaign,
} from "../src/campaigns";
import { harnessOfRun } from "../src/comparability";
import { DEFAULT_DRIVER } from "../src/drivers";
import type { ArmSummary, CampaignView, ResultRun, Square } from "./api-types";

/** The roster and the campaign blocks, as this builder needs them (`RosterRead`). */
export interface CampaignsRoster {
  campaigns: readonly Campaign[];
  campaignDefs: readonly PublishedCampaign[];
  campaignRefusals: readonly CampaignRefusal[];
  models: readonly { name: string; model: string; effort?: string | undefined; compactWindow?: string | undefined; driver?: string | undefined }[];
}

/** The page's whole body, minus the envelope `api.ts` adds. */
export interface CampaignsView {
  campaigns: CampaignView[];
  refused: { key: string; reason: string }[];
}

/** The lower of two middles on an even count: a value some run actually had, never an interpolation. */
function median(xs: readonly number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor((s.length - 1) / 2)]!;
}

/** The first level mark at or above the stop level, or undefined when the run never got there. */
function markAt(r: ResultRun, target: number | null): ResultRun["levels"][number] | undefined {
  return target === null ? undefined : r.levels.find((l) => l.level >= target);
}

function minutesTo(r: ResultRun, target: number | null): number | null {
  const mark = markAt(r, target);
  return mark === undefined || mark.playtimeMs === null ? null : Math.round(mark.playtimeMs / 60_000);
}

/** What a provider billed for a run: a reported figure, never a list price, never as-if-metered. */
function billedUsd(r: ResultRun): number | null {
  const a = r.actualCost;
  return a !== null && a.basis === "reported" && !a.asIfMetered && a.usd !== null ? a.usd : null;
}

function sumOrNull(xs: readonly (number | null)[]): number | null {
  const got = xs.filter((x): x is number => x !== null);
  return got.length === 0 ? null : got.reduce((a, b) => a + b, 0);
}

/** A run's build, as the grid names it: its harness version. */
function buildsOf(rs: readonly ResultRun[]): string[] {
  return [...new Set(rs.map((r) => r.harnessVersion).filter((v): v is string => v !== null))].sort();
}

function columnKey(ref: string, arm: string): string {
  return `${ref}/${arm}`;
}

/**
 * Every published campaign version, in page order: the versions the store
 * rows name, in the rows' order, then every other published version by id
 * and version.
 */
export function campaignsView(
  all: readonly ResultRun[],
  roster: CampaignsRoster,
  /** Whether an ended run counts toward its square — the scheduler's own `isCounted`, over a result row. */
  counted: (r: ResultRun) => boolean,
): CampaignsView {
  const catalog = roster.models.map((m) => m.name);
  const entryOf = (ref: string): CampaignsRoster["models"][number] | undefined => roster.models.find((m) => m.name === ref);
  const probes = all.filter((r) => r.campaign !== null);

  const order: PublishedCampaign[] = [];
  for (const c of roster.campaigns) if (!order.includes(c.published)) order.push(c.published);
  const rest = roster.campaignDefs
    .filter((d) => !order.some((o) => o.ref === d.ref))
    .sort((a, b) => a.def.id.localeCompare(b.def.id) || a.def.version - b.def.version);
  order.push(...rest);

  const campaigns = order.map((pub): CampaignView => {
    const def = pub.def;
    const target = def.stopAtLevel;
    const row = roster.campaigns.find((c) => c.name === def.id && c.version === def.version);
    const mine = probes.filter((r) => r.campaign === def.id && (r.campaignVersion ?? null) === def.version);
    const isLive = (r: ResultRun): boolean => r.terminationReason === null;
    const probeRuns: ProbeRun[] = mine.map((r) => ({
      campaign: r.campaign,
      version: r.campaignVersion ?? null,
      cell: r.cell,
      ref: r.ref ?? null,
      arm: r.arm ?? null,
      counted: !isLive(r) && counted(r),
      live: isLive(r),
      ...(r.party !== undefined ? { party: { id: r.party.id, size: r.party.size }, terminationReason: r.terminationReason } : {}),
    }));
    const probeOf = new Map(mine.map((r, i) => [r.runId, probeRuns[i]!]));
    /**
     * A square's runs as its attempts: a run each, or one party per id. A
     * party's attempt is live while any member is, and counts as the tally
     * says (`partyAttempt`), so the grid's numbers and the square's `want`
     * speak of the same thing.
     */
    const attemptsOf = (runs: readonly ResultRun[]): { ended: number; counted: number; live: number } => {
      if (def.party === undefined) {
        const ended = runs.filter((r) => !isLive(r));
        return { ended: ended.length, counted: ended.filter(counted).length, live: runs.length - ended.length };
      }
      const byParty = new Map<string, ProbeRun[]>();
      for (const r of runs) {
        const key = r.party?.id ?? r.runId;
        byParty.set(key, [...(byParty.get(key) ?? []), probeOf.get(r.runId)!]);
      }
      const all = [...byParty.values()].map(partyAttempt);
      return { ended: all.filter((a) => !a.live).length, counted: all.filter((a) => a.counted).length, live: all.filter((a) => a.live).length };
    };
    /** The start a run was launched on: its party member's, else its cell's. */
    const startOf = (r: ResultRun, cellId: string): { race: number; class: number } | undefined => {
      const m = r.party === undefined ? undefined : def.party?.members.find((x) => x.id === r.party!.member);
      return m ?? cellOf(def, cellId);
    };
    const squares: CampaignSquare[] = row === undefined ? [] : campaignSquares(row, catalog, probeRuns);
    const progress = campaignProgress(squares);

    // Columns: every assignment the row names (and the roster still holds) ×
    // every arm, then any (ref, arm) only the runs remember — an assignment
    // since removed, or a row since moved to another version — so a version's
    // history stays readable after its sweep moves on.
    const refs: string[] = [...new Set(squares.map((s) => s.ref))];
    for (const r of [...mine].sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0))) {
      if (r.ref != null && r.arm != null && def.arms.some((a) => a.id === r.arm) && !refs.includes(r.ref)) refs.push(r.ref);
    }
    const columns: CampaignView["columns"] = refs.flatMap((ref) =>
      def.arms.map((arm) => {
        const e = entryOf(ref);
        const armWindow = armArg(arm, "compact-window");
        return {
          key: columnKey(ref, arm.id),
          ref,
          arm: arm.id,
          model: e?.model ?? mine.find((r) => r.ref === ref)?.model ?? ref,
          effort: e?.effort ?? null,
          compactWindow: armWindow !== undefined ? (armWindow.toLowerCase() === "auto" ? null : armWindow) : (e?.compactWindow ?? null),
          harness: e === undefined ? null : harnessOfRun({ driver: e.driver ?? DEFAULT_DRIVER }),
        };
      }),
    );

    const squareOf = (cellId: string, ref: string, arm: CampaignArm): Square => {
      const runs = mine.filter((r) => r.cell === cellId && r.ref === ref && r.arm === arm.id);
      const ended = runs.filter((r) => !isLive(r));
      const good = ended.filter(counted);
      const minutes = good.map((r) => minutesTo(r, target)).filter((m): m is number => m !== null);
      const levels = runs.map((r) => r.maxLevel).filter((l): l is number => l !== null);
      const tally = squares.find((s) => s.cell.id === cellId && s.ref === ref && s.arm.id === arm.id);
      const attempts = attemptsOf(runs);
      const byStart = [...runs].sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0));
      return {
        column: columnKey(ref, arm.id),
        runs: attempts.ended,
        counted: attempts.counted,
        reached: target === null ? 0 : good.filter((r) => (r.maxLevel ?? 0) >= target).length,
        live: attempts.live,
        minutesToStop: minutes.length === 0 ? null : { min: Math.min(...minutes), median: median(minutes)!, max: Math.max(...minutes) },
        bestLevel: levels.length > 0 ? Math.max(...levels) : null,
        costUsd: sumOrNull(runs.map(billedUsd)),
        mismatchedStart: runs.filter((r) => startMismatch(startOf(r, cellId), { race: r.race, class: r.class })).length,
        builds: buildsOf(runs),
        runIds: byStart.map((r) => r.runId),
        // One entry per attempt of a party definition: the stamp's id, never the run id's stem.
        ...(def.party === undefined
          ? {}
          : { parties: [...new Set(byStart.map((r) => r.party?.id).filter((id): id is string => id !== undefined))] }),
        want: tally?.want ?? 0,
        settled: tally?.settled ?? null,
        refused: tally?.refused ?? null,
      };
    };
    const grid = def.cells.map((cell) => ({
      cell: cell.id,
      squares: columns.map((col) => squareOf(cell.id, col.ref, def.arms.find((a) => a.id === col.arm)!)),
    }));

    const comparison = refs.map((ref) => ({
      ref,
      arms: def.arms.map((arm): ArmSummary => {
        const runs = mine.filter((r) => r.ref === ref && r.arm === arm.id);
        const ended = runs.filter((r) => !isLive(r));
        const reached = ended.filter((r) => counted(r) && target !== null && (r.maxLevel ?? 0) >= target);
        const costs = reached
          .map((r) => r.actualCost)
          .filter((a): a is NonNullable<ResultRun["actualCost"]> => a !== null && a.basis === "reported" && a.usd !== null);
        const terminations: Record<string, number> = {};
        for (const r of ended) terminations[r.terminationReason!] = (terminations[r.terminationReason!] ?? 0) + 1;
        return {
          arm: arm.id,
          runs: ended.length,
          reached: reached.length,
          medianMinutesToStop: median(reached.map((r) => minutesTo(r, target)).filter((m): m is number => m !== null)),
          medianTurnsToStop: median(reached.map((r) => markAt(r, target)?.turn ?? null).filter((t): t is number => t !== null)),
          medianCostToStop: median(costs.map((a) => a.usd!)),
          medianPromptTokensToStop: median(reached.map((r) => r.tokens?.promptTokens ?? null).filter((t): t is number => t !== null)),
          terminations,
          builds: buildsOf(runs),
          costAsIfMetered: costs.filter((a) => a.asIfMetered).length,
        };
      }),
    }));

    const assigned = row === undefined ? [] : row.assignments.filter((a) => catalog.includes(a.model));
    const owed = squares.some((s) => s.settled === null);
    const state: CampaignView["state"] =
      progress.live > 0 || mine.some(isLive)
        ? "running"
        : row === undefined || assigned.length === 0
          ? "unassigned"
          : !owed
            ? "complete"
            : row.enabled
              ? "queued"
              : "disabled";
    const newest = mine.reduce<ResultRun | null>((a, b) => ((a?.startedAt ?? 0) >= (b.startedAt ?? 0) ? a : b), null);
    return {
      id: def.id,
      version: def.version,
      key: pub.ref,
      hash: pub.hash,
      source: { commit: pub.source.commit, path: pub.source.path, branch: [...pub.source.branch] },
      publishedAt: pub.publishedAt,
      question: def.question,
      note: def.note ?? null,
      shape: {
        objective: def.objective,
        stopAtLevel: def.stopAtLevel,
        episodeMs: def.budget.episodeMs,
        idleMs: def.budget.idleMs,
        noXpMs: def.budget.noXpMs,
        maxToolCalls: def.budget.maxToolCalls,
        wiki: def.wiki,
        wikiCoords: def.wikiCoords,
        resume: def.resume,
        maxAttemptsPerCell: def.maxAttemptsPerCell,
      },
      cells: def.cells.map((c) => ({ id: c.id, race: c.race, class: c.class, ...(c.note !== undefined ? { note: c.note } : {}) })),
      arms: def.arms.map((a) => ({
        id: a.id,
        ...(a.note !== undefined ? { note: a.note } : {}),
        image: a.image ?? null,
        command: a.command ?? null,
        args: [...(a.args ?? [])],
      })),
      config:
        row === undefined
          ? null
          : {
              enabled: row.enabled,
              account: row.account ?? null,
              assignments: row.assignments.map((a) => {
                const e = entryOf(a.model);
                return {
                  ref: a.model,
                  model: e?.model ?? a.model,
                  effort: e?.effort ?? null,
                  compactWindow: e?.compactWindow ?? null,
                  harness: e === undefined ? null : harnessOfRun({ driver: e.driver ?? DEFAULT_DRIVER }),
                  runsPerCell: a.runsPerCell,
                };
              }),
            },
      state,
      progress,
      columns,
      grid,
      comparison,
      costUsd: sumOrNull(mine.map(billedUsd)),
      newestRunId: newest?.runId ?? null,
      newestAt: newest?.startedAt ?? null,
    };
  });

  return { campaigns, refused: roster.campaignRefusals.map((r) => ({ key: r.key, reason: r.reason })) };
}
