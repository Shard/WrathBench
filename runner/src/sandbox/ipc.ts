/**
 * IPC message shapes between the sandbox host and the sandbox child process.
 * Transport is Bun's built-in `ipc` channel on `Bun.spawn` (JSON
 * serialization), so everything here must survive JSON.
 */

/**
 * A hint-bearing failure the SDK recorded, tallied per (action, status). The
 * hint rides inside the result object too, but a snippet that keeps only
 * `.status` drops it (run a11: 41 `too_far`, hint read 0 times), so the harness
 * carries it home itself. Mirrors `ActionHint` from the SDK; redeclared here
 * because everything on this channel must survive JSON.
 */
export interface ActionHintNote {
  action: string;
  status: string;
  count: number;
  hint: string;
  point?: { x: number; y: number; z: number };
  ts: number;
}

/**
 * A death-window transition the child latched the moment the event carrying it
 * arrived, rather than the moment the host next sampled.
 *
 * The host samples every `stateIntervalMs` (60s in the fleet); an entire death,
 * release and spirit-healer resurrection fits inside 30 seconds, so the sampled
 * window read misses whole deaths (run
 * `fleet-sonnet-low-freeplay-sonnet-low-20260827-a2`: three deaths, none
 * recorded). The child sees every event, so the transition is latched there and
 * drained from here; `ts` is the event's own timestamp, which is when the thing
 * happened.
 */
export interface DeathSignal {
  kind: "death" | "release" | "resurrect";
  /** The timestamp of the event that carried the transition. */
  ts: number;
  /** That event's stream seq, for correlation with the event log. */
  seq: number;
  /** Death only: the corpse as the cache held it at that instant. */
  position?: { map: number; x: number; y: number; z: number; source: "corpse_query" | "death_spot" };
  /** Release only: the graveyard the spirit was released to. */
  graveyard?: { map: number; x: number; y: number; z: number };
  /** Death only: the zone/area ids at the moment of death. */
  zone?: number;
  area?: number;
  /** Death only: the ghost flag as it read at that instant (usually false). */
  released?: boolean;
}

/**
 * Where the character is trying to get to: the destination of the current or
 * last `move_to` this session dispatched, and what became of it.
 *
 * Captured at the sandbox boundary rather than inside the SDK, from the
 * `POST /action` the client makes and the `WB_MOVE_RESULT` that answers it —
 * the destination the module was actually asked for, after the SDK resolved a
 * unit or a name to a point. It rides the `state_summary` snapshot, so the
 * runner's state ticker sees it on the 5s tick rather than on the (60s) row
 * cadence: a walk of ~250y is over inside one row interval, and an intention
 * only sampled at row cadence would be an intention nobody could see.
 */
export interface MoveIntentNote {
  /** The module's move id, once the POST answered. Null while the ack is in flight. */
  moveId: number | null;
  /** The map the character stood on when the move was dispatched, when observed. */
  map: number | null;
  x: number;
  y: number;
  z: number;
  /** The name of the unit the move was aimed at, when it was aimed at one. */
  target: string | null;
  /** The module's verdict (`arrived`, `too_far`, …); null while the move is in flight. */
  status: string | null;
  /** When the move was dispatched. */
  ts: number;
  /** When the verdict arrived; null while the move is in flight. */
  endedAt: number | null;
}

export interface LogEntry {
  level: "log" | "info" | "warn" | "error" | "debug";
  ts: number;
  text: string;
}

/**
 * A line of the entrypoint program's console: `repeats` is how many times it
 * was printed in a row (absent for once), `ts` the last of them. The count is
 * kept apart from the text so the wake log can go on folding a line printed
 * once per tick across the reports it spans.
 */
export interface ProgramLogEntry extends LogEntry {
  repeats?: number;
}

// host -> child
export type HostToChild =
  /**
   * `deadline` is the epoch-ms instant this eval will be abandoned — the host
   * owns the snippet budget, so the host is what names it. The child threads it
   * into the SDK client, which uses it for explanation only (a `moveTo` result
   * whose walk was always longer than the budget says so in its `hint`); no
   * wait is ever shortened or refused because of it.
   */
  | { t: "eval"; id: number; code: string; deadline?: number }
  | { t: "ping"; id: number }
  /** Abort the eval with this id: fires its `signal`, so SDK waits it left behind settle. */
  | { t: "abort"; id: number }
  | {
      t: "rpc";
      id: number;
      method: "recent_events" | "state_summary" | "death_signals" | ProgramRpcMethod;
      params: {
        limit?: number;
        /** `program_deploy`: the import version to load main.ts at, and the number the deploy gets. */
        version?: number;
        deploy?: number;
      };
    }
  /**
   * An importable workspace file changed (a write, edit or delete of a code or
   * JSON file, from a tool or from this child's own hostcall): the next
   * workspace import must load fresh modules. Edits to notes.md and other text
   * send nothing. Sent before the reply to the hostcall that caused it.
   */
  | { t: "workspace_version"; version: number }
  | { t: "shutdown" };

/** The workspace operations a snippet's `files` object makes over the hostcall channel. */
export type HostcallMethod = "files_read" | "files_write" | "files_edit" | "files_delete" | "files_list";

/**
 * Arguments as the snippet passed them. Deliberately untyped past the JSON
 * boundary: a snippet can pass anything, and the host's `Workspace` is what
 * refuses a wrong type, with the same sentence the tools give.
 */
export interface HostcallParams {
  path?: unknown;
  content?: unknown;
  old_string?: unknown;
  new_string?: unknown;
  replace_all?: unknown;
}

export interface EvalResultMsg {
  t: "result";
  id: number;
  ok: boolean;
  /** Bun.inspect rendering of the completion value; absent when undefined. */
  value?: string;
  /** Error rendering when ok is false. */
  error?: string;
  /**
   * A note about the completion value itself, rendered under it. Today the one
   * case is a snippet whose value is a function it never called (the harness
   * explains, it does not act).
   */
  hint?: string;
  /** console output drained since the previous result (includes background logs). */
  logs: LogEntry[];
  /**
   * Hint-bearing failures the SDK recorded while this snippet ran, drained here
   * so the runner can render them whatever the snippet kept. Empty on an
   * abandoned eval — the host discards its result, so those ride the pong.
   */
  hints?: ActionHintNote[];
  durationMs: number;
}

export interface EventSummary {
  seq: number;
  ts: number;
  opcode: string;
  /** JSON-safe, depth-limited data. */
  data: unknown;
  schemaError?: string | undefined;
}

// child -> host
export type ChildToHost =
  | { t: "ready" }
  | EvalResultMsg
  /**
   * `note` carries what the abandoned eval learned on its way out — today, the
   * distance an in-flight `moveTo` had covered and had left — so the host's
   * abandon message can state it. Absent when the abort taught us nothing.
   */
  | { t: "pong"; id: number; logs?: LogEntry[]; note?: string; hints?: ActionHintNote[] }
  | { t: "rpc_result"; id: number; ok: boolean; value?: unknown; error?: string }
  | { t: "hostcall"; id: number; method: HostcallMethod; params: HostcallParams }
  | { t: "fatal"; error: string }
  /**
   * Entrypoint loop: `memory` serialized after a tick, handler or snippet that
   * changed it — already checked against its limit and for plain JSON. The host
   * writes it to memory.json; the child never writes the workspace.
   */
  | { t: "memory"; json: string };

// ------------------------------------------------------ the entrypoint program

/**
 * The entrypoint loop's program calls (a probing spike), over the rpc channel:
 * load main.ts at an import version, stop it, and drain what it did since the
 * last drain. The drain doubles as the host's liveness check while the loop is
 * entrypoint: a child that cannot answer it has blocked its event loop.
 */
export type ProgramRpcMethod = "program_deploy" | "program_unload" | "program_report";

/**
 * What a deploy answered. The previous deploy keeps running when `ok` is
 * false. `warnings` (absent when there are none) name `on` keys that are not
 * event names: the deploy loaded, and those handlers are never called.
 */
export type DeployAnswer =
  | { ok: true; deploy: number; exports: string[]; warnings?: string[] }
  | { ok: false; deploy: number; error: string };

/**
 * One error signature: which hook, the error's name, and the first stack frame
 * inside the workspace — or, for a failed `sdk` call, which hook, the helper,
 * and the status or error name. `count` is how many times it happened since
 * the last report; `isNew` marks the report that carries its first occurrence
 * in this deploy, which is the one that wakes the model. An `outcome` (an
 * `sdk` call that answered `ok: false`) is never new: it is counted and shown,
 * and wakes no one.
 */
export interface ProgramErrorNote {
  signature: string;
  /** `loop()`, `on.SMSG_X`, `events.on(SMSG_X)`, `memory`, `unhandled rejection`, `load`. */
  hook: string;
  /**
   * `failed`: an `sdk` call from the program threw or rejected — caught by the
   * program or not. `outcome`: an `sdk` call from the program answered
   * `ok: false`, which never wakes the model. `thrown`: every other signature
   * — a throw or rejection out of a hook, an overrun, a memory that could not
   * be loaded or saved.
   */
  kind: "thrown" | "failed" | "outcome";
  /** The error as the model reads it: name, message, up to four workspace frames. */
  text: string;
  count: number;
  isNew: boolean;
  /** The deploy it happened in; null for one with no program running (a snippet's memory). */
  deploy: number | null;
  firstTs: number;
  lastTs: number;
}

/** `ctx.wake(reason)` calls since the last report, one row per reason. */
export interface WakeRequestNote {
  reason: string;
  /** The hook that asked: `loop()`, `on.SMSG_X`. */
  from: string;
  count: number;
  firstTs: number;
  lastTs: number;
}

/** A fact the child saw happen: a level gained, a quest turned in, a death. Each once. */
export interface ProgramMilestoneNote {
  fact: "level" | "quest" | "death";
  ts: number;
  level?: number;
  questId?: number;
}

/** Everything the program did since the last report. */
export interface ProgramReport {
  /** The deploy running now, or null. */
  deploy: number | null;
  ticks: number;
  /** The longest tick that finished since the last report, in ms; 0 when none did. */
  longestTickMs: number;
  overruns: number;
  errors: ProgramErrorNote[];
  requests: WakeRequestNote[];
  milestones: ProgramMilestoneNote[];
  /** The program's console, consecutive repeats folded into one entry; snippet output never lands here. */
  logs: ProgramLogEntry[];
  /** Console lines printed since the last report, repeats counted, including any the buffer dropped. */
  logLines: number;
  /** Hint-bearing failures, drained only while no snippet is running (a snippet's result carries its own). */
  hints: ActionHintNote[];
}

// host -> child, reply to hostcall
export type HostcallResult = { t: "hostcall_result"; id: number; ok: boolean; value?: unknown; error?: string };
