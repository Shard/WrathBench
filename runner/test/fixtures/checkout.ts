/**
 * Whether a checkout's `node_modules` is its own, installed in place.
 *
 * The suite tests the code in the checkout it runs from, and the snippet
 * child can only read that checkout: confine.ts grants the stack's packages
 * (`wrath-mcp/sdk/`, `wrath-mcp/mcp/`), `runner/` and the `node_modules/` they
 * resolve into, by inode. A `node_modules` linked
 * from another checkout (a quick way to skip an install in a trial worktree)
 * breaks both at once. The workspace links in it are relative, so
 * `@wrathbench/sdk` resolves to the *other* checkout's `sdk/`: every host-side
 * test silently runs that code, and every real snippet child dies on
 * `Cannot find module '@wrathbench/sdk'` because Landlock refuses the path
 * (EACCES), one failure per test, far from the cause. A missing install fails
 * the same way, as many failures as there are files. `bun install
 * --frozen-lockfile` is a fraction of a second with a warm cache, so the
 * answer to both is one line, said once, before any test runs.
 */

import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";

/**
 * The stack's submodule (`.gitmodules`), whose `sdk/` and `mcp/` are workspaces
 * of this checkout. It must be checked out, and it must have no install of its
 * own: a `wrath-mcp/node_modules` would hand the stack its own copies of the
 * dependencies it shares with the runner (two zods), resolved ahead of the
 * root's.
 */
export const STACK_SUBMODULE = "wrath-mcp";

interface Manifest {
  name?: string;
  workspaces?: string[];
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

function manifest(dir: string): Manifest {
  return JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as Manifest;
}

/** Null when every `node_modules` and workspace link under `root` is this checkout's; otherwise what is wrong and what to run. */
export function checkoutProblem(root: string): string | null {
  const real = realpathSync(root);
  const install = `run \`bun install --frozen-lockfile\` in ${root} (well under a second with a warm cache)`;
  const dirs = ["", ...(manifest(root).workspaces ?? [])];
  for (const d of dirs) {
    if (existsSync(join(root, d, "package.json"))) continue;
    if (d.startsWith(`${STACK_SUBMODULE}/`)) {
      return `${STACK_SUBMODULE}/ is not checked out (workspace ${d} has no package.json): run \`git submodule update --init ${STACK_SUBMODULE}\` in ${root}, then \`bun install --frozen-lockfile\`.`;
    }
    return `workspace ${d} has no package.json; the checkout is incomplete.`;
  }
  if (existsSync(join(root, STACK_SUBMODULE, "node_modules"))) {
    return (
      `${STACK_SUBMODULE}/node_modules exists: an install inside the submodule gives the stack its own copies of the dependencies it shares ` +
      `with the runner. Remove it (\`rm -rf ${join(root, STACK_SUBMODULE, "node_modules")}\`); the stack installs from this checkout's root.`
    );
  }
  const workspaceDir = new Map<string, string>();
  for (const d of dirs) {
    const name = manifest(join(root, d)).name;
    if (name !== undefined) workspaceDir.set(name, join(real, d));
  }
  for (const d of dirs) {
    const label = d === "" ? "node_modules" : `${d}/node_modules`;
    const pkg = manifest(join(root, d));
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    const nm = join(root, d, "node_modules");
    if (!existsSync(nm)) {
      if (d === "" || Object.keys(deps).length > 0) return `${label} is missing: ${install}.`;
      continue;
    }
    const at = realpathSync(nm);
    if (at !== join(real, d, "node_modules")) {
      return (
        `${label} resolves to ${at}, which is not this checkout's: the suite would run that checkout's code, ` +
        `and the confined snippet child cannot read it. Do not link node_modules from another checkout; ${install}.`
      );
    }
    for (const [dep, range] of Object.entries(deps)) {
      if (!range.startsWith("workspace:")) continue;
      const want = workspaceDir.get(dep);
      const link = [join(nm, dep), join(root, "node_modules", dep)].find((p) => existsSync(p));
      const got = link === undefined ? null : realpathSync(link);
      if (got === null) return `${label}/${dep} is missing: ${install}.`;
      if (got !== want) {
        return (
          `${label}/${dep} resolves to ${got}, not ${want ?? "a workspace of this checkout"}: ` +
          `the suite would run that code instead of this checkout's; ${install}.`
        );
      }
    }
  }
  return null;
}
