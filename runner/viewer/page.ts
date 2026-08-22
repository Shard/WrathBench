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
  .tabs { display: inline-flex; gap: 10px; }
  .tabs a.on { color: var(--fg); font-weight: 700; }
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
  select { font: inherit; background: var(--panel); color: var(--fg);
           border: 1px solid var(--line); border-radius: 4px; padding: 1px 4px; }
  .collapsed { max-height: 4.6em; overflow: hidden; position: relative; }
  .collapsed::after { content: ""; position: absolute; left: 0; right: 0; bottom: 0; height: 1.6em;
                      background: linear-gradient(transparent, var(--bg)); }
  pre.collapsed::after { background: linear-gradient(transparent, var(--panel)); }
  .status { margin: 20px 0 10px; padding: 22px 24px; border: 1px solid var(--line);
            border-left: 3px solid var(--ok); border-radius: 6px; background: var(--panel);
            font-size: 17px; line-height: 1.6; display: flex; gap: 16px; align-items: center; }
  .status .dot { width: 11px; height: 11px; border-radius: 50%; background: var(--ok);
                 flex: none; animation: pulse 1.6s ease-in-out infinite; }
  @keyframes pulse { 0%, 100% { opacity: 1; transform: scale(1); }
                     50% { opacity: .3; transform: scale(.7); } }
  @media (prefers-reduced-motion: reduce) { .status .dot { animation: none; } }
  .status .what { font-weight: 600; }
  .status .since { color: var(--dim); font-size: 14px; }
  .status.stale { border-left-color: var(--warn); }
  .status.stale .dot { background: var(--warn); animation: none; }
  .breakout { display: flex; gap: 26px; flex-wrap: wrap; }
  .breakout .cell { min-width: 82px; }
  .breakout .cell.wide { min-width: 0; }
  .breakout .k { color: var(--dim); font-size: 11px; text-transform: uppercase; letter-spacing: .06em; }
  .breakout .v { font-size: 16px; font-weight: 600; }
  .breakout .n { color: var(--dim); font-size: 11px; }
  .metrics { display: inline-flex; gap: 14px; flex-wrap: wrap; }
  #ctrl { display: inline-flex; gap: 14px; flex-wrap: wrap; margin-left: auto; }
  .metrics b { font-weight: 600; color: var(--fg); }
</style>
</head>
<body>
<header>
  <h1><a href="/">WrathBench</a> <span id="crumb" class="dim"></span></h1>
  <span class="tabs"><a href="/" class="on">runs</a><a href="/map">map</a></span>
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

/*
 * Wall-clock ages, the way an operator reads them. The exact stamp never goes
 * away — it moves to the title attribute, so hovering still answers "when".
 */
function fmtRel(ts) {
  if (!ts) return "—";
  const secs = Math.floor((Date.now() - ts) / 1000);
  if (secs < 0) return "just now";
  if (secs < 45) return "just now";
  const mins = Math.floor(secs / 60);
  if (mins < 60) return (mins || 1) + "m ago";
  const hours = Math.floor(mins / 60);
  if (hours < 24) return hours + "h ago";
  const days = Math.floor(hours / 24);
  if (days === 1) return "yesterday";
  if (days < 30) return days + "d ago";
  const months = Math.floor(days / 30);
  if (months < 12) return months + "mo ago";
  return Math.floor(days / 365) + "y ago";
}

/*
 * The subscription driver is called "claude-subscription" in configs and
 * trajectories and stays that way — this is the label the operator reads, and
 * only the label.
 */
const DRIVER_LABELS = { "claude-subscription": "claude-sdk" };
const label = (name) => (name && DRIVER_LABELS[name]) || name;

/*
 * Copper, as the game shows it. Zero is a real reading — a character can be
 * broke — so 0 renders "0c" and only a missing value renders an em dash.
 */
function fmtMoney(copper) {
  if (copper === null || copper === undefined) return "—";
  const g = Math.floor(copper / 10000);
  const s = Math.floor((copper % 10000) / 100);
  const c = copper % 100;
  const parts = [];
  if (g) parts.push(g + "g");
  if (g || s) parts.push(s + "s");
  parts.push(c + "c");
  return parts.join(" ");
}

/* The harness stamp is a git describe — "harness-0.1-12-g542034f". The prefix
 * is the same on every row, so it earns no width; the full string is on hover. */
const shortHarness = (v) => (v ? String(v).replace(/^harness-/, "") : "—");

/* How long the run has been going: first trajectory entry to last, and for a
 * live run, to now — it is still accruing. */
function playtimeMs(r, now) {
  const from = r.firstTs || r.startedAt;
  if (!from) return null;
  const to = r.live ? now : (r.lastTs || r.endedAt || r.mtime);
  if (!to) return null;
  return Math.max(0, to - from);
}

async function api(path) {
  const r = await fetch(path);
  if (!r.ok) throw new Error(path + " → " + r.status);
  return await r.json();
}

/* ---------- index ---------- */
/*
 * What the tokens column may honestly say. A run whose driver never logged
 * provider usage gets an estimate marked with a tilde — except the claude-sdk
 * lane, where the estimate was so far off the truth that saying nothing is more
 * useful than saying a number.
 */
function tokenCell(r) {
  const tok = r.tokens;
  if (!tok || (tok.turns === 0 && tok.totalTokens === 0)) return ["—", "", "dim"];
  if (tok.source === "reported")
    return [fmtTokens(tok.totalTokens), "Provider-reported, summed over " + tok.turns + " turns.", ""];
  if (r.driver === "claude-subscription")
    return ["usage not recorded", "This run predates usage logging in the claude driver: " +
      "the CLI reported tokens and the driver discarded them. A character estimate would be " +
      "wildly low here, so none is shown.", "dim"];
  return ["~" + fmtTokens(tok.totalTokens),
    "Estimated from characters ÷ 4 — this provider reported no usage.", "dim"];
}

async function renderIndex() {
  $("#crumb").textContent = "runs";
  const { runs } = await api("/api/runs");
  const main = $("#main"); main.textContent = "";
  const t = el("table");
  const head = el("tr");
  for (const h of ["run", "state", "model", "character", "harness", "level", "xp", "money",
    "quests", "started", "playtime", "tokens", "outcome"])
    head.append(el("th", "", h));
  t.append(head);
  const ticking = [];
  for (const r of runs) {
    const tr = el("tr");
    const c1 = el("td"); const a = el("a", "", r.runId); a.href = BASE + "/run/" + encodeURIComponent(r.runId); c1.append(a);
    if (r.shakeout) { c1.append(document.createTextNode(" ")); c1.append(el("span", "warn", "[" + r.shakeout + "]")); }
    tr.append(c1);
    tr.append(el("td", r.live ? "live" : "dim", r.live ? "● LIVE" : (r.pauseReason ? "paused" : (r.terminationReason ? "done" : "cold"))));
    tr.append(el("td", "", (r.platform ? label(r.platform) + " · " : "") + (r.model || "—")));
    tr.append(el("td", "", r.character || "—"));
    const harness = el("td", "dim", shortHarness(r.harnessVersion));
    if (r.harnessVersion) harness.title = r.harnessVersion;
    tr.append(harness);
    tr.append(el("td", "", num(r.level)));
    tr.append(el("td", "", num(r.xp)));
    const money = el("td", r.money === null ? "dim" : "", fmtMoney(r.money));
    if (r.money === null) money.title = "not recorded — this run predates the money column";
    tr.append(money);
    const quests = el("td", r.questsCompleted === null ? "dim" : "", num(r.questsCompleted));
    if (r.questsCompleted === null)
      quests.title = "not recorded — this run predates the quests column";
    tr.append(quests);
    const started = el("td", "dim", fmtRel(r.startedAt));
    started.title = fmtTs(r.startedAt);
    tr.append(started);
    const play = el("td", r.live ? "" : "dim", "—");
    const paint = () => {
      const ms = playtimeMs(r, Date.now());
      play.textContent = ms === null ? "—" : fmtDur(ms);
    };
    paint();
    // A live run is still accruing playtime; its cell keeps counting.
    if (r.live) ticking.push(paint);
    tr.append(play);
    const cell = tokenCell(r);
    const tokens = el("td", cell[2], cell[0]);
    if (cell[1]) tokens.title = cell[1];
    tr.append(tokens);
    const out = r.terminationReason ? r.terminationReason + (r.terminationDetail ? " — " + r.terminationDetail : "")
      : (r.pauseReason ? "paused: " + r.pauseReason : "—");
    tr.append(el("td", "dim", out));
    t.append(tr);
  }
  main.append(t);
  if (ticking.length) setInterval(() => { for (const f of ticking) f(); }, 1000);
  if (runs.length === 0) main.append(el("p", "dim", "no runs under data/runs"));
}

/* ---------- run ---------- */
const WINDOW = 200;
let RUN = null, feed = null, firstLoaded = 0, follow = true, es = null;
let statusBox = null, lastEntry = null, breakoutBox = null;

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

/* ---------- header metrics ---------- */
const fmtTokens = (n) => n >= 1e6 ? (n / 1e6).toFixed(2) + "M" : n >= 1000 ? (n / 1000).toFixed(1) + "k" : String(n);
const modelLabel = () => (RUN.platform ? label(RUN.platform) + " · " : "") + (RUN.model || "?");

/*
 * Token counts. The runner logs a provider "usage" block on response entries
 * when the provider returns one, so newer runs show measured counts. Runs
 * recorded before usage logging landed fall back to characters ÷ 4 and are
 * marked with a tilde and an "est" suffix; the server decides which by whether
 * it found any usage in the file.
 */
function showMetrics(tok) {
  const est = tok.source === "estimated";
  const box = el("span", "metrics");
  const item = (label, value, title) => {
    const s = el("span", "dim");
    s.append(document.createTextNode(label + " "), el("b", "", value));
    if (title) s.title = title;
    return s;
  };
  box.append(el("span", "", modelLabel()));
  box.append(item("context", (est ? "~" : "") + fmtTokens(tok.contextTokens),
    est ? "Estimated from prompt characters ÷ 4 — this run predates provider usage logging."
        : "Reported by the provider."));
  box.append(item("total", (est ? "~" : "") + fmtTokens(tok.totalTokens) + (est ? " est" : ""),
    "Prompt + completion summed over " + tok.turns + " turns, as billed."));
  $("#hdr").textContent = "";
  $("#hdr").append(box);
}

/* ---------- token breakout and cost ---------- */
/*
 * PRICING — $ per million tokens. Prices as of 2026-08; edit here.
 *
 *   claude-sonnet-5  list $3.00 in / $15.00 out, currently under introductory
 *                    pricing at $2.00 / $10.00 through 2026-08-31. The
 *                    introductory rate is what is used below; swap in 3.00 /
 *                    15.00 (and 0.30 / 3.75 for cache) once it lapses.
 *   claude-opus-5    $5.00 in / $25.00 out.
 *
 * Cache rates follow the published multipliers on the model's input price:
 * a cache read is 0.1x, a 5-minute cache write is 1.25x.
 *
 * These are Anthropic API list prices. A claude-sdk run is billed against a
 * subscription, not per token, so its cost line is what the same work would
 * have cost on the API — a comparison figure, not an invoice.
 */
const PRICING = [
  { id: "claude-opus-5", match: /opus/i, input: 5.00, output: 25.00, cacheRead: 0.50, cacheWrite: 6.25 },
  { id: "claude-sonnet-5", match: /sonnet/i, input: 2.00, output: 10.00, cacheRead: 0.20, cacheWrite: 2.50 },
];

/* Only price what we can name. An unknown model gets tokens and no cost. */
function priceFor(run) {
  const model = run.model || "";
  if (run.driver !== "claude-subscription" && !/claude/i.test(model)) return null;
  for (const p of PRICING) if (p.match.test(model)) return p;
  return null;
}

function costOf(tok, p) {
  const read = tok.cacheReadTokens || 0;
  const write = tok.cacheWriteTokens || 0;
  // Cached tokens are a subset of the prompt, so the full-price part is what
  // is left after both cache figures come out of it.
  const fresh = Math.max(0, tok.promptTokens - read - write);
  return (fresh * p.input + read * p.cacheRead + write * p.cacheWrite +
          tok.completionTokens * p.output) / 1e6;
}

function breakout(tok, run) {
  const box = el("div", "banner breakout");
  const row = (name, value, note) => {
    const d = el("div", "cell");
    d.append(el("div", "k", name), el("div", "v", value));
    if (note) d.append(el("div", "n", note));
    box.append(d);
  };
  // World signals first: they are what the run is actually for, and unlike the
  // token figures they mean the same thing on every driver.
  row("money", fmtMoney(run.money), run.money === null ? "not recorded" : "on hand");
  row("quests", num(run.questsCompleted), run.questsCompleted === null ? "not recorded" : "completed");
  if (tok.source !== "reported") {
    const why = run.driver === "claude-subscription"
      ? "usage not recorded — this run predates usage logging in the claude driver"
      : "no per-field breakout: this provider reported no usage";
    box.append(el("div", "cell wide dim", why));
    if (run.driver !== "claude-subscription")
      row("estimate", "~" + fmtTokens(tok.totalTokens), "characters ÷ 4, all turns");
    return box;
  }
  row("input", fmtTokens(tok.promptTokens), "cached included");
  row("output", fmtTokens(tok.completionTokens), "");
  row("cache read", tok.cacheReadTokens === null ? "—" : fmtTokens(tok.cacheReadTokens),
    tok.cacheReadTokens === null ? "not reported" : "of the input above");
  row("cache write", tok.cacheWriteTokens === null ? "—" : fmtTokens(tok.cacheWriteTokens),
    tok.cacheWriteTokens === null ? "not reported" : "");
  row("total", fmtTokens(tok.totalTokens), tok.turns + " turns");
  const p = priceFor(run);
  if (p === null) {
    row("cost", "—", "no price on file for this model");
  } else {
    const usd = costOf(tok, p);
    row("cost", "$" + (usd < 1 ? usd.toFixed(3) : usd.toFixed(2)),
      "at " + p.id + " API list" + (run.driver === "claude-subscription" ? ", not billed" : ""));
  }
  return box;
}

/* ---------- expansion presets ---------- */
/* Which block kinds a preset expands. Individual blocks stay click-toggleable. */
const PRESETS = {
  all: ["snippet", "response", "result"],
  snippets: ["snippet", "response", "result"],
  responses: ["response"],
  minimal: [],
};
const PRESET_LABELS = [["minimal", "Minimal"], ["responses", "Responses"],
  ["snippets", "Snippets"], ["all", "All expanded"]];
let preset = "minimal";
try { preset = localStorage.getItem("wrathbench.viewer.expand") || "minimal"; } catch (_) {}
if (!PRESETS[preset]) preset = "minimal";
const wants = (kind) => PRESETS[preset].includes(kind);
const blocks = [];

/* Fold a block to ~3 lines with a toggle. Short blocks are left alone. */
function collapsible(kind, node, text) {
  const lines = String(text).split("\n").length;
  if (lines <= 3 && text.length < 200) return null;
  const btn = el("button", "", "");
  let open = wants(kind);
  const set = (v) => {
    open = v;
    node.classList.toggle("collapsed", !open);
    btn.textContent = open ? "collapse" : "expand · " + lines + " lines";
  };
  btn.onclick = () => set(!open);
  blocks.push({ kind, set });
  set(open);
  return btn;
}

function applyPreset(next) {
  preset = next;
  try { localStorage.setItem("wrathbench.viewer.expand", next); } catch (_) {}
  for (const b of blocks) b.set(wants(b.kind));
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
    case "response": {
      if (e.tools && e.tools.length) meta.append(el("span", "", "→ " + e.tools.join(", ")));
      if (e.text) {
        const body = el("div", "text", e.text);
        div.append(body);
        const b = collapsible("response", body, e.text);
        if (b) meta.append(b);
      }
      if (e.clipped) meta.append(rawButton(e.i, "raw"));
      break;
    }
    case "snippet": {
      const pre = el("pre", "code", e.code);
      div.append(pre);
      const b = collapsible("snippet", pre, e.code);
      if (b) meta.append(b);
      break;
    }
    case "snippet_result":
    case "tool_result": {
      if (e.isError) meta.append(el("span", "err tag", "error"));
      if (e.name) meta.append(el("span", "", e.name));
      const pre = el("pre", "", e.text);
      if (e.isError) pre.classList.add("err");
      div.append(pre);
      const b = collapsible("result", pre, e.text);
      if (b) meta.append(b);
      if (e.clipped) meta.append(rawButton(e.i, "raw"));
      break;
    }
    case "events_served":
      meta.append(el("span", "", e.count + " events via " + e.via));
      /*
       * The record holds the raw batch; the model read the folded window
       * (CONTEXT_POLICY.EVENT_WINDOW_EXCLUDE). Lead with the split so the
       * operator reads what the model read, not the wall of monster-moves the
       * "show events" button opens.
       */
      if (e.ambient)
        meta.append(el("span", "", (e.count - e.ambient) + " model-visible, " +
          e.ambient + " ambient movement folded into state"));
      if (e.opcodes && e.opcodes.length)
        meta.append(el("span", "dim", e.opcodes.join("  ") +
          (e.moreOpcodes ? "  +" + e.moreOpcodes + " more kinds" : "")));
      if (e.folded)
        meta.append(el("span", "dim", "· +" + e.folded + " ambient movement folded out"));
      if (e.count > 0) meta.append(rawButton(e.i, "show events"));
      break;
    case "state": {
      const bits = ["level " + num(e.level), "xp " + num(e.xp)];
      if (e.map !== undefined && e.map !== null)
        bits.push("map " + e.map + " (" + [e.x, e.y, e.z].map((v) => Number(v).toFixed(0)).join(", ") + ")");
      // Only when the recorder put them there: an older run has neither.
      if (typeof e.money === "number") bits.push("money " + fmtMoney(e.money));
      const q = typeof e.quests_completed === "number" ? e.quests_completed : e.questsCompleted;
      if (typeof q === "number") bits.push("quests " + q);
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

/* ---------- live activity ---------- */
/*
 * What the session is plausibly doing, read off the tail of the trajectory.
 * The loop writes a fixed cycle — request → response → tool_call → snippet →
 * snippet_result → events_served → (state) → request — so the type of the last
 * entry, plus how long it has sat there, is the whole story.
 */
function activity(e) {
  if (!e) return "starting up…";
  switch (e.t) {
    case "meta": case "resume": return "starting up…";
    case "request": return "waiting on the model…";
    case "response":
      return e.tools && e.tools.length ? "dispatching " + e.tools.join(", ") + "…" : "model replied — next turn pending";
    case "tool_call":
      return e.name === "run_snippet" ? "running snippet…" : "calling " + (e.name || "a tool") + "…";
    case "snippet": return "running snippet…";
    case "snippet_result":
      return e.isError ? "snippet errored — model is reading it" : "reading the snippet result…";
    case "tool_result": return "tool finished — next turn pending";
    case "events_served": return "gathering world events / next turn pending";
    case "state": return "idle between turns";
    case "harness": case "watchdog": return "harness notice — see above";
    case "pause": return "paused: " + (e.reason || "unknown");
    default: return "working…";
  }
}

/* Elapsed since the last thing the run wrote, ticking once a second. */
function drawStatus() {
  if (!statusBox || !lastEntry) return;
  const secs = Math.max(0, Math.round((Date.now() - lastEntry.ts) / 1000));
  const stale = secs > 120;
  statusBox.className = "status" + (stale ? " stale" : "");
  statusBox.textContent = "";
  statusBox.append(el("span", "dot"));
  const body = el("div", "");
  body.append(el("div", "what", stale
    ? "no trajectory activity for " + fmtDur(secs * 1000) + " — the run may have stopped"
    : activity(lastEntry)));
  const bits = [];
  if (lastEntry.turn !== undefined) bits.push("turn " + lastEntry.turn);
  bits.push(secs + "s since last " + lastEntry.t.replace(/_/g, " "));
  body.append(el("div", "since", bits.join(" · ")));
  statusBox.append(body);
}

/* The run ended while we watched: the pulse becomes a termination banner. */
function finish(main, end) {
  if (statusBox) { statusBox.remove(); statusBox = null; }
  if (es) { es.close(); es = null; }
  main.append(el("div", "banner term",
    "terminated: " + (end.reason || "?") + (end.detail ? " — " + end.detail : "")));
}

function startStatus(main) {
  statusBox = el("div", "status");
  main.append(statusBox);
  drawStatus();
  setInterval(drawStatus, 1000);
}

function append(entries, where) {
  const frag = document.createDocumentFragment();
  for (const e of entries) { const n = renderEntry(e); if (n) frag.append(n); }
  if (where === "top") { feed.prepend(frag); return; }
  feed.append(frag);
  // The newest entry drives the activity line, whatever its type.
  if (entries.length) { lastEntry = entries[entries.length - 1]; drawStatus(); }
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

  showMetrics(info.tokens);

  const hdr = el("div", "banner");
  // The driver only repeats itself when it stood in for an unknown platform.
  const line1 = [modelLabel(), RUN.driver === RUN.platform ? null : label(RUN.driver),
    "harness " + (RUN.harnessVersion || "?"), "character " + (RUN.character || "?")]
    .filter(Boolean).join(" · ");
  hdr.append(el("div", "", line1));
  const dur = RUN.startedAt ? fmtDur((RUN.endedAt || RUN.mtime || Date.now()) - RUN.startedAt) : "?";
  const when = el("div", "dim", "started " + fmtRel(RUN.startedAt) + " · " + dur + " · " + info.total + " entries");
  when.title = "started " + fmtTs(RUN.startedAt);
  hdr.append(when);
  const lvl = el("div", "");
  lvl.append(document.createTextNode("level " + num(RUN.level) + " · xp " + num(RUN.xp) + "  "));
  const sp = sparkline(info.states); if (sp) lvl.append(sp);
  hdr.append(lvl);
  main.append(hdr);
  breakoutBox = breakout(info.tokens, RUN);
  main.append(breakoutBox);

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

  const sel = el("select");
  for (const [value, label] of PRESET_LABELS) {
    const o = el("option", "", label); o.value = value;
    if (value === preset) o.selected = true;
    sel.append(o);
  }
  sel.onchange = () => applyPreset(sel.value);
  const selBox = el("label", ""); selBox.append(document.createTextNode("expand "), sel);

  const followBox = el("label", "");
  const cb = el("input"); cb.type = "checkbox"; cb.checked = true;
  cb.onchange = () => { follow = cb.checked; };
  followBox.append(cb, document.createTextNode(" auto-scroll"));
  $("#ctrl").textContent = ""; $("#ctrl").append(selBox, followBox);

  // A run that has already terminated will never grow: no point holding a stream open.
  if (RUN.terminationReason) return;

  // The activity line belongs to a run that is still going; it ends with the run.
  if (RUN.live) startStatus(main);

  es = new EventSource("/api/run/" + encodeURIComponent(runId) + "/stream");
  es.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.tokens) {
      showMetrics(msg.tokens);
      // A live run's money and quest count move; the newest state sample in
      // this batch is fresher than whatever the page loaded with.
      for (const e of (msg.entries || [])) {
        if (e.t !== "state") continue;
        if (typeof e.money === "number") RUN.money = e.money;
        if (typeof e.quests_completed === "number") RUN.questsCompleted = e.quests_completed;
        if (typeof e.questsCompleted === "number") RUN.questsCompleted = e.questsCompleted;
      }
      if (breakoutBox) {
        const next = breakout(msg.tokens, RUN);
        breakoutBox.replaceWith(next);
        breakoutBox = next;
      }
    }
    if (msg.entries && msg.entries.length) {
      append(msg.entries, "bottom");
      const end = msg.entries.find((e) => e.t === "termination");
      if (end) finish(main, end);
      if (follow) window.scrollTo(0, document.body.scrollHeight);
    }
  };
  // Never clobber the metrics: the disconnect notice gets its own slot.
  es.onerror = () => {
    if (!$("#ctrl").querySelector(".err"))
      $("#ctrl").append(el("span", "err", "stream disconnected"));
  };
}

/*
 * These pages moved under /legacy when the SPA took over "/" (ADR-0022), and
 * they are served at both paths meanwhile. Deriving the prefix from the URL is
 * what lets one document work at either, with no build step and no rewriting on
 * the way out.
 */
const BASE = location.pathname.startsWith("/legacy") ? "/legacy" : "";
for (const a of document.querySelectorAll("header a")) {
  const href = a.getAttribute("href");
  if (href && href.startsWith("/")) a.setAttribute("href", BASE + (href === "/" ? "/" : href));
}

const path = decodeURIComponent(location.pathname).slice(BASE.length);
if (path.startsWith("/run/")) renderRun(path.slice(5)).catch((e) => { $("#main").textContent = String(e); });
else renderIndex().catch((e) => { $("#main").textContent = String(e); });
</script>
</body>
</html>
`;
