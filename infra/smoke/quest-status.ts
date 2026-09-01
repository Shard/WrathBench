/**
 * Probe for the questgiver-status and quest-query surface (FOLLOW-UPS 27/28):
 * `questgiver_status_query`, `questgiver_status_multiple_query`, `quest_query`
 * plus the `SMSG_QUESTGIVER_STATUS_MULTIPLE` and `SMSG_QUEST_QUERY_RESPONSE`
 * decodes.
 *
 * Standalone, raw HTTP/WS only (no SDK), and it needs the image that carries
 * those actions: it FAILS against any worldserver built before that change
 * (`quest_query` comes back 400 unsupported_action). Run it only after the
 * image is deployed.
 *
 * Arc: fresh Human Paladin in Northshire (spawns beside Deputy Willem, who
 * offers 783 "A Threat Within") ->
 *   1. the login-time SMSG_QUESTGIVER_STATUS_MULTIPLE arrives (empty — the
 *      core sends it before visibility is populated), then, with Willem in
 *      view, questgiver_status_multiple_query names him "available" (8; 2 if
 *      the core decides low-level);
 *   2. questgiver_status_query for Willem's guid -> SMSG_QUESTGIVER_STATUS
 *      for that guid with the same status;
 *   3. quest_query 783 -> SMSG_QUEST_QUERY_RESPONSE with the title and no
 *      required entries (a talk-to quest); quest_query 7 ("Kobold Camp
 *      Cleanup") -> requiredNpcOrGo[0] = { entry 6, count 8 };
 *   4. accept 783 from Willem, then questgiver_status_multiple_query ->
 *      SMSG_QUESTGIVER_STATUS_MULTIPLE in which Willem is no longer
 *      "available" (he gave his quest; the ender McBride is out of view);
 *   5. log out and delete the character.
 *
 * Run from inside the network:
 *   docker compose -f infra/compose.yml exec runner bun infra/smoke/quest-status.ts
 */

const HOST = process.env.MODULE_HOST ?? "worldserver";
const PORT = process.env.MODULE_PORT ?? "8086";
const BASE = `http://${HOST}:${PORT}`;
const WS = `ws://${HOST}:${PORT}`;

// Session tokens must be at least 32 characters (POST /session rejects
// shorter ones with weak_token); randomUUID keeps them unguessable too.
const TOKEN = `probe-qstatus-${crypto.randomUUID()}`;
import { probeName } from "./lib/name";
import { authHeaders } from "./lib/auth";

const CHARACTER = probeName("Bs");
const ACCOUNT = process.env.MODULE_ACCOUNT ?? "PROBE";

const QUEST_INTRO = 783; // A Threat Within (Deputy Willem -> Marshal McBride)
const QUEST_KILL = 7; // Kobold Camp Cleanup (kill 8 Kobold Vermin, entry 6)
const ENTRY_WILLEM = 823;
const ENTRY_VERMIN = 6;
const STATUS_AVAILABLE = new Set([8, 2, 7, 4]); // available / low-level / rep variants

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

async function action(name: string, fields: Record<string, unknown> = {}): Promise<any> {
  const r = await req("POST", "/action", { token: TOKEN, action: name, ...fields });
  if (r.status !== 200 || !r.json?.ok) fail(`action ${name} failed: ${r.status} ${JSON.stringify(r.json)}`);
  return r.json;
}

const events: any[] = [];
const units = new Map<string, { entry?: number; dead?: boolean }>();
let selfGuid = "";
const questLog = new Map<number, number>(); // slot -> questId

function trackEvent(e: any) {
  if (e.opcode !== "SMSG_UPDATE_OBJECT" || !Array.isArray(e.data?.objects)) return;
  for (const o of e.data.objects) {
    if (o.update === "create") {
      const u = units.get(o.guid) ?? {};
      if (o.fields?.entry !== undefined) u.entry = o.fields.entry;
      if (o.fields?.health !== undefined) u.dead = o.fields.health === 0;
      units.set(o.guid, u);
      if (o.self) selfGuid = o.guid;
    } else if (o.update === "outOfRange") {
      for (const g of o.guids ?? []) units.delete(g);
    }
    if ((o.update === "create" || o.update === "values") && o.guid === selfGuid && o.fields) {
      for (const [k, v] of Object.entries(o.fields)) {
        const m = /^quest(\d+)Id$/.exec(k);
        if (m) questLog.set(+m[1]!, v as number);
      }
    }
  }
}

function openEvents(): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${WS}/events?token=${encodeURIComponent(TOKEN)}`, { headers: authHeaders() });
    ws.addEventListener("open", () => resolve(ws));
    ws.addEventListener("error", (e) => reject(new Error(`ws error: ${String(e)}`)));
    ws.addEventListener("message", (ev) => {
      try {
        const e = JSON.parse(String(ev.data));
        events.push(e);
        trackEvent(e);
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

async function waitForUnit(entry: number, timeoutMs: number, what: string): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    for (const [guid, u] of units) if (u.entry === entry && !u.dead) return guid;
    if (Date.now() > deadline) fail(`never saw ${what} (entry ${entry}) in update range`);
    await Bun.sleep(200);
  }
}

async function main() {
  const health = await req("GET", "/health");
  if (health.status !== 200 || !health.json?.ok) fail(`health not ok: ${JSON.stringify(health)}`);
  log(`health ok, character=${CHARACTER}`);

  const ws = await openEvents();
  await Bun.sleep(200);

  const session = await req("POST", "/session", { token: TOKEN, account: ACCOUNT, character: CHARACTER, race: 1, class: 2 });
  if (session.status !== 200 || !session.json?.inWorld) fail(`session failed: ${JSON.stringify(session.json)}`);
  log(`in world as ${CHARACTER} guid=${session.json.guid}`);
  await waitFor((e) => e.opcode === "SMSG_UPDATE_OBJECT" && e.data?.objects?.some((o: any) => o.self), 10000, "self create");
  const willem = await waitForUnit(ENTRY_WILLEM, 10000, "Deputy Willem");

  // 1. The core's unprompted login-time STATUS_MULTIPLE is EMPTY (verified live
  //    2026-08-22: it is sent before the visibility container is populated,
  //    even though the create blocks precede it on the stream) — which is why a
  //    client, and the SDK, query per guid on spawn. So: wait until Willem is in
  //    view, then ask, and assert on the answer.
  const loginMultiple = await waitFor((e) => e.opcode === "SMSG_QUESTGIVER_STATUS_MULTIPLE", 10000, "login STATUS_MULTIPLE");
  log(`login STATUS_MULTIPLE: ${loginMultiple.data.statuses?.length ?? "?"} entries (the core sends it before visibility is populated; 0 is normal)`);
  let mark = events.length;
  await action("questgiver_status_multiple_query");
  const multiple = await waitFor((e) => e.opcode === "SMSG_QUESTGIVER_STATUS_MULTIPLE", 5000, "STATUS_MULTIPLE after Willem is in view", mark);
  const willemRow = (multiple.data.statuses ?? []).find((r: any) => r.guid === willem);
  if (!willemRow) fail(`STATUS_MULTIPLE did not name Willem (${willem}): ${JSON.stringify(multiple.data)}`);
  if (!STATUS_AVAILABLE.has(willemRow.status)) fail(`Willem's status is ${willemRow.status}, expected an available status`);
  log(`STATUS_MULTIPLE: ${multiple.data.statuses.length} questgivers, Willem status=${willemRow.status}`);

  // 2. Per-guid query, as a client sends for a questgiver coming into view.
  mark = events.length;
  await action("questgiver_status_query", { guid: willem });
  const single = await waitFor((e) => e.opcode === "SMSG_QUESTGIVER_STATUS" && e.data?.guid === willem, 5000, "SMSG_QUESTGIVER_STATUS for Willem", mark);
  if (single.data.status !== willemRow.status) fail(`single status ${single.data.status} != multiple status ${willemRow.status}`);
  log(`questgiver_status_query -> status=${single.data.status}`);

  // 3. Quest templates.
  mark = events.length;
  await action("quest_query", { questId: QUEST_INTRO });
  const intro = await waitFor((e) => e.opcode === "SMSG_QUEST_QUERY_RESPONSE" && e.data?.questId === QUEST_INTRO, 5000, `QUEST_QUERY_RESPONSE ${QUEST_INTRO}`, mark);
  if (typeof intro.data.title !== "string" || intro.data.title.length === 0) fail(`quest ${QUEST_INTRO} has no title: ${JSON.stringify(intro.data)}`);
  if (!Array.isArray(intro.data.requiredNpcOrGo) || intro.data.requiredNpcOrGo.length !== 4) fail(`requiredNpcOrGo malformed: ${JSON.stringify(intro.data)}`);
  if (!Array.isArray(intro.data.requiredItems) || intro.data.requiredItems.length !== 6) fail(`requiredItems malformed: ${JSON.stringify(intro.data)}`);
  if (intro.data.requiredNpcOrGo.some((r: any) => r.entry !== 0 || r.count !== 0)) fail(`quest ${QUEST_INTRO} should have no kill objectives: ${JSON.stringify(intro.data.requiredNpcOrGo)}`);
  log(`quest ${QUEST_INTRO}: "${intro.data.title}" level=${intro.data.level} objectives="${intro.data.objectives}"`);

  mark = events.length;
  await action("quest_query", { questId: QUEST_KILL });
  const kill = await waitFor((e) => e.opcode === "SMSG_QUEST_QUERY_RESPONSE" && e.data?.questId === QUEST_KILL, 5000, `QUEST_QUERY_RESPONSE ${QUEST_KILL}`, mark);
  const first = kill.data.requiredNpcOrGo?.[0];
  if (!first || first.entry !== ENTRY_VERMIN || first.count !== 8) fail(`quest ${QUEST_KILL} objective 0 should be { entry ${ENTRY_VERMIN}, count 8 }: ${JSON.stringify(kill.data.requiredNpcOrGo)}`);
  log(`quest ${QUEST_KILL}: "${kill.data.title}" objective 0 = ${JSON.stringify(first)}`);

  // A bad request is rejected, not coerced.
  const bad = await req("POST", "/action", { token: TOKEN, action: "quest_query" });
  if (bad.status !== 400 || bad.json?.error !== "missing_quest_id") fail(`quest_query without questId: ${bad.status} ${JSON.stringify(bad.json)}`);

  // 4. Accept 783, then refresh every marker the way a client does on a quest-log change.
  mark = events.length;
  await action("quest_list", { guid: willem });
  await waitFor(
    (e) => (e.opcode === "SMSG_QUESTGIVER_QUEST_LIST" || e.opcode === "SMSG_GOSSIP_MESSAGE") && e.data?.quests?.some((q: any) => q.questId === QUEST_INTRO),
    5000,
    "Willem's quest list",
    mark,
  );
  await action("quest_accept", { guid: willem, questId: QUEST_INTRO });
  const deadline = Date.now() + 5000;
  while (![...questLog.values()].includes(QUEST_INTRO)) {
    if (Date.now() > deadline) fail(`quest log never showed ${QUEST_INTRO}`);
    await Bun.sleep(100);
  }
  mark = events.length;
  await action("questgiver_status_multiple_query");
  const refreshed = await waitFor((e) => e.opcode === "SMSG_QUESTGIVER_STATUS_MULTIPLE", 5000, "STATUS_MULTIPLE after accept", mark);
  const after = (refreshed.data.statuses ?? []).find((r: any) => r.guid === willem);
  if (!after) fail(`refreshed STATUS_MULTIPLE did not name Willem: ${JSON.stringify(refreshed.data)}`);
  if (STATUS_AVAILABLE.has(after.status)) fail(`Willem still reads available (${after.status}) after giving quest ${QUEST_INTRO}`);
  log(`after accept: Willem status ${willemRow.status} -> ${after.status}`);

  // 5. Teardown.
  const del = await req("DELETE", "/session", { token: TOKEN });
  if (del.status !== 200) fail(`session delete failed: ${JSON.stringify(del.json)}`);
  let deleted: any = null;
  for (let attempt = 0; attempt < 5 && !deleted?.json?.deleted; ++attempt) {
    await Bun.sleep(2000);
    deleted = await req("POST", "/character-delete", { token: `${TOKEN}-del${attempt}`, account: ACCOUNT, character: CHARACTER });
  }
  if (!deleted?.json?.deleted) fail(`character-delete never succeeded`);
  ws.close();
  log("PASS: questgiver status (multiple + per-guid + refresh after accept) and quest query decode");
  process.exit(0);
}

main().catch((e) => fail(String(e?.stack ?? e)));
