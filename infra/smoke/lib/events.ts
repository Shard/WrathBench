/**
 * The event stream as the raw-HTTP smokes read it: a `/events` socket whose
 * frames land in the smoke's own buffer, and a poll of that buffer for the
 * event a step waits on. The SDK-driven smokes have the client's own
 * `events.waitFor` instead.
 */

import { authHeaders } from "./auth";

/**
 * Open `/events` under `token` at the module's WebSocket origin `ws`. Each
 * frame is parsed and handed to `onEvent`; a frame that does not parse, or an
 * `onEvent` that throws, goes to `onUnparseable` with the raw text, and is
 * dropped silently without one, as the smokes always have.
 */
export function openEventStream(ws: string, token: string, onEvent: (e: any) => void, onUnparseable?: (raw: string) => void): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const sock = new WebSocket(`${ws}/events?token=${encodeURIComponent(token)}`, { headers: authHeaders() });
    sock.addEventListener("open", () => resolve(sock));
    sock.addEventListener("error", (e) => reject(new Error(`ws error: ${String(e)}`)));
    sock.addEventListener("message", (ev) => {
      try {
        onEvent(JSON.parse(String(ev.data)));
      } catch {
        onUnparseable?.(String(ev.data));
      }
    });
  });
}

/**
 * The first event in `buf` from index `from` that `pred` matches, polled
 * every `pollMs` until `timeoutMs` has passed; then the smoke's own `fail`
 * with `timed out waiting for <what>`.
 */
export async function waitForEvent(
  buf: readonly any[],
  pred: (e: any) => boolean,
  timeoutMs: number,
  what: string,
  fail: (msg: string) => never,
  o: { from?: number; pollMs?: number } = {},
): Promise<any> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    for (let i = o.from ?? 0; i < buf.length; ++i) if (pred(buf[i])) return buf[i];
    if (Date.now() > deadline) fail(`timed out waiting for ${what}`);
    await Bun.sleep(o.pollMs ?? 100);
  }
}

/** Whether `done` came true within `ms`, checked every 50ms. */
export async function until(ms: number, done: () => boolean): Promise<boolean> {
  const by = Date.now() + ms;
  while (!done()) {
    if (Date.now() > by) return false;
    await Bun.sleep(50);
  }
  return true;
}
