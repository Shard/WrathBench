/**
 * The whole client: one self-contained HTML document, no build step, no
 * dependencies. It renders both the run list and a single run's feed, choosing
 * by pathname.
 */

export const PAGE = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>WrathBench viewer</title>
<style>
  :root {
    color-scheme: dark light;
    --bg: #14161a; --fg: #d8dee6; --dim: #8a94a3; --line: #2b3038;
    --panel: #1b1e24; --accent: #7aa2f7; --err: #f7768e; --ok: #9ece6a;
    --warn: #e0af68;
  }
  @media (prefers-color-scheme: light) {
    :root { --bg:#fbfbfc; --fg:#1e2229; --dim:#5d6673; --line:#dde1e7;
            --panel:#f2f3f6; --accent:#2f5fd0; --err:#b3283c; --ok:#3f7a24; --warn:#8a5d00; }
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--fg);
         font: 14px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; }
  a { color: var(--accent); text-decoration: none; }
  a:hover { text-decoration: underline; }
  header { position: sticky; top: 0; background: var(--bg); border-bottom: 1px solid var(--line);
           padding: 10px 16px; display: flex; gap: 16px; align-items: baseline; flex-wrap: wrap; z-index: 5; }
  header h1 { font-size: 15px; margin: 0; font-weight: 600; }
  main { padding: 12px 16px 32px; max-width: 1100px; }
  table { border-collapse: collapse; width: 100%; }
  th, td { text-align: left; padding: 5px 10px 5px 0; border-bottom: 1px solid var(--line);
           vertical-align: top; white-space: nowrap; }
  th { color: var(--dim); font-weight: 600; }
  .dim { color: var(--dim); }
  .live { color: var(--ok); font-weight: 700; }
  .err { color: var(--err); }
  .warn { color: var(--warn); }
  .entry { border-left: 3px solid var(--line); padding: 4px 0 4px 10px; margin: 6px 0; }
  .entry.snippet { border-color: var(--accent); }
  .entry.response { border-color: #5f6b7f; }
  .entry.error { border-color: var(--err); background: color-mix(in srgb, var(--err) 8%, transparent); }
  .entry.harness { border-color: var(--warn); background: color-mix(in srgb, var(--warn) 12%, transparent); }
  .entry.termination, .entry.pause { border-color: var(--err); }
  .entry.state { border-color: transparent; padding-top: 0; padding-bottom: 0; margin: 2px 0; }
  .meta { color: var(--dim); font-size: 12px; display: flex; gap: 10px; flex-wrap: wrap; align-items: baseline; }
  .tag { text-transform: uppercase; letter-spacing: .06em; font-size: 11px; font-weight: 700; }
  pre { background: var(--panel); border: 1px solid var(--line); border-radius: 4px;
        padding: 8px 10px; overflow-x: auto; margin: 4px 0; white-space: pre-wrap;
        word-break: break-word; max-height: 60vh; }
  pre.code { white-space: pre; }
  .text { white-space: pre-wrap; margin: 3px 0; }
  button { font: inherit; background: var(--panel); color: var(--fg); border: 1px solid var(--line);
           border-radius: 4px; padding: 2px 8px; cursor: pointer; }
  button:hover { border-color: var(--accent); }
  .banner { border: 1px solid var(--line); border-radius: 4px; padding: 8px 12px; margin: 8px 0; background: var(--panel); }
  .banner.shakeout { border-color: var(--warn); color: var(--warn); font-weight: 700; }
  .banner.term { border-color: var(--err); }
  svg.spark { vertical-align: middle; }
  label { color: var(--dim); }
</style>
</head>
<body>
<header>
  <h1><a href="/">WrathBench</a> <span id="crumb" class="dim"></span></h1>
  <span id="hdr" class="dim"></span>
  <span id="ctrl"></span>
</header>
<main id="main">loading…</main>
<script>
const $ = (s) => document.querySelector(s);
const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text; return n; };
const fmtTs = (ts) => ts ? new Date(ts).toISOString().replace("T", " ").slice(0, 19) : "—";
const fmtHm = (ts) => ts ? new Date(ts).toISOString().slice(11, 19) : "—";
const fmtDur = (ms) => { const s = Math.floor(ms/1000); const h = Math.floor(s/3600);
  const m = Math.floor((s%3600)/60); return h ? h+"h"+String(m).padStart(2,"0")+"m" : m+"m"+String(s%60).padStart(2,"0")+"s"; };
const num = (v) => (v === null || v === undefined) ? "—" : String(v);

async function api(path) {
  const r = await fetch(path);
  if (!r.ok) throw new Error(path + " → " + r.status);
  return await r.json();
}

/* ---------- index ---------- */
async function renderIndex() {
  $("#crumb").textContent = "runs";
  const { runs } = await api("/api/runs");
  const main = $("#main"); main.textContent = "";
  const t = el("table");
  const head = el("tr");
  for (const h of ["run", "state", "model", "driver", "level", "xp", "started", "outcome"]) head.append(el("th", "", h));
  t.append(head);
  for (const r of runs) {
    const tr = el("tr");
    const c1 = el("td"); const a = el("a", "", r.runId); a.href = "/run/" + encodeURIComponent(r.runId); c1.append(a);
    if (r.shakeout) { c1.append(document.createTextNode(" ")); c1.append(el("span", "warn", "[" + r.shakeout + "]")); }
    tr.append(c1);
    tr.append(el("td", r.live ? "live" : "dim", r.live ? "● LIVE" : (r.pauseReason ? "paused" : (r.terminationReason ? "done" : "cold"))));
    tr.append(el("td", "", r.model || "—"));
    tr.append(el("td", "", r.driver || "—"));
    tr.append(el("td", "", num(r.level)));
    tr.append(el("td", "", num(r.xp)));
    tr.append(el("td", "dim", fmtTs(r.startedAt)));
    const out = r.terminationReason ? r.terminationReason + (r.terminationDetail ? " — " + r.terminationDetail : "")
      : (r.pauseReason ? "paused: " + r.pauseReason : "—");
    tr.append(el("td", "dim", out));
    t.append(tr);
  }
  main.append(t);
  if (runs.length === 0) main.append(el("p", "dim", "no runs under data/runs"));
}

/* ---------- run ---------- */
const WINDOW = 200;
let RUN = null, feed = null, firstLoaded = 0, follow = true, es = null;

function sparkline(states) {
  const pts = states.filter((s) => s.level !== null && s.level > 0);
  if (pts.length < 2) return null;
  const key = (s) => s.level + (s.xp ? Math.min(0.95, s.xp / 40000) : 0);
  const vals = pts.map(key);
  const min = Math.min(...vals), max = Math.max(...vals), span = (max - min) || 1;
  const w = 220, h = 26;
  const d = vals.map((v, i) => (i ? "L" : "M") + (i / (vals.length - 1) * w).toFixed(1) + "," +
    (h - ((v - min) / span) * (h - 2) - 1).toFixed(1)).join(" ");
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("class", "spark"); svg.setAttribute("width", w); svg.setAttribute("height", h);
  const p = document.createElementNS(ns, "path");
  p.setAttribute("d", d); p.setAttribute("fill", "none");
  p.setAttribute("stroke", "currentColor"); p.setAttribute("stroke-width", "1.5");
  svg.append(p); return svg;
}

function rawButton(i, label) {
  const b = el("button", "", label);
  let pre = null;
  b.onclick = async () => {
    // The button lives in the flex .meta row; the panel belongs to the entry itself.
    if (pre) { pre.remove(); pre = null; b.textContent = label; return; }
    const txt = await (await fetch("/api/run/" + encodeURIComponent(RUN.runId) + "/raw/" + i)).text();
    let pretty = txt;
    try { pretty = JSON.stringify(JSON.parse(txt), null, 2); } catch (_) {}
    pre = el("pre", "", pretty.length > 400000 ? pretty.slice(0, 400000) + "\n… truncated" : pretty);
    (b.closest(".entry") || b.parentNode).append(pre);
    b.textContent = "hide";
  };
  return b;
}

function renderEntry(e) {
  // The tool_call for run_snippet duplicates the snippet entry that follows it.
  if (e.t === "tool_call" && e.name === "run_snippet") return null;
  const kind = e.t === "harness" || e.t === "watchdog" ? "harness"
    : e.isError ? "error" : e.t;
  const div = el("div", "entry " + kind);
  const meta = el("div", "meta");
  meta.append(el("span", "tag", e.t.replace(/_/g, " ")));
  meta.append(el("span", "", fmtHm(e.ts)));
  if (e.turn !== undefined) meta.append(el("span", "", "turn " + e.turn));
  div.append(meta);

  switch (e.t) {
    case "request":
      meta.append(el("span", "", e.messageCount + " messages · system " + (e.systemChars/1000).toFixed(1) + "k chars"));
      meta.append(rawButton(e.i, "show messages"));
      break;
    case "response":
      if (e.text) div.append(el("div", "text", e.text));
      if (e.tools && e.tools.length) meta.append(el("span", "", "→ " + e.tools.join(", ")));
      if (e.clipped) meta.append(rawButton(e.i, "raw"));
      break;
    case "snippet":
      div.append(el("pre", "code", e.code));
      break;
    case "snippet_result":
    case "tool_result": {
      if (e.isError) meta.append(el("span", "err tag", "error"));
      if (e.name) meta.append(el("span", "", e.name));
      const pre = el("pre", "", e.text);
      if (e.isError) pre.classList.add("err");
      div.append(pre);
      if (e.clipped) meta.append(rawButton(e.i, "raw"));
      break;
    }
    case "events_served":
      meta.append(el("span", "", e.count + " events via " + e.via));
      if (e.opcodes && e.opcodes.length) meta.append(el("span", "dim", e.opcodes.join("  ")));
      if (e.count > 0) meta.append(rawButton(e.i, "show events"));
      break;
    case "state": {
      const bits = ["level " + num(e.level), "xp " + num(e.xp)];
      if (e.map !== undefined && e.map !== null)
        bits.push("map " + e.map + " (" + [e.x, e.y, e.z].map((v) => Number(v).toFixed(0)).join(", ") + ")");
      bits.push("events " + num(e.eventCount));
      meta.append(el("span", "", bits.join(" · ")));
      break;
    }
    case "harness":
    case "watchdog": {
      if (e.kind) meta.append(el("span", "warn tag", String(e.kind)));
      const words = ["text", "detail", "reason", "message"].map((k) => e[k]).filter(Boolean);
      const extra = Object.keys(e).filter((k) =>
        !["i","t","ts","turn","start","end","clipped","kind","text","detail","reason","message"].includes(k));
      div.append(el("div", "text", words.join(" — ") ||
        extra.map((k) => k + " " + JSON.stringify(e[k])).join("  ")));
      if (e.clipped) meta.append(rawButton(e.i, "raw"));
      break;
    }
    case "termination":
    case "pause": {
      div.append(el("div", "text err",
        (e.t === "pause" ? "paused: " : "terminated: ") + e.reason + (e.detail ? " — " + e.detail : "")));
      break;
    }
    case "meta":
    default: {
      const rest = {};
      for (const k of Object.keys(e)) if (!["i","t","ts","turn","start","end","clipped"].includes(k)) rest[k] = e[k];
      const s = JSON.stringify(rest);
      div.append(el("div", "text", s === "{}" ? "" : s.length > 600 ? s.slice(0, 600) + " …" : s));
      if (e.clipped || s.length > 600) meta.append(rawButton(e.i, "raw"));
    }
  }
  return div;
}

function append(entries, where) {
  const frag = document.createDocumentFragment();
  for (const e of entries) { const n = renderEntry(e); if (n) frag.append(n); }
  if (where === "top") feed.prepend(frag); else feed.append(frag);
}

async function loadEarlier(btn) {
  const from = Math.max(0, firstLoaded - WINDOW);
  if (from === firstLoaded) return;
  const { entries } = await api("/api/run/" + encodeURIComponent(RUN.runId) + "/entries?from=" + from + "&limit=" + (firstLoaded - from));
  const anchor = feed.scrollHeight;
  append(entries, "top");
  firstLoaded = from;
  btn.textContent = from > 0 ? "load earlier (" + from + " before this)" : "start of run";
  btn.disabled = from === 0;
  window.scrollBy(0, feed.scrollHeight - anchor);
}

async function renderRun(runId) {
  $("#crumb").textContent = runId;
  const info = await api("/api/run/" + encodeURIComponent(runId));
  RUN = info.run;
  const main = $("#main"); main.textContent = "";

  if (RUN.shakeout) main.append(el("div", "banner shakeout", RUN.shakeout.toUpperCase() + " — NOT A HARNESS RESULT"));

  const hdr = el("div", "banner");
  const line1 = [RUN.model || "?", RUN.driver || "?", "harness " + (RUN.harnessVersion || "?"),
    "character " + (RUN.character || "?")].join(" · ");
  hdr.append(el("div", "", line1));
  const dur = RUN.startedAt ? fmtDur((RUN.endedAt || RUN.mtime || Date.now()) - RUN.startedAt) : "?";
  hdr.append(el("div", "dim", "started " + fmtTs(RUN.startedAt) + " · " + dur + " · " + info.total + " entries"));
  const lvl = el("div", "");
  lvl.append(document.createTextNode("level " + num(RUN.level) + " · xp " + num(RUN.xp) + "  "));
  const sp = sparkline(info.states); if (sp) lvl.append(sp);
  hdr.append(lvl);
  main.append(hdr);

  if (RUN.terminationReason)
    main.append(el("div", "banner term", "terminated: " + RUN.terminationReason +
      (RUN.terminationDetail ? " — " + RUN.terminationDetail : "")));
  else if (RUN.pauseReason)
    main.append(el("div", "banner term", "paused: " + RUN.pauseReason + " (resumable)"));
  else if (RUN.live)
    main.append(el("div", "banner", "● live — following"));

  const earlier = el("button", "", "load earlier");
  main.append(earlier);
  earlier.onclick = () => loadEarlier(earlier);

  feed = el("div", "feed");
  main.append(feed);

  const from = Math.max(0, info.total - WINDOW);
  const { entries } = await api("/api/run/" + encodeURIComponent(runId) + "/entries?from=" + from + "&limit=" + WINDOW);
  firstLoaded = from;
  earlier.textContent = from > 0 ? "load earlier (" + from + " before this)" : "start of run";
  earlier.disabled = from === 0;
  append(entries, "bottom");
  window.scrollTo(0, document.body.scrollHeight);

  const followBox = el("label", "");
  const cb = el("input"); cb.type = "checkbox"; cb.checked = true;
  cb.onchange = () => { follow = cb.checked; };
  followBox.append(cb, document.createTextNode(" auto-scroll"));
  $("#ctrl").textContent = ""; $("#ctrl").append(followBox);

  // A run that has already terminated will never grow: no point holding a stream open.
  if (RUN.terminationReason) return;

  es = new EventSource("/api/run/" + encodeURIComponent(runId) + "/stream");
  es.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.entries && msg.entries.length) {
      append(msg.entries, "bottom");
      if (follow) window.scrollTo(0, document.body.scrollHeight);
    }
  };
  es.onerror = () => { $("#hdr").textContent = "stream disconnected"; };
}

const path = decodeURIComponent(location.pathname);
if (path.startsWith("/run/")) renderRun(path.slice(5)).catch((e) => { $("#main").textContent = String(e); });
else renderIndex().catch((e) => { $("#main").textContent = String(e); });
</script>
</body>
</html>
`;
