/**
 * Probe campaigns: the commissioned middle lane.
 *
 * A campaign is an objective swept over a set of **cells** by a set of models.
 * It is commissioned, runs to completion, and is then switched off — which is
 * the whole of what separates it from an eval. Evals are re-armed by a harness
 * series bump and accumulate evidence per series; a campaign is never re-armed,
 * because it carries no target to un-meet (`probing` is unscored, so
 * `targetFor` is structurally zero for it — see `episodes.ts`).
 *
 * Three properties are worth stating, because each replaced a mechanism rather
 * than adding one:
 *
 * - **The roster is a catalog again.** Before this, a probe was a roster entry
 *   carrying an `objective` plus a pinned job pointing at it, which meant the
 *   roster held two kinds of thing and every scored surface needed a branch to
 *   tell them apart. A campaign names roster entries for their credentials and
 *   supplies the task shape itself, so `objective` never enters the catalog.
 * - **Completion is derived, never recorded.** Remaining work is
 *   `runsPerCell` minus the counted probe runs already on disk for that
 *   (campaign, cell, model). Nothing is written back, so deleting a campaign
 *   from the config cannot orphan a bookkeeping file, and re-adding it resumes
 *   exactly where it stopped.
 * - **A finished campaign is not archived.** `enabled: false` stops the
 *   scheduling; the results stay visible. Directory-moving (`archiveRun`) hides
 *   a run from every viewer surface unconditionally, which is the opposite of
 *   what a completed campaign wants.
 *
 * A cell is deliberately open-ended: the class-probe campaign's cells are
 * race/class pairs, and a later dungeon campaign's cell is a dungeon. Only
 * `id` is required, and it is what the run records, so the fan-out does not
 * care what a cell means.
 */

import { z } from "zod";

import { CHARACTER_NAME_RULE, isValidCharacterName } from "./config";

/** The watchdog overrides a campaign or a cell may set, in the config's own spelling. */
const watchdogsSchema = z
  .object({
    idleMs: z.number().int().positive().nullable().optional(),
    noXpMs: z.number().int().positive().nullable().optional(),
    episodeMs: z.number().int().positive().nullable().optional(),
  })
  .strict();

/** Names a run and a config entry both have to survive: safe in a run id and a path. */
const NAME = /^[A-Za-z0-9._-]+$/;

/**
 * The run dimensions a campaign sets, and a cell may then override. Every one
 * of them is recorded on the run like any other dimension; none of them is a
 * comparability claim, because `probing` is unscored.
 */
const dimensionsSchema = {
  objective: z.string().min(1).max(4000).optional(),
  wikiCoords: z.boolean().optional(),
  watchdogs: watchdogsSchema.optional(),
  maxToolCalls: z.number().int().positive().optional(),
  /** The starting character, as the client's own race/class ids. */
  race: z.number().int().positive().optional(),
  class: z.number().int().positive().optional(),
  // The shared game-rule predicate (config.ts): a cell's bad name should be a
  // named config refusal here, not a create-failure the probe run dies on.
  character: z.string().refine(isValidCharacterName, { message: CHARACTER_NAME_RULE }).optional(),
};

export const campaignCellSchema = z
  .object({ id: z.string().min(1).max(64).regex(NAME), ...dimensionsSchema })
  .strict();

export const campaignSchema = z
  .object({
    enabled: z.boolean().default(true),
    /**
     * Which catalog entries sweep this campaign. `"all"` is every roster name,
     * which is NOT the same question `rosterModels` answers — that one filters
     * to entries with a tier, i.e. eval eligibility. A campaign borrows
     * credentials, so a catalog-only entry (no tier) is a legitimate member.
     */
    models: z.union([z.literal("all"), z.array(z.string().min(1)).min(1)]).default("all"),
    /**
     * Skip a model the projection considers unhealthy (retired, or cooling on
     * the defer ladder). Default true: a campaign is exploration, and burning
     * its cells against a dead endpoint produces no observation.
     */
    excludeUnhealthy: z.boolean().default(true),
    /** Counted probe runs wanted per (model, cell). */
    runsPerCell: z.number().int().positive().default(1),
    cells: z.array(campaignCellSchema).min(1),
    /**
     * Pin the whole campaign to one account. Absent means it draws from the
     * model's own account class like anything else. A pinned campaign is how a
     * probe that needs a specific character or a specific box is expressed —
     * and it is subject to the same rule as a pinned job: the account must not
     * also be listed in a schedulable class.
     */
    account: z.string().min(1).optional(),
    ...dimensionsSchema,
  })
  .strict();

export type CampaignCell = z.infer<typeof campaignCellSchema>;
export type CampaignSpec = z.infer<typeof campaignSchema>;

/** One campaign, with the name it is keyed by — what everything downstream passes around. */
export interface Campaign extends CampaignSpec {
  name: string;
}

export const campaignsSchema = z.record(z.string().regex(NAME), campaignSchema);

/**
 * Parse the `campaigns` block, in declaration order.
 *
 * Order is load-bearing: it is the last tie-break when two campaigns both want
 * the same free account, so an operator can say which sweep matters by where
 * they put it in the file.
 */
export function parseCampaigns(raw: unknown): Campaign[] {
  if (raw === undefined) return [];
  const parsed = campaignsSchema.parse(raw);
  return Object.entries(parsed).map(([name, spec]) => ({ name, ...spec }));
}

/**
 * The models a campaign sweeps, resolved against the catalog.
 *
 * `eligible` answers "is this model worth launching at all" and is asked only
 * when `excludeUnhealthy` is set. It takes a name that may not be in the
 * projection at all — a catalog-only entry has no `ModelState` — and such an
 * entry must default to eligible rather than being silently dropped: absence
 * from the projection means "never eval-scheduled", not "unhealthy".
 */
export function campaignModels(
  c: Campaign,
  catalog: readonly string[],
  eligible?: (name: string) => boolean,
): string[] {
  const named = c.models === "all" ? [...catalog] : c.models.filter((m) => catalog.includes(m));
  if (!c.excludeUnhealthy || eligible === undefined) return named;
  return named.filter((m) => eligible(m));
}

/** A probe run already on disk, as the fan-out counts it. */
export interface ProbeRun {
  campaign: string | null;
  cell: string | null;
  /** Roster name this run was launched as, when it recorded one. */
  ref: string | null;
}

/** One (campaign, model, cell) with work left on it. */
export interface CampaignWork {
  campaign: string;
  /** Roster name — the catalog entry whose credentials the run uses. */
  model: string;
  cell: CampaignCell;
  /** Counted probe runs already done for this triple. */
  done: number;
  /** `runsPerCell`: how many are wanted. */
  want: number;
  /** Declaration order of the campaign, for tie-breaks. */
  order: number;
}

/**
 * Every (campaign, model, cell) that still owes runs, in sweep order.
 *
 * Sweep order spreads across models before it finishes any one of them: a
 * campaign that has touched every model once has told us more than one that
 * has finished a single model's cells, and a sweep that is going to be
 * interrupted (by an operator, a harness bump, a dead key) should be
 * interrupted holding breadth. So the first sort key is how much this model has
 * already done in this campaign, and cells are only ordered within that.
 *
 * `counted` is the same predicate every other surface uses, which is what makes
 * a stillborn or operator-cut probe re-run without any special case here.
 */
export function campaignWork(
  campaigns: readonly Campaign[],
  catalog: readonly string[],
  counted: readonly ProbeRun[],
  eligible?: (name: string) => boolean,
): CampaignWork[] {
  const key = (campaign: string, model: string, cell: string): string => `${campaign}\u0000${model}\u0000${cell}`;
  const tally = new Map<string, number>();
  for (const r of counted) {
    if (r.campaign === null || r.cell === null || r.ref === null) continue;
    const k = key(r.campaign, r.ref, r.cell);
    tally.set(k, (tally.get(k) ?? 0) + 1);
  }
  const perModel = new Map<string, number>();
  for (const r of counted) {
    if (r.campaign === null || r.ref === null) continue;
    const k = `${r.campaign}\u0000${r.ref}`;
    perModel.set(k, (perModel.get(k) ?? 0) + 1);
  }
  const out: CampaignWork[] = [];
  // Declaration order of each cell, recorded while we already have the index.
  // The comparator below runs O(n log n) times, so anything it searches for is
  // searched for repeatedly; this is the one thing here that was.
  const cellAt = new Map<string, number>();
  campaigns.forEach((c, order) => {
    if (!c.enabled) return;
    for (const model of campaignModels(c, catalog, eligible)) {
      c.cells.forEach((cell, cellIdx) => {
        const done = tally.get(key(c.name, model, cell.id)) ?? 0;
        if (done >= c.runsPerCell) return;
        cellAt.set(`${c.name}\u0000${cell.id}`, cellIdx);
        out.push({ campaign: c.name, model, cell, done, want: c.runsPerCell, order });
      });
    }
  });
  const modelOrder = (w: CampaignWork): number => perModel.get(`${w.campaign}\u0000${w.model}`) ?? 0;
  const cellIndex = (w: CampaignWork): number => cellAt.get(`${w.campaign}\u0000${w.cell.id}`) ?? 0;
  return out.sort(
    (a, b) =>
      modelOrder(a) - modelOrder(b) ||
      a.order - b.order ||
      catalog.indexOf(a.model) - catalog.indexOf(b.model) ||
      cellIndex(a) - cellIndex(b),
  );
}

/**
 * Whether a campaign has nothing left to do. Derived, and deliberately not a
 * state anyone writes: a campaign whose config entry is edited (a cell added, a
 * model added) simply stops being complete, with no record to reconcile.
 */
export function campaignComplete(
  c: Campaign,
  catalog: readonly string[],
  counted: readonly ProbeRun[],
  eligible?: (name: string) => boolean,
): boolean {
  return campaignWork([c], catalog, counted, eligible).length === 0;
}

/** The run dimensions a work item launches under: the campaign's, then the cell's. */
export function workDimensions(c: Campaign, cell: CampaignCell): {
  objective?: string;
  wikiCoords?: boolean;
  watchdogs?: z.infer<typeof watchdogsSchema>;
  maxToolCalls?: number;
  race?: number;
  class?: number;
  character?: string;
} {
  const pick = <K extends keyof CampaignCell & keyof CampaignSpec>(k: K): CampaignCell[K] | CampaignSpec[K] | undefined =>
    cell[k] !== undefined ? cell[k] : c[k];
  const out: Record<string, unknown> = {};
  for (const k of ["objective", "wikiCoords", "maxToolCalls", "race", "class", "character"] as const) {
    const v = pick(k);
    if (v !== undefined) out[k] = v;
  }
  // Watchdogs merge rather than replace: a cell that lengthens the clock should
  // not silently re-enable a watchdog the campaign turned off.
  const w = { ...(c.watchdogs ?? {}), ...(cell.watchdogs ?? {}) };
  if (Object.keys(w).length > 0) out["watchdogs"] = w;
  return out as ReturnType<typeof workDimensions>;
}
