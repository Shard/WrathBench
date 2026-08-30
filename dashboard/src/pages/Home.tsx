/**
 * The homepage: what WrathBench is, for someone who has never seen it.
 *
 * Three things and nothing more (operator, 2026-08-30): one paragraph, the
 * execution loop as a diagram, and the model-facing tools as an inspector.
 * The tool text is served by `/api/tools` off the runner's own list, so what
 * this page shows is what a run is given — the page holds no tool strings of
 * its own. The SDK families under it are a shape, not a reference; the
 * generated SDK reference and the prompt stay the authority.
 *
 * The "live now" strip reads the positions feed the map already polls: how
 * many characters are in the world and who is driving them, nothing else.
 */

import { A } from "@solidjs/router";
import { For, Show, createSignal } from "solid-js";
import { api } from "../api/client";
import { LadderChart } from "../components/LadderChart";
import { ModelIcon } from "../components/ModelIcon";
import { HOME_EPISODE, homeLadderRuns } from "../lib/homeladder";
import { poll } from "../lib/poll";
import { paretoRuns } from "../lib/pareto";
import { readBoolPref, writeBoolPref } from "../lib/prefs";
import { SDK_FAMILIES, paramNames, selectedTool } from "../lib/tools";

/** The tool list is harness text and changes only with a deploy; the strip follows the map's cadence. */
const TOOLS_POLL_MS = 300_000;
const LIVE_POLL_MS = 15_000;
const LADDER_POLL_MS = 30_000;
/** The homepage's one chart control, under its own key; free runs are always out here. */
const PARETO_KEY = "wb.home.pareto";

export default function Home() {
  const tools = poll(() => api.tools().then((r) => r.tools), TOOLS_POLL_MS);
  const live = poll(() => api.positions().then((r) => r.positions), LIVE_POLL_MS);
  const [picked, setPicked] = createSignal<string | undefined>(undefined);
  const current = () => selectedTool(tools.latest ?? [], picked());
  // The e90 ladder, fixed: latest series present, free runs always out (`lib/homeladder.ts`);
  // the one control narrows to the Pareto front of cost against XP (`lib/pareto.ts`).
  const ladder = poll(() => api.ladder(HOME_EPISODE).then((r) => r.runs), LADDER_POLL_MS);
  const [pareto, setPareto] = createSignal(readBoolPref(PARETO_KEY, false));
  const ladderRuns = () => {
    const runs = homeLadderRuns(ladder.latest ?? [], true);
    return pareto() ? paretoRuns(runs) : runs;
  };

  return (
    <div class="page home">
      <div class="home-col">
      <section class="home-intro">
        <h2 class="home-title">A benchmark played in a live world</h2>
        <p>
          WrathBench evaluates AI agents on their ability to play World of Warcraft: Wrath of the Lich King
          through a TypeScript SDK on a private AzerothCore server. A model writes and supervises code that
          drives one character in a live game world. Watching an agent observe, decide and act over hours of
          play, leveling and questing its way out into the world, gives a direct read on its long-horizon
          planning, memory and problem solving.
        </p>
        <Show when={live.latest !== undefined && live.latest.length > 0}>
          <p class="home-live">
            <span class="dot live" />
            {live.latest!.length} character{live.latest!.length === 1 ? "" : "s"} in the world now
            {" — "}
            <For each={live.latest!.slice(0, 6)}>
              {(p, i) => (
                <>
                  <Show when={i() > 0}>, </Show>
                  <A href={`/run/${encodeURIComponent(p.runId)}`}>
                    <ModelIcon model={p.model ?? ""} />
                    {p.model ?? "unknown"}
                    <Show when={p.level !== null}> L{p.level}</Show>
                  </A>
                </>
              )}
            </For>
            <Show when={live.latest!.length > 6}> and {live.latest!.length - 6} more</Show>
            {" · "}
            <A href="/map">map</A>
          </p>
        </Show>
      </section>
      </div>

      {/* Full-bleed: the one thing on the page that wants the whole width. */}
      <section class="home-bleed">
        <div class="home-bleed-inner">
          <div class="ladder-controls">
            <span class="dim">
              <h2 class="section home-ladder-title">the {HOME_EPISODE} ladder</h2> latest harness series, paid models ·{" "}
              <A href={`/ladder?episode=${HOME_EPISODE}`}>full ladder</A>
            </span>
            <label class="filter check" title="Keep only the entries no other entry beats on both axes: cheaper per run and more XP earned.">
              <input
                type="checkbox"
                checked={pareto()}
                onChange={(e) => {
                  setPareto(e.currentTarget.checked);
                  writeBoolPref(PARETO_KEY, e.currentTarget.checked);
                }}
              />
              <span>Pareto front</span>
            </label>
          </div>
          <Show when={ladder.error !== undefined}>
            <div class="banner bad">{String(ladder.error)}</div>
          </Show>
          <Show when={ladder.latest !== undefined} fallback={<p class="dim">loading…</p>}>
            <LadderChart runs={ladderRuns()} episode={HOME_EPISODE} />
          </Show>
        </div>
      </section>

      <div class="home-col">
      <h2 class="section">the loop</h2>
      <LoopDiagram />
      <p class="dim home-caption">
        Each turn the model sees a fixed state summary, the newest server events, any harness notices and its
        own scratchpad. It acts by running a snippet; the server answers with packets; those fold into the
        next turn's state. The scratchpad is the model's own notes, read and rewritten by it and handed back
        every turn; the episodic log is a one-line status the harness asks for before it trims older
        conversation, which the model can page through while reflecting at an inn.
      </p>

      <h2 class="section">the tools</h2>
      <p class="dim">
        Nine tools, identical for every model. Pick one to see the description the model is given, as served
        by the harness right now.
      </p>
      <Show when={tools.error !== undefined}>
        <div class="banner bad">{String(tools.error)}</div>
      </Show>
      <Show when={tools.latest !== undefined} fallback={<p class="dim">loading…</p>}>
        <div class="tool-inspector">
          <ul class="tool-list" role="tablist">
            <For each={tools.latest!}>
              {(t) => (
                <li>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={current()?.name === t.name}
                    class={current()?.name === t.name ? "on" : ""}
                    onClick={() => setPicked(t.name)}
                  >
                    {t.name}
                  </button>
                </li>
              )}
            </For>
          </ul>
          <Show when={current()}>
            {(t) => (
              <div class="tool-detail" role="tabpanel">
                <div class="tool-sig mono">
                  {t().name}(
                  <For each={paramNames(t().inputSchema)}>
                    {(p, i) => (
                      <>
                        <Show when={i() > 0}>, </Show>
                        <span class={p.required ? "" : "dim"}>
                          {p.name}
                          {p.required ? "" : "?"}
                        </span>
                      </>
                    )}
                  </For>
                  )
                </div>
                <p class="tool-desc">{t().description}</p>
                <Show when={t().example}>
                  {(ex) => (
                    <>
                      <div class="k">example</div>
                      <pre class="block tool-example">{ex()}</pre>
                    </>
                  )}
                </Show>
                <Show when={t().returns}>
                  {(r) => (
                    <>
                      <div class="k">returns</div>
                      <p class="tool-desc dim">{r()}</p>
                    </>
                  )}
                </Show>
              </div>
            )}
          </Show>
        </div>
      </Show>

      <h2 class="section">the sdk</h2>
      <p class="dim">
        Inside a snippet the model has <code>sdk</code>, <code>state</code> and <code>events</code>. Helpers
        cover what trajectories showed models needing; everything else goes through the raw actions and
        packets a game client would use. In families:
      </p>
      <dl class="sdk-families">
        <For each={SDK_FAMILIES}>
          {(f) => (
            <>
              <dt>{f.name}</dt>
              <dd>
                <span class="mono">{f.members}</span>
                <span class="dim"> — {f.note}</span>
              </dd>
            </>
          )}
        </For>
      </dl>
      <p class="dim">
        How runs are grouped and scored is on the <A href="/about">about</A> page; what is running now is the{" "}
        <A href="/fleet">fleet</A>.
      </p>
      </div>
    </div>
  );
}

/**
 * The execution loop, as inline SVG so it follows the theme through the same
 * custom properties as everything else. Boxes are the loop; the scratchpad
 * and the log sit under it as the two memories, each edge a tool the model
 * calls (or, for the scratchpad, the context injection).
 */
function LoopDiagram() {
  const box = (x: number, y: number, w: number, label: string, sub?: string) => (
    <g>
      <rect x={x} y={y} width={w} height={44} rx={5} class="loop-box" />
      <text x={x + w / 2} y={y + (sub === undefined ? 27 : 20)} text-anchor="middle" class="loop-label">
        {label}
      </text>
      <Show when={sub !== undefined}>
        <text x={x + w / 2} y={y + 35} text-anchor="middle" class="loop-sub">
          {sub}
        </text>
      </Show>
    </g>
  );
  const arrow = (x1: number, y1: number, x2: number, y2: number, dashed = false) => (
    <line x1={x1} y1={y1} x2={x2} y2={y2} class={dashed ? "loop-edge dashed" : "loop-edge"} marker-end="url(#loop-head)" />
  );
  return (
    <svg class="loop" viewBox="-28 0 788 222" role="img" aria-label="The execution loop: context, model turn, run_snippet, server, events, back to context; scratchpad and episodic log beside it.">
      <defs>
        <marker id="loop-head" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M0,0 L8,4 L0,8 z" class="loop-head" />
        </marker>
      </defs>
      {/* The loop, left to right; the feedback edge runs above the row so it never crosses the memories below. */}
      {box(10, 46, 120, "context", "state, events, notes")}
      {box(170, 46, 120, "model turn")}
      {box(330, 46, 120, "run_snippet", "TypeScript")}
      {box(490, 46, 120, "game server", "AzerothCore")}
      {box(650, 46, 100, "events", "packets")}
      {arrow(130, 68, 168, 68)}
      {arrow(290, 68, 328, 68)}
      {arrow(450, 68, 488, 68)}
      {arrow(610, 68, 648, 68)}
      {/* Events fold back into the next turn's context. */}
      <path d="M700,44 L700,24 L70,24 L70,44" class="loop-edge" fill="none" marker-end="url(#loop-head)" />
      <text x="385" y="19" text-anchor="middle" class="loop-sub">next turn: the packets fold into cached state</text>
      {/*
        The two memories, as the harness actually uses them (runner/src/context.ts,
        tools.ts, reflect.ts): the scratchpad is read and rewritten by the model and
        is in every turn's context; the log is appended by the model before a trim
        and paged back by the model while reflecting. No edge joins the two.
      */}
      {box(100, 166, 120, "scratchpad", "notes, markdown")}
      {box(240, 166, 120, "episodic log", "append-only")}
      {/* Two parallel verticals off the model turn, one per memory; the context edge hugs the left. */}
      <line x1="200" y1="92" x2="200" y2="164" class="loop-edge dashed" marker-start="url(#loop-head)" marker-end="url(#loop-head)" />
      <text x="194" y="126" text-anchor="end" class="loop-sub">read_scratchpad</text>
      <text x="194" y="137" text-anchor="end" class="loop-sub">write_scratchpad</text>
      <line x1="270" y1="92" x2="270" y2="164" class="loop-edge dashed" marker-start="url(#loop-head)" marker-end="url(#loop-head)" />
      <text x="278" y="126" class="loop-sub">log_status before a trim</text>
      <text x="278" y="137" class="loop-sub">read_log while reflecting, at an inn</text>
      <path d="M98,188 L70,188 L70,92" class="loop-edge dashed" fill="none" marker-end="url(#loop-head)" />
      <text x="66" y="200" text-anchor="end" class="loop-sub">in every</text>
      <text x="66" y="211" text-anchor="end" class="loop-sub">turn's context</text>
    </svg>
  );
}
