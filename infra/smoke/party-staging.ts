/**
 * Probe for party staging (docs/proposals/GROUP-PLAY.md §3): stage the five
 * members on PARTY1..PARTY5 through `stageParty` (the module, the fixture
 * SQL and STAGER's SOAP `.additem`), then log each one in through the SDK
 * the way its run will and check, from what the client is sent at login:
 *
 *   - level 20, standing in Moonbrook within 8y of the scenario's spot;
 *   - every loadout item in its equipment slot (`slot < 19`), the bags worn,
 *     the supplies in them;
 *   - the role's key spells in the spellbook;
 *   - the preset talents, rank for rank, in SMSG_TALENTS_INFO, no point unspent;
 *   - the money;
 *   - the group at login (SMSG_GROUP_LIST): the other four, the tank leading.
 *
 * Then it deletes the five through the module.
 *
 * The reaping half — that nothing staged is deleted by the next worldserver
 * boot's one-time DELETEs above its item-guid watermark — cannot be shown
 * without a boot, so it is shown once, in the release window that enables
 * SOAP, across the recreate that window does anyway:
 *
 *   bun wb smoke party-staging --keep       # before the recreate: stage, check, leave staged
 *   ...the window recreates the worldserver...
 *   bun wb smoke party-staging --recheck    # after: the same checks on what survived, then delete
 *
 * From then on the construction is the proof (stage-party.ts says why).
 *
 * Needs the chart's staging switch on (SOAP, STAGER's password in this pod,
 * the PARTY accounts on the allowlist and in auth). MODULE_PARTY_ACCOUNTS
 * overrides the five accounts, in role order.
 */

import { MODULE_SECRET } from "./lib/auth";
import { moduleBase } from "./lib/module";
import { assertStagedMember, defaultParty, deleteMembers, loginMember } from "./lib/party";
import { stageParty } from "../fixtures/stage-party";
import type { WrathClient } from "../../sdk/src/index";

const BASE = moduleBase();
const argv = Bun.argv.slice(2);
for (const a of argv) if (a !== "--keep" && a !== "--recheck") throw new Error(`unknown argument ${a}; usage: party-staging [--keep] [--recheck]`);
const KEEP = argv.includes("--keep");
const RECHECK = argv.includes("--recheck");
const party = defaultParty();

const started = Date.now();
const log = (m: string) => console.log(`[party-staging +${((Date.now() - started) / 1000).toFixed(1).padStart(6)}s] ${m}`);

let ok = false;
const clients: WrathClient[] = [];
try {
  if (RECHECK) {
    log(`--recheck: checking the party staged before the recreate, ${party.map((m) => m.character).join(", ")}`);
  } else {
    const staged = await stageParty({ campaign: "smoke-party-staging", accounts: party.map((m) => m.account), roles: party.map((m) => m.role), log });
    if (!staged.ok) throw new Error(`staging failed at ${staged.step}${staged.member ? ` (${staged.member.character} on ${staged.member.account})` : ""}: ${staged.error}`);
    log(`staged in ${Math.round(staged.ms / 1000)}s; ${staged.leader.character} leads`);
  }

  // All five at once, as the party's runs log in.
  for (const m of party) clients.push(await loginMember(BASE, MODULE_SECRET, m, "party-staging"));
  await Bun.sleep(2000);
  for (const [i, m] of party.entries()) await assertStagedMember(clients[i]!, m, party, log);
  ok = true;
  console.log(`PASS: party-staging${RECHECK ? " --recheck (nothing staged was reaped by the boot)" : ""} (${((Date.now() - started) / 1000).toFixed(1)}s)`);
} catch (e) {
  console.log(`FAIL: ${String(e instanceof Error ? (e.stack ?? e.message) : e)}`);
  process.exitCode = 1;
} finally {
  for (const c of clients) {
    await c.logout().catch(() => {});
    c.close();
  }
  if (KEEP && ok) log("--keep: the party stays staged for --recheck after the worldserver recreate");
  else await deleteMembers(BASE, MODULE_SECRET, party, log);
}
