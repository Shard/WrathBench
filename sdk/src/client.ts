/**
 * The typed client over mod-wrathbench.
 *
 * One method per PROTOCOL.md request, exact shapes, no cleverness. This is the
 * surface the model programs against, so it is deliberately boring.
 *
 * ### The two error channels
 *
 * PROTOCOL.md separates transport/request errors (HTTP non-2xx) from game-level
 * errors (events on the WebSocket). The split is not quite "HTTP vs WS",
 * because `POST /session` is synchronous and therefore reports *game* outcomes
 * — `char_create_failed_code_<N>`, `login_failed`, `timeout` — as HTTP status
 * codes too. So:
 *
 *   - `WrathTransportError`  — the request never got an answer (socket refused,
 *     non-JSON body, abort). Always thrown.
 *   - `WrathRequestError`    — the module answered `{ ok: false }`. Always
 *     thrown, and carries `kind: "request" | "game"` so a caller can tell
 *     `token_in_use` (fix your call) from `char_create_failed_code_47` (the
 *     game said no). The game-level ones are *also* on the event stream.
 *
 * Anything the server decides after an action is acked never appears here at
 * all: it arrives as an event, because that is how a client would learn of it.
 */

import {
  actionResponseSchema,
  deleteSessionResponseSchema,
  errorBodySchema,
  faceResponseSchema,
  guidKey,
  healthResponseSchema,
  isDecodeError,
  isEvent,
  moveToResponseSchema,
  sessionResponseSchema,
  type ActionResponse,
  type CreateSessionRequest,
  type DeleteSessionResponse,
  type ErrorBody,
  type FaceResponse,
  type HealthResponse,
  type KnownMoveStatus,
  type MoveResultData,
  type MoveStatus,
  type MoveToResponse,
  type SessionResponse,
} from "./protocol";
import { EventStream, type EventStreamOptions, type StreamEvent } from "./events";
import { StateCache, type ChatEntry, type NearbyObject, type UnitPosition } from "./state";
import type { z } from "zod";

/**
 * Error codes PROTOCOL.md documents today. Widened with `(string & {})` on
 * purpose: a module that adds a code must not break the SDK's parsing, only
 * lose the autocompletion for that one code.
 */
export type KnownErrorCode =
  | "missing_token"
  | "missing_character"
  | "token_in_use"
  | "unknown_account"
  | "socket_setup_failed"
  | "login_failed"
  | "character_missing_after_create"
  | "timeout"
  | "unsupported_action"
  | "no_session"
  | "not_in_world"
  | "no_player"
  | "session_gone"
  // movement extension
  | "missing_position"
  | "missing_face_target"
  | "moving";

export type ErrorCode = KnownErrorCode | (string & {});

/** Error codes that report a decision the game server made, not a bad request. */
const GAME_LEVEL_CODES = new Set<string>([
  "login_failed",
  "character_missing_after_create",
  "timeout",
]);

/** The request never completed: no answer, or an answer we could not read. */
export class WrathTransportError extends Error {
  override readonly name = "WrathTransportError";
  constructor(
    message: string,
    readonly detail?: { method: string; path: string; cause?: unknown },
  ) {
    super(message);
  }
}

/** The module answered, and said no. */
export class WrathRequestError extends Error {
  override readonly name = "WrathRequestError";
  readonly status: number;
  readonly code: ErrorCode;
  /** `"game"` when the code reports a server decision; `"request"` otherwise. */
  readonly kind: "request" | "game";
  /** Parsed out of `char_create_failed_code_<N>`, when that is the code. */
  readonly charCreateResultCode: number | undefined;
  readonly body: ErrorBody;

  constructor(status: number, body: ErrorBody) {
    const match = /^char_create_failed_code_(\d+)$/.exec(body.error);
    super(`module rejected request: ${body.error} (HTTP ${status})`);
    this.status = status;
    this.code = body.error;
    this.charCreateResultCode = match?.[1] !== undefined ? Number(match[1]) : undefined;
    this.kind = match !== null || GAME_LEVEL_CODES.has(body.error) ? "game" : "request";
    this.body = body;
  }
}

export interface ConnectOptions {
  /** e.g. `http://worldserver:8086`. */
  baseUrl: string;
  /** Opaque session id chosen by the caller; scopes both actions and events. */
  token: string;
  /** Defaults to `baseUrl` with an `ws://`/`wss://` scheme. */
  eventsUrl?: string;
  /** Open the event stream during `connect`. Default true; see the note below. */
  subscribeEvents?: boolean;
  /** Per-request timeout. Default 30000 — `POST /session` blocks up to 20s. */
  requestTimeoutMs?: number;
  fetchImpl?: typeof fetch;
  events?: Omit<EventStreamOptions, "url" | "token">;
  state?: { chatTail?: number; notificationTail?: number };
}

export interface WaitForChatOptions {
  timeout?: number;
  sinceSeq?: number;
  includeBuffered?: boolean;
}

/** A point to walk to. `o` is ignored: `move_to` takes no orientation. */
export interface MovePoint {
  x: number;
  y: number;
  z: number;
}

export interface MoveToOptions {
  /**
   * How long to wait for the terminal `WB_MOVE_RESULT`. Default 90000: the
   * single-move cap is ~250yd, which is ~36s at a base run speed of 7yd/s,
   * plus the module's 3s server-confirmation deadline and slack for a path
   * that is longer than the straight line.
   */
  timeout?: number;
}

/**
 * The outcome of a `move_to`, as the server decided it.
 *
 * A *returned* discriminated union rather than a thrown error, and deliberately
 * so: PROTOCOL.md splits transport/request errors (HTTP non-2xx) from
 * game-level outcomes (events), and `no_path` / `too_far` / `interrupted` are
 * squarely the second kind — the game answering the question that was asked,
 * not the call being wrong. Modelling them as exceptions would put a normal
 * answer ("there is no path there") on the same channel as `not_in_world`, and
 * a snippet that forgot a `try` would abort a run over it. `if (!result.ok)` is
 * hard to forget and hard to get wrong.
 *
 * `position` is the server-confirmed position the character actually ended at,
 * whatever the status — which is exactly what the next decision needs.
 */
export type MoveResult =
  | {
      readonly ok: true;
      readonly status: "arrived";
      readonly moveId: number;
      readonly position: UnitPosition;
      readonly seq: number;
      readonly ts: number;
    }
  | {
      readonly ok: false;
      readonly status: Exclude<KnownMoveStatus, "arrived"> | (string & {});
      readonly moveId: number;
      readonly position: UnitPosition;
      readonly seq: number;
      readonly ts: number;
    };

export interface WaitForNearbyOptions {
  timeout?: number;
}

/**
 * Connect to the module and (by default) subscribe to the event stream.
 *
 * The subscription is opened *before* any session exists, on purpose: the whole
 * login handshake — `SMSG_AUTH_RESPONSE`, `SMSG_CHAR_ENUM`,
 * `SMSG_LOGIN_VERIFY_WORLD` — is emitted while `POST /session` is still
 * blocking, and it is the only source for the character list and the starting
 * position. Connecting first is what makes the state cache complete.
 */
export async function connect(options: ConnectOptions): Promise<WrathClient> {
  const client = new WrathClient(options);
  if (options.subscribeEvents ?? true) await client.events.connect();
  return client;
}

export class WrathClient {
  readonly token: string;
  readonly baseUrl: string;
  readonly events: EventStream;
  readonly state: StateCache;

  private readonly fetchImpl: typeof fetch;
  private readonly requestTimeoutMs: number;

  constructor(options: ConnectOptions) {
    this.token = options.token;
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000;

    const wsBase = options.eventsUrl ?? this.baseUrl.replace(/^http/, "ws");
    this.events = new EventStream({
      ...options.events,
      url: `${wsBase.replace(/\/+$/, "")}/events`,
      token: options.token,
    });
    this.state = new StateCache(options.state ?? {});
    // Registered before the socket opens, so the cache sees every frame.
    this.events.onAny((event: StreamEvent) => this.state.apply(event));
  }

  // ------------------------------------------------------------- endpoints

  /** GET /health. Module and world status; no auth, not session-scoped. */
  health(): Promise<HealthResponse> {
    return this.request("GET", "/health", undefined, healthResponseSchema);
  }

  /**
   * POST /session — create (or reuse) the character and enter the world.
   * Blocks server-side until the session is in the world or fails, up to 20s.
   *
   * Seeds the state cache with our own guid and name, which no event carries.
   */
  async createSession(request: Omit<CreateSessionRequest, "token">): Promise<SessionResponse> {
    const body: CreateSessionRequest = { token: this.token, ...request };
    const res = await this.request("POST", "/session", body, sessionResponseSchema);
    this.state.seedSelf({ guid: res.guid, name: res.character });
    return res;
  }

  /**
   * POST /action with `action: "say"`. Acks that the opcode was synthesized and
   * queued — the chat echo (or a `SMSG_NOTIFICATION` rejection) is an event.
   * The language is chosen server-side from the character's team.
   */
  say(text: string): Promise<ActionResponse> {
    return this.request(
      "POST",
      "/action",
      { token: this.token, action: "say", text },
      actionResponseSchema,
    );
  }

  /**
   * POST /action with `action: "move_to"`. Acks "queued and pathing"; the
   * outcome is a `WB_MOVE_RESULT` event. Prefer `moveTo`, which waits for it.
   */
  moveToAsync(point: MovePoint): Promise<MoveToResponse> {
    return this.request(
      "POST",
      "/action",
      { token: this.token, action: "move_to", x: point.x, y: point.y, z: point.z },
      moveToResponseSchema,
    );
  }

  /**
   * POST /action with `action: "stop"`. Returns as soon as the module has
   * queued the `MSG_MOVE_STOP` — it does not wait for the character to halt.
   * The in-flight `moveTo` is what resolves, with `status: "stopped"`, and its
   * result carries where the character actually came to rest.
   */
  stop(): Promise<ActionResponse> {
    return this.request(
      "POST",
      "/action",
      { token: this.token, action: "stop" },
      actionResponseSchema,
    );
  }

  /**
   * POST /action with `action: "face"` — turn in place.
   *
   * Takes either an absolute orientation in radians (0 = east/+x,
   * counter-clockwise) or a point to turn toward; the module resolves a point
   * into an orientation and echoes the one it used. Rejects with
   * `WrathRequestError` code `moving` while a move is running — stop first, or
   * supersede with `moveTo`.
   */
  face(orientationOrPoint: number | { x: number; y: number }): Promise<FaceResponse> {
    const body =
      typeof orientationOrPoint === "number"
        ? { token: this.token, action: "face", orientation: orientationOrPoint }
        : { token: this.token, action: "face", x: orientationOrPoint.x, y: orientationOrPoint.y };
    return this.request("POST", "/action", body, faceResponseSchema);
  }

  /** DELETE /session — log the character out (a real client-style disconnect). */
  deleteSession(): Promise<DeleteSessionResponse> {
    return this.request(
      "DELETE",
      "/session",
      { token: this.token },
      deleteSessionResponseSchema,
    );
  }

  /** Alias for `deleteSession`, which is what it means in game terms. */
  logout(): Promise<DeleteSessionResponse> {
    return this.deleteSession();
  }

  /** Close the event stream. Does not log the character out. */
  close(): void {
    this.events.close();
  }

  // --------------------------------------------------------------- helpers
  //
  // Only what the current protocol supports. No speculative helpers
  // (docs/ARCHITECTURE.md): a helper is added when a run needed it.

  /**
   * Wait for a chat line. `match` is either an exact message string or a
   * predicate over the decoded entry. Searches events already received before
   * waiting, so it is safe to call after the action has been acked.
   */
  async waitForChat(
    match: string | ((entry: ChatEntry) => boolean),
    options: WaitForChatOptions = {},
  ): Promise<ChatEntry> {
    const predicate = typeof match === "string" ? (e: ChatEntry) => e.message === match : match;
    const event = await this.events.waitFor((e) => {
      if (!isEvent(e, "SMSG_MESSAGECHAT") || isDecodeError(e.data)) return false;
      return predicate(toChatEntry(e.seq, e.ts, e.data));
    }, options);
    return toChatEntry(event.seq, event.ts, event.data as ChatFields);
  }

  /**
   * Walk to a world position and wait for the server's verdict.
   *
   * Issues `move_to`, then resolves on the `WB_MOVE_RESULT` carrying the same
   * `moveId`. The result is *returned*, not thrown, for every outcome the game
   * decides — see `MoveResult` for why. Still thrown:
   *
   *   - `WrathRequestError` — the request was refused before anything moved
   *     (`missing_position`, `not_in_world`, `no_session`, …).
   *   - `EventTimeoutError` — no result arrived within `timeout`. That is not
   *     an outcome, it is the *absence* of one: the character may well still be
   *     walking, and pretending otherwise (a synthetic `status: "timeout"`)
   *     would put an SDK invention in a field that otherwise only ever holds
   *     the module's own words.
   *
   * A `moveTo` issued while another is running supersedes it; the older call
   * resolves with `status: "superseded"`.
   */
  async moveTo(point: MovePoint, options: MoveToOptions = {}): Promise<MoveResult> {
    const ack = await this.moveToAsync(point);
    // The match is the moveId alone, and the buffer is searched: a result can
    // land while the POST response is still in flight (an immediate `no_path`
    // does exactly that). No `sinceSeq` bound — `seq` restarts when a token's
    // session is recreated, so any seq-based floor can outrun the very event it
    // is meant to admit, while `moveId` is unique per session and issued by the
    // ack we are holding.
    const event = await this.events.waitFor(
      (e) =>
        isEvent(e, "WB_MOVE_RESULT") &&
        !isDecodeError(e.data) &&
        (e.data as MoveResultData).moveId === ack.moveId,
      { timeout: options.timeout ?? 90_000 },
    );
    const data = event.data as MoveResultData;
    const status: MoveStatus = data.status;
    const position: UnitPosition = {
      x: data.pos.x,
      y: data.pos.y,
      z: data.pos.z,
      o: data.pos.o,
    };
    const common = { moveId: data.moveId, position, seq: event.seq, ts: event.ts } as const;
    return status === "arrived"
      ? { ok: true, status: "arrived", ...common }
      : { ok: false, status, ...common };
  }

  /**
   * Wait until an object in view satisfies `predicate`.
   *
   * Reads the state cache, not the raw stream: what puts an object in view is
   * a whole `SMSG_UPDATE_OBJECT` fold plus, usually, a later query response
   * that gives it a name — no single event answers "is there a named creature
   * nearby". The cache is updated before waiters run, so re-checking it on
   * every event is exact.
   *
   * Returns the live cache entry (as every `state` query does); take
   * `state.snapshot()` if you need it frozen.
   */
  async waitForNearby(
    predicate: (obj: NearbyObject) => boolean,
    options: WaitForNearbyOptions = {},
  ): Promise<NearbyObject> {
    const scan = (): NearbyObject | undefined => {
      for (const obj of this.state.nearby.values()) {
        try {
          if (predicate(obj)) return obj;
        } catch {
          /* a throwing predicate is not a match */
        }
      }
      return undefined;
    };
    const already = scan();
    if (already) return already;

    let hit: NearbyObject | undefined;
    await this.events.waitFor(
      () => {
        hit = scan();
        return hit !== undefined;
      },
      // The buffer is not re-scanned: those events are already folded into the
      // cache, and `scan()` above has just looked at the result.
      { timeout: options.timeout ?? 10_000, includeBuffered: false },
    );
    // `waitFor` only resolves when `scan()` found something.
    return hit as NearbyObject;
  }

  /** Our own guid as a map key, once the session response has seeded it. */
  get selfKey(): string | undefined {
    return this.state.self.guid === undefined ? undefined : guidKey(this.state.self.guid);
  }

  // --------------------------------------------------------------- internals

  private async request<S extends z.ZodType>(
    method: string,
    path: string,
    body: unknown,
    schema: S,
  ): Promise<z.infer<S>> {
    const url = `${this.baseUrl}${path}`;
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method,
        headers: body === undefined ? undefined : { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.requestTimeoutMs),
      });
    } catch (cause) {
      throw new WrathTransportError(`${method} ${path} failed: ${String(cause)}`, {
        method,
        path,
        cause,
      });
    }

    const text = await res.text();
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch (cause) {
      throw new WrathTransportError(
        `${method} ${path} returned HTTP ${res.status} with a non-JSON body`,
        { method, path, cause },
      );
    }

    if (!res.ok) {
      const err = errorBodySchema.safeParse(json);
      if (!err.success) {
        throw new WrathTransportError(
          `${method} ${path} returned HTTP ${res.status} with an unrecognised error body`,
          { method, path },
        );
      }
      throw new WrathRequestError(res.status, err.data);
    }

    const parsed = schema.safeParse(json);
    if (!parsed.success) {
      throw new WrathTransportError(
        `${method} ${path} response did not match the protocol: ${parsed.error.message}`,
        { method, path },
      );
    }
    return parsed.data;
  }
}

type ChatFields = Omit<ChatEntry, "seq" | "ts">;

function toChatEntry(seq: number, ts: number, d: ChatFields): ChatEntry {
  return {
    seq,
    ts,
    type: d.type,
    language: d.language,
    senderGuid: d.senderGuid,
    message: d.message,
    chatTag: d.chatTag,
  };
}
