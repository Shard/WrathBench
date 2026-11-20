/**
 * A call's input read for drawing (`lib/toolargs.ts`): edits and writes under
 * every name the tools accept, one-line heads for small calls, and the JSON
 * kept wherever the args cannot be trusted whole.
 */

import { describe, expect, test } from "bun:test";
import { argsView, execOutput, fileChanges } from "../src/lib/toolargs";

describe("an edit", () => {
  test("the tools' own names, and every alias they accept", () => {
    expect(argsView("edit_file", { path: "main.ts", old: "a", new: "b" })).toEqual({ kind: "edit", path: "main.ts", old: "a", new: "b", replaceAll: false });
    expect(argsView("edit_file", { file_path: "lib/x.ts", old_string: "a", new_string: "b", replace_all: true })).toEqual({ kind: "edit", path: "lib/x.ts", old: "a", new: "b", replaceAll: true });
    expect(argsView("edit_file", { filePath: "x.ts", oldString: "a", newString: "b" })).toMatchObject({ path: "x.ts", old: "a", new: "b" });
    expect(argsView("edit_scratchpad", { old_text: "a", new_text: "b" })).toEqual({ kind: "edit", path: undefined, old: "a", new: "b", replaceAll: false });
    expect(argsView("edit_scratchpad", { search: "a", replace: "" })).toMatchObject({ kind: "edit", old: "a", new: "" });
  });

  test("args recorded as a JSON string are read the same", () => {
    expect(argsView("edit_file", JSON.stringify({ path: "main.ts", old: "a", new: "b" }))).toMatchObject({ kind: "edit", path: "main.ts" });
    expect(argsView("edit_file", "{not json")).toBeNull();
  });

  test("a capped side, or a record the viewer cut, keeps the JSON", () => {
    expect(argsView("edit_file", { path: "main.ts", old: "a", new: "b".repeat(10) + "\n… 550 more characters" })).toBeNull();
    expect(argsView("edit_file", { path: "main.ts", old: "a", new: "b" }, true)).toBeNull();
    expect(argsView("edit_file", { path: "main.ts", old: "a" })).toBeNull();
  });
});

describe("a write", () => {
  test("the file under its path, under the content's aliases", () => {
    expect(argsView("write_file", { path: "main.ts", content: "export {}" })).toEqual({ kind: "write", path: "main.ts", content: "export {}" });
    expect(argsView("write_scratchpad", { text: "# notes" })).toEqual({ kind: "write", path: undefined, content: "# notes" });
    // Capped, a file is still its first part, the marker saying how much more: unlike an edit, nothing reads wrong.
    expect(argsView("write_file", { path: "main.ts", content: "x\n… 201 more characters" }, true)).toEqual({ kind: "write", path: "main.ts", content: "x\n… 201 more characters" });
  });
});

describe("a small call on one line", () => {
  test("a wait, a routine and a read", () => {
    expect(argsView("yield", { seconds: 60 })).toEqual({ kind: "line", text: "1m" });
    expect(argsView("yield", { seconds: 90 })).toEqual({ kind: "line", text: "1m30s" });
    expect(argsView("yield", { seconds: 45 })).toEqual({ kind: "line", text: "45s" });
    expect(argsView("stop_routine", { name: "grind" })).toEqual({ kind: "line", text: "grind" });
    expect(argsView("start_routine", { name: "grind", args: { entries: [708], questId: 183, center: { x: -6222, y: 689, z: 386 }, radius: 120 } })).toEqual({
      kind: "line",
      text: "grind · entries=[708] · questId=183 · center={x=-6222 y=689 z=386} · radius=120",
    });
    expect(argsView("read_file", { path: "API.md", offset: 1, limit: 100 })).toEqual({ kind: "line", text: "API.md · offset=1 · limit=100" });
    expect(argsView("state_summary", {})).toEqual({ kind: "line", text: "" });
  });

  test("a value too long for a line keeps the JSON, or its words when it is the only one", () => {
    expect(argsView("start_routine", { name: "errand", args: { steps: [{ move: 1 }, { turnin: 2 }] } })).toBeNull();
    const status = "Grinding the safe Dun Morogh field (~110 XP/min, no deaths) toward level 11-12.";
    expect(argsView("log_status", { text: status })).toEqual({ kind: "text", text: status });
  });
});

describe("codex's own records", () => {
  test("an exec call's output, the text its script printed", () => {
    const out = JSON.stringify([{ type: "input_text", text: "Script completed\nOutput:\n" }, { type: "input_text", text: '{"ok":1}' }]);
    expect(execOutput(out)).toBe('Script completed\nOutput:\n\n{"ok":1}');
    expect(execOutput('[{"type":"input_text","text":"cut…')).toBeNull();
    expect(execOutput(undefined)).toBeNull();
  });

  test("a file_change item's changes", () => {
    expect(fileChanges(JSON.stringify({ id: "i", type: "file_change", changes: [{ path: "main.ts", kind: "update" }, { path: "lib/a.ts", kind: { type: "add" } }], status: "completed" }))).toEqual([
      { kind: "update", path: "main.ts" },
      { kind: "add", path: "lib/a.ts" },
    ]);
    expect(fileChanges(JSON.stringify({ type: "reasoning" }))).toBeNull();
    expect(fileChanges('{"type":"file_change","changes":[{"pa')).toBeNull();
  });
});
