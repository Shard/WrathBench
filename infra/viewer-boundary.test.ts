/**
 * The viewer is a leaf. The runner's core (`runner/src/`) and the collector
 * (`collector/src/`) never import from `runner/viewer/`, type imports
 * included: the viewer deploys alone (viewer.Dockerfile), and the code a model
 * sees (the prompt, the context, the loop) must not move when a viewer module
 * does. The viewer imports from `runner/src/` freely; what both sides read
 * lives there. `importsOf` is the stack boundary's (`stack-boundary.ts`):
 * Bun's scanner for what runs, plus the type-only forms it drops.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { importsOf } from "./stack-boundary";

const ROOT = resolve(import.meta.dir, "..");
const VIEWER = join(ROOT, "runner", "viewer");
/** The trees that may not reach into the viewer. */
const GUARDED = ["runner/src", "collector/src"] as const;

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (name === "node_modules") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (name.endsWith(".ts") || name.endsWith(".tsx")) out.push(p);
  }
  return out;
}

/** One line per import from a guarded tree into `runner/viewer/`; empty when the boundary holds. */
function viewerImports(): string[] {
  const problems: string[] = [];
  for (const tree of GUARDED) {
    for (const file of walk(join(ROOT, tree))) {
      for (const spec of importsOf(file)) {
        if (!spec.startsWith(".")) continue;
        const target = resolve(dirname(file), spec);
        if (target === VIEWER || target.startsWith(VIEWER + sep)) problems.push(`${relative(ROOT, file)}: imports ${spec}`);
      }
    }
  }
  return problems.sort();
}

describe("the viewer boundary", () => {
  test("runner/src and collector/src import nothing from runner/viewer", () => {
    expect(viewerImports()).toEqual([]);
  });
});
