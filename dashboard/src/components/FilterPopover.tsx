/**
 * One button that holds the ladder's narrowing filters.
 *
 * The page used to wear four dropdowns in a row. Two of them — race and class
 * — asked a question an eval episode cannot answer differently (every scored
 * run is the same baseline character), and the third duplicated the series
 * selector the shell already carries for every page. What is left is two
 * multi-select dimensions behind one button that says how many are on.
 *
 * Native `<select multiple>` rather than checkbox lists (operator,
 * 2026-09-18): there are thirty-odd model lines on the ladder, and thirty
 * checkboxes is a wall where six visible rows and a scrollbar is a control.
 * Ctrl/cmd-click is the browser's own multi-select and needs nothing from us;
 * a `clear` link per box is the one affordance it lacks.
 *
 * The panel is the portal-and-`popoverPlacement` mechanism `Inventory` landed,
 * not a second one: it hangs off a button in a wrapping controls row, and a
 * panel that is a child of that row is clipped and reflows it. Click to open
 * rather than hover — a filter panel that opened as the pointer crossed the
 * controls on its way to the chart would be in the way.
 */

import { For, Show, createEffect, createSignal, onCleanup, onMount } from "solid-js";
import { Portal } from "solid-js/web";
import { type Placement, popoverPlacement } from "../lib/popover";
import type { FilterOption } from "../lib/ladderfilter";

/** The panel's own width, told to both the CSS and the placement maths. */
const PANEL_W = 300;

/** One dimension inside the panel: its options, and what is selected. */
export interface FilterGroup {
  /** The dimension's name, as the box is labelled. */
  label: string;
  options: readonly FilterOption[];
  selected: readonly string[];
  onSelect: (keys: string[]) => void;
}

export function FilterPopover(props: { groups: readonly FilterGroup[] }) {
  const [open, setOpen] = createSignal(false);
  const [place, setPlace] = createSignal<Placement>({ below: true, offset: 0, left: 0, maxHeight: 320 });
  let root!: HTMLDivElement;
  let btn!: HTMLButtonElement;
  let panel: HTMLDivElement | undefined;

  /** The number on the button: every selected value, across every dimension. */
  const active = (): number => props.groups.reduce((n, g) => n + g.selected.length, 0);

  const measure = (needed?: number): void => {
    const r = btn.getBoundingClientRect();
    setPlace(
      popoverPlacement(
        r,
        { width: window.innerWidth, height: window.innerHeight },
        needed === undefined ? { width: PANEL_W } : { width: PANEL_W, needed },
      ),
    );
  };

  onMount(() => {
    const away = (ev: MouseEvent): void => {
      if (!open() || !(ev.target instanceof Node)) return;
      if (!root.contains(ev.target) && !(panel?.contains(ev.target) ?? false)) setOpen(false);
    };
    const esc = (ev: KeyboardEvent): void => {
      if (ev.key === "Escape" && open()) setOpen(false);
    };
    // A scroll moves the button out from under a fixed panel, so the panel
    // follows it rather than floating where it was opened.
    const follow = (): void => {
      if (open()) measure();
    };
    document.addEventListener("click", away);
    document.addEventListener("keydown", esc);
    window.addEventListener("scroll", follow, true);
    window.addEventListener("resize", follow);
    onCleanup(() => {
      document.removeEventListener("click", away);
      document.removeEventListener("keydown", esc);
      window.removeEventListener("scroll", follow, true);
      window.removeEventListener("resize", follow);
    });
  });

  createEffect(() => {
    // Placed against a floor on open, then against the panel's real height
    // once there is one: a button low on the page wants the room above it.
    if (!open()) return;
    measure();
    const el = panel;
    if (el !== undefined) measure(el.scrollHeight);
  });

  return (
    <div class="popover-anchor" ref={root}>
      <button
        type="button"
        class={active() > 0 ? "popover-button on" : "popover-button"}
        ref={btn}
        aria-expanded={open()}
        title="Narrow the ladder by company and model family. Values combine within a box and narrow across the two."
        onClick={(ev) => {
          ev.stopPropagation();
          setOpen(!open());
        }}
      >
        <span>filters</span>
        <Show when={active() > 0}>
          <span class="filters-count">{active()}</span>
        </Show>
      </button>
      <Show when={open()}>
        <Portal>
          <div
            class="popover filter-popover floating"
            ref={panel}
            style={{
              left: `${place().left}px`,
              top: place().below ? `${place().offset}px` : "auto",
              bottom: place().below ? "auto" : `${place().offset}px`,
              "max-height": `${place().maxHeight}px`,
              width: `${PANEL_W}px`,
            }}
          >
            <For each={props.groups}>
              {(group) => (
                <div class="filter-group">
                  <div class="filter-group-head">
                    <span class="filter-group-label">{group.label}</span>
                    <Show when={group.selected.length > 0}>
                      <button type="button" class="filter-clear" onClick={() => group.onSelect([])}>
                        clear
                      </button>
                    </Show>
                  </div>
                  {/*
                    `selected` on each option rather than `value` on the select,
                    for the reason `SeriesSelect` gives: `<For>` recreates every
                    option when a poll returns, and a select whose options are
                    all replaced loses its selection with no signal to put it
                    back. The attribute makes the DOM say what is chosen.
                  */}
                  <select
                    multiple
                    size={6}
                    onChange={(ev) =>
                      group.onSelect(Array.from(ev.currentTarget.selectedOptions, (o) => o.value))
                    }
                  >
                    <For each={group.options}>
                      {(opt) => (
                        <option value={opt.key} selected={group.selected.includes(opt.key)}>
                          {opt.key} ({opt.n})
                        </option>
                      )}
                    </For>
                  </select>
                </div>
              )}
            </For>
          </div>
        </Portal>
      </Show>
    </div>
  );
}
