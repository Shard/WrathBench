/**
 * The suite runs only against this checkout's own install: one line and exit
 * 1 before any test file loads, rather than a failure per file or per snippet
 * child far from the cause. See fixtures/checkout.ts for why a missing or
 * borrowed `node_modules` is refused rather than worked around. First in every
 * preload list, because the others import from `node_modules`.
 */

import { resolve } from "node:path";
import { checkoutProblem } from "./fixtures/checkout";

const problem = checkoutProblem(resolve(import.meta.dir, "..", ".."));
if (problem !== null) {
  console.error(`bun test: ${problem}`);
  process.exit(1);
}
