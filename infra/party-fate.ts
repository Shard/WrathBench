/**
 * A party's shared start, stop and fate (docs/proposals/GROUP-PLAY.md §1):
 * the roster's party mode, as a pure state machine over injected effects, so
 * every path is fixture-tested without a process, a pod or a game.
 *
 * A party is one attempt: its members are launched in one pass (after the
 * stager, on a fresh launch), and the first member to leave the world decides
 * what becomes of the rest.
 *
 *   staging ──fail──▶ every member a launch-failed stub          (staging-failed)
 *      │ ok (or a resume: never staged)
 *      ▼
 *      │ a stop landed while staging ──▶ nobody launched           (stopped)
 *      ▼
 *   all members launched ── the first exit ──┐
 *                                            ▼
 *        the roster was signalled, and every member paused? ──yes──▶
 *                                  each keeps its own pause      (stopped)
 *                                            │ no
 *                                            ▼
 *        the others are stopped with the episode grace (SIGTERM: each runner
 *        pauses as operator-pause) — unless the first ended on its
 *        definition's end, below — and once all have exited:
 *
 *   - the first is a TERMINATION (a watchdog, the clock, adapter-error,
 *     tool-call-limit, harness-error, launch-failed, an eviction or a dead pod
 *     with no row) — or a pause in a lane that does not resume  → ENDED: the
 *     others are terminated `party-ended`, detail `<member>: <reason>`; a
 *     member that reached its own termination in the meantime keeps it.
 *     When the first ended on its definition's end (`level-target`,
 *     `kill-target`: the attempt reached what it was launched for), the
 *     others are terminated on that same reason instead, with the same
 *     detail, so all five are the one counted verdict. They are not signalled
 *     for it: each runner is asked to end on that reason itself
 *     (`requestEnd`, `runner/src/end-request.ts`), so it ends through the
 *     same watchdog verdict and wind-down its own end would take and its
 *     driver's closing result (cost, tokens) is recorded. A member still
 *     running once `endGraceMs` has passed is stopped as above and ended
 *     by the machine as before.
 *   - the first is a PAUSE in a lane that resumes                 → PAUSED: the
 *     others that the roster's stop paused (`operator-pause`) are re-paused
 *     `party-paused` with the same detail; one that paused for a reason of its
 *     own keeps it. If any member TERMINATED meanwhile, the party cannot come
 *     back whole, so it is ENDED instead, the first such member its cause.
 *
 * A member that dies in the game is none of this: dying is not leaving the
 * world, the run plays on as a ghost or is resurrected, and nothing here
 * reacts to anything but a member's episode exiting.
 */

import { isEndReason, type EndReason } from "../runner/src/end-conditions";
import type { StageResult } from "./party-stager";

/** One member as the machine knows it. */
export interface PartyMemberRun {
  member: string;
  runId: string;
  /** This launch resumes the member's paused run rather than starting it. */
  resume: boolean;
}

/** A member's verdict, read off its run row once its episode has exited (the roster's `classify`). */
export type MemberVerdict =
  | { kind: "launch-failed"; detail: string }
  | { kind: "terminated"; reason: string; detail: string | undefined }
  | { kind: "paused"; reason: string }
  | { kind: "unknown"; detail: string };

/** A launched member: its exit, and the stop the roster's own SIGTERM path sends. */
export interface MemberHandle<Exit = unknown> {
  readonly exited: Promise<Exit>;
  stop(graceMs: number): Promise<void> | void;
}

export interface PartyFateDeps<Exit = unknown> {
  /** The stager, asked before a fresh launch only; absent on a resume. */
  stage?: () => Promise<StageResult>;
  launch(m: PartyMemberRun): Promise<MemberHandle<Exit>>;
  verdict(m: PartyMemberRun, exit: Exit): MemberVerdict;
  /** Write a termination through the runner's own writer. */
  end(m: PartyMemberRun, reason: string, detail: string): void;
  /**
   * Ask a running member's runner to end on this end reason and detail
   * itself, through its own wind-down (`runner/src/end-request.ts`). Absent:
   * every member is stopped with the grace, as for any other fate.
   */
  requestEnd?: (m: PartyMemberRun, reason: EndReason, detail: string) => void;
  /** How long a member asked to end is given to do so before it is stopped: a whole wind-down and its teardown. */
  endGraceMs?: number;
  /** Replace a member's pause (the roster's operator-pause) with `party-paused` and this detail. */
  repause(m: PartyMemberRun, detail: string): void;
  /** Record a fresh member that never became a run as a launch-failed attempt. */
  launchFailed(m: PartyMemberRun, detail: string): void;
  /** End the member's own pause in a lane that does not resume (the lane's lapse rule); returns the reason written. */
  endOwnPause(m: PartyMemberRun, verdict: Extract<MemberVerdict, { kind: "paused" }>): string;
  /** Whether the roster itself was signalled: a shared stop, never a fate. */
  stopping(): boolean;
  /** The lane's answer to a pause (`RosterSpec.resumeOnPause`), the same for every member. */
  resumeOnPause: boolean;
  graceMs: number;
  log(line: string): void;
}

export type PartyFate = "ended" | "paused" | "stopped" | "staging-failed";

export interface PartyOutcome {
  fate: PartyFate;
  /** The member whose verdict decided the fate, and that verdict's reason. Absent on a shared stop. */
  trigger?: { member: string; reason: string };
  /** Each member's verdict as read once every episode had exited. */
  verdicts: Record<string, MemberVerdict>;
  /**
   * What the machine wrote, per member, in member order: `party-ended` (or the
   * end reason the trigger reached), `party-paused`, a launch-failed stub, an
   * ended pause — or, `followed`, the end reason a member's own runner wrote
   * because the machine asked it to (`requestEnd`).
   */
  written: { member: string; wrote: string; followed?: true }[];
}

/** The reason a verdict names: its termination or pause reason, else its kind. */
export function verdictReason(v: MemberVerdict): string {
  return v.kind === "terminated" || v.kind === "paused" ? v.reason : v.kind === "unknown" ? "exited without a verdict" : v.kind;
}

/** Whether a verdict ends the attempt outright: anything but a pause the lane resumes. */
function ends(v: MemberVerdict, resumeOnPause: boolean): boolean {
  return v.kind !== "paused" || !resumeOnPause;
}

export async function runParty<Exit>(members: readonly PartyMemberRun[], deps: PartyFateDeps<Exit>): Promise<PartyOutcome> {
  const written: PartyOutcome["written"] = [];
  const fresh = members.every((m) => !m.resume);
  if (fresh && deps.stage !== undefined) {
    const staged = await deps.stage();
    if (!staged.ok) {
      deps.log(`party: staging failed — ${staged.reason}; every member is a launch-failed attempt`);
      const verdicts: Record<string, MemberVerdict> = {};
      for (const m of members) {
        deps.launchFailed(m, `staging failed: ${staged.reason}`);
        verdicts[m.member] = { kind: "launch-failed", detail: `staging failed: ${staged.reason}` };
        written.push({ member: m.member, wrote: "launch-failed" });
      }
      return { fate: "staging-failed", verdicts, written };
    }
    deps.log(`party: staged ${members.length} members${staged.detail !== undefined ? ` — ${staged.detail}` : ""}`);
    // A stop that landed while the stager ran launches nobody: five runs
    // started only to be paused at once would be five attempts with no play,
    // and the next attempt restages anyway.
    if (deps.stopping()) {
      deps.log("party: stopping — staged, but no member is launched");
      return { fate: "stopped", verdicts: {}, written };
    }
  }

  // Shared start: every member in one pass, awaited together.
  const handles = await Promise.all(members.map((m) => deps.launch(m)));
  const order: number[] = [];
  const exits = handles.map((h, i) =>
    h.exited.then((exit) => {
      order.push(i);
      return exit;
    }),
  );
  const firstIdx = await Promise.race(exits.map((p, i) => p.then(() => i)));
  const signalled = deps.stopping();
  /** The end the others were asked to follow, when the first reached its definition's end. */
  let asked: { reason: EndReason; detail: string } | null = null;
  let endGrace: ReturnType<typeof setTimeout> | undefined;
  if (!signalled) {
    const first = members[firstIdx]!;
    // The first's own verdict is final the moment it exits: an end reason
    // decides the fate "ended" on that reason whatever the others do, so each
    // can be asked to end on it now rather than paused and rewritten later.
    const v = deps.verdict(first, await exits[firstIdx]!);
    const others = [...handles.entries()].filter(([i]) => i !== firstIdx);
    if (deps.requestEnd !== undefined && v.kind === "terminated" && isEndReason(v.reason)) {
      asked = { reason: v.reason, detail: `${first.member}: ${v.reason}` };
      const graceMs = deps.endGraceMs ?? deps.graceMs;
      deps.log(`party: ${first.member} (${first.runId}) reached ${v.reason} first — asking the other ${members.length - 1} to end on it (stopped after ${Math.round(graceMs / 1000)}s if still running)`);
      const exitedYet = new Set<number>();
      for (const [i] of others) {
        void exits[i]!.then(() => exitedYet.add(i));
        deps.requestEnd(members[i]!, asked.reason, asked.detail);
      }
      endGrace = setTimeout(() => {
        // A shared stop that landed meanwhile has already signalled everyone.
        if (deps.stopping()) return;
        for (const [i, h] of others) {
          if (exitedYet.has(i)) continue;
          deps.log(`party: ${members[i]!.member} (${members[i]!.runId}) has not ended on the request — stopping it with the episode grace`);
          void h.stop(deps.graceMs);
        }
      }, graceMs);
      endGrace.unref?.();
    } else {
      deps.log(`party: ${first.member} (${first.runId}) left the world first — stopping the other ${members.length - 1} with the episode grace`);
      for (const [, h] of others) void h.stop(deps.graceMs);
    }
  }
  const exitValues = await Promise.all(exits);
  if (endGrace !== undefined) clearTimeout(endGrace);
  const verdicts: Record<string, MemberVerdict> = {};
  const vs = members.map((m, i) => deps.verdict(m, exitValues[i]!));
  members.forEach((m, i) => {
    verdicts[m.member] = vs[i]!;
  });

  if ((signalled || deps.stopping()) && vs.every((v) => v.kind === "paused")) {
    // A shared stop (a drain, a fleet stop, a deploy window): every runner
    // paused itself as operator-pause through the signal it already gets, and
    // that is each one's verdict, from which the party resumes whole. A stop
    // that lands after a member had already ended on its own — the clocks ran
    // out and the stop came inside the others' grace — is no such party: it is
    // ended below like any other, or it would be listed unresumable forever.
    return { fate: "stopped", verdicts, written };
  }

  // The fate. The first exit decides, unless a pause it would make resumable
  // finds another member already ended on its own: half a party cannot come
  // back, so the first such termination (in exit order) ends it instead.
  let triggerIdx = firstIdx;
  let fate: "ended" | "paused" = ends(vs[firstIdx]!, deps.resumeOnPause) ? "ended" : "paused";
  if (fate === "paused") {
    const ender = order.find((i) => i !== firstIdx && vs[i]!.kind !== "paused");
    if (ender !== undefined) {
      fate = "ended";
      triggerIdx = ender;
    }
  }
  const trigger = { member: members[triggerIdx]!.member, reason: verdictReason(vs[triggerIdx]!) };
  const detail = `${trigger.member}: ${trigger.reason}`;
  // A party that reached its end reached it together: the others inherit the
  // trigger's own reason, which counts, rather than `party-ended`.
  const inherited = fate === "ended" && isEndReason(trigger.reason) ? trigger.reason : "party-ended";

  for (const [i, m] of members.entries()) {
    const v = vs[i]!;
    if (fate === "paused") {
      // Every verdict here is a pause (an ender would have made the fate
      // "ended"). The roster's own stop paused the rest as operator-pause;
      // a member that paused for a reason of its own keeps it.
      if (i !== triggerIdx && v.kind === "paused" && v.reason === "operator-pause") {
        deps.repause(m, detail);
        written.push({ member: m.member, wrote: "party-paused" });
      }
      continue;
    }
    if (v.kind === "launch-failed") {
      // A fresh member that never became a run: its own attempt record. A
      // resume that could not start leaves a paused run behind, which the
      // party's end must end too.
      if (!m.resume) {
        deps.launchFailed(m, v.detail);
        written.push({ member: m.member, wrote: "launch-failed" });
      } else if (i !== triggerIdx) {
        deps.end(m, inherited, detail);
        written.push({ member: m.member, wrote: inherited });
      }
      continue;
    }
    if (v.kind === "terminated") {
      // Its own verdict stands. One that is the end it was asked to follow,
      // with that detail, was the party's end written by its own runner.
      if (asked !== null && i !== triggerIdx && v.reason === asked.reason && v.detail === asked.detail) {
        written.push({ member: m.member, wrote: v.reason, followed: true });
      }
      continue;
    }
    if (i === triggerIdx) {
      // The trigger's own pause, in a lane that does not resume: ended the
      // way the lane ends any lapse.
      if (v.kind === "paused") written.push({ member: m.member, wrote: deps.endOwnPause(m, v) });
      // A trigger that exited with no verdict at all — a pod killed under it,
      // a runner that died — ended the party as surely as a termination: it
      // is ended with it, so no member is left for the planner to find half
      // a party of.
      if (v.kind === "unknown") {
        deps.end(m, "party-ended", `${m.member}: exited without a verdict — ${v.detail}`);
        written.push({ member: m.member, wrote: "party-ended" });
      }
      continue;
    }
    deps.end(m, inherited, detail);
    written.push({ member: m.member, wrote: inherited });
  }
  deps.log(`party: ${fate} — ${detail}`);
  return { fate, trigger, verdicts, written };
}
