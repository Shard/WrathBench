/**
 * The workspace from inside the real, Landlock-confined snippet child: import
 * statements resolve against it, an edited file (or one it imports) is fresh
 * on the next import, the ambient `files` object writes through the host, the
 * child can read the directory but write nothing, and the first result from a
 * new sandbox process begins with the state-reset notice. No game stack.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SandboxHost, STATE_RESET_NOTICE } from "../src/sandbox/host";
import { Workspace } from "../src/workspace";

const hosts: SandboxHost[] = [];

function makeHost(opts: Partial<ConstructorParameters<typeof SandboxHost>[0]> = {}): { host: SandboxHost; ws: Workspace } {
  const ws = opts.workspace ?? new Workspace(join(mkdtempSync(join(tmpdir(), "wrathbench-sbxws-")), "workspace"));
  const host = new SandboxHost({
    moduleUrl: "http://worldserver:8086",
    token: "test-token",
    workspace: ws,
    snippetTimeoutMs: 5_000,
    pingGraceMs: 1_000,
    ...opts,
  });
  hosts.push(host);
  return { host, ws };
}

afterEach(async () => {
  await Promise.all(hosts.splice(0, hosts.length).map((h) => h.stop()));
});

function write(ws: Workspace, path: string, content: string): void {
  const r = ws.write(path, content);
  if (!r.ok) throw new Error(r.error);
}

describe("snippet imports", () => {
  test("each specifier form resolves against the workspace: ./x, ./x.ts, x, x.ts, nested", async () => {
    const { host, ws } = makeHost();
    write(ws, "util.ts", "export const one = 1;\nexport default 10;\n");
    write(ws, "lib/deep/two.ts", "export const two = 2;\n");
    const res = await host.evalSnippet(
      [
        'import { one } from "./util";',
        'import { one as uno } from "./util.ts";',
        'import ten from "util";',
        'import * as u from "util.ts";',
        'import { two } from "lib/deep/two";',
        'import { two as dos } from "./lib/deep/two.ts";',
        "return one + uno + ten + u.one + two + dos;",
      ].join("\n"),
    );
    expect(res.error).toBeUndefined();
    expect(res.value).toBe("17");
  });

  test("a single-expression snippet after its imports still returns its value", async () => {
    const { host, ws } = makeHost();
    write(ws, "util.ts", "export const double = (n: number) => n * 2;\n");
    const res = await host.evalSnippet('import { double } from "./util"\ndouble(21)');
    expect(res.value).toBe("42");
  });

  test("type-only imports are dropped, as in a TypeScript file", async () => {
    const { host, ws } = makeHost();
    write(ws, "types.ts", "export interface Plan { steps: number }\nexport const plan = { steps: 3 };\n");
    const res = await host.evalSnippet(
      'import type { Plan } from "./types";\nimport { Plan as P2, plan } from "./types";\nconst p: Plan = plan; const q: P2 = plan;\nreturn p.steps + q.steps;',
    );
    expect(res.error).toBeUndefined();
    expect(res.value).toBe("6");
  });

  test("node builtins keep working, as a statement and as a dynamic import", async () => {
    const { host } = makeHost();
    const res = await host.evalSnippet(
      'import { join } from "node:path";\nconst p = await import("node:path");\nreturn join("a", "b") + p.basename("/x/y");',
    );
    expect(res.value).toBe('"a/by"');
  });

  test("a missing file and a missing export are errors naming the path", async () => {
    const { host, ws } = makeHost();
    const missing = await host.evalSnippet('import { go } from "./lib/nav";\ngo()');
    expect(missing.ok).toBe(false);
    expect(missing.error).toContain('import "./lib/nav": no such file in the workspace (looked for lib/nav.ts, lib/nav.tsx');

    write(ws, "lib/nav.ts", "export const walk = 1;\n");
    const noExport = await host.evalSnippet('import { go } from "./lib/nav";\ngo()');
    expect(noExport.ok).toBe(false);
    expect(noExport.error).toBe('SyntaxError: lib/nav.ts has no export named "go"');

    // One level down, the loader's own errors, with workspace-relative paths.
    write(ws, "a.ts", 'import { gone } from "./b";\nexport const a = gone;\n');
    write(ws, "b.ts", "export const here = 1;\n");
    const nested = await host.evalSnippet('import { a } from "./a";\na');
    expect(nested.ok).toBe(false);
    expect(nested.error).toContain("gone");
    expect(nested.error).toContain("b.ts");
    expect(nested.error).not.toContain(ws.dir);
    expect(nested.error).not.toContain("?v=");

    write(ws, "c.ts", 'import { x } from "./nowhere";\nexport const c = x;\n');
    const nestedMissing = await host.evalSnippet('import { c } from "./c";\nc');
    expect(nestedMissing.ok).toBe(false);
    expect(nestedMissing.error).toContain("./nowhere");
    expect(nestedMissing.error).not.toContain(ws.dir);
  });

  test("a module's own undefined name is its error, reported once and never retried", async () => {
    const { host, ws } = makeHost();
    write(ws, "bad.ts", 'console.log("bad.ts ran");\nexport const x = neverImported + 1;\n');
    const res = await host.evalSnippet('import { x } from "./bad";\nx');
    expect(res.ok).toBe(false);
    expect(res.error).toBe("ReferenceError: neverImported is not defined");
    // The module's top-level code ran exactly once: no second graph was loaded.
    expect(res.logs.filter((l) => l.text === "bad.ts ran")).toHaveLength(1);
  });

  test("the import helper is not part of the ambient surface a snippet enumerates", async () => {
    const { host } = makeHost();
    expect((await host.evalSnippet("Object.keys(globalThis).includes('__wrathbench_import__')")).value).toBe("false");
  });

  test("an absolute or escaping specifier is refused", async () => {
    const { host } = makeHost();
    expect((await host.evalSnippet('import x from "/etc/passwd";\nx')).error).toContain(
      'import "/etc/passwd": imports name workspace files by relative path',
    );
    expect((await host.evalSnippet('import x from "../x";\nx')).error).toContain('import "../x": .. would leave the workspace');
  });

  test("an edit reaches the next import, transitively: a.ts imports b.ts, b.ts changes", async () => {
    const { host, ws } = makeHost();
    write(ws, "a.ts", 'import { b } from "./b";\nexport const a = () => `a+${b}`;\n');
    write(ws, "b.ts", 'export const b = "one";\n');
    expect((await host.evalSnippet('import { a } from "./a";\na()')).value).toBe('"a+one"');
    // Through the tool path: the host announces the new version to the child.
    const r = ws.edit("b.ts", '"one"', '"two"');
    expect(r.ok).toBe(true);
    expect((await host.evalSnippet('import { a } from "./a";\na()')).value).toBe('"a+two"');
  });

  test("a notes.md edit keeps the loaded modules; a .ts edit loads them afresh", async () => {
    const { host, ws } = makeHost();
    write(ws, "counter.ts", "let n = 0;\nexport const next = () => ++n;\n");
    const bump = 'import { next } from "./counter";\nnext()';
    expect((await host.evalSnippet(bump)).value).toBe("1");
    expect((await host.evalSnippet(bump)).value).toBe("2");
    // Text changes, by tool and by snippet: the same module instance answers.
    expect(ws.write("notes.md", "# plan\n").ok).toBe(true);
    await host.evalSnippet('await files.edit("notes.md", "# plan", "# plan, revised")');
    expect((await host.evalSnippet(bump)).value).toBe("3");
    // A code change: a new module, its state started over.
    expect(ws.edit("counter.ts", "let n = 0;", "let n = 100;").ok).toBe(true);
    expect((await host.evalSnippet(bump)).value).toBe("101");
  });

  test("notes.md is read, not imported", async () => {
    const { host, ws } = makeHost();
    write(ws, "notes.md", "# plan\n");
    const res = await host.evalSnippet('import notes from "./notes.md";\nnotes');
    expect(res.error).toContain('import "./notes.md": only code and JSON files can be imported');
  });

  test("files.write then import in one snippet sees the new code", async () => {
    const { host, ws } = makeHost();
    write(ws, "v.ts", "export const v = 1;\n");
    expect((await host.evalSnippet('import { v } from "./v";\nv')).value).toBe("1");
    const res = await host.evalSnippet('await files.write("v.ts", "export const v = 2;\\n");\nreturn (await files.read("v.ts")).trim();');
    expect(res.value).toBe('"export const v = 2;"');
    expect((await host.evalSnippet('import { v } from "./v";\nv')).value).toBe("2");
    // Within one snippet: the statement imports ran first (v = 2); the write
    // lands, and an import made after it gets the new module.
    const same = await host.evalSnippet(
      'import { v } from "./v";\nawait files.write("v.ts", "export const v = 3;\\n");\nconst { v: after } = await import(' +
        JSON.stringify(join(ws.dir, "v.ts")) +
        ");\nreturn [v, after];",
    );
    expect(same.value).toBe("[ 2, 3 ]");
  });
});

describe("dynamic import() of a workspace file", () => {
  // Found live: a model's background routine did `await import("./lib/combat")`,
  // which resolved against the sandbox's own entry module and failed naming the
  // harness path, as an unhandled rejection.
  const COMBAT = 'export const kill = (guid: string) => `kill ${guid}`;\nexport const tag = Symbol("combat");\n';

  test("the static and the dynamic form load the same module", async () => {
    const { host, ws } = makeHost();
    write(ws, "lib/combat.ts", COMBAT);
    const res = await host.evalSnippet(
      'import * as statically from "./lib/combat";\nconst dynamically = await import("./lib/combat");\nreturn [dynamically === statically, dynamically.kill("7")];',
    );
    expect(res.error).toBeUndefined();
    expect(res.value).toBe('[ true, "kill 7" ]');
    // Every spelling a statement accepts, dynamically too.
    const forms = await host.evalSnippet(
      'const a = await import("lib/combat"); const b = await import("./lib/combat.ts"); const c = await import("lib/combat.ts");\nreturn a === b && b === c;',
    );
    expect(forms.value).toBe("true");
  });

  test("a dynamic import inside a background routine works", async () => {
    const { host, ws } = makeHost();
    write(ws, "lib/combat.ts", COMBAT);
    const launched = await host.evalSnippet(
      'void (async () => { await sleep(50, { wake: false }); const { kill } = await import("./lib/combat"); console.log("routine:", kill("9")); })(); "started"',
    );
    expect(launched.ok).toBe(true);
    await Bun.sleep(300);
    const next = await host.evalSnippet("1");
    expect(next.logs.map((l) => l.text)).toContain("routine: kill 9");
    expect(host.drainNotices().filter((n) => n.text.includes("unhandled"))).toEqual([]);
  });

  test("a file the snippet wrote a line earlier is found, and an edit is seen fresh", async () => {
    const { host } = makeHost();
    const res = await host.evalSnippet(
      'await files.write("gen.ts", "export const g = 1;\\n");\nconst first = (await import("./gen")).g;\nawait files.write("gen.ts", "export const g = 2;\\n");\nreturn [first, (await import("./gen")).g];',
    );
    expect(res.value).toBe("[ 1, 2 ]");
  });

  test("a missing file is the clear path-naming error, never the harness path — in a snippet and in a routine", async () => {
    const { host, ws } = makeHost();
    const direct = await host.evalSnippet('await import("./lib/nope")');
    expect(direct.ok).toBe(false);
    expect(direct.error).toBe(
      'ImportError: import "./lib/nope": no such file in the workspace (looked for lib/nope.ts, lib/nope.tsx, lib/nope.js, lib/nope.mjs, lib/nope.jsx, lib/nope/index.ts, lib/nope/index.js)',
    );
    const escape = await host.evalSnippet('await import("../outside")');
    expect(escape.error).toBe('ImportError: import "../outside": .. would leave the workspace');

    await host.evalSnippet('void (async () => { await import("./lib/nope"); })(); "started"');
    await Bun.sleep(300);
    const next = await host.evalSnippet("1");
    const said = [...next.logs.map((l) => l.text), ...host.drainNotices().map((n) => n.text)].join("\n");
    expect(said).toContain('import "./lib/nope": no such file in the workspace');
    for (const text of [direct.error ?? "", escape.error ?? "", said]) {
      expect(text).not.toContain("entry.ts");
      expect(text).not.toContain("runner/src");
      expect(text).not.toContain(ws.dir);
    }
  });

  test("node builtins and computed specifiers are left as written; a computed miss still names no harness path", async () => {
    const { host, ws } = makeHost();
    write(ws, "lib/combat.ts", COMBAT);
    expect((await host.evalSnippet('(await import("node:path")).join("a", "b")')).value).toBe('"a/b"');
    const computed = await host.evalSnippet('const p = "./lib/combat";\nawait import(p)');
    expect(computed.ok).toBe(false);
    expect(computed.error).not.toContain("entry.ts");
    expect(computed.error).toContain("your snippet");
  });
});

describe("a workspace module and the snippet that calls it", () => {
  test("see the same ambient objects, and the module reads the calling snippet's signal", async () => {
    const { host, ws } = makeHost();
    write(
      ws,
      "lib/probe.ts",
      [
        "declare const sdk: unknown, state: unknown, events: unknown, sleep: unknown, signal: AbortSignal;",
        "export function bindings(callerSignal: AbortSignal) {",
        "  const g = globalThis as Record<string, unknown>;",
        "  return [sdk === g.sdk, state === g.state, events === g.events, sleep === g.sleep, signal === callerSignal, signal.aborted];",
        "}",
      ].join("\n"),
    );
    const res = await host.evalSnippet('import { bindings } from "./lib/probe";\nreturn bindings(signal);');
    expect(res.error).toBeUndefined();
    expect(res.value).toBe("[ true, true, true, true, true, false ]");
  });
});

describe("the files object", () => {
  test("read, write, edit, delete and list go through the host with the tools' rules", async () => {
    const { host, ws } = makeHost();
    const w = await host.evalSnippet('await files.write("lib/a.ts", "export const a = 1;\\n")');
    expect(w.value).toBe('"created lib/a.ts\\n[0% — 20/32000 chars]"');
    expect(ws.read("lib/a.ts")).toEqual({ ok: true, text: "export const a = 1;\n" });
    const e = await host.evalSnippet('await files.edit("lib/a.ts", "1", "2")');
    expect(e.value).toContain("edited lib/a.ts (1 replacement)");
    expect((await host.evalSnippet('await files.read("lib/a.ts")')).value).toBe('"export const a = 2;\\n"');
    expect((await host.evalSnippet("await files.list()")).value).toBe(
      '[\n  {\n    path: "lib/a.ts",\n    bytes: 20,\n  }, {\n    path: "notes.md",\n    bytes: 0,\n  }\n]',
    );
    const d = await host.evalSnippet('await files.delete("lib/a.ts")');
    expect(d.value).toBe('"deleted lib/a.ts (20 bytes)"');

    // A refusal rejects with the same sentence, named for the snippet API.
    const bad = await host.evalSnippet('await files.write("../x", "y")');
    expect(bad.ok).toBe(false);
    expect(bad.error).toBe('Error: files.write: path "../x" contains ..; paths stay inside the workspace');
    const amb = await host.evalSnippet('await files.write("n.md", "x\\nx\\n"); await files.edit("n.md", "x", "y")');
    expect(amb.error).toContain("files.edit: old_string occurs 2 times in n.md, at lines 1, 2");
    expect(amb.error).toContain("replace_all = true");
    const notes = await host.evalSnippet('await files.delete("notes.md")');
    expect(notes.error).toContain("notes.md cannot be deleted; empty it with files.write instead");
  });

  test("the child reads the workspace but cannot write it — the runner is the only writer", async () => {
    const { host, ws } = makeHost();
    write(ws, "notes.md", "# mine\n");
    const read = await host.evalSnippet(
      `(await import("node:fs")).readFileSync(${JSON.stringify(join(ws.dir, "notes.md"))}, "utf8")`,
    );
    expect(read.value).toBe('"# mine\\n"');
    const direct = await host.evalSnippet(
      `try { (await import("node:fs")).writeFileSync(${JSON.stringify(join(ws.dir, "notes.md"))}, "pwned"); return "WROTE"; } catch (e) { return e.code; }`,
    );
    expect(direct.value).toBe('"EACCES"');
    const create = await host.evalSnippet(
      `try { (await import("node:fs")).writeFileSync(${JSON.stringify(join(ws.dir, "new.ts"))}, "x"); return "WROTE"; } catch (e) { return e.code; }`,
    );
    expect(create.value).toBe('"EACCES"');
    expect(ws.readNotes()).toBe("# mine\n");
  });
});

describe("the state-reset notice", () => {
  test("a fresh run's first result has none; after a restart the next result begins with it, once", async () => {
    const { host } = makeHost({ snippetTimeoutMs: 400, pingGraceMs: 300 });
    const first = await host.evalSnippet("1");
    expect(first.resetNotice).toBeUndefined();
    // Blocks the event loop: the host kills and respawns the child. The
    // snippet that caused it is told in its own error, not by the notice.
    const blocked = await host.evalSnippet("const t = Date.now(); while (Date.now() - t < 3000) {}");
    expect(blocked.restarted).toBe(true);
    expect(blocked.resetNotice).toBeUndefined();
    const next = await host.evalSnippet("2");
    expect(next.resetNotice).toBe(STATE_RESET_NOTICE);
    const after = await host.evalSnippet("3");
    expect(after.resetNotice).toBeUndefined();
  });

  test("a resumed run's first result begins with it", async () => {
    const { host } = makeHost({ resumed: true });
    expect((await host.evalSnippet("1")).resetNotice).toBe(STATE_RESET_NOTICE);
    expect((await host.evalSnippet("1")).resetNotice).toBeUndefined();
  });

  test("an unexpected exit sets it for the next result from the new process", async () => {
    const { host } = makeHost();
    await host.evalSnippet("1");
    const died = await host.evalSnippet("setTimeout(() => process.exit(3), 10); await sleep(2000, { wake: false })");
    expect(died.ok).toBe(false);
    await Bun.sleep(300);
    expect((await host.evalSnippet("4")).resetNotice).toBe(STATE_RESET_NOTICE);
  });

  test("the notice is one line and never mentions globalThis", () => {
    expect(STATE_RESET_NOTICE).not.toContain("\n");
    expect(STATE_RESET_NOTICE).not.toContain("globalThis");
  });
});

describe("imports without a workspace file layer", () => {
  test("a snippet with no import statement is untouched by the import path", async () => {
    const { host, ws } = makeHost();
    writeFileSync(join(ws.dir, "x.ts"), "export const x = 1;\n");
    expect((await host.evalSnippet('const s = "import x from \\"./x\\""; return s.length')).value).toBe("19");
  });
});
