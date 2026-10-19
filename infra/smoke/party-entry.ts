/**
 * Probe for a staged party entering the Deadmines together
 * (docs/proposals/GROUP-PLAY.md §4 and phase 6): the five members staged on
 * PARTY1..PARTY5 log in grouped in Moonbrook, each walks down the mine to
 * the portal and is transferred onto map 36, and inside each one sees the
 * other four as nearby players — the proof that a grouped party lands in
 * the group's one instance (`InstanceMap::AddPlayerToMap`), not five private
 * copies. Then all five walk out through the exit trigger and are deleted.
 *
 *   bun wb smoke party-entry            # stage first, then the entry
 *   bun wb smoke party-entry --staged   # use the party a --keep staging left
 *
 * Needs the staging switch on, as party-staging does, and a world in which
 * deadmines-entry passes.
 */

import type { WrathClient } from "../../sdk/src/index";
import { DEADMINES_ENTRANCE_TRIGGER } from "../fixtures/scenarios";
import { stageParty } from "../fixtures/stage-party";
import { MODULE_SECRET } from "./lib/auth";
import { moduleBase } from "./lib/module";
import { defaultParty, deleteMembers, fmt, loginMember, walkTo } from "./lib/party";

const BASE = moduleBase();
const argv = Bun.argv.slice(2);
for (const a of argv) if (a !== "--staged" && a !== "--keep") throw new Error(`unknown argument ${a}; usage: party-entry [--staged] [--keep]`);
const STAGED = argv.includes("--staged");
const KEEP = argv.includes("--keep");
const party = defaultParty();
const DEADMINES_MAP = 36;
const EXIT_TRIGGER = { x: -14.4, y: -393.4, z: 64.6 };

const started = Date.now();
const log = (m: string) => console.log(`[party-entry +${((Date.now() - started) / 1000).toFixed(1).padStart(6)}s] ${m}`);

const clients: WrathClient[] = [];
try {
  if (!STAGED) {
    const staged = await stageParty({ campaign: "smoke-party-entry", accounts: party.map((m) => m.account), roles: party.map((m) => m.role), log });
    if (!staged.ok) throw new Error(`staging failed at ${staged.step}${staged.member ? ` (${staged.member.character})` : ""}: ${staged.error}`);
  }
  for (const m of party) clients.push(await loginMember(BASE, MODULE_SECRET, m, "party-entry"));
  await Bun.sleep(2000);
  for (const [i, m] of party.entries()) {
    const g = clients[i]!.state.group();
    if (!g?.inGroup || g.members.length < party.length - 1) throw new Error(`${m.character} logs in outside the party: ${JSON.stringify(g ?? null)}`);
  }
  log(`all ${party.length} in Moonbrook, grouped`);

  // In together: every member walks the mine at once, each its own client.
  const inbound = await Promise.all(
    party.map(async (m, i) => {
      const r = await walkTo(clients[i]!, DEADMINES_ENTRANCE_TRIGGER, (s) => log(`  ${m.character}:${s}`));
      if (!(r.ok && r.status === "transferred" && r.to.map === DEADMINES_MAP)) {
        throw new Error(`${m.character}'s walk to the portal ended ${r.status}${r.ok && r.status === "transferred" ? ` onto map ${r.to.map}` : ""}`);
      }
      return r.to;
    }),
  );
  log(`PASS entry: all ${party.length} transferred onto map ${DEADMINES_MAP} (${inbound.map((p) => fmt(p)).join(", ")})`);

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

  // Out again, together.
  await Promise.all(
    party.map(async (m, i) => {
      const r = await walkTo(clients[i]!, EXIT_TRIGGER, (s) => log(`  ${m.character}:${s}`));
      if (!(r.ok && r.status === "transferred" && r.to.map === 0)) throw new Error(`${m.character}'s walk out ended ${r.status}`);
    }),
  );
  log(`PASS exit: all ${party.length} back on map 0`);
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
  else await deleteMembers(BASE, MODULE_SECRET, party, log);
}
