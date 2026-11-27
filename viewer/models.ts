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
 * - **The projection's key is `(model, effort, compactWindow)`, not the roster
 *   name.** `entryOwnsRun` in `runner/src/models.ts` matches runs that
 *   way, so two roster entries sharing all three would legitimately show
 *   the same runs, as would an entry with no window beside a copy stating its
 *   driver's default. The rows are not deduped: that is the honest reading,
 *   and hiding it would make one of the two look idle. Counts go one step
 *   further: they are the model's under any of its entries, whichever provider
 *   served it (`sameModel`, operator 2026-11-16), and a row names the entries
 *   it shares them with (`siblings`), which the page draws as one row.
 * - **Counted is spelled once.** The run ids behind a count use `isCounted`
 *   from `runner/src/models.ts` — the same predicate that produced
 *   `EpisodeStats` — so the list and the count cannot differ.
 * - **The roster names the models.** The fleet config's `roster` map is the
 *   one source of a model's name; a fleet config without one is unreadable, not a
 *   config to invent names for.
 */

import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_DRIVER, driverEntry } from "../runner/src/drivers";
import { entryBilling } from "../runner/src/billing";
import { configDbPath } from "../runner/src/config-read";
import { DEFAULT_POLICY, LADDER_MS, countsTowardTarget, isCounted, parsePolicyBlock, entryOwnsRun, sameModel, platformOf, schedulability, verdictForGroups, schedulableView, type ModelState, type SchedulingPolicy, TIER_TABLE } from "../runner/src/models";
import { ownedWindows } from "../runner/src/roster-entry";
import type { RunFact } from "../runner/src/run-fact";
import { harnessSeries } from "../runner/src/comparability-tuple";
import { parseCampaignBlocks, type Campaign, type CampaignRefusal, type PublishedCampaign } from "../runner/src/campaigns";
import { rosterEntryRefusal } from "../runner/src/roster-refusal";
import { poolSizeOf } from "../runner/src/account-pool";
import { parseCredentials, type Credential } from "../runner/src/credential-slots";
import { harnessVersion } from "../runner/src/version";
import type { EpisodeIdView, HarnessView } from "./api-types";
import type { ModelEpisodeView, ModelRowView, ModelRunView, ModelsResponse } from "./api-types-runner";
import { readRosterBase, windowOf, type RosterBase, type RosterNames } from "./roster";
import { redactSecrets } from "./tail";

// ------------------------------------------------------------------ roster

/*
 * The roster's rows, its names and the `site` block are `roster.ts`'s, which
 * every handle reads; what this adds is what only the scheduler's pages need.
 */
interface RosterRead extends RosterNames {
  /** The file's `policy` block over the defaults (`parsePolicyBlock`), keyed on this checkout's series. */
  policy: SchedulingPolicy;
  /**
   * The provider credentials runs take slots on (`runner/src/credential-slots.ts`),
   * in preference order; empty when the store names none, or names them
   * unreadably (the supervisor's to refuse).
   */
  credentials: Credential[];
  /** How many pool accounts may be live at once (`accounts.max`, else the pool's size): the ETA's concurrency. */
  accounts: number;
  /**
   * The `campaigns` block joined to its published definitions, or empty when
   * the store names none or names them unreadably — a campaigns block that
   * cannot be read does not take the whole roster down with it, and it is
   * named in `campaignRefusals` rather than dropped.
   */
  campaigns: Campaign[];
  /** Every published campaign definition (`campaign-defs`), named by a row or not. */
  campaignDefs: PublishedCampaign[];
  /**
   * Everything the campaign parser read and would not use, by store key, as
   * the supervisor reads it (`parseCampaignBlocks`); an unreadable block is
   * one refusal keyed `campaigns`. The campaigns page shows every one.
   */
  campaignRefusals: CampaignRefusal[];
}

/** The series this viewer runs from — what the projection counts against. */
export function currentSeries(): string | null {
  return harnessSeries(harnessVersion());
}

/**
 * The whole roster off its names (`roster.ts`): the policy, the credentials,
 * the account pool and the campaigns, read from the same document, so this
 * page shows what the supervisor is actually scheduling. A roster that did not
 * read carries the defaults and nothing else. `env` is where the deploy-time
 * self-hosted model hosts are read from (`rosterEntryRefusal`), the same
 * variable every pod that parses the store is given.
 */
export function completeRoster(
  base: RosterBase,
  series: string | null = currentSeries(),
  env: Record<string, string | undefined> = process.env,
): RosterRead {
  const { doc: parsed, ...names } = base;
  const defaults: SchedulingPolicy = { ...DEFAULT_POLICY, series };
  if (parsed === null) return { ...names, policy: defaults, credentials: [], accounts: 0, campaigns: [], campaignDefs: [], campaignRefusals: [] };
  let policy: SchedulingPolicy = defaults;
  try {
    policy = parsePolicyBlock(parsed.policy, series);
  } catch {
    /* a malformed policy block is the supervisor's to refuse; the page shows the defaults */
  }
  let credentials: Credential[] = [];
  try {
    credentials = parseCredentials(parsed.credentials);
  } catch {
    /* a malformed credential is the supervisor's to refuse; the page shows none */
  }
  // No pool listed is the generated one, sized by the deployment as the supervisor reads it.
  const generated = poolSizeOf(env);
  const poolSize = parsed.accounts?.pool?.length ?? ("size" in generated ? generated.size : 0);
  const accounts = Math.min(poolSize, parsed.accounts?.max ?? poolSize);
  let campaigns: Campaign[] = [];
  let campaignDefs: PublishedCampaign[] = [];
  let campaignRefusals: CampaignRefusal[] = [];
  try {
    // What the supervisor reads, refusals and all: a row naming an
    // unpublished version, a definition that no longer checks out, an
    // (assignment, arm) pair that cannot launch. Carried to the page, never
    // swallowed.
    // An entry the supervisor refuses — an unknown key, a base no
    // credential provider serves, a pinned credential that cannot carry it —
    // is scheduled by nothing, so its squares are refused here
    // too (`campaignPairRefusals`), not shown as owed work. The verdict is the
    // supervisor's own function (`rosterEntryRefusal`); its text stays off the
    // page, whose squares say only that the entry is refused.
    const pairs = Object.fromEntries(
      Object.entries(parsed.roster).map(([n, e]) => {
        const refused = rosterEntryRefusal(e, credentials, env)?.why;
        return [n, { driver: e.driver, compactWindow: windowOf(e.compactWindow, e.driver), ...(refused !== undefined ? { refused } : {}) }];
      }),
    );
    // Where an arm can launch, as far as this reader knows: the setting, and
    // not the cluster, which only the supervisor can tell.
    ({ campaigns, definitions: campaignDefs, refused: campaignRefusals } = parseCampaignBlocks(parsed["campaign-defs"], parsed.campaigns, pairs, { runPods: policy.runPods }));
  } catch (err) {
    // A block the supervisor could not read at all: one refusal, so the page
    // says so instead of showing no campaigns.
    campaignRefusals = [{ key: "campaigns", reason: err instanceof Error ? err.message : String(err) }];
  }
  return { ...names, policy, credentials, accounts, campaigns, campaignDefs, campaignRefusals };
}

/** Each shared read's completion (`fullRosterOf`), dropped with the read it was made from. */
const completed = new WeakMap<RosterBase, RosterRead>();

/**
 * The whole roster over the read a handle shares (`api.ts`'s `fleetRoster`,
 * held on the store's short window): completed once per read, so the runner
 * and evals routes polling it cost one completion a window, as they cost one
 * read.
 */
export function fullRosterOf(base: RosterBase): RosterRead {
  let read = completed.get(base);
  if (read === undefined) {
    read = completeRoster(base);
    completed.set(base, read);
  }
  return read;
}

/**
 * Read the whole roster out of the config store (`runner/src/config-store.ts`):
 * `roster.ts`'s read, completed (`completeRoster`). `path` is the store's.
 */
export function readFleetRoster(
  dbPath: string = configDbPath(),
  series: string | null = currentSeries(),
  env: Record<string, string | undefined> = process.env,
): RosterRead {
  return completeRoster(readRosterBase(dbPath), series, env);
}

// ------------------------------------------------------------- run facts


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
function lastErrorOf(dir: string, runId: string): LastError | null {
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
export function rowOf(
  state: ModelState,
  runs: readonly RunFact[],
  runsDir: string,
  running: ReadonlySet<string> = new Set(),
  policy: SchedulingPolicy = DEFAULT_POLICY,
  /** The evals group (`viewer/groups.ts`): off, owing a counted run reads as free, as the supervisor treats it. */
  evals = true,
  /** Those of `running` that hold the model's other entries (`schedulability`); absent, every one does. */
  holding: ReadonlySet<string> = running,
): ModelRowView {
  const mine = runs
    .filter((f) => entryOwnsRun(state, f))
    .slice()
    .sort((a, b) => b.startedAt - a.startedAt);
  // What its counts count: the model's runs under any of its entries (`sameModel`).
  const ofModel = runs.filter((f) => sameModel(state, f)).sort((a, b) => b.startedAt - a.startedAt);
  const perEpisode: Partial<Record<EpisodeIdView, ModelEpisodeView>> = {};
  for (const [id, stats] of Object.entries(state.perEpisode)) {
    const ep = id as EpisodeIdView;
    const tier = ofModel.filter((f) => f.episode === ep);
    // `stillborn` stays a scheduler-side stat (it feeds the defer ladder and
    // `--status`); it is not part of the API, because a zero-response run is
    // archived at exit and the viewer never has one to show.
    const { stillborn: _archived, ...rest } = stats;
    perEpisode[ep] = { ...rest, runIds: tier.filter((f) => isCounted(f) && countsTowardTarget(f, state)).map((f) => f.runId) };
  }
  // The newest run that actually failed, not the newest run: a model whose last
  // episode was fine still owes the operator the text of the three before it.
  const failed = mine.find((f) => f.terminationReason !== null && ERROR_REASONS.has(f.terminationReason));
  const lastError = failed === undefined ? null : lastErrorOf(join(runsDir, failed.runId), failed.runId);
  return {
    name: state.name,
    model: state.model,
    effort: state.effort,
    ...(state.compactWindow !== undefined ? { compactWindow: state.compactWindow } : {}),
    windows: ownedWindows(state),
    ...(state.siblings !== undefined ? { siblings: [...state.siblings] } : {}),
    platform: state.platform,
    ...(state.providers !== undefined && state.providers.length > 1
      ? // An endpoint driver with no base is on OpenRouter, as a single-provider entry's platform reads.
        { platforms: [...new Set(state.providers.map((p) => platformOf(p.apiBase, driverEntry(state.driver ?? DEFAULT_DRIVER)?.endpoint === true ? undefined : state.driver) ?? "—"))] }
      : {}),
    harness: state.harness,
    // The reader's verdict, not the scheduler's `state.billing`: a subscription entry reads paid (billing.ts).
    billing: entryBilling(state),
    status: state.status,
    eligible: state.eligible as EpisodeIdView[],
    perEpisode,
    ...(state.cooling !== undefined ? { cooling: state.cooling } : {}),
    ...(state.retired !== undefined ? { retired: state.retired } : {}),
    ladder: state.ladder,
    declaredTier: state.declaredTier,
    tier: state.tier,
    earnedPromotion: state.earnedPromotion,
    earnedDeadmines: state.earnedDeadmines,
    idle: state.idle,
    schedulable: schedulableView(verdictForGroups(schedulability(state, running, policy, holding), evals), state),
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
  /** Those whose job holds the model's other entries: scored or freeplay, never a probe (`schedulability`). */
  holding?: ReadonlySet<string>;
  /** The evals group; absent is on. */
  evals?: boolean;
}): ModelsResponse {
  const harness = opts.harness ?? "all";
  const byHarness = harness === "all" ? opts.states : opts.states.filter((s) => s.harness === harness);
  /*
   * Excluded entries are not rows. `nav-probe` is the model `sonnet` under an
   * objective, so its projection is `sonnet`'s counts wearing another name:
   * listed as a row it reads as a second model with the same evidence. The
   * names and the reasons ride along under `roster.excluded`, so the page can
   * say what it is not showing.
   */
  const outside = new Set(opts.roster.excluded.map((e) => e.name));
  const states = byHarness.filter((s) => !outside.has(s.name));
  // A sibling the page lists no row for (excluded, or another harness) is not named.
  const listed = new Set(states.map((s) => s.name));
  const rows = states.map((s) => rowOf(s, opts.runs, opts.runsDir, opts.running ?? new Set(), opts.roster.policy, opts.evals ?? true, opts.holding));
  for (const row of rows) {
    if (row.siblings === undefined) continue;
    const kept = row.siblings.filter((n) => listed.has(n));
    if (kept.length > 0) row.siblings = kept;
    else delete row.siblings;
  }
  return {
    models: rows,
    roster: {
      path: opts.roster.path,
      shape: opts.roster.shape,
      count: opts.roster.count,
      excluded: opts.roster.excluded,
    },
    policy: {
      promoteAtLevel: opts.roster.policy.promoteAtLevel,
      deadminesAtLevel: opts.roster.policy.deadminesAtLevel,
      series: opts.roster.policy.series,
      tiers: TIER_TABLE,
      maxSessions: { ...opts.roster.policy.maxSessions },
      credentials: opts.roster.credentials.map((c) => ({ id: c.id, provider: c.provider, billing: c.billing, slots: c.slots, enabled: c.enabled })),
    },
    ladderMs: [...LADDER_MS],
    harness,
    now: opts.now ?? Date.now(),
  };
}
