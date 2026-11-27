/**
 * Synthetic runs for the dashboard render rig (`infra/dashboard-shots.ts`),
 * written through the runner's own `Trajectory` and the stack's own
 * `SessionWriter`, so the viewer and the publisher read them exactly as they
 * read a real v1 run. Every name, id and word is invented here; nothing reads
 * `data/`.
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
 *   fixture-e90, fixture-e90-go, fixture-e90-closed, fixture-reference
 *                  four finished `e90` runs, two models' rows (the first
 *                  model's on two providers, recorded under OpenRouter's
 *                  vendor-prefixed id and OpenCode Go's bare one, one row) and the scripted
 *                  reference's line, for the ladder (`writeLadderRun`)
 *   fixture-fanout terminated a quarter of an hour ago: one agent driving two
 *                  characters, Oakhart and Pellira, a session record each in
 *                  `sessions/<Character>/` and a `roster.json` no reader may
 *                  serve; on the private site only, since a fan-out run is
 *                  never published
 *   fixture-fanout-live
 *                  the same, unterminated and kept live by `tick`: three
 *                  characters, Bramblewick, Corriva and Duskel, walking loops
 *                  between the live runs on the open field, a pip each on the
 *                  private map
 *
 * Both carry a character sheet on the trace (money, worn and carried items, a
 * quest log with one quest that completes, one in progress and one of four
 * items to collect, two never found, and a turn-in), which is where the run's
 * level, XP, money and bags are read from, a turn a minute with snippets and
 * tool calls with one failure each, a harness notice and a scratchpad, and a
 * chat line every 20 s on the trace (`chatAt`), so the map has bubbles up in
 * every shot.
 *
 * The live run also has a nearby ring (`nearbyScene`), written through the
 * session writer and reaching back fourteen minutes so the public map, which
 * plays about nine behind, has units at its playhead: boars that wander, one
 * fighting the character, one dead, a questgiver of each mark, and a creature
 * chasing another player. That player is not in the ring: the record never
 * holds one, and the creature's target is written as its kind.
 */

import { createHash } from "node:crypto";
import { appendFileSync, copyFileSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  SEGMENT_MS as TRACE_WINDOW_MS,
  SessionWriter,
  type NearbyRow,
  type NearbyUnit,
  type RecordDrain,
  type TraceChat,
  type TraceDict,
  type TraceKeyData,
  type TraceRow,
  type EventRow,
  type RecordedMove,
} from "@wrathbench/mcp/record";
import { comparabilityOf } from "../../runner/src/comparability";
import { loadRunConfig, unscoredStamp } from "../../runner/src/config";
import { SESSIONS_DIR } from "../../runner/src/run-reader";
import { sessionDirOf } from "../../runner/src/session-record";
import { Trajectory } from "../../runner/src/trajectory";
import { frameFile } from "../camera/layout";
import { taskDefinition, taskHash } from "../../runner/src/task-episodes";

export const LIVE_RUN = "fixture-live";
export const ENDED_RUN = "fixture-ended";
export const FANOUT_RUN = "fixture-fanout";
export const FANOUT_LIVE_RUN = "fixture-fanout-live";
/** In the fan-out run's `roster.json` only. */
export const FANOUT_ROSTER_TOKEN = "fixture-roster-token-0000000000000000";

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
    zone: null,
    area: null,
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
  /** Its samples read the levels its turns gain (`levelAt`), so its track and its chart climb with its marks. */
  climbs?: true;
}

/** A level every twelfth turn, at the turn-in's moment: the `level` event's time, and the level a sample reads after it. */
const LEVEL_EVERY_TURNS = 12;
const levelEventAt = (spec: Spec, turn: number): number => spec.startedAt + 30_000 + (turn - 1) * 60_000 + 12_900;
function levelAt(spec: Spec, t: number): number {
  if (spec.climbs !== true) return spec.level ?? 7;
  let level = 6;
  for (let turn = 2; levelEventAt(spec, turn) <= t; turn += LEVEL_EVERY_TURNS) level++;
  return level;
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
      rows.push({ ts: t, kind: "key", map: at.map, x: p.x, y: p.y, z: at.z, o: p.o, data: keyData(levelAt(spec, t), xp(t), pelts(t), money(t), complete(t)) });
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


/** A run's session record and the clock it is written on: the fixture's own while it lays the past down, the wall clock after. */
interface FixtureSession {
  writer: SessionWriter;
  clock: { now: number | null };
}

/** One drain as the stack's host would hand its writer: the fixture's rows, and a character in the world. */
function drainOf(spec: Spec, o: { trace?: TraceRow[]; dict?: TraceDict; nearby?: NearbyRow[]; through?: number; events?: EventRow[]; moves?: RecordedMove[] }): RecordDrain {
  return {
    trace: { rows: o.trace ?? [], dropped: 0, ...(o.dict !== undefined ? { dict: o.dict } : {}) },
    events: { rows: o.events ?? [], dropped: 0 },
    nearby: { rows: o.nearby ?? [], dropped: 0, through: o.through ?? 0 },
    moves: o.moves ?? [],
    character: { guid: SELF_GUID, name: spec.character, race: 1, class: 1 },
    stream: { connected: true, events: 0, seq: 0 },
  };
}

/**
 * The run's session record, opened in `<run>/session/` as a run opens it, or
 * a fan-out character's in `<run>/sessions/<Character>/`. The id is a
 * fingerprint of the fixture's token (a fan-out character's, of its own).
 */
function openSession(runsDir: string, spec: Spec, fanout = false): FixtureSession {
  const clock: FixtureSession["clock"] = { now: spec.traceFrom };
  const token = `${spec.runId}${fanout ? `-${spec.character}` : ""}-fixture-token-0000000000000000`;
  const id = createHash("sha256").update(token).digest("hex").slice(0, 16);
  const dir = fanout ? join(runsDir, spec.runId, SESSIONS_DIR, spec.character) : sessionDirOf(join(runsDir, spec.runId));
  const writer = new SessionWriter({ dir, id, stack: { version: "fixture" }, now: () => clock.now ?? Date.now(), log: () => {} });
  writer.open();
  return { writer, clock };
}

const SCOUT_CODE = `const prey = state.units({ name: "Invented Boar", alive: true });\nreturn prey.length;`;

const GRIND_CODE = `const boars = state.units({ name: "Invented Boar", alive: true }).slice(0, 3);
for (const boar of boars) {
  await sdk.moveTo(boar);
  const fight = await sdk.killTarget(boar);
  if (fight.status === "killed") await sdk.lootCorpse(boar);
}
return state.bag().filter((i) => i.name === "Invented Pelt").length;`;

const ERRAND_CODE = `await sdk.moveTo({ x: -9412, y: 96 });
const keeper = state.units({ name: "Invented Quartermaster" })[0];
await sdk.gossipHello(keeper);
return sdk.turnInQuest(keeper, 9001);`;

/** What the fixture's model says, a turn each; invented, and long enough to fold. */
const REPLIES = [
  "The north field still has boars up. Three more pelts finish the quartermaster's order, so I pull the nearest three, loot each, and count what the bag holds before deciding whether to walk back.",
  "Checking where things stand before the next pull: health, the bag, and whatever the last minute's events say about the wolves by the fence.",
  "Pelts are done. The plan:\n1. Walk to the quartermaster and turn the order in.\n2. Take the scout's errand by the old mill.\n3. Leave the patrol routine running on the way so nothing chews on me from behind.",
  "That last pull went badly: two wolves joined and the routine kept walking into them. I am noting it down and changing the route to hug the fence line instead.",
  "The fence route is quiet. Keeping the patrol routine on it and waiting for the next wake.",
  "Stepping back for a moment to think about the last half hour before committing to the mill.",
] as const;

type ActionNote = Parameters<SessionWriter["actions"]>[1][number];

/** One dispatched action of the fixture's, as the sandbox notes it. */
function note(ts: number, action: string, extra: Partial<ActionNote> = {}): ActionNote {
  return { ts, action, status: 200, ms: 4, ...extra };
}

/** A walk of the patrol routine's: `n` moves from `t0`, each a dispatch row and its verdict, the last one's verdict `status`. */
function patrolMoves(t0: number, n: number, firstId: number, call: number, last = "arrived", name?: string): RecordedMove[] {
  const rows: RecordedMove[] = [];
  for (let k = 0; k < n; k++) {
    const at = t0 + k * 1_500;
    const base = { at, evalId: call, ...(name === undefined ? { routine: true as const } : { name }), moveId: firstId + k, map: 0, x: -9460 + k * 9, y: 60 + ((k * 37) % 50), z: 57, target: null };
    rows.push({ ...base, ts: at, status: null });
    rows.push({ ...base, ts: at + 1_200, status: k === n - 1 ? last : "arrived" });
  }
  return rows;
}

/**
 * One turn of play, a real run's shape: the model's reply, then what it did.
 * Most turns are a snippet with its action log; between them the patrol
 * routine walks (a move record a step, its own action log, the subzones it
 * crosses), and on its turn of six the model reads state, turns a quest in,
 * writes its log, or reflects. One snippet in six fails, one walk in six ends
 * `too_far` with the harness's hint, and the character dies and levels once
 * each, so a window has every kind of row the feed draws. Returns the call
 * the patrol routine belongs to, for the next turn.
 */
function writeTurn(traj: Trajectory, session: FixtureSession, spec: Spec, turn: number, t: number, at: (ms: number) => void, routineOwner: number): number {
  const w = session.writer;
  const phase = turn % 6;
  let moveId = turn * 100;
  /** A tool call on both sides: the trajectory's records and the session's `calls` rows. */
  const call = (ms: number, name: string, args: Record<string, unknown>, result: { text: string; isError?: boolean; durMs?: number; code?: string; actions?: ActionNote[]; moves?: RecordedMove[] }): number => {
    at(ms);
    const dispatchTs = t + ms;
    const id = w.call(name, args, dispatchTs);
    traj.append({ t: "tool_call", turn, name, args, dispatchTs });
    if (result.code !== undefined) traj.append({ t: "snippet", turn, code: result.code });
    at(ms + (result.durMs ?? 40));
    if (result.moves !== undefined) w.ingest(drainOf(spec, { moves: result.moves }), () => ({ call: id, inCall: true }));
    if (result.actions !== undefined) w.actions({ call: id, inCall: true }, result.actions);
    w.result(id, { text: result.text, isError: result.isError });
    traj.append({ t: result.code !== undefined ? "snippet_result" : "tool_result", turn, name, isError: result.isError === true, text: result.text });
    return id;
  };
  const snippet = (ms: number, code: string, result: { text: string; isError?: boolean; durMs?: number; actions?: ActionNote[]; moves?: RecordedMove[] }): number =>
    call(ms, "run_snippet", { code }, { ...result, code });
  /** The patrol routine between two turns: its moves, the subzones crossed, and its own action log. */
  const patrol = (ms: number, owner: number, steps: number, last = "arrived"): void => {
    const t0 = t + ms;
    at(ms + steps * 1_500 + 1_300);
    const refused = last !== "arrived";
    w.ingest(
      drainOf(spec, {
        moves: patrolMoves(t0, steps, (moveId += 20), owner, last),
        events: [
          { kind: "area", ts: t0 + 2_000, from: 9 + (turn % 3), to: 10 + (turn % 3) },
          { kind: "area", ts: t0 + steps * 1_000, from: 10 + (turn % 3), to: 9 + (turn % 3) },
        ],
      }),
      () => ({ call: owner, routine: true, inCall: true }),
    );
    w.actions({ call: owner, routine: true, inCall: true }, [
      note(t0, "move_to", { args: { x: -9460, y: 60, z: 57 }, moveId, count: steps - (refused ? 1 : 0) }),
      ...(refused ? [note(t0 + steps * 1_400, "move_to", { args: { x: -9100, y: 410, z: 57 }, status: 400, error: "too_far", hint: "a single moveTo covers about 250 yards; walk it in legs" })] : []),
      note(t0 + 900, "set_target", { args: { guid: "17379391038838734849" }, names: { target: "Invented Boar" } }),
      note(t0 + 1_000, "attack_start", { args: { guid: "17379391038838734849" }, names: { target: "Invented Boar" } }),
      note(t0 + 1_100, "cast_spell", { args: { spellId: 9101, targetGuid: "17379391038838734849" }, names: { spell: "Invented Strike", target: "Invented Boar" }, count: 4 }),
      note(t0 + 6_000, "loot", { args: { guid: "17379391038838734849" }, names: { target: "Invented Boar" } }),
      note(t0 + 6_100, "loot_item", { args: { slot: 0 }, names: { item: "Invented Pelt" } }),
      note(t0 + 6_200, "loot_release", { auto: true }),
    ]);
  };

  at(0);
  traj.append({ t: "events_served", turn, via: "context", count: 3, events: [{ opcode: "SMSG_ATTACKSTART" }, { opcode: "SMSG_LOOT_RESPONSE" }, { opcode: "SMSG_LOG_XPGAIN" }] });
  traj.append({ t: "request", turn, adapter: "stub", promptChars: 9000 + turn * 50 });
  at(3_000);
  // The plan's reply is written the way a thinking model's often is, with the
  // blank lines left after its thinking block and a closing newline, which the
  // page must not draw.
  const reply = `Turn ${turn}. ${REPLIES[phase]}`;
  traj.append({ t: "response", turn, message: { role: "assistant", content: phase === 2 ? `\n\n${reply}\n` : reply } });

  // The patrol routine belongs to the snippet that last started it, which is seldom this turn's call.
  let owner = routineOwner;
  if (phase === 1) {
    // Reads, then a small pull.
    call(4_000, "state_summary", {}, { text: "level 7 · 62% health · Invented Field · 4 pelts" });
    call(4_500, "recent_events", { limit: 20 }, { text: "3 events\nSMSG_ATTACKSTART · SMSG_LOOT_RESPONSE · SMSG_LOG_XPGAIN" });
    at(4_600);
    w.eventsServed(undefined, [{ seq: turn * 10, ts: t + 4_500, opcode: "SMSG_ATTACKSTART", data: {} }, { seq: turn * 10 + 1, ts: t + 4_550, opcode: "SMSG_LOOT_RESPONSE", data: {} }]);
    snippet(5_000, SCOUT_CODE, { text: `ok (12ms)\n=> ${turn % 4}` });
  } else if (phase === 2) {
    owner = snippet(4_000, ERRAND_CODE, {
      text: `ok (9.4s)\n=> { status: "turned_in", quest: 9001 }`,
      durMs: 9_400,
      moves: patrolMoves(t + 4_100, 1, moveId, 0, "arrived", "Invented Quartermaster"),
      actions: [
        note(t + 4_100, "move_to", { args: { x: -9412, y: 96, z: 57 }, moveId }),
        note(t + 8_000, "gossip_hello", { args: { guid: "17379391038838734900" }, names: { target: "Invented Quartermaster" } }),
        note(t + 8_400, "quest_complete", { args: { questId: 9001 }, names: { quest: "An Invented Order" } }),
        note(t + 8_600, "quest_choose_reward", { args: { questId: 9001, rewardIndex: 0 }, names: { quest: "An Invented Order" } }),
      ],
    });
    at(13_000);
    w.ingest(drainOf(spec, { events: [{ kind: "quest", ts: t + 12_800, id: 9001 }, ...(turn % 12 === 2 ? [{ kind: "level" as const, ts: t + 12_900, from: 6 + Math.floor(turn / 12), to: 7 + Math.floor(turn / 12), xp: 40 }] : [])] }));
    call(14_000, "edit_scratchpad", { old: "- [ ] pelts", new: "- [x] pelts" }, { text: "ok" });
  } else if (phase === 3) {
    // The pull that goes wrong: a refused cast, an error, and on one turn in twelve a death.
    owner = snippet(4_000, GRIND_CODE, {
      text: `error (6.1s)\nError: killTarget: target evaded\n    at grind (snippet:4:23)\n--- harness ---\ncast_spell out_of_range ×3: step inside the spell's range before casting`,
      isError: true,
      durMs: 6_100,
      actions: [
        note(t + 4_100, "move_to", { args: { x: -9440, y: 71, z: 57 }, names: { target: "Invented Wolf" }, moveId }),
        note(t + 5_000, "set_target", { args: { guid: "17379391038838735001" }, names: { target: "Invented Wolf" } }),
        note(t + 5_100, "attack_start", { args: { guid: "17379391038838735001" }, names: { target: "Invented Wolf" } }),
        note(t + 5_200, "cast_spell", { args: { spellId: 9101, targetGuid: "17379391038838735001" }, names: { spell: "Invented Strike", target: "Invented Wolf" }, status: 400, error: "out_of_range", hint: "step inside the spell's range before casting", count: 3 }),
      ],
    });
    // One boss, late in a long enough run: a rank-3 kill, which the timeline marks as a chapter.
    if (turn === 99) {
      at(10_000);
      w.ingest(drainOf(spec, { events: [{ kind: "kill", ts: t + 9_800, victimGuid: "17379391038838739999", entry: 99001, rank: 3, self: true, member: false }] }));
    }
    if (turn % 12 === 3) {
      at(11_000);
      w.ingest(drainOf(spec, { events: [{ kind: "death", ts: t + 10_800, zone: 12, area: 9, released: false }] }));
      traj.append({ t: "harness", kind: "session_note", text: "an invented notice" });
    }
    call(12_000, "log_status", { text: "Two wolves joined the pull by the fence. Routing along the fence line from here." }, { text: "logged" });
    // The routine's first refusal and first throw of this deploy: each a notice of its own.
    at(12_500);
    traj.append({ t: "program_error", kind: "refusal", signature: "grind||castSpell|not_ready", name: "grind", action: "castSpell", status: "not_ready", deploy: turn, at: t + 12_400 });
    traj.append({
      t: "program_error",
      kind: "error",
      signature: "grind|TypeError|routines/grind.ts:42",
      name: "grind",
      error: "TypeError: Cannot read properties of undefined (reading 'guid')",
      frames: ["at grind (routines/grind.ts:42:17)"],
      deploy: turn,
      at: t + 12_450,
    });
  } else if (phase === 5) {
    call(4_000, "reflect", { reason: "half an hour of pelts; is the mill worth the walk?" }, { text: "reflection window open for 2 turns" });
    call(5_000, "read_log", { limit: 5 }, { text: "5 entries\nturn 3 · L7 · Invented Field: Two wolves joined the pull by the fence." });
    call(6_000, "log_status", { text: "Pelts first, then the mill; the fence route holds." }, { text: "logged" });
  } else {
    owner = snippet(4_000, GRIND_CODE, {
      text: `ok (14.2s)\n=> ${3 + (turn % 3)}`,
      durMs: 14_200,
      actions: [0, 1, 2].flatMap((k) => {
        const guid = String(17379391038838734849n + BigInt(k));
        const at0 = t + 4_100 + k * 4_500;
        return [
          note(at0, "move_to", { args: { x: -9460 + k * 12, y: 60 + k * 9, z: 57 }, names: { target: "Invented Boar" }, moveId: moveId + k }),
          note(at0 + 900, "set_target", { args: { guid }, names: { target: "Invented Boar" } }),
          note(at0 + 1_000, "attack_start", { args: { guid }, names: { target: "Invented Boar" } }),
          note(at0 + 1_100, "cast_spell", { args: { spellId: 9101, targetGuid: guid }, names: { spell: "Invented Strike", target: "Invented Boar" }, count: 3 }),
          note(at0 + 3_800, "loot", { args: { guid }, names: { target: "Invented Boar" } }),
          note(at0 + 3_900, "loot_item", { args: { slot: 0 }, names: { item: "Invented Pelt" } }),
          note(at0 + 4_000, "loot_release", { auto: true }),
        ];
      }),
    });
  }
  // The routine walks until the next turn: a long quiet stretch, and one walk in six that is refused.
  patrol(22_000, owner, 12, phase === 4 ? "too_far" : "arrived");
  patrol(42_000, owner, 9);
  if (phase === 4 || phase === 0) {
    // A wake after the patrol, and its count of what the routine kept hitting since the last.
    at(58_000);
    traj.append({ t: "wake", via: "yield", turn, fired: "cap", sleptMs: 30_000, maxMs: 300_000, n: turn });
    traj.append({ t: "program_error", kind: "repeat", signature: "grind||castSpell|not_ready", action: "castSpell", status: "not_ready", count: 9 + (turn % 5), since: t, at: t + 58_000 });
    if (phase === 4) traj.append({ t: "program_error", kind: "repeat", signature: "grind|TypeError|routines/grind.ts:42", count: 2, since: t, at: t + 58_000 });
  }
  return owner;
}

/**
 * Write one run: its trajectory, and its session record, or with `fanout` one
 * record per character (`<run>/sessions/<Character>/`) and the launch's
 * `config.fanout`, as a fan-out run is laid out.
 */
function writeRun(runsDir: string, spec: Spec, ended: number | null, fanout?: Spec[]): { traj: Trajectory; session: FixtureSession; sessions: FixtureSession[] } {
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
    ...(fanout === undefined ? {} : { fanout: { characters: fanout.length, accounts: fanout.map((_, i) => `FIXTURE${i + 1}`) } }),
  };
  traj.writeMeta({ runId: spec.runId, harnessVersion: "harness-fixture", startedAt: spec.startedAt, config });
  traj.setCharacter(spec.runId, spec.character);
  writeFileSync(join(dir, "scratchpad.md"), spec.scratchpad);

  // The sessions are open before the turns, which write the game side of each turn into them.
  const sessions = (fanout ?? [spec]).map((s) => openSession(runsDir, s, fanout !== undefined));

  // A turn a minute, from the start. What the character reads is its trace's (`session/`, below).
  const until = ended ?? spec.traceTo;
  let turn = 0;
  let routineOwner = 0;
  for (let t = spec.startedAt + 30_000; t <= until; t += 60_000) {
    ++turn;
    const at = (ms: number): void => {
      clock = t + ms;
      for (const session of sessions) session.clock.now = t + ms;
    };
    at(0);
    if (fanout === undefined) routineOwner = writeTurn(traj, sessions[0]!, spec, turn, t, at, routineOwner);
    else {
      traj.append({ t: "request", turn, adapter: "stub", promptChars: 9000 + turn * 50 });
      traj.append({ t: "response", turn, message: { role: "assistant", content: `Turn ${turn}: checking the field for invented boars.` } });
      traj.append({ t: "snippet", turn, call: turn * 10, code: SCOUT_CODE });
      traj.append({ t: "snippet_result", turn, call: turn * 10, name: "run_snippet", isError: false, text: `ok (12ms)\n=> ${turn % 4}` });
    }
  }

  (fanout ?? [spec]).forEach((s, i) => {
    const session = sessions[i]!;
    session.clock.now = s.traceTo;
    session.writer.ingest(drainOf(s, { trace: traceRows(s, s.traceFrom, s.traceTo), dict: DICT }));
  });
  if (ended !== null) {
    clock = ended;
    for (const session of sessions) session.clock.now = ended;
    traj.setTermination(spec.runId, "episode-limit", "episode limit reached");
  }
  clock = null;
  if (ended === null) for (const session of sessions) session.clock.now = null;
  return { traj, session: sessions[0]!, sessions };
}

/**
 * Two finished `e90` runs for the ladder: a model's, which is a row, and the
 * scripted reference's, which is only the labelled line under the table. Both
 * are stamped like a launch stamps them, so the ladder reads them as members
 * and non-members of the tier for the same reasons a real run's are.
 */
export const E90_RUN = "fixture-e90";
export const E90_GO_RUN = "fixture-e90-go";
export const E90_CLOSED_RUN = "fixture-e90-closed";
export const REFERENCE_RUN = "fixture-reference";
export const E90_DUNGEON_RUN = "fixture-e90-dungeon";

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
  // Its levels are its trace's: a key row each nine minutes, in its session record.
  const id = createHash("sha256").update(`${runId}-fixture-token-000000000000`).digest("hex").slice(0, 16);
  const writer = new SessionWriter({ dir: sessionDirOf(dir), id, stack: { version: "fixture" }, now: () => clock, log: () => {} });
  writer.open();
  const rows: TraceRow[] = [];
  for (let l = 1, t = startedAt + 60_000; l <= level; l++, t += 9 * 60_000) {
    clock = t;
    traj.append({ t: "request", turn: l, adapter: "stub", promptChars: 9000 });
    traj.append({ t: "response", turn: l, message: { role: "assistant", content: `Turn ${l}.` } });
    rows.push({ ts: t, kind: "key", map: 0, x: CENTRE.x, y: CENTRE.y, z: CENTRE.z, o: 0, data: { ...keyData(l, 100 * l, 1, 50 * l, false), xpMax: null } });
  }
  writer.ingest({ trace: { rows, dropped: 0, dict: DICT }, events: { rows: [], dropped: 0 }, nearby: { rows: [], dropped: 0, through: 0 }, moves: [], character: { guid: SELF_GUID, name: runId, race: 1, class: 1 }, stream: { connected: true, events: 0, seq: 0 } });
  clock = startedAt + 90 * 60_000;
  void writer.close();
  traj.setTermination(runId, "episode-limit", "episode limit reached");
  traj.close();
}

/**
 * A freeplay character of two attempts, both ended, for the freeplay ladder
 * and its character page: it climbs to L12, leaves its starting area, enters a
 * capital on the first attempt and takes a flight on the second, so the
 * milestone columns show reached, not reached and not instrumented together.
 * And a second character of one attempt, Fernhollow, which the rig's preview
 * stamps with the preview series, so the freeplay tab has a character on each
 * side of the selector.
 */
export const FREEPLAY_RUN = "fixture-freeplay-1";
export const FREEPLAY_RUN_2 = "fixture-freeplay-2";
export const FREEPLAY_FRESH = "fixture-freeplay-fresh";

interface FreeplayAttempt {
  runId: string;
  /** Its character's name; Wanderly when absent. */
  character?: string;
  continuedFrom?: string;
  startedAt: number;
  minutes: number;
  /** The levels it shows, one a step, from the first. */
  levels: [number, number];
  /** Its zone, area and taxi rows, at minutes into the attempt. */
  events: { at: number; kind: "zone" | "area" | "taxi"; to?: number }[];
}

function writeFreeplayAttempt(runsDir: string, a: FreeplayAttempt): Promise<void> {
  const dir = join(runsDir, a.runId);
  mkdirSync(dir, { recursive: true });
  let clock = a.startedAt;
  const traj = new Trajectory(dir, { now: () => clock });
  const token = `${a.runId}-fixture-token-000000000000`;
  const name = a.character ?? "Wanderly";
  const config = {
    ...loadRunConfig({ episode: "freeplay", account: "FIXTURE", driver: "openai", model: "fixture/freeplay-model", character: name }),
    runId: a.runId,
    token,
    runsDir,
    ...(a.continuedFrom !== undefined ? { continuedFrom: a.continuedFrom } : {}),
  };
  traj.writeMeta({ runId: a.runId, harnessVersion: "harness-fixture", startedAt: a.startedAt, config, comparability: comparabilityOf(config, "harness-fixture") });
  traj.setCharacter(a.runId, name);
  const id = createHash("sha256").update(token).digest("hex").slice(0, 16);
  const writer = new SessionWriter({ dir: sessionDirOf(dir), id, stack: { version: "fixture" }, now: () => clock, log: () => {} });
  writer.open();
  const [from, to] = a.levels;
  const step = (a.minutes * 60_000) / (to - from + 1);
  const rows: TraceRow[] = [];
  for (let l = from, i = 0; l <= to; l++, i++) {
    const t = a.startedAt + 60_000 + Math.round(i * step);
    clock = t;
    traj.append({ t: "request", turn: i + 1, adapter: "stub", promptChars: 9000 });
    traj.append({ t: "response", turn: i + 1, message: { role: "assistant", content: `Turn ${i + 1}.` } });
    rows.push({ ts: t, kind: "key", map: 0, x: CENTRE.x, y: CENTRE.y, z: CENTRE.z, o: 0, data: { ...keyData(l, 100 * l, 1, 400 * l, false), xpMax: null } });
  }
  const events = a.events.map((e, i) => {
    const ts = a.startedAt + e.at * 60_000;
    return e.kind === "taxi" ? { ts, seq: i + 1, kind: "taxi" as const } : { ts, seq: i + 1, kind: e.kind, to: e.to! };
  });
  writer.ingest({ trace: { rows, dropped: 0, dict: DICT }, events: { rows: events, dropped: 0 }, nearby: { rows: [], dropped: 0, through: 0 }, moves: [], character: { guid: SELF_GUID, name, race: 1, class: 1 }, stream: { connected: true, events: 0, seq: 0 } });
  clock = a.startedAt + a.minutes * 60_000;
  const closed = writer.close();
  traj.setTermination(a.runId, "idle", "idle watchdog");
  traj.close();
  return closed;
}

/**
 * A freeplay character three days and six hours into one attempt, ended: the
 * run the timeline's zoom is for. A turn every twenty minutes, a level every
 * five hours or so, a death now and then, two bosses, and two pauses (six
 * hours and two), so its bar has bands, ticks, marks and gaps to draw.
 */
export const LONG_RUN = "fixture-long";
const LONG_HOURS = 78;

function writeLongRun(runsDir: string, startedAt: number): Promise<void> {
  const dir = join(runsDir, LONG_RUN);
  mkdirSync(dir, { recursive: true });
  let clock = startedAt;
  const traj = new Trajectory(dir, { now: () => clock });
  const token = `${LONG_RUN}-fixture-token-000000000000`;
  const name = "Longhaul";
  const config = { ...loadRunConfig({ episode: "freeplay", account: "FIXTURE", driver: "openai", model: "fixture/long-model", character: name }), runId: LONG_RUN, token, runsDir };
  traj.writeMeta({ runId: LONG_RUN, harnessVersion: "harness-fixture", startedAt, config, comparability: comparabilityOf(config, "harness-fixture") });
  traj.setCharacter(LONG_RUN, name);
  const id = createHash("sha256").update(token).digest("hex").slice(0, 16);
  const writer = new SessionWriter({ dir: sessionDirOf(dir), id, stack: { version: "fixture" }, now: () => clock, log: () => {} });
  writer.open();
  const HOUR = 3_600_000;
  const pauses: [number, number][] = [[20, 26], [50, 52]];
  const paused = (h: number): boolean => pauses.some(([a, b]) => h >= a && h < b);
  const rows: TraceRow[] = [];
  const events: EventRow[] = [];
  let level = 10;
  let turn = 0;
  let seq = 0;
  for (let m = 1; m <= LONG_HOURS * 60; m += 20) {
    const h = m / 60;
    const t = startedAt + m * 60_000;
    for (const [a, b] of pauses) {
      if (m - 20 < a * 60 && m >= a * 60) {
        clock = startedAt + a * HOUR;
        traj.append({ t: "pause", reason: "usage-limit", detail: "an invented pause" });
      }
      if (m - 20 < b * 60 && m >= b * 60) {
        clock = startedAt + b * HOUR;
        traj.append({ t: "resume", turnOffset: turn, turns: 0 });
      }
    }
    if (paused(h)) continue;
    clock = t;
    ++turn;
    traj.append({ t: "request", turn, adapter: "stub", promptChars: 9000 });
    traj.append({ t: "response", turn, message: { role: "assistant", content: `Turn ${turn}. Hour ${Math.floor(h)} of the long road: the next camp, then the pass.` } });
    if (turn % 14 === 0) events.push({ kind: "level", ts: t + 5_000, seq: ++seq, from: level, to: ++level, xp: 40 });
    if (turn % 23 === 5) events.push({ kind: "death", ts: t + 8_000, seq: ++seq, zone: 12, area: 9, released: false });
    if (turn === 60 || turn === 170) events.push({ kind: "kill", ts: t + 9_000, seq: ++seq, victimGuid: `1737939103883874${turn}`, entry: 99000 + turn, rank: 3, self: true, member: false });
    const p = position(t, 0);
    rows.push({ ts: t, kind: "key", map: 0, x: p.x, y: p.y, z: CENTRE.z, o: p.o, data: { ...keyData(level, 100 * turn, 1, 400 * turn, false), xpMax: null } });
  }
  writer.ingest({ trace: { rows, dropped: 0, dict: DICT }, events: { rows: events, dropped: 0 }, nearby: { rows: [], dropped: 0, through: 0 }, moves: [], character: { guid: SELF_GUID, name, race: 1, class: 1 }, stream: { connected: true, events: 0, seq: 0 } });
  clock = startedAt + LONG_HOURS * HOUR;
  const closed = writer.close();
  traj.setTermination(LONG_RUN, "idle", "idle watchdog");
  traj.close();
  return closed;
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
    // The character's own pet, and a creature chasing another player: the
    // player is never in the ring, and the writer's gate cuts the target's guid to its kind.
    { id: unitGuid(90005, 10, 0xf140), ty: "pet", s: { entry: 90005, name: "Invented Hound", ow: SELF_GUID }, at: wander(-4, -4, 3, 50_000, 0), moves: true },
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

/** The live run's ring, written through its session writer: a key `backMs` ago, the scene since, and a ticker to keep it going. */
function writeRing(spec: Spec, session: FixtureSession, now: number, backMs: number): { tick: (t: number) => void } {
  const scene = nearbyScene();
  const from = now - backMs;
  const key: NearbyRow = {
    ts: from,
    kind: "key",
    self: { guid: SELF_GUID, map: 0, target: null, down: false },
    units: scene.map((u) => {
      const p = u.at(from);
      return { id: u.id, ty: u.ty, s: u.s, m: { k: "pos", t: from, p: [p.x, p.y, CENTRE.z, 0] } };
    }),
  };
  session.writer.ingest(drainOf(spec, { nearby: [key, ...sceneRows(scene, from, now)], through: now }));
  let last = now;
  return {
    tick(t) {
      session.writer.ingest(drainOf(spec, { nearby: sceneRows(scene, last, t), through: t }));
      last = t;
    },
  };
}

export interface Fixture {
  runsDir: string;
  /** The live run the rig's states are about: the one with a nearby ring. */
  live: string;
  /** Every live run, `live` first. */
  lives: string[];
  /** The live fan-out run, and its characters in name order. */
  fanoutLive: { runId: string; characters: string[] };
  ended: string;
  /** An ended run of more than three days, for the timeline's zoom. */
  long: string;
  /** Resolves once the ended run's session record is closed; the live runs' rings are on disk before `writeFixture` returns. */
  ready: Promise<void>;
  /** Keep the live run live: a position, a heartbeat and now and then a state sample. */
  tick(now?: number): void;
  close(): void;
}

const LIVE_RUN_2 = "fixture-live-2";
const LIVE_RUN_3 = "fixture-live-3";
const LIVE_RUN_4 = "fixture-live-4";

/**
 * A camera's output for a run, in the contract's layout: `camera/clips.json`
 * (version 2) naming a video in two parts, each the same two-second synthetic
 * test pattern (ffmpeg's `testsrc`, `runner/test/fixtures/camera/`) and never
 * a game image, with chapters (a list cut before the chapter rule: its zone,
 * turn-in and death still listed, and not drawn), the model's words and a time map over the
 * run's span, and `meta.json` labelled `camera`. A frame on disk too, with no
 * index, which nothing may ever serve.
 */
function writeCamera(runsDir: string, runId: string, from: number, to: number, model: string): void {
  const media = join(import.meta.dir, "..", "..", "runner", "test", "fixtures", "camera");
  const dir = join(runsDir, runId, "camera");
  mkdirSync(join(dir, "clips"), { recursive: true });
  mkdirSync(join(dir, "frames"), { recursive: true });
  copyFileSync(join(media, "poster.jpg"), join(dir, "frames", "1.jpg"));
  const iso = (t: number): string => new Date(t).toISOString();
  const mid = from + Math.round((to - from) / 2);
  const parts = [
    { file: "clips/part-000.mp4", poster: "clips/part-000.jpg", from: iso(from), to: iso(mid), seconds: 2 },
    { file: "clips/part-001.mp4", poster: "clips/part-001.jpg", from: iso(mid + 10_000), to: iso(to), seconds: 2 },
  ];
  for (const n of ["part-000", "part-001"]) {
    copyFileSync(join(media, "clip.mp4"), join(dir, "clips", `${n}.mp4`));
    copyFileSync(join(media, "poster.jpg"), join(dir, "clips", `${n}.jpg`));
  }
  const at = (frac: number): number => from + Math.round((to - from) * frac);
  writeFileSync(
    join(dir, "clips.json"),
    `${JSON.stringify(
      {
        version: 2,
        runId,
        parts,
        chapters: [
          { t: 0.75, part: 0, type: "zone", detail: "entered zone 12", caption: "Out of the abbey and down the road." },
          { t: 1.5, part: 0, type: "quest", detail: "turned in quest 33", caption: "Pelts done; turning in." },
          { t: 2.5, part: 1, type: "level", detail: "reached level 5", caption: "Five pelts to go, then the scout by the old mill." },
          { t: 3.25, part: 1, type: "death", detail: "died", caption: "Too many wolves at once." },
          { t: 3.5, part: 1, type: "boss", detail: "killed boss 99001", caption: "The foreman is down." },
        ],
        captions: [
          { t: 0, text: `${model}: heading out of the abbey.` },
          { t: 1, text: "Pelts done; turning in." },
          { t: 2.25, text: "Five pelts to go, then the scout by the old mill." },
          { t: 3.25, text: "Too many wolves at once." },
        ],
        timemap: [
          [0, from],
          [1.875, mid],
          [2, mid + 10_000],
          [3, at(0.8)],
          [3.125, at(0.8)],
          [3.875, to],
        ],
      },
      null,
      2,
    )}\n`,
  );
  const metaPath = join(runsDir, runId, "meta.json");
  writeFileSync(metaPath, JSON.stringify({ ...(JSON.parse(readFileSync(metaPath, "utf8")) as object), camera: true }));
}

/** How often the fixture's live camera takes a still, like the camera's own interval. */
const LIVE_FRAME_MS = 10_000;

/**
 * A camera's stills while a run plays: `camera/frames/000042.jpg` (the
 * camera's own `frameFile`) and a line each in `camera/frames.jsonl`, the last
 * few up to `now`, each the synthetic test pattern (`runner/test/fixtures/camera/poster.jpg`). Only the private
 * viewer serves the newest of them, so `meta.json` is left alone and the
 * public snapshot stays what it was. Returns the ticker that keeps taking them.
 */
function writeLiveFrames(runsDir: string, runId: string, now: number): (t: number) => void {
  const still = join(import.meta.dir, "..", "..", "runner", "test", "fixtures", "camera", "poster.jpg");
  const dir = join(runsDir, runId, "camera");
  mkdirSync(join(dir, "frames"), { recursive: true });
  let seq = 0;
  let last = 0;
  const take = (t: number): void => {
    seq += 1;
    last = t;
    copyFileSync(still, join(dir, frameFile(seq)));
    appendFileSync(join(dir, "frames.jsonl"), `${JSON.stringify({ seq, t: new Date(t).toISOString(), file: frameFile(seq), kind: "interval" })}\n`);
  };
  for (let t = now - 3 * LIVE_FRAME_MS; t <= now - LIVE_FRAME_MS / 2; t += LIVE_FRAME_MS) take(t);
  return (t) => {
    if (t - last >= LIVE_FRAME_MS) take(t);
  };
}

/** Write the runs into `runsDir` relative to `now`, and hand back the live runs' ticker. */
/**
 * The dungeon board's runs: scored Deadmines attempts on both ids, cleared
 * and not, each with its characters' kills, deaths and instance entry on its
 * own session record, as a real attempt's are. A one-agent run is a fan-out
 * run and so private only; a five-agent attempt is five member runs.
 */
export const DUNGEON_SOLO_RUN = "fixture-dm-solo";
export const DUNGEON_SOLO_CLEARED_RUN = "fixture-dm-solo-cleared";
export const DUNGEON_PARTY = "fixture-dm-party";

const DM_CHARACTERS = ["Tankpartyb", "Healpartyc", "Magepartyd", "Roguepartye", "Palapartyf"];
const DM_MEMBERS = ["tank", "healer", "mage", "rogue", "paladin"];
const DM_ROLES = ["tank", "healer", "damage", "damage", "damage"];

/** One character's events on a Deadmines attempt: entered at `enter`, the bosses killed at their minutes, deaths and resurrections. */
interface DungeonCharacter {
  name: string;
  enter?: number;
  kills?: [entry: number, minute: number][];
  deaths?: number[];
  resurrects?: number[];
}

function dungeonEvents(c: DungeonCharacter, startedAt: number): EventRow[] {
  const t = (m: number): number => startedAt + m * 60_000;
  const rows: EventRow[] = [];
  if (c.enter !== undefined) rows.push({ kind: "instance", event: "entered", map: 36, instanceType: 1, from: { map: 0, instanceType: 0 }, ts: t(c.enter) });
  for (const [entry, m] of c.kills ?? []) rows.push({ kind: "kill", victimGuid: `fixture-victim-${entry}`, entry, rank: 1, self: c.name === DM_CHARACTERS[0], member: true, ts: t(m) });
  for (const m of c.deaths ?? []) rows.push({ kind: "death", ts: t(m) });
  for (const m of c.resurrects ?? []) rows.push({ kind: "resurrect", ts: t(m) });
  return rows.sort((a, b) => a.ts - b.ts);
}

function writeDungeonRun(
  runsDir: string,
  runId: string,
  raw: Record<string, unknown>,
  characters: DungeonCharacter[],
  o: { startedAt: number; minutes: number; reason: string; fanout: boolean; turnUsd?: number },
): Promise<void> {
  const dir = join(runsDir, runId);
  mkdirSync(dir, { recursive: true });
  let clock = o.startedAt;
  const traj = new Trajectory(dir, { now: () => clock });
  const config = { ...loadRunConfig({ driver: "openai", account: "FIXTURE1", race: 1, class: 1, loop: "program", yield: true, ...raw }), runId, token: `${runId}-fixture-token-000000000000`, runsDir };
  traj.writeMeta({ runId, harnessVersion: "harness-fixture", startedAt: o.startedAt, config, comparability: comparabilityOf(config, "harness-fixture") });
  for (let turn = 1; turn <= 3; turn++) {
    clock = o.startedAt + turn * 60_000;
    traj.append({ t: "request", turn, adapter: "stub", promptChars: 9000 });
    // The provider's charge per call, as OpenRouter reports it, so the board's cost has a reading.
    const usage = o.turnUsd === undefined ? {} : { usage: { prompt_tokens: 9000, completion_tokens: 400, cost: o.turnUsd } };
    traj.append({ t: "response", turn, message: { role: "assistant", content: `Turn ${turn}.` }, ...usage });
  }
  const writers = characters.map((c, i) => {
    const sdir = o.fanout ? join(dir, SESSIONS_DIR, c.name) : sessionDirOf(dir);
    const id = createHash("sha256").update(`${runId}-${c.name}-fixture-token`).digest("hex").slice(0, 16);
    const writer = new SessionWriter({ dir: sdir, id, stack: { version: "fixture" }, now: () => clock, log: () => {} });
    writer.open();
    const key: TraceRow = { ts: o.startedAt + 60_000, kind: "key", map: 0, x: CENTRE.x, y: CENTRE.y, z: CENTRE.z, o: 0, data: { ...keyData(20, 0, 0, 30_000, false), xpMax: null } };
    writer.ingest({
      trace: { rows: [key], dropped: 0, dict: DICT },
      events: { rows: dungeonEvents(c, o.startedAt), dropped: 0 },
      nearby: { rows: [], dropped: 0, through: 0 },
      moves: [],
      character: { guid: String(100 + i), name: c.name, race: 1, class: 1 },
      stream: { connected: true, events: 0, seq: 0 },
    });
    return writer;
  });
  clock = o.startedAt + o.minutes * 60_000;
  traj.setTermination(runId, o.reason as Parameters<Trajectory["setTermination"]>[1], o.reason);
  traj.close();
  return Promise.all(writers.map((w) => w.close())).then(() => undefined);
}

function writeDungeonRuns(runsDir: string, now: number): Promise<void> {
  const solo = taskDefinition("deadmines-solo");
  const five = taskDefinition("deadmines");
  const accounts = DM_CHARACTERS.map((_, i) => `FIXTURE${i + 1}`);
  const fanout = { characters: 5, accounts, staged: DM_CHARACTERS.map((character, i) => ({ character, account: accounts[i]! })) };
  const soloRaw = (model: string): Record<string, unknown> => ({ model, episode: "deadmines-solo", directive: solo.objective, fanout, task: { definition: taskHash("deadmines-solo") }, watchdogs: { episodeMs: 14_400_000, idleMs: 1_200_000, noXpMs: null }, maxToolCallsPerEpisode: 8000 });
  const writes: Promise<void>[] = [];
  // Cleared in 1h41m, after a wipe: the route's seven, and Cookie on the ship.
  writes.push(
    writeDungeonRun(
      runsDir,
      DUNGEON_SOLO_CLEARED_RUN,
      soloRaw("fixture/dungeon-model"),
      DM_CHARACTERS.map((name, i) => ({
        name,
        ...(i === 0 ? { enter: 4, kills: [[644, 18], [643, 35], [642, 34], [1763, 47], [646, 62], [647, 80], [645, 92], [639, 101]] as [number, number][] } : {}),
        deaths: [55],
        resurrects: [58],
      })),
      { startedAt: now - 4 * 3_600_000, minutes: 102, reason: "kill-target", fanout: true, turnUsd: 1.4 },
    ),
  );
  // Not cleared: three bosses before the clock ran out.
  writes.push(
    writeDungeonRun(
      runsDir,
      DUNGEON_SOLO_RUN,
      soloRaw("fixture/second-model"),
      DM_CHARACTERS.map((name, i) => ({ name, ...(i === 0 ? { enter: 9, kills: [[644, 30], [643, 70], [642, 71]] as [number, number][] } : {}), ...(i === 1 ? { deaths: [40, 90] } : {}) })),
      { startedAt: now - 5 * 3_600_000, minutes: 240, reason: "episode-limit", fanout: true, turnUsd: 0.12 },
    ),
  );
  // Five agents of one model: the tank's run met the clock, the rest ended with it.
  const party = { id: DUNGEON_PARTY, size: 5, members: DM_MEMBERS.map((member, i) => ({ member, role: DM_ROLES[i]!, runId: `${DUNGEON_PARTY}-${member}`, account: accounts[i]!, character: DM_CHARACTERS[i]! })) };
  DM_MEMBERS.forEach((member, i) => {
    const m = five.party!.members[i]!;
    writes.push(
      writeDungeonRun(
        runsDir,
        `${DUNGEON_PARTY}-${member}`,
        {
          model: "fixture/dungeon-model",
          episode: "deadmines",
          account: accounts[i],
          race: m.race,
          class: m.class,
          character: m.character,
          directive: m.objective,
          party: { ...party, member, role: DM_ROLES[i] },
          task: { definition: taskHash("deadmines") },
          watchdogs: { episodeMs: 14_400_000, idleMs: 1_200_000, noXpMs: null },
          maxToolCallsPerEpisode: 8000,
        },
        [{ name: DM_CHARACTERS[i]!, enter: 6, ...(i === 0 ? { kills: [[644, 25], [643, 50], [642, 49], [1763, 66], [645, 90]] as [number, number][] } : {}), deaths: [110 + i] }],
        { startedAt: now - 6 * 3_600_000, minutes: 240, reason: i === 0 ? "episode-limit" : "party-ended", fanout: false },
      ),
    );
  });
  return Promise.all(writes).then(() => undefined);
}

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
    climbs: true,
  };
  const endedRun = writeRun(runsDir, endedSpec, endedAt);
  endedRun.traj.close();
  writeCamera(runsDir, ENDED_RUN, endedSpec.startedAt, endedAt, "fixture/ended-model");
  // A fan-out run: one agent, two characters, a record each; private only.
  const fanoutAt = at(now - 15 * 60_000);
  const fanoutSpec: Spec = {
    runId: FANOUT_RUN,
    character: "Oakhart",
    model: "fixture/fanout-model",
    startedAt: at(now - 2 * 3_600_000),
    traceFrom: at(now - 2 * 3_600_000 + 60_000),
    traceTo: fanoutAt,
    phase: 0,
    scratchpad: PAD("Oakhart"),
  };
  const fanoutRun = writeRun(runsDir, fanoutSpec, fanoutAt, [fanoutSpec, { ...fanoutSpec, character: "Pellira", phase: LOOP_MS / 2, ground: { map: 0, x: -9420, y: 90, z: 57 }, level: 9 }]);
  fanoutRun.traj.close();
  // Its launch's session tokens, which no reader may serve.
  writeFileSync(join(runsDir, FANOUT_RUN, "roster.json"), JSON.stringify({ characters: [{ character: "Oakhart", token: FANOUT_ROSTER_TOKEN }, { character: "Pellira", token: FANOUT_ROSTER_TOKEN }] }), { mode: 0o600 });
  // Two attempts of one freeplay character: Northshire's areas (9, 24) then Goldshire's (87) twice, Stormwind (1519), and a flight on the second.
  const freeplayAt = at(now - 10 * 3_600_000);
  const freeplay = [
    writeFreeplayAttempt(runsDir, { runId: FREEPLAY_RUN, startedAt: freeplayAt, minutes: 180, levels: [1, 8], events: [{ at: 1, kind: "area", to: 9 }, { at: 30, kind: "area", to: 24 }, { at: 70, kind: "area", to: 87 }, { at: 75, kind: "area", to: 87 }, { at: 150, kind: "zone", to: 1519 }] }),
    writeFreeplayAttempt(runsDir, { runId: FREEPLAY_RUN_2, continuedFrom: FREEPLAY_RUN, startedAt: freeplayAt + 4 * 3_600_000, minutes: 120, levels: [8, 12], events: [{ at: 1, kind: "zone", to: 1519 }, { at: 40, kind: "taxi" }] }),
    writeFreeplayAttempt(runsDir, { runId: FREEPLAY_FRESH, character: "Fernhollow", startedAt: freeplayAt + 7 * 3_600_000, minutes: 90, levels: [1, 6], events: [{ at: 1, kind: "area", to: 9 }, { at: 50, kind: "area", to: 24 }, { at: 55, kind: "area", to: 24 }] }),
  ];
  // A run of days, for the timeline's zoom.
  const long = writeLongRun(runsDir, at(now - (LONG_HOURS + 4) * 3_600_000));
  const ready = Promise.all([endedRun.session.writer.close(), ...fanoutRun.sessions.map((x) => x.writer.close()), writeDungeonRuns(runsDir, at(now)), ...freeplay, long]).then(() => undefined);
  writeLadderRun(runsDir, E90_RUN, { driver: "openai", model: "fixture/e90-model", character: "Laddera" }, 6, at(now - 5 * 3_600_000));
  // The same model through OpenCode Go, which stamps unpinned routing and
  // records the bare id where OpenRouter prefixes the vendor: one model, so
  // the same row, on the same chart (operator, 2026-11-16).
  writeLadderRun(runsDir, E90_GO_RUN, { driver: "openai", model: "e90-model", apiBase: "https://opencode.ai/inference/go/openai/v1", character: "Ladderine" }, 5, at(now - 8 * 3_600_000));
  // A second row, under an invented id a family's weights rules still answer
  // for (Anthropic's catch-all reads `closed`), so the ladder's weights filter
  // has two buckets to offer; `fixture/e90-model` reads `unknown`.
  writeLadderRun(runsDir, E90_CLOSED_RUN, { driver: "openai", model: "anthropic/fixture-model", character: "Closewyn" }, 4, at(now - 6 * 3_600_000));
  writeLadderRun(runsDir, REFERENCE_RUN, { driver: "reference", character: "Routeric" }, 9, at(now - 4 * 3_600_000));
  // A camera on a run that is never published: the public half must show none of it.
  writeCamera(runsDir, REFERENCE_RUN, at(now - 5 * 3_600_000), at(now - 4 * 3_600_000), "reference");
  // The dungeon board's model on the e90 ladder too, on the board runs' condition: a program-loop row of its own.
  writeLadderRun(runsDir, E90_DUNGEON_RUN, { driver: "openai", model: "fixture/dungeon-model", loop: "program", yield: true, character: "Delvara" }, 3, at(now - 7 * 3_600_000));
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
    const { traj, session } = writeRun(runsDir, spec, null);
    const heartbeat = join(runsDir, spec.runId, "heartbeat");
    return { spec, traj, session, heartbeat, last: spec.traceTo };
  });
  // A live fan-out run: one agent, three characters, a record each and a pip each; private only.
  const fanoutLiveSpecs: Spec[] = [
    { ...liveSpec, runId: FANOUT_LIVE_RUN, character: "Bramblewick", model: "fixture/fanout-model", startedAt: at(now - 40 * 60_000), phase: LOOP_MS / 3, scratchpad: PAD("Bramblewick"), ground: { map: 0, x: -9330, y: 200, z: 57 }, level: 5 },
    { ...liveSpec, runId: FANOUT_LIVE_RUN, character: "Corriva", model: "fixture/fanout-model", startedAt: at(now - 40 * 60_000), phase: (LOOP_MS * 2) / 3, scratchpad: PAD("Corriva"), ground: { map: 0, x: -9280, y: 290, z: 57 }, level: 8 },
    { ...liveSpec, runId: FANOUT_LIVE_RUN, character: "Duskel", model: "fixture/fanout-model", startedAt: at(now - 40 * 60_000), phase: 0, scratchpad: PAD("Duskel"), ground: { map: 0, x: -9380, y: 300, z: 57 }, level: 6 },
  ];
  const fanoutLive = writeRun(runsDir, fanoutLiveSpecs[0]!, null, fanoutLiveSpecs);
  writeFileSync(join(runsDir, FANOUT_LIVE_RUN, "roster.json"), JSON.stringify({ characters: fanoutLiveSpecs.map((s) => ({ character: s.character, token: FANOUT_ROSTER_TOKEN })) }), { mode: 0o600 });
  const fanoutHeartbeat = join(runsDir, FANOUT_LIVE_RUN, "heartbeat");
  const ticking = [...lives, ...fanoutLive.sessions.map((session, i) => ({ spec: fanoutLiveSpecs[i]!, session, heartbeat: fanoutHeartbeat, last: fanoutLiveSpecs[i]!.traceTo }))];
  const beat = (t: number): void => {
    for (const l of ticking) {
      writeFileSync(l.heartbeat, "fixture 0\n");
      utimesSync(l.heartbeat, t / 1000, t / 1000);
    }
  };
  beat(now);
  const ring = writeRing(liveSpec, lives[0]!.session, now, 14 * 60_000);
  // The live run's camera stills, which only the private run page shows.
  const frames = writeLiveFrames(runsDir, LIVE_RUN, now);
  return {
    runsDir,
    live: LIVE_RUN,
    lives: liveSpecs.map((s) => s.runId),
    fanoutLive: { runId: FANOUT_LIVE_RUN, characters: fanoutLiveSpecs.map((s) => s.character).sort() },
    ended: ENDED_RUN,
    long: LONG_RUN,
    ready,
    tick(t = Date.now()) {
      ring.tick(t);
      frames(t);
      const to = at(t);
      for (const l of ticking) {
        if (to > l.last) {
          l.session.writer.ingest(drainOf(l.spec, { trace: traceRows({ ...l.spec, traceTo: to }, l.last + 2_000, to, false) }));
          l.last = to;
        }
      }
      beat(t);
    },
    close() {
      for (const l of lives) {
        l.traj.close();
        void l.session.writer.close();
      }
      fanoutLive.traj.close();
      for (const s of fanoutLive.sessions) void s.writer.close();
    },
  };
}
