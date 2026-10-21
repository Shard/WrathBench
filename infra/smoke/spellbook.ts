/**
 * Probe for the spellbook/cooldown/talent surface and the raw escape hatch
 * (the raw allowlist is in module/PROTOCOL.md): the `SMSG_INITIAL_SPELLS`, `SMSG_LEARNED_SPELL`,
 * `SMSG_SPELL_COOLDOWN`, `SMSG_TALENTS_INFO` decodes plus the `learn_talent`
 * and `raw` actions.
 *
 * Standalone, raw HTTP/WS only (no SDK), and it needs the image that carries
 * those taps: it FAILS against any worldserver built before that change
 * (`raw` comes back 400 unsupported_action). Run it only after the image is
 * deployed.
 *
 * Arc: fresh Human Paladin in Northshire ->
 *   1. SMSG_INITIAL_SPELLS arrives during login with a non-empty spellbook
 *      whose rows carry rank and name, and SMSG_TALENTS_INFO (player form)
 *      arrives with 0 unspent points at level 1;
 *   2. cast Seal of Righteousness (21084, a level-1 paladin spell that is in
 *      the initial book) on self -> SMSG_SPELL_GO naming us as caster and as
 *      the hit target (no SMSG_SPELL_COOLDOWN: a GCD-only spell never sends
 *      one in 3.3.5 — see the comment at the cast);
 *   2b. cast Holy Light (635, 2.5s) on self and the Seal ~300ms into it ->
 *      SMSG_CAST_FAILED spell_in_progress (105) for the Seal, and Holy Light's
 *      SMSG_SPELL_GO with no SMSG_SPELL_FAILURE (the client's cast counter);
 *   3. learn_talent at level 1 -> SMSG_TALENTS_INFO answers (nothing
 *      learned: no points), proving the handler round-trip;
 *   4. raw CMSG_TEXT_EMOTE (wave, 0x16) is acked 200; raw with a movement
 *      opcode name is refused 400 opcode_not_allowed; raw with odd hex is
 *      400 invalid_payload;
 *   5. log out and delete the character.
 *
 * Run from inside the network:
 *   bun wb smoke spellbook
 *   bun wb --local smoke spellbook   # the quickstart
 */

const BASE = moduleBase();
const WS = moduleWsBase();

const TOKEN = `probe-spellbook-${crypto.randomUUID()}`;
import { probeName } from "./lib/name";
import { authHeaders } from "./lib/auth";
import { failOnce } from "./lib/fail";
import { moduleBase, moduleWsBase } from "./lib/module";

const CHARACTER = probeName("Bp");
const ACCOUNT = process.env.MODULE_ACCOUNT ?? "PROBE";

const SEAL_OF_RIGHTEOUSNESS = 21084;
const HOLY_LIGHT = 635; // rank 1, a 2.5s cast in a level-1 paladin's book
const SPELL_FAILED_SPELL_IN_PROGRESS = 105;

function log(msg: string) {
  console.log(`[probe] ${msg}`);
}
// Best-effort session cleanup so a failed run does not leave the account
// blocked for the next one (lib/fail.ts: once, awaited, then the exit).
const { fail: failNow, failed } = failOnce({
  prefix: () => "[probe] FAIL",
  cleanup: () => fetch(`${BASE}/session`, { method: "DELETE", headers: authHeaders(), body: JSON.stringify({ token: TOKEN }) }),
  cleanupMs: 3000,
});
function fail(msg: string): never {
  return failNow(msg);
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
let selfGuid = "";

function openEvents(): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${WS}/events?token=${encodeURIComponent(TOKEN)}`, { headers: authHeaders() });
    ws.addEventListener("open", () => resolve(ws));
    ws.addEventListener("error", (e) => reject(new Error(`ws error: ${String(e)}`)));
    ws.addEventListener("message", (ev) => {
      try {
        const e = JSON.parse(String(ev.data));
        events.push(e);
        if (e.opcode === "SMSG_UPDATE_OBJECT") for (const o of e.data?.objects ?? []) if (o.self) selfGuid = o.guid;
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

async function main() {
  const health = await req("GET", "/health");
  if (health.status !== 200 || !health.json?.ok) fail(`health not ok: ${JSON.stringify(health)}`);
  log(`health ok (build ${health.json.build}), character=${CHARACTER}`);

  const ws = await openEvents();
  await Bun.sleep(200);

  const session = await req("POST", "/session", { token: TOKEN, account: ACCOUNT, character: CHARACTER, race: 1, class: 2 });
  if (session.status !== 200 || !session.json?.inWorld) fail(`session failed: ${JSON.stringify(session.json)}`);
  log(`in world as ${CHARACTER} guid=${session.json.guid}`);
  await waitFor((e) => e.opcode === "SMSG_UPDATE_OBJECT" && e.data?.objects?.some((o: any) => o.self), 10000, "self create");

  // 1. Login-time spellbook and talents.
  const initial = await waitFor((e) => e.opcode === "SMSG_INITIAL_SPELLS", 5000, "SMSG_INITIAL_SPELLS");
  if (initial.data?.decodeError) fail(`INITIAL_SPELLS decodeError`);
  const spells: any[] = initial.data.spells ?? [];
  if (spells.length === 0) fail(`INITIAL_SPELLS carried no spells`);
  const seal = spells.find((s) => s.spellId === SEAL_OF_RIGHTEOUSNESS);
  if (!seal) fail(`spell ${SEAL_OF_RIGHTEOUSNESS} not in the initial book: ${spells.map((s) => s.spellId).join(",")}`);
  if (typeof seal.rank !== "number" || typeof seal.name !== "string") fail(`spell row lacks rank/name: ${JSON.stringify(seal)}`);
  if (!Array.isArray(initial.data.cooldowns)) fail(`INITIAL_SPELLS lacks cooldowns[]`);
  log(`INITIAL_SPELLS: ${spells.length} spells, ${initial.data.cooldowns.length} cooldowns; ${SEAL_OF_RIGHTEOUSNESS} = "${seal.name}" rank ${seal.rank}`);

  const talents = await waitFor((e) => e.opcode === "SMSG_TALENTS_INFO" && e.data?.pet === false, 5000, "player SMSG_TALENTS_INFO");
  if (talents.data.unspentPoints !== 0) fail(`level-1 character has ${talents.data.unspentPoints} unspent talent points`);
  if (!Array.isArray(talents.data.specs)) fail(`TALENTS_INFO lacks specs[]: ${JSON.stringify(talents.data)}`);
  log(`TALENTS_INFO: unspent=${talents.data.unspentPoints} specs=${talents.data.specs.length} active=${talents.data.activeSpec}`);

  // 2. Cast a known spell -> SMSG_SPELL_GO naming us as caster.
  //    Deliberately NOT SMSG_SPELL_COOLDOWN: for a player's own cast the core
  //    sends it only when a cooldown-modifying aura changed the timer
  //    (module/PROTOCOL.md, after the spellbook table), so no cast this
  //    character can make produces it, and a higher level alone would not
  //    change that. Measured on a level-1 Human Paladin: 21084 (Seal of
  //    Righteousness, GCD only), 59752 (Every Man for Himself, a 2-minute
  //    racial) and the Hearthstone (a 30-minute cooldown) all cast without
  //    any cooldown opcode. The hole this leaves: nothing here exercises the
  //    SMSG_SPELL_COOLDOWN or SMSG_COOLDOWN_EVENT decode, and the login-time
  //    `cooldowns[]` check above is a different wire shape (the block inside
  //    SMSG_INITIAL_SPELLS) that is empty on a fresh character. Routes that
  //    could close part of it, none built: relog after a Hearthstone and read
  //    its cooldown back from `cooldowns[]` (measured to work; needs a
  //    fixture that clears character_spell_cooldown and adds minutes to every
  //    deploy); drink a potion for SMSG_COOLDOWN_EVENT (needs a purchased
  //    one, which waits on issue #33); or cancel a Rogue's Stealth, which the
  //    core source says also sends SMSG_COOLDOWN_EVENT (not yet observed).
  let mark = events.length;
  await action("cast_spell", { spellId: SEAL_OF_RIGHTEOUSNESS });
  const go = await waitFor(
    (e) => e.opcode === "SMSG_SPELL_GO" && e.data?.spellId === SEAL_OF_RIGHTEOUSNESS,
    5000,
    "SMSG_SPELL_GO",
    mark,
  );
  if (go.data.casterGuid !== selfGuid) fail(`SPELL_GO caster ${go.data.casterGuid} is not us (${selfGuid})`);
  if (!Array.isArray(go.data.hitGuids) || !go.data.hitGuids.includes(selfGuid))
    fail(`self-cast SPELL_GO does not hit us: ${JSON.stringify(go.data)}`);
  log(`SPELL_GO: ${SEAL_OF_RIGHTEOUSNESS} cast by us, hit us`);

  // 2b. A cast during a cast is refused, as a client's is. The module stamps
  //     each cast with the client's own counter; with the old constant 0 the
  //     core skipped its in-progress check (Spell::prepare), so the second
  //     cast reached CheckCast (not_ready on the GCD) or, past the GCD,
  //     silently cancelled the first. Holy Light is a 2.5s cast; the Seal goes
  //     out ~300ms into it, well outside the 400ms spell-queue window, so the
  //     answer is SMSG_CAST_FAILED spell_in_progress (105) for the Seal and
  //     Holy Light still goes off.
  if (!spells.some((s) => s.spellId === HOLY_LIGHT)) fail(`spell ${HOLY_LIGHT} (Holy Light) not in the initial book`);
  await Bun.sleep(2000); // the Seal's GCD
  mark = events.length;
  await action("cast_spell", { spellId: HOLY_LIGHT, targetGuid: selfGuid });
  await waitFor((e) => e.opcode === "SMSG_SPELL_START" && e.data?.spellId === HOLY_LIGHT, 3000, "Holy Light SMSG_SPELL_START", mark);
  await Bun.sleep(300);
  await action("cast_spell", { spellId: SEAL_OF_RIGHTEOUSNESS });
  const refused = await waitFor(
    (e) => e.opcode === "SMSG_CAST_FAILED" && e.data?.spellId === SEAL_OF_RIGHTEOUSNESS,
    3000,
    "SMSG_CAST_FAILED for the Seal sent during Holy Light",
    mark,
  );
  if (refused.data.result !== SPELL_FAILED_SPELL_IN_PROGRESS)
    fail(`the Seal during Holy Light answered result ${refused.data.result}, not ${SPELL_FAILED_SPELL_IN_PROGRESS} (spell_in_progress)`);
  await waitFor((e) => e.opcode === "SMSG_SPELL_GO" && e.data?.spellId === HOLY_LIGHT, 5000, "Holy Light SMSG_SPELL_GO", mark);
  const cut = events.slice(mark).find((e) => e.opcode === "SMSG_SPELL_FAILURE" && e.data?.spellId === HOLY_LIGHT);
  if (cut) fail(`Holy Light was interrupted by the cast sent during it: ${JSON.stringify(cut.data)}`);
  log(`cast during a cast: the Seal refused spell_in_progress, Holy Light went off`);

  // 3. learn_talent round-trip (no points at level 1: answered, not learned).
  mark = events.length;
  await action("learn_talent", { talentId: 1449, rank: 0 }); // Divine Strength, tier 1 Holy
  const after = await waitFor((e) => e.opcode === "SMSG_TALENTS_INFO" && e.data?.pet === false, 5000, "TALENTS_INFO after learn_talent", mark);
  const learned = (after.data.specs?.[after.data.activeSpec]?.talents ?? []).some((t: any) => t.talentId === 1449);
  if (learned) fail(`level-1 character learned a talent`);
  log(`learn_talent answered: unspent=${after.data.unspentPoints}, nothing learned (expected)`);
  const missing = await req("POST", "/action", { token: TOKEN, action: "learn_talent", talentId: 1449 });
  if (missing.status !== 400 || missing.json?.error !== "missing_talent") fail(`learn_talent without rank: ${missing.status} ${JSON.stringify(missing.json)}`);

  // 4. raw: allowed, refused, malformed.
  await action("raw", { opcode: "CMSG_TEXT_EMOTE", payload: "16000000" + "ffffffff" + "0000000000000000" }); // wave, no target
  log(`raw CMSG_TEXT_EMOTE acked`);
  const denied = await req("POST", "/action", { token: TOKEN, action: "raw", opcode: "MSG_MOVE_START_FORWARD", payload: "" });
  if (denied.status !== 400 || denied.json?.error !== "opcode_not_allowed") fail(`raw movement opcode: ${denied.status} ${JSON.stringify(denied.json)}`);
  const odd = await req("POST", "/action", { token: TOKEN, action: "raw", opcode: "CMSG_EMOTE", payload: "abc" });
  if (odd.status !== 400 || odd.json?.error !== "invalid_payload") fail(`raw odd hex: ${odd.status} ${JSON.stringify(odd.json)}`);
  log(`raw refusals: opcode_not_allowed, invalid_payload`);

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
  log("PASS: spellbook/talents decodes, self-cast SPELL_GO, cast during a cast refused, learn_talent round-trip, raw allow/deny");
  process.exit(0);
}

main().catch(failed);
