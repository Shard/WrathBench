/**
 * Stage a party for the Deadmines eval (docs/proposals/GROUP-PLAY.md §3):
 * each member a fresh character on its PARTY account under the name the
 * campaign definition gives it, put into the loadout of its race and class
 * (level 20, trainer spells, preset talents, skills, quest-level greens worn,
 * bags, supplies), standing where the request's scenario puts it, grouped
 * with the first member leading, and logged out.
 *
 * The roster's contract (infra/party-stager.ts on the fleet side, which this
 * file matches and never changes):
 *
 *   bun infra/fixtures/stage-party.ts --request -
 *
 * reads one StageRequest as JSON on stdin,
 *
 *   { party, campaign, version, scenario, level,
 *     members: [{ member, role, race, class, character, account, runId }] }
 *
 * with the members in member order and the first one leading. It exits 0 once
 * every member is staged, the party is formed and no session is open on any
 * member's account; its last stdout line is then `{"ok":true,"detail":"…"}`.
 * Any other exit is a failure whose reason is the last line on stderr: 1 for
 * a staging that failed, 2 for a request or usage refused before anything was
 * touched. Progress goes to stdout above the last line, and nothing else
 * reads it. `--request <file>` reads the request from a file; `--example`
 * prints the default party's request (PARTY1..PARTY5, one of each loadout),
 * which by hand is
 *
 *   bun infra/fixtures/stage-party.ts --example | bun infra/fixtures/stage-party.ts --request -
 *
 * from the runner pod with the chart's staging switch on (which hands it the
 * SOAP URL and STAGER's password). `stageParty` is what the CLI calls; the
 * smokes call it in-process.
 *
 * Operator tooling: never imported by `runner/` or `sdk/`. A run, once
 * launched, sees only what its own client is sent at login.
 *
 * The steps, per member, and why each is where it is:
 *
 *   1. Every character on the account is deleted through the module (a
 *      `CMSG_CHAR_DELETE`, which also clears the core's name cache) and the
 *      member is created fresh through `POST /session`, the same utility
 *      session the fixture smokes make. While that session is open the
 *      module's talent frame for the class (Talent.dbc as the client reads
 *      it) is asked for and the loadout's preset checked against it: a
 *      `character_talent` row that is not a talent rank spell ASSERTs in
 *      `Player::_LoadTalents` at the next login and takes the world down.
 *   2. After the logout save, one transaction writes the scenario: level,
 *      position, homebind, quest log, the trainer's spells read from the
 *      world DB's `trainer_spell`, talents, skills (apply.ts).
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
 *      worn gear is checked, the first member invites the others and each
 *      accepts through the SDK — the client path, so the group's guid comes
 *      from the server's generator — and everyone logs out. A group survives
 *      its members' logout (`LeaveGroupOnLogout.Enabled` is off), so the runs
 *      log in grouped.
 *
 * Why the item guids are safe across a worldserver boot: every one was
 * handed out by the live generator and saved by the player, so the next
 * boot's `SELECT MAX(guid)` covers it and the boot's one-time DELETEs above
 * that watermark never reach it. The smoke proves that once, across the
 * first worldserver recreate after SOAP is on (party-staging.ts --keep,
 * then --recheck; docs/RUNBOOK.md, "Party staging").
 */

import type { SQL } from "bun";
import { connect as connectModule, type WrathClient } from "../../sdk/src/index";
import { isValidCharacterName } from "../../runner/src/config";
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
  LOADOUTS,
  LOADOUT_IDS,
  PARTY_LEVEL,
  checkTalentsAgainstFrame,
  loadoutFor,
  partyCharacterName,
  partyScenario,
  validateLoadout,
  type Loadout,
  type StockLine,
} from "./loadouts";
import { SCENARIOS, isScenarioName } from "./scenarios";
import { soapFromEnv, type SoapClient } from "./soap";

/** The accounts a party may be staged on, and nothing else. */
export const PARTY_ACCOUNT_PATTERN = /^PARTY\d$/;
export const DEFAULT_PARTY_ACCOUNTS = ["PARTY1", "PARTY2", "PARTY3", "PARTY4", "PARTY5"] as const;
/** The scenario a Deadmines party stands in. */
export const DEFAULT_PARTY_SCENARIO = "moonbrook-mine";

/** One member to stage, as the roster sends it (infra/party-stager.ts `StageMember`). */
export type StageMember = {
  /** The member id (`tank`, `healer`, …), its run id's suffix. */
  member: string;
  /** The party definition's role word: tank, healer or damage. */
  role: string;
  race: number;
  class: number;
  /** The name to create it under: the definition's, and the one its run is launched with. */
  character: string;
  account: string;
  /** For the log and nothing else. */
  runId: string;
};

/** What the roster asks for (infra/party-stager.ts `StageRequest`). Members in order; the first leads. */
export type StageRequest = {
  party: string;
  campaign: string;
  version: number;
  /** A fixture scenario name (scenarios.ts): where the members stand and hearth. */
  scenario: string;
  level: number;
  members: StageMember[];
};

export type StageStep = "request" | "preflight" | "reset" | "create" | "gear" | "equip" | "supplies" | "verify" | "group" | "logout";

export type StagedMember = {
  member: string;
  account: string;
  character: string;
  loadout: string;
  /** The character's guid low part (`characters.guid`). */
  characterGuid: number;
  /** Item entries worn in equipment slots, by slot. */
  equipped: Record<number, number>;
  talents: number[];
};

export type StageOutcome =
  | { ok: true; detail: string; leader: string; members: StagedMember[]; ms: number }
  | { ok: false; reason: string; step: StageStep; member?: string; ms: number };

export type StageOptions = {
  /** Progress lines. Default: stdout, prefixed `[stage-party]`. */
  log?: (msg: string) => void;
  /** Overrides, for the tests and for a caller that already holds them. */
  moduleUrl?: string;
  moduleSecret?: string;
  soap?: SoapClient;
  sql?: SQL;
  /** How long one logout save may take to land. Default 90 s. */
  saveWaitMs?: number;
};

class StageFailure extends Error {
  constructor(
    readonly step: StageStep,
    message: string,
    readonly member?: string,
  ) {
    super(message);
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * The request's shape, checked at the boundary: stdin is external input.
 * Unknown keys are refused, as the roster's own schemas refuse them, so a
 * contract that drifts fails loudly instead of being half read.
 */
export function parseStageRequest(doc: unknown): { ok: true; request: StageRequest } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  if (!isRecord(doc)) return { ok: false, errors: ["the request is not a JSON object"] };
  const top = ["party", "campaign", "version", "scenario", "level", "members"];
  for (const k of Object.keys(doc)) if (!top.includes(k)) errors.push(`unknown request key '${k}'`);
  for (const k of ["party", "campaign", "scenario"]) if (typeof doc[k] !== "string" || doc[k] === "") errors.push(`${k} must be a non-empty string`);
  for (const k of ["version", "level"]) if (!Number.isInteger(doc[k])) errors.push(`${k} must be an integer`);
  if (!Array.isArray(doc["members"])) errors.push("members must be an array");
  const fields = ["member", "role", "race", "class", "character", "account", "runId"];
  for (const [i, m] of (Array.isArray(doc["members"]) ? doc["members"] : []).entries()) {
    if (!isRecord(m)) {
      errors.push(`members[${i}] is not an object`);
      continue;
    }
    for (const k of Object.keys(m)) if (!fields.includes(k)) errors.push(`members[${i}]: unknown key '${k}'`);
    for (const k of ["member", "role", "character", "account", "runId"]) if (typeof m[k] !== "string" || m[k] === "") errors.push(`members[${i}].${k} must be a non-empty string`);
    for (const k of ["race", "class"]) if (!Number.isInteger(m[k])) errors.push(`members[${i}].${k} must be an integer`);
  }
  return errors.length ? { ok: false, errors } : { ok: true, request: doc as unknown as StageRequest };
}

/** What a well-shaped request must also be before anything is touched. Pure. */
export function checkStageRequest(req: StageRequest): string[] {
  const errors: string[] = [];
  const ms = req.members;
  if (ms.length < 1 || ms.length > 5) errors.push(`a party is 1..5 members, got ${ms.length}`);
  if (!isScenarioName(req.scenario)) errors.push(`unknown scenario '${req.scenario}'`);
  // The loadouts' talents are eleven points: the level they are built for.
  if (req.level !== PARTY_LEVEL) errors.push(`level ${req.level}: the loadouts are built for level ${PARTY_LEVEL}`);
  const dupes = (xs: string[]) => [...new Set(xs.filter((x, i) => xs.indexOf(x) !== i))];
  for (const a of dupes(ms.map((m) => m.account))) errors.push(`account ${a} is named twice`);
  for (const n of dupes(ms.map((m) => m.character.toLowerCase()))) errors.push(`character ${n} is named twice`);
  for (const id of dupes(ms.map((m) => m.member))) errors.push(`member ${id} is named twice`);
  for (const m of ms) {
    if (!PARTY_ACCOUNT_PATTERN.test(m.account)) errors.push(`refusing to stage on '${m.account}': only the party accounts (PARTY1..PARTY5) are staged`);
    if (!isValidCharacterName(m.character)) errors.push(`'${m.character}' is not a character name the game accepts`);
    if (!/^[a-z][a-z0-9]{0,15}$/.test(m.member)) errors.push(`member id '${m.member}' is not a member id`);
    const l = loadoutFor(m);
    if (typeof l === "string") errors.push(`${m.member}: ${l}`);
    else errors.push(...validateLoadout(l));
  }
  return errors;
}

/** The default party's request: PARTY1..PARTY5, one of each loadout, in loadout order (the tank first, so it leads). */
export function defaultStageRequest(over: Partial<Pick<StageRequest, "party" | "campaign">> & { accounts?: readonly string[] } = {}): StageRequest {
  const accounts = over.accounts ?? DEFAULT_PARTY_ACCOUNTS;
  return {
    party: over.party ?? `manual-${Date.now()}`,
    campaign: over.campaign ?? "manual",
    version: 0,
    scenario: DEFAULT_PARTY_SCENARIO,
    level: PARTY_LEVEL,
    members: LOADOUT_IDS.map((id, i) => {
      const l = LOADOUTS[id];
      const account = accounts[i]!;
      return { member: id, role: l.partyRole, race: l.race, class: l.class, character: partyCharacterName(id, account), account, runId: over.party ?? "manual" };
    }),
  };
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
  id: string;
  account: string;
  character: string;
  runId: string;
  loadout: Loadout;
  guid?: number;
  spells?: number[];
};

const sleep = (ms: number) => Bun.sleep(ms);

/**
 * Stage a party. Resolves with what was staged, or with the step and member
 * that failed; it does not throw for a staging failure. Every session it
 * opened is logged out before it resolves. A failure leaves the accounts'
 * characters wherever they got to: the next staging deletes them first, and
 * nothing else reads them.
 */
export async function stageParty(req: StageRequest, opts: StageOptions = {}): Promise<StageOutcome> {
  const t0 = Date.now();
  const log = opts.log ?? ((m: string) => console.log(`[stage-party] ${m}`));
  const saveWaitMs = opts.saveWaitMs ?? 90_000;
  let step: StageStep = "request";
  const clients = new Set<WrathClient>();
  let sql: SQL | undefined = opts.sql;
  const ownSql = opts.sql === undefined;
  try {
    const errors = checkStageRequest(req);
    if (errors.length) throw new StageFailure("request", errors.join("; "));

    step = "preflight";
    const base = (opts.moduleUrl ?? moduleBase()).replace(/\/+$/, "");
    const secret = opts.moduleSecret ?? MODULE_SECRET;
    if (!secret) throw new StageFailure("preflight", "no module port secret (WRATHBENCH_MODULE_SECRET); the stager opens utility sessions with it");
    const soap = opts.soap ?? soapFromEnv();
    await soap.check().catch((e) => {
      throw new StageFailure("preflight", `SOAP refused STAGER before anything was touched: ${e instanceof Error ? e.message : String(e)}`);
    });
    sql ??= await connectDb();
    const scenario = SCENARIOS[req.scenario as keyof typeof SCENARIOS];
    const members: Member[] = req.members.map((m, index) => ({
      index,
      id: m.member,
      account: m.account,
      character: m.character,
      runId: m.runId,
      loadout: loadoutFor(m) as Loadout,
    }));
    for (const m of members) m.spells = await readTrainerSpells(sql, m.loadout);
    log(`party ${req.party} (${req.campaign}@${req.version}, scenario ${req.scenario}): ${members.map((m) => `${m.character} (${m.id}, ${m.loadout.label}) on ${m.account} for ${m.runId}`).join(", ")}`);

    const token = (m: Member, phase: string) => `stage-${req.party.replace(/[^\w-]/g, "-").slice(0, 40)}-${m.account}-${phase}-${crypto.randomUUID()}`;
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
    /** Each member's leg in parallel; the first failure is the result, after every leg has settled. */
    const each = async (s: StageStep, fn: (m: Member) => Promise<void>): Promise<void> => {
      step = s;
      const settled = await Promise.allSettled(members.map(fn));
      const bad = settled.findIndex((r) => r.status === "rejected");
      if (bad >= 0) {
        const reason = (settled[bad] as PromiseRejectedResult).reason;
        if (reason instanceof StageFailure) throw reason;
        throw new StageFailure(s, reason instanceof Error ? reason.message : String(reason), members[bad]!.character);
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
    const sessionAtLeast = async (since: number) => {
      const left = 1500 - (Date.now() - since);
      if (left > 0) await sleep(left); // logout_time is in seconds; see waitForNewSave
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
          throw new StageFailure("reset", msg, m.character);
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
      if (left.length) throw new StageFailure("reset", `${m.account} still holds ${left.join(", ")} after the deletes`, m.character);

      const c = await open(m, "create");
      await c.createSession({ account: m.account, character: m.character, race: m.loadout.race, class: m.loadout.class });
      const frame = await c.queryTalentTree();
      const bad = checkTalentsAgainstFrame(m.loadout, frame);
      // Log out before throwing: the character exists but has no talent rows yet.
      await close(c, true);
      if (bad.length) throw new StageFailure("create", `talent preset does not match the module's frame, nothing written: ${bad.join("; ")}`, m.character);
      const row = await readCharacter(sql!, m.account, m.character);
      if (!row) throw new StageFailure("create", `${m.character} is not in the characters table after its create`, m.character);
      await waitUntilOffline(sql!, row, saveWaitMs);
      m.guid = row.guid;
      const placed = partyScenario(m.loadout, m.spells!, scenario, req.level);
      await applyStatements(sql!, buildStatements(row.guid, placed));
      log(`  ${m.character}: created (guid ${row.guid}) and placed: ${placed.description}`);
    });

    // 3 + 4: gear and bags through SOAP while online, then the offline equipment move.
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
      if (level !== req.level) throw new Error(`${m.character} is level ${level}, expected ${req.level}`);
      staged.push({ member: m.id, account: m.account, character: m.character, loadout: m.loadout.id, characterGuid: m.guid!, equipped, talents: m.loadout.talents.map((t) => t.spell) });
    });

    step = "group";
    const leader = members[0]!;
    const lead = online.get(leader.index)!;
    for (const m of members.slice(1)) {
      const c = online.get(m.index)!;
      const invited = await lead.inviteToGroup(m.character, { timeout: 10_000 });
      if (!invited.ok) throw new StageFailure("group", `${leader.character} could not invite ${m.character}: ${invited.hint}`, m.character);
      await c.events.waitForOpcode("SMSG_GROUP_INVITE", { timeout: 10_000 });
      const g = await c.acceptGroupInvite({ timeout: 10_000 });
      if (!g.inGroup || g.leaderName !== leader.character) {
        throw new StageFailure("group", `${m.character} accepted but lists leader ${g.leaderName} (inGroup ${g.inGroup})`, m.character);
      }
    }
    if (members.length > 1) {
      const deadline = Date.now() + 10_000;
      const want = members.slice(1).map((m) => m.character);
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
    const detail = `staged ${members.length} for party ${req.party} in ${Math.round(ms / 1000)}s: ${members.map((m) => `${m.character} (${m.loadout.label})`).join(", ")}; ${leader.character} leads`;
    log(detail);
    return { ok: true, detail, leader: leader.character, members: staged.sort((a, b) => req.members.findIndex((x) => x.member === a.member) - req.members.findIndex((x) => x.member === b.member)), ms };
  } catch (e) {
    const ms = Date.now() - t0;
    if (e instanceof StageFailure) {
      return { ok: false, step: e.step, ...(e.member ? { member: e.member } : {}), reason: `${e.step}${e.member ? ` (${e.member})` : ""}: ${e.message}`, ms };
    }
    return { ok: false, step, reason: `${step}: ${e instanceof Error ? e.message : String(e)}`, ms };
  } finally {
    // No session is left open on any member's account: their runs log in next.
    for (const c of clients) {
      await c.logout().catch(() => {});
      c.close();
    }
    if (ownSql && sql) await sql.close().catch(() => {});
  }
}

// --------------------------------------------------------------------- CLI

const USAGE = "usage: bun infra/fixtures/stage-party.ts --request <-|file>   |   --example";

export type CliArgs = { kind: "request"; source: string } | { kind: "example" };

export function parseCliArgs(argv: readonly string[]): CliArgs {
  if (argv.length === 1 && argv[0] === "--example") return { kind: "example" };
  if (argv.length === 2 && argv[0] === "--request" && argv[1]) return { kind: "request", source: argv[1] };
  throw new Error(USAGE);
}

/** Exit 0 staged (last stdout line `{"ok":true,"detail":…}`), 1 a staging that failed, 2 refused; the reason is stderr's last line. */
async function main(argv: readonly string[]): Promise<number> {
  let args: CliArgs;
  try {
    args = parseCliArgs(argv);
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    return 2;
  }
  if (args.kind === "example") {
    console.log(JSON.stringify(defaultStageRequest(), null, 2));
    return 0;
  }
  let doc: unknown;
  try {
    const text = args.source === "-" ? await Bun.stdin.text() : await Bun.file(args.source).text();
    doc = JSON.parse(text);
  } catch (e) {
    console.error(`stage-party: the request is not readable JSON: ${e instanceof Error ? e.message : String(e)}`);
    return 2;
  }
  const parsed = parseStageRequest(doc);
  if (!parsed.ok) {
    console.error(`stage-party: refused the request: ${parsed.errors.join("; ")}`);
    return 2;
  }
  const refused = checkStageRequest(parsed.request);
  if (refused.length) {
    console.error(`stage-party: refused the request: ${refused.join("; ")}`);
    return 2;
  }
  const out = await stageParty(parsed.request);
  // Bun.write resolves once the bytes are out, so the line the roster reads
  // is never lost to the exit that follows.
  if (!out.ok) {
    await Bun.write(Bun.stderr, `stage-party: ${out.reason}\n`);
    return 1;
  }
  await Bun.write(Bun.stdout, `${JSON.stringify({ ok: true, detail: out.detail })}\n`);
  return 0;
}

if (import.meta.main) process.exit(await main(Bun.argv.slice(2)));
