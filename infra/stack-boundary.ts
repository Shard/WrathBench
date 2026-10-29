#!/usr/bin/env bun
/**
 * The stack boundary, outside half. The client-equivalent agent stack
 * (`module/`, `sdk/`, `mcp/`) is its own repository, wrath-mcp, consumed here
 * as the `wrath-mcp/` submodule whose `sdk/` and `mcp/` are workspaces of this
 * checkout (docs/ARCHITECTURE.md, "The stack and the benchmark"). Two checks
 * keep the consumer side honest:
 *
 *  - Outside the stack, code reaches `wrath-mcp/sdk` and `wrath-mcp/mcp`
 *    through their package names and exported entry points only, never a path
 *    into the submodule. A path would work in this checkout and nowhere the
 *    stack is consumed as a package.
 *  - The pinned stack and this repository agree on the shared pins: the Bun
 *    version (`.bun-version` and `engines.bun`), `typescript` and `@types/bun`,
 *    and `zod` wherever a workspace on either side declares it. Two lockfiles
 *    resolve these, and a disagreement would install two copies or test the
 *    stack under a toolchain its own CI never ran.
 *  - The AzerothCore commit the stack's README says it is tested against is
 *    the `deps/azerothcore` commit this repository builds the worldserver from.
 *
 * The inside half (the stack imports only itself and what it declares; module
 * includes by bare name) is the stack's own: `wrath-mcp/scripts/boundary.ts`,
 * whose test runs in this repository's suite against the pinned commit.
 *
 * Run: `bun infra/stack-boundary.ts` (exit 1 and one line per violation);
 * `infra/stack-boundary.test.ts` runs it as part of `bun run test`.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

/** Where the stack is checked out, relative to the repository root (`.gitmodules`). */
export const STACK_ROOT = "wrath-mcp";
/** The stack's workspaces, under `STACK_ROOT`. */
export const STACK_PACKAGES = ["sdk", "mcp"] as const;
/** The rest of the repository's code, which may use the stack but never be used by it. */
export const NON_STACK_DIRS = ["runner", "infra", "wiki", "dashboard", "collector", "minimap"] as const;
/** This repository's workspaces that may declare a shared dependency (`zod`). */
const CONSUMER_WORKSPACES = ["", ...NON_STACK_DIRS.filter((d) => d !== "infra")] as const;
/** Pins both sides must agree on, wherever either declares them. */
const SHARED_DEPS = ["zod", "typescript", "@types/bun"] as const;

interface Manifest {
  name: string;
  engines?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  exports?: Record<string, string>;
}

const SKIP_DIRS = new Set(["node_modules", "dist", "dist-public", ".wrangler"]);

function walk(dir: string, exts: readonly string[], out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, exts, out);
    else if (exts.some((e) => name.endsWith(e))) out.push(p);
  }
  return out;
}

function manifest(dir: string): Manifest {
  return JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as Manifest;
}

/** `@scope/name/sub` → [`@scope/name`, `./sub`]; `name/sub` → [`name`, `./sub`]. */
function splitPackage(spec: string): [string, string] {
  const parts = spec.split("/");
  const n = spec.startsWith("@") ? 2 : 1;
  const name = parts.slice(0, n).join("/");
  const sub = parts.slice(n).join("/");
  return [name, sub.length === 0 ? "." : `./${sub}`];
}

/**
 * `code` with its comments blanked and its string and template literals kept,
 * so a specifier still reads as one and a commented-out import does not.
 */
export function stripComments(code: string): string {
  let out = "";
  let i = 0;
  while (i < code.length) {
    const c = code[i]!;
    const next = code[i + 1];
    if (c === "/" && next === "/") {
      while (i < code.length && code[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && next === "*") {
      const end = code.indexOf("*/", i + 2);
      i = end < 0 ? code.length : end + 2;
      out += " ";
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      while (j < code.length && code[j] !== c) j += code[j] === "\\" ? 2 : 1;
      out += code.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/**
 * The specifiers of the type-only forms Bun's scanner drops, since a
 * transpiler erases them: `import type …`, `import { type X } …`,
 * `export type … from`, and `import("…")` in a type position. Read from the
 * text with comments blanked; a statement's specifier is the first string
 * after its `from`, so a string elsewhere in the code is not one.
 */
export function typeOnlyImports(code: string): string[] {
  const text = stripComments(code);
  const out: string[] = [];
  for (const m of text.matchAll(/(?:^|[;\n}])\s*(?:import|export)\s+(?:type\s+)?[^;'"`]*?\bfrom\s*(["'])([^"'\n]+)\1/g)) out.push(m[2]!);
  for (const m of text.matchAll(/\bimport\s*\(\s*(["'])([^"'\n]+)\1\s*\)/g)) out.push(m[2]!);
  return out;
}

/**
 * Every module specifier a TypeScript file imports: Bun's own scanner for
 * what runs (strings and comments are not imports), and `typeOnlyImports` for
 * what only the compiler sees — a type import across the boundary binds the
 * two packages as surely as a value import.
 */
export function importsOf(file: string): string[] {
  const loader = file.endsWith(".tsx") ? "tsx" : "ts";
  const scanner = new Bun.Transpiler({ loader });
  // The scanner refuses a shebang line; it is a comment to everything else.
  const code = readFileSync(file, "utf8").replace(/^#!.*/, "");
  return [...new Set([...scanner.scanImports(code).map((i) => i.path), ...typeOnlyImports(code)])];
}

/** One line per violation of the outside half; empty when the boundary holds. */
export function checkStackBoundary(root: string): string[] {
  const problems: string[] = [];
  const stackRoot = join(root, STACK_ROOT);
  const stackManifests = new Map<string, Manifest>();
  for (const pkg of STACK_PACKAGES) {
    const m = manifest(join(stackRoot, pkg));
    stackManifests.set(m.name, m);
  }
  const exportedSubpath = (name: string, sub: string): boolean => {
    const stack = stackManifests.get(name);
    if (stack === undefined) return true; // a third-party package: its own exports map is the resolver's business
    return Object.hasOwn(stack.exports ?? { ".": "" }, sub);
  };

  for (const d of NON_STACK_DIRS) {
    for (const file of walk(join(root, d), [".ts", ".tsx"])) {
      const rel = relative(root, file);
      for (const spec of importsOf(file)) {
        if (spec.startsWith(".")) {
          const target = resolve(dirname(file), spec);
          if (target === stackRoot || target.startsWith(stackRoot + sep)) {
            const into = relative(root, target).split(sep).slice(0, 2).join("/");
            problems.push(`${rel}: imports ${spec}, a path into ${into}/; use its package name`);
          }
          continue;
        }
        const [name, sub] = splitPackage(spec);
        if (stackManifests.has(name) && !exportedSubpath(name, sub)) problems.push(`${rel}: imports ${spec}, which ${name} does not export`);
      }
    }
  }
  return problems;
}

/** One line per shared pin the pinned stack and this repository disagree on; empty when they agree. */
export function checkStackPins(root: string): string[] {
  const problems: string[] = [];
  const stackRoot = join(root, STACK_ROOT);
  const bunVersion = (dir: string): string => readFileSync(join(dir, ".bun-version"), "utf8").trim();
  if (bunVersion(root) !== bunVersion(stackRoot)) {
    problems.push(`.bun-version is ${bunVersion(root)} here and ${bunVersion(stackRoot)} in ${STACK_ROOT}/`);
  }
  const ours = manifest(root);
  const theirs = manifest(stackRoot);
  if (ours.engines?.["bun"] !== theirs.engines?.["bun"]) {
    problems.push(`engines.bun is ${ours.engines?.["bun"]} here and ${theirs.engines?.["bun"]} in ${STACK_ROOT}/package.json`);
  }

  const declared = (m: Manifest): Record<string, string> => ({ ...m.devDependencies, ...m.dependencies });
  const sides: { where: string; deps: Record<string, string> }[] = [
    ...CONSUMER_WORKSPACES.map((d) => ({ where: d === "" ? "package.json" : `${d}/package.json`, deps: declared(manifest(join(root, d))) })),
    { where: `${STACK_ROOT}/package.json`, deps: declared(theirs) },
    ...STACK_PACKAGES.map((p) => ({ where: `${STACK_ROOT}/${p}/package.json`, deps: declared(manifest(join(stackRoot, p))) })),
  ];
  for (const dep of SHARED_DEPS) {
    const found = sides.filter((s) => s.deps[dep] !== undefined).map((s) => ({ where: s.where, version: s.deps[dep]! }));
    if (new Set(found.map((f) => f.version)).size > 1) {
      problems.push(`${dep} is pinned differently: ${found.map((f) => `${f.where} ${f.version}`).join(", ")}`);
    }
  }
  return problems;
}

/**
 * The AzerothCore commit the pinned stack's README says it is tested against,
 * which must be the one this repository builds the worldserver from (the
 * `deps/azerothcore` gitlink, read from the index so a staged bump counts).
 * Null when they agree; otherwise what differs.
 */
export function checkTestedAgainst(root: string, gitlink: string): string | null {
  const readme = readFileSync(join(root, STACK_ROOT, "README.md"), "utf8");
  const stated = /Tested against AzerothCore\s*\[?`([0-9a-f]{40})`/i.exec(readme)?.[1];
  if (stated === undefined) return `${STACK_ROOT}/README.md states no "Tested against AzerothCore \`<sha>\`" line`;
  if (stated !== gitlink) return `${STACK_ROOT}/README.md is tested against AzerothCore ${stated}, but deps/azerothcore pins ${gitlink}`;
  return null;
}

/** The `deps/azerothcore` gitlink in `root`'s index. */
export function azerothcoreGitlink(root: string): string {
  const p = Bun.spawnSync(["git", "-C", root, "ls-files", "-s", "--", "deps/azerothcore"], { stdout: "pipe", stderr: "pipe" });
  const m = /^160000 ([0-9a-f]{40}) /.exec(p.stdout.toString());
  if (p.exitCode !== 0 || m === null) throw new Error(`no deps/azerothcore gitlink in ${root}: ${p.stderr.toString().trim()}`);
  return m[1]!;
}

if (import.meta.main) {
  const root = resolve(import.meta.dir, "..");
  const tested = checkTestedAgainst(root, azerothcoreGitlink(root));
  const problems = [...checkStackBoundary(root), ...checkStackPins(root), ...(tested === null ? [] : [tested])];
  for (const p of problems) console.error(p);
  if (problems.length > 0) process.exit(1);
  console.log(`stack boundary holds: code outside ${STACK_ROOT}/ reaches the stack by package name and export only, and the shared pins and the tested-against AzerothCore agree`);
}
