/**
 * Probe for the account allowlist gates (WrathBench.Accounts) on the three
 * account-taking surfaces — the destructive-path coverage the fan-out review
 * flagged as missing:
 *
 *   1. a non-allowlisted account is refused with 403 account_not_permitted on
 *      POST /session, POST /characters, and POST /character-delete;
 *   2. an allowlisted account works (POST /characters answers with the enum);
 *   3. POST /character-delete is refused (409 account_owned_by_other_token)
 *      while a *different* token holds a live bench session on the account,
 *      and succeeds once that session is gone.
 *
 * It also probes the minimum-entropy token gate (FOLLOW-UPS 19): POST /session
 * with a sub-32-character token is refused 400 weak_token with an actionable
 * hint. That check needs the trainer/token-hardening image and fails against
 * anything older; the three account gates predate it. The one behavior
 * this cannot cover black-box is the world-thread re-check that closes the
 * same-tick create/delete race (DoCreateSession's _byToken scan): hitting it
 * deterministically needs two requests inside one world tick, which an
 * external probe cannot schedule. That path is compile-time-only for now.
 *
 * Run from inside the network:
 *   docker compose -f infra/compose.yml exec runner bun infra/smoke/module-accounts.ts
 */

import { authHeaders } from "./lib/auth";

const HOST = process.env.MODULE_HOST ?? "worldserver";
const PORT = process.env.MODULE_PORT ?? "8086";
const BASE = `http://${HOST}:${PORT}`;

// Own account so the probe never fights the runner track for the default
// RUNNER account (one live session per account).
const ACCOUNT = process.env.MODULE_ACCOUNT ?? "PROBE";
// Must not be on WrathBench.Accounts; nothing else about it needs to exist.
const BAD_ACCOUNT = process.env.MODULE_BAD_ACCOUNT ?? "WBNOTALLOWED";

// Session tokens must be at least 32 characters (POST /session rejects
// shorter ones with weak_token); randomUUID keeps them unguessable too.
const TOKEN = `probe-acct-${crypto.randomUUID()}`;

function randomName(): string {
  const letters = "abcdefghijklmnopqrstuvwxyz";
  let s = "Bench";
  for (let i = 0; i < 5; i++) s += letters[Math.floor(Math.random() * letters.length)];
  return s;
}
const CHARACTER = randomName();

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
    headers: { ...authHeaders(), ...(body ? { "content-type": "application/json" } : {}) },
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

function expectRefusal(
  what: string,
  r: { status: number; json: any },
  status: number,
  error: string,
) {
  if (r.status !== status || r.json?.error !== error) {
    fail(`${what}: expected ${status} ${error}, got ${r.status} ${JSON.stringify(r.json)}`);
  }
  log(`${what}: refused as expected (${status} ${error})`);
}

// Delete CHARACTER on ACCOUNT, retrying through the core's session-release
// window (account_in_use for up to ~60s after a session drops).
async function deleteCharacter(tag: string): Promise<boolean> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const del = await req("POST", "/character-delete", {
      token: `${TOKEN}-${tag}${attempt}`,
      account: ACCOUNT,
      character: CHARACTER,
    });
    if (del.status === 200) return true;
    if (del.json?.error !== "account_in_use" && del.json?.error !== "timeout") {
      log(`character delete got unexpected ${del.status} ${JSON.stringify(del.json)}`);
    }
    await Bun.sleep(3_000);
  }
  return false;
}

async function cleanup() {
  await req("DELETE", "/session", { token: TOKEN });
  if (!(await deleteCharacter("sweep"))) {
    log(`warning: could not delete character ${CHARACTER}; sweep the ${ACCOUNT} account later`);
  }
}

async function main() {
  const health = await req("GET", "/health");
  if (health.status !== 200 || !health.json?.ok) fail(`health not ok: ${JSON.stringify(health)}`);
  if (health.json.worldStopped) fail("world is stopped");

  // --- 1. Non-allowlisted account: 403 on every account-taking surface.
  expectRefusal(
    "/session on non-allowlisted account",
    await req("POST", "/session", {
      token: `${TOKEN}-bad1`, account: BAD_ACCOUNT, character: CHARACTER, race: 1, class: 1,
    }),
    403, "account_not_permitted",
  );
  expectRefusal(
    "/characters on non-allowlisted account",
    await req("POST", "/characters", { token: `${TOKEN}-bad2`, account: BAD_ACCOUNT }),
    403, "account_not_permitted",
  );
  expectRefusal(
    "/character-delete on non-allowlisted account",
    await req("POST", "/character-delete", {
      token: `${TOKEN}-bad3`, account: BAD_ACCOUNT, character: CHARACTER,
    }),
    403, "account_not_permitted",
  );

  // --- 1b. Minimum-entropy token gate on POST /session (FOLLOW-UPS 19).
  // Needs the trainer/token-hardening image; fails against anything older.
  const weak = await req("POST", "/session", {
    token: "short-token", account: ACCOUNT, character: CHARACTER, race: 1, class: 1,
  });
  expectRefusal("/session with a sub-32-character token", weak, 400, "weak_token");
  if (weak.json?.received !== "short-token".length || weak.json?.minimum !== 32 || !weak.json?.hint) {
    fail(`weak_token reply is missing its actionable fields: ${JSON.stringify(weak.json)}`);
  }

  // --- 2. Allowlisted account works: enum answers.
  const list = await req("POST", "/characters", { token: `${TOKEN}-list`, account: ACCOUNT });
  if (list.status !== 200 || !list.json?.ok || typeof list.json?.enum?.count !== "number") {
    fail(`/characters on ${ACCOUNT} failed: ${list.status} ${JSON.stringify(list.json)}`);
  }
  log(`/characters on ${ACCOUNT} ok (${list.json.enum.count} characters)`);

  // --- 3. Delete refused while another token holds the account.
  const session = await req("POST", "/session", {
    token: TOKEN, account: ACCOUNT, character: CHARACTER, race: 1, class: 1,
  });
  if (session.status !== 200 || !session.json?.ok || !session.json?.inWorld) {
    fail(`session create failed: ${session.status} ${JSON.stringify(session.json)}`);
  }
  log(`in world as ${CHARACTER} on ${ACCOUNT}`);

  expectRefusal(
    "/character-delete while another token holds the account",
    await req("POST", "/character-delete", {
      token: `${TOKEN}-steal`, account: ACCOUNT, character: CHARACTER,
    }),
    409, "account_owned_by_other_token",
  );

  const bye = await req("DELETE", "/session", { token: TOKEN });
  if (bye.status !== 200) fail(`session delete failed: ${bye.status} ${JSON.stringify(bye.json)}`);

  // --- and succeeds once the session is gone (also the character cleanup).
  if (!(await deleteCharacter("del"))) {
    fail(`character delete never succeeded after session teardown; sweep ${CHARACTER} on ${ACCOUNT}`);
  }
  log("character delete succeeded after session teardown");

  log("PASS");
  process.exit(0);
}

main().catch(async (err) => {
  await cleanup().catch(() => {});
  fail(String(err));
});
