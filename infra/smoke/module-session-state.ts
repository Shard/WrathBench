/**
 * Probe for the WB_SESSION_STATE reattach event (PROTOCOL.md /events section):
 * a WebSocket that subscribes to a token whose session is already in world
 * must receive one synthetic WB_SESSION_STATE frame carrying the session's
 * self state. This is the recovery path a model relies on after a sandbox
 * restart, so it gets verified live, not just in SDK unit tests.
 *
 * Flow: WS #1 + POST /session on the PROBE account → in world → drop WS #1 →
 * open WS #2 on the same token → assert WB_SESSION_STATE arrives with the
 * right character/guid → also assert WS #3 (concurrent subscriber) sees the
 * same event with the same seq → DELETE /session + character cleanup.
 *
 * Run from inside the network:
 *   docker compose -f infra/compose.yml exec runner bun infra/smoke/module-session-state.ts
 */

import { authHeaders } from "./lib/auth";

const HOST = process.env.MODULE_HOST ?? "worldserver";
const PORT = process.env.MODULE_PORT ?? "8086";
const BASE = `http://${HOST}:${PORT}`;
const WS = `ws://${HOST}:${PORT}`;

// Own account so the probe never fights the runner track for the default
// RUNNER account (one live session per account).
const ACCOUNT = process.env.MODULE_ACCOUNT ?? "PROBE";
// Session tokens must be at least 32 characters (POST /session rejects
// shorter ones with weak_token); randomUUID keeps them unguessable too.
const TOKEN = `probe-state-${crypto.randomUUID()}`;

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

function openEvents(buf: any[]): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${WS}/events?token=${encodeURIComponent(TOKEN)}`, { headers: authHeaders() });
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

async function cleanup() {
  await req("DELETE", "/session", { token: TOKEN });
  for (let attempt = 0; attempt < 10; attempt++) {
    const del = await req("POST", "/character-delete", {
      token: `${TOKEN}-del${attempt}`,
      account: ACCOUNT,
      character: CHARACTER,
    });
    if (del.status === 200) return;
    await Bun.sleep(2_000);
  }
  log(`warning: could not delete character ${CHARACTER}; sweep the ${ACCOUNT} account later`);
}

async function main() {
  const health = await req("GET", "/health");
  if (health.status !== 200 || !health.json?.ok) fail(`health not ok: ${JSON.stringify(health)}`);

  // In world with a live first subscriber.
  const buf1: any[] = [];
  const ws1 = await openEvents(buf1);
  await Bun.sleep(200);
  const session = await req("POST", "/session", { token: TOKEN, account: ACCOUNT, character: CHARACTER, race: 1, class: 1 });
  if (session.status !== 200 || !session.json?.ok || !session.json?.inWorld) {
    fail(`session create failed: ${session.status} ${JSON.stringify(session.json)}`);
  }
  log(`in world as ${CHARACTER} (guid ${session.json.guid})`);

  // A subscribe *during* login emits nothing; ws1 attached pre-login and must
  // not have received a synthetic state event.
  if (buf1.some((e) => e.opcode === "WB_SESSION_STATE")) {
    fail("WB_SESSION_STATE emitted to the original pre-login subscriber");
  }

  // Reattach: fresh subscriber to the already-in-world session.
  ws1.close();
  await Bun.sleep(300);
  const buf2: any[] = [];
  await openEvents(buf2);
  const stateEv = await waitFor(buf2, (e) => e.opcode === "WB_SESSION_STATE", 10_000, "WB_SESSION_STATE on reattach");
  const d = stateEv.data ?? {};
  if (d.character !== CHARACTER) fail(`state event character ${d.character} != ${CHARACTER}`);
  if (String(d.guid) !== String(session.json.guid)) fail(`state event guid ${d.guid} != ${session.json.guid}`);
  if (d.inWorld !== true) fail(`state event inWorld ${d.inWorld}`);
  for (const k of ["map", "x", "y", "z", "o", "level"]) {
    if (typeof d[k] !== "number") fail(`state event missing numeric ${k}: ${JSON.stringify(d)}`);
  }
  log(`reattach state ok: level ${d.level} at map ${d.map} (${d.x.toFixed(1)}, ${d.y.toFixed(1)}, ${d.z.toFixed(1)}), seq ${stateEv.seq}`);

  // Fan-out: another subscriber triggers another synthetic event; both sockets
  // see it, with the same seq (it is a real event in the session's stream).
  const buf3: any[] = [];
  await openEvents(buf3);
  const ev3 = await waitFor(buf3, (e) => e.opcode === "WB_SESSION_STATE", 10_000, "WB_SESSION_STATE for third subscriber");
  const echoed = await waitFor(buf2, (e) => e.opcode === "WB_SESSION_STATE" && e.seq === ev3.seq, 10_000, "fan-out of the third subscriber's state event to ws2");
  if (echoed.data?.character !== CHARACTER) fail("fanned-out state event mismatch");
  log(`fan-out ok: subscriber #3's state event (seq ${ev3.seq}) also reached subscriber #2`);

  await cleanup();
  log("PASS");
  process.exit(0); // open WebSockets would otherwise hold the event loop
}

main().catch(async (err) => {
  await cleanup().catch(() => {});
  fail(String(err));
});
