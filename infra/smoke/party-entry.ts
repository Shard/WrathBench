/**
 * Probe for a staged party entering its dungeon together
 * (docs/proposals/GROUP-PLAY.md §4 and phase 6): the five members staged on
 * PARTY1..PARTY5 log in grouped beside the portal, each makes one move of the
 * entrance trigger and is transferred onto the instance map, and inside each
 * one sees the other four as nearby players — the proof that a grouped party
 * lands in the group's one instance (`InstanceMap::AddPlayerToMap`), not five
 * private copies. Then all five walk out through the exit trigger and are
 * deleted.
 *
 * The Deadmines by default (the mine's last tunnel, map 36); `--scenario`
 * points it at another party dungeon's staging (lib/party.ts
 * `PARTY_DUNGEONS`: `silverpine-keep`, Shadowfang Keep at 20, and
 * `stormwind-stockade`, the Stockade at 24), on demand and never in the suite.
 *
 *   bun wb smoke party-entry                                # stage first, then the entry
 *   bun wb smoke party-entry --staged                       # use the party a --keep staging left
 *   bun wb smoke party-entry --scenario stormwind-stockade  # another dungeon's party
 *
 * Needs the staging switch on, as party-staging does, and for the Deadmines a
 * world in which deadmines-entry passes.
 */

import type { WrathClient } from "@wrathbench/sdk";
import { stageParty } from "../fixtures/stage-party";
import { MODULE_SECRET } from "./lib/auth";
import { moduleBase } from "./lib/module";
import { fmt } from "./lib/geo";
import { deleteMembers, loginMember, membersOf, partySmokeArgs, smokeRequest, walkTo } from "./lib/party";
import { stampedLog } from "./lib/report";

const BASE = moduleBase();
const args = partySmokeArgs("party-entry", Bun.argv.slice(2), ["--staged", "--keep"]);
const STAGED = args.switches.has("--staged");
const KEEP = args.switches.has("--keep");
const dungeon = args.dungeon;
const request = smokeRequest("party-entry", process.env, dungeon);
const party = membersOf(request);

const started = Date.now();
const log = stampedLog("party-entry", started, 6);

const clients: WrathClient[] = [];
try {
  if (!STAGED) {
    const staged = await stageParty(request, { log });
    if (!staged.ok) throw new Error(`staging failed: ${staged.reason}`);
  }
  for (const m of party) clients.push(await loginMember(BASE, MODULE_SECRET, m, "party-entry"));
  await Bun.sleep(2000);
  for (const [i, m] of party.entries()) {
    const g = clients[i]!.state.group();
    if (!g?.inGroup || g.members.length < party.length - 1) throw new Error(`${m.character} logs in outside the party: ${JSON.stringify(g ?? null)}`);
  }
  log(`all ${party.length} beside the portal (${dungeon.scenario}, level ${dungeon.level}), grouped`);

  // In together: every member moves at once, each its own client, with the
  // one plain move of the trigger's centre an agent would make from its
  // staging spot (deadmines-entry says what the module does with it).
  const { id, x, y, z } = dungeon.entrance;
  const inbound = await Promise.all(
    party.map(async (m, i) => {
      const r = await clients[i]!.moveTo({ x, y, z });
      log(`  ${m.character}: one move to trigger ${id}'s centre: ${r.status}`);
      if (!(r.ok && r.status === "transferred" && r.to.map === dungeon.instanceMap)) {
        throw new Error(`${m.character}'s walk to the portal ended ${r.status}${r.ok && r.status === "transferred" ? ` onto map ${r.to.map}` : ""}`);
      }
      return r.to;
    }),
  );
  log(`PASS entry: all ${party.length} transferred onto map ${dungeon.instanceMap} (${inbound.map((p) => fmt(p)).join(", ")})`);
  // What each agent reads: its map, named, a party dungeon (the transfer's
  // WB_AREA, sent though zone and area stay those outside across the portal).
  await Bun.sleep(1500);
  for (const [i, m] of party.entries()) {
    const map = clients[i]!.state.self.map?.value;
    if (map?.id !== dungeon.instanceMap || map.instanceType !== (dungeon.raid ? "raid" : "party")) {
      throw new Error(`${m.character}'s state.self.map inside is ${JSON.stringify(map ?? null)}, expected map ${dungeon.instanceMap}, a ${dungeon.raid ? "raid" : "party dungeon"}`);
    }
  }

  // The same instance: each sees the other four.
  const deadline = Date.now() + 20_000;
  const missing = () =>
    party.flatMap((m, i) => {
      const seen = new Set(clients[i]!.state.units({ type: "player" }).map((u) => u.name));
      return party.filter((o) => o !== m && !seen.has(o.character)).map((o) => `${m.character} cannot see ${o.character}`);
    });
  while (missing().length && Date.now() < deadline) await Bun.sleep(500);
  if (missing().length) throw new Error(`not one instance: ${missing().join("; ")}`);
  log(`PASS same instance: every member sees the other ${party.length - 1} inside`);

  // Out again, together, through the exit trigger.
  await Promise.all(
    party.map(async (m, i) => {
      const r = await walkTo(clients[i]!, dungeon.exit, (s) => log(`  ${m.character}:${s}`));
      if (!(r.ok && r.status === "transferred" && r.to.map === dungeon.entrance.map)) throw new Error(`${m.character}'s walk out ended ${r.status}`);
    }),
  );
  log(`PASS exit: all ${party.length} back on map ${dungeon.entrance.map}`);
  console.log(`PASS: party-entry (${((Date.now() - started) / 1000).toFixed(1)}s)`);
} catch (e) {
  console.log(`FAIL: ${String(e instanceof Error ? (e.stack ?? e.message) : e)}`);
  process.exitCode = 1;
} finally {
  for (const c of clients) {
    await c.logout().catch(() => {});
    c.close();
  }
  if (KEEP) log("--keep: the party is left staged");
  else await deleteMembers(BASE, MODULE_SECRET, party, "party-entry", log);
}
