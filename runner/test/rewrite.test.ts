import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  compileSnippet,
  extractImportStatements,
  extractPatternNames,
  importedBindingNames,
  resolveWorkspaceImport,
  scanTopLevelDeclarations,
  stampWorkspaceImports,
} from "../src/sandbox/rewrite";

describe("extractPatternNames", () => {
  test("object shorthand and renamed keys", () => {
    expect(extractPatternNames("{a, b: c}")).toEqual(["a", "c"]);
  });
  test("defaults bind the name, not the default expression", () => {
    expect(extractPatternNames("{a = other, b: c = 3}")).toEqual(["a", "c"]);
  });
  test("arrays and rest", () => {
    expect(extractPatternNames("[x, , y, ...rest]")).toEqual(["x", "y", "rest"]);
  });
  test("nested", () => {
    expect(extractPatternNames("{a: {b}, c: [d]}")).toEqual(["b", "d"]);
  });
});

describe("scanTopLevelDeclarations", () => {
  test("finds const/let/var/function/class at depth 0", () => {
    const { names } = scanTopLevelDeclarations(
      `const a = 1;\nlet b = { c: 2 };\nvar d = [3];\nfunction e() { const inner = 1; }\nclass F {}\nasync function g() {}`,
    );
    expect(names).toEqual(["a", "b", "d", "e", "F", "g"]);
  });
  test("ignores declarations inside blocks, strings, comments, templates", () => {
    const { names } = scanTopLevelDeclarations(
      `// const nope = 1
/* let nada = 2 */
const s = "const fake = 3";
const t = \`let alsoFake = \${(() => { const inner = 4; return inner; })()}\`;
if (true) { const scoped = 5; }`,
    );
    expect(names).toEqual(["s", "t"]);
  });
  test("destructuring at top level", () => {
    const { names } = scanTopLevelDeclarations(`const { x, y: z } = obj; let [p] = arr;`);
    expect(names).toEqual(["x", "z", "p"]);
  });
});

describe("compileSnippet", () => {
  test("strips TypeScript and rewrites simple declarations to global assignments", () => {
    const c = compileSnippet(`const n: number = 40 + 2;`);
    expect(c.js).not.toContain(": number");
    expect(c.names).toEqual(["n"]);
    // keyword stripped: the binding lives on globalThis, so later mutation
    // (e.g. from a routine) stays visible across snippets.
    expect(c.statementsBody).toContain("n = 42");
    expect(c.statementsBody).not.toContain("const n");
    expect(c.canTryExpression).toBe(false);
  });
  test("function/class/destructuring persist via guarded copy-back", () => {
    const c = compileSnippet(`function f() {}\nconst { a } = ({ a: 1 });\nlet noInit;`);
    expect(c.statementsBody).toContain(`globalThis["f"] = f`);
    expect(c.statementsBody).toContain(`globalThis["a"] = a`);
    expect(c.statementsBody).toContain(`globalThis["noInit"] = noInit`);
    expect(c.statementsBody).toContain("const { a }"); // destructuring kept as a declaration
  });
  test("for-loop declarations are not top-level and stay untouched", () => {
    const c = compileSnippet(`for (let i = 0; i < 3; i++) { console.log(i); }`);
    expect(c.statementsBody).toContain("let i = 0");
    expect(c.names).toEqual([]);
  });
  test("expression body wraps with newline padding (trailing comments safe)", () => {
    const c = compileSnippet("1 + 1 // done");
    expect(c.expressionBody.startsWith("return (\n")).toBe(true);
    expect(c.expressionBody.endsWith("\n);")).toBe(true);
  });
});

describe("import statements", () => {
  const ws = mkdtempSync(join(tmpdir(), "wrathbench-rw-"));
  mkdirSync(join(ws, "lib", "deep"), { recursive: true });
  writeFileSync(join(ws, "util.ts"), "export const one = 1;\n");
  writeFileSync(join(ws, "lib", "deep", "two.ts"), "export const two = 2;\n");
  writeFileSync(join(ws, "lib", "index.ts"), "export const idx = 0;\n");

  test("a snippet with no import statement compiles to exactly the bytes it always did", () => {
    for (const src of ["40 + 2", "const a = 1;\nreturn a;", 'const s = "import x from \\"./x\\"";', "await import(\"node:fs\")", "import.meta"]) {
      const wrapped = new Bun.Transpiler({ loader: "ts", target: "bun", deadCodeElimination: false }).transformSync(
        `const __wrathbench_snippet__ = async () => {\n${src}\n};`,
      );
      const js = wrapped.slice(wrapped.indexOf("{") + 1, wrapped.lastIndexOf("}"));
      expect(compileSnippet(src, { workspace: ws }).js).toBe(js);
      expect(compileSnippet(src, { workspace: ws })).toEqual(compileSnippet(src));
    }
  });

  test("only top-level import declarations are lifted: not import(), not import.meta, not strings or comments", () => {
    const src = [
      'import { one } from "./util";',
      "// import { no } from \"./comment\"",
      'const s = `import { no } from "./template"`;',
      'const d = await import("node:path");',
      "if (true) { const m = import.meta; }",
      "one",
    ].join("\n");
    const lifted = extractImportStatements(src);
    expect(lifted.imports.map((i) => i.text)).toEqual(['import { one } from "./util";']);
    // Blanked in place, line breaks kept, so later line numbers still match the user's.
    expect(lifted.body.split("\n")).toHaveLength(src.split("\n").length);
    expect(lifted.body.split("\n")[0]).toBe("");
  });

  test("multi-line imports with comments, attributes and no semicolon are lifted whole", () => {
    const src = 'import {\n  one, // the first\n  /* and */ one as uno,\n} from \'./util\'\nimport data from "./d.json" with { type: "json" }\none';
    const lifted = extractImportStatements(src);
    expect(lifted.imports.map((i) => i.text)).toEqual([
      "import { one, one as uno, } from './util'",
      'import data from "./d.json" with { type: "json" }',
    ]);
    expect(lifted.body).toBe("\n\n\n\n\none");
  });

  test("each specifier form resolves to the workspace file's absolute path", () => {
    for (const [spec, rel] of [
      ["./util", "util.ts"],
      ["./util.ts", "util.ts"],
      ["util", "util.ts"],
      ["util.ts", "util.ts"],
      ["lib/deep/two", "lib/deep/two.ts"],
      ["./lib/deep/two.ts", "lib/deep/two.ts"],
      ["./lib", "lib/index.ts"],
    ] as const) {
      expect(resolveWorkspaceImport(spec, ws)).toEqual({ abs: `${ws}/${rel}`, rel });
    }
    expect(resolveWorkspaceImport("node:fs", ws)).toBeNull();
    expect(() => resolveWorkspaceImport("./nope", ws)).toThrow(
      'import "./nope": no such file in the workspace (looked for nope.ts, nope.tsx, nope.js, nope.mjs, nope.jsx, nope/index.ts, nope/index.js)',
    );
    expect(() => resolveWorkspaceImport("/etc/passwd", ws)).toThrow("imports name workspace files by relative path");
    expect(() => resolveWorkspaceImport("../x", ws)).toThrow(".. would leave the workspace");
    expect(() => resolveWorkspaceImport("./util", undefined)).toThrow("this sandbox has no workspace to import from");
    // Text is read, not imported: its edits do not bump the import version.
    writeFileSync(join(ws, "notes.md"), "# plan\n");
    expect(() => resolveWorkspaceImport("./notes.md", ws)).toThrow(
      'import "./notes.md": only code and JSON files can be imported (.ts, .tsx, .mts, .cts, .js, .jsx, .mjs, .cjs, .json); read notes.md with files.read instead',
    );
    writeFileSync(join(ws, "data.json"), "{}");
    expect(resolveWorkspaceImport("./data.json", ws)).toEqual({ abs: `${ws}/data.json`, rel: "data.json" });
  });

  test("named, default, namespace and side-effect imports become awaited dynamic imports with checked exports", () => {
    const c = compileSnippet(
      [
        'import { one, one as uno } from "./util";',
        'import dflt, { two } from "lib/deep/two";',
        'import * as ns from "util.ts";',
        'import "./util";',
        "return one + uno + two + ns.one + (dflt ?? 0);",
      ].join("\n"),
      { workspace: ws },
    );
    const util = JSON.stringify(`${ws}/util.ts`);
    const two = JSON.stringify(`${ws}/lib/deep/two.ts`);
    expect(c.statementsBody).toContain(`const __wrathbench_import_0__ = await __wrathbench_import__(${util});`);
    expect(c.statementsBody).toContain('for (const __wrathbench_name__ of ["one","one"])');
    expect(c.statementsBody).toContain('throw new SyntaxError("util.ts has no export named " + JSON.stringify(__wrathbench_name__));');
    expect(c.statementsBody).toContain("const { one, \"one\": uno } = __wrathbench_import_0__;");
    expect(c.statementsBody).toContain(`const __wrathbench_import_1__ = await __wrathbench_import__(${two});`);
    expect(c.statementsBody).toContain("const dflt = __wrathbench_import_1__.default;");
    expect(c.statementsBody).toContain("const ns = __wrathbench_import_2__;");
    expect(c.statementsBody).toContain(`await __wrathbench_import__(${util});\n`);
    // Import bindings are the snippet's own: never copied back onto the global.
    expect(c.names).toEqual([]);
    expect(c.statementsBody).not.toContain('globalThis["one"]');
  });

  test("a pass-through specifier stays an ordinary dynamic import", () => {
    const c = compileSnippet('import { join } from "node:path";\nreturn join("a", "b");', { workspace: ws });
    expect(c.statementsBody).toContain('const __wrathbench_import_0__ = await import("node:path");');
  });

  test("importedBindingNames lists the local names a module's imports create", () => {
    const src = [
      'import { a, b as c, type T } from "./x";',
      "import d, { e } from './y';",
      'import * as ns from "./z";',
      'import "./side";',
      'const s = await import("./dyn");',
      'export { f } from "./re";',
    ].join("\n");
    const names = importedBindingNames(src);
    for (const n of ["a", "c", "T", "d", "e", "ns"]) expect(names).toContain(n);
    expect(names).not.toContain("b");
    expect(names).not.toContain("s");
  });

  test("a type-only import is dropped, as a TypeScript file drops it", () => {
    const c = compileSnippet('import type { T } from "./util";\nimport { one } from "./util";\nconst x: T = one;\nreturn x;', {
      workspace: ws,
    });
    expect(c.statementsBody.match(/await __wrathbench_import__/g)).toHaveLength(1);
  });

  test("a single expression after its imports keeps its REPL value", () => {
    const c = compileSnippet('import { one } from "./util"\none + 1', { workspace: ws });
    expect(c.canTryExpression).toBe(true);
    expect(c.expressionBody.endsWith("return (\none + 1\n);")).toBe(true);
    expect(c.expressionBody.startsWith("const __wrathbench_import_0__")).toBe(true);
  });

  test("a parse error below an import still names the user's line", () => {
    try {
      compileSnippet('const x = 1;\nimport { one } from "./util"\nconst y = ;', { workspace: ws });
      throw new Error("expected a parse error");
    } catch (e) {
      const pos = (e as { position?: { line?: number } }).position;
      // Line 1 of the transpiled text is the wrapper; the user's line 3 is line 4.
      expect(pos?.line).toBe(4);
    }
  });

  test("a workspace module's relative imports are stamped with the version it was loaded at", () => {
    const file = `${ws}/lib/deep/user.ts`;
    const src = 'import { one } from "../../util";\nimport { two } from \'./two\';\nexport * from "./two";\nconst s = "from \\"./nowhere\\"";\nconst d = () => import("./two.ts");\nexport const u = one + two;\n';
    const out = stampWorkspaceImports(src, file, ws, "7", "ts");
    expect(out).toContain(`from "${ws}/util.ts?v=7"`);
    expect(out).toContain(`from '${ws}/lib/deep/two.ts?v=7'`);
    expect(out).toContain(`export * from "${ws}/lib/deep/two.ts?v=7"`);
    expect(out).toContain(`import("${ws}/lib/deep/two.ts?v=7")`);
    // Not an import: left exactly as written.
    expect(out).toContain('const s = "from \\"./nowhere\\""');
    // Nothing relative: untouched, byte for byte.
    expect(stampWorkspaceImports("export const a = 1;\n", file, ws, "7", "ts")).toBe("export const a = 1;\n");
  });
});
