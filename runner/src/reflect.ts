/**
 * The `reflect` tool's gate, the reflection window, and their fixed text.
 *
 * The decisions are docs/METHODOLOGY.md, "Reflection is the model's to take,
 * and only at rest or in flight" and "An episodic log, written before each
 * trim, read back at rest or in flight": the model may spend a turn thinking
 * instead of acting, but only while the character is in a rest area or on a
 * taxi flight, and only once per stay. Both conditions are world facts a
 * client sees (`PLAYER_FLAGS_RESTING` and `UNIT_FLAG_TAXI_FLIGHT`, decoded by
 * the SDK onto `state.self.resting` and `state.self.taxiFlight`), so
 * reflection cannot happen mid-combat: a rest area is among the NPCs a player
 * would be visiting anyway, and a taxi passenger cannot fight.
 *
 * A *stay* is one unbroken stretch in which the character is resting, flying,
 * or both. The two run together on purpose: a flight into a capital turns the
 * rest flag on before it lands (the zone updates in flight), and a flight out
 * of one leaves it after takeoff, so counting them apart would hand out a
 * second reflection back to back for one continuous stretch.
 *
 * A granted reflection opens a *reflection window*. Every normal tool stays
 * usable inside it; what it adds is `read_log`, the only way the episodic log
 * is ever read back. The window closes when the stay ends — the character is
 * neither resting nor flying any more — or when the run ends, or on a
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
 * The refusal when the character is neither in a rest area nor on a flight —
 * world fact only, no strategy and no directions. An *unobserved* flag reads
 * the same way: the decision names exactly two refusals, and "we have not seen
 * your flags yet" is not a third thing the model can act on differently.
 */
export const REFLECT_NOT_RESTING =
  "Reflection needs rest or a flight — you are neither resting nor in flight. " +
  "Inns and cities set the resting state (the character shows it when it applies).";

/** The refusal when this stay's one reflection has already been spent. */
export const REFLECT_ALREADY_USED =
  "You already reflected during this stay; it becomes available again after you are neither resting nor in flight, then rest or fly again.";

/** The refusal `read_log` gives outside a reflection window. */
export const READ_LOG_CLOSED =
  "read_log is available while reflecting — call reflect while resting or in flight first.";

/**
 * How many turns a reflection window may stay open. A circuit breaker against a
 * thinking deadlock, not a cadence: it exists so that parking in an inn cannot
 * hold `read_log` open for a whole episode. The number is named to the model,
 * but only in the notice that says the window has just closed — a limit the
 * model is told about after the fact is a fact about what happened, not a
 * budget to plan a turn count around.
 */
export const REFLECT_MAX_TURNS = 30;

/** The notice pushed when the breaker closes a window. */
export const REFLECT_BREAKER_NOTICE = `Reflection ended after ${REFLECT_MAX_TURNS} turns; it becomes available again after you are neither resting nor in flight, then rest or fly again.`;

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
export type ReflectCloseReason = "left_rest" | "landed" | "breaker" | "run_end";

/** What the gate reports about the window, drained once per turn by the driver. */
export type ReflectWindowEvent =
  | { event: "open" }
  | { event: "close"; reason: ReflectCloseReason };

/**
 * Whether one reflection is available, and whether its window is open.
 *
 * The gate is fed every observation of the resting and taxi-flight flags the
 * harness makes (the state sample the context builder takes each turn and on
 * the ticker), not only the ones a `reflect` call happens to coincide with: a
 * model that reflects at an inn, travels for fifty turns and comes back must be
 * re-armed by the leaving, and nothing would have seen the leaving otherwise.
 *
 * A sandbox restart rebuilds the state cache, so `self.resting` and
 * `self.taxiFlight` are unobserved again until the next update block carries
 * `playerFlags` and `unitFlags`; the gate keeps the last reading of each until
 * then rather than treating "not seen" as "not resting" or "not flying" — the
 * same latch discipline the ghost flag has in `loop.ts`.
 *
 * Per episode, and never persisted. A resumed run starts with a fresh gate —
 * closed window, un-armed until the next false→true transition — for the same
 * reason the search memo starts empty ("A restarted episode starts with an
 * empty memo, which is the honest thing: the model's context restarted with
 * it"): the conversation the reflection informed is gone.
 */
export class ReflectGate {
  /** The last observed readings; each `undefined` until a block carried it. */
  private resting: boolean | undefined;
  private taxiFlight: boolean | undefined;
  /** Whether this stay's one reflection has been spent. */
  private used = false;
  private open = false;
  /** Turns counted since the window opened; the breaker's only input. */
  private turnsOpen = 0;
  private readonly events: ReflectWindowEvent[] = [];

  /** Whether a reflection window is open right now. */
  get isOpen(): boolean {
    return this.open;
  }

  /** Resting, flying, or both: the stay one reflection belongs to. */
  private get inStay(): boolean {
    return this.resting === true || this.taxiFlight === true;
  }

  /**
   * Record an observation of the resting and taxi-flight flags. `undefined`
   * (the field was not carried) leaves that flag's last reading standing
   * rather than erasing it, exactly as the ghost latch in `loop.ts` does.
   *
   * Arming is the stay's false→true edge, and the first sight of a resting or
   * flying character arms too: a run that opens inside an inn is at rest, and
   * refusing there would make the first reflection depend on having been seen
   * to walk in. The true→false edge closes any open window: being neither
   * resting nor flying is what ends reflecting, not a timer. Only the combined
   * edge counts, so landing in a city, taking off from one or flying over one
   * stays one stay.
   */
  note(resting: boolean | undefined, taxiFlight?: boolean): void {
    const was = this.inStay;
    const wasResting = this.resting === true;
    if (resting !== undefined) this.resting = resting;
    if (taxiFlight !== undefined) this.taxiFlight = taxiFlight;
    if (this.inStay && !was) this.used = false;
    if (!this.inStay && was) this.close(wasResting ? "left_rest" : "landed");
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
    if (!this.inStay) return { text: REFLECT_NOT_RESTING, isError: true };
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
 * never see the stay end and the breaker could never fire.
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

/** The taxi-flight reading off a state snapshot's `self.taxiFlight`, if it carried one. */
export function taxiFlightOf(snapshot: { self?: { taxiFlight?: { value?: unknown } } } | null): boolean | undefined {
  const v = snapshot?.self?.taxiFlight?.value;
  return typeof v === "boolean" ? v : undefined;
}
