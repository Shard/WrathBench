/**
 * The agent loop: model-agnostic driver. One iteration = one model request
 * with the fixed context (context.ts), then execution of whatever tool calls
 * came back, then fixed pacing. No per-model branches, prompts, or retries —
 * the only thing that varies between runs is the adapter config.
 */

import type { Database } from "bun:sqlite";
import { AdapterError, type AssistantTurn, type ChatAdapter } from "./adapter";
import {
  CONTEXT_POLICY,
  assembleContext,
  eventWindow,
  eventsPart,
  formatStateSummary,
  messageWindow,
  messageWindowCut,
  messageWindowFold,
  trimExpected,
  type ChatMessage,
  type HistoryMessage,
  type ThreadContext,
  type SnapshotLike,
} from "./context";
import { REFLECT_BREAKER_NOTICE, ReflectGate, restingOf, taxiFlightOf } from "./reflect";
import type { EpisodicLog } from "./episodic";
import { buildSystemPrompt, programPromptOf } from "./prompt";
import { fixedLoopRequestRecord } from "./request-record";
import { appendPendingActionHints, callTool, coerceToolArgs, normalizeToolArgs, toolsFor, type ToolContext } from "./tools";
import { digestCharacter, PLAIN_FANOUT_RENDER, type CharacterDigest, type FanoutSurface } from "@wrathbench/mcp/fanout";
import { harnessOf } from "./config";
import { SUBSCRIPTION_PAUSE } from "./lapse";
import { describeWindows, thresholdsOf, type SubscriptionUsage, type UsageHold } from "./subscription-usage";
import { goOverageOf } from "./opencode-go";
import { isOpenCodeGoBase } from "./platform";
import type { PauseReason, RunConfig, TerminationReason } from "./config";
import type { HarnessNotice, SandboxHost } from "./sandbox/host";
import type { ContextEvents } from "./sandbox/signals";
import type { PartySignal } from "./sandbox/signals";
import type { Scratchpad } from "@wrathbench/mcp";
import type { Trajectory } from "./trajectory";
import type { Watchdogs } from "./watchdogs";
import { WAKE_CAP_MS, type ProgramWake } from "./wake";

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
  scratchpad: Scratchpad;
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
  /**
   * The run's subscription allowance, when it draws on one through this loop
   * (OpenCode Go: `GoUsageGauge`, opencode-go.ts). Poked at each turn boundary
   * and never waited on there; a freeplay run stops at the boundary once its
   * lane reaches the freeplay threshold (`subscription-budget`), and a
   * `quota-exhausted` pause with no stated reset waits for the spent window's
   * (operator, 2026-10-16). Absent on every other run.
   */
  usage?: UsageGauge | undefined;
  /**
   * The program loop's waking (`wake.ts`), on a run with `loop: "program"`:
   * made before the sandbox, whose program's facts it takes, and slept
   * through here. Absent on the snippet loop, which never sleeps.
   */
  programWake?: ProgramWake | undefined;
}

/** What the loop asks of a subscription allowance it runs on (`LoopOptions.usage`). */
export interface UsageGauge {
  /** Refresh in the background when due; never awaited by a turn. */
  poke(): void;
  /** The hold at `threshold` percent off the newest reading, or null. */
  freeplayHold(threshold: number, now: number): UsageHold | null;
  /** A spent allowance's reset, capped, with the spent window recorded; undefined when none is known. */
  quotaReset(now: number): Promise<number | undefined>;
  /** A response billed past the allowance (`goOverageOf`): record the allowance as spent. */
  overage?(now: number): void;
  readonly current: SubscriptionUsage | undefined;
}

/**
 * What an abort signal's `reason` carries when the runner is asked to stop.
 * A string reason (older callers, tests) reads as a `manual` termination.
 */
export type StopRequest =
  | { kind: "pause"; reason: PauseReason; detail: string }
  | { kind: "terminate"; detail: string };

/**
 * A model turn as the history keeps it and every later request replays it:
 * the message the `response` record carries.
 *
 * A turn with tool calls, or with text, is the provider's own message as it
 * came back. A turn with neither — a reasoning-only answer, whose reasoning
 * the openai driver does not carry — is replayed with `content: ""`, not
 * `null`: an assistant message with null content and no `tool_calls` is not a
 * valid chat message, and strict providers refuse the whole request for it
 * (an OpenCode Go upstream answered 400 "messages[32] assistant must provide
 * content, reasoning_content or tool_calls"). The empty string is the faithful
 * spelling of "said nothing"; the turn is kept rather than dropped because a
 * turn appends exactly one assistant message, which the window cut, the
 * request record's `fromTurn` and the replay's history rebuild all count on.
 *
 * The normalisation happens here, at the source, so the `response` record
 * carries what is sent, and a replay of an older trajectory, whose records
 * carry `null`, still rebuilds the bytes that trajectory sent.
 */
export function replayedAssistant(turn: Pick<AssistantTurn, "content" | "toolCalls">): ChatMessage {
  const hasCalls = turn.toolCalls.length > 0;
  return {
    role: "assistant",
    content: turn.content === null && !hasCalls ? "" : turn.content,
    ...(hasCalls
      ? {
          tool_calls: turn.toolCalls.map((tc) => ({
            id: tc.id,
            type: "function" as const,
            function: { name: tc.name, arguments: tc.arguments },
          })),
        }
      : {}),
  };
}

export function stopRequestOf(signal: AbortSignal | undefined): StopRequest | null {
  if (signal === undefined || !signal.aborted) return null;
  const r: unknown = signal.reason;
  if (typeof r === "object" && r !== null && (r as { kind?: unknown }).kind === "pause") return r as StopRequest;
  if (typeof r === "object" && r !== null && (r as { kind?: unknown }).kind === "terminate") return r as StopRequest;
  return { kind: "terminate", detail: typeof r === "string" ? r : "aborted" };
}

export type LoopOutcome =
  | { kind: "terminated"; reason: TerminationReason; detail?: string }
  /** `notBefore`: the provider's stated reset, when the adapter carried one (adapter.ts). */
  | { kind: "paused"; reason: PauseReason; detail?: string; notBefore?: number };

export interface ContextBuilderOptions {
  config: RunConfig & { runId: string };
  sandbox: SandboxHost;
  scratchpad: Scratchpad;
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
  /** Every state sample this builder takes, as it is taken: the program loop's wake reads the stream and the level off it. */
  onSample?: ((snap: SnapshotLike) => void) | undefined;
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
   * a rest area or land to re-arm, and no reflect call is made while that
   * happens.
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

  /**
   * A fan-out run's sample (`fanout-run.ts`): the stack's brief of every
   * character (`stateBriefs`), reduced to its digests, and one reading in a snapshot's shape for
   * what acts on the run while it plays. The run is live once any character
   * is in the world; the stall detector is fed the streams' combined cursor
   * and whether every one of them is open. No level or xp: whose level ends
   * a fan-out run is its eval's to say, so a level end and the no-XP watchdog
   * read nothing here, and the freshness tripwire and the run's one recorded
   * character name, both a single character's, are left alone.
   */
  private fanoutDigests: CharacterDigest[] = [];
  private async fanoutSnapshot(roster: FanoutSurface): Promise<SnapshotLike | null> {
    try {
      const inWorld = roster.views().some((v) => v.state === "in");
      const snaps = inWorld ? await roster.sandbox.stateBriefs() : {};
      this.fanoutDigests = Object.entries(snaps).map(([name, snap]) => digestCharacter(name, snap));
      this.live = this.fanoutDigests.some((d) => d.inWorld);
      let eventCount = 0;
      let lastSeq = -1;
      for (const snap of Object.values(snaps)) {
        const s = snap as SnapshotLike;
        eventCount += s.eventCount ?? 0;
        lastSeq += (s.lastSeq ?? -1) + 1;
      }
      return { eventCount, lastSeq, observation: { connected: this.fanoutDigests.every((d) => d.connected) } } as SnapshotLike;
    } catch {
      return null;
    }
  }

  async snapshot(): Promise<SnapshotLike | null> {
    const roster = this.o.sandbox.roster;
    if (roster !== undefined) return this.fanoutSnapshot(roster);
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
          await this.o.trajectory.setCharacter(this.o.config.runId, name);
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
   * Hand the watchdogs the kills the session record wrote since the last tick
   * (`RecordSignals`, through `SandboxHost.partySignals`): a campaign's kill
   * end reads them. The record itself is the stack's (`session/events`); the
   * loop writes nothing of it. A sandbox without the drain (a test's fake)
   * hands none.
   */
  private async drainKills(): Promise<void> {
    const sandbox = this.o.sandbox as SandboxHost & { partySignals?: () => Promise<PartySignal[]> };
    if (typeof sandbox.partySignals !== "function") return;
    let signals: PartySignal[];
    try {
      signals = await sandbox.partySignals();
    } catch {
      return;
    }
    if (!this.live) return;
    for (const s of signals) if (s.kind === "kill") this.o.watchdogs.noteKill(s);
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
    const { config, watchdogs } = this.o;
    const snap = await this.snapshot();
    if (snap === null) return snap;
    this.o.onSample?.(snap);
    // Ungated by `stateIntervalMs`: the gate re-arms on a rest visit or a
    // flight beginning, and either can begin and end well inside one sample.
    this.reflect.note(restingOf(snap), taxiFlightOf(snap));
    // The kills, ungated too: a `kill` is what a campaign's kill end reads,
    // and drained only at the sample cadence it reached the end check up to a
    // whole `stateIntervalMs` late — deadmines@4's members ended 2 to 22
    // seconds apart on one VanCleef packet, the last after the roster had
    // already stopped it. Drained on every tick instead.
    await this.drainKills();
    if (this.now() - this.lastStateAt < config.stateIntervalMs) return snap;
    this.lastStateAt = this.now();
    // What the character reads is the session record's to write (the trace
    // and its events, `session/`); the sample only feeds the watchdogs and
    // the stall detector, which act on the run while it plays.
    const level = snap.self?.level?.value as number | undefined;
    const xp = snap.xp?.value as number | undefined;
    this.noteObservationStall(snap, this.turn > 0 ? { turn: this.turn } : {});
    if (this.live) watchdogs.noteProgress(level, xp);
    return snap;
  }

  /**
   * One turn's user context message. Records the periodic state line and the
   * `events_served` trajectory record as a side effect, exactly as the loop
   * did before this was extracted.
   */
  async build(turn: number, pendingNotices: HarnessNotice[], wake?: string, thread?: ThreadContext): Promise<string> {
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
    // The window: ambient movement excluded first, then the last EVENT_WINDOW
    // of what remains (context.ts, `isAmbientEvent`). The child keeps
    // those in a ring of their own; a sandbox without it (an older child, a
    // test's fake) is read the old way, over its raw tail.
    const sandbox = this.o.sandbox as SandboxHost & { contextEvents?: (limit: number) => Promise<ContextEvents> };
    const roster = this.o.sandbox.roster;
    let fetched: ContextEvents = { events: [], folded: 0 };
    try {
      // A fan-out run's turn carries no event window: the window is one
      // character's stream, and which of several streams a turn should show,
      // and how, is the harness round's to decide. `recent_events` serves the
      // merged feed on request.
      fetched =
        roster !== undefined
          ? { events: [], folded: 0 }
          : typeof sandbox.contextEvents === "function"
          ? await sandbox.contextEvents(CONTEXT_POLICY.EVENT_WINDOW)
          : { events: await sandbox.recentEvents(CONTEXT_POLICY.EVENT_WINDOW), folded: 0 };
    } catch {
      // sandbox mid-restart: an empty window is honest
    }
    const { window: events, folded } = eventWindow(fetched.events, fetched.folded);
    // A scaffold's thread context (`ThreadContext`): the pad only when the
    // thread does not hold it as it is (D8), and only the events newer than
    // the last one it was sent.
    const scratchpad = this.o.scratchpad.read();
    const padUnchanged = thread !== undefined && !thread.pad.sendWhole(scratchpad);
    const eventsHeld = thread?.events.held();
    const shownEvents = eventsPart(events, folded, eventsHeld);
    thread?.events.carried(shownEvents.shown);
    // Scrubbed of the run's registered secrets as a whole, after the pure
    // assembly: a notice (the crash notice's stderr tail), a chat line or an
    // event a snippet's text came back in, and the scratchpad all reach the
    // model, and the request record, as `[redacted]` (tools.ts scrubs tool
    // results the same way, `ToolContext.secrets`).
    const contextText = this.o.trajectory.scrub(
      assembleContext({
        // A fan-out run's state is the stack's roll-up, in its plain default wording.
        stateSummary:
          roster !== undefined
            ? PLAIN_FANOUT_RENDER.rollup(this.fanoutDigests, { maxCharacters: roster.maxCharacters, views: roster.views() })
            : formatStateSummary(snap, { sessionLive: this.live }),
        events,
        folded,
        scratchpad,
        notices: pendingNotices.splice(0, pendingNotices.length),
        turn,
        ...(wake !== undefined ? { wake } : {}),
        ...(padUnchanged ? { scratchpadUnchanged: true } : {}),
        ...(eventsHeld !== undefined ? { eventsHeld } : {}),
      }),
    );
    // What the model was shown, and how many ambient events the span folded —
    // the same shape the recent_events tool logs. The ambient packets
    // themselves were never shown; logging them was most of the file.
    // Under a thread context, the events it showed: the new ones alone (`mode: "new"`), or the window resent.
    this.o.trajectory.append({
      t: "events_served",
      via: "context",
      count: shownEvents.shown.length,
      events: shownEvents.shown,
      ...(folded > 0 && shownEvents.mode !== "new" ? { folded } : {}),
      ...(shownEvents.mode !== "window" ? { mode: shownEvents.mode } : {}),
    });
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
 *
 * The session record is not this ticker's: the stack's host drains its child's
 * recorder on a tick of its own (`wrath-mcp/mcp/src/sandbox/host.ts`).
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

/** A verdict's row write that gave up after its retries; `runLoop` rethrows `error` instead of re-terminating. */
class VerdictWriteFailed extends Error {
  constructor(readonly error: unknown) {
    super(error instanceof Error ? error.message : String(error));
  }
}

export async function runLoop(o: LoopOptions): Promise<LoopOutcome> {
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const { config, trajectory, watchdogs } = o;
  const runId = config.runId;
  // Only the freeplay threshold is the loop's to act on (`subscription-usage.ts`).
  const usageThresholds = thresholdsOf(config.usageMaxPct);
  // The first reading, early: a turn's boundary will want it.
  o.usage?.poke();

  // Append-only. The model-visible window is a pure function of it: no trim
  // state accumulates, so a rebuilt history cuts identically.
  const history: HistoryMessage[] = [];
  const pendingNotices: HarnessNotice[] = [...(o.initialNotices ?? [])];
  const builder = new ContextBuilder({
    config,
    sandbox: o.sandbox,
    scratchpad: o.scratchpad,
    trajectory,
    watchdogs,
    ...(o.turnOffset !== undefined ? { turnOffset: o.turnOffset } : {}),
    ...(o.now !== undefined ? { now: o.now } : {}),
    onObservationStalled: o.onObservationStalled,
    ...(o.programWake !== undefined ? { onSample: (snap: SnapshotLike) => o.programWake!.onSample(snap) } : {}),
  });

  /*
   * The program loop (`loop: "program"`): the model's routines run in the
   * sandbox's program whether it is awake or not, a reply with no tool call
   * sleeps until a wake (`wake.ts`) instead of re-prompting after the step
   * interval, and the wake's block opens every request of the wake that
   * follows. Absent on the snippet loop, which this function runs exactly as
   * it always has.
   */
  const programPrompt = programPromptOf(config);
  const programTools = programPrompt !== undefined ? { yield: programPrompt.yield } : undefined;
  const program = programPrompt !== undefined ? o.sandbox.program : undefined;
  const programWake = o.programWake;
  if (programPrompt !== undefined && (program === undefined || programWake === undefined)) {
    throw new Error("loop: \"program\" needs a sandbox that hosts a program and the run's wake (run.ts)");
  }
  /** The block of the last turn-end wake, on every request until the model sleeps again. */
  let currentWake: string | undefined;
  /** A sleep ends on a stop request or a watchdog verdict as well as a wake: neither waits out five minutes. */
  const sleepStopped = (): boolean => stopRequestOf(o.signal) !== null || watchdogs.check() !== null;

  let turn = 0;
  const toolCtx: ToolContext = {
    sandbox: o.sandbox,
    // The session record's side of every tool call; absent on a sandbox that keeps none.
    ...(o.sandbox.callRecord !== undefined ? { record: o.sandbox.callRecord } : {}),
    scratchpad: o.scratchpad,
    wiki: o.wiki,
    wikiCoords: config.wikiCoords,
    wikiSearch: config.wiki,
    sessionLive: () => builder.sessionLive,
    reflect: builder.reflect,
    episodic: o.episodic,
    turn: () => builder.currentTurn,
    secrets: trajectory,
    onEpisodicEntry: (entry) => trajectory.append({ t: "episodic", ...entry }),
    ...(program !== undefined && programWake !== undefined
      ? {
          program,
          onRoutinesShown: () => programWake.routinesShown(program.routines()),
          // What a result carries of the routines' refusals, and of a death, is delivered (`ProgramWake.hintsDelivered`).
          onHintsDelivered: (hints) => programWake.hintsDelivered(hints),
          ...(programPrompt?.yield === true
            ? {
                yieldWake: async (seconds: number): Promise<string> => {
                  const woke = await programWake.sleep(program, {
                    via: "yield",
                    turn,
                    capMs: Math.min(WAKE_CAP_MS, Math.round(seconds * 1000)),
                    floorMs: config.stepIntervalMs,
                    stopped: sleepStopped,
                    queuedNotices: () => pendingNotices.length,
                    idle: watchdogs,
                  });
                  // The block is this call's result, in the history: the next request does not repeat it.
                  currentWake = undefined;
                  return woke.block;
                },
              }
            : {}),
        }
      : {}),
  };

  /**
   * A verdict's row write, awaited. The record is already appended when the
   * write is issued, so a write that gives up after its retries must leave
   * the episode as it is, carrying the runner's own reason on the record:
   * caught below as anything else is, it would be re-terminated as
   * `harness-error`, a second termination with another reason
   * (`VerdictWriteFailed`).
   */
  const recorded = async <T,>(write: Promise<T>): Promise<T> => {
    try {
      return await write;
    } catch (e) {
      throw new VerdictWriteFailed(e);
    }
  };
  const terminate = async (reason: TerminationReason, detail?: string): Promise<LoopOutcome> => {
    await recorded(trajectory.setTermination(runId, reason, detail));
    return { kind: "terminated", reason, detail };
  };
  /** The stop request, honoured: a pause keeps the run resumable, a terminate ends it. */
  const stopped = async (): Promise<LoopOutcome | null> => {
    const s = stopRequestOf(o.signal);
    if (s === null) return null;
    if (s.kind === "pause") {
      await recorded(trajectory.setPause(runId, s.reason, s.detail, watchdogs.elapsedMs()));
      return { kind: "paused", reason: s.reason, detail: s.detail };
    }
    return await terminate("manual", s.detail);
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
  /** Where the window's folded part ended last turn (`messageWindowFold`); it moves with the cut. */
  let lastFold = 0;
  /**
   * The system prompt text this process last wrote onto a request record.
   * Null until the first request, so every process segment carries the text
   * once and a replay never has to look before the segment for it.
   */
  let lastSystemText: string | null = null;
  /** Whether the last response was billed past the allowance (`goOverageOf`): its record is written once per stretch. */
  let overageStretch = false;
  // The mid-turn state clock: `build` samples once per turn, and
  // that used to be this loop's only sampling — one 485s request left an
  // 8.1-minute blackout with no state row and no XP signal. Live for the whole
  // episode, not just the model call: a turn's tool calls can be slow too, and
  // the gate inside `sampleState` keeps the row cadence fixed either way.
  // Deliberately no watchdog enforcement here, unlike the claude driver's
  // ticker: this loop reads its watchdogs at the turn boundary, the boundary is
  // never further away than the adapter's bound on one complete() (its retry
  // budget plus one request ceiling, `adapter.ts`), and a mid-request
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
      const stop = await stopped();
      if (stop !== null) return stop;
      // A restart the program was blamed for counts toward snippet-runaway as a snippet's does.
      if (programWake !== undefined) for (let k = programWake.takeBlamedRestarts(); k > 0; k--) watchdogs.noteSandboxRestart();
      // 1. watchdogs
      const verdict = watchdogs.check();
      if (verdict !== null) {
        trajectory.append({ t: "watchdog", ...verdict });
        return await terminate(verdict.reason, verdict.detail);
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
      const fold = messageWindowFold(history);
      // The pre-trim prompt (METHODOLOGY, "An episodic log, asked for at each
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
            "Older conversation will be trimmed, and older tool results folded to one-line records, after this turn. " +
            "Record a short status entry — " +
            "what you are doing and how it is going — with log_status.",
        });
      }
      if (cut > lastCut) {
        const dropped = cut - lastCut;
        // The results this trim folded: those still in the window that were
        // verbatim last turn. The fold only ever moves on a trim, so this is
        // the one notice that can say so.
        let folded = 0;
        for (let k = Math.max(cut, lastFold); k < fold; k++) if (history[k]!.role === "tool") folded++;
        const foldNote = folded > 0 ? `, ${folded} older tool result${folded === 1 ? "" : "s"} folded to one-line records` : "";
        pendingNotices.push({
          ts: o.now?.() ?? Date.now(),
          kind: "window_trimmed",
          text: `Older conversation was trimmed (${dropped} message${dropped === 1 ? "" : "s"} dropped${foldNote}); your scratchpad is your memory.`,
        });
        lastCut = cut;
      }
      lastFold = fold;
      const contextText = await builder.build(turn, pendingNotices, currentWake);
      // What this context shows (the HUD, the notices) is no longer a reason to wake.
      programWake?.shown();
      // The sample above may have been the one that found the observation
      // stalled, and the pause it asked for wins before a request is written.
      const stopBuilt = await stopped();
      if (stopBuilt !== null) return stopBuilt;
      // The sample above may have been the first sight of the character; a
      // stale one ends the run here, not after a whole turn on it.
      const integrity = watchdogs.check();
      if (integrity !== null && integrity.reason === "stale-character") {
        trajectory.append({ t: "watchdog", ...integrity });
        return await terminate(integrity.reason, integrity.detail);
      }

      const systemText = buildSystemPrompt(config.objective, config.episode, harnessOf(config.driver), config.wiki, config.watchdogs.episodeMs, programPrompt);
      const messages: ChatMessage[] = [
        { role: "system", content: systemText },
        ...messageWindow(history),
        { role: "user", content: contextText },
      ];

      // 4. model request. The record keeps the fresh user message and points
      // at the rest — the system text (written once per process, and again if
      // it changes) and the window, which is records already on the file — with
      // a hash of the bytes sent (`request-record.ts`). Nothing about what is
      // sent changes: `messages` is built above exactly as before and is only read here.
      const { record, mismatch } = fixedLoopRequestRecord({
        turn,
        adapter: o.adapter.label,
        messages,
        history,
        from: cut,
        foldTo: fold,
        withSystemText: systemText !== lastSystemText,
      });
      trajectory.append(record as { t: string });
      if (mismatch === null) {
        // Only a slim record carries the text: a fallback full record has none
        // to register, so the next slim request must carry it again.
        lastSystemText = systemText;
      } else {
        trajectory.append({ t: "harness", kind: "request_replay_mismatch", turn, detail: mismatch });
      }
      const outcome = await o.adapter.complete({ messages, tools: toolsFor({ wikiCoords: config.wikiCoords, wikiSearch: config.wiki, sandbox: o.sandbox, programTools }), signal: o.signal });
      if (outcome.kind === "stub-complete") return await terminate("stub-complete");
      if (outcome.kind === "pause") {
        // A spent subscription allowance waits for its window's reset when the
        // lane's own reading names one (decision 2: no attempt against a quota
        // known to be empty).
        let notBefore = outcome.notBefore;
        let detail = outcome.detail;
        if (notBefore === undefined && outcome.reason === "quota-exhausted" && o.usage !== undefined) {
          notBefore = await o.usage.quotaReset(Date.now());
          if (notBefore !== undefined) detail = `${detail} (usage window resets ${new Date(notBefore).toISOString()})`;
        }
        await recorded(trajectory.setPause(runId, outcome.reason, detail, watchdogs.elapsedMs(), notBefore));
        return {
          kind: "paused",
          reason: outcome.reason,
          detail,
          ...(notBefore !== undefined ? { notBefore } : {}),
        };
      }
      watchdogs.noteModelOutput();
      const assistant = replayedAssistant(outcome.turn);
      // The backend that actually served the call, when the response body names
      // one (OpenRouter's top-level `provider`). Logged because cache-miss
      // attribution is impossible without it: an aggregator
      // routing the same model across backends legitimately zeroes the prompt
      // cache, and a cost sweep must be able to tell that from harness prefix
      // instability without replaying per-generation API lookups.
      // OpenCode names the backend in headers instead (`served`, adapter.ts),
      // and where the endpoint states it there it is the answer, ahead of the body.
      const servedBy = outcome.turn.served?.provider ?? (outcome.turn.raw as { provider?: unknown } | null | undefined)?.provider;
      /*
       * The model the provider says it served, off the same response body. An
       * aggregator answers a request for one slug with the id it actually
       * routed to, and that — not the config string — is what a chart needs to
       * name. Recorded on the record and promoted onto the run the first time,
       * the same fact the claude-code harness reads out of its `init` event.
       */
      // OpenCode's body echoes the id asked for; its upstream's own id is the header's.
      const servedModel = outcome.turn.served?.model ?? (outcome.turn.raw as { model?: unknown } | null | undefined)?.model;
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
        // The provider's own usage object beside it, bounded to numbers, for
        // reconciling a bill against fields the normalisation has no name for
        // (docs/COSTS.md). Record-only: it never reaches `assistant` or history.
        ...(outcome.turn.usageRaw !== undefined ? { usageRaw: outcome.turn.usageRaw } : {}),
        ...(typeof servedBy === "string" && servedBy.length > 0 ? { provider: servedBy } : {}),
        ...(typeof servedModel === "string" && servedModel.length > 0 ? { model: servedModel } : {}),
        ...(outcome.turn.providerRequestId !== undefined
          ? { providerRequestId: outcome.turn.providerRequestId }
          : {}),
        ...(outcome.turn.finishReason !== undefined ? { finishReason: outcome.turn.finishReason } : {}),
      });
      history.push(assistant);

      // A response billed to the provider's balance past the allowance
      // (OpenCode Go's Extra Usage, `billing_source: "balance"`) is money, not
      // allowance: recorded — on the record once per stretch, in meta.json each
      // time, where the fleet reads it and holds the credential — and the
      // allowance marked spent, so a freeplay run stops at this boundary
      // (`opencode-go.ts`). A scored run plays on: pausing it would spend its
      // attempt. Go's only: Zen sends the same field, where the balance is how it bills.
      if (isOpenCodeGoBase(config.apiBase) && goOverageOf(outcome.turn.raw)) {
        const at = o.now?.() ?? Date.now();
        trajectory.recordCredentialOverage(config.credential ?? null, at, { turn, record: !overageStretch });
        overageStretch = true;
        o.usage?.overage?.(at);
      } else {
        overageStretch = false;
      }

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
        const stopMid = await stopped();
        if (stopMid !== null) return stopMid;
        let args: unknown = {};
        let argError: string | null = null;
        const coerced = coerceToolArgs(tc.name, tc.arguments, programTools);
        if (coerced.ok) args = coerced.args;
        else argError = coerced.error;
        // Written before the call runs, so `ts` already is the dispatch; the
        // explicit stamp is what a reader keys on, the same field the drivers
        // that record after the fact carry, so no reader infers it from shape.
        const dispatchTs = Date.now();
        trajectory.append({ t: "tool_call", turn, name: tc.name, args: argError ?? args, dispatchTs });
        if (tc.name === "run_snippet" && argError === null) {
          // Log the normalized code: a model that used an alias key (cmd/snippet/
          // source/script/ts) has the real source under that key, and callTool
          // normalizes internally — so read it the same way here or the snippet
          // record (what analysis greps) is empty.
          const normalized = normalizeToolArgs(tc.name, args, programTools) as { code?: string };
          trajectory.append({ t: "snippet", turn, code: normalized.code ?? "" });
        }
        const restartsBefore = o.sandbox.totalRestarts;
        // An unparseable call is still a tool result the model reads, so the
        // pending hints ride it as they would any other (`callTool`).
        const result =
          argError !== null
            ? await appendPendingActionHints(toolCtx, { text: argError, isError: true })
            : await callTool(toolCtx, tc.name, args, { dispatchTs });
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
        // `isError` is the history's own, for the fold's line; the window never sends it.
        history.push({ role: "tool", content: result.text, tool_call_id: tc.id, isError: result.isError ?? false });
      }

      // 6. bookkeeping and pacing
      if (config.maxTurns !== undefined && turn >= config.maxTurns) {
        return await terminate("turn-limit", `${turn} turns`);
      }
      // The usage budget at the turn boundary (operator, 2026-10-16): a
      // freeplay run on a credential at or over its freeplay threshold stops until
      // the window resets. A scored run never: pausing it would spend its
      // attempt. The reading is refreshed in the background, never awaited.
      if (o.usage !== undefined) {
        o.usage.poke();
        if (config.episode === "freeplay") {
          const now = Date.now();
          const hold = o.usage.freeplayHold(usageThresholds.freeplay, now);
          if (hold !== null) {
            const detail = `subscription usage at or over the freeplay threshold (${hold.threshold}%): ${describeWindows(hold.windows, o.usage.current?.observedAt ?? now)}`;
            await recorded(trajectory.setPause(runId, SUBSCRIPTION_PAUSE, detail, watchdogs.elapsedMs(), hold.until));
            return { kind: "paused", reason: SUBSCRIPTION_PAUSE, detail, notBefore: hold.until };
          }
        }
      }
      if (program !== undefined && programWake !== undefined && outcome.turn.toolCalls.length === 0) {
        // The program loop: a reply with no tool call sleeps until a wake,
        // and the wake's block opens every request until the next sleep.
        const woke = await programWake.sleep(program, {
          via: "turn-end",
          turn,
          capMs: WAKE_CAP_MS,
          floorMs: config.stepIntervalMs,
          stopped: sleepStopped,
          queuedNotices: () => pendingNotices.length,
          idle: watchdogs,
        });
        currentWake = woke.block;
        continue;
      }
      await sleep(config.stepIntervalMs);
    }
  } catch (err) {
    // A verdict on record whose row write gave up: the episode ends with it.
    if (err instanceof VerdictWriteFailed) throw err.error;
    // An abandoned request throws; the stop request is the real outcome.
    const stop = await stopped();
    if (stop !== null) return stop;
    if (err instanceof AdapterError) {
      return await terminate("adapter-error", `${err.message}${err.status !== undefined ? ` (HTTP ${err.status})` : ""}`);
    }
    return await terminate("harness-error", err instanceof Error ? `${err.name}: ${err.message}` : String(err));
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

