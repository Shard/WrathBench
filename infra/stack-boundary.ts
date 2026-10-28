#!/usr/bin/env bun
/**
 * The stack boundary: module/, sdk/ and mcp/ are the client-equivalent agent
 * stack, meant to lift out of this repository whole and bolt onto a stock
 * AzerothCore (docs/ARCHITECTURE.md, "The stack and the benchmark"). This
 * check keeps that true as the code changes:
 *
 *  - Inside the stack, a TypeScript file imports only its own package (by
 *    relative path), Bun and Node built-ins, and the dependencies its
 *    package.json declares, at a subpath that dependency exports. sdk/ declares
 *    no stack dependency, so it can never import mcp/; mcp/ reaches the SDK
 *    through `@wrathbench/sdk` alone. Nothing in the stack imports runner/,
 *    infra/, wiki/, dashboard/, collector/ or minimap/.
 *  - The C++ module's quoted includes name a header by its bare file name —
 *    its own or the core's — never a path out of module/.
 *  - Outside the stack, code reaches sdk/ and mcp/ through their package
 *    names and exported entry points only, never a path into their sources.
 *
 * Run: `bun infra/stack-boundary.ts` (exit 1 and one line per violation);
 * `infra/stack-boundary.test.ts` runs it as part of `bun run test`.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { builtinModules } from "node:module";
import { dirname, join, relative, resolve, sep } from "node:path";

export const STACK_PACKAGES = ["sdk", "mcp"] as const;
/** The rest of the repository's code, which may use the stack but never be used by it. */
export const NON_STACK_DIRS = ["runner", "infra", "wiki", "dashboard", "collector", "minimap"] as const;

interface Manifest {
  name: string;
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

const BUILTINS = new Set(builtinModules);

function isBuiltin(spec: string): boolean {
  return spec === "bun" || spec.startsWith("bun:") || spec.startsWith("node:") || BUILTINS.has(spec);
}

/** `@scope/name/sub` → [`@scope/name`, `./sub`]; `name/sub` → [`name`, `./sub`]. */
function splitPackage(spec: string): [string, string] {
  const parts = spec.split("/");
  const n = spec.startsWith("@") ? 2 : 1;
  const name = parts.slice(0, n).join("/");
  const sub = parts.slice(n).join("/");
  return [name, sub.length === 0 ? "." : `./${sub}`];
}

/** Every module specifier a TypeScript file imports, by Bun's own scanner (strings and comments are not imports). */
export function importsOf(file: string): string[] {
  const loader = file.endsWith(".tsx") ? "tsx" : "ts";
  const scanner = new Bun.Transpiler({ loader });
  // The scanner refuses a shebang line; it is a comment to everything else.
  const code = readFileSync(file, "utf8").replace(/^#!.*/, "");
  return scanner.scanImports(code).map((i) => i.path);
}

/** One line per violation; empty when the boundary holds. */
export function checkStackBoundary(root: string): string[] {
  const problems: string[] = [];
  const stackManifests = new Map<string, { dir: string; manifest: Manifest }>();
  for (const pkg of STACK_PACKAGES) stackManifests.set(manifest(join(root, pkg)).name, { dir: join(root, pkg), manifest: manifest(join(root, pkg)) });

  const exportedSubpath = (name: string, sub: string): boolean => {
    const stack = stackManifests.get(name);
    if (stack === undefined) return true; // a third-party package: its own exports map is the resolver's business
    return Object.hasOwn(stack.manifest.exports ?? { ".": "" }, sub);
  };

  // Inside the stack.
  for (const pkg of STACK_PACKAGES) {
    const dir = join(root, pkg);
    const m = manifest(dir);
    const declared = new Set([...Object.keys(m.dependencies ?? {}), ...Object.keys(m.devDependencies ?? {})]);
    for (const file of walk(dir, [".ts", ".tsx"])) {
      const rel = relative(root, file);
      for (const spec of importsOf(file)) {
        if (spec.startsWith(".")) {
          const target = resolve(dirname(file), spec);
          if (target !== dir && !target.startsWith(dir + sep)) problems.push(`${rel}: imports ${spec}, outside ${pkg}/`);
          continue;
        }
        if (isBuiltin(spec)) continue;
        const [name, sub] = splitPackage(spec);
        if (!declared.has(name)) {
          problems.push(`${rel}: imports ${spec}, which ${pkg}/package.json does not declare`);
          continue;
        }
        if (!exportedSubpath(name, sub)) problems.push(`${rel}: imports ${spec}, which ${name} does not export`);
      }
    }
  }

  // The module: quoted includes by bare name only.
  for (const file of walk(join(root, "module"), [".cpp", ".h", ".hpp"])) {
    const rel = relative(root, file);
    for (const m of readFileSync(file, "utf8").matchAll(/^\s*#\s*include\s+"([^"]+)"/gm)) {
      if (m[1]!.includes("/") || m[1]!.includes("\\")) problems.push(`${rel}: includes "${m[1]}", a path rather than a header name`);
    }
  }

  // Outside the stack: package names and exported entry points only.
  const stackDirs = [...STACK_PACKAGES, "module"].map((p) => join(root, p));
  for (const d of NON_STACK_DIRS) {
    for (const file of walk(join(root, d), [".ts", ".tsx"])) {
      const rel = relative(root, file);
      for (const spec of importsOf(file)) {
        if (spec.startsWith(".")) {
          const target = resolve(dirname(file), spec);
          const into = stackDirs.find((s) => target === s || target.startsWith(s + sep));
          if (into !== undefined) problems.push(`${rel}: imports ${spec}, a path into ${relative(root, into)}/; use its package name`);
          continue;
        }
        const [name, sub] = splitPackage(spec);
        if (stackManifests.has(name) && !exportedSubpath(name, sub)) problems.push(`${rel}: imports ${spec}, which ${name} does not export`);
      }
    }
  }
  return problems;
}

if (import.meta.main) {
  const problems = checkStackBoundary(resolve(import.meta.dir, ".."));
  for (const p of problems) console.error(p);
  if (problems.length > 0) process.exit(1);
  console.log("stack boundary holds: module/, sdk/ and mcp/ import nothing outside themselves but declared dependencies");
}
