/**
 * What the viewer keeps between requests, and when it lets go.
 *
 * - Entry indexes (`TrajectoryTail`) are dropped once nobody has asked for a
 *   run in `TAIL_IDLE_MS`, except while an SSE stream is reading one.
 * - A settled run's track is read from the store once and revalidated by
 *   ETag after that; a live run's is read fresh every time and never cached.
 */

import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { TAIL_IDLE_MS, TRACK_SETTLE_MS, createApi } from "../viewer/api";
import { type RunStore, localRunStore } from "../viewer/clickhouse";
import { tempDirs } from "./fixtures/temp-dirs";

const tempDir = tempDirs();

function writeRun(runs: string, id: string, opts: { terminated?: boolean; ageMs?: number } = {}): void {
  const dir = join(runs, id);
  mkdirSync(dir, { recursive: true });
  const config = { runId: id, character: "Memo", model: "m" };
  writeFileSync(join(dir, "meta.json"), JSON.stringify({ runId: id, startedAt: 1000, config }));
  const lines: object[] = [
    { ts: 1000, t: "meta", runId: id },
    { ts: 1100, t: "request", turn: 1, promptChars: 400 },
    { ts: 1200, t: "response", turn: 1, message: { role: "assistant", content: "hi" } },
    ...(opts.terminated === true ? [{ ts: 1300, t: "termination", reason: "episode-complete" }] : []),
  ];
  writeFileSync(join(dir, "trajectory.jsonl"), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  const db = new Database(join(dir, "run.sqlite"));
  db.run(
    `CREATE TABLE run (run_id TEXT, model TEXT, driver TEXT, shakeout TEXT, harness_version TEXT, started_at INTEGER,
       ended_at INTEGER, termination_reason TEXT, termination_detail TEXT, pause_reason TEXT, config_json TEXT)`,
  );
  db.run(`INSERT INTO run VALUES (?,?,?,?,?,?,?,?,?,?,?)`, [
    id, "m", "openai", null, "harness-test", 1000, opts.terminated === true ? 1300 : null,
    opts.terminated === true ? "episode-complete" : null, null, null, JSON.stringify(config),
  ]);
  db.run(
    `CREATE TABLE state (run_id TEXT, ts INTEGER, level INTEGER, xp INTEGER, map INTEGER, x REAL, y REAL, z REAL,
       event_count INTEGER, last_seq INTEGER, money INTEGER, quests_completed INTEGER, items TEXT)`,
  );
  for (let i = 0; i < 3; i++) {
    db.run(`INSERT INTO state VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`, [
      id, 1100 + i * 50, 2, 10 * i, 0, -6240 + i, 380, 385, 1, 1, 5, 0,
      JSON.stringify([{ name: "Hearthstone", count: 1, equipped: false }]),
    ]);
  }
  db.close();
  if (opts.ageMs !== undefined) {
    const t = (Date.now() - opts.ageMs) / 1000;
    for (const f of ["trajectory.jsonl", "run.sqlite", "meta.json"]) utimesSync(join(dir, f), t, t);
  }
}

function handleOf(runs: string, store?: RunStore): ReturnType<typeof createApi> {
  return createApi({ runsDir: runs, tilesDir: join(runs, "..", "minimap"), moduleUrl: "http://127.0.0.1:1", ...(store === undefined ? {} : { store }) });
}

/** Run `fn` with `Date.now` under the test's hand, restored whatever happens. */
async function withClock(fn: (advance: (ms: number) => void) => Promise<void>): Promise<void> {
  const realNow = Date.now;
  let clock = realNow();
  Date.now = () => clock;
  try {
    await fn((ms) => {
      clock += ms;
    });
  } finally {
    Date.now = realNow;
  }
}

describe("entry index eviction", () => {
  test("a run nobody has asked for in the idle window is dropped; the one asked for stays", async () => {
    const runs = tempDir("viewer-evict-");
    writeRun(runs, "run-a");
    writeRun(runs, "run-b");
    const handle = handleOf(runs);
    await withClock(async (advance) => {
      await handle(new Request("http://x/api/run/run-a/entries"));
      await handle(new Request("http://x/api/run/run-b/entries"));
      expect(handle.cachedRuns().entries).toBe(2);
      advance(TAIL_IDLE_MS - 1);
      await handle(new Request("http://x/api/run/run-b/entries"));
      expect(handle.cachedRuns().entries).toBe(2);
      advance(2);
      // run-a is past the window, run-b was asked for a moment ago.
      await handle(new Request("http://x/api/info"));
      expect(handle.cachedRuns().entries).toBe(1);
      // An evicted run is read again on its next visit, whole.
      const page = (await (await handle(new Request("http://x/api/run/run-a/entries"))).json()) as { total: number };
      expect(page.total).toBe(3);
    });
  });

  test("a tail an open stream is reading is never dropped, and is released when the stream closes", async () => {
    const runs = tempDir("viewer-evict-pin-");
    writeRun(runs, "run-a");
    writeRun(runs, "run-b");
    const handle = handleOf(runs);
    await withClock(async (advance) => {
      const res = await handle(new Request("http://x/api/run/run-a/stream"));
      const reader = res.body!.getReader();
      await reader.read();
      advance(TAIL_IDLE_MS * 3);
      await handle(new Request("http://x/api/run/run-b/entries"));
      expect(handle.cachedRuns().entries).toBe(2);
      await reader.cancel();
      // Closing restarts its idle clock rather than dropping it on the spot.
      await handle(new Request("http://x/api/info"));
      expect(handle.cachedRuns().entries).toBe(2);
      advance(TAIL_IDLE_MS);
      await handle(new Request("http://x/api/run/run-b/entries"));
      expect(handle.cachedRuns().entries).toBe(1);
    });
  });

  test("release drops a run at once", async () => {
    const runs = tempDir("viewer-evict-release-");
    writeRun(runs, "run-a");
    const handle = handleOf(runs);
    await handle(new Request("http://x/api/run/run-a/entries"));
    expect(handle.cachedRuns().entries).toBe(1);
    handle.release("run-a");
    expect(handle.cachedRuns().entries).toBe(0);
  });
});

describe("the track of a settled run", () => {
  function countingStore(runs: string): { store: RunStore; reads: { items: number } } {
    const inner = localRunStore(runs);
    const reads = { items: 0 };
    return {
      reads,
      store: {
        ...inner,
        stateItemRows: (id) => {
          reads.items += 1;
          return inner.stateItemRows(id);
        },
      },
    };
  }

  test("is read from the store once, and answers a matching If-None-Match with a 304", async () => {
    const runs = tempDir("viewer-track-settled-");
    writeRun(runs, "done", { terminated: true, ageMs: TRACK_SETTLE_MS + 60_000 });
    const { store, reads } = countingStore(runs);
    const handle = handleOf(runs, store);
    const first = await handle(new Request("http://x/api/run/done/track"));
    expect(first.status).toBe(200);
    const etag = first.headers.get("etag");
    expect(etag).toMatch(/^W\/"/);
    expect(first.headers.get("cache-control")).toBe("no-cache");
    const body = (await first.json()) as { points: unknown[]; inv?: unknown };
    expect(body.points.length).toBe(3);

    const again = await handle(new Request("http://x/api/run/done/track"));
    expect(again.headers.get("etag")).toBe(etag);
    expect(await again.json()).toEqual(body);
    expect(reads.items).toBe(1);

    const revalidated = await handle(new Request("http://x/api/run/done/track", { headers: { "if-none-match": etag! } }));
    expect(revalidated.status).toBe(304);
    expect(revalidated.headers.get("etag")).toBe(etag);
    expect(revalidated.headers.get("vary")).toContain("Accept-Encoding");
    expect(await revalidated.text()).toBe("");
    // A stale tag is a full answer, never a 304.
    const stale = await handle(new Request("http://x/api/run/done/track", { headers: { "if-none-match": 'W/"nope"' } }));
    expect(stale.status).toBe(200);
  });

  test("a live run's track, or one that ended a moment ago, is read fresh and never cached", async () => {
    const runs = tempDir("viewer-track-live-");
    writeRun(runs, "live");
    writeRun(runs, "just-ended", { terminated: true });
    const { store, reads } = countingStore(runs);
    const handle = handleOf(runs, store);
    for (const id of ["live", "just-ended"]) {
      for (let i = 0; i < 2; i++) {
        const res = await handle(new Request(`http://x/api/run/${id}/track`));
        expect(res.status).toBe(200);
        expect(res.headers.get("etag")).toBeNull();
        expect(res.headers.get("cache-control")).toBe("no-store");
      }
    }
    expect(reads.items).toBe(4);
  });
});
