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
import { STALE_MS } from "../lib/mapview";
import { runPageHref } from "../lib/mapstate";
import { positionAgeMs, type FeedClock } from "@wrathbench/inspector/views/feedclock";
import { readBoolPref, writeBoolPref } from "../lib/prefs";
import { SDK_FAMILIES, paramNames, selectedTool } from "../lib/tools";
import { displayError } from "../lib/errors";
import { modelDisplay } from "../lib/format";
import { InfoHint } from "../components/InfoHint";
import { useFeeds } from "../lib/feeds";
import { groupsOf } from "../lib/nav";

/** What the loop diagram is showing, one hover off its heading; per-harness detail lives here, not in the drawing. */
const LOOP_NOTE =
  "The model does not play move by move. It writes a small TypeScript program against the SDK, starts its routines and sleeps while they play in the live world. It is woken when a routine ends or fails, an action is refused for the first time, the character dies, the program asks for attention, or five minutes pass; it reads what changed, revises the code and sleeps again. Its scratchpad and a short status log carry it across a trimmed or compacted conversation, and the log can be read back at an inn or on a flight. The fixed loop and Claude Code sleep through a tool that waits for the wake; Codex sleeps at the end of its turn and gives GPT-6 models its own code mode.";

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
   * publish cadence old through nobody's fault, and the live mark over a
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
  // The ladder is the evals group's: absent with it, and not asked for until
  // `/api/info` has said the group is there.
  const feeds = useFeeds();
  const evals = (): boolean => feeds.info.latest !== undefined && groupsOf(feeds.info.latest).evals;

  return (
    <div class="page home">
      <div class="home-col">
      <section class="home-intro">
        <h1>An Agent Workbench for World of Warcraft</h1>
        <p>
          WrathBench evaluates AI agents on their ability to play World of Warcraft: Wrath of the Lich King
          through a TypeScript SDK on a private AzerothCore server. A model writes and supervises code that
          drives a character in a live game world. Watching an agent observe, decide and act over hours of
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
                  <A href={runPageHref(p.runId)}>
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

      <Show when={evals()}>
        <HomeLadder />
      </Show>

      <div class="home-col">
      <h2 class="section">
        the loop
        <InfoHint label="about this diagram" text={LOOP_NOTE} />
      </h2>
      <div class="wide-scroll">
        <LoopDiagram />
      </div>

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
            <li>Keep its own notes and code: a scratchpad it rewrites, a status log it can read back, and program files that survive a restart.</li>
            <li>Reflection mode, allowing agents at an inn, in a city or on a flight to consider their next steps.</li>
            <li>Search a frozen 3.3.5a reference wiki; on scored episodes it gets names, never actual coordinates.</li>
          </ul>
        </div>
        <div>
          <h3 class="home-surface-head">can't</h3>
          <ul class="dim">
            <li>See what the server knows and a player cannot: loot tables, spawns, respawn timers.</li>
            <li>Teleport, run a GM command, or read the database. Only valid client opcodes are allowed.</li>
            <li>Be told a strategy. A failed call says what was expected and how to fix the call, never what to play next.</li>
            <li>Pause the world. The game is real time, and the clock runs while the model thinks and while it sleeps.</li>
            <li>Use a character or account it was not given, or any kind of networking outside the game.</li>
          </ul>
        </div>
      </div>

      <h2 class="section">the tools</h2>
      <p class="dim">
        The same tools for every model on a harness. Pick one to see the description the model is given.
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
        Inside its program the model has <code>sdk</code>, <code>state</code> and <code>events</code>, a{" "}
        <code>memory</code> object that survives restarts, and <code>wake()</code> to ask for its own attention.
        Helpers cover what trajectories showed models needing; everything else goes through the raw actions and
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
      </div>
    </div>
  );
}

/**
 * The program loop, as inline SVG so it follows the theme through the same
 * custom properties as everything else. Drawn for a newcomer, not as a
 * schematic: the model writes and starts a program, the program plays against
 * the server while the model sleeps, and something happening wakes the model
 * (`runner/src/wake.ts`, docs/METHODOLOGY.md "The model sleeps until woken").
 * The two memories sit under the model, dashed: the scratchpad it rewrites and
 * the status log it writes before a trim or compaction and reads back at rest.
 * Which harness sleeps how is the hover note's, never a second drawing.
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
  const arrow = (x1: number, y1: number, x2: number, y2: number) => (
    <line x1={x1} y1={y1} x2={x2} y2={y2} class="loop-edge" marker-end="url(#loop-head)" />
  );
  return (
    <svg class="loop" viewBox="0 0 660 214" role="img" aria-label="The program loop: the model writes and starts a program; the program acts in the game world and hears back while the model sleeps; when something happens the model wakes, reads what changed and revises. Its notes and a status log sit beside it.">
      <defs>
        <marker id="loop-head" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M0,0 L8,4 L0,8 z" class="loop-head" />
        </marker>
      </defs>
      {/* The loop, left to right; the wake runs above the row so it never crosses the memories below. */}
      {box(10, 46, 140, "model", "reads, decides")}
      {box(260, 46, 140, "its program", "TypeScript routines")}
      {box(510, 46, 140, "game server", "the live world")}
      {arrow(150, 68, 258, 68)}
      <text x="204" y="62" text-anchor="middle" class="loop-sub">writes, starts</text>
      {/* The program and the world talk continuously, with or without the model awake. */}
      {arrow(400, 60, 508, 60)}
      <text x="454" y="55" text-anchor="middle" class="loop-sub">acts</text>
      {arrow(508, 78, 402, 78)}
      <text x="454" y="90" text-anchor="middle" class="loop-sub">events</text>
      <text x="330" y="106" text-anchor="middle" class="loop-sub">keeps playing while the model sleeps</text>
      {/* The wake: from the program, where most wakes start (a routine ends, fails, is refused or calls wake()), back to the model. */}
      <path d="M330,44 L330,24 L80,24 L80,44" class="loop-edge" fill="none" marker-end="url(#loop-head)" />
      <text x="205" y="19" text-anchor="middle" class="loop-sub">something happens: the model wakes and reads what changed</text>
      {/* The memories, under the model: both written and read by it. */}
      {box(10, 162, 140, "notes", "a scratchpad")}
      {box(170, 162, 140, "status log", "read back at rest")}
      <line x1="80" y1="92" x2="80" y2="160" class="loop-edge dashed" marker-start="url(#loop-head)" marker-end="url(#loop-head)" />
      <path d="M130,92 L130,132 L240,132 L240,160" class="loop-edge dashed" fill="none" marker-start="url(#loop-head)" marker-end="url(#loop-head)" />
    </svg>
  );
}

/** The e90 ladder, full-bleed; mounted only where the evals group is on. */
function HomeLadder() {
  // The e90 ladder, fixed: latest series present, free runs always out (`lib/homeladder.ts`);
  // the one control draws the Pareto front of cost against XP over the field
  // (`lib/pareto.ts`) — the same treatment as the ladder page's toggle, so the
  // words mean one thing on both. It used to filter to the front; the field
  // is the context that makes the front a claim, so it stays.
  const ladder = poll(() => api.ladder(HOME_EPISODE).then((r) => r.runs), LADDER_POLL_MS);
  const [pareto, setPareto] = createSignal(readBoolPref(PARETO_KEY, false));
  const ladderRuns = () => homeLadderRuns(ladder.latest ?? [], true);
  // Full-bleed: the one thing on the page that wants the whole width.
  return (
    <section class="home-bleed">
      <div class="home-bleed-inner">
        <div class="ladder-controls">
          <span class="dim">
            <h2 class="section home-ladder-title">the {HOME_EPISODE} ladder</h2> 90 minutes of play from a fresh level-1 character ·{" "}
            <A href={`/ladder?episode=${HOME_EPISODE}`}>full ladder</A>
          </span>
          <div class="ladder-filters">
          <label class="filter check" title="Draw the Pareto front: the entries no other entry beats on both axes, cheaper per run and more XP earned. Every point stays; the dominated ones are dimmed.">
            <input
              type="checkbox"
              checked={pareto()}
              onChange={(e) => {
                setPareto(e.currentTarget.checked);
                writeBoolPref(PARETO_KEY, e.currentTarget.checked);
              }}
            />
            <span>pareto front</span>
          </label>
          </div>
        </div>
        <Show when={ladder.error !== undefined}>
          <div class="banner bad">{displayError(ladder.error)}</div>
        </Show>
        <Show when={ladder.latest !== undefined} fallback={<p class="dim loading-chart">loading…</p>}>
          <div class="wide-scroll">
            {/* No "Not plotted: …" roll-call here: the
                landing page's first screen is worth more to a stranger than a
                list of the entries this chart could not place, and /ladder
                still gives that account in full. */}
            <LadderChart runs={ladderRuns()} episode={HOME_EPISODE} pareto={pareto()} omittedNote={false} />
          </div>
        </Show>
      </div>
    </section>
  );
}
