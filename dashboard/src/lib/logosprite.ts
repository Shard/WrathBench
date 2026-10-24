/**
 * The model logos as one SVG sprite: a `<symbol>` per family, which a badge
 * draws with `<svg><use href="#wb-logo-<family>"/></svg>`.
 *
 * Why one sprite and not the twenty files. A badge used to inline its logo's
 * whole SVG text, so a runs table parsed the same markup once per row, and
 * every logo rode in the JavaScript of each page that names a model. The
 * sprite is a file of its own (`assets/model-logos.svg`), fetched once,
 * cached for good under its hashed name, and put in the document once; a
 * badge is then two elements. `<use>` rather than `<img>` because a mono logo
 * paints with `currentColor`, which only an element in the page's own tree
 * inherits.
 *
 * The sprite is generated from the per-family files by `spriteOf`, which
 * `infra/fetch-model-logos.ts` runs after it writes them, and a test holds the
 * committed sprite to what `spriteOf` makes of the committed files. The
 * per-family files stay: the social card renders from them
 * (`infra/og-render.ts`).
 *
 * Pure and import-free, so the fetch script and the tests share it with the
 * page.
 */

/** A symbol's id, from its family's. */
export function symbolId(family: string): string {
  return `wb-logo-${family}`;
}

/** One symbol: what `<use>` scales, and what an image document is rebuilt from. */
export interface LogoSymbol {
  viewBox: string;
  /** The logo's own markup, its root's presentation attributes carried on a `<g>`. */
  body: string;
}

/** Root attributes that size or place the standalone file and mean nothing inside a sprite. */
const DROPPED = new Set(["xmlns", "width", "height", "style", "viewBox"]);

/** One packaged SVG as a symbol. Throws on anything that is not one `<svg>` element with a viewBox. */
export function symbolOf(svg: string, where: string): LogoSymbol {
  const m = /^\s*<svg\s([^>]*)>([\s\S]*)<\/svg>\s*$/.exec(svg);
  if (m === null) throw new Error(`${where}: not a single <svg> element`);
  const attrs = [...m[1]!.matchAll(/([\w:-]+)="([^"]*)"/g)].map(([, k, v]) => [k!, v!] as const);
  const viewBox = attrs.find(([k]) => k === "viewBox")?.[1];
  if (viewBox === undefined) throw new Error(`${where}: no viewBox`);
  const kept = attrs.filter(([k]) => !DROPPED.has(k));
  const inner = m[2]!;
  const body = kept.length === 0 ? inner : `<g ${kept.map(([k, v]) => `${k}="${v}"`).join(" ")}>${inner}</g>`;
  return { viewBox, body };
}

/**
 * The sprite for a set of logos, family id → the packaged SVG text. Sorted by
 * id, one symbol a line, so the file is the same bytes for the same logos and
 * a diff names the logo that moved. The root is sized to nothing and taken
 * out of the flow rather than `display:none`, which would also switch off the
 * gradients and masks the colour logos are drawn with.
 */
export function spriteOf(logos: ReadonlyMap<string, string>): string {
  const lines = [...logos.keys()].sort().map((id) => {
    const s = symbolOf(logos.get(id)!, id);
    return `<symbol id="${symbolId(id)}" viewBox="${s.viewBox}">${s.body}</symbol>`;
  });
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" aria-hidden="true" style="position:absolute;width:0;height:0;overflow:hidden">`,
    ...lines,
    `</svg>`,
    ``,
  ].join("\n");
}

/** The symbols in a sprite `spriteOf` wrote, by family id. */
export function symbolsOf(sprite: string): Map<string, LogoSymbol> {
  const out = new Map<string, LogoSymbol>();
  for (const m of sprite.matchAll(/<symbol id="wb-logo-([^"]+)" viewBox="([^"]*)">([\s\S]*?)<\/symbol>/g)) {
    out.set(m[1]!, { viewBox: m[2]!, body: m[3]! });
  }
  return out;
}

/**
 * One symbol as a standalone SVG document, for the places that want an image
 * rather than an element: an SVG `<image href>` in the charts and a canvas
 * `drawImage` on the map. In an image document `currentColor` is black, which
 * is why those draw on a light puck.
 */
export function standaloneSvg(s: LogoSymbol): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="${s.viewBox}">${s.body}</svg>`;
}
