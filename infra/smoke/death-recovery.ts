/**
 * Probe for the death-recovery path end to end (docs/FOLLOW-UPS.md item 14).
 *
 * The three fixes under test: the module now acks graveyard teleports
 * (TickTeleportAcks), lets a released ghost move (the IsAlive guard is
 * ghost-aware), and whitelists spirit_healer_activate. Pre-fix, a repop left
 * the character wedged at the death spot forever.
 *
 * Full arc against a booted worldserver, raw HTTP/WS only (no SDK):
 * fresh Human Warrior in Northshire -> walk to the vineyards -> pull several
 * Kobold Vermin (attack to aggro, then stop fighting and stand) -> die
 * (self health 0 + SMSG_DEATH_RELEASE_LOC) -> repop -> assert the graveyard
 * teleport APPLIED: server-truth position (via a reattach WB_SESSION_STATE)
 * moved off the death spot to the release loc -> ghost-run back to the corpse
 * (move_to must work while dead+ghost) -> wait out the 30s reclaim delay ->
 * reclaim_corpse within the 39y radius -> assert resurrection via health
 * (a rejected reclaim is silent) -> logout + character delete.
 *
 * item 53 additions (module built 2026-08-23, needs that build): after
 * repop the module asks MSG_CORPSE_QUERY once on the client's behalf and the
 * answer is served — assert found:1 within 5y of the recorded death spot; then
 * a reclaim sent from the graveyard is the too_far case — assert the corpse
 * is further than 39y and the reclaim is silently refused (no release-clear,
 * health still the ghost's 1). The SDK's `too_far` verdict is this distance
 * plus the radius; the raw probe checks the facts it is built from.
 *
 * Each step fails with a named FAIL line and a non-zero exit.
 *
 * Run:
 *   docker compose -f infra/compose.yml exec runner bun infra/smoke/death-recovery.ts
 */

const HOST = process.env.MODULE_HOST ?? "worldserver";
const PORT = process.env.MODULE_PORT ?? "8086";
const BASE = `http://${HOST}:${PORT}`;
const WS = `ws://${HOST}:${PORT}`;

// Session tokens must be at least 32 characters (POST /session rejects
// shorter ones with weak_token); randomUUID keeps them unguessable too.
const TOKEN = `probe-death-${crypto.randomUUID()}`;
// Own account so the probe never fights the runner track for the default
// RUNNER account (one live session per account). Created by
// infra/bootstrap/bootstrap.ts with WRATHBENCH_ACCOUNT_USER=PROBE.
const ACCOUNT = process.env.MODULE_ACCOUNT ?? "PROBE";
// Fresh character every run: the arc needs a level 1 that kobolds can kill.
import { probeName } from "./lib/name";
import { authHeaders } from "./lib/auth";

const CHARACTER = probeName("Bd");

const ENTRY_VERMIN = 6; // Kobold Vermin, Northshire vineyards
const VINEYARDS = { x: -8790, y: -160, z: 82.5 };

function log(msg: string) {
  console.log(`[probe] ${msg}`);
}

let cleanupStarted = false;
async function cleanup() {
  if (cleanupStarted) return;
  cleanupStarted = true;
  await req("DELETE", "/session", { token: TOKEN }).catch(() => {});
  for (let attempt = 0; attempt < 6; attempt++) {
    await Bun.sleep(2000);
    const del = await req("POST", "/character-delete", {
      token: `${TOKEN}-del${attempt}`,
      account: ACCOUNT,
      character: CHARACTER,
    }).catch(() => ({ json: undefined }) as any);
    if (del.json?.deleted) return;
  }
  log(`warning: could not delete character ${CHARACTER}; sweep the ${ACCOUNT} account later`);
}

let step = "setup";
function fail(msg: string): never {
  console.error(`[probe] FAIL[${step}]: ${msg}`);
  cleanup().finally(() => process.exit(1));
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

// ---------------------------------------------------------------- event feed
const events: any[] = [];
const startedAt = Date.now();

type Vec = { x: number; y: number; z: number };
const units = new Map<string, { entry?: number; pos?: Vec; health?: number; dead?: boolean }>();
const self = { guid: "", health: -1, maxHealth: 0, level: 1, pos: { x: 0, y: 0, z: 0 } as Vec };

function trackEvent(e: any) {
  if (e.opcode === "SMSG_UPDATE_OBJECT" && Array.isArray(e.data?.objects)) {
    for (const o of e.data.objects) {
      if (o.update === "create") {
        const u = units.get(o.guid) ?? {};
        if (o.pos) u.pos = o.pos;
        if (o.fields?.entry !== undefined) u.entry = o.fields.entry;
        if (o.fields?.health !== undefined) {
          u.health = o.fields.health;
          u.dead = o.fields.health === 0;
        }
        units.set(o.guid, u);
        if (o.self) self.guid = o.guid;
      } else if (o.update === "values") {
        const u = units.get(o.guid) ?? {};
        if (o.fields?.health !== undefined) {
          u.health = o.fields.health;
          u.dead = o.fields.health === 0;
        }
        units.set(o.guid, u);
      } else if (o.update === "movement" && o.pos) {
        const u = units.get(o.guid) ?? {};
        u.pos = o.pos;
        units.set(o.guid, u);
      } else if (o.update === "outOfRange") {
        for (const g of o.guids ?? []) units.delete(g);
      }
      if ((o.update === "create" || o.update === "values") && o.guid === self.guid && o.fields) {
        if (o.fields.health !== undefined) self.health = o.fields.health;
        if (o.fields.maxHealth !== undefined) self.maxHealth = o.fields.maxHealth;
        if (o.fields.level !== undefined) self.level = o.fields.level;
      }
    }
  } else if (e.opcode?.startsWith("MSG_MOVE_") && e.data?.guid && e.data?.pos) {
    const u = units.get(e.data.guid) ?? {};
    u.pos = e.data.pos;
    units.set(e.data.guid, u);
  } else if (e.opcode === "SMSG_MONSTER_MOVE" && e.data?.guid) {
    const u = units.get(e.data.guid) ?? {};
    u.pos = e.data.destination ?? e.data.pos;
    units.set(e.data.guid, u);
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

const dist2d = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);

// Server-truth position without moving: a fresh subscriber to an in-world
// session receives a synthetic WB_SESSION_STATE with the session's live
// map/x/y/z (module-session-state.ts proves that mechanism; here it is the
// only client-observable way to read position while standing still).
async function serverPosition(what: string): Promise<Vec> {
  const mark = events.length;
  const extra = await openEvents(); // fans out to the main socket's buffer too
  const st = await waitFor((e) => e.opcode === "WB_SESSION_STATE", 10000, `WB_SESSION_STATE (${what})`, mark);
  extra.close();
  return { x: st.data.x, y: st.data.y, z: st.data.z };
}

// move_to with midpoint fallback for too_far legs (and the 250y cap).
async function tryMoveTo(target: Vec, what: string, depth = 0): Promise<string> {
  const r = await action("move_to", target);
  const res = await waitFor(
    (e) => e.opcode === "WB_MOVE_RESULT" && e.data?.moveId === r.moveId,
    120000,
    `WB_MOVE_RESULT for ${what}`,
  );
  if (res.data.status === "arrived") return "arrived";
  if (res.data.status === "too_far" && depth < 4) {
    const mid = { x: (self.pos.x + target.x) / 2, y: (self.pos.y + target.y) / 2, z: (self.pos.z + target.z) / 2 };
    log(`move to ${what}: ${res.data.status}, hopping via midpoint`);
    const midStatus = await tryMoveTo(mid, `${what} (midpoint)`, depth + 1);
    if (midStatus !== "arrived") return midStatus;
    return tryMoveTo(target, what, depth + 1);
  }
  return res.data.status;
}

function aliveVermin(exclude: Set<string>): { guid: string; pos: Vec } | undefined {
  let best: { guid: string; pos: Vec; d: number } | undefined;
  for (const [guid, u] of units) {
    if (u.entry !== ENTRY_VERMIN || u.dead || !u.pos || exclude.has(guid)) continue;
    const d = dist2d(u.pos, self.pos);
    if (!best || d < best.d) best = { guid, pos: u.pos, d };
  }
  return best;
}

async function main() {
  const health = await req("GET", "/health");
  if (health.status !== 200 || !health.json?.ok) fail(`health not ok: ${JSON.stringify(health)}`);
  log(`health ok, character=${CHARACTER}`);

  const ws = await openEvents();
  await Bun.sleep(200);

  // 1. Fresh Human Warrior in Northshire.
  step = "session";
  const session = await req("POST", "/session", { token: TOKEN, account: ACCOUNT, character: CHARACTER, race: 1, class: 1 });
  if (session.status !== 200 || !session.json?.inWorld) fail(`session failed: ${session.status} ${JSON.stringify(session.json)}`);
  log(`in world as ${CHARACTER} guid=${session.json.guid}`);
  const verify = await waitFor((e) => e.opcode === "SMSG_LOGIN_VERIFY_WORLD", 5000, "login verify");
  self.pos = { x: verify.data.x, y: verify.data.y, z: verify.data.z };
  await waitFor((e) => e.opcode === "SMSG_UPDATE_OBJECT" && e.data?.objects?.some((o: any) => o.self), 10000, "self create");
  if (!(self.maxHealth > 0)) fail(`self create carried no maxHealth: ${JSON.stringify(self)}`);
  log(`PASS[session]: level ${self.level}, ${self.health}/${self.maxHealth} hp`);

  // 2. Walk to the vineyards and die on purpose: aggro several Kobold Vermin
  //    (attack to get on their threat list, then stop fighting) and stand.
  step = "death";
  if ((await tryMoveTo(VINEYARDS, "the vineyards")) !== "arrived") fail("never reached the vineyards");
  const pulled = new Set<string>();
  const deathDeadline = Date.now() + 6 * 60 * 1000;
  while (self.health !== 0) {
    if (Date.now() > deathDeadline) {
      fail(`still alive after 6 minutes (${self.health}/${self.maxHealth}, ${pulled.size} mobs pulled)`);
    }
    // Keep 2-3 attackers on the threat list; re-pull as vermin die or reset.
    if (pulled.size < 3) {
      const mob = aliveVermin(pulled);
      if (mob) {
        const status = await tryMoveTo(mob.pos, `vermin ${mob.guid}`);
        if (self.health === 0) break; // died on approach: mission accomplished
        if (status === "arrived") {
          await action("set_target", { guid: mob.guid });
          await req("POST", "/action", { token: TOKEN, action: "face", x: mob.pos.x, y: mob.pos.y });
          await action("attack_start", { guid: mob.guid });
          // A landed swing is what puts us on the threat list; then stand down.
          await Bun.sleep(2500);
          await action("attack_stop");
          pulled.add(mob.guid);
          log(`pulled vermin ${mob.guid} (${pulled.size} on the threat list); standing`);
        }
      }
    }
    for (const g of pulled) if (units.get(g)?.dead ?? true) pulled.delete(g);
    await Bun.sleep(500);
  }
  const deathAt = Date.now();
  const deathPos = { ...self.pos };
  log(`dead: health 0 at (${deathPos.x.toFixed(1)}, ${deathPos.y.toFixed(1)}, ${deathPos.z.toFixed(1)})`);
  log(`PASS[death]: health reached 0`);

  // 3. Release spirit. The assertion is the teleport-ack fix: the server-truth
  //    position must actually CHANGE to the graveyard named by
  //    SMSG_DEATH_RELEASE_LOC (pre-fix it froze at the death spot forever).
  step = "repop";
  const mark = events.length;
  await action("repop");
  const release = await waitFor((e) => e.opcode === "SMSG_DEATH_RELEASE_LOC", 10000, "SMSG_DEATH_RELEASE_LOC", mark);
  const grave = { x: release.data.x, y: release.data.y, z: release.data.z };
  log(`release loc: (${grave.x.toFixed(1)}, ${grave.y.toFixed(1)}, ${grave.z.toFixed(1)})`);
  await Bun.sleep(3000); // teleport + module ack tick
  const ghostPos = await serverPosition("post-repop");
  const fromDeath = dist2d(ghostPos, deathPos);
  const fromGrave = dist2d(ghostPos, grave);
  log(`post-repop server position: (${ghostPos.x.toFixed(1)}, ${ghostPos.y.toFixed(1)}); ${fromDeath.toFixed(1)}y from death spot, ${fromGrave.toFixed(1)}y from release loc`);
  if (fromDeath < 20) fail(`graveyard teleport did not apply: still ${fromDeath.toFixed(1)}y from the death spot (the pre-fix freeze)`);
  if (fromGrave > 30) fail(`post-repop position ${fromGrave.toFixed(1)}y from the release loc, want <= 30y`);
  self.pos = ghostPos;
  log(`PASS[repop]: graveyard teleport applied (moved ${fromDeath.toFixed(1)}y off the death spot)`);

  // 3b. The same-map teleport is OBSERVABLE (item 46 part 1): the
  //     server's MSG_MOVE_TELEPORT_ACK reaches the stream under our own guid
  //     carrying the arrival point, the way a client is told where it landed.
  //     Before this tap the only positional fact between repop and the next
  //     move result was the reattach WB_SESSION_STATE read above — which a
  //     live agent never issues. Same-map graveyard only: a cross-map release
  //     (none in the starter zones) would be SMSG_NEW_WORLD instead.
  const tpAck = events
    .slice(mark)
    .find((e) => e.opcode === "MSG_MOVE_TELEPORT_ACK" && e.data?.guid === self.guid);
  if (!tpAck) fail("no own-guid MSG_MOVE_TELEPORT_ACK on the stream after repop (same-map teleport invisible; module predates item 46?)");
  const ackFromGrave = dist2d(tpAck.data.pos, grave);
  if (ackFromGrave > 30) fail(`MSG_MOVE_TELEPORT_ACK pos (${tpAck.data.pos.x.toFixed(1)}, ${tpAck.data.pos.y.toFixed(1)}) is ${ackFromGrave.toFixed(1)}y from the release loc, want <= 30y`);
  if (dist2d(tpAck.data.pos, ghostPos) > 5) fail(`MSG_MOVE_TELEPORT_ACK pos disagrees with the server-truth position by ${dist2d(tpAck.data.pos, ghostPos).toFixed(1)}y`);
  log(`PASS[teleport-ack]: MSG_MOVE_TELEPORT_ACK served for self at (${tpAck.data.pos.x.toFixed(1)}, ${tpAck.data.pos.y.toFixed(1)}), ${ackFromGrave.toFixed(1)}y from the release loc`);

  // 3c. A ghost knows where its corpse is (item 53): the module sends
  //     MSG_CORPSE_QUERY once after the graveyard port is acked, and the
  //     server's answer reaches the stream. The corpse is where we died.
  step = "corpse-query";
  const cq = await waitFor((e) => e.opcode === "MSG_CORPSE_QUERY", 10000, "MSG_CORPSE_QUERY after repop", mark);
  if (cq.data?.found !== true) fail(`MSG_CORPSE_QUERY answered ${JSON.stringify(cq.data)}, want found:true`);
  const corpse = { x: cq.data.x, y: cq.data.y, z: cq.data.z };
  const corpseFromDeath = dist2d(corpse, deathPos);
  if (corpseFromDeath > 5) fail(`corpse query puts the corpse ${corpseFromDeath.toFixed(1)}y from the recorded death spot, want <= 5y`);
  const queries = events.slice(mark).filter((e) => e.opcode === "MSG_CORPSE_QUERY").length;
  if (queries !== 1) fail(`${queries} MSG_CORPSE_QUERY answers after one repop, want exactly 1 (the latch)`);
  log(`PASS[corpse-query]: corpse at (${corpse.x.toFixed(1)}, ${corpse.y.toFixed(1)}) map ${cq.data.map}/${cq.data.corpseMap}, ${corpseFromDeath.toFixed(1)}y from the death spot`);

  // 3d. Reclaim from the graveyard: the too_far case. The core drops a reclaim
  //     further than CORPSE_RECLAIM_RADIUS (39y) without answering, so the
  //     observable is an absence — no release-clear, health still 1 — and the
  //     distance the SDK's verdict reports is this one.
  step = "too-far";
  const ghostFromCorpse = dist2d(ghostPos, corpse);
  if (ghostFromCorpse <= 39) fail(`graveyard is only ${ghostFromCorpse.toFixed(1)}y from the corpse; the too_far case cannot be probed here`);
  const tooFarMark = events.length;
  await action("reclaim_corpse");
  await Bun.sleep(3000);
  const cleared = events.slice(tooFarMark).some((e) => e.opcode === "SMSG_DEATH_RELEASE_LOC" && e.data?.map === -1);
  if (cleared || self.health > 1) fail(`a reclaim from ${ghostFromCorpse.toFixed(1)}y away resurrected (health ${self.health}); the 39y radius is not what the SDK assumes`);
  log(`PASS[too-far]: reclaim from the graveyard (${ghostFromCorpse.toFixed(0)}y > 39y) silently refused, still a ghost`);

  // 4. Ghost-run back to the corpse. Movement while dead+ghost is the IsAlive
  //    guard fix; tryMoveTo chains midpoint hops if a leg exceeds the 250y cap.
  step = "ghost-run";
  const runStatus = await tryMoveTo(deathPos, "corpse run");
  if (runStatus !== "arrived") fail(`ghost corpse run ended ${runStatus}, want arrived`);
  const atCorpse = dist2d(self.pos, deathPos);
  if (atCorpse > 30) fail(`corpse run arrived ${atCorpse.toFixed(1)}y from the corpse, outside the 39y reclaim radius`);
  log(`PASS[ghost-run]: moved ${fromDeath.toFixed(1)}y as a ghost, now ${atCorpse.toFixed(1)}y from the corpse`);

  // 5. Reclaim the corpse. The server enforces a 30s delay from death and a
  //    rejected reclaim is SILENT, so wait the delay out and verify by health.
  step = "reclaim";
  const delayLeft = deathAt + 31000 - Date.now();
  if (delayLeft > 0) {
    log(`waiting ${(delayLeft / 1000).toFixed(0)}s for the corpse reclaim delay`);
    await Bun.sleep(delayLeft);
  }
  const reclaimEnd = Date.now() + 60000;
  while (self.health <= 1 && Date.now() < reclaimEnd) {
    await action("reclaim_corpse");
    await Bun.sleep(3000);
  }
  if (self.health <= 1) fail(`reclaim never resurrected: health ${self.health}/${self.maxHealth} after 60s of attempts`);
  log(`PASS[reclaim]: resurrected at ${self.health}/${self.maxHealth} hp`);

  // 6. Logout + delete the probe character.
  step = "cleanup";
  const del = await req("DELETE", "/session", { token: TOKEN });
  if (del.status !== 200) fail(`session delete failed: ${JSON.stringify(del.json)}`);
  let deleted: any = null;
  for (let attempt = 0; attempt < 5 && !deleted?.json?.deleted; ++attempt) {
    await Bun.sleep(2000);
    deleted = await req("POST", "/character-delete", { token: `${TOKEN}-del${attempt}`, account: ACCOUNT, character: CHARACTER });
  }
  if (!deleted?.json?.deleted) fail("character-delete never succeeded");
  cleanupStarted = true; // done for real; fail() must not re-run it
  log(`PASS[cleanup]: character ${CHARACTER} deleted`);

  ws.close();

  const secs = (Date.now() - startedAt) / 1000;
  log(`stats: ${events.length} events in ${secs.toFixed(1)}s`);
  log("PASS: death -> repop teleport applied -> corpse query -> too-far refused -> ghost corpse run -> reclaim resurrected -> cleanup");
  process.exit(0); // open WebSockets would otherwise hold the event loop
}

main().catch((e) => fail(String(e?.stack ?? e)));
