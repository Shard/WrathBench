/**
 * A model's logo, wherever a model is named.
 *
 * The SVGs are committed assets fetched by `infra/fetch-model-logos.ts` and are
 * *inlined* rather than linked: a mono icon paints with `fill="currentColor"`,
 * so inlining is what lets it follow the light/dark switch. A model whose id no
 * family claims gets a neutral monogram badge — the fallback is the answer for
 * every unknown id, and there is no per-model case here or anywhere else.
 *
 * The glob is eager and may legitimately be empty: a checkout that has not run
 * the fetch CLI still builds, and every icon is then a monogram.
 */

import { Show } from "solid-js";
import { familyOf, monogramOf } from "../lib/lineup";

const LOGOS = import.meta.glob<string>("../assets/model-logos/*.svg", {
  eager: true,
  query: "?raw",
  import: "default",
});

/** family id → the asset's raw SVG text. */
const SVG = new Map<string, string>(
  Object.entries(LOGOS).map(([path, svg]) => [path.slice(path.lastIndexOf("/") + 1, -".svg".length), svg]),
);

/** The raw SVG for a model's family. Inlined by the component below; the canvas
 * side wants a decoded image instead, which is `logoImageOf`. */
function logoSvgOf(model: string | null | undefined): string | null {
  const family = familyOf(model);
  return family === null ? null : SVG.get(family.id) ?? null;
}

/* --- the canvas side: the same assets as decoded images --- */

const images = new Map<string, HTMLImageElement>();
const loaded = new Set<string>();
const listeners = new Set<() => void>();

/**
 * Ask to be told when a logo finishes decoding.
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
 * Null covers all three of "no family", "no asset" and "not decoded yet", which
 * is one branch for the caller: draw the logo when there is one, and whatever it
 * drew before when there is not. The first call for a family starts the decode
 * and every later one is the cache; `onLogoLoaded` says when the answer changes.
 * A mono icon's `currentColor` resolves to black in an image document, which is
 * why the map draws these on a light puck.
 */
export function logoImageOf(model: string | null | undefined): HTMLImageElement | null {
  const family = familyOf(model);
  if (family === null) return null;
  const have = images.get(family.id);
  if (have !== undefined) return loaded.has(family.id) ? have : null;
  const svg = SVG.get(family.id);
  if (svg === undefined) return null;
  const img = new Image();
  images.set(family.id, img);
  const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
  img.onload = (): void => {
    loaded.add(family.id);
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
 * The icon itself: the family's logo, or a monogram for an id nothing claims.
 *
 * Nothing at all for a model that is absent — a cell with no model to name
 * shows its own dash and does not want a badge in front of it.
 */
export function ModelIcon(props: { model: string | null | undefined; title?: string }) {
  const model = (): string => props.model ?? "";
  const label = (): string => {
    if (props.title !== undefined) return props.title;
    const family = familyOf(props.model);
    return family === null ? model() : `${family.name} — ${family.vendor}`;
  };
  return (
    <Show when={model() !== ""}>
      <Show
        when={logoSvgOf(props.model)}
        fallback={
          <span class="model-icon model-icon-fallback" title={label()}>
            {monogramOf(model())}
          </span>
        }
      >
        {(svg) => <span class="model-icon" title={label()} innerHTML={svg()} />}
      </Show>
    </Show>
  );
}
