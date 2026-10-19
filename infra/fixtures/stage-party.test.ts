/**
 * The stager's pure parts and its refusals before anything is touched: what
 * a request may be, where worn bags go, how landed items are counted, the
 * CLI's arguments, and that a non-admin STAGER or a malformed request ends
 * the staging before any account, character or row is touched. The live
 * staging is proven by infra/smoke/party-staging.ts in a release window.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { SoapClient } from "./soap";
import { DEFAULT_PARTY_ACCOUNTS, bagTargets, checkStageRequest, countByItem, parseStageArgs, stageParty } from "./stage-party";
import { PARTY_ROLES } from "./loadouts";

const ROLES = [...PARTY_ROLES];
const ACCOUNTS = [...DEFAULT_PARTY_ACCOUNTS];

describe("checkStageRequest", () => {
  test("the default party is a valid request", () => {
    expect(checkStageRequest({ campaign: "deadmines@1", accounts: ACCOUNTS, roles: ROLES })).toEqual([]);
    expect(checkStageRequest({ campaign: "smoke", accounts: ["PARTY3"], roles: ["healer"] })).toEqual([]);
  });

  test("refuses any account but the party's, mismatched lengths, repeats, unknown roles and a bad campaign id", () => {
    const bad = (accounts: string[], roles: string[], campaign = "c") => checkStageRequest({ campaign, accounts, roles: roles as never }).join("; ");
    expect(bad(["RUNNER", "PARTY2"], ["tank", "healer"])).toMatch(/refusing to stage on 'RUNNER'/);
    expect(bad(["SMOKE"], ["tank"])).toMatch(/refusing to stage on 'SMOKE'/);
    expect(bad(["STAGER"], ["tank"])).toMatch(/refusing to stage on 'STAGER'/);
    expect(bad(["PARTY1", "PARTY2"], ["tank"])).toMatch(/2 accounts and 1 roles/);
    expect(bad(["PARTY1", "PARTY1"], ["tank", "healer"])).toMatch(/account is named twice/);
    expect(bad(["PARTY1", "PARTY2"], ["tank", "tank"])).toMatch(/role is named twice/);
    expect(bad(["PARTY1"], ["paladin"])).toMatch(/unknown role 'paladin'/);
    expect(bad([], [])).toMatch(/1\.\.5 accounts/);
    expect(bad(["PARTY1"], ["tank"], "has spaces")).toMatch(/not a campaign id/);
  });
});

describe("bagTargets", () => {
  test("fills the first free bag slots, around what is already worn there", () => {
    const bags = [
      { item: 4240, name: "Woolen Bag", count: 1 },
      { item: 4240, name: "Woolen Bag", count: 1 },
    ];
    expect(bagTargets([], bags)).toEqual([{ entry: 4240, slot: 19 }, { entry: 4240, slot: 20 }]);
    // A dwarf hunter's starter shot pouch already sits in 19.
    expect(bagTargets([{ bag: 0, slot: 19, item: 7, entry: 5441 }], bags)).toEqual([{ entry: 4240, slot: 20 }, { entry: 4240, slot: 21 }]);
    // A backpack item at slot 23 is not a bag slot.
    expect(bagTargets([{ bag: 0, slot: 23, item: 8, entry: 6948 }], bags)[0]!.slot).toBe(19);
    const full = [19, 20, 21, 22].map((slot) => ({ bag: 0, slot, item: slot, entry: 4496 }));
    expect(() => bagTargets(full, bags)).toThrow(/no free bag slot/);
  });
});

describe("countByItem", () => {
  test("sums stacks by entry, an unknown count as one", () => {
    const c = countByItem([
      { itemId: 3770, count: 20 },
      { itemId: 3770, count: 5 },
      { itemId: 6948, count: undefined },
      { itemId: undefined, count: 3 },
    ]);
    expect([...c]).toEqual([
      [3770, 25],
      [6948, 1],
    ]);
  });
});

describe("parseStageArgs", () => {
  test("defaults to the five party accounts in role order", () => {
    expect(parseStageArgs([])).toEqual({ campaign: "manual", accounts: ACCOUNTS, roles: ROLES });
  });
  test("takes a campaign, accounts and roles, and refuses the rest", () => {
    expect(parseStageArgs(["--campaign", "deadmines@1", "--accounts", "party2,PARTY3", "--roles", "healer,mage"])).toEqual({ campaign: "deadmines@1", accounts: ["PARTY2", "PARTY3"], roles: ["healer", "mage"] });
    expect(() => parseStageArgs(["--roles", "bard"])).toThrow(/unknown role/);
    expect(() => parseStageArgs(["--password", "x"])).toThrow(/unknown flag --password/);
    expect(() => parseStageArgs(["stray"])).toThrow(/unexpected argument/);
  });
});

describe("stageParty refuses before touching anything", () => {
  let server: ReturnType<typeof Bun.serve> | undefined;
  afterEach(() => {
    server?.stop(true);
    server = undefined;
  });

  test("a malformed request is answered at the request step, with no SOAP, module or database call", async () => {
    const r = await stageParty({ campaign: "c", accounts: ["RUNNER"], roles: ["tank"], log: () => {}, moduleSecret: "x".repeat(32), soap: new SoapClient({ url: "http://127.0.0.1:1/", password: "pw" }) });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.step).toBe("request");
      expect(r.error).toMatch(/refusing to stage on 'RUNNER'/);
    }
  });

  test("a STAGER below SEC_ADMINISTRATOR stops it at preflight, before any account is listed or character deleted", async () => {
    const seen: string[] = [];
    server = Bun.serve({
      port: 0,
      fetch(req) {
        seen.push(`${req.method} ${new URL(req.url).pathname}`);
        return new Response("", { status: 403 });
      },
    });
    const soap = new SoapClient({ url: `http://127.0.0.1:${server.port}/`, password: "pw" });
    // The module URL points at the same fake: any module call would show up in `seen`.
    const r = await stageParty({ campaign: "c", accounts: ACCOUNTS, roles: ROLES, log: () => {}, soap, moduleUrl: `http://127.0.0.1:${server.port}`, moduleSecret: "x".repeat(32) });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.step).toBe("preflight");
      expect(r.error).toMatch(/below SEC_ADMINISTRATOR/);
    }
    expect(seen).toEqual(["POST /"]);
  });

  test("no module secret is a preflight refusal too", async () => {
    const r = await stageParty({ campaign: "c", accounts: ["PARTY1"], roles: ["tank"], log: () => {}, moduleSecret: "", soap: new SoapClient({ url: "http://127.0.0.1:1/", password: "pw" }) });
    expect(r.ok ? "" : r.step).toBe("preflight");
  });
});
