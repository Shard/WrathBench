/**
 * The social card, from a set of ladder runs to PNG bytes.
 *
 * Split out of `infra/render-og.ts` on 2026-09-18 so that the two things that
 * make the card have exactly one drawing between them: the ship-time CLI
 * (`render-og.ts`, which writes `dashboard/public/og.png` and prints the
 * stamp) and the snapshot publisher (`publish-dashboard.ts`, which renders the
 * card from the pass it just published and PUTs it beside the JSON). The
 * picture used to change only when the SPA shipped while the numbers under it
 * changed every five minutes, which is how the card came to be three days
 * behind the site's own ladder.
 *
 * Two things this file owns that `dashboard/src/lib/og.ts` cannot:
 *
 * - **Logos.** The dashboard reads them through `import.meta.glob`, which
 *   exists only under Vite. Same assets, same `familyOf`, read off disk.
 * - **Fonts.** resvg resolves a family through the host's font database and
 *   draws *nothing at all* when it matches none — no error, no fallback box.
 *   The card is now mostly text, so a render on a host with no fonts would
 *   produce a plausible-looking picture with the wordmark, the axis captions
 *   and every model name silently missing. `fontsDraw` renders one glyph and
 *   asks for its bounding box before any caller is allowed to ship bytes.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Resvg } from "@resvg/resvg-js";
import type { ResultRun } from "../runner/viewer/api-types";
import { familyOf } from "../dashboard/src/lib/lineup";
import { OG_H, OG_W, ogSvgOf } from "../dashboard/src/lib/og";

const ROOT = join(import.meta.dirname, "..");
const LOGO_DIR = join(ROOT, "dashboard/src/assets/model-logos");

/**
 * family id → the asset as a data URI, exactly the form `logoHrefOf` builds.
 *
 * An empty directory is legitimate — a checkout that has not run
 * `bun run model-logos` has no assets — and every mark is then a plain disc,
 * the same fallback the live chart takes for a family it does not know. The
 * assets are tracked in git, so the publisher's image carries them.
 */
export function logoHrefs(dir: string = LOGO_DIR): Map<string, string> {
  const map = new Map<string, string>();
  if (!existsSync(dir)) return map;
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".svg")) continue;
    const svg = readFileSync(join(dir, file), "utf8");
    map.set(file.slice(0, -".svg".length), `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`);
  }
  return map;
}

/** The card's SVG for these runs, with the logos resolved off disk. */
export function ogSvgWithLogos(runs: readonly ResultRun[], hrefs: Map<string, string> = logoHrefs()): string {
  return ogSvgOf(runs, {
    logoHref: (model) => {
      const family = familyOf(model);
      return family === null ? null : (hrefs.get(family.id) ?? null);
    },
  });
}

/**
 * Whether this host can draw a glyph at all.
 *
 * One letter in the card's own stack, and nothing else in the document: resvg
 * gives the rendered tree a bounding box only if a face resolved, so an
 * `undefined` here is precisely "this host would draw the card with no text on
 * it". Certain in a way a lookup in resvg's font list would not be — the stack
 * ends in a generic family and only the renderer knows what it maps that to.
 */
export function fontsDraw(): boolean {
  const probe =
    `<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" viewBox="0 0 40 40">` +
    `<text x="2" y="32" font-family="ui-monospace, SFMono-Regular, Menlo, DejaVu Sans Mono, monospace" font-size="36" fill="#ffffff">W</text>` +
    `</svg>`;
  // Nothing in the probe but the glyph, so the rendered bounding box exists
  // only if a face resolved. `getBBox` answers undefined for an empty tree.
  return new Resvg(probe).getBBox() !== undefined;
}

/** The message a caller prints when `fontsDraw` says no. It names the fix, because the failure is invisible otherwise. */
export const NO_FONTS =
  "no font resolved for the card's stack — resvg draws no text at all on a host with no font database, " +
  "so the wordmark, the axis captions and every model name would be silently missing. " +
  "Install a font (the publisher's image carries fonts-dejavu-core; see infra/docker/runner.Dockerfile).";

export interface OgPng {
  png: Uint8Array;
  /** The picture's own content hash: what `?v=` on the image URL carries. */
  stamp: string;
  /** How many entries the ladder gave it, for the log line. */
  runs: number;
}

/**
 * The card as PNG bytes, plus its content stamp.
 *
 * Throws when no font resolved rather than returning a textless card: a card
 * that is wrong in a way nobody can see is worse than a ship that stops.
 */
export function renderOgPng(runs: readonly ResultRun[], opts: { width?: number; hrefs?: Map<string, string> } = {}): OgPng {
  if (!fontsDraw()) throw new Error(NO_FONTS);
  const width = Math.round(opts.width ?? OG_W);
  const svg = ogSvgWithLogos(runs, opts.hrefs ?? logoHrefs());
  const png = new Resvg(svg, { fitTo: { mode: "width", value: width } }).render().asPng();
  return { png, stamp: new Bun.CryptoHasher("sha256").update(png).digest("hex").slice(0, 8), runs: runs.length };
}

/** The card's height at a given width, for a log line. */
export const heightAt = (width: number): number => Math.round((width * OG_H) / OG_W);

/**
 * The bucket key the card is published under.
 *
 * Beside the snapshot rather than in `v1/snap/<ver>/`: the key has to be
 * stable, because the `og:image` URL in the static `index.html` is fixed at
 * ship time and a content-addressed key would move out from under it every
 * time the data did. It is mutable in the same sense `v1/manifest.json` is,
 * and wants the same short edge TTL from the zone's cache rules.
 */
export const OG_KEY = "v1/og.png";
