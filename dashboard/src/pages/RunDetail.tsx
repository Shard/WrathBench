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
import { For, Show, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import { subscribeTail } from "../api/live";
import { api, type FeedEntry, type RunDetailResponse, type TokenTotals } from "../api/client";
import { Sparkline } from "../components/Sparkline";
import { fmtAge, fmtDuration, fmtMoney, fmtTokens, num, shortHarness, stamp } from "../lib/format";

const WINDOW = 200;

/** Past this much silence a live run is more likely stopped than thinking. */
const SILENT_MS = 120_000;

export default function RunDetail() {
  const params = useParams<{ id: string }>();

  const [detail, setDetail] = createSignal<RunDetailResponse | undefined>(undefined);
  const [entries, setEntries] = createSignal<FeedEntry[]>([]);
  const [from, setFrom] = createSignal(0);
  const [total, setTotal] = createSignal(0);
  const [tokens, setTokens] = createSignal<TokenTotals | undefined>(undefined);
  const [error, setError] = createSignal<string | undefined>(undefined);
  const [lastWrite, setLastWrite] = createSignal(Date.now());
  const [now, setNow] = createSignal(Date.now());
  const [follow, setFollow] = createSignal(true);
  const [disconnected, setDisconnected] = createSignal(false);

  const live = (): boolean => detail()?.run.terminationReason === null;

  onMount(() => {
    const clock = setInterval(() => setNow(Date.now()), 1000);
    onCleanup(() => clearInterval(clock));

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
        // Only a live run needs the tail; a finished one never grows again.
        const stop = subscribeTail(api.streamUrl(params.id), {
          onEntries: (added, tot) => {
            setEntries((prev) => [...prev, ...added]);
            setTotal((t) => t + added.length);
            if (tot !== undefined) setTokens(tot);
            setLastWrite(Date.now());
            setDisconnected(false);
            if (follow()) queueMicrotask(() => window.scrollTo(0, document.body.scrollHeight));
          },
          onTick: () => setDisconnected(false),
          onError: () => setDisconnected(true),
        });
        onCleanup(stop);
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
  const xps = createMemo(() =>
    (detail()?.states ?? []).map((s) => s.xp).filter((v): v is number => v !== null),
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
    <div class="page">
      <Show when={error()}>
        <div class="banner bad">{error()}</div>
      </Show>
      <Show when={detail()} fallback={<p class="dim">loading…</p>}>
        {(d) => {
          const run = (): RunDetailResponse["run"] => d().run;
          const playtime = (): number | null => {
            const states = d().states;
            const first = states[0]?.ts ?? run().startedAt;
            if (first === null || first === undefined) return null;
            return (run().endedAt ?? now()) - first;
          };
          return (
            <>
              <h2 class="section">
                <A href="/">fleet</A> / {run().runId}
              </h2>

              <div class="cards">
                <div class="card">
                  <div class="k">model</div>
                  <div class="v">{run().model ?? "—"}</div>
                  <div class="sub">
                    {run().platform ?? "—"} · {shortHarness(run().harnessVersion)}
                  </div>
                </div>
                <div class="card">
                  <div class="k">character</div>
                  <div class="v">{run().character ?? "—"}</div>
                  <div class="sub">
                    level {num(run().level)} · {fmtMoney(run().money)} · {num(run().questsCompleted)} quests
                  </div>
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
                <div class="card">
                  <div class="k">level / xp</div>
                  <div class="v">
                    <Sparkline values={levels()} title="level over time" height={22} width={140} />
                  </div>
                  <div class="sub">
                    <Sparkline values={xps()} title="xp over time" height={16} width={140} />
                  </div>
                </div>
              </div>

              <Show when={run().terminationReason !== null}>
                <div class="banner bad">
                  <strong>{run().terminationReason}</strong>
                  <Show when={run().terminationDetail}> — {run().terminationDetail}</Show>
                </div>
              </Show>
              <Show when={run().terminationReason === null && run().pauseReason !== null}>
                <div class="banner warn">paused: {run().pauseReason}</div>
              </Show>

              <h2 class="section">
                feed
                <Show when={from() > 0}>
                  {" "}
                  <button onClick={loadEarlier}>load earlier</button>
                </Show>
                <Show when={live()}>
                  {" "}
                  <button class={follow() ? "on" : ""} onClick={() => setFollow(!follow())}>
                    auto-scroll
                  </button>
                </Show>
              </h2>

              <div class="feed">
                <For each={entries()}>{(e) => <Entry entry={e} runId={run().runId} />}</For>
              </div>

              <Show when={live() && run().terminationReason === null}>
                <p class={now() - lastWrite() > SILENT_MS ? "warn" : "dim"}>
                  <span class="dot live" />
                  {now() - lastWrite() > SILENT_MS
                    ? "no activity for a while — the run may have stopped"
                    : activity()}{" "}
                  · {fmtAge(now() - lastWrite())}
                  <Show when={disconnected()}> · <span class="err">stream disconnected</span></Show>
                </p>
              </Show>
            </>
          );
        }}
      </Show>
    </div>
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
