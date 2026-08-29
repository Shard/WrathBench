/**
 * Sandbox child process. Spawned by `host.ts` with an IPC channel; holds the
 * one long-lived SDK client for the session and evaluates snippets against it.
 *
 * ### What a snippet sees (the whole ambient surface, documented once, here)
 *
 *   sdk         the WrathClient for this session (constructed, not connected)
 *   state       alias for sdk.state (the StateCache)
 *   events      alias for sdk.events (the EventStream)
 *   connect()   open the event stream (idempotent); call before createSession
 *   sleep(ms, options?)  Promise timer that resolves with why it woke:
 *               "elapsed", or early with "attacked" (a unit started attacking
 *               us) or "died" (our health reached zero, transition only).
 *               `{ wake: false }` is a pure timer. Rejects with the abort
 *               reason if this snippet is abandoned
 *   signal      AbortSignal for the *current* snippet; fires when the host
 *               abandons it (timeout). Every SDK wait honors it by default.
 *   scratchpad  { read(), write(content), append(text) } — the run's markdown
 *               scratchpad, bridged to the host process which owns the file
 *   API_MD_PATH absolute path to the generated SDK reference (sdk/API.md);
 *               read it with `await Bun.file(API_MD_PATH).text()`, in slices
 *   setTimeout / setInterval / clearInterval / …  the normal timers; routines
 *               started here keep running between snippets
 *
 * Top-level `const`/`let`/`var`/`function`/`class` declarations persist across
 * snippets (copied onto globalThis after each evaluation — see rewrite.ts for
 * the exact mechanics and limitations). `import` is not available.
 *
 * ### Network posture — stated honestly
 *
 * The real boundary is topology: the compose runner service can only reach
 * `worldserver` on the wrathbench network. In-process we additionally replace
 * `fetch` and `WebSocket` with versions that refuse any host other than the
 * module's. That is best-effort hardening against accidental egress, not a
 * security boundary — a snippet is trusted exactly as far as the network lets
 * it reach, which is the module and nothing else.
 *
 * ### Timeouts
 *
 * The per-snippet timeout lives in the host. A timed-out evaluation is
 * abandoned (its eventual result discarded) but the runtime, its bindings and
 * its routines survive. Abandonment is cooperative (FOLLOW-UPS 44): each eval
 * runs under its own AbortController, reachable as `signal` and threaded into
 * the SDK client through AsyncLocalStorage, so the waits the abandoned code
 * left behind (`moveTo`, `killTarget`, `waitForTransfer`, …) reject with
 * `EventAbortedError` and an in-flight move is stopped. Code the snippet
 * launched without awaiting shares its async context and therefore its
 * signal: a routine started by a snippet that later times out is aborted with
 * it; one started by a snippet that returned normally is never aborted.
 * A snippet that blocks the event loop makes this process unresponsive to
 * pings; the host kills and respawns it, and the state loss is surfaced to
 * the model as a harness notice.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { WrathClient } from "@wrathbench/sdk";
import { compileSnippet } from "./rewrite";
import { toJsonSafe } from "../jsonsafe";
import { foldUiOpenWindows, PLAYER_FLAGS_GHOST } from "../context";
import type { ActionHintNote, ChildToHost, DeathSignal, EventSummary, HostToChild, HostcallResult, LogEntry, MoveIntentNote } from "./ipc";

const MODULE_URL = process.env["WRATHBENCH_MODULE_URL"] ?? "http://worldserver:8086";
// The host always passes WRATHBENCH_TOKEN; the fallback only covers running
// this file by hand, and is random rather than a fixed `"dev"` so it can never
// collide with — or be guessed alongside — a real run's session (FOLLOW-UPS 19).
const TOKEN = process.env["WRATHBENCH_TOKEN"] ?? randomBytes(16).toString("hex");
// The fleet-assigned game account, bound onto the client so a snippet cannot
// pass (or omit) an account and land on the wrong one. Empty means
// unbound (standalone / running this file by hand): the client keeps its prior
// account behavior.
const ACCOUNT_ENV = process.env["WRATHBENCH_ACCOUNT"];
const ACCOUNT = ACCOUNT_ENV !== undefined && ACCOUNT_ENV.length > 0 ? ACCOUNT_ENV : undefined;
const VALUE_MAX_CHARS = 4_000;
const LOG_MAX_CHARS = 4_000;

const send = (msg: ChildToHost): void => {
  // Bun provides process.send when spawned with ipc; absent means we were run
  // directly (debugging) — print instead of crashing.
  const s = (process as unknown as { send?: (m: unknown) => void }).send;
  if (s) s.call(process, msg);
  else console.error("[sandbox] (no ipc)", JSON.stringify(msg).slice(0, 400));
};

// ------------------------------------------------------------ network guard

const allowedHosts = new Set<string>();
try {
  allowedHosts.add(new URL(MODULE_URL).host);
} catch {
  // leave empty; everything refused, which is the safe direction
}

const realFetch = globalThis.fetch;
type FetchInput = Parameters<typeof fetch>[0];
const guardedFetch = ((input: FetchInput, init?: RequestInit): Promise<Response> => {
  const url = new URL(
    typeof input === "string" || input instanceof URL ? String(input) : (input as Request).url,
  );
  if (!allowedHosts.has(url.host)) {
    return Promise.reject(
      new Error(`sandbox: network egress to ${url.host} is not permitted (module only)`),
    );
  }
  return realFetch(input, init);
}) as typeof fetch;
globalThis.fetch = guardedFetch;

const RealWebSocket = globalThis.WebSocket;
class GuardedWebSocket extends RealWebSocket {
  constructor(url: string | URL, protocols?: string | string[]) {
    const host = new URL(String(url)).host;
    if (!allowedHosts.has(host)) {
      throw new Error(`sandbox: WebSocket to ${host} is not permitted (module only)`);
    }
    super(url, protocols);
  }
}
globalThis.WebSocket = GuardedWebSocket as unknown as typeof WebSocket;

// ------------------------------------------------------- movement intention

/**
 * Where the character is trying to get to: the destination of the current or
 * last `move_to`, watched at the SDK's own HTTP call rather than inside the SDK.
 *
 * The wire request is the honest place to read it. By the time the client POSTs
 * `/action`, a unit, a guid or a name has already been resolved to the point
 * the module is actually asked to walk to — so nothing here re-implements
 * `resolveMoveTarget`, and a `moveToAsync` the snippet never awaits is watched
 * on exactly the same path as an awaited `moveTo`. The verdict comes from the
 * `WB_MOVE_RESULT` the module sends, so a move that is superseded, stopped or
 * refused terminates instead of being drawn as in flight forever.
 *
 * One slot: the module runs one move at a time per session, and a newer
 * dispatch is what supersedes an older one.
 */
let moveIntent: MoveIntentNote | null = null;

/**
 * Verdicts whose `moveId` no intent has learned yet, kept until the POST that
 * carries it answers. An immediate refusal (`target_off_mesh`) lands on the
 * event stream while the ack is still in flight, and dropping it would leave
 * that move drawn as if it were still walking.
 */
const earlyVerdicts = new Map<number, { status: string; ts: number }>();
const EARLY_VERDICT_MAX = 8;

function settleMoveIntent(moveId: number, status: string, ts: number): void {
  if (moveIntent !== null && moveIntent.moveId === moveId) {
    moveIntent.status = status;
    moveIntent.endedAt = ts;
    return;
  }
  earlyVerdicts.set(moveId, { status, ts });
  for (const key of earlyVerdicts.keys()) {
    if (earlyVerdicts.size <= EARLY_VERDICT_MAX) break;
    earlyVerdicts.delete(key);
  }
}

/** The `move_to` body the SDK is about to POST, as a fresh intent. Null for anything else. */
function noteMoveDispatch(body: unknown): MoveIntentNote | null {
  if (typeof body !== "object" || body === null) return null;
  const b = body as Record<string, unknown>;
  if (b["action"] !== "move_to") return null;
  const { x, y, z } = b;
  if (typeof x !== "number" || typeof y !== "number" || typeof z !== "number") return null;
  const pos = client.state.self.position?.value as { map?: unknown } | undefined;
  const guid = typeof b["guid"] === "string" ? b["guid"] : undefined;
  // The unit the move was aimed at, when it was aimed at one: the guid rides
  // along as the module's planning hint, and the cache is what has its name.
  const target =
    guid === undefined ? null : (client.state.units().find((u) => u.guid === guid)?.name ?? null);
  const note: MoveIntentNote = {
    moveId: null,
    map: typeof pos?.map === "number" ? pos.map : null,
    x,
    y,
    z,
    target,
    status: null,
    ts: Date.now(),
    endedAt: null,
  };
  moveIntent = note;
  return note;
}

/**
 * `guardedFetch` plus the move watch. Passed to the client explicitly rather
 * than installed globally, so a snippet's own `fetch` is not read here.
 */
const watchedFetch = ((input: FetchInput, init?: RequestInit): Promise<Response> => {
  let note: MoveIntentNote | null = null;
  try {
    if (typeof init?.body === "string") note = noteMoveDispatch(JSON.parse(init.body));
  } catch {
    // Not JSON, or not ours to read: the request is untouched either way.
  }
  const res = guardedFetch(input, init);
  if (note === null) return res;
  return res.then(
    (r) => {
      // Learn the module's move id from the ack. `clone()` because the SDK
      // still has to read the same body.
      void r
        .clone()
        .json()
        .then((j: unknown) => {
          const id = (j as { moveId?: unknown } | null)?.moveId;
          if (typeof id !== "number" || moveIntent !== note) return;
          note.moveId = id;
          const early = earlyVerdicts.get(id);
          if (early !== undefined) {
            earlyVerdicts.delete(id);
            note.status = early.status;
            note.endedAt = early.ts;
          }
        })
        .catch(() => {});
      return r;
    },
    (err: unknown) => {
      // Nothing was dispatched, so there is no intention to draw.
      if (moveIntent === note) moveIntent = null;
      throw err;
    },
  );
}) as typeof fetch;

// ------------------------------------------------------------- console tap

const logBuf: LogEntry[] = [];
let lastEntry: LogEntry | null = null;
let lastEntryBase = "";
let lastEntryRepeats = 1;

/**
 * Append to the log buffer, collapsing consecutive identical lines into one
 * entry suffixed "×N". A background routine faulting in a tight loop used to
 * fill a snippet result with thousands of repeated lines (morning-laguna-2);
 * the collapse keeps the information and drops the bulk. A drain resets the
 * run (the collapsed entry is no longer in the buffer), so counts never span
 * two snippet results.
 */
function pushLog(level: LogEntry["level"], text: string): void {
  const t = text.slice(0, LOG_MAX_CHARS);
  if (
    lastEntry !== null &&
    logBuf[logBuf.length - 1] === lastEntry &&
    lastEntry.level === level &&
    lastEntryBase === t
  ) {
    lastEntryRepeats++;
    lastEntry.ts = Date.now();
    lastEntry.text = `${t} ×${lastEntryRepeats}`.slice(0, LOG_MAX_CHARS);
    return;
  }
  lastEntry = { level, ts: Date.now(), text: t };
  lastEntryBase = t;
  lastEntryRepeats = 1;
  logBuf.push(lastEntry);
  if (logBuf.length > 500) logBuf.splice(0, logBuf.length - 500);
}

const realConsole = { ...console };
for (const level of ["log", "info", "warn", "error", "debug"] as const) {
  console[level] = (...args: unknown[]): void => {
    const text = args
      .map((a) => (typeof a === "string" ? a : Bun.inspect(a, { depth: 4 })))
      .join(" ");
    pushLog(level, text);
    realConsole[level]?.(...args);
  };
}

function drainLogs(): LogEntry[] {
  return logBuf.splice(0, logBuf.length);
}

/**
 * The hint-bearing failures the SDK tallied while the last snippet ran. Drained
 * exactly once per snippet result (or per pong, for an abandoned one), so the
 * runner can render them whether or not the snippet kept the result objects.
 * Hints from a background routine ride the next snippet result.
 */
function drainHints(): ActionHintNote[] {
  return client.drainActionHints();
}

// -------------------------------------------------------- ambient snippet API

/** The eval whose async context we are in, if any. Set by `evaluate`. */
const evalContext = new AsyncLocalStorage<{ signal: AbortSignal; deadline?: number }>();
const currentSignal = (): AbortSignal | undefined => evalContext.getStore()?.signal;
/** When the host will abandon the snippet we are inside, if it said. */
const currentDeadline = (): number | undefined => evalContext.getStore()?.deadline;
/**
 * What the last abandoned eval learned as it unwound — set from an SDK error
 * that carried a `moveAbandon` sentence, drained by the liveness pong that
 * follows the abort. One slot: the host pings immediately after aborting, and
 * only the abandoned snippet is unwinding at that moment.
 */
let abandonNote: string | undefined;
/**
 * Resolves when the eval an `abort` just interrupted finishes unwinding. The
 * host sends `abort` then `ping` back-to-back; when both land in one IPC chunk
 * the pong would read `abandonNote` before the SDK rejection has climbed the
 * snippet's await chain to set it, and the note the abort learned is silently
 * lost. A snippet that ignores its signal never settles, so the pong's wait on
 * this is bounded (ABANDON_UNWIND_GRACE_MS), well under the host's pingGraceMs.
 */
let abandonUnwind: Promise<void> | undefined;
const abandonUnwindSettled = new Map<number, () => void>();
const ABANDON_UNWIND_GRACE_MS = 100;
/** Live controllers by eval id, for the host's `abort`. */
const evalControllers = new Map<number, AbortController>();

const client = new WrathClient({
  baseUrl: MODULE_URL,
  token: TOKEN,
  account: ACCOUNT,
  subscribeEvents: false,
  signal: currentSignal,
  deadline: currentDeadline,
  fetchImpl: watchedFetch,
});

// The module's verdict on a move, whoever issued it: an awaited `moveTo`
// resolves from the same event, and this sees the ones nothing awaited.
client.events.on("WB_MOVE_RESULT", (e) => {
  const d = e.data as { moveId?: unknown; status?: unknown } | null;
  if (typeof d?.moveId === "number" && typeof d.status === "string") {
    settleMoveIntent(d.moveId, d.status, typeof e.ts === "number" ? e.ts : Date.now());
  }
});

let hostcallId = 0;
const hostcallPending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

function hostcall(method: "scratchpad_read" | "scratchpad_write" | "scratchpad_append", params: { content?: string } = {}): Promise<unknown> {
  const id = ++hostcallId;
  return new Promise((resolve, reject) => {
    hostcallPending.set(id, { resolve, reject });
    send({ t: "hostcall", id, method, params });
  });
}

// The generated SDK reference (sdk/API.md), at a stable absolute path a snippet
// can read: `await Bun.file(API_MD_PATH).text()`. It is larger than one snippet
// result, so read it in slices (one `## ` section, or lines filtered by name).
// Resolved from this file's location — sdk and runner are sibling workspaces —
// rather than the cwd, which the child does not control.
const API_MD_PATH = join(import.meta.dir, "..", "..", "..", "sdk", "API.md");

/**
 * Why `sleep` resolves. `elapsed` is the timer; the other two are the world
 * interrupting a wait the model would want to react to.
 */
export type SleepReason = "elapsed" | "attacked" | "died";

/**
 * `sleep(ms)` — a timer that also wakes for the two things a sleeping snippet
 * most needs to hear about, and says which happened.
 *
 * Sleep is blind: nothing about `await sleep(28000)` notices a mob walking up
 * behind the character, and the trajectories are full of 28-second naps that
 * ended in a corpse. So the timer additionally resolves early when the server
 * says a unit started attacking *us* (`SMSG_ATTACKSTART` with our guid as the
 * victim) or when our own health is observed reaching zero, and the resolved
 * value names the reason. Ignoring the value costs nothing, and an early
 * resolve is harmless inside `Promise.race([routine, sleep(ms)])` — the race's
 * whole point is that the first settle wins.
 *
 * Two deliberate non-wakes:
 *   - `died` fires on the *transition* only. A snippet that sleeps while
 *     already dead (waiting out the corpse reclaim delay is the single most
 *     common long sleep in the runs) is not woken by the death it is already
 *     handling.
 *   - `{ wake: false }` is a pure timer for a caller that wants one.
 *
 * The ambient snippet signal still aborts it: an abandoned snippet's sleep
 * rejects rather than resolving.
 */
function sleep(ms: number, options?: { wake?: boolean }): Promise<SleepReason> {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) {
    const shown = ms === undefined ? "undefined" : typeof ms === "number" ? String(ms) : typeof ms;
    throw new TypeError(
      `sleep(ms) needs a non-negative number of milliseconds, got ${shown} — e.g. sleep(2000), ` +
        `or sleep(2000, { wake: false }) for a timer that ignores being attacked`,
    );
  }
  if (options !== undefined && (options === null || typeof options !== "object")) {
    throw new TypeError(`sleep(ms, options) needs an options object, got ${typeof options} — the only option is { wake }`);
  }
  const wakeOpt = options?.wake;
  if (wakeOpt !== undefined && typeof wakeOpt !== "boolean") {
    throw new TypeError(`sleep(ms, { wake }) needs a boolean, got ${typeof wakeOpt} — { wake: false } is a pure timer`);
  }

  return new Promise<SleepReason>((resolve, reject) => {
    const signal = currentSignal();
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const selfDead = (): boolean => client.state.self.health?.value.current === 0;
    // Already dead when the sleep started: this snippet is handling that death,
    // so only a *later* one wakes it.
    let deadAtLastCheck = selfDead();
    let offAttack: (() => void) | undefined;
    let offAny: (() => void) | undefined;

    const settle = (reason: SleepReason): void => {
      cleanup();
      resolve(reason);
    };
    function cleanup(): void {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      offAttack?.();
      offAny?.();
    }
    function onAbort(): void {
      cleanup();
      reject(signal?.reason);
    }
    const timer = setTimeout(() => settle("elapsed"), ms);
    signal?.addEventListener("abort", onAbort, { once: true });

    if (wakeOpt === false) return;
    // Registered after the client's own state fold (`onAny` handlers run in
    // registration order and the cache is the first one), so both of these see
    // a state cache that already has this event in it.
    offAttack = client.events.on("SMSG_ATTACKSTART", (e) => {
      const d = e.data as { victimGuid?: unknown };
      const me = client.state.self.guid;
      if (me !== undefined && typeof d?.victimGuid === "string" && d.victimGuid === me) settle("attacked");
    });
    offAny = client.events.onAny(() => {
      const dead = selfDead();
      if (!dead) {
        // Alive again (a reclaim, a resurrect): a later death is a new one.
        deadAtLastCheck = false;
        return;
      }
      if (!deadAtLastCheck) settle("died");
    });
  });
}

let eventsConnected = false;
const ambient: Record<string, unknown> = {
  sdk: client,
  state: client.state,
  events: client.events,
  API_MD_PATH,
  connect: async (): Promise<void> => {
    if (eventsConnected) return;
    await client.events.connect();
    eventsConnected = true;
  },
  sleep,
  scratchpad: {
    read: (): Promise<unknown> => hostcall("scratchpad_read"),
    write: (content: string): Promise<unknown> => hostcall("scratchpad_write", { content }),
    append: (text: string): Promise<unknown> => hostcall("scratchpad_append", { content: text }),
  },
};
Object.assign(globalThis, ambient);
// `signal` is per-eval, so it is a getter over the async context rather than a
// value: an abandoned snippet keeps seeing its own (aborted) signal after the
// next eval has started. The setter keeps a snippet's own `const signal = …`
// copy-back (rewrite.ts) from throwing; it has no effect.
Object.defineProperty(globalThis, "signal", {
  get: currentSignal,
  set: () => {},
  configurable: true,
  enumerable: true,
});

// ---------------------------------------------------------------- evaluate

const AsyncFunction = (async () => {}).constructor as new (...args: string[]) => (
  ...fnArgs: unknown[]
) => Promise<unknown>;

/**
 * The one-line wrapper `compileSnippet` puts above the user's source
 * (`const __wrathbench_snippet__ = async () => {\n`), so a transpiler
 * position's 1-based line N is the user's line N-1.
 */
const WRAPPER_LINE_OFFSET = 1;

interface BuildPosition {
  line?: number;
  column?: number;
  lineText?: string;
}

/** One transpiler diagnostic as a line the model can act on. */
function renderBuildMessage(err: { message?: string; position?: BuildPosition | null }): string {
  const msg = err.message ?? "parse error";
  const pos = err.position;
  if (pos == null || typeof pos.line !== "number") return msg;
  const line = Math.max(1, pos.line - WRAPPER_LINE_OFFSET);
  const col = typeof pos.column === "number" ? `:${pos.column}` : "";
  const text = typeof pos.lineText === "string" && pos.lineText.length > 0 ? ` — ${pos.lineText}` : "";
  return `${msg} at line ${line}${col}${text}`;
}

const BIGINT_STRINGIFY_RE = /serialize\s+(a\s+)?BigInt/i;

/**
 * Render a caught error for the model. Three cases earn special handling,
 * all observed misrendering in live runs:
 *   - Bun transpiler failures: an AggregateError whose message is literally
 *     "Parse error" — flatten the sub-errors with their positions instead
 *     (line numbers corrected for the compile wrapper).
 *   - a single BuildMessage (one parse error) — same, without the wrapper.
 *   - JSON.stringify on a bigint — keep the TypeError but name the fix.
 */
export function renderError(err: unknown): string {
  if (err instanceof AggregateError && Array.isArray(err.errors) && err.errors.length > 0) {
    const subs = err.errors.map((e) => renderBuildMessage(e as { message?: string; position?: BuildPosition }));
    return `${err.name}: ${err.message}\n${subs.map((s) => `  ${s}`).join("\n")}`;
  }
  if (err instanceof Error) {
    // A lone Bun BuildMessage (one parse error) carries a `position` too.
    const pos = (err as { position?: BuildPosition | null }).position;
    if (pos != null && typeof pos.line === "number") {
      return `${err.name}: ${renderBuildMessage(err as { message?: string; position?: BuildPosition })}`;
    }
    // SDK guids are plain strings, so only a bigint the snippet
    // itself conjured (a 123n literal) can reach this — still worth naming.
    if (err instanceof TypeError && BIGINT_STRINGIFY_RE.test(err.message)) {
      return (
        `${err.name}: ${err.message} — JSON.stringify throws on BigInt values; ` +
        `SDK guids are already plain strings, so convert your own bigints with ` +
        `String(x), template literals, or console.log directly`
      );
    }
    return `${err.name}: ${err.message}`;
  }
  return Bun.inspect(err).slice(0, 1_000);
}

// A timed-out evaluation's late result is discarded host-side (the host
// abandons the id), so the child always reports. What it does track is the
// eval's AbortController, so a host `abort` can fire the snippet's signal.
async function evaluate(id: number, code: string, deadline?: number): Promise<void> {
  const started = Date.now();
  const controller = new AbortController();
  evalControllers.set(id, controller);
  try {
    const compiled = compileSnippet(code);
    let fn: ((...args: unknown[]) => Promise<unknown>) | null = null;
    if (compiled.canTryExpression) {
      try {
        // Single-expression snippets get REPL semantics: their value comes back.
        fn = new AsyncFunction(compiled.expressionBody);
      } catch {
        fn = null;
      }
    }
    fn ??= new AsyncFunction(compiled.statementsBody);
    const run = fn;
    const value: unknown = await evalContext.run({ signal: controller.signal, deadline }, () =>
      run.call(globalThis),
    );
    const msg: ChildToHost = {
      t: "result",
      id,
      ok: true,
      logs: drainLogs(),
      hints: drainHints(),
      durationMs: Date.now() - started,
    };
    if (value !== undefined) msg.value = Bun.inspect(value, { depth: 4 }).slice(0, VALUE_MAX_CHARS);
    // A snippet whose completion value is a function defined a wrapper and then
    // never invoked it, so nothing it wrote actually ran: `north-mini-code`
    // wrapped all 120 of its snippets in `async () => { … }` and got a cheerful
    // `ok` plus `[AsyncFunction (anonymous)]` every time, never connecting to
    // the world at all. The harness will not call it for the model (repair
    // only what has exactly one reading, and "define a callback for later" is
    // a second one) — it says what it sees.
    if (typeof value === "function") {
      msg.hint =
        "the snippet returned a function it never called — call it (await fn()) or return its " +
        "result; nothing in that function body has run.";
    }
    send(msg);
  } catch (err) {
    // An aborted eval's result is discarded host-side, and with it the one
    // thing the abort knew: how far the move it interrupted had got. The SDK
    // hangs that sentence on the error as `moveAbandon`; keep it for the pong,
    // which is the only channel the model still sees.
    const carried = (err as { moveAbandon?: unknown }).moveAbandon;
    if (controller.signal.aborted && typeof carried === "string") abandonNote = carried;
    // An aborted eval's result is discarded host-side; its logs must not go
    // with it — leave them in the buffer for the liveness pong that follows.
    send({
      t: "result",
      id,
      ok: false,
      error: renderError(err),
      // As with the logs: an abandoned eval's result is discarded host-side, so
      // its hints must stay in the SDK's tally for the pong that follows.
      logs: controller.signal.aborted ? [] : drainLogs(),
      hints: controller.signal.aborted ? [] : drainHints(),
      durationMs: Date.now() - started,
    });
  } finally {
    evalControllers.delete(id);
    const settled = abandonUnwindSettled.get(id);
    if (settled !== undefined) {
      abandonUnwindSettled.delete(id);
      settled();
    }
  }
}

/** Host abandoned this eval: fire its signal. Idempotent; unknown ids are ignored. */
function abortEval(id: number): void {
  const controller = evalControllers.get(id);
  if (controller === undefined) return;
  evalControllers.delete(id);
  abandonUnwind = new Promise((resolve) => abandonUnwindSettled.set(id, resolve));
  controller.abort(new Error(`snippet abandoned by the harness (timeout); pending waits cancelled`));
}

// --------------------------------------------------------------------- rpc

// ------------------------------------------------------------ death watcher

/**
 * The death window, latched from the events that carry it.
 *
 * The host's state sample is the run's clock for milestones, and at 60s it is
 * far coarser than a death: die, `repop()`, walk to the Spirit Healer,
 * resurrect — the whole window closes in half a minute, and the state cache
 * keeps no residue afterwards (`SMSG_DEATH_RELEASE_LOC` with `map: -1` clears
 * the corpse, the graveyard and the reclaim delay). Three deaths in run
 * `fleet-sonnet-low-freeplay-sonnet-low-20260827-a2` were missed exactly that
 * way, one of them by a single second. So the transitions are read here, where
 * every event arrives, and the host drains what happened between its samples.
 *
 * The readings are the same ones the host's fallback window read uses, for the
 * same reasons: own `health` off the raw field record (the derived gauge is
 * withheld until `maxHealth` has been seen) and the ghost bit off `playerFlags`
 * exactly as the HUD reads it. Release and resurrect additionally have a
 * packet that says so outright — `SMSG_DEATH_RELEASE_LOC`, the graveyard on the
 * way in and the clear marker on the way out — and that is the primary trigger,
 * because `playerFlags` rides an update block that need not arrive with it.
 *
 * Registered after the client's own state fold (`onAny` runs in registration
 * order), so every reading below is of a cache that already holds this event.
 */
const DEATH_SIGNAL_CAP = 64;
const deathSignals: DeathSignal[] = [];
/** Own health last read as zero. */
let watchedDead = false;
/** The spirit is released: the ghost flag, or the graveyard packet that made it one. */
let watchedReleased = false;
/**
 * The ghost bit was actually seen set. Separate from `watchedReleased` because
 * `playerFlags` need not ride the blocks that arrive during a death: a stale 0
 * all the way through is ordinary, so only a bit that was seen *on* can be read
 * as meaning anything when it goes off again.
 */
let watchedGhost = false;

function pushDeathSignal(signal: DeathSignal): void {
  deathSignals.push(signal);
  if (deathSignals.length > DEATH_SIGNAL_CAP) deathSignals.splice(0, deathSignals.length - DEATH_SIGNAL_CAP);
}

/** Drain what the watcher latched since the last call. Host-only. */
function drainDeathSignals(): DeathSignal[] {
  return deathSignals.splice(0, deathSignals.length);
}

function point(v: unknown): { map: number; x: number; y: number; z: number } | undefined {
  const p = v as { map?: unknown; x?: unknown; y?: unknown; z?: unknown } | undefined;
  if (p === undefined || p === null) return undefined;
  if (typeof p.map !== "number" || typeof p.x !== "number" || typeof p.y !== "number" || typeof p.z !== "number") {
    return undefined;
  }
  return { map: p.map, x: p.x, y: p.y, z: p.z };
}

client.events.onAny((event) => {
  const self = client.state.self;
  const health = self.fields.get("health")?.value;
  const flags = self.fields.get("playerFlags")?.value;
  const ghost = typeof flags === "number" ? (flags & PLAYER_FLAGS_GHOST) !== 0 : undefined;
  const releaseLoc =
    event.opcode === "SMSG_DEATH_RELEASE_LOC" ? (event.data as { map?: unknown }) : undefined;
  // The window as it stood *before* this event: a resurrect is only ever read
  // against a window some earlier event opened, never against this one.
  const wasDead = watchedDead;
  const wasReleased = watchedReleased;
  const wasGhost = watchedGhost;
  const releasedTo = typeof releaseLoc?.map === "number" && releaseLoc.map >= 0;
  const cleared = typeof releaseLoc?.map === "number" && releaseLoc.map < 0;

  // The death: own health observed at zero, from a reading that was not.
  if (health === 0 && !watchedDead) {
    watchedDead = true;
    const corpse = self.corpse?.value as { source?: unknown } | undefined;
    const at = point(corpse);
    const source = corpse?.source === "corpse_query" ? "corpse_query" : corpse?.source === "death_spot" ? "death_spot" : undefined;
    const zone = (self.zone?.value as { id?: unknown } | undefined)?.id;
    const area = (self.area?.value as { id?: unknown } | undefined)?.id;
    pushDeathSignal({
      kind: "death",
      ts: event.ts,
      seq: event.seq,
      ...(at !== undefined && source !== undefined ? { position: { ...at, source } } : {}),
      ...(typeof zone === "number" ? { zone } : {}),
      ...(typeof area === "number" ? { area } : {}),
      ...(ghost === undefined ? {} : { released: ghost }),
    });
  }

  // The release: the graveyard packet, or the ghost flag turning on.
  if (ghost === true) watchedGhost = true;
  if (!watchedReleased && (releasedTo || ghost === true)) {
    watchedReleased = true;
    const grave = point(self.graveyard?.value);
    pushDeathSignal({
      kind: "release",
      ts: event.ts,
      seq: event.seq,
      ...(grave === undefined ? {} : { graveyard: grave }),
    });
  }

  // The resurrect: the clear marker, health back above the single point a
  // released ghost carries, or the ghost flag turning off again. Read against
  // the window as it stood before this event, so the event that opened the
  // window cannot also close it — an unreleased corpse reads `ghost === false`
  // too, and `playerFlags` is usually a stale 0 all through a death.
  const alive = cleared || (typeof health === "number" && health > 1) || (ghost === false && wasGhost);
  if ((wasDead || wasReleased) && alive) {
    watchedDead = false;
    watchedReleased = false;
    watchedGhost = false;
    pushDeathSignal({ kind: "resurrect", ts: event.ts, seq: event.seq });
  }
});

function recentEvents(limit: number): EventSummary[] {
  return client.events.recent(limit).map((e) => ({
    seq: e.seq,
    ts: e.ts,
    opcode: e.opcode,
    data: toJsonSafe(e.data, 5),
    schemaError:
      "schemaError" in e && e.schemaError !== undefined ? String(e.schemaError) : undefined,
  }));
}

/**
 * The state snapshot the host renders into the HUD (`formatStateSummary`).
 *
 * It is `StateCache.snapshot()` plus three derived views the HUD needs and the
 * raw snapshot does not expose flat: `units()` (nearest-first, items/containers
 * dropped — with mob health/maxHealth deliberately stripped, since CONTRACTS.md
 * forbids exact mob health and the HUD only needs name/distance/dead), `bag()`
 * (backpack shape with freeSlots), and the open-window fold over the retained
 * event stream. All three are pure reads over what the cache already holds — no
 * new observation. This JSON is consumed only by the HUD, never returned raw.
 */
function stateSnapshot(): unknown {
  const snap = toJsonSafe(client.state.snapshot(), 6) as Record<string, unknown>;
  const units = client.state.units().map((u) => ({
    guid: u.guid,
    name: u.name,
    type: u.type,
    level: u.level,
    distance: u.distance,
    dead: u.dead,
    roles: u.roles,
  }));
  snap["units"] = toJsonSafe(units, 4);
  snap["bag"] = toJsonSafe(client.state.bag(), 4);
  snap["ui"] = foldUiOpenWindows(client.events.recent());
  // Where the character is trying to get to (`moveIntent`). Not an observation
  // of the world — it is this session's own last dispatch — so it rides the
  // snapshot rather than the state cache, and the HUD never prints it.
  snap["move"] = moveIntent === null ? null : { ...moveIntent };
  return snap;
}

function handle(msg: HostToChild | HostcallResult): void {
  switch (msg.t) {
    case "eval":
      void evaluate(msg.id, msg.code, msg.deadline);
      return;
    case "abort":
      abortEval(msg.id);
      return;
    case "ping":
      // Pings carry any buffered console output home: the host pings after a
      // snippet times out, and this is how the abandoned snippet's logs reach
      // the model instead of `logs: []`.
      {
        const unwinding = abandonUnwind;
        abandonUnwind = undefined;
        const pong = (): void => {
          const note = abandonNote;
          abandonNote = undefined;
          send({
            t: "pong",
            id: msg.id,
            logs: drainLogs(),
            hints: drainHints(),
            ...(note !== undefined ? { note } : {}),
          });
        };
        if (unwinding === undefined) pong();
        else void Promise.race([unwinding, Bun.sleep(ABANDON_UNWIND_GRACE_MS)]).then(pong);
      }
      return;
    case "rpc": {
      try {
        const value =
          msg.method === "recent_events"
            ? recentEvents(msg.params.limit ?? 50)
            : msg.method === "death_signals"
              ? drainDeathSignals()
              : stateSnapshot();
        send({ t: "rpc_result", id: msg.id, ok: true, value });
      } catch (err) {
        send({ t: "rpc_result", id: msg.id, ok: false, error: String(err) });
      }
      return;
    }
    case "hostcall_result": {
      const pending = hostcallPending.get(msg.id);
      if (pending) {
        hostcallPending.delete(msg.id);
        if (msg.ok) pending.resolve(msg.value);
        else pending.reject(new Error(msg.error ?? "hostcall failed"));
      }
      return;
    }
    case "shutdown":
      try {
        client.close();
      } catch {
        // closing anyway
      }
      process.exit(0);
  }
}

process.on("message", (msg) => {
  handle(msg as HostToChild | HostcallResult);
});

process.on("disconnect", () => process.exit(0));

// ------------------------------------------------- survive background errors
//
// Bun's default policy kills the process on an unhandled rejection or uncaught
// exception. A snippet that fires an SDK call without awaiting it (seen in
// night-laguna-oc-1: `JSON.stringify(sdk.questList())`) turns a routine module
// error into a rejected promise nobody holds — and the whole runtime, with all
// its bindings and routines, died for it. Report instead: the error lands in
// the log buffer (so the next snippet result shows it) and as a fatal notice
// the host surfaces to the model.
//
// Storm control (morning-laguna-2: a routine throwing in a tight loop pushed
// 4,125 identical session notes — 12MB — into one trajectory): the first
// occurrence of a fault signature reports immediately; repeats aggregate into
// a rollup notice gated to at most one per FAULT_ROLLUP_INTERVAL_MS across
// all signatures; a signature that keeps faulting past
// FAULT_ESCALATION_THRESHOLD inside its window gets one distinct escalation
// notice telling the model its routine is broken and how to stop it. The
// sandbox is never killed for this — bindings are healthy; the model acts.

const FAULT_WINDOW_MS = Number(process.env["WRATHBENCH_FAULT_WINDOW_MS"] ?? 60_000);
const FAULT_ROLLUP_INTERVAL_MS = Number(process.env["WRATHBENCH_FAULT_ROLLUP_MS"] ?? 30_000);
const FAULT_ESCALATION_THRESHOLD = Number(process.env["WRATHBENCH_FAULT_ESCALATION_THRESHOLD"] ?? 50);
/** Max immediate first-reports across ALL signatures per window (see below). */
const FAULT_IMMEDIATE_CAP = Number(process.env["WRATHBENCH_FAULT_IMMEDIATE_CAP"] ?? 5);
/** Cap on distinct signatures tracked, so a varying-message loop can't grow the Map without bound. */
const FAULT_STATS_MAX = 500;

interface FaultStat {
  count: number;
  windowStart: number;
  escalated: boolean;
}
const faultStats = new Map<string, FaultStat>();
/** Faults per signature not yet covered by a notice, for the next rollup. */
const rollupPending = new Map<string, number>();
/** When the last background-fault notice of any kind was sent. Gates rollups. */
let lastFaultNoticeAt = 0;
/**
 * Global immediate-report budget. Storm control that only aggregates repeats of
 * the SAME signature was bypassed by a routine that rejects with a per-iteration
 * value (a new signature every time), each taking the count===1 immediate path —
 * reproducing the morning-laguna-2 trajectory bloat through a varying fault
 * shape. This caps first-reports across all signatures per window; once spent,
 * even a brand-new signature aggregates into the rollup. Escalation still fires
 * once per continuously-faulting signature.
 */
let immediateReports = 0;
let immediateWindowStart = 0;

/**
 * What makes two faults "the same": kind, error name, and the first stack
 * frame — not the message, which a loop can vary per iteration.
 */
function faultSignature(kind: string, reason: unknown): string {
  if (reason instanceof Error) {
    const stackLine =
      reason.stack
        ?.split("\n")
        .map((l) => l.trim())
        .find((l) => l.startsWith("at ")) ?? "";
    return `${kind}: ${reason.name}${stackLine.length > 0 ? ` (${stackLine})` : ""}`;
  }
  return `${kind}: ${Bun.inspect(reason).slice(0, 120)}`;
}

function reportBackgroundError(kind: string, reason: unknown): void {
  const now = Date.now();
  const text = reason instanceof Error ? renderError(reason) : Bun.inspect(reason, { depth: 4 }).slice(0, 1_000);
  pushLog("error", `[${kind}] ${text}`);

  const signature = faultSignature(kind, reason);
  let stat = faultStats.get(signature);
  if (stat === undefined || now - stat.windowStart > FAULT_WINDOW_MS) {
    stat = { count: 0, windowStart: now, escalated: false };
    // Bound the Map: a routine varying its fault message adds a new signature
    // each iteration, so evict the oldest rather than growing without bound.
    if (!faultStats.has(signature) && faultStats.size >= FAULT_STATS_MAX) {
      const oldest = faultStats.keys().next().value;
      if (oldest !== undefined) faultStats.delete(oldest);
    }
    faultStats.set(signature, stat);
  }
  stat.count++;

  // Roll the global immediate-report window.
  if (now - immediateWindowStart > FAULT_WINDOW_MS) {
    immediateWindowStart = now;
    immediateReports = 0;
  }

  // First occurrence of this signature (per window): report immediately, but
  // only while the global first-report budget for this window has room. Once
  // spent, a new signature falls through to the aggregated rollup path so a
  // varying-signature storm can't bypass the control.
  if (stat.count === 1 && immediateReports < FAULT_IMMEDIATE_CAP) {
    immediateReports++;
    realConsole.error?.(`[sandbox] ${kind}:`, text);
    send({ t: "fatal", error: `${kind} (sandbox survived; bindings and routines intact): ${text}` });
    lastFaultNoticeAt = now;
    return;
  }

  // Continuous faulting: one distinct escalation notice per signature.
  if (!stat.escalated && stat.count > FAULT_ESCALATION_THRESHOLD) {
    stat.escalated = true;
    rollupPending.delete(signature); // the escalation covers the backlog
    const secs = Math.max(1, Math.round((now - stat.windowStart) / 1000));
    const escalation =
      `background routine broken: ${signature} has faulted ${stat.count} times in the last ${secs}s. ` +
      `The sandbox is alive and your bindings are intact, but a background routine is failing in a tight ` +
      `loop — from your next snippet, stop it: clearInterval any timers you started, set the flags your ` +
      `loops check so they exit, then restart the routine with a try/catch inside it. ` +
      `Further identical faults will only be reported as periodic rollups.`;
    realConsole.error?.(`[sandbox] ${escalation}`);
    send({ t: "fatal", error: escalation });
    lastFaultNoticeAt = now;
    return;
  }

  // A repeat: aggregate, and roll up at most once per interval overall.
  rollupPending.set(signature, (rollupPending.get(signature) ?? 0) + 1);
  if (now - lastFaultNoticeAt >= FAULT_ROLLUP_INTERVAL_MS) {
    const summary = [...rollupPending.entries()].map(([sig, n]) => `${sig} ×${n}`).join("; ");
    rollupPending.clear();
    const rollup = `background faults continuing (aggregated; sandbox alive): ${summary} since the last report`;
    realConsole.error?.(`[sandbox] ${rollup}`);
    send({ t: "fatal", error: rollup });
    lastFaultNoticeAt = now;
  }
}

process.on("unhandledRejection", (reason) => {
  reportBackgroundError("unhandled promise rejection", reason);
});

process.on("uncaughtException", (err) => {
  reportBackgroundError("uncaught exception", err);
});

send({ t: "ready" });
