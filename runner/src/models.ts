/**
 * The model-state projection: what the scheduler and the Models page read.
 *
 * One pure function turns the run history under `data/runs/` plus the roster
 * into a per-model verdict — how many runs it has toward its target on each
 * episode tier, whether it has earned the long tier, whether it is cooling on
 * the ladder or retired — and a second turns that into the next jobs for the
 * pool's free accounts. The fleet supervisor (`infra/run-fleet.ts`) calls both
 * every tick; `--status`, `--dry-run` and the viewer's `/api/models` read the
 * same projection, so there is exactly one answer to "why is this model not
 * running". The policy is ADR-0032; the tiers are ADR-0030 / docs/EPISODES.md.
 *
 * Rules the projection holds to:
 *
 * - **Only stamped runs exist.** A run directory with no `comparability.episode`
 *   in its meta.json predates the tiers and is never back-labeled (ADR-0030),
 *   so it is invisible here — it neither counts toward a target nor climbs the
 *   ladder. Every fleet run since the tiers landed is stamped.
 * - **A stillborn run is a launch that did not happen** — zero model
 *   `response` records in the trajectory and not live. It does not count
 *   toward the target, but it does count toward the defer ladder: a provider
 *   that refuses every launch is exactly what the ladder backs off from. The
 *   definition is the viewer's (`runner/viewer/stillborn.ts`); this module
 *   spells the record type the same way and reads it off the same file.
 * - **Overrides do not count.** A stamped run whose leash was overridden
 *   (`episodeOverride`) is not a member of its tier's group; it is listed
 *   (`attempts`) but neither counted nor a promotion witness.
 * - **The ladder is derived, never written.** Consecutive no-progress attempts
 *   (stillborn, or ended `adapter-error`) index `LADDER_MS`; the cooling
 *   deadline is the last failure's end plus the rung. The only persisted state
 *   is the operator's `clear`, kept in a sidecar the supervisor owns, and it
 *   works by ignoring attempts that ended before it.
 * - **Harness version is recorded but not filtered.** The operator's policy is
 *   three runs per (model, episode) regardless of version; the comparability
 *   surface is where versions are separated, not the schedule.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { harnessOf, normalizeDriver, type Harness } from "./config";
import { isEpisodeId, type EpisodeId } from "./episodes";

// ----------------------------------------------------------------- policy

/** The episode tiers the policy schedules on its own. `freeplay` is manual only. */
export const POLICY_EPISODES: readonly EpisodeId[] = ["e90", "e360"];

export interface SchedulingPolicy {
  /** Runs per (model, episode) the policy aims for; a roster entry may override. */
  runsPerEpisode: { e90: number; e360: number };
  /** The level an e90 run must reach to promote the model into e360. */
  promoteAtLevel: number;
}

export const DEFAULT_POLICY: SchedulingPolicy = {
  runsPerEpisode: { e90: 3, e360: 3 },
  promoteAtLevel: 5,
};

/**
 * The supervisor's defer ladder, in milliseconds per consecutive no-progress
 * attempt. The ceiling is six hours; an attempt made at the ceiling that still
 * makes no progress retires the model. It mirrors run-roster's per-spec ladder
 * so an operator reading either log sees the same rungs.
 */
export const LADDER_MS: readonly number[] = [
  1 * 60_000,
  3 * 60_000,
  5 * 60_000,
  10 * 60_000,
  15 * 60_000,
  30 * 60_000,
  60 * 60_000,
  3 * 60 * 60_000,
  6 * 60 * 60_000,
];

/** The trajectory record the loop appends for a model turn (viewer/stillborn.ts). */
export const MODEL_RESPONSE_RECORD = "response";

/** Termination reasons that mean "the model never got to play" for the ladder. */
export const NO_PROGRESS_REASONS: ReadonlySet<string> = new Set(["adapter-error"]);

// ----------------------------------------------------------------- inputs

/** A roster entry as the projection needs it: identity plus the two optional overrides. */
export interface RosterModel {
  /** The roster name; the key everything else hangs off. */
  name: string;
  model: string;
  effort?: string;
  driver?: string;
  apiBase?: string;
  /** Manual force: tiers listed here are eligible regardless of history. */
  tiers?: EpisodeId[];
  /** Per-entry target override. */
  runsPerEpisode?: Partial<Record<"e90" | "e360", number>>;
}

/** Operator overrides the supervisor persists (`fleet-models.json`). */
export interface ModelsSidecar {
  version: 1;
  /** roster name -> when the operator cleared its retirement/ladder (ms). */
  cleared: Record<string, number>;
}

export function parseModelsSidecar(text: string): ModelsSidecar {
  const empty: ModelsSidecar = { version: 1, cleared: {} };
  try {
    const raw = JSON.parse(text) as Partial<ModelsSidecar>;
    if (typeof raw !== "object" || raw === null || typeof raw.cleared !== "object" || raw.cleared === null) return empty;
    const cleared: Record<string, number> = {};
    for (const [k, v] of Object.entries(raw.cleared)) if (typeof v === "number" && Number.isFinite(v)) cleared[k] = v;
    return { version: 1, cleared };
  } catch {
    return empty;
  }
}

export function serializeModelsSidecar(s: ModelsSidecar): string {
  return JSON.stringify({ version: 1, cleared: s.cleared }, null, 2) + "\n";
}

/** One run, reduced to what the policy asks of it. */
export interface RunFact {
  runId: string;
  model: string;
  effort: string | null;
  episode: EpisodeId;
  episodeOverride: boolean;
  harnessVersion: string | null;
  startedAt: number;
  /** `ended_at` from run.sqlite, else the trajectory's mtime. */
  endedAt: number | null;
  terminationReason: string | null;
  /** `response` records in trajectory.jsonl; null when the file is unreadable. */
  modelResponses: number | null;
  /** Highest `state.level` observed, or null when there are no rows. */
  bestLevel: number | null;
  /** No termination row and a trajectory that grew recently. */
  live: boolean;
}

// ----------------------------------------------------------------- outputs

export type ModelStatus = "new" | "active" | "cooling" | "promoted" | "retired";

export interface EpisodeStats {
  /** Runs that count toward the target: stamped, un-overridden, not stillborn. */
  counted: number;
  /** Stamped runs that never produced a model response. */
  stillborn: number;
  /** Every stamped run, counted or not — what the next run id is numbered after. */
  attempts: number;
  target: number;
  bestLevel: number | null;
  /** A counted, un-overridden run reached `promoteAtLevel` — the promotion witness on e90. */
  reachedL5: boolean;
  lastEnded: number | null;
  lastReason: string | null;
}

export interface ModelCooling {
  until: number;
  /** 1-based rung of `LADDER_MS`. */
  rung: number;
  reason: string;
}

export interface ModelRetired {
  at: number;
  reason: string;
}

export interface ModelState {
  name: string;
  model: string;
  effort: string | null;
  platform: string | null;
  /** The harness this entry's runs go through (ADR-0035), from its driver; a tag, not a partition. */
  harness: Harness;
  status: ModelStatus;
  /** Episode tiers the model may be scheduled on, in policy order. */
  eligible: EpisodeId[];
  perEpisode: Partial<Record<EpisodeId, EpisodeStats>>;
  cooling?: ModelCooling;
  retired?: ModelRetired;
  /** Consecutive no-progress attempts on the ladder (0 when the last attempt progressed). */
  ladder: number;
}

export interface NextJob {
  name: string;
  episode: EpisodeId;
  account: string;
  /** 1-based attempt number on this (model, episode): `attempts + 1`. */
  attempt: number;
  why: string;
}

// ----------------------------------------------------------- reading runs

/** A trajectory touched more recently than this belongs to a live process. */
export const LIVE_WINDOW_MS = 120_000;

const RUN_ID = /^[A-Za-z0-9._-]+$/;

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}
function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

/** Count `response` records in a trajectory without holding the file in memory. */
export function countModelResponses(path: string): number | null {
  if (!existsSync(path)) return null;
  let n = 0;
  try {
    const text = readFileSync(path, "utf8");
    let from = 0;
    for (;;) {
      const nl = text.indexOf("\n", from);
      const line = nl === -1 ? text.slice(from) : text.slice(from, nl);
      if (line.length > 0) {
        // Cheap prefilter, then the honest parse: the `t` key can sit anywhere.
        if (line.includes(`"${MODEL_RESPONSE_RECORD}"`)) {
          try {
            const rec = JSON.parse(line) as { t?: unknown };
            if (rec.t === MODEL_RESPONSE_RECORD) n++;
          } catch {
            /* a torn line is not a response */
          }
        }
      }
      if (nl === -1) break;
      from = nl + 1;
    }
  } catch {
    return null;
  }
  return n;
}

/**
 * Read one run directory into a fact, or null when it is not a stamped run.
 * Tolerant everywhere: a run mid-write or an unreadable database degrades to
 * "no data", never to an exception that costs the whole projection.
 */
export function readRunFact(runsDir: string, runId: string, now = Date.now()): RunFact | null {
  const dir = join(runsDir, runId);
  const metaPath = join(dir, "meta.json");
  if (!existsSync(metaPath)) return null;
  let meta: {
    harnessVersion?: unknown;
    startedAt?: unknown;
    config?: { model?: unknown; effort?: unknown };
    comparability?: { episode?: unknown; episodeOverride?: unknown; effort?: unknown };
  };
  try {
    meta = JSON.parse(readFileSync(metaPath, "utf8")) as typeof meta;
  } catch {
    return null;
  }
  const episode = meta.comparability?.episode;
  if (!isEpisodeId(episode)) return null;
  const model = str(meta.config?.model);
  if (model === null) return null;

  const fact: RunFact = {
    runId,
    model,
    effort: str(meta.comparability?.effort) ?? str(meta.config?.effort),
    episode,
    episodeOverride: meta.comparability?.episodeOverride === true,
    harnessVersion: str(meta.harnessVersion),
    startedAt: num(meta.startedAt) ?? 0,
    endedAt: null,
    terminationReason: null,
    modelResponses: null,
    bestLevel: null,
    live: false,
  };

  const jsonl = join(dir, "trajectory.jsonl");
  let mtime: number | null = null;
  if (existsSync(jsonl)) {
    try {
      mtime = statSync(jsonl).mtimeMs;
    } catch {
      /* unreadable stat: treat as no trajectory */
    }
  }
  fact.modelResponses = countModelResponses(jsonl);

  const dbPath = join(dir, "run.sqlite");
  if (existsSync(dbPath)) {
    let db: Database | null = null;
    try {
      db = new Database(dbPath, { readonly: true });
      const r = db.query(`SELECT started_at, ended_at, termination_reason FROM run WHERE run_id = ?`).get(runId) as Record<
        string,
        unknown
      > | null;
      if (r !== null) {
        fact.startedAt = num(r["started_at"]) ?? fact.startedAt;
        fact.endedAt = num(r["ended_at"]);
        fact.terminationReason = str(r["termination_reason"]);
      }
      const lv = db.query(`SELECT MAX(level) AS v FROM state WHERE run_id = ? AND level > 0`).get(runId) as Record<
        string,
        unknown
      > | null;
      fact.bestLevel = lv === null ? null : num(lv["v"]);
    } catch {
      /* a busy or foreign database leaves the sqlite fields null */
    } finally {
      db?.close();
    }
  }
  if (fact.endedAt === null && fact.terminationReason !== null) fact.endedAt = mtime;
  fact.live = fact.terminationReason === null && mtime !== null && now - mtime < LIVE_WINDOW_MS;
  if (!fact.live && fact.endedAt === null) fact.endedAt = mtime;
  return fact;
}

/** Every stamped run under `runsDir`, oldest first. The `archive/` directory is skipped. */
export function readRunFacts(runsDir: string, now = Date.now()): RunFact[] {
  if (!existsSync(runsDir)) return [];
  const out: RunFact[] = [];
  for (const d of readdirSync(runsDir, { withFileTypes: true })) {
    if (!d.isDirectory() || !RUN_ID.test(d.name) || d.name === "archive") continue;
    const f = readRunFact(runsDir, d.name, now);
    if (f !== null) out.push(f);
  }
  out.sort((a, b) => a.startedAt - b.startedAt || (a.runId < b.runId ? -1 : a.runId > b.runId ? 1 : 0));
  return out;
}

// ------------------------------------------------------------- projection

/** Same rules as the viewer's `platformOf`: the api base is the honest source. */
export function platformOf(apiBase: string | undefined, driver: string | undefined): string | null {
  if (apiBase !== undefined) {
    let host = apiBase;
    try {
      host = new URL(apiBase).hostname;
    } catch {
      /* fall through with the raw string */
    }
    if (host.includes("openrouter.ai")) return "openrouter";
    if (host.includes("api.anthropic.com")) return "anthropic";
    if (host.includes("api.openai.com")) return "openai";
    if (host.includes("localhost") || host.startsWith("127.") || /^\d+\.\d+\.\d+\.\d+$/.test(host)) return "local";
    return host.replace(/^api\./, "");
  }
  return driver === undefined ? "openrouter" : (normalizeDriver(driver) ?? driver);
}

/** Whether a run is stillborn by the viewer's definition; null while undecidable. */
export function stillbornOf(f: RunFact): boolean | null {
  if (f.modelResponses === null) return null;
  if (f.live) return false;
  return f.modelResponses === 0;
}

/** A run that counts toward a target: a member of its tier's group that got off the ground. */
/**
 * Terminations that say nothing about the model: an operator cut the run, or the
 * harness itself failed. They still number attempts (run ids) but never count
 * toward the per-episode target, so the policy reruns them.
 */
export const NOT_THE_MODELS_FAULT = new Set(["manual", "harness-error"]);

export function isCounted(f: RunFact): boolean {
  if (f.episodeOverride || f.modelResponses === null || f.modelResponses <= 0) return false;
  if (f.terminationReason !== null && NOT_THE_MODELS_FAULT.has(f.terminationReason)) return false;
  return true;
}

/** A finished attempt the ladder reads as "no progress". */
export function isNoProgress(f: RunFact): boolean {
  if (f.live) return false;
  if (stillbornOf(f) === true) return true;
  return f.terminationReason !== null && NO_PROGRESS_REASONS.has(f.terminationReason);
}

function matchesRoster(f: RunFact, r: RosterModel): boolean {
  return f.model === r.model && (f.effort ?? null) === (r.effort ?? null);
}

function targetFor(r: RosterModel, ep: EpisodeId, policy: SchedulingPolicy): number {
  if (ep === "freeplay") return 0;
  return r.runsPerEpisode?.[ep] ?? policy.runsPerEpisode[ep];
}

/**
 * Project one roster entry's runs to its state. `clearedAt` is the operator's
 * clear: attempts that ended at or before it are ignored by the ladder (they
 * still count toward targets — a clear forgives the ladder, not the history).
 */
export function projectModel(
  r: RosterModel,
  runs: readonly RunFact[],
  policy: SchedulingPolicy,
  opts: { now: number; clearedAt?: number },
): ModelState {
  const mine = runs.filter((f) => matchesRoster(f, r));
  const perEpisode: Partial<Record<EpisodeId, EpisodeStats>> = {};
  for (const ep of POLICY_EPISODES) {
    const stats: EpisodeStats = {
      counted: 0,
      stillborn: 0,
      attempts: 0,
      target: targetFor(r, ep, policy),
      bestLevel: null,
      reachedL5: false,
      lastEnded: null,
      lastReason: null,
    };
    for (const f of mine) {
      if (f.episode !== ep) continue;
      stats.attempts++;
      if (stillbornOf(f) === true) stats.stillborn++;
      if (isCounted(f)) {
        stats.counted++;
        if (f.bestLevel !== null && f.bestLevel >= policy.promoteAtLevel) stats.reachedL5 = true;
      }
      if (f.bestLevel !== null && (stats.bestLevel === null || f.bestLevel > stats.bestLevel)) stats.bestLevel = f.bestLevel;
      if (f.endedAt !== null && (stats.lastEnded === null || f.endedAt >= stats.lastEnded)) {
        stats.lastEnded = f.endedAt;
        stats.lastReason = stillbornOf(f) === true ? "stillborn" : f.terminationReason;
      }
    }
    perEpisode[ep] = stats;
  }

  // Eligibility: e90 always; e360 on promotion or by force.
  const eligible: EpisodeId[] = ["e90"];
  const promoted = perEpisode.e90!.reachedL5;
  if (promoted || r.tiers?.includes("e360") === true) eligible.push("e360");

  // The ladder: trailing consecutive no-progress attempts, newest last, after the clear.
  let ladder = 0;
  let lastFail: RunFact | undefined;
  const finished = mine.filter((f) => !f.live && f.endedAt !== null && (opts.clearedAt === undefined || f.endedAt > opts.clearedAt));
  for (let i = finished.length - 1; i >= 0; i--) {
    const f = finished[i]!;
    if (!isNoProgress(f)) break;
    ladder++;
    if (lastFail === undefined) lastFail = f;
  }

  const state: ModelState = {
    name: r.name,
    model: r.model,
    effort: r.effort ?? null,
    platform: platformOf(r.apiBase, r.driver),
    harness: harnessOf(normalizeDriver(r.driver ?? "openai") ?? "openai"),
    status: "active",
    eligible,
    perEpisode,
    ladder,
  };
  if (lastFail !== undefined && ladder > 0) {
    const reason = stillbornOf(lastFail) === true ? "stillborn" : (lastFail.terminationReason ?? "no progress");
    if (ladder > LADDER_MS.length) {
      state.retired = {
        at: lastFail.endedAt!,
        reason: `${ladder} consecutive no-progress attempts; last ${lastFail.runId} (${reason}) after the ${Math.round(LADDER_MS[LADDER_MS.length - 1]! / 3_600_000)}h ceiling`,
      };
      state.status = "retired";
      return state;
    }
    const rung = ladder;
    const until = lastFail.endedAt! + LADDER_MS[rung - 1]!;
    if (until > opts.now) {
      state.cooling = { until, rung, reason: `${lastFail.runId}: ${reason}` };
      state.status = "cooling";
      return state;
    }
  }
  const anyCounted = eligible.some((ep) => (perEpisode[ep]?.counted ?? 0) > 0);
  state.status = !anyCounted ? "new" : eligible.includes("e360") ? "promoted" : "active";
  return state;
}

export interface ModelStatesInput {
  runsDir: string;
  roster: readonly RosterModel[];
  policy?: SchedulingPolicy;
  /** The operator sidecar; omitted reads `<runsDir>/fleet-models.json`. */
  sidecar?: ModelsSidecar;
  now?: number;
  /** Pre-read facts, for callers that already have them (tests, the viewer). */
  runs?: readonly RunFact[];
}

export const MODELS_SIDECAR = "fleet-models.json";

export function readModelsSidecar(runsDir: string): ModelsSidecar {
  const p = join(runsDir, MODELS_SIDECAR);
  if (!existsSync(p)) return { version: 1, cleared: {} };
  try {
    return parseModelsSidecar(readFileSync(p, "utf8"));
  } catch {
    return { version: 1, cleared: {} };
  }
}

/** The projection, in roster order. */
export function modelStates(input: ModelStatesInput): ModelState[] {
  const now = input.now ?? Date.now();
  const policy = input.policy ?? DEFAULT_POLICY;
  const runs = input.runs ?? readRunFacts(input.runsDir, now);
  const sidecar = input.sidecar ?? readModelsSidecar(input.runsDir);
  return input.roster.map((r) => projectModel(r, runs, policy, { now, clearedAt: sidecar.cleared[r.name] }));
}

// -------------------------------------------------------------- scheduling

/** Why a model is or is not schedulable right now — the `--status` line. */
export function schedulability(s: ModelState, running: ReadonlySet<string> = new Set()): { ok: boolean; why: string } {
  if (s.retired !== undefined) return { ok: false, why: `retired: ${s.retired.reason} — clear with --clear-model ${s.name}` };
  if (s.cooling !== undefined) {
    return { ok: false, why: `cooling rung ${s.cooling.rung}/${LADDER_MS.length} until ${new Date(s.cooling.until).toISOString()} (${s.cooling.reason})` };
  }
  if (running.has(s.name)) return { ok: false, why: "running (one stream per model)" };
  const open = s.eligible.filter((ep) => {
    const st = s.perEpisode[ep];
    return st !== undefined && st.counted < st.target;
  });
  if (open.length === 0) return { ok: false, why: `targets met on ${s.eligible.join(", ")}` };
  return { ok: true, why: `schedulable on ${open.join(", ")}` };
}

/**
 * The policy's picks for the free pool accounts, in priority order:
 * (1) models with zero counted runs on any eligible episode, (2) the shorter
 * episode first, (3) fewest counted runs toward target, ties by roster order.
 * One job per model. `running` holds roster names with a stream in flight.
 */
export function nextJobs(
  states: readonly ModelState[],
  freeAccounts: readonly string[],
  running: ReadonlySet<string> = new Set(),
): NextJob[] {
  interface Cand {
    s: ModelState;
    ep: EpisodeId;
    epOrder: number;
    fresh: number;
    counted: number;
    order: number;
  }
  const cands: Cand[] = [];
  states.forEach((s, order) => {
    if (!schedulability(s, running).ok) return;
    const fresh = s.eligible.every((ep) => (s.perEpisode[ep]?.counted ?? 0) === 0) ? 0 : 1;
    for (const ep of s.eligible) {
      const st = s.perEpisode[ep];
      if (st === undefined || st.counted >= st.target) continue;
      cands.push({ s, ep, epOrder: POLICY_EPISODES.indexOf(ep), fresh, counted: st.counted, order });
    }
  });
  cands.sort((a, b) => a.fresh - b.fresh || a.epOrder - b.epOrder || a.counted - b.counted || a.order - b.order);
  const out: NextJob[] = [];
  const taken = new Set<string>();
  const accounts = [...freeAccounts];
  for (const c of cands) {
    if (accounts.length === 0) break;
    if (taken.has(c.s.name)) continue;
    taken.add(c.s.name);
    const st = c.s.perEpisode[c.ep]!;
    out.push({
      name: c.s.name,
      episode: c.ep,
      account: accounts.shift()!,
      attempt: st.attempts + 1,
      why: `${c.fresh === 0 ? "no counted runs yet" : `${st.counted}/${st.target} on ${c.ep}`}${c.s.status === "promoted" ? ", promoted" : ""}`,
    });
  }
  return out;
}
