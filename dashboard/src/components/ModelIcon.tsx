/**
 * A model's logo, wherever a model is named.
 *
 * The logos are committed assets fetched by `infra/fetch-model-logos.ts` and
 * drawn from one sprite of them (`lib/logosprite.ts`): the sprite is fetched
 * once, put in the document once, and each badge is an `<svg><use>` of its
 * family's symbol. A mono icon paints with `fill="currentColor"`, and an
 * element in the page's own tree is what lets it follow the light/dark switch.
 * A model the catalogue (`infra/model-catalogue.ts`) cannot place gets a
 * neutral monogram badge — the fallback is the answer for every unknown id,
 * and there is no per-model case here or anywhere else.
 *
 * Whether a family has a logo is the catalogue's `icon`, so a badge picks its
 * shape before the sprite has arrived; its `<use>` draws the moment the sprite
 * is in the document. A sprite that fails to load, or that lacks the family,
 * leaves the monogram.
 */

import { Show, createSignal } from "solid-js";
import { familyOf } from "../../../infra/model-catalogue";
import { monogramOf } from "../lib/modelmark";
import { standaloneSvg, symbolId, symbolsOf, type LogoSymbol } from "../lib/logosprite";
import spriteUrl from "../assets/model-logos.svg?url";

/* --- the sprite: fetched on first use, then shared by every badge --- */

/** The sprite's symbols once it has loaded; null before, and for good after a failure. */
const [symbols, setSymbols] = createSignal<ReadonlyMap<string, LogoSymbol> | null>(null);
const [failed, setFailed] = createSignal(false);
let started = false;

/**
 * Start loading the sprite, once: when this module loads in a browser, which
 * is with the first page that names a model, so the sprite downloads while
 * that page's data does rather than after it (a badge or a puck draws only
 * once there is data, and asking then put the logos a round trip behind
 * everything else). Every reader also asks, which is the whole of it where
 * the module loaded with no document. Not from `index.html`: a preload there
 * competes with the entry script and the first data request, and cost the
 * data more on a slow link than it saved the logos.
 */
function ensureSprite(): void {
  if (started || typeof document === "undefined" || typeof window === "undefined") return;
  started = true;
  // Through a resolved promise, so a fetch that throws rather than rejects
  // (a relative URL outside a browser) lands in the same catch.
  Promise.resolve()
    .then(() => fetch(spriteUrl))
    .then((res) => {
      if (!res.ok) throw new Error(`${spriteUrl}: ${res.status}`);
      return res.text();
    })
    .then((text) => {
      document.body.insertAdjacentHTML("beforeend", text);
      setSymbols(symbolsOf(text));
      for (const cb of listeners) cb();
    })
    .catch(() => setFailed(true));
}

ensureSprite();

/** The family that has a logo, for a model; null for no family or a family with none. */
function logoFamily(model: string | null | undefined): string | null {
  const family = familyOf(model);
  if (family === null || family.icon === undefined || failed()) return null;
  const have = symbols();
  return have === null || have.has(family.id) ? family.id : null;
}

/* --- the canvas side: the same symbols as decoded images --- */

const images = new Map<string, HTMLImageElement>();
const loaded = new Set<string>();
const listeners = new Set<() => void>();

/**
 * Ask to be told when a logo becomes drawable: when the sprite arrives, and
 * when each logo finishes decoding.
 *
 * The map draws outside Solid's reactivity, so a logo that arrives after the
 * frame that wanted it has no signal to invalidate; this is the hook it
 * schedules its redraw from. Returns its own unsubscribe.
 */
export function onLogoLoaded(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/**
 * A model's logo as a decoded image, or null.
 *
 * Null covers "no family", "no asset" and "not decoded yet", which is one
 * branch for the caller: draw the logo when there is one, and whatever it drew
 * before when there is not. The first call for a family starts the decode (and
 * the sprite, if nothing has yet) and every later one is the cache;
 * `onLogoLoaded` says when the answer changes. A mono icon's `currentColor`
 * resolves to black in an image document, which is why the map draws these on
 * a light puck.
 */
export function logoImageOf(model: string | null | undefined): HTMLImageElement | null {
  ensureSprite();
  const id = logoFamily(model);
  if (id === null) return null;
  const have = images.get(id);
  if (have !== undefined) return loaded.has(id) ? have : null;
  const symbol = symbols()?.get(id);
  if (symbol === undefined) return null;
  const img = new Image();
  images.set(id, img);
  const url = URL.createObjectURL(new Blob([standaloneSvg(symbol)], { type: "image/svg+xml" }));
  img.onload = (): void => {
    loaded.add(id);
    URL.revokeObjectURL(url);
    for (const cb of listeners) cb();
  };
  img.onerror = (): void => {
    URL.revokeObjectURL(url);
  };
  img.src = url;
  return null;
}

/**
 * A model's logo as a URL an SVG `<image>` can point at, or null.
 *
 * The ladder scatter draws its marks in SVG rather than on a canvas, so it
 * wants an href and not a decoded image. Until the sprite has loaded a family
 * with a logo gets an empty image, and the answer is reactive on the sprite:
 * called inside a Solid scope, the chart draws the logo when it arrives.
 * Deliberately its own cache and its own data URI rather than
 * sharing `logoImageOf`'s blob: that one revokes its URL the moment the image
 * decodes, so a shared href would go dead as soon as the map had drawn that
 * family. Same symbols, same `familyOf`, same reason to sit on a light puck — a
 * mono icon's `currentColor` is black in an image document.
 */
const hrefs = new Map<string, string>();

/** An empty image: what a logo's puck shows while the sprite is on its way, so it fills in rather than flipping from a monogram. */
const PENDING_HREF = `data:image/svg+xml;charset=utf-8,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"/>')}`;

export function logoHrefOf(model: string | null | undefined): string | null {
  ensureSprite();
  const id = logoFamily(model);
  if (id === null) return null;
  const have = hrefs.get(id);
  if (have !== undefined) return have;
  const all = symbols();
  if (all === null) return PENDING_HREF;
  const symbol = all.get(id);
  if (symbol === undefined) return null;
  const href = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(standaloneSvg(symbol))}`;
  hrefs.set(id, href);
  return href;
}

/**
 * The icon itself: the family's logo, or a monogram for an id nothing claims.
 *
 * Nothing at all for a model that is absent — a cell with no model to name
 * shows its own dash and does not want a badge in front of it.
 */
export function ModelIcon(props: {
  model: string | null | undefined;
  title?: string;
  /**
   * `lg` is the models page's lead mark: the same logo at twice the size,
   * sitting left of a name and its sub-lines rather than inline in one. Only
   * the logo grows — a monogram is a letter in a disc, and doubling that makes
   * a placeholder shout louder than the identities it stands in for.
   */
  size?: "lg";
}) {
  const model = (): string => props.model ?? "";
  const label = (): string => {
    if (props.title !== undefined) return props.title;
    const family = familyOf(props.model);
    return family === null ? model() : `${family.name} — ${family.company}`;
  };
  ensureSprite();
  return (
    <Show when={model() !== ""}>
      <Show
        when={logoFamily(props.model)}
        fallback={
          <span class="model-icon model-icon-fallback" title={label()}>
            {monogramOf(model())}
          </span>
        }
      >
        {(id) => (
          <span class={props.size === "lg" ? "model-icon model-icon-lg" : "model-icon"} title={label()}>
            <svg>
              <use href={`#${symbolId(id())}`} />
            </svg>
          </span>
        )}
      </Show>
    </Show>
  );
}
