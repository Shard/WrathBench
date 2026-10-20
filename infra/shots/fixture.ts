/**
 * Synthetic runs for the dashboard render rig (`infra/dashboard-shots.ts`),
 * written through the runner's own `Trajectory`, so the viewer and the
 * publisher read them exactly as they read a real run. Every name, id and word
 * is invented here; nothing reads `data/`.
 *
 *   fixture-live   unterminated, a fresh heartbeat, a trace to now, walking a
 *                  loop; `tick` keeps it live while the rig runs
 *   fixture-live-2, fixture-live-3, fixture-live-4
 *                  three more live characters for the map's live list, at
 *                  other levels and models: one a few hundred yards off on the
 *                  same continent, one on Kalimdor and one in the Deadmines'
 *                  foundry, so a pick from the list has a camera move to show,
 *                  a continent to cross to and an instance's own tiles
 *   fixture-ended  terminated `episode-limit` half an hour ago, two and a half
 *                  hours of trace to replay
 *   fixture-e90, fixture-e90-closed, fixture-reference
 *                  three finished `e90` runs, two models' rows and the scripted
 *                  reference's line, for the ladder (`writeLadderRun`)
 *
 * Both carry a character sheet on the trace (money, worn and carried items, a
 * quest log with one quest that completes, one in progress and one of four
 * items to collect, two never found, and a turn-in), the 60 s
 * state line, snippets and tool calls with one failure each, a harness notice
 * and a scratchpad, and a chat line every 20 s on the trace (`chatAt`), so the
 * map has bubbles up in every shot. The state line's quest count starts again at zero halfway
 * (`questsAt`), as a resumed process's does, so the map's quest figure shows
 * the run's sum (3) where the newest sample says 1.
 *
 * The live run also has a nearby ring (`nearbyScene`), written by the
 * runner's own `NearbyWriter` and reaching back fourteen minutes so the public
 * map, which plays about nine behind, has units at its playhead: boars that
 * wander, one fighting the character, one dead, a questgiver of each mark,
 * and another player with their pet and a creature chasing them, which only
 * the private map draws.
 */

import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { comparabilityOf } from "../../runner/src/comparability";
import { loadRunConfig, unscoredStamp } from "../../runner/src/config";
import { NearbyWriter } from "../../runner/src/nearby";
import type { NearbyRow, NearbyUnit } from "../../runner/src/nearby-row";
import { Trajectory } from "../../runner/src/trajectory";
import type { TraceChat, TraceDict, TraceKeyData, TraceRow } from "../../runner/src/trace-row";
import { TRACE_WINDOW_MS } from "../../runner/src/trace-row";

export const LIVE_RUN = "fixture-live";
export const ENDED_RUN = "fixture-ended";

/** Where a character walks its loop: a map and the loop's centre. */
interface Ground {
  map: number;
  x: number;
  y: number;
  z: number;
}

/** Map 0, an open field: where the live and the ended characters walk. */
const CENTRE: Ground = { map: 0, x: -9460, y: 60, z: 57 };
const LOOP_MS = 240_000;

const DICT: TraceDict = {
  items: [
    [1001, 1, "Invented Hammer"],
    [1002, 1, "Invented Tunic"],
    [1003, 2, "Invented Boots"],
    [1004, 0, "Invented Pelt"],
    [1005, 1, "Invented Ration"],
    [1006, 1, "Invented Satchel"],
    [1007, 1, "Invented Bolt"],
    [1008, 1, "Invented Cloak"],
  ],
  quests: [
    [9001, [8, 0, 0, 0]],
    [9002, [0, 0, 0, 0, [1004, 5]]],
    // Four items to collect, two of them never found: the shape whose row is too long for one line beside a long title.
    [9004, [0, 0, 0, 0, [1007, 1], [1005, 1], [1008, 1], [1004, 5]]],
  ],
};

const ITEM_NAMES = new Map((DICT.items ?? []).map(([id, quality, name]) => [id, { quality, name }]));

function position(t: number, phase: number, at: Ground = CENTRE): { x: number; y: number; o: number } {
  const a = (2 * Math.PI * ((t + phase) % LOOP_MS)) / LOOP_MS;
  return { x: at.x + 25 * Math.cos(a), y: at.y + 25 * Math.sin(a), o: (a + Math.PI / 2) % (2 * Math.PI) };
}

/** The whole sheet at a moment: pelts collected so far grow with time. */
function keyData(level: number, xp: number, pelts: number, money: number, complete: boolean): TraceKeyData {
  return {
    hp: 180,
    hpMax: 200,
    pw: 40,
    pwMax: 100,
    pwType: 1,
    level,
    xp,
    xpMax: 4400,
    auras: [],
    combat: false,
    mounted: false,
    taxi: false,
    dead: false,
    ghost: false,
    resting: false,
    target: null,
    cast: null,
    money,
    equip: [
      [15, 1001],
      [4, 1002],
      [7, 1003],
    ],
    bags: [[19, 1006, 6]],
    inv: [
      [255, 23, 1004, pelts],
      [255, 24, 1005, 4],
    ],
    dur: [[15, 40, 50]],
    quests: [
      [0, 9001, complete ? 1 : 0, complete ? 8 : 3],
      [1, 9002, 0],
      [2, 9004, 0],
    ],
    rep: [[72, 1200]],
    skills: [[43, 30, 40]],
  };
}

function itemsOf(pelts: number): { name: string; count: number; equipped: boolean; itemId: number; quality?: number; slot: number; bag?: number }[] {
  const named = (id: number) => ITEM_NAMES.get(id)!;
  return [
    { name: named(1001).name, count: 1, equipped: true, itemId: 1001, quality: 1, slot: 15 },
    { name: named(1002).name, count: 1, equipped: true, itemId: 1002, quality: 1, slot: 4 },
    { name: named(1003).name, count: 1, equipped: true, itemId: 1003, quality: 2, slot: 7 },
    { name: named(1004).name, count: pelts, equipped: false, itemId: 1004, quality: 0, slot: 23, bag: 255 },
    { name: named(1005).name, count: 4, equipped: false, itemId: 1005, quality: 1, slot: 24, bag: 255 },
  ];
}

interface Spec {
  runId: string;
  character: string;
  model: string;
  startedAt: number;
  traceFrom: number;
  traceTo: number;
  phase: number;
  scratchpad: string;
  /** Where it walks, and its level; the open field and 7 when left out. */
  ground?: Ground;
  level?: number;
}

/** How often a character says something: often enough that every shot has a bubble up, and now and then two. */
const CHAT_EVERY_MS = 20_000;
/** What the characters say: invented, and one too long for a bubble. */
const CHAT_LINES = [
  "Pulling the next boar, hold here.",
  "Five pelts to go. The north side is clear.",
  "Resting to 60% before the next pull; the quartermaster wants the pelts first and then the scout's errand by the old mill.",
  "On my way.",
  "Need a hand by the fence?",
] as const;
const CHAT_KINDS: readonly TraceChat[0][] = ["party", "say", "party", "yell", "whisper"];

/** The line a character says at `t`, if one is due: a kind from the rotation and an invented text. */
function chatAt(spec: Spec, t: number): TraceChat | null {
  if ((t + spec.phase) % CHAT_EVERY_MS >= 2_000) return null;
  const n = Math.floor((t + spec.phase) / CHAT_EVERY_MS) + spec.runId.length;
  return [CHAT_KINDS[n % CHAT_KINDS.length]!, CHAT_LINES[n % CHAT_LINES.length]!];
}

/** The trace of one span: a key row at each window's start, a position every 2 s, a state delta as the counters move, and a chat line now and then. */
function traceRows(spec: Spec, from: number, to: number, keyAtFrom = true): TraceRow[] {
  const rows: TraceRow[] = [];
  const span = spec.traceTo - spec.traceFrom;
  const pelts = (t: number): number => 1 + Math.min(4, Math.floor(((t - spec.traceFrom) / Math.max(1, span)) * 5));
  const complete = (t: number): boolean => t - spec.traceFrom > span * 0.6;
  const xp = (t: number): number => 1000 + Math.floor(((t - spec.traceFrom) / Math.max(1, span)) * 3000);
  const money = (t: number): number => 2500 + Math.floor((t - spec.traceFrom) / 60_000) * 7;
  let lastPelts = -1;
  let lastComplete: boolean | null = null;
  const at = spec.ground ?? CENTRE;
  for (let t = from; t <= to; t += 2_000) {
    const p = position(t, spec.phase, at);
    const windowStart = t - (t % TRACE_WINDOW_MS);
    if ((t === from && keyAtFrom) || t - windowStart < 2_000) {
      rows.push({ ts: t, kind: "key", map: at.map, x: p.x, y: p.y, z: at.z, o: p.o, data: keyData(spec.level ?? 7, xp(t), pelts(t), money(t), complete(t)) });
      lastPelts = pelts(t);
      lastComplete = complete(t);
      continue;
    }
    rows.push({ ts: t, kind: "pos", map: at.map, x: p.x, y: p.y, z: at.z, o: p.o });
    const said = chatAt(spec, t);
    if (said !== null) rows.push({ ts: t, kind: "state", data: { chat: [said] } });
    if (pelts(t) !== lastPelts || complete(t) !== lastComplete) {
      const done = complete(t) && lastComplete === false;
      rows.push({
        ts: t,
        kind: "state",
        data: {
          xp: xp(t),
          money: money(t),
          inv: [[255, 23, 1004, pelts(t)]],
          quests: [[0, 9001, complete(t) ? 1 : 0, complete(t) ? 8 : 3]],
          ...(done ? { qdone: [9003] } : {}),
        },
      });
      lastPelts = pelts(t);
      lastComplete = complete(t);
    }
  }
  return rows;
}

/**
 * The recorded quest count at fraction `f` of a run: its first process turns
 * in two, a restart halfway starts the count again, and the second turns in
 * one. The run's count is 3 by the end; the newest sample's is 1.
 */
function questsAt(f: number): number {
  if (f < 0.5) return f > 0.35 ? 2 : f > 0.2 ? 1 : 0;
  return f > 0.7 ? 1 : 0;
}

function writeRun(runsDir: string, spec: Spec, ended: number | null): Trajectory {
  const dir = join(runsDir, spec.runId);
  mkdirSync(dir, { recursive: true });
  // The run's own clock while it is written; the wall clock after, for the live run's ticker.
  let clock: number | null = spec.startedAt;
  const traj = new Trajectory(dir, { now: () => clock ?? Date.now() });
  // A model's driver, as every run the public site shows is: a stub-driven
  // run is never published (`isNotAModelRun`), and the public half of the rig
  // would have nothing to draw.
  const config = {
    ...loadRunConfig({ driver: "openai" }),
    runId: spec.runId,
    token: `${spec.runId}-fixture-token-0000000000000000`,
    runsDir,
    character: spec.character,
    model: spec.model,
    account: "FIXTURE",
  };
  traj.writeMeta({ runId: spec.runId, harnessVersion: "harness-fixture", startedAt: spec.startedAt, config });
  traj.setCharacter(spec.runId, spec.character);
  writeFileSync(join(dir, "scratchpad.md"), spec.scratchpad);

  // The 60 s state line, from the start.
  const until = ended ?? spec.traceTo;
  let turn = 0;
  const at = spec.ground ?? CENTRE;
  for (let t = spec.startedAt + 30_000; t <= until; t += 60_000) {
    clock = t;
    const p = position(t, spec.phase, at);
    const pelts = 1 + Math.min(4, Math.floor(((t - spec.startedAt) / Math.max(1, until - spec.startedAt)) * 5));
    traj.recordState(spec.runId, {
      level: spec.level ?? 7,
      xp: 1000 + Math.floor(((t - spec.startedAt) / (until - spec.startedAt)) * 3000),
      map: at.map,
      ...p,
      z: at.z,
      money: 2500 + Math.floor((t - spec.startedAt) / 60_000) * 7,
      questsCompleted: questsAt((t - spec.startedAt) / Math.max(1, until - spec.startedAt)),
      turn: ++turn,
      health: 180,
      maxHealth: 200,
      nextLevelXp: 4400,
      items: itemsOf(pelts),
    });
    // A turn of play beside each sample: a snippet, its result, a reply.
    traj.append({ t: "request", turn, adapter: "stub", promptChars: 9000 + turn * 50 });
    traj.append({ t: "response", turn, message: { role: "assistant", content: `Turn ${turn}: checking the field for invented boars.` } });
    const failed = turn === 3;
    traj.append({ t: "snippet", turn, call: turn * 10, code: `const prey = state.units({ name: "Invented Boar", alive: true });\nreturn prey.length;` });
    traj.append({
      t: "snippet_result",
      turn,
      call: turn * 10,
      name: "run_snippet",
      isError: failed,
      text: failed ? "error (4ms)\nTypeError: state.units() filter: unknown key \"guid\"" : `ok (12ms)\n=> ${turn % 4}`,
    });
    if (turn === 5) {
      traj.append({ t: "tool_call", turn, call: 51, name: "edit_scratchpad", args: { old: "- [ ] pelts", new: "- [x] pelts" } });
      traj.append({ t: "tool_result", turn, call: 51, name: "edit_scratchpad", isError: false, text: "ok" });
    }
    if (turn === 6) traj.append({ t: "harness", kind: "session_note", text: "an invented notice" });
  }

  traj.recordTrace(spec.runId, traceRows(spec, spec.traceFrom, spec.traceTo), DICT);
  if (ended !== null) {
    clock = ended;
    traj.setTermination(spec.runId, "episode-limit", "episode limit reached");
  }
  clock = null;
  return traj;
}

/**
 * Two finished `e90` runs for the ladder: a model's, which is a row, and the
 * scripted reference's, which is only the labelled line under the table. Both
 * are stamped like a launch stamps them, so the ladder reads them as members
 * and non-members of the tier for the same reasons a real run's are.
 */
export const E90_RUN = "fixture-e90";
export const E90_CLOSED_RUN = "fixture-e90-closed";
export const REFERENCE_RUN = "fixture-reference";

function writeLadderRun(runsDir: string, runId: string, raw: Record<string, unknown>, level: number, startedAt: number): void {
  const dir = join(runsDir, runId);
  mkdirSync(dir, { recursive: true });
  let clock = startedAt;
  const traj = new Trajectory(dir, { now: () => clock });
  const config = { ...loadRunConfig({ episode: "e90", account: "FIXTURE", ...raw }), runId, token: `${runId}-fixture-token-000000000000`, runsDir };
  const shakeout = unscoredStamp(config.driver);
  traj.writeMeta({
    runId,
    harnessVersion: "harness-fixture",
    startedAt,
    config,
    comparability: comparabilityOf(config, "harness-fixture"),
    ...(shakeout !== undefined ? { shakeout } : {}),
  });
  for (let l = 1, t = startedAt + 60_000; l <= level; l++, t += 9 * 60_000) {
    clock = t;
    traj.append({ t: "response", turn: l, message: { role: "assistant", content: `Turn ${l}.` } });
    traj.recordState(runId, { level: l, xp: 100 * l, map: 0, x: CENTRE.x, y: CENTRE.y, z: CENTRE.z, money: 50 * l, turn: l });
  }
  clock = startedAt + 90 * 60_000;
  traj.setTermination(runId, "episode-limit", "episode limit reached");
  traj.close();
}

const PAD = (character: string): string => `# ${character}: an invented plan

## Goal
- [x] reach the field
- [ ] pelts: 5 Invented Pelts for quest 9002
- [ ] finish quest 9001, then turn it in

## Rules
1. One boar at a time.
2. Rest above 60% health.
`;

/* ------------------------------------------------------------ the ring --- */

/** A unit guid: high type (0xF130 creature, 0xF140 pet), entry in bits 24..47, a low counter. */
const unitGuid = (entry: number, low: number, high = 0xf130): string => ((BigInt(high) << 48n) | (BigInt(entry) << 24n) | BigInt(low)).toString(10);
/** The live character's own guid, as its ring's self names it. */
const SELF_GUID = "7";
const OTHER_PLAYER = "4242";
/** One step of every moving unit: a spline from where it is to where it will be. */
const STEP_MS = 5_000;

interface SceneUnit {
  id: string;
  ty: NearbyUnit["ty"];
  s: NearbyUnit["s"];
  /** Where it is at `t`; constant for a unit that stands. */
  at: (t: number) => { x: number; y: number };
  moves: boolean;
}

/** The units around the live character: invented names and entries, all within a few dozen yards of its loop. */
function nearbyScene(): SceneUnit[] {
  const still = (dx: number, dy: number) => () => ({ x: CENTRE.x + dx, y: CENTRE.y + dy });
  const wander = (cx: number, cy: number, r: number, periodMs: number, phase: number) => (t: number) => {
    const a = (2 * Math.PI * ((t + phase) % periodMs)) / periodMs;
    return { x: CENTRE.x + cx + r * Math.cos(a), y: CENTRE.y + cy + r * Math.sin(a) };
  };
  /** A step behind the character on its loop: the boar it is fighting. */
  const follow = (t: number) => {
    const p = position(t - 1_500, 0);
    return { x: p.x + 2, y: p.y + 2 };
  };
  const boar = (low: number) => ({ entry: 90001, name: "Invented Boar", level: 6 + (low % 2), hp: 100 });
  return [
    { id: unitGuid(90001, 1), ty: "creature", s: boar(1), at: wander(-40, 12, 6, 70_000, 0), moves: true },
    { id: unitGuid(90001, 2), ty: "creature", s: boar(2), at: wander(38, -18, 5, 55_000, 20_000), moves: true },
    { id: unitGuid(90001, 3), ty: "creature", s: boar(3), at: wander(12, 42, 7, 90_000, 40_000), moves: true },
    { id: unitGuid(90001, 4), ty: "creature", s: boar(4), at: wander(-18, -44, 4, 60_000, 10_000), moves: true },
    { id: unitGuid(90001, 5), ty: "creature", s: { ...boar(5), tg: SELF_GUID, tgs: true }, at: follow, moves: true },
    { id: unitGuid(90001, 6), ty: "creature", s: { ...boar(6), hp: 0, df: 0x20 }, at: still(30, 20), moves: false },
    { id: unitGuid(90002, 7), ty: "creature", s: { entry: 90002, name: "Invented Quartermaster", sub: "Supplies", level: 30, hp: 100, nf: 0x3, qg: 8 }, at: still(-6, 8), moves: false },
    { id: unitGuid(90003, 8), ty: "creature", s: { entry: 90003, name: "Invented Scout", level: 12, hp: 100, nf: 0x2, qg: 10 }, at: still(6, -8), moves: false },
    { id: unitGuid(90004, 9), ty: "creature", s: { entry: 90004, name: "Invented Hare", ctype: 8, level: 1, hp: 100 }, at: wander(-30, 34, 3, 40_000, 0), moves: true },
    // Private only: another player, their pet, and a creature chasing them.
    { id: OTHER_PLAYER, ty: "player", s: { name: "Otherwick", level: 9 }, at: wander(48, 30, 9, 120_000, 0), moves: true },
    { id: unitGuid(90005, 10, 0xf140), ty: "pet", s: { entry: 90005, name: "Otherwick's Hound", ow: OTHER_PLAYER }, at: wander(48, 30, 9, 120_000, -2_000), moves: true },
    { id: unitGuid(90006, 11), ty: "creature", s: { entry: 90006, name: "Invented Prowler", level: 8, hp: 100, tg: OTHER_PLAYER, tgs: false }, at: wander(48, 30, 9, 120_000, -4_000), moves: true },
  ];
}

/** The ring's rows from `from` (exclusive) to `to`: each moving unit's spline per step. */
function sceneRows(scene: readonly SceneUnit[], from: number, to: number): NearbyRow[] {
  const rows: NearbyRow[] = [];
  for (let t = from - (from % STEP_MS) + STEP_MS; t <= to; t += STEP_MS) {
    for (const u of scene) {
      if (!u.moves) continue;
      const a = u.at(t);
      const b = u.at(t + STEP_MS);
      rows.push({ ts: t, kind: "mv", id: u.id, m: { k: "mv", t, p: [a.x, a.y, CENTRE.z], to: [b.x, b.y, CENTRE.z], ms: STEP_MS } });
    }
  }
  return rows;
}

/** The live run's ring, written by the runner's own writer: a key `backMs` ago, the scene since, and a ticker to keep it going. */
function writeRing(runDir: string, now: number, backMs: number): { ready: Promise<void>; tick: (t: number) => void; close: () => void } {
  const scene = nearbyScene();
  const from = now - backMs;
  let pending: NearbyRow[] = [
    {
      ts: from,
      kind: "key",
      self: { guid: SELF_GUID, map: 0, target: null, down: false },
      units: scene.map((u) => {
        const p = u.at(from);
        return { id: u.id, ty: u.ty, s: u.s, m: { k: "pos", t: from, p: [p.x, p.y, CENTRE.z, 0] } };
      }),
    },
    ...sceneRows(scene, from, now),
  ];
  let through = now;
  const writer = new NearbyWriter({
    runDir,
    sandbox: {
      nearbyDrain: async () => {
        const rows = pending;
        pending = [];
        return { rows, dropped: 0, through };
      },
    },
    log: () => {},
  });
  let last = now;
  return {
    ready: writer.drain(),
    tick(t) {
      pending.push(...sceneRows(scene, last, t));
      last = t;
      through = t;
      void writer.drain();
    },
    close: () => writer.close(),
  };
}

export interface Fixture {
  runsDir: string;
  /** The live run the rig's states are about: the one with a nearby ring. */
  live: string;
  /** Every live run, `live` first. */
  lives: string[];
  ended: string;
  /** Resolves once the live run's nearby ring is on disk. */
  ready: Promise<void>;
  /** Keep the live run live: a position, a heartbeat and now and then a state sample. */
  tick(now?: number): void;
  close(): void;
}

export const LIVE_RUN_2 = "fixture-live-2";
export const LIVE_RUN_3 = "fixture-live-3";
export const LIVE_RUN_4 = "fixture-live-4";

/** Write the runs into `runsDir` relative to `now`, and hand back the live runs' ticker. */
export function writeFixture(runsDir: string, now = Date.now()): Fixture {
  mkdirSync(runsDir, { recursive: true });
  const at = (t: number): number => t - (t % 2_000);
  const liveSpec: Spec = {
    runId: LIVE_RUN,
    character: "Fixturewick",
    model: "fixture/live-model",
    startedAt: at(now - 50 * 60_000),
    traceFrom: at(now - 20 * 60_000),
    traceTo: at(now),
    phase: 0,
    scratchpad: PAD("Fixturewick"),
  };
  const endedAt = at(now - 30 * 60_000);
  const endedSpec: Spec = {
    runId: ENDED_RUN,
    character: "Replayna",
    model: "fixture/ended-model",
    startedAt: at(now - 3 * 3_600_000),
    traceFrom: at(now - 3 * 3_600_000 + 60_000),
    traceTo: endedAt,
    phase: LOOP_MS / 3,
    scratchpad: PAD("Replayna"),
  };
  writeRun(runsDir, endedSpec, endedAt).close();
  writeLadderRun(runsDir, E90_RUN, { driver: "openai", model: "fixture/e90-model", character: "Laddera" }, 6, at(now - 5 * 3_600_000));
  // A second row, under an invented id a family's weights rules still answer
  // for (Anthropic's catch-all reads `closed`), so the ladder's weights filter
  // has two buckets to offer; `fixture/e90-model` reads `unknown`.
  writeLadderRun(runsDir, E90_CLOSED_RUN, { driver: "openai", model: "anthropic/fixture-model", character: "Closewyn" }, 4, at(now - 6 * 3_600_000));
  writeLadderRun(runsDir, REFERENCE_RUN, { driver: "reference", character: "Routeric" }, 9, at(now - 4 * 3_600_000));
  const liveSpecs: Spec[] = [
    liveSpec,
    {
      ...liveSpec,
      runId: LIVE_RUN_2,
      character: "Quillara",
      model: "fixture/second-model",
      startedAt: at(now - 80 * 60_000),
      phase: LOOP_MS / 2,
      scratchpad: PAD("Quillara"),
      ground: { map: 0, x: -9180, y: 420, z: 57 },
      level: 12,
    },
    {
      ...liveSpec,
      runId: LIVE_RUN_3,
      character: "Thornelle",
      model: "fixture/third-model",
      startedAt: at(now - 30 * 60_000),
      phase: LOOP_MS / 4,
      scratchpad: PAD("Thornelle"),
      ground: { map: 1, x: -600, y: -4250, z: 38 },
      level: 3,
    },
    {
      ...liveSpec,
      runId: LIVE_RUN_4,
      character: "Delvara",
      model: "fixture/fourth-model",
      startedAt: at(now - 40 * 60_000),
      phase: (LOOP_MS * 3) / 4,
      scratchpad: PAD("Delvara"),
      // The round foundry room in the Deadmines (map 36), which a 25-yard loop stays inside.
      ground: { map: 36, x: -203, y: -579, z: 19 },
      level: 18,
    },
  ];
  const lives = liveSpecs.map((spec) => {
    const traj = writeRun(runsDir, spec, null);
    const heartbeat = join(runsDir, spec.runId, "heartbeat");
    return { spec, traj, heartbeat, last: spec.traceTo, lastState: spec.traceTo };
  });
  const beat = (t: number): void => {
    for (const l of lives) {
      writeFileSync(l.heartbeat, "fixture 0\n");
      utimesSync(l.heartbeat, t / 1000, t / 1000);
    }
  };
  beat(now);
  const ring = writeRing(join(runsDir, LIVE_RUN), now, 14 * 60_000);
  return {
    runsDir,
    live: LIVE_RUN,
    lives: liveSpecs.map((s) => s.runId),
    ended: ENDED_RUN,
    ready: ring.ready,
    tick(t = Date.now()) {
      ring.tick(t);
      const to = at(t);
      for (const l of lives) {
        if (to > l.last) {
          l.traj.recordTrace(l.spec.runId, traceRows({ ...l.spec, traceTo: to }, l.last + 2_000, to, false));
          l.last = to;
        }
        if (to - l.lastState >= 60_000) {
          const g = l.spec.ground ?? CENTRE;
          const p = position(to, l.spec.phase, g);
          l.traj.recordState(l.spec.runId, { level: l.spec.level ?? 7, xp: 4000, map: g.map, ...p, z: g.z, money: 2800, questsCompleted: 1, items: itemsOf(5) });
          l.lastState = to;
        }
      }
      beat(t);
    },
    close() {
      ring.close();
      for (const l of lives) l.traj.close();
    },
  };
}
