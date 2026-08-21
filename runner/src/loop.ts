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
  trimMessageWindow,
  type ChatMessage,
  type SnapshotLike,
} from "./context";
import { SYSTEM_PROMPT } from "./prompt";
import { TOOLS, callTool, type ToolContext } from "./tools";
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
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export type LoopOutcome =
  | { kind: "terminated"; reason: TerminationReason; detail?: string }
  | { kind: "paused"; reason: PauseReason; detail?: string };

export async function runLoop(o: LoopOptions): Promise<LoopOutcome> {
  const now = o.now ?? Date.now;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const { config, trajectory, watchdogs } = o;
  const runId = config.runId;

  let sessionLive = false;
  let lastStateAt = 0;
  let window: ChatMessage[] = [];
  const pendingNotices: HarnessNotice[] = [...(o.initialNotices ?? [])];

  const toolCtx: ToolContext = {
    sandbox: o.sandbox,
    scratchpad: o.scratchpad,
    wiki: o.wiki,
    sessionLive: () => sessionLive,
    onEventsServed: (events) =>
      trajectory.append({ t: "events_served", via: "tool", count: events.length, events }),
  };

  const terminate = (reason: TerminationReason, detail?: string): LoopOutcome => {
    trajectory.setTermination(runId, reason, detail);
    return { kind: "terminated", reason, detail };
  };

  const snapshotState = async (): Promise<SnapshotLike | null> => {
    try {
      const snap = (await o.sandbox.stateSnapshot()) as SnapshotLike;
      sessionLive = snap.self?.guid !== undefined && snap.self.guid !== null;
      return snap;
    } catch {
      return null;
    }
  };

  let turn = 0;
  try {
    for (;;) {
      // 1. watchdogs
      const verdict = watchdogs.check();
      if (verdict !== null) {
        trajectory.append({ t: "watchdog", ...verdict });
        return terminate(verdict.reason, verdict.detail);
      }

      // 2. periodic state line
      const snap = await snapshotState();
      if (snap !== null && now() - lastStateAt >= config.stateIntervalMs) {
        lastStateAt = now();
        const pos = snap.self?.position?.value as
          | { map?: number; x?: number; y?: number; z?: number }
          | undefined;
        const level = snap.self?.level?.value as number | undefined;
        trajectory.recordState(runId, {
          level,
          map: pos?.map,
          x: pos?.x,
          y: pos?.y,
          z: pos?.z,
          eventCount: snap.eventCount,
          lastSeq: snap.lastSeq,
        });
        if (sessionLive) watchdogs.noteProgress(level, undefined);
      }

      // 3. assemble the fixed context
      turn++;
      pendingNotices.push(...o.sandbox.drainNotices());
      let events: Parameters<typeof assembleContext>[0]["events"] = [];
      try {
        events = await o.sandbox.recentEvents(CONTEXT_POLICY.EVENT_WINDOW);
      } catch {
        // sandbox mid-restart: an empty window is honest
      }
      const contextText = assembleContext({
        stateSummary: formatStateSummary(snap, { sessionLive }),
        events,
        scratchpad: o.scratchpad.read(),
        notices: pendingNotices.splice(0, pendingNotices.length),
        turn,
      });
      trajectory.append({ t: "events_served", via: "context", count: events.length, events });

      const messages: ChatMessage[] = [
        { role: "system", content: SYSTEM_PROMPT },
        ...window,
        { role: "user", content: contextText },
      ];

      // 4. model request
      trajectory.append({ t: "request", turn, adapter: o.adapter.label, messages });
      const outcome = await o.adapter.complete({ messages, tools: TOOLS });
      if (outcome.kind === "stub-complete") return terminate("stub-complete");
      if (outcome.kind === "pause") {
        trajectory.setPause(runId, outcome.reason, outcome.detail);
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
      trajectory.append({ t: "response", turn, message: assistant });
      window.push(assistant);

      // 5. execute tool calls in order
      for (const tc of outcome.turn.toolCalls) {
        let args: unknown = {};
        let argError: string | null = null;
        try {
          args = tc.arguments.trim().length === 0 ? {} : JSON.parse(tc.arguments);
        } catch (err) {
          argError = `tool arguments were not valid JSON: ${String(err)}`;
        }
        trajectory.append({ t: "tool_call", turn, name: tc.name, args: argError ?? args });
        if (tc.name === "run_snippet" && argError === null) {
          trajectory.append({ t: "snippet", turn, code: (args as { code?: string }).code ?? "" });
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
        window.push({ role: "tool", content: result.text, tool_call_id: tc.id });
      }

      window = trimMessageWindow(window);

      // 6. bookkeeping and pacing
      if (config.maxTurns !== undefined && turn >= config.maxTurns) {
        return terminate("turn-limit", `${turn} turns`);
      }
      await sleep(config.stepIntervalMs);
    }
  } catch (err) {
    if (err instanceof AdapterError) {
      return terminate("adapter-error", `${err.message}${err.status !== undefined ? ` (HTTP ${err.status})` : ""}`);
    }
    return terminate("harness-error", err instanceof Error ? `${err.name}: ${err.message}` : String(err));
  }
}
