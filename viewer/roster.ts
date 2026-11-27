/**
 * The roster as a viewer reads it: the store's `site` block, the roster's rows
 * and the names the policy leaves out, off one read of the config store. What
 * every handle needs — `/api/info`'s site block, the run page's roster name —
 * and nothing the scheduler adds: the policy, the credentials, the account
 * pool and the campaigns are completed from this by `models.ts`
 * (`fullRosterOf`), which only the runner and evals groups' routes load.
 *
 * The roster schema is here, the one both halves parse with, so the rows a
 * run page names and the rows `/api/models` lists cannot differ.
 */

import { z } from "zod";
import { parseEntryCompactWindow } from "../runner/src/config";
import { DEFAULT_DRIVER } from "../runner/src/drivers";
import { configDbPath, readFleetConfig, type FleetRead } from "../runner/src/config-read";
import { entryOwnsWindow, IDLE_MODES, policyExclusion, TIERS, type PolicyJob, type RosterModel } from "../runner/src/roster-entry";
import { canonicalModelId } from "../infra/model-catalogue";
import { entryModelIds } from "../runner/src/provider-options";
import { siteSettingsOf, type SiteSettings } from "../runner/src/site-settings";

/**
 * The roster block of a fleet config, at the boundary.
 *
 * Deliberately narrow: the supervisor's own `parseFleet` validates the whole
 * file, but it lives in `infra/run-fleet.ts` beside `bun:sqlite`, a repo-root
 * assumption and the spawn path, and the viewer may not import any of that.
 * What the projection needs off an entry is its identity and its two
 * overrides, so that is all this parses; everything else is passed over
 * rather than rejected, because the viewer is not the thing that validates
 * the fleet's config.
 */
const rosterEntrySchema = z
  .object({
    model: z.string().min(1),
    effort: z.string().min(1).optional(),
    /**
     * As the operator wrote it: the store keeps the raw document, so this is
     * canonicalised below (`windowOf`) before anything matches runs on it.
     */
    compactWindow: z.string().min(1).optional(),
    driver: z.string().min(1).optional(),
    apiBase: z.string().min(1).optional(),
    /** The entry's providers (`runner/src/provider-options.ts`): read for what owns a run, and the first is the entry's own. */
    providers: z.array(z.object({ credential: z.string().min(1), apiBase: z.string().min(1).optional(), model: z.string().min(1).optional() }).loose()).min(1).optional(),
    billing: z.enum(["free", "paid"]).optional(),
    /** An objective puts the entry outside the policy (`policyExclusion`). */
    objective: z.string().min(1).optional(),
    // The evidence budget and the idle axis. Validated against the
    // projection's own exported key sets, so the two parsers cannot drift on
    // what a tier IS even while they stay deliberate twins on everything else.
    // Optional HERE and required in the supervisor's own parser, deliberately:
    // the viewer does not validate the fleet's config, it reads it. An entry
    // with no tier is one the policy does not schedule — a steered probe, or a
    // mistake the supervisor is already refusing by name — so it is skipped
    // below rather than rowed with a tier nobody wrote.
    tier: z.enum(TIERS).optional(),
    idle: z.enum(IDLE_MODES).optional(),
  })
  .loose();

/**
 * A job, as narrowly as the membership predicate needs it: the roster names it
 * holds and the account it is pinned to. The file calls the list `queue`
 * (the key survived the concept's rename to "job"); a job
 * with an `account` is pinned.
 */
const fleetJobSchema = z
  .object({
    ref: z.union([z.string(), z.array(z.string())]),
    account: z.string().min(1).optional(),
    episode: z.string().optional(),
  })
  .loose();

/**
 * The account pool, as a count of live sessions. Read from the file rather
 * than from `fleet-state.json` so the page's concurrency figures agree with
 * `--status` even with the supervisor down.
 */
const fleetAccountsSchema = z
  .object({
    pool: z.array(z.string()).optional(),
    max: z.number().optional(),
  })
  .loose();

const fleetRosterSchema = z
  .object({
    roster: z.record(z.string(), rosterEntrySchema),
    queue: z.array(fleetJobSchema).optional(),
    policy: z.unknown().optional(),
    accounts: fleetAccountsSchema.optional(),
    credentials: z.unknown().optional(),
    campaigns: z.unknown().optional(),
    "campaign-defs": z.unknown().optional(),
  })
  .loose();

/** A fleet config document as the roster schema reads it. */
export type FleetRosterDoc = z.infer<typeof fleetRosterSchema>;

/** How a fleet config answered when asked for a roster. */
export type RosterShape = "roster" | "missing" | "unreadable";

/** The roster's rows and names, and the store's `site` block, off one read. */
export interface RosterNames {
  models: RosterModel[];
  shape: RosterShape;
  /** The file that was consulted, as it was given — never a host path guess. */
  path: string | null;
  /**
   * Roster names the policy does not schedule, with why (`policyRefs` in
   * `runner/src/models.ts` — the supervisor's own predicate): a name a pinned
   * job holds, or one carrying an objective. Their runs are a probe's, not the
   * model's evidence, so `/api/models` lists them apart from the rows rather
   * than beside a model whose counts they would duplicate.
   */
  excluded: { name: string; reason: string }[];
  /**
   * Every entry the roster names — rowed or not. `models` holds only the ones
   * the policy can schedule (a steered entry carries no tier and owns no
   * budget), so this is what the page means by "the roster has N entries".
   */
  count: number;
  /** The store's `site` block (`runner/src/site-settings.ts`); empty when absent or unreadable. */
  site: SiteSettings;
}

/** `RosterNames`, and the document they were read from, for `models.ts` to complete; null when the roster did not read. */
export interface RosterBase extends RosterNames {
  doc: FleetRosterDoc | null;
}

/**
 * A roster entry's compaction window as the supervisor reads it
 * (`parseEntryCompactWindow`): canonical (`"100K"` → `"100k"`), and `auto`
 * absent except on a driver that defaults a window, where it is the entry's
 * opt-out. A value the parser refuses reads as absent too — the supervisor
 * refuses that config, so no run carries it.
 */
export function windowOf(raw: string | undefined, driver: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  try {
    return parseEntryCompactWindow(raw, driver ?? DEFAULT_DRIVER);
  } catch {
    return undefined;
  }
}

/**
 * The roster's names off a read of the config store (`readFleetConfig`), the
 * only fleet config, so a page names what the supervisor is actually
 * scheduling. An empty or absent store is `missing` — a deployment before its
 * seed, labelled rather than thrown. A store that cannot be read, or a config
 * without a `roster` map, is `unreadable` — the same posture `readFleet` takes
 * to a missing `fleet-state.json`: say it is not usable, do not synthesise
 * what it would have said. `path` is the store's.
 */
export function rosterBaseOf(read: FleetRead): RosterBase {
  const empty = { models: [], excluded: [], count: 0, site: {}, doc: null };
  const path = read.path;
  if (read.status === "empty") return { ...empty, shape: "missing", path };
  if (read.status === "unreadable") return { ...empty, shape: "unreadable", path };
  let doc: unknown;
  try {
    doc = JSON.parse(read.text);
  } catch {
    return { ...empty, shape: "unreadable", path };
  }
  // Before the roster: a display setting holds whatever shape the roster is in.
  const site = siteSettingsOf(typeof doc === "object" && doc !== null ? (doc as { site?: unknown }).site : undefined);
  let parsed: FleetRosterDoc;
  try {
    parsed = fleetRosterSchema.parse(doc);
  } catch {
    return { ...empty, site, shape: "unreadable", path };
  }
  const models: RosterModel[] = [];
  for (const [name, e] of Object.entries(parsed.roster)) {
    if (e.tier === undefined) continue;
    const compactWindow = windowOf(e.compactWindow, e.driver);
    // As the supervisor's parser leaves it: each provider's model stated, the first the entry's own.
    const providers = e.providers?.map((p) => ({ credential: p.credential, model: p.model ?? e.model, ...(p.apiBase !== undefined ? { apiBase: p.apiBase } : {}) }));
    const apiBase = providers === undefined ? e.apiBase : providers[0]!.apiBase;
    models.push({
      name,
      model: providers?.[0]!.model ?? e.model,
      ...(e.effort !== undefined ? { effort: e.effort } : {}),
      ...(compactWindow !== undefined ? { compactWindow } : {}),
      ...(e.driver !== undefined ? { driver: e.driver } : {}),
      ...(apiBase !== undefined ? { apiBase } : {}),
      ...(providers !== undefined ? { providers } : {}),
      ...(e.billing !== undefined ? { billing: e.billing } : {}),
      tier: e.tier,
      ...(e.idle !== undefined ? { idle: e.idle } : {}),
    });
  }
  /* The exclusion, from the supervisor's own predicate, over the queue. */
  const jobs: PolicyJob[] = (parsed.queue ?? []).map((j) => {
    const refs = typeof j.ref === "string" ? [j.ref] : j.ref;
    return {
      refs,
      ...(j.account !== undefined ? { account: j.account } : {}),
      name: `${refs[0] ?? "job"}-${typeof j.episode === "string" ? j.episode : "e90"}`,
    };
  });
  // Over every roster NAME. One reason is left — a pinned job holds this
  // account — since a catalog entry can no longer carry an objective
  // and a campaign borrows a model rather than removing it from the schedule.
  const excluded: { name: string; reason: string }[] = [];
  for (const name of Object.keys(parsed.roster)) {
    const reason = policyExclusion(jobs, {}, name);
    if (reason !== undefined) excluded.push({ name, reason });
  }
  return { models, shape: "roster", path, excluded, count: Object.keys(parsed.roster).length, site, doc: parsed };
}

/** `rosterBaseOf` over the config store at `dbPath`. */
export function readRosterBase(dbPath: string = configDbPath()): RosterBase {
  return rosterBaseOf(readFleetConfig(dbPath));
}

/**
 * The roster row a run belongs to, by name: what the run page links its model
 * to. A run records a model string, an effort and a compaction window, never
 * the name that scheduled it, so the match is on that identity over exactly
 * the rows `/api/models` lists (`modelsResponse`: the roster in order, the
 * excluded names left out). An effort or window the roster has no row for
 * still points at the model's own row, which is more useful than no link.
 * Null for a run with no model, or a model the roster does not name.
 */
export function rosterNameOf(
  roster: Pick<RosterNames, "models" | "excluded">,
  model: string | null,
  effort: string | null = null,
  compactWindow: string | null = null,
): string | null {
  if (model === null) return null;
  const outside = new Set(roster.excluded.map((e) => e.name));
  const rows = roster.models.filter((m) => !outside.has(m.name));
  const hit = rows.find(
    (r) => entryModelIds(r).includes(model) && (r.effort ?? null) === effort && entryOwnsWindow(r, compactWindow),
  );
  if (hit !== undefined) return hit.name;
  const own = rows.find((r) => entryModelIds(r).includes(model));
  if (own !== undefined) return own.name;
  // The same model on another provider is the same row (operator, 2026-11-16).
  const canonical = canonicalModelId(model);
  const same = rows.filter((r) => entryModelIds(r).some((m) => canonicalModelId(m) === canonical));
  return (same.find((r) => (r.effort ?? null) === effort && entryOwnsWindow(r, compactWindow)) ?? same[0])?.name ?? null;
}
