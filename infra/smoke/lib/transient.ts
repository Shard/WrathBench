/**
 * The two transient conditions a smoke may retry, each named, bounded and
 * announced. A retry is only ever of one specific condition the module and
 * the core are documented to produce for a reason outside the claim under
 * test; anything else fails the smoke as it always did. Every retry prints a
 * line carrying `RETRY_MARK`, and the suite shows those lines beside a PASS
 * (`formatSummary`), so a pass that needed one never reads as a clean pass.
 */

/** What every retry line carries; the suite collects the lines that do. */
export const RETRY_MARK = "RETRY:";

/**
 * How long a delete may wait out the core's post-logout linger. A character
 * whose session disconnected stays in world for about a minute (measured
 * 66 s from logout to a successful delete), and a `CMSG_CHAR_DELETE` in that
 * window is silently ignored, which the module reports as `504 timeout` after
 * its own 20 s wait (wrath-mcp/module/PROTOCOL.md, `POST /character-delete`).
 * Only a smoke re-run within a minute of its last session meets it.
 */
export const DELETE_LINGER_BUDGET_MS = 90_000;

/** A `POST /character-delete` reply, as a smoke's request helper returns it. */
export interface DeleteReply {
  status: number;
  json: { deleted?: boolean; error?: string } | undefined;
}

export type DeleteOutcome =
  | { ok: true; deleted: boolean; retries: number; waitedMs: number }
  | { ok: false; why: string };

/**
 * Delete last run's character, waiting out the post-logout linger and nothing
 * else. `deleted` is false for a character that does not exist (the first run
 * on a realm). Only a `504 timeout` is retried, until `budgetMs` has passed;
 * any other error, or the budget spent, is a failure with the reply in it.
 */
export async function deleteThroughLinger(o: {
  /** One `POST /character-delete` under a fresh token for `attempt`. */
  post: (attempt: number) => Promise<DeleteReply>;
  character: string;
  log: (msg: string) => void;
  budgetMs?: number;
  /** Pause between a 504 and the next attempt; the module's own wait is most of the gap. */
  gapMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}): Promise<DeleteOutcome> {
  const now = o.now ?? Date.now;
  const sleep = o.sleep ?? ((ms: number) => Bun.sleep(ms));
  const budget = o.budgetMs ?? DELETE_LINGER_BUDGET_MS;
  const t0 = now();
  for (let attempt = 0; ; attempt++) {
    const r = await o.post(attempt);
    if (r.json?.deleted === true) return { ok: true, deleted: true, retries: attempt, waitedMs: now() - t0 };
    if (r.json?.error === "character_not_found") return { ok: true, deleted: false, retries: attempt, waitedMs: now() - t0 };
    const linger = r.status === 504 && r.json?.error === "timeout";
    if (!linger) return { ok: false, why: `character-delete of ${o.character}: ${r.status} ${JSON.stringify(r.json)}` };
    const waited = now() - t0;
    if (waited >= budget) {
      return {
        ok: false,
        why: `character-delete of ${o.character} still 504 timeout after ${Math.round(waited / 1000)}s, longer than the core's post-logout linger (budget ${Math.round(budget / 1000)}s)`,
      };
    }
    o.log(
      `${RETRY_MARK} character-delete of ${o.character} answered 504 timeout (attempt ${attempt + 1}, ${Math.round(waited / 1000)}s in): ` +
        `the character is still inside the core's post-logout linger from its last session, which ignores a delete for about a minute; ` +
        `retrying until ${Math.round(budget / 1000)}s`,
    );
    await sleep(o.gapMs ?? 2000);
  }
}

/**
 * How far the server must have carried the character from a walk's start
 * before an `interrupted` counts as mid-walk (`moveRetryReason`'s `from`):
 * more than a run's first heartbeat (3.5y at run speed), so a walk the server
 * never applied stays a failure.
 */
export const MOVE_ACCEPTED_YARDS = 5;

/**
 * The character's own health as the event stream last gave it, or undefined
 * before any reading: the self unit's `create` block names it (`self`), and
 * every later `create` or `values` block for that guid carries the change. A
 * 0 is a dead character, whose `move_to` the module refuses `rooted` (death
 * roots, wrath-mcp/module/PROTOCOL.md "Roots").
 */
export function selfHealth(events: readonly any[]): number | undefined {
  let guid: string | undefined;
  let health: number | undefined;
  for (const e of events) {
    if (e?.opcode !== "SMSG_UPDATE_OBJECT" || !Array.isArray(e.data?.objects)) continue;
    for (const o of e.data.objects) {
      if (o?.update === "create" && o.self) guid = o.guid;
      if ((o?.update === "create" || o?.update === "values") && guid !== undefined && o.guid === guid && typeof o.fields?.health === "number") health = o.fields.health;
    }
  }
  return health;
}

/** A `WB_MOVE_RESULT` as a smoke reads it. */
export interface MoveResult {
  status: string;
  pos?: { x: number; y: number; z: number };
}

/**
 * Why a move that did not arrive may be walked once more, or undefined when it
 * may not. Only `interrupted` qualifies, and only while the character is alive
 * and still in its session. The module ends a walk `interrupted` on death, on
 * leaving the map, when the server's position drifts more than 15y from the
 * walk it synthesized, or when a stop misses its deadline. The last two are
 * timing against the world thread, which a busy server can trip on a walk
 * that is otherwise fine (seen once, about a minute after a worldserver boot
 * while another character was resuming; the next four passed). Death and a
 * logout are never retried, and any other status (off mesh, too far,
 * rooted, …) is a verdict on the walk itself.
 *
 * `from`, where the walk started, narrows it to a walk the server accepted:
 * an `interrupted` within MOVE_ACCEPTED_YARDS of the start is the server
 * refusing the run (a character it still held as moving, the
 * module-navigation smoke's after-failure leg), and is never retried. A world
 * tick stall long enough to trip the drift check lands mid-walk, after the
 * server has applied heartbeats (module-navigation, 10.6y in).
 */
export function moveRetryReason(
  r: MoveResult,
  o: { alive: boolean; inSession: boolean; target: { x: number; y: number }; from?: { x: number; y: number } },
): string | undefined {
  if (r.status !== "interrupted" || !o.alive || !o.inSession) return undefined;
  if (o.from !== undefined && (r.pos === undefined || Math.hypot(r.pos.x - o.from.x, r.pos.y - o.from.y) < MOVE_ACCEPTED_YARDS)) return undefined;
  const at = r.pos !== undefined ? ` at (${r.pos.x.toFixed(1)}, ${r.pos.y.toFixed(1)}, ${r.pos.z.toFixed(1)}), ${Math.hypot(r.pos.x - o.target.x, r.pos.y - o.target.y).toFixed(1)}y short` : "";
  return (
    `ended interrupted${at} with the character alive and in its session, so neither death nor a logout: ` +
    "the module's drift or stop-deadline check, which load on the world thread can trip — walking it once more; a second interrupted fails"
  );
}
