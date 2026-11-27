/**
 * The camera director's event-to-frame logic (infra/camera/shutter.ts) against
 * recorded session event rows: which rows are camera events, and which frames
 * a 1 fps capture keeps as interval and as event frames.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { StoredSessionHandle } from "@wrathbench/inspector";
import { DEADMINES_BOSSES } from "../viewer/dungeons";
import { cameraEventOf, Shutter, type Kept, type SessionEventRow, type TimedEvent } from "./camera/shutter";

const BOSSES = new Set(DEADMINES_BOSSES);
const SOLO = join(import.meta.dir, "..", "runner", "test", "fixtures", "v1p1", "v1p1-solo", "session");
const DUNGEON = join(import.meta.dir, "fixtures", "camera", "events-dungeon.jsonl");

async function soloRows(): Promise<SessionEventRow[]> {
  const h = new StoredSessionHandle("v1p1-solo", SOLO);
  const batch = await h.tail("events", null);
  return batch.rows as unknown as SessionEventRow[];
}

function dungeonRows(): SessionEventRow[] {
  return readFileSync(DUNGEON, "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as SessionEventRow);
}

const eventsOf = (rows: SessionEventRow[]): TimedEvent[] => rows.map((r) => cameraEventOf(r, BOSSES)).filter((e): e is TimedEvent => e !== null);

describe("session rows to camera events", () => {
  test("a recorded solo session: gains only, never a baseline", async () => {
    const events = eventsOf(await soloRows());
    // Its three turn-ins and its zone crossed are no events: only what the timeline marks is (`timeline-marks.ts`).
    expect(events.map((e) => [e.ts, e.type, e.detail])).toEqual([
      [1762000530250, "level", "reached level 6"],
      [1762001100250, "level", "reached level 7"],
    ]);
  });

  test("a dungeon: a boss by entry or by rank, never a plain elite; a death; no level without a gain", () => {
    const events = eventsOf(dungeonRows());
    expect(events.map((e) => [e.type, e.detail])).toEqual([
      ["boss", "killed boss 644"],
      ["death", "died"],
      ["boss", "killed boss 99999"],
    ]);
  });

  test("details are ours: numbers and fixed words, no game text", () => {
    const row: SessionEventRow = { ts: 1, kind: "achievement", id: 9502 };
    expect(cameraEventOf(row, BOSSES)).toBeNull();
    for (const e of eventsOf(dungeonRows())) expect(e.detail).toMatch(/^[a-z ]+\d*$/);
  });
});

/** A 1 fps capture over [from, to), each frame through the shutter as the director drives it. */
function capture(s: Shutter, from: number, to: number, events: TimedEvent[], lagMs: number): Kept[] {
  const kept: Kept[] = [];
  const pending = [...events].sort((a, b) => a.ts - b.ts);
  for (let t = from; t < to; t += 1000) {
    // An event reaches the director `lagMs` after it happened (the session writer's drain).
    while (pending.length > 0 && pending[0]!.ts + lagMs <= t) s.event(pending.shift()!);
    s.add({ ts: t, bytes: new Uint8Array([t % 256]) });
    kept.push(...s.due(t));
  }
  for (const e of pending) s.event(e);
  kept.push(...s.flush());
  return kept;
}

describe("the shutter", () => {
  test("interval frames every 10 s; a level-up keeps 30 s before and 10 s after, though reported 5 s late", async () => {
    const level = eventsOf(await soloRows()).find((e) => e.type === "level")!;
    const from = level.ts - 120_000;
    const s = new Shutter({ intervalMs: 10_000 });
    const kept = capture(s, from, level.ts + 120_000, [level], 5_000);
    const ev = kept.filter((k) => k.kind === "event");
    expect(ev.length).toBe(41);
    expect(ev[0]!.frame.ts).toBe(level.ts - 30_000);
    expect(ev.at(-1)!.frame.ts).toBe(level.ts + 10_000);
    expect(ev.every((k) => k.event?.type === "level" && k.event.detail === "reached level 6")).toBe(true);
    const iv = kept.filter((k) => k.kind === "interval");
    for (let i = 1; i < iv.length; i++) expect(iv[i]!.frame.ts - iv[i - 1]!.frame.ts).toBeGreaterThanOrEqual(10_000);
    // Kept in time order, so seq follows the clock.
    const ts = kept.map((k) => k.frame.ts);
    expect(ts).toEqual([...ts].sort((a, b) => a - b));
  });

  test("two events close together: each frame goes to the nearer one", () => {
    const t0 = 1_762_000_000_000;
    const a: TimedEvent = { ts: t0 + 60_000, type: "boss", detail: "killed boss 644" };
    const b: TimedEvent = { ts: t0 + 75_000, type: "level", detail: "reached level 19" };
    const kept = capture(new Shutter({ intervalMs: 10_000 }), t0, t0 + 150_000, [a, b], 2_000);
    const at = (t: number) => kept.find((k) => k.frame.ts === t)?.event?.type;
    expect(at(t0 + 60_000)).toBe("boss");
    expect(at(t0 + 67_000)).toBe("boss");
    expect(at(t0 + 68_000)).toBe("level");
    expect(at(t0 + 85_000)).toBe("level");
    expect(kept.find((k) => k.frame.ts === t0 + 86_000)).toBeUndefined();
  });

  test("a level-up and the death in the same moment are one burst, the level-up's", () => {
    const t0 = 1_762_000_000_000;
    const death: TimedEvent = { ts: t0 + 60_000, type: "death", detail: "died" };
    const level: TimedEvent = { ts: t0 + 60_000, type: "level", detail: "reached level 3" };
    const kept = capture(new Shutter({ intervalMs: 10_000 }), t0, t0 + 150_000, [death, level], 2_000);
    const burst = kept.filter((k) => k.kind === "event");
    expect(burst.length).toBe(41);
    expect(new Set(burst.map((k) => k.event?.detail))).toEqual(new Set(["reached level 3"]));
  });

  test("start marks the first frame and end the last; neither keeps a window", () => {
    const t0 = 1_762_000_000_000;
    const s = new Shutter({ intervalMs: 10_000 });
    s.event({ ts: t0, type: "start", detail: "camera attached" });
    const kept: Kept[] = [];
    for (let t = t0; t < t0 + 25_000; t += 1000) {
      s.add({ ts: t, bytes: new Uint8Array(1) });
      kept.push(...s.due(t));
    }
    s.event({ ts: t0 + 25_000, type: "end", detail: "run ended" });
    kept.push(...s.flush());
    expect(kept[0]!.event).toEqual({ type: "start", detail: "camera attached" });
    expect(kept.at(-1)!.event).toEqual({ type: "end", detail: "run ended" });
    expect(kept.at(-1)!.frame.ts).toBe(t0 + 24_000);
    expect(kept.map((k) => k.kind)).toEqual(["event", "interval", "interval", "event"]);
  });

  test("the ring holds about 45 s of frames, so memory stays bounded", () => {
    const s = new Shutter({ intervalMs: 10_000 });
    const t0 = 1_762_000_000_000;
    for (let t = t0; t < t0 + 600_000; t += 1000) {
      s.add({ ts: t, bytes: new Uint8Array(1) });
      s.due(t);
    }
    expect(s.pending).toBeLessThanOrEqual(46);
  });
});
