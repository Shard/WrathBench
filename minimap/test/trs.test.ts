import { describe, expect, test } from "bun:test";
import { parseTrs } from "../src/trs";
import { mapDirectories, parseWdbc } from "../src/dbc";
import { buildWdbc, stringOffset } from "./fixtures";

describe("parseTrs", () => {
  const text = [
    "dir: Azeroth",
    "Azeroth\\map31_43.blp\tdfe35e77355002f7b7cf9f2a61b7ec03.blp",
    "Azeroth\\map32_48.blp\tb53fb722839e0c7a81bae678ea694f5c.blp",
    "",
    "dir: Kalimdor",
    "map30_20.blp\t0000000000000000000000000000aaaa.blp",
    "not a tile line",
    "Kalimdor\\readme.txt\tsomething.blp",
    "",
  ].join("\r\n");

  test("groups tiles by lower-cased directory", () => {
    const index = parseTrs(text);
    expect([...index.keys()].sort()).toEqual(["azeroth", "kalimdor"]);
  });

  test("reads mapX_Y as column then row", () => {
    const azeroth = parseTrs(text).get("azeroth")!;
    expect(azeroth[0]).toEqual({
      col: 31,
      row: 43,
      hash: "dfe35e77355002f7b7cf9f2a61b7ec03.blp",
    });
    expect(azeroth[1]).toEqual({
      col: 32,
      row: 48,
      hash: "b53fb722839e0c7a81bae678ea694f5c.blp",
    });
  });

  test("accepts bare mapX_Y.blp names and drops non-tile lines", () => {
    const kalimdor = parseTrs(text).get("kalimdor")!;
    expect(kalimdor).toEqual([{ col: 30, row: 20, hash: "0000000000000000000000000000aaaa.blp" }]);
  });

  test("merges repeated dir: sections", () => {
    const index = parseTrs(
      "dir: Azeroth\nAzeroth\\map1_2.blp\ta.blp\ndir: Azeroth\nAzeroth\\map3_4.blp\tb.blp\n",
    );
    expect(index.get("azeroth")).toHaveLength(2);
  });

  test("tolerates an empty file", () => {
    expect(parseTrs("").size).toBe(0);
  });
});

describe("Map.dbc", () => {
  const strings = ["Azeroth", "Kalimdor", "Northrend"];
  const dbc = buildWdbc(
    [
      [0, stringOffset(strings, "Azeroth"), 7],
      [1, stringOffset(strings, "Kalimdor"), 7],
      [571, stringOffset(strings, "Northrend"), 7],
    ],
    strings,
    3,
  );

  test("parses the WDBC header and fields", () => {
    const parsed = parseWdbc(dbc);
    expect(parsed.recordCount).toBe(3);
    expect(parsed.fieldCount).toBe(3);
    expect(parsed.recordSize).toBe(12);
    expect(parsed.u32(2, 0)).toBe(571);
    expect(parsed.str(0, 1)).toBe("Azeroth");
  });

  test("rejects a non-WDBC buffer", () => {
    expect(() => parseWdbc(new Uint8Array(32))).toThrow(/not a WDBC/);
  });

  test("maps lower-cased directory names to map ids", () => {
    expect(mapDirectories(dbc)).toEqual(
      new Map([
        ["azeroth", 0],
        ["kalimdor", 1],
        ["northrend", 571],
      ]),
    );
  });
});
