/**
 * Probe campaigns: the commissioned middle lane, as the fleet schedules it.
 *
 * A campaign is a checked-in definition swept by a set of models. The two
 * halves live apart (operator decision, 2026-10-09):
 *
 * - **Static, in git** (`runner/src/campaign-defs/`): the question, the cells,
 *   the start, the leash, what ends a run and what counts as a cell done. A
 *   published version is never edited; a change is a new version.
 * - **Dynamic, in the config store** (`campaigns/<id>`, parsed here): which
 *   version is active, whether it is enabled, which roster entries sweep it and
 *   how many counted runs each owes per cell, the account it is pinned to, and
 *   whether an unhealthy model is skipped. Nothing static is accepted here —
 *   a row that names a cell or an objective is refused by name and pointed at
 *   the definition, so each fact has exactly one place.
 *
 * Three properties carried over, each of which replaced a mechanism rather
 * than adding one:
 *
 * - **The roster is a catalog.** An assignment names a roster entry for its
 *   credentials, model and effort; the definition supplies the task shape, so
 *   `objective` never enters the catalog.
 * - **Completion is derived, never recorded.** Remaining work is an
 *   assignment's `runsPerCell` minus the counted probe runs already on disk for
 *   that (campaign, version, roster name, cell) — and nothing at all once the
 *   definition's `maxAttemptsPerCell` launches have been made, so a cell that
 *   only ever fails is abandoned instead of swept forever. Counting is per
 *   VERSION: a newer version that reuses a cell id is never credited with an
 *   older version's runs.
 * - **A finished campaign is not archived.** `enabled: false` stops the
 *   scheduling; the results stay visible, and the definition keeps them
 *   attributed even after the store row is gone.
 */

import { z } from "zod";
import {
  CAMPAIGN_NAME,
  campaignDef,
  campaignRef,
  unversionedOwner,
  type CampaignCellDef,
  type CampaignDef,
  type OpenCampaignDef,
} from "./campaign-defs";

/** One roster entry sweeping a campaign, and how many counted runs per cell it owes. */
export const campaignAssignmentSchema = z
  .object({
    /** A roster name: the catalog entry whose model, effort and credentials the runs use. */
    model: z.string().min(1),
    runsPerCell: z.number().int().positive().default(1),
  })
  .strict();
export type CampaignAssignment = z.infer<typeof campaignAssignmentSchema>;

/** A `campaigns/<id>` row, as the store holds it today. */
export const campaignRowSchema = z
  .object({
    /** Which checked-in version is active. Explicit, never "latest": a merged definition must not re-target a sweep. */
    version: z.number().int().positive(),
    enabled: z.boolean().default(true),
    /** In priority order: the sweep spreads across them breadth-first. */
    assignments: z.array(campaignAssignmentSchema).default([]),
    /**
     * Pin the whole campaign to one account. Absent or null: it draws from each
     * model's own account class like anything else. A pinned campaign follows
     * the pinned-job account rules.
     */
    account: z.string().min(1).nullable().optional(),
    /**
     * Skip a model the projection considers unhealthy (retired, or cooling on
     * the defer ladder). Default true: burning a cell against a dead endpoint
     * produces no observation.
     */
    excludeUnhealthy: z.boolean().default(true),
  })
  .strict();

/**
 * The keys that belong to a definition, not a store row. Refused by name on a
 * row that states a `version`, so an operator who writes one is told where it
 * lives rather than getting a generic "unrecognized key".
 */
export const STATIC_CAMPAIGN_KEYS = [
  "cells",
  "objective",
  "watchdogs",
  "maxToolCalls",
  "wikiCoords",
  "wiki",
  "race",
  "class",
  "resume",
  "maxAttemptsPerCell",
  "stopAtLevel",
  "budget",
] as const;

/** One campaign as everything downstream passes it around: the store row joined to its definition. */
export interface Campaign {
  /** The campaign id — the store row's key and the definition's `id`. */
  name: string;
  version: number;
  def: CampaignDef;
  enabled: boolean;
  assignments: CampaignAssignment[];
  account?: string;
  excludeUnhealthy: boolean;
  /** The definition's cells, here because every planner walks them. */
  cells: readonly CampaignCellDef[];
  /** The definition's resume rule (false on a closed definition, which launches nothing). */
  resume: boolean;
  /** The definition's attempt cap, when it set one. */
  maxAttemptsPerCell?: number;
  /** Set when the row was read in the pre-definition shape and mapped onto its v1. */
  migrated?: true;
}

/** A campaign row the parser could read but will not schedule, and why. */
export interface CampaignRowRefusal {
  name: string;
  why: string;
  /** The cell ids it would have spawned under, so a live run under it is spared. */
  cells: string[];
}

function joined(name: string, def: CampaignDef, row: z.infer<typeof campaignRowSchema>, migrated: boolean): Campaign {
  return {
    name,
    version: def.version,
    def,
    enabled: row.enabled,
    assignments: row.assignments,
    ...(row.account !== undefined && row.account !== null ? { account: row.account } : {}),
    excludeUnhealthy: row.excludeUnhealthy,
    cells: def.cells,
    resume: def.status === "open" ? def.resume : false,
    ...(def.status === "open" && def.maxAttemptsPerCell !== null ? { maxAttemptsPerCell: def.maxAttemptsPerCell } : {}),
    ...(migrated ? { migrated: true as const } : {}),
  };
}

/**
 * A row in the shape campaigns had before definitions were checked in: no
 * `version`, and the task shape (`cells`, `objective`, …) inline. Mapped onto
 * the version that claims the id's unversioned runs, so a store written before
 * this change loads on the first boot after it and the operator can rewrite
 * the rows at leisure. The inline shape is DROPPED, not merged — the checked-in
 * definition is the shape — and `models` becomes one assignment per name at
 * the old `runsPerCell`. `"all"` maps to no assignments: it meant every catalog
 * entry, which is not a list anyone chose.
 */
function migrateLegacyRow(name: string, raw: Record<string, unknown>): z.infer<typeof campaignRowSchema> & { version: number } {
  const owner = unversionedOwner(name);
  if (owner === undefined) {
    throw new LegacyRowError(
      `the pre-definition shape (no version) and no checked-in definition claims "${name}" — write { version, enabled, assignments } naming a definition in runner/src/campaign-defs/`,
    );
  }
  const runsPerCell = typeof raw["runsPerCell"] === "number" && Number.isInteger(raw["runsPerCell"]) && raw["runsPerCell"] > 0 ? raw["runsPerCell"] : 1;
  const models = Array.isArray(raw["models"]) ? raw["models"].filter((m): m is string => typeof m === "string" && m.length > 0) : [];
  return campaignRowSchema.parse({
    version: owner.version,
    ...(typeof raw["enabled"] === "boolean" ? { enabled: raw["enabled"] } : {}),
    assignments: models.map((model) => ({ model, runsPerCell })),
    ...(typeof raw["account"] === "string" && raw["account"].length > 0 ? { account: raw["account"] } : {}),
    ...(typeof raw["excludeUnhealthy"] === "boolean" ? { excludeUnhealthy: raw["excludeUnhealthy"] } : {}),
  }) as z.infer<typeof campaignRowSchema> & { version: number };
}

class LegacyRowError extends Error {}

/**
 * Parse the `campaigns` block, in declaration order.
 *
 * Order is load-bearing: it is the last tie-break when two campaigns both want
 * the same free account, so an operator can say which sweep matters by where
 * they put it.
 *
 * Two kinds of failure, kept apart. A row the parser cannot READ — not an
 * object, an unknown key, a static key on a versioned row — throws, as every
 * shape error in the fleet config does, so a store write that would produce it
 * is refused on the spot. A row it can read but will not SCHEDULE — a version
 * this checkout has no definition for, a closed definition switched on, an old
 * row nothing claims — is refused by name and left out, so one campaign that
 * names a version an older image does not know cannot take the rest of the
 * config down.
 */
export function parseCampaigns(raw: unknown): { campaigns: Campaign[]; refused: CampaignRowRefusal[] } {
  if (raw === undefined) return { campaigns: [], refused: [] };
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("campaigns must be an object of { <id>: { version, enabled, assignments, … } }");
  }
  const campaigns: Campaign[] = [];
  const refused: CampaignRowRefusal[] = [];
  for (const [name, spec] of Object.entries(raw as Record<string, unknown>)) {
    if (!CAMPAIGN_NAME.test(name)) throw new Error(`campaign ${name}: the id must match ${CAMPAIGN_NAME}`);
    if (typeof spec !== "object" || spec === null || Array.isArray(spec)) {
      throw new Error(`campaign ${name}: a row is an object { version, enabled, assignments, account?, excludeUnhealthy? }`);
    }
    const o = spec as Record<string, unknown>;
    let row: z.infer<typeof campaignRowSchema>;
    let migrated = false;
    if (o["version"] === undefined) {
      try {
        row = migrateLegacyRow(name, o);
      } catch (err) {
        if (!(err instanceof LegacyRowError)) throw err;
        refused.push({ name, why: err.message, cells: [] });
        continue;
      }
      migrated = true;
    } else {
      const statics = STATIC_CAMPAIGN_KEYS.filter((k) => o[k] !== undefined);
      if (statics.length > 0) {
        throw new Error(
          `campaign ${name}: ${statics.join(", ")} ${statics.length === 1 ? "is" : "are"} the definition's, not the store's — ` +
            `the shape of ${name}@${String(o["version"])} lives in runner/src/campaign-defs/ and a change to it is a new version`,
        );
      }
      if (o["models"] !== undefined || o["runsPerCell"] !== undefined) {
        throw new Error(`campaign ${name}: models and runsPerCell are now assignments: [{ model: "<roster name>", runsPerCell: n }]`);
      }
      try {
        row = campaignRowSchema.parse(o);
      } catch (err) {
        throw new Error(`campaign ${name}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    const def = campaignDef(name, row.version);
    if (def === undefined) {
      refused.push({ name, why: `${name}@${row.version} has no definition in this checkout (runner/src/campaign-defs/)`, cells: [] });
      continue;
    }
    if (def.status === "closed" && row.enabled) {
      refused.push({
        name,
        why: `${campaignRef(def)} is closed — it attributes past runs and launches nothing; set enabled: false or name an open version`,
        cells: def.cells.map((c) => c.id),
      });
      continue;
    }
    campaigns.push(joined(name, def, row, migrated));
  }
  return { campaigns, refused };
}

/**
 * The assignments a campaign sweeps, resolved against the catalog, in the
 * campaign's own priority order.
 *
 * `eligible` answers "is this model worth launching at all" and is asked only
 * when `excludeUnhealthy` is set. It takes a name that may not be in the
 * projection at all — a catalog-only entry has no `ModelState` — and such an
 * entry must default to eligible rather than being silently dropped: absence
 * from the projection means "never eval-scheduled", not "unhealthy".
 */
export function campaignAssignments(
  c: Campaign,
  catalog: readonly string[],
  eligible?: (name: string) => boolean,
): CampaignAssignment[] {
  const named = c.assignments.filter((a) => catalog.includes(a.model));
  if (!c.excludeUnhealthy || eligible === undefined) return named;
  return named.filter((a) => eligible(a.model));
}

/** The roster names a campaign sweeps (`campaignAssignments`, names only). */
export function campaignModels(
  c: Campaign,
  catalog: readonly string[],
  eligible?: (name: string) => boolean,
): string[] {
  return campaignAssignments(c, catalog, eligible).map((a) => a.model);
}

/** A probe run already on disk, as the fan-out reads it. */
export interface ProbeRun {
  campaign: string | null;
  /**
   * The definition version the run belongs to: its stamp, or — for a run
   * stamped before versions existed — the version that claims the id's
   * unversioned runs. Null when neither says.
   */
  version: number | null;
  cell: string | null;
  /** Roster name this run was launched as, when it can be told. */
  ref: string | null;
  /**
   * Whether the run counts toward `runsPerCell` (`isCounted`). Every campaign
   * run is passed in, counted or not, because a launch that failed is still
   * evidence the cell was tried — which is the only thing that can stop a
   * failing cell being swept forever.
   */
  counted: boolean;
}

/** One (campaign, assignment, cell) with work left on it. */
export interface CampaignWork {
  campaign: string;
  version: number;
  /** Roster name — the catalog entry whose credentials the run uses. */
  model: string;
  cell: CampaignCellDef;
  /** Counted probe runs already done for this triple. */
  done: number;
  /** The assignment's `runsPerCell`: how many are wanted. */
  want: number;
  /** Launches already made for this triple, counted or not. */
  attempts: number;
  /** The definition's `maxAttemptsPerCell`, when it set one. */
  maxAttempts?: number;
  /** Declaration order of the campaign, for tie-breaks. */
  order: number;
}

/**
 * Every (campaign, assignment, cell) that still owes runs, in sweep order.
 *
 * Sweep order spreads across models before it finishes any one of them: a
 * campaign that has touched every model once has told us more than one that
 * has finished a single model's cells, and a sweep that is going to be
 * interrupted (by an operator, a harness bump, a dead key) should be
 * interrupted holding breadth. So the first sort key is how much this model has
 * already done in this campaign, then the campaign's declaration order, then
 * the assignment's priority, and cells only within that.
 *
 * Two tallies, over the same runs, asked different questions. `done` and the
 * sweep order count only what `isCounted` counts, so "how much of this campaign
 * exists" keeps its meaning and a stillborn or operator-cut probe still re-runs.
 * `attempts` counts every launch the cell has had, and is what
 * `maxAttemptsPerCell` reads: a cell whose launches keep failing is abandoned
 * rather than swept forever. Both are keyed on (campaign, version, roster
 * name, cell).
 */
export function campaignWork(
  campaigns: readonly Campaign[],
  catalog: readonly string[],
  probeRuns: readonly ProbeRun[],
  eligible?: (name: string) => boolean,
): CampaignWork[] {
  const key = (campaign: string, version: number, model: string, cell: string): string =>
    `${campaign}\u0000${version}\u0000${model}\u0000${cell}`;
  const tally = new Map<string, number>();
  const attempted = new Map<string, number>();
  const perModel = new Map<string, number>();
  for (const r of probeRuns) {
    if (r.campaign === null || r.version === null || r.cell === null || r.ref === null) continue;
    const k = key(r.campaign, r.version, r.ref, r.cell);
    attempted.set(k, (attempted.get(k) ?? 0) + 1);
    if (!r.counted) continue;
    tally.set(k, (tally.get(k) ?? 0) + 1);
    const m = `${r.campaign}\u0000${r.version}\u0000${r.ref}`;
    perModel.set(m, (perModel.get(m) ?? 0) + 1);
  }
  const out: CampaignWork[] = [];
  // Declaration order of each cell and priority of each assignment, recorded
  // while we already have the index: the comparator runs O(n log n) times.
  const cellAt = new Map<string, number>();
  const assignmentAt = new Map<string, number>();
  campaigns.forEach((c, order) => {
    if (!c.enabled || c.def.status !== "open") return;
    campaignAssignments(c, catalog, eligible).forEach((a, aIdx) => {
      assignmentAt.set(`${c.name}\u0000${c.version}\u0000${a.model}`, aIdx);
      c.cells.forEach((cell, cellIdx) => {
        const k = key(c.name, c.version, a.model, cell.id);
        const done = tally.get(k) ?? 0;
        if (done >= a.runsPerCell) return;
        // Abandoned: the cell has had its launches and still owes counted runs.
        // Skipped exactly the way a finished cell is, so `campaignComplete`,
        // the pinned-campaign job and the policy loop all inherit it without
        // any of them learning a second word for "nothing left here".
        const attempts = attempted.get(k) ?? 0;
        if (c.maxAttemptsPerCell !== undefined && attempts >= c.maxAttemptsPerCell) return;
        cellAt.set(`${c.name}\u0000${c.version}\u0000${cell.id}`, cellIdx);
        out.push({
          campaign: c.name,
          version: c.version,
          model: a.model,
          cell,
          done,
          want: a.runsPerCell,
          attempts,
          ...(c.maxAttemptsPerCell !== undefined ? { maxAttempts: c.maxAttemptsPerCell } : {}),
          order,
        });
      });
    });
  });
  const modelOrder = (w: CampaignWork): number => perModel.get(`${w.campaign}\u0000${w.version}\u0000${w.model}`) ?? 0;
  const assignmentIndex = (w: CampaignWork): number => assignmentAt.get(`${w.campaign}\u0000${w.version}\u0000${w.model}`) ?? 0;
  const cellIndex = (w: CampaignWork): number => cellAt.get(`${w.campaign}\u0000${w.version}\u0000${w.cell.id}`) ?? 0;
  return out.sort(
    (a, b) =>
      modelOrder(a) - modelOrder(b) ||
      a.order - b.order ||
      assignmentIndex(a) - assignmentIndex(b) ||
      cellIndex(a) - cellIndex(b),
  );
}

/**
 * Whether a campaign has nothing left to do — done or abandoned, since a cell
 * past its attempt cap is not work either. Derived, and deliberately not a
 * state anyone writes: a campaign whose row gains an assignment simply stops
 * being complete, with no record to reconcile.
 */
export function campaignComplete(
  c: Campaign,
  catalog: readonly string[],
  probeRuns: readonly ProbeRun[],
  eligible?: (name: string) => boolean,
): boolean {
  return campaignWork([{ ...c, enabled: true }], catalog, probeRuns, eligible).length === 0;
}

/**
 * The run dimensions a cell of an open definition launches under. One
 * function for both sides of a launch: the runner fills a fresh probe's config
 * from it, and the fleet plans with the same numbers (the ceiling for ETAs and
 * drains), so the two cannot disagree about what a probe was given.
 */
export function cellDimensions(
  def: OpenCampaignDef,
  cell: CampaignCellDef,
): {
  race: number;
  class: number;
  watchdogs: { idleMs: number; noXpMs: number | null; episodeMs: number };
  maxToolCalls: number;
  wikiCoords: boolean;
  wiki: boolean;
  objective?: string;
  stopAtLevel?: number;
} {
  return {
    race: cell.race,
    class: cell.class,
    watchdogs: { idleMs: def.budget.idleMs, noXpMs: def.budget.noXpMs, episodeMs: def.budget.episodeMs },
    maxToolCalls: def.budget.maxToolCalls,
    wikiCoords: def.wikiCoords,
    wiki: def.wiki,
    ...(def.objective !== null ? { objective: def.objective } : {}),
    ...(def.stopAtLevel !== null ? { stopAtLevel: def.stopAtLevel } : {}),
  };
}
