/**
 * Every smoke names its module sessions one way, `smoke-<file>[-<role>]-<uuid>`
 * through `smokeToken`, so `bun wb inspect audit --smoke <file>` finds them.
 * quest-accept-status once spelled its own `probe-qaccept-<uuid>`, and after
 * it failed in a release its move records could not be read.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { SMOKE_SESSION_NAME, smokeToken } from "./smoke/lib/session";

const SMOKE_DIR = join(import.meta.dir, "smoke");
const smokes = readdirSync(SMOKE_DIR).filter((n) => n.endsWith(".ts")).map((n) => ({ stem: n.slice(0, -3), src: readFileSync(join(SMOKE_DIR, n), "utf8") }));
const libs = readdirSync(join(SMOKE_DIR, "lib")).filter((n) => n.endsWith(".ts")).map((n) => ({ name: n, src: readFileSync(join(SMOKE_DIR, "lib", n), "utf8") }));

describe("smokeToken", () => {
  test("smoke-<name>[-<role>]-<uuid>, long enough for the module's 32", () => {
    const t = smokeToken("pet");
    expect(t).toMatch(/^smoke-pet-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(t.length).toBeGreaterThanOrEqual(32);
    expect(smokeToken("pet")).not.toBe(t);
    const id = "0f1e2d3c-4b5a-4968-8776-655443322110";
    expect(smokeToken("group", { role: "a", id })).toBe(`smoke-group-a-${id}`);
  });

  test("refuses a name inspect audit --smoke could not take, or an id the reducer would not find", () => {
    expect(() => smokeToken("Edge")).toThrow();
    expect(() => smokeToken("party-entry", { role: "PARTY1" })).toThrow();
    expect(() => smokeToken("a--b")).toThrow();
    expect(() => smokeToken("pet", { id: "run-1" })).toThrow();
  });
});

describe("the smokes' session names", () => {
  test("no smoke spells a token of its own", () => {
    const literal = /[`"'](?:smoke|probe)-/;
    for (const { stem, src } of smokes) expect({ stem, spelled: literal.test(src) }).toEqual({ stem, spelled: false });
    for (const { name, src } of libs) {
      if (name === "session.ts") continue;
      // The stager's party and campaign labels in lib/party.ts are not session tokens.
      const lines = src.split("\n").filter((l) => literal.test(l) && !/defaultStageRequest\(\{ party: `smoke-\$\{tag\}`, campaign: `smoke-\$\{tag\}`/.test(l));
      expect({ name, lines }).toEqual({ name, lines: [] });
    }
  });

  test("each names its sessions after its own file, as bun wb smoke runs it", () => {
    const named = /\b(?:smokeToken|smokeRequest)\("([^"]*)"|\b(?:loginMember|deleteMembers)\([^;]*?"([^"]*)"/g;
    for (const { stem, src } of smokes) {
      expect(SMOKE_SESSION_NAME.test(stem)).toBe(true);
      const names = [...src.matchAll(named)].map((m) => m[1] ?? m[2]);
      const opens = /\btoken\b/.test(src);
      if (opens) expect({ stem, named: names.length > 0 }).toEqual({ stem, named: true });
      for (const n of names) expect({ stem, n }).toEqual({ stem, n: stem });
    }
  });
});
