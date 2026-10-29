/**
 * The preflight gate's smoke: the stack is alive end to end, and nothing more.
 * The supervisor runs it before it spawns anything and again whenever the
 * server identity changes (docs/RUNBOOK.md, "The preflight gate"). Every job
 * waits on it, so it takes well under a second, and the game surface (quests,
 * combat, loot, vendors, the full arc) is left to the release's deploy smokes.
 *
 * Raw HTTP/WS only (no SDK), with the operator credential:
 *   1. GET /health answers ok: the port secret is accepted and the world runs;
 *   2. /events opens for the token before the session exists, as the SDK does;
 *   3. POST /session logs the fixture character in, creating it only when the
 *      account does not have it yet (race/class are ignored for one that
 *      exists), so there is no enumerate, delete or create on the hot path;
 *   4. the stream delivers the login state: SMSG_LOGIN_VERIFY_WORLD and the
 *      self create block carrying the guid the create answered with;
 *   5. one action round-trips: quest_query -> SMSG_QUEST_QUERY_RESPONSE, a
 *      reply only this character receives (a `say` would be heard by any
 *      benchmark character standing nearby);
 *   6. DELETE /session logs out.
 *
 * The character is persistent and never deleted. Deleting is the slow step on
 * this server: the core keeps a logged-out character in world for 60s and
 * ignores a delete in that window, which the module reports as a 504 after a
 * 20s wait. Logging in inside that window is fine: the login reattaches to the
 * character still in world, which is what a gate re-run within a minute of the
 * last one does.
 *
 * The name is `Pf` plus the account's letters, with digits spelled as letters
 * (SMOKE -> Pfsmoke, SMOKE3 -> Pfsmoked). Character names are unique across the
 * realm, so a name tied to the account cannot be taken by a run of this smoke on
 * another account. `--character <Name>` overrides it.
 *
 * Run as the gate's SMOKE account. MODULE_ACCOUNT is the runner's environment,
 * which `bun wb` does not carry (`bun wb smoke preflight` logs in as PROBE):
 *   kubectl -n wrathbench exec deploy/wrathbench-runner -- env MODULE_ACCOUNT=SMOKE bun infra/smoke/preflight.ts
 *   docker compose -f infra/compose.yml exec -e MODULE_ACCOUNT=SMOKE runner bun infra/smoke/preflight.ts   # the quickstart
 */

import { authHeaders } from "./lib/auth";
import { accountFixtureName } from "./lib/fixture";
import { moduleBase, moduleWsBase } from "./lib/module";
import { smokeToken } from "./lib/session";

const BASE = moduleBase();
const WS = moduleWsBase();
const ACCOUNT = process.env.MODULE_ACCOUNT ?? "PROBE";
// Session tokens must be at least 32 characters (POST /session: weak_token).
const TOKEN = smokeToken("preflight");
const RACE_HUMAN = 1;
const CLASS_WARRIOR = 1;
// Any quest the server knows answers; this is Northshire's first.
const QUEST = 783;

// Each wait is generous against what it measures (tens of milliseconds live)
// and small against the gate's budget: a failing gate re-runs every tick, so a
// slow failure is the expensive kind.
const HTTP_TIMEOUT_MS = 5_000;
// The module bounds a create at 20s itself, reclaiming a stale session included.
const SESSION_TIMEOUT_MS = 22_000;
const EVENT_TIMEOUT_MS = 5_000;
// The whole run, so a stuck one fails with its own message and a logout before
// the gate's `timeoutMs` kills it without either.
const OVERALL_TIMEOUT_MS = 30_000;

const started = performance.now();
const elapsed = (): string => `${Math.round(performance.now() - started)}ms`;
function log(msg: string): void {
  console.log(`[preflight +${elapsed()}] ${msg}`);
}

const CHARACTER = (() => {
  const i = process.argv.indexOf("--character");
  return i >= 0 ? (process.argv[i + 1] ?? "") : accountFixtureName("Pf", ACCOUNT);
})();

let session = false;
let ws: WebSocket | undefined;

async function req(method: string, path: string, body?: unknown, timeoutMs = HTTP_TIMEOUT_MS): Promise<{ status: number; json: any }> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { ...authHeaders(), ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });
  let json: any = undefined;
  try {
    json = await res.json();
  } catch {
    // not JSON: the status says enough
  }
  return { status: res.status, json };
}

function must(ok: boolean, msg: string): asserts ok {
  if (!ok) throw new Error(msg);
}

// ---------------------------------------------------------------- event feed
const events: any[] = [];
const waiters = new Set<{ pred: (e: any) => boolean; hit: (e: any) => void }>();

function openEvents(): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const sock = new WebSocket(`${WS}/events?token=${encodeURIComponent(TOKEN)}`, { headers: authHeaders() });
    const timer = setTimeout(() => reject(new Error(`/events did not open in ${HTTP_TIMEOUT_MS}ms`)), HTTP_TIMEOUT_MS);
    sock.addEventListener("open", () => {
      clearTimeout(timer);
      resolve(sock);
    });
    sock.addEventListener("error", (e) => {
      clearTimeout(timer);
      reject(new Error(`/events error: ${String((e as ErrorEvent).message ?? e)}`));
    });
    sock.addEventListener("message", (ev) => {
      let e: any;
      try {
        e = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      events.push(e);
      for (const w of waiters) if (w.pred(e)) w.hit(e);
    });
  });
}

/** The first event from index `from` on that matches, as soon as it arrives. */
function waitFor(pred: (e: any) => boolean, what: string, from = 0): Promise<any> {
  for (let i = from; i < events.length; i++) if (pred(events[i])) return Promise.resolve(events[i]);
  return new Promise((resolve, reject) => {
    const w = {
      pred,
      hit: (e: any) => {
        clearTimeout(timer);
        waiters.delete(w);
        resolve(e);
      },
    };
    const timer = setTimeout(() => {
      waiters.delete(w);
      reject(new Error(`no ${what} within ${EVENT_TIMEOUT_MS}ms`));
    }, EVENT_TIMEOUT_MS);
    waiters.add(w);
  });
}

async function main(): Promise<void> {
  must(/^[A-Za-z]{2,12}$/.test(CHARACTER) && !/(.)\1\1/i.test(CHARACTER), `"${CHARACTER}" is not a valid character name; pass --character <Name>`);

  // 1. Health, which is also the credential check.
  const health = await req("GET", "/health");
  must(health.status === 200 && health.json?.ok === true && health.json?.worldStopped !== true, `/health: ${health.status} ${JSON.stringify(health.json)}`);
  log(`health ok, build ${health.json.build ?? "unknown"}; ${ACCOUNT}/${CHARACTER}`);

  // 2-3. Subscribe first, then log in (creating the character only if absent).
  ws = await openEvents();
  session = true; // a create that fails mid-login can still leave a session to log out
  const created = await req(
    "POST",
    "/session",
    { token: TOKEN, account: ACCOUNT, character: CHARACTER, race: RACE_HUMAN, class: CLASS_WARRIOR },
    SESSION_TIMEOUT_MS,
  );
  must(
    created.status === 200 && created.json?.ok === true && created.json?.inWorld === true,
    `POST /session: ${created.status} ${JSON.stringify(created.json)}` +
      (String(created.json?.error ?? "").startsWith("char_create_failed") ? ` (is the name ${CHARACTER} taken on another account? --character <Name>)` : ""),
  );
  const guid = String(created.json.guid);
  log(`in world as ${CHARACTER}, guid ${guid}`);

  // 4. The login state on the stream.
  const verify = await waitFor((e) => e.opcode === "SMSG_LOGIN_VERIFY_WORLD", "SMSG_LOGIN_VERIFY_WORLD");
  await waitFor(
    (e) => e.opcode === "SMSG_UPDATE_OBJECT" && Array.isArray(e.data?.objects) && e.data.objects.some((o: any) => o.self === true && String(o.guid) === guid),
    "self create block",
  );
  log(`login state on the stream: map ${verify.data?.map}, ${events.length} events`);

  // 5. One action, one reply.
  const mark = events.length;
  const asked = await req("POST", "/action", { token: TOKEN, action: "quest_query", questId: QUEST });
  must(asked.status === 200 && asked.json?.ok === true, `quest_query: ${asked.status} ${JSON.stringify(asked.json)}`);
  const reply = await waitFor((e) => e.opcode === "SMSG_QUEST_QUERY_RESPONSE" && e.data?.questId === QUEST, `SMSG_QUEST_QUERY_RESPONSE ${QUEST}`, mark);
  must(typeof reply.data?.title === "string" && reply.data.title.length > 0, `quest ${QUEST} came back without a title: ${JSON.stringify(reply.data)}`);
  log(`quest_query ${QUEST} -> "${reply.data.title}"`);

  // 6. Log out.
  const out = await req("DELETE", "/session", { token: TOKEN });
  must(out.status === 200 && out.json?.ok === true, `DELETE /session: ${out.status} ${JSON.stringify(out.json)}`);
  session = false;
  ws.close();
  log("PASS: health -> events -> login -> login state -> quest_query round trip -> logout");
  process.exit(0);
}

async function failed(msg: string): Promise<never> {
  console.error(`[preflight +${elapsed()}] FAIL: ${msg}`);
  if (session) await req("DELETE", "/session", { token: TOKEN }, 3_000).catch(() => undefined);
  process.exit(1);
}

setTimeout(() => void failed(`not done within ${OVERALL_TIMEOUT_MS}ms`), OVERALL_TIMEOUT_MS).unref();
main().catch((e: unknown) => failed(e instanceof Error ? e.message : String(e)));
