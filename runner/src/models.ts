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
 * - **A zero-response run is a launch that did not happen** — no model
 *   `response` record in the trajectory, and not live. The runner archives it
 *   as it terminates, so no listing shows one; it does not count toward the
 *   target, but it does count toward the defer ladder (a provider that refuses
 *   every launch is exactly what the ladder backs off from), which is why this
 *   projection reads the archive and the viewer does not.
 * - **Overrides do not count.** A stamped run whose leash was overridden
 *   (`episodeOverride`) is not a member of its tier's group; it is listed
 *   (`attempts`) but neither counted nor a promotion witness.
 * - **The ladder is derived, never written.** Consecutive no-progress attempts
 *   (stillborn, or ended `adapter-error`) index `LADDER_MS`; the cooling
 *   deadline is the last failure's end plus the rung. The only persisted state
 *   is the operator's `clear`, kept in a sidecar the supervisor owns, and it
 *   works by ignoring attempts that ended before it.
 * - **The harness series is the schedule's key.** A run records its exact
 *   version; the policy (`series`) names the series of the checkout it runs
 *   from, and runs from another series are shown but not counted — a minor
 *   bump restarts the evidence, a fix commit within the series does not. A
 *   policy with no series (an unversioned checkout) filters nothing.
 * - **A paused run is suspended, not judged** (ADR-0036). A run with a
 *   `pause_reason` and no termination — the supervisor stopped under it, or
 *   its provider ran out of quota — is an attempt but is neither counted nor
 *   a ladder failure while it is paused, and it holds its model: the policy
 *   does not start a second stream for a model whose run is waiting to be
 *   resumed. It is counted, or climbs the ladder, only when it finally ends.
 * - **Billing is a model property** (`model-cost.ts`). A paid model has its own
 *   targets (hard: never extras) and shares one in-flight cap; a free model
 *   gets extra runs at lowest priority once nothing else is schedulable,
 *   cycling through `extras.characters`. An extra is an attempt, never counted.
 * - **A local model's extras are freeplay** (`policy.extras.local`, ADR-0034).
 *   The box is inference-bound, so another 90 minutes of it says little that
 *   the last three said; one unbounded freeplay run at a time, restarted when
 *   it ends, is the long-horizon data it can give. Same rule otherwise: an
 *   attempt, reported apart, never counted toward a target.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { harnessSeries } from "./comparability";
import { harnessOf, isDriver, type Driver, type Harness } from "./config";
import { EPISODE_IDS, isEpisodeId, type EpisodeId } from "./episodes";
import { billingOf, type Billing } from "./model-cost";
import { platformOfBase } from "./platform";
import { ARCHIVE_DIR } from "../viewer/archive-dir";

// ----------------------------------------------------------------- policy

/**
 * The episode tiers the policy has targets on. `freeplay` has none — it is
 * never scheduled as evidence — but a local model's extras are freeplay runs
 * (`ExtrasMode`), so the projection still keeps stats for it.
 */
export const POLICY_EPISODES: readonly EpisodeId[] = ["e90", "e360"];

/**
 * Every episode the projection keeps stats for, in presentation order. Wider
 * than `POLICY_EPISODES` by `freeplay`, which carries a target of zero and
 * exists here so that freeplay attempts are numbered (a run id is
 * `…-<datestamp>-a<attempt>`, so two freeplay extras in one day need real
 * attempt numbers) and so a freeplay extra is reported like any other.
 */
export const STATS_EPISODES: readonly EpisodeId[] = EPISODE_IDS;

/**
 * How a model past its targets takes its extras (ADR-0034, "Local extras are
 * freeplay"): `characters` cycles `extras.characters` over the scored tiers,
 * `freeplay` runs one unbounded freeplay episode at a time.
 */
export type ExtrasMode = "characters" | "freeplay";

/** The local class's default: an inference-bound model that just keeps playing. */
export const DEFAULT_LOCAL_EXTRAS: ExtrasMode = "freeplay";

/** A starting character for an extra run: race and class ids as the client sends them. */
export interface StartingCharacter {
  race: number;
  class: number;
}

export interface SchedulingPolicy {
  /** Runs per (model, episode) the policy aims for; a roster entry may override. */
  runsPerEpisode: { e90: number; e360: number };
  /** The level an e90 run must reach to promote the model into e360. */
  promoteAtLevel: number;
  /**
   * The harness series (`comparability.ts`) runs must carry to count. Null:
   * no filter, every stamped run counts (the pre-series behaviour).
   */
  series: string | null;
  /**
   * The paid-model policy, or null to treat paid and free alike (the
   * pre-split behaviour). Paid targets are hard — never extras — and at most
   * `maxConcurrent` paid models are in flight across the pool at once.
   */
  paid: { runsPerEpisode: { e90: number; e360: number }; maxConcurrent: number } | null;
  /**
   * Extra runs for free models once nothing else is schedulable, or null for
   * none. Each extra takes the next character in `characters`, cycling —
   * except for the local class, whose extras are whatever `local` says.
   */
  extras: { characters: StartingCharacter[]; local: ExtrasMode } | null;
}

/** Paid defaults once `policy.paid` is present: one long run is enough to see the shape. */
export const DEFAULT_PAID = { runsPerEpisode: { e90: 3, e360: 1 }, maxConcurrent: 1 } as const;

/**
 * Sensible level-1 combos for the Alliance starting zones the wiki bundle
 * covers: human (1), dwarf (3), night elf (4), gnome (7); classes a fresh
 * character can play solo — warrior 1, paladin 2, hunter 3, rogue 4, priest 5,
 * mage 8, warlock 9, druid 11.
 */
export const DEFAULT_EXTRA_CHARACTERS: readonly StartingCharacter[] = [
  { race: 1, class: 1 },
  { race: 3, class: 3 },
  { race: 4, class: 11 },
  { race: 7, class: 8 },
  { race: 1, class: 9 },
  { race: 3, class: 2 },
  { race: 4, class: 4 },
  { race: 1, class: 5 },
];

export const DEFAULT_POLICY: SchedulingPolicy = {
  runsPerEpisode: { e90: 3, e360: 3 },
  promoteAtLevel: 5,
  series: null,
  paid: null,
  extras: null,
};

/**
 * The file's `policy` block (`infra/fleet.json`) over the defaults, in one
 * place so the supervisor, `--status` and the viewer read the same answer.
 *
 * Every field is optional and absent means today's behaviour: `paid` absent
 * is no paid/free split, `extras` absent is no extras, and a present block
 * with nothing in it takes `DEFAULT_PAID` / `DEFAULT_EXTRA_CHARACTERS`. The
 * series is the caller's (the checkout it runs from), never the file's.
 * Throws on a malformed block with a message naming the field; the viewer
 * catches and shows the defaults, the supervisor refuses the config.
 */
export function parsePolicyBlock(raw: unknown, series: string | null = null): SchedulingPolicy & { maxConcurrent: Record<string, number> } {
  const base = { ...DEFAULT_POLICY, series, maxConcurrent: {} as Record<string, number> };
  if (raw === undefined) return base;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error("fleet config: policy must be an object");
  const o = raw as { runsPerEpisode?: unknown; maxConcurrent?: unknown; paid?: unknown; extras?: unknown };
  const runs = parseRunsPerEpisode(o.runsPerEpisode, "policy.runsPerEpisode");
  const out = { ...base, runsPerEpisode: { ...DEFAULT_POLICY.runsPerEpisode, ...runs } };
  if (o.maxConcurrent !== undefined) {
    if (typeof o.maxConcurrent !== "object" || o.maxConcurrent === null || Array.isArray(o.maxConcurrent)) {
      throw new Error('policy.maxConcurrent must be an object like { "claude-code": 2 }');
    }
    for (const [k, v] of Object.entries(o.maxConcurrent as Record<string, unknown>)) {
      if (!isDriver(k)) throw new Error(`policy.maxConcurrent: unknown driver ${k}`);
      const driver = k;
      if (typeof v !== "number" || !Number.isInteger(v) || v < 1) throw new Error(`policy.maxConcurrent.${k} must be a positive integer`);
      out.maxConcurrent[driver] = v;
    }
  }
  if (o.paid !== undefined) {
    if (typeof o.paid !== "object" || o.paid === null || Array.isArray(o.paid)) throw new Error('policy.paid must be an object like { "runsPerEpisode": { "e90": 3, "e360": 1 }, "maxConcurrent": 1 }');
    const p = o.paid as { runsPerEpisode?: unknown; maxConcurrent?: unknown };
    const pr = parseRunsPerEpisode(p.runsPerEpisode, "policy.paid.runsPerEpisode");
    let cap: number = DEFAULT_PAID.maxConcurrent;
    if (p.maxConcurrent !== undefined) {
      if (typeof p.maxConcurrent !== "number" || !Number.isInteger(p.maxConcurrent) || p.maxConcurrent < 0) throw new Error("policy.paid.maxConcurrent must be a non-negative integer");
      cap = p.maxConcurrent;
    }
    out.paid = { runsPerEpisode: { ...DEFAULT_PAID.runsPerEpisode, ...pr }, maxConcurrent: cap };
  }
  if (o.extras !== undefined) {
    if (typeof o.extras !== "object" || o.extras === null || Array.isArray(o.extras)) throw new Error('policy.extras must be an object like { "characters": [{ "race": 1, "class": 1 }] }');
    const e = o.extras as { characters?: unknown };
    let characters: StartingCharacter[] = [...DEFAULT_EXTRA_CHARACTERS];
    if (e.characters !== undefined) {
      if (!Array.isArray(e.characters)) throw new Error("policy.extras.characters must be an array of { race, class }");
      characters = (e.characters as unknown[]).map((c, i) => {
        const cc = c as { race?: unknown; class?: unknown };
        const ok = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 11;
        if (typeof c !== "object" || c === null || !ok(cc.race) || !ok(cc.class)) {
          throw new Error(`policy.extras.characters[${i}] must be { race: 1..11, class: 1..11 }`);
        }
        return { race: cc.race, class: cc.class };
      });
    }
    let local: ExtrasMode = DEFAULT_LOCAL_EXTRAS;
    if ((e as { local?: unknown }).local !== undefined) {
      const l = (e as { local?: unknown }).local;
      if (l !== "characters" && l !== "freeplay") {
        throw new Error('policy.extras.local must be "freeplay" (one unbounded freeplay run at a time) or "characters" (the race/class cycle)');
      }
      local = l;
    }
    out.extras = { characters, local };
  }
  return out;
}

/** `{ e90?, e360? }` as targets; `where` names the field in the error. */
export function parseRunsPerEpisode(raw: unknown, where: string): Partial<Record<"e90" | "e360", number>> | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error(`${where} must be an object like { "e90": 3, "e360": 3 }`);
  const out: Partial<Record<"e90" | "e360", number>> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (k !== "e90" && k !== "e360") throw new Error(`${where}: unknown episode ${k} (e90 or e360; freeplay has no target — it is only ever an extra)`);
    if (typeof v !== "number" || !Number.isInteger(v) || v < 0) throw new Error(`${where}.${k} must be a non-negative integer`);
    out[k] = v;
  }
  return out;
}

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

/** The trajectory record the loop appends for a model turn (viewer/archive-dir.ts). */
export const MODEL_RESPONSE_RECORD = "response";
/** The trajectory record a pause writes (`Trajectory.setPause`). */
export const PAUSE_RECORD = "pause";

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
  /** Operator override of the billing verdict (`model-cost.ts`). */
  billing?: Billing;
}

/**
 * A job as the membership predicate needs it: which roster names it holds, and
 * the account it is pinned to when it is pinned to one.
 *
 * Deliberately structural. The supervisor's `FleetJob` carries a spawn's worth
 * of fields and lives beside the process path; the viewer parses a narrow
 * slice of the same file at its own boundary. Both can satisfy this, so the
 * question "is this roster name the policy's to schedule" has one answer
 * rather than one per reader (FOLLOW-UPS 52).
 */
export interface PolicyJob {
  refs: readonly string[];
  /** Set: the job is pinned to this account. Absent: it takes a pool account. */
  account?: string | undefined;
  /** The job's name, for the exclusion sentence. */
  name?: string | undefined;
}

/** A roster entry as the same predicate needs it: only the objective matters. */
export interface PolicyRosterEntry {
  objective?: string | undefined;
}

/** Roster names a pinned job references: never the policy's to schedule. */
export function pinnedRefs(jobs: readonly PolicyJob[]): Set<string> {
  return new Set(jobs.filter((j) => j.account !== undefined).flatMap((j) => [...j.refs]));
}

/**
 * The roster names the policy may schedule: not referenced by a pinned job
 * (that account is spoken for, and a probe's runs are not the model's
 * evidence), and not carrying an objective (an objective stamps every run
 * unscored, and the policy schedules evidence).
 */
export function policyRefs(
  jobs: readonly PolicyJob[],
  roster: Record<string, PolicyRosterEntry>,
): Set<string> {
  const pinned = pinnedRefs(jobs);
  return new Set(
    Object.entries(roster)
      .filter(([n, e]) => !pinned.has(n) && e.objective === undefined)
      .map(([n]) => n),
  );
}

/** Why a roster name is outside the policy, or undefined when it is inside. */
export function policyExclusion(
  jobs: readonly PolicyJob[],
  roster: Record<string, PolicyRosterEntry>,
  name: string,
): string | undefined {
  const job = jobs.find((j) => j.account !== undefined && j.refs.includes(name));
  if (job !== undefined) return `pinned to ${job.account} by job ${job.name ?? job.refs.join("+")}`;
  if (roster[name]?.objective !== undefined) return "carries an objective (unscored probe)";
  return undefined;
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
  /** `harnessSeries(harnessVersion)`; what the schedule keys on. */
  harnessSeries: string | null;
  /** An extra run (ADR-0034): an attempt the policy made past the target, never counted. */
  extra: boolean;
  startedAt: number;
  /** `ended_at` from run.sqlite, else the trajectory's mtime. */
  endedAt: number | null;
  terminationReason: string | null;
  /** `response` records in trajectory.jsonl; null when the file is unreadable. */
  modelResponses: number | null;
  /** Highest `state.level` observed, or null when there are no rows. */
  bestLevel: number | null;
  /** No termination row, not paused, and a trajectory that grew recently. */
  live: boolean;
  /**
   * Set while the run is paused (ADR-0036): `pause_reason` in run.sqlite with
   * no termination. `at` is meta.json's pause mark when present, else the
   * trajectory's mtime; `count` is how many times this run has paused, which
   * is what a resume cadence indexes; `episodeElapsedMs` is the clock the run
   * will continue from (null for a pause written before the mark existed).
   */
  pause: { reason: string; at: number; count: number; episodeElapsedMs: number | null } | null;
  /** The game account the run was launched on; a resume must go back to it. */
  account: string | null;
  /** The run's wall-clock budget (`watchdogs.episodeMs`), null when disabled. */
  episodeMs: number | null;
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
  /** Attempts the policy made past the target (`extra: true`); reported apart, never counted. */
  extras: number;
  /** Runs from another harness series: shown and numbered as attempts, never counted. */
  otherSeries: number;
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
  /** Free or paid, decided by `model-cost.ts` (or the roster's override). */
  billing: Billing;
  /** Episode tiers the model may be scheduled on, in policy order. */
  eligible: EpisodeId[];
  perEpisode: Partial<Record<EpisodeId, EpisodeStats>>;
  cooling?: ModelCooling;
  retired?: ModelRetired;
  /** Consecutive no-progress attempts on the ladder (0 when the last attempt progressed). */
  ladder: number;
  /**
   * The model's newest paused run in this series (ADR-0036): it holds the
   * model — nothing new is scheduled for it — until the supervisor resumes
   * the run or the run goes stale (`isStalePause`).
   */
  paused?: { runId: string; reason: string; at: number; episodeElapsedMs: number | null; episodeMs: number | null };
}

export interface NextJob {
  name: string;
  episode: EpisodeId;
  account: string;
  /** 1-based attempt number on this (model, episode): `attempts + 1`. */
  attempt: number;
  why: string;
  /** An extra run past the target (free models only), with the character it rolls. */
  extra?: StartingCharacter;
}

/** A pick the policy would have made but held back, with the reason — what `--dry-run` explains. */
export interface HeldPick {
  name: string;
  episode: EpisodeId;
  why: string;
}

/** An account that exists but is taken, and (where known) who is holding it. */
export interface BusyAccount {
  account: string;
  /** The run id or job name on it; absent when the caller cannot name one. */
  by?: string;
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
  return countRecords(path, [MODEL_RESPONSE_RECORD])?.get(MODEL_RESPONSE_RECORD) ?? null;
}

/** One pass over a trajectory, counting the records of each kind named. Null when unreadable. */
export function countRecords(path: string, kinds: readonly string[]): Map<string, number> | null {
  if (!existsSync(path)) return null;
  const n = new Map<string, number>(kinds.map((k) => [k, 0]));
  try {
    const text = readFileSync(path, "utf8");
    let from = 0;
    for (;;) {
      const nl = text.indexOf("\n", from);
      const line = nl === -1 ? text.slice(from) : text.slice(from, nl);
      if (line.length > 0) {
        // Cheap prefilter, then the honest parse: the `t` key can sit anywhere.
        for (const k of kinds) {
          if (!line.includes(`"${k}"`)) continue;
          let hit = false;
          try {
            const rec = JSON.parse(line) as { t?: unknown };
            hit = rec.t === k;
          } catch {
            /* a torn line is not a record */
          }
          if (hit) {
            n.set(k, (n.get(k) ?? 0) + 1);
            break;
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
    config?: { model?: unknown; effort?: unknown; extra?: unknown; account?: unknown; watchdogs?: { episodeMs?: unknown } };
    comparability?: { episode?: unknown; episodeOverride?: unknown; effort?: unknown };
    pause?: { reason?: unknown; at?: unknown; episodeElapsedMs?: unknown };
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
    harnessSeries: harnessSeries(str(meta.harnessVersion)),
    extra: meta.config?.extra === true,
    startedAt: num(meta.startedAt) ?? 0,
    endedAt: null,
    terminationReason: null,
    modelResponses: null,
    bestLevel: null,
    live: false,
    pause: null,
    account: str(meta.config?.account),
    episodeMs: num(meta.config?.watchdogs?.episodeMs),
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
  const counts = countRecords(jsonl, [MODEL_RESPONSE_RECORD, PAUSE_RECORD]);
  fact.modelResponses = counts?.get(MODEL_RESPONSE_RECORD) ?? null;
  let pauseReason: string | null = null;

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
      try {
        const p = db.query(`SELECT pause_reason FROM run WHERE run_id = ?`).get(runId) as Record<string, unknown> | null;
        pauseReason = p === null ? null : str(p["pause_reason"]);
      } catch {
        /* a store without the column (synthetic or very old) is not paused */
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
  // A termination wins over a stale pause row (the --resume path clears the
  // row, but a run can also be classified by hand after a pause).
  if (pauseReason !== null && fact.terminationReason === null) {
    const markedAt = num(meta.pause?.at);
    fact.pause = {
      reason: pauseReason,
      at: markedAt ?? mtime ?? fact.startedAt,
      count: Math.max(1, counts?.get(PAUSE_RECORD) ?? 1),
      episodeElapsedMs: num(meta.pause?.episodeElapsedMs),
    };
  }
  fact.live = fact.terminationReason === null && fact.pause === null && mtime !== null && now - mtime < LIVE_WINDOW_MS;
  if (!fact.live && fact.endedAt === null) fact.endedAt = mtime;
  return fact;
}

/**
 * Every stamped run under `runsDir`, oldest first.
 *
 * `archive/` is skipped by default, which is what a *listing* wants: an
 * archived run is one nobody should see again. The **scheduler** asks for them
 * (`includeArchived`), and has to. A run that terminates with no model
 * response is archived by the runner as it exits, and those runs are exactly
 * what the defer ladder is made of — drop them and a provider that refuses
 * every launch relaunches forever at rung zero. They also number attempts:
 * a run id carries a date stamp plus `-a<attempt>`, so an invisible attempt
 * would have the next one collide with a directory already on disk.
 */
export function readRunFacts(runsDir: string, now = Date.now(), opts: { includeArchived?: boolean } = {}): RunFact[] {
  if (!existsSync(runsDir)) return [];
  const out: RunFact[] = [];
  const scan = (dir: string): void => {
    if (!existsSync(dir)) return;
    for (const d of readdirSync(dir, { withFileTypes: true })) {
      if (!d.isDirectory() || !RUN_ID.test(d.name) || d.name === ARCHIVE_DIR) continue;
      const f = readRunFact(dir, d.name, now);
      if (f !== null) out.push(f);
    }
  };
  scan(runsDir);
  if (opts.includeArchived === true) scan(join(runsDir, ARCHIVE_DIR));
  out.sort((a, b) => a.startedAt - b.startedAt || (a.runId < b.runId ? -1 : a.runId > b.runId ? 1 : 0));
  return out;
}

// ------------------------------------------------------------- projection

/**
 * The roster entry's platform: the shared classifier (`platform.ts`, which the
 * writer and the viewer also read), over this projection's own fallback — a
 * roster entry with no api base is the openai-compatible default, which is
 * OpenRouter. `local` is loopback and RFC-1918 only, the same test `billingOf`
 * calls the operator's own hardware; a public IPv4 reads as itself.
 */
export function platformOf(apiBase: string | undefined, driver: string | undefined): string | null {
  return platformOfBase(apiBase) ?? (driver ?? "openrouter");
}

/** A roster entry's driver; `openai` when it names none. A name outside the vocabulary is a config error. */
export function driverOf(r: { name: string; driver?: string }): Driver {
  const d = r.driver ?? "openai";
  if (!isDriver(d)) throw new Error(`roster.${r.name}: driver "${d}" is not one of openai|claude-code|stub`);
  return d;
}

/**
 * Whether a run produced no model response at all; null while undecidable.
 *
 * Internal to the scheduler now: such a run is archived by the runner as it
 * terminates and no listing shows one, but the ladder is made of them, so the
 * projection (which reads the archive) still has to name the state.
 */
export function stillbornOf(f: RunFact): boolean | null {
  if (f.modelResponses === null) return null;
  // Paused: undecided. A 0-response rate-limited pause is a launch still in
  // progress as far as the policy is concerned (the roster retries it).
  if (f.live || f.pause !== null) return null;
  return f.modelResponses === 0;
}

/** A run that counts toward a target: a member of its tier's group that got off the ground. */
/**
 * Terminations that say nothing about the model: an operator cut the run, or the
 * harness itself failed. They still number attempts (run ids) but never count
 * toward the per-episode target, so the policy reruns them.
 */
export const NOT_THE_MODELS_FAULT = new Set(["manual", "harness-error"]);

/**
 * A pause nobody came back for: older than twice the run's own budget (a run
 * with no wall clock uses the long tier's six hours). Not auto-resumed; listed
 * for the operator to resume by hand or archive. Measured from the pause, not
 * the launch — a run that paused three times over a night is still current.
 */
export const STALE_PAUSE_FALLBACK_BUDGET_MS = 6 * 60 * 60_000;

export function isStalePause(f: Pick<RunFact, "pause" | "episodeMs">, now: number): boolean {
  if (f.pause === null) return false;
  return now - f.pause.at > 2 * (f.episodeMs ?? STALE_PAUSE_FALLBACK_BUDGET_MS);
}

export function isCounted(f: RunFact): boolean {
  if (f.pause !== null) return false;
  if (f.extra || f.episodeOverride || f.modelResponses === null || f.modelResponses <= 0) return false;
  if (f.terminationReason !== null && NOT_THE_MODELS_FAULT.has(f.terminationReason)) return false;
  return true;
}

/** A finished attempt the ladder reads as "no progress". */
export function isNoProgress(f: RunFact): boolean {
  if (f.live || f.pause !== null) return false;
  if (stillbornOf(f) === true) return true;
  return f.terminationReason !== null && NO_PROGRESS_REASONS.has(f.terminationReason);
}

function matchesRoster(f: RunFact, r: RosterModel): boolean {
  return f.model === r.model && (f.effort ?? null) === (r.effort ?? null);
}

function targetFor(r: RosterModel, ep: EpisodeId, policy: SchedulingPolicy, billing: Billing): number {
  if (ep === "freeplay") return 0;
  const base = billing === "paid" && policy.paid !== null ? policy.paid.runsPerEpisode : policy.runsPerEpisode;
  return r.runsPerEpisode?.[ep] ?? base[ep];
}

/** The billing verdict for a roster entry, as the projection stamps it. */
export function rosterBilling(r: RosterModel): Billing {
  return billingOf({ model: r.model, apiBase: r.apiBase, driver: r.driver, billing: r.billing });
}

/** Whether a run belongs to the policy's series (a policy with no series takes every run). */
export function inSeries(f: RunFact, policy: SchedulingPolicy): boolean {
  return policy.series === null || f.harnessSeries === policy.series;
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
  const billing = rosterBilling(r);
  const all = runs.filter((f) => matchesRoster(f, r));
  // Another series' runs are shown, never counted: not witnesses, not ladder.
  // The ladder is about the provider, but a run that old says nothing about
  // tonight's provider either. They DO number attempts: the attempt index is
  // what keeps run ids unique on disk, and a series bump must not make the
  // next run id collide with an older directory (2026-08-23, harness-0.4).
  const mine = all.filter((f) => inSeries(f, policy));
  const perEpisode: Partial<Record<EpisodeId, EpisodeStats>> = {};
  for (const ep of STATS_EPISODES) {
    const stats: EpisodeStats = {
      counted: 0,
      stillborn: 0,
      attempts: 0,
      extras: 0,
      otherSeries: all.filter((f) => f.episode === ep && !inSeries(f, policy)).length,
      target: targetFor(r, ep, policy, billing),
      bestLevel: null,
      reachedL5: false,
      lastEnded: null,
      lastReason: null,
    };
    for (const f of all) if (f.episode === ep) stats.attempts++;
    for (const f of mine) {
      if (f.episode !== ep) continue;
      if (f.extra) stats.extras++;
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
  // A paused run is neither rung nor reset: it is skipped on the walk.
  const finished = mine.filter((f) => !f.live && f.pause === null && f.endedAt !== null && (opts.clearedAt === undefined || f.endedAt > opts.clearedAt));
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
    harness: harnessOf(driverOf(r)),
    status: "active",
    billing,
    eligible,
    perEpisode,
    ladder,
  };
  // The newest paused run that is not stale holds the model (ADR-0036).
  const pausedRun = [...mine].reverse().find((f) => f.pause !== null && !isStalePause(f, opts.now));
  if (pausedRun !== undefined && pausedRun.pause !== null) {
    state.paused = {
      runId: pausedRun.runId,
      reason: pausedRun.pause.reason,
      at: pausedRun.pause.at,
      episodeElapsedMs: pausedRun.pause.episodeElapsedMs,
      episodeMs: pausedRun.episodeMs,
    };
  }
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
  // The scheduler's own read includes the archive (see `readRunFacts`): the
  // ladder and the attempt numbers are made of runs no listing shows. A caller
  // that has already read the facts — the viewer — decides for itself.
  const runs = input.runs ?? readRunFacts(input.runsDir, now, { includeArchived: true });
  const sidecar = input.sidecar ?? readModelsSidecar(input.runsDir);
  return input.roster.map((r) => projectModel(r, runs, policy, { now, clearedAt: sidecar.cleared[r.name] }));
}

// -------------------------------------------------------------- scheduling

/**
 * Why a model is or is not schedulable right now — the `--status` line.
 * `extras` is true when the model has met its targets but may still take
 * an extra run (free billing, an extras policy, not cooling or retired).
 */
export function schedulability(
  s: ModelState,
  running: ReadonlySet<string> = new Set(),
  policy: Pick<SchedulingPolicy, "extras"> = DEFAULT_POLICY,
): { ok: boolean; why: string; extras: boolean } {
  if (s.retired !== undefined) return { ok: false, extras: false, why: `retired: ${s.retired.reason} — clear with --clear-model ${s.name}` };
  if (s.cooling !== undefined) {
    return { ok: false, extras: false, why: `cooling rung ${s.cooling.rung}/${LADDER_MS.length} until ${new Date(s.cooling.until).toISOString()} (${s.cooling.reason})` };
  }
  if (running.has(s.name)) return { ok: false, extras: false, why: "running (one stream per model)" };
  if (s.paused !== undefined) {
    const spent = s.paused.episodeElapsedMs !== null ? `${Math.round(s.paused.episodeElapsedMs / 60_000)}m` : "?m";
    const of = s.paused.episodeMs !== null ? ` of ${Math.round(s.paused.episodeMs / 60_000)}m` : "";
    return {
      ok: false,
      extras: false,
      why: `paused run ${s.paused.runId} (${s.paused.reason}, ${spent}${of} elapsed) — resumed by the supervisor, never rescheduled`,
    };
  }
  const open = s.eligible.filter((ep) => {
    const st = s.perEpisode[ep];
    return st !== undefined && st.counted < st.target;
  });
  if (open.length === 0) {
    const mode = extrasModeOf(s, policy);
    const extras = policy.extras !== null && s.billing === "free" && (mode === "freeplay" || policy.extras.characters.length > 0);
    const how = mode === "freeplay" ? " — freeplay extras while the box is idle" : " — extras when the pool is idle";
    return { ok: false, extras, why: `targets met on ${s.eligible.join(", ")}${extras ? how : ""}` };
  }
  return { ok: true, extras: false, why: `schedulable on ${open.join(", ")}` };
}

/** Extras made so far across every episode, which is what the character cycle indexes. */
export function extrasSoFar(s: ModelState): number {
  return STATS_EPISODES.reduce((n, ep) => n + (s.perEpisode[ep]?.extras ?? 0), 0);
}

/** Priority order of an episode: the scored tiers as they are declared, freeplay last. */
function episodeOrder(ep: EpisodeId): number {
  return EPISODE_IDS.indexOf(ep);
}

/**
 * The account class a pick belongs to (ADR-0034, "Account classes"): which of
 * `accounts.pool` / `accounts.paid` / `accounts.local` it may land on. `pool`
 * is the base class — every account that is not split out belongs to it.
 */
export type AccountClass = "pool" | "paid" | "local";

/** Every class, pool first: the order `--status` and `--dry-run` print them in. */
export const ACCOUNT_CLASSES = ["pool", "paid", "local"] as const;

/**
 * Which class a model's picks belong to. Local wins over billing: the LM Studio
 * box is free by `model-cost.ts` and still has exactly one runner, so its models
 * are kept off the shared pool for the same reason paid models are.
 */
export function accountClassOf(s: Pick<ModelState, "billing" | "platform">): AccountClass {
  if (s.platform === "local") return "local";
  return s.billing === "paid" ? "paid" : "pool";
}

/**
 * The same verdict from a roster entry, for callers that have the file rather
 * than the projection (`--status` renders its accounts table before the
 * projection is read). One classifier, two entry points.
 */
export function rosterClass(r: RosterModel): AccountClass {
  return accountClassOf({ billing: rosterBilling(r), platform: platformOf(r.apiBase, r.driver) });
}

/**
 * How this model takes its extras (ADR-0034, "Local extras are freeplay").
 *
 * A knob on the policy rather than a fact about the class, so the choice is
 * readable in `fleet.json`: `policy.extras.local` is `"freeplay"` by default
 * and `"characters"` puts the local class back on the race/class cycle the
 * free models run. Every other class cycles characters; only the local class
 * asks the knob.
 */
export function extrasModeOf(s: Pick<ModelState, "billing" | "platform">, policy: Pick<SchedulingPolicy, "extras">): ExtrasMode {
  if (policy.extras === null) return "characters";
  return accountClassOf(s) === "local" ? policy.extras.local : "characters";
}

export interface NextJobsOptions {
  /** Paid models already in flight (pinned jobs excluded), for the paid cap. */
  paidRunning?: number;
  policy?: Pick<SchedulingPolicy, "paid" | "extras">;
  /**
   * The accounts each SPLIT-OUT class may use (`accounts.paid`,
   * `accounts.local`; ADR-0034's account classes). A class missing from this
   * map is not split: its picks share `freeAccounts`, which is what every
   * caller did before the split. A class present takes its accounts from here
   * and never from `freeAccounts`; an empty array is therefore "this class has
   * nowhere free to run", and every pick of it is held saying so — `classBusy`
   * says which of the two reasons.
   */
  classAccounts?: Partial<Record<AccountClass, readonly string[]>>;
  /**
   * Accounts of a split-out class that EXIST but are occupied right now, with
   * the run or job holding each where the caller knows it. `classAccounts`
   * carries only what is free, so without this an all-busy class is
   * indistinguishable from an unconfigured one — and the fleet told operators
   * to add an account they already had (FOLLOW-UPS: the SHAKEOUT2 report).
   */
  classBusy?: Partial<Record<AccountClass, readonly BusyAccount[]>>;
}

/**
 * The policy's picks for the free pool accounts, in priority order:
 * (1) models with zero counted runs on any eligible episode, (2) the shorter
 * episode first, (3) fewest counted runs toward target, ties by roster order.
 * One job per model. `running` holds roster names with a stream in flight.
 *
 * Two additions under ADR-0034's paid/free split. A paid pick is held when
 * `policy.paid.maxConcurrent` paid models are already in flight, and the
 * next candidate takes its account; `held` says so. A pick of a SPLIT-OUT
 * class (paid, local) draws from `opts.classAccounts[class]` — never from
 * `freeAccounts` — so a paid model can only ever land on a paid account and a
 * local one only on the local box's account.
 * When every account still
 * free has nothing schedulable left, free models with an extras policy get an
 * **extra** run: fewest extras first, the shorter tier first (`e360` only for
 * a promoted model), roster order — and the pick carries the next character
 * in the cycle.
 */
export function planNextJobs(
  states: readonly ModelState[],
  freeAccounts: readonly string[],
  running: ReadonlySet<string> = new Set(),
  opts: NextJobsOptions = {},
): { jobs: NextJob[]; held: HeldPick[] } {
  const policy = opts.policy ?? DEFAULT_POLICY;
  interface Cand {
    s: ModelState;
    ep: EpisodeId;
    epOrder: number;
    fresh: number;
    counted: number;
    order: number;
  }
  const cands: Cand[] = [];
  const extraCands: Cand[] = [];
  states.forEach((s, order) => {
    const v = schedulability(s, running, policy);
    if (v.extras) {
      if (extrasModeOf(s, policy) === "freeplay") {
        // One candidate, not one per tier: a freeplay extra has no tier, and
        // there is only ever one of them in flight.
        extraCands.push({ s, ep: "freeplay", epOrder: episodeOrder("freeplay"), fresh: 1, counted: extrasSoFar(s), order });
        return;
      }
      // `eligible` already gates e360 on promotion (or a forced tier).
      for (const ep of s.eligible) {
        extraCands.push({ s, ep, epOrder: episodeOrder(ep), fresh: 1, counted: extrasSoFar(s), order });
      }
      return;
    }
    if (!v.ok) return;
    const fresh = s.eligible.every((ep) => (s.perEpisode[ep]?.counted ?? 0) === 0) ? 0 : 1;
    for (const ep of s.eligible) {
      const st = s.perEpisode[ep];
      if (st === undefined || st.counted >= st.target) continue;
      cands.push({ s, ep, epOrder: episodeOrder(ep), fresh, counted: st.counted, order });
    }
  });
  const byPriority = (a: Cand, b: Cand): number => a.fresh - b.fresh || a.epOrder - b.epOrder || a.counted - b.counted || a.order - b.order;
  cands.sort(byPriority);
  extraCands.sort(byPriority);

  const jobs: NextJob[] = [];
  const held: HeldPick[] = [];
  const taken = new Set<string>();
  const accounts = [...freeAccounts];
  // The split-out classes' accounts, each drawn down separately. A class absent
  // here is not split and shares `accounts` — the pre-split behaviour.
  const split: Partial<Record<AccountClass, string[]>> = {};
  for (const cls of ACCOUNT_CLASSES) {
    const declared = opts.classAccounts?.[cls];
    if (cls !== "pool" && declared !== undefined) split[cls] = [...declared];
  }
  const listOf = (cls: AccountClass): string[] => split[cls] ?? accounts;
  const empty = (): boolean => accounts.length === 0 && Object.values(split).every((l) => l.length === 0);
  // Who took which account of a split class in THIS call: a second local model
  // is held because the box is busy, not because the box is missing.
  const tookHere = new Map<AccountClass, BusyAccount[]>();
  /**
   * Why a split class has nothing free. Two different operator actions, so
   * never one message: an empty class needs an account added to the file, a
   * busy one needs a run to finish (or the cap raised).
   */
  const noRoom = (cls: AccountClass): string => {
    const busy = [...(opts.classBusy?.[cls] ?? []), ...(tookHere.get(cls) ?? [])];
    if (busy.length === 0) return `no ${cls} account configured — add one to accounts.${cls}`;
    return `${cls} account(s) busy: ${busy.map((b) => (b.by !== undefined ? `${b.account} held by ${b.by}` : b.account)).join(", ")}`;
  };
  let paid = opts.paidRunning ?? 0;
  const cap = policy.paid?.maxConcurrent;
  for (const c of cands) {
    if (taken.has(c.s.name)) continue;
    const cls = accountClassOf(c.s);
    const isPaid = c.s.billing === "paid";
    const from = listOf(cls);
    if (split[cls] !== undefined && from.length === 0) {
      // The actionable reason wins over the cap: there is no account to run on.
      taken.add(c.s.name);
      held.push({ name: c.s.name, episode: c.ep, why: noRoom(cls) });
      continue;
    }
    if (isPaid && cap !== undefined && paid >= cap) {
      taken.add(c.s.name);
      held.push({ name: c.s.name, episode: c.ep, why: `paid cap: ${paid}/${cap} paid model(s) already in flight` });
      continue;
    }
    if (from.length === 0) {
      taken.add(c.s.name);
      continue;
    }
    taken.add(c.s.name);
    if (isPaid) paid++;
    const st = c.s.perEpisode[c.ep]!;
    const account = from.shift()!;
    if (split[cls] !== undefined) tookHere.set(cls, [...(tookHere.get(cls) ?? []), { account, by: c.s.name }]);
    jobs.push({
      name: c.s.name,
      episode: c.ep,
      account,
      attempt: st.attempts + 1,
      why: `${c.fresh === 0 ? "no counted runs yet" : `${st.counted}/${st.target} on ${c.ep}`}${c.s.status === "promoted" ? ", promoted" : ""}`,
    });
  }
  // Extras: lowest priority, only for accounts nothing else wanted — and only
  // ever on the candidate's own class, so a local model's extra takes the local
  // box and never a pool account. An extra is a free model's run by
  // construction, so the paid class is never reached here.
  const chars = policy.extras?.characters ?? [];
  for (const c of extraCands) {
    if (empty()) break;
    if (taken.has(c.s.name)) continue;
    // A freeplay extra rolls no character: the roster entry's own start stands,
    // and the run is unbounded (the tier pins no wall clock).
    const freeplay = c.ep === "freeplay";
    if (!freeplay && chars.length === 0) continue;
    const xcls = accountClassOf(c.s);
    const from = listOf(xcls);
    if (from.length === 0) continue;
    taken.add(c.s.name);
    const st = c.s.perEpisode[c.ep]!;
    const n = extrasSoFar(c.s);
    const character = freeplay ? undefined : chars[n % chars.length]!;
    const account = from.shift()!;
    if (split[xcls] !== undefined) tookHere.set(xcls, [...(tookHere.get(xcls) ?? []), { account, by: c.s.name }]);
    jobs.push({
      name: c.s.name,
      episode: c.ep,
      account,
      attempt: st.attempts + 1,
      why: freeplay
        ? `extra #${n + 1}: freeplay (targets met; one unbounded run at a time)`
        : `extra #${n + 1} on ${c.ep} (targets met; race ${character!.race} class ${character!.class})`,
      ...(character !== undefined ? { extra: character } : {}),
    });
  }
  return { jobs, held };
}

/** `planNextJobs` without the explanation — what the supervisor consumes. */
export function nextJobs(
  states: readonly ModelState[],
  freeAccounts: readonly string[],
  running: ReadonlySet<string> = new Set(),
  opts: NextJobsOptions = {},
): NextJob[] {
  return planNextJobs(states, freeAccounts, running, opts).jobs;
}
