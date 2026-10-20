/**
 * The on-demand regression suite (`bun wb smoke suite`, infra/smoke/lib/suite.ts):
 * which members may run at the same time, that a failure is attributed to its
 * own smoke and fails the suite without stopping the others, and that no
 * member logs in on an account the fleet can be holding.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDirs } from "./temp-dirs";
import { chainsOf, fleetHeld, formatSummary, refusals, runSuite, select, spawnMember, SUITE_MEMBERS, type SuiteMember } from "./smoke/lib/suite";

const m = (name: string, account: string, also?: Record<string, string>): SuiteMember => ({ name, account, ...(also ? { also } : {}) });

describe("the members", () => {
  test("every member is a smoke file, kill-credit, quest-accept-status and module-quest among them", () => {
    for (const s of SUITE_MEMBERS) expect(existsSync(join(import.meta.dir, "smoke", `${s.name}.ts`))).toBe(true);
    expect(SUITE_MEMBERS.map((s) => s.name)).toEqual(expect.arrayContaining(["kill-credit", "quest-accept-status", "module-quest"]));
    expect(SUITE_MEMBERS.some((s) => s.name === "suite")).toBe(false);
  });

  test("no member logs in on an account the fleet can be holding", () => {
    expect(refusals(SUITE_MEMBERS)).toEqual([]);
  });

  test("the three regression smokes are on three accounts, so they start at once", () => {
    const chains = chainsOf(SUITE_MEMBERS);
    const chainOf = (name: string) => chains.findIndex((c) => c.some((s) => s.name === name));
    expect(new Set(["kill-credit", "quest-accept-status", "module-quest"].map(chainOf)).size).toBe(3);
    for (const c of chains) expect(c[0]!.name).toMatch(/^(kill-credit|quest-accept-status|module-quest)$/);
  });
});

describe("fleetHeld", () => {
  test("the pool, the reference run's PROBE, the party and the launch gate's SMOKE are refused, case-folded", () => {
    for (const a of ["RUNNER", "runner3", "SHAKEOUT2", "PROBE", "PARTY1", "party5", "SMOKE", "smoke"]) expect(fleetHeld(a)).toBeDefined();
    for (const a of ["SMOKE2", "SMOKE3", "smoke4"]) expect(fleetHeld(a)).toBeUndefined();
  });

  test("an observer account counts as much as the main one", () => {
    expect(refusals([m("swim", "SMOKE3", { MODULE_ACCOUNT_OBSERVER: "PROBE" })])).toEqual(["swim would log in on PROBE, held by a reference run"]);
  });
});

describe("chainsOf", () => {
  test("distinct accounts are separate chains; a shared one is one chain in member order", () => {
    const a = m("a", "SMOKE2");
    const b = m("b", "SMOKE3");
    const c = m("c", "smoke2");
    expect(chainsOf([a, b, c])).toEqual([[a, c], [b]]);
  });

  test("a member on two accounts joins the chains of both, keeping member order", () => {
    const a = m("a", "SMOKE2");
    const b = m("b", "SMOKE3");
    const c = m("c", "SMOKE4", { MODULE_ACCOUNT_OBSERVER: "SMOKE2" });
    const d = m("d", "SMOKE3", { OTHER: "SMOKE4" });
    expect(chainsOf([a, b, c, d])).toEqual([[a, b, c, d]]);
  });
});

describe("runSuite", () => {
  /** A runner that records start/end order and takes `ms` per member, failing the named ones. */
  function fake(ms: number, failing: string[] = []) {
    const log: string[] = [];
    const run = async (s: SuiteMember) => {
      log.push(`start ${s.name}`);
      await Bun.sleep(ms);
      log.push(`end ${s.name}`);
      return failing.includes(s.name) ? { ok: false, ms, tail: `exit 1: ${s.name} broke` } : { ok: true, ms, tail: "PASS" };
    };
    return { log, run };
  }

  test("chains run at once and a chain's members one after another", async () => {
    const { log, run } = fake(20);
    await runSuite([m("a", "SMOKE2"), m("b", "SMOKE3"), m("c", "SMOKE2")], run);
    expect(log.indexOf("start b")).toBeLessThan(log.indexOf("end a"));
    expect(log.indexOf("start c")).toBeGreaterThan(log.indexOf("end a"));
  });

  test("a failure is its own smoke's, fails nothing else, and does not stop its chain", async () => {
    const { log, run } = fake(5, ["a"]);
    const results = await runSuite([m("a", "SMOKE2"), m("b", "SMOKE3"), m("c", "SMOKE2")], run);
    expect(results.map((r) => [r.member.name, r.ok])).toEqual([["a", false], ["b", true], ["c", true]]);
    expect(log).toContain("start c");
    expect(results[0]!.tail).toBe("exit 1: a broke");
  });

  test("a runner that throws is a FAIL for that member, not a crashed suite", async () => {
    const results = await runSuite([m("a", "SMOKE2"), m("b", "SMOKE3")], async (s) => {
      if (s.name === "a") throw new Error("spawn ENOENT");
      return { ok: true, ms: 1, tail: "PASS" };
    });
    expect(results[0]).toMatchObject({ ok: false, tail: "could not run: spawn ENOENT" });
    expect(results[1]!.ok).toBe(true);
  });
});

describe("formatSummary", () => {
  test("one PASS/FAIL line per smoke, in member order, with account and duration; the failure carries its tail", () => {
    const lines = formatSummary(
      [
        { member: m("kill-credit", "SMOKE2"), ok: true, ms: 11_300, tail: "PASS: …" },
        { member: m("quest-accept-status", "SMOKE3"), ok: false, ms: 4_000, tail: "exit 1: [qaccept] FAIL: timed out" },
      ],
      11_400,
    );
    expect(lines[0]).toMatch(/^PASS {2}kill-credit +SMOKE2 +11\.3s$/);
    expect(lines[1]).toMatch(/^FAIL {2}quest-accept-status +SMOKE3 +4\.0s {2}exit 1: \[qaccept\] FAIL: timed out$/);
    expect(lines[2]).toBe("suite: 2 smoke(s), 1 passed, 1 failed, 11.4s wall");
  });
});

describe("select", () => {
  test("no names is every member; names pick those; a wrong name is reported", () => {
    expect(select([])).toEqual({ members: [...SUITE_MEMBERS] });
    expect(select(["module-quest"])).toEqual({ members: SUITE_MEMBERS.filter((s) => s.name === "module-quest") });
    expect(select(["kill-credit", "nope"])).toEqual({ unknown: ["nope"] });
  });
});

describe("spawnMember: a real child, its output attributed", () => {
  const tempDir = tempDirs();

  function smokes(files: Record<string, string>): string {
    const dir = tempDir("wb-suite-");
    for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, `${name}.ts`), body);
    return dir;
  }

  test("every line carries the smoke's name, the account reaches it, and a non-zero exit is a FAIL with its last line", async () => {
    const dir = smokes({
      good: `console.log("hello as " + process.env.MODULE_ACCOUNT); console.log("PASS: good");`,
      bad: `console.log("step one"); console.error("[bad] FAIL: it broke"); process.exit(1);`,
    });
    const out: string[] = [];
    const opts = { dir, cwd: dir, timeoutMs: 10_000, out: { stdout: (s: string) => void out.push(s), stderr: (s: string) => void out.push(s) } };
    const results = await runSuite([m("good", "SMOKE2"), m("bad", "SMOKE3")], (s) => spawnMember(s, opts));
    expect(out).toContain("[good] hello as SMOKE2\n");
    expect(out).toContain("[bad] [bad] FAIL: it broke\n");
    expect(results[0]).toMatchObject({ ok: true, tail: "PASS: good" });
    expect(results[1]).toMatchObject({ ok: false, tail: "exit 1: [bad] FAIL: it broke" });
  });

  test("a smoke that outlives its timeout is killed and failed, naming the timeout", async () => {
    const dir = smokes({ slow: `console.log("started"); await Bun.sleep(30_000);` });
    const r = await spawnMember(m("slow", "SMOKE2"), { dir, cwd: dir, timeoutMs: 500, out: { stdout: () => {}, stderr: () => {} } });
    expect(r.ok).toBe(false);
    expect(r.tail).toBe("killed after 1s; last line: started");
  });
});
