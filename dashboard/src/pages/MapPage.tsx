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
 * Canvas drawing sits outside Solid's reactivity on purpose. Pips move every
 * frame, so the draw loop is a requestAnimationFrame with its own mutable
 * state; Solid owns the sidebar, the chips and the header, which change once
 * per poll or a few times a second. The loop runs every frame but draws only
 * what changed: the ground (tiles, lattice, art) on its own canvas when its
 * view or its sources move, the marks over it when something on them has
 * visibly moved (dashboard/README.md, "The map's redraws").
 *
 * Where a run recorded a trace, a pip is *placed* every frame rather than
 * walked toward its newest reading: the trace player (`lib/traceplayer.ts`)
 * says where the character was at the playhead, and the playhead is one clock
 * for the whole map — live, a delay behind the feed sized from its cadence;
 * in a replay, the cursor at a wall-clock speed. A run with no trace, and any
 * moment the trace cannot answer for, draws as it did: a live pip lerps to its
 * reading, a replayed one is time-interpolated along the 60 s track.
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
import { For, Show, createEffect, createMemo, createSignal, on, onCleanup, onMount, untrack } from "solid-js";
import { api, type AgentPosition, type TrackResponse } from "../api/client";
import { ModelIcon, logoImageOf, onLogoLoaded } from "../components/ModelIcon";
import { PlayBar } from "../components/PlayBar";
import { UnitFrame } from "../components/UnitFrame";
import { InventoryPanel } from "../components/Inventory";
import { LiveList } from "../components/LiveList";
import { sheetReading } from "../lib/inventory";
import { questLog } from "../lib/questlog";
import { cursorMemory } from "../lib/cursormemory";
import { intentLabel, intentToDraw, intentTone, type IntentTone } from "../lib/mapintent";
import { restFrameDue, restPhase, statusStamp } from "../lib/reflect";
import {
  type UnitFlag,
  auraViews,
  castReading,
  gaugesOf,
  resolvePowerType,
  sameAuras,
  targetReading,
  unitFlags,
} from "../lib/unitframe";
import { NO_TILE_BASE, nativeFormat, tileIndexSrc, tileSrc } from "../lib/tiles";
import { type TileIndex, parseTileIndex } from "@viewer/tileindex";
import {
  type NearbyDot,
  type ScreenBox,
  LABEL_RANK,
  NEARBY_FETCH_SPAN_MS,
  createNearbyStore,
  cullLabels,
  nearbyFrameDue,
  placeLabel,
} from "../lib/nearbyplayer";
import { type LodLayer, ART_LAYER, LOD_MAX, MINIMAP_LAYER } from "@viewer/worldmap";
import { fmtAge, fmtItems, fmtMoney, modelDisplay, num, shortHarness, shortRunId } from "../lib/format";
import {
  type Speed,
  DEFAULT_SPEED,
  IDLE_GAP_MS,
  idleSpans,
  keyBelongsToTarget,
  nextSpeed,
  playbackKey,
  prevSampleBefore,
  traceDrives as traceDrivesAt,
} from "../lib/playback";
import {
  type ReplayAnchor,
  type TrailRun,
  LIVE_REACH,
  TRAIL_MS,
  createLiveClock,
  createTraceStore,
  horizonOf,
  ingestPositions,
  ingestIndex,
  ingestTrack,
  ingestTracks,
  replaySpan,
  replaySpans,
  liveCadence,
  replayCursorAt,
  replayReach,
} from "../lib/traceplayer";
import {
  clearReplayState,
  createLeftReplay,
  createMapState,
  replayHrefFor,
} from "../lib/mapstate";
import { createMapFit } from "../lib/mapfit";
import { bubbleLifeMs, bubblesAt, layoutStacks, stacksKey, type BubbleStack, type StackBox } from "../lib/chatbubbles";
import {
  DEFAULT_MAP,
  STALE_MS,
  TILE_CACHE_MAX,
  type DrawnPose,
  type FeedClock,
  type LayerKey,
  type Pip,
  type Touch,
  type View,
  colorOf as runColorOf,
  decimateRoute,
  defaultView,
  drawnPose,
  emptySideNote,
  fitTo,
  cellAbsent,
  frameLevels,
  headingOnScreen,
  hitTest,
  isDoubleTap,
  latticeLines,
  layerDue,
  minimapHidden,
  levelCellPx,
  mapChips,
  mapName,
  mapParam,
  NEARBY_DOT_R,
  NEARBY_HIT_R,
  nearbyColor,
  nearbyNamesShown,
  nearbyShown,
  pinchView,
  pipName,
  posesMoved,
  positionAgeMs,
  project,
  MOVE_PX,
  stepPips,
  syncPips,
  trailFadeDue,
  visibleGrid,
  worldPerPixel,
  zoomAt,
} from "../lib/mapview";
import { poll } from "../lib/poll";
import { useClock } from "../lib/clock";
import { visibleInterval } from "../lib/visibleinterval";
import {
  type RouteRun,
  classifySegments,
  indexAt,
  itemsAtCursor,
  nextSampleAfter,
  positionsAt,
  routeUpTo,
  runParam,
  trackPoseAt,
  trackSpan,
} from "../lib/replay";
import { displayError, logError } from "../lib/errors";
import { MEMBER_SLOTS, groupTrack, loadParty, memberClass, memberToken, partyHref, partyParam, type PartyView } from "../lib/party";

const POLL_MS = 5000;

/**
 * How often the per-frame playhead reaches Solid: the replay cursor while it
 * plays (the scrubber, the clock, the route and the sidebar), and the live
 * playhead (the sidebar's unit frame). The canvas reads the playhead itself
 * every frame; at frame rate these would rebuild the route sixty times a
 * second for no visible gain.
 */
const CURSOR_TICK_MS = 100;
const PLAYHEAD_TICK_MS = 250;
/** How often the page asks the trace store for the windows the playhead is about to reach. */
const PUMP_MS = 1000;
/** A fading trail redraws at least this often, so it fades behind a pip standing still. */
const TRAIL_FRAME_MS = 250;
/**
 * The live marks redraw at least this often with nothing moving, for what
 * changes with time alone: a reading turning stale, an intention ageing out.
 */
const OVERLAY_HEARTBEAT_MS = 1000;
/** The trail's opacity next to the pip; it fades to nothing `TRAIL_MS` back. */
const TRAIL_ALPHA = 0.7;
/** The heading mark: how far past the puck its tip reaches, and how wide its base is. */
const HEADING_LEN = 9;
const HEADING_HALF = 5;

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
  // The nearby layer's classes (`nearbyColor`) and its quest marks.
  err: "#f7768e",
  ok: "#9ece6a",
  accent: "#7aa2f7",
  warn: "#e0af68",
};
/** A nearby unit's label: smaller than a pip's, in the same chip. */
const NEARBY_FONT = "10px ui-monospace, monospace";
const NEARBY_MARK_FONT = "700 11px ui-monospace, monospace";
/** At most this many unhovered names on screen at once, after overlap culling. */
const NEARBY_LABELS_MAX = 60;
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
/**
 * A flight path's stretch of a replayed route: one colour for every run, the
 * stylesheet's `--flight`, because the run's own colour already says "this
 * run" and the flight has to read as something else beside it.
 */
let FLIGHT = "#bfe6ff";
/**
 * A party's member colours, the stylesheet's `--member-<n>` (`memberToken`),
 * read with the rest of the theme. Five members of one model share one logo,
 * so in a party's replay the colour is each member's identity: the ring round
 * its puck, its route, its legend row.
 */
let MEMBER_COLORS: string[] = ["#e69f00", "#56b4e9", "#cc79a7", "#f0e442", "#009e73"];
/** Whether the viewer asked for less motion; the glyph is drawn either way. */
let reduceMotion = false;

interface TileEntry {
  img: HTMLImageElement;
  /** Loading, drawable, or known not to exist (a 404, or a build with no tile host). */
  state: "pending" | "ok" | "missing";
}

/** One cache key per tile, whatever its layer and level: the native 0_0 and level 1's 0_0 are different tiles. */
function tileKey(map: number, layer: LodLayer, z: number, row: number, col: number): string {
  return `${map}/${layer}/${z}/${row}_${col}`;
}

export default function MapPage() {
  /*
   * The route is the page's mode, and the only mode it has: `/map` is live,
   * `/map?run=<id>` is that run's replay. Everything else the page holds —
   * cursor, playback, the selection, pan and zoom — is per-frame state that
   * would make the URL churn, so none of it goes here. The cursor is
   * remembered per run beside the route instead, so coming back to a replay
   * does not restart it: `lib/cursormemory.ts`.
   *
   * The one exception is the pinned map, `?map=<id>`: a chip click is a
   * deliberate choice, not a frame's worth of state, and a link that opens
   * Kalimdor has to carry it — chips exist only for maps with someone on
   * them, so on a quiet fleet the link is the only way to any other map.
   */
  const [params, setParams] = useSearchParams();
  /*
   * `/map?party=<id>` is a party's replay: every member's track on one clock
   * (`lib/party.ts`). It is the same feed swap as a run's, with five pips; a
   * run id wins where a link names both.
   */
  const runId = (): string | undefined => runParam(params.run);
  const partyId = (): string | undefined => (runId() === undefined ? partyParam(params.party) : undefined);
  /** What the page is replaying, as one key: a run id, or the party's `party:<id>`. Undefined is live. */
  const replayId = (): string | undefined => runId() ?? (partyId() === undefined ? undefined : `party:${partyId()}`);

  /* --- sources: the only writable state on the page --- */
  const [single, setSingle] = createSignal<TrackResponse | undefined>(undefined);
  /** A party's tracks, in member order, and the party they are; undefined outside a party's replay. */
  const [group, setGroup] = createSignal<readonly TrackResponse[] | undefined>(undefined);
  const [party, setParty] = createSignal<PartyView | undefined>(undefined);
  const [cursor, setCursor] = createSignal(0);
  const [playing, setPlaying] = createSignal(false);
  // Playback speed is a viewer preference, not replay state: it survives the
  // swap on purpose, so it is not among the writables `clearReplayState` resets.
  const [speed, setSpeed] = createSignal<Speed>(DEFAULT_SPEED);
  const [replayError, setReplayError] = createSignal<string | undefined>(undefined);
  const [feedList, setFeedList] = createSignal<readonly AgentPosition[]>([]);
  const [pinnedMap, setPinnedMap] = createSignal<number | null>(null);
  const [selectedId, setSelectedId] = createSignal<string | null>(null);
  /** Every replayed track: the run's, or each member's. Empty live. */
  const replayed = createMemo<readonly TrackResponse[]>(() => {
    const g = group();
    if (g !== undefined) return g;
    const s = single();
    return s === undefined ? [] : [s];
  });
  /** The replayed track the map follows: the run's; in a party's, the member picked, the leader until one is. */
  const track = createMemo<TrackResponse | undefined>(() => {
    const g = group();
    if (g === undefined) return single();
    const id = selectedId();
    return g.find((t) => t.runId === id) ?? g[0];
  });
  /** What the transport steps over and the cursor is remembered under: the run's track, or the party's merged one. */
  const playTrack = createMemo<TrackResponse | undefined>(() => {
    const g = group();
    const id = partyId();
    return g === undefined || id === undefined ? single() : groupTrack(id, g);
  });
  /** A party member's place in the party, by run id; undefined for any other run. */
  const memberIndex = createMemo(() => new Map((party()?.members ?? []).map((m) => [m.runId, m.index])));
  /** A run's colour on the canvas: a party member's own, any other run's hue. */
  const colorOf = (id: string): string => {
    const i = memberIndex().get(id);
    return i === undefined ? runColorOf(id) : MEMBER_COLORS[i % MEMBER_SLOTS]!;
  };
  // The sidebar's "last update" ages between polls, so it needs its own tick.
  const ageTick = useClock();
  /*
   * The live playhead as the sidebar reads it, a few times a second, and the
   * trace store's change count, so what the sidebar derives from the store
   * re-reads it when a segment lands. Both written only by the frame loop.
   */
  const [playhead, setPlayhead] = createSignal<number | null>(null);
  const [traceRev, setTraceRev] = createSignal(0);
  /* The nearby store's change count, for the sidebar's count and target name; written only by the frame loop. */
  const [nearbyRev, setNearbyRev] = createSignal(0);

  /*
   * The trace: one store for whichever mode the page is in (the live feed's
   * runs, or the replayed one), and the live clock, re-made on every route
   * swap. The delay is derived from how the client says its feed is made, so
   * the private viewer and the public bucket run the same formula
   * (`liveCadence`): about 12 s here, about 9 minutes there.
   */
  let traceChanged = true;
  const store = createTraceStore({
    onChange: () => {
      traceChanged = true;
      needsDraw = true;
    },
  });
  /*
   * The units around each live character (`lib/nearbyplayer.ts`): each run's
   * newest window, sampled at the same playhead the pips are placed at. Live
   * only — a replay has no units; the public build's windows ride in
   * `live.json`.
   */
  let nearbyChanged = false;
  const nearbyStore = createNearbyStore({
    onChange: () => {
      nearbyChanged = true;
      needsDraw = true;
    },
  });
  /** When each run's window was last asked for (`performance.now()`), so a run is asked once a poll. */
  const nearbyAsked = new Map<string, number>();
  const cadence = liveCadence(api.feedCadence, POLL_MS);
  let liveClock = createLiveClock(cadence);
  /** Set while a replay plays: where and when it started, at what speed. */
  let replayAnchor: ReplayAnchor | null = null;
  const fetchSegment = (runId: string, t0: number) => api.traceSegment(runId, t0);

  // The live feed keeps its 5s poll, and answers with nothing while a replay
  // owns the map — one feed reaches the renderer, never two. The envelope's
  // clock rides along: the public build's positions arrive up to two minutes
  // late through no fault of the agents, and the pips' stale dimming has to
  // age readings against the snapshot's own clock rather than this browser's
  // (`positionAgeMs`). The private build carries no envelope and a null clock.
  //
  // Every answer — a repeat included, which `poll` does not pass on — goes to
  // the trace store and the live clock here, at receipt: the clock is
  // anchored to the moment the data arrived, not to when a render got to it.
  const feed = poll(
    () =>
      replayId() === undefined
        ? api.positions().then((p) => {
            if (replayId() === undefined) {
              const arrival = horizonOf(p, Date.now(), performance.now());
              ingestPositions(store, p.positions);
              if (arrival !== null) liveClock.arrive(arrival);
              queueMicrotask(pumpTraces);
              nearbyStore.retain(p.positions.filter((x) => x.nearby === true).map((x) => x.runId));
              queueMicrotask(() => pumpNearby(true));
            }
            return {
              positions: p.positions,
              clock: p.generatedAt === undefined ? null : { generatedAt: p.generatedAt, fetchedAt: Date.now() },
            };
          })
        : Promise.resolve({ positions: [] as AgentPosition[], clock: null as FeedClock | null }),
    POLL_MS,
  );
  const feedPositions = (): readonly AgentPosition[] => feed.latest?.positions ?? [];

  /*
   * Every live character, whatever harness it runs: the shell's series
   * selector is a comparability filter for pages of results, and the map is
   * a picture of the world right now, so it is not offered here (the shell
   * hides it on this route).
   */
  const { maps, count, cursorMap, activeMap, selected } = createMapState({
    feed: feedList,
    track,
    group,
    pinned: pinnedMap,
    selectedId,
  });

  /** What the replay scrubs over: the points and the trace together (`replaySpan`), every member's in a party. */
  const span = createMemo(() => {
    traceRev();
    const ts = replayed();
    if (ts.length === 0) return null;
    return ts.length === 1 ? replaySpan(ts[0]!, store) : replaySpans(ts, store);
  });
  /** The replay's idle stretches, compressed in playback (`advanceCursor`): where no member moved. Once per load. */
  const idle = createMemo(() => {
    const t = playTrack();
    return t === undefined ? [] : idleSpans(t.points);
  });
  /** A replay is scrubbable only where its samples span some time. */
  const scrubbable = (): boolean => {
    const sp = span();
    return sp !== null && sp.to > sp.from;
  };
  /**
   * Set while a freshly loaded replay's cursor is still at its start and the
   * reader has not moved it: the trace's span arrives after the track and can
   * begin before its first point, and the replay should open where the
   * record does.
   */
  let followStart = false;
  /* The cursor stays inside the span as the trace's half of it arrives and tightens. */
  createEffect(
    on(span, (sp) => {
      if (sp === null || untrack(playing)) return;
      const c = untrack(cursor);
      const next = followStart ? sp.from : Math.min(sp.to, Math.max(sp.from, c));
      if (next !== c) setCursor(next);
    }),
  );

  /* The marks, which take the pointer, over the ground: two canvases (`layerDue`). */
  let canvas!: HTMLCanvasElement;
  let ground!: HTMLCanvasElement;
  let stage!: HTMLDivElement;

  /*
   * The chat bubbles (`lib/chatbubbles.ts`): which are up is a signal, written
   * by the frame loop only when the set changes, and where each stack sits is
   * set on its element by the same loop, every frame the map is drawn. Each
   * stack's size is measured when the set changes or the stage resizes, not
   * per frame.
   */
  const [bubbleStacks, setBubbleStacks] = createSignal<BubbleStack[]>([]);
  const stackEls = new Map<string, HTMLDivElement>();
  const stackSizes = new Map<string, { w: number; h: number }>();
  let bubblesShown = "";
  let bubblesMeasure = false;

  /* Mutable render state — read every frame, never through a signal. */
  const pips = new Map<string, Pip>();
  /* The live feed's reference clock, beside the pips it dates; null in a replay. */
  let feedClock: FeedClock | null = null;
  const tiles = new Map<string, TileEntry>();
  let view: View = { scale: 0.25, ox: 0, oy: 0 };
  let route: RouteRun[] = [];
  let routeColor = "";
  /* The decimation of `route` last handed to the canvas, and what it was for. */
  let routeDrawn: RouteRun[] = [];
  let routeSrc: RouteRun[] | null = null;
  let routeScale = 0;
  /* The overlay's own invalidation; the ground redraws by its key, and `groundRev` is the part of it no view change moves. */
  let needsDraw = true;
  let groundRev = 0;
  let W = 0;
  let H = 0;
  /*
   * Fitting is deliberate, not reactive: on the first map to appear, a track
   * load, a chip click, and a replay's cursor crossing to another continent
   * (`lib/mapfit.ts`, which says why a crossing fits on the spot).
   */
  const mapFit = createMapFit({
    activeMap,
    feed: feedList,
    cursorMap,
    fit: (here) => {
      view = fitTo({ w: W, h: H }, here);
      needsDraw = true;
    },
    onCross: () => {
      setPinnedMap(null);
      // A link that still named the old map would reopen it rather than follow.
      if (params.map !== undefined) setParams({ map: null }, { replace: true });
    },
  });
  let theme = { ...DEFAULT_THEME };
  /*
   * The art layer is drawn here at full strength and then laid over the map
   * in one blit at its blend weight. Drawing its tiles straight onto the map
   * at partial alpha would double the weight wherever two draws overlap — the
   * hair of overdraw between neighbouring tiles, a coarser tile under one
   * still loading — and show as a grid across the art.
   */
  const artCanvas = document.createElement("canvas");

  /*
   * Each map's tile index (`@viewer/tileindex`), fetched once: which cells
   * exist, and where the art hides the minimap. Until it answers no tile of
   * that map is requested, so a first frame does not probe every absent cell;
   * a 404, a failure or a slow answer is null, and every cell is asked for as
   * it was before indexes existed.
   */
  const indexes = new Map<number, TileIndex | null | "loading">();
  const INDEX_TIMEOUT_MS = 3000;
  function tileIndex(map: number): TileIndex | null | undefined {
    const have = indexes.get(map);
    if (have !== undefined) return have === "loading" ? undefined : have;
    const src = tileIndexSrc(map);
    if (src === null) {
      indexes.set(map, null);
      return null;
    }
    indexes.set(map, "loading");
    fetch(src, { signal: AbortSignal.timeout(INDEX_TIMEOUT_MS) })
      .then((r) => (r.ok ? r.json() : null))
      .then(
        (raw: unknown) => indexes.set(map, parseTileIndex(raw)),
        () => indexes.set(map, null),
      )
      .finally(() => {
        groundRev++;
      });
    return undefined;
  }
  const waiting = new Image();

  /*
   * Tiles: an LRU of Image objects with misses remembered in the same map,
   * every layer and pyramid level in the one cache. Before the extraction has
   * run every visible tile is missing, and an unremembered miss would
   * re-request dozens of them on every pan. `tileLevel` keeps a frame's
   * level, and the one above it that is drawn while it loads, inside the cap.
   */
  function tile(map: number, layer: LodLayer, z: number, row: number, col: number): TileEntry {
    const key = tileKey(map, layer, z, row, col);
    const hit = tiles.get(key);
    if (hit !== undefined) {
      tiles.delete(key);
      tiles.set(key, hit);
      return hit;
    }
    const index = tileIndex(map);
    // The index is still on its way: pending, and not cached, so the next
    // frame after it lands decides for real.
    if (index === undefined) return { img: waiting, state: "pending" };
    const img = new Image();
    const entry: TileEntry = { img, state: "missing" };
    // Null means this build was given no tile host and must not ask for one
    // (`lib/tiles.ts`); a cell the index does not list does not exist.
    // Either is remembered as a miss like any other, so the grid is drawn and
    // nothing is requested. The natives come in the format the index names.
    const src = cellAbsent(index, layer, z, row, col) ? null : tileSrc(map, layer, z, row, col, nativeFormat(index));
    if (src !== null) {
      entry.state = "pending";
      img.onload = (): void => {
        entry.state = "ok";
        groundRev++;
      };
      // One redraw per miss, never a re-request: the entry stays cached as
      // missing. The redraw is what gives a cell that was drawn from a coarser
      // level while it loaded its lattice square, now that it is known empty.
      img.onerror = (): void => {
        entry.state = "missing";
        groundRev++;
      };
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
      err: get("--err", DEFAULT_THEME.err),
      ok: get("--ok", DEFAULT_THEME.ok),
      accent: get("--accent", DEFAULT_THEME.accent),
      warn: get("--warn", DEFAULT_THEME.warn),
    };
    INTENT_FAIL = get("--err", "#f7768e");
    REST_TINT = get("--xp", "#7b3fd6");
    FLIGHT = get("--flight", "#bfe6ff");
    MEMBER_COLORS = Array.from({ length: MEMBER_SLOTS }, (_, i) => get(memberToken(i), MEMBER_COLORS[i]!));
    groundRev++;
    needsDraw = true;
  }

  function resize(): void {
    const dpr = window.devicePixelRatio || 1;
    const r = stage.getBoundingClientRect();
    W = Math.max(1, Math.round(r.width));
    H = Math.max(1, Math.round(r.height));
    // Setting a size wipes a canvas even when it does not change, so both
    // layers redraw after this whatever the view does.
    for (const c of [ground, canvas]) {
      c.width = Math.round(W * dpr);
      c.height = Math.round(H * dpr);
      c.getContext("2d")?.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    groundRev++;
    artCanvas.width = canvas.width;
    artCanvas.height = canvas.height;
    artCanvas.getContext("2d")?.setTransform(dpr, 0, 0, dpr, 0, 0);
    /*
     * Until something has been fitted the view is the default framing, and it
     * depends on the stage, so it is recomputed here rather than once at mount:
     * the first `ResizeObserver` callback is where the real size arrives, and a
     * phone rotated on an empty map would otherwise keep a frame built for the
     * other orientation. A pending fit is exactly the "nothing has claimed the
     * view yet" flag — once a feed consumes it this leaves the view alone, so a
     * pan survives a resize as before. It deliberately does not live in the fit
     * effect: that effect re-runs on every poll tick, and an empty-feed branch
     * there would snap the view back under a reader who had just panned.
     */
    if (mapFit.pending()) view = defaultView({ w: W, h: H }, untrack(activeMap));
    needsDraw = true;
    bubblesMeasure = true;
  }

  /** On the map as drawn: a traced pip's map is its pose's, which can be minutes behind its reading's. */
  const onMap = (): Pip[] => {
    const map = activeMap();
    return [...pips.values()].filter((p) => p.map === map);
  };

  /* --- the playhead, and the pips placed at it --- */

  /** The replay's precise cursor at `performance.now()` = `p`, while it plays; the cursor signal otherwise. */
  function replayCursor(p: number): number {
    const sp = span();
    if (replayAnchor === null || sp === null) return cursor();
    return replayCursorAt(replayAnchor, p, idle(), sp.to);
  }

  /** The one clock every pip is placed by: live, the delayed playhead; in a replay, the cursor. Null live before any feed. */
  function playheadAt(p: number): number | null {
    return track() === undefined ? liveClock.at(p) : replayCursor(p);
  }

  /** Whether the trace places the pips and fills the sidebar (`traceDrivesAt`). */
  const traceDrives = (): boolean => traceDrivesAt(track() !== undefined, playing(), speed());

  /** Put a pip at a pose. */
  function place(pip: Pip, map: number, x: number, y: number, o: number | null, flying: boolean): void {
    pip.map = map;
    pip.x = x;
    pip.y = y;
    pip.o = o;
    pip.flying = flying;
  }

  /**
   * Every pip, placed for the frame at playhead `t`: by the trace where it
   * answers, by the coarse track in a replay where it does not, and walked
   * toward its newest reading otherwise. Whether that shows is the frame's
   * question, asked of where each was last drawn (`posesMoved`).
   */
  function placePips(t: number | null): void {
    const fine = traceDrives();
    const walking: Pip[] = [];
    for (const pip of pips.values()) {
      const pose = t !== null && fine ? store.poseAt(pip.runId, t) : null;
      if (pose !== null) {
        place(pip, pose.map, pose.x, pose.y, pose.o, pose.flying);
        continue;
      }
      // Each replayed pip by its own track: a party's five are five tracks.
      const tr = trackById().get(pip.runId);
      const coarse = tr !== undefined && t !== null ? trackPoseAt(tr.points, kindsOf(pip.runId), t, IDLE_GAP_MS) : null;
      if (coarse !== null) {
        place(pip, coarse.map, coarse.x, coarse.y, null, false);
        continue;
      }
      pip.map = pip.data.map;
      pip.o = null;
      pip.flying = false;
      walking.push(pip);
    }
    stepPips(walking);
  }

  /** The bubbles up at playhead `t` for the pips on the map; whether the set changed. */
  function updateBubbles(list: readonly Pip[], t: number | null): boolean {
    const stacks: BubbleStack[] = [];
    if (t !== null) {
      const life = bubbleLifeMs(track() === undefined ? null : speed());
      for (const pip of list) {
        const bubbles = bubblesAt(pip.runId, store.chat(pip.runId, t - life, t), t, life);
        if (bubbles.length > 0) stacks.push({ runId: pip.runId, bubbles });
      }
    }
    const key = stacksKey(stacks);
    if (key === bubblesShown) return false;
    bubblesShown = key;
    setBubbleStacks(stacks);
    bubblesMeasure = true;
    return true;
  }

  /** Each stack over its pip as the view stands, lifted clear of the others and of every puck (`layoutStacks`). */
  function placeBubbles(): void {
    if (stackEls.size === 0) return;
    const boxes: StackBox[] = [];
    for (const [runId, el] of stackEls) {
      const pip = pips.get(runId);
      if (pip === undefined) continue;
      let size = stackSizes.get(runId);
      if (size === undefined || bubblesMeasure) {
        size = { w: el.offsetWidth, h: el.offsetHeight };
        stackSizes.set(runId, size);
      }
      const p = project(view, pip.x, pip.y);
      boxes.push({ runId, sx: p.sx, sy: p.sy, ...size });
    }
    bubblesMeasure = false;
    const pucks = onMap().map((pip) => {
      const p = project(view, pip.x, pip.y);
      return { x: p.sx - PUCK_R_SEL, y: p.sy - PUCK_R_SEL, w: 2 * PUCK_R_SEL, h: 2 * PUCK_R_SEL };
    });
    for (const b of layoutStacks(boxes, W, pucks)) {
      const el = stackEls.get(b.runId);
      if (el === undefined) continue;
      el.style.setProperty("--bx", `${Math.round(b.x)}px`);
      el.style.setProperty("--by", `${Math.round(b.y)}px`);
      el.style.setProperty("--lx", `${Math.round(b.leadX)}px`);
      el.style.setProperty("--lead", `${Math.round(b.lead)}px`);
    }
  }

  /**
   * Ask the store for the windows the playhead is about to reach, on a timer
   * rather than per frame: in a replay the replayed run's, live only the runs
   * drawn on the map on screen — the public data host rate-limits these, and
   * a character on another continent is not looked at. A replay also takes
   * its first and last listed windows, which bound its span to the frames.
   */
  function pumpTraces(): void {
    const t = playheadAt(performance.now());
    if (t === null) return;
    const tr = track();
    if (tr !== undefined) {
      if (!traceDrives()) return;
      // The followed member first, so the windows it needs are the first asked for.
      store.pump(tr.runId, t, fetchSegment, { ...replayReach(speed()), ends: true });
      for (const other of replayed()) {
        if (other.runId !== tr.runId) store.pump(other.runId, t, fetchSegment, { ...replayReach(speed()), ends: true });
      }
      return;
    }
    for (const pip of onMap()) store.pump(pip.runId, t, fetchSegment, LIVE_REACH);
  }

  /**
   * Ask for the nearby windows the map can show: live, zoomed in to
   * the layer's scale, and only for runs the feed flagged `nearby` whose pip
   * is on (or near) the screen — typically one to three. Once a poll per run
   * (`onPoll`), and from the 1 s pump only for a run whose window cannot
   * answer the playhead (never asked, or left to age while zoomed out), so
   * zooming in fills the layer without waiting for the next poll.
   */
  function pumpNearby(onPoll: boolean): void {
    if (track() !== undefined || !nearbyShown(view.scale)) return;
    const now = performance.now();
    const t = playheadAt(now);
    for (const pip of onMap()) {
      if (pip.data.nearby !== true) continue;
      const s = project(view, pip.x, pip.y);
      if (s.sx < -W / 2 || s.sx > W * 1.5 || s.sy < -H / 2 || s.sy > H * 1.5) continue;
      const last = nearbyAsked.get(pip.runId);
      const answers = t !== null && nearbyStore.countAt(pip.runId, t) !== null;
      if (last !== undefined && (now - last < POLL_MS / 2 || (!onPoll && answers))) continue;
      nearbyAsked.set(pip.runId, now);
      const id = pip.runId;
      api.nearby(id, NEARBY_FETCH_SPAN_MS).then(
        (w) => {
          if (track() === undefined) nearbyStore.set(id, w);
        },
        (e: unknown) => logError("map nearby", e),
      );
    }
  }

  /** A cached tile, looked at without asking for it or touching its place in the LRU. */
  function peekTile(map: number, layer: LodLayer, z: number, row: number, col: number): TileEntry | undefined {
    return tiles.get(tileKey(map, layer, z, row, col));
  }

  function drawGrid(ctx: CanvasRenderingContext2D, map: number): void {
    ctx.fillStyle = theme.grid;
    ctx.fillRect(0, 0, W, H);
    ctx.lineWidth = 1;
    ctx.font = "11px ui-monospace, monospace";
    ctx.textBaseline = "top";
    ctx.strokeStyle = theme.gridline;
    ctx.fillStyle = theme.dim;
    /*
     * Where a tile comes from is `lib/tiles.ts`: the private viewer serves
     * them same-origin, and the public build reads
     * `VITE_WRATHBENCH_TILES_BASE` for the host holding the `tiles/` prefix.
     * A build given no host draws the labelled grid at every zoom, which is
     * the same state a lab machine that never ran the extraction is in.
     */
    if (NO_TILE_BASE) {
      drawLattice(ctx, 0, true);
      return;
    }
    /*
     * Which level of the pyramid: the native tiles while they are at least
     * `TILE_MIN_PX` on screen, and zoomed out the baked level whose cells stay
     * near that size, so real ground shows at every zoom and the cells on
     * screen never outgrow the cache (`frameLevels`). A pyramid level draws
     * over the lattice in one pass, so the lattice shows wherever a level has
     * no ground: ocean and the edge of the world.
     *
     * Then the painted map over it, weighted by zoom: all art zoomed out, all
     * minimap zoomed in, a blend between. Where the art has nothing — a map
     * with none, an unpainted corner, a tile not loaded yet — nothing is laid
     * over the minimap and it shows at full strength.
     */
    const f = frameLevels(view.scale, { w: W, h: H });
    if (f.minimap > 0) drawLattice(ctx, f.minimap, false);
    // Where the art covers it at full strength the minimap is neither fetched
    // nor drawn (`minimapHidden`); everywhere else it is the ground under it.
    const index = tileIndex(map) ?? null;
    drawLevel(ctx, map, MINIMAP_LAYER, f.minimap, (row, col) => minimapHidden(f, index, row, col));
    const art = artCanvas.getContext("2d");
    if (f.art === null || art === null) return;
    art.clearRect(0, 0, W, H);
    drawLevel(art, map, ART_LAYER, f.art);
    ctx.globalAlpha = 1 - f.minimapAlpha;
    ctx.drawImage(artCanvas, 0, 0, W, H);
    ctx.globalAlpha = 1;
  }

  /**
   * The lattice as one stroked path at level `z`'s cell size, labelled with
   * the native file names when asked and the cells are wide enough to hold
   * them. See `latticeLines` for why it is a path and not per-cell rects.
   */
  function drawLattice(ctx: CanvasRenderingContext2D, z: number, labels: boolean): void {
    const l = latticeLines(view, { w: W, h: H }, z);
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
    const g = visibleGrid(view, { w: W, h: H }, z);
    if (labels && g.size > 64) {
      for (let row = g.row0; row <= g.row1; row++) {
        for (let col = g.col0; col <= g.col1; col++) {
          ctx.fillText(`${row}_${col}`, col * g.size + view.ox + 6, row * g.size + view.oy + 5);
        }
      }
    }
  }

  /**
   * One level of one layer, with anything already cached drawn under the
   * cells still loading, so a zoom never flashes to an empty grid.
   *
   * Underneath goes the finest cached level above (a zoom in: the level just
   * left is still in the cache) and, over that, the cached cells one level
   * down (a zoom out: the same). Neither is ever requested — a tile that is
   * not already here is not worth a fetch for the few frames until the real
   * one lands. A level above that is known missing ends the search, because a
   * pyramid tile exists wherever any of its children has ground.
   *
   * Native tiles (level 0) draw as they always have: a loaded tile fills its
   * cell, and anything else gets its outline and file-name label — except a
   * cell still loading that has something cached drawn under it. A cell
   * `hidden` answers true for is skipped outright: not asked for, not drawn.
   */
  function drawLevel(
    ctx: CanvasRenderingContext2D,
    map: number,
    layer: LodLayer,
    z: number,
    hidden?: (row: number, col: number) => boolean,
  ): void {
    const g = visibleGrid(view, { w: W, h: H }, z);
    const cells: { row: number; col: number; t: TileEntry }[] = [];
    for (let row = g.row0; row <= g.row1; row++) {
      for (let col = g.col0; col <= g.col1; col++) {
        if (hidden?.(row, col) === true) continue;
        cells.push({ row, col, t: tile(map, layer, z, row, col) });
      }
    }

    const covered = new Set<TileEntry>();
    const above = new Map<string, { a: number; row: number; col: number; img: HTMLImageElement }>();
    const below: { row: number; col: number; img: HTMLImageElement }[] = [];
    for (const { row, col, t } of cells) {
      if (t.state !== "pending") continue;
      for (let a = z + 1; a <= LOD_MAX; a++) {
        const ar = row >> (a - z);
        const ac = col >> (a - z);
        const e = peekTile(map, layer, a, ar, ac);
        if (e === undefined || e.state === "pending") continue;
        if (e.state === "ok") {
          above.set(`${a}/${ar}_${ac}`, { a, row: ar, col: ac, img: e.img });
          covered.add(t);
        }
        break;
      }
      if (z === 0) continue;
      for (let dr = 0; dr < 2; dr++) {
        for (let dc = 0; dc < 2; dc++) {
          const e = peekTile(map, layer, z - 1, 2 * row + dr, 2 * col + dc);
          if (e?.state !== "ok") continue;
          below.push({ row: 2 * row + dr, col: 2 * col + dc, img: e.img });
          covered.add(t);
        }
      }
    }
    // Coarsest first, so the finer cached level wins where both are drawn.
    for (const u of [...above.values()].sort((p, q) => q.a - p.a)) {
      const size = levelCellPx(view.scale, u.a);
      ctx.drawImage(u.img, u.col * size + view.ox, u.row * size + view.oy, size + 1, size + 1);
    }
    const half = levelCellPx(view.scale, z - 1);
    for (const u of below) ctx.drawImage(u.img, u.col * half + view.ox, u.row * half + view.oy, half + 1, half + 1);

    for (const { row, col, t } of cells) {
      const x = col * g.size + view.ox;
      const y = row * g.size + view.oy;
      if (t.state === "ok") {
        // A hair of overdraw: neighbouring tiles must not show a seam when
        // the scale puts their edges on a fractional device pixel.
        ctx.drawImage(t.img, x, y, g.size + 1, g.size + 1);
        continue;
      }
      // A pyramid level drew its lattice underneath already.
      if (z > 0 || covered.has(t)) continue;
      ctx.strokeRect(x + 0.5, y + 0.5, g.size - 1, g.size - 1);
      // The label is the file name the extraction would write: it is how an
      // operator checks orientation where there is no tile to draw.
      if (g.size > 64) ctx.fillText(`${row}_${col}`, x + 6, y + 5);
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
   *
   * Run by run, so decimation keeps every run's ends: the gap at a teleport and
   * the point where a walk becomes a flight survive any zoom.
   */
  function drawnRoute(): RouteRun[] {
    if (route === routeSrc && view.scale === routeScale) return routeDrawn;
    routeSrc = route;
    routeScale = view.scale;
    const minDist = worldPerPixel(view.scale);
    routeDrawn = route.map((r) => ({ ...r, points: decimateRoute(r.points, minDist) }));
    return routeDrawn;
  }

  /**
   * The path travelled so far on this map, behind the pip. Replay only: the
   * run's colour where it moved under its own power, `FLIGHT` where it flew,
   * and nothing across a teleport (`classifySegments`).
   */
  function drawRoute(ctx: CanvasRenderingContext2D, runs: RouteRun[]): void {
    ctx.lineWidth = 2;
    ctx.globalAlpha = 0.65;
    for (const run of runs) {
      if (run.points.length < 2) continue;
      ctx.beginPath();
      for (let i = 0; i < run.points.length; i++) {
        const p = project(view, run.points[i]!.x, run.points[i]!.y);
        if (i === 0) ctx.moveTo(p.sx, p.sy);
        else ctx.lineTo(p.sx, p.sy);
      }
      ctx.strokeStyle = run.kind === "flight" ? FLIGHT : (run.color ?? routeColor);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  /**
   * The route from where the cached prefix ends to the pip, for this frame.
   * The prefix follows the cursor signal, a tenth of a second behind the
   * frame's playhead — at 600× that is a whole sample — so the points between
   * and the pip itself are joined on here, by the same rules: no line across a
   * teleport or onto another map. A pip the trace places is joined by its own
   * trail instead: a line from the coarse sample before it would cut across
   * the path it actually walked.
   */
  function routeToPip(tr: TrackResponse, map: number, t: number, pip: Pip | undefined): RouteRun[] {
    if (pip !== undefined && pip.o !== null) return [];
    const kinds = kindsOf(tr.runId);
    const runs = routeUpTo(tr.points, kinds, map, t, Math.max(0, indexAt(tr.points, cursor())));
    const i = indexAt(tr.points, t);
    const a = tr.points[i];
    if (a === undefined || pip === undefined || pip.map !== map || a.map !== map) return runs;
    const kind = kinds[i] ?? "walk";
    if (kind === "teleport") return runs;
    const last = runs[runs.length - 1];
    const end = last?.points[last.points.length - 1];
    if (last !== undefined && last.kind === kind && end?.x === a.x && end.y === a.y) last.points.push({ x: pip.x, y: pip.y });
    else runs.push({ kind, points: [{ x: a.x, y: a.y }, { x: pip.x, y: pip.y }] });
    return runs;
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
  function drawIntents(ctx: CanvasRenderingContext2D, list: Pip[], mapId: number, cursorNow: number | null): boolean {
    // The feed's own clock, not the wall clock: a replayed intention was
    // recorded hours or months ago, and ageing it against `Date.now()` would
    // drop every one of them as stale. Live, the two are the same thing.
    const now = replayId() === undefined || cursorNow === null ? Date.now() : cursorNow;
    let drew = false;
    ctx.textBaseline = "middle";
    ctx.font = "11px ui-monospace, monospace";
    for (const pip of list) {
      // A live pip the trace places stands at the playhead, on the public site
      // minutes behind the newest reading the move came with: a move recorded
      // after that moment has not happened yet where the pip is, and one
      // before it is aged from the playhead, not from now.
      const placed = replayId() === undefined && pip.o !== null && cursorNow !== null;
      if (placed && (pip.data.move?.ts ?? -Infinity) > cursorNow) continue;
      const move = placed
        ? intentToDraw(pip.data.move, mapId, cursorNow, null)
        : intentToDraw(pip.data.move, mapId, now, feedClock);
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

  /**
   * The trail behind a traced pip: the last `TRAIL_MS` of its path, fading
   * out behind it, in the run's colour and `FLIGHT` where it flew. A cut ends
   * a stretch without a line (`TraceStore.trail`), so a hearth jumps cleanly.
   * Whether any of it is long enough on screen to show a fade: a character
   * standing still has a trail of one spot under its own puck, which needs
   * no frames to fade.
   */
  function drawTrails(ctx: CanvasRenderingContext2D, list: Pip[], map: number, t: number): boolean {
    let drew = false;
    ctx.save();
    ctx.lineWidth = 2;
    ctx.lineCap = "round";
    for (const pip of list) {
      if (pip.o === null) continue;
      const runs: TrailRun[] = store.trail(pip.runId, t - TRAIL_MS, t);
      for (const run of runs) {
        if (run.map !== map) continue;
        ctx.strokeStyle = run.flight ? FLIGHT : colorOf(pip.runId);
        let a = project(view, run.points[0]!.x, run.points[0]!.y);
        // A run's length on screen, all of it: zoomed out, a trail is many
        // sub-pixel segments that show together.
        let length = 0;
        for (let i = 1; i < run.points.length; i++) {
          const p = run.points[i]!;
          const b = project(view, p.x, p.y);
          const age = t - (run.points[i - 1]!.t + p.t) / 2;
          ctx.globalAlpha = TRAIL_ALPHA * Math.max(0, 1 - age / TRAIL_MS);
          ctx.beginPath();
          ctx.moveTo(a.sx, a.sy);
          ctx.lineTo(b.sx, b.sy);
          ctx.stroke();
          length += Math.hypot(b.sx - a.sx, b.sy - a.sy);
          a = b;
        }
        if (length >= MOVE_PX) drew = true;
      }
    }
    ctx.restore();
    return drew;
  }

  /** A small wedge just outside the pip, pointing where the character faces. */
  function drawHeading(ctx: CanvasRenderingContext2D, pip: Pip, sx: number, sy: number, r: number): void {
    if (pip.o === null) return;
    const d = headingOnScreen(view, pip.x, pip.y, pip.o);
    if (d.dx === 0 && d.dy === 0) return;
    const tip = r + HEADING_LEN;
    const base = r + 1;
    ctx.beginPath();
    ctx.moveTo(sx + d.dx * tip, sy + d.dy * tip);
    ctx.lineTo(sx + d.dx * base - d.dy * HEADING_HALF, sy + d.dy * base + d.dx * HEADING_HALF);
    ctx.lineTo(sx + d.dx * base + d.dy * HEADING_HALF, sy + d.dy * base - d.dx * HEADING_HALF);
    ctx.closePath();
    ctx.fillStyle = pip.flying ? FLIGHT : colorOf(pip.runId);
    ctx.fill();
    ctx.lineWidth = 1;
    ctx.strokeStyle = theme.bg;
    ctx.stroke();
  }

  /* The nearby layer as last drawn, in screen pixels, for the hover's hit test; and the unit under the pointer. */
  let nearbyDrawn: { dot: NearbyDot; sx: number; sy: number }[] = [];
  /** Where the pips draw their pucks and name chips this frame: no unit label goes there. */
  let pipBoxes: ScreenBox[] = [];
  let hoveredId: string | null = null;
  /** Label widths by text, so a city of names is measured once. */
  const labelWidths = new Map<string, number>();
  const labelWidth = (ctx: CanvasRenderingContext2D, text: string): number => {
    let w = labelWidths.get(text);
    if (w === undefined) {
      w = ctx.measureText(text).width;
      if (labelWidths.size > 2000) labelWidths.clear();
      labelWidths.set(text, w);
    }
    return w;
  };

  /**
   * The units around the live characters on `map` at playhead `t`, under the
   * pips: one dot per unit in its class's colour (`nearbyColor`; the dead as a
   * ring), one path per class; the selected character's own target ringed;
   * quest marks and names once zoomed in far enough, culled so they overlap
   * neither each other nor a character's puck and name. The hovered unit's
   * name is `drawNearbyHover`'s, over the pips.
   */
  function drawNearby(ctx: CanvasRenderingContext2D, map: number, t: number, sel: AgentPosition | null, list: Pip[]): void {
    const dots = nearbyStore.dotsAt(t, map);
    const drawn: { dot: NearbyDot; sx: number; sy: number }[] = [];
    for (const dot of dots) {
      const p = project(view, dot.x, dot.y);
      if (p.sx < -20 || p.sy < -20 || p.sx > W + 20 || p.sy > H + 20) continue;
      drawn.push({ dot, sx: p.sx, sy: p.sy });
    }
    nearbyDrawn = drawn;
    if (drawn.length === 0) return;
    // What the pips will draw over the layer: each puck and its name chip.
    ctx.save();
    ctx.font = "12px ui-monospace, monospace";
    pipBoxes = list.map((pip) => {
      const p = project(view, pip.x, pip.y);
      return { x: p.sx - PUCK_R_SEL, y: p.sy - PUCK_R_SEL, w: PUCK_R_SEL * 2 + 4 + ctx.measureText(pipName(pip.data)).width + 6, h: PUCK_R_SEL * 2 };
    });
    ctx.restore();
    const r = NEARBY_DOT_R;
    ctx.save();
    for (const cls of ["other", "service", "player", "engaged"] as const) {
      ctx.beginPath();
      let any = false;
      for (const d of drawn) {
        if (d.dot.cls !== cls) continue;
        ctx.moveTo(d.sx + r, d.sy);
        ctx.arc(d.sx, d.sy, r, 0, Math.PI * 2);
        any = true;
      }
      if (!any) continue;
      ctx.fillStyle = nearbyColor(cls, theme);
      ctx.fill();
    }
    ctx.beginPath();
    for (const d of drawn) {
      if (d.dot.cls !== "dead") continue;
      ctx.moveTo(d.sx + r, d.sy);
      ctx.arc(d.sx, d.sy, r, 0, Math.PI * 2);
    }
    ctx.lineWidth = 1;
    ctx.strokeStyle = theme.dim;
    ctx.stroke();
    // The selected character's own target, ringed as a selected pip is.
    const target = sel === null ? null : (nearbyStore.targetAt(sel.runId, t)?.id ?? null);
    const ringed = target === null ? undefined : drawn.find((d) => d.dot.id === target);
    if (ringed !== undefined) {
      ctx.beginPath();
      ctx.arc(ringed.sx, ringed.sy, r + 3, 0, Math.PI * 2);
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = theme.fg;
      ctx.stroke();
    }
    const names = nearbyNamesShown(view.scale);
    if (names) {
      ctx.font = NEARBY_MARK_FONT;
      ctx.textBaseline = "alphabetic";
      ctx.textAlign = "center";
      ctx.fillStyle = theme.warn;
      for (const d of drawn) if (d.dot.quest !== null) ctx.fillText(d.dot.quest, d.sx, d.sy - r - 2);
      ctx.textAlign = "left";
    }
    if (!names) {
      ctx.restore();
      return;
    }
    // Names: every one at close zoom but the hovered one, culled by rank.
    ctx.font = NEARBY_FONT;
    ctx.textBaseline = "middle";
    const labelled = drawn
      .filter((d) => d.dot.id !== hoveredId && d.dot.name !== null && d.dot.name !== "")
      .map((d) => {
        const text = d.dot.name!;
        const rank = d.dot.id === target ? -1 : LABEL_RANK[d.dot.cls];
        return { x: d.sx + r + 3, y: d.sy - 7, w: labelWidth(ctx, text) + 6, h: 14, rank, text };
      });
    for (const i of cullLabels(labelled, NEARBY_LABELS_MAX, pipBoxes)) {
      const b = labelled[i]!;
      ctx.globalAlpha = 0.75;
      ctx.fillStyle = theme.bg;
      ctx.fillRect(b.x, b.y, b.w, b.h);
      ctx.globalAlpha = 1;
      ctx.fillStyle = theme.fg;
      ctx.fillText(b.text, b.x + 3, b.y + 7.5);
    }
    ctx.restore();
  }

  /**
   * The hovered unit's name, and its subname and level where known, over
   * everything else: beside its dot on whichever side keeps clear of the pips'
   * pucks and names (`placeLabel`), since unlike the culled names it is never
   * left out.
   */
  function drawNearbyHover(ctx: CanvasRenderingContext2D): void {
    if (hoveredId === null) return;
    const d = nearbyDrawn.find((x) => x.dot.id === hoveredId);
    if (d === undefined || d.dot.name === null) return;
    const text = `${d.dot.name}${d.dot.sub === null ? "" : ` <${d.dot.sub}>`}${d.dot.level === null ? "" : ` ${d.dot.level}`}`;
    ctx.save();
    ctx.font = NEARBY_FONT;
    ctx.textBaseline = "middle";
    const { x, y, w } = placeLabel(d.sx, d.sy, NEARBY_DOT_R, labelWidth(ctx, text) + 6, 14, pipBoxes);
    ctx.globalAlpha = 0.85;
    ctx.fillStyle = theme.bg;
    ctx.fillRect(x, y, w, 14);
    ctx.globalAlpha = 1;
    ctx.fillStyle = theme.fg;
    ctx.fillText(text, x + 3, y + 7.5);
    ctx.beginPath();
    ctx.arc(d.sx, d.sy, NEARBY_DOT_R + 2, 0, Math.PI * 2);
    ctx.lineWidth = 1;
    ctx.strokeStyle = theme.fg;
    ctx.stroke();
    ctx.restore();
  }

  function drawPips(ctx: CanvasRenderingContext2D, list: Pip[], sel: AgentPosition | null, cursorNow: number | null): void {
    const now = Date.now();
    // Staleness is against the feed's own clock: the cursor in a replay, where
    // every sample is hours or months old on the wall and none of them is
    // "stale" — the character was exactly there, then. Live, the two agree.
    const ageRef = replayId() === undefined || cursorNow === null ? now : cursorNow;
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
        // A party member's puck is ringed in its own colour: the logo is the
        // same on all five, so the ring is what says which one this is.
        const member = memberIndex().has(pip.runId);
        ctx.lineWidth = member ? (on ? 4 : 3) : on ? 2 : 1;
        ctx.strokeStyle = member ? colorOf(pip.runId) : on ? theme.fg : theme.line;
        ctx.stroke();
        if (member && on) {
          ctx.beginPath();
          ctx.arc(p.sx, p.sy, r + 3, 0, Math.PI * 2);
          ctx.lineWidth = 1.5;
          ctx.strokeStyle = theme.fg;
          ctx.stroke();
        }
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
      // Over the label rather than under it: a character facing east would
      // otherwise lose its heading to its own name.
      drawHeading(ctx, pip, p.sx, p.sy, logo !== null ? (on ? PUCK_R_SEL : PUCK_R) : on ? DOT_R_SEL : DOT_R);
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

    // A window dragged to a screen of another pixel ratio changes no size the
    // observer sees, so the ratio is watched on its own: one query for the
    // current ratio, replaced each time it stops matching.
    let dprMq: MediaQueryList | undefined;
    const onDpr = (): void => {
      resize();
      watchDpr();
    };
    const watchDpr = (): void => {
      dprMq?.removeEventListener("change", onDpr);
      dprMq = window.matchMedia?.(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
      dprMq?.addEventListener("change", onDpr);
    };
    watchDpr();

    // A logo that decodes after the frame that wanted it has no signal to
    // invalidate, so it asks for a redraw the same way a tile does.
    const offLogo = onLogoLoaded(() => {
      needsDraw = true;
    });

    let raf = 0;
    let lastCursorTick = -Infinity;
    let lastPlayheadTick = -Infinity;
    let lastDraw = -Infinity;
    let lastNearbyDraw = -Infinity;
    let trailsShown = false;
    /* What each layer was last drawn for (`layerDue`), the pips as last drawn, and the playhead the trails were faded to. */
    let groundDrawn: LayerKey | null = null;
    let overlayDrawn: LayerKey | null = null;
    let posesDrawn = new Map<string, DrawnPose>();
    let trailsAt: number | null = null;
    /*
     * The frame's playhead out to Solid, throttled (`CURSOR_TICK_MS`,
     * `PLAYHEAD_TICK_MS`), and the end of a replay. The only writes the loop
     * makes to signals, and nothing the loop reads is derived from them within
     * the frame.
     */
    const tickSignals = (p: number, t: number | null): void => {
      if (traceChanged) {
        traceChanged = false;
        setTraceRev((n) => n + 1);
      }
      if (nearbyChanged) {
        nearbyChanged = false;
        setNearbyRev((n) => n + 1);
      }
      if (t === null) return;
      if (track() === undefined) {
        if (p - lastPlayheadTick >= PLAYHEAD_TICK_MS) {
          lastPlayheadTick = p;
          setPlayhead(t);
        }
        return;
      }
      if (replayAnchor === null) return;
      const sp = span();
      if (sp !== null && t >= sp.to) {
        setPlaying(false);
        seek(sp.to);
        return;
      }
      if (p - lastCursorTick >= CURSOR_TICK_MS) {
        lastCursorTick = p;
        setCursor(t);
      }
    };
    const frame = (): void => {
      const p = performance.now();
      const t = playheadAt(p);
      tickSignals(p, t);
      const ctx = canvas.getContext("2d");
      const gctx = ground.getContext("2d");
      if (ctx !== null && gctx !== null) {
        placePips(t);
        const list = onMap();
        // There is always a map to draw: `chooseMap` falls back to the
        // default continent, so an empty feed gets tiles rather than the flat
        // rectangle this used to paint when it had no map id.
        const map = activeMap();
        // The ground, only when the view, the stage, the map or what it is
        // drawn from has changed: a pan or a zoom, a tile landing.
        const key: LayerKey = { scale: view.scale, ox: view.ox, oy: view.oy, w: W, h: H, map, rev: groundRev };
        if (layerDue(groundDrawn, key)) {
          groundDrawn = key;
          drawGrid(gctx, map);
        }
        const viewKey: LayerKey = { ...key, rev: 0 };
        const poses = new Map(list.map((pip) => [pip.runId, drawnPose(view, pip)]));
        // A pip redraws the marks once it has moved half a pixel from where
        // it was drawn, however slowly it got there.
        const moving = posesMoved(posesDrawn, poses);
        const moved = moving || layerDue(overlayDrawn, viewKey);
        // A drifting rest glyph is the one mark that changes with nothing else
        // changing, so it keeps the marks drawing, at its own rate; under
        // reduced motion it is static and asks for nothing. A trail fades
        // behind a pip standing still, which wants a frame now and then, and
        // none at all while the playhead stands still.
        const resting = list.some((pip) => pip.data.reflecting === true);
        const restDue = resting && restFrameDue(lastDraw, p, reduceMotion);
        const fading = trailFadeDue(trailsShown, t, trailsAt, p, lastDraw, TRAIL_FRAME_MS);
        // The units nearly always move, so they redraw on their own, slower
        // clock (`nearbyFrameDue`) rather than holding the map at frame rate.
        const nearbyOn = track() === undefined && t !== null && nearbyShown(view.scale) && nearbyStore.size() > 0;
        const nearbyDue = nearbyOn && nearbyFrameDue(lastNearbyDraw, p);
        // Live only: in a replay every age is the cursor's, which stands still with the marks.
        const heartbeat = track() === undefined && p - lastDraw >= OVERLAY_HEARTBEAT_MS;
        // The bubbles follow the pips: placed whenever the map is drawn, and
        // whenever the set up changes.
        const said = updateBubbles(list, t);
        if (said || needsDraw || moved) placeBubbles();
        if (needsDraw || moved || fading || nearbyDue || restDue || heartbeat) {
          needsDraw = false;
          lastDraw = p;
          overlayDrawn = viewKey;
          posesDrawn = poses;
          trailsAt = t;
          ctx.clearRect(0, 0, W, H);
          // The state the marks were drawn under when they shared the
          // ground's canvas, where they began each frame after the lattice.
          ctx.lineWidth = 1;
          ctx.font = "11px ui-monospace, monospace";
          ctx.textBaseline = "top";
          ctx.strokeStyle = theme.gridline;
          ctx.fillStyle = theme.dim;
          ctx.globalAlpha = 1;
          // The route is cached twice over: the effect that owns it rebuilds
          // the prefix only when the cursor or map moves, and `drawnRoute`
          // decimates that to screen resolution only when the zoom changes.
          // Recomputing either per pointer-move frame is the one thing in this
          // loop that scales with the length of a run. The stretch from where
          // it ends to the pip is the frame's own, a handful of points.
          drawRoute(ctx, drawnRoute());
          if (t !== null) {
            for (const tr of replayed()) {
              const pip = pips.get(tr.runId);
              const color = colorOf(tr.runId);
              drawRoute(ctx, routeToPip(tr, map, t, pip?.map === map ? pip : undefined).map((r) => ({ ...r, color })));
            }
          }
          trailsShown = t !== null && traceDrives() && drawTrails(ctx, list, map, t);
          const intents = drawIntents(ctx, list, map, t);
          if (intents || resting) drawIntentLegend(ctx, intents, resting);
          if (nearbyOn) {
            lastNearbyDraw = p;
            drawNearby(ctx, map, t, selected(), list);
          } else nearbyDrawn = [];
          drawPips(ctx, list, selected(), t);
          if (nearbyOn) drawNearbyHover(ctx);
        }
      }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    // Not while the tab is hidden: both pumps fetch (`visibleInterval`).
    const stopPump = visibleInterval(() => {
      pumpTraces();
      pumpNearby(false);
    }, PUMP_MS);

    /*
     * The transport's keyboard, on the document so it works with the canvas
     * focused or nothing focused at all. A key that belongs to a focused
     * control — space on a button — is left to it.
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
      stopPump();
      ro.disconnect();
      mq?.removeEventListener("change", readTheme);
      motionMq?.removeEventListener("change", readMotion);
      dprMq?.removeEventListener("change", onDpr);
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
      setTrack: (t) => setSingle(() => t),
      setGroup: () => {
        setGroup(undefined);
        setParty(undefined);
      },
      setCursor,
      setPlaying,
      setPinned: setPinnedMap,
      setSelectedId,
      setFeed: (list) => setFeedList(() => list),
      setError: setReplayError,
    });
    pips.clear();
    route = [];
    mapFit.ask();
    // The trace goes with the rest: neither mode's segments, clock or anchor
    // means anything in the other.
    store.retain([]);
    nearbyStore.retain([]);
    nearbyAsked.clear();
    hoveredId = null;
    liveClock = createLiveClock(cadence);
    replayAnchor = null;
    setPlayhead(null);
    /*
     * The camera goes back to the default with the rest of it. The ask above
     * alone would not do it: nothing re-reads the flag until a feed arrives or
     * the stage resizes, so leaving a replay onto a quiet fleet would keep the
     * replay's continent framing while the map underneath became the default
     * one — Northrend's camera over Eastern Kingdoms' tiles. Coming back to a
     * busy map this shows the starter framing for the one round-trip before the
     * refresh lands and the fit effect overwrites it, which is the right
     * intermediate: a foreign continent's camera is not.
     */
    // The pin is the one piece of state the URL carries, so the clear above
    // gives it back here: a `/map?map=1` link, opened cold or reached by back
    // or forward, lands on its map. Read untracked, or a chip click would
    // re-run this whole swap.
    const pin = untrack(() => mapParam(params.map));
    setPinnedMap(pin);
    view = defaultView({ w: W, h: H }, pin ?? DEFAULT_MAP);
    needsDraw = true;
    if (id === undefined) {
      // Only when leaving a replay, never on a cold load — see createLeftReplay.
      if (returningToLive) feed.refresh();
      return;
    }
    /*
     * A run still going, or inside the minute its last window settles, has
     * its newest minutes only in the open tail, which the track does not
     * carry: read the run's index (publicly, its place in the fast lane) with
     * the track, and again on the live map's cadence for as long as there is
     * a tail. A window that closes meanwhile is listed by the next read and
     * the tail moves on past it (`setTail` keeps the old one until it lands).
     */
    const stops: (() => void)[] = [];
    onCleanup(() => stops.forEach((stop) => stop()));
    /** Keep one replayed run's open tail current, for as long as it has one. */
    const followTail = (runId: string): void => {
      let stop: (() => void) | undefined;
      const refresh = (): void => {
        api.traceIndex(runId).then(
          (index) => {
            if (mine !== trackToken) return;
            ingestIndex(store, runId, index);
            if (index.tail === null) stop?.();
          },
          (e: unknown) => {
            logError("map replay trace", e);
            if ((e as { status?: unknown }).status === 404) stop?.();
          },
        );
      };
      refresh();
      // Paused while the tab is hidden, like the live feed's poll.
      stop = visibleInterval(refresh, POLL_MS);
      stops.push(stop);
    };
    /**
     * Where the loaded replay opens: where it was last left off, if it was —
     * see cursormemory.ts. The route effect above has just cleared the cursor,
     * so this is the one place a loaded track's cursor is chosen. At the
     * start, it follows the start the trace reports (`followStart`).
     */
    const open = (play: TrackResponse): void => {
      const resumed = cursorMemory.resume(play);
      followStart = resumed === (trackSpan(play.points)?.from ?? 0);
      setCursor(resumed);
      mapFit.ask();
      needsDraw = true;
    };
    const failed = (e: unknown): void => {
      logError("map replay", e);
      if (mine === trackToken) setReplayError(displayError(e));
    };
    const pid = partyId();
    if (pid !== undefined) {
      /*
       * A party: its members off the listing (`loadParty`), then every
       * member's track at once. A member whose track fails is left out
       * rather than failing the four that loaded.
       */
      void loadParty(api, pid)
        .then(async (view) => {
          if (mine !== trackToken) return;
          if (view === null) throw new Error(`no such party: ${pid}`);
          const got = await Promise.all(view.members.map((m) => api.track(m.runId).catch(() => null)));
          if (mine !== trackToken) return;
          const tracks = got.filter((t): t is TrackResponse => t !== null);
          if (tracks.length === 0) throw new Error(`no member of ${pid} has a track`);
          ingestTracks(store, tracks);
          for (const t of tracks) followTail(t.runId);
          setParty(view);
          setGroup(tracks);
          open(groupTrack(pid, tracks));
        })
        .catch(failed);
      return;
    }
    void api
      .track(id)
      .then((t) => {
        if (mine !== trackToken) return;
        // The run's closed windows, the only ones its replay will ask for.
        // A track from before the recorder lists none and plays coarse.
        ingestTrack(store, t);
        followTail(id);
        setSingle(t);
        open(t);
      })
      .catch(failed);
  });

  /**
   * The replayed character at the cursor: the track's reading (`positionsAt`),
   * placed where the trace has it when the trace drives. Before the run's
   * first 60 s point — a short trace-era run can have one, after minutes of
   * trace, or none — the reading is the first point's, or the track's own
   * identity, so the pip and the sidebar exist wherever the trace does.
   */
  function replayFeedAt(t: TrackResponse, ts: number): AgentPosition[] {
    traceRev();
    const pose = traceDrives() ? store.poseAt(t.runId, ts) : null;
    if (pose === null) return positionsAt(t, ts);
    const first = t.points[0];
    const [reading] = positionsAt(t, first === undefined ? ts : Math.max(ts, first.ts));
    const base: AgentPosition = reading ?? {
      runId: t.runId,
      character: t.characterName,
      model: t.model,
      map: pose.map,
      x: pose.x,
      y: pose.y,
      ts,
      level: null,
      xp: null,
      money: null,
      questsCompleted: null,
      harnessVersion: t.harnessVersion,
    };
    return [{ ...base, map: pose.map, x: pose.x, y: pose.y }];
  }

  /** Each traced live run's map at the playhead, as one string, so it only "changes" when a map does. */
  const tracedMaps = createMemo(() => {
    traceRev();
    const at = playhead();
    if (at === null || track() !== undefined) return "";
    return feedPositions()
      .map((p) => `${p.runId}:${store.poseAt(p.runId, at)?.map ?? ""}`)
      .join("|");
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
    const ts = replayed();
    if (ts.length > 0) {
      // Every replayed run at the cursor: one, or a party's members.
      const at = cursor();
      const list = ts.flatMap((t) => replayFeedAt(t, at));
      // A replayed sample's age is not a freshness claim; the plain arithmetic applies.
      feedClock = null;
      syncPips(pips, list, true);
      setFeedList(list);
    } else {
      // Where the trace has the playhead, the reading stands where the pip is
      // drawn — on the public site minutes behind the newest sample — so the
      // chips, the counts and the fit agree with the pips. Re-run when a
      // traced run changes map, not on every playhead tick.
      tracedMaps();
      const at = untrack(playhead);
      const list = feedPositions().map((p) => {
        const pose = at === null ? null : store.poseAt(p.runId, at);
        return pose === null ? p : { ...p, map: pose.map, x: pose.x, y: pose.y };
      });
      feedClock = feed.latest?.clock ?? null;
      syncPips(pips, list);
      setFeedList(list);
    }
    needsDraw = true;
  });

  /*
   * A pin arriving by URL after load: the chip click below writes it, and
   * browser back and forward move it. Deferred, because the route swap above
   * already seeded the pin the page opened with. The fit is made on the spot
   * (`askNow`): a pin that leaves the map on screen as it was, such as the one
   * a cursor crossing drops or a step back onto the map already showing, wakes
   * no fit effect, and the ask would otherwise wait for an unrelated change. A
   * map nobody is on gets its opening frame instead, since there is no one
   * there to fit to.
   */
  createEffect(
    on(
      () => params.map,
      (raw) => {
        const pin = mapParam(raw);
        // The URL catching up with a pin the page already made (a pick from
        // the live list, a crossing) asks for nothing: refitting here would
        // take the camera off the character the pick framed.
        if (pin === untrack(pinnedMap)) return;
        setPinnedMap(pin);
        mapFit.askNow();
        if (pin !== null && !feedList().some((p) => p.map === pin)) {
          view = defaultView({ w: W, h: H }, pin);
          needsDraw = true;
        }
      },
      { defer: true },
    ),
  );

  /*
   * How each step of the track was travelled, once per track: the
   * classification walks the whole run, and the cursor and map only slice it.
   */
  const segmentKinds = createMemo(() => new Map(replayed().map((t) => [t.runId, classifySegments(t)])));
  /** The replayed tracks by run id, for the per-pip lookups in the frame loop. */
  const trackById = createMemo(() => new Map(replayed().map((t) => [t.runId, t])));
  const kindsOf = (runId: string): ReturnType<typeof classifySegments> => segmentKinds().get(runId) ?? [];

  /*
   * The drawn route, recomputed when its inputs move rather than per frame:
   * the trace's own frames wherever a loaded segment answers, and the 60 s
   * points for the steps no loaded segment covers at both ends — so a
   * trace-era run with one point still draws the path it walked, and an old
   * run draws what it always did.
   */
  createEffect(() => {
    traceRev();
    const tracks = replayed();
    const kinds = segmentKinds();
    const map = activeMap();
    const ts = cursor();
    const sp = span();
    // memberIndex() is read through colorOf: a party's routes take the members' colours.
    const next: RouteRun[] = [];
    for (const t of tracks) {
      const id = t.runId;
      const color = colorOf(id);
      const coarse = routeUpTo(t.points, kinds.get(id) ?? [], map, ts, 0, (i) => store.covers(id, t.points[i]!.ts) && store.covers(id, t.points[i + 1]!.ts));
      const fine: RouteRun[] =
        sp === null
          ? []
          : store
              .path(id, sp.from, ts)
              .filter((r) => r.map === map)
              .map((r) => ({ kind: r.flight ? "flight" : "walk", points: r.points }));
      for (const r of [...coarse, ...fine]) next.push({ ...r, color });
    }
    route = next;
    routeColor = colorOf(track()?.runId ?? "");
    needsDraw = true;
  });

  /*
   * The transport's deliberate moves. Every one of them goes through `seek`,
   * which is the only place besides the track load that the cursor is set —
   * and the only place it is remembered (`cursormemory.ts`: remembered at the
   * deliberate moves, never from an effect, because the route swap zeroes the
   * cursor on the way out and an effect would record that).
   */
  // A party's transport is the party's: its merged points and its own memory key (`playTrack`).
  const seek = (ts: number): void => {
    const t = playTrack();
    if (t === undefined) return;
    followStart = false;
    setCursor(ts);
    cursorMemory.remember(t.runId, ts);
  };
  /** Stop where the playhead is now, not where the throttled cursor last said. */
  const halt = (): void => {
    if (replayAnchor !== null) setCursor(replayCursor(performance.now()));
    setPlaying(false);
  };
  const stepBack = (): void => {
    const t = playTrack();
    if (t === undefined) return;
    halt();
    const prev = prevSampleBefore(t.points, cursor());
    if (prev !== undefined) seek(prev.ts);
  };
  const stepForward = (): void => {
    const t = playTrack();
    if (t === undefined) return;
    halt();
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
   * A pause is a deliberate stop, so it is where the cursor is remembered.
   */
  const togglePlay = (): void => {
    const t = track();
    if (t === undefined || !scrubbable()) return;
    if (playing()) {
      halt();
      seek(cursor());
      return;
    }
    if (cursor() >= span()!.to) seek(span()!.from);
    followStart = false;
    setPlaying(true);
  };

  /*
   * Playback on the run's own clock at the chosen speed (`SPEEDS`), its idle
   * gaps compressed: an anchor — where it started, when, how fast — that the
   * frame loop reads the playhead off (`replayCursorAt`) and ends at the last
   * sample. Never a tick that adds to the cursor, so a tab put away and
   * brought back finds the replay where the time says. A speed change mid-play
   * continues from the playhead at the new speed.
   */
  createEffect(() => {
    if (!playing()) {
      replayAnchor = null;
      return;
    }
    const s = speed();
    untrack(() => {
      const now = performance.now();
      const from = replayAnchor === null ? cursor() : replayCursor(now);
      replayAnchor = { cursor: from, at: now, speed: s };
    });
    needsDraw = true;
  });

  /* --- interaction --- */
  // One finger (or the mouse) drags; a second turns the gesture into a pinch
  // until either of the two lifts, and the finger left behind drags on. A
  // gesture that ever moved or pinched is never a tap.
  let drag: { x: number; y: number; ox: number; oy: number; moved: boolean } | null = null;
  let pinch: { ids: [number, number]; from: [Touch, Touch]; view: View } | null = null;
  let lastTap: (Touch & { t: number }) | null = null;
  const fingers = new Map<number, Touch>();

  const dragFrom = (p: Touch, moved: boolean): void => {
    drag = { x: p.x, y: p.y, ox: view.ox, oy: view.oy, moved };
  };
  const onPointerDown = (e: PointerEvent): void => {
    fingers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    canvas.setPointerCapture(e.pointerId);
    canvas.classList.add("drag");
    if (fingers.size === 1) {
      dragFrom({ x: e.clientX, y: e.clientY }, false);
    } else if (fingers.size === 2 && pinch === null) {
      const [a, b] = [...fingers.entries()];
      pinch = { ids: [a![0], b![0]], from: [a![1], b![1]], view };
      drag = null;
    }
  };
  /** A mouse over the map with no button down: name the unit under it. */
  const hover = (e: PointerEvent): void => {
    if (e.pointerType === "touch") return;
    const r = canvas.getBoundingClientRect();
    const x = e.clientX - r.left;
    const y = e.clientY - r.top;
    let best: string | null = null;
    let bestD = NEARBY_HIT_R * NEARBY_HIT_R;
    for (const d of nearbyDrawn) {
      const dd = (d.sx - x) * (d.sx - x) + (d.sy - y) * (d.sy - y);
      if (dd <= bestD) {
        bestD = dd;
        best = d.dot.id;
      }
    }
    if (best !== hoveredId) {
      hoveredId = best;
      needsDraw = true;
    }
  };
  const onPointerMove = (e: PointerEvent): void => {
    if (!fingers.has(e.pointerId)) {
      hover(e);
      return;
    }
    fingers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pinch !== null) {
      const a = fingers.get(pinch.ids[0]);
      const b = fingers.get(pinch.ids[1]);
      if (a === undefined || b === undefined) return;
      view = pinchView(pinch.view, pinch.from, [a, b]);
      needsDraw = true;
      return;
    }
    if (drag === null) return;
    const dx = e.clientX - drag.x;
    const dy = e.clientY - drag.y;
    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) drag.moved = true;
    view = { ...view, ox: drag.ox + dx, oy: drag.oy + dy };
    needsDraw = true;
  };
  const endPointer = (id: number): void => {
    fingers.delete(id);
    if (pinch !== null && pinch.ids.includes(id)) {
      pinch = null;
      const rest = [...fingers.values()][0];
      if (rest !== undefined) dragFrom(rest, true);
    }
    if (fingers.size === 0) {
      drag = null;
      canvas.classList.remove("drag");
    }
  };
  const onPointerUp = (e: PointerEvent): void => {
    const wasTap = fingers.size === 1 && pinch === null && drag !== null && !drag.moved;
    endPointer(e.pointerId);
    if (!wasTap) return;
    const r = canvas.getBoundingClientRect();
    const tap = { x: e.clientX - r.left, y: e.clientY - r.top, t: e.timeStamp };
    if (isDoubleTap(lastTap, tap)) {
      lastTap = null;
      view = zoomAt(view, tap.x, tap.y, 2);
      needsDraw = true;
      return;
    }
    lastTap = tap;
    const hit = hitTest(view, onMap(), tap.x, tap.y, PIP_HIT_R);
    setSelectedId(hit === null ? null : hit.runId);
    needsDraw = true;
  };
  const onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    const r = canvas.getBoundingClientRect();
    view = zoomAt(view, e.clientX - r.left, e.clientY - r.top, Math.exp(-e.deltaY * 0.0015));
    needsDraw = true;
  };

  /* --- the selected character at the playhead, for the sidebar --- */

  /** The sidebar's playhead: the cursor in a replay, the live playhead's throttled copy otherwise. */
  const sideAt = (): number | null => (track() !== undefined ? cursor() : playhead());
  /** What the trace says about the selected run at that moment; null where it has nothing, or does not drive. */
  const selectedTrace = createMemo(() => {
    traceRev();
    const p = selected();
    const t = sideAt();
    if (p === null || t === null || !traceDrives()) return null;
    return { unit: store.unitAt(p.runId, t), pose: store.poseAt(p.runId, t), t };
  });
  /**
   * The trace's character sheet for the selected run at the same moment, on
   * the same terms (`TraceStore.sheetAt`). Its own memo rather than a field of
   * `selectedTrace`, so the panels below see a change only when the sheet's
   * lists do, not on every tick of the playhead.
   */
  const selectedSheet = createMemo(() => {
    traceRev();
    const p = selected();
    const t = sideAt();
    if (p === null || t === null || !traceDrives()) return null;
    return store.sheetAt(p.runId, t);
  });
  /**
   * Money and the inventory at the playhead: the sheet's where it says, the
   * reading's where it does not (`sheetReading`) — live, the position's money
   * and no inventory, which the feed no longer carries; in a replay, the
   * track's reading at the cursor. Each kept equal across ticks while its
   * value is, so the bag and the paperdoll redraw only when what they show
   * changes.
   */
  const shown = createMemo(() => {
    const p = selected();
    if (p === null) return null;
    const t = track();
    return sheetReading(selectedSheet(), { money: p.money, items: t === undefined ? null : itemsAtCursor(t, cursor()) });
  });
  const shownItems = createMemo(() => shown()?.items ?? null);
  const shownMoney = createMemo(() => shown()?.money ?? null);
  /**
   * The quest log at the playhead, only where the sheet carries it: nothing
   * coarser records the log, so where the sheet cannot say (faster than 60×,
   * nothing loaded there, before the sheet, a restart's unobserved stretch)
   * there is no quest button at all. The same array while the log says the
   * same thing (`questLog`).
   */
  const shownQuests = createMemo(() => {
    const v = selectedSheet();
    return v === null ? null : questLog(v.sheet, v.qreq, v.items);
  });
  /** The bars' numbers: the trace's where it answers, the reading's where it does not (`gaugesOf`). */
  const gauges = createMemo(() => {
    const p = selected();
    return p === null ? null : gaugesOf(p, selectedTrace()?.unit?.state ?? null);
  });
  // Kept equal across ticks unless a cell actually changes, so the icons the
  // Wowhead script decorated stay put while their time counts down.
  const auras = createMemo(
    () => {
      const s = selectedTrace();
      return s?.unit === null || s === null ? [] : auraViews(s.unit.state.auras, s.t);
    },
    [],
    { equals: sameAuras },
  );
  const flags = createMemo<UnitFlag[]>(
    () => {
      const u = selectedTrace()?.unit;
      return u === null || u === undefined ? [] : unitFlags(u.state);
    },
    [],
    { equals: (a, b) => a.join() === b.join() },
  );
  const cast = createMemo(() => {
    const s = selectedTrace();
    return s === null || s.unit === null ? null : castReading(s.unit.state.cast, s.unit.castFrom, s.t);
  });
  /** The selected run's nearby layer at the playhead: how many units it has in view, and its own target among them. */
  const nearbyHere = createMemo(() => {
    nearbyRev();
    const p = selected();
    const t = sideAt();
    if (p === null || t === null || track() !== undefined) return null;
    const count = nearbyStore.countAt(p.runId, t);
    return count === null ? null : { count, target: nearbyStore.targetAt(p.runId, t) };
  });
  const target = createMemo(() => {
    const u = selectedTrace()?.unit;
    return u === null || u === undefined ? null : targetReading(u.state.target, nearbyHere()?.target?.name ?? null);
  });

  // The URL is written and the pin follows from it (the effect above), so
  // the address bar is always a link to what is on screen.
  const pickMap = (map: number): void => {
    if (map === activeMap()) return;
    setSelectedId(null);
    setParams({ map: String(map) }, { replace: true });
  };
  /**
   * A row of the live list: its pip's click, and the camera framed on the pip
   * where it is drawn (on the public build minutes behind the reading). A
   * character on another continent pins that continent first, the selection
   * kept, as a chip click would not keep it.
   */
  /** Where a party member is at the cursor, for its legend row: the map, and dead or a ghost where the trace says so. */
  const memberPlace = (p: AgentPosition): string => {
    traceRev();
    const t = sideAt();
    const u = t === null || !traceDrives() ? null : store.unitAt(p.runId, t);
    const state = u?.state.ghost === true ? " · ghost" : u?.state.dead === true ? " · dead" : "";
    return `${mapName(p.map)}${state}`;
  };
  const focusOn = (runId: string): void => {
    setSelectedId(runId);
    // The sidebar has just swapped the list for the character's sheet, and on
    // a phone, where it sits under the map, that moved the stage's foot; frame
    // against the stage as it is now, not as the observer last reported it.
    resize();
    const at = pips.get(runId) ?? feedList().find((p) => p.runId === runId);
    if (at === undefined) return;
    if (at.map !== activeMap()) {
      setPinnedMap(at.map);
      setParams({ map: String(at.map) }, { replace: true });
    }
    mapFit.focus(at);
  };

  return (
    <div class="map-wrap">
      <div class="map-stage" ref={stage}>
        <canvas class="map-ground" ref={ground} />
        <canvas
          ref={canvas}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={(e) => endPointer(e.pointerId)}
          onPointerLeave={() => {
            if (hoveredId === null) return;
            hoveredId = null;
            needsDraw = true;
          }}
          onWheel={onWheel}
        />
        {/* A bubble takes the pointer for its title; a drag or a wheel on one is the map's. */}
        <div class="map-bubbles" onPointerDown={onPointerDown} onWheel={onWheel}>
          <For each={bubbleStacks()}>
            {(stack) => {
              let el!: HTMLDivElement;
              onCleanup(() => {
                if (stackEls.get(stack.runId) !== el) return;
                stackEls.delete(stack.runId);
                stackSizes.delete(stack.runId);
              });
              return (
                <div
                  class="map-bubble-stack"
                  ref={(e) => {
                    el = e;
                    stackEls.set(stack.runId, e);
                  }}
                >
                  <For each={stack.bubbles}>
                    {(b) => (
                      <div class={`card map-bubble ${b.kind}`} title={b.title}>
                        {b.text}
                      </div>
                    )}
                  </For>
                </div>
              );
            }}
          </For>
        </div>
        <div class="map-chips">
          <Show when={mapChips(maps(), activeMap()).length > 1}>
            <For each={mapChips(maps(), activeMap())}>
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
          track={playTrack()}
          party={party() === undefined ? undefined : { id: party()!.id, members: replayed().length }}
          replayError={replayError()}
          feedError={feed.error === undefined ? undefined : displayError(feed.error)}
          cursor={cursor()}
          span={span()}
          playing={playing()}
          speed={speed()}
          count={count()}
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
            <Show
              when={replayId() === undefined && count() > 0}
              fallback={<span class="dim">{emptySideNote(replayId() !== undefined, activeMap())}</span>}
            >
              <LiveList rows={feedList()} onPick={focusOn} />
            </Show>
          }
        >
          {(p) => (
            <>
              {/*
                A party's replay: the members as the legend, each where it is at
                the cursor, and a click follows that member onto its map.
              */}
              <Show when={party()}>
                {(pv) => (
                  <>
                    <h3>
                      <A href={partyHref(pv().id)} title={pv().id}>
                        party · {shortRunId(pv().id)}
                      </A>
                    </h3>
                    <LiveList
                      rows={feedList()}
                      onPick={focusOn}
                      member={(id) => memberIndex().get(id)}
                      place={memberPlace}
                      selectedId={p().runId}
                    />
                  </>
                )}
              </Show>
              <h3>
                {memberIndex().has(p().runId) ? (
                  <span class={`swatch ${memberClass(memberIndex().get(p().runId)!)}`} />
                ) : (
                  <span class="swatch" style={{ background: colorOf(p().runId) }} />
                )}
                <span title={p().runId}>{pipName(p())}</span>
              </h3>
              <div class="k">model</div>
              <div class="v">
                <ModelIcon model={p().model} />
                <span title={p().model ?? ""}>{p().model === null ? "—" : modelDisplay(p().model!)}</span>
              </div>
              <Show when={gauges()}>
                {(g) => (
                  <div class="v">
                    <UnitFrame
                      level={g().level}
                      xp={g().xp}
                      nextLevelXp={g().nextLevelXp}
                      health={g().health}
                      maxHealth={g().maxHealth}
                      power={g().power}
                      maxPower={g().maxPower}
                      powerType={resolvePowerType(g().powerType, p().class)}
                      dead={g().dead}
                      cast={cast()}
                      target={target()}
                      flags={flags()}
                      auras={auras()}
                      now={selectedTrace()?.t}
                    />
                  </div>
                )}
              </Show>
              {/* At the playhead from the trace's sheet where it says (`shown`), the reading's otherwise. */}
              <div class="k">money</div>
              <div class="v mono">{fmtMoney(shownMoney())}</div>
              <div class="k">quests completed</div>
              <div class="v mono">{num(p().questsCompleted)}</div>
              {/*
                Inventory: the bag opens over the sidebar rather
                than widening it, and the paperdoll sits under it. The trace's
                sheet at the playhead where it answers; otherwise, in a replay,
                the track's newest reading behind the cursor (`lib/replay.ts`).
                Where neither says there is nothing to show, which the null
                line says rather than drawing empty bags.
                The quest log beside them is the sheet's alone (`shownQuests`),
                and does not wait on the bags: a sheet with the log and not yet
                the bags draws the null line and the quest button.
              */}
              <div class="k">inventory</div>
              <div class="v">
                <InventoryPanel items={shownItems()} quests={shownQuests()} missing={fmtItems(null, false)} />
              </div>
              {/* Where the pip is drawn: the trace's pose at the playhead when it has one. */}
              <div class="k">map</div>
              <div class="v" title={`map ${selectedTrace()?.pose?.map ?? p().map}`}>
                {mapName(selectedTrace()?.pose?.map ?? p().map)}
              </div>
              <div class="k">position</div>
              <div class="v mono">
                {(selectedTrace()?.pose?.x ?? p().x).toFixed(1)}, {(selectedTrace()?.pose?.y ?? p().y).toFixed(1)}
              </div>
              <Show when={nearbyHere()}>
                {(n) => (
                  <>
                    <div
                      class="k"
                      title="units in view: red engaged with the character, green service NPC, blue another player, grey other, ring dead"
                    >
                      nearby
                    </div>
                    <div class="v mono">{n().count}</div>
                  </>
                )}
              </Show>
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
                {/* In a party's replay the run's own replay is the way to one member alone. */}
                <Show when={replayHrefFor(group() === undefined ? track() : undefined, p())}>
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
