/**
 * Unit tests for the pure half of the fixtures tool: argument parsing, the
 * account guard, statement building and the orientation helper. No database.
 */

import { describe, expect, test } from "bun:test";
import {
  ACCOUNT_PATTERN,
  assertFixturableAccount,
  buildEquipStatements,
  buildStatements,
  parseArgs,
  renderStatement,
  type InventoryRow,
} from "./apply";
import { SCENARIOS, facing, isScenarioName, taxiMask, validateScenario, type Scenario } from "./scenarios";

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

describe("parseArgs", () => {
  const base = ["--account", "SMOKE3", "--character", "Smoketram", "--scenario", "tram-ironforge"];

  test("parses the required flags and defaults", () => {
    expect(parseArgs(base)).toEqual({
      account: "SMOKE3",
      character: "Smoketram",
      scenario: "tram-ironforge",
      waitMs: 90_000,
      dryRun: false,
    });
  });

  test("uppercases the account so an operator can type it in lower case", () => {
    expect(parseArgs(["--account", "smoke3", ...base.slice(2)]).account).toBe("SMOKE3");
  });

  test("takes --wait-ms and --dry-run", () => {
    const args = parseArgs([...base, "--wait-ms", "1500", "--dry-run"]);
    expect(args.waitMs).toBe(1500);
    expect(args.dryRun).toBe(true);
  });

  test("refuses a runner account", () => {
    expect(() => parseArgs(["--account", "RUNNER", ...base.slice(2)])).toThrow(/refusing to fixture/);
  });

  test("refuses an unknown scenario", () => {
    expect(() => parseArgs([...base.slice(0, 4), "--scenario", "nope"])).toThrow(/unknown scenario/);
  });

  test("refuses missing flags and stray arguments", () => {
    expect(() => parseArgs(["--account", "SMOKE"])).toThrow(/--character is required/);
    expect(() => parseArgs([...base, "junk"])).toThrow(/unexpected argument/);
    expect(() => parseArgs([...base, "--wait-ms"])).toThrow(/needs a value/);
    expect(() => parseArgs([...base, "--wait-ms", "-1"])).toThrow(/non-negative/);
  });
});

describe("facing", () => {
  test("points along the axes", () => {
    expect(facing({ x: 0, y: 0 }, { x: 1, y: 0 })).toBeCloseTo(0, 6);
    expect(facing({ x: 0, y: 0 }, { x: 0, y: 1 })).toBeCloseTo(Math.PI / 2, 6);
    expect(facing({ x: 0, y: 0 }, { x: -1, y: 0 })).toBeCloseTo(Math.PI, 6);
  });

  test("normalises into [0, 2*PI)", () => {
    const o = facing({ x: 0, y: 0 }, { x: 0, y: -1 });
    expect(o).toBeCloseTo((3 * Math.PI) / 2, 6);
    expect(o).toBeGreaterThanOrEqual(0);
    expect(o).toBeLessThan(2 * Math.PI);
  });

  test("the tram scenario faces the areatrigger", () => {
    // (-4838.95, -1318.46) -> (-4840.26, -1330.46): mostly south, slightly west.
    expect(SCENARIOS["tram-ironforge"].position.o).toBeCloseTo(4.6036, 3);
  });
});

describe("scenarios", () => {
  test("every shipped scenario validates", () => {
    for (const scenario of Object.values(SCENARIOS)) validateScenario(scenario);
  });

  test("isScenarioName is exact", () => {
    expect(isScenarioName("northshire-fresh")).toBe(true);
    expect(isScenarioName("toString")).toBe(false);
  });

  test("rejects nonsense", () => {
    const ok = SCENARIOS["northshire-fresh"] as Scenario;
    expect(() => validateScenario({ ...ok, level: 0 })).toThrow(/level/);
    expect(() => validateScenario({ ...ok, level: 81 })).toThrow(/level/);
    expect(() => validateScenario({ ...ok, money: -1 })).toThrow(/money/);
    expect(() => validateScenario({ ...ok, position: { ...ok.position, x: NaN } })).toThrow(/position.x/);
    expect(() => validateScenario({ ...ok, position: { ...ok.position, o: 7 } })).toThrow(/position.o/);
    expect(() => validateScenario({ ...ok, spells: [0] })).toThrow(/spells/);
    expect(() => validateScenario({ ...ok, quests: { rewarded: [-3] } })).toThrow(/rewarded/);
    expect(() => validateScenario({ ...ok, quests: { counted: [{ quest: 7, mobcount: [] }] } })).toThrow(/mobcount/);
    expect(() => validateScenario({ ...ok, quests: { counted: [{ quest: 7, mobcount: [1, 2, 3, 4, 5] }] } })).toThrow(/mobcount/);
    expect(() => validateScenario({ ...ok, quests: { counted: [{ quest: 7, mobcount: [-1] }] } })).toThrow(/mobcount/);
    expect(() => validateScenario({ ...ok, quests: { counted: [{ quest: 0, mobcount: [1] }] } })).toThrow(/counted/);
    expect(() => validateScenario({ ...ok, quests: { inProgress: [7], counted: [{ quest: 7, mobcount: [1] }] } })).toThrow(/also in/);
    expect(() => validateScenario({ ...ok, quests: { counted: [{ quest: 7, mobcount: [1] }, { quest: 7, mobcount: [2] }] } })).toThrow(/repeat/);
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

  test("clears the transport and taxi state that would otherwise strand the character", () => {
    const [update] = buildStatements(217, scenario);
    for (const fragment of ["instance_id = 0", "taxi_path = ''", "transguid = 0", "trans_x = 0"]) {
      expect(update!.sql).toContain(fragment);
    }
  });

  test("homebind, spells and quests each get a statement", () => {
    const rendered = buildStatements(217, scenario).map(renderStatement);
    expect(rendered.some((s) => s.startsWith("REPLACE INTO character_homebind"))).toBe(true);
    expect(rendered).toContain("INSERT IGNORE INTO character_spell (guid, spell, specMask) VALUES (217, 1234, 255)");
    expect(rendered).toContain("INSERT IGNORE INTO character_spell (guid, spell, specMask) VALUES (217, 5678, 255)");
    // status 3 is QUEST_STATUS_INCOMPLETE; 1 is COMPLETE (QuestDef.h).
    expect(rendered).toContain("INSERT IGNORE INTO character_queststatus (guid, quest, status) VALUES (217, 11, 3)");
    expect(rendered).toContain(
      "INSERT IGNORE INTO character_queststatus_rewarded (guid, quest, active) VALUES (217, 22, 1)",
    );
  });

  test("no statement touches an item table", () => {
    const rendered = buildStatements(217, scenario).map(renderStatement).join("\n");
    expect(rendered).not.toMatch(/item_instance|character_inventory/);
  });

  test("omits what the scenario does not ask for", () => {
    const bare = buildStatements(217, { description: "bare", level: 1, position: scenario.position });
    expect(bare).toHaveLength(1);
  });

  test("clearQuests emits both deletes before any insert", () => {
    const rendered = buildStatements(217, {
      ...scenario,
      clearQuests: true,
    }).map(renderStatement);
    const del = rendered.findIndex((s) => s.startsWith("DELETE FROM character_queststatus WHERE"));
    const ins = rendered.findIndex((s) => s.startsWith("INSERT IGNORE INTO character_queststatus "));
    expect(del).toBeGreaterThanOrEqual(0);
    expect(rendered).toContain("DELETE FROM character_queststatus_rewarded WHERE guid = 217");
    expect(del).toBeLessThan(ins);
  });

  test("a counted quest is written whole: status, then all four mobcounts", () => {
    const rendered = buildStatements(217, {
      ...scenario,
      clearQuests: true,
      quests: { rewarded: [783], counted: [{ quest: 7, mobcount: [7] }, { quest: 8, mobcount: [8, 2], complete: true }] },
    }).map(renderStatement);
    // 3 is QUEST_STATUS_INCOMPLETE, 1 is COMPLETE (QuestDef.h); the missing counts are 0.
    expect(rendered).toContain(
      "REPLACE INTO character_queststatus (guid, quest, status, mobcount1, mobcount2, mobcount3, mobcount4) VALUES (217, 7, 3, 7, 0, 0, 0)",
    );
    expect(rendered).toContain(
      "REPLACE INTO character_queststatus (guid, quest, status, mobcount1, mobcount2, mobcount3, mobcount4) VALUES (217, 8, 1, 8, 2, 0, 0)",
    );
    // After the wipe, or the wipe would take the counts with it.
    const del = rendered.findIndex((s) => s.startsWith("DELETE FROM character_queststatus WHERE"));
    const rep = rendered.findIndex((s) => s.startsWith("REPLACE INTO character_queststatus "));
    expect(del).toBeLessThan(rep);
  });

  test("the deploy smokes' scenarios stand quest 7 at 7/8 and at 8/8 complete", () => {
    const lastKill = buildStatements(217, SCENARIOS["vineyard-last-kill"]).map(renderStatement);
    expect(lastKill).toContain(
      "REPLACE INTO character_queststatus (guid, quest, status, mobcount1, mobcount2, mobcount3, mobcount4) VALUES (217, 7, 3, 7, 0, 0, 0)",
    );
    const done = buildStatements(217, SCENARIOS["mcbride-kill-quest-done"]).map(renderStatement);
    expect(done).toContain(
      "REPLACE INTO character_queststatus (guid, quest, status, mobcount1, mobcount2, mobcount3, mobcount4) VALUES (217, 7, 1, 8, 0, 0, 0)",
    );
    for (const r of [lastKill, done]) expect(r).toContain("INSERT IGNORE INTO character_queststatus_rewarded (guid, quest, active) VALUES (217, 783, 1)");
  });

  test("rejects an invalid scenario before building anything", () => {
    expect(() => buildStatements(217, { ...scenario, level: 999 })).toThrow(/invalid scenario/);
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

  test("a two-hander empties the off hand into the first free backpack slot", () => {
    const rows: Row[] = [
      { bag: 0, slot: 15, item: 1, entry: 36 },
      { bag: 0, slot: 16, item: 2, entry: 2362 },
      { bag: 0, slot: 23, item: 3, entry: 6948 },
      { bag: 0, slot: 24, item: 4, entry: 5613 },
    ];
    const after = run(rows, buildEquipStatements(9, rows, [{ entry: 5613, slot: 15 }], [16]));
    expect(at(after, 0, 15)).toBe(5613);
    expect(at(after, 0, 16)).toBeUndefined();
    expect(at(after, 0, 24)).toBe(36);
    expect(at(after, 0, 25)).toBe(2362);
  });

  test("takes a staged item from inside a bag, and leaves alone what is already worn where it belongs", () => {
    const rows: Row[] = [
      { bag: 0, slot: 4, item: 1, entry: 6721 },
      { bag: 0, slot: 19, item: 2, entry: 4240 },
      { bag: 2, slot: 0, item: 3, entry: 3400 },
    ];
    const stmts = buildEquipStatements(9, rows, [{ entry: 6721, slot: 4 }, { entry: 3400, slot: 15 }]);
    const after = run(rows, stmts);
    expect(stmts).toHaveLength(2); // one park, one place: the chest was already on
    expect(at(after, 0, 15)).toBe(3400);
    expect(at(after, 2, 0)).toBeUndefined();
  });

  test("says which item is missing rather than guessing, and refuses impossible targets", () => {
    expect(() => buildEquipStatements(9, fresh, [{ entry: 99999, slot: 4 }])).toThrow(/item 99999 for slot 4 is not in the bags/);
    expect(() => buildEquipStatements(9, fresh, [{ entry: 6721, slot: 4 }, { entry: 2545, slot: 4 }])).toThrow(/slot 4 twice/);
    expect(() => buildEquipStatements(9, fresh, [{ entry: 6721, slot: 23 }])).toThrow(/not an equipment or bag slot/);
    // Two of one item need two in the bags.
    const one = fresh.filter((r) => r.item !== 205);
    expect(() => buildEquipStatements(9, one, [{ entry: 4240, slot: 19 }, { entry: 4240, slot: 20 }])).toThrow(/item 4240 for slot 20/);
    const full: Row[] = [{ bag: 0, slot: 16, item: 1, entry: 2362 }, ...Array.from({ length: 16 }, (_, i) => ({ bag: 0, slot: 23 + i, item: 100 + i, entry: 5000 + i }))];
    expect(() => buildEquipStatements(9, full, [], [16])).toThrow(/no free backpack slot/);
  });

  test("writes only bag and slot, never a guid or an item row", () => {
    const rendered = buildEquipStatements(217, fresh, [{ entry: 6721, slot: 4 }]).map(renderStatement).join("\n");
    expect(rendered).not.toMatch(/INSERT|DELETE|item_instance|SET item|SET guid/);
  });
});

describe("renderStatement", () => {
  test("inlines parameters and escapes quotes", () => {
    expect(renderStatement({ sql: "SELECT ?, ?", params: ["it's", 3] })).toBe("SELECT 'it''s', 3");
  });
});

describe("taxiMask", () => {
  test("sets bit n-1 of the right word, 14 words wide", () => {
    expect(taxiMask([6, 7])).toBe(["96", ...new Array(13).fill("0")].join(" "));
    expect(taxiMask([33]).split(" ")[1]).toBe("1");
    expect(taxiMask([]).split(" ")).toHaveLength(14);
  });
  test("a scenario with taxiNodes writes taximask, one without does not", () => {
    const base: Scenario = { description: "t", level: 10, position: SCENARIOS["taxi-ironforge"].position };
    const without = buildStatements(217, base).map(renderStatement).join("\n");
    expect(without).not.toContain("taximask");
    const withNodes = buildStatements(217, { ...base, taxiNodes: [6, 7] }).map(renderStatement).join("\n");
    expect(withNodes).toContain("taximask = '96 0 0 0 0 0 0 0 0 0 0 0 0 0'");
  });
  test("achievements become character_achievement rows with the fixture date", () => {
    const base: Scenario = { description: "t", level: 10, position: SCENARIOS["taxi-ironforge"].position };
    expect(buildStatements(217, base).map(renderStatement).join("\n")).not.toContain("character_achievement");
    const withAch = buildStatements(217, { ...base, achievements: [6] }).map(renderStatement).join("\n");
    expect(withAch).toContain("REPLACE INTO character_achievement (guid, achievement, date) VALUES (217, 6, 1262304000)");
  });
});
