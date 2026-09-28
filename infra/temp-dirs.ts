/**
 * Temp directories an infra test file makes and removes again; the same helper
 * as runner/test/fixtures/temp-dirs.ts, which says why it is shaped this way.
 * Call `tempDirs()` once at the top level of a test file: the function it
 * returns makes a fresh directory under the OS temp dir with the given prefix,
 * and every one it made is removed in that file's `afterAll`.
 */

import { afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function tempDirs(): (prefix: string) => string {
  const made: string[] = [];
  afterAll(() => {
    for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
  });
  return (prefix) => {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    made.push(dir);
    return dir;
  };
}
