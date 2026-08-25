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
   * How often the world is sampled while a turn is in flight (a model request
   * or a tool call can hold the turn for minutes). Defaults to the same 5s
   * tick the claude-code driver uses; tests shrink it. Recording stays
   * throttled by `stateIntervalMs` regardless.
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
 * message. It lives in one place precisely because it *is* the
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
   * The driver turn currently in flight, stamped onto every state sample.
   *
   * Set by the driver rather than counted here: the fixed loop and the
   * claude-code driver each own their own turn counter, and a sample
   * is taken on the clock (`stateIntervalMs`), not once per turn. Zero means
   * "before the first turn", which is recorded as no turn at all.
   */
  private turn = 0;
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

  async snapshot(): Promise<SnapshotLike | null> {
    try {
      const snap = (await this.o.sandbox.stateSnapshot()) as SnapshotLike;
      this.live = snap.self?.guid !== undefined && snap.self.guid !== null;
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
  sampleState(): Promise<SnapshotLike | null> {
    this.sampling ??= this.sampleOnce().finally(() => {
      this.sampling = null;
    });
    return this.sampling;
  }

  private async sampleOnce(): Promise<SnapshotLike | null> {
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

/**
 * The mid-turn state clock, shared by both drivers (FOLLOW-UPS 77): sampling
 * only at the turn boundary leaves everything inside a long turn invisible —
 * the claude-code driver's turns run tens of minutes, and one 485s model
 * request on the openai-compatible path left an 8-minute blackout in a run's
 * timeline. The ticker samples on wall clock while a turn is in flight;
 * `ContextBuilder.sampleState` throttles what is *recorded* to
 * `stateIntervalMs`, so a fast tick costs snapshots, never duplicate rows.
 *
 * Ticks never overlap (a slow sample makes later ticks no-ops rather than a
 * queue), a failed sample is dropped (the sandbox may be mid-restart, and the
 * next tick tries again), and `stop()` resolves only after any in-flight tick
 * has settled — so nothing appends to the trajectory after the episode has
 * been finalised and the trajectory closed. The sample itself is bounded (the
 * sandbox RPC has its own timeout), so awaiting it cannot park a shutdown.
 */
export function startStateTicker(o: {
  sample: () => Promise<unknown>;
  intervalMs: number;
  /** Skip ticking entirely (the claude driver: episode already ended). */
  done?: (() => boolean) | undefined;
  /** After every tick, even a failed one (the claude driver checks watchdogs here). */
  afterSample?: (() => void) | undefined;
}): { stop: () => Promise<void> } {
  let inFlight: Promise<void> | null = null;
  const timer = setInterval(() => {
    if (inFlight !== null || o.done?.() === true) return;
    inFlight = o
      .sample()
      .catch(() => null)
      .then(() => o.afterSample?.())
      .catch(() => undefined)
      .finally(() => {
        inFlight = null;
      });
  }, o.intervalMs);
  // Observability must never be what keeps the process alive.
  timer.unref?.();
  return {
    stop: async () => {
      clearInterval(timer);
      await inFlight;
    },
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

  // The mid-turn state clock (FOLLOW-UPS 77): `build` samples once per turn,
  // and that used to be this loop's only sampling — one 485s request left an
  // 8.1-minute blackout with no state row and no XP signal. The ticker keeps
  // state rows and the no-xp progress signal flowing while `adapter.complete`
  // or a long tool call holds the turn. Deliberately no watchdog enforcement
  // here, unlike the claude driver's ticker: this loop reads its watchdogs at
  // the turn boundary, the boundary is never further away than the adapter's
  // own retry budget, and a mid-request kill would have to abandon a request
  // the adapter still accounts for — the ticker's job is the record, not the
  // kill.
  const ticker = startStateTicker({
    sample: () => builder.sampleState(),
    intervalMs: o.stateTickMs ?? 5_000,
  });

  let turn = 0;
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
      const contextText = await builder.build(turn, pendingNotices);

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
    await ticker.stop();
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
