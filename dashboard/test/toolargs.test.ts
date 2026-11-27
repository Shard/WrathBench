/**
 * A call's input read for drawing (`lib/toolargs.ts`): an edit under the
 * names the tools accept, and the JSON kept wherever the args cannot be
 * trusted whole, so a capped or cut record never reads as a complete edit.
 */

import { describe, expect, test } from "bun:test";
import { argsView } from "../src/lib/toolargs";

describe("an edit", () => {
  test("the tools' own names, and the aliases they accept, whether recorded as an object or a JSON string", () => {
    expect(argsView("edit_file", { path: "main.ts", old: "a", new: "b" })).toEqual({ kind: "edit", path: "main.ts", old: "a", new: "b", replaceAll: false });
    expect(argsView("edit_file", { file_path: "lib/x.ts", old_string: "a", new_string: "b", replace_all: true })).toEqual({ kind: "edit", path: "lib/x.ts", old: "a", new: "b", replaceAll: true });
    expect(argsView("edit_scratchpad", { old_text: "a", new_text: "b" })).toEqual({ kind: "edit", path: undefined, old: "a", new: "b", replaceAll: false });
    expect(argsView("edit_file", JSON.stringify({ path: "main.ts", old: "a", new: "b" }))).toMatchObject({ kind: "edit", path: "main.ts" });
    expect(argsView("edit_file", "{not json")).toBeNull();
  });

  test("a capped side, a record the viewer cut, or a missing side keeps the JSON", () => {
    expect(argsView("edit_file", { path: "main.ts", old: "a", new: "b".repeat(10) + "\n… 550 more characters" })).toBeNull();
    expect(argsView("edit_file", { path: "main.ts", old: "a", new: "b" }, true)).toBeNull();
    expect(argsView("edit_file", { path: "main.ts", old: "a" })).toBeNull();
  });
});
