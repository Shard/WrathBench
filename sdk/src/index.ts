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
  MovePoint,
  MoveResult,
  MoveToOptions,
  WaitForChatOptions,
  WaitForNearbyOptions,
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
  Anomaly,
  ChatEntry,
  CharacterSummary,
  CreatureInfo,
  GapRecord,
  Gauge,
  NearbyObject,
  NotificationEntry,
  Observed,
  SelfState,
  StateCacheOptions,
  StateSeed,
  StateSnapshot,
  UnitFieldsState,
  UnitPosition,
  WorldPosition,
} from "./state";

export {
  guidKey,
  isDecodeError,
  isEvent,
  isKnownOpcode,
  isMoveOpcode,
  KNOWN_OPCODES,
  MOVE_OPCODES,
  MOVE_STATUSES,
  parseEventFrame,
  PROTOCOL_REVISION,
} from "./protocol";
export type {
  ActionRequest,
  ActionResponse,
  CreateBlock,
  CreateSessionRequest,
  CreatureQueryResponseData,
  DecodeErrorData,
  DeleteSessionRequest,
  DeleteSessionResponse,
  DestroyObjectData,
  ErrorBody,
  FaceResponse,
  GameEvent,
  GuidKey,
  GuidListBlock,
  HealthResponse,
  KnownEvent,
  KnownMoveStatus,
  KnownOpcode,
  MoveOpcode,
  MoveProgressData,
  MoveResultData,
  MoveStatus,
  MoveToResponse,
  MoveUpdateData,
  MovementBlock,
  PositionData,
  SessionResponse,
  UnknownEvent,
  UpdateBlock,
  UpdateFields,
  UpdateObjectData,
  ValuesBlock,
} from "./protocol";
