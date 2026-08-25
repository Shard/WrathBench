/**
 * Unit tests for the pure half of the fixtures tool: argument parsing, the
 * account guard, statement building and the orientation helper. No database.
 */

import { describe, expect, test } from "bun:test";
import {
  ACCOUNT_PATTERN,
  assertFixturableAccount,
  buildStatements,
  parseArgs,
  renderStatement,
} from "./apply";
import { SCENARIOS, facing, isScenarioName, taxiMask, validateScenario, type Scenario } from "./scenarios";

describe("account guard", () => {
  test("accepts the smoke and probe accounts", () => {
    for (const account of ["SMOKE", "SMOKE2", "SMOKE3", "SMOKE4", "SMOKE10", "PROBE"]) {
      expect(ACCOUNT_PATTERN.test(account)).toBe(true);
      expect(() => assertFixturableAccount(account)).not.toThrow();
    }
  });

  test("refuses runner and shakeout accounts", () => {
    for (const account of ["RUNNER", "RUNNER2", "SHAKEOUT", "SHAKEOUT2", "SMOKEY", "XSMOKE", "smoke3"]) {
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

  test("rejects an invalid scenario before building anything", () => {
    expect(() => buildStatements(217, { ...scenario, level: 999 })).toThrow(/invalid scenario/);
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
