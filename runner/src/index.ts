/**
 * @wrathbench/runner — the fixed harness (ADR-0004). Everything here is
 * model-agnostic; the only per-run variables are the adapter config and the
 * character. Entry points:
 *
 *   bun runner/src/run.ts       start or resume a run
 *   bun runner/src/mcp.ts       MCP stdio server over the same tools
 *   bun runner/src/timeline.ts  terminal timeline for a run
 *   bun runner/src/classify.ts  manual termination classification
 */

export { loadRunConfig, newRunId, runConfigSchema, watchdogConfigSchema, TERMINATION_REASONS, PAUSE_REASONS } from "./config";
export type { RunConfig, WatchdogConfig, TerminationReason, PauseReason } from "./config";

export { SandboxHost } from "./sandbox/host";
export type { SnippetResult, HarnessNotice, SandboxHostOptions } from "./sandbox/host";
export { compileSnippet, scanTopLevelDeclarations, extractPatternNames } from "./sandbox/rewrite";

export { TOOLS, callTool, isKnownTool } from "./tools";
export type { ToolContext, ToolDef, ToolResult } from "./tools";

export { McpServer, MCP_PROTOCOL_VERSION } from "./mcp";

export { SYSTEM_PROMPT } from "./prompt";
export { CONTEXT_POLICY, assembleContext, formatStateSummary, formatEventLine, messageWindow, messageWindowCut } from "./context";
export type { ChatMessage, ContextInputs, SnapshotLike } from "./context";

export { OpenAiChatAdapter, StubAdapter, AdapterError, stubTurnSchema } from "./adapter";
export type { ChatAdapter, ChatRequest, AdapterOutcome, AssistantTurn, StubTurn } from "./adapter";

export { Watchdogs } from "./watchdogs";
export type { WatchdogVerdict } from "./watchdogs";

export { runLoop } from "./loop";
export type { LoopOptions, LoopOutcome } from "./loop";

export { Trajectory, readTrajectory, readMeta } from "./trajectory";
export type { RunMeta, StateLine, TrajectoryRecord } from "./trajectory";

export { Scratchpad, SCRATCHPAD_MAX_CHARS } from "./scratchpad";
export { harnessVersion } from "./version";
export { renderTimeline } from "./timeline";
export { toJsonSafe, jsonLine, compactJson } from "./jsonsafe";
