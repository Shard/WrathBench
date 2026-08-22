/**
 * The live map: one self-contained HTML document, same as `page.ts` — no build
 * step, no dependencies, no mapping library. A two-axis affine transform over a
 * canvas is the whole of pan and zoom.
 *
 * The renderer consumes a *position feed* and nothing else (ADR-0019). Exactly
 * one function fetches — `fetchPositions()` — and every drawing function takes
 * the positions it draws as an argument. A replay mode later swaps that one
 * function for a trajectory reader with a time cursor and the rest of this file
 * does not change. Anything that made a draw path ask whether a run is live
 * would be a regression against the ADR.
 *
 * The coordinate maths is duplicated verbatim from `runner/viewer/worldmap.ts`,
 * which is the source of truth and where the tests point. The page is a string
 * with no module loader, so it cannot import it; if the transform ever changes,
 * change it there first and copy it here.
 */

export const MAP_PAGE = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>WrathBench map</title>
<style>
  :root {
    color-scheme: dark light;
    --bg: #14161a; --fg: #d8dee6; --dim: #8a94a3; --line: #2b3038;
    --panel: #1b1e24; --accent: #7aa2f7; --err: #f7768e; --ok: #9ece6a;
    --warn: #e0af68;
    --grid: #1a1d22; --gridline: #23272e;
  }
  @media (prefers-color-scheme: light) {
    :root { --bg:#fbfbfc; --fg:#1e2229; --dim:#5d6673; --line:#dde1e7;
            --panel:#f2f3f6; --accent:#2f5fd0; --err:#b3283c; --ok:#3f7a24; --warn:#8a5d00;
            --grid:#e9ebef; --gridline:#d5d9e0; }
  }
  * { box-sizing: border-box; }
  html, body { height: 100%; }
  body { margin: 0; background: var(--bg); color: var(--fg); overflow: hidden;
         font: 14px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; }
  a { color: var(--accent); text-decoration: none; }
  a:hover { text-decoration: underline; }
  header { background: var(--bg); border-bottom: 1px solid var(--line);
           padding: 10px 16px; display: flex; gap: 16px; align-items: baseline; flex-wrap: wrap; }
  header h1 { font-size: 15px; margin: 0; font-weight: 600; }
  .tabs { display: inline-flex; gap: 10px; }
  .tabs a.on { color: var(--fg); font-weight: 700; }
  .dim { color: var(--dim); }
  .err { color: var(--err); }
  #wrap { display: flex; height: calc(100% - 43px); }
  #stage { position: relative; flex: 1; min-width: 0; }
  canvas { display: block; width: 100%; height: 100%; cursor: grab; touch-action: none; }
  canvas.drag { cursor: grabbing; }
  #chips { position: absolute; top: 10px; left: 10px; display: flex; gap: 6px; flex-wrap: wrap; }
  #hint { position: absolute; bottom: 10px; left: 10px; color: var(--dim); font-size: 12px; }
  button { font: inherit; background: var(--panel); color: var(--fg); border: 1px solid var(--line);
           border-radius: 4px; padding: 2px 8px; cursor: pointer; }
  button:hover { border-color: var(--accent); }
  button.on { border-color: var(--accent); color: var(--fg); font-weight: 700; }
  #side { width: 300px; flex: none; border-left: 1px solid var(--line); background: var(--panel);
          padding: 12px 14px; overflow-y: auto; }
  #side h2 { font-size: 14px; margin: 0 0 8px; font-weight: 700; }
  #side .k { color: var(--dim); font-size: 11px; text-transform: uppercase; letter-spacing: .06em; }
  #side .v { margin-bottom: 8px; word-break: break-word; }
  #side .swatch { display: inline-block; width: 10px; height: 10px; border-radius: 50%;
                  margin-right: 6px; vertical-align: middle; }
</style>
</head>
<body>
<header>
  <h1><a href="/">WrathBench</a></h1>
  <span class="tabs"><a href="/">runs</a><a href="/map" class="on">map</a></span>
  <span id="hdr" class="dim">loading…</span>
</header>
<div id="wrap">
  <div id="stage">
    <canvas id="cv"></canvas>
    <div id="chips"></div>
    <div id="hint" class="dim">drag to pan · scroll to zoom · click a pip</div>
  </div>
  <div id="side"><span class="dim">no agent selected</span></div>
</div>
<script>
const $ = (s) => document.querySelector(s);
const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text; return n; };

/* ---------- coordinates — mirror of runner/viewer/worldmap.ts ---------- */
/* World X → tile row, world Y → tile column; 64×64 tiles of 533.33325 yards,
 * origin at the centre. Change worldmap.ts first, then copy here. */
const TILE_SIZE = 533.33325, GRID = 64, TILE_PX = 256;
const coordToTile = (c) => 32 - c / TILE_SIZE;
const worldToPixel = (x, y) => ({ px: coordToTile(y) * TILE_PX, py: coordToTile(x) * TILE_PX });

/* ---------- formatting (mirrors page.ts) ---------- */
const num = (v) => (v === null || v === undefined) ? "—" : String(v);
function fmtMoney(copper) {
  if (copper === null || copper === undefined) return "—";
  const g = Math.floor(copper / 10000), s = Math.floor((copper % 10000) / 100), c = copper % 100;
  const parts = [];
  if (g) parts.push(g + "g");
  if (g || s) parts.push(s + "s");
  parts.push(c + "c");
  return parts.join(" ");
}
function fmtAge(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return s + "s ago";
  const m = Math.floor(s / 60);
  if (m < 60) return m + "m" + String(s % 60).padStart(2, "0") + "s ago";
  return Math.floor(m / 60) + "h" + String(m % 60).padStart(2, "0") + "m ago";
}
const shortHarness = (v) => (v ? String(v).replace(/^harness-/, "") : "—");

/* ---------- the position feed — the only thing that fetches ---------- */
/*
 * ADR-0019's reuse seam. Everything below draws whatever array this returns and
 * never asks where it came from; replay swaps in a trajectory reader here.
 */
const POLL_MS = 5000;
const STALE_MS = 120000;

async function fetchPositions() {
  const r = await fetch("/api/positions");
  if (!r.ok) throw new Error("/api/positions → " + r.status);
  const body = await r.json();
  return body.positions || [];
}

/* ---------- tiles ---------- */
/*
 * An LRU of Image objects with 404s memoised in the same map: before the
 * extraction has run every visible tile is missing, and an unremembered miss
 * would re-request dozens of them on every pan.
 */
const TILE_CACHE_MAX = 512;
const tileCache = new Map();
let needsDraw = true;

function tile(map, row, col) {
  const key = map + "/" + row + "_" + col;
  const hit = tileCache.get(key);
  if (hit !== undefined) { tileCache.delete(key); tileCache.set(key, hit); return hit; }
  const img = new Image();
  const entry = { img, ok: false, done: false };
  img.onload = () => { entry.ok = true; entry.done = true; needsDraw = true; };
  // A miss changes nothing on screen — the fallback square is already drawn —
  // and asking for a redraw here would re-request every missing tile forever.
  img.onerror = () => { entry.done = true; };
  img.src = "/tiles/" + map + "/" + row + "_" + col + ".png";
  tileCache.set(key, entry);
  while (tileCache.size > TILE_CACHE_MAX) tileCache.delete(tileCache.keys().next().value);
  return entry;
}

/* ---------- view ---------- */
/* screen = worldPixel * scale + offset. One affine transform, both axes. */
const view = { scale: 0.25, ox: 0, oy: 0, fitted: false };
const cv = $("#cv");
const ctx = cv.getContext("2d");
let W = 0, H = 0;

function resize() {
  const dpr = window.devicePixelRatio || 1;
  const r = cv.getBoundingClientRect();
  W = Math.max(1, Math.round(r.width));
  H = Math.max(1, Math.round(r.height));
  cv.width = Math.round(W * dpr);
  cv.height = Math.round(H * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  needsDraw = true;
}
window.addEventListener("resize", resize);

const MIN_SCALE = 0.01, MAX_SCALE = 8;
const clampScale = (s) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, s));

function centreOn(px, py, scale) {
  view.scale = clampScale(scale);
  view.ox = W / 2 - px * view.scale;
  view.oy = H / 2 - py * view.scale;
  needsDraw = true;
}

/* Auto-fit the bounding box of what is on screen. A single agent has no box to
 * fit, so it gets a sane close-up rather than a division by zero. */
function fitTo(list) {
  if (list.length === 0) { centreOn(GRID * TILE_PX / 2, GRID * TILE_PX / 2, 0.06); return; }
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of list) {
    const q = worldToPixel(p.x, p.y);
    x0 = Math.min(x0, q.px); x1 = Math.max(x1, q.px);
    y0 = Math.min(y0, q.py); y1 = Math.max(y1, q.py);
  }
  const pad = 240;
  const bw = (x1 - x0) + pad * 2, bh = (y1 - y0) + pad * 2;
  const scale = clampScale(Math.min(W / bw, H / bh));
  centreOn((x0 + x1) / 2, (y0 + y1) / 2, Math.min(scale, 1.5));
}

/* ---------- pips ---------- */
/*
 * Kept in a map keyed by run id and mutated in place across polls: recreating
 * them would reset the interpolation and drop the selection every 5 seconds.
 */
const pips = new Map();
let maps = [];
let activeMap = null;
let selected = null;
let feedError = null;

/* A stable colour per run — same run, same dot, across reloads and machines. */
function hueOf(runId) {
  let h = 2166136261;
  for (let i = 0; i < runId.length; i++) { h ^= runId.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0) % 360;
}
const colorOf = (runId) => "hsl(" + hueOf(runId) + " 70% 60%)";

function ingest(list) {
  const seen = new Set();
  for (const p of list) {
    seen.add(p.runId);
    const q = worldToPixel(p.x, p.y);
    let pip = pips.get(p.runId);
    if (pip === undefined) {
      pip = { runId: p.runId, data: p, px: q.px, py: q.py, tx: q.px, ty: q.py };
      pips.set(p.runId, pip);
    } else {
      pip.data = p;
      pip.tx = q.px; pip.ty = q.py;
    }
  }
  for (const id of [...pips.keys()]) if (!seen.has(id)) pips.delete(id);

  const counts = new Map();
  for (const pip of pips.values()) counts.set(pip.data.map, (counts.get(pip.data.map) || 0) + 1);
  maps = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]);
  if (activeMap === null || !counts.has(activeMap)) activeMap = maps.length ? maps[0][0] : null;
  if (selected !== null && !pips.has(selected)) selected = null;

  if (!view.fitted && pips.size > 0) { fitTo(onMap()); view.fitted = true; }
  needsDraw = true;
}

const onMap = () => [...pips.values()].filter((p) => p.data.map === activeMap).map((p) => p.data);
const pipsOnMap = () => [...pips.values()].filter((p) => p.data.map === activeMap);

/* ---------- drawing ---------- */
/*
 * The palette comes from the same CSS custom properties the rest of the viewer
 * uses, so the canvas follows the light/dark switch. Read once and re-read when
 * the scheme changes — getComputedStyle in a draw loop is not free.
 */
let theme = {};
function readTheme() {
  const cs = getComputedStyle(document.documentElement);
  theme = {
    grid: cs.getPropertyValue("--grid").trim() || "#1a1d22",
    gridline: cs.getPropertyValue("--gridline").trim() || "#23272e",
    dim: cs.getPropertyValue("--dim").trim() || "#8a94a3",
    fg: cs.getPropertyValue("--fg").trim() || "#d8dee6",
    bg: cs.getPropertyValue("--bg").trim() || "#14161a",
  };
  needsDraw = true;
}
readTheme();
if (window.matchMedia) {
  const mq = window.matchMedia("(prefers-color-scheme: dark)");
  if (mq.addEventListener) mq.addEventListener("change", readTheme);
}

function drawGrid(map) {
  ctx.fillStyle = theme.grid;
  ctx.fillRect(0, 0, W, H);
  const c0 = Math.max(0, Math.floor((-view.ox / view.scale) / TILE_PX));
  const c1 = Math.min(GRID - 1, Math.floor(((W - view.ox) / view.scale) / TILE_PX));
  const r0 = Math.max(0, Math.floor((-view.oy / view.scale) / TILE_PX));
  const r1 = Math.min(GRID - 1, Math.floor(((H - view.oy) / view.scale) / TILE_PX));
  const size = TILE_PX * view.scale;
  /*
   * Zoomed far out a 256px tile carries no information, and the whole 64×64
   * grid would be on screen at once — more cells than the cache holds, so every
   * frame would evict and re-request the lot. Below that scale the grid alone
   * is the honest picture. The threshold also keeps the visible cell count
   * inside the LRU: at 96px a 1920×1200 viewport shows 20×13 ≈ 260 tiles, well
   * under TILE_CACHE_MAX, so a pan can never thrash it.
   */
  const useTiles = size >= 96;
  const line = theme.gridline, dim = theme.dim;
  ctx.lineWidth = 1;
  ctx.font = "11px ui-monospace, monospace";
  ctx.textBaseline = "top";
  for (let row = r0; row <= r1; row++) {
    for (let col = c0; col <= c1; col++) {
      const x = col * size + view.ox, y = row * size + view.oy;
      const t = useTiles ? tile(map, row, col) : null;
      if (t !== null && t.ok) {
        // A hair of overdraw: neighbouring tiles must not show a seam when the
        // scale puts their edges on a fractional device pixel.
        ctx.drawImage(t.img, x, y, size + 1, size + 1);
        continue;
      }
      ctx.strokeStyle = line;
      ctx.strokeRect(x + 0.5, y + 0.5, size - 1, size - 1);
      // The label is the file name the extraction would write: it is how an
      // operator checks orientation the moment real tiles land.
      if (size > 64) {
        ctx.fillStyle = dim;
        ctx.fillText(row + "_" + col, x + 6, y + 5);
      }
    }
  }
}

function drawPips(list) {
  const now = Date.now();
  ctx.textBaseline = "middle";
  ctx.font = "12px ui-monospace, monospace";
  for (const pip of list) {
    const x = pip.px * view.scale + view.ox, y = pip.py * view.scale + view.oy;
    if (x < -60 || y < -30 || x > W + 60 || y > H + 30) continue;
    const stale = now - pip.data.ts > STALE_MS;
    const on = pip.runId === selected;
    ctx.globalAlpha = stale ? 0.4 : 1;
    ctx.beginPath();
    ctx.arc(x, y, on ? 7 : 5, 0, Math.PI * 2);
    ctx.fillStyle = colorOf(pip.runId);
    ctx.fill();
    if (on) { ctx.lineWidth = 2; ctx.strokeStyle = theme.fg; ctx.stroke(); }
    const name = pip.data.character || pip.runId;
    // The label chip takes the page's own background and foreground so it
    // stays legible when the viewer flips to the light scheme.
    ctx.fillStyle = theme.bg;
    ctx.globalAlpha = stale ? 0.3 : 0.75;
    const w = ctx.measureText(name).width;
    ctx.fillRect(x + 9, y - 8, w + 6, 16);
    ctx.globalAlpha = stale ? 0.4 : 1;
    ctx.fillStyle = theme.fg;
    ctx.fillText(name, x + 12, y + 1);
    ctx.globalAlpha = 1;
  }
}

/* A plain lerp toward the newest reading: a pip walks rather than teleports. */
function step(list) {
  let moving = false;
  for (const pip of list) {
    const dx = pip.tx - pip.px, dy = pip.ty - pip.py;
    if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) { pip.px = pip.tx; pip.py = pip.ty; continue; }
    pip.px += dx * 0.18; pip.py += dy * 0.18;
    moving = true;
  }
  return moving;
}

function frame() {
  const list = pipsOnMap();
  const moving = step(list);
  if (needsDraw || moving) {
    needsDraw = false;
    ctx.clearRect(0, 0, W, H);
    if (activeMap !== null) { drawGrid(activeMap); drawPips(list); }
    else { ctx.fillStyle = theme.grid; ctx.fillRect(0, 0, W, H); }
  }
  requestAnimationFrame(frame);
}

/* ---------- interaction ---------- */
let drag = null;
cv.addEventListener("pointerdown", (e) => {
  drag = { x: e.clientX, y: e.clientY, ox: view.ox, oy: view.oy, moved: false };
  cv.setPointerCapture(e.pointerId);
  cv.classList.add("drag");
});
cv.addEventListener("pointermove", (e) => {
  if (drag === null) return;
  const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
  if (Math.abs(dx) > 3 || Math.abs(dy) > 3) drag.moved = true;
  view.ox = drag.ox + dx; view.oy = drag.oy + dy;
  needsDraw = true;
});
cv.addEventListener("pointerup", (e) => {
  const wasDrag = drag !== null && drag.moved;
  drag = null;
  cv.classList.remove("drag");
  if (!wasDrag) pick(e);
});
cv.addEventListener("pointercancel", () => { drag = null; cv.classList.remove("drag"); });

cv.addEventListener("wheel", (e) => {
  e.preventDefault();
  const r = cv.getBoundingClientRect();
  const sx = e.clientX - r.left, sy = e.clientY - r.top;
  const next = clampScale(view.scale * Math.exp(-e.deltaY * 0.0015));
  // Keep the world point under the cursor under the cursor.
  view.ox = sx - (sx - view.ox) * (next / view.scale);
  view.oy = sy - (sy - view.oy) * (next / view.scale);
  view.scale = next;
  needsDraw = true;
}, { passive: false });

function pick(e) {
  const r = cv.getBoundingClientRect();
  const sx = e.clientX - r.left, sy = e.clientY - r.top;
  let best = null, bestD = 18 * 18;
  for (const pip of pipsOnMap()) {
    const x = pip.px * view.scale + view.ox, y = pip.py * view.scale + view.oy;
    const d = (x - sx) * (x - sx) + (y - sy) * (y - sy);
    if (d <= bestD) { bestD = d; best = pip.runId; }
  }
  selected = best;
  drawSide();
  needsDraw = true;
}

/* ---------- sidebar ---------- */
function drawSide() {
  const side = $("#side");
  side.textContent = "";
  const pip = selected === null ? null : pips.get(selected);
  if (pip === undefined || pip === null) {
    side.append(el("span", "dim", pips.size ? "no agent selected" : "no agents on the map"));
    return;
  }
  const p = pip.data;
  const h = el("h2");
  const sw = el("span", "swatch"); sw.style.background = colorOf(p.runId);
  h.append(sw, document.createTextNode(p.character || p.runId));
  side.append(h);
  const row = (k, v, cls) => { side.append(el("div", "k", k), el("div", "v " + (cls || ""), v)); };
  row("model", p.model || "—");
  row("level / xp", num(p.level) + " · " + num(p.xp));
  row("money", fmtMoney(p.money));
  row("quests completed", num(p.questsCompleted));
  row("map", String(p.map));
  row("position", p.x.toFixed(1) + ", " + p.y.toFixed(1));
  const age = el("div", "v"); age.textContent = fmtAge(Date.now() - p.ts);
  side.append(el("div", "k", "last update"), age);
  row("harness", shortHarness(p.harnessVersion));
  const a = el("a", "", "open run →");
  a.href = "/run/" + encodeURIComponent(p.runId);
  side.append(a);
  // The age is the only thing that moves on its own; it ticks in place.
  clearInterval(drawSide.timer);
  drawSide.timer = setInterval(() => {
    const cur = selected === null ? null : pips.get(selected);
    if (!cur) { clearInterval(drawSide.timer); return; }
    age.textContent = fmtAge(Date.now() - cur.data.ts);
  }, 1000);
}

function drawChips() {
  const box = $("#chips");
  box.textContent = "";
  if (maps.length < 2) return;
  for (const [map, count] of maps) {
    const b = el("button", map === activeMap ? "on" : "", "map " + map + " · " + count);
    b.onclick = () => {
      if (map === activeMap) return;
      activeMap = map;
      selected = null;
      fitTo(onMap());
      drawChips(); drawSide();
    };
    box.append(b);
  }
}

function drawHeader() {
  const bits = [pips.size + (pips.size === 1 ? " agent" : " agents")];
  if (maps.length > 1) bits.push(maps.length + " maps");
  $("#hdr").className = feedError ? "err" : "dim";
  $("#hdr").textContent = feedError ? String(feedError) : bits.join(" · ");
}

/* ---------- loop ---------- */
async function poll() {
  try {
    ingest(await fetchPositions());
    feedError = null;
  } catch (err) {
    feedError = err;
  }
  drawChips(); drawHeader(); drawSide();
}

resize();
frame();
poll().then(() => drawSide());
setInterval(poll, POLL_MS);
</script>
</body>
</html>
`;
