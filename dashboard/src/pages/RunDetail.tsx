/**
 * One run, turn by turn.
 *
 * The feed is windowed: the last 200 entries load first and "load earlier"
 * walks backwards a window at a time, because a `request` entry embeds the
 * whole message array and an `events_served` entry every packet — the server
 * summarises them, but the count is still thousands on a long run. A live run
 * follows the same file over the viewer's SSE tail, which also heartbeats every
 * second so a quiet run can be told from a dead connection.
 *
 * Long blocks fold to a few lines with a click to expand, and the expand
 * preset over the feed ("minimal / responses / snippets / all", remembered in
 * localStorage) sets where they all start; a per-block click still overrides
 * it. State samples and harness notices get their own compact rows rather than
 * the generic JSON dump — see `lib/feedview.ts` for both.
 *
 * The public build is this page without the tail and without "load earlier":
 * the publisher renders one window per run — the same last-200 tail this page
 * loads first, projected and prose-redacted (docs/DATA-AND-LEGAL.md,
 * "Trajectory logs") — and a live run's window advances with the detail poll
 * instead of over SSE. A snapshot from before the window existed answers 404
 * for it, which the panel says plainly rather than failing the page.
 */

import { A, useLocation, useParams } from "@solidjs/router";
import {
  For,
  Show,
  createContext,
  createEffect,
  createMemo,
  createSignal,
  getOwner,
  on,
  onCleanup,
  onMount,
  runWithOwner,
  useContext,
} from "solid-js";
import { subscribeTail } from "../api/live";
import {
  api,
  ApiError,
  rawPath,
  SNAPSHOT_MODE,
  type ApiInfoResponse,
  type ComparabilityView,
  type EventsServedEntry,
  type FeedEntry,
  type ModelRowView,
  type RunDetailResponse,
  type TokenTotals,
  type WorkspaceFileView,
} from "../api/client";
import { HarnessTag } from "../components/HarnessTag";
import { ModelIcon } from "../components/ModelIcon";
import { XpChart } from "../components/XpChart";
import { CharacterPlot } from "../components/CharacterChart";
import { AttemptStrip, CharacterTotalsCard } from "../components/CharacterCards";
import { Coins, QuestCount } from "../components/CharacterFacts";
import { XpBar } from "../components/UnitFrame";
import { InventoryPanel } from "../components/Inventory";
import { characterSeriesLabel, stitchCharacter, type CharacterSeries } from "../lib/ladder";
import { fmtAge, fmtCost, fmtDuration, fmtElapsed, fmtItems, fmtLatency, fmtTokens, fmtToolCallBudget, fmtTps, fmtWhen, modelDisplay, resolvedLabel, shortHarness, shortRunId, stamp } from "../lib/format";
import { fileReading, isCode, openFile } from "../lib/workspace";
import { groupFeed, type CallGroup, type FeedGroup, type ResponseGroup, type TurnGroup } from "../lib/feedgroup";
import { groupTurn, isReflectTool, reflectingAt } from "../lib/reflect";
import { hasLineage, lineageIndex, type Lineage } from "@viewer/lineage";
import { modelsHref, rosterNameFor } from "../lib/models";
import { poll } from "../lib/poll";
import {
  EXPAND_LABELS,
  EXPAND_PRESETS,
  expandedBy,
  harnessFields,
  isHarnessEntry,
  noticeView,
  readExpandPref,
  splitNotices,
  stateLine,
  writeExpandPref,
  type ExpandPreset,
} from "../lib/feedview";
import { readBoolPref, writeBoolPref } from "../lib/prefs";
import { atBottom, sourceHint, sourceLabel } from "../lib/runview";
import { displayError, logError } from "../lib/errors";
import { statusOf, statusText, statusTitle } from "../lib/runs";

const WINDOW = 200;

/** How close to the bottom still counts as "following" (px). */
const FOLLOW_THRESHOLD = 32;

/**
 * The manual autoscroll preference, remembered across visits. Only the manual
 * toggle writes it; a scroll that turns follow off is a fact about this session
 * (the reader is looking at something) and must not become the saved default.
 */
const FOLLOW_KEY = "wrathbench.runview.follow";
function readFollowPref(): boolean {
  return readBoolPref(FOLLOW_KEY, true);
}
function writeFollowPref(keep: boolean): void {
  writeBoolPref(FOLLOW_KEY, keep);
}

/** Past this much silence a live run is more likely stopped than thinking. */
const SILENT_MS = 120_000;

/**
 * How often a live run's summary is re-fetched.
 *
 * The entry feed arrives over the tail's SSE stream, but the summary card does not:
 * playtime, level and money come from `/api/run/<id>`, and playtime for a live
 * run advances with the clock. Matched to the fleet listing's own 10s poll so
 * the two pages show the same number rather than one lagging the other.
 */
const DETAIL_POLL_MS = 10_000;

/**
 * "achievements: 12 (95 pts) · flights: 2", or "not recorded" for either half
 * the run has no records for. Null means the run wrote nothing of that kind,
 * which the page must not print as a zero (`AchievementFacts` / `TaxiFacts`).
 */
function achievementLine(d: RunDetailResponse | undefined): string {
  const ach = d?.achievements ?? null;
  const taxi = d?.taxi ?? null;
  const left = ach === null ? "achievements: not recorded" : `achievements: ${ach.earned} (${ach.points} pts)`;
  const right = taxi === null ? "flights: not recorded" : `flights: ${taxi.flights}`;
  return `${left} · ${right}`;
}

/**
 * The token card's speed line: how fast the model is producing, recently and
 * over the run. Recent first, for the reason the fleet column shows it: on a
 * live run the rate now is the question. "no reply yet" rather than a zero — a
 * run whose first request is still in flight has not been slow.
 */
function tpsLine(d: RunDetailResponse | undefined, source?: string): string {
  const tps = d?.tps ?? null;
  if (tps === null || tps.recent === null) return "tok/s: no reply measured yet";
  const line = `${fmtTps(tps.recent)} tok/s over the last ${tps.recentReplies} ${tps.recentReplies === 1 ? "reply" : "replies"} · ${fmtTps(tps.overall)} tok/s over all ${tps.replies}`;
  // The rate is the token total's per-reply arithmetic, so a total that
  // under-reads makes a rate that under-reads by the same factor.
  return source === "snapshot" ? `${line} · under-read` : line;
}

/**
 * How the token figure was arrived at. `snapshot` is its own answer, not a
 * flavour of "reported": the claude-code driver's per-response usage carries
 * the API's opening output count, so a run whose turns never emitted a
 * `claude_result` has a completion total that is provider-reported and known to
 * be far too low (~300× on the run with both halves). Saying so is the whole
 * point — an unrepaired figure must not read like a repaired one.
 */
export default function RunDetail() {
  const params = useParams<{ id: string }>();
  const location = useLocation();

  /* Which worldserver the viewer can see, for the footer. */
  const [info, setInfo] = createSignal<ApiInfoResponse | undefined>(undefined);
  const [detail, setDetail] = createSignal<RunDetailResponse | undefined>(undefined);
  const [entries, setEntries] = createSignal<FeedEntry[]>([]);
  const [from, setFrom] = createSignal(0);
  const [total, setTotal] = createSignal(0);
  /** Public build only: whether this run's snapshot carries an entries window at all. */
  const [feedPublished, setFeedPublished] = createSignal(true);
  const [tokens, setTokens] = createSignal<TokenTotals | undefined>(undefined);
  const [error, setError] = createSignal<string | undefined>(undefined);
  const [lastWrite, setLastWrite] = createSignal(Date.now());
  const [now, setNow] = createSignal(Date.now());
  const [follow, setFollow] = createSignal(readFollowPref());
  /*
   * Where every foldable block in the feed starts. Remembered, and it only
   * ever sets a default: each block keeps its own toggle, so a reader can open
   * one snippet under "minimal" and close one under "all" (see `FoldBlock`).
   */
  const [expand, setExpand] = createSignal<ExpandPreset>(readExpandPref());
  const chooseExpand = (v: ExpandPreset): void => {
    setExpand(v);
    writeExpandPref(v);
  };
  const [disconnected, setDisconnected] = createSignal(false);
  /*
   * Where this run sits in its freeplay character, or undefined for a run that has
   * none. The detail endpoint reads one run directory and so cannot see a
   * sibling; the listing can, and this page already talks to it nowhere else,
   * so the lineage is one fetch off `/api/results` rather than a field the
   * public projection would have to learn to carry.
   */
  const [lineage, setLineage] = createSignal<Lineage | undefined>(undefined);

  /*
   * The log column is the scroll container, not the window: with the two-column
   * layout the feed scrolls inside its own pane while the sidebar stays put.
   * `logEl` is that pane. Pinning to the bottom must happen after Solid commits
   * the new entry nodes, or `scrollHeight` is read stale and we land mid-list —
   * so it is done in an effect on `entries`, never inside the SSE callback.
   */
  let logEl: HTMLDivElement | undefined;
  const pinToBottom = (): void => {
    if (logEl !== undefined) logEl.scrollTop = logEl.scrollHeight;
  };
  /* A user scrolling up off the bottom turns follow off; scrolling back on. */
  const onLogScroll = (): void => {
    if (logEl === undefined) return;
    setFollow(atBottom(logEl.scrollTop, logEl.scrollHeight, logEl.clientHeight, FOLLOW_THRESHOLD));
  };
  /* The manual toggle: remembered, and it re-pins when switched back on. */
  const toggleFollow = (): void => {
    const next = !follow();
    setFollow(next);
    writeFollowPref(next);
    if (next) queueMicrotask(pinToBottom);
  };
  createEffect(on(entries, () => { if (follow()) pinToBottom(); }));
  /*
   * The roster, only so this run can link back to the model row that scheduled
   * it. A run records a model string and an effort, never a roster name, and
   * `(model, effort)` is the key the projection itself matches on. A failed
   * fetch simply leaves the name unlinked.
   */
  const [roster, setRoster] = createSignal<ModelRowView[]>([]);
  const rosterName = (run: RunDetailResponse["run"]): string | null =>
    rosterNameFor(roster(), run.model, run.comparability?.effort ?? null);

  const live = (): boolean => detail()?.run.terminationReason === null;

  /**
   * This run's character as one series for `CharacterPlot` — the same shape, the same
   * stitching (`stitchCharacter`) and the same axes the freeplay field is drawn
   * on, so a character's line does not change meaning between the two pages.
   *
   * Null when the run is not part of a character. A character that cannot be laid out
   * — a prior attempt with no active-time reading, or no level mark carrying
   * one — comes back with an empty series and the reason, which the plot prints
   * rather than drawing something wrong.
   */
  const characterPlot = createMemo(
    (): { series: CharacterSeries[]; omitted: { characterId: string; label: string; why: string }[] } | null => {
      const d = detail();
      const st = d?.character;
      if (d === undefined || st === undefined) return null;
      const model = d.run.model ?? "(unnamed)";
      // The line is named for the model, not the character;
      // the name rides along for the hover.
      const label = characterSeriesLabel(model, d.run.comparability?.effort ?? null);
      const last = st.runs[st.runs.length - 1];
      if (last === undefined) {
        return { series: [], omitted: [{ characterId: st.characterId, label, why: "no attempt served" }] };
      }
      const { points, endX, broke } = stitchCharacter(st.runs);
      const why = broke ?? (points.length === 0 ? "no level mark carries an active-time reading" : null);
      if (why !== null) return { series: [], omitted: [{ characterId: st.characterId, label, why }] };
      const end = points[points.length - 1]!;
      return {
        series: [
          {
            characterId: st.characterId,
            label,
            character: d.run.character,
            model,
            effort: d.run.comparability?.effort ?? null,
            // The character is doing whatever its newest attempt is doing.
            status: statusOf(last),
            attempts: st.attempts,
            latestRunId: last.runId,
            points,
            endX: Math.max(endX, end.x),
            endLevel: end.level,
            truncated: st.truncated,
          },
        ],
        omitted: [],
      };
    },
  );

  onMount(() => {
    const clock = setInterval(() => setNow(Date.now()), 1000);
    onCleanup(() => clearInterval(clock));

    /*
     * The tail is opened from an async continuation, so its cleanup cannot be
     * registered there: Solid tracks the owner through a synchronous global,
     * and an `onCleanup` called after the first await attaches to nothing. The
     * handle is registered now and filled in later. Leaking it would be worse
     * than a stray EventSource — the server clears that stream's 1 Hz rescan in
     * `cancel()`, which only fires when the client closes.
     */
    let stop: (() => void) | undefined;
    onCleanup(() => stop?.());
    // `poll()` (lib/poll.ts) registers its own `onCleanup`, which has the same
    // owner requirement as `stop` above; captured now so it can be started
    // from inside the async continuation below.
    const owner = getOwner();

    void api.info().then(setInfo).catch(() => undefined);
    void api
      .models()
      .then((m) => setRoster(m.models))
      .catch(() => undefined);

    void api
      .run(params.id)
      .then(async (d) => {
        setDetail(d);
        setTokens(d.tokens);
        /*
         * The character this run belongs to, when the server did not answer with
         * one. It does since 2026-09-05 (`character` on `/api/run/<id>`, which also
         * carries the whole chain's totals), and this fetch is the fallback for
         * a snapshot or a viewer built before that field existed: it recovers
         * the lineage LINE, not the totals, which cannot be derived here.
         *
         * Fetched once and never polled: a continuation is only ever launched
         * after its predecessor has ended, so a run being watched cannot gain a
         * successor while it is on screen. Only freeplay has lineage, and the
         * tier is read off the stamped comparability tuple — the run row carries
         * no episode of its own. `continuedFrom` is checked as well, because a
         * run whose metadata predates the stamp has no tuple and would
         * otherwise lose its line.
         */
        if (d.character === undefined && (d.run.continuedFrom !== null || d.run.comparability?.episode === "freeplay")) {
          void api
            .results("all", true, "all")
            .then((res) => {
              /*
               * This run, then everything else the listing served: a run the
               * listing does not hold (archived, or served by an older viewer)
               * still gets its own place in the walk rather than no line at all.
               * Stillborn launches drop out inside `lineageIndex`, so
               * "continued by" can never name a launch that produced nothing.
               */
              const others = res.runs.filter((r) => r.runId !== d.run.runId);
              setLineage(lineageIndex([{ ...d.run }, ...others]).get(d.run.runId));
            })
            .catch(() => undefined);
        }
        /*
         * The public build's window is one published artifact per run, and a
         * snapshot from before it existed answers 404. Caught here rather than
         * awaited bare: a rejection would take the summary, the charts and the
         * live poll down with it and report an unpublished feed as a page
         * error. The count still comes off the detail either way.
         */
        setTotal(d.total);
        const loadWindow = async (): Promise<void> => {
          const page = await api.entries(params.id, undefined, WINDOW);
          setEntries(page.entries);
          setFrom(page.from);
          setTotal(page.total);
        };
        if (SNAPSHOT_MODE) {
          try {
            await loadWindow();
            setFeedPublished(true);
          } catch {
            setFeedPublished(false);
          }
        } else {
          /*
           * Privately a failure here is an error and NOT an unpublished feed,
           * so it gets the banner rather than `feedPublished(false)`. Caught
           * all the same: awaited bare it would reject the whole load and take
           * the summary, the charts and the live poll down with the log.
           */
          try {
            await loadWindow();
          } catch (e: unknown) {
            logError("run entries", e);
            setError(displayError(e));
          }
        }
        if (d.run.terminationReason !== null) return;
        // A live run's summary keeps moving; a finished one is settled.
        runWithOwner(owner, () => {
          const detailPoll = poll(() => api.run(params.id), DETAIL_POLL_MS);
          createEffect(() => {
            const next = detailPoll.latest;
            if (next === undefined) return;
            setDetail(next);
            /*
             * In the public build the tail that advances the token card, the
             * entry count and the feed never opens, so the polled detail is
             * the only thing that moves them — the window is re-read on the
             * same tick, since a grown run publishes a new one under a new
             * version key. Without this they freeze at the first load while
             * the rest of the page keeps up.
             */
            if (SNAPSHOT_MODE) {
              setTokens(next.tokens);
              setTotal(next.total);
              if (feedPublished()) void loadWindow().catch(() => undefined);
            }
          });
        });
        // Only a live run needs the tail; a finished one never grows again.
        // The public build has no tail to open at all: a bucket of published
        // Static JSON serves no SSE stream, and an EventSource against it would be a
        // reconnect loop against a 404.
        if (SNAPSHOT_MODE) return;
        stop = subscribeTail(api.streamUrl(params.id), {
          onEntries: (added, tot) => {
            setEntries((prev) => [...prev, ...added]);
            setTotal((t) => t + added.length);
            if (tot !== undefined) setTokens(tot);
            setLastWrite(Date.now());
            setDisconnected(false);
            // The pin is driven by an effect on `entries` (see above), which
            // runs after the DOM commits — reading scrollHeight here is stale.
          },
          onTick: () => setDisconnected(false),
          onError: () => setDisconnected(true),
        });
      })
      .catch((e: unknown) => {
        logError("run detail", e);
        setError(displayError(e, { retries: false }));
      });
  });

  const loadEarlier = (): void => {
    // The public build renders no button for this (one window per run is all
    // the publisher makes), so the `Show` gate is the boundary.
    const start = Math.max(0, from() - WINDOW);
    if (start === from()) return;
    void api
      .entries(params.id, start, from() - start)
      .then((page) => {
        setEntries((prev) => [...page.entries, ...prev]);
        setFrom(page.from);
      })
      // A button press that fails silently reads as a button that does nothing.
      .catch((e: unknown) => {
        logError("run entries", e);
        setError(displayError(e, { retries: false }));
      });
  };

  /*
   * The composite view (lib/feedgroup.ts): a turn header per request, one
   * card per tool call, everything else as-is. Re-derived from the whole
   * window on every change — that is what lets a pair split by the live tail
   * or the window edge heal without pairing state — but fed its own previous
   * value so settled groups keep their object identity and `<For>` reuses
   * their DOM instead of rebuilding every row per tail append.
   */
  const groups = createMemo<FeedGroup[]>((prev) => groupFeed(entries(), prev), []);

  /**
   * A plain-language guess at what the session is doing, from the newest entry
   * alone: the loop writes a fixed cycle, so the type of the last thing written
   * says where in that cycle it is.
   */
  const activity = (): string => {
    const last = entries()[entries().length - 1];
    if (last === undefined) return "starting up";
    switch (last.t) {
      case "request":
        return "waiting on the model";
      case "response":
        return "reading the reply";
      case "snippet":
        return "running a snippet";
      case "snippet_result":
      case "tool_result":
        return "thinking about the result";
      case "events_served":
        return "next turn pending";
      default:
        return `after ${last.t}`;
    }
  };

  return (
    <div class="page runview">
      <Show when={error()}>
        <div class="banner bad">{error()}</div>
      </Show>
      <Show when={detail()} fallback={<p class="dim loading-page">loading…</p>}>
        {(d) => {
          const run = (): RunDetailResponse["run"] => d().run;
          /* Playtime is the API's: cumulative active time, paused stretches out. */
          const playtime = (): number | null => d().playtimeMs ?? null;
          return (
            <>
              <h1 class="section">
                {/*
                  The runs table is where a reader of this page came from — the
                  fleet is the ops view and is not even a nav item any more. The
                  crumb carries the sort and filters they arrived with, so it is
                  also the "back" the second link used to be.
                */}
                <A href={`/runs${location.search}`}>runs</A> /{" "}
                <span title={run().runId}>{shortRunId(run().runId)}</span>
                {/*
                  Every run belongs to a character, and a scored run's is a
                  chain of one, so this link is unconditional — the
                  page does not have to know whether it is looking at freeplay
                  to know where the character lives. The id is the chain root's
                  when there is a chain, and the run's own when there is not,
                  which is the same answer `characterViewOf` gives.
                */}
                {" · "}
                <A
                  href={`/character/${encodeURIComponent(d().character?.characterId ?? lineage()?.characterId ?? run().runId)}`}
                  title="this run's character, across every attempt"
                >
                  character
                </A>
              </h1>

              {/*
                The freeplay character this run is one attempt of, as the whole
                character: every attempt in order, this one marked, each a link.
                A reader landing on a12 wants a11 — and, landing on a11, wants
                to see that the character kept playing without having to guess
                a run id. The one-line version below is the fallback for a
                viewer or snapshot that answers no `character`.
              */}
              <Show when={d().character}>{(st) => <AttemptStrip character={st()} runId={run().runId} />}</Show>
              <Show when={d().character === undefined && hasLineage(lineage()) ? lineage() : undefined}>
                {(l) => (
                  <p class="dim" title="a durable freeplay character: one character, continued across attempts">
                    freeplay character{" "}
                    <A href={`/character/${encodeURIComponent(l().characterId)}`} title={l().characterId}>
                      {shortRunId(l().characterId)}
                    </A>{" "}
                    · attempt {l().attempt} of {l().attempts}
                    <Show when={l().previous}>
                      {(p) => (
                        <>
                          {" · continues "}
                          <A href={`/run/${encodeURIComponent(p())}`} title={p()}>
                            {shortRunId(p())}
                          </A>
                        </>
                      )}
                    </Show>
                    <Show when={l().next}>
                      {(n) => (
                        <>
                          {" · continued by "}
                          <A href={`/run/${encodeURIComponent(n())}`} title={n()}>
                            {shortRunId(n())}
                          </A>
                        </>
                      )}
                    </Show>
                  </p>
                )}
              </Show>

              {/*
                For a character, the character's whole climb comes first: level
                against cumulative active playtime, stitched across the
                attempts, the same line the freeplay field draws. The per-attempt
                XP chart stays below it — this session's shape is still worth
                seeing, it is just not the run.
              */}
              <Show when={characterPlot()}>
                {(plot) => (
                  <>
                    <h2 class="section">the character, across {d().character?.attempts} attempts</h2>
                    <CharacterPlot series={plot().series} omitted={plot().omitted} single />
                    <h2 class="section">this attempt</h2>
                  </>
                )}
              </Show>

              {/* Cumulative XP with level bands — full page width, above both columns. */}
              <XpChart
                states={d().states}
                startedAt={run().startedAt}
                endedAt={run().endedAt}
                episodeMs={run().comparability?.budget.episodeMs ?? null}
                now={now()}
              />

              <div class="runview-cols">
                {/* Left column: the feed is its own scroll container (autoscroll pins it). */}
                <div class="runview-logs" ref={logEl} onScroll={onLogScroll}>
                  <h2 class="section">
                    feed
                    <Show when={from() > 0 && !SNAPSHOT_MODE}>
                      {" "}
                      <button onClick={loadEarlier}>load earlier</button>
                    </Show>
                    <Show when={SNAPSHOT_MODE && from() > 0}>
                      {" "}
                      <span class="dim">last {WINDOW} of {total()}</span>
                    </Show>
                    <Show when={feedPublished()}>
                      <label class="filter expand-preset">
                        <span class="dim">expand</span>
                        <select
                          value={expand()}
                          onChange={(e) => chooseExpand(e.currentTarget.value as ExpandPreset)}
                        >
                          <For each={EXPAND_PRESETS}>
                            {(p) => <option value={p}>{EXPAND_LABELS[p]}</option>}
                          </For>
                        </select>
                      </label>
                    </Show>
                  </h2>
                  {/*
                    A statement about the snapshot, not a failure: a run
                    published before the entries window existed has none, so
                    nothing went wrong and nothing is worth retrying. Plainly
                    styled for the same reason.
                  */}
                  <Show
                    when={feedPublished()}
                    fallback={<p class="dim">No trajectory window is published for this run.</p>}
                  >
                    {/*
                      The run's own clock, for every row's stamp. `startedAt`
                      is the run row's, so a resumed run still counts from when
                      the character first drew breath rather than restarting at
                      zero — which is what the reader is comparing runs on. It
                      is wall time, not playtime: a run a rate limit paused for
                      six hours shows that gap here, and the sidebar's
                      `playtimeMs` is the figure that does not.
                    */}
                    <RunStart.Provider value={() => run().startedAt}>
                    <div class="feed">
                      {/*
                        A trajectory is one attempt's, so the feed cannot be
                        stitched — but the reader can walk. At the top of the
                        earliest window this attempt has (`from() === 0`, so the
                        link stands where the log actually begins, not above a
                        window with more of this run above it) the previous
                        attempt is one click away, and the next one is at the
                        bottom.
                      */}
                      <Show when={from() === 0 ? d().character : undefined}>
                        {(st) => (
                          <Show when={st().previous}>
                            {(prev) => (
                              <p class="dim feed-seam">
                                ← earlier:{" "}
                                <A href={`/run/${encodeURIComponent(prev())}`} title={prev()}>
                                  attempt {st().attempt - 1} of {st().attempts}
                                </A>{" "}
                                — this attempt's log begins here.
                              </p>
                            )}
                          </Show>
                        )}
                      </Show>
                      {/* A run with no loaded entries — the window is empty, or
                          the fetch failed — says so where the feed would be. */}
                      <Show when={groups().length === 0}>
                        <p class="dim">Nothing in this window of the trajectory.</p>
                      </Show>
                      <For each={groups()}>
                        {(g) => {
                          /*
                           * The accent is asked of the run's windows, not of the
                           * loaded entries: the `open` that starts a window can
                           * sit far above whatever slice the feed has, and a
                           * turn is either inside a window or it is not.
                           */
                          const rf = (): boolean => reflectingAt(d().reflections, groupTurn(g));
                          switch (g.kind) {
                            case "turn":
                              return <TurnRow g={g} runId={run().runId} reflecting={rf()} />;
                            case "response":
                              return <ResponseRow g={g} runId={run().runId} preset={expand()} reflecting={rf()} />;
                            case "call":
                              return <CallCard g={g} runId={run().runId} preset={expand()} reflecting={rf()} />;
                            default:
                              // The two records with a shape worth drawing rather
                              // than dumping; everything else is still generic.
                              if (g.entry.t === "state") {
                                return <StateRow entry={g.entry} runId={run().runId} preset={expand()} />;
                              }
                              if (isHarnessEntry(g.entry)) {
                                return <NoticeRow entry={g.entry} runId={run().runId} preset={expand()} />;
                              }
                              return <Entry entry={g.entry} runId={run().runId} preset={expand()} />;
                          }
                        }}
                      </For>
                      {/*
                        The other end of the seam: this attempt stopped, and the
                        character kept playing somewhere else. Only for an
                        attempt that has ENDED — a live one's feed has more
                        coming, and a "continues in" under it would be wrong.
                      */}
                      <Show when={run().terminationReason !== null ? d().character : undefined}>
                        {(st) => (
                          <Show when={st().next}>
                            {(next) => (
                              <p class="dim feed-seam">
                                this attempt ends here — continues in{" "}
                                <A href={`/run/${encodeURIComponent(next())}`} title={next()}>
                                  attempt {st().attempt + 1} of {st().attempts}
                                </A>{" "}
                                →
                              </p>
                            )}
                          </Show>
                        )}
                      </Show>
                    </div>
                    </RunStart.Provider>
                  </Show>
                </div>

                {/* Right column: controls and everything about the run, always in view. */}
                <aside class="runview-side">
                  {/*
                    The controls row heads the sidebar whether the run is live or
                    over, because the way into this run's replay belongs with the
                    other controls rather than buried in a section heading — which
                    is where it used to sit, under "comparability", where nobody
                    looks for navigation. The map has the return leg (`open run →`).
                  */}
                  <div class="side-controls">
                    <A class="btn" href={`/map?run=${encodeURIComponent(run().runId)}`}>
                      replay on map
                    </A>
                    <Show when={live()}>
                      {/* Manual toggle; it reflects and overrides the scroll-driven auto state. */}
                      <button class={follow() ? "on" : ""} onClick={toggleFollow}>
                        auto-scroll
                      </button>
                      <Show when={run().terminationReason === null}>
                        <span class={now() - lastWrite() > SILENT_MS ? "warn" : "dim"}>
                          {/* Stops pulsing once the run has gone quiet: a live dot
                              over "no activity for a while" contradicts itself. */}
                          <span class={now() - lastWrite() > SILENT_MS ? "dot" : "dot live"} />
                          {now() - lastWrite() > SILENT_MS
                            ? "no activity for a while — the run may have stopped"
                            : activity()}{" "}
                          · {fmtAge(now() - lastWrite())}
                          <Show when={disconnected()}> · <span class="err">feed disconnected</span></Show>
                        </span>
                      </Show>
                    </Show>
                  </div>

                  {/*
                    For a character, the character's totals are the headline and
                    this session's are the footnote — the whole complaint was a
                    page that answered "how many quests" with one attempt's
                    tally. The cards below keep the run's own figures, under a
                    heading that says which they are.
                  */}
                  <Show when={d().character}>
                    {(st) => (
                      <>
                        <h2 class="section">the character · {st().attempts} attempts</h2>
                        <CharacterTotalsCard character={st()} />
                        <h2 class="section">this attempt</h2>
                      </>
                    )}
                  </Show>

                  <div class="cards">
                    <div class="card">
                      <div class="k">model</div>
                      <div class="v">
                        <ModelIcon model={run().model} />
                        {/* The roster row this run's model belongs to, when it is on the roster:
                            a run records a model string, never the name that scheduled it. */}
                        <Show when={run().model} fallback="—">
                          {(full) => (
                            <span title={full()}>
                              <Show when={rosterName(run())} fallback={modelDisplay(full())}>
                                {(name) => <A href={modelsHref(name())}>{modelDisplay(full())}</A>}
                              </Show>
                            </span>
                          )}
                        </Show>
                      </div>
                      <div class="sub">
                        {run().platform ?? "—"} · {shortHarness(run().harnessVersion)}
                      </div>
                      {/* The id the provider actually served, plus the CLI that
                          drove it: `sonnet` is a roster alias the Claude Code CLI
                          resolves at launch, and this is where the run says to what. */}
                      <Show when={resolvedLabel(run().model, run().resolvedModel) ?? run().cliVersion}>
                        <div class="sub">
                          <Show when={resolvedLabel(run().model, run().resolvedModel)}>
                            {(id) => <span title={id()}>served as {modelDisplay(id())}</span>}
                          </Show>
                          <Show when={run().cliVersion}>
                            {(v) => (
                              <>
                                <Show when={resolvedLabel(run().model, run().resolvedModel)}> · </Show>
                                cli {v()}
                              </>
                            )}
                          </Show>
                        </div>
                      </Show>
                    </div>
                    <div class="card">
                      <div class="k">character</div>
                      <div class="v">
                        {run().character ?? "—"}
                        {/* Race and class: the baseline is Human Paladin; the extras cycle varies it. */}
                        <Show when={run().characterLabel !== null}>
                          <span class="dim"> · {run().characterLabel}</span>
                        </Show>
                      </div>
                      {/*
                        Progress toward the next ding lives here since the
                        level/xp card was retired: the XP chart above plots
                        CUMULATIVE xp with the levels as bands, which is a
                        different number, and this progress is on no other
                        surface of this page. It is the frame's own bar
                        (`XpBar`), not a second one — and the money and the
                        quest count are drawn beside it rather than spelled out.
                      */}
                      <div class="sub charline">
                        <XpBar level={run().level} xp={run().xp} />
                        <Coins copper={run().money} />
                        <QuestCount count={run().questsCompleted} />
                      </div>
                      {/*
                        Newest recorded inventory. Icons and tooltips
                        come from Wowhead in the reader's browser; we serve no
                        item art. A run that recorded no
                        inventory at all still says so in words, which is what
                        `fmtItems` answers for null.
                      */}
                      <Show when={run().items} fallback={<div class="sub">carrying: {fmtItems(run().items, false)}</div>}>
                        {(items) => <InventoryPanel items={items()} />}
                      </Show>
                      {/*
                        Achievements and flights from this run's milestone records.
                        "not recorded" is not zero: a run from before the taps wrote
                        neither kind of record, and nothing here guesses a number for
                        it. Points are a displayed signal only — no ranking reads them.
                      */}
                      <div class="sub">{achievementLine(detail())}</div>
                    </div>
                    <div class="card">
                      <div class="k">context / total tokens</div>
                      <div class="v mono">
                        {fmtTokens(tokens()?.contextTokens ?? null)} / {fmtTokens(tokens()?.totalTokens ?? null)}
                      </div>
                      <div class="sub" title={sourceHint(tokens()?.source)}>
                        {sourceLabel(tokens()?.source)} · {tokens()?.turns ?? 0} turns
                      </div>
                      {/*
                        Speed, in the same unit the tokens above are counted in.
                        The clock is the model's own replies — what it was
                        waiting on, to the last record of the reply — never the
                        run's elapsed time, most of which the harness spends
                        driving the game.
                      */}
                      <div class="sub" title="output tokens ÷ wall time of model replies (the wait it answered, plus the reply)">
                        {tpsLine(detail(), tokens()?.source)}
                      </div>
                    </div>
                    <div class="card">
                      <div class="k">playtime</div>
                      <div class="v mono">{fmtDuration(playtime())}</div>
                      <div class="sub" title={stamp(run().startedAt)}>
                        {total()} entries
                      </div>
                    </div>
                    <div class="card">
                      <div class="k">tokens in / out</div>
                      <div class="v mono">
                        {fmtTokens(tokens()?.promptTokens ?? null)} / {fmtTokens(tokens()?.completionTokens ?? null)}
                      </div>
                      <div class="sub">
                        cache r/w {fmtTokens(tokens()?.cacheReadTokens ?? null)} /{" "}
                        {fmtTokens(tokens()?.cacheWriteTokens ?? null)}
                      </div>
                    </div>
                    {/*
                      * Cost sits with the token cards because it is the same
                      * measurement read in another unit — and it is shown twice
                      * because two different questions hide behind one number.
                      * ACTUAL is what the provider charged (OpenRouter's per-call
                      * `usage.cost`, or the Claude SDK's `total_cost_usd`); most
                      * runs have none and say so rather than borrowing the
                      * estimate. EXPECTED is this repo's price table applied to the
                      * tokens above, dated, so a stale rate reads as stale.
                      */}
                    <div class="card">
                      <div class="k">cost — actual</div>
                      <div class="v mono" title={detail()?.cost.actual.note ?? ""}>
                        {fmtCost(detail()?.cost.actual, "—")}
                      </div>
                      <div class="sub" title={detail()?.cost.actual.note ?? ""}>
                        {detail()?.cost.actual.basis === "none"
                          ? "provider reports no cost for this run"
                          : detail()?.cost.actual.asIfMetered
                            ? "the driver's own total_cost_usd, billed to a subscription"
                            : "the provider's own charge, summed over the run"}
                      </div>
                    </div>
                    <div class="card">
                      <div class="k">cost — expected</div>
                      <div class="v mono" title={detail()?.cost.expected.note ?? ""}>
                        {fmtCost(detail()?.cost.expected)}
                      </div>
                      <div class="sub" title={detail()?.cost.expected.note ?? ""}>
                        {detail()?.cost.expected.basis === "none"
                          ? (detail()?.cost.expected.note ?? "")
                          : `from the token totals at ${detail()?.cost.expected.priceId ?? "list"} prices, ${detail()?.cost.expected.asOf ?? "undated"}`}
                      </div>
                    </div>
                  </div>

                  <h2 class="section">milestones</h2>
                  <Milestones detail={detail()} />

                  <h2 class="section">comparability</h2>
                  <Tuple run={run()} />

                  <Show when={run().terminationReason !== null}>
                    <div class="banner bad">
                      <strong>{run().terminationReason}</strong>
                      <Show when={run().terminationDetail}> — {run().terminationDetail}</Show>
                    </div>
                  </Show>
                  <Show when={run().terminationReason === null && run().pauseReason !== null}>
                    {/*
                      The status cell's own words: "paused", "paused: <reason>",
                      or "stalled" (`statusText`, which also keeps the public
                      token from reading "paused: paused").
                    */}
                    <div class="banner warn" title={statusTitle(statusOf(run()))}>
                      {statusText(run())}
                    </div>
                  </Show>

                  <h2 class="section">workspace</h2>
                  <WorkspacePanel runId={run().runId} live={live()} />

                  <ServerFooter info={info()} run={run()} />
                </aside>
              </div>
            </>
          );
        }}
      </Show>
    </div>
  );
}

/**
 * The run's workspace (runner/src/workspace.ts): the model's own files as a
 * list to pick from, and the picked one whole — notes.md open first. The same
 * inspector the homepage's tool list is, so it reads as one kind of surface,
 * with a module in the inspector's code style and everything else as text.
 *
 * A live run's list is re-read on the summary's cadence, and the open file
 * only when the list says it changed (`fileReading`). A 404 — a run with no
 * workspace, or a snapshot that published none — is a statement, not an
 * error, and is shown where the panel would be; the rest of the page never
 * waits on any of this.
 */
function WorkspacePanel(props: { runId: string; live: boolean }) {
  const [files, setFiles] = createSignal<WorkspaceFileView[] | undefined>(undefined);
  const [absent, setAbsent] = createSignal(false);
  const [error, setError] = createSignal<string | undefined>(undefined);
  const [picked, setPicked] = createSignal<string | undefined>(undefined);
  /** The open file's text as last read; kept on screen while a newer reading of the same file loads. */
  const [shown, setShown] = createSignal<{ path: string; text: string } | undefined>(undefined);

  const loadList = (): void => {
    void api.workspace(props.runId).then(
      (w) => {
        // A 404 earlier is not final: a public tab open across a publisher
        // deploy meets rows with no workspace pointer until the next pass.
        setAbsent(false);
        setFiles(w.files);
        setError(undefined);
      },
      (e: unknown) => {
        if (e instanceof ApiError && e.status === 404) {
          setAbsent(true);
          return;
        }
        logError("run workspace", e);
        setError(displayError(e));
      },
    );
  };
  onMount(() => {
    loadList();
    if (!props.live) return;
    // One more read after the run ends, for the files it left, then stop.
    const timer = setInterval(() => {
      loadList();
      if (!props.live) clearInterval(timer);
    }, DETAIL_POLL_MS);
    onCleanup(() => clearInterval(timer));
  });

  const open = createMemo(() => {
    const list = files();
    return list === undefined ? undefined : openFile(list, picked());
  });
  const reading = createMemo(() => {
    const f = open();
    return f === undefined ? undefined : fileReading(f);
  });
  createEffect(
    on(reading, (r) => {
      const f = open();
      if (r === undefined || f === undefined) return;
      void api.workspaceFile(props.runId, f.path).then(
        // A slower answer for a file the reader has already left is dropped.
        (text) => {
          if (reading() === r) setShown({ path: f.path, text });
        },
        (e: unknown) => {
          logError("run workspace file", e);
          setError(displayError(e));
        },
      );
    }),
  );

  return (
    <Show when={!absent()} fallback={<p class="dim">no workspace</p>}>
      <Show when={error()}>
        <div class="banner bad">{error()}</div>
      </Show>
      <Show when={files()} fallback={<p class="dim">loading…</p>}>
        {(list) => (
          <div class="tool-inspector">
            <ul class="tool-list" role="tablist">
              <For each={list()}>
                {(f) => (
                  <li>
                    <button
                      type="button"
                      role="tab"
                      aria-selected={open()?.path === f.path}
                      class={open()?.path === f.path ? "on" : ""}
                      title={f.firstLine === "" ? `${f.bytes} bytes` : `${f.bytes} bytes — ${f.firstLine}`}
                      onClick={() => setPicked(f.path)}
                    >
                      {f.path}
                    </button>
                  </li>
                )}
              </For>
            </ul>
            <Show when={open()}>
              {(f) => (
                <div class="tool-detail" role="tabpanel">
                  <div class="tool-sig" title={`${f().bytes} bytes · ${stamp(f().mtime)}`}>
                    {f().path} <span class="dim">· {fmtWhen(f().mtime)}</span>
                  </div>
                  <Show when={shown()?.path === f().path ? shown() : undefined} fallback={<p class="dim">loading…</p>}>
                    {(s) => <pre class={isCode(f().path) ? "block tool-example" : "block"}>{s().text}</pre>}
                  </Show>
                </div>
              )}
            </Show>
          </div>
        )}
      </Show>
    </Show>
  );
}

/**
 * The worldserver this run actually drove against, when known.
 *
 * A run stamped with its own `comparability.serverBuild` states that as fact —
 * it is what `/health` reported at this run's own launch or resume, not a
 * live reading. Only a run that predates the field falls back to the hedged
 * "worldserver now" reading off the viewer's own live `/health` poll, which is
 * not necessarily the build this run drove.
 */
function ServerFooter(props: { info: ApiInfoResponse | undefined; run: RunDetailResponse["run"] }) {
  const ran = (): ComparabilityView["serverBuild"] => props.run.comparability?.serverBuild ?? null;
  return (
    <footer class="identity">
      <Show
        when={ran()}
        fallback={
          <Show
            when={props.info?.worldserver}
            fallback={<>the game server this run drove was not recorded</>}
          >
            {(w) => (
              <>
                worldserver now: <span class="mono">{w().build}</span>, up since{" "}
                {stamp(w().startedAtMs)} — not necessarily the build this run drove (this run
                predates per-run server identity)
              </>
            )}
          </Show>
        }
      >
        {(b) => (
          <>
            worldserver: <span class="mono">{b().build}</span>, up since {stamp(b().startedAtMs)}
          </>
        )}
      </Show>
    </footer>
  );
}

/**
 * What the run's milestone records account for: deaths, level
 * marks, spells learned, talent points spent, trades completed.
 *
 * Counts and turn numbers, nothing else. Every one of these is a *lower bound*
 * — the producers sample the world on a timer — and every one distinguishes
 * "not recorded" (null, or a viewer that does not answer the field) from zero,
 * so a run from before a producer shipped says so instead of claiming the
 * character never died, never learned and never traded.
 */
function Milestones(props: { detail: RunDetailResponse | undefined }) {
  const d = (): RunDetailResponse | undefined => props.detail;
  /** Up to six turn indices off a list of marks; "" when none carried one. */
  const turns = (marks: readonly { turn: number | null }[]): string => {
    const ts = marks.map((m) => m.turn).filter((t): t is number => t !== null);
    if (ts.length === 0) return "";
    const head = ts.slice(0, 6).join(", ");
    return ` · turn ${head}${ts.length > 6 ? ` +${ts.length - 6}` : ""}`;
  };
  const NOT_RECORDED = "not recorded";
  return (
    <dl class="tuple">
      <dt>deaths</dt>
      <dd class="mono">
        <Show when={d()?.deaths} fallback={NOT_RECORDED}>
          {(f) => (
            <>
              {f().deaths} · releases {f().releases} · resurrects {f().resurrects}
              {turns(f().sites)}
            </>
          )}
        </Show>
      </dd>
      <dt>levels</dt>
      <dd class="mono">
        <Show when={d()?.leveling} fallback={NOT_RECORDED}>
          {(f) => (
            <>
              {f().levelUps} up · {f().startLevel} → {f().maxLevel}
              {turns(f().marks.filter((m) => m.from !== null))}
            </>
          )}
        </Show>
      </dd>
      <dt>spells learned</dt>
      <dd class="mono">
        <Show when={d()?.spells} fallback={NOT_RECORDED}>
          {(f) => (
            <>
              {f().learned} · {f().atLogin} at login{turns(f().marks)}
            </>
          )}
        </Show>
      </dd>
      <dt>talents spent</dt>
      <dd class="mono">
        <Show when={d()?.talents} fallback={NOT_RECORDED}>
          {(f) => (
            <>
              {f().spends} point{f().spends === 1 ? "" : "s"} · {f().talents} talent
              {f().talents === 1 ? "" : "s"}
              {turns(f().marks)}
            </>
          )}
        </Show>
      </dd>
      <dt>trades</dt>
      <dd class="mono">
        <Show when={d()?.trades} fallback={NOT_RECORDED}>
          {(f) => (
            <>
              {f().trades}
              {turns(f().marks)}
            </>
          )}
        </Show>
      </dd>
    </dl>
  );
}

/**
 * The comparability tuple: everything that has to match before this run may be
 * charted beside another.
 *
 * A run whose metadata predates the stamp says "not recorded" and stops there.
 * Nothing is recomputed from today's harness — a prompt hash taken against the
 * current prompt would assert a comparability that was never established.
 */
function Tuple(props: { run: RunDetailResponse["run"] }) {
  const c = (): ComparabilityView | null => props.run.comparability;
  const ms = (v: number | null): string => (v === null ? "disabled" : fmtDuration(v));
  return (
    <Show
      when={c()}
      fallback={
        <p class="dim">
          Not recorded — this run predates the comparability stamp. Its harness version is{" "}
          {shortHarness(props.run.harnessVersion)}; nothing else about what it was given can be
          established after the fact.
        </p>
      }
    >
      {(t) => (
        <dl class="tuple">
          <dt>run id</dt>
          <dd class="mono">{props.run.runId}</dd>
          <dt>harness version</dt>
          <dd class="mono">{t().harnessVersion}</dd>
          <dt>prompt</dt>
          <dd class="mono">
            {t().promptHash} · {t().promptChars} chars
          </dd>
          <dt>harness</dt>
          <dd>
            <HarnessTag harness={t().harness} />
          </dd>
          <dt>effort</dt>
          <dd>{t().effort ?? "not sent (provider default)"}</dd>
          <dt>episode budget</dt>
          <dd class="mono">
            {t().budget.maxTurns === null ? "unlimited turns" : `${t().budget.maxTurns} turns`} ·{" "}
            {fmtToolCallBudget(t().budget.maxToolCalls)} · idle {ms(t().budget.idleMs)} · no-xp{" "}
            {ms(t().budget.noXpMs)} · episode {ms(t().budget.episodeMs)}
          </dd>
          <dt>wiki reference</dt>
          <dd>
            {t().wiki === false
              ? "withheld: no search_reference tool, and the prompt does not name it"
              : t().wikiCoords === undefined
                ? "not recorded for older runs"
                : t().wikiCoords
                  ? "coordinates served"
                  : "names-first, coordinates withheld"}
          </dd>
          <dt>server build</dt>
          <dd class="mono">
            {t().serverBuild === null
              ? "not recorded (module unreachable at launch)"
              : `${t().serverBuild!.build} · up since ${stamp(t().serverBuild!.startedAtMs)}`}
          </dd>
          <dt>scoring</dt>
          <dd class={t().objective || props.run.shakeout !== null ? "warn" : "ok"}>
            {props.run.shakeout !== null
              ? props.run.shakeout
              : t().objective
                ? "unscored (human-set objective)"
                : "scorable"}
          </dd>
        </dl>
      )}
    </Show>
  );
}

/** The one-line summary of an events batch, shared by plain rows and turn headers. */
function eventsHead(e: EventsServedEntry): string {
  const more = (e.moreOpcodes ?? 0) > 0 ? ` +${e.moreOpcodes} kinds` : "";
  return `${e.count ?? 0} events · ${(e.opcodes ?? []).join(" ")}${more}`;
}

/**
 * The text an entry type puts in its body and head. Only types that still
 * reach the plain `Entry` renderer belong here — stray events batches,
 * meta/terminations/watchdogs, and whatever record kind ships next. Requests,
 * responses and tool calls are always routed to the composite rows
 * (lib/feedgroup.ts); `state` and `notice` have their own rows below. All of
 * them reach `detailOf` for the expanded long form, which is why the field
 * drop lives there.
 */
function bodyOf(e: FeedEntry): { text: string; head: string } {
  if (e.t === "events_served") return { text: "", head: eventsHead(e as EventsServedEntry) };
  // Everything else renders as the summary the server built, minus the
  // bookkeeping fields.
  return { text: detailOf(e), head: "" };
}

/**
 * The whole summary an entry carries, minus the bookkeeping the head already
 * shows. The compact rows below expand to exactly this, so a field the one-line
 * form does not name is still one click away rather than gone.
 */
function detailOf(e: FeedEntry): string {
  const { i, t, ts, start, end, clipped, ...rest } = e as Record<string, unknown>;
  void i;
  void t;
  void ts;
  void start;
  void end;
  void clipped;
  return JSON.stringify(rest, null, 1);
}

const FOLD_LINES = 3;

/**
 * A foldable pre block — the body treatment every card shares.
 *
 * `defaultOpen` is the whole-feed preset's say (lib/feedview.ts) and `over` is
 * this reader's, which wins while it is set. Changing the preset clears the
 * override, so the choice at the top of the feed always means what it says —
 * without it, a block clicked once would ignore every later preset change and
 * the control would look broken on exactly the rows someone had touched.
 */
function FoldBlock(props: { text: string; defaultOpen?: boolean }) {
  const [over, setOver] = createSignal<boolean | null>(null);
  createEffect(on(() => props.defaultOpen, () => setOver(null), { defer: true }));
  const open = (): boolean => over() ?? props.defaultOpen === true;
  const setOpen = (v: boolean): void => void setOver(v);
  // Counted without splitting: bodies run to many KB and the array of line
  // substrings would be built only to read its length.
  const lines = createMemo(() => {
    let n = 1;
    for (let at = props.text.indexOf("\n"); at !== -1; at = props.text.indexOf("\n", at + 1)) n++;
    return n;
  });
  const foldable = (): boolean => lines() > FOLD_LINES;
  return (
    <>
      <pre class={`block ${foldable() && !open() ? "fold" : ""}`}>{props.text}</pre>
      <Show when={foldable()}>
        <button class="toggle" onClick={() => setOpen(!open())}>
          {open() ? "collapse" : `expand · ${lines()} lines`}
        </button>
      </Show>
    </>
  );
}

/**
 * The raw-line link for one constituent of a composite row.
 *
 * Nothing in the public build: raw trajectory lines are never published, so
 * the link would be a 404 into the bucket. One guard here rather than at the
 * ten call sites, which is also why they can stay written as they are.
 */
function RawLink(props: { runId: string; i: number; label?: string }) {
  if (SNAPSHOT_MODE) return null;
  return (
    <a href={rawPath(props.runId, props.i)} target="_blank" rel="noreferrer">
      {props.label ?? "raw"}
    </a>
  );
}

/**
 * One formatter for every row's clock cell: `toLocaleTimeString` builds a
 * fresh `Intl.DateTimeFormat` per call, and this cell is on every row.
 * Still used for the hover title, and for a run whose start is unknown.
 */
const TIME_FMT = new Intl.DateTimeFormat(undefined, {
  hour: "numeric",
  minute: "2-digit",
  second: "2-digit",
});

/**
 * When the run began, for the feed's per-row clock.
 *
 * A context rather than a prop threaded through six row components: every row
 * asks the same question of the same run, and the value changes only when the
 * page swaps runs. Null is a run row with no `startedAt` — the cell falls back
 * to the wall clock rather than counting from the epoch.
 */
const RunStart = createContext<() => number | null>(() => null);

/**
 * The timestamp cell every head row ends with: how far into the run this
 * happened, with the absolute time on hover. Elapsed rather than wall clock
 * because "03:41:22" is not a question anyone reading a trajectory has, and
 * because it is the figure that reads the same across two runs compared side
 * by side (`fmtElapsed`).
 */
function When(props: { ts: number }) {
  const start = useContext(RunStart);
  const from = (): number | null => start();
  return (
    <span title={stamp(props.ts)}>
      {from() === null ? TIME_FMT.format(props.ts) : fmtElapsed(props.ts - from()!)}
    </span>
  );
}

function Entry(props: { entry: FeedEntry; runId: string; preset: ExpandPreset }) {
  const parts = createMemo(() => bodyOf(props.entry));
  return (
    <div class="entry">
      <div class="head">
        <span class="t">{props.entry.t}</span>
        <Show when={props.entry.turn !== undefined}>
          <span>turn {props.entry.turn}</span>
        </Show>
        <span>{parts().head}</span>
        <span class="spacer" />
        <When ts={props.entry.ts} />
        <Show when={props.entry.clipped === true}>
          <RawLink runId={props.runId} i={props.entry.i} />
        </Show>
      </div>
      <Show when={parts().text.length > 0}>
        <div class="body">
          <FoldBlock text={parts().text} defaultOpen={expandedBy(props.preset, "detail")} />
        </div>
      </Show>
    </div>
  );
}

/**
 * One turn's header: the request and the context events that were packed
 * inside it, as a single head-only line. Everything in a `request` body is
 * text the reader has already scrolled past (the whole re-sent history), so
 * the row carries only the counts — the full messages stay one click away
 * behind the raw links.
 */
function TurnRow(props: { g: TurnGroup; runId: string; reflecting: boolean }) {
  const req = (): TurnGroup["request"] => props.g.request;
  return (
    <div class={`entry ${props.reflecting ? "reflecting" : ""}`}>
      <div class="head">
        <span class="t">turn {req().turn ?? "?"}</span>
        {/* The turn header is where the window is named; the rows under it
            carry the border alone, or the word would repeat down the feed. */}
        <Show when={props.reflecting}>
          <span class="reflect-tag">Zz reflecting</span>
        </Show>
        <span>
          {req().messageCount ?? "?"} msgs · {fmtTokens(req().promptChars ?? null)} chars
        </span>
        <Show when={props.g.events}>{(ev) => <span>{eventsHead(ev())}</span>}</Show>
        <span class="spacer" />
        <When ts={req().ts} />
        <Show when={props.g.events?.clipped === true}>
          <RawLink runId={props.runId} i={props.g.events!.i} label="raw events" />
        </Show>
        <Show when={req().clipped === true}>
          <RawLink runId={props.runId} i={req().i} label="raw request" />
        </Show>
      </div>
    </div>
  );
}

/** The model's reply, with how long the model took to produce it. */
function ResponseRow(props: { g: ResponseGroup; runId: string; preset: ExpandPreset; reflecting: boolean }) {
  const e = (): ResponseGroup["entry"] => props.g.entry;
  return (
    <div class={`entry ${props.reflecting ? "reflecting" : ""}`}>
      <div class="head">
        <span class="t">response</span>
        <Show when={e().turn !== undefined}>
          <span>turn {e().turn}</span>
        </Show>
        <Show when={props.g.latencyMs !== null}>
          <span class="lat">{fmtLatency(props.g.latencyMs)}</span>
        </Show>
        <span>{(e().tools ?? []).join(", ")}</span>
        <span class="spacer" />
        <When ts={e().ts} />
        <Show when={e().clipped === true}>
          <RawLink runId={props.runId} i={e().i} />
        </Show>
      </div>
      <Show when={(e().text ?? "").length > 0}>
        <div class="body">
          <FoldBlock text={e().text ?? ""} defaultOpen={expandedBy(props.preset, "response")} />
        </div>
      </Show>
    </div>
  );
}

/**
 * One tool call as one card: the input on top, the result under a dashed rule.
 * For run_snippet the input is the snippet's code and the call's args are not
 * shown — they are the same code again, which is exactly the duplication this
 * card exists to remove. The duration is `result.ts − call.ts` and only shown
 * when the writer recorded the call before running it (see lib/feedgroup.ts).
 */
function CallCard(props: { g: CallGroup; runId: string; preset: ExpandPreset; reflecting: boolean }) {
  const g = (): CallGroup => props.g;
  /** The input text: the snippet's code, else the call's args. */
  const input = createMemo((): string => {
    const snip = g().snippet;
    if (snip !== null) return snip.code ?? "";
    const args = g().call?.args;
    if (args === undefined) return "";
    return typeof args === "string" ? args : JSON.stringify(args);
  });
  const name = (): string =>
    g().call?.name ?? g().result?.name ?? (g().snippet !== null ? "run_snippet" : "?");
  const turn = (): number | undefined => (g().call ?? g().snippet ?? g().result)?.turn;
  const anyTs = (): number => g().call?.ts ?? g().snippet?.ts ?? g().result?.ts ?? 0;
  return (
    <div class={`entry ${g().result?.isError === true ? "bad" : ""} ${props.reflecting ? "reflecting" : ""}`}>
      <div class="head">
        <span class="t">{name()}</span>
        {/* The surface's own three tools, named where a reader will look for
            them: they are why a window exists, and they read as ordinary tool
            calls otherwise. Independent of the accent — a `reflect` that was
            refused opens no window and is still one of these. */}
        <Show when={isReflectTool(name())}>
          <span class="reflect-tag">reflection</span>
        </Show>
        <Show when={turn() !== undefined}>
          <span>turn {turn()}</span>
        </Show>
        <Show when={g().call?.call !== undefined}>
          <span>call {g().call!.call}</span>
        </Show>
        <Show when={g().durationMs !== null}>
          <span class="lat">{fmtLatency(g().durationMs)}</span>
        </Show>
        <span class="spacer" />
        <When ts={anyTs()} />
        <Show when={g().call?.clipped === true}>
          <RawLink runId={props.runId} i={g().call!.i} label="raw call" />
        </Show>
        <Show when={g().snippet?.clipped === true}>
          <RawLink runId={props.runId} i={g().snippet!.i} label="raw code" />
        </Show>
        <Show when={g().result?.clipped === true}>
          <RawLink runId={props.runId} i={g().result!.i} label="raw result" />
        </Show>
      </div>
      <Show when={input().length > 0}>
        <div class="body">
          <FoldBlock text={input()} defaultOpen={expandedBy(props.preset, "call")} />
        </div>
      </Show>
      <Show
        when={g().result}
        fallback={
          // A live tail that has the call but not yet the result — or a run
          // that died mid-call and never wrote one.
          <div class="body pending">no result yet</div>
        }
      >
        {(r) => {
          /*
           * The harness's own lines are lifted out of the result text and drawn
           * as a callout: they are the harness talking to the model, not the
           * tool's output, and inside a folded console dump they were invisible
           * to a reader looking for exactly them (lib/feedview.ts).
           */
          const split = createMemo(() => splitNotices(r().text ?? ""));
          return (
            <>
              <Show when={split().body.length > 0}>
                <div class="body">
                  <FoldBlock text={split().body} defaultOpen={expandedBy(props.preset, "call")} />
                </div>
              </Show>
              <Show when={split().notices.length > 0}>
                <div class="body notices">
                  <NoticeCallout lines={split().notices} />
                </div>
              </Show>
            </>
          );
        }}
      </Show>
    </div>
  );
}

/**
 * The harness speaking to the model, as a callout rather than a footnote.
 *
 * One line per deduped (action, status) group, exactly as the harness wrote
 * it — `moveTo too_far ×21: a single moveTo covers ~250y — …`. Nothing is
 * reformatted: the count and the wording are what the model was handed, and a
 * page that rephrased them would be showing something the run did not contain.
 * Always open: there are at most a handful of lines, and a notice nobody
 * expands is a notice nobody reads.
 */
function NoticeCallout(props: { lines: string[] }) {
  return (
    <div class="notice-callout">
      <span class="notice-tag">harness</span>
      <div class="notice-lines">
        <For each={props.lines}>{(l) => <div class="notice-line">{l}</div>}</For>
      </div>
    </div>
  );
}

/**
 * A `harness` record: the harness's own voice in the feed.
 *
 * One type carries two things (see `lib/feedview.ts`). A record with text is
 * addressed to the model — a sandbox restart, a truncated turn — and gets the
 * callout. A record without is bookkeeping the run needed to state, and gets
 * one quiet line with its fields behind the same toggle every other row uses:
 * shouting `resolved_model` on every run would train the reader to skip
 * exactly the rows this treatment exists for.
 *
 * Read defensively throughout, so a writer landing with fields this build does
 * not know about renders with its full record one click away, never as an error.
 */
function NoticeRow(props: { entry: FeedEntry; runId: string; preset: ExpandPreset }) {
  const n = createMemo(() => noticeView(props.entry));
  return (
    <div class="entry harness" classList={{ notice: !n().bookkeeping }}>
      <div class="head">
        <span class="t">harness</span>
        <span classList={{ "notice-kind": !n().bookkeeping, dim: n().bookkeeping }}>{n().kind}</span>
        <Show when={n().count !== null}>
          <span class="dim">×{n().count}</span>
        </Show>
        <Show when={props.entry.turn !== undefined}>
          <span class="dim">turn {props.entry.turn}</span>
        </Show>
        {/* Bookkeeping says its whole content on the head line. */}
        <Show when={n().bookkeeping}>
          <span class="state-line mono">{harnessFields(props.entry)}</span>
        </Show>
        <span class="spacer" />
        <When ts={props.entry.ts} />
        <Show when={props.entry.clipped === true}>
          <RawLink runId={props.runId} i={props.entry.i} />
        </Show>
      </div>
      <Show when={!n().bookkeeping}>
        <div class="body notices">
          <NoticeCallout lines={n().text.split("\n")} />
        </div>
        {/*
          The rest of the record, and only when there is one: a notice whose
          whole content is its text would otherwise print that text twice.
        */}
        <Show when={harnessFields(props.entry).length > 0}>
          <div class="body">
            <FoldBlock text={detailOf(props.entry)} defaultOpen={expandedBy(props.preset, "detail")} />
          </div>
        </Show>
      </Show>
    </div>
  );
}

/**
 * One state sample as one line, with the full record behind a toggle.
 *
 * The ticker writes one every few seconds, so these are the most numerous rows
 * in a long feed and the least worth reading in full: what the reader wants
 * scanning past them is the shape of the run — the level climbing, the zone
 * changing, the money moving. `stateLine` is that line (lib/feedview.ts); the
 * JSON is unchanged underneath, and under the "all" preset it starts open.
 */
function StateRow(props: { entry: FeedEntry; runId: string; preset: ExpandPreset }) {
  const line = createMemo(() => stateLine(props.entry));
  const [open, setOpen] = createSignal<boolean | null>(null);
  createEffect(on(() => props.preset, () => setOpen(null), { defer: true }));
  const shown = (): boolean => open() ?? expandedBy(props.preset, "detail");
  return (
    <div class="entry state">
      <div class="head">
        <span class="t">state</span>
        <Show when={props.entry.turn !== undefined}>
          <span class="dim">turn {props.entry.turn}</span>
        </Show>
        <span class="state-line mono">{line()}</span>
        <span class="spacer" />
        <button class="toggle" onClick={() => setOpen(!shown())}>
          {shown() ? "less" : "detail"}
        </button>
        <When ts={props.entry.ts} />
        <Show when={props.entry.clipped === true}>
          <RawLink runId={props.runId} i={props.entry.i} />
        </Show>
      </div>
      <Show when={shown()}>
        <div class="body">
          <pre class="block">{detailOf(props.entry)}</pre>
        </div>
      </Show>
    </div>
  );
}
