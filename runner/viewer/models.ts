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
 * - **Stillborn is spelled once.** The counted/stillborn split of the run ids
 *   uses `isCounted`/`stillbornOf` from `runner/src/models.ts` — the same two
 *   predicates that produced `EpisodeStats` — so the lists and the counts
 *   cannot differ. (The viewer's own `eval.ts#stillbornOf` answers `false` for
 *   an unreadable trajectory where this one answers `null`; mixing them would
 *   put a run in a count and not in its list.)
 * - **Only the new fleet shape carries a roster.** ADR-0031's `roster` map is
 *   what names a model; a config that predates it has lane entries and no
 *   names, and inventing names from the model strings would mint keys that stop
 *   matching the day the operator renames `fleet.next.json` over `fleet.json`.
 *   A legacy config is therefore an empty, labelled state, not a guess.
 */

import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import {
  DEFAULT_POLICY,
  LADDER_MS,
  isCounted,
  readRunFact,
  stillbornOf,
  type ModelState,
  type RosterModel,
  type SchedulingPolicy,
  type RunFact,
} from "../src/models";
import { isEpisodeId } from "../src/episodes";
import type { EpisodeIdView, HarnessView, ModelEpisodeView, ModelRowView, ModelRunView, ModelsResponse } from "./api-types";
import { isArchiveDir } from "./stillborn";
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
    tiers: z.array(z.string()).optional(),
    runsPerEpisode: z.record(z.string(), z.number()).optional(),
  })
  .loose();

const fleetRosterSchema = z
  .object({
    roster: z.record(z.string(), rosterEntrySchema).optional(),
    policy: z
      .object({ runsPerEpisode: z.object({ e90: z.number().optional(), e360: z.number().optional() }).loose().optional() })
      .loose()
      .optional(),
  })
  .loose();

/** How a fleet config answered when asked for a roster. */
export type RosterShape = "roster" | "legacy" | "missing" | "unreadable";

export interface RosterRead {
  models: RosterModel[];
  shape: RosterShape;
  /** The file that was consulted, as it was given — never a host path guess. */
  path: string | null;
  /** The file's `policy` block over the defaults; only targets are configurable. */
  policy: SchedulingPolicy;
}

/**
 * Read the roster out of a fleet config.
 *
 * `legacy` is the pre-ADR-0031 shape: lanes with inline entries and no `roster`
 * map. It reads as an empty roster with a label the page renders, which is the
 * same posture `readFleet` takes to a missing `fleet-state.json` — say the file
 * is not there, do not synthesise what it would have said.
 */
export function readFleetRoster(path: string | undefined): RosterRead {
  if (path === undefined || path.length === 0) {
    return { models: [], shape: "missing", path: null, policy: DEFAULT_POLICY };
  }
  if (!existsSync(path)) return { models: [], shape: "missing", path, policy: DEFAULT_POLICY };
  let parsed: z.infer<typeof fleetRosterSchema>;
  try {
    parsed = fleetRosterSchema.parse(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return { models: [], shape: "unreadable", path, policy: DEFAULT_POLICY };
  }
  const per = parsed.policy?.runsPerEpisode;
  const policy: SchedulingPolicy = {
    ...DEFAULT_POLICY,
    runsPerEpisode: {
      e90: typeof per?.e90 === "number" ? per.e90 : DEFAULT_POLICY.runsPerEpisode.e90,
      e360: typeof per?.e360 === "number" ? per.e360 : DEFAULT_POLICY.runsPerEpisode.e360,
    },
  };
  if (parsed.roster === undefined) return { models: [], shape: "legacy", path, policy };
  const models: RosterModel[] = [];
  for (const [name, e] of Object.entries(parsed.roster)) {
    const tiers = (e.tiers ?? []).filter(isEpisodeId);
    const runs = e.runsPerEpisode ?? {};
    const per: Partial<Record<"e90" | "e360", number>> = {};
    if (typeof runs["e90"] === "number") per.e90 = runs["e90"];
    if (typeof runs["e360"] === "number") per.e360 = runs["e360"];
    models.push({
      name,
      model: e.model,
      ...(e.effort !== undefined ? { effort: e.effort } : {}),
      ...(e.driver !== undefined ? { driver: e.driver } : {}),
      ...(e.apiBase !== undefined ? { apiBase: e.apiBase } : {}),
      ...(tiers.length > 0 ? { tiers } : {}),
      ...(Object.keys(per).length > 0 ? { runsPerEpisode: per } : {}),
    });
  }
  return { models, shape: "roster", path, policy };
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
export function readRunFactsCached(
  runsDir: string,
  cache: Map<string, FactCacheEntry>,
  now = Date.now(),
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
  for (const id of names) {
    seen.add(id);
    const dir = join(runsDir, id);
    const { sig, mtime } = signature(dir);
    let hit = cache.get(id);
    if (hit === undefined || hit.sig !== sig) {
      hit = { sig, fact: readRunFact(runsDir, id, now), mtime };
      cache.set(id, hit);
    }
    if (hit.fact === null) continue;
    const live = hit.fact.terminationReason === null && hit.mtime !== null && now - hit.mtime < LIVE_WINDOW_MS;
    out.push(live === hit.fact.live ? hit.fact : { ...hit.fact, live });
  }
  for (const id of [...cache.keys()]) if (!seen.has(id)) cache.delete(id);
  out.sort((a, b) => a.startedAt - b.startedAt || (a.runId < b.runId ? -1 : a.runId > b.runId ? 1 : 0));
  return out;
}

// ------------------------------------------------------------ last error

/** Termination reasons that are an error the operator would want the text of. */
export const ERROR_REASONS: ReadonlySet<string> = new Set(["adapter-error", "harness-error"]);

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
    startedAt: f.startedAt,
    endedAt: f.endedAt,
    durationMs: durationOf(f),
    bestLevel: f.bestLevel,
    terminationReason: f.terminationReason,
    live: f.live,
    counted: isCounted(f),
    stillborn: stillbornOf(f) === true,
  };
}

/**
 * One roster model's row: the projection, plus the ids behind the counts.
 *
 * `runs` is every stamped run the projection matched, newest first — the
 * detail panel's list — and the per-episode id lists are slices of it, so a row
 * cannot show a count whose runs are not in its own panel.
 */
export function rowOf(state: ModelState, runs: readonly RunFact[], runsDir: string): ModelRowView {
  const mine = runs
    .filter((f) => f.model === state.model && (f.effort ?? null) === state.effort)
    .slice()
    .sort((a, b) => b.startedAt - a.startedAt);
  const perEpisode: Partial<Record<EpisodeIdView, ModelEpisodeView>> = {};
  for (const [id, stats] of Object.entries(state.perEpisode)) {
    const ep = id as EpisodeIdView;
    const tier = mine.filter((f) => f.episode === ep);
    perEpisode[ep] = {
      ...stats,
      runIds: tier.filter((f) => isCounted(f)).map((f) => f.runId),
      stillbornRunIds: tier.filter((f) => stillbornOf(f) === true).map((f) => f.runId),
    };
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
    status: state.status,
    eligible: state.eligible as EpisodeIdView[],
    perEpisode,
    ...(state.cooling !== undefined ? { cooling: state.cooling } : {}),
    ...(state.retired !== undefined ? { retired: state.retired } : {}),
    ladder: state.ladder,
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
  /** Optional harness filter (ADR-0035); "all" or absent lists every row. */
  harness?: HarnessView | "all";
}): ModelsResponse {
  const harness = opts.harness ?? "all";
  const states = harness === "all" ? opts.states : opts.states.filter((s) => s.harness === harness);
  return {
    models: states.map((s) => rowOf(s, opts.runs, opts.runsDir)),
    roster: { path: opts.roster.path, shape: opts.roster.shape, count: opts.roster.models.length },
    policy: {
      runsPerEpisode: opts.roster.policy.runsPerEpisode,
      promoteAtLevel: opts.roster.policy.promoteAtLevel,
    },
    ladderMs: [...LADDER_MS],
    harness,
    now: opts.now ?? Date.now(),
  };
}
