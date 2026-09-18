/**
 * Probe for the movement + update-object module pillars.
 *
 * End to end against a booted worldserver, from inside the compose network:
 * session in world (Human in Northshire) -> observe own create block via
 * SMSG_UPDATE_OBJECT -> a nearby creature appears as a create event and its
 * name arrives via the auto creature-query -> move_to a point ~35m away ->
 * WB_MOVE_PROGRESS -> WB_MOVE_RESULT arrived with server-confirmed position at
 * the target -> face -> logout. No dependencies; Bun built-ins only.
 *
 * Run:
 *   docker compose -f infra/compose.yml exec runner bun infra/smoke/module-movement.ts
 *
 * Override the target with MODULE_HOST / MODULE_PORT (default worldserver:8086).
 */

import { authHeaders } from "./lib/auth";

const HOST = process.env.MODULE_HOST ?? "worldserver";
const PORT = process.env.MODULE_PORT ?? "8086";
const BASE = `http://${HOST}:${PORT}`;
const WS = `ws://${HOST}:${PORT}`;

// Session tokens must be at least 32 characters (POST /session rejects
// shorter ones with weak_token); randomUUID keeps them unguessable too.
const TOKEN = `probe-move-${crypto.randomUUID()}`;
// Fixed name: POST /session reuses an existing character, so repeated probe
// runs do not eat into the realm's 10-characters-per-account cap.
const CHARACTER = "Benchmove";

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

const events: any[] = [];
const startedAt = Date.now();

function openEvents(): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${WS}/events?token=${encodeURIComponent(TOKEN)}`, { headers: authHeaders() });
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

const dist2d = (a: { x: number; y: number }, b: { x: number; y: number }) =>
  Math.hypot(a.x - b.x, a.y - b.y);

async function main() {
  const health = await req("GET", "/health");
  if (health.status !== 200 || !health.json?.ok) fail(`health not ok: ${JSON.stringify(health)}`);
  log(`health ok: ${JSON.stringify(health.json)}`);

  const ws = await openEvents();
  log(`ws connected for token ${TOKEN}`);
  await Bun.sleep(200);

  // 1. Session in world.
  const session = await req("POST", "/session", { token: TOKEN, character: CHARACTER, race: 1, class: 1 });
  if (session.status !== 200 || !session.json?.ok || !session.json?.inWorld) {
    fail(`session create failed: ${session.status} ${JSON.stringify(session.json)}`);
  }
  log(`session in world: ${JSON.stringify(session.json)}`);

  const verify = await waitFor((e) => e.opcode === "SMSG_LOGIN_VERIFY_WORLD", 5000, "SMSG_LOGIN_VERIFY_WORLD");
  const spawn = { x: verify.data.x, y: verify.data.y, z: verify.data.z };
  log(`spawn: ${JSON.stringify(verify.data)}`);

  // 2. Own create block on the update-object stream (self, with position and health).
  const selfCreate = await waitFor(
    (e) =>
      e.opcode === "SMSG_UPDATE_OBJECT" &&
      e.data?.objects?.some((o: any) => o.update === "create" && o.self === true),
    10000,
    "self create block in SMSG_UPDATE_OBJECT",
  );
  const selfObj = selfCreate.data.objects.find((o: any) => o.update === "create" && o.self === true);
  if (selfObj.objectType !== "player") fail(`self objectType ${selfObj.objectType} != player`);
  if (!selfObj.pos || dist2d(selfObj.pos, spawn) > 5) {
    fail(`self create pos ${JSON.stringify(selfObj.pos)} does not match spawn ${JSON.stringify(spawn)}`);
  }
  if (!(selfObj.fields?.health > 0) || !(selfObj.fields?.level >= 1)) {
    fail(`self create missing health/level: ${JSON.stringify(selfObj.fields)}`);
  }
  log(
    `self create: level=${selfObj.fields.level} health=${selfObj.fields.health}/${selfObj.fields.maxHealth} ` +
      `pos=(${selfObj.pos.x.toFixed(1)}, ${selfObj.pos.y.toFixed(1)}, ${selfObj.pos.z.toFixed(1)})`,
  );

  // 3. A nearby creature appears as a create event with level + position, and its
  //    name arrives via the client-style creature query the module issued.
  const creatureCreate = await waitFor(
    (e) =>
      e.opcode === "SMSG_UPDATE_OBJECT" &&
      e.data?.objects?.some(
        (o: any) => o.update === "create" && o.objectType === "unit" && o.fields?.entry > 0 && o.pos,
      ),
    10000,
    "nearby creature create block",
  );
  const creature = creatureCreate.data.objects.find(
    (o: any) => o.update === "create" && o.objectType === "unit" && o.fields?.entry > 0 && o.pos,
  );
  const nameEvt = await waitFor(
    (e) => e.opcode === "SMSG_CREATURE_QUERY_RESPONSE" && e.data?.entry === creature.fields.entry && e.data?.found,
    10000,
    `creature name for entry ${creature.fields.entry}`,
  );
  log(
    `nearby creature: entry=${creature.fields.entry} name="${nameEvt.data.name}" level=${creature.fields.level} ` +
      `pos=(${creature.pos.x.toFixed(1)}, ${creature.pos.y.toFixed(1)}, ${creature.pos.z.toFixed(1)})`,
  );

  // 4. move_to a point 30-60m away in Northshire. Two walkable waypoints — the
  //    human start spot and the courtyard in front of the abbey doors, ~37m
  //    apart — and the probe walks to whichever is farther from where the
  //    (reused) character currently stands.
  const WAYPOINTS = [
    { x: -8949.95, y: -132.49, z: 83.53 }, // human start
    { x: -8913.2, y: -137.6, z: 80.9 },    // abbey courtyard
  ];
  // A reused character may have been left anywhere by another probe run; walk
  // it home first so the fixed 30-60m leg below is meaningful.
  if (WAYPOINTS.every((wp) => dist2d(spawn, wp) > 60)) {
    const home = await req("POST", "/action", { token: TOKEN, action: "move_to", ...WAYPOINTS[0] });
    if (home.status !== 200 || !home.json?.ok) fail(`walk-home move_to failed: ${JSON.stringify(home.json)}`);
    const homeRes = await waitFor(
      (e) => e.opcode === "WB_MOVE_RESULT" && e.data?.moveId === home.json.moveId,
      120000,
      "walk-home WB_MOVE_RESULT",
    );
    if (homeRes.data.status !== "arrived") fail(`walk-home result ${JSON.stringify(homeRes.data)}`);
    spawn.x = homeRes.data.pos.x;
    spawn.y = homeRes.data.pos.y;
    spawn.z = homeRes.data.pos.z;
    log(`walked home to (${spawn.x.toFixed(1)}, ${spawn.y.toFixed(1)})`);
  }
  const target = WAYPOINTS.reduce((a, b) => (dist2d(spawn, a) >= dist2d(spawn, b) ? a : b));
  const wantDist = dist2d(spawn, target);
  if (wantDist < 30 || wantDist > 60) fail(`test target ${wantDist.toFixed(1)}m from spawn, want 30-60m`);

  const move = await req("POST", "/action", { token: TOKEN, action: "move_to", ...target });
  if (move.status !== 200 || !move.json?.ok) fail(`move_to failed: ${move.status} ${JSON.stringify(move.json)}`);
  const moveId = move.json.moveId;
  log(`move_to acked: moveId=${moveId} distance=${wantDist.toFixed(1)}m`);

  await waitFor(
    (e) => e.opcode === "WB_MOVE_PROGRESS" && e.data?.moveId === moveId,
    5000,
    "WB_MOVE_PROGRESS",
  );
  log("progress event observed");

  const result = await waitFor(
    (e) => e.opcode === "WB_MOVE_RESULT" && e.data?.moveId === moveId,
    30000,
    "WB_MOVE_RESULT",
  );
  if (result.data.status !== "arrived") fail(`move result ${JSON.stringify(result.data)}, want arrived`);
  const arrivedPos = result.data.pos;
  const offBy = dist2d(arrivedPos, target);
  if (offBy > 4) fail(`arrived pos ${JSON.stringify(arrivedPos)} is ${offBy.toFixed(1)}m from target`);
  log(
    `arrived: server-confirmed pos=(${arrivedPos.x.toFixed(1)}, ${arrivedPos.y.toFixed(1)}, ${arrivedPos.z.toFixed(1)}) ` +
      `(${offBy.toFixed(2)}m from target)`,
  );

  // 5. face north-ish (o = pi/2) and verify the ack echoes the normalized value.
  const face = await req("POST", "/action", { token: TOKEN, action: "face", orientation: Math.PI / 2 });
  if (face.status !== 200 || !face.json?.ok) fail(`face failed: ${face.status} ${JSON.stringify(face.json)}`);
  if (Math.abs(face.json.orientation - Math.PI / 2) > 0.01) fail(`face orientation echo ${face.json.orientation}`);
  log(`face acked: orientation=${face.json.orientation.toFixed(3)}`);

  // 6. stop is a no-op while standing but must ack.
  const stop = await req("POST", "/action", { token: TOKEN, action: "stop" });
  if (stop.status !== 200 || !stop.json?.ok) fail(`stop failed: ${stop.status} ${JSON.stringify(stop.json)}`);

  // 7. Logout.
  const del = await req("DELETE", "/session", { token: TOKEN });
  if (del.status !== 200 || !del.json?.ok) fail(`session delete failed: ${del.status} ${JSON.stringify(del.json)}`);
  log(`session deleted: ${JSON.stringify(del.json)}`);

  ws.close();

  // Firehose accounting.
  const secs = (Date.now() - startedAt) / 1000;
  const updates = events.filter((e) => e.opcode === "SMSG_UPDATE_OBJECT").length;
  const finalHealth = await req("GET", "/health");
  log(
    `stats: ${events.length} events in ${secs.toFixed(1)}s (${(events.length / secs).toFixed(1)}/s), ` +
      `${updates} SMSG_UPDATE_OBJECT; health=${JSON.stringify(finalHealth.json)}`,
  );

  log("PASS: in world -> self+creature update events -> move_to arrived -> face -> logout");
  process.exit(0);
}

main().catch((e) => fail(String(e?.stack ?? e)));
