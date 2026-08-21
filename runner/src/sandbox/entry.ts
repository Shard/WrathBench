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
 *   sleep(ms)   Promise timer
 *   scratchpad  { read(), write(content), append(text) } — the run's markdown
 *               scratchpad, bridged to the host process which owns the file
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
 * its routines survive. A snippet that blocks the event loop makes this
 * process unresponsive to pings; the host kills and respawns it, and the state
 * loss is surfaced to the model as a harness notice.
 */

import { WrathClient } from "@wrathbench/sdk";
import { compileSnippet } from "./rewrite";
import { toJsonSafe } from "../jsonsafe";
import type { ChildToHost, EventSummary, HostToChild, HostcallResult, LogEntry } from "./ipc";

const MODULE_URL = process.env["WRATHBENCH_MODULE_URL"] ?? "http://worldserver:8086";
const TOKEN = process.env["WRATHBENCH_TOKEN"] ?? "dev";
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

// ------------------------------------------------------------- console tap

const logBuf: LogEntry[] = [];
const realConsole = { ...console };
for (const level of ["log", "info", "warn", "error", "debug"] as const) {
  console[level] = (...args: unknown[]): void => {
    const text = args
      .map((a) => (typeof a === "string" ? a : Bun.inspect(a, { depth: 4 })))
      .join(" ")
      .slice(0, LOG_MAX_CHARS);
    logBuf.push({ level, ts: Date.now(), text });
    if (logBuf.length > 500) logBuf.splice(0, logBuf.length - 500);
    realConsole[level]?.(...args);
  };
}

function drainLogs(): LogEntry[] {
  return logBuf.splice(0, logBuf.length);
}

// -------------------------------------------------------- ambient snippet API

const client = new WrathClient({ baseUrl: MODULE_URL, token: TOKEN, subscribeEvents: false });

let hostcallId = 0;
const hostcallPending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

function hostcall(method: "scratchpad_read" | "scratchpad_write" | "scratchpad_append", params: { content?: string } = {}): Promise<unknown> {
  const id = ++hostcallId;
  return new Promise((resolve, reject) => {
    hostcallPending.set(id, { resolve, reject });
    send({ t: "hostcall", id, method, params });
  });
}

let eventsConnected = false;
const ambient: Record<string, unknown> = {
  sdk: client,
  state: client.state,
  events: client.events,
  connect: async (): Promise<void> => {
    if (eventsConnected) return;
    await client.events.connect();
    eventsConnected = true;
  },
  sleep: (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms)),
  scratchpad: {
    read: (): Promise<unknown> => hostcall("scratchpad_read"),
    write: (content: string): Promise<unknown> => hostcall("scratchpad_write", { content }),
    append: (text: string): Promise<unknown> => hostcall("scratchpad_append", { content: text }),
  },
};
Object.assign(globalThis, ambient);

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
    if (err instanceof TypeError && BIGINT_STRINGIFY_RE.test(err.message)) {
      return (
        `${err.name}: ${err.message} — guids are bigints and JSON.stringify throws on them; ` +
        `use String(guid), template literals, or console.log directly`
      );
    }
    return `${err.name}: ${err.message}`;
  }
  return Bun.inspect(err).slice(0, 1_000);
}

// A timed-out evaluation's late result is discarded host-side (the host
// abandons the id), so the child always reports and never tracks abandonment.
async function evaluate(id: number, code: string): Promise<void> {
  const started = Date.now();
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
    const value: unknown = await fn.call(globalThis);
    const msg: ChildToHost = {
      t: "result",
      id,
      ok: true,
      logs: drainLogs(),
      durationMs: Date.now() - started,
    };
    if (value !== undefined) msg.value = Bun.inspect(value, { depth: 4 }).slice(0, VALUE_MAX_CHARS);
    send(msg);
  } catch (err) {
    send({
      t: "result",
      id,
      ok: false,
      error: renderError(err),
      logs: drainLogs(),
      durationMs: Date.now() - started,
    });
  }
}

// --------------------------------------------------------------------- rpc

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

function handle(msg: HostToChild | HostcallResult): void {
  switch (msg.t) {
    case "eval":
      void evaluate(msg.id, msg.code);
      return;
    case "ping":
      // Pings carry any buffered console output home: the host pings after a
      // snippet times out, and this is how the abandoned snippet's logs reach
      // the model instead of `logs: []`.
      send({ t: "pong", id: msg.id, logs: drainLogs() });
      return;
    case "rpc": {
      try {
        const value =
          msg.method === "recent_events"
            ? recentEvents(msg.params.limit ?? 50)
            : toJsonSafe(client.state.snapshot(), 6);
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

function reportBackgroundError(kind: string, reason: unknown): void {
  const text = reason instanceof Error ? renderError(reason) : Bun.inspect(reason, { depth: 4 }).slice(0, 1_000);
  logBuf.push({ level: "error", ts: Date.now(), text: `[${kind}] ${text}`.slice(0, LOG_MAX_CHARS) });
  if (logBuf.length > 500) logBuf.splice(0, logBuf.length - 500);
  realConsole.error?.(`[sandbox] ${kind}:`, text);
  send({ t: "fatal", error: `${kind} (sandbox survived; bindings and routines intact): ${text}` });
}

process.on("unhandledRejection", (reason) => {
  reportBackgroundError("unhandled promise rejection", reason);
});

process.on("uncaughtException", (err) => {
  reportBackgroundError("uncaught exception", err);
});

send({ t: "ready" });
