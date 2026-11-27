/**
 * The pure half of the fixtures tool, held to what keeps it off a live run's
 * character: the account guard, the schema every write lands in, the tables it
 * may touch, and the wait for a fresh character's logout save. No database.
 */

import { describe, expect, test } from "bun:test";
import {
  ACCOUNT_PATTERN,
  assertFixturableAccount,
  buildEquipStatements,
  buildStatements,
  connectOptions,
  renderStatement,
  savedOut,
  type CharacterRow,
  type InventoryRow,
} from "./apply";
import { SCENARIOS, validateScenario, type Scenario } from "./scenarios";
import { stagingEnvOf } from "../world";

describe("account guard", () => {
  test("accepts the smoke, probe and party accounts", () => {
    for (const account of ["SMOKE", "SMOKE2", "SMOKE3", "SMOKE4", "SMOKE10", "PROBE", "PARTY1", "PARTY5"]) {
      expect(ACCOUNT_PATTERN.test(account)).toBe(true);
      expect(() => assertFixturableAccount(account)).not.toThrow();
    }
  });

  test("refuses runner and shakeout accounts, the stager's, and anything shaped like a party account that is not one", () => {
    for (const account of ["RUNNER", "RUNNER2", "SHAKEOUT", "SHAKEOUT2", "SMOKEY", "XSMOKE", "smoke3", "STAGER", "SPECTATOR", "PARTY", "PARTY10", "PARTYX", "XPARTY1"]) {
      expect(() => assertFixturableAccount(account)).toThrow(/refusing to fixture/);
    }
  });
});

describe("the characters schema", () => {
  test("is the connection's default database, from WRATHBENCH_CHARACTERS_DB: a world's own under the stager's world env", () => {
    expect(connectOptions({}).database).toBe("acore_characters");
    expect(connectOptions({ WRATHBENCH_CHARACTERS_DB: "acore_characters", ...stagingEnvOf("wabcdefghij", 7878, {}) }).database).toBe("acore_characters_wabcdefghij");
    expect(() => connectOptions({ WRATHBENCH_CHARACTERS_DB: "acore_characters; DROP" })).toThrow(/not a schema name/);
  });

  test("no statement names a schema, so every write lands in the connection's", () => {
    const rows: InventoryRow[] = [
      { bag: 0, slot: 4, item: 10, entry: 45 },
      { bag: 0, slot: 23, item: 11, entry: 2488 },
    ];
    const statements = [
      ...Object.values(SCENARIOS).flatMap((s) => buildStatements(42, s)),
      ...buildEquipStatements(42, rows, [{ entry: 2488, slot: 4 }], []),
    ];
    expect(statements.length).toBeGreaterThan(10);
    for (const s of statements) {
      expect(s.sql).not.toMatch(/acore_/);
      expect(s.sql).not.toMatch(/\b\w+\.\w+\s*(\(|SET|WHERE|$)/m);
    }
  });
});

describe("scenarios", () => {
  test("every shipped scenario validates", () => {
    for (const scenario of Object.values(SCENARIOS)) validateScenario(scenario);
  });
});

describe("buildStatements", () => {
  const scenario: Scenario = {
    description: "test",
    level: 12,
    xp: 345,
    money: 6789,
    position: { map: 0, zone: 1537, x: 1.5, y: -2.5, z: 3.5, o: 4.5 },
    homebind: { map: 0, zone: 1537, x: 10, y: 20, z: 30 },
    spells: [1234, 5678],
    quests: { inProgress: [11], rewarded: [22] },
  };

  test("the character update carries every field and ends with the guid", () => {
    const [update] = buildStatements(217, scenario);
    expect(update!.sql).toContain("UPDATE characters SET");
    expect(update!.sql).toContain("WHERE guid = ?");
    // The placeholder count and the parameter count must agree or MySQL binds
    // the wrong values into the wrong columns.
    expect(update!.sql.split("?").length - 1).toBe(update!.params.length);
    expect(update!.params.slice(0, 9)).toEqual([12, 345, 6789, 0, 1537, 1.5, -2.5, 3.5, 4.5]);
    expect(update!.params.at(-1)).toBe(217);
    // Full health and every power, left to the loader to clamp.
    expect(update!.params.slice(9, 17)).toEqual([100000, 100000, 100000, 100000, 100000, 100000, 100000, 100000]);
    // at_login is never touched.
    expect(update!.sql).not.toContain("at_login");
  });

  test("no statement touches an item table", () => {
    const rendered = buildStatements(217, scenario).map(renderStatement).join("\n");
    expect(rendered).not.toMatch(/item_instance|character_inventory/);
  });
});

describe("buildEquipStatements", () => {
  type Row = InventoryRow;
  /** Apply statements to rows the way MySQL would, enforcing the (guid, bag, slot) key after each one. */
  function run(rows: Row[], stmts: ReturnType<typeof buildEquipStatements>): Row[] {
    const out = rows.map((r) => ({ ...r }));
    for (const s of stmts) {
      expect(s.sql).toMatch(/^UPDATE character_inventory SET bag = (\?|0), slot = \? WHERE guid = \? AND item = \?$/);
      const [bag, slot, , item] = s.sql.includes("bag = 0,") ? [0, ...s.params] : s.params;
      const r = out.find((x) => x.item === item)!;
      r.bag = Number(bag);
      r.slot = Number(slot);
      const keys = out.map((x) => `${x.bag}:${x.slot}`);
      expect(new Set(keys).size).toBe(keys.length);
    }
    return out;
  }
  const at = (rows: Row[], bag: number, slot: number) => rows.find((r) => r.bag === bag && r.slot === slot)?.entry;

  // A fresh warrior: starter shirt, pants, boots and sword worn, hearthstone and food in
  // the backpack; then the staged chest, sword, shield and two bags the server stored after them.
  const fresh: Row[] = [
    { bag: 0, slot: 3, item: 101, entry: 38 },
    { bag: 0, slot: 6, item: 102, entry: 39 },
    { bag: 0, slot: 7, item: 103, entry: 40 },
    { bag: 0, slot: 15, item: 104, entry: 25 },
    { bag: 0, slot: 23, item: 105, entry: 6948 },
    { bag: 0, slot: 24, item: 106, entry: 117 },
    { bag: 0, slot: 25, item: 201, entry: 6721 },
    { bag: 0, slot: 26, item: 202, entry: 3400 },
    { bag: 0, slot: 27, item: 203, entry: 15207 },
    { bag: 0, slot: 28, item: 204, entry: 4240 },
    { bag: 0, slot: 29, item: 205, entry: 4240 },
    { bag: 0, slot: 30, item: 206, entry: 2545 },
  ];

  test("wears each staged item and puts the starter item it displaced where the new one was, guids untouched", () => {
    const targets = [
      { entry: 6721, slot: 4 },
      { entry: 2545, slot: 6 },
      { entry: 3400, slot: 15 },
      { entry: 15207, slot: 16 },
      { entry: 4240, slot: 19 },
      { entry: 4240, slot: 20 },
    ];
    const after = run(fresh, buildEquipStatements(217, fresh, targets));
    expect([at(after, 0, 4), at(after, 0, 6), at(after, 0, 15), at(after, 0, 16), at(after, 0, 19), at(after, 0, 20)]).toEqual([6721, 2545, 3400, 15207, 4240, 4240]);
    // The starter pants and sword went to the backpack slots the new ones left.
    expect(at(after, 0, 30)).toBe(39);
    expect(at(after, 0, 26)).toBe(25);
    // Untouched rows stay; every guid is the one the server allocated.
    expect(at(after, 0, 3)).toBe(38);
    expect(at(after, 0, 23)).toBe(6948);
    expect(after.map((r) => r.item).sort()).toEqual(fresh.map((r) => r.item).sort());
  });

  test("writes only bag and slot, never a guid or an item row", () => {
    const rendered = buildEquipStatements(217, fresh, [{ entry: 6721, slot: 4 }]).map(renderStatement).join("\n");
    expect(rendered).not.toMatch(/INSERT|DELETE|item_instance|SET item|SET guid/);
  });
});

describe("waitUntilOffline: a fresh character's first logout save", () => {
  const AT_LOGIN_FIRST = 0x20;
  const row = (over: Partial<CharacterRow>): CharacterRow => ({
    guid: 1055,
    level: 1,
    xp: 0,
    money: 0,
    map: 0,
    zone: 0,
    position_x: -8949.95,
    position_y: -132.49,
    position_z: 83.53,
    orientation: 0,
    online: 0,
    logout_time: 1793246022,
    at_login: 0,
    ...over,
  });

  test("the create INSERT stamps logout_time, so a fresh character reads offline before its session's save; only AT_LOGIN_FIRST tells them apart", () => {
    // The row right after POST /session created it and DELETE /session asked it out:
    // the INSERT's own logout_time, online's async 1 not landed yet.
    expect(savedOut(row({ at_login: AT_LOGIN_FIRST }))).toBe(false);
    // The logout save wrote at_login with the first-login bit cleared in memory.
    expect(savedOut(row({ at_login: 0 }))).toBe(true);
    // Other at_login flags are the core's business and say nothing about the save.
    expect(savedOut(row({ at_login: 0x1 }))).toBe(true);
    expect(savedOut(row({ online: 1 }))).toBe(false);
    expect(savedOut(row({ logout_time: 0 }))).toBe(false);
  });
});
