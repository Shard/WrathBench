/**
 * A disclosure pane: a heading you click to slide the content in and out.
 *
 * For the lists that are worth having on the page but not worth reading every
 * time — paused runs on the fleet page, a campaign's cell table. The heading
 * carries the count so the collapsed state still answers "is there anything in
 * there", which is the only question a closed pane has to answer.
 *
 * Three things it does not do, deliberately:
 *
 * - The children are always in the DOM. Gating them on `open` would mean there
 *   is nothing to animate, so the collapse is CSS alone (`grid-template-rows`
 *   0fr→1fr over a clipped inner box) and `inert` is what keeps a closed pane's
 *   links out of the tab order.
 * - It does not own the open state beyond the pane. `storageKey` is how a pane
 *   survives its own remount, which on the campaigns page happens every poll
 *   tick — `poll()` hands back fresh objects and `<For>` is keyed on reference,
 *   so an expanded pane would otherwise snap shut once a minute.
 * - It does not fetch, and it does not know what it wraps.
 */

import { Show, createSignal, createUniqueId, type JSX } from "solid-js";

export interface CollapsibleProps {
  /** The heading, left of the summary. A string or any markup. */
  title: JSX.Element;
  /** Small text beside the heading — a count, a state — visible when closed. */
  summary?: JSX.Element;
  /** Open on first render, when nothing is remembered. Default closed. */
  defaultOpen?: boolean;
  /** Remember open/closed under this key. Absent means "forget on unmount". */
  storageKey?: string;
  children: JSX.Element;
}

/**
 * The remembered state, if the browser has one and will part with it. Blocked
 * storage (private mode, a browser configured to refuse) is not an error here:
 * the pane still opens and closes, it just starts from `fallback` every time.
 */
function readOpen(key: string, fallback: boolean): boolean {
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : v === "1";
  } catch {
    return fallback;
  }
}

function writeOpen(key: string, open: boolean): void {
  try {
    localStorage.setItem(key, open ? "1" : "0");
  } catch {
    /* see readOpen: not persisting is the only consequence */
  }
}

export function Collapsible(props: CollapsibleProps): JSX.Element {
  const fallback = props.defaultOpen === true;
  const [open, setOpen] = createSignal(
    props.storageKey === undefined ? fallback : readOpen(props.storageKey, fallback),
  );
  const id = createUniqueId();

  const toggle = (): void => {
    const next = !open();
    setOpen(next);
    if (props.storageKey !== undefined) writeOpen(props.storageKey, next);
  };

  return (
    <section class="collapsible" classList={{ open: open() }}>
      {/* A heading element around the control, so folding a section does not cost the outline. */}
      <h3 class="collapsible-head">
        <button
          type="button"
          class="collapsible-toggle"
          aria-expanded={open()}
          aria-controls={id}
          onClick={toggle}
        >
          {/* Drawn in CSS, so it is empty here and hidden from the accessibility tree. */}
          <span class="collapsible-chev" aria-hidden="true" />
          <span class="collapsible-title">{props.title}</span>
          <Show when={props.summary !== undefined}>
            <span class="collapsible-summary dim">{props.summary}</span>
          </Show>
        </button>
      </h3>
      <div class="collapsible-body" id={id} inert={!open()}>
        <div class="collapsible-clip">
          <div class="collapsible-content">{props.children}</div>
        </div>
      </div>
    </section>
  );
}
