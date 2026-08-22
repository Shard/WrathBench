/**
 * POST-DEPLOY ONLY — needs the account-reclaim image (2026-08). Fails against
 * anything older, where a same-account create under a second token still returns
 * `account_in_use` (the exact harness trap this probe proves is gone).
 *
 * Reproduces the confirmed trap and asserts the fix. On a shared-account lane a
 * session could leak under a previous episode's token; the next episode's
 * createSession was then boxed in — `account_in_use` on create, `no_session` on
 * deleteSession (new token), and an empty state cache, with no recovery. The fix:
 * a normal `POST /session` on a permitted account RECLAIMS a stale/leaked session
 * instead of refusing.
 *
 * Flow (all on the PROBE account so it never fights the runner track):
 *   (a) create under token A (character A) → in world;
 *   (b) WITHOUT deleting A, create under token B (a DIFFERENT character) on the
 *       SAME account → used to be account_in_use; assert it now SUCCEEDS, and
 *       that token A's session is gone (an action under A → 404 no_session);
 *   (c) create under token B again (same token, in world, same character) →
 *       assert idempotent success (200 inWorld), not token_in_use;
 *   (d) with B live, POST /character-delete under a third token → assert it is
 *       still refused 409 account_owned_by_other_token (ownership gate intact);
 *   (e) cleanup: delete session B and both characters.
 *
 * The core releases an account up to ~a minute after a session drops (the same
 * window the runner's deleteCharacter loop rides), so B's create can legitimately
 * return `504 timeout` while A drains; the probe retries into it, exactly as a
 * caller should.
 *
 * Run from inside the network:
 *   docker compose -f infra/compose.yml exec runner bun infra/smoke/module-reclaim.ts
 */

const HOST = process.env.MODULE_HOST ?? "worldserver";
const PORT = process.env.MODULE_PORT ?? "8086";
const BASE = `http://${HOST}:${PORT}`;
const WS = `ws://${HOST}:${PORT}`;

// Own account so the probe never fights the runner track for the default
// RUNNER account (one live session per account).
const ACCOUNT = process.env.MODULE_ACCOUNT ?? "PROBE";

// Session tokens must be at least 32 characters (POST /session rejects shorter
// ones with weak_token); randomUUID keeps them unguessable and >= 32 chars.
const TOKEN_A = `probe-reclaim-a-${crypto.randomUUID()}`;
const TOKEN_B = `probe-reclaim-b-${crypto.randomUUID()}`;
const TOKEN_C = `probe-reclaim-c-${crypto.randomUUID()}`;

function randomName(): string {
  const letters = "abcdefghijklmnopqrstuvwxyz";
  let s = "Bench";
  for (let i = 0; i < 5; i++) s += letters[Math.floor(Math.random() * letters.length)];
  return s;
}
const CHAR_A = randomName();
const CHAR_B = randomName();

function log(msg: string) {
  console.log(`[probe] ${msg}`);
}
function fail(msg: string): never {
  console.error(`[probe] FAIL: ${msg}`);
  process.exit(1);
}

async function req(method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  let json: any = undefined;
  try {
    json = await res.json();
  } catch {
    /* ignore non-JSON */
  }
  return { status: res.status, json };
}

function openEvents(token: string, buf: any[]): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${WS}/events?token=${encodeURIComponent(token)}`);
    ws.addEventListener("open", () => resolve(ws));
    ws.addEventListener("error", (e) => reject(new Error(`ws error: ${String(e)}`)));
    ws.addEventListener("message", (ev) => {
      try {
        buf.push(JSON.parse(String(ev.data)));
      } catch {
        /* ignore */
      }
    });
  });
}

async function waitFor(buf: any[], pred: (e: any) => boolean, timeoutMs: number, what: string): Promise<any> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const hit = buf.find(pred);
    if (hit) return hit;
    if (Date.now() > deadline) fail(`timed out waiting for ${what}`);
    await Bun.sleep(100);
  }
}

// Create a session, retrying through the core's account-release window: while a
// stale session on the account drains, the reclaiming create returns
// `504 timeout` (retryable). `account_in_use` must NEVER appear on POST /session
// after the fix — if it does, that is the regression, so fail fast on it rather
// than retrying it into a long confusing timeout.
async function createWithReclaim(
  token: string,
  character: string,
): Promise<{ status: number; json: any }> {
  for (let attempt = 0; attempt < 25; attempt++) {
    const r = await req("POST", "/session", {
      token,
      account: ACCOUNT,
      character,
      race: 1,
      class: 1,
    });
    if (r.status === 200) return r;
    if (r.json?.error !== "timeout") return r;   // only `timeout` is the retryable release-in-progress
    log(`create for ${character} still draining the account (${r.status} ${r.json?.error}); retrying`);
    await Bun.sleep(2_000);
  }
  return { status: 0, json: { error: "reclaim_never_converged" } };
}

// Delete a character, retrying through the release window (account_in_use /
// timeout are transient), mirroring the runner's deleteCharacter.
async function deleteCharacter(character: string, tag: string): Promise<boolean> {
  for (let attempt = 0; attempt < 25; attempt++) {
    const del = await req("POST", "/character-delete", {
      token: `probe-reclaim-del-${tag}-${crypto.randomUUID()}`,
      account: ACCOUNT,
      character,
    });
    if (del.status === 200 && del.json?.deleted) return true;
    if (del.json?.error !== "account_in_use" && del.json?.error !== "timeout") {
      log(`character delete (${character}) got unexpected ${del.status} ${JSON.stringify(del.json)}`);
    }
    await Bun.sleep(3_000);
  }
  return false;
}

async function cleanup() {
  await req("DELETE", "/session", { token: TOKEN_A }).catch(() => {});
  await req("DELETE", "/session", { token: TOKEN_B }).catch(() => {});
  for (const [c, tag] of [[CHAR_A, "a"], [CHAR_B, "b"]] as const) {
    if (!(await deleteCharacter(c, tag))) {
      log(`warning: could not delete character ${c}; sweep the ${ACCOUNT} account later`);
    }
  }
}

async function main() {
  const health = await req("GET", "/health");
  if (health.status !== 200 || !health.json?.ok) fail(`health not ok: ${JSON.stringify(health)}`);
  if (health.json.worldStopped) fail("world is stopped");

  // --- (a) token A in world.
  const a = await createWithReclaim(TOKEN_A, CHAR_A);
  if (a.status !== 200 || !a.json?.ok || !a.json?.inWorld) {
    fail(`(a) create under token A failed: ${a.status} ${JSON.stringify(a.json)}`);
  }
  log(`(a) in world as ${CHAR_A} under token A`);

  // --- (b) create under token B on the SAME account, WITHOUT deleting A.
  // This is the exact trap; it must now succeed by reclaiming A's session.
  const b = await createWithReclaim(TOKEN_B, CHAR_B);
  if (b.status !== 200 || !b.json?.ok || !b.json?.inWorld) {
    fail(
      `(b) create under token B did NOT reclaim the account: ${b.status} ${JSON.stringify(b.json)} ` +
        `(pre-fix this returns 400 account_in_use — the trap)`,
    );
  }
  if (b.json?.character !== CHAR_B) {
    fail(`(b) reclaim returned the wrong character: expected ${CHAR_B}, got ${JSON.stringify(b.json)}`);
  }
  log(`(b) reclaimed the account; in world as ${CHAR_B} under token B`);

  // token A's session must be gone: an action under it answers no_session.
  const aGone = await req("POST", "/action", { token: TOKEN_A, action: "stop" });
  if (aGone.status !== 404 || aGone.json?.error !== "no_session") {
    fail(`(b) token A's session was not torn down: action under A got ${aGone.status} ${JSON.stringify(aGone.json)}`);
  }
  log(`(b) token A's session is gone (action → 404 no_session)`);

  // --- (c) same-token create while B is in world → idempotent success that
  // also re-syncs state (a WB_SESSION_STATE lands on B's event stream). Open a
  // subscriber first; that itself triggers one reattach state event (ADR-0014),
  // so we count from after it and require a NEW one from the idempotent create.
  const bufB: any[] = [];
  const wsB = await openEvents(TOKEN_B, bufB);
  await waitFor(bufB, (e) => e.opcode === "WB_SESSION_STATE", 10_000, "(c) reattach WB_SESSION_STATE on subscribe");
  const before = bufB.filter((e) => e.opcode === "WB_SESSION_STATE").length;

  const c = await req("POST", "/session", {
    token: TOKEN_B, account: ACCOUNT, character: CHAR_B, race: 1, class: 1,
  });
  if (c.status !== 200 || !c.json?.ok || !c.json?.inWorld) {
    fail(`(c) idempotent same-token create failed: ${c.status} ${JSON.stringify(c.json)} (expected 200, not token_in_use)`);
  }
  if (c.json?.character !== CHAR_B) {
    fail(`(c) idempotent create returned the wrong character: ${JSON.stringify(c.json)}`);
  }
  const deadline = Date.now() + 10_000;
  while (bufB.filter((e) => e.opcode === "WB_SESSION_STATE").length <= before) {
    if (Date.now() > deadline) fail("(c) idempotent create emitted no fresh WB_SESSION_STATE (state re-sync missing)");
    await Bun.sleep(100);
  }
  const states = bufB.filter((e) => e.opcode === "WB_SESSION_STATE");
  const stateEv = states[states.length - 1];
  if (String(stateEv.data?.guid) !== String(c.json.guid)) {
    fail(`(c) re-sync state event guid ${stateEv.data?.guid} != create guid ${c.json.guid}`);
  }
  wsB.close();
  log(`(c) same-token in-world create returned idempotent success and re-synced state`);

  // --- (d) character-delete under a third token is still refused (ownership gate).
  const d = await req("POST", "/character-delete", {
    token: TOKEN_C, account: ACCOUNT, character: CHAR_B,
  });
  if (d.status !== 409 || d.json?.error !== "account_owned_by_other_token") {
    fail(
      `(d) character-delete ownership gate regressed: expected 409 account_owned_by_other_token, ` +
        `got ${d.status} ${JSON.stringify(d.json)}`,
    );
  }
  log(`(d) character-delete under a third token still refused (409 account_owned_by_other_token)`);

  // --- (e) cleanup.
  const bye = await req("DELETE", "/session", { token: TOKEN_B });
  if (bye.status !== 200) log(`warning: session B delete returned ${bye.status} ${JSON.stringify(bye.json)}`);
  for (const [ch, tag] of [[CHAR_A, "a"], [CHAR_B, "b"]] as const) {
    if (!(await deleteCharacter(ch, tag))) {
      fail(`(e) character delete never succeeded for ${ch}; sweep the ${ACCOUNT} account`);
    }
  }
  log("(e) both characters deleted");

  log("PASS");
  process.exit(0);
}

main().catch(async (err) => {
  await cleanup().catch(() => {});
  fail(String(err));
});
