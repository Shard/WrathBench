import { describe, expect, test } from "bun:test";
import type { WorkspaceFileView } from "../src/api/client";
import { fileReading, isCode, openFile } from "../src/lib/workspace";

const file = (path: string, bytes = 10, mtime = 1): WorkspaceFileView => ({ path, bytes, mtime, firstLine: "" });
const FILES = [file("notes.md"), file("lib/camp.ts"), file("plan.md")];

describe("openFile", () => {
  test("notes.md unless something else was picked; a pick that is gone falls back to notes.md", () => {
    expect(openFile(FILES, undefined)?.path).toBe("notes.md");
    expect(openFile(FILES, "lib/camp.ts")?.path).toBe("lib/camp.ts");
    expect(openFile(FILES, "lib/deleted.ts")?.path).toBe("notes.md");
  });

  test("a listing without notes.md opens its first file; an empty one opens nothing", () => {
    expect(openFile([file("a.md"), file("b.ts")], undefined)?.path).toBe("a.md");
    expect(openFile([], "notes.md")).toBeUndefined();
  });
});

describe("fileReading", () => {
  test("moves with the size or the mtime, and stays put otherwise", () => {
    const base = fileReading(file("notes.md", 10, 1));
    expect(fileReading(file("notes.md", 10, 1))).toBe(base);
    expect(fileReading(file("notes.md", 11, 1))).not.toBe(base);
    expect(fileReading(file("notes.md", 10, 2))).not.toBe(base);
    expect(fileReading(file("plan.md", 10, 1))).not.toBe(base);
  });
});

describe("isCode", () => {
  test("a TypeScript module is code; notes and everything else are text", () => {
    expect(isCode("lib/camp.ts")).toBe(true);
    expect(isCode("notes.md")).toBe(false);
    expect(isCode("data.json")).toBe(false);
  });
});
