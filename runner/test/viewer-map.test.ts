import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readLatestPosition, readPositions } from "../viewer/positions";
import { parseTilePath, resolveTilePath } from "../viewer/tiles";
import {
  GRID,
  TILE_PX,
  coordToTile,
  pixelToWorld,
  tileToCoord,
  tileToWorld,
  visibleTiles,
  worldToPixel,
  worldToTile,
} from "../viewer/worldmap";

/* ---------- coordinates ---------- */

describe("worldmap", () => {
  test("Anvilmar lands where the ADR says it does", () => {
    // map 0, x ≈ -6240, y ≈ 380 — the reference point in ADR-0019.
    const t = worldToTile(-6240, 380);
    expect(t.row).toBeCloseTo(43.7, 3);
    expect(t.col).toBeCloseTo(31.2875, 3);
  });

  test("the world origin is the centre of the grid", () => {
    const t = worldToTile(0, 0);
    expect(t.row).toBe(32);
    expect(t.col).toBe(32);
  });

  test("one tile of world is one tile of grid", () => {
    expect(coordToTile(533.33325)).toBeCloseTo(31, 9);
    expect(coordToTile(-533.33325)).toBeCloseTo(33, 9);
  });

  test("world → tile → world round-trips", () => {
    for (const [x, y] of [
      [-6240, 380],
      [0, 0],
      [1629.3, -4373.7],
      [16000, -16000],
    ] as [number, number][]) {
      const t = worldToTile(x, y);
      const back = tileToWorld(t.row, t.col);
      expect(back.x).toBeCloseTo(x, 4);
      expect(back.y).toBeCloseTo(y, 4);
    }
  });

  test("tile → coord is the inverse of coord → tile", () => {
    expect(tileToCoord(coordToTile(-6240))).toBeCloseTo(-6240, 4);
    expect(tileToCoord(43.7)).toBeCloseTo(-6240, 2);
  });

  test("pixels are tiles scaled, with X from world Y and Y from world X", () => {
    const p = worldToPixel(-6240, 380);
    expect(p.py).toBeCloseTo(43.7 * TILE_PX, 2);
    expect(p.px).toBeCloseTo(31.2875 * TILE_PX, 2);
    const back = pixelToWorld(p.px, p.py);
    expect(back.x).toBeCloseTo(-6240, 4);
    expect(back.y).toBeCloseTo(380, 4);
  });

  test("visible tiles are clamped to the grid", () => {
    const v = visibleTiles(-5000, -5000, 5 * TILE_PX, 3 * TILE_PX);
    expect(v).toEqual({ row0: 0, col0: 0, row1: 3, col1: 5 });
    const far = visibleTiles(1e9, 1e9, 2e9, 2e9);
    expect(far.row0).toBe(GRID - 1);
    expect(far.col1).toBe(GRID - 1);
  });
});

/*
 * The replay seam (ADR-0019): the transform must be usable with nothing else
 * loaded — no runs directory, no sqlite, no viewer. A future trajectory reader
 * imports exactly this and nothing more.
 */
describe("worldmap standalone", () => {
  test("imports on its own and answers without any other module", async () => {
    const mod = (await import("../viewer/worldmap")) as Record<string, unknown>;
    expect(typeof mod["worldToTile"]).toBe("function");
    const fn = mod["worldToTile"] as (x: number, y: number) => { row: number; col: number };
    expect(fn(-6240, 380).row).toBeCloseTo(43.7, 3);
  });

  test("has no imports at all", async () => {
    const src = await Bun.file(new URL("../viewer/worldmap.ts", import.meta.url).pathname).text();
    expect(src).not.toMatch(/^\s*import\s/m);
    expect(src).not.toMatch(/\brequire\s*\(/);
  });
});

/* ---------- tile paths ---------- */

describe("tile paths", () => {
  test("a well-formed path parses", () => {
    expect(parseTilePath("/tiles/0/43_31.png")).toEqual({ map: 0, row: 43, col: 31 });
    expect(parseTilePath("/tiles/571/0_0.png")).toEqual({ map: 571, row: 0, col: 0 });
  });

  test("traversal is rejected, decoded or not", () => {
    for (const p of [
      "/tiles/../../etc/passwd",
      "/tiles/0/../../../etc/passwd",
      "/tiles/0/..%2f..%2fpasswd.png",
      "/tiles/0/../43_31.png",
      "/tiles/./0/43_31.png",
    ])
      expect(parseTilePath(p)).toBeNull();
  });

  test("non-integer segments are rejected", () => {
    for (const p of [
      "/tiles/a/43_31.png",
      "/tiles/0/4.3_31.png",
      "/tiles/0/-1_31.png",
      "/tiles/0/43-31.png",
      "/tiles/0/43_31.PNG",
      "/tiles/0/43_31.png/x",
      "/tiles/-1/43_31.png",
      "/tiles/0/43_31.jpg",
      "/tiles/0/43_31",
    ])
      expect(parseTilePath(p)).toBeNull();
  });

  test("indices outside the 64×64 grid are rejected", () => {
    expect(parseTilePath("/tiles/0/64_0.png")).toBeNull();
    expect(parseTilePath("/tiles/0/0_64.png")).toBeNull();
    expect(parseTilePath("/tiles/0/63_63.png")).not.toBeNull();
  });

  test("resolveTilePath finds an extracted tile and only that", () => {
    const root = mkdtempSync(join(tmpdir(), "wrathbench-tiles-"));
    mkdirSync(join(root, "0"));
    // Synthetic bytes: the route only streams the file and sets a content type.
    writeFileSync(join(root, "0", "43_31.png"), new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
    writeFileSync(join(root, "secret.txt"), "not a tile");
    expect(resolveTilePath(root, "/tiles/0/43_31.png")).toBe(join(root, "0", "43_31.png"));
    // A tile the extraction has not written is a miss, not an error.
    expect(resolveTilePath(root, "/tiles/0/44_31.png")).toBeNull();
    expect(resolveTilePath(root, "/tiles/0/../secret.txt")).toBeNull();
    expect(resolveTilePath(join(root, "nope"), "/tiles/0/43_31.png")).toBeNull();
  });
});

/* ---------- the position feed ---------- */

interface FixtureRun {
  id: string;
  terminated?: string;
  model?: string;
  character?: string;
  /** [ts, level, xp, map, x, y, z, money, quests] — nulls allowed. */
  states?: (number | null)[][];
  /** Omit the position columns entirely, as a pre-ADR-0018 run does. */
  noPositionColumns?: boolean;
}

function fixture(runs: FixtureRun[]): string {
  const runsDir = mkdtempSync(join(tmpdir(), "wrathbench-map-runs-"));
  for (const r of runs) {
    const dir = join(runsDir, r.id);
    mkdirSync(dir);
    writeFileSync(
      join(dir, "meta.json"),
      JSON.stringify({
        runId: r.id,
        harnessVersion: "harness-0.2",
        startedAt: 1,
        config: { model: r.model ?? "a/model", character: r.character ?? "Char", driver: "openai" },
      }),
    );
    writeFileSync(join(dir, "trajectory.jsonl"), "");
    const db = new Database(join(dir, "run.sqlite"));
    const cols = r.noPositionColumns
      ? `run_id TEXT, ts INTEGER, level INTEGER, xp INTEGER`
      : `run_id TEXT, ts INTEGER, level INTEGER, xp INTEGER, map INTEGER,
         x REAL, y REAL, z REAL, money INTEGER, quests_completed INTEGER`;
    db.exec(`CREATE TABLE run (run_id TEXT PRIMARY KEY, harness_version TEXT, started_at INTEGER,
      ended_at INTEGER, adapter TEXT, driver TEXT, shakeout TEXT, model TEXT,
      termination_reason TEXT, termination_detail TEXT, pause_reason TEXT, config_json TEXT);
      CREATE TABLE state (${cols});`);
    db.query(`INSERT INTO run (run_id, model, termination_reason, config_json) VALUES (?, ?, ?, ?)`).run(
      r.id,
      r.model ?? "a/model",
      r.terminated ?? null,
      "{}",
    );
    const width = r.noPositionColumns ? 4 : 10;
    const holes = new Array(width).fill("?").join(", ");
    for (const s of r.states ?? [])
      db.query(`INSERT INTO state VALUES (${holes})`).run(...([r.id, ...s] as never[]));
    db.close();
  }
  return runsDir;
}

describe("readPositions", () => {
  const NOW = 1_700_000_000_000;

  test("returns the ADR-0019 shape for a live run", () => {
    const runsDir = fixture([
      {
        id: "live-1",
        model: "anthropic/claude",
        character: "Brächt",
        states: [[NOW - 5000, 4, 900, 0, -6240, 380, 380, 12345, 7]],
      },
    ]);
    const [p] = readPositions(runsDir, NOW);
    expect(p).toEqual({
      runId: "live-1",
      character: "Brächt",
      model: "anthropic/claude",
      map: 0,
      x: -6240,
      y: 380,
      ts: NOW - 5000,
      level: 4,
      xp: 900,
      money: 12345,
      questsCompleted: 7,
      harnessVersion: "harness-0.2",
    });
  });

  test("a terminated run is not on the map, however fresh its last position", () => {
    const runsDir = fixture([
      {
        id: "done-1",
        terminated: "goal-reached",
        states: [[NOW - 1000, 4, 900, 0, 1, 2, 3, 0, 0]],
      },
    ]);
    expect(readPositions(runsDir, NOW)).toHaveLength(0);
  });

  test("a position older than the window drops out", () => {
    const runsDir = fixture([
      { id: "stale-1", states: [[NOW - 11 * 60_000, 4, 900, 0, 1, 2, 3, 0, 0]] },
      { id: "fresh-1", states: [[NOW - 60_000, 4, 900, 0, 1, 2, 3, 0, 0]] },
    ]);
    expect(readPositions(runsDir, NOW).map((p) => p.runId)).toEqual(["fresh-1"]);
  });

  test("the newest sample that carried a position wins, not the newest sample", () => {
    // A level-only sample must not blink a live agent off the map.
    const runsDir = fixture([
      {
        id: "live-2",
        states: [
          [NOW - 9000, 4, 900, 0, -6240, 380, 380, 1, 1],
          [NOW - 1000, 5, 100, null, null, null, null, 2, 2],
        ],
      },
    ]);
    const [p] = readPositions(runsDir, NOW);
    expect(p!.x).toBe(-6240);
    expect(p!.ts).toBe(NOW - 9000);
  });

  test("a schema with no position columns is skipped, not an error", () => {
    const runsDir = fixture([{ id: "old-1", noPositionColumns: true, states: [[NOW, 4, 900]] }]);
    expect(readPositions(runsDir, NOW)).toEqual([]);
    expect(readLatestPosition(runsDir, "old-1")).toBeNull();
  });

  test("a run with no database at all is skipped", () => {
    const runsDir = mkdtempSync(join(tmpdir(), "wrathbench-map-empty-"));
    mkdirSync(join(runsDir, "bare"));
    expect(readPositions(runsDir, NOW)).toEqual([]);
    expect(readLatestPosition(runsDir, "bare")).toBeNull();
  });

  test("newest position first", () => {
    const runsDir = fixture([
      { id: "a", states: [[NOW - 30_000, 1, 1, 0, 1, 2, 3, 0, 0]] },
      { id: "b", states: [[NOW - 1_000, 1, 1, 1, 1, 2, 3, 0, 0]] },
    ]);
    expect(readPositions(runsDir, NOW).map((p) => p.runId)).toEqual(["b", "a"]);
  });
});
