/**
 * @wrathbench/mcp — the agent surface over the SDK: a confined, persistent
 * snippet sandbox holding one `WrathClient`, an MCP server, the core tools
 * that drive them, and the module's authentication helpers.
 *
 * It depends on `@wrathbench/sdk` through that package's public entry point
 * and on nothing else in this repository. A harness (the runner is one)
 * plugs its own tools, its context rendering, its records and its child-side
 * watchers in through the hooks exported here; nothing in this package knows
 * what a harness records or scores.
 */

import { join } from "node:path";

/** The stdio <-> TCP bridge a CLI agent is handed as its MCP server command (`bridge.ts`). */
export const MCP_BRIDGE_PATH = join(import.meta.dir, "bridge.ts");
/** The Landlock wrapper every sandbox child is exec'd through (`sandbox/confine.ts`). */
export const SANDBOX_CONFINE_PATH = join(import.meta.dir, "sandbox", "confine.ts");
/** The bare sandbox child, with no harness extension (`sandbox/entry.ts`); `SandboxHost`'s default. */
export const SANDBOX_ENTRY_PATH = join(import.meta.dir, "sandbox", "entry.ts");

export {
  SANDBOX_FORWARDED_ENV,
  SandboxHost,
  sandboxChildEnv,
  STATE_LOSS_RECOVERY,
} from "./sandbox/host";
export type {
  ActionsFlush,
  EvalLink,
  HarnessNotice,
  SandboxHostOptions,
  SandboxNoticeKind,
  SnippetResult,
} from "./sandbox/host";
// Types only: importing the child runtime itself is what makes a process a
// sandbox child (it replaces fetch, WebSocket and console), so its values are
// reached through `@wrathbench/mcp/sandbox-child` and nowhere else.
export type { SandboxChildApi, SandboxChildExtension, SandboxChildExtensionFactory } from "./sandbox/child";

export { compactJson, jsonLine, toJsonSafe } from "./jsonsafe";
export {
  leaseRunSecret,
  leaseSessionSecret,
  MODULE_SECRET_ENV,
  moduleAuthHeaders,
  moduleSecret,
  releaseSessionSecret,
} from "./module-auth";
export type { LeaseOptions, LeaseOutcome } from "./module-auth";
export { MIN_SECRET_CHARS, REDACTED, SCRUB_HOLD_CHARS, SCRUB_MAX_PENDING_CHARS, ScrubbedStream, SecretRedactor } from "./redact";
export {
  overCapText,
  Scratchpad,
  SCRATCHPAD_MAX_CHARS,
  scratchpadSizeLabel,
  stripLegacyMarker,
} from "./scratchpad";
export type { OverCap, WriteResult } from "./scratchpad";

export { CALL_SITE_LABEL_CHARS, SNIPPET_URL, builtRoutine, callSiteLabel } from "./sandbox/call-site";
export {
  CLIENT_CACHE_FILE,
  CLIENT_CACHE_OPCODES,
  ClientCacheStore,
  clientCacheKey,
  keepsAnswer,
  reparseFrame,
} from "./sandbox/client-cache";
export type { ClientCacheFrame, ClientCacheStoreOptions } from "./sandbox/client-cache";
export {
  ACCESS_FS,
  ACCESS_NET,
  ConfinementError,
  confinementPlan,
  DEV_NODES,
  elfInterpreter,
  landlockAbi,
  modulePort,
  PROC_GLOBAL_FILES,
  REQUIRED_ABI,
  SCOPE,
} from "./sandbox/confine";
export type { ConfinementPlan, FsRule, NetRule, PlanInput } from "./sandbox/confine";
export { RepeatFolder } from "./sandbox/log-fold";
export { REATTACH_REPLAY_WAIT_MS, REATTACH_STATE_WAIT_MS } from "./sandbox/reattach-waits";
export { compileSnippet, extractPatternNames, scanTopLevelDeclarations } from "./sandbox/rewrite";
export type { CompiledSnippet, ScanResult } from "./sandbox/rewrite";
export type {
  ActionBatch,
  ActionHintNote,
  ActionNote,
  ChildToHost,
  EvalResultMsg,
  EventSummary,
  HostcallResult,
  HostToChild,
  LogEntry,
  MoveIntentNote,
} from "./sandbox/ipc";
