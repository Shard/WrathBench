/**
 * The two transient conditions a smoke may retry (infra/smoke/lib/transient.ts):
 * each retried only for its own reason and within its own bound.
 */
import { describe, expect, test } from "bun:test";
import { DELETE_LINGER_BUDGET_MS, deleteThroughLinger, MOVE_ACCEPTED_YARDS, moveRetryReason, type DeleteReply } from "./smoke/lib/transient";

/** A fake module: each attempt returns the next reply, and each takes `stepMs` of a fake clock (the module's own 20 s wait). */
function fakeDeletes(replies: DeleteReply[], stepMs = 22_000) {
  let clock = 0;
  const logs: string[] = [];
  let calls = 0;
  return {
    logs,
    calls: () => calls,
    opts: {
      character: "Qasmoked",
      log: (m: string) => void logs.push(m),
      now: () => clock,
      sleep: async () => {},
      post: async () => {
        clock += stepMs;
        return replies[Math.min(calls++, replies.length - 1)]!;
      },
    },
  };
}

const LINGER: DeleteReply = { status: 504, json: { error: "timeout" } };

describe("deleteThroughLinger", () => {
  test("anything but a 504 timeout fails at once, never retried", async () => {
    for (const reply of [
      { status: 409, json: { error: "account_owned_by_other_token" } },
      { status: 502, json: { error: "char_delete_failed_code_71" } },
      { status: 504, json: { error: "something_else" } },
      { status: 500, json: undefined },
    ] satisfies DeleteReply[]) {
      const f = fakeDeletes([reply, { status: 200, json: { deleted: true } }]);
      const r = await deleteThroughLinger(f.opts);
      expect(r.ok).toBe(false);
      expect(f.calls()).toBe(1);
      expect(f.logs).toEqual([]);
    }
  });

  test("a 504 that outlasts the linger is a failure, not an endless wait", async () => {
    const f = fakeDeletes([LINGER]);
    const r = await deleteThroughLinger(f.opts);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.why).toContain("longer than the core's post-logout linger");
    expect(f.calls()).toBe(Math.ceil(DELETE_LINGER_BUDGET_MS / 22_000));
  });
});

describe("moveRetryReason", () => {
  const target = { x: -8909.5, y: -104.2 };
  const alive = { alive: true, inSession: true, target };

  test("death, a logout, or any other verdict is never retried", () => {
    expect(moveRetryReason({ status: "interrupted" }, { ...alive, alive: false })).toBeUndefined();
    expect(moveRetryReason({ status: "interrupted" }, { ...alive, inSession: false })).toBeUndefined();
    for (const status of ["arrived", "target_off_mesh", "start_off_mesh", "too_far", "rooted", "stopped", "superseded", "path_incomplete"]) {
      expect(moveRetryReason({ status }, alive)).toBeUndefined();
    }
  });

  // module-navigation's after-failure leg, harness-1.0-49: a ~3 s world tick
  // stall stopped the walker's heartbeats at 10.6y from HOME, and the drift
  // check ended the walk there. The regression the leg pins ends the same way
  // with the character still at HOME, because the server never took the run.
  const home = { x: -8949.95, y: -132.49 };
  const courtyard = { x: -8913.2, y: -137.6 };

  test("with a start, an interrupted walk the server never moved is a failure, not a retry", () => {
    const at = (dx: number) => ({ status: "interrupted", pos: { x: home.x + dx, y: home.y, z: 83.5 } });
    expect(moveRetryReason(at(0), { ...alive, target: courtyard, from: home })).toBeUndefined();
    expect(moveRetryReason(at(MOVE_ACCEPTED_YARDS - 0.1), { ...alive, target: courtyard, from: home })).toBeUndefined();
    expect(moveRetryReason({ status: "interrupted" }, { ...alive, target: courtyard, from: home })).toBeUndefined();
    expect(moveRetryReason(at(MOVE_ACCEPTED_YARDS + 0.1), { ...alive, target: courtyard, from: home })).toBeDefined();
  });
});
