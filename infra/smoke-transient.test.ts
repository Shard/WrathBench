/**
 * The two transient conditions a smoke may retry (infra/smoke/lib/transient.ts):
 * each retried only for its own reason, within its own bound, and announced.
 */
import { describe, expect, test } from "bun:test";
import { DELETE_LINGER_BUDGET_MS, deleteThroughLinger, moveRetryReason, RETRY_MARK, type DeleteReply } from "./smoke/lib/transient";

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
  test("a back-to-back rerun waits out the previous session's linger, saying so on each retry", async () => {
    const f = fakeDeletes([LINGER, LINGER, LINGER, { status: 200, json: { deleted: true } }]);
    const r = await deleteThroughLinger(f.opts);
    expect(r).toEqual({ ok: true, deleted: true, retries: 3, waitedMs: 88_000 });
    expect(f.logs).toHaveLength(3);
    for (const l of f.logs) {
      expect(l.startsWith(RETRY_MARK)).toBe(true);
      expect(l).toContain("post-logout linger");
    }
  });

  test("the first run on a realm has nothing to delete, and needs no retry", async () => {
    const f = fakeDeletes([{ status: 400, json: { error: "character_not_found" } }]);
    expect(await deleteThroughLinger(f.opts)).toEqual({ ok: true, deleted: false, retries: 0, waitedMs: 22_000 });
    expect(f.logs).toEqual([]);
  });

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

  test("an interrupted walk of a live character in its session is walked once more, and the reason says where it stopped", () => {
    const why = moveRetryReason({ status: "interrupted", pos: { x: -8905.5, y: -104.2, z: 82 } }, alive);
    expect(why).toContain("ended interrupted at (-8905.5, -104.2, 82.0), 4.0y short");
    expect(why).toContain("a second interrupted fails");
  });

  test("death, a logout, or any other verdict is never retried", () => {
    expect(moveRetryReason({ status: "interrupted" }, { ...alive, alive: false })).toBeUndefined();
    expect(moveRetryReason({ status: "interrupted" }, { ...alive, inSession: false })).toBeUndefined();
    for (const status of ["arrived", "target_off_mesh", "start_off_mesh", "too_far", "rooted", "stopped", "superseded", "path_incomplete"]) {
      expect(moveRetryReason({ status }, alive)).toBeUndefined();
    }
  });
});
