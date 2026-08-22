import { expect, test } from "bun:test";
import { cleanQuestValue, extractQuest } from "../src/quests";
import { createMemoryBundle, makeWriter } from "../src/bundle";
import { searchReference, questPrefix } from "../src/search";

// Every fixture here is invented. No wiki or game text appears in this repo.

test("a questbox states giver and ender separately", () => {
  const quest = extractQuest(
    "{{questbox\n| name = Example Quest Alpha\n| start = [[Example Person Gamma]]\n" +
      "| end = {{npc||Example Person Delta}}\n| category = Example Zone Beta\n| id = 4242\n}}\n" +
      "== Objectives ==\nSpeak with {{npc||Example Person Delta}}.",
  );
  expect(quest).toEqual({
    start: "Example Person Gamma",
    end: "Example Person Delta",
    category: "Example Zone Beta",
  });
});

test("an omitted or empty end is left unstated, never copied from start", () => {
  const omitted = extractQuest("{{questbox|name=Example|start=[[Example Person Gamma]]|id=7}}");
  expect(omitted).toEqual({ start: "Example Person Gamma" });
  const empty = extractQuest("{{questbox\n| start = [[Example Person Gamma]]\n| end = \n| id = 7\n}}");
  expect(empty).toEqual({ start: "Example Person Gamma" });
});

test("list-item quest templates are not infoboxes and state nothing", () => {
  expect(extractQuest("*{{questlong|Alliance|5|Example Quest Alpha}}")).toBeNull();
  expect(extractQuest("Example Zone Beta has lorem quests.")).toBeNull();
});

test("values give up their link labels and NPC templates", () => {
  expect(cleanQuestValue("[[Example Person Gamma|Gamma the Example]]")).toBe("Gamma the Example");
  expect(cleanQuestValue("{{NPC|Alliance|Example Person Delta|icon=Example Icon}}")).toBe(
    "Example Person Delta",
  );
  expect(cleanQuestValue("  ")).toBeUndefined();
  expect(cleanQuestValue("{{unknownexample|lorem=ipsum}}")).toBeUndefined();
});

test("the snippet prefix names the ender, and says so when the page does not", () => {
  expect(questPrefix({ start: "Example Person Gamma", end: "Example Person Delta" })).toContain(
    "turn in to Example Person Delta",
  );
  expect(questPrefix({ start: "Example Person Gamma" })).toContain("not stated on this page");
  expect(questPrefix(undefined)).toBe("");
});

test("search leads a quest hit with its giver and ender", () => {
  const db = createMemoryBundle();
  const writer = makeWriter(db, 1);
  writer.addPage(
    "Quest:Example Quest Alpha",
    118,
    "Objectives\nSpeak with the example person.\nDescription\nLorem ipsum dolor sit amet.",
    undefined,
    [{ kind: "quest", id: 4242 }],
    { start: "Example Person Gamma", end: "Example Person Delta", category: "Example Zone Beta" },
  );
  writer.flush();

  const [hit] = searchReference(db, "Quest:Example Quest Alpha");
  expect(hit?.quest).toEqual({
    start: "Example Person Gamma",
    end: "Example Person Delta",
    category: "Example Zone Beta",
  });
  expect(hit?.snippet.startsWith("[quest infobox:")).toBe(true);
  expect(hit?.snippet).toContain("turn in to Example Person Delta");

  // The id band carries it too: "quest 4242" is how a model asks.
  const [byId] = searchReference(db, "quest 4242");
  expect(byId?.snippet).toContain("turn in to Example Person Delta");
  db.close();
});

test("a bundle without the quest channel degrades to no quest line", () => {
  const db = createMemoryBundle();
  const writer = makeWriter(db, 1);
  writer.addPage("Quest:Example Quest Alpha", 118, "Lorem ipsum dolor sit amet.", undefined, [], {
    start: "Example Person Gamma",
    end: "Example Person Delta",
  });
  writer.flush();
  db.run("DROP TABLE page_quest");
  const [hit] = searchReference(db, "Quest:Example Quest Alpha");
  expect(hit?.quest).toBeUndefined();
  expect(hit?.snippet).not.toContain("quest infobox");
  db.close();
});
