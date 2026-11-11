/**
 * The trace end to end, on the real code at every step: the stack's trace
 * recorder (`@wrathbench/mcp/record/recorder`) over a real SDK state cache fed
 * hand-written frames, the stack's `SessionWriter` folding, keying and
 * segmenting what each drain hands it into the run's `session/trace`, the
 * viewer's `trace-db.ts` reading it back through the run's session source, and
 * the codec decoding what the viewer encoded. What the player gets out must be
 * what the recorder put in.
 *
 * Also here: the storage contract has two spellings, the stack's
 * (`@wrathbench/mcp/record`, rows with parsed `data`) and the browser-safe
 * codec's (`viewer/api-types.ts` and `viewer/trace.ts`, a row with `data` as
 * text). The codec cannot import the stack (it ships to the browser over
 * `@viewer/*` and imports nothing), so the two are pinned compatible here, at
 * the type level and at runtime. Where v1 differs from the codec's spelling on
 * purpose, the difference is its own pin.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { EventStream, StateCache } from "@wrathbench/sdk";
import {
  applySheetPatch as writerApplyPatch,
  emptyTraceSheet as writerEmptySheet,
  emptyTraceState as writerEmptyState,
  SEGMENT_MS,
  SHEET_KEY_LEN as WRITER_SHEET_KEY_LEN,
  SHEET_KEYS as WRITER_SHEET_KEYS,
  sheetPatch as writerSheetPatch,
  validateSession,
  type TraceDict as WriterDict,
  type TraceKind,
  type TraceQuestReq as WriterQuestReq,
  type TraceRow as WriterRow,
  type TraceSheet as WriterSheet,
  type TraceState as WriterState,
} from "@wrathbench/mcp/record";
import { TraceRecorder } from "@wrathbench/mcp/record/recorder";
import type { TraceItemName, TraceQuestReq as ViewerQuestReq, TraceSheet as ViewerSheet, TraceState as ViewerState } from "../viewer/api-types";
import { projectTraceSegment } from "../viewer/public-projection";
import { sessionSource } from "../viewer/session-source";
import {
  GAP_MS,
  Q_O,
  SEG_MS,
  SETTLE_MS,
  SHEET_KEY_LEN,
  SHEET_KEYS,
  STATE_KEYS,
  applySheetPatch,
  decodeSegment,
  encodeSegment,
  emptyTraceSheet as viewerEmptySheet,
  emptyTraceState as viewerEmptyState,
  sampleAt,
  sheetAt,
  sheetPatch,
  stateAt,
  unpackSegs,
  type DecodedSegment,
  type TraceRow as ViewerRow,
} from "../viewer/trace";
import { readPositionTrace, readTraceIndex, readTraceSegment } from "../viewer/trace-db";
import { tempDirs } from "./fixtures/temp-dirs";
import { openTestSession, recordDrain, type TestSession } from "./fixtures/v1-session";

const tempDir = tempDirs();

/* --------------------------------------------------------- the contract --- */

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
/** A compile-time assertion: the file does not typecheck unless `T` is `true`. */
function pin<T extends true>(): T {
  return true as T;
}

describe("the two spellings of the contract", () => {
  test("the state keys are the same keys, and a state the writer folds is one the codec reads", () => {
    // Type level: identical key sets, and the writer's state assignable to the
    // codec's (the codec's auras also admit the public three-element form).
    // The record's `zone` and `area` are the codec's too: a keyframe carries
    // them once observed, so a 0.5 segment, which never had them, reads as it did.
    expect(pin<Equal<keyof WriterState, keyof ViewerState>>()).toBe(true);
    expect(pin<WriterState extends ViewerState ? true : false>()).toBe(true);
    expect(pin<Equal<WriterState["target"], ViewerState["target"]>>()).toBe(true);
    expect(pin<Equal<WriterState["cast"], ViewerState["cast"]>>()).toBe(true);
    // Runtime: the same keys, and the same empty state.
    expect<string[]>([...STATE_KEYS].sort()).toEqual(Object.keys(writerEmptyState()).sort());
    expect(viewerEmptyState()).toEqual(writerEmptyState());
  });

  test("a row the writer stores is a row the codec reads: the same columns, the same kinds, one window", () => {
    // v1 difference: a segment line may carry the dictionary (`dict`), which
    // the session source folds into the lookup it hands the codec and never
    // passes on as a column.
    expect(pin<Equal<Exclude<keyof WriterRow, "dict">, keyof ViewerRow>>()).toBe(true);
    expect(pin<"dict" extends keyof WriterRow ? true : false>()).toBe(true);
    // v1 difference: a `dict` row is a kind of its own, which the source drops
    // before the codec sees a row; every other kind is one the codec reads.
    expect(pin<Exclude<TraceKind, "dict"> extends ViewerRow["kind"] ? true : false>()).toBe(true);
    expect(pin<"dict" extends TraceKind ? true : false>()).toBe(true);
    expect(pin<Equal<Exclude<WriterRow["map"], undefined>, ViewerRow["map"]>>()).toBe(true);
    expect(pin<Equal<Exclude<WriterRow["x"], undefined>, ViewerRow["x"]>>()).toBe(true);
    expect(pin<Equal<Exclude<WriterRow["o"], undefined>, ViewerRow["o"]>>()).toBe(true);
    expect(pin<Equal<WriterRow["ts"], ViewerRow["ts"]>>()).toBe(true);
    // `data` is parsed on the writer's side and the column's text on the codec's.
    expect(pin<ViewerRow["data"] extends string | null ? true : false>()).toBe(true);
    // A segment of the record is a window of the codec.
    expect(SEGMENT_MS).toBe(SEG_MS);
  });

  test("the sheet is one contract in both spellings: the same keys, rows, key lengths and patch rule", () => {
    expect(pin<Equal<WriterSheet, ViewerSheet>>()).toBe(true);
    expect(pin<Equal<WriterQuestReq, ViewerQuestReq>>()).toBe(true);
    // A drain's item entry is the id and then exactly what a segment's `items` holds per id.
    expect(pin<NonNullable<WriterDict["items"]>[number] extends [number, ...TraceItemName] ? true : false>()).toBe(true);
    expect([...SHEET_KEYS]).toEqual([...WRITER_SHEET_KEYS]);
    expect(SHEET_KEY_LEN).toEqual(WRITER_SHEET_KEY_LEN);
    expect(viewerEmptySheet()).toEqual(writerEmptySheet());
    // The unit keys and the sheet's never overlap, so a key row's data splits cleanly.
    expect(STATE_KEYS.some((k) => (SHEET_KEYS as readonly string[]).includes(k))).toBe(false);
    // The two patch implementations agree, on a list that adds, changes and removes.
    const a = [[255, 23, 1, 2], [255, 24, 5], [19, 0, 7]];
    const b = [[19, 0, 7], [255, 23, 1, 3], [255, 30, 9]];
    const p = sheetPatch(a, b, 2);
    expect(p).toEqual(writerSheetPatch(a, b, 2)!);
    expect(applySheetPatch(a, p!, 2)).toEqual(writerApplyPatch(a, p!, 2)!);
    expect(applySheetPatch(a, p!, 2)).toEqual([[19, 0, 7], [255, 23, 1, 3], [255, 30, 9]]);
  });
});

/* ------------------------------------------------------- end to end --- */

/** A window boundary; the run straddles W1. */
const W0 = 1_760_000_100_000;
const W1 = W0 + SEG_MS;
const RUN = "trace-e2e-run";

/** A creature guid with high type 0xF130 and entry 299, as the recorder's own test builds one. */
const CREATURE_GUID = ((0xf130n << 48n) | (299n << 24n) | 41n).toString(10);

/** The host's side: the run's session record, written on the recorder's clock from each drain of it. */
function host(runs: string, rec: TraceRecorder, clock: () => number): { session: TestSession; ingest: () => void } {
  const session = openTestSession(join(runs, RUN), clock());
  return {
    session,
    ingest: () => {
      session.clock.now = clock();
      const d = rec.drain();
      session.writer.ingest(recordDrain({ trace: d.rows, ...(d.dict !== undefined ? { dict: d.dict } : {}) }));
    },
  };
}

/** The trace as the record holds it, the dictionary rows left out: what the viewer's rows are made of. */
function storedRows(session: TestSession): WriterRow[] {
  return session.reader.rows("trace").filter((r) => r.kind !== "dict");
}

describe("the trace end to end", () => {
  test("a walk across a window boundary, an aura, a hearth and a flight come back as recorded", async () => {
    const runs = tempDir("trace-e2e-");

    // The child: a real cache and stream, fed by hand, and the recorder over them.
    const events = new EventStream({ url: "ws://worldserver:8086/events", token: "t", reconnect: false });
    const cache = new StateCache({ seed: { guid: "7", name: "Fenwick" } });
    events.onAny((e) => cache.apply(e));
    let clock = W0 + 270_000;
    const rec = new TraceRecorder({ state: cache, events, now: () => clock, pollMs: 60_000 });
    let seq = 1;
    const feed = (opcode: string, opcodeId: number, data: unknown, ts: number): void => {
      clock = ts;
      events.ingest(JSON.stringify({ seq: seq++, opcode, opcodeId, ts, data }));
    };
    const selfFields = (fields: Record<string, unknown>, ts: number): void =>
      feed("SMSG_UPDATE_OBJECT", 0xa9, { blocks: 1, objects: [{ update: "values", guid: "7", fields }] }, ts);

    // The host: the stack's session writer, ingesting the child's drain on its tick.
    const { session, ingest } = host(runs, rec, () => clock);
    let lastDrain = clock;
    const tick = (): void => {
      rec.poll();
      // The record tick's cadence: a drain every 5 s of clock.
      if (clock - lastDrain >= 5_000) {
        ingest();
        lastDrain = clock;
      }
    };

    rec.start();
    feed("SMSG_LOGIN_VERIFY_WORLD", 0x236, { map: 0, x: -8949, y: -132, z: 83.5, o: 1.0 }, W0 + 271_000);
    selfFields({ health: 120, maxHealth: 120, powerType: 0, power1: 80, maxPower1: 100, level: 5, xp: 300, nextLevelXp: 1400, unitFlags: 0x8 }, W0 + 271_100);
    tick();

    // A walk east at about 7 yd/s, across the window boundary at W1.
    let x = -8949;
    for (let ts = W0 + 272_000; ts <= W1 + 20_000; ts += 1000) {
      x += 7;
      feed("WB_MOVE_PROGRESS", 0xff02, { moveId: 1, pos: { x, y: -132 + (ts - W0) / 10_000, z: 83.5, o: 1.0 } }, ts);
      // A buff lands just after the boundary, a fight takes some health.
      if (ts === W1 + 5_000) {
        feed("SMSG_AURA_UPDATE", 0x496, { targetGuid: "7", auras: [{ slot: 0, spellId: 1126, flags: 0x13, level: 5, stacks: 1, duration: 1_800_000, maxDuration: 1_800_000 }] }, ts + 10);
      }
      if (ts === W0 + 290_000) selfFields({ targetGuid: CREATURE_GUID, health: 95 }, ts + 20);
      if (ts === W0 + 295_000) selfFields({ targetGuid: "0", health: 101 }, ts + 20);
      tick();
    }
    const beforeHearth = { x, y: -132 + (W1 + 20_000 - W0) / 10_000 };

    // A hearth: the server's teleport ack about self, then a few steps.
    const HEARTH = W1 + 25_000;
    feed("MSG_MOVE_TELEPORT_ACK", 0xc7, { guid: "7", flags: 0, pos: { x: -4821, y: -1155, z: 502, o: 1.7 } }, HEARTH);
    tick();
    for (let i = 1; i <= 3; i++) {
      feed("WB_MOVE_PROGRESS", 0xff02, { moveId: 2, pos: { x: -4821 + i, y: -1155, z: 502, o: 1.7 } }, HEARTH + i * 1000);
      tick();
    }

    // A flight: the spline a tick ahead of the flag, the flag, a minute aloft, the landing.
    const TAKEOFF = W1 + 40_000;
    feed("SMSG_ACTIVATETAXIREPLY", 0x1ae, { reply: 0, ok: true }, TAKEOFF - 100);
    feed("SMSG_MONSTER_MOVE", 0xdd, { guid: "7", pos: { x: -4818, y: -1155, z: 502 }, destination: { x: -5418, y: -2955, z: 352 }, durationMs: 60_000 }, TAKEOFF - 50);
    selfFields({ unitFlags: 0x100008 }, TAKEOFF);
    tick();
    for (let ts = TAKEOFF + 5_000; ts < TAKEOFF + 60_000; ts += 5_000) {
      clock = ts;
      tick();
    }
    selfFields({ unitFlags: 0x8 }, TAKEOFF + 60_000);
    tick();
    clock = TAKEOFF + 70_000;
    ingest();
    rec.stop();
    // The session closes: every segment closed and compressed, and still read.
    session.clock.now = clock;
    await session.writer.close();
    expect(sessionSource(runs, RUN).kind).toBe("v1");
    expect(readdirSync(join(session.dir, "trace")).every((f) => f.endsWith(".jsonl.zst"))).toBe(true);

    const stored = storedRows(session);
    // The writer keyed the second window from its fold, as its first row arrived.
    expect(stored.some((r) => r.kind === "key" && r.ts === W1)).toBe(true);
    expect(stored.filter((r) => r.kind === "flight")).toHaveLength(1);
    expect(stored.some((r) => r.kind === "pos" && (r.data as { jump?: number } | null)?.jump === 1 && r.ts === HEARTH)).toBe(true);

    // `session/` is the trace's one home: every row the viewer reads back
    // below came from there, and the run directory holds nothing else.
    expect(readdirSync(join(runs, RUN))).toEqual(["session"]);
    expect(existsSync(join(runs, RUN, "run.sqlite"))).toBe(false);

    // The viewer, once both windows have settled.
    const now = W1 + SEG_MS + SETTLE_MS;
    const index = readTraceIndex(runs, RUN, now);
    expect(unpackSegs(index.segs)).toEqual([W0, W1]);
    expect(index.tail).toBeNull();
    const segs: DecodedSegment[] = [W0, W1].map((t0) => {
      const found = readTraceSegment(runs, RUN, t0, now)!;
      expect(found.closed).toBe(true);
      return decodeSegment(JSON.parse(JSON.stringify(found.segment)));
    });
    const frames = segs.flatMap((s) => s.frames);
    const segOf = (ts: number): DecodedSegment => segs.find((s) => ts >= s.t0 && ts < s.t1)!;

    // Every recorded position, where it was recorded.
    const samples = stored.filter((r) => r.kind === "pos" || r.kind === "flight");
    expect(samples.length).toBeGreaterThan(50);
    for (const r of samples) {
      const p = sampleAt(frames, r.ts)!;
      expect(`${r.ts - W0} map ${p.map}`).toBe(`${r.ts - W0} map ${r.map}`);
      expect(Math.abs(p.x - r.x!)).toBeLessThanOrEqual(0.05 + 1e-9);
      expect(Math.abs(p.y - r.y!)).toBeLessThanOrEqual(0.05 + 1e-9);
      expect(Math.abs(p.z - r.z!)).toBeLessThanOrEqual(0.05 + 1e-9);
      if (r.kind === "pos") expect(Math.abs(((p.o - r.o! + 3 * Math.PI) % (2 * Math.PI)) - Math.PI)).toBeLessThanOrEqual(Math.PI / Q_O + 1e-9);
    }
    // Between two walking samples the player is on the line; across the window
    // boundary too, with no stutter at the seam.
    for (const t of [W0 + 280_500, W1 - 500, W1, W1 + 500]) {
      const a = sampleAt(frames, t - 500)!;
      const b = sampleAt(frames, t + 500)!;
      const mid = sampleAt(frames, t)!;
      expect(mid.x).toBeCloseTo((a.x + b.x) / 2, 1);
    }
    // The hearth is held into, never drawn through.
    const held = sampleAt(frames, HEARTH - 1)!;
    expect(held.x).toBeCloseTo(beforeHearth.x, 1);
    expect(sampleAt(frames, HEARTH)!.x).toBeCloseTo(-4821, 1);
    // Halfway through the flight, halfway along it; then down at its end.
    const aloft = sampleAt(frames, TAKEOFF + 30_000)!;
    expect(aloft.flying).toBe(true);
    expect(aloft.x).toBeCloseTo((-4818 + -5418) / 2, 0);
    expect(aloft.y).toBeCloseTo((-1155 + -2955) / 2, 0);
    expect(sampleAt(frames, TAKEOFF + 60_000)).toMatchObject({ flying: false });
    expect(sampleAt(frames, TAKEOFF + 60_000)!.x).toBeCloseTo(-5418, 1);
    expect(GAP_MS).toBeLessThan(60_000);

    // Every recorded state, at its moment: fold the stored rows as the writer
    // does and ask the codec at each row's time.
    // The unit keys only: the sheet rides the same rows and `sheetAt` reads it.
    const unit = (d: object): Partial<WriterState> => Object.fromEntries(Object.entries(d).filter(([k]) => (STATE_KEYS as readonly string[]).includes(k)));
    // The codec's keys (the record's unit state, `zone` and `area` included).
    const codecEmpty = (): Partial<WriterState> => unit(writerEmptyState());
    let fold = codecEmpty();
    for (const r of stored) {
      if (r.kind === "key") fold = { ...codecEmpty(), ...unit(r.data as object) };
      else if (r.kind === "state") fold = { ...fold, ...unit(r.data as object) };
      else continue;
      expect<object>(stateAt(segOf(r.ts), r.ts)).toEqual(fold);
    }
    // Spot checks against what was fed, not only against the fold.
    expect(stateAt(segOf(W1 + 6_000), W1 + 6_000).auras).toEqual([[1126, 1, W1 + 5_010 + 1_800_000, 0x13]]);
    expect(stateAt(segOf(W0 + 291_000), W0 + 291_000)).toMatchObject({ hp: 95, target: { kind: "creature", entry: 299 } });
    expect(stateAt(segOf(W0 + 296_000), W0 + 296_000)).toMatchObject({ hp: 101, target: null });
    expect(stateAt(segOf(TAKEOFF + 30_000), TAKEOFF + 30_000).taxi).toBe(true);
    expect(stateAt(segOf(TAKEOFF + 65_000), TAKEOFF + 65_000).taxi).toBe(false);
    // The second window's keyframe is the writer's key: the state at W1, whole.
    expect(segs[1]!.key).toMatchObject({ hp: 101, level: 5, pwType: 0, combat: false });

    expect(validateSession(session.dir).errors).toEqual([]);
  });

  test("a player target is its kind and nothing else, in the record and in the codec", async () => {
    const runs = tempDir("trace-e2e-player-");
    const events = new EventStream({ url: "ws://worldserver:8086/events", token: "t", reconnect: false });
    const cache = new StateCache({ seed: { guid: "7", name: "Fenwick" } });
    events.onAny((e) => cache.apply(e));
    let clock = W0 + 10_000;
    const rec = new TraceRecorder({ state: cache, events, now: () => clock, pollMs: 60_000 });
    let seq = 1;
    const feed = (opcode: string, data: unknown, ts: number): void => {
      clock = ts;
      events.ingest(JSON.stringify({ seq: seq++, opcode, opcodeId: 1, ts, data }));
    };
    const { session, ingest } = host(runs, rec, () => clock);
    rec.start();
    feed("SMSG_LOGIN_VERIFY_WORLD", { map: 0, x: -8949, y: -132, z: 83.5, o: 1 }, W0 + 11_000);
    feed("SMSG_UPDATE_OBJECT", { blocks: 1, objects: [{ update: "values", guid: "7", fields: { health: 120, maxHealth: 120, level: 5 } }] }, W0 + 11_100);
    // Another player (high type 0, a bare counter) is targeted, with health showing.
    feed("SMSG_UPDATE_OBJECT", { blocks: 1, objects: [{ update: "create", guid: "4242", objectType: "player", fields: { health: 50, maxHealth: 100, level: 9 } }] }, W0 + 12_000);
    feed("SMSG_UPDATE_OBJECT", { blocks: 1, objects: [{ update: "values", guid: "7", fields: { targetGuid: "4242" } }] }, W0 + 13_000);
    clock = W0 + 14_000;
    rec.poll();
    ingest();
    // Then a creature, which keeps its entry.
    feed("SMSG_UPDATE_OBJECT", { blocks: 1, objects: [{ update: "values", guid: "7", fields: { targetGuid: CREATURE_GUID } }] }, W0 + 20_000);
    clock = W0 + 21_000;
    rec.poll();
    ingest();
    rec.stop();
    await session.writer.close();

    const targets = storedRows(session)
      .map((r) => (r.data as { target?: unknown } | null | undefined)?.target)
      .filter((t) => t !== undefined && t !== null);
    expect(targets).toContainEqual({ kind: "player" });
    expect(targets.filter((t) => (t as { kind: string }).kind === "player").every((t) => JSON.stringify(t) === '{"kind":"player"}')).toBe(true);
    const seg = decodeSegment(JSON.parse(JSON.stringify(readTraceSegment(runs, RUN, W0, W1 + SEG_MS)!.segment)));
    expect(stateAt(seg, W0 + 15_000).target).toEqual({ kind: "player" });
    expect(stateAt(seg, W0 + 22_000).target).toMatchObject({ kind: "creature", entry: 299 });
    expect(JSON.stringify(seg)).not.toContain("4242");
    expect(validateSession(session.dir).errors).toEqual([]);
  });

  test("the character sheet: recorder, writer, session record, the viewer's reads, the codec and the public projection give back the cache's own sheet at every moment", async () => {
    const runs = tempDir("trace-e2e-sheet-");
    const events = new EventStream({ url: "ws://worldserver:8086/events", token: "t", reconnect: false });
    const cache = new StateCache({ seed: { guid: "7", name: "Fenwick" } });
    events.onAny((e) => cache.apply(e));
    let clock = W0 + 270_000;
    const rec = new TraceRecorder({ state: cache, events, now: () => clock, pollMs: 60_000 });
    let seq = 1;
    const feed = (opcode: string, data: unknown, ts: number): void => {
      clock = ts;
      events.ingest(JSON.stringify({ seq: seq++, opcode, opcodeId: 1, ts, data }));
    };
    const update = (objects: unknown[], ts: number): void => feed("SMSG_UPDATE_OBJECT", { blocks: objects.length, objects }, ts);
    const HI = 0x4000_0000;
    const guid = (lo: number): string => ((BigInt(HI) << 32n) | BigInt(lo)).toString(10);
    const item = (lo: number, fields: Record<string, number>) => ({ update: "create", guid: guid(lo), objectType: "item", fields });
    const named = (itemId: number, name: string, ts: number): void => feed("SMSG_ITEM_QUERY_SINGLE_RESPONSE", { itemId, found: true, name, quality: 1 }, ts);

    const { session, ingest } = host(runs, rec, () => clock);
    let lastDrain = clock;
    let x = -8949;
    /** One second of play: a step, a poll per 250 ms, a drain every 5 s. */
    const second = (): void => {
      const end = clock + 1_000;
      x += 3;
      feed("WB_MOVE_PROGRESS", { moveId: 1, pos: { x, y: -132, z: 83.5, o: 1 } }, clock + 1);
      for (let t = clock; t < end; t += 250) {
        clock = t;
        rec.poll();
      }
      clock = end;
      if (clock - lastDrain >= 5_000) {
        ingest();
        lastDrain = clock;
      }
    };
    /** What the cache itself says the sheet is, through the SDK's own joins: the truth to compare with. */
    const truth = (): Record<string, unknown> => ({
      money: cache.money?.value ?? 0,
      // In key order (bag, then slot), as the trace keeps every list; the SDK lists the backpack first.
      inv: cache.bag().items.map((b) => [b.bag, b.slot, b.itemId, b.count ?? 1]).sort((a, b) => a[0]! - b[0]! || a[1]! - b[1]!),
      equip: cache.inventory.filter((i) => i.slot <= 18).map((i) => [i.slot, i.itemId]),
      quests: cache.questLog.map((q) => [q.slot, q.questId, q.state, ...q.counts]),
    });
    const truths: { t: number; at: ReturnType<typeof truth> }[] = [];
    const mark = (): void => {
      truths.push({ t: clock, at: truth() });
    };

    rec.start();
    feed("SMSG_LOGIN_VERIFY_WORLD", { map: 0, x, y: -132, z: 83.5, o: 1 }, W0 + 271_000);
    update(
      [
        { update: "create", guid: "7", objectType: "player", self: true, fields: { level: 9, health: 300, maxHealth: 300, money: 900, invSlot0Lo: 1, invSlot0Hi: HI, invSlot19Lo: 2, invSlot19Hi: HI, invSlot23Lo: 3, invSlot23Hi: HI, quest0Id: 4100, quest0State: 0, quest0CountsLo: 1 } },
        item(1, { entry: 51001, stackCount: 1, durability: 30, maxDurability: 30 }),
        { update: "create", guid: guid(2), objectType: "container", fields: { entry: 51002, numSlots: 4, bagSlot1Lo: 4, bagSlot1Hi: HI } },
        item(3, { entry: 51003, stackCount: 7 }),
        item(4, { entry: 51004, stackCount: 1 }),
      ],
      W0 + 271_100,
    );
    for (const [id, name] of [[51001, "Test Blade"], [51002, "Test Pouch"], [51003, "Test Stone"], [51004, "Test Ring"]] as const) named(id, name, W0 + 271_200);
    mark();
    // Loot, a stack growing, money just before the boundary, a turn-in after it, a sale.
    const script: [number, () => void][] = [
      [W0 + 285_000, () => {
        update([item(5, { entry: 51005, stackCount: 2 })], clock);
        update([{ update: "values", guid: "7", fields: { invSlot24Lo: 5, invSlot24Hi: HI, quest0CountsLo: 2 } }], clock);
        named(51005, "Test Token", clock);
      }],
      [W0 + 299_700, () => update([{ update: "values", guid: "7", fields: { money: 950 } }], clock)],
      [W1 + 5_000, () => update([{ update: "values", guid: guid(3), fields: { stackCount: 9 } }], clock)],
      [W1 + 10_000, () => {
        feed("SMSG_QUESTGIVER_QUEST_COMPLETE", { questId: 4100, xp: 200, money: 40 }, clock);
        update([{ update: "values", guid: "7", fields: { quest0Id: 0, money: 990, invSlot24Lo: 0, invSlot24Hi: 0 } }], clock);
      }],
      [W1 + 15_000, () => update([{ update: "values", guid: guid(1), fields: { durability: 12 } }], clock)],
      [W1 + 20_000, () => update([{ update: "values", guid: guid(2), fields: { bagSlot1Lo: 0, bagSlot1Hi: 0 } }], clock)],
    ];
    for (const [at, change] of script) {
      while (clock + 1_000 <= at) second();
      clock = at;
      change();
      mark();
    }
    while (clock < W1 + 30_000) second();
    ingest();
    rec.stop();
    expect(sessionSource(runs, RUN).kind).toBe("v1");

    // The names travel with the record: every segment names each id its rows
    // reference, once, and the item template's name is all a name is.
    const bySegment = session.reader.segments("trace").map((seg) => {
      const ids: number[] = [];
      for (const r of session.reader.segment("trace", seg)) for (const e of r.dict?.items ?? []) ids.push(e[0]);
      return ids;
    });
    expect(bySegment).toHaveLength(2);
    for (const ids of bySegment) expect(ids.length).toBe(new Set(ids).size);
    expect([...new Set(bySegment.flat())].sort()).toEqual([51001, 51002, 51003, 51004, 51005]);
    const names = new Map(session.reader.rows("trace").flatMap((r) => (r.dict?.items ?? []).map((e) => [e[0], e[2]] as const)));
    expect(names.get(51005)).toBe("Test Token");

    // The viewer, once both windows have settled; then the public projection of the same.
    const now = W1 + SEG_MS + SETTLE_MS;
    const read = (t0: number): DecodedSegment => decodeSegment(JSON.parse(JSON.stringify(readTraceSegment(runs, RUN, t0, now)!.segment)));
    const segs = [read(W0), read(W1)];
    const pub = [W0, W1].map((t0) => decodeSegment(JSON.parse(JSON.stringify(projectTraceSegment(readTraceSegment(runs, RUN, t0, now)!.segment)))));
    const segOf = (list: DecodedSegment[], t: number): DecodedSegment => list.find((s) => t >= s.t0 && t < s.t1)!;

    // At every change, a second after it (the sheet is read at most once a
    // second and stamped with when the cache saw it), and just before the next:
    // the sheet the segment folds to is the cache's own, privately and publicly.
    const shape = (s: ReturnType<typeof sheetAt>): unknown => ({
      money: s.money,
      inv: (s.inv ?? []).map((r) => [r[0], r[1], r[2], r[3] ?? 1]),
      equip: (s.equip ?? []).map((r) => [r[0], r[1]]),
      quests: (s.quests ?? []).map((r) => [r[0], r[1], r[2], r[3] ?? 0, r[4] ?? 0, r[5] ?? 0, r[6] ?? 0]),
    });
    for (let i = 0; i < truths.length; i++) {
      const { t, at } = truths[i]!;
      const next = truths[i + 1]?.t ?? W1 + 30_000;
      for (const probe of [t + 1_000, next - 1]) {
        if (probe < W0 + 272_000) continue;
        expect({ probe: probe - W0, sheet: shape(sheetAt(segOf(segs, probe), probe)) }).toEqual({ probe: probe - W0, sheet: at });
        expect(sheetAt(segOf(pub, probe), probe)).toEqual(sheetAt(segOf(segs, probe), probe));
      }
    }
    // The money observed 300 ms before the boundary was latched after the
    // writer keyed W1: it stands from W1 on, never taken back by that key.
    expect(sheetAt(segs[1]!, W1).money).toBe(950);
    // The turn-in, as an event, once; durability as it fell.
    expect(sheetAt(segs[1]!, W1 + 12_000).qdone).toEqual([4100]);
    expect(sheetAt(segs[1]!, W1 + 16_000).dur).toEqual([[0, 12, 30]]);
    // Each segment names what it references, privately and publicly the same.
    expect([...segs[0]!.items.keys()]).toEqual([51001, 51002, 51003, 51004, 51005]);
    expect(pub[0]!.items).toEqual(segs[0]!.items);
    expect(segs[1]!.items.get(51004)).toEqual([1, "Test Ring"]);

    // The live tail carries the same sheet in its keyframe.
    const live = readPositionTrace(runs, RUN, W1 + 25_000)!;
    const tail = decodeSegment(JSON.parse(JSON.stringify(live.tail)));
    expect(shape(sheetAt(tail, W1 + 21_500))).toEqual(truths.at(-1)!.at);
    expect(readTraceIndex(runs, RUN, W1 + 25_000).tail!.items).toBeDefined();

    // Still read the same once the session has closed and its segments are compressed.
    session.clock.now = clock;
    await session.writer.close();
    expect(JSON.stringify(read(W0))).toBe(JSON.stringify(segs[0]));
    expect(validateSession(session.dir).errors).toEqual([]);
  });
});

describe("zone and area in the codec", () => {
  const row = (ts: number, kind: ViewerRow["kind"], data: object | null, pos = false): ViewerRow => ({
    ts,
    kind,
    map: pos ? 0 : null,
    x: pos ? -8949 : null,
    y: pos ? -132 : null,
    z: pos ? 83.5 : null,
    o: pos ? 1 : null,
    data: data === null ? null : JSON.stringify(data),
  });

  test("a v1 key row's zone and area reach the keyframe, and a change of either is an event", () => {
    const key = { ...writerEmptyState(), ...writerEmptySheet(), level: 5, zone: 12, area: 87 };
    const seg = decodeSegment(JSON.parse(JSON.stringify(encodeSegment([row(W0 + 1_000, "key", key, true), row(W0 + 2_000, "state", { area: 88 }), row(W0 + 3_000, "state", { zone: 40, area: 120 })], { run: RUN, t0: W0, t1: W0 + SEG_MS }))));
    expect(stateAt(seg, W0 + 1_500)).toMatchObject({ zone: 12, area: 87 });
    expect(stateAt(seg, W0 + 2_500)).toMatchObject({ zone: 12, area: 88 });
    expect(stateAt(seg, W0 + 3_500)).toMatchObject({ zone: 40, area: 120 });
  });

  test("a trace that never had them (0.5) keeps keyframes without them, and reads them as unobserved", () => {
    const { zone: _z, area: _a, ...older } = writerEmptyState();
    const encoded = encodeSegment([row(W0 + 1_000, "key", { ...older, level: 5 }, true)], { run: RUN, t0: W0, t1: W0 + SEG_MS });
    expect(Object.keys(encoded.k.s)).not.toContain("zone");
    expect(Object.keys(encoded.k.s)).not.toContain("area");
    expect(stateAt(decodeSegment(JSON.parse(JSON.stringify(encoded))), W0 + 1_500)).toMatchObject({ zone: null, area: null });
  });
});
