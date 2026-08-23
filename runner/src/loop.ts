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
import type { Trajectory } from "./trajectory";
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
   */
  async sampleState(): Promise<SnapshotLike | null> {
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
      trajectory.append({
        t: "response",
        turn,
        message: assistant,
        // Only when the provider reported it; absent otherwise, so the viewer
        // keeps falling back to its estimate rather than reading a zero.
        ...(outcome.turn.usage !== undefined ? { usage: outcome.turn.usage } : {}),
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
  }
}
