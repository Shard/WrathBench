/**
 * Probe for the achievement and taxi taps (issue #8 first half):
 * `SMSG_ALL_ACHIEVEMENT_DATA` at login, `SMSG_ACTIVATETAXIREPLY` after a raw
 * `CMSG_ACTIVATETAXI`, and the `taxiFlight` reading on self in
 * `SMSG_UPDATE_OBJECT`.
 *
 * Standalone, raw HTTP/WS only (no SDK). It FAILS against any worldserver
 * built before those taps (the login event never arrives). Run it only after
 * the image is deployed.
 *
 * Fixture (FOLLOW-UPS 45 pattern): a persistent character (default
 * `Smoketaxi` on MODULE_ACCOUNT, never deleted) is placed by
 * `infra/fixtures/apply.ts --scenario taxi-ironforge` — level 10, 1g, logged
 * out, standing in front of Gryth Thurden in Ironforge with TaxiNodes 6
 * (Ironforge) and 8 (Thelsamar) marked visited, because the server refuses a
 * flight to a node the character has not visited (ERR_TAXINOTVISITED).
 *
 * Arc:
 *   1. login -> SMSG_ALL_ACHIEVEMENT_DATA arrives with `achievements[]`
 *      holding the row the fixture planted (Achievement.dbc 6, "Level 10",
 *      10 points — the module's DBC naming, asserted non-vacuously) with id,
 *      packed `date`, readable `time`, `name`, `points`;
 *   2. self's SMSG_UPDATE_OBJECT carries `taxiFlight: false`. Self is matched
 *      by guid: only create/movement blocks carry `self: true`, a values-only
 *      block names the guid (the first gate run failed on exactly this);
 *   3. raw CMSG_ACTIVATETAXI (Gryth's guid, 6 -> 7) -> SMSG_ACTIVATETAXIREPLY
 *      with reply 0, then self flips to `taxiFlight: true` within 5s;
 *   4. DELETE /session mid-flight. apply.ts resets `taxi_path` and the
 *      position on the next run, so the flight never has to finish.
 *
 * Run from inside the network. The `runner` service carries the DB env the
 * fixture tool needs and MODULE_ACCOUNT defaults to PROBE, so no `-e` flags:
 *
 *   docker compose -f infra/compose.yml exec runner bun infra/smoke/achievements-taxi.ts
 *
 * (Add `-e MODULE_ACCOUNT=SMOKE2` and the like only to log in as another
 * allowlisted account.)
 */

import { applyScenario, ensureFixtureCharacter, type FixtureContext } from "./lib/fixture";
import { authHeaders } from "./lib/auth";

const HOST = process.env.MODULE_HOST ?? "worldserver";
const PORT = process.env.MODULE_PORT ?? "8086";
const BASE = `http://${HOST}:${PORT}`;
const WS = `ws://${HOST}:${PORT}`;

const TOKEN = `probe-achievements-taxi-${crypto.randomUUID()}`;
const ACCOUNT = process.env.MODULE_ACCOUNT ?? "PROBE";
const CHARACTER = process.env.SMOKE_CHARACTER ?? "Smoketaxi";
const SCENARIO = "taxi-ironforge";

const GRYTH_THURDEN = 1573; // creature entry, Ironforge flight master
const TAXI_IRONFORGE = 6;
const TAXI_THELSAMAR = 8;
const ACHIEVEMENT_LEVEL_10 = 6; // Achievement.dbc: "Level 10", 10 points, planted by the fixture

function log(msg: string) {
  console.log(`[probe] ${msg}`);
}
function fail(msg: string): never {
  console.error(`[probe] FAIL: ${msg}`);
  const bail = () => process.exit(1);
  setTimeout(bail, 3000);
  fetch(`${BASE}/session`, { method: "DELETE", headers: authHeaders(), body: JSON.stringify({ token: TOKEN }) }).then(bail, bail);
  throw new Error("unreachable");
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
  } catch {}
  return { status: res.status, json };
}

async function createSession(): Promise<any> {
  // Dwarf Warrior: the fixture stands in Ironforge, so a same-faction race.
  const r = await req("POST", "/session", { token: TOKEN, account: ACCOUNT, character: CHARACTER, race: 3, class: 1 });
  if (r.status !== 200 || !r.json?.inWorld) fail(`session failed: ${JSON.stringify(r.json)}`);
  return r.json;
}
async function endSession(): Promise<void> {
  const r = await req("DELETE", "/session", { token: TOKEN });
  if (r.status !== 200) fail(`session delete failed: ${JSON.stringify(r.json)}`);
}

const events: any[] = [];
let selfGuid = "";
const creatureGuidByEntry = new Map<number, string>();

function openEvents(): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${WS}/events?token=${encodeURIComponent(TOKEN)}`, { headers: authHeaders() });
    ws.addEventListener("open", () => resolve(ws));
    ws.addEventListener("error", (e) => reject(new Error(`ws error: ${String(e)}`)));
    ws.addEventListener("message", (ev) => {
      try {
        const e = JSON.parse(String(ev.data));
        events.push(e);
        if (e.opcode === "SMSG_UPDATE_OBJECT")
          for (const o of e.data?.objects ?? []) {
            if (o.self) selfGuid = o.guid;
            if (o.fields?.entry !== undefined && o.guid) creatureGuidByEntry.set(o.fields.entry, o.guid);
          }
      } catch {}
    });
  });
}

async function waitFor(pred: (e: any) => boolean, timeoutMs: number, what: string, from = 0): Promise<any> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    for (let i = from; i < events.length; ++i) if (pred(events[i])) return events[i];
    if (Date.now() > deadline) fail(`timed out waiting for ${what}`);
    await Bun.sleep(100);
  }
}

/**
 * Self's `fields.taxiFlight` on an update block, if that block carries the
 * field. Matched by guid: `self: true` rides only the create/movement block,
 * and the flag flip arrives as a values-only block that names the guid.
 */
function selfTaxiFlight(e: any): boolean | undefined {
  if (e.opcode !== "SMSG_UPDATE_OBJECT" || !selfGuid) return undefined;
  for (const o of e.data?.objects ?? [])
    if ((o.self || o.guid === selfGuid) && typeof o.fields?.taxiFlight === "boolean") return o.fields.taxiFlight;
  return undefined;
}

function u32le(n: number): string {
  return (n >>> 0).toString(16).padStart(8, "0").match(/../g)!.reverse().join("");
}
function u64le(guid: string): string {
  return BigInt(guid).toString(16).padStart(16, "0").match(/../g)!.reverse().join("");
}

const fixtureCtx: FixtureContext = {
  base: BASE,
  account: ACCOUNT,
  character: CHARACTER,
  token: TOKEN,
  log,
  fail,
  contendedDeadlineMs: 10_000,
  contendedRetryMs: 5_000,
  createAndLogout: async () => {
    await createSession();
    await endSession();
  },
};

async function main() {
  const health = await req("GET", "/health");
  if (health.status !== 200 || !health.json?.ok) fail(`health not ok: ${JSON.stringify(health)}`);
  log(`health ok (build ${health.json.build}), character=${CHARACTER} on ${ACCOUNT}`);

  await ensureFixtureCharacter(fixtureCtx);
  await applyScenario(fixtureCtx, SCENARIO);

  const ws = await openEvents();
  await Bun.sleep(200);
  const session = await createSession();
  log(`in world as ${CHARACTER} guid=${session.guid}`);
  selfGuid = String(session.guid);

  // 1. Login-time achievement list.
  const all = await waitFor((e) => e.opcode === "SMSG_ALL_ACHIEVEMENT_DATA", 10_000, "SMSG_ALL_ACHIEVEMENT_DATA (is the tap deployed?)");
  if (all.data?.decodeError) fail(`ALL_ACHIEVEMENT_DATA decodeError: ${JSON.stringify(all.data)}`);
  const rows: any[] = all.data?.achievements;
  if (!Array.isArray(rows) || typeof all.data.count !== "number" || all.data.count !== rows.length)
    fail(`ALL_ACHIEVEMENT_DATA shape: ${JSON.stringify(all.data)}`);
  for (const r of rows) {
    if (!Number.isInteger(r.achievementId) || !Number.isInteger(r.date) || typeof r.time !== "string")
      fail(`achievement row shape: ${JSON.stringify(r)}`);
    if (r.name !== undefined && (typeof r.name !== "string" || !Number.isInteger(r.points)))
      fail(`achievement row name/points: ${JSON.stringify(r)}`);
  }
  const named = rows.filter((r) => typeof r.name === "string").length;
  log(`ALL_ACHIEVEMENT_DATA: ${rows.length} earned, ${named} named from Achievement.dbc${rows[0] ? `; first ${JSON.stringify(rows[0])}` : ""}`);
  const planted = rows.find((r) => r.achievementId === ACHIEVEMENT_LEVEL_10);
  if (!planted) fail(`the fixture's achievement ${ACHIEVEMENT_LEVEL_10} is not in the login list: ${JSON.stringify(rows)}`);
  if (planted.name !== "Level 10" || planted.points !== 10 || planted.categoryId !== 92)
    fail(`achievement ${ACHIEVEMENT_LEVEL_10} is not named from Achievement.dbc: ${JSON.stringify(planted)} (did the module log "loaded N achievements"?)`);
  if (!/^2010-01-01 \d\d:\d\d$/.test(planted.time)) fail(`fixture date decoded as ${planted.time}, expected 2010-01-01`);

  // 2. Self on the ground: taxiFlight false.
  const selfBlock = await waitFor((e) => selfTaxiFlight(e) !== undefined, 10_000, "self update with taxiFlight");
  if (selfTaxiFlight(selfBlock) !== false) fail(`self starts with taxiFlight=${selfTaxiFlight(selfBlock)}`);
  log(`self taxiFlight=false at login`);

  // 3. Activate a flight at Gryth Thurden.
  const grythGuid = await (async () => {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const g = creatureGuidByEntry.get(GRYTH_THURDEN);
      if (g) return g;
      await Bun.sleep(100);
    }
    return fail(`Gryth Thurden (entry ${GRYTH_THURDEN}) never came into view — did apply.ts place ${CHARACTER}?`);
  })();
  const mark = events.length;
  const payload = u64le(grythGuid) + u32le(TAXI_IRONFORGE) + u32le(TAXI_THELSAMAR);
  const r = await req("POST", "/action", { token: TOKEN, action: "raw", opcode: "CMSG_ACTIVATETAXI", payload });
  if (r.status !== 200 || !r.json?.ok) fail(`raw CMSG_ACTIVATETAXI: ${r.status} ${JSON.stringify(r.json)}`);
  const reply = await waitFor((e) => e.opcode === "SMSG_ACTIVATETAXIREPLY", 5000, "SMSG_ACTIVATETAXIREPLY", mark);
  log(`ACTIVATETAXIREPLY: ${JSON.stringify(reply.data)}`);
  if (reply.data?.reply !== 0 || reply.data?.ok !== true) fail(`taxi refused: reply ${reply.data?.reply} (6 = not visited: the fixture's taximask did not land)`);
  const flying = await waitFor((e) => selfTaxiFlight(e) === true, 5000, "self taxiFlight=true", mark);
  log(`self taxiFlight=true (${(flying.ts ?? "")})`);

  // 4. Teardown mid-flight; the fixture resets the row next run.
  await endSession();
  ws.close();
  log("PASS: ALL_ACHIEVEMENT_DATA at login, taxiFlight false -> ACTIVATETAXIREPLY 0 -> taxiFlight true");
  process.exit(0);
}

main().catch((e) => fail(String(e?.stack ?? e)));
