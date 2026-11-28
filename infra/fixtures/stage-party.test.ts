/**
 * The stager's contract with the roster (infra/party-stager.ts on the fleet
 * side: `--request -`, one StageRequest on stdin, exit 0 with a last stdout
 * line `{"ok":true,…}`, else the reason on stderr's last line) and its pure
 * parts: what a request must be, and that a malformed request, a non-admin STAGER or a missing
 * secret ends the staging before any account, character or row is touched;
 * and that every checked-in party definition is a party the stager takes.
 * The live staging is proven by infra/smoke/party-staging.ts in a release window.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { checkedIn, checkedInFiles } from "../../runner/test/fixtures/campaigns";
import { commandStager, type StageRequest as RosterRequest } from "../party-stager";
import { tempDirs } from "../temp-dirs";
import { stagingEnvOf } from "../world";
import { PARTY_DUNGEONS, partyDungeon } from "../smoke/lib/party";
import { loadoutFor, partyCharacterName, type Loadout } from "./loadouts";
import { RAID_LOADOUTS } from "./raid-loadouts";
import { ONYXIA_ENTRANCE_TRIGGER, SCENARIOS, type Scenario } from "./scenarios";
import { SoapClient } from "./soap";
import {
  BACKPACK_ROOM,
  DEFAULT_PARTY_ACCOUNTS,
  RAID_CONVERT_OPCODE,
  bagsFirst,
  checkStageRequest,
  convertToRaid,
  defaultStageRequest,
  maxMembers,
  parseStageRequest,
  stageParty,
  type RaidLeader,
  type StageRequest,
} from "./stage-party";
import { LOADOUTS, LOADOUT_IDS } from "./loadouts";

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

/** The roster's request on five eval-pool accounts, as a party campaign with `accounts: "evals"` draws them. */
function evalRequest(): StageRequest {
  const r = rosterRequest();
  r.members.forEach((m, i) => (m.account = `EVAL0${i + 1}`));
  return r;
}

/** The Onyxia raid's request, as the roster builds it from onyxia@1 on ten eval-pool accounts: every member with its spec. */
function raidRequest(): StageRequest {
  const def = checkedIn("onyxia@1");
  return {
    party: "onyxia-1-party-one-agent-20261128-1",
    campaign: "onyxia",
    version: 1,
    scenario: "dustwallow-lair",
    level: 80,
    members: def.party!.members.map((m, i) => ({
      member: m.id,
      role: m.role,
      ...(m.spec !== undefined ? { spec: m.spec } : {}),
      race: m.race,
      class: m.class,
      character: m.character,
      account: `EVAL${String(i + 1).padStart(2, "0")}`,
      runId: "onyxia-1-party-one-agent-20261128-1",
    })),
  };
}

/** A world id (infra/world.ts `WORLD_ID_RE`). */
const WORLD = "wabcdefghij";
const tempDir = tempDirs();

describe("parseStageRequest: the roster's shape and nothing else", () => {
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
    expect(bad({ ...req, members: [{ ...req.members[0]!, spec: 3 }] })).toMatch(/members\[0\]\.spec must be a non-empty string/);
  });

  test("takes a member's spec, and a request without one parses to the object it always did", () => {
    const raid = parseStageRequest(JSON.parse(JSON.stringify(raidRequest())));
    expect(raid.ok && raid.request.members[2]!.spec).toBe("holy");
    const plain = parseStageRequest(JSON.parse(JSON.stringify(rosterRequest())));
    expect(plain.ok && plain.request).toEqual(rosterRequest());
    expect(plain.ok && plain.request.members.some((m) => "spec" in m)).toBe(false);
  });
});

describe("checkStageRequest", () => {
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
    expect(with_((r) => (r.level = 25))).toMatch(/level 25: the loadouts are built for levels 20 and 24/);
    expect(with_((r) => (r.level = 21))).toMatch(/built for levels 20 and 24/);
    expect(with_((r) => (r.members = []))).toMatch(/1\.\.5 members/);
  });

  test("takes the party at 24 and on the other party scenarios", () => {
    for (const scenario of ["moonbrook-mine", "silverpine-keep", "stormwind-stockade"]) {
      for (const level of [20, 24]) expect([scenario, level, checkStageRequest({ ...rosterRequest(), scenario, level })]).toEqual([scenario, level, []]);
    }
  });

  test("refuses a party larger than its scenario's spots, naming the scenario and both counts", () => {
    expect(checkStageRequest({ ...rosterRequest(), scenario: "northshire-fresh" }).join("; ")).toMatch(/scenario 'northshire-fresh' has 0 party spots for 5 members/);
    expect(checkStageRequest({ ...rosterRequest(), scenario: "moonbrook-mine" })).toEqual([]);
  });

  test("a party is five unless its scenario stages a larger raid: ten outside Onyxia's Lair, and nowhere else", () => {
    expect(maxMembers("moonbrook-mine")).toBe(5);
    expect(maxMembers("stormwind-stockade")).toBe(5);
    expect(maxMembers("northshire-fresh")).toBe(5);
    expect(maxMembers("dustwallow-lair")).toBe(10);
    expect(checkStageRequest(raidRequest())).toEqual([]);
    // Ten on a group's scenario is refused by the count, not only by the spots.
    expect(checkStageRequest({ ...raidRequest(), scenario: "moonbrook-mine" }).join("; ")).toMatch(/a party is 1\.\.5 members, got 10/);
    const eleven = raidRequest();
    eleven.members.push({ ...eleven.members[9]!, member: "extra", character: "Extraraidl", account: "EVAL11" });
    expect(checkStageRequest(eleven).join("; ")).toMatch(/a party is 1\.\.10 members outside Onyxia's Lair, got 11/);
  });

  test("a raid member is keyed by class, spec and level: two priests are two loadouts, a spec is level 80's and level 80 needs one", () => {
    const r = raidRequest();
    const heal = r.members.filter((m) => m.class === 5 && m.role === "healer").map((m) => (loadoutFor(m, 80) as Loadout).id);
    expect(heal).toEqual(["holypriest", "discpriest"]);
    const with_ = (f: (q: StageRequest) => void) => {
      const q = raidRequest();
      f(q);
      return checkStageRequest(q).join("; ");
    };
    expect(with_((q) => delete q.members[3]!.spec)).toMatch(/discpriest: a member staged at 80 names its spec/);
    expect(with_((q) => (q.members[3]!.spec = "fury"))).toMatch(/no loadout for class 5 with spec fury/);
    expect(with_((q) => (q.members[3]!.role = "damage"))).toMatch(/Dwarf Priest \(Discipline\) loadout plays "healer"/);
    expect(with_((q) => (q.level = 24))).toMatch(/Human Warrior \(Protection\) loadout is built for level 80; the party is staged at 24/);
    // A level-20 member that names a spec is refused too: the spec is the raid's.
    const pinned = rosterRequest();
    pinned.members[0]!.spec = "protection";
    expect(checkStageRequest(pinned).join("; ")).toMatch(/built for level 80; the party is staged at 20/);
  });

  test("the default request is the Deadmines' at 20 unless told otherwise", () => {
    const d = defaultStageRequest({ party: "p" });
    expect([d.scenario, d.level]).toEqual(["moonbrook-mine", 20]);
    const s = defaultStageRequest({ party: "p", scenario: "stormwind-stockade", level: 24 });
    expect([s.scenario, s.level]).toEqual(["stormwind-stockade", 24]);
    expect(checkStageRequest(s)).toEqual([]);
  });
});

describe("the party scenarios' spots", () => {
  /** Inside an AreaTrigger.dbc volume: a sphere, or the oriented box Position::IsWithinBox tests. */
  const inside = (t: (typeof PARTY_DUNGEONS)[string]["entrance"] & { radius?: number; box?: { length: number; width: number; height: number; yaw: number } }, p: { x: number; y: number; z: number }) => {
    if (t.radius) return Math.hypot(p.x - t.x, p.y - t.y, p.z - t.z) <= t.radius;
    const b = t.box!;
    const dx = p.x - t.x;
    const dy = p.y - t.y;
    const c = Math.cos(-b.yaw);
    const s = Math.sin(-b.yaw);
    return Math.abs(dx * c - dy * s) <= b.length / 2 && Math.abs(dx * s + dy * c) <= b.width / 2 && Math.abs(p.z - t.z) <= b.height / 2;
  };

  for (const d of Object.values(PARTY_DUNGEONS)) {
    test(`${d.scenario}: five spots outside the entrance trigger, 10-14.4y from its centre (the Deadmines band), 2.8y or more apart, each facing it`, () => {
      const spots = (SCENARIOS[d.scenario] as Scenario).partySpots!;
      expect(spots).toHaveLength(5);
      for (const p of spots) {
        const d2 = Math.hypot(p.x - d.entrance.x, p.y - d.entrance.y);
        expect([p, d2 >= 10 && d2 <= 14.4]).toEqual([p, true]);
        expect([p, inside(d.entrance, p)]).toEqual([p, false]);
        const o = Math.atan2(d.entrance.y - p.y, d.entrance.x - p.x);
        expect(p.o).toBeCloseTo(o < 0 ? o + 2 * Math.PI : o, 6);
      }
      for (let i = 0; i < spots.length; i++) for (let j = i + 1; j < spots.length; j++) expect(Math.hypot(spots[i]!.x - spots[j]!.x, spots[i]!.y - spots[j]!.y)).toBeGreaterThanOrEqual(2.8);
    });
  }

  test("dustwallow-lair: ten spots outside Onyxia's Lair's sphere in three dimensions, 17-23.5y from its centre, 2.8y or more apart, each facing it", () => {
    const t = ONYXIA_ENTRANCE_TRIGGER;
    const spots = (SCENARIOS["dustwallow-lair"] as Scenario).partySpots!;
    expect(spots).toHaveLength(10);
    for (const p of spots) {
      const d3 = Math.hypot(p.x - t.x, p.y - t.y, p.z - t.z);
      expect([p, d3 > t.radius + 1 && d3 <= 23.5]).toEqual([p, true]);
      expect([p.map, p.zone]).toEqual([1, 15]);
      const o = Math.atan2(t.y - p.y, t.x - p.x);
      expect(p.o).toBeCloseTo(o < 0 ? o + 2 * Math.PI : o, 6);
    }
    for (let i = 0; i < spots.length; i++) for (let j = i + 1; j < spots.length; j++) expect(Math.hypot(spots[i]!.x - spots[j]!.x, spots[i]!.y - spots[j]!.y)).toBeGreaterThanOrEqual(2.8);
    expect(SCENARIOS["dustwallow-lair"].homebind).toMatchObject({ map: 1, zone: 513 });
  });

  test("every party smoke dungeon stages at a level the stager takes", () => {
    for (const d of Object.values(PARTY_DUNGEONS)) expect([d.scenario, checkStageRequest(defaultStageRequest({ party: "p", scenario: d.scenario, level: d.level }))]).toEqual([d.scenario, []]);
    expect(partyDungeon().scenario).toBe("moonbrook-mine");
    expect(() => partyDungeon("nowhere")).toThrow(/no party dungeon for scenario 'nowhere'/);
  });
});

describe("the checked-in party definitions", () => {
  const parties = checkedInFiles()
    .map((f) => checkedIn(f.replace(/\.json$/, "")))
    .filter((d) => d.party !== undefined);

  for (const def of parties.filter((d) => d.party!.size > 5)) {
    test(`${def.id}@${def.version}: the stager takes the raid on the eval pool's accounts, every member keyed by its spec`, () => {
      const start = def.start as { staged: string; level: number };
      const req: StageRequest = {
        party: "p",
        campaign: def.id,
        version: def.version,
        scenario: start.staged,
        level: start.level,
        members: def.party!.members.map((m, i) => ({ member: m.id, role: m.role, ...(m.spec !== undefined ? { spec: m.spec } : {}), race: m.race, class: m.class, character: m.character, account: `EVAL${String(i + 1).padStart(2, "0")}`, runId: "p" })),
      };
      expect(checkStageRequest(req)).toEqual([]);
      expect(new Set(def.party!.members.map((m) => (loadoutFor(m, start.level) as Loadout).id)).size).toBe(def.party!.size);
    });
  }

  for (const def of parties.filter((d) => d.party!.size <= 5)) {
    const members = def.party!.members;
    test(`${def.id}@${def.version}: the stager takes it on PARTY1..PARTY5 in member order, each member under the name derived from its account`, () => {
      const start = def.start as { staged: string; level: number };
      const req: StageRequest = {
        party: "p",
        campaign: def.id,
        version: def.version,
        scenario: start.staged,
        level: start.level,
        members: members.map((m, i) => ({ member: m.id, role: m.role, race: m.race, class: m.class, character: m.character, account: DEFAULT_PARTY_ACCOUNTS[i]!, runId: `p-${m.id}` })),
      };
      expect(checkStageRequest(req)).toEqual([]);
      // The names the staging smokes leave on those accounts: no create on one account races a delete on another.
      expect(members.map((m) => m.character)).toEqual(members.map((m, i) => partyCharacterName((loadoutFor(m) as Loadout).id as (typeof LOADOUT_IDS)[number], DEFAULT_PARTY_ACCOUNTS[i]!)));
    });

  }
});

describe("the accounts a party is staged on", () => {
  test("a party drawn from the eval pool is staged, as the pinned PARTY accounts are", () => {
    expect(checkStageRequest(evalRequest())).toEqual([]);
    const later = evalRequest();
    later.members[4]!.account = "EVAL99";
    expect(checkStageRequest(later)).toEqual([]);
    later.members[3]!.account = "eval99";
    expect(checkStageRequest(later).join("; ")).toMatch(/account EVAL99 is named twice/);
  });

  test("every other account is refused: the generated pool, tenants, runners, smokes, STAGER, and names only shaped like a party's", () => {
    for (const account of ["POOL01", "POOL10", "TENANT01", "TENANT99", "RUNNER", "RUNNER2", "SHAKEOUT", "SMOKE", "SMOKE4", "PROBE", "STAGER", "EVAL1", "EVAL100", "EVAL", "XEVAL01", "PARTY10"]) {
      const r = evalRequest();
      r.members[2]!.account = account;
      expect(checkStageRequest(r).join("; ")).toMatch(new RegExp(`refusing to stage on '${account}'`));
    }
  });
});

describe("on a world of its own", () => {
  let server: ReturnType<typeof Bun.serve> | undefined;
  const saved: Record<string, string | undefined> = {};
  const setEnv = (vars: Record<string, string>) => {
    for (const [k, v] of Object.entries(vars)) {
      if (!(k in saved)) saved[k] = process.env[k];
      process.env[k] = v;
    }
  };
  afterEach(() => {
    server?.stop(true);
    server = undefined;
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
      delete saved[k];
    }
  });

  /** The roster's env names the shared world, MODULE_HOST included (which moduleBase() prefers over WRATHBENCH_MODULE_URL). */
  const SHARED = {
    WRATHBENCH_MODULE_URL: "http://worldserver:8086",
    MODULE_HOST: "worldserver",
    MODULE_PORT: "8086",
    WRATHBENCH_SOAP_URL: "http://worldserver:7878/",
    WRATHBENCH_CHARACTERS_DB: "acore_characters",
    WRATHBENCH_STAGER_PASSWORD: "pw",
  };

  test("the roster's world env reaches the stager: its module, SOAP console and characters schema, never the shared world's", async () => {
    setEnv(SHARED);
    const dir = tempDir("wb-stage-world-");
    const script = join(dir, "where.ts");
    // The stager's own resolvers, run in the child the roster spawns.
    writeFileSync(
      script,
      [
        `import { moduleBase } from ${JSON.stringify(join(import.meta.dir, "../smoke/lib/module"))};`,
        `import { connectOptions } from ${JSON.stringify(join(import.meta.dir, "apply"))};`,
        `import { soapFromEnv } from ${JSON.stringify(join(import.meta.dir, "soap"))};`,
        "await Bun.stdin.text();",
        "console.log(JSON.stringify({ ok: true, detail: JSON.stringify({ module: moduleBase(), soap: soapFromEnv().url, schema: connectOptions().database }) }));",
      ].join("\n"),
    );
    const stager = commandStager({ cwd: dir, command: ["bun", script] });
    const onWorld = await stager.stage(evalRequest() as RosterRequest, undefined, stagingEnvOf(WORLD, 7878, {}));
    expect(onWorld.ok && JSON.parse(onWorld.detail!)).toEqual({ module: `http://${WORLD}.worlds:8086`, soap: `http://${WORLD}.worlds:7878/`, schema: `acore_characters_${WORLD}` });
  }, 30_000);

  test("the stager takes an eval party on a world and stages there: past the request, on the world's module and schema", async () => {
    const seen: string[] = [];
    server = Bun.serve({
      port: 0,
      fetch(req) {
        seen.push(`${req.method} ${new URL(req.url).pathname}`);
        return new Response("", { status: 403 });
      },
    });
    const env = { ...process.env, ...SHARED, ...stagingEnvOf(WORLD, 7878, {}), WRATHBENCH_SOAP_URL: `http://127.0.0.1:${server.port}/`, WRATHBENCH_MODULE_SECRET: "x".repeat(32) };
    const proc = Bun.spawn(["bun", SCRIPT, "--request", "-"], { stdin: new Blob([JSON.stringify(evalRequest())]), stdout: "pipe", stderr: "pipe", env });
    const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    // Refused by SOAP at preflight (exit 1), not refused as a request (exit 2).
    expect(code).toBe(1);
    expect(err.trim().split("\n").at(-1)).toMatch(/^stage-party: preflight: /);
    expect(out).toContain(`staging on module http://${WORLD}.worlds:8086, SOAP http://127.0.0.1:${server.port}/, characters schema acore_characters_${WORLD}`);
    expect(seen).toEqual(["POST /"]);
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
});

describe("raid staging's own steps", () => {
  test("a raid set's bags go on first, in a round of their own; no level-20 set ever does", () => {
    for (const id of LOADOUT_IDS) expect([id, bagsFirst(LOADOUTS[id])]).toEqual([id, false]);
    for (const l of Object.values(RAID_LOADOUTS)) expect([l.id, bagsFirst(l), l.gear.length + l.bags.length > BACKPACK_ROOM]).toEqual([l.id, true, true]);
  });

  /** A leader whose raw path answers as `reply` says, and whose group turns raid when the server would convert it. */
  function fakeLeader(reply: "converts" | "refused" | "ignored", method = false): RaidLeader & { sent: string[] } {
    let raid = false;
    const sent: string[] = [];
    const send = async (opcode: string) => {
      sent.push(opcode);
      if (reply === "refused") throw new Error(`POST /action -> 400 opcode_not_allowed: sdk.raw() sends only the CMSG_* opcodes on the module's raw allowlist`);
      if (reply === "converts") raid = true;
      return { ok: true, action: "raw", opcode, payload: "" };
    };
    return {
      sent,
      raw: ((opcode: string) => send(opcode)) as unknown as RaidLeader["raw"],
      state: { group: () => ({ raid }) } as unknown as RaidLeader["state"],
      ...(method ? { convertToRaid: () => send("method") } : {}),
    };
  }

  test("converts through the raw action with the opcode's name, and waits for the server's raid flag", async () => {
    const lead = fakeLeader("converts");
    await convertToRaid(lead, { timeoutMs: 500, pollMs: 5 });
    expect(lead.sent).toEqual([RAID_CONVERT_OPCODE]);
    expect(RAID_CONVERT_OPCODE).toBe("CMSG_GROUP_RAID_CONVERT");
  });

  test("prefers a dedicated SDK method when the SDK has one", async () => {
    const lead = fakeLeader("converts", true);
    await convertToRaid(lead, { timeoutMs: 500, pollMs: 5 });
    expect(lead.sent).toEqual(["method"]);
  });

  test("a module without the opcode on its allowlist ends the step with the reason; a convert the server ignores times out naming why", async () => {
    await expect(convertToRaid(fakeLeader("refused"), { timeoutMs: 100, pollMs: 5 })).rejects.toThrow(/the module refused CMSG_GROUP_RAID_CONVERT \(not on its raw allowlist\)/);
    await expect(convertToRaid(fakeLeader("ignored"), { timeoutMs: 50, pollMs: 5 })).rejects.toThrow(/still not a raid/);
  });
});
