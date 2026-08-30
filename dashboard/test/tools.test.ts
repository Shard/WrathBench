import { describe, expect, test } from "bun:test";
import type { ToolView } from "../src/api/client";
import { SDK_FAMILIES, paramNames, selectedTool } from "../src/lib/tools";

const tool = (name: string): ToolView => ({ name, description: `${name} does`, inputSchema: {}, example: null, returns: "x" });
const TOOLS = [tool("run_snippet"), tool("reflect")];

describe("selectedTool", () => {
  test("the named tool, else the first, else nothing", () => {
    expect(selectedTool(TOOLS, "reflect")?.name).toBe("reflect");
    expect(selectedTool(TOOLS, "nope")?.name).toBe("run_snippet");
    expect(selectedTool(TOOLS, undefined)?.name).toBe("run_snippet");
    expect(selectedTool([], "reflect")).toBeUndefined();
  });
});

describe("paramNames", () => {
  test("required first, then the rest; a schema with no properties is empty", () => {
    const schema = { type: "object", properties: { limit: {}, query: {} }, required: ["query"] };
    expect(paramNames(schema)).toEqual([
      { name: "query", required: true },
      { name: "limit", required: false },
    ]);
    expect(paramNames({ type: "object" })).toEqual([]);
  });
});

describe("SDK_FAMILIES", () => {
  test("the six families the brief names, raw escape hatch last", () => {
    expect(SDK_FAMILIES.map((f) => f.name)).toEqual(["movement", "combat", "quests", "items", "NPC windows", "raw escape hatch"]);
  });
});
