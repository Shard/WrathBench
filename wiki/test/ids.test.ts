import { describe, expect, test } from "bun:test";
import { extractIds } from "../src/ids";

/**
 * Every fixture here is invented. Field and template names mirror the shapes
 * real dumps use; the names, numbers and prose are synthetic.
 */
describe("extractIds", () => {
  test("takes the id of an infobox template and its kind from the template name", () => {
    expect(
      extractIds("{{questbox\n| name=Example Quest Alpha\n| id=4242\n| level=5\n}}\nLorem ipsum."),
    ).toEqual([{ kind: "quest", id: 4242 }]);
    expect(extractIds("{{npcbox\n | name = Example Person Gamma|id=1717\n | level = 3\n}}")).toEqual([
      { kind: "npc", id: 1717 },
    ]);
  });

  test("named id fields carry their own kind wherever they sit", () => {
    expect(extractIds("{{examplebox|itemid=9001|questid=77}}")).toEqual([
      { kind: "item", id: 9001 },
      { kind: "quest", id: 77 },
    ]);
  });

  test("an id outside any known template is kept as unknown", () => {
    expect(extractIds("{{examplebox|id=55}}")).toEqual([{ kind: "unknown", id: 55 }]);
  });

  test("ignores numbers that are not id fields", () => {
    expect(extractIds("{{questbox|level=5|experience=25150|money=70}}")).toEqual([]);
    expect(extractIds("Two plus seven hundred and eighty three equals 785.")).toEqual([]);
    expect(extractIds("")).toEqual([]);
  });

  test("rejects out-of-range and malformed values", () => {
    expect(extractIds("{{questbox|id=0}}")).toEqual([]);
    expect(extractIds("{{questbox|id=1234567890}}")).toEqual([]);
    expect(extractIds("{{questbox|id=}}")).toEqual([]);
    expect(extractIds("{{questbox|id=abc}}")).toEqual([]);
  });

  test("deduplicates and caps, and is deterministic", () => {
    const text = "{{questbox|id=4242}} later {{questbox|id=4242}}";
    expect(extractIds(text)).toEqual([{ kind: "quest", id: 4242 }]);
    expect(extractIds(text)).toEqual(extractIds(text));
    const many = Array.from({ length: 30 }, (_v, i) => `{{npcbox|id=${100 + i}}}`).join("\n");
    expect(extractIds(many).length).toBe(8);
  });

  test("the same id under two kinds is two rows", () => {
    expect(extractIds("{{questbox|id=12}}\n{{npcbox|id=12}}")).toEqual([
      { kind: "quest", id: 12 },
      { kind: "npc", id: 12 },
    ]);
  });

  test("a far-away template opening does not colour a later id", () => {
    const text = `{{questbox|name=Example Quest Alpha}}\n${"lorem ipsum ".repeat(400)}\n{{examplebox|id=31}}`;
    expect(extractIds(text)).toEqual([{ kind: "unknown", id: 31 }]);
  });
});
