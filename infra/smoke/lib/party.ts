/**
 * What the party smokes share: the staged party's members, a login per
 * member, the assertions that a member is what the stager says it staged,
 * a walk longer than one move, and the cleanup.
 *
 * Operator tooling: the smokes and the stager live in infra/, never in the
 * agent's reach.
 */

import { connect, type MoveResult, type WrathClient } from "@wrathbench/sdk";
import { LOADOUT_IDS, PARTY_MONEY, loadoutAt, loadoutFor, partySpot, type Loadout } from "../../fixtures/loadouts";
import { DEFAULT_PARTY_ACCOUNTS, DEFAULT_PARTY_SCENARIO, defaultStageRequest, type StageRequest } from "../../fixtures/stage-party";
import {
  DEADMINES_ENTRANCE_TRIGGER,
  SCENARIOS,
  SHADOWFANG_ENTRANCE_TRIGGER,
  STOCKADE_ENTRANCE_TRIGGER,
  type Position,
  type Scenario,
  type ScenarioName,
} from "../../fixtures/scenarios";
import { smokeToken } from "./session";
import { dist2d, fmt } from "./geo";

export type PartyMember = { member: string; account: string; character: string; loadout: Loadout; level: number; spot: Position };

type Point = { x: number; y: number; z: number };

/**
 * A dungeon a party can be staged outside of, for the party smokes: the
 * scenario its party stands in, the level it is staged at (the one its probe
 * campaign states), the entrance trigger each member makes its one move of,
 * the instance map that lands it on, and the exit trigger inside, which an
 * AreaTrigger.dbc record on that map sends back to map 0. Smoke data only:
 * nothing here is on a scenario object, which the staging hash covers.
 */
export type PartyDungeon = { scenario: ScenarioName; level: number; entrance: Point & { id: number }; instanceMap: number; exit: Point & { id: number } };

export const PARTY_DUNGEONS: Readonly<Record<string, PartyDungeon>> = {
  // The Deadmines (map 36): exit trigger 119.
  "moonbrook-mine": { scenario: "moonbrook-mine", level: 20, entrance: DEADMINES_ENTRANCE_TRIGGER, instanceMap: 36, exit: { id: 119, x: -14.4, y: -393.4, z: 64.6 } },
  // Shadowfang Keep (map 33): exit trigger 194, 5.3y from where the entrance lands.
  "silverpine-keep": { scenario: "silverpine-keep", level: 20, entrance: SHADOWFANG_ENTRANCE_TRIGGER, instanceMap: 33, exit: { id: 194, x: -230.95, y: 2105.06, z: 79.75 } },
  // The Stockade (map 34): exit trigger 503, 15y from where the entrance lands.
  "stormwind-stockade": { scenario: "stormwind-stockade", level: 24, entrance: STOCKADE_ENTRANCE_TRIGGER, instanceMap: 34, exit: { id: 503, x: 39.37, y: 0.8, z: -12.79 } },
};

/** The dungeon a party smoke is pointed at (`--scenario <name>`), the Deadmines' when none is named. */
export function partyDungeon(name: string = DEFAULT_PARTY_SCENARIO): PartyDungeon {
  const d = PARTY_DUNGEONS[name];
  if (!d) throw new Error(`no party dungeon for scenario '${name}'; the party smokes know ${Object.keys(PARTY_DUNGEONS).join(", ")}`);
  return d;
}

/**
 * The smokes' party: the stager's default request (PARTY1..PARTY5, one of
 * each loadout, the tank first and leading), or MODULE_PARTY_ACCOUNTS
 * (comma-separated) in that order, on the Deadmines' scenario at 20 or the
 * given dungeon's scenario and level. The request is what the roster would
 * send, so the smokes exercise the contract the fleet uses.
 */
export function smokeRequest(tag: string, env: Record<string, string | undefined> = process.env, dungeon: PartyDungeon = partyDungeon()): StageRequest {
  const accounts = (env["MODULE_PARTY_ACCOUNTS"] ?? DEFAULT_PARTY_ACCOUNTS.join(",")).split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
  if (accounts.length !== LOADOUT_IDS.length) throw new Error(`MODULE_PARTY_ACCOUNTS names ${accounts.length} accounts; a party is ${LOADOUT_IDS.length}`);
  return defaultStageRequest({ party: `smoke-${tag}`, campaign: `smoke-${tag}`, accounts, scenario: dungeon.scenario, level: dungeon.level });
}

/** The members of a request, with their loadouts at its level and their spots in its scenario; the first leads. */
export function membersOf(req: StageRequest): PartyMember[] {
  const scenario = (SCENARIOS as Record<string, Scenario>)[req.scenario];
  if (!scenario) throw new Error(`unknown scenario '${req.scenario}'`);
  return req.members.map((m, i) => {
    const l = loadoutFor(m);
    if (typeof l === "string") throw new Error(l);
    return { member: m.member, account: m.account, character: m.character, loadout: loadoutAt(l, req.level), level: req.level, spot: partySpot(scenario, i) };
  });
}

/** A member's part of a session name: its account, as `inspect audit --smoke <smoke>-<account>` takes it. */
const accountRole = (m: PartyMember): string => m.account.toLowerCase().replace(/[^a-z0-9]+/g, "");

/** Log one member in on its own client, under the smoke `tag`'s session name for its account. */
export async function loginMember(base: string, secret: string | undefined, m: PartyMember, tag: string): Promise<WrathClient> {
  const c = await connect({ baseUrl: base, token: smokeToken(tag, { role: accountRole(m) }), secret, account: m.account });
  await c.createSession({ account: m.account, character: m.character });
  return c;
}

async function until<T>(what: string, ms: number, read: () => T | undefined): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = read();
    if (v !== undefined) return v;
    if (Date.now() > deadline) throw new Error(`${what}: not observed within ${Math.round(ms / 1000)}s`);
    await Bun.sleep(250);
  }
}

/**
 * The staging smoke's assertions for one logged-in member, each read off the
 * state cache the way a run's own client sees it at login: level, position,
 * the loadout's items in their equipment slots, the role's key spells, the
 * preset talents in SMSG_TALENTS_INFO, the money, the supplies in the bags,
 * and the group listing the other members with the first one leading.
 */
export async function assertStagedMember(c: WrathClient, m: PartyMember, party: readonly PartyMember[], log: (s: string) => void): Promise<void> {
  const l = m.loadout;
  const who = `${m.character} (${l.label})`;
  const level = await until(`${who} level`, 15_000, () => c.state.self.level?.value);
  if (level !== m.level) throw new Error(`${who} is level ${level}, expected ${m.level}`);

  const pos = await until(`${who} position`, 15_000, () => c.state.self.position?.value);
  const spot = m.spot;
  if (pos.map !== spot.map || dist2d(pos, spot) > 3) throw new Error(`${who} stands on map ${pos.map} at ${fmt(pos)}, expected its staging spot ${fmt(spot)} on map ${spot.map} within 3y`);

  const equipped = new Map<number, number>();
  await until(`${who} equipment`, 15_000, () => {
    equipped.clear();
    for (const it of c.state.inventory) if (it.slot < 19 && it.itemId !== undefined) equipped.set(it.slot, it.itemId);
    return l.gear.every((g) => equipped.get(g.slot) === g.item) ? true : undefined;
  }).catch(() => {
    const wrong = l.gear.filter((g) => equipped.get(g.slot) !== g.item).map((g) => `${g.name} (${g.item}) in ${g.slot}: found ${equipped.get(g.slot) ?? "nothing"}`);
    throw new Error(`${who} does not wear the loadout: ${wrong.join("; ")}`);
  });

  const known = new Set(c.state.spells().map((s) => s.spellId));
  const missingSpells = l.keySpells.filter((s) => !known.has(s));
  if (missingSpells.length) throw new Error(`${who} lacks key spells ${missingSpells.join(", ")} (knows ${known.size})`);

  const talents = await until(`${who} SMSG_TALENTS_INFO`, 15_000, () => c.state.talents());
  const ranks = new Map(talents.talents.map((t) => [t.talentId, t.rank + 1]));
  const wrongTalents = l.talents.filter((t) => ranks.get(t.talentId) !== t.rank).map((t) => `${t.name} ${ranks.get(t.talentId) ?? 0}/${t.rank}`);
  if (wrongTalents.length) throw new Error(`${who} talents differ from the preset: ${wrongTalents.join(", ")}`);
  if (talents.unspentPoints !== 0) throw new Error(`${who} has ${talents.unspentPoints} unspent talent points; the preset spends all ${l.talents.reduce((n, t) => n + t.rank, 0)}`);

  const money = await until(`${who} money`, 15_000, () => c.state.money?.value);
  if (money !== PARTY_MONEY) throw new Error(`${who} has ${money} copper, expected ${PARTY_MONEY}`);

  const bag = c.state.bag();
  const counts = new Map<number, number>();
  for (const it of bag.items) if (it.itemId !== undefined) counts.set(it.itemId, (counts.get(it.itemId) ?? 0) + (it.count ?? 1));
  const shortSupplies = l.supplies.filter((s) => (counts.get(s.item) ?? 0) < s.count).map((s) => `${s.name} ${counts.get(s.item) ?? 0}/${s.count}`);
  if (shortSupplies.length) throw new Error(`${who} is short of supplies: ${shortSupplies.join(", ")}`);
  if (bag.bags.length < l.bags.length) throw new Error(`${who} wears ${bag.bags.length} bags, expected at least ${l.bags.length}`);

  if (party.length > 1) {
    const leader = party[0]!;
    const others = party.filter((p) => p !== m).map((p) => p.character);
    const g = await until(`${who} SMSG_GROUP_LIST at login`, 15_000, () => {
      const s = c.state.group();
      return s?.inGroup && others.every((n) => s.members.some((x) => x.name === n)) ? s : undefined;
    }).catch(() => {
      throw new Error(`${who}'s group at login is ${JSON.stringify(c.state.group() ?? null)}, expected ${others.join(", ")}`);
    });
    if (m === leader ? !g.leader : g.leaderName !== leader.character) throw new Error(`${who} sees leader ${g.leaderName} (self leader ${g.leader}), expected ${leader.character}`);
  }
  log(`  PASS ${who}: level ${level} at ${fmt(pos)}, ${l.gear.length} items worn, ${l.keySpells.length} key spells, ${l.talents.length} talents, ${money}c, supplies, group`);
}

/**
 * Walk to a point more than one move away (moves reach 250y): legs of at
 * most 200y along the straight line, each target that is not ground swapped
 * for the walkable point the module names, until the target is reached or
 * a portal takes the walker. Returns the final result: `arrived` there, or
 * `transferred`. For open ground: underground, a straight-line leg can end
 * over the tunnel it is meant to reach, and the nearest walkable point can be
 * an island no route reaches; a move of the target itself is the module's to
 * plan (wrath-mcp/module/PROTOCOL.md, `arrived` and `path_incomplete`).
 */
export async function walkTo(c: WrathClient, target: { x: number; y: number; z: number }, log: (s: string) => void, maxLegs = 6): Promise<MoveResult> {
  let last: MoveResult | undefined;
  for (let leg = 0; leg < maxLegs; leg++) {
    const here = c.state.self.position?.value;
    if (!here) throw new Error("no position to walk from");
    const d = dist2d(here, target);
    const f = 200 / d;
    const step = d <= 200 ? target : { x: here.x + (target.x - here.x) * f, y: here.y + (target.y - here.y) * f, z: here.z + (target.z - here.z) * f };
    let r = await c.moveTo(step, { timeout: 120_000 });
    if (!r.ok && r.status === "target_off_mesh" && r.nearest) {
      log(`    ${fmt(step)} is not ground; the nearest walkable point is ${fmt(r.nearest)}`);
      r = await c.moveTo(r.nearest, { timeout: 120_000 });
    }
    log(`    leg ${leg + 1}: ${fmt(here)} -> ${fmt(step)}: ${r.status}${r.ok && r.status === "transferred" ? ` to map ${r.to.map}` : ""}`);
    last = r;
    if (r.ok && r.status === "transferred") return r;
    if (!(r.ok && r.status === "arrived")) return r;
    if (step === target) return r;
  }
  return last!;
}

/** Delete the members' characters through the module, failures logged, never thrown (a `finally`). */
export async function deleteMembers(base: string, secret: string | undefined, party: readonly PartyMember[], tag: string, log: (s: string) => void): Promise<void> {
  for (const m of party) {
    const c = await connect({ baseUrl: base, token: smokeToken(tag, { role: `del-${accountRole(m)}` }), secret, account: m.account, subscribeEvents: false });
    try {
      await c.deleteCharacter(m.character, { account: m.account });
      log(`  deleted ${m.character} on ${m.account}`);
    } catch (e) {
      log(`  delete ${m.character} on ${m.account} failed: ${String(e instanceof Error ? e.message : e)}`);
    } finally {
      c.close();
    }
  }
}
