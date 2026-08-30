/**
 * The `reflect` tool's gate, the reflection window, and their fixed text.
 *
 * The decisions are docs/METHODOLOGY.md, "Reflection is the model's to take,
 * and only at rest" and "An episodic log, written before each trim, read back
 * at rest": the model may spend a turn thinking instead of acting, but only
 * while the character is in a rest area, and only once per rest visit. The
 * rest condition is a world fact (`PLAYER_FLAGS_RESTING`, decoded by the SDK
 * onto `state.self.resting`), so reflection cannot happen mid-combat and
 * happens among the NPCs a player would be visiting anyway.
 *
 * A granted reflection opens a *reflection window*. Every normal tool stays
 * usable inside it; what it adds is `read_log`, the only way the episodic log
 * is ever read back. The window closes when the character leaves the rest area
 * — the same world fact that opened it — or when the run ends, or on a
 * circuit breaker after `REFLECT_MAX_TURNS` turns, which exists so a character
 * parked in an inn cannot hold the window open for a whole episode.
 *
 * Nothing here summarizes anything. The tool returns a fixed, content-free
 * prompt and the model writes the outcome into its own scratchpad — that is
 * what separates this from the model-driven summarizer the context policy
 * rejected.
 */

import type { ToolResult } from "./tools";

/**
 * The refusal when the character is not in a rest area — world fact only, no
 * strategy and no directions. An *unobserved* resting flag reads the same way:
 * the decision names exactly two refusals, and "we have not seen your flags
 * yet" is not a third thing the model can act on differently.
 */
export const REFLECT_NOT_RESTING =
  "Reflection needs rest — you are not in a rest area. Inns and cities set the resting state " +
  "(the character shows it when it applies).";

/** The refusal when this rest visit's one reflection has already been spent. */
export const REFLECT_ALREADY_USED =
  "You already reflected during this rest; it becomes available again after you leave the rest area and return.";

/** The refusal `read_log` gives outside a reflection window. */
export const READ_LOG_CLOSED =
  "read_log is available while reflecting — call reflect in a rest area first.";

/**
 * How many turns a reflection window may stay open. A circuit breaker, not a
 * cadence: it exists only so that parking in an inn cannot hold `read_log`
 * open for a whole episode, and nothing in the model-visible text names it
 * until it fires.
 */
export const REFLECT_MAX_TURNS = 30;

/** The notice pushed when the breaker closes a window. */
export const REFLECT_BREAKER_NOTICE = `Reflection ended after ${REFLECT_MAX_TURNS} turns; it becomes available again after you leave the rest area and return.`;

/**
 * The reflection itself: fixed for every model and every run, and deliberately
 * empty of game knowledge — it asks questions about the record the model
 * already has, and names no place, faction, quest or tactic.
 */
export const REFLECTION_PROMPT = `Take this turn to think rather than act.

- Read your scratchpad against what you have actually observed and what you have been told.
- State what you believe to be true, and the evidence for each belief.
- Say what has worked and what has not.
- Decide what to do next.

Write the outcome to your scratchpad.`;

/** Why a reflection window closed. */
export type ReflectCloseReason = "left_rest" | "breaker" | "run_end";

/** What the gate reports about the window, drained once per turn by the driver. */
export type ReflectWindowEvent =
  | { event: "open" }
  | { event: "close"; reason: ReflectCloseReason };

/**
 * Whether one reflection is available, and whether its window is open.
 *
 * The gate is fed every observation of the resting flag the harness makes (the
 * state sample the context builder takes each turn and on the ticker), not only
 * the ones a `reflect` call happens to coincide with: a model that reflects at
 * an inn, travels for fifty turns and comes back must be re-armed by the
 * leaving, and nothing would have seen the leaving otherwise.
 *
 * Per episode, and never persisted. A resumed run starts with a fresh gate —
 * closed window, un-armed until the next false→true transition — for the same
 * reason the search memo starts empty ("A restarted episode starts with an
 * empty memo, which is the honest thing: the model's context restarted with
 * it"): the conversation the reflection informed is gone.
 */
export class ReflectGate {
  /** The last observed reading; `undefined` until a block carried the flag. */
  private resting: boolean | undefined;
  /** Whether this rest visit's one reflection has been spent. */
  private used = false;
  private open = false;
  /** Turns counted since the window opened; the breaker's only input. */
  private turnsOpen = 0;
  private readonly events: ReflectWindowEvent[] = [];

  /** Whether a reflection window is open right now. */
  get isOpen(): boolean {
    return this.open;
  }

  /**
   * Record an observation of the resting flag. `undefined` (the field was not
   * carried) leaves the last reading standing rather than erasing it, exactly
   * as the ghost latch in `loop.ts` does.
   *
   * Arming is the false→true edge, and the first sight of a resting character
   * arms too: a run that opens inside an inn is at rest, and refusing there
   * would make the first reflection depend on having been seen to walk in.
   * The true→false edge closes any open window: leaving the rest area is what
   * ends reflecting, not a timer.
   */
  note(resting: boolean | undefined): void {
    if (resting === undefined) return;
    if (resting && this.resting !== true) this.used = false;
    if (!resting && this.resting === true) this.close("left_rest");
    this.resting = resting;
  }

  /**
   * Count one driver turn against an open window, closing it on the breaker.
   * Called once per turn by the context builder, which is the one per-turn
   * hook both drivers share.
   */
  noteTurn(): void {
    if (!this.open) return;
    this.turnsOpen++;
    if (this.turnsOpen >= REFLECT_MAX_TURNS) this.close("breaker");
  }

  /** Close an open window, if one is open. Idempotent. */
  close(reason: ReflectCloseReason): void {
    if (!this.open) return;
    this.open = false;
    this.turnsOpen = 0;
    this.events.push({ event: "close", reason });
  }

  /** The tool's answer: the fixed prompt, or one of the two fixed refusals. */
  request(): ToolResult {
    if (this.resting !== true) return { text: REFLECT_NOT_RESTING, isError: true };
    if (this.used) return { text: REFLECT_ALREADY_USED, isError: true };
    this.used = true;
    this.open = true;
    this.turnsOpen = 0;
    this.events.push({ event: "open" });
    return { text: REFLECTION_PROMPT };
  }

  /** Window transitions since the last drain, oldest first. */
  drainEvents(): ReflectWindowEvent[] {
    return this.events.splice(0, this.events.length);
  }
}

/**
 * A gate whose window can never open: `reflect` still answers, `read_log`
 * always refuses.
 *
 * For the standalone MCP server, which has no context builder — nothing samples
 * the world on a clock and nothing counts turns there, so a window opened would
 * never see the character leave the rest area and the breaker could never fire.
 * Serving the log through a window that cannot close would be worse than not
 * serving it at all; a scored episode always runs under a driver whose builder
 * feeds this gate.
 */
export class ClosedWindowReflectGate extends ReflectGate {
  override get isOpen(): boolean {
    return false;
  }
}

/** The resting reading off a state snapshot's `self.resting`, if it carried one. */
export function restingOf(snapshot: { self?: { resting?: { value?: unknown } } } | null): boolean | undefined {
  const v = snapshot?.self?.resting?.value;
  return typeof v === "boolean" ? v : undefined;
}
