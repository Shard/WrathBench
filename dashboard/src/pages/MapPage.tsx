/**
 * The live map, ported from the hand-written `/map` page onto Solid.
 *
 * The map view's two rules hold unchanged. The renderer consumes a *position feed*
 * and nothing else: `positions()` is the only thing that fetches, every draw
 * function takes what it draws as an argument, and no draw path asks whether a
 * run is live — a replay mode swaps the feed and this file does not change. And
 * the world→tile transform is imported from `runner/viewer/worldmap.ts` rather
 * than copied; the old page copied it only because a template string cannot
 * import.
 *
 * Replay (`/map?run=<id>`) is a *feed swap*, not a second renderer: the same
 * `AgentPosition[]` the live poll produces is produced instead by a time cursor
 * over one run's recorded track. Nothing in the draw path asks
 * which mode it is in — the two differences are that a scrubbed pip is placed
 * rather than walked (the lerp would trail the cursor and read as a bug), and
 * that the route walked so far is drawn behind it.
 *
 * The two modes share one control strip, bottom centre of the stage: a live
 * pill on `/map`, the transport on `/map?run=<id>`, and a loading state in
 * between. The move between live and replay is therefore a change of what that
 * one strip says, with the way back — the live link — always in the same place,
 * rather than a second cluster of controls appearing in a corner. Its
 * arithmetic is `lib/playback.ts`; this file only wires it.
 *
 * Canvas drawing sits outside Solid's reactivity on purpose. Pips interpolate
 * toward their newest reading every frame, so the draw loop is a
 * requestAnimationFrame with its own mutable state; Solid owns the sidebar, the
 * chips and the header, which change once per poll.
 *
 * That seam is now enforced rather than intended. The signals below are the
 * only writable state; everything the page displays is derived from them in
 * `mapstate.ts`, which computes and never writes. Effects here go one way too —
 * they read signals and write only renderer state (`pips`, `view`, `route`,
 * `needsDraw`) or a signal nothing upstream of them reads. The rule is that no
 * signal is read and written in the same reactive scope, which is the shape the
 * page had before and the reason it recursed.
 */

import { A, useSearchParams } from "@solidjs/router";
import { For, Show, createEffect, createMemo, createSignal, on, onCleanup, onMount } from "solid-js";
import { api, type AgentPosition, type TrackResponse } from "../api/client";
import { ModelIcon, logoImageOf, onLogoLoaded } from "../components/ModelIcon";
import { PlayBar } from "../components/PlayBar";
import { UnitFrame } from "../components/UnitFrame";
import { InventoryPanel } from "../components/Inventory";
import { cursorMemory } from "../lib/cursormemory";
import { intentLabel, intentToDraw, intentTone, type IntentTone } from "../lib/mapintent";
import { restPhase, statusStamp } from "../lib/reflect";
import { resolvePowerType } from "../lib/unitframe";
import { NO_TILE_BASE, tileSrc } from "../lib/tiles";
import { fmtAge, fmtItems, fmtMoney, modelDisplay, num, shortHarness } from "../lib/format";
import { type Speed, keyBelongsToTarget, nextSpeed, playbackKey, prevSampleBefore, tickMs } from "../lib/playback";
import {
  clearReplayState,
  createLeftReplay,
  createMapState,
  replayHrefFor,
} from "../lib/mapstate";
import {
  STALE_MS,
  TILE_MIN_PX,
  type FeedClock,
  type Pip,
  type View,
  colorOf,
  decimateRoute,
  defaultView,
  emptySideNote,
  fitTo,
  hitTest,
  latticeLines,
  mapName,
  pipName,
  positionAgeMs,
  project,
  stepPips,
  syncPips,
  visibleGrid,
  worldPerPixel,
  zoomAt,
} from "../lib/mapview";
import { poll } from "../lib/poll";
import { useSeriesFilter } from "../components/SeriesSelect";
import { useClock } from "../lib/clock";
import { nextSampleAfter, positionsAt, routeUpTo, runParam, trackSpan } from "../lib/replay";
import { displayError, logError } from "../lib/errors";

const POLL_MS = 5000;
const TILE_CACHE_MAX = 512;

/*
 * The pip's own geometry, half again the size it was first drawn at: a logo
 * legible enough to name the model at a glance is what the
 * puck is for, and at a 9-unit radius it was a smudge. The fallback dot and the
 * label's clearance are scaled with it so an unrecognised model still reads as
 * the same kind of mark. Nothing here touches the sidebar, whose icons are
 * `ModelIcon` and sized by CSS.
 */
const PUCK_R = 14;
const PUCK_R_SEL = 17;
const LOGO = 18;
const LOGO_SEL = 21;
const DOT_R = 8;
const DOT_R_SEL = 11;
/** The click radius, kept ahead of the puck it has to cover. */
const PIP_HIT_R = 24;

/**
 * The destination marker: its radius, and how far from the pip it has to sit
 * before it is worth drawing at all. Below that the character is standing on
 * its destination — the normal end of a successful move — and a marker there
 * would only be a ring around the pip. A move still walking clears a far
 * smaller bar than one already over.
 */
const DEST_R = 6;
const DEST_MIN_PX = 14;
const DEST_MIN_PX_LIVE = 4;
/**
 * The canvas colours, as the stylesheet's own tokens resolve them. Named once
 * here because the canvas needs them as strings: `readTheme` reads the live
 * custom properties every theme change and falls back to these, and the same
 * values are what the map draws with before the first read.
 */
const DEFAULT_THEME = {
  grid: "#1a1d22",
  gridline: "#23272e",
  dim: "#8a94a3",
  fg: "#d8dee6",
  bg: "#14161a",
  line: "#2b3038",
};
/**
 * The one colour the map states rather than derives. A failed move is not a
 * run's identity, it is a fact about the move, so it does not take the run's
 * colour; the value is the stylesheet's own `--err`.
 */
let INTENT_FAIL = "#f7768e";
/**
 * The rest glyph's colour: the stylesheet's own experience purple, the same
 * token the reflection surface uses everywhere else in the dashboard, so
 * "this character is thinking rather than acting" is one colour across the
 * page rather than a canvas invention.
 */
let REST_TINT = "#7b3fd6";
/** Whether the viewer asked for less motion; the glyph is drawn either way. */
let reduceMotion = false;

interface TileEntry {
  img: HTMLImageElement;
  ok: boolean;
}

export default function MapPage() {
  /*
   * The route is the page's mode, and the only mode it has: `/map` is live,
   * `/map?run=<id>` is that run's replay. Everything else the page holds —
   * cursor, playback, the pinned map, the selection, pan and zoom — is
   * per-frame state that would make the URL churn, so none of it goes here.
   * The cursor is remembered per run beside the route instead, so coming back
   * to a replay does not restart it: `lib/cursormemory.ts`.
   */
  const [params] = useSearchParams();
  const replayId = (): string | undefined => runParam(params.run);

  /* --- sources: the only writable state on the page --- */
  const [track, setTrack] = createSignal<TrackResponse | undefined>(undefined);
  const [cursor, setCursor] = createSignal(0);
  const [playing, setPlaying] = createSignal(false);
  // Playback speed is a viewer preference, not replay state: it survives the
  // swap on purpose, so it is not among the writables `clearReplayState` resets.
  const [speed, setSpeed] = createSignal<Speed>(1);
  const [replayError, setReplayError] = createSignal<string | undefined>(undefined);
  const [feedList, setFeedList] = createSignal<readonly AgentPosition[]>([]);
  const [pinnedMap, setPinnedMap] = createSignal<number | null>(null);
  const [selectedId, setSelectedId] = createSignal<string | null>(null);
  // The sidebar's "last update" ages between polls, so it needs its own tick.
  const ageTick = useClock();

  // The live feed keeps its 5s poll, and answers with nothing while a replay
  // owns the map — one feed reaches the renderer, never two. The envelope's
  // clock rides along: the public build's positions arrive up to two minutes
  // late through no fault of the agents, and the pips' stale dimming has to
  // age readings against the snapshot's own clock rather than this browser's
  // (`positionAgeMs`). The private build carries no envelope and a null clock.
  const feed = poll(
    () =>
      replayId() === undefined
        ? api.positions().then((p) => ({
            positions: p.positions,
            clock: p.generatedAt === undefined ? null : { generatedAt: p.generatedAt, fetchedAt: Date.now() },
          }))
        : Promise.resolve({ positions: [] as AgentPosition[], clock: null as FeedClock | null }),
    POLL_MS,
  );
  const feedPositions = (): readonly AgentPosition[] => feed.latest?.positions ?? [];

  /*
   * The shell's harness series narrows the live feed, so the map
   * agrees with every other page about which runs exist. Never during a replay:
   * a replay is one named run the reader asked for by id, and hiding it because
   * of a header control would look like a broken link.
   */
  const seriesFilter = useSeriesFilter(feedList, () => replayId() === undefined);
  const liveSeries = seriesFilter.series;
  const shownList = seriesFilter.kept;
  const seriesHidden = seriesFilter.filteredOut;

  const { maps, count, cursorMap, activeMap, selected } = createMapState({
    feed: shownList,
    track,
    pinned: pinnedMap,
    selectedId,
  });

  const span = createMemo(() => {
    const t = track();
    return t === undefined ? null : trackSpan(t.points);
  });
  /** A replay is scrubbable only where its samples span some time. */
  const scrubbable = (): boolean => {
    const sp = span();
    return sp !== null && sp.to > sp.from;
  };

  let canvas!: HTMLCanvasElement;
  let stage!: HTMLDivElement;

  /* Mutable render state — read every frame, never through a signal. */
  const pips = new Map<string, Pip>();
  /* The live feed's reference clock, beside the pips it dates; null in a replay. */
  let feedClock: FeedClock | null = null;
  const tiles = new Map<string, TileEntry>();
  let view: View = { scale: 0.25, ox: 0, oy: 0 };
  let route: { x: number; y: number }[] = [];
  let routeColor = "";
  /* The decimation of `route` last handed to the canvas, and what it was for. */
  let routeDrawn: { x: number; y: number }[] = [];
  let routeSrc: { x: number; y: number }[] | null = null;
  let routeScale = 0;
  /* Fitting is deliberate, not reactive — see the fit effect for why. */
  let pendingFit = true;
  let needsDraw = true;
  let W = 0;
  let H = 0;
  let theme = { ...DEFAULT_THEME };

  /*
   * Tiles: an LRU of Image objects with misses remembered in the same map.
   * Before the extraction has run every visible tile is missing, and an
   * unremembered miss would re-request dozens of them on every pan.
   */
  function tile(map: number, row: number, col: number): TileEntry {
    const key = `${map}/${row}_${col}`;
    const hit = tiles.get(key);
    if (hit !== undefined) {
      tiles.delete(key);
      tiles.set(key, hit);
      return hit;
    }
    const img = new Image();
    const entry: TileEntry = { img, ok: false };
    // Null means this build was given no tile host and must not ask for one
    // (`lib/tiles.ts`). Remembered as a miss like any other, so the grid is
    // drawn and nothing is requested.
    const src = tileSrc(map, row, col);
    if (src !== null) {
      img.onload = (): void => {
        entry.ok = true;
        needsDraw = true;
      };
      // A miss changes nothing on screen — the fallback square is already there
      // — and asking for a redraw would re-request every missing tile forever.
      img.onerror = null;
      img.src = src;
    }
    tiles.set(key, entry);
    while (tiles.size > TILE_CACHE_MAX) {
      const oldest = tiles.keys().next().value;
      if (oldest === undefined) break;
      tiles.delete(oldest);
    }
    return entry;
  }

  function readTheme(): void {
    const cs = getComputedStyle(document.documentElement);
    const get = (n: string, fallback: string): string => cs.getPropertyValue(n).trim() || fallback;
    theme = {
      grid: get("--grid", DEFAULT_THEME.grid),
      gridline: get("--gridline", DEFAULT_THEME.gridline),
      dim: get("--dim", DEFAULT_THEME.dim),
      fg: get("--fg", DEFAULT_THEME.fg),
      bg: get("--bg", DEFAULT_THEME.bg),
      line: get("--line", DEFAULT_THEME.line),
    };
    INTENT_FAIL = get("--err", "#f7768e");
    REST_TINT = get("--xp", "#7b3fd6");
    needsDraw = true;
  }

  function resize(): void {
    const dpr = window.devicePixelRatio || 1;
    const r = stage.getBoundingClientRect();
    W = Math.max(1, Math.round(r.width));
    H = Math.max(1, Math.round(r.height));
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    const ctx = canvas.getContext("2d");
    ctx?.setTransform(dpr, 0, 0, dpr, 0, 0);
    /*
     * Until something has been fitted the view is the default framing, and it
     * depends on the stage, so it is recomputed here rather than once at mount:
     * the first `ResizeObserver` callback is where the real size arrives, and a
     * phone rotated on an empty map would otherwise keep a frame built for the
     * other orientation. `pendingFit` is exactly the "nothing has claimed the
     * view yet" flag — once a feed consumes it this leaves the view alone, so a
     * pan survives a resize as before. It deliberately does not live in the fit
     * effect: that effect re-runs on every poll tick, and an empty-feed branch
     * there would snap the view back under a reader who had just panned.
     */
    if (pendingFit) view = defaultView({ w: W, h: H });
    needsDraw = true;
  }

  const onMap = (): Pip[] => {
    const map = activeMap();
    return [...pips.values()].filter((p) => p.data.map === map);
  };

  function drawGrid(ctx: CanvasRenderingContext2D, map: number): void {
    ctx.fillStyle = theme.grid;
    ctx.fillRect(0, 0, W, H);
    const g = visibleGrid(view, { w: W, h: H });
    /*
     * Zoomed far out a 256px tile carries no information, and the whole 64×64
     * grid would be on screen at once — more cells than the cache holds, so
     * every frame would evict and re-request the lot. The threshold also keeps
     * the visible cell count inside the LRU.
     *
     * Where a tile comes from is `lib/tiles.ts`: the private viewer serves
     * them same-origin, and the public build reads
     * `VITE_WRATHBENCH_TILES_BASE` for the host holding the `tiles/` prefix.
     * A build given no host and a tile merely missing draw identically — the
     * labelled grid below — which is the same state a lab machine that never
     * ran the extraction is in.
     */
    const useTiles = !NO_TILE_BASE && g.size >= TILE_MIN_PX;
    ctx.lineWidth = 1;
    ctx.font = "11px ui-monospace, monospace";
    ctx.textBaseline = "top";
    ctx.strokeStyle = theme.gridline;
    ctx.fillStyle = theme.dim;
    if (!useTiles) {
      /*
       * Below the threshold nothing is drawn into a cell, so nothing can be
       * covered and the lattice is one path rather than one rect per cell: the
       * whole world on screen was up to 4096 `strokeRect` calls, and a pan made
       * that per frame. Shared boundaries now carry one line
       * where the inset rects carried two, which reads thinner and is the only
       * visible change.
       */
      const l = latticeLines(view, { w: W, h: H });
      ctx.beginPath();
      for (const x of l.xs) {
        ctx.moveTo(x, l.y0);
        ctx.lineTo(x, l.y1);
      }
      for (const y of l.ys) {
        ctx.moveTo(l.x0, y);
        ctx.lineTo(l.x1, y);
      }
      ctx.stroke();
      // Labels stay per cell and stay bounded: they need a cell wider than 64px,
      // which caps them at a screenful.
      if (g.size > 64) {
        for (let row = g.row0; row <= g.row1; row++) {
          for (let col = g.col0; col <= g.col1; col++) {
            ctx.fillText(`${row}_${col}`, col * g.size + view.ox + 6, row * g.size + view.oy + 5);
          }
        }
      }
      return;
    }
    for (let row = g.row0; row <= g.row1; row++) {
      for (let col = g.col0; col <= g.col1; col++) {
        const x = col * g.size + view.ox;
        const y = row * g.size + view.oy;
        const t = tile(map, row, col);
        if (t.ok) {
          // A hair of overdraw: neighbouring tiles must not show a seam when
          // the scale puts their edges on a fractional device pixel.
          ctx.drawImage(t.img, x, y, g.size + 1, g.size + 1);
          continue;
        }
        ctx.strokeRect(x + 0.5, y + 0.5, g.size - 1, g.size - 1);
        // The label is the file name the extraction would write: it is how an
        // operator checks orientation where there is no tile to draw.
        if (g.size > 64) ctx.fillText(`${row}_${col}`, x + 6, y + 5);
      }
    }
  }

  /**
   * The prefix decimated to screen resolution, cached across frames.
   *
   * The tolerance comes from the scale alone, so the result is independent of
   * the offset: a pan — the gesture that redraws every frame — reuses it, and
   * only a zoom or a freshly built prefix rebuilds. Identity is enough to spot
   * the latter because the effect that owns `route` assigns a new array every
   * time, including the empty one on a mode swap.
   */
  function drawnRoute(): { x: number; y: number }[] {
    if (route === routeSrc && view.scale === routeScale) return routeDrawn;
    routeSrc = route;
    routeScale = view.scale;
    routeDrawn = decimateRoute(route, worldPerPixel(view.scale));
    return routeDrawn;
  }

  /** The path walked so far on this map, behind the pip. Replay only. */
  function drawRoute(ctx: CanvasRenderingContext2D, points: { x: number; y: number }[]): void {
    if (points.length < 2) return;
    ctx.beginPath();
    for (let i = 0; i < points.length; i++) {
      const p = project(view, points[i]!.x, points[i]!.y);
      if (i === 0) ctx.moveTo(p.sx, p.sy);
      else ctx.lineTo(p.sx, p.sy);
    }
    ctx.lineWidth = 2;
    ctx.globalAlpha = 0.65;
    ctx.strokeStyle = routeColor;
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  /**
   * Where each agent is trying to get to: a dashed line from the pip to the
   * destination of its current or last move, and a marker labelled with what
   * the move was aimed at.
   *
   * Drawn under the pips, so a destination reached (the marker lands under the
   * character) never hides the character. The tone is the intention's own —
   * dashed and bright while it walks, faded once it is over, red when the
   * module refused it or the walk broke down; `lib/mapintent.ts` owns that
   * reading and the staleness bounds, and this only paints.
   */
  function drawIntents(ctx: CanvasRenderingContext2D, list: Pip[], mapId: number): boolean {
    // The feed's own clock, not the wall clock: a replayed intention was
    // recorded hours or months ago, and ageing it against `Date.now()` would
    // drop every one of them as stale. Live, the two are the same thing.
    const now = replayId() === undefined ? Date.now() : cursor();
    let drew = false;
    ctx.textBaseline = "middle";
    ctx.font = "11px ui-monospace, monospace";
    for (const pip of list) {
      const move = intentToDraw(pip.data.move, mapId, now, feedClock);
      if (move === null) continue;
      const from = project(view, pip.x, pip.y);
      const to = project(view, move.x, move.y);
      const tone = intentTone(move.status);
      // Nothing to say when the destination is under the character at this
      // zoom: an arrived move is exactly that, and a marker on top of the pip
      // is clutter, not information. A move still walking earns a much smaller
      // separation — where an agent is *headed* is the live fact, and at the
      // whole-world zoom a 250y walk is a handful of pixels.
      if (Math.hypot(to.sx - from.sx, to.sy - from.sy) < (tone === "walking" ? DEST_MIN_PX_LIVE : DEST_MIN_PX)) {
        continue;
      }
      if (to.sx < -80 || to.sy < -40 || to.sx > W + 80 || to.sy > H + 40) continue;
      drew = true;
      const color = tone === "failed" ? INTENT_FAIL : colorOf(pip.runId);
      ctx.save();
      ctx.globalAlpha = tone === "walking" ? 0.9 : 0.4;
      ctx.strokeStyle = color;
      ctx.lineWidth = tone === "walking" ? 2 : 1;
      ctx.setLineDash(tone === "walking" ? [7, 5] : [3, 5]);
      ctx.beginPath();
      ctx.moveTo(from.sx, from.sy);
      ctx.lineTo(to.sx, to.sy);
      ctx.stroke();
      // The destination itself: a ring, crossed when the move failed there.
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.arc(to.sx, to.sy, DEST_R, 0, Math.PI * 2);
      ctx.stroke();
      if (tone === "failed") {
        ctx.beginPath();
        ctx.moveTo(to.sx - DEST_R, to.sy - DEST_R);
        ctx.lineTo(to.sx + DEST_R, to.sy + DEST_R);
        ctx.moveTo(to.sx + DEST_R, to.sy - DEST_R);
        ctx.lineTo(to.sx - DEST_R, to.sy + DEST_R);
        ctx.stroke();
      }
      const label = intentLabel(move) + (move.status === null ? "" : ` · ${move.status}`);
      const w = ctx.measureText(label).width;
      ctx.globalAlpha = tone === "walking" ? 0.75 : 0.35;
      ctx.fillStyle = theme.bg;
      ctx.fillRect(to.sx + DEST_R + 3, to.sy - 8, w + 6, 16);
      ctx.globalAlpha = tone === "walking" ? 1 : 0.55;
      ctx.fillStyle = tone === "failed" ? INTENT_FAIL : theme.dim;
      ctx.fillText(label, to.sx + DEST_R + 6, to.sy + 1);
      ctx.restore();
    }
    return drew;
  }

  /**
   * The legend for the above, bottom-left, and only while something is drawn.
   *
   * On the canvas rather than in the DOM because it explains marks the canvas
   * makes: the swatches are the same strokes, drawn by the same code, so the
   * legend cannot drift from what the map actually looks like.
   */
  function drawIntentLegend(ctx: CanvasRenderingContext2D, intents: boolean, resting: boolean): void {
    const rows: [string, string, IntentTone][] = intents
      ? [
          ["heading for", theme.dim, "walking"],
          ["move ended", theme.dim, "ended"],
          ["move failed", INTENT_FAIL, "failed"],
        ]
      : [];
    const height = (rows.length + (resting ? 1 : 0)) * 16;
    const x = 12;
    let y = H - 12 - height;
    ctx.save();
    ctx.textBaseline = "middle";
    ctx.font = "11px ui-monospace, monospace";
    ctx.globalAlpha = 0.75;
    ctx.fillStyle = theme.bg;
    ctx.fillRect(x - 6, y - 10, 132, height + 10);
    for (const [text, color, tone] of rows) {
      ctx.globalAlpha = tone === "walking" ? 0.9 : 0.45;
      ctx.strokeStyle = color;
      ctx.lineWidth = tone === "walking" ? 2 : 1;
      ctx.setLineDash(tone === "walking" ? [7, 5] : [3, 5]);
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + 24, y);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
      ctx.fillStyle = tone === "failed" ? INTENT_FAIL : theme.dim;
      ctx.fillText(text, x + 32, y);
      y += 16;
    }
    if (resting) {
      // The same glyph the pips wear, drawn by the same call, so the legend
      // cannot describe a mark the map does not make.
      ctx.globalAlpha = 1;
      drawRestGlyph(ctx, x + 12, y, { rise: 0, alpha: 0.9 });
      ctx.fillStyle = theme.dim;
      ctx.fillText("reflecting", x + 32, y);
    }
    ctx.restore();
  }

  /**
   * The rest mark: a small "Zz" above and right of a pip, the way the client
   * marks a resting character. Purple rather than the run's colour — it says
   * something about the harness's loop, not about which run this is.
   */
  function drawRestGlyph(
    ctx: CanvasRenderingContext2D,
    sx: number,
    sy: number,
    phase: { rise: number; alpha: number },
  ): void {
    ctx.save();
    ctx.globalAlpha = phase.alpha;
    ctx.fillStyle = REST_TINT;
    ctx.textBaseline = "middle";
    ctx.font = "italic 700 13px ui-monospace, monospace";
    ctx.fillText("Zz", sx, sy - phase.rise);
    ctx.restore();
  }

  function drawPips(ctx: CanvasRenderingContext2D, list: Pip[], sel: AgentPosition | null): void {
    const now = Date.now();
    // Staleness is against the feed's own clock: the cursor in a replay, where
    // every sample is hours or months old on the wall and none of them is
    // "stale" — the character was exactly there, then. Live, the two agree.
    const ageRef = replayId() === undefined ? now : cursor();
    ctx.textBaseline = "middle";
    ctx.font = "12px ui-monospace, monospace";
    for (const pip of list) {
      const p = project(view, pip.x, pip.y);
      if (p.sx < -60 || p.sy < -30 || p.sx > W + 60 || p.sy > H + 30) continue;
      const stale = positionAgeMs(pip.data.ts, ageRef, feedClock) > STALE_MS;
      const on = sel !== null && pip.runId === sel.runId;
      ctx.globalAlpha = stale ? 0.4 : 1;
      /*
       * The model's logo where the position names a model we recognise and its
       * asset has decoded, and the colored dot everywhere else — an
       * unknown model, or a logo still loading, is the pip the map always had.
       * The puck is light on purpose: a mono icon paints `currentColor`, which
       * an image document resolves to black, so it needs a light ground in both
       * themes. Run identity stays with the colour — the trail and the
       * sidebar's swatch are still the run's, not the model's.
       */
      const logo = logoImageOf(pip.data.model);
      if (logo !== null) {
        const r = on ? PUCK_R_SEL : PUCK_R;
        ctx.beginPath();
        ctx.arc(p.sx, p.sy, r, 0, Math.PI * 2);
        ctx.fillStyle = "#ffffff";
        ctx.fill();
        ctx.lineWidth = on ? 2 : 1;
        ctx.strokeStyle = on ? theme.fg : theme.line;
        ctx.stroke();
        const s = on ? LOGO_SEL : LOGO;
        ctx.drawImage(logo, p.sx - s / 2, p.sy - s / 2, s, s);
      } else {
        ctx.beginPath();
        ctx.arc(p.sx, p.sy, on ? DOT_R_SEL : DOT_R, 0, Math.PI * 2);
        ctx.fillStyle = colorOf(pip.runId);
        ctx.fill();
        if (on) {
          ctx.lineWidth = 2;
          ctx.strokeStyle = theme.fg;
          ctx.stroke();
        }
      }
      const name = pipName(pip.data);
      // Clear of whatever was drawn: the puck is wider than the dot it replaces.
      const edge = logo !== null ? (on ? PUCK_R_SEL + 2 : PUCK_R + 2) : DOT_R + 4;
      // The label chip takes the page's own background and foreground so it
      // stays legible when the viewer flips to the light scheme.
      ctx.fillStyle = theme.bg;
      ctx.globalAlpha = stale ? 0.3 : 0.75;
      const w = ctx.measureText(name).width;
      ctx.fillRect(p.sx + edge, p.sy - 8, w + 6, 16);
      ctx.globalAlpha = stale ? 0.4 : 1;
      ctx.fillStyle = theme.fg;
      ctx.fillText(name, p.sx + edge + 3, p.sy + 1);
      ctx.globalAlpha = 1;
      if (pip.data.reflecting === true) {
        const ph = restPhase(now, reduceMotion);
        drawRestGlyph(ctx, p.sx + edge - 2, p.sy - 14, {
          rise: ph.rise,
          alpha: stale ? ph.alpha * 0.4 : ph.alpha,
        });
      }
    }
  }

  onMount(() => {
    readTheme();
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(stage);

    const mq = window.matchMedia?.("(prefers-color-scheme: dark)");
    mq?.addEventListener("change", readTheme);

    const motionMq = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    const readMotion = (): void => {
      reduceMotion = motionMq?.matches === true;
      needsDraw = true;
    };
    readMotion();
    motionMq?.addEventListener("change", readMotion);

    // A logo that decodes after the frame that wanted it has no signal to
    // invalidate, so it asks for a redraw the same way a tile does.
    const offLogo = onLogoLoaded(() => {
      needsDraw = true;
    });

    let raf = 0;
    const frame = (): void => {
      const ctx = canvas.getContext("2d");
      if (ctx !== null) {
        const list = onMap();
        const moving = stepPips(list);
        // A drifting rest glyph is the one mark that changes with nothing else
        // changing, so it has to keep the loop drawing; under reduced motion it
        // is static and asks for nothing.
        const resting = list.some((p) => p.data.reflecting === true);
        if (needsDraw || moving || (resting && !reduceMotion)) {
          needsDraw = false;
          ctx.clearRect(0, 0, W, H);
          // There is always a map to draw: `chooseMap` falls back to the
          // default continent, so an empty feed gets tiles rather than the flat
          // rectangle this used to paint when it had no map id.
          const map = activeMap();
          drawGrid(ctx, map);
          // The route is cached twice over: the effect that owns it rebuilds
          // the prefix only when the cursor or map moves, and `drawnRoute`
          // decimates that to screen resolution only when the zoom changes.
          // Recomputing either per pointer-move frame is the one thing in this
          // loop that scales with the length of a run.
          drawRoute(ctx, drawnRoute());
          const intents = drawIntents(ctx, list, map);
          if (intents || resting) drawIntentLegend(ctx, intents, resting);
          drawPips(ctx, list, selected());
        }
      }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);

    /*
     * The transport's keyboard, on the document so it works with the canvas
     * focused or nothing focused at all. A key that belongs to a focused
     * control — space on a button, typing in the series select — is left to it.
     */
    const onKey = (e: KeyboardEvent): void => {
      if (track() === undefined || e.altKey || e.ctrlKey || e.metaKey) return;
      if (keyBelongsToTarget((e.target as HTMLElement | null)?.tagName)) return;
      const action = playbackKey(e.key);
      if (action === null) return;
      e.preventDefault();
      switch (action) {
        case "toggle":
          togglePlay();
          break;
        case "back":
          stepBack();
          break;
        case "forward":
          stepForward();
          break;
        case "start":
          jumpTo("start");
          break;
        case "end":
          jumpTo("end");
          break;
      }
    };
    document.addEventListener("keydown", onKey);

    onCleanup(() => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      mq?.removeEventListener("change", readTheme);
      motionMq?.removeEventListener("change", readMotion);
      offLogo();
      document.removeEventListener("keydown", onKey);
    });
  });

  /*
   * The route change *is* the state swap, and this is the only place that
   * performs it. Live → replay, replay → live, and one replay straight to
   * another all arrive here, whether from the controls below, browser
   * back/forward, or a deep link opened cold: `replayId` reads the search
   * params, so every one of those is the same code path.
   *
   * The clear is unconditional and comes before the fetch. Doing it in the
   * response, as this used to, layers rather than swaps — run A's pips stay on
   * screen under run B's identity until B's track lands. A blank moment is the
   * honest picture of "we are between two states".
   */
  let trackToken = 0;
  const leftReplay = createLeftReplay();
  createEffect(() => {
    const id = replayId();
    const returningToLive = leftReplay(id);
    const mine = ++trackToken;
    clearReplayState({
      setTrack: (t) => setTrack(() => t),
      setCursor,
      setPlaying,
      setPinned: setPinnedMap,
      setSelectedId,
      setFeed: (list) => setFeedList(() => list),
      setError: setReplayError,
    });
    pips.clear();
    route = [];
    pendingFit = true;
    /*
     * The camera goes back to the default with the rest of it. `pendingFit`
     * alone would not do it: nothing re-reads the flag until a feed arrives or
     * the stage resizes, so leaving a replay onto a quiet fleet would keep the
     * replay's continent framing while the map underneath became the default
     * one — Northrend's camera over Eastern Kingdoms' tiles. Coming back to a
     * busy map this shows the starter framing for the one round-trip before the
     * refresh lands and the fit effect overwrites it, which is the right
     * intermediate: a foreign continent's camera is not.
     */
    view = defaultView({ w: W, h: H });
    needsDraw = true;
    if (id === undefined) {
      // Only when leaving a replay, never on a cold load — see createLeftReplay.
      if (returningToLive) feed.refresh();
      return;
    }
    void api
      .track(id)
      .then((t) => {
        if (mine !== trackToken) return;
        setTrack(t);
        // Where this run was last left off, if it was — see cursormemory.ts.
        // The route effect above has just cleared the cursor, so this is the
        // one place a loaded track's cursor is chosen.
        setCursor(cursorMemory.resume(t));
        pendingFit = true;
        needsDraw = true;
      })
      .catch((e: unknown) => {
        logError("map replay", e);
        if (mine === trackToken) setReplayError(displayError(e));
      });
  });

  /*
   * The one place a feed reaches the renderer, live or replayed.
   *
   * Reads: track, cursor, feed.latest. Writes: the feed signal, and the pip map
   * the canvas owns. Nothing it reads is downstream of what it writes, which is
   * the property the old version violated — it wrote a freshly built position
   * into a signal it read in the same scope, so every tick re-entered itself.
   */
  createEffect(() => {
    const t = track();
    if (t !== undefined) {
      const list = positionsAt(t, cursor());
      // A replayed sample's age is not a freshness claim; the plain arithmetic applies.
      feedClock = null;
      syncPips(pips, list, true);
      setFeedList(list);
    } else {
      const list = feedPositions();
      feedClock = feed.latest?.clock ?? null;
      syncPips(pips, list);
      setFeedList(list);
    }
    needsDraw = true;
  });

  /*
   * Following the cursor across a continent is the honest behaviour: the
   * character is not on the map the operator was looking at any more, so the
   * chip they pinned stops applying and the view refits.
   *
   * Terminates: cursorMap changes → this writes pinnedMap → activeMap
   * recomputes from maps/pinned/cursorMap → writes nothing.
   */
  createEffect(
    on(cursorMap, (map) => {
      if (map === null) return;
      setPinnedMap(null);
      pendingFit = true;
    }),
  );

  /*
   * Fitting the view, on the three occasions someone asked for it: the first
   * map to appear, a track load, and a chip click. Deliberately *not* on every
   * change of `activeMap` — an unrelated agent logging out can flip which map
   * is busiest, and yanking a panned view out from under an operator for that
   * would be hostile.
   */
  createEffect(() => {
    const map = activeMap();
    const list = feedList();
    if (!pendingFit || list.length === 0) return;
    pendingFit = false;
    view = fitTo(
      { w: W, h: H },
      list.filter((p) => p.map === map),
    );
    needsDraw = true;
  });

  /* The drawn route, recomputed when its inputs move rather than per frame. */
  createEffect(() => {
    const t = track();
    const map = activeMap();
    const ts = cursor();
    route = t === undefined ? [] : routeUpTo(t.points, map, ts);
    routeColor = colorOf(t?.runId ?? "");
    needsDraw = true;
  });

  /*
   * The transport's deliberate moves. Every one of them goes through `seek`,
   * which is the only place besides the track load that the cursor is set —
   * and the only place it is remembered (`cursormemory.ts`: remembered at the
   * deliberate moves, never from an effect, because the route swap zeroes the
   * cursor on the way out and an effect would record that).
   */
  const seek = (ts: number): void => {
    const t = track();
    if (t === undefined) return;
    setCursor(ts);
    cursorMemory.remember(t.runId, ts);
  };
  const stepBack = (): void => {
    const t = track();
    if (t === undefined) return;
    setPlaying(false);
    const prev = prevSampleBefore(t.points, cursor());
    if (prev !== undefined) seek(prev.ts);
  };
  const stepForward = (): void => {
    const t = track();
    if (t === undefined) return;
    setPlaying(false);
    const next = nextSampleAfter(t.points, cursor());
    if (next !== undefined) seek(next.ts);
  };
  const jumpTo = (edge: "start" | "end"): void => {
    const sp = span();
    if (sp === null) return;
    setPlaying(false);
    seek(edge === "start" ? sp.from : sp.to);
  };
  /**
   * Play from the end starts over: a transport whose play button does nothing
   * because the cursor happens to be on the last sample reads as broken.
   */
  const togglePlay = (): void => {
    const t = track();
    if (t === undefined || !scrubbable()) return;
    if (playing()) {
      setPlaying(false);
      return;
    }
    if (nextSampleAfter(t.points, cursor()) === undefined) seek(span()!.from);
    setPlaying(true);
  };

  /*
   * Playback: one recorded sample per tick, so a 6h run scrubs in ~30s at 1×.
   * The successor is a binary search rather than a scan — at four ticks a
   * second over a long track the scan was the page's largest repeated cost.
   * The speed is read here so a change mid-play restarts the interval.
   */
  createEffect(() => {
    if (!playing()) return;
    const t = track();
    if (t === undefined) return;
    const timer = setInterval(() => {
      const next = nextSampleAfter(t.points, cursor());
      if (next === undefined) setPlaying(false);
      else seek(next.ts);
    }, tickMs(speed()));
    onCleanup(() => clearInterval(timer));
  });

  /* --- interaction --- */
  let drag: { x: number; y: number; ox: number; oy: number; moved: boolean } | null = null;

  const onPointerDown = (e: PointerEvent): void => {
    drag = { x: e.clientX, y: e.clientY, ox: view.ox, oy: view.oy, moved: false };
    canvas.setPointerCapture(e.pointerId);
    canvas.classList.add("drag");
  };
  const onPointerMove = (e: PointerEvent): void => {
    if (drag === null) return;
    const dx = e.clientX - drag.x;
    const dy = e.clientY - drag.y;
    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) drag.moved = true;
    view = { ...view, ox: drag.ox + dx, oy: drag.oy + dy };
    needsDraw = true;
  };
  const onPointerUp = (e: PointerEvent): void => {
    const wasDrag = drag !== null && drag.moved;
    drag = null;
    canvas.classList.remove("drag");
    if (wasDrag) return;
    const r = canvas.getBoundingClientRect();
    const hit = hitTest(view, onMap(), e.clientX - r.left, e.clientY - r.top, PIP_HIT_R);
    setSelectedId(hit === null ? null : hit.runId);
    needsDraw = true;
  };
  const onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    const r = canvas.getBoundingClientRect();
    view = zoomAt(view, e.clientX - r.left, e.clientY - r.top, Math.exp(-e.deltaY * 0.0015));
    needsDraw = true;
  };

  const pickMap = (map: number): void => {
    if (map === activeMap()) return;
    setPinnedMap(map);
    setSelectedId(null);
    pendingFit = true;
  };

  return (
    <div class="map-wrap">
      <div class="map-stage" ref={stage}>
        <canvas
          ref={canvas}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={() => {
            drag = null;
            canvas.classList.remove("drag");
          }}
          onWheel={onWheel}
        />
        <div class="map-chips">
          <Show when={maps().length > 1}>
            <For each={maps()}>
              {([map, n]) => (
                <button
                  class={map === activeMap() ? "on" : ""}
                  onClick={() => pickMap(map)}
                  title={`map ${map}`}
                >
                  {mapName(map)} · {n}
                </button>
              )}
            </For>
          </Show>
        </div>
        <PlayBar
          replayId={replayId()}
          track={track()}
          replayError={replayError()}
          feedError={feed.error === undefined ? undefined : displayError(feed.error)}
          cursor={cursor()}
          playing={playing()}
          speed={speed()}
          count={count()}
          seriesHidden={seriesHidden()}
          liveSeries={liveSeries()}
          selected={selected()}
          onSeek={(ts) => {
            setPlaying(false);
            seek(ts);
          }}
          onTogglePlay={togglePlay}
          onStepBack={stepBack}
          onStepForward={stepForward}
          onCycleSpeed={() => setSpeed(nextSpeed(speed()))}
        />
      </div>
      <div class="side">
        <Show
          when={selected()}
          fallback={
            <span class="dim">
              {emptySideNote(count(), replayId() !== undefined, activeMap())}
            </span>
          }
        >
          {(p) => (
            <>
              <h3>
                <span class="swatch" style={{ background: colorOf(p().runId) }} />
                <span title={p().runId}>{pipName(p())}</span>
              </h3>
              <div class="k">model</div>
              <div class="v">
                <ModelIcon model={p().model} />
                <span title={p().model ?? ""}>{p().model === null ? "—" : modelDisplay(p().model!)}</span>
              </div>
              <div class="v">
                <UnitFrame
                  level={p().level}
                  xp={p().xp}
                  nextLevelXp={p().nextLevelXp}
                  health={p().health}
                  maxHealth={p().maxHealth}
                  power={p().power}
                  maxPower={p().maxPower}
                  powerType={resolvePowerType(p().powerType, p().class)}
                />
              </div>
              <div class="k">money</div>
              <div class="v mono">{fmtMoney(p().money)}</div>
              <div class="k">quests completed</div>
              <div class="v mono">{num(p().questsCompleted)}</div>
              {/*
                Inventory: the bag opens over the sidebar rather
                than widening it, and the paperdoll sits under it. A replay
                cursor reads the newest sample behind it (`lib/replay.ts`), and
                before the first one there is nothing to show — which the null
                line says rather than drawing empty bags.
              */}
              <div class="k">inventory</div>
              <div class="v">
                <Show when={p().items} fallback={<span class="inv-note">{fmtItems(p().items, false)}</span>}>
                  {(items) => <InventoryPanel items={items()} />}
                </Show>
              </div>
              <div class="k">map</div>
              <div class="v" title={`map ${p().map}`}>
                {mapName(p().map)}
              </div>
              <div class="k">position</div>
              <div class="v mono">
                {p().x.toFixed(1)}, {p().y.toFixed(1)}
              </div>
              <div class="k">last update</div>
              {/*
                The pips' own arithmetic (`positionAgeMs`), not the browser's:
                on the public build a reading is already up to a publish cadence
                old when it arrives, and the sidebar was reporting that delay as
                the character standing still. Null clock in a replay and on the
                private API, where the plain subtraction is right. In a replay
                the reference is the cursor, not this browser's clock: the
                sample's age is how far behind the cursor it is.
              */}
              <div class="v">
                {fmtAge(
                  positionAgeMs(
                    p().ts,
                    track() === undefined ? ageTick() : cursor(),
                    feed.latest?.clock ?? null,
                  ),
                )}
              </div>
              <div class="k">harness</div>
              <div class="v">{shortHarness(p().harnessVersion)}</div>
              {/*
                Both ways out of a selected pip, as one row of controls rather
                than two bare links stacked in the panel's key/value flow — the
                same `.side-controls` shape the run page uses, so the pair reads
                as controls. The replay link is absent rather than inert when it
                would point at the run already on screen.
              */}
              <Show when={p().status}>
                {(st) => (
                  <div class="side-status">
                    <div class="k">
                      status
                      <Show when={p().reflecting === true}>
                        <span class="reflecting" title="reflecting: thinking rather than acting">
                          Zz
                        </span>
                      </Show>
                    </div>
                    <div class="stamp mono">{statusStamp(st())}</div>
                    <div class="text">{st().text}</div>
                  </div>
                )}
              </Show>
              <div class="side-controls">
                <A class="btn" href={`/run/${encodeURIComponent(p().runId)}`}>
                  open run →
                </A>
                <Show when={replayHrefFor(track(), p())}>
                  {(href) => (
                    <A class="btn" href={href()}>
                      replay →
                    </A>
                  )}
                </Show>
              </div>
            </>
          )}
        </Show>
      </div>
    </div>
  );
}
