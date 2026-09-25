/**
 * The agent loop: model-agnostic driver. One iteration = one model request
 * with the fixed context (context.ts), then execution of whatever tool calls
 * came back, then fixed pacing. No per-model branches, prompts, or retries —
 * the only thing that varies between runs is the adapter config.
 */

import type { Database } from "bun:sqlite";
import { AdapterError, type ChatAdapter } from "./adapter";
import {
  CONTEXT_POLICY,
  PLAYER_FLAGS_GHOST,
  assembleContext,
  formatStateSummary,
  messageWindow,
  messageWindowCut,
  trimExpected,
  type ChatMessage,
  type SnapshotLike,
} from "./context";
import { REFLECT_BREAKER_NOTICE, ReflectGate, restingOf } from "./reflect";
import type { EpisodicLog } from "./episodic";
import { buildSystemPrompt } from "./prompt";
import { callTool, coerceToolArgs, normalizeToolArgs, toolsFor, type ToolContext } from "./tools";
import { harnessOf } from "./config";
import type { PauseReason, RunConfig, TerminationReason } from "./config";
import type { HarnessNotice, SandboxHost } from "./sandbox/host";
import type { DeathSignal } from "./sandbox/ipc";
import type { Workspace } from "./workspace";
import type { ItemSample, Trajectory } from "./trajectory";
import type { Watchdogs } from "./watchdogs";

/**
 * `TRADE_STATUS_TRADE_COMPLETE` on 3.3.5a: what `SMSG_TRADE_STATUS` carries
 * when a trade actually went through. The SDK names it in `tradeStatusText`
 * but exports no constant, and a bare `8` in the producer would be a riddle.
 */
const TRADE_STATUS_COMPLETE = 8;

/**
 * Written samples in a row that must find the observation standing still
 * behind a closed stream before the stall is named on the record. Three is
 * three minutes at the fleet's `stateIntervalMs`, long enough that a stream
 * dropping and coming back on its own reconnect ladder is never called one.
 */
const OBSERVATION_STALL_SAMPLES = 3;

/**
 * Asks the runner to pause the run because its observation has stalled
 * (`STALL_PAUSE`, lapse.ts). `detail` is the stall record's own sentence.
 * Every driver takes it and hands it to its `ContextBuilder`; run.ts answers it
 * by stopping the run the way a supervisor stop does, as a pause.
 */
export type ObservationStallHook = (detail: string) => void;

export interface LoopOptions {
  config: RunConfig & { runId: string; token: string };
  adapter: ChatAdapter;
  sandbox: SandboxHost;
  workspace: Workspace;
  /** The run's append-only episodic log (`log_status` / `read_log`). */
  episodic: EpisodicLog;
  wiki?: Database | undefined;
  trajectory: Trajectory;
  watchdogs: Watchdogs;
  /** Shown to the model on the first turn (e.g. "runner restarted, resuming"). */
  initialNotices?: HarnessNotice[];
  /** Turns this run recorded before this process; see `ContextBuilderOptions`. */
  turnOffset?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** See `ContextBuilderOptions.onObservationStalled`. */
  onObservationStalled?: ObservationStallHook | undefined;
  /**
   * How often the world is sampled while a turn is in flight (`startStateTicker`).
   * Coarse by design and deliberately not derived from `stateIntervalMs`: the
   * tick is the *opportunity* to sample, the interval is the gate.
   */
  stateTickMs?: number;
  /**
   * The runner's stop request. Its `reason` is a `StopRequest`: a pause
   * (the supervisor is stopping; the run is suspended, not judged) or a
   * termination (`manual`, the operator's Ctrl-C). Read at the turn
   * boundaries and between tool calls, and handed to the adapter so a request
   * in flight is abandoned rather than waited out.
   */
  signal?: AbortSignal | undefined;
}

/**
 * What an abort signal's `reason` carries when the runner is asked to stop.
 * A string reason (older callers, tests) reads as a `manual` termination.
 */
export type StopRequest =
  | { kind: "pause"; reason: PauseReason; detail: string }
  | { kind: "terminate"; detail: string };

export function stopRequestOf(signal: AbortSignal | undefined): StopRequest | null {
  if (signal === undefined || !signal.aborted) return null;
  const r: unknown = signal.reason;
  if (typeof r === "object" && r !== null && (r as { kind?: unknown }).kind === "pause") return r as StopRequest;
  if (typeof r === "object" && r !== null && (r as { kind?: unknown }).kind === "terminate") return r as StopRequest;
  return { kind: "terminate", detail: typeof r === "string" ? r : "aborted" };
}

export type LoopOutcome =
  | { kind: "terminated"; reason: TerminationReason; detail?: string }
  | { kind: "paused"; reason: PauseReason; detail?: string };

export interface ContextBuilderOptions {
  config: RunConfig & { runId: string };
  sandbox: SandboxHost;
  workspace: Workspace;
  trajectory: Trajectory;
  watchdogs: Watchdogs;
  /**
   * Turns this run already recorded before this process started.
   *
   * A resumed run's driver counts from 1 again — the conversation is gone, and
   * `maxTurns` bounds this episode, not the run's whole life. The *recorded*
   * turn must keep climbing, or turns-to-level would credit a resumed run with
   * the handful of turns since its last pause. `run.ts` reads the high-water
   * mark off the run's own state rows.
   */
  turnOffset?: number;
  now?: () => number;
  /**
   * Called once, the first time this process writes `observation_stalled`:
   * the observation has stood still behind a closed stream for the whole
   * window the reconnect ladder gets, so nothing on its own is going to bring
   * it back. The run pauses rather than go on recording the last reading as
   * the world. Absent (tests, a bare builder), the stall is recorded and
   * nothing else happens.
   */
  onObservationStalled?: ObservationStallHook | undefined;
}

/**
 * The per-turn preamble, shared by every driver: snapshot state, emit the
 * periodic state line, gather the event window and assemble the fixed context
 * message. It lives in one place precisely because it *is* the
 * context policy — a driver that assembled its own would be per-model tuning.
 */
export class ContextBuilder {
  private lastStateAt = 0;
  private live = false;
  /**
   * The movement intention already recorded, as `dispatch:verdict` — the
   * sandbox keeps one slot and re-reports it on every 5s sample, so this is
   * what turns a standing intent into exactly two rows: the dispatch, and the
   * verdict that ended it.
   */
  private lastMoveKey: string | null = null;
  /** High-water mark into the snapshot's quest-completion list, for logging. */
  private questsLogged = 0;
  /** Last zone/area ids a milestone was written for; undefined until the first sample names one. */
  private lastZoneId: number | undefined;
  private lastAreaId: number | undefined;
  /**
   * Achievement ids already written as a milestone, and whether the login
   * backlog record has been written.
   *
   * By id rather than by high-water mark, because the sandbox can restart: a
   * rebuilt cache re-reads the whole login backlog, and a second pass over it
   * must write nothing rather than re-report a run's own past as fresh earns.
   */
  private readonly recordedAchievements = new Set<number>();
  private loginAchievementsRecorded = false;
  /**
   * The last `taxiFlight` reading. Seeded silently by the first observation:
   * a resumed process whose first sample is already `true` joined a flight in
   * progress, and calling that a takeoff would invent one.
   */
  private lastTaxiFlight: boolean | undefined;
  /**
   * The last level a milestone was written for; undefined until the first
   * sample names one, which is written as a mark from `undefined`.
   */
  private lastLevel: number | undefined;
  /**
   * Spell ids already accounted for, and whether the login baseline record has
   * been written. By id rather than by count, for the reason
   * `recordedAchievements` is: a sandbox restart re-reads `SMSG_INITIAL_SPELLS`
   * and the second pass must write nothing rather than report a run's own book
   * as fresh learns.
   */
  private readonly recordedSpells = new Set<number>();
  private loginSpellsRecorded = false;
  /**
   * talentId -> the highest rank seen. Seeded silently by the first talent
   * frame — a resumed character's already-spent points are not spends this run
   * made — and lowered silently when a respec takes ranks back, so a relearn
   * afterwards reads as a spend again.
   */
  private readonly talentRanks = new Map<number, number>();
  private talentsSeeded = false;
  /** The `ts` of the last completed trade written; the dedup key. */
  private lastTradeTs: number | undefined;
  /**
   * The dead window and the ghost flag as the last sample read them. Both are
   * seeded silently by the first observation, for the reason `lastTaxiFlight`
   * is: a process that opens on a character already dead joined the window in
   * progress, and calling that a death would invent one.
   */
  private lastDead: boolean | undefined;
  private lastGhost: boolean | undefined;
  /**
   * A death window the child's signals opened and have not closed.
   *
   * While it stands the sampled window read updates its latches from the
   * snapshot but writes nothing: the two producers disagree about the same
   * sample. The signal path sets `lastGhost` from the release it saw, while the
   * snapshot's `playerFlags` is routinely a stale `0` for the whole window (an
   * update block need not carry it), so the window read would call that a
   * resurrect the moment the spirit was released. And the snapshot is taken
   * before the drain, so a cycle that drained whole leaves a snapshot still
   * showing a corpse the record has already accounted for. The window that the
   * signals opened is theirs to close.
   */
  private signalWindow = false;
  /** `sandbox.totalRestarts` as the last sample read it; a change abandons `signalWindow`. */
  private lastRestarts = 0;
  /**
   * The child's observation cursor at the last written sample, and how many
   * written samples in a row have found it standing still behind a stream that
   * is no longer open. See `noteObservationStall`.
   */
  private lastCursor: { eventCount: number; lastSeq: number } | null = null;
  private stalledSamples = 0;
  private stallRecorded = false;
  /** Whether `onObservationStalled` has been called; once per process. */
  private stallPauseAsked = false;
  /**
   * Whether the cursor has ever moved in this process. Latched, so a sandbox
   * restart — whose fresh child starts the count at zero again — cannot disarm
   * the detector for the rest of a run that had been observing fine.
   */
  private everObserved = false;
  /**
   * The driver turn currently in flight, stamped onto every state sample.
   *
   * Set by the driver rather than counted here: the fixed loop and the
   * claude-code driver each own their own turn counter, and a sample
   * is taken on the clock (`stateIntervalMs`), not once per turn. Zero means
   * "before the first turn", which is recorded as no turn at all.
   */
  private turn = 0;
  /**
   * The episode's reflection gate, fed by every state sample this builder
   * takes. It lives here because this is the one place both drivers sample the
   * world on the clock: the `reflect` tool needs to see the character *leave*
   * a rest area to re-arm, and no reflect call is made while that happens.
   */
  readonly reflect = new ReflectGate();
  /** The sample in flight, if any; concurrent callers share it. */
  private sampling: Promise<SnapshotLike | null> | null = null;
  private readonly now: () => number;

  constructor(private readonly o: ContextBuilderOptions) {
    this.now = o.now ?? Date.now;
  }

  /**
   * Tell the builder which turn is in flight; every later sample carries it.
   * The driver counts this episode's turns; the offset makes the record the
   * run's, so a resume does not restart the series.
   */
  noteTurn(turn: number): void {
    this.turn = (this.o.turnOffset ?? 0) + turn;
  }

  /** Whether the last snapshot showed a character in the world. */
  get sessionLive(): boolean {
    return this.live;
  }

  /** The turn currently in flight, as the record counts it (offset included). */
  get currentTurn(): number {
    return this.turn;
  }

  async snapshot(): Promise<SnapshotLike | null> {
    try {
      const snap = (await this.o.sandbox.stateSnapshot()) as SnapshotLike;
      const wasLive = this.live;
      this.live = snap.self?.guid !== undefined && snap.self.guid !== null;
      if (this.live && !wasLive) {
        // The first sight of a character in the world: the fresh-episode
        // precondition is judged here, once, by the watchdogs.
        this.o.watchdogs.noteFirstLive({
          guid: snap.self?.guid === undefined || snap.self.guid === null ? undefined : String(snap.self.guid),
          level: snap.self?.level?.value as number | undefined,
        });
        // The model named the character, so the launch config's
        // name is only a suggestion: what is in the world is the run's
        // character, and every reader of it is corrected here, once.
        const name = typeof snap.self?.name === "string" ? snap.self.name : undefined;
        if (name !== undefined && name.length > 0 && name !== this.o.config.character) {
          this.o.trajectory.setCharacter(this.o.config.runId, name);
        }
      }
      return snap;
    } catch {
      return null;
    }
  }

  /**
   * Snapshot, and record the periodic state line if `stateIntervalMs` has
   * elapsed. Separate from `build` because a driver whose turns are long (the
   * claude-code driver: one turn can run for tens of minutes) must
   * sample the world on the clock, not once per turn, or the timeline has no
   * data mid-turn and `no-xp` has nothing to measure.
   *
   * Coalesced, never concurrent: the mid-turn ticker and the turn preamble
   * can call this at the same time, and two interleaved samples would each
   * read the quest/zone/area high-water marks before either advanced them —
   * double-logging every completion and milestone in the window. A caller
   * landing mid-sample gets that sample's snapshot, which is as fresh as the
   * one it would have taken.
   */
  async sampleState(): Promise<SnapshotLike | null> {
    // One sample at a time, run-wide. The turn preamble and the ticker
    // (`startStateTicker`) both call this, and two concurrent samples would
    // double-read the world and race every high-water mark below — so a caller
    // arriving mid-sample joins the one in flight rather than starting another.
    if (this.inFlight !== null) return await this.inFlight;
    const p = this.doSampleState().finally(() => {
      if (this.inFlight === p) this.inFlight = null;
    });
    this.inFlight = p;
    return await p;
  }

  private inFlight: Promise<SnapshotLike | null> | null = null;

  /**
   * Write the death-window transitions the child latched since the last sample,
   * in the order they happened, and leave the window read's latches holding
   * what they left behind.
   *
   * The record shapes are exactly the ones the sampled read produces — the
   * evidence is better, the record is the same — with `observedTs` the death
   * event's own timestamp. `released` on an event-driven death is the ghost
   * flag as it read at the instant of death, which is normally false: the
   * spirit is released a moment later, and the `release` record is what says
   * when. `zone` / `area` fall back to the sample's reading when the child's
   * cache had not named one.
   */
  private async applyDeathSignals(
    trajectory: Trajectory,
    turn: { turn?: number },
    zoneId: number | undefined,
    areaId: number | undefined,
  ): Promise<boolean> {
    const sandbox = this.o.sandbox as SandboxHost & { deathSignals?: () => Promise<DeathSignal[]> };
    // A child that died mid-window took its latches with it and will never
    // send the resurrect that closes this one, so the fallback gets the window
    // back rather than being muted for the rest of the run.
    const restarts = sandbox.totalRestarts ?? 0;
    if (restarts !== this.lastRestarts) {
      this.lastRestarts = restarts;
      this.signalWindow = false;
    }
    if (typeof sandbox.deathSignals !== "function") return false;
    let signals: DeathSignal[];
    try {
      signals = await sandbox.deathSignals();
    } catch {
      // A child that cannot answer leaves the window read as the only producer,
      // which is what it is there for.
      return false;
    }
    for (const s of signals) {
      if (s.kind === "death") {
        const zone = s.zone ?? zoneId;
        const area = s.area ?? areaId;
        trajectory.recordMilestone({
          kind: "death",
          observedTs: s.ts,
          ...(s.position === undefined ? {} : { position: s.position }),
          ...(typeof zone === "number" ? { zone: { id: zone } } : {}),
          ...(typeof area === "number" ? { area: { id: area } } : {}),
          ...(s.released === undefined ? {} : { released: s.released }),
          ...turn,
        });
        this.lastDead = true;
        this.signalWindow = true;
        if (s.released === true) this.lastGhost = true;
      } else if (s.kind === "release") {
        trajectory.recordMilestone({
          kind: "release",
          ...(s.graveyard === undefined ? {} : { graveyard: s.graveyard }),
          ...turn,
        });
        this.lastDead = true;
        this.lastGhost = true;
        this.signalWindow = true;
      } else {
        trajectory.recordMilestone({ kind: "resurrect", ...turn });
        this.lastDead = false;
        this.lastGhost = false;
        this.signalWindow = false;
      }
    }
    return signals.length > 0;
  }

  /**
   * Record the sandbox's movement intention when it changed.
   *
   * The change is (move id, status): a dispatch writes one row, the verdict
   * that ends it writes a second, and every sample in between writes nothing.
   * A move whose ack has not answered yet has no id, and is keyed by its
   * dispatch time so the id arriving does not re-record it.
   */
  private noteMove(snap: SnapshotLike): void {
    const m = snap.move;
    if (m === undefined || m === null) return;
    if (typeof m.x !== "number" || typeof m.y !== "number" || typeof m.z !== "number") return;
    // Keyed on the dispatch's own timestamp, not the move id: the id is
    // learned from the ack a moment later, and keying on it would record the
    // same dispatch twice.
    const key = `${m.ts}:${m.status ?? ""}`;
    if (key === this.lastMoveKey) return;
    this.lastMoveKey = key;
    this.o.trajectory.recordMove(this.o.config.runId, {
      // The intent's own instants: when it was dispatched, and when the
      // verdict landed. The sample that carried it home is up to a tick later.
      ts: m.endedAt ?? m.ts,
      moveId: m.moveId,
      map: m.map,
      x: m.x,
      y: m.y,
      z: m.z,
      target: m.target,
      status: m.status,
    });
  }

  /**
   * Name a sample that is no longer an observation.
   *
   * The sampler reads the sandbox child's state cache, and that read is purely
   * local: it cannot fail, and a cache nothing folds into any more reads
   * exactly like a world in which nothing is happening. A run whose snippet
   * closed the child's own event stream therefore kept writing the same level,
   * the same position and the same event cursor for fifteen hours while the
   * character went on playing — recorded silently, because nothing in the path
   * had an error to raise.
   *
   * So the stall is put on the record instead: the child says its stream is
   * not open and the cursor has not moved for `OBSERVATION_STALL_SAMPLES`
   * samples in a row, which no quiet world produces — an idle character still
   * receives the world's update packets. Armed only once the cursor has moved
   * at least once, so a run whose first snippet has yet to connect is not a
   * stall. The record is then reasserted every `OBSERVATION_STALL_SAMPLES`
   * samples for as long as it holds, so a run paused hours into one ends with
   * the verdict beside its last rows rather than a single line to scroll back
   * to, and one more record says when the observation came back. The sample
   * itself is still written throughout: the last known reading is what a
   * resumed run counts its turns from, and a timeline that simply stops is its
   * own kind of lie.
   *
   * The same closed stream is what feeds the event window served each turn, so
   * this record speaks for that freeze too.
   *
   * The first record also asks the runner to pause the run
   * (`onObservationStalled`): the window before it is the reconnect ladder's,
   * and past it the rows are repetition, not play. The reassertions exist for
   * a builder with no one to ask.
   */
  private noteObservationStall(snap: SnapshotLike, turn: { turn?: number }): void {
    const eventCount = snap.eventCount ?? 0;
    const lastSeq = snap.lastSeq ?? -1;
    const cursor = { eventCount, lastSeq };
    const moved =
      this.lastCursor === null ||
      eventCount !== this.lastCursor.eventCount ||
      lastSeq !== this.lastCursor.lastSeq;
    if (eventCount > 0) this.everObserved = true;
    this.lastCursor = cursor;
    // `connected` absent is a sandbox that does not report on itself (tests, an
    // older child): no claim either way, so no stall.
    if (moved || !this.everObserved || snap.observation?.connected !== false) {
      if (this.stallRecorded) {
        this.o.trajectory.append({ t: "harness", kind: "observation_resumed", ...cursor, ...turn });
      }
      this.stalledSamples = 0;
      this.stallRecorded = false;
      return;
    }
    this.stalledSamples++;
    if (this.stalledSamples % OBSERVATION_STALL_SAMPLES !== 0) return;
    this.stallRecorded = true;
    const detail = `the sandbox event stream is closed and the observation cursor has not moved for ${this.stalledSamples} samples; every state row since is the last reading repeated, not the world`;
    this.o.trajectory.append({
      t: "harness",
      kind: "observation_stalled",
      detail,
      samples: this.stalledSamples,
      ...cursor,
      ...turn,
    });
    if (!this.stallPauseAsked && this.o.onObservationStalled !== undefined) {
      this.stallPauseAsked = true;
      this.o.onObservationStalled(detail);
    }
  }

  private async doSampleState(): Promise<SnapshotLike | null> {
    const { config, trajectory, watchdogs } = this.o;
    const snap = await this.snapshot();
    if (snap === null) return snap;
    // Ungated by `stateIntervalMs`: a ~250y walk is over well inside one state
    // row, so an intention only recorded at row cadence would be one nobody
    // could ever see in flight.
    this.noteMove(snap);
    // Ungated for the same reason `noteMove` is: the gate re-arms on a rest
    // area being left, and a rest visit can begin and end well inside one
    // state row.
    this.reflect.note(restingOf(snap));
    if (this.now() - this.lastStateAt < config.stateIntervalMs) return snap;
    this.lastStateAt = this.now();
    const pos = snap.self?.position?.value as
      | { map?: number; x?: number; y?: number; z?: number }
      | undefined;
    const level = snap.self?.level?.value as number | undefined;
    const xp = snap.xp?.value as number | undefined;
    const money = snap.money?.value as number | undefined;
    // The player frame's numbers, read off the snapshot this
    // sample already took: the SDK's derived gauges, the raw `powerType` the
    // client picks a bar with, and the XP denominator. No dead flag is written:
    // `playerFlags` is routinely a stale 0 for a whole window (see the death
    // block below), and health is the reliable reading — 0 is a corpse, 1 a
    // ghost — so a reader infers it from the gauge instead.
    const hp = gaugeOf(snap.self?.health?.value);
    const pw = gaugeOf(snap.self?.power?.value);
    const powerType = snap.self?.fields?.["powerType"]?.value;
    const nextLevelXp = snap.nextLevelXp?.value;
    // The list only grows, so anything past the high-water mark is new. One
    // compact record each; the state line carries the count, not the list.
    const completions = snap.questCompletions ?? [];
    // A shorter list means the cache was rebuilt (sandbox restart); re-log from
    // the start rather than going silent for the rest of the run.
    if (completions.length < this.questsLogged) this.questsLogged = 0;
    for (const c of completions.slice(this.questsLogged)) {
      trajectory.append({ t: "quest_complete", questId: c.questId });
    }
    this.questsLogged = completions.length;
    // Zone/area milestones, the series's first producer: ids only, from
    // the state cache, never the names — the names are client DBC text the
    // HUD renders, and a record must stay what the server said. The first
    // observed pair is a milestone from `undefined` so a run's starting zone
    // is on the record; a sample with no observation writes nothing.
    const zone = snap.self?.zone?.value as { id?: number } | undefined;
    const area = snap.self?.area?.value as { id?: number } | undefined;
    const turn = this.turn > 0 ? { turn: this.turn } : {};
    if (typeof zone?.id === "number" && zone.id !== this.lastZoneId) {
      trajectory.recordMilestone({
        kind: "zone",
        from: this.lastZoneId === undefined ? undefined : { id: this.lastZoneId },
        to: { id: zone.id },
        ...turn,
      });
      this.lastZoneId = zone.id;
    }
    if (typeof area?.id === "number" && area.id !== this.lastAreaId) {
      trajectory.recordMilestone({
        kind: "area",
        from: this.lastAreaId === undefined ? undefined : { id: this.lastAreaId },
        to: { id: area.id },
        ...turn,
      });
      this.lastAreaId = area.id;
    }
    // Achievements (issue #8): the backlog once, then one record per
    // own earn. The state cache has already dropped the say-range broadcasts
    // that were another player's, so everything here is this character's.
    const ach = snap.self?.achievements;
    if (ach !== undefined) {
      const entries = ach.entries ?? [];
      if (!this.loginAchievementsRecorded && ach.loginSeen === true) {
        const backlog = entries.filter((e) => e.source === "login");
        const ids: number[] = [];
        let points = 0;
        for (const e of backlog) {
          if (typeof e.achievementId !== "number") continue;
          ids.push(e.achievementId);
          if (typeof e.points === "number") points += e.points;
        }
        trajectory.recordMilestone({ kind: "achievements_at_login", ids, points, ...turn });
        for (const id of ids) this.recordedAchievements.add(id);
        this.loginAchievementsRecorded = true;
      }
      for (const e of entries) {
        if (e.source !== "earned" || typeof e.achievementId !== "number") continue;
        if (this.recordedAchievements.has(e.achievementId)) continue;
        trajectory.recordMilestone({
          kind: "achievement",
          id: e.achievementId,
          ...(typeof e.name === "string" ? { name: e.name } : {}),
          ...(typeof e.points === "number" ? { points: e.points } : {}),
          ...(typeof e.categoryId === "number" ? { categoryId: e.categoryId } : {}),
          ...turn,
        });
        this.recordedAchievements.add(e.achievementId);
      }
    }
    // Flights: no packet says "a flight began", so the flip is read the way a
    // client reads it — an accepted reply, then the taxi flag turning on.
    // The flag turning off is the landing, recorded whether or not
    // the takeoff was seen, because it is its own observation.
    const taxiFlight = snap.self?.taxiFlight?.value;
    if (typeof taxiFlight === "boolean") {
      const accepted = (snap.self?.taxiReply?.value as { ok?: unknown } | undefined)?.ok === true;
      if (this.lastTaxiFlight === false && taxiFlight && accepted) {
        trajectory.recordMilestone({
          kind: "taxi",
          ...(typeof area?.id === "number" ? { from: { areaId: area.id } } : {}),
          ...turn,
        });
      } else if (this.lastTaxiFlight === true && !taxiFlight) {
        trajectory.recordMilestone({
          kind: "taxi_landed",
          ...(typeof area?.id === "number" ? { to: { areaId: area.id } } : {}),
          ...turn,
        });
      }
      this.lastTaxiFlight = taxiFlight;
    }
    // Level: `self.level` on change, with the XP reading at the
    // moment the new level was first seen. The first observation is a mark from
    // `undefined` for the same reason the first zone is one — a run's starting
    // level belongs on the record — so a level-up is a mark that carries a
    // `from`, never simply a mark, and a resumed process's own first mark
    // (which also carries none) cannot be counted as a gain.
    if (typeof level === "number" && level !== this.lastLevel) {
      trajectory.recordMilestone({
        kind: "level",
        from: this.lastLevel,
        to: level,
        ...(typeof xp === "number" ? { xp } : {}),
        ...turn,
      });
      this.lastLevel = level;
    }
    // Spells, talents and trades. All three are reads over
    // what the state cache already holds — the spellbook, the last
    // `SMSG_TALENTS_INFO`, the trade window — so nothing here observes the
    // world beyond what the sample already took.
    //
    // The spellbook is written the way the achievement backlog is: the first
    // sample that sees a book at all is the baseline (`spells_at_login`), and
    // everything appearing afterwards is a learn. A book seen empty is not a
    // baseline — the cache has simply not had `SMSG_INITIAL_SPELLS` yet, and
    // taking it as one would make the whole book arrive as fresh learns a
    // moment later.
    const book = snap.spells ?? [];
    if (book.length > 0) {
      const ids = book.map((s) => s?.spellId).filter((id): id is number => typeof id === "number");
      if (!this.loginSpellsRecorded) {
        this.loginSpellsRecorded = true;
        for (const id of ids) this.recordedSpells.add(id);
        trajectory.recordMilestone({ kind: "spells_at_login", ids: [...ids].sort((a, b) => a - b), ...turn });
      } else {
        for (const id of ids) {
          if (this.recordedSpells.has(id)) continue;
          this.recordedSpells.add(id);
          trajectory.recordMilestone({ kind: "spell", id, ...turn });
        }
      }
    }
    // Talents: a rank that climbed is a spend. The wire rank is 0-based, so
    // the record carries both it and the points it means, and a talent the
    // frame stops listing (a respec) is forgotten rather than remembered at
    // its old rank, which would swallow the relearn.
    const talents = snap.talents;
    if (talents !== undefined && talents !== null) {
      const rows = (talents.talents ?? []).filter(
        (t): t is { talentId: number; rank: number } =>
          typeof t?.talentId === "number" && typeof t?.rank === "number",
      );
      const spec = typeof talents.activeSpec === "number" ? talents.activeSpec : undefined;
      const seen = new Set<number>();
      for (const t of rows) {
        seen.add(t.talentId);
        const prev = this.talentRanks.get(t.talentId);
        if (prev !== undefined && t.rank <= prev) {
          if (t.rank < prev) this.talentRanks.set(t.talentId, t.rank);
          continue;
        }
        this.talentRanks.set(t.talentId, t.rank);
        if (!this.talentsSeeded) continue;
        trajectory.recordMilestone({
          kind: "talent",
          id: t.talentId,
          points: t.rank + 1,
          rank: t.rank,
          ...(spec === undefined ? {} : { spec }),
          ...turn,
        });
      }
      for (const id of [...this.talentRanks.keys()]) if (!seen.has(id)) this.talentRanks.delete(id);
      this.talentsSeeded = true;
    }
    // Trades: `TRADE_STATUS_TRADE_COMPLETE` (8) latches on the trade window and
    // nothing clears it until the next trade packet, so a sample landing any
    // time after the completion still sees it. Keyed on the cache's own stamp
    // rather than its `seq`, which restarts when a session is recreated.
    const trade = snap.trade;
    if (trade !== undefined && trade !== null && trade.status === TRADE_STATUS_COMPLETE) {
      // A completion with no stamp has no dedup key, and re-writing it on
      // every sample for the rest of the run would be worse than missing it.
      const tradeTs = typeof trade.ts === "number" ? trade.ts : undefined;
      if (tradeTs !== undefined && tradeTs !== this.lastTradeTs) {
        this.lastTradeTs = tradeTs;
        trajectory.recordMilestone({ kind: "trade", observedTs: tradeTs, ...turn });
      }
    }
    // Death: the transitions the sandbox child latched off the
    // events themselves, drained here and written as they happened. The child
    // sees every event; this sample lands every `stateIntervalMs`, and a whole
    // death — die, repop, walk to the Spirit Healer, resurrect — fits between
    // two samples. Run `fleet-sonnet-low-freeplay-sonnet-low-20260827-a2` lost
    // three deaths that way, one of them by a single second, which is what the
    // window read below cannot fix by tuning: the cache keeps no residue once
    // the resurrect clears it.
    //
    // Applied in order and updating the same latches the window read uses, so
    // two complete cycles inside one gap are two deaths, and so the window read
    // that follows sees the state these signals left and repeats nothing.
    const drained = await this.applyDeathSignals(trajectory, turn, zone?.id, area?.id);
    // The signals own this sample's window if one is still open, and they own
    // it for the rest of *this* sample even when they closed it: `snap` was
    // taken before the drain, so a window that opened and closed whole still
    // reads as a corpse here, and that corpse is already on the record.
    const signalsOwnWindow = this.signalWindow || drained;
    // The same window, still read from the sample, as the fallback it now is,
    // and silent about anything the signals are already accounting for.
    //
    // Read as a *window* rather than as a health edge.
    // A sample lands every `stateIntervalMs`, so an edge detector would see
    // almost no deaths at all; but the cache latches the corpse, the graveyard
    // and the reclaim delay from the death until the resurrect clears them, so
    // any sample inside the window still sees it and can stamp the death with
    // the cache's own timestamp instead of the sample's. A death that opened
    // and closed entirely between two samples leaves nothing — the same lower
    // bound the zone and flight records carry.
    //
    // Health comes off the raw field, not the derived gauge: `deriveGauges`
    // withholds the gauge until `maxHealth` has been seen, and the ghost bit is
    // read off `playerFlags` exactly as the HUD reads it.
    const playerFlags = snap.self?.fields?.["playerFlags"]?.value;
    const ghost =
      typeof playerFlags === "number" ? (playerFlags & PLAYER_FLAGS_GHOST) !== 0 : undefined;
    const health = snap.self?.fields?.["health"]?.value;
    const corpse = snap.self?.corpse;
    const dead = ghost === true || health === 0 || corpse !== undefined;
    if (this.lastDead === undefined) {
      this.lastDead = dead;
      this.lastGhost = ghost;
    } else {
      if (dead && !this.lastDead && !signalsOwnWindow) {
        const c = corpse?.value as
          | { map?: number; x?: number; y?: number; z?: number; source?: unknown }
          | undefined;
        const source: "corpse_query" | "death_spot" | undefined =
          c?.source === "corpse_query" ? "corpse_query" : c?.source === "death_spot" ? "death_spot" : undefined;
        const site =
          c !== undefined &&
          source !== undefined &&
          typeof c.map === "number" &&
          typeof c.x === "number" &&
          typeof c.y === "number" &&
          typeof c.z === "number"
            ? { map: c.map, x: c.x, y: c.y, z: c.z, source }
            : undefined;
        const observedTs = corpse?.ts ?? snap.self?.reclaimDelay?.ts;
        trajectory.recordMilestone({
          kind: "death",
          ...(typeof observedTs === "number" ? { observedTs } : {}),
          ...(site === undefined ? {} : { position: site }),
          ...(typeof zone?.id === "number" ? { zone: { id: zone.id } } : {}),
          ...(typeof area?.id === "number" ? { area: { id: area.id } } : {}),
          ...(ghost === undefined ? {} : { released: ghost }),
          ...turn,
        });
      }
      if (ghost === true && this.lastGhost === false && !signalsOwnWindow) {
        const g = snap.self?.graveyard?.value as
          | { map?: number; x?: number; y?: number; z?: number }
          | undefined;
        trajectory.recordMilestone({
          kind: "release",
          ...(g !== undefined &&
          typeof g.map === "number" &&
          typeof g.x === "number" &&
          typeof g.y === "number" &&
          typeof g.z === "number"
            ? { graveyard: { map: g.map, x: g.x, y: g.y, z: g.z } }
            : {}),
          ...turn,
        });
      } else if (ghost === false && this.lastGhost === true && !signalsOwnWindow) {
        trajectory.recordMilestone({ kind: "resurrect", ...turn });
      }
      this.lastDead = dead;
      // An unobserved flag leaves the last reading standing rather than
      // erasing it: "we did not see playerFlags this sample" is not "not a ghost".
      if (ghost !== undefined) this.lastGhost = ghost;
    }
    this.noteObservationStall(snap, turn);
    trajectory.recordState(config.runId, {
      level,
      xp,
      map: pos?.map,
      x: pos?.x,
      y: pos?.y,
      z: pos?.z,
      eventCount: snap.eventCount,
      lastSeq: snap.lastSeq,
      money,
      questsCompleted: completions.length,
      ...turn,
      zone: zone?.id,
      area: area?.id,
      items: itemSample(snap),
      health: hp?.current,
      maxHealth: hp?.max,
      power: pw?.current,
      maxPower: pw?.max,
      ...(typeof powerType === "number" ? { powerType } : {}),
      ...(typeof nextLevelXp === "number" ? { nextLevelXp } : {}),
    });
    if (this.live) watchdogs.noteProgress(level, xp);
    return snap;
  }

  /**
   * One turn's user context message. Records the periodic state line and the
   * `events_served` trajectory record as a side effect, exactly as the loop
   * did before this was extracted.
   */
  async build(turn: number, pendingNotices: HarnessNotice[]): Promise<string> {
    this.noteTurn(turn);
    const snap = await this.sampleState();
    // The reflection window's per-turn bookkeeping, in the one hook both
    // drivers share: count this turn against an open window (the breaker), then
    // write whatever transitions the gate has accumulated — the sample above
    // may have closed one by observing the character leave the rest area.
    this.reflect.noteTurn();
    for (const e of this.reflect.drainEvents()) {
      this.o.trajectory.append({ t: "reflect_window", turn: this.turn, ...e });
      if (e.event === "close" && e.reason === "breaker") {
        pendingNotices.push({ ts: this.now(), kind: "reflect_ended", text: REFLECT_BREAKER_NOTICE });
      }
    }
    pendingNotices.push(...this.o.sandbox.drainNotices());
    let events: Parameters<typeof assembleContext>[0]["events"] = [];
    try {
      events = await this.o.sandbox.recentEvents(CONTEXT_POLICY.EVENT_WINDOW);
    } catch {
      // sandbox mid-restart: an empty window is honest
    }
    const contextText = assembleContext({
      stateSummary: formatStateSummary(snap, { sessionLive: this.live }),
      events,
      workspace: this.o.workspace.view(),
      notices: pendingNotices.splice(0, pendingNotices.length),
      turn,
    });
    this.o.trajectory.append({ t: "events_served", via: "context", count: events.length, events });
    return contextText;
  }
}

/** Default cadence of the state ticker: coarse, and independent of `stateIntervalMs`. */
export const DEFAULT_STATE_TICK_MS = 5_000;

export interface StateTickerOptions {
  builder: ContextBuilder;
  /** Cadence of the tick itself; `stateIntervalMs` still gates whether a row is written. */
  tickMs?: number | undefined;
  /** True once the episode is over: the ticker goes quiet without waiting to be cleared. */
  stopped: () => boolean;
  /**
   * Run after each completed sample. The claude driver uses it to *enforce* the
   * watchdogs mid-turn (it can kill the CLI from outside the turn); the fixed
   * loop does not — it enforces at the turn boundary, so the episode clock keeps
   * the semantics it has always had. Feeding the watchdogs is not this hook's
   * job: `sampleState` does that itself, on every driver.
   */
  onSample?: (() => void) | undefined;
}

/**
 * Sample the world on a timer, independent of turn boundaries.
 *
 * A driver turn is one HTTP request or one CLI session, and either can run for
 * minutes: 485s was observed against a local model, leaving an eight-minute
 * hole with no state row and no XP signal. Sampling only side
 * of a turn is therefore not sampling on the clock at all, so both drivers run
 * this and neither implements its own.
 *
 * The tick is coarse and the `stateIntervalMs` gate inside `sampleState` decides
 * whether a row is actually written; `sampleState`'s own mutex means a tick that
 * lands on the turn preamble joins that sample rather than racing it. The timer
 * is unref'd, so it can never hold the process open, and the returned stop must
 * be called on every exit path — a live ticker outliving `runLoop` would write
 * to a closed trajectory.
 */
export function startStateTicker(o: StateTickerOptions): () => Promise<void> {
  let sampling: Promise<unknown> | null = null;
  const timer = setInterval(() => {
    if (sampling !== null || o.stopped()) return;
    sampling = o.builder
      .sampleState()
      .catch(() => null)
      .finally(() => {
        sampling = null;
        if (!o.stopped()) o.onSample?.();
      });
  }, o.tickMs ?? DEFAULT_STATE_TICK_MS);
  timer.unref?.();
  // Awaited, because `clearInterval` does not cancel a sample already waiting on
  // the sandbox: the caller closes the trajectory as soon as the episode ends,
  // and a sample landing after that would write to a closed handle. The trailing
  // sample keeps its row — it is a real observation — but `stopped()` gates
  // `onSample`, so it cannot enforce anything after the outcome is decided.
  return async () => {
    clearInterval(timer);
    await sampling?.catch(() => undefined);
  };
}

export async function runLoop(o: LoopOptions): Promise<LoopOutcome> {
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const { config, trajectory, watchdogs } = o;
  const runId = config.runId;

  // Append-only. The model-visible window is a pure function of it: no trim
  // state accumulates, so a rebuilt history cuts identically.
  const history: ChatMessage[] = [];
  const pendingNotices: HarnessNotice[] = [...(o.initialNotices ?? [])];
  const builder = new ContextBuilder({
    config,
    sandbox: o.sandbox,
    workspace: o.workspace,
    trajectory,
    watchdogs,
    ...(o.turnOffset !== undefined ? { turnOffset: o.turnOffset } : {}),
    ...(o.now !== undefined ? { now: o.now } : {}),
    onObservationStalled: o.onObservationStalled,
  });

  let turn = 0;
  const toolCtx: ToolContext = {
    sandbox: o.sandbox,
    workspace: o.workspace,
    wiki: o.wiki,
    wikiCoords: config.wikiCoords,
    wikiSearch: config.wiki,
    sessionLive: () => builder.sessionLive,
    reflect: builder.reflect,
    episodic: o.episodic,
    turn: () => builder.currentTurn,
    onEpisodicEntry: (entry) => trajectory.append({ t: "episodic", ...entry }),
    onEventsServed: (events, folded) =>
      trajectory.append({
        t: "events_served",
        via: "tool",
        count: events.length,
        events,
        ...(folded !== undefined && folded > 0 ? { folded } : {}),
      }),
  };

  const terminate = (reason: TerminationReason, detail?: string): LoopOutcome => {
    trajectory.setTermination(runId, reason, detail);
    return { kind: "terminated", reason, detail };
  };
  /** The stop request, honoured: a pause keeps the run resumable, a terminate ends it. */
  const stopped = (): LoopOutcome | null => {
    const s = stopRequestOf(o.signal);
    if (s === null) return null;
    if (s.kind === "pause") {
      trajectory.setPause(runId, s.reason, s.detail, watchdogs.elapsedMs());
      return { kind: "paused", reason: s.reason, detail: s.detail };
    }
    return terminate("manual", s.detail);
  };

  /** Whether the provider's served-model id has already been promoted (first wins). */
  let promotedResolved = false;
  /**
   * Where the model-visible window started last turn. The block trim is silent
   * by construction — the model simply stops seeing the oldest messages — and a
   * model cannot plan around memory it does not know it lost, so the turn whose
   * window shrank says so in its own `[harness notices]`.
   */
  let lastCut = 0;
  // The mid-turn state clock: `build` samples once per turn, and
  // that used to be this loop's only sampling — one 485s request left an
  // 8.1-minute blackout with no state row and no XP signal. Live for the whole
  // episode, not just the model call: a turn's tool calls can be slow too, and
  // the gate inside `sampleState` keeps the row cadence fixed either way.
  // Deliberately no watchdog enforcement here, unlike the claude driver's
  // ticker: this loop reads its watchdogs at the turn boundary, the boundary is
  // never further away than the adapter's own retry budget, and a mid-request
  // kill would have to abandon a request the adapter still accounts for — the
  // ticker's job is the record, not the kill. `finished` shuts it up the instant
  // an outcome is decided, ahead of the `finally` that stops the timer.
  let finished = false;
  const stopTicker = startStateTicker({
    builder,
    tickMs: o.stateTickMs,
    stopped: () => finished || stopRequestOf(o.signal) !== null,
  });
  try {
    for (;;) {
      // 0. a stop request wins over everything, at the turn boundary
      const stop = stopped();
      if (stop !== null) return stop;
      // 1. watchdogs
      const verdict = watchdogs.check();
      if (verdict !== null) {
        trajectory.append({ t: "watchdog", ...verdict });
        return terminate(verdict.reason, verdict.detail);
      }

      // 2. state line + 3. the fixed context (context.ts)
      turn++;
      // Before `build`, which is what drains the notices: history only grows at
      // the end of a turn, so this turn's cut is already decided here, and the
      // notice belongs in the very request whose window was trimmed rather than
      // one turn after the model went blind. Purely a read of `messageWindow`'s
      // own pure cut function — the notice is an input to `assembleContext`
      // like every other, and assembly stays pure.
      const cut = messageWindowCut(history);
      // The pre-trim prompt (METHODOLOGY, "An episodic log, written before each
      // trim"): the trigger is the trim itself, not a cadence. `trimExpected`
      // is exact — the crossing has already happened and the cut lags one turn
      // behind it — so this fires on exactly the last turn before each trim,
      // once, whatever the model's per-turn message count does. No guard is
      // needed and none is kept: a guard would only be able to hide a bug here.
      if (trimExpected(history)) {
        pendingNotices.push({
          ts: o.now?.() ?? Date.now(),
          kind: "trim_pending",
          text:
            "Older conversation will be trimmed after this turn. Record a short status entry — " +
            "what you are doing and how it is going — with log_status.",
        });
      }
      if (cut > lastCut) {
        const dropped = cut - lastCut;
        pendingNotices.push({
          ts: o.now?.() ?? Date.now(),
          kind: "window_trimmed",
          text: `Older conversation was trimmed (${dropped} message${dropped === 1 ? "" : "s"} dropped); notes.md is your memory.`,
        });
        lastCut = cut;
      }
      const contextText = await builder.build(turn, pendingNotices);
      // The sample above may have been the one that found the observation
      // stalled, and the pause it asked for wins before a request is written.
      const stopBuilt = stopped();
      if (stopBuilt !== null) return stopBuilt;
      // The sample above may have been the first sight of the character; a
      // stale one ends the run here, not after a whole turn on it.
      const integrity = watchdogs.check();
      if (integrity !== null && integrity.reason === "stale-character") {
        trajectory.append({ t: "watchdog", ...integrity });
        return terminate(integrity.reason, integrity.detail);
      }

      const messages: ChatMessage[] = [
        { role: "system", content: buildSystemPrompt(config.objective, config.episode, harnessOf(config.driver), config.wiki) },
        ...messageWindow(history),
        { role: "user", content: contextText },
      ];

      // 4. model request
      trajectory.append({ t: "request", turn, adapter: o.adapter.label, messages });
      const outcome = await o.adapter.complete({ messages, tools: toolsFor({ wikiCoords: config.wikiCoords, wikiSearch: config.wiki }), signal: o.signal });
      if (outcome.kind === "stub-complete") return terminate("stub-complete");
      if (outcome.kind === "pause") {
        trajectory.setPause(runId, outcome.reason, outcome.detail, watchdogs.elapsedMs());
        return { kind: "paused", reason: outcome.reason, detail: outcome.detail };
      }
      watchdogs.noteModelOutput();
      const assistant: ChatMessage = {
        role: "assistant",
        content: outcome.turn.content,
        ...(outcome.turn.toolCalls.length > 0
          ? {
              tool_calls: outcome.turn.toolCalls.map((tc) => ({
                id: tc.id,
                type: "function" as const,
                function: { name: tc.name, arguments: tc.arguments },
              })),
            }
          : {}),
      };
      // The backend that actually served the call, when the response body names
      // one (OpenRouter's top-level `provider`). Logged because cache-miss
      // attribution is impossible without it: an aggregator
      // routing the same model across backends legitimately zeroes the prompt
      // cache, and a cost sweep must be able to tell that from harness prefix
      // instability without replaying per-generation API lookups.
      const servedBy = (outcome.turn.raw as { provider?: unknown } | null | undefined)?.provider;
      /*
       * The model the provider says it served, off the same response body. An
       * aggregator answers a request for one slug with the id it actually
       * routed to, and that — not the config string — is what a chart needs to
       * name. Recorded on the record and promoted onto the run the first time,
       * the same fact the claude-code harness reads out of its `init` event.
       */
      const servedModel = (outcome.turn.raw as { model?: unknown } | null | undefined)?.model;
      // One promotion, on the first response that names either fact: the
      // provider is the answer to the routing the tuple stamped (2026-09-16),
      // and a run whose request pinned one backend and whose response names
      // another is the one case a reader has to be able to see. Promoted with
      // the model rather than on its own so the flag still means "the run has
      // been annotated", and so a per-turn meta read stays a per-run one.
      const namedModel = typeof servedModel === "string" && servedModel.length > 0;
      const namedProvider = typeof servedBy === "string" && servedBy.length > 0;
      if ((namedModel || namedProvider) && !promotedResolved) {
        promotedResolved = true;
        trajectory.recordResolved(runId, {
          ...(namedModel ? { model: servedModel as string } : {}),
          ...(namedProvider ? { provider: servedBy as string } : {}),
        });
      }
      trajectory.append({
        t: "response",
        turn,
        message: assistant,
        // Only when the provider reported it; absent otherwise, so the viewer
        // keeps falling back to its estimate rather than reading a zero.
        ...(outcome.turn.usage !== undefined ? { usage: outcome.turn.usage } : {}),
        ...(typeof servedBy === "string" && servedBy.length > 0 ? { provider: servedBy } : {}),
        ...(typeof servedModel === "string" && servedModel.length > 0 ? { model: servedModel } : {}),
        ...(outcome.turn.providerRequestId !== undefined
          ? { providerRequestId: outcome.turn.providerRequestId }
          : {}),
        ...(outcome.turn.finishReason !== undefined ? { finishReason: outcome.turn.finishReason } : {}),
      });
      history.push(assistant);

      // A "length" finish is the provider truncating the turn, possibly mid
      // tool-call JSON — which would otherwise reach the model as an ordinary
      // argument error and be scored as its mistake (2026-08-22 API review).
      // Tell the model plainly so a retry with less output is its own choice,
      // not a mystery.
      if (outcome.turn.finishReason === "length") {
        pendingNotices.push({
          ts: o.now?.() ?? Date.now(),
          kind: "provider_truncated",
          text: "your last turn was cut off by the provider's output limit (finish_reason: length) — any tool call in it may be incomplete; keep replies shorter, and re-issue anything that did not take effect",
        });
      }

      // 5. execute tool calls in order
      for (const tc of outcome.turn.toolCalls) {
        // A stop between tool calls: the calls already made are in the
        // trajectory; the ones not made are simply not made (a resumed run
        // starts a new turn, so nothing dangles).
        const stopMid = stopped();
        if (stopMid !== null) return stopMid;
        let args: unknown = {};
        let argError: string | null = null;
        const coerced = coerceToolArgs(tc.name, tc.arguments);
        if (coerced.ok) args = coerced.args;
        else argError = coerced.error;
        // Written before the call runs, so `ts` already is the dispatch; the
        // explicit stamp is what a reader keys on, the same field the drivers
        // that record after the fact carry, so no reader infers it from shape.
        trajectory.append({ t: "tool_call", turn, name: tc.name, args: argError ?? args, dispatchTs: Date.now() });
        if (tc.name === "run_snippet" && argError === null) {
          // Log the normalized code: a model that used an alias key (cmd/snippet/
          // source/script/ts) has the real source under that key, and callTool
          // normalizes internally — so read it the same way here or the snippet
          // record (what analysis greps) is empty.
          const normalized = normalizeToolArgs(tc.name, args) as { code?: string };
          trajectory.append({ t: "snippet", turn, code: normalized.code ?? "" });
        }
        const restartsBefore = o.sandbox.totalRestarts;
        const result =
          argError !== null ? { text: argError, isError: true } : await callTool(toolCtx, tc.name, args);
        trajectory.append({
          t: tc.name === "run_snippet" ? "snippet_result" : "tool_result",
          turn,
          name: tc.name,
          isError: result.isError ?? false,
          text: result.text,
          // The reflect marker (METHODOLOGY, "Reflection is the model's to take"):
          // a granted reflection is `reflect: true` with `isError: false`, a
          // refused one `reflect: true` with `isError: true`, so a reader counts
          // reflect turns without parsing the fixed text. The turn itself still
          // counts as a turn — nothing here exempts it.
          ...(tc.name === "reflect" ? { reflect: true } : {}),
        });
        if (tc.name === "run_snippet") {
          if (o.sandbox.totalRestarts > restartsBefore) watchdogs.noteSandboxRestart();
          else if (result.isError !== true) watchdogs.noteSnippetSuccess();
        }
        history.push({ role: "tool", content: result.text, tool_call_id: tc.id });
      }

      // 6. bookkeeping and pacing
      if (config.maxTurns !== undefined && turn >= config.maxTurns) {
        return terminate("turn-limit", `${turn} turns`);
      }
      await sleep(config.stepIntervalMs);
    }
  } catch (err) {
    // An abandoned request throws; the stop request is the real outcome.
    const stop = stopped();
    if (stop !== null) return stop;
    if (err instanceof AdapterError) {
      return terminate("adapter-error", `${err.message}${err.status !== undefined ? ` (HTTP ${err.status})` : ""}`);
    }
    return terminate("harness-error", err instanceof Error ? `${err.name}: ${err.message}` : String(err));
  } finally {
    finished = true;
    // A window still open when the episode ends is closed on the record rather
    // than left dangling; the gate is per-episode, so nothing outlives this.
    builder.reflect.close("run_end");
    for (const e of builder.reflect.drainEvents()) {
      trajectory.append({ t: "reflect_window", turn: builder.currentTurn, ...e });
    }
    await stopTicker();
  }
}

/** Equipment slots are 0-18 in the player's `invSlot<n>` numbering; 19-22 are worn bags. */
const EQUIPMENT_LAST_SLOT = 18;

/**
 * The `items` column of a state sample: what is worn (inventory slots 0-18)
 * and what is carried (`bag()` across every bag). A row whose name has not been
 * answered yet is kept under its item id so the count stays honest.
 * `undefined` when the snapshot carries no inventory.
 *
 * Each row carries where it sits and what it is — `slot`, `bag` (carried only),
 * `itemId`, `quality` — because a paperdoll and a bag grid are drawn from the
 * sample, not guessed from an order. Every one of those is written only when the
 * snapshot actually carried it: a slot whose item create block or item query has
 * not arrived yet is an occupied slot with no id, and the field is left off the
 * row rather than filled with a zero.
 */
export function itemSample(snap: SnapshotLike): ItemSample[] | undefined {
  const inv = snap.inventory;
  const bag = snap.bag?.items;
  if (inv === undefined && bag === undefined) return undefined;
  const out: ItemSample[] = [];
  const label = (name: unknown, itemId: unknown, fallback: string): string =>
    typeof name === "string" ? name : itemId != null ? `item ${String(itemId)}` : fallback;
  /** An optional numeric field, present only when the snapshot carried a number. */
  const opt = (key: "itemId" | "quality" | "slot" | "bag", v: unknown): { [k: string]: number } =>
    typeof v === "number" ? { [key]: v } : {};
  for (const i of inv ?? []) {
    if (typeof i.slot !== "number" || i.slot > EQUIPMENT_LAST_SLOT) continue;
    const count = typeof i.stackCount === "number" ? i.stackCount : 1;
    out.push({
      name: label(i.name, i.itemId, `slot ${i.slot}`),
      count,
      equipped: true,
      ...opt("itemId", i.itemId),
      ...opt("quality", i.quality),
      // Worn: `slot` is the equipment slot and there is no `bag`.
      slot: i.slot,
    });
  }
  for (const i of bag ?? []) {
    const count = typeof i.count === "number" ? i.count : 1;
    out.push({
      name: label(i.name, i.itemId, `slot ${String(i.slot)}`),
      count,
      equipped: false,
      ...opt("itemId", i.itemId),
      ...opt("quality", i.quality),
      // Carried: the `bag`/`slot` pair the item actions take, unchanged.
      ...opt("slot", i.slot),
      ...opt("bag", i.bag),
    });
  }
  return out;
}

/**
 * A `{ current, max }` gauge off an `Observed.value`, or undefined.
 *
 * The SDK's `deriveGauges` publishes a gauge only once both halves have been
 * observed, so this either yields a whole pair or nothing — a ratio is never
 * read from a half-seen field.
 */
export function gaugeOf(v: unknown): { current: number; max: number } | undefined {
  if (typeof v !== "object" || v === null) return undefined;
  const g = v as { current?: unknown; max?: unknown };
  return typeof g.current === "number" && typeof g.max === "number"
    ? { current: g.current, max: g.max }
    : undefined;
}
