/**
 * The service status badge, top right of every page: a dot, a word, and a
 * popout of the handful of facts behind them. Derivation is in
 * `lib/status.ts`; this is the button and the popout's open/close.
 *
 * The popout is a `menu`-style disclosure: it opens on click or Enter/Space
 * (a real button, so the keyboard gets it for free), closes on Escape, on a
 * click outside, and on navigation, and is anchored under the badge by CSS.
 */

import { For, Show, createEffect, createSignal, onCleanup } from "solid-js";
import { useLocation } from "@solidjs/router";
import { useFeeds } from "../lib/feeds";
import { serviceStatus, statusRows } from "../lib/status";

export function StatusBadge() {
  const feeds = useFeeds();
  const location = useLocation();
  const [open, setOpen] = createSignal(false);
  // The badge's own clock: the heartbeat's age must tick without a poll.
  const [now, setNow] = createSignal(Date.now());
  const timer = setInterval(() => setNow(Date.now()), 1000);
  onCleanup(() => clearInterval(timer));

  const input = () => ({ fleet: feeds.fleet.latest, error: feeds.fleet.error });
  const status = () => serviceStatus(input(), now());
  const rows = () => statusRows(input(), feeds.info.latest, now());

  let root: HTMLDivElement | undefined;
  const onDocClick = (e: MouseEvent): void => {
    if (root !== undefined && !root.contains(e.target as Node)) setOpen(false);
  };
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === "Escape") setOpen(false);
  };
  createEffect(() => {
    if (!open()) return;
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    onCleanup(() => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    });
  });
  // A route change is a fresh page; the popout does not follow it.
  createEffect(() => {
    location.pathname;
    setOpen(false);
  });

  return (
    <div class="status" ref={root}>
      <button
        type="button"
        class={`status-badge ${status().tone}`}
        aria-haspopup="dialog"
        aria-expanded={open()}
        aria-controls="status-popout"
        title="service status"
        onClick={() => setOpen(!open())}
      >
        <span class={`dot ${status().tone}`} />
        {status().word}
      </button>
      <Show when={open()}>
        <div id="status-popout" class="status-popout" role="dialog" aria-label="service status">
          <dl>
            <For each={rows()}>
              {(r) => (
                <>
                  <dt>{r.label}</dt>
                  <dd title={r.title ?? ""}>{r.value}</dd>
                </>
              )}
            </For>
          </dl>
        </div>
      </Show>
    </div>
  );
}
