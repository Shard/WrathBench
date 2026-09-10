/**
 * The Models surface: one row per roster model, over the single projection.
 *
 * Everything a row asserts about a model — how many runs it has toward its
 * target on each tier, whether it earned the long tier, whether it is cooling
 * or retired — comes from `runner/src/models.ts`. This module adds only what a
 * page needs and a scheduler does not: the run ids behind each count, the last
 * error a model died of, and the roster to project against. If a number here
 * ever disagreed with `--status` it would be because this file recomputed it,
 * so it recomputes nothing.
 *
 * Three rules worth stating, because they are the ones a reader trips on:
 *
 * - **The projection's key is `(model, effort)`, not the roster name.**
 *   `matchesRoster` in `runner/src/models.ts` matches runs that way, so two
 *   roster entries sharing a model string and an effort would legitimately show
 *   the same runs. The rows are not deduped: that is the honest reading, and
 *   hiding it would make one of the two look idle.
 * - **Counted is spelled once.** The run ids behind a count use `isCounted`
 *   from `runner/src/models.ts` — the same predicate that produced
 *   `EpisodeStats` — so the list and the count cannot differ.
 * - **The roster names the models.** The fleet config's `roster` map is the
 *   one source of a model's name; a fleet config without one is unreadable, not a
 *   config to invent names for.
 */

import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import {
  DEFAULT_POLICY,
  LADDER_MS,
  isCounted,
  parsePolicyBlock,
  policyExclusion,
  schedulability,
  schedulableView,
  readRunFact,
  type CountCache,
  type ModelState,
  type PolicyJob,
  type RosterModel,
  type SchedulingPolicy,
  type RunFact,
  type ClassAccountCounts,
  TIERS,
  TIER_TABLE,
  IDLE_MODES,
} from "../src/models";
import { harnessSeries } from "../src/comparability";
import { isEpisodeId } from "../src/episodes";
import { parseCampaigns, type Campaign } from "../src/campaigns";
import { harnessVersion } from "../src/version";
import type { EpisodeIdView, HarnessView, ModelEpisodeView, ModelRowView, ModelRunView, ModelsResponse } from "./api-types";
import { isArchiveDir } from "./archive-dir";
import { redactSecrets } from "./tail";

const RUN_ID = /^[A-Za-z0-9._-]+$/;

// ------------------------------------------------------------------ roster

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
    driver: z.string().min(1).optional(),
    apiBase: z.string().min(1).optional(),
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
 * The account classes, as counts. Read from the file rather than
 * from `fleet-state.json` so the page's concurrency figures agree with
 * `--status` even with the supervisor down — `--status` reads
 * `classAccountsOf(config, …)`, which is this same block.
 */
const fleetAccountsSchema = z
  .object({
    pool: z.array(z.string()).optional(),
    paid: z.array(z.string()).optional(),
    local: z.array(z.string()).optional(),
  })
  .loose();

const fleetRosterSchema = z
  .object({
    roster: z.record(z.string(), rosterEntrySchema),
    queue: z.array(fleetJobSchema).optional(),
    policy: z.unknown().optional(),
    accounts: fleetAccountsSchema.optional(),
    campaigns: z.unknown().optional(),
  })
  .loose();

/** How a fleet config answered when asked for a roster. */
export type RosterShape = "roster" | "missing" | "unreadable";

export interface RosterRead {
  models: RosterModel[];
  shape: RosterShape;
  /** The file that was consulted, as it was given — never a host path guess. */
  path: string | null;
  /** The file's `policy` block over the defaults (`parsePolicyBlock`), keyed on this checkout's series. */
  policy: SchedulingPolicy;
  /**
   * `policy.maxConcurrent`: streams the policy may have in flight per key
   * (`concurrencyKeyOf`, plus the `claude-code:<ENV NAME>` subscription lanes,
   * which a claude run spends alongside the `claude-code` total). Absent key
   * means unlimited; an empty object means the file names no cap.
   */
  maxConcurrent: Record<string, number>;
  /**
   * Roster names the policy does not schedule, with why (`policyRefs` in
   * `runner/src/models.ts` — the supervisor's own predicate): a name a pinned
   * job holds, or one carrying an objective. Their runs are a probe's, not the
   * model's evidence, so `/api/models` lists them apart from the rows rather
   * than beside a model whose counts they would duplicate (item 52).
   */
  excluded: { name: string; reason: string }[];
  /**
   * Every entry the roster names — rowed or not. `models` holds only the ones
   * the policy can schedule (a steered entry carries no tier and owns no
   * budget), so this is what the page means by "the roster has N entries".
   */
  count: number;
  /** `accounts.pool` / `.paid` / `.local` as counts: the ETA's concurrency. */
  accounts: ClassAccountCounts;
  /**
   * The `campaigns` block, or empty when the file names none or names
   * them unreadably. The viewer reports what a file says and never adjudicates
   * it — a campaigns block the supervisor would refuse simply reads as absent
   * here rather than taking the whole roster down with it.
   */
  campaigns: Campaign[];
}

/** The series this viewer runs from — what the projection counts against. */
export function currentSeries(): string | null {
  return harnessSeries(harnessVersion());
}

/**
 * Read the roster out of a fleet config. A file without a `roster` map is
 * `unreadable` — the same posture `readFleet` takes to a missing
 * `fleet-state.json`: say the file is not usable, do not synthesise what it
 * would have said.
 */
export function readFleetRoster(path: string | undefined, series: string | null = currentSeries()): RosterRead {
  const defaults: SchedulingPolicy = { ...DEFAULT_POLICY, series };
  const empty = { models: [], policy: defaults, maxConcurrent: {}, excluded: [], count: 0, accounts: {}, campaigns: [] };
  if (path === undefined || path.length === 0) {
    return { ...empty, shape: "missing", path: null };
  }
  if (!existsSync(path)) return { ...empty, shape: "missing", path };
  let parsed: z.infer<typeof fleetRosterSchema>;
  try {
    parsed = fleetRosterSchema.parse(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return { ...empty, shape: "unreadable", path };
  }
  let policy: SchedulingPolicy = defaults;
  let maxConcurrent: Record<string, number> = {};
  try {
    const { maxConcurrent: cap, ...rest } = parsePolicyBlock(parsed.policy, series);
    policy = rest;
    maxConcurrent = cap;
  } catch {
    /* a malformed policy block is the supervisor's to refuse; the page shows the defaults */
  }
  const models: RosterModel[] = [];
  for (const [name, e] of Object.entries(parsed.roster)) {
    if (e.tier === undefined) continue;
    models.push({
      name,
      model: e.model,
      ...(e.effort !== undefined ? { effort: e.effort } : {}),
      ...(e.driver !== undefined ? { driver: e.driver } : {}),
      ...(e.apiBase !== undefined ? { apiBase: e.apiBase } : {}),
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
  const accounts: ClassAccountCounts = {
    pool: parsed.accounts?.pool?.length ?? 0,
    paid: parsed.accounts?.paid?.length ?? 0,
    local: parsed.accounts?.local?.length ?? 0,
  };
  let campaigns: Campaign[] = [];
  try {
    campaigns = parseCampaigns(parsed.campaigns);
  } catch {
    // See `campaigns` on RosterRead: unreadable reads as absent.
  }
  return { models, shape: "roster", path, policy, maxConcurrent, excluded, count: Object.keys(parsed.roster).length, accounts, campaigns };
}

// ------------------------------------------------------------- run facts

/** What makes a cached fact stale: either artefact changing size or mtime. */
function signature(dir: string): { sig: string; mtime: number | null } {
  let sig = "";
  let mtime: number | null = null;
  for (const name of ["trajectory.jsonl", "run.sqlite"]) {
    try {
      const st = statSync(join(dir, name));
      sig += `${name}:${st.size}:${st.mtimeMs}|`;
      if (name === "trajectory.jsonl") mtime = st.mtimeMs;
    } catch {
      sig += `${name}:-|`;
    }
  }
  return { sig, mtime };
}

export interface FactCacheEntry {
  sig: string;
  fact: RunFact | null;
  /** The trajectory's mtime, so liveness can be re-decided against a new `now`. */
  mtime: number | null;
}

/** A trajectory touched more recently than this belongs to a live process. */
export const LIVE_WINDOW_MS = 120_000;

/**
 * Every stamped run, memoised per run on (size, mtime) of its two artefacts.
 *
 * `readRunFacts` reads every `trajectory.jsonl` in full to count model
 * responses, which is fine once and ruinous every thirty seconds across
 * hundreds of finished runs. A finished run's files never change again, so its
 * fact is read once per process — the same bargain `runTotals` strikes in
 * `api.ts`. Liveness is the one field that cannot be cached, because it is a
 * claim about *now*, so it is re-decided from the cached mtime on every call.
 */
/**
 * The record-count scanners behind the fact cache, one map per fact cache.
 *
 * A live run's signature moves between every poll, so its fact is re-read every
 * time — and reading it used to mean reading a 400MB trajectory from byte zero.
 * The scanners fold only what has been appended since the last poll
 * (`countRecordsCached`). They hang off the fact cache rather than off the
 * module so that a caller's cache is the whole lifetime of the memory, and they
 * are swept by the same loop that drops a vanished run below.
 */
const COUNT_CACHES = new WeakMap<Map<string, FactCacheEntry>, CountCache>();

function countCacheFor(cache: Map<string, FactCacheEntry>): CountCache {
  let counts = COUNT_CACHES.get(cache);
  if (counts === undefined) {
    counts = new Map();
    COUNT_CACHES.set(cache, counts);
  }
  return counts;
}

/**
 * Told whenever the memo changes: an entry written (`entry`) or a vanished
 * run dropped (`null`). The persisted cache in `fact-store.ts` is the only
 * caller that passes one; without it this behaves exactly as it always has.
 */
export type FactCacheChange = (id: string, entry: FactCacheEntry | null) => void;

export function readRunFactsCached(
  runsDir: string,
  cache: Map<string, FactCacheEntry>,
  now = Date.now(),
  onChange?: FactCacheChange,
): RunFact[] {
  let names: string[];
  try {
    names = readdirSync(runsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && RUN_ID.test(d.name) && !isArchiveDir(d.name))
      .map((d) => d.name);
  } catch {
    return [];
  }
  const out: RunFact[] = [];
  const seen = new Set<string>();
  const counts = countCacheFor(cache);
  for (const id of names) {
    seen.add(id);
    const dir = join(runsDir, id);
    const { sig, mtime } = signature(dir);
    let hit = cache.get(id);
    if (hit === undefined || hit.sig !== sig) {
      hit = { sig, fact: readRunFact(runsDir, id, now, { counts }), mtime };
      cache.set(id, hit);
      onChange?.(id, hit);
    }
    if (hit.fact === null) continue;
    const live = hit.fact.terminationReason === null && hit.mtime !== null && now - hit.mtime < LIVE_WINDOW_MS;
    out.push(live === hit.fact.live ? hit.fact : { ...hit.fact, live });
  }
  for (const id of [...cache.keys()]) {
    if (seen.has(id)) continue;
    cache.delete(id);
    counts.delete(join(runsDir, id, "trajectory.jsonl"));
    onChange?.(id, null);
  }
  out.sort((a, b) => a.startedAt - b.startedAt || (a.runId < b.runId ? -1 : a.runId > b.runId ? 1 : 0));
  return out;
}

// ------------------------------------------------------------ last error

/** Termination reasons that are an error the operator would want the text of. */
export const ERROR_REASONS: ReadonlySet<string> = new Set(["adapter-error", "harness-error", "stale-character"]);

/** How much of a provider's error text is worth carrying to a table cell. */
export const ERROR_MAX_CHARS = 300;

/** The tail of a trajectory that is read looking for the termination record. */
export const ERROR_TAIL_BYTES = 64 * 1024;

export interface LastError {
  runId: string;
  reason: string;
  message: string;
  at: number | null;
}

/**
 * The message a run died of, off the end of its own trajectory.
 *
 * Bounded on purpose: the last 64KB, which holds the termination record of any
 * run that wrote one, rather than the whole file. Two redactions, because an
 * error message is provider text and the boundary rule is that nothing leaks:
 * `redactSecrets` handles a secret sitting under a known key, and the run's own
 * recorded token is struck out of the string itself, which a key-name rule
 * cannot do when the value is interpolated into a URL.
 */
export function lastErrorOf(dir: string, runId: string): LastError | null {
  const path = join(dir, "trajectory.jsonl");
  if (!existsSync(path)) return null;
  let text: string;
  let partial = false;
  try {
    const st = statSync(path);
    const from = Math.max(0, st.size - ERROR_TAIL_BYTES);
    partial = from > 0;
    const len = st.size - from;
    const buf = Buffer.alloc(len);
    const fd = openSync(path, "r");
    try {
      readSync(fd, buf, 0, len, from);
    } finally {
      closeSync(fd);
    }
    text = buf.toString("utf8");
  } catch {
    return null;
  }
  const lines = text.split("\n");
  // A window that started mid-file almost certainly cut its first line in half.
  if (partial && lines.length > 1) lines.shift();
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    if (line.length === 0 || !line.includes(`"termination"`)) continue;
    let rec: { t?: unknown; ts?: unknown; reason?: unknown; detail?: unknown };
    try {
      rec = redactSecrets(JSON.parse(line)) as typeof rec;
    } catch {
      continue;
    }
    if (rec.t !== "termination" || typeof rec.reason !== "string" || !ERROR_REASONS.has(rec.reason)) continue;
    const raw = typeof rec.detail === "string" && rec.detail.length > 0 ? rec.detail : rec.reason;
    const scrubbed = stripSecrets(dir, raw);
    return {
      runId,
      reason: rec.reason,
      message: scrubbed.length > ERROR_MAX_CHARS ? `${scrubbed.slice(0, ERROR_MAX_CHARS)}…` : scrubbed,
      at: typeof rec.ts === "number" ? rec.ts : null,
    };
  }
  return null;
}

/**
 * Strike a run's own recorded secrets out of a free-text message.
 *
 * `redactSecrets` keys on field names, which is right for a record and useless
 * for a sentence that interpolated the token into a URL. The run's `meta.json`
 * is where the token was written, so it is also what can be searched for.
 */
function stripSecrets(dir: string, message: string): string {
  let out = message;
  try {
    const meta = JSON.parse(readFileSync(join(dir, "meta.json"), "utf8")) as {
      config?: Record<string, unknown>;
    };
    for (const key of ["token", "apiKey", "authorization", "password"]) {
      const v = meta.config?.[key];
      if (typeof v === "string" && v.length >= 8) out = out.split(v).join("[redacted]");
    }
  } catch {
    /* no meta is no secret to strike */
  }
  return out;
}

// ------------------------------------------------------------ projection

function durationOf(f: RunFact): number | null {
  if (f.endedAt === null || f.startedAt <= 0) return null;
  const ms = f.endedAt - f.startedAt;
  return ms >= 0 ? ms : null;
}

function runView(f: RunFact): ModelRunView {
  return {
    runId: f.runId,
    episode: f.episode as EpisodeIdView,
    episodeOverride: f.episodeOverride,
    harnessVersion: f.harnessVersion,
    harnessSeries: f.harnessSeries,
    extra: f.extra,
    startedAt: f.startedAt,
    endedAt: f.endedAt,
    durationMs: durationOf(f),
    bestLevel: f.bestLevel,
    terminationReason: f.terminationReason,
    live: f.live,
    counted: isCounted(f),
  };
}

/**
 * One roster model's row: the projection, plus the ids behind the counts.
 *
 * `runs` is every stamped run the projection matched, newest first — the
 * detail panel's list — and the per-episode id lists are slices of it, so a row
 * cannot show a count whose runs are not in its own panel.
 */
export function rowOf(state: ModelState, runs: readonly RunFact[], runsDir: string, running: ReadonlySet<string> = new Set(), policy: SchedulingPolicy = DEFAULT_POLICY): ModelRowView {
  const mine = runs
    .filter((f) => f.model === state.model && (f.effort ?? null) === state.effort)
    .slice()
    .sort((a, b) => b.startedAt - a.startedAt);
  const perEpisode: Partial<Record<EpisodeIdView, ModelEpisodeView>> = {};
  for (const [id, stats] of Object.entries(state.perEpisode)) {
    const ep = id as EpisodeIdView;
    const tier = mine.filter((f) => f.episode === ep);
    // `stillborn` stays a scheduler-side stat (it feeds the defer ladder and
    // `--status`); it is not part of the API, because a zero-response run is
    // archived at exit and the viewer never has one to show.
    const { stillborn: _archived, ...rest } = stats;
    perEpisode[ep] = { ...rest, runIds: tier.filter((f) => isCounted(f)).map((f) => f.runId) };
  }
  // The newest run that actually failed, not the newest run: a model whose last
  // episode was fine still owes the operator the text of the three before it.
  const failed = mine.find((f) => f.terminationReason !== null && ERROR_REASONS.has(f.terminationReason));
  const lastError = failed === undefined ? null : lastErrorOf(join(runsDir, failed.runId), failed.runId);
  return {
    name: state.name,
    model: state.model,
    effort: state.effort,
    platform: state.platform,
    harness: state.harness,
    billing: state.billing,
    status: state.status,
    eligible: state.eligible as EpisodeIdView[],
    perEpisode,
    ...(state.cooling !== undefined ? { cooling: state.cooling } : {}),
    ...(state.retired !== undefined ? { retired: state.retired } : {}),
    ladder: state.ladder,
    declaredTier: state.declaredTier,
    tier: state.tier,
    earnedRung1: state.earnedRung1,
    idle: state.idle,
    schedulable: schedulableView(schedulability(state, running, policy), state),
    runs: mine.map(runView),
    newestRunId: mine.length > 0 ? mine[0]!.runId : null,
    lastError,
  };
}

/** The whole response, given the projection and the facts it was built from. */
export function modelsResponse(opts: {
  states: readonly ModelState[];
  runs: readonly RunFact[];
  runsDir: string;
  roster: RosterRead;
  now?: number;
  /** Optional harness filter; "all" or absent lists every row. */
  harness?: HarnessView | "all";
  /** Roster refs with a job in flight (the supervisor's state), for the verdict. */
  running?: ReadonlySet<string>;
}): ModelsResponse {
  const harness = opts.harness ?? "all";
  const byHarness = harness === "all" ? opts.states : opts.states.filter((s) => s.harness === harness);
  /*
   * Excluded entries are not rows. `nav-probe` is the model `sonnet` under an
   * objective, so its projection is `sonnet`'s counts wearing another name:
   * listed as a row it reads as a second model with the same evidence. The
   * names and the reasons ride along under `roster.excluded`, so the page can
   * say what it is not showing (item 52).
   */
  const outside = new Set(opts.roster.excluded.map((e) => e.name));
  const states = byHarness.filter((s) => !outside.has(s.name));
  return {
    models: states.map((s) => rowOf(s, opts.runs, opts.runsDir, opts.running ?? new Set(), opts.roster.policy)),
    roster: {
      path: opts.roster.path,
      shape: opts.roster.shape,
      count: opts.roster.count,
      excluded: opts.roster.excluded,
    },
    policy: {
      promoteAtLevel: opts.roster.policy.promoteAtLevel,
      series: opts.roster.policy.series,
      paid: opts.roster.policy.paid,
      tiers: TIER_TABLE,
      maxConcurrent: opts.roster.maxConcurrent,
    },
    ladderMs: [...LADDER_MS],
    harness,
    now: opts.now ?? Date.now(),
  };
}
