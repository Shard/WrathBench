/**
 * The service status badge, top right of every page: a dot, a word, and a
 * popout of the handful of facts behind them. Derivation is in
 * `lib/status.ts`; this is the button and the popout's open/close.
 *
 * The popout is a `menu`-style disclosure: it opens on click or Enter/Space
 * (a real button, so the keyboard gets it for free), closes on Escape, on a
 * click outside, and on navigation, and is anchored under the badge by CSS.
 *
 * It also carries the one link to the fleet page (operator, 2026-08-30), which
 * left the top bar the same day: the fleet is the ops view of the service this
 * badge already reports on, so it belongs here rather than among the pages a
 * reader came for. The route itself is unchanged.
 */

import { For, Show, createEffect, createSignal, onCleanup } from "solid-js";
import { A, useLocation } from "@solidjs/router";
import { useFeeds } from "../lib/feeds";
import { serviceStatus, statusRows } from "../lib/status";

export function StatusBadge() {
  const feeds = useFeeds();
  const location = useLocation();
  const [open, setOpen] = createSignal(false);

  /*
   * No clock of its own. Every age the badge shows is measured inside the
   * response (`lib/fleet.ts`, `heartbeatAge`), so it advances with the fleet
   * poll — five seconds, the same granularity the rest of the page has — and
   * never with this browser's idea of the time. The cost of that would be a
   * wedged poll freezing the badge green forever; `stalled` is the poller's
   * own real-clock watchdog (`lib/poll.ts`) that closes exactly that hole.
   */
  const input = () => ({ fleet: feeds.fleet.latest, error: feeds.fleet.error, stalled: feeds.fleet.stalled });
  const status = () => serviceStatus(input());
  const rows = () => statusRows(input(), feeds.info.latest);

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
                  <dt title={r.labelTitle ?? ""}>{r.label}</dt>
                  <dd title={r.title ?? ""}>
                    <Show when={r.lines} fallback={r.value}>
                      {(lines) => <For each={lines()}>{(l) => <div>{l}</div>}</For>}
                    </Show>
                  </dd>
                </>
              )}
            </For>
          </dl>
          <A class="status-popout-link" href="/fleet">
            fleet →
          </A>
        </div>
      </Show>
    </div>
  );
}
