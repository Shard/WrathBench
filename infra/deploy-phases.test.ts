/**
 * The deploy window's phases, held to the script that writes them.
 *
 * infra/k8s-deploy.sh is the one writer of data/runs/server-state.json, through
 * its `write_phase`. Three readers enumerate the phases on their own: the
 * viewer's `SERVER_PHASES` (an unknown phase reads as `running` with nothing to
 * say), the supervisor's `WINDOW_PHASES` (which it reclaims on a tick) and the
 * Fleet page's `deployWindowOpen` and `serverBanner`. A phase the script writes
 * and a reader lacks is a window the page reports as a quiet server, which is
 * how `waiting` went missing; a phase a reader keeps that nothing writes is
 * dead code. So each list must equal the script's, exactly.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { Glob } from "bun";
import type { FleetServerView } from "../runner/viewer/api-types";
import { SERVER_PHASES } from "../runner/viewer/api";
import { deployWindowOpen, serverBanner } from "../dashboard/src/lib/fleet";
import { WINDOW_PHASES } from "./run-fleet-state";

const INFRA = import.meta.dir;

/** Code lines only: a comment that names a phase writes nothing. */
function codeLines(path: string): string[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => !/^\s*#/.test(l));
}

/** The phase of every `write_phase <phase> …` call. A phase that is not a literal word cannot be checked, so it fails. */
function writtenPhases(path: string): Set<string> {
  const out = new Set<string>();
  for (const line of codeLines(path)) {
    for (const m of line.matchAll(/\bwrite_phase\s+(\S+)/g)) {
      const phase = m[1]!;
      if (!/^[a-z][a-z-]*$/.test(phase)) throw new Error(`write_phase with a non-literal phase ${phase}: ${line.trim()}`);
      out.add(phase);
    }
  }
  return out;
}

const sorted = (xs: Iterable<string>): string[] => [...xs].sort();

const DEPLOY = join(INFRA, "k8s-deploy.sh");
const PHASES = writtenPhases(DEPLOY);
/** `running` is the rest state and `failed` the verdict; every other phase the script writes is the window. */
const VERDICTS = new Set(["running", "failed"]);
const WINDOW = new Set([...PHASES].filter((p) => !VERDICTS.has(p)));

describe("the deploy window's phases", () => {
  test("k8s-deploy.sh writes the rest state, the verdict and a window", () => {
    for (const v of VERDICTS) expect(PHASES.has(v)).toBe(true);
    expect(WINDOW.size).toBeGreaterThan(0);
  });

  test("k8s-deploy.sh writes server-state.json only through write_phase, and no other infra script writes it", () => {
    expect(codeLines(DEPLOY).filter((l) => l.includes("server-state.json"))).toHaveLength(1);
    expect(codeLines(DEPLOY).some((l) => /^\s*write_phase\(\)\s*\{/.test(l))).toBe(true);
    // k8s-release.sh's own PHASES (build drain pin deploy resume) are its steps, not server phases: it runs k8s-deploy.sh for the window.
    const others: string[] = [];
    for (const rel of new Glob("**/*.sh").scanSync({ cwd: INFRA })) {
      const path = join(INFRA, rel);
      if (path === DEPLOY) continue;
      if (codeLines(path).some((l) => l.includes("server-state"))) others.push(relative(INFRA, path));
    }
    expect(others).toEqual([]);
  });

  test("the viewer serves exactly the phases the script writes", () => {
    expect(sorted(SERVER_PHASES)).toEqual(sorted(PHASES));
  });

  test("the supervisor's window phases are exactly the script's window", () => {
    expect(sorted(WINDOW_PHASES)).toEqual(sorted(WINDOW));
  });

  test("the Fleet page opens the window on exactly the script's window, and has a banner for every phase", () => {
    for (const p of PHASES) {
      const phase = p as FleetServerView["phase"];
      expect({ phase, open: deployWindowOpen({ phase }) }).toEqual({ phase, open: WINDOW.has(phase) });
      const banner = serverBanner({ phase, since: 0, build: "b", detail: "d", updatedAt: 0 });
      const tone = phase === "running" ? "dim" : phase === "failed" ? "bad" : "info";
      expect({ phase, tone: banner?.tone }).toEqual({ phase, tone });
    }
  });
});
