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
 * Long blocks fold to a few lines with a click to expand. The old page kept a
 * whole-feed expand preset in localStorage; that has not been ported (see
 * docs/FOLLOW-UPS.md).
 *
 * The public build is this page without the feed and without the tail: the
 * summary, the charts, the states and the costs all publish, the entries do
 * not (docs/DATA-AND-LEGAL.md), and the panel says so where they would be. The
 * withheld routes are never called rather than called and refused — see the
 * three `SNAPSHOT_MODE` guards below, and why an awaited 403 would have cost
 * the rest of the page.
 */

import { A, useLocation, useParams } from "@solidjs/router";
import { For, Show, createEffect, createMemo, createSignal, getOwner, on, onCleanup, onMount, runWithOwner } from "solid-js";
import { subscribeTail } from "../api/live";
import {
  api,
  rawPath,
  SNAPSHOT_MODE,
  type ApiInfoResponse,
  type ComparabilityView,
  type EventsServedEntry,
  type FeedEntry,
  type ModelRowView,
  type RunDetailResponse,
  type TokenTotals,
} from "../api/client";
import { HarnessTag } from "../components/HarnessTag";
import { ModelIcon } from "../components/ModelIcon";
import { XpChart } from "../components/XpChart";
import { fmtAge, fmtCost, fmtDuration, fmtItems, fmtLatency, fmtMoney, fmtTokens, fmtTps, num, resolvedLabel, shortHarness, stamp } from "../lib/format";
import { groupFeed, type CallGroup, type FeedGroup, type ResponseGroup, type TurnGroup } from "../lib/feedgroup";
import { modelsHref, rosterNameFor } from "../lib/models";
import { poll } from "../lib/poll";
import { readBoolPref, writeBoolPref } from "../lib/prefs";
import { atBottom } from "../lib/runview";

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
 * The entry feed arrives over the tail stream, but the summary card does not:
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
  const line = `${fmtTps(tps.recent)} tok/s over the last ${tps.recentReplies} repl(ies) · ${fmtTps(tps.overall)} over ${tps.replies}`;
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
function sourceLabel(source: string | undefined): string {
  if (source === "reported") return "provider-reported";
  if (source === "snapshot") return "snapshot — under-read";
  return "estimated (chars ÷ 4)";
}

function sourceHint(source: string | undefined): string {
  if (source === "snapshot") {
    return "claude-code opening usage snapshots: this run's turns never emitted a finished output count, so the completion total and the rate below are far too low";
  }
  if (source === "reported") return "provider-reported token counts";
  return "no provider counted; characters ÷ 4";
}

export default function RunDetail() {
  const params = useParams<{ id: string }>();
  const location = useLocation();

  /* Which worldserver the viewer can see, for the footer (FOLLOW-UPS 42). */
  const [info, setInfo] = createSignal<ApiInfoResponse | undefined>(undefined);
  const [detail, setDetail] = createSignal<RunDetailResponse | undefined>(undefined);
  const [entries, setEntries] = createSignal<FeedEntry[]>([]);
  const [from, setFrom] = createSignal(0);
  const [total, setTotal] = createSignal(0);
  const [tokens, setTokens] = createSignal<TokenTotals | undefined>(undefined);
  const [error, setError] = createSignal<string | undefined>(undefined);
  const [lastWrite, setLastWrite] = createSignal(Date.now());
  const [now, setNow] = createSignal(Date.now());
  const [follow, setFollow] = createSignal(readFollowPref());
  const [disconnected, setDisconnected] = createSignal(false);

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

  onMount(() => {
    const clock = setInterval(() => setNow(Date.now()), 1000);
    onCleanup(() => clearInterval(clock));

    /*
     * The tail is opened from an async continuation, so its cleanup cannot be
     * registered there: Solid tracks the owner through a synchronous global,
     * and an `onCleanup` called after the first await attaches to nothing. The
     * handle is registered now and filled in later. Leaking it would be worse
     * than a stray EventSource — the server clears the stream's 1 Hz rescan in
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
         * The feed is the one part of this page the public site does not
         * publish: an entry carries model output and verbatim game text, which
         * docs/DATA-AND-LEGAL.md does not let out of the lab. Not asked for
         * rather than asked for and refused — the withheld route answers 403,
         * and awaiting it here would reject this whole continuation, taking the
         * summary, the charts and the live poll down with it and reporting a
         * published boundary as a page error. The panel says so plainly
         * instead; the count still comes off the detail, which is the same
         * `entries.length` the feed would have reported.
         */
        if (SNAPSHOT_MODE) {
          setTotal(d.total);
        } else {
          const page = await api.entries(params.id, undefined, WINDOW);
          setEntries(page.entries);
          setFrom(page.from);
          setTotal(page.total);
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
             * In the public build the tail that advances the token card and
             * the entry count never opens, so the polled detail is the only
             * thing that moves them — without this they freeze at the first
             * load while the rest of the page keeps up.
             */
            if (SNAPSHOT_MODE) {
              setTokens(next.tokens);
              setTotal(next.total);
            }
          });
        });
        // Only a live run needs the tail; a finished one never grows again.
        // The public build has no tail to open at all: a bucket of published
        // JSON serves no stream, and an EventSource against it would be a
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
      .catch((e: unknown) => setError(String(e)));
  });

  const loadEarlier = (): void => {
    // No SNAPSHOT_MODE guard: the public build's window never opens (`from`
    // never leaves 0), so the button that calls this never renders — the
    // `Show` gate is the boundary, and a guard here would be dead code
    // implying a route into the withheld feed that does not exist.
    const start = Math.max(0, from() - WINDOW);
    if (start === from()) return;
    void api.entries(params.id, start, from() - start).then((page) => {
      setEntries((prev) => [...page.entries, ...prev]);
      setFrom(page.from);
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
      <Show when={detail()} fallback={<p class="dim">loading…</p>}>
        {(d) => {
          const run = (): RunDetailResponse["run"] => d().run;
          /* Playtime is the API's: cumulative active time, paused stretches out. */
          const playtime = (): number | null => d().playtimeMs ?? null;
          return (
            <>
              <h2 class="section">
                <A href="/">fleet</A> / {run().runId}
                {/* Back to the runs table, with the sort and filters the reader came from. */}
                <A class="dim" style={{ "margin-left": "12px", "font-size": "13px", "font-weight": "normal" }} href={`/runs${location.search}`}>
                  ← runs
                </A>
              </h2>

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
                    <Show when={from() > 0}>
                      {" "}
                      <button onClick={loadEarlier}>load earlier</button>
                    </Show>
                  </h2>
                  {/*
                    A statement of what this build publishes, not a failure:
                    the public site never asks for the entries, so nothing went
                    wrong and nothing is worth retrying. Plainly styled for the
                    same reason — an error colour here would send readers
                    looking for a fault that does not exist.
                  */}
                  <Show
                    when={!SNAPSHOT_MODE}
                    fallback={<p class="dim">Trajectory entries are withheld on the public site.</p>}
                  >
                    <div class="feed">
                      <For each={groups()}>
                        {(g) => {
                          switch (g.kind) {
                            case "turn":
                              return <TurnRow g={g} runId={run().runId} />;
                            case "response":
                              return <ResponseRow g={g} runId={run().runId} />;
                            case "call":
                              return <CallCard g={g} runId={run().runId} />;
                            default:
                              return <Entry entry={g.entry} runId={run().runId} />;
                          }
                        }}
                      </For>
                    </div>
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
                          <span class="dot live" />
                          {now() - lastWrite() > SILENT_MS
                            ? "no activity for a while — the run may have stopped"
                            : activity()}{" "}
                          · {fmtAge(now() - lastWrite())}
                          <Show when={disconnected()}> · <span class="err">stream disconnected</span></Show>
                        </span>
                      </Show>
                    </Show>
                  </div>

                  <div class="cards">
                    <div class="card">
                      <div class="k">model</div>
                      <div class="v">
                        <ModelIcon model={run().model} />
                        {/* The roster row this run's model belongs to, when it is on the roster:
                            a run records a model string, never the name that scheduled it. */}
                        <Show when={rosterName(run())} fallback={run().model ?? "—"}>
                          {(name) => <A href={modelsHref(name())}>{run().model}</A>}
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
                            {(id) => <>served as {id()}</>}
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
                        `xp in level` lives here since the level/xp card was
                        retired: the XP chart above plots CUMULATIVE xp with the
                        levels as bands, which is a different number from
                        progress toward the next ding, and that progress is on
                        no other surface of this page.
                      */}
                      <div class="sub">
                        level {num(run().level)} · {num(run().xp)} xp in level · {fmtMoney(run().money)} ·{" "}
                        {num(run().questsCompleted)} quests
                      </div>
                      {/* Newest recorded inventory (FOLLOW-UPS 50): plain lists, no icons. */}
                      <div class="sub">carrying: {fmtItems(run().items, false)}</div>
                      <div class="sub">equipped: {fmtItems(run().items, true)}</div>
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

                  <h2 class="section">comparability</h2>
                  <Tuple run={run()} />

                  <Show when={run().terminationReason !== null}>
                    <div class="banner bad">
                      <strong>{run().terminationReason}</strong>
                      <Show when={run().terminationDetail}> — {run().terminationDetail}</Show>
                    </div>
                  </Show>
                  <Show when={run().terminationReason === null && run().pauseReason !== null}>
                    <div class="banner warn">paused: {run().pauseReason}</div>
                  </Show>

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
 * The worldserver this run actually drove against, when known (FOLLOW-UPS 42).
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
            fallback={<>worldserver: unreachable from the viewer</>}
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
            {t().budget.maxToolCalls} tool calls · idle {ms(t().budget.idleMs)} · no-xp{" "}
            {ms(t().budget.noXpMs)} · episode {ms(t().budget.episodeMs)}
          </dd>
          <dt>wiki reference</dt>
          <dd>
            {t().wikiCoords === undefined
              ? "not recorded (predates the coordinates tier)"
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
                ? "unscored (operator objective)"
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
 * reach the plain `Entry` renderer belong here — `state`, stray events
 * batches, meta/notices/terminations. Requests, responses and tool calls are
 * always routed to the composite rows (lib/feedgroup.ts), never here.
 */
function bodyOf(e: FeedEntry): { text: string; head: string } {
  if (e.t === "events_served") return { text: "", head: eventsHead(e as EventsServedEntry) };
  // Everything else renders as the summary the server built, minus the
  // bookkeeping fields.
  const { i, t, ts, start, end, clipped, ...rest } = e as Record<string, unknown>;
  void i;
  void t;
  void ts;
  void start;
  void end;
  void clipped;
  return { text: JSON.stringify(rest, null, 1), head: "" };
}

const FOLD_LINES = 3;

/** A foldable pre block — the body treatment every card shares. */
function FoldBlock(props: { text: string }) {
  const [open, setOpen] = createSignal(false);
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

/** The raw-line link for one constituent of a composite row. */
function RawLink(props: { runId: string; i: number; label?: string }) {
  return (
    <a href={rawPath(props.runId, props.i)} target="_blank" rel="noreferrer">
      {props.label ?? "raw"}
    </a>
  );
}

/**
 * One formatter for every row's clock cell: `toLocaleTimeString` builds a
 * fresh `Intl.DateTimeFormat` per call, and this cell is on every row.
 */
const TIME_FMT = new Intl.DateTimeFormat(undefined, {
  hour: "numeric",
  minute: "2-digit",
  second: "2-digit",
});

/** The timestamp cell every head row ends with. */
function When(props: { ts: number }) {
  return <span title={stamp(props.ts)}>{TIME_FMT.format(props.ts)}</span>;
}

function Entry(props: { entry: FeedEntry; runId: string }) {
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
          <FoldBlock text={parts().text} />
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
function TurnRow(props: { g: TurnGroup; runId: string }) {
  const req = (): TurnGroup["request"] => props.g.request;
  return (
    <div class="entry">
      <div class="head">
        <span class="t">turn {req().turn ?? "?"}</span>
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
function ResponseRow(props: { g: ResponseGroup; runId: string }) {
  const e = (): ResponseGroup["entry"] => props.g.entry;
  return (
    <div class="entry">
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
          <FoldBlock text={e().text ?? ""} />
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
function CallCard(props: { g: CallGroup; runId: string }) {
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
    <div class={`entry ${g().result?.isError === true ? "bad" : ""}`}>
      <div class="head">
        <span class="t">{name()}</span>
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
          <FoldBlock text={input()} />
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
        {(r) => (
          <div class="body">
            <FoldBlock text={r().text ?? ""} />
          </div>
        )}
      </Show>
    </div>
  );
}
