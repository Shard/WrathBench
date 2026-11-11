/**
 * The runner's sandbox host: `@wrathbench/mcp`'s `SandboxHost`, running the
 * runner's own child entry (`entry.ts`, the stack's child plus the
 * benchmark's extension, `child-extension.ts`) and draining what that
 * extension latches: the turn's event window and the snippet delta.
 *
 * Everything about the child's lifecycle, its timeout, its confinement and
 * its environment is the stack's (`wrath-mcp/mcp/src/sandbox/host.ts`), and
 * so is the session record, which the stack's host drains from its child on
 * its own tick. This file names the runner's directory as one the confined
 * child may read, because the extension's code lives here, and hands the
 * loop the death, flight and party transitions the stack recorded
 * (`../session-record.ts`), in the shapes the loop has always drained.
 */

import { join } from "node:path";
import {
  SandboxHost as StackSandboxHost,
  type HarnessNotice as StackNotice,
  type SandboxHostOptions,
  type SandboxNoticeKind,
} from "@wrathbench/mcp";
import type { CallRecord } from "@wrathbench/mcp";
import type { PartySignal } from "@wrathbench/mcp/record";
import type { SessionRecord } from "../session-record";
import type { ContextEvents } from "./signals";
import type { SnippetDelta } from "./snippet-delta";

export { SANDBOX_FORWARDED_ENV, sandboxChildEnv, STATE_LOSS_RECOVERY } from "@wrathbench/mcp";
export type { ActionsFlush, EvalLink, SandboxHostOptions, SnippetResult } from "@wrathbench/mcp";

/**
 * A notice for the model, as the runner raises them: the sandbox's own kinds
 * plus the ones the runner's drivers raise about the conversation itself.
 */
export type HarnessNotice = StackNotice<
  | SandboxNoticeKind
  | "provider_truncated"
  // The fixed loop's message window dropped a block of older messages
  // (context.ts, `messageWindowCut`). Never raised by the claude-code
  // driver, which runs no window of ours.
  | "window_trimmed"
  // The turn before the block trim is expected: the harness asks for an
  // episodic status entry (METHODOLOGY, "An episodic log"). Fixed-loop only.
  | "trim_pending"
  // The CLI drivers' counterparts: a status entry asked for before the
  // CLI's own compaction, or right after one (`cli-compaction.ts`).
  | "compaction_pending"
  | "compacted"
  // A reflection window closed on its circuit breaker (`reflect.ts`).
  | "reflect_ended"
>;

/** The child entry the runner's host spawns: the stack's child with the benchmark's extension. */
export const RUNNER_SANDBOX_ENTRY = join(import.meta.dir, "entry.ts");

/** The runner's workspace, which the confined child must read for that entry and its extension. */
const RUNNER_DIR = join(import.meta.dir, "..", "..");

/** The runner's host options: the stack's, with the run's session record in place of a bare writer. */
export type RunnerSandboxHostOptions = Omit<SandboxHostOptions, "record"> & {
  /** The run's session record (`../session-record.ts`). Undefined records nothing. */
  session?: SessionRecord | undefined;
  /** The record tick, when not the stack's default. */
  recordTickMs?: number | undefined;
};

export class SandboxHost extends StackSandboxHost {
  private readonly session: SessionRecord | undefined;

  constructor(opts: RunnerSandboxHostOptions) {
    const { session, recordTickMs, ...stack } = opts;
    super({
      ...stack,
      entryPath: opts.entryPath ?? RUNNER_SANDBOX_ENTRY,
      readDirs: [RUNNER_DIR, ...(opts.readDirs ?? [])],
      ...(session !== undefined ? { record: { writer: session.writer, ...(recordTickMs !== undefined ? { tickMs: recordTickMs } : {}) } } : {}),
    });
    this.session = session;
  }

  /** The session record's side of a tool call, for a tool context (`CoreToolContext.record`). */
  get callRecord(): CallRecord | undefined {
    return this.session?.writer;
  }

  /**
   * The turn's event window, via the child's own ring of non-ambient events:
   * the last `limit` of them (at most `CONTEXT_POLICY.EVENT_WINDOW`) and the
   * ambient count of the span they cover. See `ContextEvents`.
   */
  async contextEvents(limit: number): Promise<ContextEvents> {
    const v = ((await this.rpc("context_events", { limit })) ?? {}) as Partial<ContextEvents>;
    return { events: v.events ?? [], folded: typeof v.folded === "number" ? v.folded : 0 };
  }

  /**
   * The signals the stack recorded since the last call, after one record
   * drain so that what the child latched a moment ago is in them. A host with
   * no session record has none to give and says so by throwing, which the
   * loop reads as "no drain" and falls back to its sampled reading.
   */
  private async recorded(): Promise<NonNullable<SessionRecord["signals"]>> {
    if (this.session === undefined) throw new Error("this host keeps no session record");
    await this.recordDrain();
    return this.session.signals;
  }

  /** The kills recorded since the last call (`RecordSignals`). Destructive: the loop owns the drain and hands each to the watchdogs. */
  async partySignals(): Promise<PartySignal[]> {
    return (await this.recorded()).drainKills();
  }

  /**
   * Drain what changed since the last drain (`snippet-delta.ts`): party
   * members' transitions, chat from others, damage taken, level and quests.
   * Destructive, and owned by one caller — the `run_snippet` result on a
   * driver whose registry entry renders it (`tools.ts`).
   *
   * Never spawns a child; null when none is running (`drain`).
   */
  async snippetDelta(): Promise<SnippetDelta | null> {
    const drained = await this.drain("snippet_delta");
    return drained === null ? null : ((drained.value ?? null) as SnippetDelta | null);
  }
}
