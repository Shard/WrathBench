/**
 * One run's fact, as the scheduler reads it: `readRunFact` over a run
 * directory, the record-count scanner it tallies the trajectory with, the
 * verdict off the trajectory's tail, and the walk and cache key over a whole
 * runs tree. Split out of `models.ts` (which re-exports all of it unchanged)
 * so a reader that needs the fact and not the policy — the collector, which
 * stores each run's fact as it tails, and the viewer beside it — does not load
 * the scheduler: the roster, the campaigns, the credential slots.
 *
 * Moved verbatim: `runFactCacheVersion` hashes the source of what it names,
 * and the same text is the same key, so a kept fact stays served.
 */

import { createHash } from "node:crypto";
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import { openRunDb, RUN_DB_JOURNAL_FILE, RUN_DB_WAL_FILE } from "./rundb";
import { bestLevelOf, fanoutLead, fanoutReadings, readRunRow } from "./run-reader";
import { harnessSeries } from "./comparability-tuple";
import { EPISODE_IDS, isEpisodeId, type EpisodeId } from "./episodes";
import { OFFLINE_PAUSE, PARTY_PAUSE, SUBSCRIPTION_PAUSE } from "./lapse";
import { parseSubscriptionUsage, type SubscriptionUsage } from "./subscription-usage";
import { routingSchema, type RoutingSpec } from "./routing";
import { ARCHIVE_DIR } from "./archive-dir";
import { HEARTBEAT_DEAD_MS, HEARTBEAT_FILE, heartbeatAt } from "./heartbeat";
import type { RunFactCache } from "./run-fact-cache";
import { servingSchema, type ServingSpec } from "./serving";
import { num } from "./values";

/** The trajectory record the loop appends for a model turn (archive-dir.ts). */
export const MODEL_RESPONSE_RECORD = "response";
/** The trajectory record a pause writes (`Trajectory.setPause`). */
export const PAUSE_RECORD = "pause";
/** The trajectory record `run.ts --resume` writes: where the run's next segment starts. */
export const RESUME_RECORD = "resume";

/**
 * Pause reasons that ride no backoff ladder: the fleet stopped under the run
 * (`operator-pause`), its runner died before it could write a verdict
 * (`offline`, derived and never on disk), or a credential's usage budget
 * stopped a freeplay run at the freeplay threshold (`subscription-budget`,
 * operator 2026-10-16), or a party member was paused because another member
 * paused first (`party-paused`, whose party waits on that member's own
 * pause). All four are the harness's own doing, so the pause
 * streak neither counts them nor resets on them; `resumeNotBefore` brings the
 * first two and the fourth back without cooling and the third at its window's reset, under
 * the lane gate. Every other pause — a provider's refusal, a dead login, a CLI
 * failing on its host, a stalled observation — is on the ladder.
 */
export const LADDER_EXEMPT_PAUSES: ReadonlySet<string> = new Set(["operator-pause", OFFLINE_PAUSE, SUBSCRIPTION_PAUSE, PARTY_PAUSE]);

/** Whether a pause of this reason cools on the backoff ladder and counts toward its streak. */
export function onPauseLadder(reason: unknown): boolean {
  return typeof reason === "string" && !LADDER_EXEMPT_PAUSES.has(reason);
}

/**
 * Whether a pause record counts toward the streak: its reason is on the
 * ladder and its provider did not state a reset. A pause that carries the
 * provider's `notBefore` waits for that instant once, off the ladder
 * (`resumeNotBefore`), so it neither counts nor resets the streak — without
 * that, a daily allowance spent at noon ran the whole ladder out on refusals
 * the provider had already announced, hours before the reset. Only records
 * the runner writes with a numeric `notBefore` are exempt: an older pause
 * whose reset sits in its detail text is read exactly as it always was.
 */
export function pauseCountsOnLadder(rec: { reason?: unknown; notBefore?: unknown }): boolean {
  return onPauseLadder(rec.reason) && typeof rec.notBefore !== "number";
}

/** One run, reduced to what the policy asks of it. */
export interface RunFact {
  runId: string;
  /**
   * Set when the verdict came from the trajectory's `termination` record
   * because the row has none: the runner recorded its end and could not
   * write the row (`Trajectory.setTermination`). The supervisor writes it
   * into the row (`repairRecordedTerminations`); absent on every other run.
   */
  recordedTermination?: { reason: string; detail: string | null; at: number };
  model: string;
  effort: string | null;
  /**
   * The CLI compaction window the run was stamped with. Absent or null
   * is the CLI's own `auto` — every run that set none, and every run written
   * before the field existed.
   */
  compactWindow?: string | null;
  episode: EpisodeId;
  episodeOverride: boolean;
  harnessVersion: string | null;
  /** `harnessSeries(harnessVersion)`; what the schedule keys on. */
  harnessSeries: string | null;
  /**
   * The agent loop and its `yield`, as the comparability tuple stamped them:
   * absent is the snippet loop with no `yield`, which every run stamped
   * before the keys existed is. A target counts only the runs on the loop
   * its entry now launches (`countsTowardTarget`).
   */
  loop?: "program";
  yield?: true;
  /** The routing the run stamped (`comparability.routing`); absent when it stated none. */
  routing?: RoutingSpec;
  /** False when the run had no reference wiki (`comparability.wiki`); absent when it had it. */
  wiki?: false;
  /**
   * The local build the run stated (`comparability.serving`), or null when it
   * stated none. Always set by `readRunFact`, so a roster entry's own build
   * (or its lack of one) decides whether the run is its (`entryOwnsRun`).
   */
  serving?: ServingSpec | null;
  /** An extra run: an attempt the policy made past the target, never counted. */
  extra: boolean;
  startedAt: number;
  /** `ended_at` from run.sqlite, else the trajectory's mtime. */
  endedAt: number | null;
  terminationReason: string | null;
  /** `response` records in trajectory.jsonl; null when the file is unreadable. */
  modelResponses: number | null;
  /** Highest `state.level` observed, or null when there are no rows. */
  bestLevel: number | null;
  /**
   * No termination row, not paused, and a sign of a live owner: a trajectory
   * that grew recently, or a fresh heartbeat (a run waiting on a slow request
   * writes nothing to its trajectory but keeps beating).
   */
  live: boolean;
  /**
   * When the run's owner last beat (`heartbeat` in the run directory), or null
   * when there is no such file: the owner exited cleanly and removed it, or the
   * run was written by a runner that predates the heartbeat.
   */
  heartbeatAt?: number | null;
  /** The run's idle watchdog (`watchdogs.idleMs`), null when disabled or unrecorded. */
  idleMs?: number | null;
  /**
   * Read from `archive/` (`readRunFacts` with `includeArchived`). The scheduler
   * reads such a run for the ladder and for attempt numbers and for nothing
   * else: it is not under the runs directory any more, so nothing can resume it.
   */
  archived?: boolean;
  /**
   * Set while the run is paused: `pause_reason` in run.sqlite with
   * no termination. `at` is meta.json's pause mark when present, else the
   * trajectory's mtime; `count` is the pause streak — the consecutive ladder
   * pauses since the last segment that made a turn, at least 1 — which is what
   * the resume cadence indexes; `episodeElapsedMs` is the clock the run will
   * continue from (null for a pause written before the mark existed).
   */
  pause: {
    reason: string;
    at: number;
    count: number;
    episodeElapsedMs: number | null;
    /**
     * Not resumable before this instant. On the supervisor's derived `offline`
     * pause, when the run is provably ownerless; on any other, the provider's
     * stated reset off the pause mark (adapter.ts), which the resume waits
     * for once and the streak does not count (`pauseCountsOnLadder`).
     */
    notBefore?: number;
  } | null;
  /** The game account the run was launched on; a resume must go back to it. */
  account: string | null;
  /**
   * The character the run actually played (the model names it, and
   * `run.ts` rewrites the config's suggestion at the first sight of it). What
   * account affinity keys on: a fresh attempt prefers the account this
   * character is still standing on, so the name does not collide elsewhere.
   */
  character: string | null;
  /** The run's wall-clock budget (`watchdogs.episodeMs`), null when disabled. */
  episodeMs: number | null;
  /**
   * The probe campaign and cell this run was commissioned by, or
   * null on anything that is not a campaign run. Read straight off the run's own
   * config, which is why a campaign's progress survives an edit to the file —
   * and why a completed campaign's results outlive the deletion of its entry.
   */
  campaign: string | null;
  cell: string | null;
  /**
   * The campaign definition version the run stamped, the roster name the
   * fleet launched it as, and the campaign arm it ran — absent on a run from
   * before each was recorded, which then belongs to no campaign square
   * (`probeRunsOf` reads stamps only). Optional so a fact built by hand need
   * not spell them.
   */
  campaignVersion?: number | null;
  ref?: string | null;
  arm?: string | null;
  /**
   * The party this run is a member of (`config.party`): its id — the attempt's
   * run-id stem, shared by every member — which member, and the size. Null on
   * every run that is not a party member; optional so a fact built by hand
   * need not spell it. A party is one attempt, so a campaign square tallies
   * parties by this id (`campaignSquares`) and the resume planner brings a
   * paused party back whole.
   */
  party?: { id: string; member: string; size: number } | null;
  /**
   * Every account a fan-out run holds (`config.fanout.accounts`): one agent
   * driving several characters, each on an account of its own, the first of
   * which is also `account`. Null on every other run; optional so a fact
   * built by hand need not spell it. What the fleet holds for the run's whole
   * life, live or paused (`accountsOfRun`).
   */
  fanoutAccounts?: string[] | null;
  /**
   * The world the run played on (`config.world`): a world per eval's id, or
   * `shared`. Null on a run written before worlds, which played on the shared
   * world; optional so a fact built by hand need not spell it. A label, never
   * a key: nothing groups or counts by it.
   */
  world?: string | null;
  /**
   * The credential this run took a slot on (`RunConfig.credential`), or null
   * on a run that recorded none (a 0.5 run, one launched by hand without
   * `--credential`). Read off the
   * run's own config for the same reason `campaign` is: the fleet counts live
   * runs per credential, and that count has to survive a supervisor restart,
   * which nothing held in memory does.
   */
  credential: string | null;
  /** The run's driver (`config.driver`), or null when meta.json names none. Optional so a fact built by hand need not spell it. */
  driver?: string | null;
  /**
   * The newest subscription usage reading the run recorded (meta.json's
   * `subscriptionUsage`), or null. What a credential's `usage` budget reads,
   * newest per credential (operator, 2026-10-16).
   */
  credentialUsage?: SubscriptionUsage | null;
  /**
   * When a response on this run was last billed to the provider's balance
   * past the allowance (meta.json's `credentialOverage`, OpenCode Go's
   * `billing_source: "balance"`), or null. The fleet holds its credential
   * until a usage read shows room after it (`FleetGoUsage.noteOverages`).
   */
  credentialOverageAt?: number | null;
  /**
   * The provider's own reported charge on this run's responses, in dollars,
   * per UTC day (`YYYY-MM-DD`) the response was recorded on: what a `spend`
   * budget sums. Absent on a fact built by hand; empty on a run whose
   * provider reports no charge.
   */
  spendByDay?: Record<string, number>;
  /**
   * The segments `run.ts --resume` started, per UTC day of their `resume`
   * record: with a start on that day, what a `runs` budget counts. Absent on a
   * fact built by hand.
   */
  resumesByDay?: Record<string, number>;
}

// ----------------------------------------------------------- reading runs

/**
 * A trajectory touched more recently than this belongs to a live process. A
 * run counts as live when it has not terminated and its trajectory grew
 * recently. "No termination reason" alone is not enough — a killed process
 * leaves none — and a stale mtime is the only signal we have from outside the
 * container. The one definition: the run listing (`run-list.ts`) re-exports it.
 */
export const LIVE_WINDOW_MS = 120_000;

const RUN_ID = /^[A-Za-z0-9._-]+$/;

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

/** Count `response` records in a trajectory without holding the file in memory. */
export function countModelResponses(path: string): number | null {
  return countRecords(path, [MODEL_RESPONSE_RECORD])?.get(MODEL_RESPONSE_RECORD) ?? null;
}

const NEWLINE = 0x0a;
const EMPTY = Buffer.alloc(0);
/** How much of a trajectory is held in memory at once while counting. */
const READ_CHUNK = 1 << 22;

/**
 * Where a pause streak stands partway through a trajectory. A segment is the
 * stretch between two `resume` records (the first starts at byte zero):
 * `closed` is the streak as the segments already closed left it, and `turn`
 * and `pause` are what the open one has shown so far.
 */
interface StreakFold {
  closed: number;
  turn: boolean;
  pause: boolean;
}

/**
 * The pause streak with the open segment as the newest: the ladder pauses
 * since the last segment that made a turn, that segment's own pause included.
 * A segment with a `response` in it resets the count — its pause, when it is
 * on the ladder, is the first of a new streak — and one with none adds its
 * pause to the streak before it. An exempt pause (`pauseCountsOnLadder`) adds
 * nothing and resets nothing. A segment's turns count wherever they fall in
 * it: a runner stopped mid-turn flushes its last `response` after the pause
 * record.
 */
function streakOf(s: StreakFold): number {
  const own = s.pause ? 1 : 0;
  return s.turn ? own : s.closed + own;
}

/** A record a scanner watches, as far as the counts, the streak and the spend read it. */
type WatchedRecord = { t: string; reason?: unknown; notBefore?: unknown; kind?: unknown; ts?: unknown; cost?: unknown };

/** The UTC day (`YYYY-MM-DD`) an instant falls on: what a credential's per-day budget counts in. */
export function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function foldStreak(s: StreakFold, rec: WatchedRecord): void {
  if (rec.t === MODEL_RESPONSE_RECORD) s.turn = true;
  else if (rec.t === PAUSE_RECORD) s.pause ||= pauseCountsOnLadder(rec);
  else if (rec.t === RESUME_RECORD) {
    s.closed = streakOf(s);
    s.turn = false;
    s.pause = false;
  }
}

/** `readSync` in its positional form: fill `buffer` from `position` on, answering the bytes read. */
export type ReadAt = (fd: number, buffer: Buffer, offset: number, length: number, position: number) => number;

/**
 * How a scanner reads its file. Both default to what production uses; they
 * exist so a test can make a few-kilobyte file span hundreds of reads, or make
 * a read fail, instead of writing gigabytes to reach either.
 */
export interface ScanReads {
  /** Bytes per read (`READ_CHUNK`). */
  chunk?: number;
  /** The read itself (`readSync`). */
  read?: ReadAt;
}

/** What one pass over a trajectory answers. */
export interface RecordTally {
  /** Records of each kind asked for; a kind nothing carries is zero, never absent. */
  counts: Map<string, number>;
  /** The pause streak (`streakOf`), or null when the scanner was not asked to fold it. */
  pauseStreak: number | null;
  /**
   * The provider's own reported charge (`usage.cost` on a `response`) per UTC
   * day of the record, when `response` is among the kinds counted: what a
   * credential's `spend` budget sums. Empty when no response carried one.
   */
  spendByDay: Record<string, number>;
  /**
   * `resume` records per UTC day, when the scanner folds the pause streak
   * (the only time it reads them): each is a segment a resume started. Empty
   * otherwise.
   */
  resumesByDay: Record<string, number>;
}

/** The per-day sums a scanner keeps beside its counts: spend and resumes. */
interface DayTally {
  spend: Record<string, number>;
  resumes: Record<string, number>;
}

/**
 * Record counts for a trajectory without holding the file in memory, resumably.
 *
 * A count is monotone, so folding only the bytes appended since the last pass
 * gives the same answer as re-reading the file whole. That is the whole reason
 * this is an object: `readRunFact` is memoised on (size, mtime), which hits for
 * every finished run and structurally MISSES for a live one, whose trajectory
 * grows every second. The live runs reach hundreds of megabytes and
 * `/api/models` and `/api/fleet` are polled every five seconds, so re-reading
 * from byte zero on each poll blocked the viewer's event loop for one to three
 * seconds at a time (measured: 844ms and 895ms for the two live trajectories on
 * 2026-09-04, against ~0ms for everything else `readRunFact` does).
 *
 * The pause streak, when asked for, is the same kind of fold: a left fold over
 * the records in order (`foldStreak`), so resuming it from where the last pass
 * stopped gives the same answer too.
 *
 * A trailing half-written line is held in `pending` and re-read with the next
 * chunk rather than counted, so nothing is counted twice across a resume. A
 * file that SHRANK is not resumable at all — that is truncation or replacement
 * — and the check for it belongs to whoever holds the scanner
 * (`tallyRecordsCached`), which throws the scanner away and starts fresh.
 *
 * `countRecords` below is the one-shot form, with the contract it always had.
 *
 * Reading is `readSync` over a fixed buffer rather than the whole-file string
 * `readFileSync` built: the same discipline `RunTotalsScanner` follows in
 * `runner/src/run-totals.ts`, but not the same code — that one reads
 * asynchronously through `Bun.file`, and this path is sync all the way up
 * through the fleet supervisor. Splitting happens on bytes, which is safe
 * because 0x0A cannot occur inside a UTF-8 multi-byte sequence. The bytes are
 * searched for the prefilter's needles rather than walked one at a time, and
 * only the lines a needle falls in are cut out (`foldLines`): the same lines,
 * in the same order, as taking every line and dropping the ones without one.
 *
 * `from` starts the count at a byte other than zero, and nothing before it is
 * read: the roster counts one attempt's turns as the records past the size the
 * trajectory had when that attempt launched (`turnsSince`). Such a scanner is
 * one-shot. It never goes into a `CountCache`, whose reuse check knows nothing
 * of a starting byte and would answer its partial counts as the whole file's.
 */
export class RecordCountScanner {
  readonly path: string;
  readonly kinds: readonly string[];
  /** Whether this scanner folds the pause streak as well as counting. */
  readonly pauseStreak: boolean;
  /** The records worth parsing: the kinds counted, and the ones the streak reads. */
  private readonly watched: ReadonlySet<string>;
  /** The prefilter, as bytes: the record names are ASCII, so this is the same test. */
  private readonly needles: Buffer[];
  private readonly counts: Map<string, number>;
  private readonly streak: StreakFold = { closed: 0, turn: false, pause: false };
  private readonly days: DayTally = { spend: {}, resumes: {} };
  /** Bytes folded as complete lines; where the next scan resumes. */
  private consumed = 0;
  /** Bytes after the last newline: a record still being written, never counted. */
  private pending: Buffer = EMPTY;
  private readonly chunk: number;
  private readonly read: ReadAt;
  /** Why the last scan answered null. */
  private failed: unknown = undefined;

  constructor(
    path: string,
    kinds: readonly string[],
    opts: { pauseStreak?: boolean; from?: number } & ScanReads = {},
  ) {
    this.path = path;
    this.kinds = [...kinds];
    this.pauseStreak = opts.pauseStreak === true;
    this.watched = new Set([...this.kinds, ...(this.pauseStreak ? [MODEL_RESPONSE_RECORD, PAUSE_RECORD, RESUME_RECORD] : [])]);
    this.needles = [...this.watched].map((k) => Buffer.from(`"${k}"`, "utf8"));
    this.counts = new Map<string, number>(this.kinds.map((k) => [k, 0]));
    this.consumed = opts.from ?? 0;
    this.chunk = opts.chunk ?? READ_CHUNK;
    this.read = opts.read ?? readSync;
  }

  /** How far this scanner has read, complete lines and the partial one. */
  get size(): number {
    return this.consumed + this.pending.length;
  }

  /** Why the last scan answered null (the stat's or the read's error), for a caller that logs it; undefined after one that answered. */
  get failure(): unknown {
    return this.failed;
  }

  /** The record a line holds when it is one this scanner watches, else null. */
  private recordOf(line: Buffer): WatchedRecord | null {
    if (line.length === 0) return null;
    // Cheap prefilter, then the honest parse: the `t` key can sit anywhere.
    if (!this.needles.some((n) => line.includes(n))) return null;
    return this.parsed(line);
  }

  /** The parse alone, for a line already known to carry a needle. */
  private parsed(line: Buffer): WatchedRecord | null {
    let rec: { t?: unknown; reason?: unknown; notBefore?: unknown; kind?: unknown; ts?: unknown; usage?: { cost?: unknown } } | null;
    try {
      rec = JSON.parse(line.toString("utf8")) as typeof rec;
    } catch {
      return null; // a torn line is not a record
    }
    const t = rec?.t;
    return typeof t === "string" && this.watched.has(t)
      ? { t, reason: rec!.reason, notBefore: rec!.notBefore, kind: rec!.kind, ts: rec!.ts, cost: rec!.usage?.cost }
      : null;
  }

  /** One line into a set of counts and a streak: the scanner's own, or a copy of them. */
  private apply(line: Buffer, counts: Map<string, number>, streak: StreakFold, days: DayTally = this.days): void {
    this.applyRecord(this.recordOf(line), counts, streak, days);
  }

  private applyRecord(rec: WatchedRecord | null, counts: Map<string, number>, streak: StreakFold, days: DayTally = this.days): void {
    if (rec === null) return;
    // Billed usage, a CLI's compaction call included: whatever the provider charged.
    if (rec.t === MODEL_RESPONSE_RECORD && counts.has(MODEL_RESPONSE_RECORD) && typeof rec.cost === "number" && Number.isFinite(rec.cost) && rec.cost > 0 && typeof rec.ts === "number") {
      const day = utcDay(rec.ts);
      days.spend[day] = (days.spend[day] ?? 0) + rec.cost;
    }
    // A segment a resume started: a `runs` budget counts it as a launch.
    if (rec.t === RESUME_RECORD && typeof rec.ts === "number" && Number.isFinite(rec.ts)) {
      const day = utcDay(rec.ts);
      days.resumes[day] = (days.resumes[day] ?? 0) + 1;
    }
    // A CLI's own summarisation call (pi's compaction, a `response` of kind
    // `compaction`) is billed usage, not a reply of the model's: it neither
    // counts as one nor ends a pause streak.
    if (rec.t === MODEL_RESPONSE_RECORD && rec.kind === "compaction") return;
    // Pre-seeded with exactly the kinds asked for, so a line counts toward at most one.
    const n = counts.get(rec.t);
    if (n !== undefined) counts.set(rec.t, n + 1);
    if (this.pauseStreak) foldStreak(streak, rec);
  }

  private take(line: Buffer): void {
    this.apply(line, this.counts, this.streak);
  }

  /**
   * Fold the complete lines of `buf` from `from` (a line start) through `end`
   * (the index of its last newline). Only the lines that carry a needle are
   * cut out and parsed: every other line is one `recordOf` drops unparsed
   * (empty, or no needle in it), so not cutting it out is the same answer.
   * Each needle is found by a native search that passes over any byte at most
   * once, and the lines are taken in file order, which the streak fold
   * depends on. A byte loop over every line cost ~36 s for the cluster's
   * ~15 GB of trajectories.
   */
  private foldLines(buf: Buffer, from: number, end: number): void {
    const needles = this.needles;
    const next = needles.map((n) => buf.indexOf(n, from));
    for (;;) {
      let at = -1;
      for (const p of next) if (p !== -1 && (at === -1 || p < at)) at = p;
      // A needle holds no newline, so one that starts past `end` is in the partial tail.
      if (at === -1 || at > end) break;
      const start = buf.lastIndexOf(NEWLINE, at) + 1;
      const stop = buf.indexOf(NEWLINE, at);
      this.applyRecord(this.parsed(buf.subarray(start, stop)), this.counts, this.streak);
      // The line is taken once, whatever else it carries: search on from the next one.
      for (let k = 0; k < next.length; k++) if (next[k] !== -1 && next[k]! <= stop) next[k] = buf.indexOf(needles[k]!, stop + 1);
    }
    this.consumed += end + 1 - from;
  }

  /**
   * Read whatever has been appended since the last call and answer the tally
   * so far. Null when the file cannot be read — the contract `countRecords`
   * has always had — with whatever was already folded left intact, so a later
   * call resumes rather than starting over.
   */
  scan(): RecordTally | null {
    this.failed = undefined;
    let size: number;
    try {
      size = statSync(this.path).size;
    } catch (e) {
      this.failed = e;
      return null;
    }
    if (size <= this.size) return this.snapshot();
    let fd: number | null = null;
    try {
      fd = openSync(this.path, "r");
      const chunk = Buffer.allocUnsafe(this.chunk);
      // The partial line, as the reads delivered it: joined once, when its
      // newline arrives, not re-joined and re-walked on every read it spans.
      const carry: Buffer[] = this.pending.length === 0 ? [] : [this.pending];
      let carried = this.pending.length;
      this.pending = EMPTY;
      let pos = this.consumed + carried;
      while (pos < size) {
        const n = this.read(fd, chunk, 0, Math.min(this.chunk, size - pos), pos);
        if (n <= 0) break;
        pos += n;
        const fresh = chunk.subarray(0, n);
        const first = fresh.indexOf(NEWLINE);
        // The read buffer is reused, so anything held past this iteration is copied.
        if (first === -1) {
          carry.push(Buffer.from(fresh));
          carried += n;
          continue;
        }
        let from = 0;
        if (carried > 0) {
          const line = Buffer.concat([...carry, fresh.subarray(0, first)]);
          this.take(line);
          this.consumed += line.length + 1; // the newline
          carry.length = 0;
          carried = 0;
          from = first + 1;
        }
        const last = fresh.lastIndexOf(NEWLINE);
        if (last >= from) this.foldLines(fresh, from, last);
        if (last + 1 < n) {
          carry.push(Buffer.from(fresh.subarray(last + 1)));
          carried = n - last - 1;
        }
      }
      this.pending = carried === 0 ? EMPTY : carry.length === 1 ? carry[0]! : Buffer.concat(carry);
    } catch (e) {
      this.failed = e;
      return null;
    } finally {
      if (fd !== null) {
        try {
          closeSync(fd);
        } catch {
          /* a file that will not close still counted */
        }
      }
    }
    return this.snapshot();
  }

  /**
   * Fold the trailing bytes that carry no newline as a line of their own, then
   * answer. Only the one-shot form does this: a file whose last record was
   * written without a terminating newline still has that record counted,
   * exactly as the whole-file read always did. A resumable scanner must not
   * fold them, because the next append would count those bytes twice;
   * `scanAsWhole` gives the same answer without folding.
   */
  countOnce(): RecordTally | null {
    const tally = this.scan();
    if (tally === null) return null;
    if (this.pending.length > 0) {
      this.take(this.pending);
      this.consumed += this.pending.length;
      this.pending = EMPTY;
    }
    return this.snapshot();
  }

  /**
   * `scan`, answered the way `countOnce` answers: trailing bytes with no
   * newline that already parse as a whole record count, as a whole-file read
   * counts them. Only the answer includes them — they stay pending, so the
   * scanner still resumes from the same byte and the newline that completes
   * them later does not count them twice. A torn tail does not parse and
   * counts nowhere, exactly as before.
   */
  scanAsWhole(): RecordTally | null {
    const tally = this.scan();
    if (tally === null || this.pending.length === 0) return tally;
    const streak = { ...this.streak };
    const days: DayTally = { spend: { ...tally.spendByDay }, resumes: { ...tally.resumesByDay } };
    this.apply(this.pending, tally.counts, streak, days);
    return { counts: tally.counts, pauseStreak: this.pauseStreak ? streakOf(streak) : null, spendByDay: days.spend, resumesByDay: days.resumes };
  }

  /** A copy: the caller must never hold a reference to resumable state. */
  private snapshot(): RecordTally {
    return {
      counts: new Map(this.counts),
      pauseStreak: this.pauseStreak ? streakOf(this.streak) : null,
      spendByDay: { ...this.days.spend },
      resumesByDay: { ...this.days.resumes },
    };
  }
}

/** One pass over a trajectory, counting the records of each kind named. Null when unreadable. */
export function countRecords(path: string, kinds: readonly string[]): Map<string, number> | null {
  return tallyRecords(path, kinds)?.counts ?? null;
}

/** `countRecords`, answering the pause streak as well when asked for it. */
export function tallyRecords(path: string, kinds: readonly string[], opts: { pauseStreak?: boolean } = {}): RecordTally | null {
  if (!existsSync(path)) return null;
  return new RecordCountScanner(path, kinds, opts).countOnce();
}

/** A kept scanner, and the file it was built on: the inode and device it read. */
export interface CountEntry {
  scanner: RecordCountScanner;
  ino: number;
  dev: number;
}

/** Scanners a caller keeps between polls, keyed by trajectory path. */
export type CountCache = Map<string, CountEntry>;

/** The resumable form of `countRecords` (`tallyRecordsCached`). */
export function countRecordsCached(cache: CountCache, path: string, kinds: readonly string[]): Map<string, number> | null {
  return tallyRecordsCached(cache, path, kinds)?.counts ?? null;
}

/**
 * The resumable form: the same tally, folding only what has been appended
 * since this cache last saw the file.
 *
 * The truncation check lives here rather than inside `scan`, because a scanner
 * that has read past the end of its own file cannot answer for it at all: the
 * only safe response is a new scanner, and only the holder of the cache can
 * make one. Same for a file that is not the one the scanner read — rotated,
 * or replaced by a rename at any size, which a size check alone would fold on
 * from the old file's offset — so the entry carries the inode and device it
 * was built on. Same for a caller that changes what it asks for: the counts a
 * scanner carries are the counts of the kinds it was built with, and it folds
 * a streak only if it was built to.
 *
 * The file is checked before it is read, not after. A replacement landing
 * between that stat and the scanner's own open is one poll's answer; every
 * caller polls again, and the replaced file's size or mtime has moved, so its
 * next read starts fresh here. The supervisor re-reads every tick; the
 * collector re-derives whenever a trajectory's (size, mtime) moves.
 */
export function tallyRecordsCached(
  cache: CountCache,
  path: string,
  kinds: readonly string[],
  opts: { pauseStreak?: boolean } = {},
): RecordTally | null {
  let st: { size: number; ino: number; dev: number };
  try {
    st = statSync(path);
  } catch {
    cache.delete(path);
    return null;
  }
  let entry = cache.get(path);
  const usable =
    entry !== undefined &&
    entry.ino === st.ino &&
    entry.dev === st.dev &&
    st.size >= entry.scanner.size &&
    entry.scanner.pauseStreak === (opts.pauseStreak === true) &&
    entry.scanner.kinds.length === kinds.length &&
    entry.scanner.kinds.every((k, i) => k === kinds[i]);
  if (!usable) {
    entry = { scanner: new RecordCountScanner(path, kinds, opts), ino: st.ino, dev: st.dev };
    cache.set(path, entry);
  }
  // `scanAsWhole`, not `scan`: the cache is an optimisation, never a different
  // answer, and a whole-file read counts a final record with no newline.
  return entry!.scanner.scanAsWhole();
}

/**
 * Read one run directory into a fact, or null when it is not a stamped run.
 * Tolerant everywhere: a run mid-write or an unreadable database degrades to
 * "no data", never to an exception that costs the whole projection.
 */
/** `config.party` as a fact reads it: id, member and size, or null when the run is no party member. */
/** A fan-out run's accounts, off its config's grant; null when it has none. */
function fanoutAccountsOfConfig(f: { accounts?: unknown } | undefined): string[] | null {
  if (f === undefined || f === null || typeof f !== "object" || !Array.isArray(f.accounts)) return null;
  const accounts = f.accounts.filter((a): a is string => typeof a === "string" && a.length > 0);
  return accounts.length > 0 ? accounts : null;
}

/**
 * Every account a run holds: a fan-out run's whole grant, else the one it was
 * launched on, else none. The one answer the fleet asks of a run whenever an
 * account's holder matters.
 */
export function accountsOfRun(f: Pick<RunFact, "account" | "fanoutAccounts">): string[] {
  if (f.fanoutAccounts != null && f.fanoutAccounts.length > 0) return [...f.fanoutAccounts];
  return f.account === null ? [] : [f.account];
}

function partyOfConfig(p: { id?: unknown; member?: unknown; size?: unknown } | undefined): RunFact["party"] {
  if (p === undefined || p === null || typeof p !== "object") return null;
  const id = str(p.id);
  const member = str(p.member);
  const size = num(p.size);
  return id === null || member === null || size === null ? null : { id, member, size };
}

export function readRunFact(
  runsDir: string,
  runId: string,
  now = Date.now(),
  opts: { counts?: CountCache } = {},
): RunFact | null {
  const r = readRunReading(runsDir, runId, now, { ...opts, stampedOnly: true });
  return r !== null && isStamped(r) ? r : null;
}

/**
 * A run with no episode stamp: one launched by hand without `--episode`
 * (docs/RUNBOOK.md, "Ad-hoc launches", "A fan-out run, by hand"). Read the way
 * a fact is, and never one: no projection, ladder, target, attempt number or
 * public row reads it, so it is never a scored run, an owed one or a strike.
 * What reads it is what it costs the fleet while it runs — the credential it
 * bills (its slot, its runs and spend today, its usage readings) — through
 * `readFleetRuns`. Its `bestLevel` is not read and is null.
 */
export type UnstampedRun = Omit<RunFact, "episode"> & { episode: null };

/** A run directory as `readRunReading` reads it: a fact, or a run with no episode. */
export type RunReading = RunFact | UnstampedRun;

function isStamped(r: RunReading): r is RunFact {
  return r.episode !== null;
}

/**
 * `readRunFact`, and the same reading of a run with no episode stamp
 * (`UnstampedRun`). `stampedOnly` stops at the stamp, as `readRunFact` always
 * has, for a reader that has no use for the rest.
 */
function readRunReading(
  runsDir: string,
  runId: string,
  now: number,
  opts: { counts?: CountCache; stampedOnly?: boolean },
): RunReading | null {
  const dir = join(runsDir, runId);
  const metaPath = join(dir, "meta.json");
  if (!existsSync(metaPath)) return null;
  let meta: {
    harnessVersion?: unknown;
    startedAt?: unknown;
    config?: {
      model?: unknown;
      effort?: unknown;
      compactWindow?: unknown;
      extra?: unknown;
      account?: unknown;
      character?: unknown;
      campaign?: unknown;
      cell?: unknown;
      campaignVersion?: unknown;
      ref?: unknown;
      arm?: unknown;
      party?: { id?: unknown; member?: unknown; size?: unknown };
      fanout?: { accounts?: unknown };
      credential?: unknown;
      driver?: unknown;
      world?: unknown;
      watchdogs?: { episodeMs?: unknown; idleMs?: unknown };
    };
    comparability?: { episode?: unknown; episodeOverride?: unknown; effort?: unknown; compactWindow?: unknown; loop?: unknown; yield?: unknown; serving?: unknown; routing?: unknown; wiki?: unknown };
    pause?: { reason?: unknown; at?: unknown; episodeElapsedMs?: unknown; notBefore?: unknown };
    subscriptionUsage?: unknown;
    credentialOverage?: { at?: unknown };
  };
  try {
    meta = JSON.parse(readFileSync(metaPath, "utf8")) as typeof meta;
  } catch {
    return null;
  }
  const stamp = meta.comparability?.episode;
  // No stamp at all is a hand launch; a stamp this reader does not know is not
  // a run it can read.
  const episode = isEpisodeId(stamp) ? stamp : stamp === null || stamp === undefined ? null : undefined;
  if (episode === undefined || (episode === null && opts.stampedOnly === true)) return null;
  const model = str(meta.config?.model);
  if (model === null) return null;
  const compactWindow = str(meta.comparability?.compactWindow) ?? str(meta.config?.compactWindow);

  const fact: RunReading = {
    runId,
    model,
    effort: str(meta.comparability?.effort) ?? str(meta.config?.effort),
    // Only when set: absent is `auto`, and every older fact reads the same.
    ...(compactWindow !== null ? { compactWindow } : {}),
    episode,
    episodeOverride: meta.comparability?.episodeOverride === true,
    harnessVersion: str(meta.harnessVersion),
    harnessSeries: harnessSeries(str(meta.harnessVersion)),
    // Only when stamped: absent is the snippet loop, and every older fact reads the same.
    ...(meta.comparability?.loop === "program" ? { loop: "program" as const } : {}),
    ...(meta.comparability?.yield === true ? { yield: true as const } : {}),
    serving: servingOfMeta(meta.comparability?.serving),
    // The rest of the condition a target compares (`countsTowardTarget`): only when stamped.
    ...(routingOfMeta(meta.comparability?.routing) !== null ? { routing: routingOfMeta(meta.comparability?.routing)! } : {}),
    ...(meta.comparability?.wiki === false ? { wiki: false as const } : {}),
    extra: meta.config?.extra === true,
    startedAt: num(meta.startedAt) ?? 0,
    endedAt: null,
    terminationReason: null,
    modelResponses: null,
    bestLevel: null,
    live: false,
    pause: null,
    account: str(meta.config?.account),
    character: str(meta.config?.character),
    episodeMs: num(meta.config?.watchdogs?.episodeMs),
    idleMs: num(meta.config?.watchdogs?.idleMs),
    heartbeatAt: heartbeatAt(dir),
    campaign: str(meta.config?.campaign),
    cell: str(meta.config?.cell),
    campaignVersion: num(meta.config?.campaignVersion),
    ref: str(meta.config?.ref),
    arm: str(meta.config?.arm),
    party: partyOfConfig(meta.config?.party),
    fanoutAccounts: fanoutAccountsOfConfig(meta.config?.fanout),
    credential: str(meta.config?.credential),
    driver: str(meta.config?.driver),
    world: str(meta.config?.world),
    credentialUsage: parseSubscriptionUsage(meta.subscriptionUsage) ?? null,
    credentialOverageAt: num(meta.credentialOverage?.at),
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
  const kinds = [MODEL_RESPONSE_RECORD];
  // A caller that polls the same live run passes a scanner cache, which folds
  // only the bytes appended since its last read; everyone else reads once.
  const tally =
    opts.counts === undefined
      ? tallyRecords(jsonl, kinds, { pauseStreak: true })
      : tallyRecordsCached(opts.counts, jsonl, kinds, { pauseStreak: true });
  fact.modelResponses = tally?.counts.get(MODEL_RESPONSE_RECORD) ?? null;
  fact.spendByDay = tally?.spendByDay ?? {};
  fact.resumesByDay = tally?.resumesByDay ?? {};
  let pauseReason: string | null = null;

  // The run row and the best level, wherever the run keeps them (`run-reader.ts`).
  const r = readRunRow(dir, runId);
  if (r !== null) {
    fact.startedAt = num(r["started_at"]) ?? fact.startedAt;
    fact.endedAt = num(r["ended_at"]);
    fact.terminationReason = str(r["termination_reason"]);
    pauseReason = str(r["pause_reason"]);
  }
  // Nothing reads a level off a run with no episode, and it is the costly part of the read.
  fact.bestLevel = fact.episode === null ? null : bestLevelOf(dir, runId);
  const beating = fact.heartbeatAt != null && now - fact.heartbeatAt < HEARTBEAT_DEAD_MS;
  // A verdict the row lacks but the trajectory holds: the runner appends the
  // record before it writes the row, and a row write that gave up (after its
  // retries), or one still queued when the process was killed, leaves the
  // record alone. Without this the run reads as ownerless: a resuming lane
  // brings back a run that recorded its own end, and a scored run that paused
  // reads as unknown and is swept stale. Only for a run with no verdict, no
  // pause and no live owner, and only the file's tail: the record is among the
  // last few a run writes. A pause the tail does not show is taken from
  // meta.json's mark, which the pause path writes at once; a `resume` after
  // either means neither stands.
  let pauseFromRecord: TrajectoryVerdict | null = null;
  if (fact.terminationReason === null && pauseReason === null && !beating && mtime !== null) {
    const rec = verdictOfTrajectory(jsonl);
    if (rec?.kind === "terminated") {
      const at = rec.at ?? mtime;
      fact.terminationReason = rec.reason;
      fact.endedAt = at;
      fact.recordedTermination = { reason: rec.reason, detail: rec.detail, at };
    } else if (rec?.kind === "paused") {
      pauseReason = rec.reason;
      pauseFromRecord = rec;
    } else if (rec === null && typeof meta.pause?.reason === "string" && meta.pause.reason !== "") {
      pauseReason = meta.pause.reason;
    }
  }
  if (fact.endedAt === null && fact.terminationReason !== null) fact.endedAt = mtime;
  // A termination wins over a stale pause row (the --resume path clears the
  // row, but a run can also be classified by hand after a pause).
  if (pauseReason !== null && fact.terminationReason === null) {
    const recorded = pauseFromRecord?.kind === "paused" ? pauseFromRecord : null;
    const markedAt = num(meta.pause?.at) ?? recorded?.at ?? null;
    const statedReset = num(meta.pause?.notBefore) ?? recorded?.notBefore ?? null;
    fact.pause = {
      reason: pauseReason,
      at: markedAt ?? mtime ?? fact.startedAt,
      // The streak, not the run's lifetime of pauses: a freeplay run lives
      // forever, and nine pauses spread across weeks of good play are not a
      // provider that has refused for six hours (operator, 2026-09-25).
      count: Math.max(1, tally?.pauseStreak ?? 1),
      episodeElapsedMs: num(meta.pause?.episodeElapsedMs) ?? recorded?.episodeElapsedMs ?? null,
      ...(statedReset !== null ? { notBefore: statedReset } : {}),
    };
  }
  fact.live = fact.terminationReason === null && fact.pause === null && ((mtime !== null && now - mtime < LIVE_WINDOW_MS) || beating);
  if (!fact.live && fact.endedAt === null) fact.endedAt = mtime;
  return fact;
}

/** How much of a trajectory's end `verdictOfTrajectory` reads. */
export const TERMINATION_TAIL_BYTES = 1 << 20;

/** The last verdict a trajectory records: its end, a pause, or a resume that cancels the pause before it. */
export type TrajectoryVerdict =
  | { kind: "terminated"; reason: string; detail: string | null; at: number | null }
  | { kind: "paused"; reason: string; detail: string | null; at: number | null; notBefore: number | null; episodeElapsedMs: number | null }
  | { kind: "resumed" };

/**
 * The run's last `termination`, `pause` or `resume` record, read off the
 * trajectory's tail, or null when the tail holds none. The verdict is
 * appended a handful of records before a runner exits, so the last MiB holds
 * it; a run that wrote more than that after its verdict is not one this
 * recovers.
 */
export function verdictOfTrajectory(path: string, tailBytes = TERMINATION_TAIL_BYTES): TrajectoryVerdict | null {
  let fd: number | null = null;
  try {
    fd = openSync(path, "r");
    const size = statSync(path).size;
    const start = Math.max(0, size - tailBytes);
    const buf = Buffer.alloc(size - start);
    let got = 0;
    while (got < buf.length) {
      const n = readSync(fd, buf, got, buf.length - got, start + got);
      if (n <= 0) break;
      got += n;
    }
    const lines = buf.subarray(0, got).toString("utf8").split("\n");
    // The first line of a tail that starts mid-file is a fragment.
    for (let i = lines.length - 1; i >= (start > 0 ? 1 : 0); i--) {
      const line = lines[i]!;
      if (!line.includes('"termination"') && !line.includes(`"${PAUSE_RECORD}"`) && !line.includes(`"${RESUME_RECORD}"`)) continue;
      let rec: { t?: unknown; reason?: unknown; detail?: unknown; ts?: unknown; notBefore?: unknown; episodeElapsedMs?: unknown };
      try {
        rec = JSON.parse(line) as typeof rec;
      } catch {
        continue;
      }
      if (rec.t === RESUME_RECORD) return { kind: "resumed" };
      if (typeof rec.reason !== "string" || rec.reason === "") continue;
      const detail = typeof rec.detail === "string" ? rec.detail : null;
      const at = typeof rec.ts === "number" ? rec.ts : null;
      if (rec.t === "termination") return { kind: "terminated", reason: rec.reason, detail, at };
      if (rec.t === PAUSE_RECORD) {
        return {
          kind: "paused",
          reason: rec.reason,
          detail,
          at,
          notBefore: typeof rec.notBefore === "number" ? rec.notBefore : null,
          episodeElapsedMs: typeof rec.episodeElapsedMs === "number" ? rec.episodeElapsedMs : null,
        };
      }
    }
    return null;
  } catch {
    return null;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

/** The run's last `termination` record off the trajectory's tail, or null when the tail ends otherwise (`verdictOfTrajectory`). */
export function terminationOfTrajectory(path: string, tailBytes = TERMINATION_TAIL_BYTES): { reason: string; detail: string | null; at: number | null } | null {
  const v = verdictOfTrajectory(path, tailBytes);
  return v?.kind === "terminated" ? { reason: v.reason, detail: v.detail, at: v.at } : null;
}

/** Bump when what `readRunFact` answers, or what `runFactKey` keys on, changes in a way their source text would not show. */
const RUN_FACT_CACHE_SCHEMA = 1;
let runFactCacheVersionMemo: string | undefined;

/**
 * The identity of the reader a kept fact came from: the schema number, and the
 * source of `readRunFact` and of everything it calls that decides a
 * terminated run's fact. A fact read by other code is not this code's
 * answer, so a release that changes any of them starts the cache over rather
 * than serving what the old reader said (a level counted another way would
 * be a promotion decided on it).
 */
export function runFactCacheVersion(): string {
  runFactCacheVersionMemo ??= createHash("sha256")
    .update(
      [
        String(RUN_FACT_CACHE_SCHEMA),
        ...[readRunFact, readRunReading, isStamped, partyOfConfig, fanoutAccountsOfConfig, runFactKey, runDbWriteInFlight, verdictOfTrajectory, tallyRecords, RecordCountScanner, harnessSeries, isEpisodeId, heartbeatAt, openRunDb, readRunRow, bestLevelOf, fanoutReadings, fanoutLead, str, num, parseSubscriptionUsage].map(String),
        JSON.stringify([EPISODE_IDS, MODEL_RESPONSE_RECORD, HEARTBEAT_FILE]),
      ].join("\n"),
    )
    .digest("hex")
    .slice(0, 16);
  return runFactCacheVersionMemo;
}

/** The files `readRunFact` reads, and the heartbeat it stats: a kept fact is good while none of them has moved. */
const RUN_FACT_FILES = ["meta.json", "trajectory.jsonl", "run.sqlite", HEARTBEAT_FILE, "session/live.json"] as const;
/**
 * A write in flight on the run database: no key, so nothing is kept or served
 * for the run. A rollback journal is one; so is a WAL that holds frames, which
 * are commits `run.sqlite` does not show yet. An EMPTY `-wal` is not: a reader
 * of a WAL-mode file with no writer creates one and leaves it, and refusing
 * on that would keep such a run out of the cache for good (runner/src/rundb.ts).
 */
function runDbWriteInFlight(dir: string): boolean {
  if (statSync(join(dir, RUN_DB_JOURNAL_FILE), { throwIfNoEntry: false }) !== undefined) return true;
  const wal = statSync(join(dir, RUN_DB_WAL_FILE), { throwIfNoEntry: false });
  return wal !== undefined && wal.size > 0;
}
/** How long a run's files must have been still before its fact is kept. */
export const RUN_FACT_SETTLE_MS = 60_000;

/**
 * A run directory's cache key, or null when it has none. Taken BEFORE the
 * read, so a write that lands during the read leaves the key behind the files
 * and the next read misses. Size, mtime and inode of each file `readRunFact`
 * reads (absent is its own value): a write moves the mtime, and a copy put in
 * its place is a new inode. Not ctime: the kubelet's fsGroup chown moves every
 * file's ctime each time the fleet pod starts (every file under the runs
 * volume read the pod's start time on 2026-10-16), which would miss every
 * entry on exactly the boot the cache is for. The cost is a rewrite in place
 * at the same size with its mtime set back, which is served stale until the
 * file is deleted. `newest` is the latest mtime, for the settle rule.
 */
export function runFactKey(dir: string): { key: string; newest: number } | null {
  const parts: (number | string)[] = [];
  let newest = 0;
  try {
    if (runDbWriteInFlight(dir)) return null;
    for (const name of RUN_FACT_FILES) {
      const st = statSync(join(dir, name), { throwIfNoEntry: false });
      if (st === undefined) {
        parts.push(name, -1);
        continue;
      }
      parts.push(name, st.size, st.mtimeMs, st.ino);
      newest = Math.max(newest, st.mtimeMs);
    }
  } catch {
    return null; // a stat that fails for another reason is doubt
  }
  return { key: JSON.stringify(parts), newest };
}

/**
 * Whether a fact may be kept: the run is terminated, so nothing in it reads
 * the clock, and its files have been still for `RUN_FACT_SETTLE_MS`, so a
 * write in the same timestamp tick as the key cannot hide behind it. Paused
 * and open runs are always read fresh.
 */
export function cacheableFact(f: RunReading, newest: number, now: number): boolean {
  return f.terminationReason !== null && now - newest >= RUN_FACT_SETTLE_MS;
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
 *
 * `counts` is a scanner cache for a caller that reads every run on a timer —
 * the fleet supervisor, twice a tick — so each trajectory is read whole once
 * and after that only for what was appended since the last call, instead of
 * the whole tree from byte zero every time. Same facts either way.
 *
 * `facts` keeps terminated runs' facts on disk across processes
 * (`runFactCache`), so a supervisor's boot reads in full only the runs that
 * have not ended. A kept fact is served only under the key its files had when
 * it was read (`runFactKey`) and only once they had been still for a minute
 * (`cacheableFact`); everything else is read exactly as without it. Same facts
 * either way.
 */
export function readRunFacts(
  runsDir: string,
  now = Date.now(),
  opts: { includeArchived?: boolean; counts?: CountCache; facts?: RunFactCache } = {},
): RunFact[] {
  return scanRunReadings(runsDir, now, opts, false).facts;
}

/**
 * `readRunFacts`, and beside the facts every run under `runsDir` with no
 * episode stamp (`UnstampedRun`), read in the same walk and kept the same way.
 * For the fleet's budgets and slots, which every run on a credential costs,
 * stamped or not; nothing that reads the facts' meaning is given the others.
 */
export function readFleetRuns(
  runsDir: string,
  now = Date.now(),
  opts: { includeArchived?: boolean; counts?: CountCache; facts?: RunFactCache } = {},
): { facts: RunFact[]; unstamped: UnstampedRun[] } {
  return scanRunReadings(runsDir, now, opts, true);
}

function scanRunReadings(
  runsDir: string,
  now: number,
  opts: { includeArchived?: boolean; counts?: CountCache; facts?: RunFactCache },
  withUnstamped: boolean,
): { facts: RunFact[]; unstamped: UnstampedRun[] } {
  if (!existsSync(runsDir)) return { facts: [], unstamped: [] };
  const out: RunFact[] = [];
  const unstamped: UnstampedRun[] = [];
  const read = (dir: string, runId: string): RunReading | null =>
    readRunReading(dir, runId, now, { ...(opts.counts === undefined ? {} : { counts: opts.counts }), stampedOnly: !withUnstamped });
  const seen = new Set<string>();
  const kept = new Set<string>();
  const facts = opts.facts;
  const scan = (dir: string, archived: boolean): void => {
    if (!existsSync(dir)) return;
    for (const d of readdirSync(dir, { withFileTypes: true })) {
      if (!d.isDirectory() || !RUN_ID.test(d.name) || d.name === ARCHIVE_DIR) continue;
      seen.add(join(dir, d.name, "trajectory.jsonl"));
      let f: RunReading | null = null;
      if (facts === undefined) {
        f = read(dir, d.name);
      } else {
        const rel = archived ? `${ARCHIVE_DIR}/${d.name}` : d.name;
        kept.add(rel);
        const key = runFactKey(join(dir, d.name));
        f = key === null ? null : (facts.get(rel, key.key) ?? null);
        if (f === null) {
          f = read(dir, d.name);
          if (key !== null && f !== null && cacheableFact(f, key.newest, now)) facts.set(rel, key.key, f);
          else facts.delete(rel);
        }
      }
      if (f === null) continue;
      if (isStamped(f)) out.push(archived ? { ...f, archived: true } : f);
      else if (withUnstamped) unstamped.push(archived ? { ...f, archived: true } : f);
    }
  };
  scan(runsDir, false);
  if (opts.includeArchived === true) scan(join(runsDir, ARCHIVE_DIR), true);
  // A cache held across calls keeps only the paths this call visited: a run
  // moved into `archive/` leaves its old path behind, and nothing else would
  // ever drop that scanner.
  if (opts.counts !== undefined) for (const path of opts.counts.keys()) if (!seen.has(path)) opts.counts.delete(path);
  if (facts !== undefined) {
    // An archive-less read sees only half the tree; it must not drop the other half's entries.
    if (opts.includeArchived === true) facts.retain(kept);
    facts.flush();
  }
  const order = (a: RunReading, b: RunReading): number => a.startedAt - b.startedAt || (a.runId < b.runId ? -1 : a.runId > b.runId ? 1 : 0);
  out.sort(order);
  unstamped.sort(order);
  return { facts: out, unstamped };
}

/**
 * Whether a run produced no model response at all; null while undecidable.
 *
 * Internal to the scheduler now: such a run is archived by the runner as it
 * terminates and no listing shows one, but the ladder is made of them, so the
 * projection (which reads the archive) still has to name the state.
 */
export function stillbornOf(f: Pick<RunFact, "live" | "pause" | "modelResponses">): boolean | null {
  if (f.modelResponses === null) return null;
  // Paused: undecided. A 0-response rate-limited pause is a launch still in
  // progress as far as the policy is concerned (the roster retries it).
  if (f.live || f.pause !== null) return null;
  return f.modelResponses === 0;
}

/** A stamped routing block, or null when there is none to read. */
function routingOfMeta(raw: unknown): RoutingSpec | null {
  const parsed = routingSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/** A stamped serving block, or null when there is none to read. */
function servingOfMeta(raw: unknown): ServingSpec | null {
  const parsed = servingSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}
