/**
 * The suite's checkout guard (fixtures/checkout.ts, run by preload-checkout.ts)
 * against fake checkouts: the shape `bun install` leaves passes, and a missing
 * or borrowed `node_modules` is named with the install command, never passed.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { checkoutProblem } from "./fixtures/checkout";
import { tempDirs } from "./fixtures/temp-dirs";

const tempDirIn = tempDirs();
// Real paths, so the guard's realpath answers compare equal where the temp dir sits behind a link.
const tempDir = (prefix: string): string => realpathSync(tempDirIn(prefix));

function pkg(dir: string, body: object): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify(body));
}

/** A checkout shaped like this repo's after `bun install`: `b` depends on workspace `a`, linked relatively. */
function checkout(root: string): string {
  pkg(root, { name: "root", workspaces: ["a", "b"], devDependencies: { typescript: "1" } });
  pkg(join(root, "a"), { name: "@x/a" });
  pkg(join(root, "b"), { name: "@x/b", dependencies: { "@x/a": "workspace:*", zod: "1" } });
  mkdirSync(join(root, "node_modules"), { recursive: true });
  mkdirSync(join(root, "b", "node_modules", "@x"), { recursive: true });
  symlinkSync("../../../a", join(root, "b", "node_modules", "@x", "a"));
  return root;
}

describe("the checkout guard", () => {
  test("an install in place passes, a workspace with no dependencies needing no node_modules of its own", () => {
    expect(checkoutProblem(checkout(tempDir("wb-checkout-")))).toBeNull();
  });

  test("no install at all names the missing node_modules and the command", () => {
    const root = checkout(tempDir("wb-checkout-"));
    rmSync(join(root, "node_modules"), { recursive: true });
    expect(checkoutProblem(root)).toBe(
      `node_modules is missing: run \`bun install --frozen-lockfile\` in ${root} (well under a second with a warm cache).`,
    );
  });

  test("a workspace's node_modules linked from another checkout is refused, and so its relative workspace links never count", () => {
    const main = checkout(tempDir("wb-main-"));
    const trial = checkout(tempDir("wb-trial-"));
    rmSync(join(trial, "b", "node_modules"), { recursive: true });
    symlinkSync(join(main, "b", "node_modules"), join(trial, "b", "node_modules"));
    const problem = checkoutProblem(trial);
    expect(problem).toStartWith(`b/node_modules resolves to ${join(main, "b", "node_modules")}, which is not this checkout's`);
    expect(problem).toContain("Do not link node_modules from another checkout");
    expect(problem).toContain(`bun install --frozen-lockfile\` in ${trial}`);
  });

  test("the root node_modules linked from another checkout is refused", () => {
    const main = checkout(tempDir("wb-main-"));
    const trial = checkout(tempDir("wb-trial-"));
    rmSync(join(trial, "node_modules"), { recursive: true });
    symlinkSync(join(main, "node_modules"), join(trial, "node_modules"));
    expect(checkoutProblem(trial)).toStartWith(`node_modules resolves to ${join(main, "node_modules")}, which is not this checkout's`);
  });

  test("a workspace link that leads out of the checkout is refused, naming where it leads and where it should", () => {
    const main = checkout(tempDir("wb-main-"));
    const trial = checkout(tempDir("wb-trial-"));
    const link = join(trial, "b", "node_modules", "@x", "a");
    rmSync(link);
    symlinkSync(join(main, "a"), link);
    expect(checkoutProblem(trial)).toStartWith(`b/node_modules/@x/a resolves to ${join(main, "a")}, not ${join(trial, "a")}`);
  });

  test("a missing workspace link is a missing install", () => {
    const root = checkout(tempDir("wb-checkout-"));
    rmSync(join(root, "b", "node_modules", "@x", "a"));
    expect(checkoutProblem(root)).toStartWith("b/node_modules/@x/a is missing: run `bun install --frozen-lockfile`");
  });

  test("a workspace with dependencies and no node_modules is a missing install", () => {
    const root = checkout(tempDir("wb-checkout-"));
    rmSync(join(root, "b", "node_modules"), { recursive: true });
    expect(checkoutProblem(root)).toStartWith("b/node_modules is missing");
  });
});
