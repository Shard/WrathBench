/**
 * The stager's contract with the roster (infra/party-stager.ts on the fleet
 * side: `--request -`, one StageRequest on stdin, exit 0 with a last stdout
 * line `{"ok":true,…}`, else the reason on stderr's last line) and its pure
 * parts: what a request must be, where worn bags go, how landed items are
 * counted, and that a malformed request, a non-admin STAGER or a missing
 * secret ends the staging before any account, character or row is touched.
 * The live staging is proven by infra/smoke/party-staging.ts in a release window.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { SoapClient } from "./soap";
import {
  DEFAULT_PARTY_ACCOUNTS,
  bagTargets,
  checkStageRequest,
  countByItem,
  defaultStageRequest,
  parseCliArgs,
  parseStageRequest,
  stageParty,
  type StageRequest,
} from "./stage-party";

const SCRIPT = join(import.meta.dir, "stage-party.ts");

/** A request in the roster's exact shape (infra/party-stager.ts `StageRequest`), the leader first. */
function rosterRequest(): StageRequest {
  return {
    party: "deadmines-1-cell-a-20261019-1",
    campaign: "deadmines",
    version: 1,
    scenario: "moonbrook-mine",
    level: 20,
    members: [
      { member: "tank", role: "tank", race: 1, class: 1, character: "Brannoc", account: "PARTY1", runId: "deadmines-1-cell-a-20261019-1-tank" },
      { member: "healer", role: "healer", race: 3, class: 5, character: "Hilda", account: "PARTY2", runId: "deadmines-1-cell-a-20261019-1-healer" },
      { member: "mage", role: "damage", race: 1, class: 8, character: "Marwen", account: "PARTY3", runId: "deadmines-1-cell-a-20261019-1-mage" },
      { member: "rogue", role: "damage", race: 1, class: 4, character: "Rook", account: "PARTY4", runId: "deadmines-1-cell-a-20261019-1-rogue" },
      { member: "paladin", role: "damage", race: 3, class: 2, character: "Dain", account: "PARTY5", runId: "deadmines-1-cell-a-20261019-1-paladin" },
    ],
  };
}

describe("parseStageRequest: the roster's shape and nothing else", () => {
  test("takes the roster's request as it is sent", () => {
    const r = parseStageRequest(JSON.parse(JSON.stringify(rosterRequest())));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.request.members.map((m) => m.character)).toEqual(["Brannoc", "Hilda", "Marwen", "Rook", "Dain"]);
  });
  test("refuses a drifted contract loudly: unknown keys, missing or mistyped fields", () => {
    const bad = (doc: unknown) => {
      const r = parseStageRequest(doc);
      return r.ok ? "" : r.errors.join("; ");
    };
    expect(bad([])).toMatch(/not a JSON object/);
    expect(bad({ ...rosterRequest(), accounts: ["PARTY1"] })).toMatch(/unknown request key 'accounts'/);
    expect(bad({ ...rosterRequest(), level: "20" })).toMatch(/level must be an integer/);
    const { scenario: _s, ...noScenario } = rosterRequest();
    expect(bad(noScenario)).toMatch(/scenario must be a non-empty string/);
    const req = rosterRequest();
    expect(bad({ ...req, members: [{ ...req.members[0]!, roles: "tank" }] })).toMatch(/members\[0\]: unknown key 'roles'/);
    expect(bad({ ...req, members: [{ ...req.members[0]!, race: "1" }] })).toMatch(/members\[0\]\.race must be an integer/);
    expect(bad({ ...req, members: "x" })).toMatch(/members must be an array/);
  });
});

describe("checkStageRequest", () => {
  test("the roster's request and the default request are valid; names come from the request", () => {
    expect(checkStageRequest(rosterRequest())).toEqual([]);
    const d = defaultStageRequest({ party: "p" });
    expect(checkStageRequest(d)).toEqual([]);
    expect(d.members.map((m) => [m.member, m.account, m.character, m.role])).toEqual([
      ["tank", "PARTY1", "Tankpartyb", "tank"],
      ["healer", "PARTY2", "Healpartyc", "healer"],
      ["mage", "PARTY3", "Magepartyd", "damage"],
      ["rogue", "PARTY4", "Roguepartye", "damage"],
      ["paladin", "PARTY5", "Palapartyf", "damage"],
    ]);
    expect(d.scenario).toBe("moonbrook-mine");
    expect(d.level).toBe(20);
  });

  test("refuses any account but the party's, repeats, a member with no loadout, an unknown scenario and another level", () => {
    const with_ = (f: (r: StageRequest) => void) => {
      const r = rosterRequest();
      f(r);
      return checkStageRequest(r).join("; ");
    };
    expect(with_((r) => (r.members[0]!.account = "RUNNER"))).toMatch(/refusing to stage on 'RUNNER'/);
    expect(with_((r) => (r.members[0]!.account = "STAGER"))).toMatch(/refusing to stage on 'STAGER'/);
    expect(with_((r) => (r.members[1]!.account = "PARTY1"))).toMatch(/account PARTY1 is named twice/);
    expect(with_((r) => (r.members[1]!.character = "brannoc"))).toMatch(/character brannoc is named twice/);
    expect(with_((r) => (r.members[1]!.character = "Hil da"))).toMatch(/not a character name/);
    expect(with_((r) => Object.assign(r.members[4]!, { race: 4, class: 3 }))).toMatch(/paladin: no loadout for class 3/);
    expect(with_((r) => (r.members[4]!.race = 1))).toMatch(/Dwarf Paladin \(race 3\); the member is race 1/);
    expect(with_((r) => (r.members[1]!.role = "damage"))).toMatch(/plays "healer"/);
    expect(with_((r) => (r.scenario = "nowhere"))).toMatch(/unknown scenario 'nowhere'/);
    expect(with_((r) => (r.level = 25))).toMatch(/built for level 20/);
    expect(with_((r) => (r.members = []))).toMatch(/1\.\.5 members/);
  });
});

describe("bagTargets", () => {
  test("fills the first free bag slots, around what is already worn there", () => {
    const bags = [
      { item: 4240, name: "Woolen Bag", count: 1 },
      { item: 4240, name: "Woolen Bag", count: 1 },
    ];
    expect(bagTargets([], bags)).toEqual([{ entry: 4240, slot: 19 }, { entry: 4240, slot: 20 }]);
    expect(bagTargets([{ bag: 0, slot: 19, item: 7, entry: 4496 }], bags)).toEqual([{ entry: 4240, slot: 20 }, { entry: 4240, slot: 21 }]);
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

describe("the CLI", () => {
  test("takes --request <-|file> or --example, and nothing else", () => {
    expect(parseCliArgs(["--request", "-"])).toEqual({ kind: "request", source: "-" });
    expect(parseCliArgs(["--request", "/tmp/r.json"])).toEqual({ kind: "request", source: "/tmp/r.json" });
    expect(parseCliArgs(["--example"])).toEqual({ kind: "example" });
    for (const argv of [[], ["--request"], ["--campaign", "x"], ["--request", "-", "--example"]]) expect(() => parseCliArgs(argv)).toThrow(/usage/);
  });

  /** Run the script as the roster does: `bun stage-party.ts --request -`, the request on stdin. */
  async function run(stdin: string, argv = ["--request", "-"]) {
    const proc = Bun.spawn(["bun", SCRIPT, ...argv], { stdin: new Blob([stdin]), stdout: "pipe", stderr: "pipe", env: { ...process.env, WRATHBENCH_STAGER_PASSWORD: "" } });
    const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    return { out, err, code, lastErr: err.trim().split("\n").at(-1) ?? "" };
  }

  test("a refused request exits non-zero with the reason as stderr's last line, before touching anything", async () => {
    const notJson = await run("{nope");
    expect(notJson.code).toBe(2);
    expect(notJson.lastErr).toMatch(/not readable JSON/);
    const req = rosterRequest();
    req.members[0]!.account = "RUNNER";
    const runner = await run(JSON.stringify(req));
    expect(runner.code).toBe(2);
    expect(runner.lastErr).toMatch(/refused the request: .*refusing to stage on 'RUNNER'/);
    expect(runner.out).toBe("");
  }, 30_000);

  test("a staging that cannot start (no STAGER password here) exits 1 with the reason on stderr", async () => {
    const r = await run(JSON.stringify(rosterRequest()));
    expect(r.code).toBe(1);
    expect(r.lastErr).toMatch(/^stage-party: preflight: /);
    expect(r.out).not.toContain('"ok":true');
  }, 30_000);

  test("--example prints a request the stager accepts", async () => {
    const r = await run("", ["--example"]);
    expect(r.code).toBe(0);
    const parsed = parseStageRequest(JSON.parse(r.out));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(checkStageRequest(parsed.request)).toEqual([]);
  }, 30_000);
});

describe("stageParty refuses before touching anything", () => {
  let server: ReturnType<typeof Bun.serve> | undefined;
  afterEach(() => {
    server?.stop(true);
    server = undefined;
  });

  test("a malformed request is answered at the request step, with no SOAP, module or database call", async () => {
    const req = rosterRequest();
    req.members[0]!.account = "RUNNER";
    const r = await stageParty(req, { log: () => {}, moduleSecret: "x".repeat(32), soap: new SoapClient({ url: "http://127.0.0.1:1/", password: "pw" }) });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.step).toBe("request");
      expect(r.reason).toMatch(/refusing to stage on 'RUNNER'/);
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
    const r = await stageParty(defaultStageRequest({ accounts: DEFAULT_PARTY_ACCOUNTS }), { log: () => {}, soap, moduleUrl: `http://127.0.0.1:${server.port}`, moduleSecret: "x".repeat(32) });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.step).toBe("preflight");
      expect(r.reason).toMatch(/below SEC_ADMINISTRATOR/);
    }
    expect(seen).toEqual(["POST /"]);
  });

  test("no module secret is a preflight refusal too", async () => {
    const r = await stageParty(rosterRequest(), { log: () => {}, moduleSecret: "", soap: new SoapClient({ url: "http://127.0.0.1:1/", password: "pw" }) });
    expect(r.ok ? "" : r.step).toBe("preflight");
  });
});
