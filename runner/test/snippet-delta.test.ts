/**
 * The snippet delta (`sandbox/snippet-delta.ts`): what changed since the
 * previous snippet result, on the drivers whose registry entry renders it.
 *
 * The recorder is pure over a narrow reading of the cache, so most of it is
 * tested against hand-written fixture state; one case drives the real child
 * through the host, and the tool dispatcher is tested with and without the
 * switch. Names and numbers are Deadmines-shaped but invented, never captured
 * from a running game (CLAUDE.md).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { AdapterOutcome, ChatAdapter, ChatRequest } from "../src/adapter";
import { loadRunConfig } from "../src/config";
import type { GroupMemberLike, UnitLike } from "../src/context";
import { runLoop } from "../src/loop";
import { Trajectory, readTrajectory } from "../src/trajectory";
import { Watchdogs } from "../src/watchdogs";
import { DRIVER_LIST, entryOf } from "../src/drivers";
import { EpisodicLog } from "../src/episodic";
import { SNIPPET_DELTA_SENTENCE, buildSystemPrompt } from "../src/prompt";
import { ReflectGate } from "../src/reflect";
import { SecretRedactor } from "../src/redact";
import { SandboxHost, type SnippetResult } from "../src/sandbox/host";
import {
  SNIPPET_DELTA,
  SNIPPET_DELTA_HEADER,
  SnippetDeltaRecorder,
  renderSnippetDelta,
  type SnippetDelta,
  type SnippetDeltaState,
} from "../src/sandbox/snippet-delta";
import { Scratchpad } from "../src/scratchpad";
import { callTool, renderActionHints, type ToolContext } from "../src/tools";
import { tempDirs } from "./fixtures/temp-dirs";

const tempDir = tempDirs();

const ME = "7";
const TANK = "21";
const HEAL = "22";
const ROGUE = "23";

/** A mutable world the recorder reads; each test edits it and feeds an event. */
function world() {
  const w = {
    level: 19 as number | undefined,
    members: [] as GroupMemberLike[],
    units: new Map<string, UnitLike>(),
    quests: [] as { questId: number; complete: boolean; title?: string; level?: number }[],
    names: new Map<string, string>([
      ["99", "Defias Evoker"],
      ["98", "Defias Miner"],
      ["97", "Defias Squallshaper"],
    ]),
  };
  const state: SnippetDeltaState = {
    selfGuid: () => ME,
    level: () => w.level,
    group: () => ({ inGroup: true, members: w.members }),
    memberUnit: (guid) => w.units.get(guid),
    questLog: () => w.quests,
    nameOf: (guid) => w.names.get(guid) ?? w.members.find((m) => m.guid === guid)?.name as string | undefined,
  };
  let seq = 1;
  const rec = new SnippetDeltaRecorder(state);
  const feed = (opcode = "SMSG_UPDATE_OBJECT", data: unknown = {}): void => rec.observe({ opcode, seq: seq++, data });
  return { w, rec, feed, nextSeq: () => seq };
}

const unit = (health: number, maxHealth = 1000, ghost = false): UnitLike => ({
  health,
  maxHealth,
  dead: health === 0,
  ghost,
});

const chat = (type: number, senderGuid: string, message: string) => ({ type, language: 0, senderGuid, message, chatTag: 0 });

const spell = (casterGuid: string, name: string, damage: number) => ({
  targetGuid: ME,
  casterGuid,
  spellId: 1,
  name,
  damage,
  overkill: 0,
  schoolMask: 4,
  absorb: 0,
  resist: 0,
  blocked: 0,
  crit: false,
});

const swing = (attackerGuid: string, damage: number, miss = false) => ({
  attackerGuid,
  victimGuid: ME,
  hitInfo: 0,
  damage,
  overkill: 0,
  absorb: 0,
  resist: 0,
  blocked: 0,
  victimState: 1,
  miss,
  crit: false,
});

/** The party in view, all healthy, read once so every member is seeded. */
function seededParty() {
  const t = world();
  t.w.members = [
    { guid: TANK, name: "Tankpartyb", online: true },
    { guid: HEAL, name: "Healpartyc", online: true },
    { guid: ROGUE, name: "Roguepartye", online: true },
  ];
  t.w.units.set(TANK, unit(1000));
  t.w.units.set(HEAL, unit(800, 800));
  t.w.units.set(ROGUE, unit(900, 900));
  t.w.quests = [{ questId: 214, complete: false, title: "Red Silk Bandanas" }];
  t.feed();
  // The first drain seeds level and quests silently.
  expect(renderSnippetDelta(t.rec.drain())).toBeUndefined();
  return t;
}

describe("the snippet delta recorder and its block", () => {
  test("empty when nothing changed: no header at all", () => {
    const t = seededParty();
    t.feed();
    t.feed("SMSG_PARTY_MEMBER_STATS", {});
    expect(renderSnippetDelta(t.rec.drain())).toBeUndefined();
  });

  test("a member's death and a new chat line show once, then the block is empty again", () => {
    const t = seededParty();
    t.w.units.set(TANK, unit(400));
    t.feed();
    t.w.units.set(TANK, unit(180));
    t.feed();
    t.w.units.set(TANK, unit(0));
    t.feed();
    t.feed("SMSG_MESSAGECHAT", chat(0x02, TANK, "pull back to the ramp"));
    const block = renderSnippetDelta(t.rec.drain());
    expect(block).toBe(
      [SNIPPET_DELTA_HEADER, "Tankpartyb: below 50%, below 25%, died", "chat:", "  [party] <Tankpartyb> pull back to the ramp"].join("\n"),
    );
    t.feed();
    expect(renderSnippetDelta(t.rec.drain())).toBeUndefined();
  });

  test("a death and a rez between two results are both told, in order, with the health now", () => {
    const t = seededParty();
    t.w.units.set(HEAL, unit(0, 800));
    t.feed();
    t.w.units.set(HEAL, unit(1, 800, true));
    t.feed();
    t.w.units.set(HEAL, unit(400, 800));
    t.feed();
    expect(renderSnippetDelta(t.rec.drain())).toBe(`${SNIPPET_DELTA_HEADER}\nHealpartyc: died, released, alive again (now 50%)`);
  });

  test("health flapping around half is one line, not a tick per swing", () => {
    const t = seededParty();
    for (const hp of [450, 600, 420, 700, 380]) {
      t.w.units.set(TANK, unit(hp));
      t.feed();
    }
    expect(renderSnippetDelta(t.rec.drain())).toBe(`${SNIPPET_DELTA_HEADER}\nTankpartyb: below 50% (now 38%)`);
  });

  test("a member leaving view for the instance is told by its fresh party frame, never by a stale one", () => {
    const t = seededParty();
    // The SDK still holds a party frame from long before the rogue came into view.
    const staleSeq = 0;
    t.w.units.delete(ROGUE);
    t.w.members[2] = { ...t.w.members[2]!, stats: { online: true, dead: true, health: 0, maxHealth: 900, zone: { name: "Elwynn Forest" }, seq: staleSeq } };
    t.feed();
    expect(renderSnippetDelta(t.rec.drain())).toBeUndefined();
    // Its first fresh frame is where it is, not a change.
    t.w.members[2] = { ...t.w.members[2]!, stats: { online: true, dead: false, health: 900, maxHealth: 900, zone: { name: "Westfall" }, seq: t.nextSeq() } };
    t.feed("SMSG_PARTY_MEMBER_STATS", {});
    expect(renderSnippetDelta(t.rec.drain())).toBeUndefined();
    t.w.members[2] = { ...t.w.members[2]!, stats: { online: true, dead: false, health: 900, maxHealth: 900, zone: { name: "The Deadmines" }, seq: t.nextSeq() } };
    t.feed("SMSG_PARTY_MEMBER_STATS", {});
    expect(renderSnippetDelta(t.rec.drain())).toBe(`${SNIPPET_DELTA_HEADER}\nRoguepartye: now in The Deadmines`);
  });

  test("a member drifting in and out of view at a portal is not moving: only its death, release and rez are told", () => {
    // Our ghost runs back across Westfall while the healer, dead and then a
    // ghost, sits on the far side of the zone line and drifts in and out of
    // view. Out of view its own party frame names The Deadmines; in view the
    // SDK keeps that frame, as old as the last packet, and the unit is read.
    const t = seededParty();
    const frame = (st: { dead?: boolean; ghost?: boolean; health: number }, zone = "The Deadmines") => {
      t.w.members[1] = { ...t.w.members[1]!, stats: { online: true, maxHealth: 800, zone: { name: zone }, seq: t.nextSeq(), ...st } };
      t.feed("SMSG_PARTY_MEMBER_STATS", {});
    };
    const inView = (u: UnitLike) => {
      t.w.units.set(HEAL, u);
      t.feed();
    };
    const outOfView = (st: { dead?: boolean; ghost?: boolean; health: number }, zone?: string) => {
      t.w.units.delete(HEAL);
      frame(st, zone);
    };
    for (let i = 0; i < 4; i++) {
      outOfView({ dead: false, ghost: false, health: 800 });
      inView(unit(800, 800));
    }
    inView(unit(0, 800));
    for (let i = 0; i < 6; i++) {
      outOfView({ dead: true, ghost: false, health: 0 });
      inView(unit(0, 800));
    }
    inView(unit(1, 800, true));
    for (let i = 0; i < 6; i++) {
      outOfView({ dead: false, ghost: true, health: 1 });
      inView(unit(1, 800, true));
    }
    inView(unit(400, 800));
    for (let i = 0; i < 4; i++) {
      outOfView({ dead: false, ghost: false, health: 400 });
      inView(unit(400, 800));
    }
    expect(renderSnippetDelta(t.rec.drain())).toBe(`${SNIPPET_DELTA_HEADER}\nHealpartyc: died, released, alive again (now 50%)`);
  });

  test("a member's genuine zone change in that drift is told once, beside its other news", () => {
    const t = seededParty();
    const outOfView = (st: { dead?: boolean; ghost?: boolean; health: number }, zone: string) => {
      t.w.units.delete(HEAL);
      t.w.members[1] = { ...t.w.members[1]!, stats: { online: true, maxHealth: 800, zone: { name: zone }, seq: t.nextSeq(), ...st } };
      t.feed("SMSG_PARTY_MEMBER_STATS", {});
    };
    const inView = (u: UnitLike) => {
      t.w.units.set(HEAL, u);
      t.feed();
    };
    outOfView({ dead: false, ghost: false, health: 800 }, "The Deadmines");
    inView(unit(0, 800));
    for (let i = 0; i < 3; i++) {
      outOfView({ dead: true, health: 0 }, "The Deadmines");
      inView(unit(0, 800));
    }
    inView(unit(1, 800, true));
    // It walks out through the portal, a ghost, and its frame says so.
    for (let i = 0; i < 3; i++) {
      outOfView({ dead: false, ghost: true, health: 1 }, "Westfall");
      inView(unit(1, 800, true));
    }
    inView(unit(400, 800));
    outOfView({ dead: false, ghost: false, health: 400 }, "Westfall");
    inView(unit(400, 800));
    expect(renderSnippetDelta(t.rec.drain())).toBe(
      `${SNIPPET_DELTA_HEADER}\nHealpartyc: died, released, now in Westfall, alive again (now 50%)`,
    );
  });

  test("offline, and leaving the group, are transitions too", () => {
    const t = seededParty();
    t.w.members[0] = { ...t.w.members[0]!, online: false };
    t.w.units.delete(TANK);
    t.w.members.splice(1, 1);
    t.w.units.delete(HEAL);
    t.feed("SMSG_GROUP_LIST", {});
    expect(renderSnippetDelta(t.rec.drain())).toBe(`${SNIPPET_DELTA_HEADER}\nTankpartyb: offline\nHealpartyc: left the group`);
  });

  test("damage taken is one line, totalled per source, from spell and melee logs", () => {
    const t = seededParty();
    t.feed("SMSG_SPELLNONMELEEDAMAGELOG", spell("99", "Fireball", 112));
    t.feed("SMSG_SPELLNONMELEEDAMAGELOG", spell("99", "Fireball", 98));
    t.feed("SMSG_SPELLNONMELEEDAMAGELOG", spell("99", "Frostbolt", 61));
    t.feed("SMSG_SPELLNONMELEEDAMAGELOG", spell("99", "Fireball", 105));
    t.feed("SMSG_ATTACKERSTATEUPDATE", swing("98", 21));
    t.feed("SMSG_ATTACKERSTATEUPDATE", swing("98", 0, true));
    t.feed("SMSG_ATTACKERSTATEUPDATE", swing("98", 15));
    // Not ours: another's hit on the tank, and our own spell on a mob.
    t.feed("SMSG_SPELLNONMELEEDAMAGELOG", { ...spell("99", "Fireball", 300), targetGuid: TANK });
    t.feed("SMSG_SPELLNONMELEEDAMAGELOG", { ...spell(ME, "Frostbolt", 300), targetGuid: "99" });
    expect(renderSnippetDelta(t.rec.drain())).toBe(
      `${SNIPPET_DELTA_HEADER}\ntook 412: Defias Evoker 376 (Fireball ×3, Frostbolt), Defias Miner 36 (melee ×2)`,
    );
  });

  test("our own lines, creature speech and say lines are not chat for the block; whispers are", () => {
    const t = seededParty();
    t.feed("SMSG_MESSAGECHAT", chat(0x02, ME, "mine"));
    t.feed("SMSG_MESSAGECHAT", chat(0x0c, "99", "You there! Check out that noise."));
    t.feed("SMSG_MESSAGECHAT", chat(0x01, TANK, "a say"));
    t.feed("SMSG_MESSAGECHAT", chat(0x07, HEAL, "oom, drink after this"));
    expect(renderSnippetDelta(t.rec.drain())).toBe(`${SNIPPET_DELTA_HEADER}\nchat:\n  [whisper] <Healpartyc> oom, drink after this`);
  });

  test("chat keeps the newest five and says how many came before", () => {
    const t = seededParty();
    for (let i = 1; i <= 8; i++) t.feed("SMSG_MESSAGECHAT", chat(0x02, TANK, `line ${i}`));
    const block = renderSnippetDelta(t.rec.drain())!;
    expect(block).toContain("chat (+3 earlier):");
    expect(block).not.toContain("line 3");
    expect(block).toContain("line 4");
    expect(block).toContain("line 8");
  });

  test("a level-up and the quest log's changes are told, and seeded silently the first time", () => {
    const t = seededParty();
    t.w.level = 20;
    // The HUD's level bracket stays out of the delta: it names quests by label.
    t.w.quests = [
      { questId: 214, complete: true, title: "Red Silk Bandanas", level: 17 },
      { questId: 155, complete: false, title: "The Defias Brotherhood", level: 22 },
    ];
    expect(renderSnippetDelta(t.rec.drain())).toBe(
      `${SNIPPET_DELTA_HEADER}\nlevel 19 → 20\nquests: complete — 214 Red Silk Bandanas; new — 155 The Defias Brotherhood`,
    );
    t.w.quests = [{ questId: 155, complete: false, title: "The Defias Brotherhood" }];
    expect(renderSnippetDelta(t.rec.drain())).toBe(`${SNIPPET_DELTA_HEADER}\nquests: left the log — 214 Red Silk Bandanas`);
  });

  test("a drain before our own self block seeds nothing, so the log that then arrives is not all new", () => {
    // Before login (or right after a sandbox restart) the SDK reads an empty
    // quest log and no level.
    const t = seededParty();
    const fresh = new SnippetDeltaRecorder({
      selfGuid: () => ME,
      level: () => t.w.level,
      group: () => undefined,
      memberUnit: () => undefined,
      questLog: () => t.w.quests,
      nameOf: () => undefined,
    });
    t.w.level = undefined;
    t.w.quests = [];
    expect(renderSnippetDelta(fresh.drain())).toBeUndefined();
    t.w.level = 19;
    t.w.quests = [
      { questId: 214, complete: false, title: "Red Silk Bandanas" },
      { questId: 155, complete: false, title: "The Defias Brotherhood" },
    ];
    expect(renderSnippetDelta(fresh.drain())).toBeUndefined();
    t.w.quests[0] = { ...t.w.quests[0]!, complete: true };
    expect(renderSnippetDelta(fresh.drain())).toBe(`${SNIPPET_DELTA_HEADER}\nquests: complete — 214 Red Silk Bandanas`);
  });

  test(`the block never passes ${SNIPPET_DELTA.MAX_CHARS} characters: old chat goes first, then lines from the foot`, () => {
    const t = seededParty();
    const many: GroupMemberLike[] = [];
    for (let i = 0; i < 8; i++) many.push({ guid: `${40 + i}`, name: `Raidmember${i}longname`, online: true });
    t.w.members.push(...many);
    for (const m of many) t.w.units.set(String(m.guid), unit(1000));
    t.feed();
    t.rec.drain();
    for (const m of many) {
      t.w.units.set(String(m.guid), unit(400));
      t.feed();
      t.w.units.set(String(m.guid), unit(0));
      t.feed();
      t.w.units.set(String(m.guid), unit(1, 1000, true));
      t.feed();
    }
    for (let i = 0; i < 6; i++) t.feed("SMSG_MESSAGECHAT", chat(0x02, TANK, `${"x".repeat(150)} ${i}`));
    t.feed("SMSG_SPELLNONMELEEDAMAGELOG", spell("99", "Fireball", 112));
    const block = renderSnippetDelta(t.rec.drain())!;
    expect(block.length).toBeLessThanOrEqual(SNIPPET_DELTA.MAX_CHARS);
    expect(block.startsWith(SNIPPET_DELTA_HEADER)).toBe(true);
    expect(block).toMatch(/\(\+\d+ lines cut\)$/);
    // Party first: the first member's line survives the cut.
    expect(block).toContain("Raidmember0longname: below 50%, died, released");
  });

  test("deterministic: one drain renders the same bytes every time", () => {
    const d: SnippetDelta = {
      members: [{ name: "Tankpartyb", words: ["below 50%", "died"], truncated: false }],
      chat: ["  [party] <Tankpartyb> pull back"],
      chatDropped: 0,
      damage: [
        { name: "Defias Miner", total: 36, hits: [{ what: "melee", count: 2, total: 36 }] },
        { name: "Defias Evoker", total: 376, hits: [{ what: "Fireball", count: 3, total: 315 }, { what: "Frostbolt", count: 1, total: 61 }] },
      ],
      damageOther: { sources: 0, total: 0 },
      quests: { complete: [], added: [], gone: [] },
    };
    expect(renderSnippetDelta(d)).toBe(renderSnippetDelta(structuredClone(d)));
  });
});

// ------------------------------------------------------------ the child

const hosts: SandboxHost[] = [];
afterEach(async () => {
  await Promise.all(hosts.splice(0, hosts.length).map((h) => h.stop()));
});

describe("the child latches it and the host drains it", () => {
  test("a member's death and a party line reach the drain once, through the real child", async () => {
    const dir = tempDir("wrathbench-delta-child-");
    const host = new SandboxHost({
      moduleUrl: "http://worldserver:8086",
      token: "test-token",
      scratchpad: new Scratchpad(join(dir, "scratchpad.md")),
      snippetTimeoutMs: 5_000,
      pingGraceMs: 1_000,
    });
    hosts.push(host);
    // Hand-written frames from module/PROTOCOL.md's tables, as in sleep.test.ts.
    const res = await host.evalSnippet(`
      state.seedSelf({ guid: "7", name: "Magepartyd" });
      globalThis.seq = 1;
      globalThis.feed = (opcode, opcodeId, data) =>
        events.ingest(JSON.stringify({ seq: seq++, opcode, opcodeId, ts: Date.now(), data }));
      feed("SMSG_GROUP_LIST", 0x7d, { groupType: 0, left: false, raid: false, subGroup: 0, memberFlags: 0, roles: 0,
        groupGuid: "500", counter: 1, leaderGuid: "21", lootMethod: 0,
        members: [{ name: "Tankpartyb", guid: "21", online: true, subGroup: 0, flags: 0, roles: 0 }] });
      feed("SMSG_UPDATE_OBJECT", 0xa9, { blocks: 1, objects: [{ update: "create", guid: "21", objectType: "player",
        pos: { x: 6, y: 8, z: 0, o: 0 }, fields: { health: 1000, maxHealth: 1000, level: 20 } }] });
      "fed"
    `);
    expect(res.ok).toBe(true);
    expect(await host.snippetDelta()).toMatchObject({ members: [], chat: [] });
    await host.evalSnippet(`
      feed("SMSG_UPDATE_OBJECT", 0xa9, { blocks: 1, objects: [{ update: "values", guid: "21", fields: { health: 0 } }] });
      feed("SMSG_MESSAGECHAT", 0x96, { type: 0x02, language: 0, senderGuid: "21", message: "wipe, run back", chatTag: 0 });
      "died"
    `);
    const d = (await host.snippetDelta())!;
    expect(d.members).toEqual([{ name: "Tankpartyb", words: ["died"], truncated: false }]);
    expect(d.chat).toEqual(["  [party] <Tankpartyb> wipe, run back"]);
    const again = (await host.snippetDelta())!;
    expect(renderSnippetDelta(again)).toBeUndefined();
  });
});

// ------------------------------------------------------- the dispatcher

function fakeSandbox(delta: SnippetDelta | Error) {
  let drains = 0;
  const sandbox = {
    evalSnippet: (): Promise<SnippetResult> =>
      Promise.resolve({ ok: true, value: "42", logs: [], durationMs: 3, actionHints: [{ action: "castSpell", status: "not_ready", count: 2, hint: "its cooldown", ts: 1 }] }),
    snippetDelta: () => {
      drains++;
      return delta instanceof Error ? Promise.reject(delta) : Promise.resolve(delta);
    },
    drainActionHints: () => Promise.resolve([]),
  } as unknown as SandboxHost;
  return { sandbox, drains: () => drains };
}

function makeCtx(sandbox: SandboxHost, snippetDelta?: boolean): ToolContext {
  const dir = tempDir("wrathbench-delta-tools-");
  return {
    sandbox,
    scratchpad: new Scratchpad(join(dir, "scratchpad.md")),
    sessionLive: () => true,
    reflect: new ReflectGate(),
    episodic: new EpisodicLog(join(dir, "episodic.jsonl")),
    turn: () => 1,
    secrets: new SecretRedactor(),
    ...(snippetDelta !== undefined ? { snippetDelta } : {}),
  };
}

const A8_LIKE: SnippetDelta = {
  members: [
    { name: "Tankpartyb", words: ["below 50%", "below 25%", "died"], truncated: false },
    { name: "Healpartyc", words: ["below 50%"], truncated: false, hp: 38 },
  ],
  chat: ["  [party] <Tankpartyb> pull back to the ramp, evokers first", "  [whisper] <Healpartyc> oom, drink after this"],
  chatDropped: 1,
  damage: [
    { name: "Defias Evoker", total: 376, hits: [{ what: "Fireball", count: 3, total: 315 }, { what: "Frostbolt", count: 1, total: 61 }] },
    { name: "Defias Miner", total: 36, hits: [{ what: "melee", count: 2, total: 36 }] },
  ],
  damageOther: { sources: 0, total: 0 },
  level: { from: 19, to: 20 },
  quests: { complete: ["214 Red Silk Bandanas"], added: [], gone: [] },
};

describe("which driver gets it", () => {
  test("with the switch on, the block is the result's last part, after the harness block", async () => {
    const { sandbox } = fakeSandbox(A8_LIKE);
    const res = await callTool(makeCtx(sandbox, true), "run_snippet", { code: "1" });
    const harness = renderActionHints([{ action: "castSpell", status: "not_ready", count: 2, hint: "its cooldown", ts: 1 }])!;
    expect(res.text).toBe(`ok (3ms)\n=> 42\n${harness}\n${renderSnippetDelta(A8_LIKE)}`);
    expect(renderSnippetDelta(A8_LIKE)).toBe(
      [
        "--- since your last snippet ---",
        "Tankpartyb: below 50%, below 25%, died",
        "Healpartyc: below 50% (now 38%)",
        "took 412: Defias Evoker 376 (Fireball ×3, Frostbolt), Defias Miner 36 (melee ×2)",
        "level 19 → 20",
        "quests: complete — 214 Red Silk Bandanas",
        "chat (+1 earlier):",
        "  [party] <Tankpartyb> pull back to the ramp, evokers first",
        "  [whisper] <Healpartyc> oom, drink after this",
      ].join("\n"),
    );
  });

  test("the fixed loop's context has no switch: its result keeps its exact bytes and nothing is drained", async () => {
    const { sandbox, drains } = fakeSandbox(A8_LIKE);
    const res = await callTool(makeCtx(sandbox), "run_snippet", { code: "1" });
    const harness = renderActionHints([{ action: "castSpell", status: "not_ready", count: 2, hint: "its cooldown", ts: 1 }])!;
    expect(res.text).toBe(`ok (3ms)\n=> 42\n${harness}`);
    expect(drains()).toBe(0);
  });

  test("the fixed loop never drains it: a whole runLoop episode's snippet results carry no block", async () => {
    const dir = tempDir("wrathbench-delta-loop-");
    const config = { ...loadRunConfig({ driver: "stub", stepIntervalMs: 0, stateIntervalMs: 1 }), runId: "run-delta", token: "run-delta" };
    const trajectory = new Trajectory(dir);
    trajectory.writeMeta({ runId: "run-delta", harnessVersion: "t", startedAt: 1_000, config });
    let call = 0;
    const adapter: ChatAdapter = {
      label: "stub",
      complete(_req: ChatRequest): Promise<AdapterOutcome> {
        call++;
        if (call > 2) return Promise.resolve({ kind: "stub-complete" });
        return Promise.resolve({
          kind: "ok",
          turn: { content: `turn ${call}`, toolCalls: [{ id: `c${call}`, name: "run_snippet", arguments: JSON.stringify({ code: "1" }) }] },
        });
      },
    };
    const { sandbox: base, drains } = fakeSandbox(A8_LIKE);
    const sandbox = Object.assign(base, {
      recentEvents: () => Promise.resolve([]),
      stateSnapshot: () => Promise.resolve({ self: {}, lastSeq: -1, eventCount: 0 }),
      totalRestarts: 0,
      consecutiveRestarts: 0,
      drainNotices: () => [],
      stop: () => Promise.resolve(),
    }) as unknown as SandboxHost;
    await runLoop({
      config,
      adapter,
      sandbox,
      scratchpad: new Scratchpad(join(dir, "scratchpad.md")),
      episodic: new EpisodicLog(join(dir, "episodic.jsonl")),
      trajectory,
      watchdogs: new Watchdogs(config.watchdogs),
      sleep: () => Promise.resolve(),
    });
    trajectory.close();
    const results = readTrajectory(dir).filter((r) => r.t === "snippet_result");
    expect(results.length).toBe(2);
    for (const r of results) expect(String(r["text"])).not.toContain(SNIPPET_DELTA_HEADER);
    expect(drains()).toBe(0);
  });

  test("a drain that fails costs nothing: the result is as it would have been", async () => {
    const { sandbox } = fakeSandbox(new Error("child not answering"));
    const res = await callTool(makeCtx(sandbox, true), "run_snippet", { code: "1" });
    expect(res.text).not.toContain(SNIPPET_DELTA_HEADER);
    expect(res.text.startsWith("ok (3ms)\n=> 42\n--- harness ---")).toBe(true);
  });

  test("the registry turns it on for claude-code alone, and never for a fixed-loop driver", () => {
    expect(DRIVER_LIST.filter((d) => d.snippetDelta).map((d) => d.id)).toEqual(["claude-code"]);
    for (const d of DRIVER_LIST) if (d.kind === "loop") expect(d.snippetDelta).toBe(false);
    expect(entryOf("codex").snippetDelta).toBe(false);
    expect(entryOf("pi").snippetDelta).toBe(false);
  });

  test("the prompt names it only where the driver renders it", () => {
    expect(buildSystemPrompt(undefined, undefined, "claude-code")).toContain(
      `and your scratchpad. ${SNIPPET_DELTA_SENTENCE} This harness does not trim`,
    );
    for (const h of ["wrathbench", "codex", "pi"] as const) {
      expect(buildSystemPrompt(undefined, undefined, h)).not.toContain(SNIPPET_DELTA_SENTENCE);
    }
  });
});
