/**
 * @wrathbench/sdk — the surface the model programs against.
 *
 * The SDK's public shape is part of the harness version (docs/ARCHITECTURE.md).
 * Adding to it is a minor bump; changing or removing anything exported here is
 * a major one and wants an ADR under docs/decisions/.
 */

export { connect, WrathClient, WrathRequestError, WrathTransportError } from "./client";
export type {
  ConnectOptions,
  ErrorCode,
  KnownErrorCode,
  WaitForChatOptions,
} from "./client";

export {
  EventStream,
  EventStreamClosedError,
  EventTimeoutError,
  STREAM_ERROR,
  STREAM_GAP,
} from "./events";
export type {
  EventByOpcode,
  EventStreamOptions,
  StreamErrorEvent,
  StreamEvent,
  StreamGapEvent,
  Unsubscribe,
  WaitForOptions,
} from "./events";

export { StateCache } from "./state";
export type {
  ChatEntry,
  CharacterSummary,
  GapRecord,
  Gauge,
  NearbyObject,
  NotificationEntry,
  Observed,
  SelfState,
  StateCacheOptions,
  StateSeed,
  StateSnapshot,
  WorldPosition,
} from "./state";

export {
  guidKey,
  isDecodeError,
  isEvent,
  isKnownOpcode,
  KNOWN_OPCODES,
  parseEventFrame,
  PROTOCOL_REVISION,
} from "./protocol";
export type {
  ActionRequest,
  ActionResponse,
  CreateSessionRequest,
  DecodeErrorData,
  DeleteSessionRequest,
  DeleteSessionResponse,
  ErrorBody,
  GameEvent,
  GuidKey,
  HealthResponse,
  KnownEvent,
  KnownOpcode,
  SessionResponse,
  UnknownEvent,
} from "./protocol";
