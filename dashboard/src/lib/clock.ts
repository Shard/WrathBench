/**
 * A 1 Hz wall-clock signal, for anything that ages between polls.
 *
 * `StatusBadge`'s heartbeat age and the map's "last update" both need to tick
 * on their own — the data they read only changes on a poll, but the reader is
 * watching the seconds count up in between. Three call sites carried the same
 * `createSignal` + `setInterval` + `onCleanup` before this; RunDetail's is
 * left alone for the next pass (it is mid-edit elsewhere).
 */

import { createSignal, onCleanup } from "solid-js";

export function useClock(intervalMs = 1000): () => number {
  const [now, setNow] = createSignal(Date.now());
  const timer = setInterval(() => setNow(Date.now()), intervalMs);
  onCleanup(() => clearInterval(timer));
  return now;
}
