/**
 * What the SDK-driven smokes share around a client: the fixture boot's
 * create-and-log-out, a login that waits out a contended account, the first
 * position after login, and the next matching event on the stream.
 *
 * Kept apart from lib/fixture.ts, which stays SDK-free: kill-credit drives
 * the fixture boot over raw HTTP and the launch gate imports it.
 */

import { connect, type StreamEvent, type WrathClient } from "@wrathbench/sdk";
import { MODULE_SECRET } from "./auth";

/**
 * A fixture's `createAndLogout` on its own client: a session under `token`
 * (which creates the character through CMSG_CHAR_CREATE when it does not
 * exist), a logout, and the client closed whatever happened.
 */
export async function sdkCreateAndLogout(o: { base: string; token: string; account: string; character: string; race: number; class: number }): Promise<void> {
  const c = await connect({ baseUrl: o.base, token: o.token, secret: MODULE_SECRET });
  try {
    await c.createSession({ account: o.account, character: o.character, race: o.race, class: o.class });
    await c.logout();
  } finally {
    c.close();
  }
}

/**
 * A Human Warrior's login that waits out another holder of the account (up
 * to 20 minutes, a minute apart), and fails at once, through the smoke's own
 * `fail`, on the realm's ten-character cap.
 */
export async function createSessionWithBackoff(
  client: WrathClient,
  o: { account: string; character: string; log: (msg: string) => void; fail: (msg: string) => never },
): Promise<void> {
  // Another probe may hold the single PROBE session; wait it out (up to 20min).
  const deadline = Date.now() + 20 * 60_000;
  for (;;) {
    try {
      await client.createSession({ account: o.account, character: o.character, race: 1, class: 1 });
      return;
    } catch (e) {
      const msg = String(e instanceof Error ? e.message : e);
      if (/char_create_failed_code_53/.test(msg)) {
        o.fail(`${o.account} is at the realm's ten-character cap, so ${o.character} cannot be created; delete a spare character or set SMOKE_CHARACTER to one that exists`);
      }
      if (!/account_in_use|token_in_use|in use/i.test(msg) || Date.now() > deadline) throw e;
      o.log(`  account busy (${msg.slice(0, 80)}); retrying in 60s`);
      await Bun.sleep(60_000);
    }
  }
}

/** The character's position once the cache has one, or the smoke's `fail` after 10s. */
export async function selfPosition(client: WrathClient, fail: (msg: string) => never): Promise<{ map: number; x: number; y: number; z: number }> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const p = client.state.self.position?.value;
    if (p !== undefined) return p;
    if (Date.now() > deadline) fail("no self position observed after login");
    await Bun.sleep(100);
  }
}

/** The next event after `from` matching, or undefined on timeout. */
export async function nextStreamEvent(client: WrathClient, from: number, match: (e: StreamEvent) => boolean, ms: number): Promise<StreamEvent | undefined> {
  const already = client.events.recent().find((e) => e.seq > from && match(e));
  if (already !== undefined) return already;
  try {
    return await client.events.waitFor((e) => e.seq > from && match(e), { timeout: ms });
  } catch {
    return undefined;
  }
}

/** An event's `data` as a record, empty for none. */
export const eventData = (e: StreamEvent | undefined): Record<string, unknown> => (e?.data ?? {}) as Record<string, unknown>;
