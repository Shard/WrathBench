/**
 * The module's limits, live (wrath-mcp/module/PROTOCOL.md, "Limits"; added in
 * wrath-mcp#57). Raw HTTP and sockets, no SDK: what is under test is the
 * module's own answers to a caller holding only a lease secret.
 *
 *   0. Gate: a `POST /action` whose declared body is over 64 KiB is answered
 *      `413 body_too_large`. A module that answers anything else (or waits for
 *      the body and serves it) predates the limits, and the smoke stops there.
 *   1. `POST /lease` with the port secret on MODULE_ACCOUNT, then a create (or
 *      login) of its persistent character with the lease secret.
 *   2. Lease-secret `/events` upgrades on that token until one is refused: the
 *      first one past `WrathBench.EventsSubscribersPerToken` (4 by default,
 *      SMOKE_EVENTS_SUBSCRIBERS for a world set otherwise) is
 *      `429 subscriber_limit`. One closed, a new one is admitted. At the cap
 *      again, a port-secret subscriber is admitted, and a lease-secret one is
 *      still refused, so the port secret's socket was not counted.
 *   3. The request rate (`WrathBench.ActionRate`), off by default. A burst of
 *      requests the module refuses on its HTTP thread (an unknown action):
 *      they draw from the lease's bucket like any action but never wait on the
 *      world thread, so the burst measures the bucket and not the world's
 *      pace. Any `429 rate_limited` must come after some were served, and a
 *      real action a second later is served again. None refused is a world
 *      with the rate off: logged as such, and a pass.
 *   4. The `/health` view by credential (wrath-mcp#70): the port secret's
 *      carries `limits` and `leases`, a lease secret's neither, wherever
 *      either calls from.
 *   Cleanup, always: the subscribers closed, then `DELETE /session` and
 *   `DELETE /lease` with the port secret, which no limit applies to (a lease
 *   secret's logout after the burst could itself be rate limited).
 *   5. One-step character binding (wrath-mcp#70), on a fresh lease of the
 *      same account once the first is released: two first creates naming
 *      different characters, sent at once, answer one `200` and one `409
 *      character_bound` whose `bound` names the winner. Cleaned up the same
 *      way.
 *
 * Not exercised: `431 header_too_large` (the same path as 413), `429
 * lease_limit` (1024 leases), and the connection caps.
 *
 * It FAILS against a module that predates wrath-mcp#57, saying so. A member of
 * the on-demand suite (lib/suite.ts), not of the preflight gate.
 *
 *   bun wb smoke module-limits
 *   bun wb --local smoke module-limits   # the quickstart
 *
 * MODULE_ACCOUNT defaults to SMOKE4 (a suite account, with room for the
 * persistent `Lim` + account letters character, e.g. `Limsmokee`).
 */

import { connect, type Socket } from "node:net";
import { leaseSessionSecret, logoutSession, releaseSessionSecret } from "@wrathbench/mcp/module-auth";
import { authHeaders, MODULE_SECRET } from "./lib/auth";
import { failOnce } from "./lib/fail";
import { accountFixtureName } from "./lib/fixture";
import { moduleBase } from "./lib/module";
import { smokeToken } from "./lib/session";
import { RETRY_MARK } from "./lib/transient";
import { stampedLog } from "./lib/report";

const BASE = moduleBase();
const ACCOUNT = process.env.MODULE_ACCOUNT ?? "SMOKE4";
const TOKEN = smokeToken("module-limits");
const CHARACTER = process.env.SMOKE_CHARACTER ?? accountFixtureName("Lim", ACCOUNT);
/** Step 5's token, and the second persistent character its race names. */
const BIND_TOKEN = smokeToken("module-limits", { role: "bind" });
const RIVAL = accountFixtureName("Lib", ACCOUNT);
/** The module's default; the chart sets none. */
const SUBSCRIBERS = Number(process.env.SMOKE_EVENTS_SUBSCRIBERS ?? "4");
/** Upgrades tried before concluding there is no cap at all. */
const SUBSCRIBER_TRIES = Math.max(12, SUBSCRIBERS + 2);
const BODY_LIMIT = 64 * 1024;
const BURST = 60;
const REPLY_MS = 5_000;
const PREDATES = "the module predates the limits (wrath-mcp#57)";

const started = Date.now();
const log = stampedLog("module-limits", started);

const held: Socket[] = [];
let leased = false;
let bindLeased = false;
let cleaned: Promise<void> | undefined;
/** Once, from the pass and the fail path alike. */
function cleanup(): Promise<void> {
  cleaned ??= (async () => {
    for (const s of held.splice(0)) s.destroy();
    if (!leased) return;
    await logoutSession({ moduleUrl: BASE, token: TOKEN });
    await releaseSessionSecret({ moduleUrl: BASE, token: TOKEN });
  })();
  return cleaned;
}

/** Step 5's lease, from its own pass and from the fail path. */
async function cleanupBind(): Promise<void> {
  if (!bindLeased) return;
  bindLeased = false;
  await logoutSession({ moduleUrl: BASE, token: BIND_TOKEN });
  await releaseSessionSecret({ moduleUrl: BASE, token: BIND_TOKEN });
}

const { fail: failNow, failed } = failOnce({
  prefix: () => "[module-limits] FAIL",
  cleanup: async () => {
    await cleanup();
    await cleanupBind();
  },
  cleanupMs: 15_000,
});
function fail(msg: string): never {
  return failNow(msg);
}

// ---------------------------------------------------------------- raw HTTP

/** One reply read off a raw socket; on a `101` the socket stays open, as the subscriber. */
interface RawReply {
  status: number;
  body: string;
  socket: Socket;
}

/**
 * Write `head` (and `body`, once `bodyAfterMs` has passed without a reply) on
 * a fresh connection and read one HTTP reply. Raw rather than `fetch` or
 * `WebSocket`: a refused upgrade reaches a `WebSocket` only as an error with
 * no status, and the module answers an oversized request and closes while a
 * `fetch` may still be writing it, which can surface as a reset instead of
 * the `413`. Undefined when nothing complete arrives within `timeoutMs`.
 */
function rawExchange(head: string, o: { body?: string; bodyAfterMs?: number; timeoutMs: number }): Promise<RawReply | undefined> {
  const url = new URL(BASE);
  return new Promise((resolve) => {
    const socket = connect({ host: url.hostname, port: Number(url.port || 80) });
    let buf = Buffer.alloc(0);
    let done = false;
    const finish = (r: RawReply | undefined) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearTimeout(bodyTimer);
      if (r === undefined || r.status !== 101) socket.destroy();
      resolve(r);
    };
    const timer = setTimeout(() => finish(undefined), o.timeoutMs);
    const bodyTimer = o.body === undefined ? undefined : setTimeout(() => socket.write(o.body!), o.bodyAfterMs ?? 0);
    const parse = (closed: boolean) => {
      const end = buf.indexOf("\r\n\r\n");
      if (end < 0) return closed ? finish(undefined) : undefined;
      const lines = buf.subarray(0, end).toString("latin1").split("\r\n");
      const status = Number(lines[0]!.split(" ")[1]);
      if (status === 101) return finish({ status, body: "", socket });
      const length = Number(lines.find((l) => /^content-length:/i.test(l))?.split(":")[1]?.trim() ?? NaN);
      const body = buf.subarray(end + 4);
      if (body.length >= length || closed) finish({ status, body: body.toString("utf8"), socket });
    };
    // Kept for the socket's life: an admitted subscriber's event frames are read and dropped.
    socket.on("data", (chunk: Buffer) => {
      if (done) return;
      buf = Buffer.concat([buf, chunk]);
      parse(false);
    });
    socket.on("end", () => parse(true));
    socket.on("close", () => parse(true));
    socket.on("error", () => parse(true));
    socket.on("connect", () => socket.write(head));
  });
}

function hostHeader(): string {
  return new URL(BASE).host;
}

/** A `/events` upgrade on TOKEN with `secret` as the bearer. */
function upgrade(secret: string | undefined): Promise<RawReply | undefined> {
  const key = Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("base64");
  const head =
    `GET /events?token=${encodeURIComponent(TOKEN)} HTTP/1.1\r\nHost: ${hostHeader()}\r\n` +
    `Upgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n` +
    (secret === undefined ? "" : `Authorization: Bearer ${secret}\r\n`) +
    "\r\n";
  return rawExchange(head, { timeoutMs: REPLY_MS });
}

const errorOf = (r: RawReply | { json: any }): string | undefined => {
  if ("json" in r) return r.json?.error;
  try {
    return JSON.parse(r.body)?.error;
  } catch {
    return undefined;
  }
};
const shown = (r: RawReply | undefined): string => (r === undefined ? `no reply in ${REPLY_MS / 1000}s` : `${r.status} ${r.body}`);

/** A JSON request with `bearer` (the lease secret, or the port secret when absent). */
async function req(method: string, path: string, body: unknown, bearer?: string): Promise<{ status: number; json: any }> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { ...(bearer === undefined ? authHeaders() : { authorization: `Bearer ${bearer}` }), "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  return { status: res.status, json: await res.json().catch(() => undefined) };
}

// ------------------------------------------------------------------- steps

/** 0. The gate. */
async function bodyLimit(secret: string): Promise<void> {
  const prefix = JSON.stringify({ token: TOKEN, action: "clear_target", pad: "" }).slice(0, -2);
  const body = `${prefix}${"x".repeat(BODY_LIMIT + 36 * 1024 - prefix.length - 2)}"}`;
  const head =
    `POST /action HTTP/1.1\r\nHost: ${hostHeader()}\r\nAuthorization: Bearer ${secret}\r\n` +
    `Content-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n`;
  // The head alone first: the module refuses on the declared length, before
  // the body. A module without the limit waits for it, gets it, and answers.
  const r = await rawExchange(head, { body, bodyAfterMs: 500, timeoutMs: REPLY_MS + 500 });
  if (r?.status !== 413 || errorOf(r) !== "body_too_large") {
    fail(`POST /action with a ${Buffer.byteLength(body)}-byte body: expected 413 body_too_large, got ${shown(r)}: ${PREDATES}`);
  }
  log(`PASS body over 64 KiB: 413 body_too_large`);
}

/** 1. Into the world on the lease secret. */
async function login(secret: string): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    const r = await req("POST", "/session", { token: TOKEN, character: CHARACTER, race: 1, class: 1 }, secret);
    if (r.status === 200 && r.json?.inWorld) return log(`in world as ${CHARACTER} on ${ACCOUNT}, lease secret`);
    if (r.status === 504 && r.json?.error === "timeout" && attempt < 4) {
      log(`${RETRY_MARK} create answered 504 timeout (attempt ${attempt}): an earlier session on ${ACCOUNT} is still releasing; retrying`);
      await Bun.sleep(3_000);
      continue;
    }
    fail(`session create with the lease secret: ${r.status} ${JSON.stringify(r.json)}`);
  }
}

/** 2. The subscriber cap. */
async function subscribers(secret: string): Promise<void> {
  let refused: RawReply | undefined;
  for (let i = 1; i <= SUBSCRIBER_TRIES && refused === undefined; i++) {
    const r = await upgrade(secret);
    if (r === undefined) fail(`lease-secret /events upgrade ${i}: ${shown(r)}`);
    if (r.status === 101) held.push(r.socket);
    else refused = r;
  }
  if (refused === undefined) {
    fail(`${held.length} lease-secret /events subscribers admitted on one token, none refused: ${PREDATES}, or WrathBench.EventsSubscribersPerToken is 0 on this world`);
  }
  if (refused.status !== 429 || errorOf(refused) !== "subscriber_limit") {
    fail(`lease-secret /events upgrade ${held.length + 1}: expected 429 subscriber_limit, got ${shown(refused)}`);
  }
  if (held.length !== SUBSCRIBERS) {
    fail(`subscriber ${held.length + 1} refused, expected ${SUBSCRIBERS + 1} (SMOKE_EVENTS_SUBSCRIBERS=${SUBSCRIBERS}): set it to the world's WrathBench.EventsSubscribersPerToken`);
  }
  log(`PASS subscriber cap: ${held.length} admitted, number ${held.length + 1} refused 429 subscriber_limit`);

  // The slot is held until the server has seen the socket gone, so a new
  // upgrade is admitted a moment after the close, not at once.
  held.pop()!.end();
  const by = Date.now() + REPLY_MS;
  let again: RawReply | undefined;
  for (let tries = 1; ; tries++) {
    again = await upgrade(secret);
    if (again?.status === 101) {
      held.push(again.socket);
      log(`PASS one subscriber closed, a new one admitted (attempt ${tries})`);
      break;
    }
    if (again === undefined || errorOf(again) !== "subscriber_limit" || Date.now() > by) {
      fail(`after closing a subscriber, a new one: expected 101 within ${REPLY_MS / 1000}s, last ${shown(again)}`);
    }
    await Bun.sleep(250);
  }

  const port = await upgrade(MODULE_SECRET);
  if (port?.status !== 101) fail(`port-secret /events upgrade at the cap: expected 101, got ${shown(port)}`);
  held.push(port.socket);
  const still = await upgrade(secret);
  if (still?.status === 101) held.push(still.socket);
  if (still?.status !== 429 || errorOf(still) !== "subscriber_limit") {
    fail(`lease-secret upgrade beside the port-secret subscriber: expected 429 subscriber_limit, got ${shown(still)}`);
  }
  log("PASS port-secret subscriber admitted at the cap, not counted (a lease-secret one still refused)");
  for (const s of held.splice(0)) s.end();
}

/** 3. The request rate. */
async function rate(secret: string): Promise<void> {
  // A full bucket to start from: the steps above drew a few.
  await Bun.sleep(2_500);
  const replies: { status: number; json: any }[] = [];
  for (let i = 0; i < BURST; i++) replies.push(await req("POST", "/action", { token: TOKEN, action: "wb_limits_probe" }, secret));
  const served = (r: { status: number; json: any }) => r.status === 400 && errorOf(r) === "unsupported_action";
  const limited = (r: { status: number; json: any }) => r.status === 429 && errorOf(r) === "rate_limited";
  const odd = replies.findIndex((r) => !served(r) && !limited(r));
  if (odd >= 0) fail(`burst request ${odd + 1}: expected 400 unsupported_action or 429 rate_limited, got ${replies[odd]!.status} ${JSON.stringify(replies[odd]!.json)}`);
  const first = replies.findIndex(limited);
  if (first < 0) {
    log(`PASS request rate: off on this world (${BURST}/${BURST} served, none refused; WrathBench.ActionRate 0)`);
    return;
  }
  if (first === 0) fail("request rate: the burst's first request was refused 429 rate_limited; a lease's bucket should start with some to spend");
  const refusedCount = replies.filter(limited).length;
  log(`request rate: ${first} served before the first 429 rate_limited, ${refusedCount} of ${BURST} refused`);
  await Bun.sleep(1_100);
  const after = await req("POST", "/action", { token: TOKEN, action: "clear_target" }, secret);
  if (after.status !== 200 || after.json?.ok !== true) fail(`request rate: clear_target 1.1s after the burst: expected 200, got ${after.status} ${JSON.stringify(after.json)}`);
  log(`PASS request rate: on; ${first} served, then 429 rate_limited, then served again 1.1s later`);
}

/** 4. The `/health` view by credential. */
async function healthViews(secret: string): Promise<void> {
  const port = await req("GET", "/health", undefined);
  if (port.status !== 200 || typeof port.json?.limits !== "object" || port.json.limits === null || port.json?.leases === undefined) {
    fail(`port-secret GET /health: expected 200 with limits and leases, got ${port.status} ${JSON.stringify(port.json)}`);
  }
  const lease = await req("GET", "/health", undefined, secret);
  if (lease.status !== 200 || lease.json?.ok !== true) fail(`lease-secret GET /health: expected 200 ok, got ${lease.status} ${JSON.stringify(lease.json)}`);
  if ("limits" in lease.json || "leases" in lease.json) {
    fail(`lease-secret GET /health carries ${["limits", "leases"].filter((k) => k in lease.json).join(" and ")}: the full view is the port secret's (wrath-mcp#70)`);
  }
  log(`PASS /health by credential: the port secret's view has limits and leases, a lease secret's neither`);
}

/** 5. Two first creates at once, naming different characters, on a fresh lease. */
async function bindRace(): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    const lease = await leaseSessionSecret({ moduleUrl: BASE, token: BIND_TOKEN, account: ACCOUNT });
    if (lease.secret === undefined) fail(`no lease secret for the bind step: ${lease.note}`);
    bindLeased = true;
    const create = (character: string) => req("POST", "/session", { token: BIND_TOKEN, character, race: 1, class: 1 }, lease.secret);
    const [a, b] = await Promise.all([create(CHARACTER), create(RIVAL)]);
    const replies = [
      { character: CHARACTER, ...a },
      { character: RIVAL, ...b },
    ];
    const shownAll = replies.map((r) => `${r.character}: ${r.status} ${JSON.stringify(r.json)}`).join("; ");
    // An earlier session on the account still releasing answers a create 504, which binds nothing: start over.
    if (replies.some((r) => r.status === 504 && r.json?.error === "timeout") && !replies.some((r) => r.status === 200) && attempt < 4) {
      log(`${RETRY_MARK} bind step: a create answered 504 timeout (attempt ${attempt}): ${shownAll}; retrying`);
      await cleanupBind();
      await Bun.sleep(3_000);
      continue;
    }
    const won = replies.filter((r) => r.status === 200);
    const lost = replies.filter((r) => r.status === 409 && r.json?.error === "character_bound");
    if (won.length !== 1 || lost.length !== 1) fail(`two first creates at once: expected one 200 and one 409 character_bound, got ${shownAll}`);
    if (lost[0]!.json?.bound !== won[0]!.character) fail(`the refused create's bound is ${JSON.stringify(lost[0]!.json?.bound)}, expected the winner ${won[0]!.character}: ${shownAll}`);
    log(`PASS two first creates at once: ${won[0]!.character} 200, ${lost[0]!.character} 409 character_bound naming ${won[0]!.character}`);
    await cleanupBind();
    return;
  }
}

async function main(): Promise<void> {
  if (MODULE_SECRET === undefined) fail("WRATHBENCH_MODULE_SECRET is not set: the smoke leases with the port secret");
  if (!Number.isInteger(SUBSCRIBERS) || SUBSCRIBERS < 1) fail(`SMOKE_EVENTS_SUBSCRIBERS must be a positive integer, got ${process.env.SMOKE_EVENTS_SUBSCRIBERS}`);
  const health = await req("GET", "/health", undefined);
  if (health.status !== 200 || !health.json?.ok) fail(`health not ok: ${health.status} ${JSON.stringify(health.json)}`);
  log(`module build ${health.json.build ?? "?"}, protocol ${health.json.protocol ?? "?"}`);

  const lease = await leaseSessionSecret({ moduleUrl: BASE, token: TOKEN, account: ACCOUNT });
  if (lease.secret === undefined) fail(`no lease secret: ${lease.note}`);
  leased = true;
  const secret = lease.secret;
  log(`leased a session secret on ${lease.account}`);

  await bodyLimit(secret);
  await login(secret);
  await subscribers(secret);
  await rate(secret);
  await healthViews(secret);

  await cleanup();
  log("logged out and released the lease");
  await bindRace();
  log("logged out and released the bind step's lease");
  log("PASS: 413 body_too_large -> subscriber cap -> port secret uncounted -> request rate -> /health by credential -> one-step binding");
  process.exit(0);
}

main().catch(failed);
