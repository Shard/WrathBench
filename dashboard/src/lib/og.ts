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
 * - **Text is rationed, not banned**. Discord renders a
 *   `summary_large_image` card about 400 px wide inline, so anything set at
 *   the live chart's 10-unit label size is a smear. Nothing here is set below
 *   21 units — ~7 px at that inline width — and only three things are set at
 *   all: the wordmark, the chart's identity in the top-right (what the two
 *   axes are, in the words `lib/axes.ts` already uses), and one name above
 *   each frontier entry. Everything off the front stays unlabelled: the
 *   frontier is the claim the card makes, and a name on a dominated point is
 *   a glyph spent on a point the reader is not being asked to read.
 * - **A label that would collide is dropped, never drawn over.** `keepLabels`
 *   takes the boxes and keeps the better-scoring one of any overlapping pair,
 *   so the card renders cleanly whatever the roster does. A card is a picture
 *   nobody proofreads before it is unfurled.
 * - **No CSS variables.** resvg has no cascade and no `:root`, so the dark
 *   palette from `styles.css` is repeated here as literal hex. The ground is
 *   painted explicitly for the same reason a card must never be transparent:
 *   Discord composites it on its own chrome. The font stack is the site's own
 *   (`OG_FONT`), for the same reason: a card in a different face than the page
 *   it links to reads as someone else's card.
 *
 * The derivation is the live chart's, imported rather than restated
 * (`homeLadderRuns`, `ladderPoints`, `ladderChartLayout`, `paretoFront`), so
 * the card cannot claim a shape the homepage does not draw.
 */

import type { ResultRun } from "@viewer/api-types";
import { COST, XP } from "./axes";
import { modelDisplay } from "./format";
import { HOME_EPISODE, homeLadderRuns } from "./homeladder";
import { CUE_PAD, ladderChartLayout, ladderPoints, type Rect } from "./ladder";
import { paretoFront } from "./pareto";
import { HUMAN_SPEEDRUN_BANDS } from "./reference";

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
 * The card's one margin. Left, right and bottom are the same number so the
 * picture sits square in the frame — the old 80-unit left margin was there to
 * keep a `$0` gutter puck off the axis line, and it read as a hole in the
 * left of the card. The clearance it was buying is
 * geometry, not padding: the gutter's centre is `FREE_GUTTER_W / 3` inside
 * `x0` and a puck's outer edge is `OG_MARK_R + 3`, so at this margin the
 * leftmost possible mark still clears the edge of the card by more than a
 * puck's width, and the plot keeps the 24 units the old asymmetry spent.
 */
const PAD = 56;

/**
 * The header band, which `top` is the height of: the wordmark on the left and
 * the chart's identity on the right. Taller than the other margins on purpose
 * — it is the only margin with anything in it.
 */
const M = { top: 128, right: PAD, bottom: PAD, left: PAD };
const BOX = { x0: M.left, x1: OG_W - M.right, y0: OG_H - M.bottom, y1: M.top };

/**
 * The site's own font stack (`styles.css`, the body face), plus the one name
 * a bare container is likely to have.
 *
 * resvg resolves a family through the host's font database and draws **nothing
 * at all** when it matches none — no error, no fallback box. The publisher's
 * image carries `fonts-dejavu-core` for exactly this reason
 * (`infra/docker/runner.Dockerfile`), and naming DejaVu Sans Mono here is what
 * lets the generic tail resolve without relying on the host's idea of
 * `monospace`. `infra/og-render.ts` checks a glyph actually drew before it
 * ships the bytes.
 */
export const OG_FONT = "ui-monospace, SFMono-Regular, Menlo, DejaVu Sans Mono, monospace";

/** Mono advance: the stack is monospace, so a string's width really is its length times this. */
const ADVANCE = 0.6;

/** The wordmark, and the two sizes the identity block is set in. */
const WORDMARK_SIZE = 46;
const IDENT_SIZE = 24;
const IDENT_SMALL = 21;
/** One name above a frontier mark. The smallest thing on the card, and still ~7 px at Discord's inline width. */
const LABEL_SIZE = 22;
/**
 * Breathing room around a name's box, for the collision rule only — the text
 * is drawn at its true size. Two names that merely touch read as one long
 * word, so "would collide" has to mean "would come near", the same thing
 * `LABEL_PAD` means on the live chart.
 */
const LABEL_PAD = 6;

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
  /** The "↖ better" reading cue in the plot's top-left, on by default (try it, drop it if it does not read). */
  cue?: boolean;
  /** The top-right block naming the two axes and the tier, on by default. */
  identity?: boolean;
  /** One name above each frontier entry, on by default. */
  labels?: boolean;
}

/* ------------------------------------------------------------- label rule */

/** A candidate label: its box, and how good the entry under it is. */
export interface LabelBox extends Rect {
  /** The point's key, so a caller can match a kept box back to its mark. */
  key: string;
  /**
   * Higher wins a collision. The caller signs the y reading by its axis spec's
   * `better`, so "the lower-scored one is dropped" means worse on the axis the
   * card is about — not the ladder table's own order, which ranks by something
   * this picture does not draw.
   */
  score: number;
}

const overlaps = (a: Rect, b: Rect): boolean => a.l < b.r && b.l < a.r && a.t < b.b && b.t < a.b;

/**
 * The labels that can be drawn, out of the ones that were asked for.
 *
 * Greedy in score order: the best entry keeps its name, and anything whose box
 * hits a name already kept — or one of the `reserved` boxes, which is how the
 * wordmark and the identity block defend their corners — is dropped rather
 * than drawn over. Dropping is the right call and not a compromise: two names
 * overlaid are two names nobody can read, and the one worth reading is the one
 * further along the axis.
 *
 * Ties break on `key` so the same roster always yields the same card; the
 * result is in the order it came in, so drawing order is the caller's.
 */
export function keepLabels(candidates: readonly LabelBox[], reserved: readonly Rect[] = []): LabelBox[] {
  const byScore = [...candidates].sort((a, b) => b.score - a.score || a.key.localeCompare(b.key));
  const taken: Rect[] = [...reserved];
  const kept = new Set<string>();
  for (const c of byScore) {
    if (taken.some((r) => overlaps(c, r))) continue;
    taken.push(c);
    kept.add(c.key);
  }
  return candidates.filter((c) => kept.has(c.key));
}

/** SVG text is markup: a model slug is not, but it is a string from the wire. */
const esc = (t: string): string => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** The name over a frontier mark: the site's own display name, with the effort it was run at. */
function labelOf(p: { model: string; effort: string | null }): string {
  const name = modelDisplay(p.model);
  return p.effort === null ? name : `${name} (${p.effort})`;
}

/**
 * How good an entry is, for the collision rule — the y reading signed by its
 * axis's `better`, so "drop the lower-scored one" is a statement about the
 * axis the card draws and nothing else.
 */
const scoreOf = (p: { y: number }): number => (XP.better === "higher" ? p.y : -p.y);

/** A run of text as a box: mono, so the width is the length times one advance. */
function textRect(x: number, baseline: number, text: string, size: number, anchor: "start" | "middle" | "end"): Rect {
  const w = text.length * ADVANCE * size;
  const l = anchor === "start" ? x : anchor === "end" ? x - w : x - w / 2;
  // A quarter em below the baseline covers the descenders, one em above the
  // ascenders — the same box `lib/ladder.ts` places the live chart's labels in.
  return { l, t: baseline - size, r: l + w, b: baseline + 0.25 * size };
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
   * The header band: the wordmark on the left, the chart's identity on the
   * right. Their boxes are reserved before any point label is placed, so a
   * name near the top of the plot is dropped rather than drawn through the
   * caption that says what the plot is.
   */
  const reserved: Rect[] = [];
  if (opts.wordmark !== false) {
    body.push(
      `<text x="${M.left}" y="80" font-family="${OG_FONT}" font-size="${WORDMARK_SIZE}" font-weight="700" fill="${FG}">WrathBench</text>`,
    );
    reserved.push(textRect(M.left, 80, "WrathBench", WORDMARK_SIZE, "start"));
  }
  if (opts.identity !== false) {
    /*
     * What the picture is, in the words the site already uses: the two axis
     * captions out of `lib/axes.ts` verbatim, so the card cannot drift from
     * the chart it is a picture of, and the tier's own length underneath
     * (a reader who has never seen the site needs the
     * axes named before the frontier means anything).
     */
    const lines: [string, number, string][] = [
      [`${XP.caption(HOME_EPISODE)} vs`, IDENT_SIZE, FG],
      [COST.caption(HOME_EPISODE), IDENT_SIZE, FG],
      [`${HUMAN_SPEEDRUN_BANDS[HOME_EPISODE]?.minutes ?? 90}-minute episodes`, IDENT_SMALL, DIM],
    ];
    const x = OG_W - M.right;
    let y = 40;
    for (const [text, size, fill] of lines) {
      body.push(
        `<text x="${x}" y="${y}" text-anchor="end" font-family="${OG_FONT}" font-size="${size}" fill="${fill}">${esc(text)}</text>`,
      );
      reserved.push(textRect(x, y, text, size, "end"));
      y += size + 8;
    }
  }

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
      `<text x="${round(wx)}" y="${round(y)}" text-anchor="${cue.anchor}" font-family="${OG_FONT}" font-size="${size}" fill="${DIM}">${word}</text>`,
    );
    // The arrow and the word together, so a frontier name never lands on either.
    const wordRect = textRect(wx, y, word, size, cue.anchor);
    reserved.push({ l: Math.min(wordRect.l, ax, ax + a), t: Math.min(wordRect.t, hy - a, hy + a), r: Math.max(wordRect.r, ax, ax + a), b: Math.max(wordRect.b, hy - a, hy + a) });
  }

  /*
   * One name above each frontier entry.
   *
   * Only the front: the step line is the claim the card makes, and a name on a
   * dominated point spends a glyph on a point nobody is being asked to read.
   * Above the mark, except where "above" would put the name in the header
   * band, in which case it goes below — the topmost entry is by definition the
   * one nearest the ceiling, and it is also the one most worth naming.
   */
  if (opts.labels !== false) {
    const gap = OG_MARK_R + 3 + 6;
    const cands: (LabelBox & { x: number; y: number })[] = frontPlaced.map((p) => {
      const text = labelOf(p.point);
      const above = p.cy - gap - LABEL_SIZE * 0.25;
      const below = p.cy + gap + LABEL_SIZE;
      const baseline = above - LABEL_SIZE < M.top ? below : above;
      // Kept inside the card: a name clipped by the edge is a name nobody reads.
      const half = (text.length * ADVANCE * LABEL_SIZE) / 2;
      const x = Math.min(Math.max(p.cx, PAD / 2 + half), OG_W - PAD / 2 - half);
      const r = textRect(x, baseline, text, LABEL_SIZE, "middle");
      return {
        l: r.l - LABEL_PAD,
        t: r.t - LABEL_PAD / 2,
        r: r.r + LABEL_PAD,
        b: r.b + LABEL_PAD / 2,
        key: p.point.key,
        score: scoreOf(p.point),
        x,
        y: baseline,
      };
    });
    for (const c of keepLabels(cands, reserved)) {
      const { x, y } = cands.find((k) => k.key === c.key)!;
      const text = labelOf(frontPlaced.find((p) => p.point.key === c.key)!.point);
      body.push(
        `<text x="${round(x)}" y="${round(y)}" text-anchor="middle" font-family="${OG_FONT}" font-size="${LABEL_SIZE}" fill="${FG}">${esc(text)}</text>`,
      );
    }
  }


  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${OG_W}" height="${OG_H}" viewBox="0 0 ${OG_W} ${OG_H}">`,
    ...body,
    `</svg>`,
  ].join("");
}
