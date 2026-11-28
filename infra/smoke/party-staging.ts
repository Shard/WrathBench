/**
 * Probe for party staging (docs/proposals/GROUP-PLAY.md §3): stage the five
 * members on PARTY1..PARTY5 through `stageParty` (the module, the fixture
 * SQL and STAGER's SOAP `.additem`), then log each one in through the SDK
 * the way its run will and check, from what the client is sent at login:
 *
 *   - the scenario's level, standing within 3y of its own spot of the
 *     scenario;
 *   - every loadout item in its equipment slot (`slot < 19`), the bags worn,
 *     the supplies in them;
 *   - the role's key spells at that level in the spellbook;
 *   - the preset talents at that level, rank for rank, in SMSG_TALENTS_INFO,
 *     no point unspent;
 *   - the money;
 *   - the group at login (SMSG_GROUP_LIST): the other four, the tank leading.
 *
 * The Deadmines' party by default (`moonbrook-mine`, level 20); `--scenario`
 * stages and checks another party dungeon's (lib/party.ts `PARTY_DUNGEONS`:
 * `silverpine-keep` at 20, `stormwind-stockade` at 24, the level its probe
 * campaign's `start.level` states, with the loadouts' `LEVEL_EXTENSIONS`
 * applied), on demand and never in the suite.
 *
 *   bun wb smoke party-staging                                # the Deadmines' party at 20
 *   bun wb smoke party-staging --scenario stormwind-stockade  # the Stockade's at 24
 *
 * Then it deletes the five through the module.
 *
 * The reaping half — that nothing staged is deleted by the next worldserver
 * boot's one-time DELETEs above its item-guid watermark — cannot be shown
 * without a boot, so it is shown once. The boot cannot be the recreate of
 * the window that enables SOAP, since nothing can be staged before SOAP
 * exists. It is the next window's recreate, with the party campaign held
 * from --keep to --recheck:
 *
 *   bun wb smoke party-staging --keep       # campaign held: stage, check, leave staged
 *   ...the next worldserver recreate...
 *   bun wb smoke party-staging --recheck    # after: the same checks on what survived, then delete
 *
 * A --recheck (or party-entry's --staged) takes the same --scenario as the
 * --keep that staged the party.
 *
 * From then on the construction is the proof (stage-party.ts says why).
 *
 * Needs the chart's staging switch on (SOAP, STAGER's password in this pod,
 * the PARTY accounts on the allowlist and in auth). MODULE_PARTY_ACCOUNTS
 * overrides the five accounts, in role order.
 */

import { MODULE_SECRET } from "./lib/auth";
import { moduleBase } from "./lib/module";
import { assertStagedMember, deleteMembers, loginMember, membersOf, partyDungeon, smokeRequest } from "./lib/party";
import { stageParty } from "../fixtures/stage-party";
import type { WrathClient } from "@wrathbench/sdk";
import { stampedLog } from "./lib/report";

const BASE = moduleBase();
const USAGE = "usage: party-staging [--keep] [--recheck] [--scenario <name>]";
const argv = Bun.argv.slice(2);
let scenarioArg: string | undefined;
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]!;
  if (a === "--scenario") {
    scenarioArg = argv[++i];
    if (!scenarioArg) throw new Error(`--scenario needs a name; ${USAGE}`);
  } else if (a !== "--keep" && a !== "--recheck") throw new Error(`unknown argument ${a}; ${USAGE}`);
}
const KEEP = argv.includes("--keep");
const RECHECK = argv.includes("--recheck");
const dungeon = partyDungeon(scenarioArg);
const request = smokeRequest("party-staging", process.env, dungeon);
const party = membersOf(request);

const started = Date.now();
const log = stampedLog("party-staging", started, 6);

let ok = false;
const clients: WrathClient[] = [];
try {
  if (RECHECK) {
    log(`--recheck: checking the party staged before the recreate (${dungeon.scenario}, level ${dungeon.level}), ${party.map((m) => m.character).join(", ")}`);
  } else {
    const staged = await stageParty(request, { log });
    if (!staged.ok) throw new Error(`staging failed: ${staged.reason}`);
    log(staged.detail);
  }

  // All five at once, as the party's runs log in.
  for (const m of party) clients.push(await loginMember(BASE, MODULE_SECRET, m, "party-staging"));
  await Bun.sleep(2000);
  for (const [i, m] of party.entries()) await assertStagedMember(clients[i]!, m, party, log);
  ok = true;
  console.log(`PASS: party-staging${scenarioArg ? ` --scenario ${dungeon.scenario} (level ${dungeon.level})` : ""}${RECHECK ? " --recheck (nothing staged was reaped by the boot)" : ""} (${((Date.now() - started) / 1000).toFixed(1)}s)`);
} catch (e) {
  console.log(`FAIL: ${String(e instanceof Error ? (e.stack ?? e.message) : e)}`);
  process.exitCode = 1;
} finally {
  for (const c of clients) {
    await c.logout().catch(() => {});
    c.close();
  }
  if (KEEP && ok) log("--keep: the party stays staged for --recheck after the worldserver recreate");
  else await deleteMembers(BASE, MODULE_SECRET, party, "party-staging", log);
}
