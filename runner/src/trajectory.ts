/**
 * Trajectory persistence for one run: `data/runs/<run-id>/`
 *
 *   trajectory.jsonl   the model side, and only that: every request and
 *                      response with its tokens and cost, the turns, the
 *                      snippets and tool calls with their results as the model
 *                      saw them, the event window each turn's context showed,
 *                      compaction, reflection, watchdog firings, pauses and the
 *                      termination. Append-only, one JSON object per line,
 *                      `{ t, ts, ... }`. A fixed-loop `request` keeps the fresh
 *                      user message and points at the rest of the prompt, which
 *                      the file already holds (`request-record.ts`; `replay.ts`
 *                      rebuilds it).
 *   session/           the session record, the game side (`session-record.ts`,
 *                      wrath-mcp/docs/SESSION-FORMAT.md): the trace, events,
 *                      tool calls and actions, and the live ring of nearby
 *                      units. The scorer reads it (`run-reader.ts`).
 *   meta.json          the run's own bookkeeping: its config and harness
 *                      version, for `--resume`, and the verdict, the pause and
 *                      the reflection window beside them (`RunVerdictFields`),
 *                      rewritten whole and atomically (`writeMetaFile`).
 *   scratchpad.md      owned by Scratchpad, lives in the same directory.
 *
 * A v1 run has no run.sqlite. A 0.5 run's (its run row, 60-second state rows,
 * trace and moves) stays readable through `run-reader.ts` and the viewer's
 * `legacy05-source.ts`, and nothing here writes one.
 *
 * Redaction: records never carry API keys by construction (headers are never
 * logged), and every string is additionally scrubbed against the secret values
 * registered via `redact()` — belt and braces for a key that leaks into a
 * message body. The same list is the run's model-facing one: every tool result
 * and every turn's context message passes `scrub()` before the model reads it
 * (`tools.ts`, `ContextBuilder.build`), so a record and the model see the same
 * `[redacted]`.
 */

import { appendFileSync, mkdirSync, readFileSync, existsSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { jsonLine, toJsonSafe } from "@wrathbench/mcp/jsonsafe";
import type { Comparability } from "./comparability";
import type { PauseReason, RunConfig, TerminationReason } from "./config";
import { SecretRedactor } from "@wrathbench/mcp/redact";
import type { SubscriptionUsage } from "./subscription-usage";
import { latestReading, runRowOfMeta, turnIndexOf } from "./run-reader";

/**
 * One item on a state sample: a client-cache name, its stack count, worn or
 * carried, and where it sits.
 *
 * Everything past `name`, `count` and `equipped` is optional and arrived later
 * (the paperdoll/bag UI). Every row written before it carries those three and
 * nothing else, so a reader treats an absent field as **unobserved** — never as
 * zero, and never as slot 0. A live sample can be missing them too: a slot whose
 * item create block or item query has not arrived yet is a real observation of
 * an occupied slot with no id, name or quality behind it.
 *
 * `slot` and `bag` are the SDK's own addressing pair, unchanged, so a row is
 * what `equipItem`/`useItem`/`destroyItem` take:
 * - worn (`equipped: true`): `bag` absent, `slot` the equipment slot 0-18.
 * - carried (`equipped: false`): `bag` 255 for the backpack (slots 23-38) or a
 *   worn bag's own equipment slot 19-22 (slots 0..numSlots-1), `slot` the slot
 *   within it.
 *
 * So `bag !== undefined` is the carried discriminator and `slot` means the same
 * kind of thing on both sides of it. There is no separate `bagSlot`.
 */
export interface ItemSample {
  name: string;
  count: number;
  equipped: boolean;
  /** The item template id, once the item's own create block has been seen. */
  itemId?: number;
  /** Item quality (0 poor .. 7 heirloom), from the item query, once answered. */
  quality?: number;
  /** The equipment slot when worn, the slot within `bag` when carried. */
  slot?: number;
  /** The container, when carried: 255 the backpack, 19-22 a worn bag. Absent when worn. */
  bag?: number;
}

export interface RunMeta {
  runId: string;
  harnessVersion: string;
  /**
   * The `@wrathbench/sdk` version this build depends on (`SDK_VERSION`), which
   * `@wrathbench/mcp` shares: the stack a run drove, recorded beside the
   * harness stamp and rewritten with it on a resume. A label only
   * (docs/METHODOLOGY.md): not in the comparability tuple, so no run restamps for
   * it, and no filter reads it. Absent on runs written before the SDK had a version of its own.
   */
  sdkVersion?: string;
  /**
   * The wrath-mcp commit the stack came from (`stackCommit()` in version.ts),
   * `-dirty` when a checkout's submodule had tracked edits. Written and
   * rewritten beside `sdkVersion`, and like it a label only: outside the
   * comparability tuple, read by no filter. Absent on runs written before the
   * stack was a submodule, and when neither the checkout nor the image knew it.
   */
  stackCommit?: string | undefined;
  startedAt: number;
  config: RunConfig;
  /**
   * Everything that has to match before two runs share a chart: harness
   * version, prompt hash, episode budget, context engine, effort, and whether
   * an operator objective steered the run. Absent on runs written
   * before the stamp existed, which read as "not recorded" rather than being
   * recomputed against today's prompt.
   */
  comparability?: Comparability;
  /**
   * The unscored stamp (`unscoredStamp` in config.ts): set for a stub run or
   * an operator-objective run. Present in meta.json, in the `shakeout` column
   * of run.sqlite and in the timeline header, so such a run cannot be mistaken
   * for a score. The key keeps its name from before the harness/driver
   * split because old runs carry it; the harness (`wrathbench` | `claude-code`) is a separate dimension in
   * the comparability tuple, never a stamp here.
   */
  shakeout?: string;
  /**
   * Set while the run is paused (`--resume` clears it): the reason, when, and
   * the episode clock spent so far, which is what the resumed run's wall
   * clock continues from. The same facts are in run.sqlite's `pause_reason`
   * and the trajectory's `pause` record; they live here too so a supervisor
   * can find resumable runs from meta.json alone.
   */
  pause?: PauseMark;
  /**
   * A resume that could not reattach the driver's own conversation (the
   * claude-code CLI keeps its history in its own session; the runner starts
   * a fresh one and says so in the prompt). Sticky once set: the run had at
   * least one fresh restart somewhere in its life.
   */
  resumedFresh?: boolean;
  /**
   * What the *provider* said it actually served, as opposed to what the run
   * asked for. `config.model` is the roster's string — often an alias (`sonnet`,
   * `opus`) that the Claude Code CLI resolves at launch — so nothing in run
   * metadata said which Claude a run was on. The CLI's `init` event names the
   * resolved id and its own version; an OpenAI-compatible provider names the
   * served id on every response. First observation wins and is never revised:
   * a run has one answer, and a second look would only ever be a later segment
   * disagreeing with the one the score was earned under.
   *
   * Absent on every run written before this existed. The viewer back-fills
   * those at read time from the trajectory rather than rewriting them.
   */
  resolved?: ResolvedModel;
  /**
   * The newest reading of the run's subscription usage windows, as its driver
   * normalised it (`subscription-usage.ts`: per window the used percent, the
   * window's length and its reset — nothing else). Written on change by
   * `recordSubscriptionUsage`; the fleet reads the newest per credential off
   * these to hold launches (operator, 2026-10-16). Operator-only: no public
   * projection carries it. Absent on every run that never saw one.
   */
  subscriptionUsage?: SubscriptionUsage;
  /**
   * The newest response billed to the provider's balance past the allowance
   * (OpenCode Go's `billing_source: "balance"`): the credential and when.
   * Written by `recordCredentialOverage`; the fleet holds the credential until
   * a usage read shows room after it. Operator-only like `subscriptionUsage`.
   */
  credentialOverage?: { credential: string | null; at: number };
  /**
   * Every credential move the operator made on this run
   * (`runner/src/move-credential.ts`), oldest first: the credential it left,
   * the one it went to, when, who, and why. `config.credential` says which
   * credential the run is on now; this says how it got there, because a
   * run's credential is otherwise read as the one it started on. Top level
   * and not in `config`, so a resume never reads it as launch config.
   * Operator-only like `subscriptionUsage`: no public projection carries it.
   * A 0.5 run may carry its lane moves as `laneHistory` instead, which
   * nothing reads.
   */
  credentialHistory?: CredentialMove[];
  /**
   * Every time this run directory was restored from a character archive
   * (`runner/src/character-archive.ts`), oldest first: which archive, when
   * it was written and by which build, and the account and guid the
   * character left and landed on. The run keeps its id across an import,
   * because it is the same character continuing; this is how its record
   * says the run moved. Operator-only like `credentialHistory`.
   */
  imports?: CharacterImport[];
}

/** One restore of a run from a character archive (`RunMeta.imports`). */
export interface CharacterImport {
  /** Epoch ms. */
  at: number;
  actor: string;
  note: string | null;
  /** The archive's file name. */
  archive: string;
  /** When the archive was written (ISO), and by which harness build. */
  exportedAt: string;
  exportedWith: string;
  from: { account: string; guid: number };
  to: { account: string; guid: number };
}

/** One operator move of a run's credential (`RunMeta.credentialHistory`). */
export interface CredentialMove {
  /** The credential id it was on before. */
  from: string;
  /** The credential id it is on from now on. */
  to: string;
  /** Epoch ms. */
  at: number;
  actor: string;
  note: string;
}

/** The provider's own answer to "what ran", promoted onto the run. */
export interface ResolvedModel {
  /** The resolved model id (`claude-sonnet-5`), or null when none was named. */
  model: string | null;
  /** The Claude Code CLI's version. Null on any other driver. */
  cliVersion: string | null;
  /**
   * The backend that actually served the run, as the response body named it
   * (`Z.AI`, `Together`, `Google AI Studio`). Null on a driver or endpoint
   * that names none.
   *
   * The same species as `model`: observed mid-episode, promoted once, never
   * revised. It is the *answer* to the routing the tuple stamped — the request
   * says which providers are allowed, this says which one took it — and with
   * `allow_fallbacks: false` those agree, so a disagreement is exactly the
   * thing worth seeing. It is an annotation and not a key for the reason the
   * resolved model id is not one (docs/METHODOLOGY.md): a fact observed
   * minutes after launch cannot be part of what a launch stamped, and the
   * requested routing already carries the grouping.
   */
  provider: string | null;
}

export interface PauseMark {
  reason: PauseReason;
  detail?: string | undefined;
  at: number;
  /** Episode wall clock spent across every segment up to this pause. */
  episodeElapsedMs: number;
  /**
   * The provider's stated reset, when the adapter carried one: the supervisor
   * resumes at this instant, off the defer ladder (`resumeNotBefore`).
   */
  notBefore?: number;
}

export interface TrajectoryRecord {
  t: string;
  ts: number;
  [key: string]: unknown;
}

/**
 * The run's own bookkeeping beside its identity in meta.json, the run row
 * run.sqlite held in 0.5: the verdict, when it was reached, a pause in
 * progress and an open reflection window. `run-reader.ts` reads them back in
 * the row's column names (`runRowOfMeta`).
 */
export interface RunVerdictFields {
  /** The run's end, as `setTermination` recorded it. */
  termination?: { reason: string; detail?: string | undefined };
  /** When the verdict was recorded (epoch ms). */
  endedAt?: number;
  /** The reason of a pause still standing; `--resume` clears it. */
  pauseReason?: string;
  /** When the reflection window still open opened; absent when none is. */
  reflectingSince?: number;
}

/**
 * The meta.json fields only the verdict methods write (`setTermination`,
 * `repairTermination`, `setPause`, `clearPause`): `writeMeta` takes them from
 * the file it replaces and never from the meta it is handed, which is often
 * one read before a verdict moved (a resume's, read before `clearPause`).
 */
const VERDICT_FIELDS = ["termination", "endedAt", "pauseReason"] as const;

/**
 * Rewrite meta.json whole and atomically: a temporary file beside it, renamed
 * into place, so a reader (the viewer, the collector, the supervisor) never
 * sees half of one. Synchronous, so a verdict written here is on disk before
 * the call returns, which the SIGTERM handler relies on.
 */
export function writeMetaFile(dir: string, meta: object): void {
  const path = join(dir, "meta.json");
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(toJsonSafe(meta), null, 2)}\n`, "utf8");
  renameSync(tmp, path);
}

export class Trajectory {
  readonly dir: string;
  readonly jsonlPath: string;
  private readonly secrets = new SecretRedactor();
  private readonly now: () => number;
  /**
   * The run this file belongs to, latched at `writeMeta` — which every launch
   * and every resume path calls before a turn is taken. It exists so `append`
   * can mirror the one record kind that has a *current* answer worth asking
   * (`reflect_window`) into meta.json without every call site having to pass a
   * run id it does not otherwise need. Null for the read-only openers
   * (`classify.ts`, `timeline.ts`), which append none of those kinds.
   */
  private runId: string | null = null;
  /**
   * The verdict this handle has recorded, kept in memory as well as in
   * meta.json, so the second pause of one segment (the SIGTERM handler's,
   * then the driver's unwind reaching the same call) is recognised as one.
   */
  private recorded: { kind: "terminated" } | { kind: "paused"; mark: PauseMark } | null = null;

  constructor(dir: string, opts: { now?: () => number } = {}) {
    this.dir = dir;
    this.now = opts.now ?? Date.now;
    mkdirSync(dir, { recursive: true });
    this.jsonlPath = join(dir, "trajectory.jsonl");
  }

  /** Every write is synchronous; kept for the callers that await the run's writes before they exit. */
  flush(): Promise<void> {
    return SETTLED;
  }

  /** Register a secret to scrub from every persisted string and from everything the model reads. */
  redact(secret: string | undefined): void {
    this.secrets.redact(secret);
  }

  /**
   * `text` with every registered secret replaced by `[redacted]`. Applied to
   * every line this writes, and by the drivers to what the model reads, so
   * there is one list per run.
   */
  scrub(text: string): string {
    return this.secrets.scrub(text);
  }

  /** Append one record. `ts` is stamped here unless the record carries one. */
  append(record: { t: string; ts?: number; [key: string]: unknown }): void {
    const full = { ts: this.now(), ...record };
    appendFileSync(this.jsonlPath, `${this.scrub(jsonLine(full))}\n`, "utf8");
    if (record.t === "reflect_window") this.mirrorReflectWindow(full.ts, record["event"]);
  }

  /** meta.json as it stands, or null when it is missing or unreadable. */
  private readMetaFile(): (RunMeta & RunVerdictFields) | null {
    try {
      return JSON.parse(readFileSync(join(this.dir, "meta.json"), "utf8")) as RunMeta & RunVerdictFields;
    } catch {
      return null;
    }
  }

  /**
   * Change meta.json in place: read it, apply `change`, scrub and write it
   * back whole (`writeMetaFile`). Nothing when there is no meta.json (a test
   * harness, a torn launch): the record carries what happened.
   */
  private updateMeta(change: (meta: RunMeta & RunVerdictFields) => RunMeta & RunVerdictFields): void {
    const meta = this.readMetaFile();
    if (meta === null) return;
    try {
      writeMetaFile(this.dir, JSON.parse(this.scrub(jsonLine(change(meta)))) as object);
    } catch {
      /* a full or read-only disk: the record still carries it */
    }
  }

  /**
   * Keep meta.json's `reflectingSince` equal to the gate's window, so a reader
   * can ask whether a character is reflecting *now* without replaying the
   * JSONL. The transitions themselves stay in the trajectory; this is only the
   * current answer, written from the same records rather than from a second
   * call site, so the two cannot disagree.
   */
  private mirrorReflectWindow(ts: number, event: unknown): void {
    if (this.runId === null || (event !== "open" && event !== "close")) return;
    this.updateMeta(({ reflectingSince: _since, ...meta }) => (event === "open" ? { ...meta, reflectingSince: ts } : meta));
  }

  /**
   * The run's identity, to its two places: meta.json whole and a `meta` record
   * in the trajectory.
   *
   * The module session token goes to meta.json only. It is the bearer secret
   * for the run's game session, and the readers that need it — `--resume`
   * reattaching, the roster releasing a session, the viewer striking it out of
   * an error message — all read meta.json. The record carries the rest of the
   * config without it (`withoutSessionToken`).
   *
   * The verdict fields (`VERDICT_FIELDS`) are the file's as it stands, never
   * `meta`'s, as a 0.5 run's `run` row kept them across a relaunch; an open
   * reflection window is dropped, because no window is open at a process
   * boundary (`reflect.ts`: "A resumed run starts with a fresh gate").
   */
  writeMeta(meta: RunMeta): Promise<void> {
    this.runId = meta.runId;
    const before = this.readMetaFile();
    const given = { ...meta } as RunMeta & RunVerdictFields;
    for (const k of [...VERDICT_FIELDS, "reflectingSince"] as const) delete given[k];
    const kept: RunVerdictFields = {};
    for (const k of VERDICT_FIELDS) if (before?.[k] !== undefined) (kept as Record<string, unknown>)[k] = before[k];
    const next = { ...given, ...kept };
    writeMetaFile(this.dir, JSON.parse(this.scrub(jsonLine(next))) as object);
    this.append({ t: "meta", ...meta, config: withoutSessionToken(meta.config) });
    return SETTLED;
  }

  /**
   * A continuation whose character turned out to be gone: the run goes on as
   * a fresh one, and both places that said "continues run X on character Y" —
   * meta.json and the trajectory — are told so, because a lineage the
   * character does not back is exactly the wrong record.
   */
  dropContinuation(_runId: string, detail: string): Promise<void> {
    this.append({ t: "harness", kind: "continue-dropped", detail });
    this.updateMeta((meta) => {
      const { continuedFrom: _from, character: _name, ...config } = meta.config;
      return { ...meta, config: config as RunConfig };
    });
    return SETTLED;
  }

  /**
   * Promote what the provider said it served onto the run, once.
   *
   * The answer arrives mid-episode (the CLI's `init` event, the first response
   * body), long after the launch write. First observation wins: a call that
   * would overwrite an already-recorded value with a different one is
   * ignored, and the run keeps the id it was launched under.
   *
   * Returns whether anything was written, so a caller can log the promotion
   * exactly once without keeping its own flag honest.
   */
  recordResolved(_runId: string, r: Partial<ResolvedModel>): boolean {
    const model = r.model ?? null;
    const cliVersion = r.cliVersion ?? null;
    const provider = r.provider ?? null;
    if (model === null && cliVersion === null && provider === null) return false;
    const meta = this.readMetaFile();
    const have = meta?.resolved;
    const next: ResolvedModel = {
      model: have?.model ?? model,
      cliVersion: have?.cliVersion ?? cliVersion,
      // `?? null` and not `?? provider`: an older run's `resolved` block has no
      // `provider` key at all, and `undefined ?? provider` would take the new
      // one — which is what we want — while a run that recorded `null` keeps
      // its null. Both read the same here, and the first observation wins
      // either way.
      provider: have?.provider ?? provider,
    };
    if (
      have !== undefined &&
      have.model === next.model &&
      have.cliVersion === next.cliVersion &&
      (have.provider ?? null) === next.provider
    ) {
      return false;
    }
    if (meta !== null) {
      /*
       * The tuple carries the same answer as an annotation, so a reader that
       * already parses comparability does not need a second lookup. It is
       * excluded from `sameComparability`, which is why
       * filling it here does not turn every resume into a restamp.
       */
      this.updateMeta((m) => ({
        ...m,
        resolved: next,
        ...(m.comparability !== undefined ? { comparability: { ...m.comparability, resolvedModel: next.model } } : {}),
      }));
    }
    this.append({ t: "harness", kind: "resolved_model", ...next });
    return true;
  }

  /**
   * The run's newest subscription usage reading (`subscription-usage.ts`), on
   * the record and in meta.json, where the fleet reads the newest per
   * credential.
   * The driver calls this only when the reading changed. The record carries
   * the windows and no text: a `harness` record's `text` is published, and a
   * usage percentage or a reset time never is (operator, 2026-10-16).
   * meta.json is rewritten whole, and never throws into a turn.
   */
  recordSubscriptionUsage(u: SubscriptionUsage, turn?: number): void {
    this.append({ t: "harness", kind: "rate_limits", ...(turn !== undefined ? { turn } : {}), credential: u.credential, windows: u.windows });
    this.updateMeta((meta) => ({ ...meta, subscriptionUsage: u }));
  }

  /**
   * A response billed to the provider's balance past the allowance: in
   * meta.json, where the fleet reads it, and — when `record` — as a `harness`
   * record of kind `usage_overage`, which carries no text and no figure.
   * Never throws into a turn.
   */
  recordCredentialOverage(credential: string | null, at: number, opts: { turn?: number; record?: boolean } = {}): void {
    if (opts.record !== false) this.append({ t: "harness", kind: "usage_overage", ...(opts.turn !== undefined ? { turn: opts.turn } : {}), credential, billingSource: "balance" });
    this.updateMeta((meta) => ({ ...meta, credentialOverage: { credential, at } }));
  }

  /**
   * The character the run is actually playing (the model names it).
   *
   * The launch config carries only the harness's suggestion, so every reader
   * of "which character was this" — the runs page, the positions feed and the
   * resume note — has to be told the name the model chose, once, at the first
   * sight of it in the world: in meta.json's config, and as a record.
   */
  setCharacter(_runId: string, character: string): Promise<void> {
    this.append({ t: "character", character });
    this.updateMeta((meta) => (meta.config?.character === character ? meta : { ...meta, config: { ...meta.config, character } }));
    return SETTLED;
  }

  /**
   * The run's verdict: the trajectory record first, then meta.json.
   *
   * The record is appended before meta.json is rewritten, so a rewrite that
   * fails leaves the verdict in trajectory.jsonl alone. `readRunFact` reads it
   * from there when meta.json has none (`terminationOfTrajectory`), so the
   * supervisor neither resumes nor re-ends a run whose runner recorded its
   * end, and repairs meta.json (`repairTermination`).
   */
  setTermination(_runId: string, reason: TerminationReason, detail?: string): Promise<void> {
    this.recorded = { kind: "terminated" };
    this.append({ t: "termination", reason, detail });
    this.writeTermination(reason, detail, this.now());
    return SETTLED;
  }

  /**
   * Write a verdict the trajectory already holds into a meta.json that lacks
   * it, appending nothing: the supervisor's repair of a run whose runner
   * recorded its end but could not write it down (`setTermination`). A
   * meta.json that already carries a verdict is left alone. Returns whether it
   * wrote.
   */
  repairTermination(_runId: string, reason: string, detail: string | null, at: number): boolean {
    const meta = this.readMetaFile();
    if (meta === null || meta.termination !== undefined) return false;
    this.writeTermination(reason, detail ?? undefined, at);
    return true;
  }

  private writeTermination(reason: string, detail: string | undefined, at: number): void {
    this.updateMeta(({ pauseReason: _pause, ...meta }) => ({ ...meta, termination: { reason, ...(detail !== undefined ? { detail } : {}) }, endedAt: at }));
  }

  /**
   * Record a pause. `episodeElapsedMs` rides on the record when the caller
   * knows it (run.ts does; the drivers pass what their watchdogs say) so the
   * pause line in the trajectory reads as "paused at 41m of 90m". `notBefore`
   * rides on it when the provider stated its reset: the pause streak reads it
   * off this record, and a pause that carries one is not on the ladder.
   *
   * One pause per segment: a run whose meta.json already carries a
   * `pauseReason` is left as it is and no second record is appended. The
   * signal handler in run.ts writes the pause the instant SIGTERM lands (so a
   * SIGKILL a second later still leaves a verdict), and the driver's own
   * cooperative unwind then reaches the same call — the first write is the
   * verdict, and the pause count `readRunFact` derives from the trajectory
   * stays one per segment. `--resume` clears it (`clearPause`), so the next
   * segment's pause is recorded again.
   */
  setPause(runId: string, reason: PauseReason, detail?: string, episodeElapsedMs?: number, notBefore?: number): Promise<boolean> {
    return Promise.resolve(this.takePause(runId, reason, detail, episodeElapsedMs, notBefore));
  }

  /** `setPause`'s synchronous half: false when the run already carries a pause, else the record appended and meta.json written. */
  private takePause(_runId: string, reason: PauseReason, detail?: string, episodeElapsedMs?: number, notBefore?: number): boolean {
    // What this handle recorded first, then meta.json (a run paused before this
    // process opened it). A recorded termination is never followed by a pause.
    if (this.recorded !== null) return false;
    const standing = this.readMetaFile()?.pauseReason;
    if (typeof standing === "string" && standing !== "") return false;
    this.recorded = {
      kind: "paused",
      mark: {
        reason,
        ...(detail !== undefined ? { detail } : {}),
        at: this.now(),
        episodeElapsedMs: episodeElapsedMs ?? 0,
        ...(notBefore !== undefined ? { notBefore } : {}),
      },
    };
    this.append({
      t: "pause",
      reason,
      detail,
      ...(episodeElapsedMs !== undefined ? { episodeElapsedMs } : {}),
      ...(notBefore !== undefined ? { notBefore } : {}),
    });
    this.updateMeta((meta) => ({ ...meta, pauseReason: reason }));
    return true;
  }

  /**
   * The pause and its meta.json mark, together and once per segment: when the
   * run already carries a pause, NOTHING is written — not the record, not the
   * reason, and not the mark. A run that paused on its provider and is then
   * stopped keeps that pause's reason and its instant (`at`), which is what
   * the resume cadence counts from. `meta` is the run's meta as it stands.
   */
  pauseWithMark(runId: string, mark: PauseMark, meta: RunMeta): Promise<boolean> {
    if (!this.takePause(runId, mark.reason, mark.detail, mark.episodeElapsedMs, mark.notBefore)) return Promise.resolve(false);
    return this.writeMeta({ ...meta, pause: mark }).then(() => true);
  }

  /**
   * The pause this handle recorded in this segment, as a meta.json mark, or
   * null. For a caller that must leave the mark when the episode threw before
   * it could (`run.ts`).
   */
  get recordedPause(): PauseMark | null {
    return this.recorded?.kind === "paused" ? this.recorded.mark : null;
  }

  clearPause(_runId: string): Promise<void> {
    if (this.recorded?.kind === "paused") this.recorded = null;
    this.updateMeta(({ pauseReason: _pause, ...meta }) => meta);
    return SETTLED;
  }

  /** The run row, in run.sqlite's column names, as meta.json now holds it (`runRowOfMeta`); null without a meta.json. */
  runRow(runId: string): Record<string, unknown> | null {
    const meta = this.readMetaFile();
    return meta === null ? null : (runRowOfMeta(runId, meta as unknown as Record<string, unknown>) as unknown as Record<string, unknown>);
  }

  /**
   * The highest turn this run has already recorded, or 0: where a resumed
   * run's numbering continues from, so its turns-to-level is the run's cost
   * and not this episode's. Read off the trajectory's own `request` records
   * (`TurnIndex`), each `resume` moving the offset as this one will.
   */
  maxTurn(_runId: string): number {
    return turnIndexOf(this.dir).max;
  }

  /**
   * The most recent reading of the character's level and XP, or null: off the
   * session record's trace (`run-reader.ts`). Read on `--resume` so the
   * resumed session note can tell the model where its character was left.
   */
  lastState(runId: string): { level?: number; xp?: number } | null {
    const r = latestReading(this.dir, runId);
    if (r === null || (r.level === null && r.xp === null)) return null;
    return { ...(r.level !== null ? { level: r.level } : {}), ...(r.xp !== null ? { xp: r.xp } : {}) };
  }

  /** Nothing to close: every write is a whole append or a whole rename. */
  close(): void {}

  /** The owner's close; nothing is held open. */
  async finish(): Promise<void> {}
}

const SETTLED: Promise<void> = Promise.resolve();

/** Read every record of a trajectory file. Bad lines surface, not vanish. */
export function readTrajectory(dir: string): TrajectoryRecord[] {
  const path = join(dir, "trajectory.jsonl");
  if (!existsSync(path)) return [];
  const out: TrajectoryRecord[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (line.trim().length === 0) continue;
    try {
      out.push(JSON.parse(line) as TrajectoryRecord);
    } catch {
      out.push({ t: "unparseable-line", ts: 0, line });
    }
  }
  return out;
}

/**
 * A run config without its module session token: the config as every copy but
 * meta.json holds it (`Trajectory.writeMeta`).
 */
export function withoutSessionToken<C extends { token?: unknown }>(config: C): Omit<C, "token"> {
  const { token: _token, ...rest } = config;
  return rest;
}

export function readMeta(dir: string): RunMeta | null {
  const path = join(dir, "meta.json");
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8")) as RunMeta;
}

// ------------------------------------------------------------- heartbeat
//
// The proof that a run has a live owner. A trajectory's mtime cannot be that
// proof: a run waiting on a slow provider, or a model in a long reflect, writes
// nothing for as long as its request takes, and the idle watchdog is checked
// between turns, so not even `idleMs` bounds the silence. The runner therefore
// rewrites one small file on a timer for as long as its process exists, and
// removes it on any exit it gets to make. Age is the whole test — never pid
// liveness, because the reader may be on another pod or host, and the run this
// exists for is one whose owner was SIGKILLed: its mark simply goes cold. The
// content (host and pid) is for the operator reading a refusal, nothing else.

export const HEARTBEAT_FILE = "heartbeat";
/** How often a running runner rewrites its heartbeat. */
export const HEARTBEAT_EVERY_MS = 20_000;
/**
 * A heartbeat older than this has no owner: six missed beats, which also
 * absorbs a blocked event loop (a snippet's 30 s ceiling) and clock skew
 * between the pod that wrote it and the pod reading it.
 */
export const HEARTBEAT_DEAD_MS = 120_000;

/** When the run's owner last beat, or null when the run carries no heartbeat. */
export function heartbeatAt(dir: string): number | null {
  try {
    return statSync(join(dir, HEARTBEAT_FILE)).mtimeMs;
  } catch {
    return null;
  }
}

/** Who wrote the heartbeat ("host pid"), for a message; empty when unreadable. */
export function heartbeatOwner(dir: string): string {
  try {
    return readFileSync(join(dir, HEARTBEAT_FILE), "utf8").trim();
  } catch {
    return "";
  }
}

/**
 * Beat now and every `HEARTBEAT_EVERY_MS` until the returned stop is called
 * (or the process exits: the timer is unref'd and never keeps it alive). Stop
 * removes the file, so a clean exit leaves a run anyone may resume at once.
 */
export function startHeartbeat(dir: string, owner: string): () => void {
  const path = join(dir, HEARTBEAT_FILE);
  const beat = (): void => {
    try {
      writeFileSync(path, `${owner}\n`);
    } catch {
      /* a full or read-only disk costs the heartbeat, never the run */
    }
  };
  beat();
  const timer = setInterval(beat, HEARTBEAT_EVERY_MS);
  timer.unref();
  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    try {
      rmSync(path, { force: true });
    } catch {
      /* already gone */
    }
  };
}
