/**
 * The stack boundary's outside half (`stack-boundary.ts`) against this
 * checkout, and against a planted tree for each kind of violation it exists to
 * catch. The inside half is the stack's own (`wrath-mcp/scripts/boundary.ts`),
 * and its test runs in this suite too.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { azerothcoreGitlink, checkStackBoundary, checkStackPins, checkTestedAgainst } from "./stack-boundary";

const made: string[] = [];
afterAll(() => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
});

const pkg = (body: object): string => JSON.stringify(body);

function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "wrathbench-boundary-"));
  made.push(root);
  const base: Record<string, string> = {
    ".bun-version": "1.4.4\n",
    "package.json": pkg({ name: "wrathbench", engines: { bun: "1.4.4" }, devDependencies: { typescript: "7.0.2", "@types/bun": "1.4.4" } }),
    "runner/package.json": pkg({ name: "@wrathbench/runner", dependencies: { "@wrathbench/sdk": "workspace:0.1.0", zod: "4.4.3" } }),
    "wiki/package.json": pkg({ name: "@wrathbench/wiki" }),
    "dashboard/package.json": pkg({ name: "@wrathbench/dashboard" }),
    "collector/package.json": pkg({ name: "@wrathbench/collector", dependencies: { zod: "4.4.3" } }),
    "minimap/package.json": pkg({ name: "@wrathbench/minimap" }),
    "wrath-mcp/.bun-version": "1.4.4\n",
    "wrath-mcp/package.json": pkg({ name: "wrath-mcp", engines: { bun: "1.4.4" }, devDependencies: { typescript: "7.0.2", "@types/bun": "1.4.4" } }),
    "wrath-mcp/sdk/package.json": pkg({ name: "@wrathbench/sdk", dependencies: { zod: "4.4.3" }, exports: { ".": "./src/index.ts" } }),
    "wrath-mcp/mcp/package.json": pkg({
      name: "@wrathbench/mcp",
      dependencies: { "@wrathbench/sdk": "workspace:*", zod: "4.4.3" },
      exports: { ".": "./src/index.ts", "./sandbox-child": "./src/sandbox/child.ts" },
    }),
    "wrath-mcp/sdk/src/index.ts": "export const x = 1;\n",
    "runner/src/ok.ts": 'import { connect } from "@wrathbench/sdk";\nimport { startSandboxChild } from "@wrathbench/mcp/sandbox-child";\n',
  };
  for (const [path, body] of Object.entries({ ...base, ...files })) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), body);
  }
  return root;
}

describe("the stack boundary, outside half", () => {
  test("holds in this checkout", () => {
    const root = resolve(import.meta.dir, "..");
    expect(checkStackBoundary(root)).toEqual([]);
    expect(checkStackPins(root)).toEqual([]);
  });

  test("a clean planted tree passes", () => {
    const root = tree({});
    expect(checkStackBoundary(root)).toEqual([]);
    expect(checkStackPins(root)).toEqual([]);
  });

  test("outside the stack, code uses package names and exported entry points", () => {
    const root = tree({
      "infra/smoke/x.ts": 'import { connect } from "../../wrath-mcp/sdk/src/index";\nimport { connect as c } from "@wrathbench/sdk";\n',
      "runner/src/y.ts": 'import { h } from "@wrathbench/mcp/src/sandbox/host";\n',
      "runner/src/z.ts": 'import x from "../../wrath-mcp/module/conf/x";\n',
    });
    expect(checkStackBoundary(root).sort()).toEqual([
      "infra/smoke/x.ts: imports ../../wrath-mcp/sdk/src/index, a path into wrath-mcp/sdk/; use its package name",
      "runner/src/y.ts: imports @wrathbench/mcp/src/sandbox/host, which @wrathbench/mcp does not export",
      "runner/src/z.ts: imports ../../wrath-mcp/module/conf/x, a path into wrath-mcp/module/; use its package name",
    ]);
  });

  test("type-only imports count: every form a transpiler erases", () => {
    const root = tree({
      "runner/src/t1.ts": 'import type { ToolContext } from "../../wrath-mcp/mcp/src/tools";\n',
      "runner/src/t2.ts": 'import { type StateCache } from "@wrathbench/sdk/src/state";\n',
      "runner/src/t3.ts": 'export type { X } from "../../wrath-mcp/sdk/src/index";\n',
      "runner/src/t4.ts": 'let x: import("../../wrath-mcp/mcp/src/server").McpServer | undefined;\nexport { x };\n',
    });
    expect(checkStackBoundary(root).sort()).toEqual([
      "runner/src/t1.ts: imports ../../wrath-mcp/mcp/src/tools, a path into wrath-mcp/mcp/; use its package name",
      "runner/src/t2.ts: imports @wrathbench/sdk/src/state, which @wrathbench/sdk does not export",
      "runner/src/t3.ts: imports ../../wrath-mcp/sdk/src/index, a path into wrath-mcp/sdk/; use its package name",
      "runner/src/t4.ts: imports ../../wrath-mcp/mcp/src/server, a path into wrath-mcp/mcp/; use its package name",
    ]);
  });

  test("strings and comments that look like imports are not imports", () => {
    const root = tree({ "runner/src/prose.ts": '// import x from "../../wrath-mcp/sdk/src/index";\nexport const s = \'from "../../wrath-mcp/sdk"\';\n' });
    expect(checkStackBoundary(root)).toEqual([]);
  });
});

describe("the shared pins", () => {
  test("a Bun version that differs, in either place, is named", () => {
    const root = tree({
      "wrath-mcp/.bun-version": "1.4.5\n",
      "wrath-mcp/package.json": pkg({ name: "wrath-mcp", engines: { bun: "1.4.5" }, devDependencies: { typescript: "7.0.2", "@types/bun": "1.4.4" } }),
    });
    expect(checkStackPins(root)).toEqual([
      ".bun-version is 1.4.4 here and 1.4.5 in wrath-mcp/",
      "engines.bun is 1.4.4 here and 1.4.5 in wrath-mcp/package.json",
    ]);
  });

  test("zod, typescript and @types/bun must agree wherever either side declares them", () => {
    const root = tree({
      "wrath-mcp/sdk/package.json": pkg({ name: "@wrathbench/sdk", dependencies: { zod: "4.5.0" }, exports: { ".": "./src/index.ts" } }),
      "wrath-mcp/package.json": pkg({ name: "wrath-mcp", engines: { bun: "1.4.4" }, devDependencies: { typescript: "7.0.3", "@types/bun": "1.4.4" } }),
    });
    expect(checkStackPins(root)).toEqual([
      "zod is pinned differently: runner/package.json 4.4.3, collector/package.json 4.4.3, wrath-mcp/sdk/package.json 4.5.0, wrath-mcp/mcp/package.json 4.4.3",
      "typescript is pinned differently: package.json 7.0.2, wrath-mcp/package.json 7.0.3",
    ]);
  });
});

describe("the wrath-mcp pin record", () => {
  test("infra/PINS.md names the commit the submodule pins", () => {
    const root = resolve(import.meta.dir, "..");
    const p = Bun.spawnSync(["git", "-C", root, "ls-files", "-s", "--", "wrath-mcp"], { stdout: "pipe" });
    const gitlink = /^160000 ([0-9a-f]{40}) /.exec(p.stdout.toString())?.[1];
    const pins = readFileSync(join(root, "infra", "PINS.md"), "utf8");
    const recorded = /^## wrath-mcp[^\n]*\n+- Commit: `([0-9a-f]{40})`/m.exec(pins)?.[1];
    expect(gitlink).toBeDefined();
    expect(recorded).toBe(gitlink!);
  });
});

describe("the AzerothCore the stack is tested against", () => {
  const sha = (c: string): string => c.repeat(40);
  const readme = (s: string): Record<string, string> => ({ "wrath-mcp/README.md": `# wrath-mcp\n\nTested against AzerothCore\n[\`${s}\`](https://example.invalid/${s}).\n` });

  test("is the deps/azerothcore commit this checkout pins", () => {
    const root = resolve(import.meta.dir, "..");
    expect(checkTestedAgainst(root, azerothcoreGitlink(root))).toBeNull();
  });

  test("a stack README naming another commit, or none, is named", () => {
    expect(checkTestedAgainst(tree(readme(sha("a"))), sha("a"))).toBeNull();
    expect(checkTestedAgainst(tree(readme(sha("a"))), sha("b"))).toBe(`wrath-mcp/README.md is tested against AzerothCore ${sha("a")}, but deps/azerothcore pins ${sha("b")}`);
    expect(checkTestedAgainst(tree({ "wrath-mcp/README.md": "# wrath-mcp\n" }), sha("b"))).toBe('wrath-mcp/README.md states no "Tested against AzerothCore `<sha>`" line');
  });
});
