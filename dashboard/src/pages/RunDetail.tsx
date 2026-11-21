/**
 * One run, turn by turn.
 *
 * The feed is windowed: the last `ENTRIES_WINDOW` entries (a thousand,
 * `@viewer/public-keys`) load first and "load earlier"
 * walks backwards a window at a time, because a `request` entry embeds the
 * whole message array and an `events_served` entry every packet — the server
 * summarises them, but the count is still thousands on a long run. A live run
 * follows the same file over the viewer's SSE tail, which also heartbeats every
 * second so a quiet run can be told from a dead connection.
 *
 * One time is in focus on the page, the timeline's at the bottom of the
 * viewport (`components/Timeline.tsx`, `lib/timelinestore.ts`), and the feed,
 * the camera's video and the XP chart's cursor all show it. The feed follows
 * it and leads it: a seek scrolls the feed to that moment, loading the window
 * that holds it when this one does not, and the reader's own scroll moves the
 * focus to the row in view. While the focus is the newest moment (the live
 * edge of a run still going) the feed stays pinned to its newest entry, which
 * is all the old auto-scroll toggle did; scrolling up or seeking back lets go,
 * and the bar's live button takes hold again. The focus rides in `?t=`, so a
 * link to the map's replay and back keeps the place.
 *
 * The feed is two tiers: decisions as cards, and the actions between two of
 * them folded to one line of counts that opens (`lib/feedtier.ts` for which is
 * which, `components/FeedRows.tsx` for the rows). Long blocks fold to a few
 * lines with a click to expand, and the expand preset over the feed ("minimal
 * / responses / snippets / all", remembered in localStorage) sets where every
 * fold starts; a per-block click still overrides it.
 *
 * The public build is this page without the tail and without "load earlier":
 * the publisher renders one window per run — the same tail this page loads
 * first, projected and prose-redacted (docs/DATA-AND-LEGAL.md,
 * "Trajectory logs") — and a live run's window advances with the detail poll
 * instead of over SSE. A snapshot from before the window existed answers 404
 * for it, which the panel says plainly rather than failing the page.
 */

import { A, useLocation, useParams, useSearchParams } from "@solidjs/router";
import {
  For,
  Show,
  batch,
  createEffect,
  createMemo,
  createSignal,
  getOwner,
  on,
  onCleanup,
  onMount,
  runWithOwner,
} from "solid-js";
import { subscribeTail } from "../api/live";
import {
  api,
  ApiError,
  SNAPSHOT_MODE,
  type ApiInfoResponse,
  type ClipsResponse,
  type ComparabilityView,
  type FeedEntry,
  type RunDetailResponse,
  type TokenTotals,
} from "../api/client";
import { HarnessTag } from "../components/HarnessTag";
import { ModelIcon } from "../components/ModelIcon";
import { XpChart } from "../components/XpChart";
import { ChartCard } from "../components/ChartCard";
import { CharacterPlot } from "../components/CharacterChart";
import { AttemptStrip, CharacterTotalsPanel } from "../components/CharacterCards";
import { CostCard, runCostReading } from "../components/CostCard";
import { InfoHint } from "../components/InfoHint";
import { Coins, QuestCount } from "../components/CharacterFacts";
import { InventoryPanel, XpBar, createInspectorClient } from "@wrathbench/inspector/views";
import { FanoutCharacters } from "../components/FanoutCharacters";
import { ScratchpadPanel } from "../components/Scratchpad";
import { ChaptersPanel, LiveFrame, RunVideo } from "../components/Replay";
import { Timeline } from "../components/Timeline";
import { createTimeline } from "../lib/timelinestore";
import { createScrollGuard, createUrlSync, feedPlan, parseT, rowAt, rowInView, withT, type FeedWindow, type Span } from "../lib/timeline";
import { runMarks, startLevelOf } from "@viewer/timeline-marks";
import { activeMsUntil } from "@viewer/sessions";
import { characterSeriesLabel, stitchCharacter, type CharacterSeries } from "../lib/ladder";
import { fmtAge, fmtDuration, fmtItems, fmtTokens, fmtToolCallBudget, fmtTps, modelDisplay, resolvedLabel, shortHarness, shortRunId, stamp } from "../lib/format";
import { useFeeds } from "../lib/feeds";
import { groupFeed, type FeedGroup } from "../lib/feedgroup";
import type { Surface } from "../lib/feedtier";
import { moveVerdicts, sameVerdicts } from "../lib/actionlog";
import { FeedList, MoveVerdicts, RunStart } from "../components/FeedRows";
import { hasLineage, lineageIndex, type Lineage } from "@viewer/lineage";
import { ENTRIES_WINDOW } from "@viewer/public-keys";
import { modelsHref } from "../lib/models";
import { groupsOf, linkable } from "../lib/nav";
import { poll } from "../lib/poll";
import {
  EXPAND_LABELS,
  EXPAND_PRESETS,
  readExpandPref,
  writeExpandPref,
  type ExpandPreset,
} from "../lib/feedview";
import { atBottom, chartClock, chartWindowMs, contextHint, hasModelSide, runChartInput, showsComparability, sourceHint, sourceLabel } from "../lib/runview";
import { displayError, logError } from "../lib/errors";
import { statusOf, statusText, statusTitle } from "../lib/runs";
import { partyHref, partyReplayHref } from "../lib/party";

const WINDOW = ENTRIES_WINDOW;

/** How close to the bottom of the feed still counts as its newest entry (px). */
const FOLLOW_THRESHOLD = 32;

/** How long the focus rests before it is written to `?t=`: a scrub or playback is one entry's worth of writes, not forty. */
const URL_SETTLE_MS = 400;
/** How long a seek outside the loaded window rests before the window is asked for: a drag across a day asks once. */
const LOAD_SETTLE_MS = 150;

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
 * The token card's speed, short: the recent rate, the question on a live run
 * (the fleet column shows it for the same reason). "no reply yet" rather than
 * a zero — a run whose first request is still in flight has not been slow.
 */
function tpsShort(d: RunDetailResponse | undefined): string {
  const tps = d?.tps ?? null;
  if (tps === null || tps.recent === null) return "no reply yet";
  return `${fmtTps(tps.recent)} tok/s`;
}

/**
 * Behind the token card's info hint: how the tokens were counted, and the
 * speed in full — recent and over the run. The clock is the model's own
 * replies (what it was waiting on, to the last record of the reply), never the
 * run's elapsed time, most of which the harness spends driving the game.
 */
function tokenHint(d: RunDetailResponse | undefined, source?: string): string {
  const tps = d?.tps ?? null;
  const speed =
    tps === null || tps.recent === null
      ? "tok/s: no reply measured yet"
      : `${fmtTps(tps.recent)} tok/s over the last ${tps.recentReplies} ${tps.recentReplies === 1 ? "reply" : "replies"} · ${fmtTps(tps.overall)} tok/s over all ${tps.replies}`;
  // The rate is the token total's per-reply arithmetic, so a total that
  // under-reads makes a rate that under-reads by the same factor.
  return `${sourceLabel(source)}: ${sourceHint(source)}\n\n${speed}\n(output tokens ÷ wall time of model replies: the wait it answered, plus the reply)`;
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
  // The models table is the runner group's: the model is named, not linked, where that group is off.
  const feeds = useFeeds();

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
   * The run's scratchpad, or null for a run that has none (yet). A string, so
   * a re-read that brings back the same pad changes nothing on the page. Read
   * once with the detail and again on each detail change of a live run: every
   * poll tick privately, and publicly each new version of the run, whose
   * listing row then names the new pad. Its absence is never an error and its
   * failure never a banner — the pad is one panel, not the page.
   */
  const [pad, setPad] = createSignal<string | null>(null);
  /*
   * The camera's video, or null for a run that has none: read with the pad
   * and on the same changes, since the sweep assembles it after the fact.
   * Compared by content, so a re-read that brings the same body back leaves
   * the player alone.
   */
  const [clips, setClips] = createSignal<ClipsResponse | null>(null, {
    equals: (a, b) => JSON.stringify(a) === JSON.stringify(b),
  });

  /*
   * The inspector's API (`/api/inspector`, the viewer's private mount), for a
   * fan-out run's characters. The public build has no such mount and draws none.
   */
  const inspector = SNAPSHOT_MODE ? null : createInspectorClient("/api/inspector");
  const loadClips = (): void => {
    void api
      .clips(params.id)
      .then(setClips)
      .catch((e: unknown) => {
        if (e instanceof ApiError && e.status === 404) setClips(null);
        else logError("run clips", e);
      });
  };
  const loadPad = (): void => {
    void api
      .scratchpad(params.id)
      .then((p) => setPad(p.text))
      .catch((e: unknown) => {
        if (e instanceof ApiError && e.status === 404) setPad(null);
        else logError("run scratchpad", e);
      });
  };

  const live = (): boolean => detail()?.run.terminationReason === null;

  /*
   * The focused time (`lib/timelinestore.ts`). The bar covers the run from
   * its start to its newest moment: this browser's clock while a private run
   * is live, since the tail keeps the page that current, and the newest thing
   * a snapshot holds publicly, where "now" is minutes ahead of the data.
   */
  let newestSeen = 0;
  const span = createMemo<Span | null>(
    () => {
      const d = detail();
      if (d === undefined) return null;
      const list = entries();
      // The newest thing seen so far, not the newest in the window held: the bar must not shorten when the feed jumps back.
      newestSeen = Math.max(newestSeen, list[list.length - 1]?.ts ?? 0, d.states[d.states.length - 1]?.ts ?? 0);
      const seen = newestSeen;
      const start = d.run.startedAt ?? list[0]?.ts ?? d.states[0]?.ts ?? null;
      if (start === null) return null;
      const end = live() ? (SNAPSHOT_MODE ? seen : Math.max(now(), seen)) : Math.max(d.run.endedAt ?? 0, seen);
      return { from: start, to: Math.max(start, end) };
    },
    null,
    { equals: (x, y) => x?.from === y?.from && x?.to === y?.to },
  );
  /** The stretches the run was paused for, which playback hurries through. */
  const pauses = createMemo<Span[]>(() => {
    const s = detail()?.sessions ?? [];
    const out: Span[] = [];
    for (let i = 1; i < s.length; i++) {
      const end = s[i - 1]!.end;
      if (end !== null && s[i]!.start > end) out.push({ from: end, to: s[i]!.start });
    }
    return out;
  });
  const tl = createTimeline({ span, live, idle: pauses });
  /* The camera's video, while it plays: the bar's play button is then its pause. */
  const [videoOn, setVideoOn] = createSignal(false);
  let video: { pause(): void } | undefined;
  const marks = createMemo(() => {
    const d = detail();
    return d === undefined ? [] : runMarks({ leveling: d.leveling, states: d.states, deaths: d.deaths, bosses: d.bosses });
  });

  /*
   * `?t=` (`lib/timeline.ts`): a link opens at its time, the focus is written
   * back once it rests, and a `t` that is not this page's own write (back,
   * forward, a pasted link) is a seek.
   */
  const [search, setSearch] = useSearchParams();
  const urlSync = createUrlSync(search.t);
  const opensAt = parseT(search.t);
  if (opensAt !== null) tl.seek(opensAt, "url");
  let urlTimer: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => clearTimeout(urlTimer));
  createEffect(
    on(
      tl.focus,
      () => {
        clearTimeout(urlTimer);
        urlTimer = setTimeout(() => {
          // A time the URL gave is already there.
          if (tl.origin() === "url") return;
          const t = urlSync.toUrl(tl.focus());
          if (t !== undefined) setSearch({ t: t ?? undefined }, { replace: true });
        }, URL_SETTLE_MS);
      },
      { defer: true },
    ),
  );
  createEffect(
    on(
      () => search.t,
      (raw) => {
        const t = urlSync.fromUrl(raw);
        if (t === undefined) return;
        if (t === "none") tl.goLive("url");
        else tl.seek(t, "url");
      },
      { defer: true },
    ),
  );
  /** The runs table's own parameters, without this page's: what the crumb goes back with. */
  const listSearch = (): string => {
    const q = new URLSearchParams(location.search);
    q.delete("t");
    const text = q.toString();
    return text === "" ? "" : `?${text}`;
  };

  /*
   * The log column is the scroll container, not the window: with the two-column
   * layout the feed scrolls inside its own pane while the sidebar stays put.
   * `logEl` is that pane. Every scroll the page makes itself is marked on the
   * guard first, so the scroll handler can tell it from the reader's
   * (`createScrollGuard`). Scrolling must happen after Solid commits the new
   * entry nodes, or `scrollHeight` is read stale and we land mid-list, so it
   * is done in an effect on `entries`, never inside the SSE callback.
   */
  let logEl: HTMLDivElement | undefined;
  const guard = createScrollGuard();
  const rowEls = (): HTMLElement[] => (logEl === undefined ? [] : [...logEl.querySelectorAll<HTMLElement>(".feed > .entry[data-ts]")]);
  const pinToBottom = (): void => {
    if (logEl === undefined) return;
    guard.mark();
    logEl.scrollTop = logEl.scrollHeight;
  };
  /** Put the last row at or before `ts` at the top of the pane. */
  const scrollToTime = (ts: number): void => {
    if (logEl === undefined) return;
    const rows = rowEls();
    const row = rows[rowAt(rows.map((r) => Number(r.dataset.ts)), ts)];
    if (row === undefined) return;
    guard.mark();
    logEl.scrollTop += row.getBoundingClientRect().top - logEl.getBoundingClientRect().top;
  };
  /** The window held, as the feed's rules read it (`feedPlan`). */
  const held = (): FeedWindow => {
    const list = entries();
    return { from: from(), end: from() + list.length, total: total(), oldestTs: list[0]?.ts ?? null, newestTs: list[list.length - 1]?.ts ?? null };
  };
  /** Whether the window held ends where the run does: a tail append belongs on it. */
  const atTail = (): boolean => from() + entries().length >= total();
  /** Set when a window was asked for to show the focus: the entries effect scrolls to it once the rows exist. */
  let scrollPending = false;
  let windowToken = 0;
  let loadTimer: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => clearTimeout(loadTimer));
  const replaceWindow = (pending: Promise<{ from: number; total: number; entries: FeedEntry[] }>): void => {
    const mine = ++windowToken;
    void pending
      .then((page) => {
        if (mine !== windowToken) return;
        scrollPending = true;
        batch(() => {
          setEntries(page.entries);
          setFrom(page.from);
          setTotal(page.total);
        });
      })
      .catch((e: unknown) => {
        logError("run entries", e);
        setError(displayError(e, { retries: false }));
      });
  };
  /**
   * The public build, focused on a time its one published window does not
   * reach: the bar still seeks there and the map link, the video and the
   * chart follow, and the feed says in a line that it has nothing for the
   * period rather than showing rows from another one (operator, 2026-11-16).
   */
  const feedAway = createMemo((): boolean => {
    const f = tl.focus();
    return SNAPSHOT_MODE && f !== null && entries().length > 0 && feedPlan(held(), f) === "load";
  });
  /** Show the focus in the feed: a scroll inside the window held, or the window that holds it. */
  const showFocus = (): void => {
    if (!feedPublished() || detail() === undefined) return;
    clearTimeout(loadTimer);
    const f = tl.focus();
    if (f === null) {
      // The newest moment: the tail window, pinned to its end.
      if (atTail() || SNAPSHOT_MODE) pinToBottom();
      else loadTimer = setTimeout(() => replaceWindow(api.entries(params.id, undefined, WINDOW)), LOAD_SETTLE_MS);
      return;
    }
    // A snapshot has one window per run: a time outside it leaves the feed out (`feedAway`) and scrolls nothing.
    if (feedPlan(held(), f) === "scroll") scrollToTime(f);
    else if (SNAPSHOT_MODE) return;
    else loadTimer = setTimeout(() => replaceWindow(api.entriesAt(params.id, f, WINDOW)), LOAD_SETTLE_MS);
  };
  /* The feed follows the focus, except a move it reported itself. */
  createEffect(
    on(
      tl.focus,
      () => {
        if (tl.origin() !== "feed") showFocus();
      },
      { defer: true },
    ),
  );
  /* New rows: stay on the newest while following it, and land on the focus when the window was loaded for it. */
  createEffect(
    on(entries, () => {
      if (tl.focus() === null) pinToBottom();
      else if (scrollPending) scrollToTime(tl.at());
      scrollPending = false;
    }),
  );
  /*
   * The reader's own scroll moves the focus to the row in view; at the very
   * bottom of the run's last window that is its newest moment, which on a
   * live run is following it.
   */
  let scrollFrame = 0;
  onCleanup(() => cancelAnimationFrame(scrollFrame));
  const onLogScroll = (): void => {
    if (logEl === undefined || guard.own()) return;
    cancelAnimationFrame(scrollFrame);
    scrollFrame = requestAnimationFrame(() => {
      // A feed put away has no row in view, and the pane collapsing under it is not the reader reaching its end.
      if (logEl === undefined || feedAway()) return;
      if (atTail() && atBottom(logEl.scrollTop, logEl.scrollHeight, logEl.clientHeight, FOLLOW_THRESHOLD)) {
        if (tl.focus() !== null) tl.goLive("feed");
        return;
      }
      const rows = rowEls();
      const top = logEl.getBoundingClientRect().top;
      const row = rows[rowInView(rows.length, (i) => rows[i]!.getBoundingClientRect().bottom - top)];
      const ts = Number(row?.dataset.ts);
      if (Number.isFinite(ts) && ts > 0) {
        tl.setPlaying(false);
        tl.seek(ts, "feed");
      }
    });
  };


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
    loadPad();
    loadClips();

    /*
     * The feed's window is asked for beside the detail rather than after it:
     * neither needs the other, and waiting cost the first load a round trip.
     * Its failure is handled where it is awaited below; the empty catch only
     * keeps a detail that failed first from leaving it unhandled.
     */
    // A link that opens at a time asks for the window that holds it, not the tail.
    const firstWindow = opensAt === null ? api.entries(params.id, undefined, WINDOW) : api.entriesAt(params.id, opensAt, WINDOW);
    void firstWindow.catch(() => undefined);

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
        /*
         * Where the feed this page holds ends, once `/entries` has answered:
         * the live tail starts there, so whatever the run wrote between that
         * read and the stream opening is not lost. Unset when the read failed,
         * and the stream then starts at the tail's end as it always did.
         */
        let heldThrough: number | undefined;
        const loadWindow = async (pending = api.entries(params.id, undefined, WINDOW)): Promise<void> => {
          const page = await pending;
          scrollPending = tl.focus() !== null && entries().length === 0;
          batch(() => {
            setEntries(page.entries);
            setFrom(page.from);
            setTotal(page.total);
          });
        };
        if (SNAPSHOT_MODE) {
          try {
            await loadWindow(firstWindow);
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
            await loadWindow(firstWindow);
            heldThrough = total();
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
            // The pad has no tail in either build; it moves with the detail.
            loadPad();
            loadClips();
          });
        });
        // Only a live run needs the tail; a finished one never grows again.
        // The public build has no tail to open at all: a bucket of published
        // Static JSON serves no SSE stream, and an EventSource against it would be a
        // reconnect loop against a 404.
        if (SNAPSHOT_MODE) return;
        stop = subscribeTail(api.streamUrl(params.id, heldThrough), {
          onEntries: (added, tot) => {
            /*
             * The tail grows the window only while the window is the run's
             * tail: a reader the timeline took to an earlier window keeps
             * what they are reading, and the count alone moves. An entry's
             * `i` is its index in the run, so one already held is dropped,
             * and a hole (a window swapped under the stream) is closed by
             * reading the tail again.
             */
            const end = from() + entries().length;
            const fresh = added.filter((e) => e.i >= end);
            if (end >= total()) {
              if (fresh.length > 0 && fresh[0]!.i > end) replaceWindow(api.entries(params.id, undefined, WINDOW));
              else if (fresh.length > 0) setEntries((prev) => [...prev, ...fresh]);
            }
            setTotal((t) => Math.max(t, (added[added.length - 1]?.i ?? -1) + 1, t + fresh.length));
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

  /** The stretch of the run the feed holds, for the rule under the timeline's bar. */
  const feedSpan = createMemo<Span | null>(() => {
    const list = entries();
    const first = list[0]?.ts;
    const last = list[list.length - 1]?.ts;
    return first === undefined || last === undefined ? null : { from: first, to: last };
  });

  /** The window after this one, for a reader the timeline took to the middle of a run. */
  const loadLater = (): void => {
    const start = from() + entries().length;
    if (start >= total()) return;
    void api
      .entries(params.id, start, WINDOW)
      .then((page) => setEntries((prev) => (from() + prev.length === page.from ? [...prev, ...page.entries] : prev)))
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
  /** What the run was driven with, for the rows a surface files differently (`lib/feedtier.ts`). */
  const surface = createMemo<Surface>(
    () => {
      const run = detail()?.run;
      return { loop: run?.comparability?.loop ?? "snippet", harness: run?.harness ?? null };
    },
    {},
    { equals: (x, y) => x.loop === y.loop && x.harness === y.harness },
  );
  /** Whether the run has a model side; a store session's calls are its record's, with no model to time. */
  const modelSide = createMemo(() => {
    const run = detail()?.run;
    return run === undefined || hasModelSide(run);
  });
  // The harness says where a call's envelope sits and whether a gap before a call is the model's.
  const groups = createMemo<FeedGroup[]>((prev) => groupFeed(entries(), prev, surface().harness ?? null, modelSide()), []);
  /** The window's `move` verdicts, for the action lines of the moves they end. */
  const verdicts = createMemo(() => moveVerdicts(entries()), undefined, { equals: sameVerdicts });

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
      case "actions":
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
          /*
           * The XP chart on the session clock: the same active time the
           * playtime sums, so a run resumed in place days later reads as its
           * sessions with a seam at each resume (`runChartInput`).
           */
          const chart = createMemo(() => runChartInput(d().states, run(), d().sessions, playtime(), chartClock(run().live, now)));
          /*
           * The focused time on the chart's clock: active time where the run
           * has sessions, the wall clock where it has none (`runChartInput`).
           * None while following a live run, whose curve ends at its cursor.
           */
          const chartCursor = (): number | null => {
            if (tl.following()) return null;
            const sessions = d().sessions;
            return sessions === undefined || sessions.length === 0 ? tl.at() : activeMsUntil(sessions, tl.at());
          };
          /* The live status line's words, once: on the line and, whole, in its hover. */
          const silent = (): boolean => now() - lastWrite() > SILENT_MS;
          const statusLine = (): string =>
            `${silent() ? "no activity for a while — the run may have stopped" : activity()} · ${fmtAge(now() - lastWrite())}${disconnected() ? " · feed disconnected" : ""}`;
          return (
            <>
              {/*
                The title row: the crumb left, and right of it the run's
                controls with the live status line. The controls used to head
                the sidebar and the status line sat under them, re-wrapping as
                its words changed and shoving everything below; here it shares
                a row the crumb already sets the height of, and clips rather
                than wraps (`.runview-status`), so nothing below it moves.
              */}
              <div class="runview-head">
              <h1 class="section">
                {/*
                  The runs table is where a reader of this page came from — the
                  fleet is the ops view and is not even a nav item any more. The
                  crumb carries the sort and filters they arrived with, so it is
                  also the "back" the second link used to be.
                */}
                <A href={`/runs${listSearch()}`}>runs</A> /{" "}
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
                {/* A party member's attempt is five runs; the party page is all of them. */}
                <Show when={run().party}>
                  {(p) => (
                    <>
                      {" · "}
                      <A href={partyHref(p().id)} title={`${p().id} · ${p().role ?? p().member}`}>
                        party
                      </A>
                    </>
                  )}
                </Show>
              </h1>
              <div class="side-controls runview-actions">
                <Show when={live()}>
                  {/* Drops the live mark once the run has gone quiet: a live mark
                      over "no activity for a while" contradicts itself. */}
                  <span class={silent() ? "runview-status warn" : "runview-status dim"} title={statusLine()}>
                    <span class={silent() ? "dot" : "dot live"} />
                    {silent() ? "no activity for a while — the run may have stopped" : activity()} · {fmtAge(now() - lastWrite())}
                    <Show when={disconnected()}> · <span class="err">feed disconnected</span></Show>
                  </span>
                </Show>
                {/* The map has the return leg (`open run →`); both carry the focused time. */}
                <A class="btn" href={withT(`/map?run=${encodeURIComponent(run().runId)}`, tl.focus())}>
                  replay on map
                </A>
                <Show when={run().party}>
                  {(p) => (
                    <A class="btn" href={partyReplayHref(p().id)} title="every member of the party on one clock">
                      party replay
                    </A>
                  )}
                </Show>
              </div>
              </div>

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
                      <span class="dim">last {total() - from()} of {total()}</span>
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
                    <MoveVerdicts.Provider value={verdicts}>
                    <Show when={feedAway()}>
                      <p class="dim feed-seam">trajectory logs for this period are unavailable</p>
                    </Show>
                    <div class="feed" hidden={feedAway()}>
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
                      <FeedList
                        groups={groups()}
                        runId={run().runId}
                        preset={expand()}
                        surface={surface()}
                        reflections={d().reflections}
                      />
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
                      <Show when={!SNAPSHOT_MODE && from() + entries().length < total()}>
                        <p class="dim feed-seam">
                          <button onClick={loadLater}>load later</button>
                        </p>
                      </Show>
                    </div>
                    </MoveVerdicts.Provider>
                    </RunStart.Provider>
                  </Show>
                </div>

                {/* Right column: everything about the run, always in view. */}
                <aside class="runview-side">
                  {/*
                    The model, then the character it played: who and what, before
                    anything about how it went. The character's totals across
                    attempts are a pane under the milestones, closed until opened.
                  */}
                  <div class="cards">
                    <Show when={hasModelSide(run())}>
                      <div class="card">
                        <div class="k">model</div>
                        <div class="v">
                          <ModelIcon model={run().model} />
                          {/* The roster row this run's model belongs to, when it is on the roster:
                              a run records a model string, never the name that scheduled it, so
                              the server matches it (`rosterName` on the detail). */}
                          <Show when={run().model} fallback="—">
                            {(full) => (
                              <span title={full()}>
                                <Show when={linkable(feeds.info.latest, "/models") ? detail()?.rosterName : undefined} fallback={modelDisplay(full())}>
                                  {(name) => <A href={modelsHref(name())}>{modelDisplay(full())}</A>}
                                </Show>
                              </span>
                            )}
                          </Show>
                        </div>
                        <div class="sub">
                          {run().platform ?? "—"} · {shortHarness(run().harnessVersion)}
                          {/* The world it played on, a world per eval's id; nothing for the shared one. */}
                          <Show when={run().world !== undefined && run().world !== "shared" ? run().world : undefined}>
                            {(w) => <span class="mono" title="world"> · {w()}</span>}
                          </Show>
                          <Show when={d().camera === true}>
                            <span title="a camera followed this run; it changes nothing about the run"> · camera</span>
                          </Show>
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
                    </Show>
                    <div class="card">
                      <div class="k">character</div>
                      <div class="v">
                        {/* A fan-out run's row is no one character's: its level and xp are its lead's, named here. */}
                        <Show when={run().character ?? d().fanoutLead} fallback="—">
                          {(name) =>
                            run().character === null ? (
                              <A href={`/run/${encodeURIComponent(run().runId)}?character=${encodeURIComponent(name())}`} title="the level and xp below are this character's: the highest level of the run's characters">
                                lead: {name()}
                              </A>
                            ) : (
                              name()
                            )
                          }
                        </Show>
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
                  </div>

                  {/*
                    The camera's newest still while the reader follows a live
                    run, private only: it is the live edge's picture, so a
                    seek back puts it away and leaves the run's video.
                  */}
                  <Show when={!SNAPSHOT_MODE && tl.following()}>
                    <LiveFrame runId={params.id} now={now()} />
                  </Show>
                  {/*
                    The video shows the focused time and, while it plays,
                    moves it (`lib/video-sync.ts`); starting it stops the
                    bar's own playback, and the bar's stops it. Until the
                    reader has focused a time it rests on its poster, so a
                    page opened at a run's end asks for no part but the first.
                  */}
                  <Show when={clips()}>
                    {(c) => (
                      <RunVideo
                        clips={c()}
                        follow={tl.focus()}
                        foreign={tl.origin() !== "video"}
                        hold={tl.playing()}
                        control={(v) => (video = v)}
                        onRunTime={(ms) => tl.seek(ms, "video")}
                        onPlaying={(on) => {
                          setVideoOn(on);
                          if (on) tl.setPlaying(false);
                        }}
                      />
                    )}
                  </Show>

                  <div class="cards">
                    {/*
                      The charts live in the sidebar, under the character, so
                      the feed keeps the page's height: cumulative XP with level
                      bands, drawn compact, and the full drawing a click away —
                      with, for a character, its climb across every attempt.
                      A fan-out run has no curve of its own (each character's
                      is its session's, under "characters"), so no card.
                    */}
                    <Show when={d().fanout === undefined}>
                      <ChartCard
                        label="xp"
                        compact={
                          <XpChart
                            compact
                            states={chart().states}
                            startedAt={chart().startedAt}
                            endedAt={chart().endedAt}
                            episodeMs={chartWindowMs(run(), playtime())}
                            now={chart().now}
                            seams={chart().seams}
                            cursor={chartCursor()}
                          />
                        }
                      >
                        <h2 class="section">this attempt</h2>
                        <XpChart
                          states={chart().states}
                          startedAt={chart().startedAt}
                          endedAt={chart().endedAt}
                          episodeMs={chartWindowMs(run(), playtime())}
                          now={chart().now}
                          seams={chart().seams}
                          cursor={chartCursor()}
                        />
                        {/*
                          Level against cumulative active playtime, stitched
                          across the attempts: the same line the freeplay field
                          draws, so a character reads the same on both pages.
                        */}
                        <Show when={characterPlot()}>
                          {(plot) => (
                            <>
                              <h2 class="section">the character, across {d().character?.attempts} attempts</h2>
                              <CharacterPlot series={plot().series} omitted={plot().omitted} single />
                            </>
                          )}
                        </Show>
                      </ChartCard>
                    </Show>
                    <Show when={hasModelSide(run())}>
                      <div class="card">
                        <div class="k">
                          context / total tokens
                          <InfoHint label="how the tokens were counted" text={tokenHint(detail(), tokens()?.source)} />
                        </div>
                        <div class="v mono" title={contextHint(tokens())}>
                          {fmtTokens(tokens()?.contextTokens ?? null)} / {fmtTokens(tokens()?.totalTokens ?? null)}
                        </div>
                        <div class="sub">
                          {sourceLabel(tokens()?.source)} · {tokens()?.turns ?? 0} turns · {tpsShort(detail())}
                        </div>
                      </div>
                    </Show>
                    <div class="card">
                      <div class="k">playtime</div>
                      <div class="v mono">{fmtDuration(playtime())}</div>
                      <div class="sub" title={stamp(run().startedAt)}>
                        {/* A run resumed in place is more than one session; one is the norm and goes unsaid. */}
                        <Show when={(d().sessions?.length ?? 1) > 1}>{d().sessions?.length} sessions · </Show>
                        {total()} entries
                      </div>
                    </div>
                    <Show when={hasModelSide(run())}>
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
                        Cost sits with the token cards because it is the same
                        measurement read in another unit. One card, the actual
                        as its headline where there is one (`CostCard`).
                      */}
                      <CostCard reading={runCostReading(detail()?.cost)} />
                    </Show>
                  </div>

                  {/* The model's own notes, under the figures about the run. Absent for a run with none. */}
                  <Show when={pad()}>{(text) => <ScratchpadPanel text={text()} />}</Show>

                  <h2 class="section">milestones</h2>
                  <Milestones detail={detail()} />
                  {/* The video's chapter list, folded away down here; a time in it is a seek on the timeline. */}
                  <Show when={clips()}>{(c) => <ChaptersPanel clips={c()} at={tl.at()} onSeek={(ms) => tl.seek(ms, "timeline")} />}</Show>

                  {/* The character across every attempt, closed until opened, since it is not this run and it is long. */}
                  <Show when={d().character}>{(st) => <CharacterTotalsPanel character={st()} runId={run().runId} />}</Show>

                  {/* A fan-out run has no session of its own: a record per character, picked here. */}
                  <Show when={inspector !== null && detail()?.fanout}>
                    {(f) => <FanoutCharacters client={inspector!} runId={params.id} sessions={f()} live={run().live} now={now()} />}
                  </Show>

                  {/* The tuple, and the game server under it, are the evals group's (`showsComparability`). */}
                  <Show when={showsComparability(run(), groupsOf(feeds.info.latest))}>
                    <h2 class="section">comparability</h2>
                    <Tuple run={run()} />
                  </Show>

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

                  <Show when={showsComparability(run(), groupsOf(feeds.info.latest))}>
                    <ServerFooter info={info()} run={run()} />
                  </Show>
                </aside>
              </div>
              <Timeline
                store={tl}
                playing={tl.playing() || videoOn()}
                onToggle={() => (videoOn() ? video?.pause() : tl.toggle())}
                marks={marks()}
                startLevel={startLevelOf(d())}
                sessions={d().sessions}
                feed={feedSpan()}
              />
            </>
          );
        }}
      </Show>
    </div>
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
          not recorded · harness {shortHarness(props.run.harnessVersion)}
          <InfoHint
            label="why not"
            text="this run predates the comparability stamp: nothing else about what it was given can be established after the fact"
          />
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
          <Show when={t().compactWindow}>
            {(w) => (
              <>
                <dt>compact window</dt>
                <dd>{w()}</dd>
              </>
            )}
          </Show>
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
