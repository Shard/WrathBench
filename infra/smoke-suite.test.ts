/**
 * The on-demand regression suite (`bun wb smoke suite`, infra/smoke/lib/suite.ts):
 * that no member logs in on an account the fleet can be holding, and that a
 * failure is attributed to its own smoke without stopping the others.
 */
import { describe, expect, test } from "bun:test";
import { fleetHeld, refusals, runSuite, SUITE_MEMBERS, type SuiteMember } from "./smoke/lib/suite";

const m = (name: string, account: string, also?: Record<string, string>): SuiteMember => ({ name, account, ...(also ? { also } : {}) });

describe("the members", () => {
  test("no member logs in on an account the fleet can be holding", () => {
    expect(refusals(SUITE_MEMBERS)).toEqual([]);
  });
});

describe("fleetHeld", () => {
  test("the pool, the reference run's PROBE, the party and the launch gate's SMOKE are refused, case-folded", () => {
    for (const a of ["RUNNER", "runner3", "SHAKEOUT2", "POOL01", "pool17", "PROBE", "PARTY1", "party5", "SMOKE", "smoke"]) expect(fleetHeld(a)).toBeDefined();
    for (const a of ["SMOKE2", "SMOKE3", "smoke4"]) expect(fleetHeld(a)).toBeUndefined();
  });

  test("an observer account counts as much as the main one", () => {
    expect(refusals([m("swim", "SMOKE3", { MODULE_ACCOUNT_OBSERVER: "PROBE" })])).toEqual(["swim would log in on PROBE, held by a reference run"]);
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

  test("a failure is its own smoke's, fails nothing else, and does not stop its chain", async () => {
    const { log, run } = fake(5, ["a"]);
    const results = await runSuite([m("a", "SMOKE2"), m("b", "SMOKE3"), m("c", "SMOKE2")], run);
    expect(results.map((r) => [r.member.name, r.ok])).toEqual([["a", false], ["b", true], ["c", true]]);
    expect(log).toContain("start c");
    expect(results[0]!.tail).toBe("exit 1: a broke");
  });
});
