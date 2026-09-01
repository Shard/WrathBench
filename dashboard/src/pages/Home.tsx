/**
 * The homepage: what WrathBench is, for someone who has never seen it.
 */

import { A } from "@solidjs/router";
import { For, Show, createSignal } from "solid-js";
import { api } from "../api/client";
import { LadderChart } from "../components/LadderChart";
import { ModelIcon } from "../components/ModelIcon";
import { HOME_EPISODE, homeLadderRuns } from "../lib/homeladder";
import { poll } from "../lib/poll";
import { STALE_MS, positionAgeMs, type FeedClock } from "../lib/mapview";
import { paretoRuns } from "../lib/pareto";
import { readBoolPref, writeBoolPref } from "../lib/prefs";
import { SDK_FAMILIES, paramNames, selectedTool } from "../lib/tools";
import { displayError } from "../lib/errors";
import { modelDisplay } from "../lib/format";

/** The tool list is harness text and changes only with a deploy; the strip follows the map's cadence. */
const TOOLS_POLL_MS = 300_000;
const LIVE_POLL_MS = 15_000;
const LADDER_POLL_MS = 30_000;
/** The homepage's one chart control, under its own key; free runs are always out here. */
const PARETO_KEY = "wb.home.pareto";

export default function Home() {
  const tools = poll(() => api.tools().then((r) => r.tools), TOOLS_POLL_MS);
  /*
   * The envelope's clock rides along with the positions, exactly as the map
   * carries it (`MapPage.tsx`): on the public build a reading is up to a
   * publish cadence old through nobody's fault, and a pulsing green dot over a
   * two-minute-old feed claims a liveness the page cannot see. Private builds
   * carry no envelope and a null clock, where the arithmetic is the plain one.
   */
  const live = poll(
    () =>
      api.positions().then((r) => ({
        positions: r.positions,
        clock: r.generatedAt === undefined ? null : { generatedAt: r.generatedAt, fetchedAt: Date.now() },
      })),
    LIVE_POLL_MS,
  );
  const positions = () => live.latest?.positions ?? [];
  /** True once the freshest reading on the strip is older than one publish cadence. */
  const positionsStale = (): boolean => {
    const list = positions();
    if (list.length === 0) return false;
    const clock: FeedClock | null = live.latest?.clock ?? null;
    const now = Date.now();
    return Math.min(...list.map((p) => positionAgeMs(p.ts, now, clock))) > STALE_MS;
  };
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
        <h2 class="home-title">An Agent Workbench for World of Warcraft</h2>
        <p>
          WrathBench evaluates AI agents on their ability to play World of Warcraft: Wrath of the Lich King
          through a TypeScript SDK on a private AzerothCore server. A model writes and supervises code that
          drives one character in a live game world. Watching an agent observe, decide and act over hours of
          play, leveling and questing its way out into the world, gives a direct read on its long-horizon
          planning, memory and problem solving.
        </p>
        <Show when={positions().length > 0}>
          <p class="home-live">
            <span class={positionsStale() ? "dot" : "dot live"} />
            {positions().length} character{positions().length === 1 ? "" : "s"} in the world
            {positionsStale() ? " (last seen a while ago)" : " now"}
            {" — "}
            <For each={positions().slice(0, 6)}>
              {(p, i) => (
                <>
                  <Show when={i() > 0}>, </Show>
                  <A href={`/run/${encodeURIComponent(p.runId)}`}>
                    <ModelIcon model={p.model ?? ""} />
                    <span title={p.model ?? ""}>{p.model === null ? "unknown" : modelDisplay(p.model)}</span>
                    <Show when={p.level !== null}> L{p.level}</Show>
                  </A>
                </>
              )}
            </For>
            <Show when={positions().length > 6}> and {positions().length - 6} more</Show>
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
              <h2 class="section home-ladder-title">the {HOME_EPISODE} ladder</h2> 90 minutes of play from a fresh level-1 character ·{" "}
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
            <div class="banner bad">{displayError(ladder.error)}</div>
          </Show>
          <Show when={ladder.latest !== undefined} fallback={<p class="dim loading-chart">loading…</p>}>
            <div class="wide-scroll">
              <LadderChart runs={ladderRuns()} episode={HOME_EPISODE} />
            </div>
          </Show>
        </div>
      </section>

      <div class="home-col">
      <h2 class="section">the loop</h2>
      <div class="wide-scroll">
        <LoopDiagram />
      </div>
      <p class="dim home-caption">
        Each turn the model sees a fixed state summary, the newest server events, any harness notices and its
        own scratchpad. It acts by running a snippet; the server answers with packets; those fold into the
        next turn's state. The scratchpad is the model's own notes, read and rewritten by it and handed back
        every turn; the episodic log is a one-line status the harness asks for before it trims older
        conversation, which the model can page through while reflecting at an inn.
      </p>

      <h2 class="section">what the agent can see and do</h2>
      <p class="dim">
        The harness gives the agent roughly what a player has: a client's view of the world, a
        client's actions, and its own notes.
      </p>
      <div class="home-surface">
        <div>
          <h3 class="home-surface-head">can</h3>
          <ul class="dim">
            <li>See what a game client sees: units in range, its quests, bags, spells, chat, position.</li>
            <li>Act through the handlers a client hits: move, fight, talk, loot, trade, train, fly, mail.</li>
            <li>Keep its own notes: a scratchpad it rewrites, and an episodic log it can read.</li>
            <li>Reflection mode, allowing agents resting at an inn or in a city to consider their next steps.</li>
            <li>Search a frozen 3.3.5a reference wiki; on scored episodes it gets names, never actual coordinates.</li>
          </ul>
        </div>
        <div>
          <h3 class="home-surface-head">can't</h3>
          <ul class="dim">
            <li>See what the server knows and a player cannot: loot tables, spawns, respawn timers.</li>
            <li>Teleport, run a GM command, or read the database. Only valid client opcodes are allowed.</li>
            <li>Be told a strategy. A failed call says what was expected and how to fix the call, never what to play next.</li>
            <li>Pause the world. The game is real time and ninety minutes is ninety realtime minutes.</li>
            <li>Use another character, another account, or any kind of networking outside the game.</li>
          </ul>
        </div>
      </div>

      <h2 class="section">the tools</h2>
      <p class="dim">
        Eight tools, identical for every model. Pick one to see the description the model is given, as served
        by the harness right now.
      </p>
      <Show when={tools.error !== undefined}>
        <div class="banner bad">{displayError(tools.error)}</div>
      </Show>
      <Show when={tools.latest !== undefined} fallback={<p class="dim">loading…</p>}>
        <div class="tool-inspector">
          <ul class="tool-list" role="tablist">
            {/* An empty tool list is a harness that served none, not a page that
                failed to draw one: say so where the tabs would have been. */}
            <Show when={tools.latest!.length === 0}>
              <li class="dim">the harness served no tools</li>
            </Show>
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
        tools.ts, reflect.ts): the model writes the scratchpad and the harness reads
        it back by injecting it into every turn's context; the log is appended by the
        model before a trim and paged back by the model while reflecting. No edge
        joins the two.

        The scratchpad edge is one-directional on purpose. There is no read
        tool — the notes are read by being injected into every turn's context,
        which is the edge already drawn along the left. (`read_scratchpad` was
        removed on 2026-08-30 for exactly that reason: it re-served text the
        turn already carried.)
      */}
      {box(100, 166, 120, "scratchpad", "notes, markdown")}
      {box(240, 166, 120, "episodic log", "append-only")}
      {/* Two parallel verticals off the model turn, one per memory — the scratchpad's is a write only; the read is the context edge hugging the left. */}
      <line x1="200" y1="92" x2="200" y2="164" class="loop-edge dashed" marker-end="url(#loop-head)" />
      <text x="194" y="132" text-anchor="end" class="loop-sub">write_scratchpad</text>
      <line x1="270" y1="92" x2="270" y2="164" class="loop-edge dashed" marker-start="url(#loop-head)" marker-end="url(#loop-head)" />
      <text x="278" y="126" class="loop-sub">log_status before a trim</text>
      <text x="278" y="137" class="loop-sub">read_log while reflecting, at an inn</text>
      <path d="M98,188 L70,188 L70,92" class="loop-edge dashed" fill="none" marker-end="url(#loop-head)" />
      <text x="66" y="200" text-anchor="end" class="loop-sub">read into every</text>
      <text x="66" y="211" text-anchor="end" class="loop-sub">turn's context</text>
    </svg>
  );
}
