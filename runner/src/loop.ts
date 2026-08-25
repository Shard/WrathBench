/**
 * The agent loop: model-agnostic driver. One iteration = one model request
 * with the fixed context (context.ts), then execution of whatever tool calls
 * came back, then fixed pacing. No per-model branches, prompts, or retries —
 * the only thing that varies between runs is the adapter config (ADR-0004).
 */

import type { Database } from "bun:sqlite";
import { AdapterError, type ChatAdapter } from "./adapter";
import {
  CONTEXT_POLICY,
  assembleContext,
  formatStateSummary,
  messageWindow,
  type ChatMessage,
  type SnapshotLike,
} from "./context";
import { buildSystemPrompt } from "./prompt";
import { callTool, coerceToolArgs, normalizeToolArgs, toolsFor, type ToolContext } from "./tools";
import type { PauseReason, RunConfig, TerminationReason } from "./config";
import type { HarnessNotice, SandboxHost } from "./sandbox/host";
import type { Scratchpad } from "./scratchpad";
import type { ItemSample, Trajectory } from "./trajectory";
import type { Watchdogs } from "./watchdogs";

export interface LoopOptions {
  config: RunConfig & { runId: string; token: string };
  adapter: ChatAdapter;
  sandbox: SandboxHost;
  scratchpad: Scratchpad;
  wiki?: Database | undefined;
  trajectory: Trajectory;
  watchdogs: Watchdogs;
  /** Shown to the model on the first turn (e.g. "runner restarted, resuming"). */
  initialNotices?: HarnessNotice[];
  /** Turns this run recorded before this process; see `ContextBuilderOptions`. */
  turnOffset?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
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
}

/**
 * The per-turn preamble, shared by every driver: snapshot state, emit the
 * periodic state line, gather the event window and assemble the fixed context
 * message (ADR-0012). It lives in one place precisely because it *is* the
 * context policy — a driver that assembled its own would be per-model tuning.
 */
export class ContextBuilder {
  private lastStateAt = 0;
  private live = false;
  /** High-water mark into the snapshot's quest-completion list, for logging. */
  private questsLogged = 0;
  /** Last zone/area ids a milestone was written for; undefined until the first sample names one. */
  private lastZoneId: number | undefined;
  private lastAreaId: number | undefined;
  /**
   * Achievement ids already written as a milestone, and whether the login
   * backlog record has been written (ADR-0048).
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
   * The driver turn currently in flight, stamped onto every state sample.
   *
   * Set by the driver rather than counted here: the fixed loop and the
   * claude-code driver each own their own turn counter, and a sample
   * is taken on the clock (`stateIntervalMs`), not once per turn. Zero means
   * "before the first turn", which is recorded as no turn at all.
   */
  private turn = 0;
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

  async snapshot(): Promise<SnapshotLike | null> {
    try {
      const snap = (await this.o.sandbox.stateSnapshot()) as SnapshotLike;
      const wasLive = this.live;
      this.live = snap.self?.guid !== undefined && snap.self.guid !== null;
      if (this.live && !wasLive) {
        // The first sight of a character in the world: the fresh-episode
        // precondition (ADR-0006) is judged here, once, by the watchdogs.
        this.o.watchdogs.noteFirstLive({
          guid: snap.self?.guid === undefined || snap.self.guid === null ? undefined : String(snap.self.guid),
          level: snap.self?.level?.value as number | undefined,
        });
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

  private async doSampleState(): Promise<SnapshotLike | null> {
    const { config, trajectory, watchdogs } = this.o;
    const snap = await this.snapshot();
    if (snap === null || this.now() - this.lastStateAt < config.stateIntervalMs) return snap;
    this.lastStateAt = this.now();
    const pos = snap.self?.position?.value as
      | { map?: number; x?: number; y?: number; z?: number }
      | undefined;
    const level = snap.self?.level?.value as number | undefined;
    const xp = snap.xp?.value as number | undefined;
    const money = snap.money?.value as number | undefined;
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
    // Zone/area milestones (FOLLOW-UPS 35's first producer): ids only, from
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
    // Achievements (ADR-0048, issue #8): the backlog once, then one record per
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
    // client reads it — an accepted reply, then the taxi flag turning on
    // (ADR-0048). The flag turning off is the landing, recorded whether or not
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
      scratchpad: this.o.scratchpad.read(),
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
 * hole with no state row and no XP signal (FOLLOW-UPS 77). Sampling only side
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

  // Append-only. The model-visible window is a pure function of it (ADR-0012
  // addendum): no trim state accumulates, so a rebuilt history cuts identically.
  const history: ChatMessage[] = [];
  const pendingNotices: HarnessNotice[] = [...(o.initialNotices ?? [])];
  const builder = new ContextBuilder({
    config,
    sandbox: o.sandbox,
    scratchpad: o.scratchpad,
    trajectory,
    watchdogs,
    ...(o.turnOffset !== undefined ? { turnOffset: o.turnOffset } : {}),
    ...(o.now !== undefined ? { now: o.now } : {}),
  });

  const toolCtx: ToolContext = {
    sandbox: o.sandbox,
    scratchpad: o.scratchpad,
    wiki: o.wiki,
    wikiCoords: config.wikiCoords,
    sessionLive: () => builder.sessionLive,
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

  let turn = 0;
  // Live for the whole episode, not just the model call: a turn's tool calls can
  // be slow too, and the gate inside `sampleState` keeps the row cadence fixed
  // either way. `finished` shuts it up the instant an outcome is decided, ahead
  // of the `finally` that clears the timer.
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

      // 2. state line + 3. the fixed context (ADR-0012)
      turn++;
      const contextText = await builder.build(turn, pendingNotices);
      // The sample above may have been the first sight of the character; a
      // stale one ends the run here, not after a whole turn on it.
      const integrity = watchdogs.check();
      if (integrity !== null && integrity.reason === "stale-character") {
        trajectory.append({ t: "watchdog", ...integrity });
        return terminate(integrity.reason, integrity.detail);
      }

      const messages: ChatMessage[] = [
        { role: "system", content: buildSystemPrompt(config.objective, config.episode) },
        ...messageWindow(history),
        { role: "user", content: contextText },
      ];

      // 4. model request
      trajectory.append({ t: "request", turn, adapter: o.adapter.label, messages });
      const outcome = await o.adapter.complete({ messages, tools: toolsFor(config), signal: o.signal });
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
      // attribution is impossible without it (FOLLOW-UPS 78): an aggregator
      // routing the same model across backends legitimately zeroes the prompt
      // cache, and a cost sweep must be able to tell that from harness prefix
      // instability without replaying per-generation API lookups.
      const servedBy = (outcome.turn.raw as { provider?: unknown } | null | undefined)?.provider;
      trajectory.append({
        t: "response",
        turn,
        message: assistant,
        // Only when the provider reported it; absent otherwise, so the viewer
        // keeps falling back to its estimate rather than reading a zero.
        ...(outcome.turn.usage !== undefined ? { usage: outcome.turn.usage } : {}),
        ...(typeof servedBy === "string" && servedBy.length > 0 ? { provider: servedBy } : {}),
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
        trajectory.append({ t: "tool_call", turn, name: tc.name, args: argError ?? args });
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
    await stopTicker();
  }
}

/** Equipment slots are 0-18 in the player's `invSlot<n>` numbering; 19-22 are worn bags. */
const EQUIPMENT_LAST_SLOT = 18;

/**
 * The `items` column of a state sample: what is worn (inventory slots 0-18)
 * and what is carried (`bag()` across every bag), names and counts only. A
 * row whose name has not been answered yet is kept under its item id so the
 * count stays honest. `undefined` when the snapshot carries no inventory.
 */
export function itemSample(snap: SnapshotLike): ItemSample[] | undefined {
  const inv = snap.inventory;
  const bag = snap.bag?.items;
  if (inv === undefined && bag === undefined) return undefined;
  const out: ItemSample[] = [];
  const label = (name: unknown, itemId: unknown, fallback: string): string =>
    typeof name === "string" ? name : itemId != null ? `item ${String(itemId)}` : fallback;
  for (const i of inv ?? []) {
    if (typeof i.slot !== "number" || i.slot > EQUIPMENT_LAST_SLOT) continue;
    const count = typeof i.stackCount === "number" ? i.stackCount : 1;
    out.push({ name: label(i.name, i.itemId, `slot ${i.slot}`), count, equipped: true });
  }
  for (const i of bag ?? []) {
    const count = typeof i.count === "number" ? i.count : 1;
    out.push({ name: label(i.name, i.itemId, `slot ${String(i.slot)}`), count, equipped: false });
  }
  return out;
}
