/**
 * Probe for the party surface (FOLLOW-UPS 100, group): two sessions on two
 * accounts, one invites the other by name (`inviteToGroup`), the invitee sees
 * `state.group().pendingInvite` and accepts (`acceptGroupInvite`), both see
 * the party in `SMSG_GROUP_LIST` with the right leader, the leader leaves
 * (`leaveGroup`) and both are out.
 *
 * It FAILS against any worldserver built before the taps (no group reply is
 * whitelisted, so every wait times out). Run it only after the image is
 * deployed: it is one of the gates for the item 100 build.
 *
 * Two accounts because the module holds one live session per account
 * (MODULE_ACCOUNT / MODULE_ACCOUNT2, both on WrathBench.Accounts). Two
 * throwaway Human Warriors at the human start; grouping has no range check.
 *
 * Run from inside the network:
 *   docker compose -f infra/compose.yml exec runner bun infra/smoke/group.ts
 */

import { connect } from "../../sdk/src/index";
import { probeName } from "./lib/name";

const BASE = `http://${process.env.MODULE_HOST ?? "worldserver"}:${process.env.MODULE_PORT ?? "8086"}`;
const ACCOUNT_A = process.env.MODULE_ACCOUNT ?? "PROBE";
const ACCOUNT_B = process.env.MODULE_ACCOUNT2 ?? "SMOKE2";
const RUN = crypto.randomUUID();
const NAME_A = probeName("Bga");
const NAME_B = probeName("Bgb");

const started = Date.now();
const log = (m: string) => console.log(`[group +${((Date.now() - started) / 1000).toFixed(1).padStart(5)}s] ${m}`);
function fail(m: string): never {
  throw new Error(m);
}

const health = await fetch(`${BASE}/health`).then((r) => r.json() as Promise<any>);
if (!health?.ok) fail(`health not ok: ${JSON.stringify(health)}`);
log(`health ok: build=${health.build ?? "?"}; ${NAME_A} on ${ACCOUNT_A}, ${NAME_B} on ${ACCOUNT_B}`);

const a = await connect({ baseUrl: BASE, token: `smoke-group-a-${RUN}` });
const b = await connect({ baseUrl: BASE, token: `smoke-group-b-${RUN}` });
try {
  await a.createSession({ account: ACCOUNT_A, character: NAME_A, race: 1, class: 1 });
  await b.createSession({ account: ACCOUNT_B, character: NAME_B, race: 1, class: 1 });
  log(`both in world: ${NAME_A} ${a.state.self.guid}, ${NAME_B} ${b.state.self.guid}`);
  await Bun.sleep(1000);

  // 1. Invite by name; the invitee sees the dialog.
  const invite = await a.inviteToGroup(NAME_B, { timeout: 10_000 });
  log(`inviteToGroup: ${JSON.stringify(invite)}`);
  if (!invite.ok) fail(`invite refused: ${invite.hint}`);
  await b.events.waitForOpcode("SMSG_GROUP_INVITE", { timeout: 10_000 });
  const pending = b.state.group()?.pendingInvite ?? fail("B has no pendingInvite after SMSG_GROUP_INVITE");
  if (pending.inviterName !== NAME_A) fail(`invite from ${pending.inviterName}, expected ${NAME_A}`);
  log(`PASS invite: ${NAME_B} sees an invite from ${pending.inviterName}`);

  // 2. Accept; both sides list the party with A as leader.
  const groupB = await b.acceptGroupInvite({ timeout: 10_000 });
  log(`B group: ${JSON.stringify({ inGroup: groupB.inGroup, leaderName: groupB.leaderName, members: groupB.members.map((m) => m.name) })}`);
  if (!groupB.inGroup) fail("B not inGroup after accept");
  if (groupB.leaderName !== NAME_A || groupB.leader) fail(`B sees leader ${groupB.leaderName} (leader=${groupB.leader}), expected ${NAME_A}`);
  if (!groupB.members.some((m) => m.name === NAME_A && m.online)) fail(`B's member list lacks ${NAME_A} online: ${JSON.stringify(groupB.members)}`);
  await a.events.waitFor((e) => e.opcode === "SMSG_GROUP_LIST" && (e.data as any).left === false, { timeout: 10_000 });
  const groupA = a.state.group() ?? fail("A has no group state");
  if (!groupA.inGroup || !groupA.leader) fail(`A: inGroup=${groupA.inGroup} leader=${groupA.leader}`);
  if (!groupA.members.some((m) => m.name === NAME_B)) fail(`A's member list lacks ${NAME_B}: ${JSON.stringify(groupA.members)}`);
  log(`PASS accept: both list the party, ${NAME_A} leads`);

  // 3. The leader leaves a two-person group: it is disbanded for both.
  const sinceB = b.events.recent(1)[0]?.seq ?? 0;
  const leftA = await a.leaveGroup({ timeout: 10_000 });
  if (leftA.inGroup) fail("A still inGroup after leaveGroup");
  await b.events.waitFor((e) => e.seq > sinceB && (e.opcode === "SMSG_GROUP_DESTROYED" || (e.opcode === "SMSG_GROUP_LIST" && (e.data as any).left === true)), { timeout: 10_000 });
  if (b.state.group()?.inGroup !== false) fail("B still inGroup after the leader left");
  log("PASS leave: both out of the group");
  console.log(`PASS: group (${((Date.now() - started) / 1000).toFixed(1)}s)`);
} catch (e) {
  console.log(`FAIL: ${String(e instanceof Error ? (e.stack ?? e.message) : e)}`);
  process.exitCode = 1;
} finally {
  await a.logout().catch(() => {});
  await b.logout().catch(() => {});
  await a.deleteCharacter(NAME_A, { account: ACCOUNT_A }).catch((e) => log(`delete ${NAME_A} failed: ${String(e)}`));
  await b.deleteCharacter(NAME_B, { account: ACCOUNT_B }).catch((e) => log(`delete ${NAME_B} failed: ${String(e)}`));
  a.close();
  b.close();
}
