/**
 * The camera director's event-to-frame logic (infra/camera/shutter.ts) against
 * recorded session event rows: which rows are camera events, and which frames
 * a 1 fps capture keeps as interval and as event frames.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { StoredSessionHandle } from "@wrathbench/inspector";
import { BOSS_ENTRIES } from "../runner/src/dungeons";
import { cameraEventOf, Shutter, type Kept, type SessionEventRow, type TimedEvent } from "./camera/shutter";

const BOSSES = BOSS_ENTRIES;
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
});
