/**
 * The workspace (`src/workspace.ts`): path safety, the per-file and total
 * limits (warn at 80%, refuse at 100%, never truncate), the usage line, the
 * edit refusals, delete, the listing format and the legacy-scratchpad
 * migration. Plain files in a temp directory; no sandbox.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FILE_MAX_CHARS,
  LISTING_FIRST_LINE_CHARS,
  NOTES_MAX_CHARS,
  SNIPPET_VOCABULARY,
  WORKSPACE_LISTING_HEADER,
  WORKSPACE_MAX_BYTES,
  Workspace,
  carryWorkspace,
  openRunWorkspace,
  renderNotes,
  renderWorkspaceContext,
  renderWorkspaceListing,
} from "../src/workspace";

function fresh(): Workspace {
  return new Workspace(join(mkdtempSync(join(tmpdir(), "wrathbench-ws-")), "workspace"));
}

function ok(r: { ok: boolean; text?: string; error?: string }): string {
  if (!r.ok) throw new Error(`expected ok, got: ${(r as { error: string }).error}`);
  return (r as { text: string }).text;
}

function refused(r: { ok: boolean; text?: string; error?: string }): string {
  if (r.ok) throw new Error(`expected a refusal, got: ${(r as { text: string }).text}`);
  return (r as { error: string }).error;
}

describe("workspace: the directory", () => {
  test("a new workspace holds an empty notes.md", () => {
    const ws = fresh();
    expect(readFileSync(join(ws.dir, "notes.md"), "utf8")).toBe("");
    expect(ws.list()).toEqual([{ path: "notes.md", bytes: 0, firstLine: "" }]);
  });

  test("an empty file is allowed", () => {
    const ws = fresh();
    expect(ok(ws.write("empty.ts", ""))).toContain("created empty.ts");
    expect(ws.list().find((f) => f.path === "empty.ts")).toEqual({ path: "empty.ts", bytes: 0, firstLine: "" });
  });
});

describe("workspace: path safety", () => {
  const ws = fresh();

  test("relative paths are normalised", () => {
    expect(ok(ws.write("./lib//util.ts", "export const a = 1;\n"))).toContain("created lib/util.ts");
    expect(ok(ws.read("lib/./util.ts"))).toBe("export const a = 1;\n");
  });

  test("`..` is refused, even when it would land back inside", () => {
    expect(refused(ws.write("../escape.ts", "x"))).toContain('"../escape.ts" contains ..');
    expect(refused(ws.write("lib/../notes.md", "x"))).toContain('"lib/../notes.md" contains ..');
    expect(refused(ws.read(".."))).toContain("contains ..");
    expect(existsSync(join(ws.dir, "..", "escape.ts"))).toBe(false);
  });

  test("absolute paths are refused, naming the path", () => {
    expect(refused(ws.write("/etc/passwd", "x"))).toBe(
      'path "/etc/passwd" is absolute; paths are relative to the workspace, e.g. notes.md or lib/util.ts',
    );
    expect(refused(ws.read("~/x"))).toContain("is absolute");
    expect(refused(ws.read("C:/x"))).toContain("is absolute");
  });

  test("backslashes, control characters, empty paths and directories are refused", () => {
    expect(refused(ws.write("lib\\x.ts", "x"))).toContain("the separator is /");
    expect(refused(ws.write("a\nb", "x"))).toContain("control character");
    expect(refused(ws.write("", "x"))).toContain("path is empty");
    expect(refused(ws.write(".", "x"))).toContain("names the workspace itself");
    expect(refused(ws.write("lib/", "x"))).toContain("names a directory");
    expect(refused(ws.write("lib", "x"))).toBe("lib is a directory, not a file");
    expect(refused(ws.read("lib"))).toContain("lib is a directory");
    expect(refused(ws.write(42, "x"))).toContain("path must be a string");
  });

  test("a file cannot be a directory for another", () => {
    expect(refused(ws.write("lib/util.ts/inner.ts", "x"))).toBe(
      "lib/util.ts is a file, so lib/util.ts/inner.ts cannot be created under it",
    );
  });

  test("a missing file is named", () => {
    expect(refused(ws.read("nope.ts"))).toBe("no such file in the workspace: nope.ts");
  });
});

describe("workspace: limits — warn at 80%, refuse at 100%, never truncate", () => {
  test("notes.md: under 80% is quiet, above 80% warns, above the limit is refused and nothing is written", () => {
    const ws = fresh();
    const quiet = ok(ws.write("notes.md", "a".repeat(1000)));
    expect(quiet).not.toContain("warning");
    expect(quiet.split("\n").at(-1)).toBe(`[3% — 1000/${NOTES_MAX_CHARS} chars]`);

    const high = ok(ws.write("notes.md", "b".repeat(26_000)));
    expect(high).toContain(`warning: notes.md is 26000/${NOTES_MAX_CHARS} chars (81% of its limit)`);
    expect(high.split("\n").at(-1)).toBe(`[81% — 26000/${NOTES_MAX_CHARS} chars]`);

    const over = refused(ws.write("notes.md", "c".repeat(NOTES_MAX_CHARS + 5)));
    expect(over).toBe(
      `notes.md would be ${NOTES_MAX_CHARS + 5} chars, over its ${NOTES_MAX_CHARS}-char limit; ` +
        `trim to under ${NOTES_MAX_CHARS} chars or move detail to another file. Nothing was written.`,
    );
    // Refused means untouched: the previous content stands, and nothing was cut.
    expect(ws.readNotes()).toBe("b".repeat(26_000));
  });

  test("exactly at the limit is allowed", () => {
    const ws = fresh();
    const at = ok(ws.write("lib/big.ts", "x".repeat(FILE_MAX_CHARS)));
    expect(at.split("\n").at(-1)).toBe(`[100% — ${FILE_MAX_CHARS}/${FILE_MAX_CHARS} chars]`);
  });

  test("an edit is held to the same limit as a write", () => {
    const ws = fresh();
    ok(ws.write("lib/a.ts", `${"x".repeat(FILE_MAX_CHARS - 10)}TAIL`));
    const over = refused(ws.edit("lib/a.ts", "TAIL", "T".repeat(20)));
    expect(over).toContain(`lib/a.ts would be ${FILE_MAX_CHARS + 10} chars, over its ${FILE_MAX_CHARS}-char limit`);
    expect(ws.read("lib/a.ts")).toEqual({ ok: true, text: `${"x".repeat(FILE_MAX_CHARS - 10)}TAIL` });
  });

  test("the workspace total: usage shows it above 50%, warns above 80%, refuses past 1 MiB", () => {
    const ws = fresh();
    const chunk = "z".repeat(FILE_MAX_CHARS);
    const per = Buffer.byteLength(chunk);
    // Up to just over half the total: the usage line starts naming it.
    let i = 0;
    let last = "";
    while ((i + 1) * per <= WORKSPACE_MAX_BYTES * 0.5) last = ok(ws.write(`f${String(i++).padStart(2, "0")}.txt`, chunk));
    expect(last.split("\n").at(-1)).not.toContain("workspace");
    last = ok(ws.write(`f${String(i++).padStart(2, "0")}.txt`, chunk));
    const total1 = i * per;
    expect(last.split("\n").at(-1)).toBe(
      `[100% — ${FILE_MAX_CHARS}/${FILE_MAX_CHARS} chars; workspace ${Math.floor((100 * total1) / WORKSPACE_MAX_BYTES)}% — ${total1}/${WORKSPACE_MAX_BYTES} bytes]`,
    );
    expect(last).not.toContain("warning: the workspace");
    // Past 80% of the total: a warning with size and limit.
    while ((i + 1) * per <= WORKSPACE_MAX_BYTES * 0.8) ok(ws.write(`f${String(i++).padStart(2, "0")}.txt`, chunk));
    last = ok(ws.write(`f${String(i++).padStart(2, "0")}.txt`, chunk));
    expect(last).toContain(`warning: the workspace is ${i * per}/${WORKSPACE_MAX_BYTES} bytes`);
    // Fill to the edge, then one more is refused whole.
    while ((i + 1) * per <= WORKSPACE_MAX_BYTES) ok(ws.write(`f${String(i++).padStart(2, "0")}.txt`, chunk));
    const over = refused(ws.write("one-more.txt", chunk));
    expect(over).toBe(
      `the workspace would total ${i * per + per} bytes, over its ${WORKSPACE_MAX_BYTES}-byte limit; ` +
        `trim or delete files to get under ${WORKSPACE_MAX_BYTES} bytes. Nothing was written.`,
    );
    expect(existsSync(join(ws.dir, "one-more.txt"))).toBe(false);
    // Replacing a file counts its old size out: a same-size rewrite still fits.
    expect(ok(ws.write("f00.txt", "y".repeat(FILE_MAX_CHARS)))).toContain("wrote f00.txt");
  });
});

describe("workspace: edit", () => {
  test("replaces one exact occurrence and reports it", () => {
    const ws = fresh();
    ok(ws.write("notes.md", "# plan\n- [ ] train\n"));
    const res = ok(ws.edit("notes.md", "- [ ] train", "- [x] train"));
    expect(res.split("\n")[0]).toBe("edited notes.md (1 replacement)");
    expect(res.split("\n").at(-1)).toMatch(/^\[0% — \d+\/32000 chars\]$/);
    expect(ws.readNotes()).toBe("# plan\n- [x] train\n");
  });

  test("refuses an empty old_string", () => {
    const ws = fresh();
    expect(refused(ws.edit("notes.md", "", "x"))).toBe(
      "old_string is empty, so there is nothing to match; to replace a whole file use write_file",
    );
  });

  test("refuses old_string identical to new_string", () => {
    const ws = fresh();
    ok(ws.write("notes.md", "same"));
    expect(refused(ws.edit("notes.md", "same", "same"))).toBe(
      "old_string and new_string are identical, so this edit would change nothing",
    );
  });

  test("refuses a miss, saying it must match exactly including whitespace", () => {
    const ws = fresh();
    ok(ws.write("lib/a.ts", "export const a = 1;\n"));
    const miss = refused(ws.edit("lib/a.ts", "export const a =  1;", "x"));
    expect(miss).toContain("old_string was not found in lib/a.ts; it must match exactly, including whitespace and line breaks");
    // No fuzzy fallback: a near miss changes nothing.
    expect(ws.read("lib/a.ts")).toEqual({ ok: true, text: "export const a = 1;\n" });
  });

  test("refuses an ambiguous match, listing the 1-based line of every occurrence", () => {
    const ws = fresh();
    ok(ws.write("lib/a.ts", "foo\nbar\nfoo\n\nbaz foo\n"));
    expect(refused(ws.edit("lib/a.ts", "foo", "qux"))).toBe(
      "old_string occurs 3 times in lib/a.ts, at lines 1, 3, 5; " +
        "include more surrounding text so it matches exactly once, or pass replace_all: true",
    );
    expect(refused(ws.edit("lib/a.ts", "foo", "qux", false, SNIPPET_VOCABULARY))).toContain("pass replace_all = true");
  });

  test("replace_all replaces every occurrence", () => {
    const ws = fresh();
    ok(ws.write("lib/a.ts", "foo\nbar\nfoo\n"));
    expect(ok(ws.edit("lib/a.ts", "foo", "$&qux", true)).split("\n")[0]).toBe("edited lib/a.ts (2 replacements)");
    // Plain strings: `$&` in the replacement is text, not a pattern.
    expect(ws.read("lib/a.ts")).toEqual({ ok: true, text: "$&qux\nbar\n$&qux\n" });
  });

  test("no argument coercion: replace_all must be a boolean", () => {
    const ws = fresh();
    ok(ws.write("lib/a.ts", "foo foo"));
    expect(refused(ws.edit("lib/a.ts", "foo", "bar", "true"))).toBe("replace_all must be true or false, got string");
  });

  test("an edit to a file that does not exist says to create it", () => {
    const ws = fresh();
    expect(refused(ws.edit("lib/none.ts", "a", "b"))).toBe("lib/none.ts does not exist; create it with write_file");
  });
});

describe("workspace: delete", () => {
  test("removes a file and prunes the directories it leaves empty", () => {
    const ws = fresh();
    ok(ws.write("lib/deep/a.ts", "export {};\n"));
    expect(ok(ws.delete("lib/deep/a.ts"))).toBe("deleted lib/deep/a.ts (11 bytes)");
    expect(existsSync(join(ws.dir, "lib"))).toBe(false);
    expect(existsSync(ws.dir)).toBe(true);
  });

  test("refuses an absent file", () => {
    const ws = fresh();
    expect(refused(ws.delete("gone.ts"))).toBe("no such file in the workspace: gone.ts");
  });

  test("notes.md may be emptied but not deleted", () => {
    const ws = fresh();
    ok(ws.write("notes.md", "x"));
    expect(refused(ws.delete("notes.md"))).toBe("notes.md cannot be deleted; empty it with write_file instead");
    expect(refused(ws.delete("./notes.md"))).toContain("cannot be deleted");
    expect(ok(ws.write("notes.md", ""))).toContain("wrote notes.md");
    expect(ws.readNotes()).toBe("");
  });
});

describe("workspace: versions", () => {
  test("every change bumps the version and tells the listeners; refusals do not", () => {
    const ws = fresh();
    const seen: number[] = [];
    ws.onChange((v) => seen.push(v));
    ok(ws.write("a.ts", "1"));
    ok(ws.edit("a.ts", "1", "2"));
    refused(ws.edit("a.ts", "nope", "3"));
    ok(ws.delete("a.ts"));
    refused(ws.write("../x", "y"));
    expect(seen).toEqual([1, 2, 3]);
    expect(ws.version).toBe(3);
  });
});

describe("workspace: the listing and the notes block", () => {
  test("header, one line per file sorted by path, first line trimmed and capped", () => {
    const ws = fresh();
    ok(ws.write("notes.md", "  # Plan  \n- level up\n"));
    ok(ws.write("lib/nav.ts", "// walking helpers\nexport {};\n"));
    ok(ws.write("Zeta.md", "z\n"));
    ok(ws.write("empty.ts", ""));
    ok(ws.write("long.md", `${"L".repeat(300)}\nsecond`));
    const files = ws.list();
    expect(files.map((f) => f.path)).toEqual(["Zeta.md", "empty.ts", "lib/nav.ts", "long.md", "notes.md"]);
    const long = files.find((f) => f.path === "long.md")!;
    expect(long.firstLine.length).toBe(LISTING_FIRST_LINE_CHARS);
    expect(long.firstLine.endsWith("…")).toBe(true);
    expect(renderWorkspaceListing(files)).toBe(
      [
        "<workspace>",
        WORKSPACE_LISTING_HEADER,
        "Zeta.md  2 bytes  z",
        "empty.ts  0 bytes",
        "lib/nav.ts  30 bytes  // walking helpers",
        `long.md  307 bytes  ${"L".repeat(LISTING_FIRST_LINE_CHARS - 1)}…`,
        "notes.md  22 bytes  # Plan",
        "</workspace>",
      ].join("\n"),
    );
  });

  test("notes are verbatim inside a tag carrying their usage", () => {
    expect(renderNotes("# Plan\n- a\n")).toBe('<notes path="notes.md" usage="0% 11/32000">\n# Plan\n- a\n</notes>');
    expect(renderNotes("no newline")).toBe('<notes path="notes.md" usage="0% 10/32000">\nno newline\n</notes>');
    expect(renderNotes("")).toBe('<notes path="notes.md" usage="0% 0/32000">\n</notes>');
    expect(renderNotes("n".repeat(16_000))).toContain('usage="50% 16000/32000"');
  });

  test("the context block is the listing, a blank line, then the notes — pure and byte-stable", () => {
    const view = {
      files: [
        { path: "lib/a.ts", bytes: 12, firstLine: "export {};" },
        { path: "notes.md", bytes: 6, firstLine: "# Plan" },
      ],
      notes: "# Plan",
    };
    const a = renderWorkspaceContext(view);
    expect(renderWorkspaceContext(structuredClone(view))).toBe(a);
    expect(a).toBe(
      `<workspace>\n${WORKSPACE_LISTING_HEADER}\nlib/a.ts  12 bytes  export {};\nnotes.md  6 bytes  # Plan\n</workspace>\n\n` +
        '<notes path="notes.md" usage="0% 6/32000">\n# Plan\n</notes>',
    );
  });
});

describe("workspace: runs before the workspace, and continuations", () => {
  test("a pre-workspace run's scratchpad seeds notes.md, without the old truncation marker", () => {
    const runDir = mkdtempSync(join(tmpdir(), "wrathbench-ws-legacy-"));
    writeFileSync(join(runDir, "scratchpad.md"), `${"p".repeat(NOTES_MAX_CHARS)}\n\n[scratchpad truncated at ${NOTES_MAX_CHARS} chars]`);
    const ws = openRunWorkspace(runDir);
    expect(ws.readNotes()).toBe("p".repeat(NOTES_MAX_CHARS));
    // The pad is left where it was; a second open does not re-seed over newer notes.
    expect(existsSync(join(runDir, "scratchpad.md"))).toBe(true);
    ok(ws.write("notes.md", "newer"));
    expect(openRunWorkspace(runDir).readNotes()).toBe("newer");
  });

  test("a continuation carries the whole workspace, or the predecessor's scratchpad as notes.md", () => {
    const pred = mkdtempSync(join(tmpdir(), "wrathbench-ws-pred-"));
    const predWs = openRunWorkspace(pred);
    ok(predWs.write("notes.md", "# carried\n"));
    ok(predWs.write("lib/nav.ts", "export const n = 1;\n"));
    const next = openRunWorkspace(mkdtempSync(join(tmpdir(), "wrathbench-ws-next-")));
    expect(carryWorkspace(next, pred)).toBe(true);
    expect(next.list().map((f) => f.path)).toEqual(["lib/nav.ts", "notes.md"]);
    expect(next.readNotes()).toBe("# carried\n");

    const legacy = mkdtempSync(join(tmpdir(), "wrathbench-ws-oldpred-"));
    writeFileSync(join(legacy, "scratchpad.md"), "# old pad\n");
    const next2 = openRunWorkspace(mkdtempSync(join(tmpdir(), "wrathbench-ws-next2-")));
    expect(carryWorkspace(next2, legacy)).toBe(true);
    expect(next2.readNotes()).toBe("# old pad\n");

    const empty = mkdtempSync(join(tmpdir(), "wrathbench-ws-nopred-"));
    const next3 = openRunWorkspace(mkdtempSync(join(tmpdir(), "wrathbench-ws-next3-")));
    expect(carryWorkspace(next3, empty)).toBe(false);
  });

  test("clear empties the workspace in place: the root directory survives", () => {
    const ws = fresh();
    ok(ws.write("lib/a.ts", "x"));
    ok(ws.write("notes.md", "y"));
    mkdirSync(join(ws.dir, "stray"));
    ws.clear();
    expect(existsSync(ws.dir)).toBe(true);
    expect(ws.list()).toEqual([{ path: "notes.md", bytes: 0, firstLine: "" }]);
  });
});
