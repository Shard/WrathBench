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
 */

import { A, useParams } from "@solidjs/router";
import { For, Show, createEffect, createMemo, createSignal, on, onCleanup, onMount } from "solid-js";
import { subscribeTail } from "../api/live";
import {
  api,
  type ApiInfoResponse,
  type ComparabilityView,
  type FeedEntry,
  type ModelRowView,
  type RunDetailResponse,
  type TokenTotals,
} from "../api/client";
import { HarnessTag } from "../components/EpisodePicker";
import { Sparkline } from "../components/Sparkline";
import { XpChart } from "../components/XpChart";
import { fmtAge, fmtCost, fmtDuration, fmtItems, fmtMoney, fmtTokens, num, shortHarness, stamp } from "../lib/format";
import { modelsHref, rosterNameFor } from "../lib/models";
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
  try {
    return localStorage.getItem(FOLLOW_KEY) !== "0";
  } catch {
    return true;
  }
}
function writeFollowPref(keep: boolean): void {
  try {
    localStorage.setItem(FOLLOW_KEY, keep ? "1" : "0");
  } catch {
    /* private mode, blocked storage: the toggle still works, it just won't persist */
  }
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

export default function RunDetail() {
  const params = useParams<{ id: string }>();

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
    // Same reason as `stop`: registered here, filled in after the first await.
    let resummarise: ReturnType<typeof setInterval> | undefined;
    onCleanup(() => {
      if (resummarise !== undefined) clearInterval(resummarise);
    });

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
        const page = await api.entries(params.id, undefined, WINDOW);
        setEntries(page.entries);
        setFrom(page.from);
        setTotal(page.total);
        if (d.run.terminationReason !== null) return;
        // A live run's summary keeps moving; a finished one is settled.
        resummarise = setInterval(() => {
          void api
            .run(params.id)
            .then((next) => setDetail(next))
            .catch(() => {
              /* a failed poll keeps the last good summary, like `poll()` does */
            });
        }, DETAIL_POLL_MS);
        // Only a live run needs the tail; a finished one never grows again.
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
    const start = Math.max(0, from() - WINDOW);
    if (start === from()) return;
    void api.entries(params.id, start, from() - start).then((page) => {
      setEntries((prev) => [...page.entries, ...prev]);
      setFrom(page.from);
    });
  };

  const levels = createMemo(() =>
    (detail()?.states ?? []).map((s) => s.level).filter((v): v is number => v !== null && v > 0),
  );

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
                  <div class="feed">
                    <For each={entries()}>{(e) => <Entry entry={e} runId={run().runId} />}</For>
                  </div>
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
                        {/* The roster row this run's model belongs to, when it is on the roster:
                            a run records a model string, never the name that scheduled it. */}
                        <Show when={rosterName(run())} fallback={run().model ?? "—"}>
                          {(name) => <A href={modelsHref(name())}>{run().model}</A>}
                        </Show>
                      </div>
                      <div class="sub">
                        {run().platform ?? "—"} · {shortHarness(run().harnessVersion)}
                      </div>
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
                      <div class="sub">
                        level {num(run().level)} · {fmtMoney(run().money)} · {num(run().questsCompleted)} quests
                      </div>
                      {/* Newest recorded inventory (FOLLOW-UPS 50): plain lists, no icons. */}
                      <div class="sub">carrying: {fmtItems(run().items, false)}</div>
                      <div class="sub">equipped: {fmtItems(run().items, true)}</div>
                    </div>
                    <div class="card">
                      <div class="k">context / total tokens</div>
                      <div class="v mono">
                        {fmtTokens(tokens()?.contextTokens ?? null)} / {fmtTokens(tokens()?.totalTokens ?? null)}
                      </div>
                      <div class="sub">
                        {tokens()?.source === "reported" ? "provider-reported" : "estimated (chars ÷ 4)"} ·{" "}
                        {tokens()?.turns ?? 0} turns
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
                    <div class="card">
                      <div class="k">level / xp</div>
                      <div class="v">
                        {/* The prominent XP curve is the full-width chart above; this is a
                            glanceable level trace. */}
                        <Sparkline values={levels()} title="level over time" height={22} width={140} />
                      </div>
                      <div class="sub">
                        L{num(run().level)} · xp {num(run().xp)} in level
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

/** The text a given entry type puts in its body, and whether it is an error. */
function bodyOf(e: FeedEntry): { text: string; bad: boolean; head: string } {
  const rec = e as Record<string, unknown>;
  const str = (k: string): string => (typeof rec[k] === "string" ? (rec[k] as string) : "");
  switch (e.t) {
    case "response":
      return { text: str("text"), bad: false, head: (rec["tools"] as string[] | undefined)?.join(", ") ?? "" };
    case "snippet":
      return { text: str("code"), bad: false, head: "" };
    case "snippet_result":
    case "tool_result":
      return { text: str("text"), bad: rec["isError"] === true, head: str("name") };
    case "request":
      return {
        text: "",
        bad: false,
        head: `${String(rec["messageCount"] ?? "?")} messages · ${String(rec["promptChars"] ?? "?")} chars`,
      };
    case "events_served":
      return {
        text: "",
        bad: false,
        head: `${String(rec["count"] ?? 0)} events · ${((rec["opcodes"] as string[] | undefined) ?? []).join(" ")}`,
      };
    default: {
      // Everything else — meta, state, notices, terminations — renders as the
      // summary the server built, minus the bookkeeping fields.
      const { i, t, ts, start, end, clipped, ...rest } = rec;
      void i;
      void t;
      void ts;
      void start;
      void end;
      void clipped;
      return { text: JSON.stringify(rest, null, 1), bad: false, head: "" };
    }
  }
}

const FOLD_LINES = 3;

function Entry(props: { entry: FeedEntry; runId: string }) {
  const [open, setOpen] = createSignal(false);
  const parts = createMemo(() => bodyOf(props.entry));
  const lines = createMemo(() => parts().text.split("\n").length);
  const foldable = (): boolean => lines() > FOLD_LINES;
  return (
    <div class={`entry ${parts().bad ? "bad" : ""}`}>
      <div class="head">
        <span class="t">{props.entry.t}</span>
        <Show when={props.entry.turn !== undefined}>
          <span>turn {props.entry.turn}</span>
        </Show>
        <span>{parts().head}</span>
        <span class="spacer" style={{ flex: 1 }} />
        <span title={stamp(props.entry.ts)}>{new Date(props.entry.ts).toLocaleTimeString()}</span>
        <Show when={props.entry.clipped === true}>
          <a
            href={`/api/run/${encodeURIComponent(props.runId)}/raw/${props.entry.i}`}
            target="_blank"
            rel="noreferrer"
          >
            raw
          </a>
        </Show>
      </div>
      <Show when={parts().text.length > 0}>
        <div class="body">
          <pre class={`block ${foldable() && !open() ? "fold" : ""}`}>{parts().text}</pre>
          <Show when={foldable()}>
            <button class="toggle" onClick={() => setOpen(!open())}>
              {open() ? "collapse" : `expand · ${lines()} lines`}
            </button>
          </Show>
        </div>
      </Show>
    </div>
  );
}
