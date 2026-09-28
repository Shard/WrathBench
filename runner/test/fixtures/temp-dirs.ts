/**
 * Temp directories a test file makes and removes again.
 *
 * `/tmp` where the suite runs can be RAM, and every directory a test left there
 * stayed until the next reboot. Call `tempDirs()` once at the top
 * level of a test file: it registers that file's `afterAll`, and the function it
 * returns makes a fresh directory under the OS temp dir with the given prefix,
 * every one of which is removed once the file's tests are done. Not a module
 * level registry: bun shares imported modules across the files of one run, so
 * an `afterAll` here would bind to whichever file imported it first, and bun
 * does not fire `process.on("exit")` at the end of `bun test`.
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
