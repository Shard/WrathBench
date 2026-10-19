/**
 * Wake-on-event: a probe-campaign arm's harness change, switchable per run and
 * off by default, so one image serves the control and the treatments.
 *
 * Two independent options, set by an arm's args (`--wake-turn-end true`,
 * `--wake-in-snippet true`) and recorded on the run (`RunConfig.wake`) and in
 * its comparability tuple (`wake`, absent when off):
 *
 * - **turnEnd.** After a reply with no tool call, the harness makes no new
 *   model call until a wake fires or `WAKE_CAP_MS` passes, instead of
 *   re-prompting after the fixed `stepIntervalMs`. The step interval stays the
 *   floor. The next user message says what fired and how long the model slept
 *   (a `woke` harness notice). On the fixed loop that is a turn with no tool
 *   calls; on both CLI drivers every turn ends that way, so it is every turn
 *   boundary.
 * - **inSnippet.** An ambient `wait({ on, maxMs })` in the sandbox holds a
 *   `run_snippet` open past the snippet limit, up to `WAKE_CAP_MS` of waiting
 *   per snippet, for a named event, a promise settling or a state predicate.
 *   Every other snippet keeps the limit (`entry.ts`, `wait`; the host's eval
 *   timer is held for exactly the waiting, `host.ts`).
 *
 * The wake set: `MANDATORY_WAKES` always fire and the model cannot turn them
 * off. `attacked` is never mandatory: it fires on every pull of a grind, so a
 * wait that always woke for it would wake on nearly every wait. The turn-end
 * wait also fires on `TURN_END_OPTIONAL_WAKES`, a harness-fixed set; an
 * in-snippet wait fires on whatever the model names.
 *
 * Every wait writes one `wake` trajectory record (`WakeRecord`) — what fired
 * and how long it slept — so a campaign can measure calls per hour and cost
 * per level from the record alone.
 */

import type { HarnessNotice } from "./sandbox/host";

/** The hard cap on any one wait, turn-end or in-snippet: five minutes. A constant, not a knob. */
export const WAKE_CAP_MS = 300_000;

/** The run's wake options. Absent on a run with both off, which is every run off this branch. */
export interface WakeOptions {
  turnEnd: boolean;
  inSnippet: boolean;
}

/** The wakes no wait can turn off. */
export const MANDATORY_WAKES = ["died", "streamClosed", "sandboxRestart", "notice"] as const;
export type MandatoryWake = (typeof MANDATORY_WAKES)[number];

/** The wakes a wait fires on only when asked. */
export const OPTIONAL_WAKES = ["levelUp", "questComplete", "attacked"] as const;
export type OptionalWake = (typeof OPTIONAL_WAKES)[number];

/**
 * The optional wakes a turn-end wait fires on. Fixed by the harness, because at
 * a turn end the model has no call to name keys with, and identical for every
 * model. Level-up and quest-complete are in it by the operator's decision
 * (operator, 2026-10-19); `attacked` is not.
 */
export const TURN_END_OPTIONAL_WAKES: readonly OptionalWake[] = ["levelUp", "questComplete"];

/** What the sandbox child observes and reports for the turn-end wait (`ipc.ts`, `wake_fact`). */
export type WakeFactKey = "died" | "streamClosed" | OptionalWake;

/** One observation the child pushed, numbered by the host as it arrived. */
export interface WakeFact {
  /** Host-assigned, strictly increasing: the cursor a wait reads from. */
  seq: number;
  key: WakeFactKey;
  ts: number;
  /** e.g. `level 5`, or the quest's title. Harness text only, never game chat. */
  detail?: string;
}

/** What ended a wait. `cap` is the five minutes; `stopped` is the run ending under it (a stop request, a watchdog). */
export type WakeFired = MandatoryWake | OptionalWake | "cap" | "stopped";

/** The `wake` trajectory record, one per wait. */
export type WakeRecord = {
  t: "wake";
  via: "turn-end" | "in-snippet";
  turn: number;
  fired: string;
  /** Wall clock from the turn's end (turn-end) or the call (in-snippet) to the wake. */
  sleptMs: number;
  /** The most the wait could have slept: the cap at a turn end, the call's `maxMs` in a snippet. */
  maxMs: number;
  detail?: string;
  /** The tool call an in-snippet wait was made in, as `tool_call.dispatchTs`. */
  callTs?: number;
};

/** The arm options as `run.ts` reads them; null when the run has none on. */
export function wakeOptionsOf(args: Readonly<Record<string, string | boolean>>): WakeOptions | null {
  const on = (flag: string): boolean => {
    const v = args[flag];
    if (v === undefined) return false;
    if (v === true || v === "true") return true;
    if (v === "false") return false;
    throw new Error(`--${flag} takes true or false, got ${JSON.stringify(v)}`);
  };
  const turnEnd = on("wake-turn-end");
  const inSnippet = on("wake-in-snippet");
  return turnEnd || inSnippet ? { turnEnd, inSnippet } : null;
}

/** The env value the sandbox child reads its options from (`entry.ts`); only ever set when one is on. */
export function wakeEnvValue(w: WakeOptions): string {
  return [w.turnEnd ? "turn-end" : null, w.inSnippet ? "in-snippet" : null].filter((x) => x !== null).join(",");
}

/** The env variable `wakeEnvValue` is passed in. Never in `SANDBOX_FORWARDED_ENV`: the host sets it explicitly or not at all. */
export const WAKE_ENV = "WRATHBENCH_WAKE";

/**
 * The claude-code CLI's per-call MCP tool timeout on a run with the in-snippet
 * wait, so a `run_snippet` held open for the full cap is not cut short by
 * whatever the CLI's default is: the cap, the snippet limit and a restart's
 * margin, rounded up to ten minutes. Nothing on any other run: the CLI's env is
 * the one it always had. (The CLI's stdio idle timeout is 30 minutes, well
 * above any held call, so no progress pings are needed.)
 */
export function wakeEnv(w: WakeOptions | undefined): Record<string, string> {
  return w?.inSnippet === true ? { MCP_TOOL_TIMEOUT: String(2 * WAKE_CAP_MS) } : {};
}

/**
 * The codex CLI's `tool_timeout_sec`: 300 as it always was, and on a run with
 * the in-snippet wait that plus the cap, since a held snippet can take the
 * cap plus its own limit.
 */
export function codexToolTimeoutSec(w: WakeOptions | undefined): number {
  return w?.inSnippet === true ? 300 + WAKE_CAP_MS / 1000 : 300;
}

/** `wakeEnvValue`, read back by the child; null when unset or naming neither option. */
export function wakeOptionsFromEnv(v: string | undefined): WakeOptions | null {
  if (v === undefined || v.length === 0) return null;
  const words = v.split(",");
  const w = { turnEnd: words.includes("turn-end"), inSnippet: words.includes("in-snippet") };
  return w.turnEnd || w.inSnippet ? w : null;
}

const WAKE_WORDS: Record<MandatoryWake | OptionalWake, string> = {
  died: "your character dying",
  streamClosed: "the event stream closing",
  sandboxRestart: "a sandbox restart",
  notice: "a harness notice",
  levelUp: "a level gained",
  questComplete: "a quest's objectives completed",
  attacked: "a unit starting to attack you",
};

/**
 * The prompt's statement of what a reply without a tool call now does,
 * appended after the body's last line on a run with `turnEnd`. The operator's
 * words (operator, 2026-10-19), verbatim: it names every wake the turn-end
 * wait fires on, which `wake.test.ts` holds against `MANDATORY_WAKES` and
 * `TURN_END_OPTIONAL_WAKES`. Same bytes on every harness: on the CLI drivers a
 * reply without a tool call is what ends a turn.
 */
export const TURN_END_SENTENCE =
  "A reply without a tool call ends your turn and you sleep until something wakes you — your character dying, a level gained, a quest's objectives completed, the event stream closing, a sandbox restart or a harness notice — or five minutes pass; the next turn says which and how long you slept.";

/** `TURN_END_SENTENCE`. */
export function turnEndSentence(): string {
  return TURN_END_SENTENCE;
}

/** What each wake is called in the model-facing text: the `woke` notice, and the names `TURN_END_SENTENCE` lists. */
export function wakeWords(k: MandatoryWake | OptionalWake): string {
  return WAKE_WORDS[k];
}

/**
 * The prompt bullet for the in-snippet wait, placed after the `sleep` bullet
 * on a run with `inSnippet` (wording approved, operator, 2026-10-19). The full
 * entry is the wake variant of the SDK reference (`sdk/API-wake.md`).
 */
export const WAIT_BULLET =
  `- wait({ on, maxMs }) holds a snippet open past its time limit until what you name happens — up to five minutes of waiting per snippet, and maxMs (at most 300000, the default) per call. ` +
  `on is a wake name ("levelUp", "questComplete", "attacked"), an event opcode such as "WB_MOVE_RESULT", a promise (it wakes when the promise settles), a function returning true (checked on every event and every second), or an array of these; ` +
  `your character dying, the event stream closing and a harness notice always wake it. It resolves with { woke, waitedMs }, woke being what fired or "maxMs" — e.g. const r = await wait({ on: [trip, "levelUp"], maxMs: 240000 }). ` +
  `Its full entry is in the SDK reference under "## Waiting (wait)".`;

/** "4m 12s", "38s". */
export function formatSlept(ms: number): string {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

/**
 * The harness notice the turn after a turn-end wait carries (wording
 * approved, operator, 2026-10-19). None for `stopped`: the run is ending and
 * there is no next turn.
 */
export function wokeNotice(w: { fired: WakeFired; sleptMs: number; detail?: string | undefined }, ts: number): HarnessNotice | null {
  if (w.fired === "stopped") return null;
  const slept = formatSlept(w.sleptMs);
  if (w.fired === "cap") {
    return { ts, kind: "woke", text: `you slept ${slept} after ending your turn without a tool call; nothing woke you before the five-minute limit.` };
  }
  const what = WAKE_WORDS[w.fired];
  return {
    ts,
    kind: "woke",
    text: `you slept ${slept} after ending your turn without a tool call; woken by ${what}${w.detail !== undefined ? ` (${w.detail})` : ""}.`,
  };
}

/** Where a turn-end wait reads its wakes from: the sandbox host, as far as the waiter needs it. */
export interface WakeSource {
  /** Facts the child pushed with `seq` above the cursor (`SandboxHost.wakeFactsAfter`). Never spawns, never drains. */
  wakeFactsAfter(seq: number): readonly WakeFact[];
  /** The newest fact's `seq`, 0 before any. */
  readonly wakeFactSeq: number;
  /** Harness notices raised by the host so far, a counter: `drainNotices` is the state sample's, not the waiter's. */
  readonly noticesRaised: number;
  readonly totalRestarts: number;
}

/** The point a turn-end wait counts from, taken as the model request is sent. */
export interface WakeCursor {
  facts: number;
  notices: number;
  restarts: number;
}

export function wakeCursor(s: WakeSource): WakeCursor {
  return { facts: s.wakeFactSeq, notices: s.noticesRaised, restarts: s.totalRestarts };
}

/** How often the turn-end wait looks: often enough that a wake is never late by more than this. */
export const WAKE_TICK_MS = 1_000;

export interface TurnEndWaitOptions {
  source: WakeSource;
  /** Taken as the request was sent, so a wake that landed while the model was replying still counts. */
  cursor: WakeCursor;
  /** Optional wakes this wait fires on; `TURN_END_OPTIONAL_WAKES` on a run. */
  keys: readonly OptionalWake[];
  /** Notices the driver has queued for the next message itself (`provider_truncated`, a compaction ask). */
  queuedNotices: () => number;
  /** True once the run is ending: a stop request, a watchdog verdict, a driver's `done()`. */
  stopped: () => boolean;
  /** The floor: today's `stepIntervalMs`, slept first whatever happens. */
  minMs: number;
  capMs?: number;
  tickMs?: number;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

export interface TurnEndWake {
  fired: WakeFired;
  sleptMs: number;
  detail?: string;
}

/**
 * Wait at a turn end until a wake fires, the run stops or the cap passes.
 *
 * Reads only counters and the host's own fact list: it never drains the death
 * signals or the notices (those are the state sample's and the context
 * builder's, and stealing from them would lose records) and never starts a
 * sandbox. Mandatory wakes win over optional ones when both are pending.
 */
export async function waitForTurnEndWake(o: TurnEndWaitOptions): Promise<TurnEndWake> {
  const cap = o.capMs ?? WAKE_CAP_MS;
  const tick = o.tickMs ?? WAKE_TICK_MS;
  const start = o.now();
  const slept = (): number => o.now() - start;
  await o.sleep(Math.min(o.minMs, cap));
  for (;;) {
    if (o.stopped()) return { fired: "stopped", sleptMs: slept() };
    const hit = pendingWake(o);
    if (hit !== null) return { ...hit, sleptMs: slept() };
    const left = cap - slept();
    if (left <= 0) return { fired: "cap", sleptMs: slept() };
    await o.sleep(Math.min(tick, left));
  }
}

/** The wake already pending against the cursor, mandatory first, or null. */
function pendingWake(o: Pick<TurnEndWaitOptions, "source" | "cursor" | "keys" | "queuedNotices">): { fired: WakeFired; detail?: string } | null {
  const facts = o.source.wakeFactsAfter(o.cursor.facts);
  const died = facts.find((f) => f.key === "died");
  if (died !== undefined) return withDetail("died", died.detail);
  if (o.source.totalRestarts !== o.cursor.restarts) return { fired: "sandboxRestart" };
  const closed = facts.find((f) => f.key === "streamClosed");
  if (closed !== undefined) return withDetail("streamClosed", closed.detail);
  if (o.source.noticesRaised !== o.cursor.notices || o.queuedNotices() > 0) return { fired: "notice" };
  const asked = facts.find((f) => f.key !== "died" && f.key !== "streamClosed" && o.keys.includes(f.key));
  return asked === undefined ? null : withDetail(asked.key, asked.detail);
}

function withDetail(fired: WakeFired, detail: string | undefined): { fired: WakeFired; detail?: string } {
  return detail === undefined ? { fired } : { fired, detail };
}

/**
 * The turn boundary on a run with the turn-end wake, the same for every
 * driver: wait (`waitForTurnEndWake`), write the record, and queue the `woke`
 * notice for the next message. Replaces the driver's `sleep(stepIntervalMs)`
 * after a reply with no tool call and nowhere else.
 */
export async function sleepUntilWoken(o: {
  source: WakeSource;
  cursor: WakeCursor;
  /** The driver's notice queue for the next message: read for queued notices, and given the `woke` one. */
  pendingNotices: HarnessNotice[];
  stopped: () => boolean;
  stepIntervalMs: number;
  turn: number;
  append: (record: WakeRecord) => void;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  tickMs?: number;
}): Promise<TurnEndWake> {
  const woke = await waitForTurnEndWake({
    source: o.source,
    cursor: o.cursor,
    keys: TURN_END_OPTIONAL_WAKES,
    queuedNotices: () => o.pendingNotices.length,
    stopped: o.stopped,
    minMs: o.stepIntervalMs,
    now: o.now,
    sleep: o.sleep,
    ...(o.tickMs !== undefined ? { tickMs: o.tickMs } : {}),
  });
  o.append(turnEndRecord(o.turn, woke));
  const notice = wokeNotice(woke, o.now());
  if (notice !== null) o.pendingNotices.push(notice);
  return woke;
}

/** The record a turn-end wait writes. */
export function turnEndRecord(turn: number, w: TurnEndWake): WakeRecord {
  return {
    t: "wake",
    via: "turn-end",
    turn,
    fired: w.fired,
    sleptMs: w.sleptMs,
    maxMs: WAKE_CAP_MS,
    ...(w.detail !== undefined ? { detail: w.detail } : {}),
  };
}
