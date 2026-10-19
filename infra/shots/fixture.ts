/**
 * Synthetic runs for the dashboard render rig (`infra/dashboard-shots.ts`),
 * written through the runner's own `Trajectory`, so the viewer and the
 * publisher read them exactly as they read a real run. Every name, id and word
 * is invented here; nothing reads `data/`.
 *
 *   fixture-live   unterminated, a fresh heartbeat, a trace to now, walking a
 *                  loop; `tickLive` keeps it live while the rig runs
 *   fixture-ended  terminated `episode-limit` half an hour ago, two and a half
 *                  hours of trace to replay
 *   fixture-e90, fixture-reference
 *                  two finished `e90` runs, a model's row and the scripted
 *                  reference's line, for the ladder (`writeLadderRun`)
 *
 * Both carry a character sheet on the trace (money, worn and carried items, a
 * quest log with one quest that completes, one in progress and one of four
 * items to collect, two never found, and a turn-in), the 60 s
 * state line, snippets and tool calls with one failure each, a harness notice
 * and a scratchpad. The state line's quest count starts again at zero halfway
 * (`questsAt`), as a resumed process's does, so the map's quest figure shows
 * the run's sum (3) where the newest sample says 1.
 */

import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { comparabilityOf } from "../../runner/src/comparability";
import { loadRunConfig, unscoredStamp } from "../../runner/src/config";
import { Trajectory } from "../../runner/src/trajectory";
import type { TraceDict, TraceKeyData, TraceRow } from "../../runner/src/trace-row";
import { TRACE_WINDOW_MS } from "../../runner/src/trace-row";

export const LIVE_RUN = "fixture-live";
export const ENDED_RUN = "fixture-ended";

/** Map 0, an open field: where both characters walk. */
const CENTRE = { x: -9460, y: 60, z: 57 };
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

function position(t: number, phase: number): { x: number; y: number; o: number } {
  const a = (2 * Math.PI * ((t + phase) % LOOP_MS)) / LOOP_MS;
  return { x: CENTRE.x + 25 * Math.cos(a), y: CENTRE.y + 25 * Math.sin(a), o: (a + Math.PI / 2) % (2 * Math.PI) };
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
}

/** The trace of one span: a key row at each window's start, a position every 2 s, a state delta as the counters move. */
function traceRows(spec: Spec, from: number, to: number, keyAtFrom = true): TraceRow[] {
  const rows: TraceRow[] = [];
  const span = spec.traceTo - spec.traceFrom;
  const pelts = (t: number): number => 1 + Math.min(4, Math.floor(((t - spec.traceFrom) / Math.max(1, span)) * 5));
  const complete = (t: number): boolean => t - spec.traceFrom > span * 0.6;
  const xp = (t: number): number => 1000 + Math.floor(((t - spec.traceFrom) / Math.max(1, span)) * 3000);
  const money = (t: number): number => 2500 + Math.floor((t - spec.traceFrom) / 60_000) * 7;
  let lastPelts = -1;
  let lastComplete: boolean | null = null;
  for (let t = from; t <= to; t += 2_000) {
    const p = position(t, spec.phase);
    const windowStart = t - (t % TRACE_WINDOW_MS);
    if ((t === from && keyAtFrom) || t - windowStart < 2_000) {
      rows.push({ ts: t, kind: "key", map: 0, x: p.x, y: p.y, z: CENTRE.z, o: p.o, data: keyData(7, xp(t), pelts(t), money(t), complete(t)) });
      lastPelts = pelts(t);
      lastComplete = complete(t);
      continue;
    }
    rows.push({ ts: t, kind: "pos", map: 0, x: p.x, y: p.y, z: CENTRE.z, o: p.o });
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
  const config = {
    ...loadRunConfig({ driver: "stub" }),
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
  for (let t = spec.startedAt + 30_000; t <= until; t += 60_000) {
    clock = t;
    const p = position(t, spec.phase);
    const pelts = 1 + Math.min(4, Math.floor(((t - spec.startedAt) / Math.max(1, until - spec.startedAt)) * 5));
    traj.recordState(spec.runId, {
      level: 7,
      xp: 1000 + Math.floor(((t - spec.startedAt) / (until - spec.startedAt)) * 3000),
      map: 0,
      ...p,
      z: CENTRE.z,
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

export interface Fixture {
  runsDir: string;
  live: string;
  ended: string;
  /** Keep the live run live: a position, a heartbeat and now and then a state sample. */
  tick(now?: number): void;
  close(): void;
}

/** Write both runs into `runsDir` relative to `now`, and hand back the live run's ticker. */
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
  writeLadderRun(runsDir, REFERENCE_RUN, { driver: "reference", character: "Routeric" }, 9, at(now - 4 * 3_600_000));
  const live = writeRun(runsDir, liveSpec, null);
  const heartbeat = join(runsDir, LIVE_RUN, "heartbeat");
  let last = liveSpec.traceTo;
  let lastState = liveSpec.traceTo;
  const beat = (t: number): void => {
    writeFileSync(heartbeat, "fixture 0\n");
    utimesSync(heartbeat, t / 1000, t / 1000);
  };
  beat(now);
  return {
    runsDir,
    live: LIVE_RUN,
    ended: ENDED_RUN,
    tick(t = Date.now()) {
      const to = at(t);
      if (to > last) {
        live.recordTrace(LIVE_RUN, traceRows({ ...liveSpec, traceTo: to }, last + 2_000, to, false));
        last = to;
      }
      if (to - lastState >= 60_000) {
        const p = position(to, 0);
        live.recordState(LIVE_RUN, { level: 7, xp: 4000, map: 0, ...p, z: CENTRE.z, money: 2800, questsCompleted: 1, items: itemsOf(5) });
        lastState = to;
      }
      beat(t);
    },
    close() {
      live.close();
    },
  };
}
