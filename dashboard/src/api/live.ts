/**
 * The live tail, as a Solid resource-friendly subscription.
 *
 * The viewer already streams new entries over SSE (`/api/run/<id>/stream`), so
 * this is a thin adapter rather than a second protocol: the server sends a
 * hello, then either a batch of entries or a heartbeat tick every second. The
 * heartbeat exists so a proxy or a fetch timeout cannot mistake a quiet run for
 * a dead connection, and it is what drives the "N seconds since anything
 * happened" line on the run page.
 */

import type { FeedEntry, TokenTotals } from "@viewer/api-types";

export interface TailMessage {
  hello?: string;
  total?: number;
  entries?: FeedEntry[];
  tokens?: TokenTotals;
  tick?: number;
}

export interface TailHandlers {
  onEntries: (entries: FeedEntry[], tokens: TokenTotals | undefined) => void;
  onTick?: (at: number) => void;
  onError?: () => void;
}

/** Subscribe to a run's tail. Returns the unsubscribe. */
export function subscribeTail(url: string, handlers: TailHandlers): () => void {
  const es = new EventSource(url);
  es.onmessage = (ev: MessageEvent<string>): void => {
    let msg: TailMessage;
    try {
      msg = JSON.parse(ev.data) as TailMessage;
    } catch {
      return;
    }
    if (msg.entries !== undefined && msg.entries.length > 0) handlers.onEntries(msg.entries, msg.tokens);
    else if (msg.tick !== undefined) handlers.onTick?.(msg.tick);
  };
  es.onerror = (): void => handlers.onError?.();
  return () => es.close();
}
