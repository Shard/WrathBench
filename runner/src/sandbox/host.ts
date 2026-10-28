/**
 * The runner's sandbox host: `@wrathbench/mcp`'s `SandboxHost`, running the
 * runner's own child entry (`entry.ts`, the stack's child plus the
 * benchmark's extension, `child-extension.ts`) and draining what that
 * extension latches — the death, flight and party transitions, the turn's
 * event window, the snippet delta, and the trace and nearby recorders.
 *
 * Everything about the child's lifecycle, its timeout, its confinement and
 * its environment is the stack's (`mcp/src/sandbox/host.ts`); this file adds
 * only the benchmark's drains and names the runner's directory as one the
 * confined child may read, because the extension's code lives here.
 */

import { join } from "node:path";
import {
  SandboxHost as StackSandboxHost,
  type HarnessNotice as StackNotice,
  type SandboxHostOptions,
  type SandboxNoticeKind,
} from "@wrathbench/mcp";
import type { NearbyDrain } from "../nearby-row";
import type { TraceDrain } from "../trace-row";
import type { PartySignal } from "./party-watch";
import type { ContextEvents, DeathSignal, FlightSignal } from "./signals";
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

export class SandboxHost extends StackSandboxHost {
  constructor(opts: SandboxHostOptions) {
    super({ ...opts, entryPath: opts.entryPath ?? RUNNER_SANDBOX_ENTRY, readDirs: [RUNNER_DIR, ...(opts.readDirs ?? [])] });
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
   * Drain the death-window transitions the child latched since the last call.
   *
   * The child sees every event; the host samples on a 60s clock, and a whole
   * death fits between two samples (`signals.ts`, `DeathSignal`). Draining is
   * destructive by design: these are the record, so every drained signal must
   * be written, and one caller (the loop's state sample) owns the drain.
   */
  async deathSignals(): Promise<DeathSignal[]> {
    return ((await this.rpc("death_signals")) ?? []) as DeathSignal[];
  }

  /**
   * Flight transitions the child latched since the last drain (`signals.ts`,
   * `FlightSignal`): the same shape as `deathSignals`, for the same reason,
   * and destructive the same way — the loop's state sample owns the drain.
   */
  async flightSignals(): Promise<FlightSignal[]> {
    return ((await this.rpc("flight_signals")) ?? []) as FlightSignal[];
  }

  /**
   * The party transitions — group, instance, kill — the child latched since
   * the last drain (`party-watch.ts`). Destructive like `deathSignals`; the
   * loop's state sample owns the drain.
   */
  async partySignals(): Promise<PartySignal[]> {
    return ((await this.rpc("party_signals")) ?? []) as PartySignal[];
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

  /**
   * Drain the trace recorder's buffer (`trace-recorder.ts`): the position and
   * state rows the child latched since the last drain, how many its cap
   * dropped, and the item and quest ids it named for the first time
   * (`TraceDict`). Destructive like `deathSignals`, and owned by one caller — the
   * trace writer the state ticker runs (`trace.ts`).
   *
   * Never spawns a child, unlike `stateSnapshot`: with none running there is
   * nothing to drain, and a paused run must not get a sandbox out of its
   * ticker. Null says so; an empty drain from a live child is `{ rows: [] }`.
   */
  async traceDrain(): Promise<TraceDrain | null> {
    const drained = await this.drain("trace_drain");
    if (drained === null) return null;
    const v = (drained.value ?? {}) as Partial<TraceDrain>;
    const out: TraceDrain = { rows: Array.isArray(v.rows) ? v.rows : [], dropped: typeof v.dropped === "number" ? v.dropped : 0 };
    if (v.dict !== null && typeof v.dict === "object") out.dict = v.dict;
    return out;
  }

  /**
   * Drain the nearby recorder's buffer (`nearby-recorder.ts`): the rows about
   * the units in view since the last drain, how many its cap dropped, and how
   * far its poll has looked. Owned by one caller, the ring writer the state
   * ticker runs (`../nearby.ts`), and like `traceDrain` it never spawns a
   * child: with none running it answers null.
   */
  async nearbyDrain(): Promise<NearbyDrain | null> {
    const drained = await this.drain("nearby_drain");
    if (drained === null) return null;
    const v = (drained.value ?? {}) as Partial<NearbyDrain>;
    return {
      rows: Array.isArray(v.rows) ? v.rows : [],
      dropped: typeof v.dropped === "number" ? v.dropped : 0,
      through: typeof v.through === "number" ? v.through : 0,
    };
  }
}
