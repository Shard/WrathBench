/**
 * Probe for the trainer action surface (FOLLOW-UPS 9): `trainer_list` /
 * `trainer_buy_spell` plus the `SMSG_TRAINER_LIST`, `SMSG_TRAINER_BUY_SUCCEEDED`
 * and `SMSG_TRAINER_BUY_FAILED` decodes.
 *
 * Standalone, raw HTTP/WS only (no SDK), and it needs the trainer image: it
 * FAILS against any worldserver built before that change (`trainer_list` comes
 * back 400 unsupported_action). Run it only after the image is deployed.
 *
 * Arc: fresh Human Paladin in Northshire -> walk into Northshire Abbey (the
 * waypoint module-quest.ts already proves) -> find a class trainer purely from
 * served events (creature-query name/subname) -> walk to it (the handler needs
 * INTERACTION_DISTANCE, not update range) -> `trainer_list` -> assert the
 * decoded spell list parses -> buy the cheapest spell and assert an outcome
 * event -> log out and delete the character.
 *
 * Northshire rather than the dwarf start on purpose: Brother Sammuel is the
 * trainer models actually walk to in trajectories (FOLLOW-UPS 9), and the abbey
 * route is the one waypoint set already verified by another smoke.
 *
 * Expected branch at level 1: a level-1 paladin with stock starting money is
 * likely to see NO green (state 0) spell — everything it can use it already
 * knows, the rest is gated on level. The probe then buys the cheapest
 * not-known spell instead and accepts `SMSG_TRAINER_BUY_FAILED` with a decoded
 * reason as a pass: what is under test is the opcode path and the decode, and a
 * refusal exercises both. If a green spell IS offered it buys that one and
 * expects `SMSG_TRAINER_BUY_SUCCEEDED` (money permitting — `state` says nothing
 * about affordability, so reason 1 is a legitimate outcome there too). Whichever
 * fires is logged.
 *
 * Run from inside the network:
 *   docker compose -f infra/compose.yml exec runner bun infra/smoke/trainer.ts
 */

const HOST = process.env.MODULE_HOST ?? "worldserver";
const PORT = process.env.MODULE_PORT ?? "8086";
const BASE = `http://${HOST}:${PORT}`;
const WS = `ws://${HOST}:${PORT}`;

// Session tokens must be at least 32 characters (POST /session rejects
// shorter ones with weak_token); randomUUID keeps them unguessable too.
const TOKEN = `probe-trainer-${crypto.randomUUID()}`;

// Fresh character every run, deleted at the end.
import { probeName } from "./lib/name";
import { authHeaders } from "./lib/auth";

const CHARACTER = probeName("Bt");

// Own account so the probe never fights the runner track for the default
// RUNNER account (one live session per account).
const ACCOUNT = process.env.MODULE_ACCOUNT ?? "PROBE";

// Inside Northshire Abbey, the waypoint module-quest.ts walks to for Marshal
// McBride. The abbey trainers come into update range from here; the probe then
// walks the last few yards to whichever one it picks.
const ABBEY = { x: -8902.6, y: -162.6, z: 82.0 };

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
  } catch {
    /* ignore non-JSON */
  }
  return { status: res.status, json };
}

async function action(name: string, fields: Record<string, unknown> = {}): Promise<any> {
  const r = await req("POST", "/action", { token: TOKEN, action: name, ...fields });
  if (r.status !== 200 || !r.json?.ok) fail(`action ${name} failed: ${r.status} ${JSON.stringify(r.json)}`);
  return r.json;
}

// ---------------------------------------------------------------- event feed
type Vec = { x: number; y: number; z: number };
const events: any[] = [];
const startedAt = Date.now();

const units = new Map<string, { entry?: number; pos?: Vec; dead?: boolean }>();
const creatures = new Map<number, { name: string; subname: string }>();
const self = { guid: "", money: 0, level: 1, pos: { x: 0, y: 0, z: 0 } as Vec };

function trackEvent(e: any) {
  if (e.opcode === "SMSG_UPDATE_OBJECT" && Array.isArray(e.data?.objects)) {
    for (const o of e.data.objects) {
      if (o.update === "create") {
        const u = units.get(o.guid) ?? {};
        if (o.pos) u.pos = o.pos;
        if (o.fields?.entry !== undefined) u.entry = o.fields.entry;
        if (o.fields?.health !== undefined) u.dead = o.fields.health === 0;
        units.set(o.guid, u);
        if (o.self) self.guid = o.guid;
      } else if (o.update === "values") {
        const u = units.get(o.guid) ?? {};
        if (o.fields?.health !== undefined) u.dead = o.fields.health === 0;
        units.set(o.guid, u);
      } else if (o.update === "movement" && o.pos) {
        const u = units.get(o.guid) ?? {};
        u.pos = o.pos;
        units.set(o.guid, u);
      } else if (o.update === "outOfRange") {
        for (const g of o.guids ?? []) units.delete(g);
      }
      if ((o.update === "create" || o.update === "values") && o.guid === self.guid && o.fields) {
        if (o.fields.money !== undefined) self.money = o.fields.money;
        if (o.fields.level !== undefined) self.level = o.fields.level;
      }
    }
  } else if (e.opcode === "SMSG_CREATURE_QUERY_RESPONSE" && e.data?.found) {
    creatures.set(e.data.entry, { name: e.data.name ?? "", subname: e.data.subname ?? "" });
  } else if (e.opcode === "SMSG_DESTROY_OBJECT") {
    units.delete(e.data?.guid);
  } else if (e.opcode === "WB_MOVE_RESULT" || e.opcode === "WB_MOVE_PROGRESS") {
    if (e.data?.pos) self.pos = e.data.pos;
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

// Like waitFor, but a miss is an answer rather than a failure: the trainer
// handlers return silently when the NPC is out of range, is not a trainer, or
// trains another class, so "no event" is a real outcome the probe must handle.
async function pollFor(pred: (e: any) => boolean, timeoutMs: number, from = 0): Promise<any | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    for (let i = from; i < events.length; ++i) if (pred(events[i])) return events[i];
    if (Date.now() > deadline) return null;
    await Bun.sleep(100);
  }
}

async function tryMoveTo(target: Vec, what: string, depth = 0): Promise<string> {
  const r = await action("move_to", target);
  const res = await waitFor(
    (e) => e.opcode === "WB_MOVE_RESULT" && e.data?.moveId === r.moveId,
    120000,
    `WB_MOVE_RESULT for ${what}`,
  );
  if (res.data.status === "arrived") return "arrived";
  if (res.data.status === "too_far" && depth < 4) {
    const mid = {
      x: (self.pos.x + target.x) / 2,
      y: (self.pos.y + target.y) / 2,
      z: (self.pos.z + target.z) / 2,
    };
    log(`move to ${what}: ${res.data.status}, hopping via midpoint`);
    const midStatus = await tryMoveTo(mid, `${what} (midpoint)`, depth + 1);
    if (midStatus !== "arrived") return midStatus;
    return tryMoveTo(target, what, depth + 1);
  }
  if (res.data.status === "interrupted" && depth < 6) {
    await Bun.sleep(1000);
    return tryMoveTo(target, what, depth + 1);
  }
  return res.data.status;
}

// Trainer candidates, purely from served events: creature subnames the client
// shows under the name ("Paladin Trainer", "Weapon Master", ...). Class
// trainers matching our own class first, then any other trainer.
type Candidate = { guid: string; entry: number; name: string; subname: string; pos?: Vec };
function trainerCandidates(preferred: RegExp): Candidate[] {
  const out: Candidate[] = [];
  for (const [guid, u] of units) {
    if (u.entry === undefined || u.dead) continue;
    const c = creatures.get(u.entry);
    if (!c || !/trainer/i.test(c.subname)) continue;
    out.push({ guid, entry: u.entry, name: c.name, subname: c.subname, pos: u.pos });
  }
  out.sort((a, b) => Number(preferred.test(b.subname)) - Number(preferred.test(a.subname)));
  return out;
}

async function main() {
  const health = await req("GET", "/health");
  if (health.status !== 200 || !health.json?.ok) fail(`health not ok: ${JSON.stringify(health)}`);
  if (health.json.worldStopped) fail("world is stopped");
  log(`health ok, character=${CHARACTER}`);

  const ws = await openEvents();
  await Bun.sleep(200);

  // 1. Fresh Human Paladin in Northshire.
  const session = await req("POST", "/session", {
    token: TOKEN, account: ACCOUNT, character: CHARACTER, race: 1, class: 2,
  });
  if (session.status !== 200 || !session.json?.inWorld) fail(`session failed: ${JSON.stringify(session.json)}`);
  log(`in world as ${CHARACTER} guid=${session.json.guid}`);
  const verify = await waitFor((e) => e.opcode === "SMSG_LOGIN_VERIFY_WORLD", 5000, "login verify");
  self.pos = { x: verify.data.x, y: verify.data.y, z: verify.data.z };
  await waitFor((e) => e.opcode === "SMSG_UPDATE_OBJECT" && e.data?.objects?.some((o: any) => o.self), 10000, "self create");

  // 2. Walk into the abbey; the trainers are within update range of McBride.
  const arrival = await tryMoveTo(ABBEY, "Northshire Abbey");
  if (arrival !== "arrived") fail(`move into the abbey ended ${arrival}`);

  // Creature-query answers for a room full of NPCs trickle in; poll rather
  // than sleeping a fixed amount and calling an empty room a failure.
  let candidates = trainerCandidates(/paladin/i);
  for (const deadline = Date.now() + 10_000; candidates.length === 0 && Date.now() < deadline; ) {
    await Bun.sleep(250);
    candidates = trainerCandidates(/paladin/i);
  }
  if (candidates.length === 0) {
    fail(
      `no creature with a "Trainer" subname in update range at the abbey; ` +
        `saw ${units.size} units, ${creatures.size} creature-query answers`,
    );
  }
  log(`trainer candidates: ${candidates.map((c) => `${c.name} <${c.subname}>`).join(", ")}`);

  // 3. trainer_list, walking the candidate list: the handler answers nothing at
  // all for a trainer of another class, so silence means "try the next one".
  let listed: any = null;
  let trainer: Candidate | null = null;
  for (const c of candidates.slice(0, 3)) {
    // The handler resolves the NPC through GetNPCIfCanInteractWith, which is
    // an INTERACTION_DISTANCE (~5.5yd) check — update range is not enough, so
    // walk to the candidate first, exactly as a player would.
    if (!c.pos) {
      log(`skipping ${c.name}: no position seen yet`);
      continue;
    }
    const walked = await tryMoveTo(c.pos, `${c.name} <${c.subname}>`);
    if (walked !== "arrived") {
      log(`could not reach ${c.name}: ${walked}`);
      continue;
    }
    const mark = events.length;
    await action("trainer_list", { guid: c.guid });
    const ev = await pollFor((e) => e.opcode === "SMSG_TRAINER_LIST" && e.data?.guid === c.guid, 5000, mark);
    if (ev) {
      listed = ev;
      trainer = c;
      break;
    }
    log(`no SMSG_TRAINER_LIST from ${c.name} <${c.subname}> — wrong class, out of range, or not a trainer`);
  }
  if (!listed || !trainer) {
    fail(
      `no trainer answered trainer_list. If the action itself came back 200 but nothing arrived, ` +
        `check class match ` +
        `(this character is a Paladin).`,
    );
  }
  log(`${trainer.name} answered SMSG_TRAINER_LIST: type=${listed.data.trainerType} greeting="${listed.data.greeting ?? ""}"`);

  // 4. The decoded shape is the thing under test.
  const spells: any[] = listed.data.spells;
  if (!Array.isArray(spells) || spells.length === 0) fail(`empty/absent spells array: ${JSON.stringify(listed.data)}`);
  for (const s of spells) {
    for (const k of ["spellId", "state", "cost", "reqLevel", "reqSkill", "reqSkillValue"]) {
      if (typeof s[k] !== "number") fail(`spell entry missing numeric ${k}: ${JSON.stringify(s)}`);
    }
    if (s.state < 0 || s.state > 2) fail(`spell state out of the 0..2 enum: ${JSON.stringify(s)}`);
  }
  const byState = [0, 1, 2].map((st) => spells.filter((s) => s.state === st).length);
  log(
    `${spells.length} spells: ${byState[0]} green(available) ${byState[1]} red(unavailable) ${byState[2]} gray(known); ` +
      `money=${self.money}c level=${self.level}`,
  );

  // 5. Buy: cheapest green if there is one, else cheapest not-known spell so the
  // buy path still runs and answers with a decoded failure reason.
  const green = spells.filter((s) => s.state === 0).sort((a, b) => a.cost - b.cost);
  const fallback = spells.filter((s) => s.state !== 2).sort((a, b) => a.cost - b.cost);
  const pick = green[0] ?? fallback[0];
  if (!pick) fail("trainer offers only already-known spells; nothing to exercise the buy path with");
  const expecting = green.length > 0 ? "SUCCEEDED (green spell, money permitting)" : "FAILED (no green spell at level 1)";
  log(`buying spell ${pick.spellId} (state=${pick.state} cost=${pick.cost}c reqLevel=${pick.reqLevel}); expecting ${expecting}`);

  const mark = events.length;
  await action("trainer_buy_spell", { guid: trainer.guid, spellId: pick.spellId });
  const outcome = await pollFor(
    (e) =>
      (e.opcode === "SMSG_TRAINER_BUY_SUCCEEDED" || e.opcode === "SMSG_TRAINER_BUY_FAILED") &&
      e.data?.spellId === pick.spellId,
    8000,
    mark,
  );
  if (!outcome) {
    fail(
      `trainer_buy_spell produced no outcome event within 8s. The handler returns silently when the ` +
        `trainer is not valid for the character or is out of interaction range; both should have been ` +
        `ruled out by the trainer_list above.`,
    );
  }
  if (outcome.opcode === "SMSG_TRAINER_BUY_SUCCEEDED") {
    if (outcome.data.guid !== trainer.guid) fail(`buy succeeded for the wrong trainer guid: ${JSON.stringify(outcome.data)}`);
    log(`SMSG_TRAINER_BUY_SUCCEEDED spellId=${outcome.data.spellId} (money now ${self.money}c)`);
  } else {
    const reasons = ["unavailable", "not_enough_money", "not_enough_skill"];
    if (typeof outcome.data.reason !== "number") fail(`buy failure has no decoded reason: ${JSON.stringify(outcome.data)}`);
    log(`SMSG_TRAINER_BUY_FAILED spellId=${outcome.data.spellId} reason=${outcome.data.reason} (${reasons[outcome.data.reason] ?? "?"})`);
  }

  // 6. Cleanup: log out and delete the probe character.
  const del = await req("DELETE", "/session", { token: TOKEN });
  if (del.status !== 200) fail(`session delete failed: ${JSON.stringify(del.json)}`);
  log("logged out");
  let deleted: any = null;
  for (let attempt = 0; attempt < 10 && !deleted?.json?.deleted; ++attempt) {
    await Bun.sleep(3000);
    deleted = await req("POST", "/character-delete", { token: `${TOKEN}-del${attempt}`, account: ACCOUNT, character: CHARACTER });
    if (!deleted.json?.deleted) log(`character-delete attempt ${attempt}: ${deleted.status} ${JSON.stringify(deleted.json)}`);
  }
  if (!deleted?.json?.deleted) fail(`character-delete never succeeded; sweep ${CHARACTER} on ${ACCOUNT}`);
  log(`character ${CHARACTER} deleted`);

  ws.close();
  const secs = (Date.now() - startedAt) / 1000;
  log(`stats: ${events.length} events in ${secs.toFixed(1)}s`);
  log("PASS: trainer_list decoded -> spell list parsed -> trainer_buy_spell answered");
  process.exit(0);
}

main().catch((e) => fail(String(e?.stack ?? e)));
