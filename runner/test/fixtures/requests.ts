/**
 * What each `request` record of a test trajectory stood for, as the model saw
 * it: a full record's own message array, a slim one rebuilt through the replay
 * (`runner/src/replay.ts`). A slim request that does not rebuild to the bytes
 * its hash names throws, so a test reading prompts through this also proves
 * they replay.
 */

import type { ChatMessage } from "../../src/context";
import { Replayer } from "../../src/replay";
import { readTrajectory } from "../../src/trajectory";

export interface SentRequest {
  /** The record as written. */
  record: Record<string, unknown>;
  messages: ChatMessage[];
}

export function requestsOf(dir: string): SentRequest[] {
  const replayer = new Replayer();
  const out: SentRequest[] = [];
  readTrajectory(dir).forEach((rec, k) => {
    const taken = replayer.take(rec, k + 1);
    if (rec.t !== "request") return;
    if (taken === null) {
      out.push({ record: rec, messages: (rec["messages"] as ChatMessage[] | undefined) ?? [] });
      return;
    }
    if (!taken.verdict.ok || taken.messages === undefined) {
      throw new Error(`request on line ${k + 1} did not replay: ${taken.verdict.detail ?? "no messages"}`);
    }
    out.push({ record: rec, messages: taken.messages });
  });
  return out;
}

/** The fresh user message of every request, in order. */
export function userMessagesOf(dir: string): string[] {
  return requestsOf(dir).map((r) => String(r.messages[r.messages.length - 1]?.content ?? ""));
}
