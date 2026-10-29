/**
 * Probe for the party frames (#286): two sessions on two accounts form a
 * party, one walks out of the other's sight range, and the one left behind
 * sees that member's party frame.
 *
 *   1. A invites B and B accepts (as the group smoke does). Both stand at the
 *      human start, in sight of each other, so the server sends no party
 *      frame yet.
 *   2. A listens for SMSG_PARTY_MEMBER_STATS from the start, since the SDK's
 *      event buffer does not keep these packets for a later wait to find.
 *      Then B walks to the Northshire vineyards, about 160y off and out of
 *      sight range. A must see B leave view (`inView` false) and get the
 *      server's delta for B with a position.
 *   3. A sends CMSG_REQUEST_PARTY_MEMBER_STATS for B over the raw allowlist,
 *      as a party frame's own refresh does. The SDK never sends it on its own.
 *      A waits for the answer before it sends, since the answer can arrive
 *      before the raw ack and is not kept in the buffer either.
 *      The answer, SMSG_PARTY_MEMBER_STATS_FULL, carries B's health and
 *      position. `group().members[i].stats` must then hold B's health, max
 *      health and position (whole yards, within 2y of where B stands), online
 *      and alive, with `inView` false.
 *
 * It FAILS against any worldserver built before the taps: no party frame is
 * whitelisted, so the waits time out. Run it only after the image is
 * deployed. It is on demand: it is in neither preflight nor the deploy smokes.
 *
 * It uses two accounts because the module holds one live session per account
 * (MODULE_ACCOUNT / MODULE_ACCOUNT2, both on WrathBench.Accounts). The two
 * characters are throwaway Human Warriors at the human start. Grouping has no
 * range check.
 *
 * Run from inside the network:
 *   bun wb smoke party-frames
 *   bun wb --local smoke party-frames   # the quickstart
 */

import { connect } from "@wrathbench/sdk";
import type { StreamEvent } from "@wrathbench/sdk";
import { probeName } from "./lib/name";
import { authHeaders, MODULE_SECRET } from "./lib/auth";
import { moduleBase } from "./lib/module";
import { dist2d, fmt } from "./lib/party";
import { smokeToken } from "./lib/session";

const BASE = moduleBase();
const ACCOUNT_A = process.env.MODULE_ACCOUNT ?? "PROBE";
const ACCOUNT_B = process.env.MODULE_ACCOUNT2 ?? "SMOKE2";
const RUN = crypto.randomUUID();
const NAME_A = probeName("Pfa");
const NAME_B = probeName("Pfb");
/** The Northshire vineyards' edge, about 160y from the human start: past any sight range (one-quest, kill-credit walk there). */
const VINEYARDS = { x: -8790, y: -160, z: 82.5 };

const started = Date.now();
const log = (m: string) => console.log(`[party-frames +${((Date.now() - started) / 1000).toFixed(1).padStart(5)}s] ${m}`);
function fail(m: string): never {
  throw new Error(m);
}

/** Poll until `read` returns a value, or fail naming `what`. */
async function until<T>(read: () => T | undefined, what: string, timeoutMs: number): Promise<T> {
  const by = Date.now() + timeoutMs;
  for (;;) {
    const v = read();
    if (v !== undefined) return v;
    if (Date.now() > by) fail(`timed out after ${timeoutMs}ms waiting for ${what}`);
    await Bun.sleep(100);
  }
}

const health = await fetch(`${BASE}/health`, { headers: authHeaders() }).then((r) => r.json() as Promise<any>);
if (!health?.ok) fail(`health not ok: ${JSON.stringify(health)}`);
log(`health ok: build=${health.build ?? "?"}; ${NAME_A} on ${ACCOUNT_A}, ${NAME_B} on ${ACCOUNT_B}`);

const a = await connect({ baseUrl: BASE, token: smokeToken("party-frames", { role: "a", id: RUN }), secret: MODULE_SECRET });
const b = await connect({ baseUrl: BASE, token: smokeToken("party-frames", { role: "b", id: RUN }), secret: MODULE_SECRET });
try {
  await a.createSession({ account: ACCOUNT_A, character: NAME_A, race: 1, class: 1 });
  await b.createSession({ account: ACCOUNT_B, character: NAME_B, race: 1, class: 1 });
  const guidB = b.state.self.guid ?? fail("B has no guid after login");
  log(`both in world: ${NAME_A} ${a.state.self.guid}, ${NAME_B} ${guidB}`);
  await Bun.sleep(1000);

  // 1. The party.
  const invite = await a.inviteToGroup(NAME_B, { timeout: 10_000 });
  if (!invite.ok) fail(`invite refused: ${invite.hint}`);
  await b.events.waitForOpcode("SMSG_GROUP_INVITE", { timeout: 10_000 });
  const groupB = await b.acceptGroupInvite({ timeout: 10_000 });
  if (!groupB.inGroup) fail("B not inGroup after accept");
  await until(() => a.state.group()?.members.find((m) => m.guid === guidB), `${NAME_B} in ${NAME_A}'s member list`, 10_000);
  const memberB = () => a.state.group()?.members.find((m) => m.guid === guidB);
  if (memberB()?.inView !== true) fail(`${NAME_B} stands beside ${NAME_A} but inView is ${memberB()?.inView}`);
  log(`PASS party: ${NAME_A} lists ${NAME_B}, in view`);

  // 2. B walks out of sight; A hears the server's delta. The listener is on
  // before the walk because these packets are not kept in the buffer.
  const frames: StreamEvent[] = [];
  const off = a.events.on("SMSG_PARTY_MEMBER_STATS", (e) => {
    if ((e.data as { guid?: string }).guid === guidB) frames.push(e);
  });
  const walk = await b.moveTo(VINEYARDS, { timeout: 120_000 });
  log(`B moveTo ${fmt(VINEYARDS)}: ${walk.status}`);
  if (!walk.ok || walk.status !== "arrived") fail(`B could not walk out of sight: ${JSON.stringify(walk)}`);
  const there = b.state.self.position?.value ?? fail("B has no position after the walk");
  const startA = a.state.self.position?.value ?? fail("A has no position");
  log(`B stands ${dist2d(there, startA).toFixed(0)}y from A`);
  await until(() => (memberB()?.inView === false ? true : undefined), `${NAME_B} out of ${NAME_A}'s view`, 15_000);
  const withPos = await until(
    () => frames.find((e) => typeof (e.data as { x?: unknown }).x === "number"),
    `an SMSG_PARTY_MEMBER_STATS for ${NAME_B} with a position`,
    15_000,
  );
  off();
  const d = withPos.data as { mask: number; x: number; y: number; health?: number };
  log(`PASS delta: ${frames.length} SMSG_PARTY_MEMBER_STATS for ${NAME_B}, one with position (${d.x}, ${d.y}), mask 0x${d.mask.toString(16)}`);

  // 3. The frame's own refresh, raw: the full answer with health and position.
  // The wait is armed before the send: the answer can reach the socket before
  // the raw ack resolves, and a _FULL is never retained for a later wait to
  // find.
  const fullWait = a.events.waitFor(
    (e) => e.opcode === "SMSG_PARTY_MEMBER_STATS_FULL" && (e.data as { guid?: string }).guid === guidB,
    { timeout: 10_000, includeBuffered: false, description: `an SMSG_PARTY_MEMBER_STATS_FULL for ${NAME_B}` },
  );
  fullWait.catch(() => {}); // a refused send fails below; this rejection is then not the error
  const asked = await a.raw("CMSG_REQUEST_PARTY_MEMBER_STATS", [{ guid: guidB }]);
  if (!asked.ok) fail(`CMSG_REQUEST_PARTY_MEMBER_STATS refused: ${JSON.stringify(asked)}`);
  const full = await fullWait;
  const fd = full.data as { health?: number; maxHealth?: number; x?: number; y?: number; status?: number };
  if (typeof fd.health !== "number" || typeof fd.maxHealth !== "number") fail(`_FULL has no health: ${JSON.stringify(fd)}`);
  if (typeof fd.x !== "number" || typeof fd.y !== "number") fail(`_FULL has no position: ${JSON.stringify(fd)}`);
  log(`PASS full: health ${fd.health}/${fd.maxHealth}, position (${fd.x}, ${fd.y}), status 0x${(fd.status ?? 0).toString(16)}`);

  // The fold: group().members[i].stats and inView.
  const m = memberB() ?? fail(`${NAME_B} left ${NAME_A}'s member list`);
  const st = m.stats ?? fail(`${NAME_B} has no stats on ${NAME_A}'s group()`);
  if (m.inView !== false) fail(`inView is ${m.inView} with ${NAME_B} out of sight`);
  if (st.online !== true || st.dead === true || st.ghost === true) fail(`stats says online=${st.online} dead=${st.dead} ghost=${st.ghost}`);
  if (st.health !== fd.health || st.maxHealth !== fd.maxHealth) fail(`stats health ${st.health}/${st.maxHealth}, the packet said ${fd.health}/${fd.maxHealth}`);
  const ownHp = b.state.self.health?.value;
  if (ownHp !== undefined && st.maxHealth !== ownHp.max) fail(`stats maxHealth ${st.maxHealth}, ${NAME_B}'s own frame says ${ownHp.max}`);
  const pos = st.position ?? fail("stats has no position");
  const off2d = dist2d(pos, there);
  if (off2d > 2) fail(`stats position (${pos.x}, ${pos.y}) is ${off2d.toFixed(1)}y from where ${NAME_B} stands ${fmt(there)}`);
  log(`PASS fold: stats ${JSON.stringify({ online: st.online, health: st.health, maxHealth: st.maxHealth, level: st.level, zone: st.zone, position: st.position })}, inView false`);

  console.log(`PASS: party-frames (${((Date.now() - started) / 1000).toFixed(1)}s)`);
} catch (e) {
  console.log(`FAIL: ${String(e instanceof Error ? (e.stack ?? e.message) : e)}`);
  process.exitCode = 1;
} finally {
  await a.leaveGroup({ timeout: 10_000 }).catch(() => {});
  await a.logout().catch(() => {});
  await b.logout().catch(() => {});
  await a.deleteCharacter(NAME_A, { account: ACCOUNT_A }).catch((e) => log(`delete ${NAME_A} failed: ${String(e)}`));
  await b.deleteCharacter(NAME_B, { account: ACCOUNT_B }).catch((e) => log(`delete ${NAME_B} failed: ${String(e)}`));
  a.close();
  b.close();
}
