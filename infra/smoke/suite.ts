/**
 * The on-demand regression suite: the game-surface smokes, in parallel where
 * their accounts allow, one PASS/FAIL line per smoke with its duration, and a
 * non-zero exit on any failure. The members, their accounts and the account
 * rule are in lib/suite.ts.
 *
 * It is not part of any gate. The deploy window verifies a release with the
 * launch gate alone, and the supervisor never runs this. Run it with the fleet
 * live: no member logs in on an account the fleet can be using, and nothing
 * here pauses, drains or scales anything.
 *
 * Every smoke runs as a child (`bun infra/smoke/<name>.ts`, MODULE_ACCOUNT set
 * to its account), its output streamed with `[<name>]` in front of each line,
 * and killed after MEMBER_TIMEOUT_MS. A killed smoke can leave its session
 * behind; the next login on that account reclaims it.
 *
 * Run:
 *   bun wb smoke suite                        # every member
 *   bun wb smoke suite kill-credit module-quest
 *   bun wb smoke suite --list                 # the members and their accounts
 */

import { join } from "node:path";
import { accountsOf, formatSummary, refusals, runSuite, select, spawnMember, SUITE_MEMBERS } from "./lib/suite";

const SMOKE_DIR = import.meta.dir;
const REPO_ROOT = join(SMOKE_DIR, "..", "..");
/** Above the slowest member's worst case (a first run's create waits out the 60s logout linger). */
const MEMBER_TIMEOUT_MS = 10 * 60_000;
const out = { stdout: (s: string) => void process.stdout.write(s), stderr: (s: string) => void process.stderr.write(s) };

async function main(argv: string[]): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log("usage: bun wb smoke suite [--list] [member …]");
    return 0;
  }
  if (argv.includes("--list")) {
    for (const m of SUITE_MEMBERS) console.log(`${m.name.padEnd(22)} ${accountsOf(m).join(", ")}`);
    return 0;
  }
  const picked = select(argv);
  if ("unknown" in picked) {
    console.error(`suite: no member named ${picked.unknown.join(", ")}; the members are ${SUITE_MEMBERS.map((m) => m.name).join(", ")}`);
    return 2;
  }
  const refused = refusals(picked.members);
  if (refused.length > 0) {
    for (const r of refused) console.error(`suite: refused: ${r}`);
    return 2;
  }
  console.log(`suite: ${picked.members.map((m) => `${m.name} (${accountsOf(m).join("+")})`).join(", ")}`);
  const t0 = Date.now();
  const results = await runSuite(picked.members, (m) => spawnMember(m, { dir: SMOKE_DIR, cwd: REPO_ROOT, timeoutMs: MEMBER_TIMEOUT_MS, out }));
  for (const line of formatSummary(results, Date.now() - t0)) console.log(line);
  return results.every((r) => r.ok) ? 0 : 1;
}

process.exit(await main(process.argv.slice(2)));
