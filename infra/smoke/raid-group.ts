/**
 * Probe for raid formation: six to ten sessions on as many accounts. The
 * leader invites four and they accept (a party of five), converts the party
 * to a raid (`CMSG_GROUP_RAID_CONVERT`, raw), invites the rest, who land in
 * the second subgroup, then moves the last member into the third
 * (`CMSG_GROUP_CHANGE_SUB_GROUP`, raw). Every member's `state.group()` must
 * list the whole raid with the right leader and subgroups after each step.
 * Then everyone leaves, logs out and the throwaway characters are deleted.
 *
 * It FAILS against any worldserver whose module does not allowlist the raid
 * opcodes (the convert answers 403 opcode_not_allowed). On demand only: not a
 * suite member and not a deploy smoke — `bun wb smoke raid-group` alone.
 *
 * What it needs:
 *   - MODULE_RAID_ACCOUNTS, comma-separated, 6 to 10 accounts, the first
 *     leading. Required, with no default: a login on an account reclaims it
 *     from whatever session holds it, so the operator names accounts nothing
 *     else is using. Each must be on the module's allowlist
 *     (`worldserver.accounts`, or `staging.accounts` with staging on) AND
 *     match the fixture tool's account guard (SMOKE*, PROBE, PARTYn), and
 *     have a free character slot (PROBE usually sits at the realm's cap of
 *     ten). The long-lived world's allowlist has SMOKE, SMOKE2-4 and PROBE,
 *     five, so six needs at least one PARTYn account with staging on.
 *   - The fixture tool (infra/fixtures/apply.ts) reachable, as for every
 *     fixtured smoke: in the runner pod WRATHBENCH_DB_HOST is set. A raid
 *     converts only when every member is at or above
 *     Group.Raid.LevelRestriction (10 by default), so each throwaway Human
 *     Warrior is raised to 10 by the `talents-stormwind` scenario before it
 *     logs in. Grouping has no range check, so where it stands is moot.
 *
 * Run from inside the network:
 *   MODULE_RAID_ACCOUNTS=SMOKE,SMOKE2,SMOKE3,SMOKE4,PARTY1,PARTY2 bun wb smoke raid-group
 */

import { connect, type GroupState, type WrathClient } from "@wrathbench/sdk";
import { applyScenario, deleteFixtureCharacters, type FixtureContext } from "./lib/fixture";
import { probeName } from "./lib/name";
import { MODULE_SECRET } from "./lib/auth";
import { moduleBase, moduleHealth } from "./lib/module";
import { smokeSubToken, smokeToken } from "./lib/session";
import { fail, stampedLog } from "./lib/report";
import { sdkCreateAndLogout } from "./lib/sdk";

const BASE = moduleBase();
const RUN = crypto.randomUUID();
const TOKEN = smokeToken("raid-group", { id: RUN });
/** Level 10: Group.Raid.LevelRestriction's default, the lowest a raid converts at. */
const LEVEL_SCENARIO = "talents-stormwind";
const PARTY = 5;

const started = Date.now();
const log = stampedLog("raid-group", started);

const accounts = (process.env.MODULE_RAID_ACCOUNTS ?? "")
  .split(",")
  .map((s) => s.trim().toUpperCase())
  .filter(Boolean);
if (accounts.length < PARTY + 1 || accounts.length > 10 || new Set(accounts).size !== accounts.length) {
  fail(`MODULE_RAID_ACCOUNTS must name 6 to 10 distinct accounts (got ${JSON.stringify(accounts)}); see the header for what each needs`);
}

type Member = { account: string; character: string; client?: WrathClient };
const members: Member[] = accounts.map((account) => ({ account, character: probeName("Rg") }));
const leader = members[0]!;

const health = await moduleHealth(BASE);
if (!health?.ok) fail(`health not ok: ${JSON.stringify(health)}`);
log(`health ok: build=${health.build ?? "?"}; ${members.map((m) => `${m.character} on ${m.account}`).join(", ")}`);

const ctxOf = (m: Member, i: number): FixtureContext => ({
  base: BASE,
  account: m.account,
  character: m.character,
  token: smokeSubToken(TOKEN, `fx${i}`),
  log,
  fail,
  createAndLogout: () =>
    sdkCreateAndLogout({ base: BASE, token: smokeSubToken(TOKEN, `create${i}`), account: m.account, character: m.character, race: 1, class: 1 }),
});

/** Poll a client's group state until `ok` holds, or fail naming what it last read. */
async function untilGroup(m: Member, what: string, ok: (g: GroupState) => boolean): Promise<GroupState> {
  const deadline = Date.now() + 15_000;
  for (;;) {
    const g = m.client!.state.group();
    if (g !== undefined && ok(g)) return g;
    if (Date.now() > deadline) {
      fail(`${m.character}: ${what} not seen in 15s; group() = ${JSON.stringify(g && { inGroup: g.inGroup, raid: g.raid, subGroup: g.subGroup, leaderGuid: g.leaderGuid, members: g.members.map((x) => [x.name, x.subGroup]) })}`);
    }
    await Bun.sleep(200);
  }
}

/** Each member's subgroup as every client must see it: its own on itself, the member's on the others. */
async function expectRaid(subGroups: Map<string, number>, step: string): Promise<void> {
  const leaderGuid = leader.client!.state.self.guid;
  for (const m of members) {
    await untilGroup(m, `the raid after ${step}`, (g) => {
      if (!g.inGroup || !g.raid || g.leaderGuid !== leaderGuid) return false;
      if (g.members.length !== members.length - 1 || g.subGroup !== subGroups.get(m.character)) return false;
      return g.members.every((x) => subGroups.get(x.name) === x.subGroup);
    });
  }
  log(`PASS ${step}: all ${members.length} list the raid, ${leader.character} leading, subgroups ${JSON.stringify(Object.fromEntries(subGroups))}`);
}

async function invite(m: Member): Promise<void> {
  const r = await leader.client!.inviteToGroup(m.character, { timeout: 10_000 });
  if (!r.ok) fail(`invite of ${m.character} refused: ${r.hint}`);
  await untilGroup(m, `the invite from ${leader.character}`, (g) => g.pendingInvite?.inviterName === leader.character);
  await m.client!.acceptGroupInvite({ timeout: 10_000 });
}

try {
  // 0. Throwaway characters, raised to the raid level while logged out.
  for (const [i, m] of members.entries()) {
    const ctx = ctxOf(m, i);
    await ctx.createAndLogout();
    await applyScenario(ctx, LEVEL_SCENARIO);
  }
  for (const [i, m] of members.entries()) {
    m.client = await connect({ baseUrl: BASE, token: smokeSubToken(TOKEN, `m${i}`), secret: MODULE_SECRET });
    await m.client.createSession({ account: m.account, character: m.character, race: 1, class: 1 });
  }
  log(`all ${members.length} in world`);
  await Bun.sleep(1000);

  // 1. A party of five: the leader and the next four.
  for (const m of members.slice(1, PARTY)) await invite(m);
  await untilGroup(leader, "a party of five", (g) => g.inGroup && !g.raid && g.leader && g.members.length === PARTY - 1);
  log(`PASS party: ${leader.character} leads a party of ${PARTY}`);

  // 2. Convert to a raid: the leader's verdict is result 0, and every member's list carries the raid flag.
  const since = leader.client!.events.recent(1)[0]?.seq ?? 0;
  await leader.client!.raw("CMSG_GROUP_RAID_CONVERT", "");
  const verdict = await leader.client!.events.waitFor(
    (e) => e.seq > since && e.opcode === "SMSG_PARTY_COMMAND_RESULT",
    { timeout: 10_000 },
  );
  if ((verdict.data as { result?: number }).result !== 0) fail(`raid convert refused: ${JSON.stringify(verdict.data)}`);
  const subGroups = new Map(members.slice(0, PARTY).map((m) => [m.character, 0]));
  for (const m of members.slice(0, PARTY)) {
    await untilGroup(m, "the raid flag", (g) => g.raid && g.subGroup === 0);
  }
  log("PASS convert: the party of five is a raid, all in subgroup 0");

  // 3. The rest: past five, each lands in the first subgroup with room, the second.
  for (const m of members.slice(PARTY)) {
    await invite(m);
    subGroups.set(m.character, 1);
  }
  await expectRaid(subGroups, `inviting ${members.length - PARTY} more`);

  // 4. The raid frame's drag: the last member into the third subgroup.
  const moved = members[members.length - 1]!;
  await leader.client!.raw("CMSG_GROUP_CHANGE_SUB_GROUP", [{ cstring: moved.character }, { u8: 2 }]);
  subGroups.set(moved.character, 2);
  await expectRaid(subGroups, `moving ${moved.character} to subgroup 2`);

  console.log(`PASS: raid-group (${((Date.now() - started) / 1000).toFixed(1)}s)`);
} catch (e) {
  console.log(`FAIL: ${String(e instanceof Error ? (e.stack ?? e.message) : e)}`);
  process.exitCode = 1;
} finally {
  // Members leave before the leader, so the raid empties rather than
  // passing the lead around; then out and deleted, whatever happened.
  for (const m of [...members].reverse()) {
    if (m.client?.state.group()?.inGroup) await m.client.leaveGroup({ timeout: 10_000 }).catch((e) => log(`${m.character} leave failed: ${String(e)}`));
  }
  for (const m of members) {
    await m.client?.logout().catch(() => {});
    m.client?.close();
  }
  for (const [i, m] of members.entries()) {
    await deleteFixtureCharacters({ base: BASE, account: m.account, token: smokeSubToken(TOKEN, `del${i}`), log }, [m.character]);
  }
}
