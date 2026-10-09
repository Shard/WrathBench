/**
 * A chart as a sidebar card, and the full drawing one click away.
 *
 * The run page used to open with its charts at full width above the feed,
 * where they took half a laptop screen from the thing the page is for. The
 * card holds a compact drawing sized to the sidebar; the click opens the full
 * one in the browser's own modal `<dialog>`, which brings Esc, focus trapping
 * and the backdrop with it rather than a second popover mechanism. A click on
 * the backdrop closes it too: the dialog's own box is the backdrop's hit area,
 * and everything inside sits in a body that is not.
 *
 * The card is a `<button>` so the keyboard reaches it, which is also why the
 * compact drawing must be phrasing content (an `<svg>`, or a `<span>`).
 */

import type { JSX } from "solid-js";

export function ChartCard(props: { label: string; compact: JSX.Element; children: JSX.Element }) {
  let dialog: HTMLDialogElement | undefined;
  return (
    <>
      <button type="button" class="card chart-card" title="open the full chart" onClick={() => dialog?.showModal()}>
        <span class="k">{props.label}</span>
        {props.compact}
      </button>
      <dialog
        class="chart-dialog"
        ref={dialog}
        onClick={(e) => {
          if (e.target === dialog) dialog?.close();
        }}
      >
        <div class="chart-dialog-body">
          <button type="button" class="chart-dialog-close" onClick={() => dialog?.close()}>
            close
          </button>
          {props.children}
        </div>
      </dialog>
    </>
  );
}
