/**
 * The unit frame's bars: percent clamping, the power tint by type, the dead
 * state, and the "unobserved is not zero" rule the feed relies on.
 */

import { describe, expect, test } from "bun:test";
import {
  XP_FOR_LEVEL,
  barReading,
  classPowerType,
  healthReading,
  isDead,
  percentOf,
  powerToken,
  powerTypeOf,
  resolvePowerType,
  xpToNext,
} from "../src/lib/unitframe";

describe("percentOf", () => {
  test("clamps into 0–100 and refuses non-ratios", () => {
    expect(percentOf(50, 200)).toBe(25);
    expect(percentOf(300, 200)).toBe(100);
    expect(percentOf(-5, 200)).toBe(0);
    expect(percentOf(10, 0)).toBe(0);
    expect(percentOf(null, 200)).toBe(0);
    expect(percentOf(10, Number.NaN)).toBe(0);
  });
});

describe("barReading", () => {
  test("prints cur / max with the percent in the title", () => {
    expect(barReading(1234, 5000)).toEqual({ pct: 24.68, text: "1,234 / 5,000", title: "25%", observed: true });
  });
  test("unobserved is a dash, not zero", () => {
    expect(barReading(undefined, undefined)).toEqual({ pct: 0, text: "—", title: "", observed: false });
    expect(barReading(5, null).observed).toBe(false);
  });
});

describe("power", () => {
  test("colours by the client's power type ids", () => {
    expect(powerToken(powerTypeOf(0))).toBe("var(--power-mana)");
    expect(powerToken(powerTypeOf(1))).toBe("var(--power-rage)");
    expect(powerToken(powerTypeOf(2))).toBe("var(--power-focus)");
    expect(powerToken(powerTypeOf(3))).toBe("var(--power-energy)");
    expect(powerToken(powerTypeOf(6))).toBe("var(--power-runic)");
    expect(powerTypeOf(null)).toBe("mana");
    expect(powerTypeOf(99)).toBe("mana");
  });
  test("falls back to the class's primary power at 3.3.5a", () => {
    expect(classPowerType(1)).toBe("rage");
    expect(classPowerType(4)).toBe("energy");
    expect(classPowerType(6)).toBe("runic");
    expect(classPowerType(3)).toBe("mana"); // hunters were mana until Cataclysm
    expect(classPowerType(11)).toBe("mana");
    expect(classPowerType(null)).toBe("mana");
  });
});

describe("dead state", () => {
  test("a corpse and a released ghost both read dead; alive above 1", () => {
    expect(isDead(0)).toBe(true);
    expect(isDead(1)).toBe(true);
    expect(isDead(2)).toBe(false);
    expect(isDead(undefined)).toBe(false);
    expect(isDead(500, true)).toBe(true);
    expect(isDead(0, false)).toBe(false);
  });
  test("the health bar empties and mutes when dead", () => {
    expect(healthReading(1, 120)).toEqual({ pct: 0, text: "0 / 120", title: "dead", observed: true, dead: true });
    expect(healthReading(90, 120).dead).toBe(false);
    expect(healthReading(undefined, undefined)).toMatchObject({ observed: false, dead: false, text: "—" });
  });
});

describe("resolvePowerType", () => {
  test("the sample's own power type wins; the class is the fallback", () => {
    // A druid (class 11) in bear form reports rage, whatever its class says.
    expect(resolvePowerType(1, 11)).toBe("rage");
    expect(resolvePowerType(0, 1)).toBe("mana");
    // A run recorded before the column: the class's primary power stands in.
    expect(resolvePowerType(null, 1)).toBe("rage");
    expect(resolvePowerType(undefined, 4)).toBe("energy");
    expect(resolvePowerType(null, 6)).toBe("runic");
    expect(resolvePowerType(null, null)).toBe("mana");
  });
});

describe("xpToNext", () => {
  test("prefers the character's own value and falls back to the level table", () => {
    expect(xpToNext(5, 2800)).toBe(2800);
    expect(xpToNext(5)).toBe(XP_FOR_LEVEL[5] ?? -1);
    expect(xpToNext(1)).toBe(400);
    expect(xpToNext(80)).toBeNull();
    expect(xpToNext(null)).toBeNull();
    // L1–L79 from the table; L80 is the cap and has no row.
    expect(XP_FOR_LEVEL.length).toBe(80);
  });

  test("the table is AzerothCore's 3.3.5 player_xp_for_level, not the pre-Wrath curve shifted a slot", () => {
    // deps/azerothcore/data/sql/base/db_world/player_xp_for_level.sql
    expect(XP_FOR_LEVEL[59]).toBe(172000);
    expect(XP_FOR_LEVEL[60]).toBe(290000);
    expect(XP_FOR_LEVEL[61]).toBe(317000);
    expect(XP_FOR_LEVEL[69]).toBe(717000);
    expect(XP_FOR_LEVEL[70]).toBe(1523800);
    expect(XP_FOR_LEVEL[79]).toBe(1670800);
  });
});
