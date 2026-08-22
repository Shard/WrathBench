/**
 * Probe for the navigation status vocabulary (FOLLOW-UPS item 38 N1).
 *
 * End to end against a booted worldserver, from inside the compose network:
 * session in world (Human in Northshire) -> a `move_to` whose z is 30y above
 * the ground arrives and reports `meshZ` (the mesh owns z; no z-ladder) -> a
 * `move_to` whose z is 100y above the ground (outside the mesh's ±50y poly
 * search) is `target_off_mesh`, nothing moved -> a 300y request is `too_far`
 * -> a plain walk still arrives with no `meshZ` -> logout. No dependencies;
 * Bun built-ins only.
 *
 * Not staged here, deliberately: `no_mesh` needs an unmapped map, and
 * `path_incomplete` / `start_off_mesh` need specific terrain (a transport
 * deck, a mesh gap) that Northshire does not offer on demand. Those two are
 * exercised by the travel gate (infra/smoke/travel.ts) where the tram
 * provides the deck. `WB_AREATRIGGER` is also the gate's: no DBC trigger lies
 * within 400y of either starter zone.
 *
 * Preflight-gate ready (ADR-0023 amendment, 2026-08-23): reads MODULE_ACCOUNT
 * the way the supervisor's spawnSmoke injects it, deletes last run's character
 * through the real CMSG_CHAR_DELETE path before creating this run's (the same
 * pattern as quest-accept-status.ts / kill-credit.ts), and only logs out at
 * the end — a disconnected character lingers 60s in the core's
 * WorldSession::expireTime, during which a delete is silently ignored.
 *
 * Run standalone (defaults to the PROBE account):
 *   docker compose -f infra/compose.yml exec runner bun infra/smoke/module-navigation.ts
 *
 * Override the target with MODULE_HOST / MODULE_PORT (default worldserver:8086)
 * and the login account with MODULE_ACCOUNT (default PROBE).
 */

const HOST = process.env.MODULE_HOST ?? "worldserver";
const PORT = process.env.MODULE_PORT ?? "8086";
const BASE = `http://${HOST}:${PORT}`;
const WS = `ws://${HOST}:${PORT}`;

// Session tokens must be at least 32 characters (POST /session rejects
// shorter ones with weak_token); randomUUID keeps them unguessable too.
const TOKEN = `probe-nav-${crypto.randomUUID()}`;
// Fixed name, deleted at the START of every run and only logged out at the
// end (see deletePreviousCharacter below). One name per script, so the
// leftover is always exactly one.
const CHARACTER = "Smokenav";
const ACCOUNT = process.env.MODULE_ACCOUNT ?? "PROBE";

function log(msg: string) {
  console.log(`[nav] ${msg}`);
}
function fail(msg: string): never {
  console.error(`[nav] FAIL: ${msg}`);
  const bail = () => process.exit(1);
  setTimeout(bail, 3000);
  fetch(`${BASE}/session`, { method: "DELETE", body: JSON.stringify({ token: TOKEN }) }).then(bail, bail);
  throw new Error("unreachable");
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

const events: any[] = [];

function openEvents(): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${WS}/events?token=${encodeURIComponent(TOKEN)}`);
    ws.addEventListener("open", () => resolve(ws));
    ws.addEventListener("error", (e) => reject(new Error(`ws error: ${String(e)}`)));
    ws.addEventListener("message", (ev) => {
      try {
        events.push(JSON.parse(String(ev.data)));
      } catch {
        log(`event <- (unparseable) ${String(ev.data)}`);
      }
    });
  });
}

async function waitFor(pred: (e: any) => boolean, timeoutMs: number, what: string): Promise<any> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const hit = events.find(pred);
    if (hit) return hit;
    if (Date.now() > deadline) fail(`timed out waiting for ${what}`);
    await Bun.sleep(100);
  }
}

const dist2d = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);

async function deletePreviousCharacter(): Promise<void> {
  for (let attempt = 0; attempt < 4; ++attempt) {
    const r = await req("POST", "/character-delete", { token: `${TOKEN}-del${attempt}`, account: ACCOUNT, character: CHARACTER });
    if (r.json?.deleted === true) {
      log(`deleted last run's ${CHARACTER}: ${JSON.stringify(r.json)}`);
      return;
    }
    if (r.status === 502 && r.json?.error === "character_not_found") {
      log(`no previous ${CHARACTER} to delete (first run on this realm)`);
      return;
    }
    log(`character-delete attempt ${attempt}: ${r.status} ${JSON.stringify(r.json)}`);
    if (r.status !== 504) break;
    await Bun.sleep(2000);
  }
  fail(`could not delete last run's ${CHARACTER}`);
}

/** Issue move_to and return the terminal WB_MOVE_RESULT data for it. */
async function move(target: { x: number; y: number; z: number }, timeoutMs = 60000): Promise<any> {
  const ack = await req("POST", "/action", { token: TOKEN, action: "move_to", ...target });
  if (ack.status !== 200 || !ack.json?.ok) fail(`move_to refused: ${ack.status} ${JSON.stringify(ack.json)}`);
  const result = await waitFor(
    (e) => e.opcode === "WB_MOVE_RESULT" && e.data?.moveId === ack.json.moveId,
    timeoutMs,
    `WB_MOVE_RESULT for moveId ${ack.json.moveId}`,
  );
  log(
    `move_to (${target.x.toFixed(1)}, ${target.y.toFixed(1)}, ${target.z.toFixed(1)}) -> ${result.data.status}` +
      (result.data.meshZ !== undefined ? ` meshZ=${result.data.meshZ.toFixed(1)}` : "") +
      (result.data.reachedPos ? ` reachedPos=${JSON.stringify(result.data.reachedPos)}` : ""),
  );
  return result.data;
}

async function main() {
  const health = await req("GET", "/health");
  if (health.status !== 200 || !health.json?.ok) fail(`health not ok: ${JSON.stringify(health)}`);
  log(`health ok: build=${health.json.build ?? "?"}, character=${CHARACTER}`);

  // 0. Delete last run's character through the real CMSG_CHAR_DELETE path
  //    (see deletePreviousCharacter for why this runs first, not last).
  await deletePreviousCharacter();

  const ws = await openEvents();
  await Bun.sleep(200);

  // 1. Session in world.
  const session = await req("POST", "/session", { token: TOKEN, account: ACCOUNT, character: CHARACTER, race: 1, class: 1 });
  if (session.status !== 200 || !session.json?.ok || !session.json?.inWorld) {
    fail(`session create failed: ${session.status} ${JSON.stringify(session.json)}`);
  }
  const verify = await waitFor((e) => e.opcode === "SMSG_LOGIN_VERIFY_WORLD", 5000, "SMSG_LOGIN_VERIFY_WORLD");
  let here = { x: verify.data.x, y: verify.data.y, z: verify.data.z };
  log(`in world at (${here.x.toFixed(1)}, ${here.y.toFixed(1)}, ${here.z.toFixed(1)}) map ${verify.data.map}`);

  // Two walkable landmarks ~37m apart (human start, abbey courtyard). A reused
  // character may be anywhere; walk home first so the legs below are fixed.
  const HOME = { x: -8949.95, y: -132.49, z: 83.53 };
  const COURTYARD = { x: -8913.2, y: -137.6, z: 80.9 };
  if (dist2d(here, HOME) > 10) {
    const home = await move(HOME, 120000);
    if (home.status !== "arrived") fail(`walk-home result ${JSON.stringify(home)}`);
    here = home.pos;
  }

  // 2. Wrong z, right x/y: the mesh owns z. Arrives, and says which z it used.
  const high = await move({ x: COURTYARD.x, y: COURTYARD.y, z: COURTYARD.z + 30 });
  if (high.status !== "arrived") fail(`z+30 request should arrive (mesh resolves z), got ${JSON.stringify(high)}`);
  if (dist2d(high.pos, COURTYARD) > 4) fail(`z+30 arrived ${dist2d(high.pos, COURTYARD).toFixed(1)}m from target`);
  if (typeof high.meshZ !== "number") fail(`z+30 arrival carries no meshZ: ${JSON.stringify(high)}`);
  if (Math.abs(high.meshZ - COURTYARD.z) > 3) fail(`meshZ ${high.meshZ} is not the courtyard ground (${COURTYARD.z})`);
  log(`PASS z+30 -> arrived with meshZ ${high.meshZ.toFixed(1)} (requested ${(COURTYARD.z + 30).toFixed(1)})`);

  // 3. Far outside the poly search box (±50y vertically): no polygon under the
  //    target. Typed target_off_mesh, and the character did not move.
  const before = { ...high.pos };
  const sky = await move({ x: HOME.x, y: HOME.y, z: HOME.z + 100 });
  if (sky.status !== "target_off_mesh") fail(`z+100 request should be target_off_mesh, got ${JSON.stringify(sky)}`);
  if (dist2d(sky.pos, before) > 1) fail(`target_off_mesh moved the character: ${JSON.stringify(sky.pos)}`);
  log("PASS z+100 -> target_off_mesh, nothing moved");

  // 4. Beyond the single-move cap.
  const far = await move({ x: HOME.x + 300, y: HOME.y, z: HOME.z });
  if (far.status !== "too_far") fail(`300y request should be too_far, got ${JSON.stringify(far)}`);
  log("PASS 300y -> too_far");

  // 5. An ordinary walk back carries no meshZ (request z within 1y of the mesh).
  const back = await move(HOME);
  if (back.status !== "arrived") fail(`walk back should arrive, got ${JSON.stringify(back)}`);
  if (back.meshZ !== undefined) fail(`plain arrival should not carry meshZ: ${JSON.stringify(back)}`);
  log("PASS plain walk -> arrived, no meshZ");

  // 6. Every status on the record is in the documented vocabulary.
  const VOCAB = new Set([
    "arrived", "too_far", "no_mesh", "target_off_mesh", "start_off_mesh", "path_incomplete",
    "transferred", "interrupted", "stopped", "superseded",
  ]);
  const seen = new Set(events.filter((e) => e.opcode === "WB_MOVE_RESULT").map((e) => e.data?.status));
  for (const s of seen) if (!VOCAB.has(s)) fail(`undocumented move status on the stream: ${s}`);
  if (seen.has("no_path")) fail("undifferentiated no_path is still emitted");
  log(`statuses seen: ${[...seen].join(", ")}`);

  // 7. Logout.
  const del = await req("DELETE", "/session", { token: TOKEN });
  if (del.status !== 200 || !del.json?.ok) fail(`session delete failed: ${del.status} ${JSON.stringify(del.json)}`);
  ws.close();

  log("PASS: meshZ arrival -> target_off_mesh -> too_far -> plain arrival; vocabulary clean");
  process.exit(0);
}

main().catch((e) => fail(String(e?.stack ?? e)));
