/**
 * The run feed's rows.
 *
 * Two tiers (`lib/feedtier.ts`). A decision is a card, as it always was: the
 * model's reply, a tool call with its input over its result, a harness
 * notice, a level or a death. Actions are minimised: a run of them between
 * two decisions is one line of counts that opens to a line each, and each
 * line opens to the card it used to be. Every row leads with its kind's icon
 * (`FeedIcon`).
 *
 * `lib/feedgroup.ts` decides which entries are one row, `lib/feedtier.ts`
 * which rows fold, and `lib/feedline.ts` and `lib/feedview.ts` how a row
 * reads; this file only lays them out. Long blocks fold to a few lines, and
 * the page's expand preset sets where every fold starts.
 */

import { For, Show, createContext, createEffect, createMemo, createSignal, on, useContext, type JSX } from "solid-js";
import type { ActionsEntry, EventsServedEntry, FeedEntry, ReflectionWindowView } from "@viewer/api-types";
import { rawPath, SNAPSHOT_MODE } from "../api/client";
import { actionLines, isActionsEntry, keepLines, sameLine, type MoveVerdict } from "../lib/actionlog";
import type { CallGroup, FeedGroup, ResponseGroup, TurnGroup } from "../lib/feedgroup";
import { deployChips, eventsHead, leadChips, lineOf, milestoneLine, programErrorLine, replyLine, type Chip } from "../lib/feedline";
import { countLabel, kindOf, runLines, tallyLabel, tallyNotes, tierFeed, tsOf, type ActionRun, type FeedKind, type FeedRow, type Surface, type Tally } from "../lib/feedtier";
import { expandedBy, harnessFields, isHarnessEntry, noticeView, splitNotices, stateLine, type ExpandPreset } from "../lib/feedview";
import { fmtElapsed, fmtLatency, fmtTokens, paneText, stamp } from "../lib/format";
import { groupTurn, isReflectTool, reflectingAt } from "../lib/reflect";
import { FeedIcon } from "./FeedIcon";

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
 * A card's body: its text in a `FoldBlock`, with the blank lines at either end
 * dropped (`paneText`), and nothing at all when no text is left — an empty
 * reply and one that is only newlines draw the same.
 */
function FoldBody(props: { text: string; defaultOpen: boolean }) {
  const text = createMemo(() => paneText(props.text));
  return (
    <Show when={text().length > 0}>
      <div class="body">
        <FoldBlock text={text()} defaultOpen={props.defaultOpen} />
      </div>
    </Show>
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
export const RunStart = createContext<() => number | null>(() => null);

/**
 * The window's move verdicts by move id (`lib/actionlog.ts`), for the one
 * outcome an action line draws: how a `move_to` ended. A context for the same
 * reason as `RunStart` — every action block asks the same question of the
 * same window.
 */
export const MoveVerdicts = createContext<() => Map<number, MoveVerdict[]>>(() => new Map());

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

/**
 * A card's head figures past its name: muted, an error one in the error
 * colour, each with its hover where the figure alone would be cryptic.
 */
function Chips(props: { chips: readonly Chip[] }) {
  return (
    <For each={props.chips}>
      {(c) => (
        <span class={c.err === true ? "err" : "dim"} title={c.title}>
          {c.text}
        </span>
      )}
    </For>
  );
}

function Entry(props: { entry: FeedEntry; runId: string; preset: ExpandPreset; kind: FeedKind; bare?: boolean | undefined }) {
  const parts = createMemo(() => bodyOf(props.entry));
  return (
    <div class="entry">
      {/* Opened from its line, the line is the head. */}
      <Show when={props.bare !== true}>
        <div class="head">
          <FeedIcon kind={props.kind} />
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
      </Show>
      <FoldBody text={parts().text} defaultOpen={props.bare === true || expandedBy(props.preset, "detail")} />
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
    <div class={`entry turn ${props.reflecting ? "reflecting" : ""}`}>
      <div class="head">
        <FeedIcon kind="turn" />
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

/**
 * The model's reply, with how long the model took to produce it. A reply
 * with no words (a compaction call, an envelope no card claimed, an empty or
 * errored reply) is its head alone, saying what it was.
 */
function ResponseRow(props: { g: ResponseGroup; runId: string; preset: ExpandPreset; reflecting: boolean; bare?: boolean | undefined }) {
  const e = (): ResponseGroup["entry"] => props.g.entry;
  const worded = (): boolean => (e().text ?? "").trim().length > 0;
  const reply = createMemo(() => (worded() ? null : replyLine(e())));
  // Opened from its line, a reply with no words has nothing the line did not say.
  if (props.bare === true && !worded()) return null;
  return (
    <div class={`entry ${props.reflecting ? "reflecting" : ""}`} classList={{ bad: reply()?.failed === true }}>
      <Show when={props.bare !== true}>
        <div class="head">
          <FeedIcon kind={worded() ? "response" : "record"} />
          <span class="t">{reply()?.label ?? "response"}</span>
          <Show when={e().turn !== undefined}>
            <span>turn {e().turn}</span>
          </Show>
          <Show when={props.g.latencyMs !== null}>
            <span class="lat">{fmtLatency(props.g.latencyMs)}</span>
          </Show>
          <Show when={reply()}>{(r) => <span>{r().text}</span>}</Show>
          <Chips chips={leadChips(props.g.lead)} />
          <span class="spacer" />
          <When ts={e().ts} />
          <Show when={e().clipped === true}>
            <RawLink runId={props.runId} i={e().i} />
          </Show>
        </div>
      </Show>
      <FoldBody text={e().text ?? ""} defaultOpen={props.bare === true || expandedBy(props.preset, "response")} />
    </div>
  );
}

/**
 * One tool call as one card: the input on top, the result under a dashed rule.
 * A snippet's card starts closed to its head under the presets that do not
 * open calls, with its line count, its outcome and its action log's counts.
 * For run_snippet the input is the snippet's code and the call's args are not
 * shown — they are the same code again, which is exactly the duplication this
 * card exists to remove. The duration is `result.ts − call.ts` and only shown
 * when the writer recorded the call before running it (see lib/feedgroup.ts).
 */
function CallCard(props: { g: CallGroup; runId: string; preset: ExpandPreset; reflecting: boolean; kind: FeedKind; bare?: boolean | undefined }) {
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
  /*
   * A snippet's card is closed to its head unless the preset opens calls
   * ("snippets", "all") or the reader clicks: under the default the feed is
   * the model's replies, and a snippet is one line that says how long its
   * code is, how it ended and what it put on the wire. Every other tool's
   * card is short already and is drawn whole.
   */
  const folds = (): boolean => props.kind === "snippet" && props.bare !== true;
  const [over, setOver] = createSignal<boolean | null>(null);
  createEffect(on(() => props.preset, () => setOver(null), { defer: true }));
  const open = (): boolean => !folds() || (over() ?? expandedBy(props.preset, "call"));
  /** What led to the call and what its write set off, as figures on the head. */
  const chips = createMemo((): Chip[] => [...leadChips(g().lead), ...deployChips(g().deploys)]);
  const codeLines = createMemo(() => {
    const code = paneText(input());
    return code.length === 0 ? 0 : code.split("\n").length;
  });
  /** What the closed head says of the action log and the harness's lines, so neither a refusal nor a hint is hidden. */
  const closedTally = createMemo((): Tally => {
    const t = tallyNotes(g().actions);
    return { ...t, hints: splitNotices(g().result?.text ?? "").notices.length };
  });
  const onHead = (e: MouseEvent): void => {
    if (!folds() || (e.target as Element).closest("a, button") !== null) return;
    setOver(!open());
  };
  return (
    <div class={`entry ${g().result?.isError === true ? "bad" : ""} ${props.reflecting ? "reflecting" : ""}`} classList={{ closed: !open() }}>
      <div class="head" classList={{ folds: folds() }} onClick={onHead}>
        <Show when={folds()}>
          <button class="fold-toggle" classList={{ open: open() }} aria-expanded={open()} aria-label={open() ? "collapse" : "expand"} onClick={() => setOver(!open())}>
            <FeedIcon kind="chevron" />
          </button>
        </Show>
        {/* Opened from its line, the line already names the call, its turn and its time. */}
        <Show when={props.bare !== true}>
          <FeedIcon kind={props.kind} />
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
        </Show>
        <Show when={g().durationMs !== null}>
          <span class="lat" title="from the call's dispatch to its result">
            {fmtLatency(g().durationMs)}
          </span>
        </Show>
        <Chips chips={chips()} />
        <Show when={!open()}>
          <span>
            {codeLines()} {codeLines() === 1 ? "line" : "lines"}
          </span>
          <Show when={g().result} fallback={<span>no result yet</span>}>
            {(r) => <span class={r().isError === true ? "err outcome" : "ok outcome"}>{r().isError === true ? "error" : "ok"}</span>}
          </Show>
          <TallyChips tally={closedTally()} />
        </Show>
        <span class="spacer" />
        <Show when={props.bare !== true}>
          <When ts={anyTs()} />
        </Show>
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
      <Show when={open()}>
        <FoldBody text={input()} defaultOpen={expandedBy(props.preset, "call")} />
        <Show when={g().actions.length > 0}>
          <ActionLines records={g().actions} preset={props.preset} />
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
                <FoldBody text={split().body} defaultOpen={expandedBy(props.preset, "call")} />
                <Show when={split().notices.length > 0}>
                  <div class="body notices">
                    <NoticeCallout lines={split().notices} />
                  </div>
                </Show>
              </>
            );
          }}
        </Show>
      </Show>
    </div>
  );
}

/** An action line, and whether the call it came from was a routine's. */
type RoutineLine = ReturnType<typeof actionLines>[number] & { routine: boolean };

/** An action log this short is drawn as its lines; a longer one as its counts, opening to them. */
const ACTION_INLINE_LINES = 2;

/** How many failures a closed row draws under its counts before it says how many more there are. */
const FAILED_SHOWN = 3;

/**
 * A tally as chips: each kind's icon and its count, then what went wrong.
 * The failures and the harness's hints are words in their own colours, so a
 * closed row never reads as clean when it was not.
 */
function TallyChips(props: { tally: Tally }) {
  return (
    <span class="tally">
      <For each={props.tally.counts}>
        {(c) => (
          <span class="tally-chip">
            <FeedIcon kind={c.kind} />
            {countLabel(c.kind, c.n)}
          </span>
        )}
      </For>
      <Show when={props.tally.failed > 0}>
        <span class="tally-chip err">{props.tally.failed} failed</span>
      </Show>
      <Show when={props.tally.hints > 0}>
        <span class="tally-chip hint">
          {props.tally.hints} {props.tally.hints === 1 ? "hint" : "hints"}
        </span>
      </Show>
    </span>
  );
}

/** The head of a row that opens: the disclosure mark, then what the row holds. */
function FoldHead(props: { open: boolean; onToggle: () => void; title?: string | undefined; children: JSX.Element }) {
  return (
    <button class="fold-head" classList={{ open: props.open }} aria-expanded={props.open} title={props.title} onClick={() => props.onToggle()}>
      <FeedIcon kind="chevron" />
      {props.children}
    </button>
  );
}

/** The failures of a closed row, a line each, and how many more there were. */
function FailureLines(props: { lines: readonly { text: string; title?: string | undefined }[] }) {
  return (
    <>
      <For each={props.lines.slice(0, FAILED_SHOWN)}>
        {(l) => (
          <div class="action-line err" title={l.title}>
            {l.text}
          </div>
        )}
      </For>
      <Show when={props.lines.length > FAILED_SHOWN}>
        <div class="action-line dim">+{props.lines.length - FAILED_SHOWN} more failed</div>
      </Show>
    </>
  );
}

/**
 * What a snippet put on the wire (`lib/actionlog.ts`): its counts on one
 * line, opening to a line per dispatch, under the same preset as the code
 * above it. Closed, the refused dispatches are drawn under the counts all the
 * same. A refused dispatch reads in the error colour, the SDK's own
 * client-parity traffic dimmed; the module's hint and the timing are on the
 * hover.
 */
function ActionLines(props: { records: readonly ActionsEntry[]; preset: ExpandPreset; startOpen?: boolean | undefined }) {
  const verdicts = useContext(MoveVerdicts);
  // The previous lines kept where they read the same, so `<For>` redraws only a line whose verdict moved.
  const lines = createMemo<RoutineLine[]>(
    (prev) =>
      keepLines(
        prev,
        props.records.flatMap((r) => actionLines(r, verdicts()).map((l) => ({ ...l, routine: r.routine === true }))),
        (a, b) => sameLine(a, b) && a.routine === b.routine,
      ),
    [],
  );
  const tally = createMemo(() => tallyNotes(props.records));
  const [over, setOver] = createSignal<boolean | null>(null);
  createEffect(on(() => props.preset, () => setOver(null), { defer: true }));
  const inline = (): boolean => lines().length <= ACTION_INLINE_LINES;
  const open = (): boolean => inline() || (over() ?? (props.startOpen === true || expandedBy(props.preset, "call")));
  return (
    <div class="body actions">
      <Show when={!inline()}>
        <FoldHead open={open()} onToggle={() => setOver(!open())} title={tallyLabel(tally())}>
          <TallyChips tally={tally()} />
        </FoldHead>
      </Show>
      <Show when={open()} fallback={<FailureLines lines={lines().filter((l) => l.failed)} />}>
        <For each={lines()}>
          {(l) => (
            <div class="action-line" classList={{ err: l.failed, dim: l.auto }} title={l.title}>
              <Show when={l.routine}>
                <span class="dim">routine · </span>
              </Show>
              {l.text}
            </div>
          )}
        </For>
      </Show>
    </div>
  );
}

/**
 * An action-log record no call in the window owns: its call is off the top,
 * or it was dispatched outside every snippet (an event callback).
 */
function ActionsRow(props: { entry: ActionsEntry; runId: string; preset: ExpandPreset; startOpen?: boolean | undefined }) {
  return (
    <div class="entry">
      {/* Opened from its line, the line is the head. */}
      <Show when={props.startOpen !== true}>
        <div class="head">
          <FeedIcon kind="other" />
          <span class="t">actions</span>
          <Show when={props.entry.routine === true}>
            <span>routine</span>
          </Show>
          <Show when={props.entry.turn !== undefined}>
            <span>turn {props.entry.turn}</span>
          </Show>
          <span class="spacer" />
          <When ts={props.entry.ts} />
          <Show when={props.entry.clipped === true}>
            <RawLink runId={props.runId} i={props.entry.i} />
          </Show>
        </div>
      </Show>
      <ActionLines records={[props.entry]} preset={props.preset} startOpen={props.startOpen} />
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
function NoticeRow(props: { entry: FeedEntry; runId: string; preset: ExpandPreset; bare?: boolean | undefined }) {
  const n = createMemo(() => noticeView(props.entry));
  // Bookkeeping opened from its line: its line was its head, so the record is what is left.
  if (props.bare === true && n().bookkeeping) return <BareDetail entry={props.entry} />;
  return (
    <div class="entry harness" classList={{ notice: !n().bookkeeping }}>
      <div class="head">
        <FeedIcon kind={n().bookkeeping ? "record" : "notice"} />
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
          <NoticeCallout lines={paneText(n().text).split("\n")} />
        </div>
        {/*
          The rest of the record, and only when there is one: a notice whose
          whole content is its text would otherwise print that text twice.
        */}
        <Show when={harnessFields(props.entry).length > 0}>
          <FoldBody text={detailOf(props.entry)} defaultOpen={expandedBy(props.preset, "detail")} />
        </Show>
      </Show>
    </div>
  );
}

/** A record opened from its line: the record, under the line that already named it. */
function BareDetail(props: { entry: FeedEntry }) {
  return (
    <div class="entry">
      <div class="body">
        <pre class="block">{detailOf(props.entry)}</pre>
      </div>
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
function StateRow(props: { entry: FeedEntry; runId: string; preset: ExpandPreset; startOpen?: boolean | undefined }) {
  const line = createMemo(() => stateLine(props.entry));
  const [open, setOpen] = createSignal<boolean | null>(null);
  createEffect(on(() => props.preset, () => setOpen(null), { defer: true }));
  const shown = (): boolean => open() ?? (props.startOpen === true || expandedBy(props.preset, "detail"));
  // Opened from its line, the record is all there is left to show.
  if (props.startOpen === true) return <BareDetail entry={props.entry} />;
  return (
    <div class="entry state">
      <div class="head">
        <FeedIcon kind="state" />
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

/**
 * A milestone, a turn-in or a program's error or refusal as one line
 * (`lib/feedline.ts`), with the record behind a toggle: a level or a death
 * is a thing to spot down a long feed, not a record to read. A death and a
 * thrown error carry the error rule an errored card does.
 */
function MarkRow(props: {
  entry: FeedEntry;
  runId: string;
  preset: ExpandPreset;
  kind: FeedKind;
  line: string;
  title?: string | undefined;
  bad: boolean;
  startOpen?: boolean | undefined;
}) {
  const [open, setOpen] = createSignal<boolean | null>(null);
  createEffect(on(() => props.preset, () => setOpen(null), { defer: true }));
  const shown = (): boolean => open() ?? (props.startOpen === true || expandedBy(props.preset, "detail"));
  if (props.startOpen === true) return <BareDetail entry={props.entry} />;
  return (
    <div class="entry mark" classList={{ bad: props.bad }}>
      <div class="head">
        <FeedIcon kind={props.kind} />
        <span class="t" title={props.title}>
          {props.line}
        </span>
        <Show when={props.entry.turn !== undefined}>
          <span class="dim">turn {props.entry.turn}</span>
        </Show>
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

/** What every row is handed: the run, the reader's preset, and what the run was driven with. */
interface FeedCtx {
  readonly runId: string;
  readonly preset: ExpandPreset;
  readonly surface: Surface;
  /** Whether a row's turn is inside one of the run's reflection windows. */
  reflecting(g: FeedGroup): boolean;
}

/**
 * One row in full: the card a decision is, and what an action's line opens
 * to. `opened` is the second case: the reader has already clicked for this
 * row, so the one-line rows show their record rather than asking again.
 */
function FullRow(props: { g: FeedGroup; ctx: FeedCtx; opened?: boolean }) {
  const g = props.g;
  const ctx = props.ctx;
  const kind = (): FeedKind => kindOf(g, ctx.surface);
  /*
   * The accent is asked of the run's windows, not of the loaded entries: the
   * `open` that starts a window can sit far above whatever slice the feed
   * has, and a turn is either inside a window or it is not.
   */
  const rf = (): boolean => ctx.reflecting(g);
  switch (g.kind) {
    case "turn":
      return <TurnRow g={g} runId={ctx.runId} reflecting={rf()} />;
    case "response":
      return <ResponseRow g={g} runId={ctx.runId} preset={ctx.preset} reflecting={rf()} bare={props.opened} />;
    case "call":
      return <CallCard g={g} runId={ctx.runId} preset={ctx.preset} reflecting={rf()} kind={kind()} bare={props.opened} />;
    default:
      // The records with a shape worth drawing rather than dumping; everything else is still generic.
      if (g.entry.t === "state") return <StateRow entry={g.entry} runId={ctx.runId} preset={ctx.preset} startOpen={props.opened} />;
      if (isHarnessEntry(g.entry)) return <NoticeRow entry={g.entry} runId={ctx.runId} preset={ctx.preset} bare={props.opened} />;
      if (isActionsEntry(g.entry)) return <ActionsRow entry={g.entry} runId={ctx.runId} preset={ctx.preset} startOpen={props.opened} />;
      if (g.entry.t === "milestone" || g.entry.t === "quest_complete") {
        return <MarkRow entry={g.entry} runId={ctx.runId} preset={ctx.preset} kind={kind()} line={milestoneLine(g.entry)} bad={kind() === "death"} startOpen={props.opened} />;
      }
      if (g.entry.t === "program_error") {
        const p = programErrorLine(g.entry);
        const thrown = (g.entry as { kind?: unknown }).kind === "error";
        return <MarkRow entry={g.entry} runId={ctx.runId} preset={ctx.preset} kind={kind()} line={p.text.length > 0 ? `${p.label}: ${p.text}` : p.label} title={p.title} bad={thrown} startOpen={props.opened} />;
      }
      return <Entry entry={g.entry} runId={ctx.runId} preset={ctx.preset} kind={kind()} bare={props.opened} />;
  }
}

/**
 * One action as one line: its icon, what it was, what it came to, when. A
 * click opens the row in full under it, exactly the card it would have been.
 */
function ActionItem(props: { g: FeedGroup; ctx: FeedCtx }) {
  const line = createMemo(() => lineOf(props.g, props.ctx.surface));
  const [over, setOver] = createSignal<boolean | null>(null);
  createEffect(on(() => props.ctx.preset, () => setOver(null), { defer: true }));
  const open = (): boolean => over() ?? expandedBy(props.ctx.preset, "detail");
  return (
    <div class="act" classList={{ open: open() }}>
      <button class="act-line" classList={{ err: line().failed }} title={line().title} aria-expanded={open()} onClick={() => setOver(!open())}>
        <FeedIcon kind={line().kind} />
        <span class="act-label">{line().label}</span>
        <span class="act-text">{line().text}</span>
        <span class="spacer" />
        <When ts={line().ts} />
      </button>
      <Show when={open()}>
        <FullRow g={props.g} ctx={props.ctx} opened />
      </Show>
    </div>
  );
}

/**
 * A run of actions between two decisions, as one quiet row: its counts, and
 * under them, opened, a line per action. A run of one is that line. Closed,
 * whatever failed inside is drawn under the counts anyway: a refusal is the
 * one thing in a run a reader must not have to open it to find.
 */
function RunRow(props: { run: ActionRun; ctx: FeedCtx }) {
  const verdicts = useContext(MoveVerdicts);
  const lines = createMemo(() => runLines(props.run.items));
  const [over, setOver] = createSignal<boolean | null>(null);
  createEffect(on(() => props.ctx.preset, () => setOver(null), { defer: true }));
  const open = (): boolean => over() ?? expandedBy(props.ctx.preset, "actions");
  const failures = createMemo(() => {
    if (props.run.tally.failed === 0) return [];
    const out: { text: string; title?: string | undefined }[] = [];
    for (const g of lines()) {
      if (g.kind === "plain" && isActionsEntry(g.entry)) {
        for (const l of actionLines(g.entry, verdicts())) if (l.failed) out.push({ text: l.text, title: l.title });
        continue;
      }
      const l = lineOf(g, props.ctx.surface);
      if (l.failed) out.push({ text: `${l.label} ${l.text}` });
    }
    return out;
  });
  return (
    <div class="entry run" classList={{ bad: props.run.tally.failed > 0, reflecting: props.ctx.reflecting(props.run.items[0]!) }}>
      <Show when={lines().length > 1} fallback={<ActionItem g={lines()[0] ?? props.run.items[0]!} ctx={props.ctx} />}>
        <FoldHead open={open()} onToggle={() => setOver(!open())} title={tallyLabel(props.run.tally)}>
          <TallyChips tally={props.run.tally} />
          <span class="spacer" />
          <When ts={props.run.fromTs} />
        </FoldHead>
        <Show when={open()} fallback={<FailureLines lines={failures()} />}>
          <div class="run-items">
            <For each={lines()}>{(g) => <ActionItem g={g} ctx={props.ctx} />}</For>
          </div>
        </Show>
      </Show>
    </div>
  );
}

/**
 * A row with its time on it (`data-ts`, run time in ms), which is what the
 * page reads to scroll the feed to a moment and to tell which moment a
 * scrolled feed is showing. Every row's root is one element; it is stamped
 * here, once, rather than in each of the row components.
 */
function stamped(row: JSX.Element, ts: number): JSX.Element {
  if (typeof HTMLElement !== "undefined" && row instanceof HTMLElement) row.dataset.ts = String(ts);
  return row;
}

/** A run's place in the list: one object for as long as the run starts at the same entry. */
interface RunHandle {
  kind: "handle";
  anchor: number;
}

/**
 * The feed: decisions as cards, runs of actions folded between them.
 *
 * `<For>` reconciles by reference, and a live run's last run of actions is a
 * new object on every append. So the list holds a handle per run, the same
 * one while the run starts at the same entry, and the row under it reads the
 * run's current items: what a reader opened stays open while the tail grows,
 * and only the new line is drawn.
 */
export function FeedList(props: {
  groups: readonly FeedGroup[];
  runId: string;
  preset: ExpandPreset;
  surface: Surface;
  reflections: readonly ReflectionWindowView[] | undefined;
}) {
  const ctx: FeedCtx = {
    get runId() {
      return props.runId;
    },
    get preset() {
      return props.preset;
    },
    get surface() {
      return props.surface;
    },
    reflecting: (g) => reflectingAt(props.reflections, groupTurn(g)),
  };
  const rows = createMemo<FeedRow[]>((prev) => tierFeed(props.groups, props.surface, prev), []);
  const runs = createMemo(() => {
    const by = new Map<number, ActionRun>();
    for (const r of rows()) if (r.kind === "run") by.set(r.anchor, r);
    return by;
  });
  const handles = new Map<number, RunHandle>();
  const keys = createMemo<(FeedGroup | RunHandle)[]>(() => {
    const live = new Set<number>();
    const out = rows().map((r) => {
      if (r.kind !== "run") return r;
      live.add(r.anchor);
      let h = handles.get(r.anchor);
      if (h === undefined) handles.set(r.anchor, (h = { kind: "handle", anchor: r.anchor }));
      return h;
    });
    for (const anchor of [...handles.keys()]) if (!live.has(anchor)) handles.delete(anchor);
    return out;
  });
  return (
    <For each={keys()}>
      {(k) => {
        if (k.kind !== "handle") return stamped(<FullRow g={k} ctx={ctx} />, tsOf(k));
        // Its run for as long as the handle is listed; the last one it had on the pass that drops it.
        const run = createMemo<ActionRun>((prev) => runs().get(k.anchor) ?? prev, runs().get(k.anchor)!);
        return stamped(<RunRow run={run()} ctx={ctx} />, run().fromTs);
      }}
    </For>
  );
}
