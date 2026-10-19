/**
 * Stage a party for the Deadmines eval (docs/proposals/GROUP-PLAY.md §3):
 * five fresh characters on the PARTY accounts, each put into its role's
 * loadout (level 20, trainer spells, preset talents, skills, quest-level
 * greens worn, bags, supplies), standing in Moonbrook, grouped with the tank
 * leading, and logged out.
 *
 *   bun infra/fixtures/stage-party.ts [--campaign <id>] [--accounts PARTY1,…] [--roles tank,healer,…]
 *
 * from the runner pod (with the chart's staging switch on, which hands it
 * the SOAP URL and STAGER's password). The fleet's party mode calls
 * `stageParty` in-process before a fresh party launch.
 *
 * Operator tooling: never imported by `runner/` or `sdk/`. The run, once
 * launched, sees only what its own client is sent at login.
 *
 * The steps, per member, and why each is where it is:
 *
 *   1. Every character on the account is deleted through the module (a
 *      `CMSG_CHAR_DELETE`, which also clears the core's name cache) and the
 *      member is created fresh through `POST /session`, the same utility
 *      session the fixture smokes make. While that session is open the
 *      module's talent frame for the class (Talent.dbc as the client reads
 *      it) is asked for and the role's preset checked against it: a
 *      `character_talent` row that is not a talent rank spell ASSERTs in
 *      `Player::_LoadTalents` at the next login and takes the world down.
 *   2. After the logout save, one transaction writes the scenario: level,
 *      position, homebind, quest log, the trainer's spells read from the
 *      world DB's `trainer_spell`, talents, skills, ammo (apply.ts).
 *   3. The member logs in again and STAGER's SOAP `.additem` stores the
 *      gear and two bags while it is online, so the running server's own
 *      generator allocates every item guid on the world thread and the
 *      player's own save writes the rows (route (c) of the design). The
 *      bag view is read until each line has landed: SOAP's answer alone does
 *      not say so.
 *   4. After that save, one transaction moves the gear and the bags from the
 *      backpack to their slots, swapping starter gear into the places they
 *      left (`bag`/`slot` only, never a guid).
 *   5. All members log in together: supplies go into the now-worn bags, the
 *      worn gear is checked, the tank invites the others and each accepts
 *      through the SDK — the client path, so the group's guid comes from the
 *      server's generator — and everyone logs out. A group survives its
 *      members' logout (`LeaveGroupOnLogout.Enabled` is off), so the runs log
 *      in grouped.
 *
 * Why the item guids are safe across a worldserver boot: every one was
 * handed out by the live generator and saved by the player, so the next
 * boot's `SELECT MAX(guid)` covers it and the boot's one-time DELETEs above
 * that watermark never reach it. The smoke proves that once, across the
 * recreate of the release window that turns SOAP on (party-staging.ts
 * --keep, then --recheck).
 */

import type { SQL } from "bun";
import { connect as connectModule, type WrathClient } from "../../sdk/src/index";
import { MODULE_SECRET } from "../smoke/lib/auth";
import { characterNames, type FixtureContext } from "../smoke/lib/fixture";
import { moduleBase } from "../smoke/lib/module";
import {
  OFFHAND_SLOT,
  applyStatements,
  buildEquipStatements,
  buildStatements,
  connect as connectDb,
  readCharacter,
  readInventory,
  snapshot,
  waitForNewSave,
  waitUntilOffline,
  type CharacterRow,
  type EquipTarget,
  type InventoryRow,
} from "./apply";
import {
  LEADER_ROLE,
  LOADOUTS,
  PARTY_LEVEL,
  PARTY_ROLES,
  checkTalentsAgainstFrame,
  isPartyRole,
  partyCharacterName,
  partyScenario,
  validateLoadout,
  type Loadout,
  type PartyRole,
  type StockLine,
} from "./loadouts";
import { soapFromEnv, type SoapClient } from "./soap";

/** The accounts a party may be staged on, and nothing else. */
export const PARTY_ACCOUNT_PATTERN = /^PARTY\d$/;
export const DEFAULT_PARTY_ACCOUNTS = ["PARTY1", "PARTY2", "PARTY3", "PARTY4", "PARTY5"] as const;

export type StageStep = "request" | "preflight" | "reset" | "create" | "scenario" | "gear" | "equip" | "supplies" | "verify" | "group" | "logout";

export type StagePartyRequest = {
  /** The campaign the party is for; in logs and session tokens. */
  campaign: string;
  /** The party's accounts, in member order. */
  accounts: readonly string[];
  /** One role per account, same order. */
  roles: readonly PartyRole[];
  /** Progress lines. Default: console, prefixed `[stage-party]`. */
  log?: (msg: string) => void;
  /** Overrides, for the tests and for a caller that already holds them. */
  moduleUrl?: string;
  moduleSecret?: string;
  soap?: SoapClient;
  sql?: SQL;
  /** How long one logout save may take to land. Default 90 s. */
  saveWaitMs?: number;
};

export type StagedMember = {
  /** 0-based position in the request. */
  member: number;
  role: PartyRole;
  account: string;
  character: string;
  race: number;
  class: number;
  /** The character's guid low part (`characters.guid`). */
  characterGuid: number;
  /** Item entries worn in equipment slots, by slot. */
  equipped: Record<number, number>;
  talents: number[];
  spellCount: number;
};

export type StageResult =
  | { ok: true; campaign: string; leader: { account: string; character: string }; members: StagedMember[]; ms: number }
  | { ok: false; campaign: string; step: StageStep; member?: { role: PartyRole; account: string; character: string }; error: string; ms: number };

class StageFailure extends Error {
  constructor(
    readonly step: StageStep,
    message: string,
    readonly member?: { role: PartyRole; account: string; character: string },
  ) {
    super(message);
  }
}

/** What a request must be before anything is touched. Pure. */
export function checkStageRequest(req: Pick<StagePartyRequest, "campaign" | "accounts" | "roles">): string[] {
  const errors: string[] = [];
  if (!req.campaign || !/^[\w.@-]{1,64}$/.test(req.campaign)) errors.push(`campaign '${req.campaign}' is not a campaign id`);
  if (req.accounts.length === 0 || req.accounts.length > 5) errors.push(`a party is 1..5 accounts, got ${req.accounts.length}`);
  if (req.accounts.length !== req.roles.length) errors.push(`${req.accounts.length} accounts and ${req.roles.length} roles`);
  if (new Set(req.accounts).size !== req.accounts.length) errors.push(`an account is named twice: ${req.accounts.join(",")}`);
  if (new Set(req.roles).size !== req.roles.length) errors.push(`a role is named twice: ${req.roles.join(",")}`);
  for (const a of req.accounts) if (!PARTY_ACCOUNT_PATTERN.test(a)) errors.push(`refusing to stage on '${a}': only the party accounts (PARTY1..PARTY5) are staged`);
  for (const r of req.roles) {
    if (!isPartyRole(r)) errors.push(`unknown role '${r}'; known: ${PARTY_ROLES.join(", ")}`);
    else errors.push(...validateLoadout(LOADOUTS[r]));
  }
  return errors;
}

/** Worn-bag targets: each staged bag into the first bag slot (19-22) nothing occupies. Pure. */
export function bagTargets(rows: readonly InventoryRow[], bags: readonly StockLine[]): EquipTarget[] {
  const taken = new Set(rows.filter((r) => r.bag === 0 && r.slot >= 19 && r.slot <= 22).map((r) => r.slot));
  const out: EquipTarget[] = [];
  for (const b of bags) {
    let slot = 19;
    while (taken.has(slot) && slot <= 22) slot++;
    if (slot > 22) throw new Error(`no free bag slot for ${b.name}`);
    taken.add(slot);
    out.push({ entry: b.item, slot });
  }
  return out;
}

/** Item counts by entry across a bag view. */
export function countByItem(items: readonly { itemId: number | undefined; count: number | undefined }[]): Map<number, number> {
  const out = new Map<number, number>();
  for (const it of items) if (it.itemId !== undefined) out.set(it.itemId, (out.get(it.itemId) ?? 0) + (it.count ?? 1));
  return out;
}

/** The class trainer's spells up to the party level, from the table the core loads (`ObjectMgr::LoadTrainers`). */
export async function readTrainerSpells(sql: SQL, loadout: Loadout, maxLevel = PARTY_LEVEL): Promise<number[]> {
  const world = process.env["WRATHBENCH_WORLD_DB"] ?? "acore_world";
  if (!/^\w+$/.test(world)) throw new Error(`WRATHBENCH_WORLD_DB '${world}' is not a schema name`);
  const rows = (await sql.unsafe(
    `SELECT DISTINCT ts.SpellId AS spell
     FROM ${world}.trainer_spell ts JOIN ${world}.trainer t ON t.Id = ts.TrainerId
     WHERE ts.TrainerId = ? AND t.Type = 0 AND t.Requirement = ? AND ts.ReqLevel <= ?
     ORDER BY ts.SpellId`,
    [loadout.trainerId, loadout.class, maxLevel],
  )) as { spell: number }[];
  const spells = rows.map((r) => Number(r.spell));
  // A class trainer of this id teaches dozens of spells by level 20; none
  // means the id is wrong or the world DB is not the one the core loads.
  if (spells.length < 10) throw new Error(`trainer ${loadout.trainerId} (class ${loadout.class}) lists ${spells.length} spells up to level ${maxLevel}; expected the class trainer`);
  return spells;
}

type Member = {
  index: number;
  role: PartyRole;
  account: string;
  character: string;
  loadout: Loadout;
  guid?: number;
  spells?: number[];
};

const sleep = (ms: number) => Bun.sleep(ms);

/**
 * Stage a party. Resolves with what was staged, or with the step and member
 * that failed; it does not throw for a staging failure. A failure leaves the
 * accounts' characters wherever they got to: the next staging deletes them
 * first, and nothing else reads them.
 */
export async function stageParty(req: StagePartyRequest): Promise<StageResult> {
  const t0 = Date.now();
  const log = req.log ?? ((m: string) => console.log(`[stage-party] ${m}`));
  const saveWaitMs = req.saveWaitMs ?? 90_000;
  let step: StageStep = "request";
  const clients = new Set<WrathClient>();
  let sql: SQL | undefined = req.sql;
  const ownSql = req.sql === undefined;
  try {
    const errors = checkStageRequest(req);
    if (errors.length) throw new StageFailure("request", errors.join("; "));

    step = "preflight";
    const base = (req.moduleUrl ?? moduleBase()).replace(/\/+$/, "");
    const secret = req.moduleSecret ?? MODULE_SECRET;
    if (!secret) throw new StageFailure("preflight", "no module port secret (WRATHBENCH_MODULE_SECRET); the stager opens utility sessions with it");
    const soap = req.soap ?? soapFromEnv();
    await soap.check().catch((e) => {
      throw new StageFailure("preflight", `SOAP refused STAGER before anything was touched: ${e instanceof Error ? e.message : String(e)}`);
    });
    sql ??= await connectDb();
    const members: Member[] = req.accounts.map((account, index) => {
      const role = req.roles[index]!;
      return { index, role, account, character: partyCharacterName(role, account), loadout: LOADOUTS[role] };
    });
    for (const m of members) m.spells = await readTrainerSpells(sql, m.loadout);
    log(`campaign ${req.campaign}: ${members.map((m) => `${m.character} (${m.role}, ${m.loadout.label}) on ${m.account}`).join(", ")}`);

    const token = (m: Member, phase: string) => `stage-${req.campaign.replace(/[^\w-]/g, "-")}-${m.account}-${phase}-${crypto.randomUUID()}`;
    const open = async (m: Member, phase: string): Promise<WrathClient> => {
      const c = await connectModule({ baseUrl: base, token: token(m, phase), secret, account: m.account });
      clients.add(c);
      return c;
    };
    const close = async (c: WrathClient, logout: boolean): Promise<void> => {
      if (logout) await c.logout();
      c.close();
      clients.delete(c);
    };
    const who = (m: Member) => ({ role: m.role, account: m.account, character: m.character });
    /** Each member's leg in parallel; the first failure is the result, after every leg has settled. */
    const each = async (s: StageStep, fn: (m: Member) => Promise<void>): Promise<void> => {
      step = s;
      const settled = await Promise.allSettled(members.map(fn));
      const bad = settled.findIndex((r) => r.status === "rejected");
      if (bad >= 0) {
        const reason = (settled[bad] as PromiseRejectedResult).reason;
        if (reason instanceof StageFailure) throw reason;
        throw new StageFailure(s, reason instanceof Error ? reason.message : String(reason), who(members[bad]!));
      }
    };
    /** Wait until the bag view holds `want` of each entry beyond `baseline`. */
    const waitForItems = async (c: WrathClient, baseline: Map<number, number>, lines: readonly StockLine[], what: string): Promise<void> => {
      const want = new Map<number, number>();
      for (const l of lines) want.set(l.item, (want.get(l.item) ?? baseline.get(l.item) ?? 0) + l.count);
      const deadline = Date.now() + 15_000;
      for (;;) {
        const have = countByItem(c.state.bag().items);
        const short = [...want].filter(([item, n]) => (have.get(item) ?? 0) < n);
        if (short.length === 0) return;
        if (Date.now() > deadline) {
          throw new Error(`${what}: still short after .additem: ${short.map(([item, n]) => `${item} has ${have.get(item) ?? 0}/${n}`).join(", ")} (bags full, or the store failed)`);
        }
        await sleep(250);
      }
    };

    // 1 + 2: fresh character, talent check, scenario.
    await each("reset", async (m) => {
      const ctx: FixtureContext = {
        base,
        account: m.account,
        character: m.character,
        token: token(m, "list"),
        log,
        fail: (msg) => {
          throw new StageFailure("reset", msg, who(m));
        },
        createAndLogout: async () => {},
        contendedDeadlineMs: 3 * 60_000,
        contendedRetryMs: 10_000,
      };
      const names = await characterNames(ctx);
      if (names.length) {
        const c = await connectModule({ baseUrl: base, token: token(m, "del"), secret, account: m.account, subscribeEvents: false });
        try {
          for (const name of names) await c.deleteCharacter(name, { account: m.account });
        } finally {
          c.close();
        }
        log(`  ${m.account}: deleted ${names.join(", ")}`);
      }
      const left = await characterNames(ctx);
      if (left.length) throw new StageFailure("reset", `${m.account} still holds ${left.join(", ")} after the deletes`, who(m));

      step = "create";
      const c = await open(m, "create");
      await c.createSession({ account: m.account, character: m.character, race: m.loadout.race, class: m.loadout.class });
      const frame = await c.queryTalentTree();
      const bad = checkTalentsAgainstFrame(m.loadout, frame);
      // Log out before throwing: the character exists but has no talent rows yet.
      await close(c, true);
      if (bad.length) throw new StageFailure("create", `talent preset does not match the module's frame, nothing written: ${bad.join("; ")}`, who(m));
      const row = await readCharacter(sql!, m.account, m.character);
      if (!row) throw new StageFailure("create", `${m.character} is not in the characters table after its create`, who(m));
      await waitUntilOffline(sql!, row, saveWaitMs);
      m.guid = row.guid;
      const scenario = partyScenario(m.loadout, m.spells!);
      await applyStatements(sql!, buildStatements(row.guid, scenario));
      log(`  ${m.character}: created (guid ${row.guid}) and placed: ${scenario.description}`);
    });

    // 3 + 4: gear and bags through SOAP while online, then the offline equipment move.
    const sessionAtLeast = async (since: number) => {
      const left = 1500 - (Date.now() - since);
      if (left > 0) await sleep(left); // logout_time is in seconds; see waitForNewSave
    };
    await each("gear", async (m) => {
      const before: CharacterRow = await snapshot(sql!, m.guid!);
      const c = await open(m, "gear");
      const loginAt = Date.now();
      await c.createSession({ account: m.account, character: m.character });
      await sleep(1000); // the login burst, so the bag view has its baseline
      const baseline = countByItem(c.state.bag().items);
      const lines = [...m.loadout.gear.map((g) => ({ item: g.item, name: g.name, count: 1 })), ...m.loadout.bags];
      for (const l of lines) await soap.addItem(m.character, l.item, l.count);
      await waitForItems(c, baseline, lines, `${m.character} gear`);
      await sessionAtLeast(loginAt);
      await close(c, true);
      await waitForNewSave(sql!, before, saveWaitMs);

      step = "equip";
      const rows = await readInventory(sql!, m.guid!);
      const targets: EquipTarget[] = [...m.loadout.gear.map((g) => ({ entry: g.item, slot: g.slot })), ...bagTargets(rows, m.loadout.bags)];
      const clear = m.loadout.gear.some((g) => g.twoHand) ? [OFFHAND_SLOT] : [];
      const moves = buildEquipStatements(m.guid!, rows, targets, clear);
      await applyStatements(sql!, moves);
      log(`  ${m.character}: ${lines.length} items stored by the server, ${moves.length / 2} moved to their slots`);
    });

    // 5: everyone in together: supplies, the worn-gear check, the party.
    step = "supplies";
    const befores = new Map<number, CharacterRow>();
    for (const m of members) befores.set(m.index, await snapshot(sql, m.guid!));
    const online = new Map<number, WrathClient>();
    const loginAt = Date.now();
    await each("supplies", async (m) => {
      const c = await open(m, "party");
      online.set(m.index, c);
      await c.createSession({ account: m.account, character: m.character });
      await sleep(1000);
      const baseline = countByItem(c.state.bag().items);
      for (const l of m.loadout.supplies) await soap.addItem(m.character, l.item, l.count);
      await waitForItems(c, baseline, m.loadout.supplies, `${m.character} supplies`);
    });

    const staged: StagedMember[] = [];
    await each("verify", async (m) => {
      const c = online.get(m.index)!;
      const equipped: Record<number, number> = {};
      for (const it of c.state.inventory) if (it.slot < 19 && it.itemId !== undefined) equipped[it.slot] = it.itemId;
      const missing = m.loadout.gear.filter((g) => equipped[g.slot] !== g.item);
      if (missing.length) {
        throw new Error(
          `the loader did not wear ${missing.map((g) => `${g.name} (${g.item}) in slot ${g.slot}, found ${equipped[g.slot] ?? "nothing"}`).join("; ")}` +
            ` — it mails what it will not equip; the design's fallback is to leave the gear in the bags (GROUP-PLAY.md §3 step 4)`,
        );
      }
      const level = c.state.self.level?.value;
      if (level !== PARTY_LEVEL) throw new Error(`${m.character} is level ${level}, expected ${PARTY_LEVEL}`);
      staged.push({
        member: m.index,
        role: m.role,
        account: m.account,
        character: m.character,
        race: m.loadout.race,
        class: m.loadout.class,
        characterGuid: m.guid!,
        equipped,
        talents: m.loadout.talents.map((t) => t.spell),
        spellCount: m.spells!.length + m.loadout.questSpells.length,
      });
    });

    step = "group";
    const leader = members.find((m) => m.role === LEADER_ROLE) ?? members[0]!;
    const lead = online.get(leader.index)!;
    for (const m of members) {
      if (m === leader) continue;
      const c = online.get(m.index)!;
      const invited = await lead.inviteToGroup(m.character, { timeout: 10_000 });
      if (!invited.ok) throw new StageFailure("group", `${leader.character} could not invite ${m.character}: ${invited.hint}`, who(m));
      await c.events.waitForOpcode("SMSG_GROUP_INVITE", { timeout: 10_000 });
      const g = await c.acceptGroupInvite({ timeout: 10_000 });
      if (!g.inGroup || g.leaderName !== leader.character) {
        throw new StageFailure("group", `${m.character} accepted but lists leader ${g.leaderName} (inGroup ${g.inGroup})`, who(m));
      }
    }
    if (members.length > 1) {
      const deadline = Date.now() + 10_000;
      const want = members.filter((m) => m !== leader).map((m) => m.character);
      while (Date.now() < deadline && !want.every((n) => lead.state.group()?.members.some((x) => x.name === n))) await sleep(200);
      const listed = lead.state.group()?.members.map((x) => x.name) ?? [];
      const absent = want.filter((n) => !listed.includes(n));
      if (absent.length) throw new StageFailure("group", `${leader.character}'s party lists ${listed.join(", ") || "nobody"}; missing ${absent.join(", ")}`);
      log(`  party formed: ${leader.character} leads ${want.join(", ")}`);
    }

    step = "logout";
    const left = 1500 - (Date.now() - loginAt);
    if (left > 0) await sleep(left);
    for (const [, c] of online) await close(c, true);
    await each("logout", async (m) => {
      await waitForNewSave(sql!, befores.get(m.index)!, saveWaitMs);
    });

    const ms = Date.now() - t0;
    log(`staged ${members.length} member(s) in ${Math.round(ms / 1000)}s`);
    return { ok: true, campaign: req.campaign, leader: { account: leader.account, character: leader.character }, members: staged.sort((a, b) => a.member - b.member), ms };
  } catch (e) {
    const ms = Date.now() - t0;
    if (e instanceof StageFailure) return { ok: false, campaign: req.campaign, step: e.step, ...(e.member ? { member: e.member } : {}), error: e.message, ms };
    return { ok: false, campaign: req.campaign, step, error: e instanceof Error ? e.message : String(e), ms };
  } finally {
    for (const c of clients) {
      await c.logout().catch(() => {});
      c.close();
    }
    if (ownSql && sql) await sql.close().catch(() => {});
  }
}

// --------------------------------------------------------------------- CLI

const USAGE = `usage: bun infra/fixtures/stage-party.ts [--campaign <id>] [--accounts PARTY1,PARTY2,…] [--roles ${PARTY_ROLES.join(",")}]`;

export function parseStageArgs(argv: readonly string[]): { campaign: string; accounts: string[]; roles: PartyRole[] } {
  const raw: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith("--")) throw new Error(`unexpected argument '${a}'\n${USAGE}`);
    const v = argv[++i];
    if (v === undefined) throw new Error(`${a} needs a value\n${USAGE}`);
    raw[a.slice(2)] = v;
  }
  for (const k of Object.keys(raw)) if (!["campaign", "accounts", "roles"].includes(k)) throw new Error(`unknown flag --${k}\n${USAGE}`);
  const accounts = (raw["accounts"] ?? DEFAULT_PARTY_ACCOUNTS.join(",")).split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
  const roles = (raw["roles"] ?? PARTY_ROLES.join(",")).split(",").map((s) => s.trim()).filter(Boolean);
  for (const r of roles) if (!isPartyRole(r)) throw new Error(`unknown role '${r}'; known: ${PARTY_ROLES.join(", ")}`);
  return { campaign: raw["campaign"] ?? "manual", accounts, roles: roles as PartyRole[] };
}

if (import.meta.main) {
  try {
    const args = parseStageArgs(Bun.argv.slice(2));
    const result = await stageParty(args);
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.ok ? 0 : 1);
  } catch (e) {
    console.error(`[stage-party] ${e instanceof Error ? e.message : String(e)}`);
    process.exit(2);
  }
}
