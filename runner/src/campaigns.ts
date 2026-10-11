/**
 * Probe campaigns: the commissioned middle lane, as the fleet schedules it.
 *
 * A campaign is a published definition swept by a set of models. The two
 * halves live apart:
 *
 * - **Static, published** (`campaign-defs/<id>@<version>`, written only by
 *   `campaign-publish.ts` from `runner/campaigns/<id>@<version>.json`): the
 *   question, the cells, the arms, the leash, what ends a run and what counts
 *   as a square done. Write-once: a change is a new version.
 * - **Dynamic, a store row** (`campaigns/<id>`, parsed here): which version is
 *   active, whether it is enabled, which roster entries sweep it and how many
 *   counted runs each owes per square, the account it is pinned to, and
 *   whether an unhealthy model is skipped.
 *
 * Three properties, each of which replaced a mechanism rather than adding one:
 *
 * - **The roster is a catalog.** An assignment names a roster entry for its
 *   credentials, model and effort; the definition supplies the task shape.
 * - **Completion is derived, never recorded.** A square is one (assignment,
 *   arm, cell); what it still owes is its `runsPerCell` minus the counted
 *   probe runs on disk stamped with that campaign, version, roster name, arm
 *   and cell — and nothing at all once the definition's `maxAttemptsPerCell`
 *   launches have been made, so a square that only ever fails is abandoned
 *   instead of swept forever. Counting is per VERSION. `campaignSquares` is
 *   the one tally, read by the scheduler and the campaigns page alike.
 * - **A finished campaign is not archived.** `enabled: false` stops the
 *   scheduling; the results stay visible while the definition is published.
 */

import { z } from "zod";
import {
  CAMPAIGN_NAME,
  campaignDefKey,
  campaignHash,
  campaignRef,
  issuesOf,
  parseCampaignRef,
  publishedCampaignSchema,
  type CampaignArm,
  type CampaignCell,
  type CampaignDefinition,
  type CampaignSource,
} from "./campaign-def";

/** One roster entry sweeping a campaign, and how many counted runs per square it owes. */
export const campaignAssignmentSchema = z
  .object({
    /** A roster name: the catalog entry whose model, effort and credentials the runs use. */
    model: z.string().min(1),
    runsPerCell: z.number().int().positive().default(1),
  })
  .strict();
export type CampaignAssignment = z.infer<typeof campaignAssignmentSchema>;

/** A `campaigns/<id>` row. */
export const campaignRowSchema = z
  .object({
    /** Which published version is active. Explicit, never "latest": a new publish must not re-target a sweep. */
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
     * the defer ladder). Default true: burning a square against a dead
     * endpoint produces no observation.
     */
    excludeUnhealthy: z.boolean().default(true),
  })
  .strict();

/** A definition as the store holds it, read and checked. */
export interface PublishedCampaign {
  /** `race-probe@1`. */
  ref: string;
  def: CampaignDefinition;
  hash: string;
  source: CampaignSource;
  publishedAt: number;
}

/** One campaign as everything downstream passes it around: the store row joined to its published definition. */
export interface Campaign {
  /** The campaign id — the store row's key and the definition's `id`. */
  name: string;
  version: number;
  published: PublishedCampaign;
  /** Every published version of this id, the active one included: a paused run follows its own. */
  versions: PublishedCampaign[];
  def: CampaignDefinition;
  enabled: boolean;
  assignments: CampaignAssignment[];
  account?: string;
  excludeUnhealthy: boolean;
  /** The definition's cells and arms, here because every planner walks them. */
  cells: readonly CampaignCell[];
  arms: readonly CampaignArm[];
  resume: boolean;
  /** The definition's attempt cap, when it set one. */
  maxAttemptsPerCell?: number;
  /**
   * (assignment, arm) pairs that cannot launch as configured, found before
   * any launch (`campaignPairRefusals`): their squares stay in the grid and
   * are never scheduled. Empty when the roster was not consulted.
   */
  refusedPairs: { ref: string; arm: string; reason: string }[];
}

/**
 * A store row, a published definition or an (assignment, arm) pair the
 * parser could read but will not use, and why. Carried to `--status` and to
 * `/api/campaigns`; never dropped.
 */
export interface CampaignRefusal {
  /**
   * The store key (`campaigns/<id>`, `campaign-defs/<id>@<version>`), or
   * `<id>@<version>:<ref>:<arm>` for a pair.
   */
  key: string;
  reason: string;
  /** For a row: the campaign id, so its pin is refused and named. */
  campaign?: string;
}

/** The value an arm's args give a flag, or undefined when they do not name it. */
export function armArg(arm: CampaignArm, flag: string): string | undefined {
  const args = arm.args ?? [];
  const i = args.indexOf(`--${flag}`);
  if (i < 0) return undefined;
  const v = args[i + 1];
  return v === undefined || v.startsWith("--") ? "true" : v;
}

/** What the pair check needs of a roster entry. */
export interface PairRosterEntry {
  driver?: string | undefined;
  compactWindow?: string | undefined;
}

/**
 * The (assignment, arm) pairs of a campaign that would fail at launch, said
 * before one is made: a failed launch spends an attempt, and three spend the
 * square. Today that is the compaction window, which an arm may vary
 * (operator, 2026-10-11): an arm that sets `--compact-window` cannot run an
 * assignment whose roster entry sets one too (the run would get the flag
 * twice), nor one off the claude-code driver (no other harness has the
 * window).
 */
export function campaignPairRefusals(
  c: Pick<Campaign, "name" | "version" | "assignments" | "arms">,
  roster: Readonly<Record<string, PairRosterEntry>>,
): { ref: string; arm: string; reason: string }[] {
  const out: { ref: string; arm: string; reason: string }[] = [];
  for (const a of c.assignments) {
    const entry = roster[a.model];
    if (entry === undefined) continue;
    for (const arm of c.arms) {
      const window = armArg(arm, "compact-window");
      if (window === undefined) continue;
      const driver = entry.driver ?? "openai";
      if (driver !== "claude-code") {
        out.push({ ref: a.model, arm: arm.id, reason: `arm ${arm.id} sets --compact-window ${window}, and ${a.model} runs on the ${driver} driver, which has no compaction window` });
      } else if (entry.compactWindow !== undefined) {
        out.push({ ref: a.model, arm: arm.id, reason: `arm ${arm.id} sets --compact-window ${window}, and roster entry ${a.model} already sets compactWindow ${entry.compactWindow} — assign an entry with no window` });
      }
    }
  }
  return out;
}

/** The key a pair refusal is filed under in `refused[]`. */
export function pairRefusalKey(c: Pick<Campaign, "name" | "version">, ref: string, arm: string): string {
  return `${c.name}@${c.version}:${ref}:${arm}`;
}

/**
 * Parse the `campaign-defs` block: every published definition, checked again
 * on read. A row that no longer parses, or whose stored hash is not its
 * definition's, is refused by key and left out — a definition can only reach
 * the store through a publish that checked both, so either is a store edited
 * by hand or a schema that moved, and neither may take the rest of the config
 * down.
 */
export function parseCampaignDefinitions(raw: unknown): { definitions: PublishedCampaign[]; refused: CampaignRefusal[] } {
  if (raw === undefined) return { definitions: [], refused: [] };
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error('campaign-defs must be an object of { "<id>@<version>": { definition, hash, source, publishedAt } }');
  }
  const definitions: PublishedCampaign[] = [];
  const refused: CampaignRefusal[] = [];
  for (const [ref, doc] of Object.entries(raw as Record<string, unknown>)) {
    const key = `campaign-defs/${ref}`;
    const parsed = publishedCampaignSchema.safeParse(doc);
    if (!parsed.success) {
      refused.push({ key, reason: `not a published definition: ${issuesOf(parsed.error)}` });
      continue;
    }
    const p = parsed.data;
    if (campaignRef(p.definition) !== ref) {
      refused.push({ key, reason: `holds ${campaignRef(p.definition)}, not ${ref}` });
      continue;
    }
    const hash = campaignHash(p.definition);
    if (hash !== p.hash) {
      refused.push({ key, reason: `its definition hashes to ${hash}, but it was published as ${p.hash} — edited after publication` });
      continue;
    }
    definitions.push({ ref, def: p.definition, hash: p.hash, source: p.source, publishedAt: p.publishedAt });
  }
  return { definitions, refused };
}

/**
 * Parse the `campaigns` block, in declaration order, against the published
 * definitions.
 *
 * Order is load-bearing: it is the last tie-break when two campaigns both want
 * the same free account, so an operator can say which sweep matters by where
 * they put it.
 *
 * Two kinds of failure, kept apart. A row the parser cannot READ — not an
 * object, an unknown key, a bad value — throws, as every shape error in the
 * fleet config does, so a store write that would produce it is refused on the
 * spot. A row it can read but will not SCHEDULE — a version nobody has
 * published — is refused by key and left out, and stays listed until the
 * version is published or the row is rewritten.
 */
export function parseCampaigns(
  raw: unknown,
  definitions: readonly PublishedCampaign[],
): { campaigns: Campaign[]; refused: CampaignRefusal[] } {
  if (raw === undefined) return { campaigns: [], refused: [] };
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("campaigns must be an object of { <id>: { version, enabled, assignments, … } }");
  }
  const campaigns: Campaign[] = [];
  const refused: CampaignRefusal[] = [];
  for (const [name, spec] of Object.entries(raw as Record<string, unknown>)) {
    if (!CAMPAIGN_NAME.test(name)) throw new Error(`campaign ${name}: the id must match ${CAMPAIGN_NAME}`);
    const parsed = campaignRowSchema.safeParse(spec);
    if (!parsed.success) {
      throw new Error(`campaign ${name}: ${issuesOf(parsed.error)} — a row is { version, enabled, assignments [{ model, runsPerCell }], account?, excludeUnhealthy? }`);
    }
    const row = parsed.data;
    const ref = campaignRef({ id: name, version: row.version });
    const published = definitions.find((d) => d.ref === ref);
    if (published === undefined) {
      refused.push({ key: `campaigns/${name}`, campaign: name, reason: `${ref} is not published (${campaignDefKey({ id: name, version: row.version })} is absent) — publish it with runner/src/campaign-publish.ts` });
      continue;
    }
    const def = published.def;
    campaigns.push({
      name,
      version: def.version,
      published,
      versions: definitions.filter((d) => d.def.id === name),
      def,
      enabled: row.enabled,
      assignments: row.assignments,
      ...(row.account !== undefined && row.account !== null ? { account: row.account } : {}),
      excludeUnhealthy: row.excludeUnhealthy,
      cells: def.cells,
      arms: def.arms,
      resume: def.resume,
      ...(def.maxAttemptsPerCell !== null ? { maxAttemptsPerCell: def.maxAttemptsPerCell } : {}),
      refusedPairs: [],
    });
  }
  return { campaigns, refused };
}

/**
 * Both blocks at once, as every reader of the config wants them, with each
 * campaign's pair refusals found against the roster when one is given.
 */
export function parseCampaignBlocks(
  rawDefs: unknown,
  rawRows: unknown,
  roster?: Readonly<Record<string, PairRosterEntry>>,
): { definitions: PublishedCampaign[]; campaigns: Campaign[]; refused: CampaignRefusal[] } {
  const d = parseCampaignDefinitions(rawDefs);
  const c = parseCampaigns(rawRows, d.definitions);
  const pairs: CampaignRefusal[] = [];
  if (roster !== undefined) {
    for (const camp of c.campaigns) {
      camp.refusedPairs = campaignPairRefusals(camp, roster);
      for (const p of camp.refusedPairs) pairs.push({ key: pairRefusalKey(camp, p.ref, p.arm), reason: p.reason });
    }
  }
  return { definitions: d.definitions, campaigns: c.campaigns, refused: [...d.refused, ...c.refused, ...pairs] };
}

/** Look a published definition up by `id@version`. */
export function publishedOf(definitions: readonly PublishedCampaign[], ref: string): PublishedCampaign | undefined {
  return parseCampaignRef(ref) === null ? undefined : definitions.find((d) => d.ref === ref);
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

/** Which square a probe job is: travels on a pick, a job and a resume. */
export interface ProbeIdentity {
  campaign: string;
  version: number;
  cell: string;
  arm: string;
}

/**
 * The job a pinned campaign's square spawns under: `<campaign>-<cell>-<arm>`.
 * A job name is what run ids, log paths and the defer sidecar hang off, so it
 * names the whole square; the version is not in it because one row names one
 * version at a time.
 */
export function pinnedCampaignJobName(campaign: string, cell: string, arm: string): string {
  return `${campaign}-${cell}-${arm}`;
}

/** The job a policy pick of a square spawns under: `<ref>-<campaign>-<cell>-<arm>`. */
export function policyCampaignJobName(ref: string, campaign: string, cell: string, arm: string): string {
  return `${ref}-${campaign}-${cell}-${arm}`;
}

/** A probe run on disk, as the tally reads it: its stamps and nothing inferred. */
export interface ProbeRun {
  campaign: string | null;
  version: number | null;
  cell: string | null;
  /** The roster name the fleet launched it as (`config.ref`). */
  ref: string | null;
  /** The arm it ran (`config.arm`). A run with none predates arms and belongs to no square. */
  arm: string | null;
  /**
   * Whether the run counts toward `runsPerCell` (`isCounted`). Every campaign
   * run is passed in, counted or not, because a launch that failed is still
   * evidence the square was tried — the only thing that can stop a failing
   * square being swept forever.
   */
  counted: boolean;
  /** Still in flight: an attempt that may yet count. */
  live: boolean;
}

/** One (assignment, arm, cell) of a campaign, and what is on disk for it. */
export interface CampaignSquare {
  campaign: string;
  version: number;
  /** Roster name — the catalog entry whose credentials the runs use. */
  ref: string;
  arm: CampaignArm;
  cell: CampaignCell;
  /** The assignment's `runsPerCell`. */
  want: number;
  /** Counted runs, uncapped. */
  done: number;
  /** Launches, counted or not, live included. */
  attempts: number;
  live: number;
  /**
   * `done`: it has its runs. `capped`: it had its launches without them and
   * nothing is in flight, so no more are coming. Null: still owed.
   */
  settled: "done" | "capped" | null;
  /** Why its (assignment, arm) pair cannot launch (`campaignPairRefusals`); null when it can. Never scheduled while set. */
  refused: string | null;
}

function squareKey(campaign: string, version: number, ref: string, arm: string, cell: string): string {
  return `${campaign}\u0000${version}\u0000${ref}\u0000${arm}\u0000${cell}`;
}

/**
 * Every square of one campaign, in assignment × cell × arm order, with its
 * tally. The ONE count: the scheduler derives its work from it and the
 * campaigns page its progress and its state, so "complete" and the numbers
 * beside it can never disagree. A run belongs to a square only by its own
 * stamps — campaign, version, roster name, arm and cell — never by matching
 * its model against whatever the roster says today.
 *
 * Over every assignment the catalog names, healthy or not: eligibility is a
 * fact about this tick, not about the sweep (`campaignWork` applies it).
 */
export function campaignSquares(c: Campaign, catalog: readonly string[], probeRuns: readonly ProbeRun[]): CampaignSquare[] {
  const tally = new Map<string, { done: number; attempts: number; live: number }>();
  for (const r of probeRuns) {
    if (r.campaign !== c.name || r.version !== c.version || r.cell === null || r.ref === null || r.arm === null) continue;
    const k = squareKey(r.campaign, r.version, r.ref, r.arm, r.cell);
    const t = tally.get(k) ?? { done: 0, attempts: 0, live: 0 };
    t.attempts++;
    if (r.live) t.live++;
    if (r.counted) t.done++;
    tally.set(k, t);
  }
  const out: CampaignSquare[] = [];
  for (const a of campaignAssignments(c, catalog)) {
    for (const cell of c.cells) {
      for (const arm of c.arms) {
        const t = tally.get(squareKey(c.name, c.version, a.model, arm.id, cell.id)) ?? { done: 0, attempts: 0, live: 0 };
        const capped = c.maxAttemptsPerCell !== undefined && t.attempts >= c.maxAttemptsPerCell;
        out.push({
          campaign: c.name,
          version: c.version,
          ref: a.model,
          arm,
          cell,
          want: a.runsPerCell,
          done: t.done,
          attempts: t.attempts,
          live: t.live,
          settled: t.done >= a.runsPerCell ? "done" : capped && t.live === 0 ? "capped" : null,
          refused: c.refusedPairs.find((p) => p.ref === a.model && p.arm === arm.id)?.reason ?? null,
        });
      }
    }
  }
  return out;
}

/** What a campaign's squares add up to, as the page states it. */
export interface CampaignProgress {
  /** cells × arms × Σ runsPerCell, over the assignments the catalog names. */
  want: number;
  /** Counted runs, never more per square than it wants. */
  done: number;
  /** Launches, counted or not, live included. */
  attempted: number;
  /** Runs wanted on squares abandoned at the attempt cap: never coming, so `done + capped === want` exactly when every square is settled. */
  capped: number;
  live: number;
}

export function campaignProgress(squares: readonly CampaignSquare[]): CampaignProgress {
  let want = 0;
  let done = 0;
  let attempted = 0;
  let capped = 0;
  let live = 0;
  for (const s of squares) {
    want += s.want;
    done += Math.min(s.done, s.want);
    attempted += s.attempts;
    if (s.settled === "capped") capped += s.want - Math.min(s.done, s.want);
    live += s.live;
  }
  return { want, done, attempted, capped, live };
}

/** One square with work left on it, as the scheduler takes it. */
export interface CampaignWork {
  campaign: string;
  version: number;
  /** Roster name — the catalog entry whose credentials the run uses. */
  model: string;
  arm: CampaignArm;
  cell: CampaignCell;
  /** Counted probe runs already done for this square. */
  done: number;
  /** The assignment's `runsPerCell`: how many are wanted. */
  want: number;
  /** Launches already made for this square, counted or not. */
  attempts: number;
  /** The definition's `maxAttemptsPerCell`, when it set one. */
  maxAttempts?: number;
  /** Declaration order of the campaign, for tie-breaks. */
  order: number;
}

/**
 * Every square that still owes runs, across the enabled campaigns, in sweep
 * order.
 *
 * Sweep order spreads across models before it finishes any one of them: a
 * campaign that has touched every model once has told us more than one that
 * has finished a single model's cells, and a sweep that is going to be
 * interrupted (by an operator, a harness bump, a dead key) should be
 * interrupted holding breadth. So the first sort key is how much this model has
 * already done in this campaign, then the campaign's declaration order, then
 * the assignment's priority; within one assignment the arm that has done
 * least goes first, so a comparison's arms advance together, then cells and
 * arms in declaration order.
 *
 * A square is work while it is short of its counted runs and has not had its
 * `maxAttemptsPerCell` launches — a live launch counts toward the cap, so a
 * square at its cap is never launched again while its last attempt plays —
 * and while its (assignment, arm) pair is not refused.
 */
export function campaignWork(
  campaigns: readonly Campaign[],
  catalog: readonly string[],
  probeRuns: readonly ProbeRun[],
  eligible?: (name: string) => boolean,
): CampaignWork[] {
  const out: (CampaignWork & { modelDone: number; armDone: number; aIdx: number; cIdx: number; armIdx: number })[] = [];
  campaigns.forEach((c, order) => {
    if (!c.enabled) return;
    const healthy = new Set(campaignAssignments(c, catalog, eligible).map((a) => a.model));
    const squares = campaignSquares(c, catalog, probeRuns);
    const modelDone = new Map<string, number>();
    const armDone = new Map<string, number>();
    for (const s of squares) {
      modelDone.set(s.ref, (modelDone.get(s.ref) ?? 0) + s.done);
      armDone.set(`${s.ref}\u0000${s.arm.id}`, (armDone.get(`${s.ref}\u0000${s.arm.id}`) ?? 0) + s.done);
    }
    const assignmentIdx = new Map(c.assignments.map((a, i) => [a.model, i]));
    for (const s of squares) {
      if (!healthy.has(s.ref)) continue;
      if (s.refused !== null) continue;
      if (s.done >= s.want) continue;
      if (c.maxAttemptsPerCell !== undefined && s.attempts >= c.maxAttemptsPerCell) continue;
      out.push({
        campaign: c.name,
        version: c.version,
        model: s.ref,
        arm: s.arm,
        cell: s.cell,
        done: s.done,
        want: s.want,
        attempts: s.attempts,
        ...(c.maxAttemptsPerCell !== undefined ? { maxAttempts: c.maxAttemptsPerCell } : {}),
        order,
        modelDone: modelDone.get(s.ref) ?? 0,
        armDone: armDone.get(`${s.ref}\u0000${s.arm.id}`) ?? 0,
        aIdx: assignmentIdx.get(s.ref) ?? 0,
        cIdx: c.cells.indexOf(s.cell),
        armIdx: c.arms.indexOf(s.arm),
      });
    }
  });
  return out
    .sort(
      (a, b) =>
        a.modelDone - b.modelDone ||
        a.order - b.order ||
        a.aIdx - b.aIdx ||
        a.armDone - b.armDone ||
        a.cIdx - b.cIdx ||
        a.armIdx - b.armIdx,
    )
    .map(({ modelDone: _m, armDone: _a, aIdx: _i, cIdx: _c, armIdx: _r, ...w }) => w);
}
