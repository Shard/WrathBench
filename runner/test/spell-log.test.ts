/**
 * The spell combat log on the event window: `SMSG_SPELLNONMELEEDAMAGELOG`,
 * `SMSG_SPELLHEALLOG` and `SMSG_SPELLENERGIZELOG` (wrath-mcp/module/PROTOCOL.md, "Spell
 * combat log"), and the dispel lines judged by the same rule
 * (`SMSG_SPELLDISPELLOG`, `SMSG_SPELLSTEALLOG`, `SMSG_DISPEL_FAILED`, which
 * carry no sentence). Three layers: the pure sentence and window predicate
 * (context.ts, `spellLogNote` / `spellLogShown`), `eventWindow` and the line
 * format over marked summaries, and the sandbox child marking events as they
 * arrive, run for real against a hand-fed stream.
 *
 * Every frame is hand-written from PROTOCOL.md's tables; the unit and spell
 * names are invented. Nothing here is captured from a running game (CLAUDE.md).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { CONTEXT_POLICY, DISPEL_LOG_OPCODES, eventWindow, formatEventLine, spellLogNote, spellLogShown } from "../src/context";
import { SandboxHost } from "../src/sandbox/host";
import type { EventSummary } from "@wrathbench/mcp";
import { Scratchpad } from "@wrathbench/mcp";
import { tempDirs } from "./fixtures/temp-dirs";

const ME = "7";
const MEMBER = "941";
const MOB = "17379391048826012345";
const STRANGER = "960";

const damage = (casterGuid: string, targetGuid: string, over: Record<string, unknown> = {}) => ({
  targetGuid,
  casterGuid,
  spellId: 9001,
  rank: 1,
  name: "Test Bolt",
  damage: 54,
  overkill: 0,
  schoolMask: 4,
  absorb: 0,
  resist: 0,
  blocked: 0,
  hitInfo: 0,
  crit: false,
  ...over,
});
const heal = (casterGuid: string, targetGuid: string, over: Record<string, unknown> = {}) => ({
  targetGuid,
  casterGuid,
  spellId: 9002,
  name: "Test Mend",
  amount: 120,
  overheal: 0,
  absorb: 0,
  crit: false,
  ...over,
});
const energize = (casterGuid: string, targetGuid: string) => ({
  targetGuid,
  casterGuid,
  spellId: 9003,
  name: "Test Surge",
  powerType: 1,
  amount: 10,
});

/** A dispel (or Spellsteal, or the auras that resisted one), in PROTOCOL.md's shape. */
const dispel = (casterGuid: string, targetGuid: string) => ({
  targetGuid,
  casterGuid,
  spellId: 9004,
  rank: 1,
  name: "Test Cleanse",
  auras: [{ spellId: 9005, rank: 1, name: "Test Hex" }],
});

const names: Record<string, string> = { [MOB]: "Test Evoker", [MEMBER]: "Ysolde", [STRANGER]: "Wanderer" };
const nameOf = (g: string): string | undefined => names[g];

describe("spellLogNote: the combat log's sentence", () => {
  test.each([
    ["a mob's hit on us", "SMSG_SPELLNONMELEEDAMAGELOG", damage(MOB, ME), "Test Evoker's Test Bolt hits you for 54 (fire)"],
    [
      "a crit with absorb, resist, block and overkill",
      "SMSG_SPELLNONMELEEDAMAGELOG",
      damage(ME, MOB, { crit: true, absorb: 5, resist: 4, blocked: 3, overkill: 2, schoolMask: 0x14 }),
      "Your Test Bolt crits Test Evoker for 54 (fire+frost, 5 absorbed, 4 resisted, 3 blocked, 2 overkill)",
    ],
    ["a hit on a party member", "SMSG_SPELLNONMELEEDAMAGELOG", damage(MOB, MEMBER), "Test Evoker's Test Bolt hits Ysolde for 54 (fire)"],
    ["our own heal on ourselves", "SMSG_SPELLHEALLOG", heal(ME, ME), "Your Test Mend heals you for 120"],
    [
      "a member's crit heal on us, part overheal",
      "SMSG_SPELLHEALLOG",
      heal(MEMBER, ME, { crit: true, overheal: 30 }),
      "Ysolde's Test Mend critically heals you for 120 (30 overheal)",
    ],
    ["a power gain", "SMSG_SPELLENERGIZELOG", energize(ME, ME), "Your Test Surge gives you 10 rage"],
  ])("%s", (_, opcode, data, want) => {
    expect(spellLogNote(opcode, data, ME, nameOf)).toBe(want);
  });

  test("an unnamed caster and a spell the core has no name for still read", () => {
    const d = { ...damage("123", ME), name: undefined, spellId: 4242 };
    expect(spellLogNote("SMSG_SPELLNONMELEEDAMAGELOG", d, ME, nameOf)).toBe(
      "An unnamed unit's spell 4242 hits you for 54 (fire)",
    );
  });

  test("every other opcode has no sentence", () => {
    expect(spellLogNote("SMSG_ATTACKERSTATEUPDATE", damage(MOB, ME), ME, nameOf)).toBeUndefined();
    expect(spellLogNote("SMSG_PERIODICAURALOG", damage(MOB, ME), ME, nameOf)).toBeUndefined();
  });

  test("a dispel line has none either", () => {
    for (const opcode of DISPEL_LOG_OPCODES) expect(spellLogNote(opcode, dispel(ME, MOB), ME, nameOf)).toBeUndefined();
  });
});

describe("spellLogShown: which spell lines the window keeps", () => {
  const party = new Set([MEMBER]);
  test.each([
    ["damage on us", "SMSG_SPELLNONMELEEDAMAGELOG", damage(MOB, ME), true],
    ["damage we deal", "SMSG_SPELLNONMELEEDAMAGELOG", damage(ME, MOB), true],
    ["damage a party member takes", "SMSG_SPELLNONMELEEDAMAGELOG", damage(MOB, MEMBER), true],
    ["damage a party member deals", "SMSG_SPELLNONMELEEDAMAGELOG", damage(MEMBER, MOB), false],
    ["damage between strangers", "SMSG_SPELLNONMELEEDAMAGELOG", damage(STRANGER, MOB), false],
    ["a heal on us", "SMSG_SPELLHEALLOG", heal(MEMBER, ME), true],
    ["a heal we cast on a member", "SMSG_SPELLHEALLOG", heal(ME, MEMBER), true],
    ["a member's heal on a member", "SMSG_SPELLHEALLOG", heal(MEMBER, MEMBER), false],
    ["our own power gain", "SMSG_SPELLENERGIZELOG", energize(ME, ME), true],
    ["a member's power gain", "SMSG_SPELLENERGIZELOG", energize(MEMBER, MEMBER), false],
    ["our dispel on a mob", "SMSG_SPELLDISPELLOG", dispel(ME, MOB), true],
    ["a mob's dispel on us", "SMSG_SPELLDISPELLOG", dispel(MOB, ME), true],
    ["a member's cleanse on us", "SMSG_SPELLDISPELLOG", dispel(MEMBER, ME), true],
    ["a mob's purge of a member", "SMSG_SPELLDISPELLOG", dispel(MOB, MEMBER), false],
    ["a member's cleanse of a member", "SMSG_SPELLDISPELLOG", dispel(MEMBER, MEMBER), false],
    ["strangers' dispel", "SMSG_SPELLDISPELLOG", dispel(STRANGER, MOB), false],
    ["our Spellsteal", "SMSG_SPELLSTEALLOG", dispel(ME, MOB), true],
    ["a stranger's Spellsteal", "SMSG_SPELLSTEALLOG", dispel(STRANGER, MOB), false],
    ["our dispel resisted", "SMSG_DISPEL_FAILED", dispel(ME, MOB), true],
    ["a resisted dispel on us", "SMSG_DISPEL_FAILED", dispel(MOB, ME), true],
    ["a member's dispel resisted", "SMSG_DISPEL_FAILED", dispel(MEMBER, MOB), false],
  ])("%s", (_, opcode, data, want) => {
    expect(spellLogShown(opcode, data, ME, party)).toBe(want);
  });

  test("every other opcode is shown, whoever it names", () => {
    expect(spellLogShown("SMSG_PERIODICAURALOG", damage(STRANGER, MOB), ME, party)).toBe(true);
    expect(spellLogShown("SMSG_ATTACKERSTATEUPDATE", {}, ME, party)).toBe(true);
  });
});

describe("eventWindow and the line over marked summaries", () => {
  const ev = (seq: number, opcode: string, extra: Partial<EventSummary> = {}): EventSummary => ({
    seq,
    ts: 1000 + seq,
    opcode,
    data: {},
    ...extra,
  });

  test("a bystander's line is left out and not counted as ambient", () => {
    const { window, folded } = eventWindow(
      [
        ev(1, "SMSG_SPELLHEALLOG", { bystander: true }),
        ev(2, "SMSG_MONSTER_MOVE"),
        ev(3, "SMSG_SPELLNONMELEEDAMAGELOG", { note: "x" }),
      ],
      0,
    );
    expect(window.map((e) => e.seq)).toEqual([3]);
    expect(folded).toBe(1);
  });

  test("the sentence follows the raw payload, which stays whole", () => {
    const line = formatEventLine({
      seq: 12,
      ts: 0,
      opcode: "SMSG_SPELLNONMELEEDAMAGELOG",
      data: damage(MOB, ME),
      note: "Test Evoker's Test Bolt hits you for 54 (fire)",
    });
    expect(line).toStartWith(`#12 SMSG_SPELLNONMELEEDAMAGELOG {"targetGuid":"7","casterGuid":"${MOB}","spellId":9001,`);
    expect(line).toEndWith(` — Test Evoker's Test Bolt hits you for 54 (fire)`);
    // Under the per-event data cap, so nothing of the payload is cut.
    expect(JSON.stringify(damage(MOB, ME)).length).toBeLessThanOrEqual(CONTEXT_POLICY.EVENT_DATA_CHARS);
  });
});

// ------------------------------------------------------------ the child

const tempDir = tempDirs();
const hosts: SandboxHost[] = [];

function makeHost(): SandboxHost {
  const dir = tempDir("wrathbench-spell-log-");
  const host = new SandboxHost({
    moduleUrl: "http://worldserver:8086",
    token: "test-token",
    scratchpad: new Scratchpad(join(dir, "scratchpad.md")),
    snippetTimeoutMs: 5_000,
    pingGraceMs: 1_000,
  });
  hosts.push(host);
  return host;
}

afterEach(async () => {
  await Promise.all(hosts.splice(0, hosts.length).map((h) => h.stop()));
});

/** Us, one party member, and a named caster mob in view. */
const PRELUDE = `
state.seedSelf({ guid: "${ME}", name: "Fenwick" });
globalThis.seq = 1;
globalThis.feed = (opcode, opcodeId, data) => {
  events.ingest(JSON.stringify({ seq: seq++, opcode, opcodeId, ts: Date.now(), data }));
};
feed("SMSG_GROUP_LIST", 0x07d, { groupType: 0, left: false, raid: false, subGroup: 0, memberFlags: 0, roles: 0,
  groupGuid: "1", counter: 1, leaderGuid: "${ME}", lootMethod: 0,
  members: [{ name: "Ysolde", guid: "${MEMBER}", online: true, subGroup: 0, flags: 0, roles: 0 }] });
feed("SMSG_UPDATE_OBJECT", 0x0a9, { blocks: 1, objects: [{ update: "create", guid: "${MOB}", objectType: "unit",
  pos: { x: 6, y: 8, z: 0, o: 0 }, fields: { entry: 1732, health: 900, maxHealth: 1000, level: 18 } }] });
feed("SMSG_CREATURE_QUERY_RESPONSE", 0x061, { entry: 1732, found: true, name: "Test Evoker", subname: "", type: 7, rank: 0 });
"ready";
`;

describe("the sandbox child marks spell lines as they arrive", () => {
  test("ours and a member's damage taken reach the window with their sentence; a bystander's stays on the raw stream", async () => {
    const host = makeHost();
    expect((await host.evalSnippet(PRELUDE)).ok).toBe(true);
    const fed = await host.evalSnippet(`
      feed("SMSG_SPELLNONMELEEDAMAGELOG", 0x250, ${JSON.stringify(damage(MOB, ME))});
      feed("SMSG_SPELLNONMELEEDAMAGELOG", 0x250, ${JSON.stringify(damage(MOB, MEMBER))});
      feed("SMSG_SPELLHEALLOG", 0x150, ${JSON.stringify(heal(MEMBER, MEMBER))});
      // The mob dies and leaves view before the turn renders: named as it was.
      feed("SMSG_DESTROY_OBJECT", 0x0aa, { guid: "${MOB}", onDeath: true });
      "fed";
    `);
    expect(fed.ok).toBe(true);
    const { events } = await host.contextEvents(CONTEXT_POLICY.EVENT_WINDOW);
    const spell = events.filter((e) => e.opcode.startsWith("SMSG_SPELL"));
    expect(spell.map((e) => e.note)).toEqual([
      "Test Evoker's Test Bolt hits you for 54 (fire)",
      "Test Evoker's Test Bolt hits Ysolde for 54 (fire)",
    ]);
    const raw = await host.recentEvents(50);
    const bystander = raw.find((e) => e.opcode === "SMSG_SPELLHEALLOG");
    expect(bystander).toMatchObject({ bystander: true, note: "Ysolde's Test Mend heals Ysolde for 120" });
  });

  test("our dispel reaches the window without a sentence; a member's and a mob's purge of a member stay on the raw stream", async () => {
    const host = makeHost();
    expect((await host.evalSnippet(PRELUDE)).ok).toBe(true);
    const fed = await host.evalSnippet(`
      feed("SMSG_SPELLDISPELLOG", 0x27b, ${JSON.stringify(dispel(ME, MOB))});
      feed("SMSG_DISPEL_FAILED", 0x262, ${JSON.stringify(dispel(MOB, ME))});
      feed("SMSG_SPELLSTEALLOG", 0x333, ${JSON.stringify(dispel(MOB, MEMBER))});
      feed("SMSG_SPELLDISPELLOG", 0x27b, ${JSON.stringify(dispel(MEMBER, MEMBER))});
      "fed";
    `);
    expect(fed.ok).toBe(true);
    const { events } = await host.contextEvents(CONTEXT_POLICY.EVENT_WINDOW);
    const shown = events.filter((e) => DISPEL_LOG_OPCODES.has(e.opcode));
    expect(shown.map((e) => e.opcode)).toEqual(["SMSG_SPELLDISPELLOG", "SMSG_DISPEL_FAILED"]);
    expect(shown.map((e) => e.note)).toEqual([undefined, undefined]);
    expect(shown.map((e) => e.schemaError)).toEqual([undefined, undefined]);
    const raw = (await host.recentEvents(50)).filter((e) => DISPEL_LOG_OPCODES.has(e.opcode));
    expect(raw.map((e) => [e.opcode, e.bystander === true])).toEqual([
      ["SMSG_SPELLDISPELLOG", false],
      ["SMSG_DISPEL_FAILED", false],
      ["SMSG_SPELLSTEALLOG", true],
      ["SMSG_SPELLDISPELLOG", true],
    ]);
  });
});
