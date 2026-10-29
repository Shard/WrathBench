/**
 * Probe for the reattach replay (wrath-mcp/module/PROTOCOL.md, "/events"): a WebSocket
 * that subscribes with `replay=1` to a token whose character is already in
 * world gets a `WB_SESSION_STATE` saying `replay: true`, then what a
 * connected client holds — the character's own create block with every item,
 * its auras, the login packets, a create block for everything in view —
 * closed by `WB_REPLAY_DONE`, on that socket alone, one burst per session
 * per interval. It is the path a sandbox restart and a resumed run recover
 * through, so it is verified live: a second SDK client, with an empty cache,
 * must read the same character the first one did.
 *
 * Arc, on the PROBE account with a fresh Human Warrior in Northshire:
 *   1. client A logs in, waits for the login's create blocks and a few units
 *      in view, and snapshots own state, inventory, spellbook, skills,
 *      reputations, achievements, bind point, quest log and the view;
 *   2. A's socket is closed without a logout — what a killed sandbox child
 *      leaves behind — a plain socket P subscribes (no flag), and client B, a
 *      fresh cache, subscribes asking for the replay: it must arrive on B, on
 *      the same session (seq continues), with no destroy in it, and B's
 *      snapshot must match A's; P must get its plain state frame and none of
 *      the burst (the burst's seqs read as one gap on P);
 *   3. B sends a party line, which needs its own race from the replayed block;
 *   4. B's same-token createSession answers in world with a state frame and no
 *      second replay;
 *   5. two more askers, C1 and C2, subscribe together right after: they share
 *      one burst (the same seqs on both), sent no sooner than the interval
 *      after B's;
 *   6. logout.
 *
 * POST-DEPLOY ONLY: fails against a worldserver built before the replay (B
 * never sees WB_REPLAY_DONE). Budget: ~30s.
 *
 * Run from inside the network:
 *   bun wb smoke reattach-state
 *   bun wb --local smoke reattach-state   # the quickstart
 */

import { connect, WrathClient } from "@wrathbench/sdk";
import { authHeaders, MODULE_SECRET } from "./lib/auth";
import { moduleBase } from "./lib/module";

const BASE = moduleBase();
const ACCOUNT = process.env.MODULE_ACCOUNT ?? "PROBE";
const TOKEN = `smoke-reattach-${crypto.randomUUID()}`;
const CHARACTER = "Smokeratt";

const started = Date.now();
const log = (m: string) =>
  console.log(`[reattach-state +${((Date.now() - started) / 1000).toFixed(1).padStart(5)}s] ${m}`);
function fail(m: string): never {
  throw new Error(m);
}

async function deletePreviousCharacter(): Promise<void> {
  for (let attempt = 0; attempt < 4; ++attempt) {
    const res = await fetch(`${BASE}/character-delete`, {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders() },
      body: JSON.stringify({ token: `${TOKEN}-del${attempt}`, account: ACCOUNT, character: CHARACTER }),
    });
    const json: any = await res.json().catch(() => undefined);
    if (json?.deleted === true) return log(`deleted last run's ${CHARACTER}`);
    if (json?.error === "character_not_found") return log(`no previous ${CHARACTER}`);
    log(`character-delete attempt ${attempt}: ${res.status} ${JSON.stringify(json)}`);
    if (res.status !== 504) break;
    await Bun.sleep(2000);
  }
  fail(`could not delete last run's ${CHARACTER}`);
}

/** The fields a create block restates for an idle level-1 warrior; power is rage, 0 either way. */
const SELF_FIELDS = ["race", "class", "gender", "powerType", "level", "health", "maxHealth", "money", "xp", "nextLevelXp", "playerFlags", "unitFlags", "faction"];

/** What the two clients are compared on: values only, never seq or ts. */
function picture(client: WrathClient) {
  const s = client.state.snapshot();
  const self: Record<string, number | undefined> = {};
  for (const f of SELF_FIELDS) self[f] = s.self.fields.get(f)?.value;
  return {
    guid: s.self.guid,
    self,
    position: s.self.position?.value,
    bindPoint: s.self.bindPoint?.value,
    inventory: s.inventory.map((i) => ({ slot: i.slot, guid: i.guid, itemId: i.itemId, stackCount: i.stackCount })).sort((a, b) => a.slot - b.slot),
    spells: s.spells.map((x) => x.spellId).sort((a, b) => a - b),
    skills: s.skills.map((x) => ({ skillId: x.skillId, value: x.value, max: x.max })).sort((a, b) => a.skillId - b.skillId),
    reputation: s.reputation.map((r) => ({ repListId: r.repListId, standing: r.standing, visible: r.visible, atWar: r.atWar })),
    achievements: s.self.achievements?.entries.map((a) => a.achievementId).sort((a, b) => a - b),
    talents: s.talents === undefined ? undefined : { unspentPoints: s.talents.unspentPoints },
    questLog: s.questLog.map((q) => q.questId),
    units: new Set([...s.nearby.values()].filter((o) => o.objectType?.value !== "item" && o.objectType?.value !== "container").map((o) => o.guid)),
  };
}

function same(what: string, a: unknown, b: unknown): void {
  const ja = JSON.stringify(a);
  const jb = JSON.stringify(b);
  if (ja !== jb) fail(`${what} differs after the reattach:\n  before ${ja}\n  after  ${jb}`);
}

const health = await fetch(`${BASE}/health`, { headers: authHeaders() }).then((r) => r.json() as Promise<any>);
if (!health?.ok) fail(`health not ok: ${JSON.stringify(health)}`);
log(`health ok: build=${health.build ?? "?"}, character=${CHARACTER}`);
await deletePreviousCharacter();

const a = await connect({ baseUrl: BASE, token: TOKEN, secret: MODULE_SECRET });
let b: WrathClient | undefined;
/** Sockets opened beside A and B, closed at the end. */
const extra: WrathClient[] = [];

try {
  // 1. Client A: the login.
  await a.createSession({ account: ACCOUNT, character: CHARACTER, race: 1, class: 1 });
  log(`in world as ${CHARACTER} (Human Warrior), guid ${a.state.self.guid}`);
  {
    const deadline = Date.now() + 15_000;
    for (;;) {
      const s = a.state.snapshot();
      const units = [...s.nearby.values()].filter((o) => o.objectType?.value === "unit").length;
      if (s.inventory.length > 0 && s.spells.length > 0 && s.self.bindPoint !== undefined && s.skills.length > 0 && units >= 3) break;
      if (Date.now() > deadline) fail(`the login never filled the cache: ${JSON.stringify({ inventory: s.inventory.length, spells: s.spells.length, units })}`);
      await Bun.sleep(100);
    }
  }
  // Let the first seconds of view settle (the login's units keep arriving for a moment).
  await Bun.sleep(1_500);
  const before = picture(a);
  const lastSeqBefore = a.state.lastSeq;
  log(`A holds: ${before.inventory.length} items, ${before.spells.length} spells, ${before.skills.length} skills, ${before.reputation.length} factions, ${before.units.size} objects in view, health ${before.self["health"]}/${before.self["maxHealth"]}, ${before.self["money"]} copper, seq ${lastSeqBefore}`);

  // 2. The restart: A's socket goes, nothing is logged out, a plain socket P
  // subscribes, and B subscribes asking for the replay.
  a.close();
  await Bun.sleep(300);
  const plainSocket = new WrathClient({ baseUrl: BASE, token: TOKEN, secret: MODULE_SECRET, subscribeEvents: false });
  extra.push(plainSocket);
  await plainSocket.events.connect();
  const plainState = await plainSocket.events.waitForOpcode("WB_SESSION_STATE", { timeout: 10_000 });
  if ((plainState.data as { replay?: unknown }).replay === true) fail("a plain subscribe was answered with a replay");
  b = new WrathClient({ baseUrl: BASE, token: TOKEN, secret: MODULE_SECRET, subscribeEvents: false });
  await b.events.connect({ replay: true });
  const stateFrame = await b.events.waitForOpcode("WB_SESSION_STATE", { timeout: 10_000 });
  const stateData = stateFrame.data as { replay?: unknown; character?: unknown; guid?: unknown };
  if (stateData.replay !== true) fail(`the subscribe's WB_SESSION_STATE does not announce a replay: ${JSON.stringify(stateFrame.data)}`);
  if (stateData.character !== CHARACTER || String(stateData.guid) !== String(before.guid)) fail(`state frame names ${JSON.stringify(stateData)}, expected ${CHARACTER} ${before.guid}`);
  if (stateFrame.seq <= lastSeqBefore) fail(`seq restarted (${stateFrame.seq} after ${lastSeqBefore}): the reattach rebuilt the session instead of replaying it`);
  const done = await b.events.waitForOpcode("WB_REPLAY_DONE", { timeout: 10_000, sinceSeq: stateFrame.seq });
  const burst = b.events.recent(10_000).filter((e) => e.seq > stateFrame.seq && e.seq < done.seq);
  const destroys = burst.filter((e) => e.opcode === "SMSG_DESTROY_OBJECT");
  if (destroys.length > 0) fail(`the replay destroyed ${destroys.length} object(s): ${JSON.stringify(destroys.map((e) => e.data))}`);
  const opcodes = [...new Set(burst.map((e) => e.opcode))];
  for (const must of ["SMSG_UPDATE_OBJECT", "SMSG_INITIAL_SPELLS", "SMSG_BINDPOINTUPDATE", "SMSG_TALENTS_INFO", "SMSG_INITIALIZE_FACTIONS", "SMSG_ALL_ACHIEVEMENT_DATA", "SMSG_AURA_UPDATE_ALL"]) {
    if (!opcodes.includes(must)) fail(`the replay carried no ${must}; it carried ${opcodes.join(", ")}`);
  }
  log(`B got the replay: ${burst.length} frames (${opcodes.join(", ")}), ${(done.data as { objects: number }).objects} objects restated, seq ${stateFrame.seq}..${done.seq}`);
  // P, which did not ask, got none of it: no frame of P's carries a seq inside the burst.
  await Bun.sleep(200);
  const leaked = plainSocket.events.recent(10_000).filter((e) => e.seq >= stateFrame.seq && e.seq <= done.seq);
  if (leaked.length > 0) fail(`the replay reached a socket that did not ask: ${leaked.length} frame(s), e.g. ${leaked[0]!.opcode} #${leaked[0]!.seq}`);
  log(`PASS the plain socket saw none of the burst (${plainSocket.events.gaps} gap(s) on it, the burst's seqs)`);

  // The replay is one burst, but the creates land as one frame each on the
  // wire; give B's cache a beat before reading it.
  await Bun.sleep(200);
  const after = picture(b);
  same("own guid", before.guid, after.guid);
  same("own fields", before.self, after.self);
  same("bind point", before.bindPoint, after.bindPoint);
  same("inventory (slot, guid, item, count)", before.inventory, after.inventory);
  same("spellbook", before.spells, after.spells);
  same("skills", before.skills, after.skills);
  same("reputations", before.reputation, after.reputation);
  same("achievements", before.achievements, after.achievements);
  same("talents", before.talents, after.talents);
  same("quest log", before.questLog, after.questLog);
  if (after.position === undefined || before.position === undefined) fail("a position is unobserved");
  if (after.position.map !== before.position.map || Math.hypot(after.position.x - before.position.x, after.position.y - before.position.y) > 1) {
    fail(`position moved: ${JSON.stringify(before.position)} -> ${JSON.stringify(after.position)}`);
  }
  // The view: mobs wander, so B's set is the server's current one, which A's
  // may differ from at the edges; the bulk must be the same objects.
  const shared = [...after.units].filter((g) => before.units.has(g)).length;
  if (after.units.size === 0) fail("B sees nothing in view after the replay");
  if (shared < Math.ceil(before.units.size * 0.7)) fail(`only ${shared} of A's ${before.units.size} objects in view are in B's ${after.units.size}`);
  log(`PASS parity: fields, bind point, ${after.inventory.length} items, ${after.spells.length} spells, ${after.skills.length} skills, ${after.reputation.length} factions, ${after.achievements?.length ?? 0} achievements; ${shared}/${before.units.size} of the view shared (${after.units.size} now)`);

  // 3. A party line needs B's own race, which only the replayed create block carries.
  const said = await b.say("reattach probe", { type: "party" });
  if (!said.ok) fail(`party line refused: ${JSON.stringify(said)}`);
  log(`PASS party line sent in ${after.self["race"] === 1 ? "Common" : "the race's language"} from the replayed race`);

  // 4. A same-token createSession on the live session: in world, a state frame, no second replay.
  const sinceSeq = b.state.lastSeq + 1;
  const again = await b.createSession({ account: ACCOUNT, character: CHARACTER, race: 1, class: 1 });
  if (!again.inWorld || String(again.guid) !== String(before.guid)) fail(`same-token createSession answered ${JSON.stringify(again)}`);
  const plain = await b.events.waitForOpcode("WB_SESSION_STATE", { timeout: 10_000, sinceSeq });
  if ((plain.data as { replay?: unknown }).replay === true) fail("a same-token createSession announced a second replay");
  const second = await b.events.waitForOpcode("WB_REPLAY_DONE", { timeout: 2_000, sinceSeq }).catch(() => undefined);
  if (second !== undefined) fail(`a same-token createSession replayed again (seq ${second.seq})`);
  if (b.state.self.level?.value !== before.self["level"]) fail(`level after the repeated createSession is ${b.state.self.level?.value}, expected ${before.self["level"]}`);
  log("PASS same-token createSession: in world, the state frame alone");

  // 5. Two askers at once share one burst, no sooner than the interval after the last.
  const c1 = new WrathClient({ baseUrl: BASE, token: TOKEN, secret: MODULE_SECRET, subscribeEvents: false });
  const c2 = new WrathClient({ baseUrl: BASE, token: TOKEN, secret: MODULE_SECRET, subscribeEvents: false });
  extra.push(c1, c2);
  const askedAt = Date.now();
  await Promise.all([c1.events.connect({ replay: true }), c2.events.connect({ replay: true })]);
  const [done1, done2] = await Promise.all([
    c1.events.waitForOpcode("WB_REPLAY_DONE", { timeout: 15_000 }),
    c2.events.waitForOpcode("WB_REPLAY_DONE", { timeout: 15_000 }),
  ]);
  if (done1.seq !== done2.seq) fail(`two askers in one moment got two bursts (DONE at seq ${done1.seq} and ${done2.seq})`);
  const sinceLast = done1.ts - done.ts;
  if (sinceLast < 2_500) fail(`the second burst came ${sinceLast}ms after the first; the interval is 3000ms`);
  const c1State = c1.events.recent(10_000).find((e) => e.opcode === "WB_SESSION_STATE" && (e.data as { replay?: unknown }).replay === true);
  const c2State = c2.events.recent(10_000).find((e) => e.opcode === "WB_SESSION_STATE" && (e.data as { replay?: unknown }).replay === true);
  if (c1State === undefined || c2State === undefined || c1State.seq !== c2State.seq) fail("the shared burst's state frame differs between the two askers");
  if (c1.state.self.fields.get("race")?.value !== 1 || c2.state.self.fields.get("race")?.value !== 1) fail("a shared burst left an asker without its race");
  log(`PASS two askers shared one burst (seq ${c1State.seq}..${done1.seq}), ${sinceLast}ms after B's, ${Date.now() - askedAt}ms after asking`);

  console.log(`PASS: reattach-state (${((Date.now() - started) / 1000).toFixed(1)}s)`);
} catch (e) {
  console.log(`FAIL: ${String(e instanceof Error ? (e.stack ?? e.message) : e)}`);
  process.exitCode = 1;
} finally {
  const live = b ?? a;
  await live.logout().catch(() => {});
  live.close();
  a.close();
  for (const c of extra) c.close();
}
