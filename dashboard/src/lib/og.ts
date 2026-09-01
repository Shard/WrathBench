/**
 * The social card: the homepage's scatter, redrawn as one flat SVG string for
 * a crawler to unfurl.
 *
 * A link pasted into Discord or anywhere else reading Open Graph tags fetches
 * the HTML and the image with no JavaScript, so the picture cannot be the
 * live chart — it is rendered at ship time (`infra/render-og.ts` rasterises
 * this to `dashboard/public/og.png`) and the tags point at the PNG.
 *
 * Three constraints shape everything here and are worth stating once:
 *
 * - **No DOM and no Solid.** Solid's DOM build has no `renderToString`, so
 *   this is a plain string builder — which also makes it testable with the
 *   ladder fixtures, like every other pure module in `lib/`.
 * - **No text.** Discord renders a `summary_large_image` card about 400 px
 *   wide inline; every label on the live chart is unreadable a third of the
 *   way down, and a smear of illegible glyphs reads as a broken image. The
 *   frontier and the logos carry the whole message, and the one exception is
 *   the wordmark, set large enough to survive the downscale.
 * - **No CSS variables.** resvg has no cascade and no `:root`, so the dark
 *   palette from `styles.css` is repeated here as literal hex. The ground is
 *   painted explicitly for the same reason a card must never be transparent:
 *   Discord composites it on its own chrome.
 *
 * The derivation is the live chart's, imported rather than restated
 * (`homeLadderRuns`, `ladderPoints`, `ladderChartLayout`, `paretoFront`), so
 * the card cannot claim a shape the homepage does not draw.
 */

import type { ResultRun } from "@viewer/api-types";
import { COST, XP } from "./axes";
import { homeLadderRuns } from "./homeladder";
import { CUE_PAD, ladderChartLayout, ladderPoints } from "./ladder";
import { paretoFront } from "./pareto";

/** The card's canvas: the size every crawler documents wanting, and the one the tags declare. */
export const OG_W = 1200;
export const OG_H = 630;

/**
 * The dark palette of `styles.css`, as literal hex.
 *
 * Dark rather than theme-aware because a card has no theme: it is a raster
 * composited into someone else's chrome, and the dark ground is the shell's
 * own identity.
 */
const BG = "#14161a";
const DIM = "#8a94a3";
const LINE = "#2b3038";
const GRIDLINE = "#23272e";
const ACCENT = "#7aa2f7";
const FG = "#d8dee6";

/**
 * The plot rectangle. Generous margins with nothing in them but air: no tick
 * labels and no axis captions means the frame needs only enough room that a
 * puck at the edge of the data is not clipped by the edge of the card. The
 * left margin is the wide one because the cost axis's free gutter puts a
 * whole puck barely inside `x0`, and a mark straddling the axis line reads as
 * a rendering fault rather than as a $0 reading.
 */
const M = { top: 96, right: 56, bottom: 56, left: 80 };
const BOX = { x0: M.left, x1: OG_W - M.right, y0: OG_H - M.bottom, y1: M.top };

/**
 * The mark's radius: 2.5× the live chart's `MARK_R`, scaled from its 1000-unit
 * viewBox onto this 1200-unit one. The live puck is sized so the scatter is
 * still a scatter and not a field of badges; here the picture *is* the badges,
 * and at a 400 px render this is an 11 px disc — the floor at which a logo is
 * a logo rather than a speck.
 */
export const OG_MARK_R = 16.5;
/** The logo inside the puck, in the live chart's proportion (`LOGO_S / MARK_R`). */
const OG_LOGO_S = OG_MARK_R * (7.5 / 5.5);

/** What the card needs that a pure module cannot know. */
export interface OgOptions {
  /**
   * A model's logo as an `<image href>`, or null for one no family claims.
   *
   * Injected rather than imported: the live chart's `logoHrefOf` reads the
   * assets through `import.meta.glob`, which only exists under Vite, and this
   * module is built by a Bun script. Same assets, resolved by the caller.
   */
  logoHref?: (model: string) => string | null;
  /** The wordmark, on by default. */
  wordmark?: boolean;
  /** The "↖ better" reading cue in the plot's top-left, on by default (operator, 2026-09-01: try it, drop it if it does not read). */
  cue?: boolean;
}

const round = (n: number): string => String(Math.round(n * 100) / 100);

/**
 * The frontier as a staircase rather than a polyline.
 *
 * A segment between two frontier entries is not a set of achievable points —
 * nothing was observed between them — so a diagonal would draw an interpolation
 * the data does not support. The step says the true thing: everything up and
 * left of this line is unclaimed.
 */
function stepPath(pts: readonly { cx: number; cy: number }[]): string {
  const [first, ...rest] = pts;
  if (first === undefined) return "";
  let d = `M ${round(first.cx)} ${round(first.cy)}`;
  let cy = first.cy;
  for (const p of rest) {
    d += ` L ${round(p.cx)} ${round(cy)} L ${round(p.cx)} ${round(p.cy)}`;
    cy = p.cy;
  }
  return d;
}

/** One mark: the light puck the mono logos need under them, its ring, and the art. */
function puck(cx: number, cy: number, onFront: boolean, href: string | null): string {
  const stroke = onFront ? ACCENT : LINE;
  const width = onFront ? 3 : 2;
  const opacity = onFront ? 1 : 0.55;
  const parts = [
    `<circle cx="${round(cx)}" cy="${round(cy)}" r="${round(OG_MARK_R + 3)}" fill="${BG}"/>`,
    `<circle cx="${round(cx)}" cy="${round(cy)}" r="${round(OG_MARK_R)}" fill="#ffffff" stroke="${stroke}" stroke-width="${width}"/>`,
  ];
  if (href !== null) {
    parts.push(
      `<image href="${href}" x="${round(cx - OG_LOGO_S / 2)}" y="${round(cy - OG_LOGO_S / 2)}" width="${round(
        OG_LOGO_S,
      )}" height="${round(OG_LOGO_S)}" preserveAspectRatio="xMidYMid meet"/>`,
    );
  } else {
    // A model no family claims: the disc alone, in the chart's own colour.
    // The live chart would draw a monogram, and a letter is text.
    parts.push(`<circle cx="${round(cx)}" cy="${round(cy)}" r="${round(OG_MARK_R * 0.45)}" fill="${DIM}"/>`);
  }
  return `<g opacity="${opacity}">${parts.join("")}</g>`;
}

/**
 * The card, as an SVG string.
 *
 * Takes the ladder's runs exactly as the homepage's `api.ladder(HOME_EPISODE)`
 * answers them and narrows them the same way (`homeLadderRuns`, free runs out),
 * so the picture and the page agree by construction rather than by a comment
 * asking the next editor to keep them in step. An empty set still returns a
 * valid card — the ground and the wordmark — because a build must never ship
 * tags pointing at nothing.
 */
export function ogSvgOf(runs: readonly ResultRun[], opts: OgOptions = {}): string {
  const href = opts.logoHref ?? ((): null => null);
  const points = ladderPoints(homeLadderRuns(runs, true), COST, XP).points;
  const layout = ladderChartLayout(points, BOX, COST, XP);
  const front = new Set(paretoFront(points, { x: COST.better, y: XP.better }).map((p) => p.key));
  const placed = layout.placed.map((p) => ({ cx: p.cx, cy: p.cy, point: p.point }));

  const body: string[] = [`<rect width="${OG_W}" height="${OG_H}" fill="${BG}"/>`];

  /*
   * Gridlines, and only the horizontal ones. The vertical minor ticks of the
   * log cost axis are 1 px apart at a 400 px render and turn into a grey wash;
   * the y ticks are four or five lines across the card and survive. A solid
   * hairline rather than the live chart's dashes, for the same reason.
   */
  for (const t of layout.yTicks) {
    const y = layout.py(t);
    body.push(
      `<line x1="${BOX.x0}" y1="${round(y)}" x2="${BOX.x1}" y2="${round(y)}" stroke="${GRIDLINE}" stroke-width="1.5"/>`,
    );
  }
  body.push(
    `<line x1="${BOX.x0}" y1="${BOX.y0}" x2="${BOX.x1}" y2="${BOX.y0}" stroke="${LINE}" stroke-width="2"/>`,
    `<line x1="${BOX.x0}" y1="${BOX.y1}" x2="${BOX.x0}" y2="${BOX.y0}" stroke="${LINE}" stroke-width="2"/>`,
  );

  // The frontier, under the marks: cheapest first, which is the order the
  // staircase climbs.
  const frontPlaced = placed.filter((p) => front.has(p.point.key)).sort((a, b) => a.cx - b.cx || b.cy - a.cy);
  const d = stepPath(frontPlaced);
  if (d !== "") {
    body.push(`<path d="${d}" fill="none" stroke="${ACCENT}" stroke-width="3" stroke-linejoin="round" opacity="0.75"/>`);
  }

  // Off-front marks first, so a frontier puck is never buried by a dimmer one.
  for (const p of placed.filter((q) => !front.has(q.point.key))) {
    body.push(puck(p.cx, p.cy, false, href(p.point.model)));
  }
  for (const p of frontPlaced) body.push(puck(p.cx, p.cy, true, href(p.point.model)));

  if (opts.cue !== false) {
    // The live chart's corner cue, scaled for the card: the layout computed
    // `cue` for the tick font in this box, so its corner and anchor are right
    // but its size is not — 26 units is ~9 px at the 400 px render, the floor
    // for a word to stay a word. Set from the box edges rather than the cue's
    // own baseline so the larger glyphs keep the same inset.
    const cue = layout.cue;
    const size = 26;
    const top = cue.y <= (BOX.y0 + BOX.y1) / 2;
    const left = cue.anchor === "start";
    const x = left ? BOX.x0 + CUE_PAD * 2 : BOX.x1 - CUE_PAD * 2;
    const y = top ? BOX.y1 + CUE_PAD * 2 + size : BOX.y0 - CUE_PAD * 2;
    // The arrow is drawn, not typed: the generic families resvg resolves on a
    // build host carry no arrow glyph, and a missing glyph renders as nothing.
    // A diagonal with a chevron head, pointing into the corner the word names.
    const a = size * 0.7;
    const ax = left ? x : x - a;
    const ay = y - size * 0.75;
    const dx = left ? 1 : -1;
    const dy = top ? 1 : -1;
    const hx = left ? ax : ax + a;
    const hy = top ? ay - a / 2 : ay + a / 2;
    const word = cue.text.replace(/^[^A-Za-z]+|[^A-Za-z]+$/g, "");
    const wx = left ? x + a + 8 : x - a - 8;
    body.push(
      `<path d="M ${round(hx + dx * a)} ${round(hy + dy * a)} L ${round(hx)} ${round(hy)} M ${round(hx)} ${round(hy + dy * (a / 2))} L ${round(hx)} ${round(hy)} L ${round(hx + dx * (a / 2))} ${round(hy)}" fill="none" stroke="${DIM}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>`,
      `<text x="${round(wx)}" y="${round(y)}" text-anchor="${cue.anchor}" font-family="Helvetica, Arial, sans-serif" font-size="${size}" fill="${DIM}">${word}</text>`,
    );
  }

  if (opts.wordmark !== false) {
    // 52 units is ~17 px at the 400 px inline render: comfortably above the
    // size at which the name stops being a word and becomes a texture. Set in
    // the generic families resvg resolves without a font file of our own.
    body.push(
      `<text x="${M.left}" y="64" font-family="Helvetica, Arial, sans-serif" font-size="52" font-weight="700" fill="${FG}">WrathBench</text>`,
    );
  }

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${OG_W}" height="${OG_H}" viewBox="0 0 ${OG_W} ${OG_H}">`,
    ...body,
    `</svg>`,
  ].join("");
}
