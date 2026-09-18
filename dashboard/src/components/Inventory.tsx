/**
 * What the character wears and carries, drawn the way a client draws it.
 *
 * Two panels over one inventory sample: a bag button that opens a grid of
 * carried stacks, and a paperdoll of the nineteen equipment slots. Both are
 * layout only — the arrangement is `lib/inventory.ts`, the linking is
 * `lib/wowhead.ts`, and the art is Wowhead's, fetched by the reader's browser
 * from a link we render (operator, 2026-09-18). We hold no icons.
 *
 * The consequence of not holding them is that every cell has to read before
 * the script decorates it, and keep reading if it never does — a reader on a
 * blocked network, or an entry Wowhead does not know. So a cell is our own
 * text (the name in its quality colour, the stack count badged) and the script
 * replaces the text with an icon when it arrives. The swap is driven by a
 * MutationObserver rather than by an effect, because `tooltips.js` loads async:
 * the `refreshLinks()` an effect fires after a render usually finds no global
 * at all, and the decoration lands later on the script's own pass.
 */

import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import { type InvItem, carried, carriedCount, paperdoll } from "../lib/inventory";
import {
  PAPERDOLL_BOTTOM,
  PAPERDOLL_LEFT,
  PAPERDOLL_RIGHT,
  entryOf,
  isDecorated,
  itemUrl,
  loadWowhead,
  qualityColor,
  refreshLinks,
  slotLabel,
} from "../lib/wowhead";

/**
 * Keep every `a.inv-link` under `root` labelled with whether Wowhead got to it.
 *
 * Attribute changes are not observed, so the class this writes cannot feed the
 * observer its own next mutation.
 */
function watchDecoration(root: HTMLElement): () => void {
  const mark = (): void => {
    for (const a of Array.from(root.querySelectorAll("a.inv-link"))) {
      a.classList.toggle("decorated", isDecorated(a));
    }
  };
  mark();
  const obs = new MutationObserver(mark);
  obs.observe(root, { childList: true, subtree: true });
  return () => obs.disconnect();
}

/** One square: the item's link and its stack count, or nothing at all. */
function Cell(props: { item: InvItem; label?: string }) {
  const entry = () => entryOf(props.item);
  const url = () => {
    const e = entry();
    return e === null ? null : itemUrl(e);
  };
  const color = () => qualityColor(props.item.quality);
  return (
    <div class="inv-cell" title={`${props.item.name}${props.item.count > 1 ? ` ×${props.item.count}` : ""}`}>
      <Show
        when={url()}
        fallback={
          // No id and no parsable placeholder: the name is all we can show, and
          // it is not a link to anywhere.
          <span class="inv-link" style={color() === null ? undefined : { color: color()! }}>
            <span class="inv-name">{props.item.name}</span>
          </span>
        }
      >
        {(href) => (
          <a
            class="inv-link"
            href={href()}
            target="_blank"
            rel="noreferrer"
            data-wh-icon-size="medium"
            data-wh-rename-link="false"
            style={color() === null ? undefined : { color: color()! }}
          >
            <span class="inv-name">{props.item.name}</span>
          </a>
        )}
      </Show>
      <Show when={props.item.count > 1}>
        <span class="inv-count">{props.item.count}</span>
      </Show>
    </div>
  );
}

/** An equipment square with nothing in it: dim, and named. */
function EmptySlot(props: { slot: number }) {
  return (
    <div class="inv-cell empty" title={slotLabel(props.slot)}>
      <span class="inv-slot-label">{slotLabel(props.slot)}</span>
    </div>
  );
}

function SlotColumn(props: { slots: readonly number[]; bySlot: Map<number, InvItem>; cls: string }) {
  return (
    <div class={props.cls}>
      <For each={props.slots}>
        {(slot) => (
          <Show when={props.bySlot.get(slot)} fallback={<EmptySlot slot={slot} />}>
            {(item) => <Cell item={item()} />}
          </Show>
        )}
      </For>
    </div>
  );
}

/**
 * The equipment sheet.
 *
 * Until track A records `slot`, every worn item lands in the "slot unknown"
 * row below and the squares are all empty. That is the honest reading of what
 * the run recorded, not a rendering failure, and the row says so in words.
 */
export function Paperdoll(props: { items: readonly InvItem[] }) {
  const doll = createMemo(() => paperdoll(props.items));
  let root!: HTMLDivElement;
  onMount(() => {
    loadWowhead();
    onCleanup(watchDecoration(root));
  });
  createEffect(() => {
    doll();
    refreshLinks();
  });
  return (
    <div class="paperdoll" ref={root}>
      <div class="paperdoll-grid">
        <SlotColumn slots={PAPERDOLL_LEFT} bySlot={doll().bySlot} cls="paperdoll-col" />
        <div class="paperdoll-mid" />
        <SlotColumn slots={PAPERDOLL_RIGHT} bySlot={doll().bySlot} cls="paperdoll-col" />
      </div>
      <SlotColumn slots={PAPERDOLL_BOTTOM} bySlot={doll().bySlot} cls="paperdoll-row" />
      <Show when={doll().unplaced.length > 0}>
        <div class="inv-unplaced">
          <div class="inv-note">equipped (slot unknown)</div>
          <div class="inv-grid">
            <For each={doll().unplaced}>{(item) => <Cell item={item} />}</For>
          </div>
        </div>
      </Show>
      <Show when={doll().bySlot.size === 0 && doll().unplaced.length === 0}>
        <div class="inv-note">nothing equipped</div>
      </Show>
    </div>
  );
}

/**
 * The bag: a count you can hover on a desktop and tap on a phone.
 *
 * Hover alone would hide the whole panel from touch, so the button is a real
 * button and a click pins the popover open; hover is the shortcut, not the
 * mechanism.
 */
export function BagGrid(props: { items: readonly InvItem[] }) {
  const rows = createMemo(() => carried(props.items));
  const [hover, setHover] = createSignal(false);
  const [pinned, setPinned] = createSignal(false);
  const open = () => hover() || pinned();
  let root!: HTMLDivElement;
  onMount(() => {
    loadWowhead();
    onCleanup(watchDecoration(root));
    const away = (e: MouseEvent): void => {
      if (pinned() && e.target instanceof Node && !root.contains(e.target)) setPinned(false);
    };
    const esc = (e: KeyboardEvent): void => {
      if (e.key === "Escape") setPinned(false);
    };
    document.addEventListener("click", away);
    document.addEventListener("keydown", esc);
    onCleanup(() => {
      document.removeEventListener("click", away);
      document.removeEventListener("keydown", esc);
    });
  });
  createEffect(() => {
    // Read both, so a newly opened popover refreshes as well as a changed bag.
    rows();
    open();
    refreshLinks();
  });
  return (
    <div
      class="bag"
      ref={root}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      <button
        type="button"
        class="bag-button"
        aria-expanded={open()}
        onClick={(e) => {
          e.stopPropagation();
          setPinned((p) => !p);
        }}
      >
        <span class="bag-icon" aria-hidden="true" />
        <span class="bag-count">{carriedCount(props.items)}</span>
        <span class="bag-label">carrying</span>
      </button>
      <Show when={open()}>
        <div class="bag-popover">
          <Show when={rows().length > 0} fallback={<div class="inv-note">bags empty</div>}>
            <div class="inv-grid">
              <For each={rows()}>{(item) => <Cell item={item} />}</For>
            </div>
          </Show>
        </div>
      </Show>
    </div>
  );
}

/**
 * Both panels, for the places that show a whole character.
 *
 * `null` items is a run that recorded no inventory at all, which is not an
 * empty bag; the caller decides what to say about that and this renders
 * nothing for it.
 */
export function InventoryPanel(props: { items: readonly InvItem[] | null | undefined }) {
  return (
    <Show when={props.items} fallback={<div class="inv-note">inventory not recorded</div>}>
      {(items) => (
        <div class="inventory">
          <BagGrid items={items()} />
          <Paperdoll items={items()} />
        </div>
      )}
    </Show>
  );
}
