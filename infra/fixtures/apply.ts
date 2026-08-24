/**
 * Put a logged-out smoke character into a named scenario.
 *
 *   docker compose -f infra/compose.yml run --rm --no-deps fixtures \
 *     --account SMOKE3 --character Smoketram --scenario tram-ironforge
 *
 * or, from inside a container that can reach the db:
 *
 *   bun infra/fixtures/apply.ts --account SMOKE3 --character Smoketram \
 *     --scenario tram-ironforge [--wait-ms 90000] [--dry-run]
 *
 * Why direct SQL
 * --------------
 * Same reasoning as infra/bootstrap/bootstrap.ts: the harness has no
 * privileged control path into the running world. SOAP is off by contract
 * (docs/CONTRACTS.md) and the worldserver console is interactive and racy.
 * Setting up a *character* has the additional constraint that it must not be
 * something the agent could ever reach, so it lives here, in infra/, is never
 * imported by runner/ or sdk/, and only touches accounts matching
 * the SMOKE / PROBE pattern. Runner accounts are never fixtured.
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
  validateScenario,
  type Scenario,
  type ScenarioName,
} from "./scenarios";

// ------------------------------------------------------------------ constants

/**
 * Accounts this tool will touch. Smoke accounts (SMOKE, SMOKE2..SMOKE4) are
 * the preflight gate's, PROBE is the ad-hoc debugging account. RUNNER* and
 * SHAKEOUT* are deliberately absent: a benchmark run must start from a
 * character the agent itself created.
 */
export const ACCOUNT_PATTERN = /^(SMOKE\d*|PROBE)$/;

/**
 * QUEST_STATUS_INCOMPLETE. Note the value: in
 * src/server/game/Quests/QuestDef.h the enum is NONE=0, COMPLETE=1,
 * INCOMPLETE=3 — 1 is *complete*, not incomplete, and 2/4 are commented out.
 * Player::_LoadQuestStatus rejects anything >= MAX_QUEST_STATUS and falls back
 * to 3, so a wrong value here is a silent behaviour change, not an error.
 */
const QUEST_STATUS_INCOMPLETE = 3;

/**
 * specMask for an added spell. DESCRIBE character_spell says the column
 * defaults to 1, but the core writes 255 for ordinary spells (verified against
 * every row this database has), and Player::_LoadSpells passes the stored mask
 * straight into addSpell. 255 is the all-talent-specs superset, which is what
 * a fixture wants.
 */
const SPELL_SPEC_MASK = 255;

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
      `refusing to fixture account '${account}': only smoke accounts (SMOKE, SMOKE2, ...) and PROBE may be ` +
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

  for (const quest of scenario.quests?.rewarded ?? []) {
    statements.push({
      sql: `INSERT IGNORE INTO character_queststatus_rewarded (guid, quest, active) VALUES (?, ?, 1)`,
      params: [guid, quest],
    });
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

async function connect(): Promise<SQL> {
  const sql = new SQL({
    adapter: "mysql",
    hostname: env("WRATHBENCH_DB_HOST", "db"),
    port: Number(env("WRATHBENCH_DB_PORT", "3306")),
    username: env("WRATHBENCH_DB_USER", "root"),
    password: env("WRATHBENCH_DB_PASSWORD"),
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

type CharacterRow = {
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
] as const;

/** `guid, level, ...` optionally qualified; the join needs it, `online` is ambiguous otherwise. */
const snapshotColumns = (prefix = "") => SNAPSHOT_COLUMNS.map((c) => `${prefix}${c}`).join(", ");

async function readCharacter(sql: SQL, account: string, character: string): Promise<CharacterRow | undefined> {
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

async function snapshot(sql: SQL, guid: number): Promise<CharacterRow> {
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
async function waitUntilOffline(sql: SQL, row: CharacterRow, waitMs: number): Promise<void> {
  if (row.online === 0) return;
  const deadline = Date.now() + waitMs;
  log(`character is online; waiting up to ${Math.round(waitMs / 1000)}s for the logout save to land`);
  for (;;) {
    await Bun.sleep(500);
    const current = await snapshot(sql, row.guid);
    if (current.online === 0) {
      log("character is offline");
      return;
    }
    if (Date.now() > deadline) {
      throw new Error(
        `character ${row.guid} is still online after ${Math.round(waitMs / 1000)}s. ` +
          `End the session first (DELETE /session) and retry; fixturing a live character would be ` +
          `overwritten by that session's logout save.`,
      );
    }
  }
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

    await sql.begin(async (tx) => {
      for (const stmt of statements) await tx.unsafe(stmt.sql, stmt.params);
    });

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
