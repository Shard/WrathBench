/**
 * Throwaway probe for the Stage-2 module vertical slice.
 *
 * Drives the whole slice against a booted worldserver from inside the container
 * network: open a WebSocket for events, POST /session (create character + enter
 * world), POST /action say "hello world", assert the chat echo comes back on the
 * WS, then DELETE /session. No dependencies; Bun built-ins only.
 *
 * Run from inside the network, e.g.:
 *   bun wb smoke module-slice
 *   bun wb --local smoke module-slice   # the quickstart
 *
 * Override the target with MODULE_HOST / MODULE_PORT (default worldserver:8086).
 */

import { moduleBase, moduleWsBase, moduleRequest } from "./lib/module";
import { smokeToken } from "./lib/session";
import { failAndExit as fail, taggedLog } from "./lib/report";
import { openEventStream, waitForEvent } from "./lib/events";

const BASE = moduleBase();
const WS = moduleWsBase();

// Session tokens must be at least 32 characters (POST /session rejects
// shorter ones with weak_token); randomUUID keeps them unguessable too.
const TOKEN = smokeToken("module-slice");
// WoW character names are letters only (digits => CHAR_NAME_MIXED_LANGUAGES) and
// must be unique. A random letter suffix keeps re-runs from colliding.
function randomName(): string {
  const letters = "abcdefghijklmnopqrstuvwxyz";
  let s = "Bench";
  for (let i = 0; i < 5; i++) s += letters[Math.floor(Math.random() * letters.length)];
  return s;
}
const CHARACTER = randomName();
const SAY_TEXT = "hello world";

const log = taggedLog("probe");

const req = moduleRequest(BASE);

// Collect events off the WebSocket into a shared buffer.
const events: any[] = [];

function openEvents(): Promise<WebSocket> {
  return openEventStream(
    WS,
    TOKEN,
    (obj) => {
      events.push(obj);
      log(`event <- ${obj.opcode} ${JSON.stringify(obj.data)}`);
    },
    (raw) => log(`event <- (unparseable) ${raw}`),
  );
}

function waitFor(pred: (e: any) => boolean, timeoutMs: number, what: string): Promise<any> {
  return waitForEvent(events, pred, timeoutMs, what, fail);
}

async function main() {
  // 1. Health.
  const health = await req("GET", "/health");
  if (health.status !== 200 || !health.json?.ok) fail(`health not ok: ${JSON.stringify(health)}`);
  log(`health ok: ${JSON.stringify(health.json)}`);

  // 2. Open the event stream before creating the session so we catch login packets.
  const ws = await openEvents();
  log(`ws connected for token ${TOKEN}`);
  await Bun.sleep(200); // let the OnWsOpen register

  // 3. Create session: create the character and enter the world.
  const session = await req("POST", "/session", {
    token: TOKEN,
    character: CHARACTER,
    race: 1, // Human
    class: 1, // Warrior
    gender: 0,
  });
  if (session.status !== 200 || !session.json?.ok || !session.json?.inWorld) {
    fail(`session create failed: ${session.status} ${JSON.stringify(session.json)}`);
  }
  log(`session in world: ${JSON.stringify(session.json)}`);
  const selfGuid = BigInt(session.json.guid);

  // We should have seen the login handshake packets on the WS by now.
  await waitFor((e) => e.opcode === "SMSG_LOGIN_VERIFY_WORLD", 5000, "SMSG_LOGIN_VERIFY_WORLD event");
  log("observed SMSG_LOGIN_VERIFY_WORLD on the event stream");

  const beforeSay = events.length;

  // 4. Say "hello world".
  const say = await req("POST", "/action", { token: TOKEN, action: "say", text: SAY_TEXT });
  if (say.status !== 200 || !say.json?.ok) fail(`say action failed: ${say.status} ${JSON.stringify(say.json)}`);
  log(`say dispatched: ${JSON.stringify(say.json)}`);

  // 5. Assert the chat echo comes back on the WS, from our own character.
  const chat = await waitFor(
    (e) => e.opcode === "SMSG_MESSAGECHAT" && e.data?.message === SAY_TEXT,
    5000,
    `SMSG_MESSAGECHAT with message "${SAY_TEXT}"`,
  );
  if (BigInt(chat.data.senderGuid) !== selfGuid) {
    fail(`chat sender ${chat.data.senderGuid} != self ${selfGuid}`);
  }
  if (events.indexOf(chat) < beforeSay) fail("chat event predates the say action");
  log(`chat echo verified: sender=${chat.data.senderGuid} type=${chat.data.type} msg="${chat.data.message}"`);

  // 6. Logout.
  const del = await req("DELETE", "/session", { token: TOKEN });
  if (del.status !== 200 || !del.json?.ok) fail(`session delete failed: ${del.status} ${JSON.stringify(del.json)}`);
  log(`session deleted: ${JSON.stringify(del.json)}`);

  ws.close();

  const finalHealth = await req("GET", "/health");
  log(`final health: ${JSON.stringify(finalHealth.json)}`);

  log("PASS: create character -> in world -> say -> chat event -> logout");
  process.exit(0);
}

main().catch((e) => fail(String(e?.stack ?? e)));
