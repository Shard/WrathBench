/**
 * The live map, ported from the hand-written `/map` page onto Solid.
 *
 * ADR-0019's two rules hold unchanged. The renderer consumes a *position feed*
 * and nothing else: `positions()` is the only thing that fetches, every draw
 * function takes what it draws as an argument, and no draw path asks whether a
 * run is live — a replay mode swaps the feed and this file does not change. And
 * the world→tile transform is imported from `runner/viewer/worldmap.ts` rather
 * than copied; the old page copied it only because a template string cannot
 * import.
 *
 * Replay (`/map?run=<id>`) is a *feed swap*, not a second renderer: the same
 * `AgentPosition[]` the live poll produces is produced instead by a time cursor
 * over one run's recorded track (FOLLOW-UPS 22). Nothing in the draw path asks
 * which mode it is in — the two differences are that a scrubbed pip is placed
 * rather than walked (the lerp would trail the cursor and read as a bug), and
 * that the route walked so far is drawn behind it.
 *
 * Canvas drawing sits outside Solid's reactivity on purpose. Pips interpolate
 * toward their newest reading every frame, so the draw loop is a
 * requestAnimationFrame with its own mutable state; Solid owns the sidebar, the
 * chips and the header, which change once per poll.
 */

import { A, useSearchParams } from "@solidjs/router";
import { For, Show, createEffect, createSignal, onCleanup, onMount } from "solid-js";
import { api, type AgentPosition, type TrackResponse } from "../api/client";
import { fmtAge, fmtMoney, num, shortHarness, stamp } from "../lib/format";
import {
  STALE_MS,
  TILE_MIN_PX,
  colorOf,
  fitTo,
  hitTest,
  project,
  visibleGrid,
  zoomAt,
  type View,
} from "../lib/mapview";
import { poll } from "../lib/poll";
import { mapsVisited, positionsAt, routeUpTo, trackSpan } from "../lib/replay";

const POLL_MS = 5000;
const TILE_CACHE_MAX = 512;

interface Pip {
  runId: string;
  data: AgentPosition;
  /**
   * Where the pip is *drawn*, in world yards — walking toward `data.x/y` rather
   * than jumping to it. One coordinate system throughout: `project()` and
   * `hitTest()` both read these, so what the eye picks is what the click gets.
   */
  x: number;
  y: number;
}

interface TileEntry {
  img: HTMLImageElement;
  ok: boolean;
}

export default function MapPage() {
  const [params] = useSearchParams();
  const replayId = (): string | undefined =>
    typeof params.run === "string" && params.run.length > 0 ? params.run : undefined;

  const [track, setTrack] = createSignal<TrackResponse | undefined>(undefined);
  const [cursor, setCursor] = createSignal(0);
  const [playing, setPlaying] = createSignal(false);
  const [replayError, setReplayError] = createSignal<string | undefined>(undefined);

  // The live feed keeps its 5s poll, and answers with nothing while a replay
  // owns the map — one feed reaches `ingest`, never two.
  const feed = poll(
    () => (replayId() === undefined ? api.positions().then((p) => p.positions) : Promise.resolve([])),
    POLL_MS,
  );

  let canvas!: HTMLCanvasElement;
  let stage!: HTMLDivElement;

  const [maps, setMaps] = createSignal<[number, number][]>([]);
  const [activeMap, setActiveMap] = createSignal<number | null>(null);
  const [selected, setSelected] = createSignal<AgentPosition | null>(null);
  const [count, setCount] = createSignal(0);
  const [ageTick, setAgeTick] = createSignal(Date.now());

  /* Mutable render state — read every frame, never through a signal. */
  const pips = new Map<string, Pip>();
  const tiles = new Map<string, TileEntry>();
  let view: View = { scale: 0.25, ox: 0, oy: 0 };
  let fitted = false;
  let needsDraw = true;
  let W = 0;
  let H = 0;
  let theme = { grid: "#1a1d22", gridline: "#23272e", dim: "#8a94a3", fg: "#d8dee6", bg: "#14161a" };

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
    img.onload = (): void => {
      entry.ok = true;
      needsDraw = true;
    };
    // A miss changes nothing on screen — the fallback square is already there —
    // and asking for a redraw would re-request every missing tile forever.
    img.onerror = null;
    img.src = `/tiles/${map}/${row}_${col}.png`;
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
      grid: get("--grid", "#1a1d22"),
      gridline: get("--gridline", "#23272e"),
      dim: get("--dim", "#8a94a3"),
      fg: get("--fg", "#d8dee6"),
      bg: get("--bg", "#14161a"),
    };
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
    needsDraw = true;
  }

  const onMap = (): Pip[] => [...pips.values()].filter((p) => p.data.map === activeMap());

  function ingest(list: AgentPosition[], snap = false): void {
    const seen = new Set<string>();
    for (const p of list) {
      seen.add(p.runId);
      const existing = pips.get(p.runId);
      if (existing === undefined) {
        pips.set(p.runId, { runId: p.runId, data: p, x: p.x, y: p.y });
      } else {
        existing.data = p;
        // Scrubbing: the pip belongs where the cursor says, now. Walking there
        // at 0.18/frame would trail every drag of the slider.
        if (snap) {
          existing.x = p.x;
          existing.y = p.y;
        }
      }
    }
    for (const id of [...pips.keys()]) if (!seen.has(id)) pips.delete(id);

    const counts = new Map<number, number>();
    for (const pip of pips.values()) counts.set(pip.data.map, (counts.get(pip.data.map) ?? 0) + 1);
    const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]);
    setMaps(sorted);
    setCount(pips.size);
    const active = activeMap();
    if (active === null || !counts.has(active)) setActiveMap(sorted.length > 0 ? sorted[0]![0] : null);
    const sel = selected();
    if (sel !== null) {
      const still = pips.get(sel.runId);
      setSelected(still === undefined ? null : still.data);
    }
    if (!fitted && pips.size > 0) {
      view = fitTo({ w: W, h: H }, onMap().map((p) => p.data));
      fitted = true;
    }
    needsDraw = true;
  }

  function drawGrid(ctx: CanvasRenderingContext2D, map: number): void {
    ctx.fillStyle = theme.grid;
    ctx.fillRect(0, 0, W, H);
    const g = visibleGrid(view, { w: W, h: H });
    /*
     * Zoomed far out a 256px tile carries no information, and the whole 64×64
     * grid would be on screen at once — more cells than the cache holds, so
     * every frame would evict and re-request the lot. The threshold also keeps
     * the visible cell count inside the LRU.
     */
    const useTiles = g.size >= TILE_MIN_PX;
    ctx.lineWidth = 1;
    ctx.font = "11px ui-monospace, monospace";
    ctx.textBaseline = "top";
    for (let row = g.row0; row <= g.row1; row++) {
      for (let col = g.col0; col <= g.col1; col++) {
        const x = col * g.size + view.ox;
        const y = row * g.size + view.oy;
        const t = useTiles ? tile(map, row, col) : null;
        if (t !== null && t.ok) {
          // A hair of overdraw: neighbouring tiles must not show a seam when
          // the scale puts their edges on a fractional device pixel.
          ctx.drawImage(t.img, x, y, g.size + 1, g.size + 1);
          continue;
        }
        ctx.strokeStyle = theme.gridline;
        ctx.strokeRect(x + 0.5, y + 0.5, g.size - 1, g.size - 1);
        // The label is the file name the extraction would write: it is how an
        // operator checks orientation the moment real tiles land.
        if (g.size > 64) {
          ctx.fillStyle = theme.dim;
          ctx.fillText(`${row}_${col}`, x + 6, y + 5);
        }
      }
    }
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
    ctx.strokeStyle = colorOf(replayId() ?? "");
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  function drawPips(ctx: CanvasRenderingContext2D, list: Pip[]): void {
    const now = Date.now();
    const sel = selected();
    ctx.textBaseline = "middle";
    ctx.font = "12px ui-monospace, monospace";
    for (const pip of list) {
      const p = project(view, pip.x, pip.y);
      if (p.sx < -60 || p.sy < -30 || p.sx > W + 60 || p.sy > H + 30) continue;
      const stale = now - pip.data.ts > STALE_MS;
      const on = sel !== null && pip.runId === sel.runId;
      ctx.globalAlpha = stale ? 0.4 : 1;
      ctx.beginPath();
      ctx.arc(p.sx, p.sy, on ? 7 : 5, 0, Math.PI * 2);
      ctx.fillStyle = colorOf(pip.runId);
      ctx.fill();
      if (on) {
        ctx.lineWidth = 2;
        ctx.strokeStyle = theme.fg;
        ctx.stroke();
      }
      const name = pip.data.character ?? pip.runId;
      // The label chip takes the page's own background and foreground so it
      // stays legible when the viewer flips to the light scheme.
      ctx.fillStyle = theme.bg;
      ctx.globalAlpha = stale ? 0.3 : 0.75;
      const w = ctx.measureText(name).width;
      ctx.fillRect(p.sx + 9, p.sy - 8, w + 6, 16);
      ctx.globalAlpha = stale ? 0.4 : 1;
      ctx.fillStyle = theme.fg;
      ctx.fillText(name, p.sx + 12, p.sy + 1);
      ctx.globalAlpha = 1;
    }
  }

  /* A plain lerp toward the newest reading: a pip walks rather than teleports. */
  function step(list: Pip[]): boolean {
    let moving = false;
    for (const pip of list) {
      const dx = pip.data.x - pip.x;
      const dy = pip.data.y - pip.y;
      if (Math.abs(dx) < 0.05 && Math.abs(dy) < 0.05) {
        pip.x = pip.data.x;
        pip.y = pip.data.y;
        continue;
      }
      pip.x += dx * 0.18;
      pip.y += dy * 0.18;
      moving = true;
    }
    return moving;
  }

  onMount(() => {
    readTheme();
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(stage);

    const mq = window.matchMedia?.("(prefers-color-scheme: dark)");
    mq?.addEventListener("change", readTheme);

    let raf = 0;
    const frame = (): void => {
      const ctx = canvas.getContext("2d");
      if (ctx !== null) {
        const list = onMap();
        const moving = step(list);
        if (needsDraw || moving) {
          needsDraw = false;
          ctx.clearRect(0, 0, W, H);
          const map = activeMap();
          if (map !== null) {
            drawGrid(ctx, map);
            const t = track();
            if (t !== undefined) drawRoute(ctx, routeUpTo(t.points, map, cursor()));
            drawPips(ctx, list);
          } else {
            ctx.fillStyle = theme.grid;
            ctx.fillRect(0, 0, W, H);
          }
        }
      }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);

    const ageTimer = setInterval(() => setAgeTick(Date.now()), 1000);

    onCleanup(() => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      mq?.removeEventListener("change", readTheme);
      clearInterval(ageTimer);
    });
  });

  /* Loading a run's track: the replay's own fit, and the cursor at the start. */
  createEffect(() => {
    const id = replayId();
    if (id === undefined) {
      setTrack(undefined);
      setPlaying(false);
      return;
    }
    setReplayError(undefined);
    void api
      .track(id)
      .then((t) => {
        setTrack(t);
        const span = trackSpan(t.points);
        setCursor(span?.from ?? 0);
        pips.clear();
        fitted = false;
        setMaps(mapsVisited(t.points).map((m) => [m, 1] as [number, number]));
        setActiveMap(t.points[0]?.map ?? null);
        needsDraw = true;
      })
      .catch((e: unknown) => setReplayError(String(e)));
  });

  /* The one place a feed reaches the renderer, live or replayed. */
  createEffect(() => {
    const t = track();
    if (t !== undefined) {
      const list = positionsAt(t, cursor());
      ingest(list, true);
      const here = list[0];
      // Following the cursor across a continent is the honest behaviour: the
      // character is not on the map the user was looking at any more.
      if (here !== undefined && here.map !== activeMap()) {
        setActiveMap(here.map);
        view = fitTo({ w: W, h: H }, [here]);
      }
      setSelected(here ?? null);
      return;
    }
    const list = feed.latest;
    if (list !== undefined) ingest(list);
  });

  /* Playback: one recorded sample per tick, so a 6h run scrubs in ~30s. */
  createEffect(() => {
    if (!playing()) return;
    const t = track();
    if (t === undefined) return;
    const timer = setInterval(() => {
      const points = t.points;
      const span = trackSpan(points);
      if (span === null) return;
      const next = points.find((p) => p.ts > cursor());
      if (next === undefined) {
        setPlaying(false);
        return;
      }
      setCursor(next.ts);
    }, 250);
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
    const hit = hitTest(view, onMap(), e.clientX - r.left, e.clientY - r.top);
    setSelected(hit === null ? null : hit.data);
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
    setActiveMap(map);
    setSelected(null);
    view = fitTo({ w: W, h: H }, onMap().map((p) => p.data));
    needsDraw = true;
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
                <button class={map === activeMap() ? "on" : ""} onClick={() => pickMap(map)}>
                  map {map} · {n}
                </button>
              )}
            </For>
          </Show>
        </div>
        <Show when={track()}>
          {(t) => {
            const span = (): { from: number; to: number } | null => trackSpan(t().points);
            return (
              <div class="map-chips" style={{ top: "auto", bottom: "34px", right: "10px" }}>
                <div class="scrub">
                  <button onClick={() => setPlaying(!playing())}>{playing() ? "pause" : "play"}</button>
                  <input
                    type="range"
                    min={span()?.from ?? 0}
                    max={span()?.to ?? 0}
                    value={cursor()}
                    onInput={(e) => {
                      setPlaying(false);
                      setCursor(Number(e.currentTarget.value));
                    }}
                  />
                  <span class="dim mono">{stamp(cursor())}</span>
                  <A href="/map">live</A>
                </div>
              </div>
            );
          }}
        </Show>
        <div class="map-hint">
          {replayError() !== undefined ? (
            <span class="err">{replayError()}</span>
          ) : track() !== undefined ? (
            <>
              replay of {track()!.runId} · {track()!.points.length} recorded positions · drag to pan
            </>
          ) : feed.error !== undefined ? (
            <span class="err">{String(feed.error)}</span>
          ) : (
            <>
              {count()} {count() === 1 ? "agent" : "agents"} · drag to pan · scroll to zoom · click a pip
            </>
          )}
        </div>
      </div>
      <div class="side">
        <Show
          when={selected()}
          fallback={<span class="dim">{count() > 0 ? "no agent selected" : "no agents on the map"}</span>}
        >
          {(p) => (
            <>
              <h3>
                <span class="swatch" style={{ background: colorOf(p().runId) }} />
                {p().character ?? p().runId}
              </h3>
              <div class="k">model</div>
              <div class="v">{p().model ?? "—"}</div>
              <div class="k">level / xp</div>
              <div class="v mono">
                {num(p().level)} · {num(p().xp)}
              </div>
              <div class="k">money</div>
              <div class="v mono">{fmtMoney(p().money)}</div>
              <div class="k">quests completed</div>
              <div class="v mono">{num(p().questsCompleted)}</div>
              <div class="k">map</div>
              <div class="v mono">{p().map}</div>
              <div class="k">position</div>
              <div class="v mono">
                {p().x.toFixed(1)}, {p().y.toFixed(1)}
              </div>
              <div class="k">last update</div>
              <div class="v">{fmtAge(ageTick() - p().ts)}</div>
              <div class="k">harness</div>
              <div class="v">{shortHarness(p().harnessVersion)}</div>
              <A href={`/run/${encodeURIComponent(p().runId)}`}>open run →</A>
            </>
          )}
        </Show>
      </div>
    </div>
  );
}
