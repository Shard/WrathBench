/**
 * Put a logged-out smoke character into a named scenario.
 *
 *   bun infra/fixtures/apply.ts --account SMOKE3 --character Smoketram \
 *     --scenario tram-ironforge [--wait-ms 90000] [--dry-run]
 *
 * from inside a container that can reach the db: the cluster's runner pod
 * (`kubectl -n wrathbench exec deploy/wrathbench-runner -- bun infra/fixtures/apply.ts …`),
 * or on the quickstart
 *
 *   docker compose -f infra/compose.yml run --rm --no-deps fixtures \
 *     --account SMOKE3 --character Smoketram --scenario tram-ironforge
 *
 * Why direct SQL
 * --------------
 * Same reasoning as infra/bootstrap/bootstrap.ts: the agent has no
 * privileged control path into the running world (wrath-mcp/docs/CONTRACTS.md binds
 * the agent's path; the operator's party staging uses SOAP in-cluster, on an
 * admin account, for the one write SQL cannot make guid-safely —
 * docs/proposals/GROUP-PLAY.md) and the worldserver console is interactive
 * and racy.
 * Setting up a *character* has the additional constraint that it must not be
 * something the agent could ever reach, so it lives here, in infra/, is never
 * imported by runner/ or sdk/, and only touches accounts matching
 * the SMOKE / PROBE / PARTY pattern. Runner accounts are never fixtured.
 *
 * The write happens while the character is offline. The core reads the
 * `characters` row on login and writes it back on logout, so a fixture applied
 * under a live session would be overwritten by that session's save.
 */

import { SQL } from "bun";
import {
  SCENARIOS,
  SCENARIO_NAMES,
  isScenarioName,
  taxiMask,
  ACHIEVEMENT_FIXTURE_DATE,
  QUEST_MOBCOUNT_COLUMNS,
  validateScenario,
  type Scenario,
  type ScenarioName,
} from "./scenarios";

// ------------------------------------------------------------------ constants

/**
 * Accounts this tool will touch. Smoke accounts (SMOKE, SMOKE2..SMOKE4) are
 * the preflight gate's, PROBE is the ad-hoc debugging account, and PARTY1..
 * PARTY5 are reserved for the party eval, whose loadouts are staged by the
 * operator's decision for that lane (docs/proposals/GROUP-PLAY.md §2).
 * RUNNER* and SHAKEOUT* are deliberately absent: a benchmark run must start
 * from a character the agent itself created.
 */
export const ACCOUNT_PATTERN = /^(SMOKE\d*|PROBE|PARTY\d)$/;

/**
 * QUEST_STATUS_INCOMPLETE. Note the value: in
 * src/server/game/Quests/QuestDef.h the enum is NONE=0, COMPLETE=1,
 * INCOMPLETE=3 — 1 is *complete*, not incomplete, and 2/4 are commented out.
 * Player::_LoadQuestStatus rejects anything >= MAX_QUEST_STATUS and falls back
 * to 3, so a wrong value here is a silent behaviour change, not an error.
 */
const QUEST_STATUS_INCOMPLETE = 3;
/** QUEST_STATUS_COMPLETE (QuestDef.h): the objectives are met, the quest is not yet turned in. */
const QUEST_STATUS_COMPLETE = 1;

/**
 * specMask for an added spell. DESCRIBE character_spell says the column
 * defaults to 1, but the core writes 255 for ordinary spells (verified against
 * every row this database has), and Player::_LoadSpells passes the stored mask
 * straight into addSpell. 255 is the all-talent-specs superset, which is what
 * a fixture wants.
 */
const SPELL_SPEC_MASK = 255;

/**
 * specMask for a talent: the primary spec only, which is what the core writes
 * when a player learns one (`LearnTalent` passes `GetActiveSpecMask()`, 1 for
 * spec 0) and the only spec a character without dual spec has. `addTalent`
 * counts the row's points only when the mask covers the active spec, so 1 is
 * also what makes the points land.
 */
const TALENT_SPEC_MASK = 1;

/** The skill cap for a level, `Player::GetMaxSkillValueForLevel`: 5 x level. */
export const maxSkillForLevel = (level: number): number => level * 5;

/**
 * Health and each power are written high on purpose. The loader clamps:
 * PlayerStorage.cpp does `SetHealth(saved > GetMaxHealth() ? GetMaxHealth() :
 * saved)` and the same for every power. So "bigger than any max at level 80"
 * means "full", without this tool having to know the character's stats.
 */
const FULL = 100000;

// ------------------------------------------------------------------ arguments

export type Args = {
  account: string;
  character: string;
  scenario: ScenarioName;
  waitMs: number;
  dryRun: boolean;
};

const USAGE = `usage: bun infra/fixtures/apply.ts --account <ACCOUNT> --character <Name> --scenario <name> [--wait-ms 90000] [--dry-run]

scenarios: ${SCENARIO_NAMES.join(", ")}`;

export function parseArgs(argv: string[]): Args {
  const raw: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (!arg.startsWith("--")) throw new Error(`unexpected argument '${arg}'\n${USAGE}`);
    const key = arg.slice(2);
    if (key === "dry-run") {
      raw[key] = true;
      continue;
    }
    const value = argv[++i];
    if (value === undefined) throw new Error(`--${key} needs a value\n${USAGE}`);
    raw[key] = value;
  }

  const account = String(raw["account"] ?? "").toUpperCase();
  const character = String(raw["character"] ?? "");
  const scenario = String(raw["scenario"] ?? "");

  if (!account) throw new Error(`--account is required\n${USAGE}`);
  if (!character) throw new Error(`--character is required\n${USAGE}`);
  if (!scenario) throw new Error(`--scenario is required\n${USAGE}`);

  assertFixturableAccount(account);

  if (!isScenarioName(scenario)) {
    throw new Error(`unknown scenario '${scenario}'; known: ${SCENARIO_NAMES.join(", ")}`);
  }

  const waitMs = raw["wait-ms"] === undefined ? 90_000 : Number(raw["wait-ms"]);
  if (!Number.isFinite(waitMs) || waitMs < 0) throw new Error(`--wait-ms must be a non-negative number`);

  return { account, character, scenario, waitMs, dryRun: raw["dry-run"] === true };
}

/** Refuses any account that is not a smoke or probe account. */
export function assertFixturableAccount(account: string): void {
  if (!ACCOUNT_PATTERN.test(account)) {
    throw new Error(
      `refusing to fixture account '${account}': only smoke accounts (SMOKE, SMOKE2, ...), PROBE and the party accounts (PARTY1..PARTY5) may be ` +
        `fixtured. Benchmark runs must start from a character the agent created.`,
    );
  }
}

// --------------------------------------------------------- statement building

export type Statement = { sql: string; params: (string | number)[] };

/** Renders a statement with its parameters inlined, for --dry-run output. */
export function renderStatement(stmt: Statement): string {
  let i = 0;
  const text = stmt.sql.replace(/\?/g, () => {
    const v = stmt.params[i++];
    return typeof v === "string" ? `'${v.replace(/'/g, "''")}'` : String(v);
  });
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Every write the fixture makes, in order, as parameterised statements. Pure:
 * no database, no clock, no environment — which is what apply.test.ts checks.
 *
 * `at_login` is deliberately not touched. It carries flags the core acts on at
 * the next login (rename, customise, reset spells) and a fixture has no
 * business setting or clearing them.
 */
export function buildStatements(guid: number, scenario: Scenario): Statement[] {
  validateScenario(scenario);

  const p = scenario.position;
  const statements: Statement[] = [
    {
      sql: `UPDATE characters SET
              level = ?, xp = ?, money = ?,
              map = ?, zone = ?,
              position_x = ?, position_y = ?, position_z = ?, orientation = ?,
              instance_id = 0,
              taxi_path = '',
              trans_x = 0, trans_y = 0, trans_z = 0, trans_o = 0, transguid = 0,
              health = ?,
              power1 = ?, power2 = ?, power3 = ?, power4 = ?,
              power5 = ?, power6 = ?, power7 = ?
            WHERE guid = ?`,
      params: [
        scenario.level,
        scenario.xp ?? 0,
        scenario.money ?? 0,
        p.map,
        p.zone,
        p.x,
        p.y,
        p.z,
        p.o,
        FULL,
        FULL,
        FULL,
        FULL,
        FULL,
        FULL,
        FULL,
        FULL,
        guid,
      ],
    },
  ];

  if (scenario.homebind) {
    const h = scenario.homebind;
    statements.push({
      sql: `REPLACE INTO character_homebind (guid, mapId, zoneId, posX, posY, posZ) VALUES (?, ?, ?, ?, ?, ?)`,
      params: [guid, h.map, h.zone, h.x, h.y, h.z],
    });
  }

  for (const spell of scenario.spells ?? []) {
    statements.push({
      sql: `INSERT IGNORE INTO character_spell (guid, spell, specMask) VALUES (?, ?, ?)`,
      params: [guid, spell, SPELL_SPEC_MASK],
    });
  }

  if (scenario.taxiNodes) {
    statements.push({
      sql: `UPDATE characters SET taximask = ? WHERE guid = ?`,
      params: [taxiMask(scenario.taxiNodes), guid],
    });
  }

  for (const achievement of scenario.achievements ?? []) {
    statements.push({
      sql: `REPLACE INTO character_achievement (guid, achievement, date) VALUES (?, ?, ?)`,
      params: [guid, achievement, ACHIEVEMENT_FIXTURE_DATE],
    });
  }

  if (scenario.clearQuests) {
    statements.push({ sql: `DELETE FROM character_queststatus WHERE guid = ?`, params: [guid] });
    statements.push({ sql: `DELETE FROM character_queststatus_rewarded WHERE guid = ?`, params: [guid] });
  }

  for (const quest of scenario.quests?.inProgress ?? []) {
    statements.push({
      sql: `INSERT IGNORE INTO character_queststatus (guid, quest, status) VALUES (?, ?, ?)`,
      params: [guid, quest, QUEST_STATUS_INCOMPLETE],
    });
  }

  for (const c of scenario.quests?.counted ?? []) {
    const mobcount = Array.from({ length: QUEST_MOBCOUNT_COLUMNS }, (_, i) => c.mobcount[i] ?? 0);
    statements.push({
      sql: `REPLACE INTO character_queststatus (guid, quest, status, mobcount1, mobcount2, mobcount3, mobcount4) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      params: [guid, c.quest, c.complete ? QUEST_STATUS_COMPLETE : QUEST_STATUS_INCOMPLETE, ...mobcount],
    });
  }

  for (const quest of scenario.quests?.rewarded ?? []) {
    statements.push({
      sql: `INSERT IGNORE INTO character_queststatus_rewarded (guid, quest, active) VALUES (?, ?, 1)`,
      params: [guid, quest],
    });
  }

  if (scenario.talents) {
    // The preset replaces whatever was there: a stale row from an earlier
    // build would add its points on top, and InitTalentForLevel answers an
    // over-spent tree by resetting every talent at login.
    statements.push({ sql: `DELETE FROM character_talent WHERE guid = ?`, params: [guid] });
    for (const spell of scenario.talents) {
      statements.push({
        sql: `INSERT INTO character_talent (guid, spell, specMask) VALUES (?, ?, ?)`,
        params: [guid, spell, TALENT_SPEC_MASK],
      });
    }
  }

  if (scenario.maxSkills) {
    // Level-ranged skills only: armor and other mono skills sit at max 1 and
    // languages at 300, and both are fixed by the loader whatever is stored.
    const cap = maxSkillForLevel(scenario.level);
    statements.push({
      sql: `UPDATE character_skills SET value = ?, max = ? WHERE guid = ? AND max > 1 AND max < 300`,
      params: [cap, cap, guid],
    });
  }

  return statements;
}

// ------------------------------------------------------------ equipment move

/** One `character_inventory` row joined to its `item_instance.itemEntry`. */
export type InventoryRow = {
  /** 0 for the character's own slots (equipment, worn bags, backpack, bank...); else the container item's guid. */
  bag: number;
  slot: number;
  /** The item guid (`character_inventory.item`). */
  item: number;
  /** The item template (`item_instance.itemEntry`). */
  entry: number;
};

/** Where one staged item is worn: an equipment slot 0..18, or a bag slot 19..22. */
export type EquipTarget = { entry: number; slot: number };

/** Equipment and worn-bag slots end here (`INVENTORY_SLOT_BAG_END`). */
const WORN_END = 23;
/** The backpack (`INVENTORY_SLOT_ITEM_START`..`_END`). */
const BACKPACK_START = 23;
const BACKPACK_END = 39;
/** EQUIPMENT_SLOT_OFFHAND, emptied under a two-handed main hand. */
export const OFFHAND_SLOT = 16;
/**
 * Parking slots for the moves, bag 0. Nothing the core writes is this high in
 * 3.3.5 (the currency slots end at 149), the column is a tinyint, and every
 * parked row leaves again inside the same transaction.
 */
const PARK_BASE = 200;

const posKey = (bag: number, slot: number) => `${bag}:${slot}`;

/**
 * The offline equipment move (docs/proposals/GROUP-PLAY.md §3, step 4), as
 * statements. Pure. Every staged item the server stored in the backpack or a
 * bag moves to its slot in `targets`; whatever the fresh character already
 * wears there (starter gear) moves to the place the new item left; and each
 * `clear` slot (the off hand, under a two-handed main hand) is emptied into
 * the first backpack slot free after those moves. Only `bag` and `slot`
 * change, never a guid: the rows are the ones the running server allocated
 * and saved.
 *
 * `(guid, bag, slot)` is unique, so a swap cannot be one UPDATE: every row
 * that moves is first parked on a free high slot and then placed, which keeps
 * the key unique after each statement.
 */
export function buildEquipStatements(
  guid: number,
  rows: readonly InventoryRow[],
  targets: readonly EquipTarget[],
  clear: readonly number[] = [],
): Statement[] {
  const seenSlots = new Set<number>();
  for (const t of targets) {
    if (!Number.isInteger(t.slot) || t.slot < 0 || t.slot >= WORN_END) {
      throw new Error(`equip target ${t.entry}: slot ${t.slot} is not an equipment or bag slot (0..22)`);
    }
    if (seenSlots.has(t.slot)) throw new Error(`equip targets name slot ${t.slot} twice`);
    seenSlots.add(t.slot);
  }
  for (const c of clear) if (seenSlots.has(c)) throw new Error(`slot ${c} is both a target and cleared`);
  for (const r of rows) if (r.bag === 0 && r.slot >= PARK_BASE) throw new Error(`item ${r.item} already sits on parking slot ${r.slot}`);

  const at = new Map<string, InventoryRow>(rows.map((r) => [posKey(r.bag, r.slot), r]));
  const worn = (r: InventoryRow) => r.bag === 0 && r.slot < WORN_END;
  /** item guid -> where it ends up. */
  const finalPos = new Map<number, { bag: number; slot: number }>();
  const used = new Set<number>();

  for (const t of targets) {
    const current = at.get(posKey(0, t.slot));
    if (current && current.entry === t.entry && !used.has(current.item)) {
      used.add(current.item); // already worn there: nothing to move
      continue;
    }
    const src = rows.find((r) => r.entry === t.entry && !used.has(r.item) && !worn(r));
    if (!src) throw new Error(`item ${t.entry} for slot ${t.slot} is not in the bags (the .additem did not land, or its save has not)`);
    used.add(src.item);
    finalPos.set(src.item, { bag: 0, slot: t.slot });
    if (current) finalPos.set(current.item, { bag: src.bag, slot: src.slot });
  }

  // What is occupied once the moves above have happened.
  const occupiedAfter = new Set<string>();
  for (const r of rows) {
    const p = finalPos.get(r.item) ?? { bag: r.bag, slot: r.slot };
    occupiedAfter.add(posKey(p.bag, p.slot));
  }
  for (const c of clear) {
    const occupant = at.get(posKey(0, c));
    if (!occupant || finalPos.has(occupant.item)) continue;
    let free = -1;
    for (let s = BACKPACK_START; s < BACKPACK_END; s++) {
      if (!occupiedAfter.has(posKey(0, s))) {
        free = s;
        break;
      }
    }
    if (free < 0) throw new Error(`no free backpack slot to take the item worn in slot ${c}`);
    occupiedAfter.delete(posKey(0, c));
    occupiedAfter.add(posKey(0, free));
    finalPos.set(occupant.item, { bag: 0, slot: free });
  }

  const byItem = new Map(rows.map((r) => [r.item, r]));
  const moves = [...finalPos].filter(([item, p]) => {
    const r = byItem.get(item)!;
    return r.bag !== p.bag || r.slot !== p.slot;
  });
  if (moves.length > 255 - PARK_BASE) throw new Error(`${moves.length} item moves is more than the parking slots hold`);

  const statements: Statement[] = [];
  moves.forEach(([item], i) => {
    statements.push({ sql: `UPDATE character_inventory SET bag = 0, slot = ? WHERE guid = ? AND item = ?`, params: [PARK_BASE + i, guid, item] });
  });
  for (const [item, p] of moves) {
    statements.push({ sql: `UPDATE character_inventory SET bag = ?, slot = ? WHERE guid = ? AND item = ?`, params: [p.bag, p.slot, guid, item] });
  }
  return statements;
}

// ----------------------------------------------------------------- plumbing

function env(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined) throw new Error(`missing required environment variable ${name}`);
  return v;
}

const log = (msg: string) => console.log(`[fixtures] ${msg}`);

/**
 * The database password, mirroring compose's `${WRATHBENCH_DB_ROOT_PASSWORD:-wrathbench}`:
 * the service env sets WRATHBENCH_DB_PASSWORD, a host shell or `.env` more often
 * sets WRATHBENCH_DB_ROOT_PASSWORD (infra/README), and the compose default is
 * the literal. Without the last step every invocation from a container that
 * predates the env block would throw instead of connecting.
 */
function dbPassword(): string {
  return process.env["WRATHBENCH_DB_PASSWORD"] ?? process.env["WRATHBENCH_DB_ROOT_PASSWORD"] ?? "wrathbench";
}

export async function connect(): Promise<SQL> {
  const sql = new SQL({
    adapter: "mysql",
    hostname: env("WRATHBENCH_DB_HOST", "db"),
    port: Number(env("WRATHBENCH_DB_PORT", "3306")),
    username: env("WRATHBENCH_DB_USER", "root"),
    password: dbPassword(),
    database: env("WRATHBENCH_CHARACTERS_DB", "acore_characters"),
    // Same reason as bootstrap.ts: MySQL 8.4's caching_sha2_password wants the
    // server's RSA key on first handshake, and the connection never leaves the
    // private compose network.
    allowPublicKeyRetrieval: true,
    max: 1,
  });
  await sql`SELECT 1`;
  return sql;
}

export type CharacterRow = {
  guid: number;
  level: number;
  xp: number;
  money: number;
  map: number;
  zone: number;
  position_x: number;
  position_y: number;
  position_z: number;
  orientation: number;
  online: number;
  logout_time: number;
};

const SNAPSHOT_COLUMNS = [
  "guid",
  "level",
  "xp",
  "money",
  "map",
  "zone",
  "position_x",
  "position_y",
  "position_z",
  "orientation",
  "online",
  "logout_time",
] as const;

/** `guid, level, ...` optionally qualified; the join needs it, `online` is ambiguous otherwise. */
const snapshotColumns = (prefix = "") => SNAPSHOT_COLUMNS.map((c) => `${prefix}${c}`).join(", ");

export async function readCharacter(sql: SQL, account: string, character: string): Promise<CharacterRow | undefined> {
  // acore_auth is a separate schema on the same server, so the join is
  // qualified rather than relying on the connection's default database.
  const rows = (await sql.unsafe(
    `SELECT ${snapshotColumns("c.")} FROM characters c
     JOIN acore_auth.account a ON a.id = c.account
     WHERE a.username = ? AND c.name = ?`,
    [account, character],
  )) as CharacterRow[];
  return rows[0];
}

export async function snapshot(sql: SQL, guid: number): Promise<CharacterRow> {
  const rows = (await sql.unsafe(`SELECT ${snapshotColumns()} FROM characters WHERE guid = ?`, [guid])) as CharacterRow[];
  const row = rows[0];
  if (!row) throw new Error(`character ${guid} vanished`);
  return row;
}

/**
 * Wait until the core has finished writing the character out.
 *
 * `characters.online` is set to 0 by Player::SaveToDB on the logout path, so
 * `online = 0` is the signal that the late save has landed, not merely that
 * the session was asked to end. The race this closes: the module's
 * `DELETE /session` acknowledges as soon as it has queued the logout, but
 * LogoutPlayer runs on a later world tick (and the core may hold the player in
 * world for up to 20 seconds of logout timer first). Fixturing in that window
 * writes rows the subsequent save overwrites, and the fixture looks like it
 * silently did nothing.
 */
export async function waitUntilOffline(sql: SQL, row: CharacterRow, waitMs: number): Promise<void> {
  // A character that has never been saved out (`logout_time` 0) is one the
  // caller just created and logged straight out of. The login's `online = 1`
  // is an async execute and the logout save an async transaction, so at the
  // instant the module acknowledged the logout the row can still read
  // `online = 0` with the save behind it — and a fixture written now is
  // overwritten by that save (seen live: the mail smoke's character back at
  // the start position). The save stamps `logout_time`, so wait for it.
  const settled = (r: CharacterRow) => r.online === 0 && r.logout_time !== 0;
  if (settled(row)) return;
  const deadline = Date.now() + waitMs;
  log(
    row.online !== 0
      ? `character is online; waiting up to ${Math.round(waitMs / 1000)}s for the logout save to land`
      : `character has never been saved out; waiting up to ${Math.round(waitMs / 1000)}s for its first logout save`,
  );
  for (;;) {
    await Bun.sleep(500);
    const current = await snapshot(sql, row.guid);
    if (settled(current)) {
      log("character is offline");
      return;
    }
    if (Date.now() > deadline) {
      throw new Error(
        `character ${row.guid} is still online (or unsaved) after ${Math.round(waitMs / 1000)}s. ` +
          `End the session first (DELETE /session) and retry; fixturing a live character would be ` +
          `overwritten by that session's logout save.`,
      );
    }
  }
}

/**
 * Wait for the save of a session that logged in AFTER `before` was read: the
 * row is offline and `logout_time` has moved past `before.logout_time`. The
 * plain `waitUntilOffline` cannot tell a second login's save from the first's
 * (both leave `online = 0` and a non-zero `logout_time`), so a multi-login
 * stager reads the row before each login and waits on this. `logout_time` is
 * in seconds, so a session must outlive one second for the change to show;
 * every staging session does.
 */
export async function waitForNewSave(sql: SQL, before: CharacterRow, waitMs: number): Promise<CharacterRow> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    const current = await snapshot(sql, before.guid);
    if (current.online === 0 && current.logout_time > before.logout_time) return current;
    if (Date.now() > deadline) {
      throw new Error(
        `character ${before.guid}: no new logout save within ${Math.round(waitMs / 1000)}s ` +
          `(online=${current.online}, logout_time ${current.logout_time} vs ${before.logout_time} before the login)`,
      );
    }
    await Bun.sleep(500);
  }
}

/** The character's inventory rows with each item's template, for `buildEquipStatements`. */
export async function readInventory(sql: SQL, guid: number): Promise<InventoryRow[]> {
  const rows = (await sql.unsafe(
    `SELECT ci.bag AS bag, ci.slot AS slot, ci.item AS item, ii.itemEntry AS entry
     FROM character_inventory ci JOIN item_instance ii ON ii.guid = ci.item
     WHERE ci.guid = ?`,
    [guid],
  )) as InventoryRow[];
  return rows.map((r) => ({ bag: Number(r.bag), slot: Number(r.slot), item: Number(r.item), entry: Number(r.entry) }));
}

/** Run statements in one transaction. */
export async function applyStatements(sql: SQL, statements: readonly Statement[]): Promise<void> {
  await sql.begin(async (tx) => {
    for (const stmt of statements) await tx.unsafe(stmt.sql, stmt.params);
  });
}

function describe(row: CharacterRow): string {
  return [
    `level=${row.level}`,
    `xp=${row.xp}`,
    `money=${row.money}`,
    `map=${row.map}`,
    `zone=${row.zone}`,
    `pos=(${row.position_x.toFixed(2)}, ${row.position_y.toFixed(2)}, ${row.position_z.toFixed(2)})`,
    `o=${row.orientation.toFixed(3)}`,
  ].join(" ");
}

// --------------------------------------------------------------------- main

async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  const scenario: Scenario = SCENARIOS[args.scenario];
  validateScenario(scenario);

  const sql = await connect();
  try {
    const before = await readCharacter(sql, args.account, args.character);
    if (!before) {
      console.error(
        `[fixtures] no character '${args.character}' on account '${args.account}'.\n` +
          `[fixtures] This tool never creates characters. Make it through the module first ` +
          `(POST /session with the character name, then DELETE /session), then re-run.`,
      );
      return 1;
    }

    const statements = buildStatements(before.guid, scenario);

    if (args.dryRun) {
      log(`dry run: ${args.account}/${args.character} (guid ${before.guid}) -> ${args.scenario}`);
      log(`scenario: ${scenario.description}`);
      log(`before: ${describe(before)}`);
      for (const stmt of statements) console.log(`  ${renderStatement(stmt)};`);
      log(`${statements.length} statement(s) not executed (--dry-run)`);
      return 0;
    }

    await waitUntilOffline(sql, before, args.waitMs);

    // Re-read after the wait, not before it. If the character was still online
    // at invocation, the logout SaveToDB rewrote the row while we waited, so
    // the row read above is the pre-logout state and not the state this
    // fixture is actually overwriting. The before/after pair is the tool's
    // proof artifact; it has to be honest.
    const settled = await snapshot(sql, before.guid);

    await applyStatements(sql, statements);

    const after = await snapshot(sql, before.guid);
    log(`${args.account}/${args.character} (guid ${before.guid}) -> ${args.scenario}: ${scenario.description}`);
    log(`before: ${describe(settled)}`);
    log(`after:  ${describe(after)}`);
    return 0;
  } finally {
    await sql.close().catch(() => {});
  }
}

if (import.meta.main) {
  try {
    process.exit(await main(process.argv.slice(2)));
  } catch (err) {
    console.error(`[fixtures] ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
