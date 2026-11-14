/**
 * Credentials with slots, the fleet's half (Shard/WrathBench#429;
 * `runner/src/credential-slots.ts` has the record and `runner/src/subscription-usage.ts`
 * the usage windows).
 *
 * "Can this run start now, and on what?" has one answer: a run takes a slot on
 * the first enabled credential that serves its model's provider and has room
 * under its slots and its budget, and it records that credential. Under that,
 * one cap is not a credential's — how many sessions of a driver one host can
 * carry (`policy.maxSessions`) — and it is counted beside the slots.
 *
 * Three pieces, asked at every place a launch can happen (the pinned jobs, the
 * manual queue, the policy's picks, the resumes, a running roster's next
 * episode):
 *
 * - **`CredentialGate`**, the budgets: a credential's newest usage reading
 *   (off the runs on disk, and for OpenCode Go off its usage endpoint,
 *   `FleetGoUsage`), the runs it launched today and the provider's charge on
 *   them today. A held credential is passed over like a full one.
 * - **`SlotBook`**, the counts: every live run on its credential's slot and
 *   its driver's session cap, re-derived each tick from the runs and the jobs.
 * - **`placeRef`**, the choice: the candidates in preference order
 *   (`credentialCandidates`, the one place that asks), each tried against the
 *   gate and the book.
 *
 * The sentences a hold produces can reach a public surface (a held pick's
 * reason, a paused run's `why`), so they name the credential and the budget's
 * kind and never a percentage, a sum or a reset time; `formatCredentialStatus`
 * is the operator's `--status` block, which carries all three.
 */
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { credentialCandidates, describeBudget, providerById, type Credential } from "../runner/src/credential-slots";
import {
  credentialHealth,
  credentialWindows,
  type CredentialFix,
  type CredentialHealth,
  type CredentialHold,
  type CredentialRead,
  type CredentialWindow,
  type HoldCode,
  type ResumeHoldCode,
} from "../runner/src/credential-health";
import { DEFAULT_DRIVER, driverEntry } from "../runner/src/drivers";
import { utcDay, type RunFact } from "../runner/src/models";
import { isOpenCodeGoBase } from "../runner/src/platform";
import { GoUsagePoller, goUsageUrl, type GoFetch } from "../runner/src/opencode-go";
import type { SecretResolution } from "../runner/src/store-secrets";
import {
  CREDENTIAL_USAGE_SIDECAR,
  describeWindows,
  EXHAUSTED_PCT,
  gateClassOf,
  newestByCredential,
  readCredentialUsage,
  thresholdOf,
  usageHold,
  type SubscriptionUsage,
  type UsageHold,
} from "../runner/src/subscription-usage";
import type { FleetRosterEntry, JobSpawn } from "./run-fleet-config";

export { readCredentialUsage, CREDENTIAL_USAGE_SIDECAR };

// ------------------------------------------------------------------ the budgets

/** Why a paused run's credential holds its resume: the operator's sentence, and its code for the public phrase. */
export interface ResumeHold {
  text: string;
  /** Null only from a gate that worded its hold without a code. */
  code: ResumeHoldCode | null;
}

/** The run facts a budget reads. */
export type BudgetRun = Pick<RunFact, "credential" | "startedAt"> & Partial<Pick<RunFact, "spendByDay" | "resumesByDay" | "credentialUsage">>;

export interface CredentialGate {
  now: number;
  /** The newest usage observation per credential. */
  usage: ReadonlyMap<string, SubscriptionUsage>;
  /** The usage hold on a launch of `episode`'s class and `model` on credential `id`, or null. */
  usageHoldOf(id: string, episode: string | null | undefined, model?: string | null): UsageHold | null;
  /**
   * Why a launch of `episode`'s class is held on credential `id` by its
   * budget, in words fit for any surface, or undefined. A fresh start and a
   * resume are held alike: each segment is a run to a runs-per-day budget.
   */
  holdOf(id: string, episode: string | null | undefined, model?: string | null): string | undefined;
  /**
   * `holdOf`, structured: the sentence, plus what holds (`HoldCode`) and
   * until when where known. The code and the time are operator-only (the
   * admin interface's status); the sentence stays the one any surface gets.
   */
  holdReasonOf(id: string, episode: string | null | undefined, model?: string | null): (CredentialHold & { text: string }) | undefined;
  /**
   * Launches on `id` since 00:00 UTC, as the runs on disk record them: fresh
   * starts and the segments resumes started. A tick's own starts count from
   * the next tick, so one tick may pass the budget by what it starts at once,
   * at most the credential's free slots.
   */
  runsToday(id: string): number;
  /** The provider's reported charge on `id`'s runs since 00:00 UTC, in dollars. */
  spendToday(id: string): number;
}

/** The next 00:00 UTC after `now`: when a per-day budget opens again. */
export function nextUtcMidnight(now: number): number {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
}

/** A hold the provider's last read of a credential's key puts on it (`FleetGoUsage.readHolds`). */
export interface ReadHold {
  code: Extract<HoldCode, "auth-failed" | "no-access" | "overage">;
  text: string;
}

/**
 * The gate over the credentials, the readings and the runs, and the holds the
 * providers' reads of their keys put on them (`readHolds`), which come first:
 * a credential whose key was refused is held before its budget is asked. Pure.
 */
export function credentialGate(
  credentials: readonly Credential[],
  observations: Iterable<SubscriptionUsage | null | undefined>,
  runs: readonly BudgetRun[],
  now: number,
  readHolds: ReadonlyMap<string, ReadHold> = new Map(),
): CredentialGate {
  const usage = newestByCredential(observations);
  const byId = new Map(credentials.map((c) => [c.id, c]));
  const today = utcDay(now);
  const midnight = Date.parse(`${today}T00:00:00.000Z`);
  const runsToday = new Map<string, number>();
  const spendToday = new Map<string, number>();
  const started = (id: string, n = 1): void => {
    runsToday.set(id, (runsToday.get(id) ?? 0) + n);
  };
  for (const f of runs) {
    if (f.credential === null) continue;
    if (f.startedAt >= midnight) started(f.credential);
    // Each segment a resume started today is a run too (operator, 2026-11-11).
    const resumed = f.resumesByDay?.[today];
    if (resumed !== undefined && resumed > 0) started(f.credential, resumed);
    const spent = f.spendByDay?.[today];
    if (spent !== undefined) spendToday.set(f.credential, (spendToday.get(f.credential) ?? 0) + spent);
  }
  const usageHoldOf = (id: string, episode: string | null | undefined, model?: string | null): UsageHold | null => {
    const c = byId.get(id);
    if (c === undefined) return null;
    // A spent window holds every credential that has readings, budget or not:
    // no attempt is spent against a quota known to be empty.
    const t = c.budget?.kind === "usage" ? { scored: c.budget.scoredMaxPct, freeplay: c.budget.freeplayMaxPct } : { scored: EXHAUSTED_PCT, freeplay: EXHAUSTED_PCT };
    return usageHold(usage.get(id), thresholdOf(gateClassOf(episode), t), now, model ?? null);
  };
  const holdReasonOf = (id: string, episode: string | null | undefined, model?: string | null): (CredentialHold & { text: string }) | undefined => {
    const c = byId.get(id);
    if (c === undefined) return undefined;
    const read = readHolds.get(id);
    if (read !== undefined) return { code: read.code, until: null, text: read.text };
    const h = usageHoldOf(id, episode, model);
    if (h !== null) {
      const cls = gateClassOf(episode);
      return h.threshold >= EXHAUSTED_PCT || cls === "spent-only" || h.windows.some((w) => w.usedPercent >= EXHAUSTED_PCT)
        ? { code: "usage-spent", until: h.until, text: `credential ${id}: a usage window is spent — held until it resets` }
        : { code: "usage-threshold", until: h.until, text: `credential ${id}: at or over its ${cls} usage threshold — held until its usage window resets` };
    }
    if (c.budget?.kind === "spend" && (spendToday.get(id) ?? 0) >= c.budget.usdPerDay) {
      return { code: "spend-budget", until: nextUtcMidnight(now), text: `credential ${id}: its spend budget for the day is used — held until 00:00 UTC` };
    }
    if (c.budget?.kind === "runs" && (runsToday.get(id) ?? 0) >= c.budget.perDay) {
      return { code: "runs-budget", until: nextUtcMidnight(now), text: `credential ${id}: its runs for the day are used — held until 00:00 UTC` };
    }
    return undefined;
  };
  return {
    now,
    usage,
    usageHoldOf,
    holdReasonOf,
    holdOf: (id, episode, model) => holdReasonOf(id, episode, model)?.text,
    runsToday: (id) => runsToday.get(id) ?? 0,
    spendToday: (id) => spendToday.get(id) ?? 0,
  };
}

// ------------------------------------------------------------------ the counts

/** A credential slot's key in a `SlotBook`. */
export const credentialKey = (id: string): string => `credential:${id}`;
/** A driver's host-session key in a `SlotBook`. */
export const driverKey = (driver: string): string => `driver:${driver}`;
/** The run-pod key in a `SlotBook`: every probing episode while it runs as its own pod. */
export const RUN_POD_KEY = "run-pods";
/**
 * The world key in a `SlotBook`: every scored or probing attempt while each
 * plays on a world of its own. One per attempt however many sessions it
 * holds — a party's members share their world — so it is counted once per
 * add whatever the count asked for.
 */
export const WORLD_KEY = "worlds";

/**
 * The book's run-pod setting: undefined while probing episodes are child
 * processes (`policy.runPods` off, or off the cluster: `chooseLauncher`'s
 * test), else the chart's cap on pods in flight (`runPods.maxPods`, absent
 * for none). The cap is the namespace's room said up front: its
 * ResourceQuota refuses a pod past it at creation (`isQuotaRefusal`).
 */
export function runPodsOf(mode: string, onCluster: boolean, maxPods: number | undefined): { max: number | undefined } | undefined {
  return mode === "probes" && onCluster ? { max: maxPods } : undefined;
}

/**
 * The book's world setting, as `runPodsOf`: undefined while every run shares
 * the long-lived world (`policy.worlds` off), else the chart's `worlds.max`.
 * With worlds on, a scored or probing attempt never falls back to the shared
 * world, so where none can be made — off the cluster, or while failed boots
 * hold them (`worldsHold`) — the key is full and says why.
 */
export function worldsOf(mode: string, onCluster: boolean, maxWorlds: number | undefined, hold?: string): WorldsSetting | undefined {
  if (mode !== "evals") return undefined;
  if (!onCluster) return { max: 0, hold: "policy.worlds is \"evals\" and this supervisor is not on the cluster: a scored or probing attempt plays on a world of its own or not at all" };
  return hold !== undefined ? { max: 0, hold } : { max: maxWorlds };
}

export interface WorldsSetting {
  max: number | undefined;
  /** Why no world may be made now; the key is full while it is set. */
  hold?: string;
}

/** The tiers that play on a world of their own while worlds are on (`infra/world.ts` `worldUsedBy`). */
const WORLD_EPISODES = new Set(["e90", "e360", "probing", "deadmines", "deadmines-solo"]);

/**
 * Every run in flight, counted on its credential's slots and its driver's
 * host sessions: one tick's ledger. Built afresh each tick from what is live,
 * so it survives a supervisor restart as the runs do.
 */
export class SlotBook {
  private readonly count = new Map<string, number>();
  private readonly slots: ReadonlyMap<string, number>;

  constructor(
    credentials: readonly Credential[],
    private readonly maxSessions: Readonly<Record<string, number>>,
    /**
     * How the probing episodes run (`runPodsOf`): undefined while they are
     * child processes, else as pods under `max` at once (none: no cap).
     */
    private readonly runPods?: { max: number | undefined },
    /** The worlds (`worldsOf`): undefined while every attempt shares the long-lived world, else at most `max` at once. */
    private readonly worlds?: WorldsSetting,
  ) {
    this.slots = new Map(credentials.map((c) => [credentialKey(c.id), c.slots]));
  }

  /**
   * The keys one session of `driver` on credential `id` (none for a scripted
   * run) counts against, and the run-pod key for a probing episode while those
   * run as pods.
   */
  keysOf(driver: string | undefined, id: string | null | undefined, episode?: string | null): string[] {
    const d = driver ?? DEFAULT_DRIVER;
    return [
      ...(id != null ? [credentialKey(id)] : []),
      driverKey(d),
      ...(episode === "probing" && this.runPods !== undefined ? [RUN_POD_KEY] : []),
      ...(episode != null && WORLD_EPISODES.has(episode) && this.worlds !== undefined ? [WORLD_KEY] : []),
    ];
  }

  capOf(key: string): number | undefined {
    if (key.startsWith("credential:")) return this.slots.get(key) ?? 0;
    if (key === RUN_POD_KEY) return this.runPods?.max;
    if (key === WORLD_KEY) return this.worlds?.max;
    return this.maxSessions[key.slice("driver:".length)];
  }

  inUse(key: string): number {
    return this.count.get(key) ?? 0;
  }

  add(keys: readonly string[], n = 1): void {
    for (const k of keys) this.count.set(k, this.inUse(k) + perKey(k, n));
  }

  remove(keys: readonly string[], n = 1): void {
    for (const k of keys) this.count.set(k, Math.max(0, this.inUse(k) - perKey(k, n)));
  }

  /** The first key with no room for `n` more sessions, or undefined when they fit. */
  fullKey(keys: readonly string[], n = 1): string | undefined {
    return keys.find((k) => {
      const cap = this.capOf(k);
      return cap !== undefined && this.inUse(k) + perKey(k, n) > cap;
    });
  }

  /** "credential claude-1 1/1 in flight" — a full key, for a hold's reason. */
  describe(key: string): string {
    const cap = this.capOf(key);
    if (key.startsWith("credential:")) return `credential ${key.slice("credential:".length)} ${this.inUse(key)}/${cap} in flight`;
    if (key === RUN_POD_KEY) return `run pods ${this.inUse(key)}/${cap} in flight (the chart's runPods.maxPods)`;
    if (key === WORLD_KEY) return this.worlds?.hold ?? `worlds ${this.inUse(key)}/${cap} (the chart's worlds.max)`;
    return `${key.slice("driver:".length)} ${this.inUse(key)}/${cap} sessions on this host`;
  }

  clone(): SlotBook {
    const b = Object.create(SlotBook.prototype) as SlotBook;
    Object.assign(b, { count: new Map(this.count), slots: this.slots, maxSessions: this.maxSessions, runPods: this.runPods, worlds: this.worlds });
    return b;
  }
}

/** A world is one per attempt, whatever its sessions; every other key counts each. */
function perKey(key: string, n: number): number {
  return key === WORLD_KEY ? Math.min(n, 1) : n;
}

// ------------------------------------------------------------------ the choice

/** A credential as a spawn carries it to the run: its id, the variable its secret is in, its usage thresholds. */
export interface PlacedCredential {
  id: string;
  env: string;
  usageMaxPct?: { scored: number; freeplay: number };
}

export function placedOf(c: Credential): PlacedCredential {
  return {
    id: c.id,
    env: c.secretEnv,
    ...(c.budget?.kind === "usage" ? { usageMaxPct: { scored: c.budget.scoredMaxPct, freeplay: c.budget.freeplayMaxPct } } : {}),
  };
}

/** Where one ref would run: its credential (null for a scripted run) and the keys it would spend. */
export interface Placement {
  credential: PlacedCredential | null;
  keys: string[];
}

export type PlaceResult = { ok: true; placement: Placement } | { ok: false; why: string };

/**
 * Where a session of one roster entry may start for `episode`: the first
 * candidate (`credentialCandidates`, in preference order, or `pin` alone) the
 * gate does not hold and the book has room on for `sessions` more, or why
 * none. Never mutates the book; the caller adds the placement's keys once it
 * commits. A party is `sessions` members on one credential: all of them, or
 * none.
 */
export function placeRef(
  entry: Pick<FleetRosterEntry, "model" | "driver" | "apiBase" | "billing"> | undefined,
  episode: string,
  o: {
    credentials: readonly Credential[];
    book: SlotBook;
    gate?: CredentialGate | undefined;
    pin?: string | undefined;
    sessions?: number;
    env?: Record<string, string | undefined>;
  },
): PlaceResult {
  if (entry === undefined) return { ok: false, why: "not in the roster" };
  const sessions = o.sessions ?? 1;
  const fit = credentialCandidates(o.credentials, entry, { pin: o.pin, ...(o.env !== undefined ? { env: o.env } : {}) });
  if (fit.provider === null) {
    const keys = o.book.keysOf(entry.driver, null, episode);
    const full = o.book.fullKey(keys, sessions);
    return full === undefined ? { ok: true, placement: { credential: null, keys } } : { ok: false, why: `cap: ${o.book.describe(full)}` };
  }
  if (fit.candidates.length === 0) return { ok: false, why: fit.why! };
  const whys: string[] = [];
  for (const c of fit.candidates) {
    const held = o.gate?.holdOf(c.id, episode, entry.model);
    if (held !== undefined) {
      whys.push(held);
      continue;
    }
    const keys = o.book.keysOf(entry.driver, c.id, episode);
    const full = o.book.fullKey(keys, sessions);
    if (full !== undefined) {
      whys.push(`cap: ${o.book.describe(full)}`);
      continue;
    }
    return { ok: true, placement: { credential: placedOf(c), keys } };
  }
  return { ok: false, why: whys.length === 1 ? whys[0]! : `no credential has room (${whys.join("; ")})` };
}

/**
 * Where a paused run comes back: only on the credential it recorded, never
 * moved (a Codex home holds its threads; a Claude run is moved by the
 * operator, `move-credential`). A run that recorded none goes where a fresh
 * launch would.
 */
export function placeResume(
  entry: Pick<FleetRosterEntry, "model" | "driver" | "apiBase" | "billing"> | undefined,
  episode: string,
  recorded: string | null | undefined,
  o: Parameters<typeof placeRef>[2],
): PlaceResult {
  if (recorded == null) return placeRef(entry, episode, o);
  const r = placeRef(entry, episode, { ...o, pin: recorded });
  return r.ok ? r : { ok: false, why: `${r.why} (a paused run comes back on the credential it started on)` };
}

// ---------------------------------------------------------------- OpenCode Go

/**
 * Whether the supervisor reads this credential's OpenCode Go usage: every Go
 * credential on the allowance — its paid side, whatever its budget's kind —
 * and any Go credential the operator gave a `usage` budget. A `runs` budget
 * on the paid side still draws the allowance, so a refused key or a spent
 * window holds it too; only the budget's own limit differs. The free side is
 * not read: a `$0` model keeps working past a spent allowance, and a reading
 * on it would hold it at 100% like any credential with readings. A refused
 * key still reaches it, because it names the same key (`readHoldsOf`).
 * Enabled-ness is the caller's: a reader polls only enabled credentials.
 */
export function readsGoUsage(c: Pick<Credential, "provider" | "billing" | "budget">): boolean {
  return c.provider === "opencode-go" && (c.billing === "paid" || c.budget?.kind === "usage");
}

/**
 * Why each credential's launches are held by its key's last read, by id, off
 * the reads by credential id: a refused key holds every enabled credential of
 * its provider naming the same variable (the free side shares the paid side's
 * key); no access to the usage and a balance charge hold the credential read.
 * The sentences name the credential and the class only, like every hold's.
 * Pure: the supervisor passes its pollers' reads (`FleetGoUsage.readHolds`),
 * and `--status` and the dry run the reads the supervisor published
 * (`publishedReads`), so all three hold alike.
 */
export function readHoldsOf(credentials: readonly Credential[], reads: ReadonlyMap<string, CredentialRead>): Map<string, ReadHold> {
  const out = new Map<string, ReadHold>();
  const byId = new Map(credentials.map((c) => [c.id, c]));
  for (const [id, r] of reads) {
    const of = byId.get(id);
    if (of === undefined) continue;
    if (r.classification === "auth-failed") {
      for (const c of credentials) {
        if (c.enabled && c.provider === of.provider && c.secretEnv === of.secretEnv && !out.has(c.id)) {
          out.set(c.id, { code: "auth-failed", text: `credential ${c.id}: its key was refused (auth-failed) — held until a usage read succeeds` });
        }
      }
    } else if (r.classification === "no-access" && !out.has(id)) {
      out.set(id, { code: "no-access", text: `credential ${id}: its key may not read its usage (no-access) — held until a usage read succeeds` });
    } else if (r.classification === "overage" && !out.has(id)) {
      out.set(id, { code: "overage", text: `credential ${id}: billed past its allowance (overage) — held until its usage shows room` });
    }
  }
  return out;
}

/**
 * The reads a supervisor published with its credential statuses
 * (fleet-state.json's `credentials[].lastRead`), by id, for a reader that is
 * not the supervisor: only the credentials it reads itself (`readsGoUsage`).
 * A status carries a sibling's refusal on a credential with no read of its
 * own (`credentialStatuses`), and that borrowed read is not one the
 * supervisor holds it by. A disabled credential's read counts as the tick
 * counts it: its refusal still holds the enabled credentials naming its key.
 * A state file with no reads gives none.
 */
export function publishedReads(credentials: readonly Credential[], statuses: readonly Pick<CredentialStatus, "id" | "lastRead">[] | undefined): Map<string, CredentialRead> {
  const read = new Set(credentials.filter((c) => readsGoUsage(c)).map((c) => c.id));
  const out = new Map<string, CredentialRead>();
  for (const s of statuses ?? []) if (s.lastRead !== undefined && read.has(s.id)) out.set(s.id, s.lastRead);
  return out;
}

/**
 * The supervisor's reader for the OpenCode Go credentials it reads
 * (`readsGoUsage`, `opencode-go.ts`): one poller per credential, each calling its
 * endpoint at most once a minute, refreshed before a tick decides anything.
 * The endpoint is the Go base's origin, which the roster's Go entries name.
 * A key missing from the environment is no observation, said once per boot.
 * Every read is classified (`GoUsagePoller.lastRead`), and a change of class
 * is said: a refused key (`auth-failed`) holds every Go credential naming it,
 * a key that may not read usage (`no-access`) and a balance charge a run
 * recorded (`overage`, `noteOverages`) hold that credential, and an unread
 * endpoint holds nothing (`readHolds`, which the gate takes). The key is
 * read from the environment at the call and never logged.
 */
export class FleetGoUsage {
  private readonly pollers = new Map<string, GoUsagePoller>();
  private readonly missingKey = new Set<string>();
  /** The key each poller was built with, compared by value and never logged. */
  private readonly keyOf = new Map<string, string>();

  constructor(
    private readonly o: {
      env?: Record<string, string | undefined>;
      fetch?: GoFetch;
      now?: () => number;
      say?: (line: string) => void;
    } = {},
  ) {}

  /**
   * Read every due Go credential; resolves when done. Never rejects. `env` is
   * where the keys are read from this time: the supervisor passes its
   * environment with the config store's secrets over it, read each tick.
   */
  async refresh(
    credentials: readonly Credential[],
    roster: Readonly<Record<string, Pick<FleetRosterEntry, "apiBase">>>,
    env: Record<string, string | undefined> = this.o.env ?? process.env,
  ): Promise<void> {
    const base = Object.values(roster).map((e) => e.apiBase).find((b) => isOpenCodeGoBase(b));
    const url = goUsageUrl(base);
    if (url === undefined) return;
    const due: Promise<void>[] = [];
    for (const c of credentials) {
      if (!c.enabled || !readsGoUsage(c)) continue;
      const key = env[c.secretEnv];
      if (key === undefined || key.length === 0) {
        if (!this.missingKey.has(c.id)) {
          this.missingKey.add(c.id);
          this.o.say?.(`credential ${c.id}: ${c.secretEnv} is not set, so its OpenCode Go usage is not read and holds nothing`);
        }
        continue;
      }
      this.missingKey.delete(c.id);
      let poller = this.pollers.get(c.id);
      // A key set or rotated since (the config store, read each tick) is a new
      // key: a fresh poller reads it, rather than the old one reading the old.
      if (poller !== undefined && this.keyOf.get(c.id) !== key) poller = undefined;
      if (poller === undefined) {
        poller = new GoUsagePoller(c.id, url, key, {
          ...(this.o.fetch !== undefined ? { fetch: this.o.fetch } : {}),
          ...(this.o.now !== undefined ? { now: this.o.now } : {}),
          ...(this.o.say !== undefined ? { onNote: (t: string) => this.o.say!(`credential ${c.id}: ${t}`) } : {}),
        });
        this.pollers.set(c.id, poller);
        this.keyOf.set(c.id, key);
      }
      due.push(poller.refresh());
    }
    await Promise.all(due);
  }

  /**
   * The balance charges the runs recorded (meta.json's `credentialOverage`,
   * `RunFact.credentialOverageAt`), handed to each polled credential's
   * poller: the newest stands until a read shows room after it.
   */
  noteOverages(runs: Iterable<Pick<RunFact, "credential"> & Partial<Pick<RunFact, "credentialOverageAt">>>): void {
    for (const f of runs) {
      if (f.credential === null || f.credentialOverageAt == null) continue;
      this.pollers.get(f.credential)?.noteOverage(f.credentialOverageAt);
    }
  }

  /** Why each credential's launches are held by its key's last read, by id (`readHoldsOf` over `lastReads`). */
  readHolds(credentials: readonly Credential[]): Map<string, ReadHold> {
    return readHoldsOf(credentials, this.lastReads());
  }

  /** The newest reading of every credential read so far. */
  observations(): SubscriptionUsage[] {
    return [...this.pollers.values()].flatMap((p) => (p.current !== undefined ? [p.current] : []));
  }

  /**
   * Each poller's last read as its reader classified it, by credential id: the
   * status's health input (`credentialStatuses`' `reads`). A poller that does
   * not keep one (`GoUsagePoller.lastRead`) contributes nothing.
   */
  lastReads(): Map<string, CredentialRead> {
    const out = new Map<string, CredentialRead>();
    for (const [id, p] of this.pollers) {
      const r = (p as { lastRead?: CredentialRead }).lastRead;
      if (r !== undefined) out.set(id, r);
    }
    return out;
  }
}

/** Write the supervisor's readings beside the runs. Best effort: a failure is no reading for the others, never a stopped tick. */
export function writeCredentialUsageSidecar(runsDir: string, usage: readonly SubscriptionUsage[]): void {
  try {
    writeFileSync(join(runsDir, CREDENTIAL_USAGE_SIDECAR), `${JSON.stringify({ credentials: usage }, null, 2)}\n`, "utf8");
  } catch {
    // the runs on disk still carry their own readings
  }
}

// ---------------------------------------------------------------- the status

/**
 * One credential's state, as the supervisor publishes it (fleet-state.json),
 * `--status` prints it and the private viewer shows it. Operator-only: the
 * figures never reach a public surface, and nothing here is a secret — the
 * variable's NAME and whether it is set, never its value.
 */
export interface CredentialStatus {
  id: string;
  provider: string;
  billing: "free" | "paid";
  enabled: boolean;
  secretEnv: string;
  /** Whether the variable is set: its secret in the config store, else the supervisor's environment. Never which value. */
  secretSet: boolean;
  /** Present and true when the config store holds its secret, which then wins over the environment's. */
  stored?: boolean;
  slots: number;
  inUse: number;
  budget: string;
  /** What the budget has used: the usage windows, today's spend or runs; null with no budget and no reading. */
  used: string | null;
  /** Why a scored and a freeplay launch are held, when they are. */
  held: { scored?: string; freeplay?: string };
  /**
   * The same holds, structured: what holds each and until when. Absent from a
   * state file a supervisor wrote before it published them; the admin
   * interface then reads a held class as held by its budget, code unknown.
   */
  holds?: { scored?: CredentialHold; freeplay?: CredentialHold };
  /** The newest failure a run on it recorded that says the credential itself is the problem (`auth-failed`, `no-access`, `quota-exhausted`), with when. */
  lastError: { reason: string; at: number } | null;
  /** The provider's newest read of it, where a reader reads it (OpenCode Go's usage endpoint): its health's input. */
  lastRead?: CredentialRead;
  /** Its state, why, since when, and the provider's last answer (`credentialHealth`). */
  health?: CredentialHealth;
  /** Its newest usage reading's windows in force, as meters; null with no reading. */
  windows?: CredentialWindow[] | null;
  /** What makes it well again; null when it is. */
  fix?: CredentialFix | null;
}

/** The pauses that indict the credential rather than the model. */
const CREDENTIAL_PAUSES: ReadonlySet<string> = new Set(["auth-failed", "no-access", "quota-exhausted"]);

/** Every credential's state this tick. */
export function credentialStatuses(o: {
  credentials: readonly Credential[];
  book: SlotBook;
  gate: CredentialGate;
  runs: readonly Pick<RunFact, "credential" | "pause">[];
  env?: Record<string, string | undefined>;
  /**
   * The config store's secrets over the environment (`resolveStoreSecrets`):
   * a variable reads as set from its stored secret, and as unset when its
   * stored secret does not open. Absent: the environment alone.
   */
  secrets?: SecretResolution;
  /**
   * The providers' last reads, by credential id (`FleetGoUsage.lastReads()`).
   * A credential with none of its own takes another's of its provider naming
   * the same variable only where the read is about the key itself (refused,
   * or no access): Go's free side shares the paid side's key but bills no
   * plan, so the paid side's usage says nothing about it.
   */
  reads?: ReadonlyMap<string, CredentialRead>;
}): CredentialStatus[] {
  const env = o.secrets?.env ?? o.env ?? process.env;
  const readOf = (c: Credential): CredentialRead | undefined =>
    o.reads?.get(c.id) ??
    o.credentials
      .filter((x) => x.provider === c.provider && x.secretEnv === c.secretEnv)
      .map((x) => o.reads?.get(x.id))
      .find((r) => r !== undefined && (r.classification === "auth-failed" || r.classification === "no-access"));
  return o.credentials.map((c) => {
    const u = o.gate.usage.get(c.id);
    const used =
      c.budget?.kind === "spend"
        ? `$${o.gate.spendToday(c.id).toFixed(2)} of $${c.budget.usdPerDay} today`
        : c.budget?.kind === "runs"
          ? `${o.gate.runsToday(c.id)} of ${c.budget.perDay} runs today`
          : u !== undefined && u.windows.length > 0
            ? describeWindows(u.windows, u.observedAt)
            : null;
    const scoredHold = o.gate.holdReasonOf(c.id, "e90");
    const freeplayHold = o.gate.holdReasonOf(c.id, "freeplay");
    const scored = scoredHold?.text;
    const freeplay = freeplayHold?.text;
    let lastError: CredentialStatus["lastError"] = null;
    for (const f of o.runs) {
      if (f.credential !== c.id || f.pause === null || !CREDENTIAL_PAUSES.has(f.pause.reason)) continue;
      if (lastError === null || f.pause.at > lastError.at) lastError = { reason: f.pause.reason, at: f.pause.at };
    }
    const secret = env[c.secretEnv];
    const holds = providerById(c.provider)?.holds ?? "key";
    const home = holds === "home";
    // A home is a path, and a path that does not exist is as unset as an empty one.
    const secretSet = secret !== undefined && secret.length > 0 && (!home || existsSync(secret));
    const holdsOf = {
      ...(scoredHold !== undefined ? { scored: { code: scoredHold.code, until: scoredHold.until } } : {}),
      ...(freeplayHold !== undefined ? { freeplay: { code: freeplayHold.code, until: freeplayHold.until } } : {}),
    };
    const lastRead = readOf(c);
    const stored = o.secrets?.stored.has(c.secretEnv) === true;
    const storedUnreadable = o.secrets?.unreadable.get(c.secretEnv) ?? null;
    const replacedAt = o.secrets?.updatedAt.get(c.secretEnv) ?? null;
    const { health, fix } = credentialHealth({ enabled: c.enabled, secretEnv: c.secretEnv, holds, secretSet, stored, storedUnreadable, holdsOf, lastError, read: lastRead ?? null, replacedAt });
    return {
      id: c.id,
      provider: c.provider,
      billing: c.billing,
      enabled: c.enabled,
      secretEnv: c.secretEnv,
      secretSet,
      ...(stored ? { stored } : {}),
      slots: c.slots,
      inUse: o.book.inUse(credentialKey(c.id)),
      budget: describeBudget(c.budget),
      used,
      held: { ...(scored !== undefined ? { scored } : {}), ...(freeplay !== undefined ? { freeplay } : {}) },
      holds: holdsOf,
      lastError,
      ...(lastRead !== undefined ? { lastRead } : {}),
      health,
      windows: credentialWindows(u, o.gate.now),
      fix,
    };
  });
}

/** "4m ago" — how old an instant is. */
function ago(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60_000));
  return m < 60 ? `${m}m ago` : m < 48 * 60 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`;
}

/**
 * `--status`: one line per credential — slots in use, the budget and what it
 * has used, whether its secret is set, whether a scored and a freeplay launch
 * are held, and the newest failure that indicts it — plus the per-driver
 * session caps. Operator-only.
 */
export function formatCredentialStatus(
  statuses: readonly CredentialStatus[],
  maxSessions: Readonly<Record<string, number>>,
  now: number,
  opts: {
    /** How full a credential's own volume is (a Codex home's), appended to its line; undefined adds nothing. */
    volumeOf?: (s: CredentialStatus) => string | undefined;
  } = {},
): string[] {
  const out: string[] = [];
  const caps = Object.entries(maxSessions).map(([d, n]) => `${d} <= ${n}`);
  if (statuses.length === 0) {
    out.push("credentials: none configured — no model run can start (bun wb config credentials add <id> <json>)");
  } else {
    out.push("credentials (a run takes a slot on the first enabled one that serves its provider and has room):");
    for (const s of statuses) {
      const state = !s.enabled ? "disabled" : !s.secretSet ? "!! not set" : "ok";
      const held = s.held.scored !== undefined && s.held.freeplay !== undefined ? "starts HELD" : s.held.scored !== undefined ? "scored starts HELD" : s.held.freeplay !== undefined ? "freeplay HELD" : "open";
      const err = s.lastError !== null ? `; last ${s.lastError.reason} ${ago(now - s.lastError.at)}` : "";
      const volume = opts.volumeOf?.(s);
      out.push(
        `  ${s.id.padEnd(16)} ${s.provider.padEnd(12)} ${s.billing.padEnd(4)}  ${s.inUse}/${s.slots} slots  ${s.budget}${s.used !== null ? ` (${s.used})` : ""} — ${held}; ${s.secretEnv} ${state}${err}${volume !== undefined ? `; volume ${volume}` : ""}`,
      );
    }
  }
  if (caps.length > 0) out.push(`host sessions: ${caps.join(", ")} (policy.maxSessions; every session of the driver counts, whichever credential pays)`);
  return out;
}

/** The driver a roster entry runs on, for its session cap. */
export function driverOfEntry(e: Pick<FleetRosterEntry, "driver"> | undefined): string {
  return driverEntry(e?.driver ?? DEFAULT_DRIVER)?.id ?? DEFAULT_DRIVER;
}

// ------------------------------------------------------------------ the spawns

/**
 * Why a paused run's credential holds its resume, or undefined: gone from the
 * config, disabled, or its budget (`CredentialGate.holdReasonOf`), with its code. A run that
 * recorded none is held by nothing here.
 */
export function resumeHoldOf(
  f: Pick<RunFact, "credential" | "episode" | "model">,
  cfg: { credentials: readonly Credential[] },
  gate: CredentialGate,
): ResumeHold | undefined {
  if (f.credential === null) return undefined;
  const c = cfg.credentials.find((x) => x.id === f.credential);
  if (c === undefined) return { text: `credential ${f.credential} is not configured — the run comes back only on it (or move it: bun wb config move-credential)`, code: "credential-off" };
  if (!c.enabled) return { text: `credential ${f.credential} is disabled — the run comes back only on it (or move it: bun wb config move-credential)`, code: "credential-off" };
  const h = gate.holdReasonOf(c.id, f.episode, f.model);
  return h === undefined ? undefined : { text: h.text, code: h.code };
}

/** A spawn the budget changed, and why. */
export interface GatedSpawn {
  name: string;
  why: string;
  /** True for a running job drained to its episode boundary; false for a start held. */
  drained: boolean;
}

/**
 * The budgets applied to a tick's spawns (after the planners, beside the
 * pause switch): an enabled spawn with an entry whose credential is held for
 * that entry's class does not start, and a RUNNING one is drained to its
 * episode boundary — its live episode finishes untouched, the next does not
 * launch — unless it is a freeplay job, which its own driver pauses at the
 * turn boundary (`subscription-budget`). Pure; the supervisor logs `gated`
 * once per change.
 */
export function gateSpawns(
  spawns: JobSpawn[],
  gate: CredentialGate | undefined,
  running: ReadonlySet<string>,
): { spawns: JobSpawn[]; gated: GatedSpawn[] } {
  if (gate === undefined) return { spawns, gated: [] };
  const gated: GatedSpawn[] = [];
  const out = spawns.map((s) => {
    if (!s.enabled) return s;
    let why: string | undefined;
    for (const e of s.entries) {
      if (e.placedOn === undefined) continue;
      why = gate.holdOf(e.placedOn.id, e.episode, e.model);
      if (why !== undefined) break;
    }
    if (why === undefined) return s;
    const live = running.has(s.name);
    if (live && s.entries.some((e) => e.episode === "freeplay")) return s;
    gated.push({ name: s.name, why, drained: live });
    return { ...s, enabled: false };
  });
  return { spawns: out, gated };
}

/** The Codex homes the credentials name, by their variables: the directories the rollout sweep walks. */
export function codexHomeEnvsOf(credentials: readonly Credential[]): string[] {
  return [...new Set(credentials.filter((c) => providerById(c.provider)?.holds === "home").map((c) => c.secretEnv))];
}
