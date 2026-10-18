import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { STALL_PAUSE } from "../src/lapse";
import { Trajectory } from "../src/trajectory";
import { localRunStore, type RunStore } from "../viewer/clickhouse";
import { positionsFromStore, readLatestPosition, readLatestStatus, readPositions, readReflecting } from "../viewer/positions";
import { projectPositions } from "../viewer/public-projection";
import { trackFrom } from "../viewer/results";
import { readStates } from "../viewer/runs";
import { parseTilePath, resolveTilePath, tileRefPath } from "../viewer/tiles";
import {
  GRID,
  LOD_MAX,
  TILE_PX,
  coordToTile,
  lodGrid,
  lodTileName,
  pixelToWorld,
  tileToCoord,
  tileToWorld,
  visibleTiles,
  worldToPixel,
  worldToTile,
} from "../viewer/worldmap";
import { tempDirs } from "./fixtures/temp-dirs";

const tempDir = tempDirs();

/* ---------- coordinates ---------- */

describe("worldmap", () => {
  test("Anvilmar lands at the recorded reference point", () => {
    // map 0, x ≈ -6240, y ≈ 380 — the map view's recorded reference point.
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
 * The replay seam: the transform must be usable with nothing else
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
    const root = tempDir("wrathbench-tiles-");
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

/* ---------- the pyramid's paths ---------- */

describe("pyramid tile paths", () => {
  test("a level's grid halves per level, down to one tile for the world", () => {
    expect(lodGrid(0)).toBe(GRID);
    expect(lodGrid(1)).toBe(32);
    expect(lodGrid(LOD_MAX)).toBe(1);
  });

  test("lodTileName spells levels 1..LOD_MAX and refuses level 0 and anything outside the level's grid", () => {
    expect(lodTileName("minimap", 1, 21, 15)).toBe("minimap/1/21_15.png");
    expect(lodTileName("minimap", LOD_MAX, 0, 0)).toBe("minimap/6/0_0.png");
    // Level 0 is the native tile and only ever `tileName`: a pyramid writer
    // cannot be made to emit it.
    expect(() => lodTileName("minimap", 0, 43, 31)).toThrow();
    expect(() => lodTileName("art", 0, 43, 31)).toThrow();
    expect(lodTileName("art", 1, 21, 15)).toBe("art/1/21_15.png");
    expect(() => lodTileName("minimap", LOD_MAX + 1, 0, 0)).toThrow();
    expect(() => lodTileName("minimap", 1.5, 0, 0)).toThrow();
    expect(() => lodTileName("minimap", 1, 32, 0)).toThrow();
    expect(() => lodTileName("minimap", 6, 0, 1)).toThrow();
    expect(() => lodTileName("minimap", 2, -1, 0)).toThrow();
  });

  test("a well-formed pyramid path parses, and its canonical path is the one lodTileName spells", () => {
    const ref = parseTilePath("/tiles/0/minimap/3/5_3.png");
    expect(ref).toEqual({ map: 0, row: 5, col: 3, lod: { layer: "minimap", z: 3 } });
    expect(tileRefPath(ref!)).toBe(`/tiles/0/${lodTileName("minimap", 3, 5, 3)}`);
    expect(parseTilePath("/tiles/1/art/2/9_5.png")).toEqual({ map: 1, row: 9, col: 5, lod: { layer: "art", z: 2 } });
    expect(tileRefPath(parseTilePath("/tiles/1/art/2/9_5.png")!)).toBe(`/tiles/1/${lodTileName("art", 2, 9, 5)}`);
    expect(parseTilePath("/tiles/571/minimap/6/0_0.png")).toEqual({
      map: 571,
      row: 0,
      col: 0,
      lod: { layer: "minimap", z: 6 },
    });
    // The native path is untouched and its canonical form is itself.
    expect(tileRefPath(parseTilePath("/tiles/0/43_31.png")!)).toBe("/tiles/0/43_31.png");
  });

  test("a level outside 1..LOD_MAX, a layer not on the list, or a cell outside the level's grid is rejected", () => {
    for (const p of [
      "/tiles/0/minimap/0/43_31.png", // level 0 exists only as the native path
      "/tiles/0/minimap/7/0_0.png",
      "/tiles/0/minimap/1/32_0.png", // level 1 is 32×32
      "/tiles/0/minimap/6/0_1.png", // level 6 is one tile
      "/tiles/0/terrain/1/0_0.png", // not a layer
      "/tiles/0/art/0/43_31.png", // the art has no level 0
      "/tiles/0/art/7/0_0.png",
      "/tiles/0/art/1/32_0.png",
      "/tiles/0/Art/1/0_0.png",
      "/tiles/0/Minimap/1/0_0.png",
      "/tiles/0/minimap/-1/0_0.png",
      "/tiles/0/minimap/1.5/0_0.png",
      "/tiles/0/minimap/1/0_0.png/x",
      "/tiles/0/minimap/1/0_0.jpg",
      "/tiles/0/minimap/../1/0_0.png",
      "/tiles/0/minimap/1/../0_0.png",
      "/tiles/0/minimap%2f1/0_0.png",
      "/tiles/0/minimap/1",
      "/tiles/minimap/1/0_0.png",
      "/tiles/a/minimap/1/0_0.png",
    ])
      expect(parseTilePath(p)).toBeNull();
  });

  test("resolveTilePath finds a baked level under its layer and nothing beside it", () => {
    const root = tempDir("wrathbench-lod-");
    mkdirSync(join(root, "0", "minimap", "2"), { recursive: true });
    writeFileSync(join(root, "0", lodTileName("minimap", 2, 10, 7)), new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
    writeFileSync(join(root, "0", "minimap", "secret.txt"), "not a tile");
    expect(resolveTilePath(root, "/tiles/0/minimap/2/10_7.png")).toBe(join(root, "0", "minimap", "2", "10_7.png"));
    // A leading zero names the same file: the path is rebuilt from the integer.
    expect(resolveTilePath(root, "/tiles/0/minimap/02/10_7.png")).toBe(join(root, "0", "minimap", "2", "10_7.png"));
    expect(resolveTilePath(root, "/tiles/0/minimap/2/10_8.png")).toBeNull();
    expect(resolveTilePath(root, "/tiles/0/minimap/secret.txt")).toBeNull();
    // The same name at level 0 is a different file, and not this one.
    expect(resolveTilePath(root, "/tiles/0/10_7.png")).toBeNull();
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
  /** Omit the position columns entirely, as a run from before position recording does. */
  noPositionColumns?: boolean;
  /** Add the `items` column and set it on the newest state row. */
  items?: string | null;
  /**
   * Add the player-frame columns and set them on the newest
   * state row: [health, maxHealth, power, maxPower, powerType, nextLevelXp].
   */
  gauges?: (number | null)[];
  /** The class in meta.json's config, as a launch writes it. */
  klass?: number;
  /** Raw lines for `episodic.jsonl`; absent writes no file at all. */
  episodic?: string[];
  /** `run.reflecting_since`: a number opens a window, null adds the column shut. */
  reflectingSince?: number | null;
}

function fixture(runs: FixtureRun[]): string {
  const runsDir = tempDir("wrathbench-map-runs-");
  for (const r of runs) {
    const dir = join(runsDir, r.id);
    mkdirSync(dir);
    writeFileSync(
      join(dir, "meta.json"),
      JSON.stringify({
        runId: r.id,
        harnessVersion: "harness-0.2",
        startedAt: 1,
        config: {
          model: r.model ?? "a/model",
          character: r.character ?? "Char",
          driver: "openai",
          ...(r.klass === undefined ? {} : { class: r.klass }),
        },
      }),
    );
    writeFileSync(join(dir, "trajectory.jsonl"), "");
    const db = new Database(join(dir, "run.sqlite"));
    const cols = r.noPositionColumns
      ? `run_id TEXT, ts INTEGER, level INTEGER, xp INTEGER`
      : `run_id TEXT, ts INTEGER, level INTEGER, xp INTEGER, map INTEGER,
         x REAL, y REAL, z REAL, money INTEGER, quests_completed INTEGER`;
    db.exec(`CREATE TABLE run (run_id TEXT PRIMARY KEY, harness_version TEXT, started_at INTEGER,
      ended_at INTEGER, driver TEXT, shakeout TEXT, model TEXT,
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
    if (r.gauges !== undefined) {
      for (const c of ["health", "max_health", "power", "max_power", "power_type", "next_level_xp"])
        db.exec(`ALTER TABLE state ADD COLUMN ${c} INTEGER`);
      db.query(
        `UPDATE state SET health = ?, max_health = ?, power = ?, max_power = ?, power_type = ?,
         next_level_xp = ? WHERE ts = (SELECT MAX(ts) FROM state)`,
      ).run(...(r.gauges as never[]));
    }
    if (r.episodic !== undefined)
      writeFileSync(join(dir, "episodic.jsonl"), r.episodic.map((l) => `${l}\n`).join(""));
    if (r.reflectingSince !== undefined) {
      db.exec(`ALTER TABLE run ADD COLUMN reflecting_since INTEGER`);
      db.query(`UPDATE run SET reflecting_since = ? WHERE run_id = ?`).run(r.reflectingSince, r.id);
    }
    if (r.items !== undefined) {
      db.exec(`ALTER TABLE state ADD COLUMN items TEXT`);
      db.query(`UPDATE state SET items = ? WHERE ts = (SELECT MAX(ts) FROM state)`).run(r.items);
    }
    db.close();
  }
  return runsDir;
}


/* ---------- the episodic status and the reflection window ---------- */

describe("the character's last status", () => {
  const NOW = 1_700_000_000_000;
  const entry = (o: Record<string, unknown>): string => JSON.stringify(o);

  test("the newest entry is served, with unobserved stamps as null", () => {
    const runsDir = fixture([
      {
        id: "logged",
        states: [[NOW - 5000, 4, 900, 0, -6240, 380, 380, 1, 0]],
        episodic: [
          entry({ ts: NOW - 9000, turn: 3, level: 2, zone: "Coldridge Valley", text: "killed a boar" }),
          entry({ ts: NOW - 4000, turn: 11, text: "heading for the inn" }),
        ],
      },
    ]);
    expect(readLatestStatus(runsDir, "logged")).toEqual({
      turn: 11,
      // Neither stamp was observed when the entry was written: null, never
      // back-filled from the entry before it.
      level: null,
      zone: null,
      text: "heading for the inn",
      ts: NOW - 4000,
    });
    expect(readPositions(runsDir, NOW)[0]?.status?.turn).toBe(11);
  });

  test("no log, an empty log and a half-written last line all read as what came before", () => {
    const runsDir = fixture([
      { id: "none", states: [[NOW - 1000, 1, 0, 0, 1, 2, 3, 0, 0]] },
      { id: "empty", states: [[NOW - 1000, 1, 0, 0, 1, 2, 3, 0, 0]], episodic: [] },
      {
        id: "torn",
        states: [[NOW - 1000, 1, 0, 0, 1, 2, 3, 0, 0]],
        episodic: [entry({ ts: NOW - 2000, turn: 1, level: 1, zone: "Anvilmar", text: "first" }), '{"ts":1,"tur'],
      },
    ]);
    expect(readLatestStatus(runsDir, "none")).toBeNull();
    expect(readLatestStatus(runsDir, "empty")).toBeNull();
    expect(readLatestStatus(runsDir, "torn")?.text).toBe("first");
  });

  test("an entry with no text and no turn is not an entry", () => {
    const runsDir = fixture([
      {
        id: "junk",
        states: [[NOW - 1000, 1, 0, 0, 1, 2, 3, 0, 0]],
        episodic: [entry({ ts: NOW, level: 3, text: "no turn" }), entry({ ts: NOW, turn: 9 })],
      },
    ]);
    expect(readLatestStatus(runsDir, "junk")).toBeNull();
  });
});

describe("readReflecting", () => {
  const NOW = 1_700_000_000_000;

  test("a standing reflecting_since is an open window; NULL and no column are not", () => {
    const runsDir = fixture([
      { id: "open", states: [[NOW - 1000, 1, 0, 0, 1, 2, 3, 0, 0]], reflectingSince: NOW - 3000 },
      { id: "shut", states: [[NOW - 1000, 1, 0, 0, 1, 2, 3, 0, 0]], reflectingSince: null },
      // A run recorded before the column existed was never reflecting.
      { id: "older", states: [[NOW - 1000, 1, 0, 0, 1, 2, 3, 0, 0]] },
    ]);
    expect(readReflecting(runsDir, "open")).toBe(true);
    expect(readReflecting(runsDir, "shut")).toBe(false);
    expect(readReflecting(runsDir, "older")).toBe(false);
    expect(readReflecting(runsDir, "no-such-run")).toBe(false);
    const byId = new Map(readPositions(runsDir, NOW).map((p) => [p.runId, p]));
    expect(byId.get("open")?.reflecting).toBe(true);
    expect(byId.get("older")?.reflecting).toBe(false);
  });
});

describe("readPositions", () => {
  const NOW = 1_700_000_000_000;

  test("returns the map-view shape for a live run", () => {
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
      // The fixture stamps no comparability, so the effort is "not recorded".
      effort: null,
      map: 0,
      x: -6240,
      y: 380,
      ts: NOW - 5000,
      level: 4,
      xp: 900,
      money: 12345,
      questsCompleted: 7,
      harnessVersion: "harness-0.2",
      // A fixture written before the player-frame columns existed reads them as
      // unobserved — null, never zero.
      health: null,
      maxHealth: null,
      power: null,
      maxPower: null,
      powerType: null,
      nextLevelXp: null,
      class: null,
      // A fixture written before the move table existed records no intention.
      move: null,
      // Nothing logged, and a run.sqlite without the column was never reflecting.
      status: null,
      reflecting: false,
    });
  });

  test("the feed carries no inventory, however much the state line recorded: the sidebar reads the trace's sheet", () => {
    const items = JSON.stringify([
      { name: "Worn Mace", count: 1, equipped: true, itemId: 5956, quality: 1, slot: 16 },
      { name: "Tough Jerky", count: 5, equipped: false, itemId: 117, quality: 1, slot: 23, bag: 255 },
    ]);
    const runsDir = fixture([
      { id: "live-items", states: [[NOW - 5000, 4, 900, 0, -6240, 380, 380, 1, 0]], items },
      { id: "live-bare", states: [[NOW - 4000, 4, 900, 0, -6240, 380, 380, 1, 0]] },
    ]);
    const feed = readPositions(runsDir, NOW);
    expect(feed.map((p) => p.runId).sort()).toEqual(["live-bare", "live-items"]);
    for (const p of feed) expect(Object.keys(p)).not.toContain("items");
  });

  test("the unit frame's numbers ride the sample the pip is drawn from", () => {
    const runsDir = fixture([
      {
        id: "live-hp",
        klass: 1,
        states: [
          [NOW - 9000, 4, 900, 0, -6240, 380, 380, 1, 1],
          // The newest sample carries no position, so the row below it wins —
          // and the frame must show that row's numbers, not this one's.
          [NOW - 1000, 4, 950, null, null, null, null, 1, 1],
        ],
        gauges: [140, 220, 30, 100, 0, 2100],
      },
    ]);
    const [p] = readPositions(runsDir, NOW);
    expect(p!.ts).toBe(NOW - 9000);
    // The gauges were written on the newest row, which has no position: the
    // positioned row carried none, and none is what the feed says.
    expect(p!.health).toBeNull();
    expect(p!.class).toBe(1);

    const positioned = fixture([
      { id: "live-hp2", klass: 4, states: [[NOW - 5000, 4, 900, 0, 1, 2, 3, 1, 1]], gauges: [140, 220, 30, 100, 3, 2100] },
    ]);
    const [q] = readPositions(positioned, NOW);
    expect({ ...q, runId: q!.runId }).toMatchObject({
      health: 140,
      maxHealth: 220,
      power: 30,
      maxPower: 100,
      powerType: 3,
      nextLevelXp: 2100,
      class: 4,
    });
  });

  test("the recorded track carries the frame's numbers through readStates", () => {
    // The replay path: state row → readStates → trackFrom. Distinct values, so
    // a max_health/max_power transposition in either mapping fails here.
    const runsDir = fixture([
      { id: "track-hp", states: [[NOW - 5000, 4, 900, 0, 1, 2, 3, 1, 1]], gauges: [140, 220, 30, 100, 3, 2100] },
    ]);
    const [p] = trackFrom(readStates(runsDir, "track-hp")).points;
    expect(p).toMatchObject({
      health: 140,
      maxHealth: 220,
      power: 30,
      maxPower: 100,
      powerType: 3,
      nextLevelXp: 2100,
    });
    // A run recorded before the columns reads them as unobserved, not zero.
    const old = fixture([{ id: "track-old", states: [[NOW - 5000, 4, 900, 0, 1, 2, 3, 1, 1]] }]);
    expect(trackFrom(readStates(old, "track-old")).points[0]).toMatchObject({ health: null, maxPower: null });
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
    const runsDir = tempDir("wrathbench-map-empty-");
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

  test("the quest count is the run's, summed across the resumes that start the recorded one again", () => {
    const runsDir = fixture([
      {
        // A freeplay run resumed in place twice: its processes counted 12 and
        // 3, and the one running now has counted 2, which is all the newest
        // sample says.
        id: "resumed",
        states: [
          [NOW - 600_000, 30, 1, 0, 1, 2, 3, 5, 9],
          // A stretch's last count on a sample with no position still counts.
          [NOW - 540_000, 30, 2, null, null, null, null, 5, 12],
          [NOW - 480_000, 30, 3, 0, 1, 2, 3, 5, 0],
          [NOW - 420_000, 30, 4, 0, 1, 2, 3, 5, 3],
          [NOW - 120_000, 30, 5, 0, 1, 2, 3, 5, 0],
          [NOW - 60_000, 30, 6, 0, 1, 2, 3, 5, null],
          [NOW - 5_000, 30, 7, 0, 1, 2, 3, 5, 2],
        ],
      },
      // No sample carried a count: not recorded, never zero.
      { id: "uncounted", states: [[NOW - 5_000, 4, 900, 0, 1, 2, 3, 1, null]] },
    ]);
    const byId = new Map(readPositions(runsDir, NOW).map((p) => [p.runId, p]));
    expect(byId.get("resumed")?.questsCompleted).toBe(17);
    expect(byId.get("uncounted")?.questsCompleted).toBeNull();
    // `live.json` carries the same figure.
    expect(projectPositions({ positions: [...byId.values()] }).positions.find((p) => p.runId === "resumed")?.questsCompleted).toBe(17);
    // And the replay track's last point reads it too.
    expect(trackFrom(readStates(runsDir, "resumed")).points.at(-1)?.questsCompleted).toBe(17);
  });

  test("a run whose nearby ring is being written is flagged, privately only", () => {
    const now = Date.now();
    const runsDir = fixture([
      { id: "ringed", states: [[now - 5_000, 4, 900, 0, 1, 2, 3, 0, 0]] },
      { id: "plain", states: [[now - 5_000, 4, 900, 0, 1, 2, 3, 0, 0]] },
    ]);
    const t0 = Math.floor(now / 60_000) * 60_000;
    mkdirSync(join(runsDir, "ringed", "nearby"));
    writeFileSync(join(runsDir, "ringed", "nearby", `${t0}.jsonl`), `{"ts":${now},"kind":"tick"}\n`);
    const byId = new Map(readPositions(runsDir, now).map((p) => [p.runId, p]));
    expect(byId.get("ringed")?.nearby).toBe(true);
    expect("nearby" in byId.get("plain")!).toBe(false);
    expect(projectPositions({ positions: [...byId.values()] }).positions.every((p) => !("nearby" in p))).toBe(true);
  });
});

/*
 * The same feed with its listing taken off the derived store. The fixture is
 * written by the runner's own writer rather than by hand, because the store is
 * filled by the collector, and the collector reads what the runner writes.
 */
describe("positionsFromStore", () => {
  const NOW = 1_700_000_000_000;

  /** One run as the runner writes it, its only state sample at `stateTs`. */
  function writeRun(
    runsDir: string,
    runId: string,
    o: { stateTs: number; terminated?: boolean; reflecting?: boolean; episodic?: string; paused?: "rate-limited" | typeof STALL_PAUSE },
  ): void {
    const dir = join(runsDir, runId);
    let clock = NOW - 60_000;
    const traj = new Trajectory(dir, { now: () => clock });
    traj.writeMeta({
      runId,
      harnessVersion: "harness-0.5-9-gabc",
      startedAt: clock,
      config: { runId, driver: "openai", model: "a-model", effort: "medium", race: 3, class: 1 } as never,
      comparability: { episode: "freeplay", harness: "wrathbench", effort: "medium" } as never,
    });
    traj.setCharacter(runId, `C-${runId}`);
    clock = o.stateTs;
    traj.recordState(runId, {
      level: 4,
      xp: 120,
      map: 0,
      x: -6240,
      y: 380,
      z: 380,
      money: 71,
      questsCompleted: 3,
      health: 140,
      maxHealth: 220,
      items: [{ name: "Tough Jerky", count: 4, equipped: false, itemId: 117, quality: 1, slot: 23, bag: 255 }],
    });
    traj.recordMove(runId, { map: 0, x: 7, y: 8, z: 9, moveId: 1 });
    if (o.reflecting === true) traj.append({ t: "reflect_window", event: "open" });
    if (o.terminated === true) traj.setTermination(runId, "episode-elapsed" as never, "done");
    if (o.paused !== undefined) traj.setPause(runId, o.paused, "fixture");
    traj.close();
    if (o.episodic !== undefined)
      writeFileSync(join(dir, "episodic.jsonl"), `${JSON.stringify({ ts: o.stateTs, turn: 7, text: o.episodic })}\n`);
  }

  function corpus(): string {
    const runsDir = tempDir("wrathbench-map-store-");
    writeRun(runsDir, "live-a", { stateTs: NOW - 5_000, reflecting: true, episodic: "heading for the inn" });
    writeRun(runsDir, "live-b", { stateTs: NOW - 1_000 });
    writeRun(runsDir, "ended", { stateTs: NOW - 1_000, terminated: true });
    writeRun(runsDir, "stale", { stateTs: NOW - 11 * 60_000 });
    // Archived: the store carries it, flagged, and the feed must not draw it.
    writeRun(join(runsDir, "archive"), "shelved", { stateTs: NOW - 1_000 });
    return runsDir;
  }

  test("is the file walk's feed, entry for entry and in the same order", async () => {
    const runsDir = corpus();
    const fromStore = await positionsFromStore(localRunStore(runsDir), runsDir, NOW);
    // Terminated, stale and archived runs are all left off; newest position first.
    expect(fromStore.map((p) => p.runId)).toEqual(["live-b", "live-a"]);
    expect(JSON.stringify(fromStore)).toBe(JSON.stringify(readPositions(runsDir, NOW)));
    // The readings off the store's aggregate, and the live reads off the files.
    expect(fromStore[1]).toMatchObject({
      character: "C-live-a",
      level: 4,
      xp: 120,
      money: 71,
      questsCompleted: 3,
      health: 140,
      maxHealth: 220,
      class: 1,
      move: { x: 7, y: 8, z: 9 },
      status: { turn: 7, text: "heading for the inn" },
      reflecting: true,
    });
    expect(Object.keys(fromStore[1]!)).not.toContain("items");
  });

  test("the listing is the store's: a run it does not list is not opened, whatever is on disk", async () => {
    const runsDir = corpus();
    const inner = localRunStore(runsDir);
    const reads = { runRows: 0, latestStates: 0 };
    const store: RunStore = {
      ...inner,
      runRows: async () => {
        reads.runRows += 1;
        return (await inner.runRows()).filter((r) => r.run_id === "live-a");
      },
      latestStates: () => {
        reads.latestStates += 1;
        return inner.latestStates();
      },
    };
    expect((await positionsFromStore(store, runsDir, NOW)).map((p) => p.runId)).toEqual(["live-a"]);
    expect(reads).toEqual({ runRows: 1, latestStates: 1 });
  });

  test("a run paused because its observation stalled is off the map in both feeds; another pause is not", async () => {
    // A stalled run's newest rows are the last reading repeated while the
    // character went on elsewhere: fresh by the stamp, wrong by the content.
    const runsDir = tempDir("wrathbench-map-stall-");
    writeRun(runsDir, "stalled", { stateTs: NOW - 1_000, paused: STALL_PAUSE });
    writeRun(runsDir, "cooling", { stateTs: NOW - 2_000, paused: "rate-limited" });
    expect(readPositions(runsDir, NOW).map((p) => p.runId)).toEqual(["cooling"]);
    expect((await positionsFromStore(localRunStore(runsDir), runsDir, NOW)).map((p) => p.runId)).toEqual(["cooling"]);
  });

  test("a row the store flags archived is not drawn, even when its files would answer", async () => {
    const runsDir = corpus();
    const inner = localRunStore(runsDir);
    const store: RunStore = {
      ...inner,
      runRows: async () => (await inner.runRows()).map((r) => (r.run_id === "live-a" ? { ...r, archived: 1 } : r)),
    };
    expect((await positionsFromStore(store, runsDir, NOW)).map((p) => p.runId)).toEqual(["live-b"]);
  });

  test("both feeds carry the run's quest count across a resume, where the store's row has the newest sample's", async () => {
    const runsDir = tempDir("wrathbench-map-resumed-");
    writeRun(runsDir, "resumed", { stateTs: NOW - 300_000 });
    // The fleet resumed it in place: a new process, whose count starts at zero.
    let clock = NOW - 120_000;
    const traj = new Trajectory(join(runsDir, "resumed"), { now: () => clock });
    for (const [ts, q] of [[NOW - 120_000, 0], [NOW - 60_000, 1], [NOW - 2_000, 2]] as const) {
      clock = ts;
      traj.recordState("resumed", { level: 4, xp: 130, map: 0, x: -6240, y: 380, z: 380, money: 71, questsCompleted: q });
    }
    traj.close();
    const store = localRunStore(runsDir);
    expect((await store.latestStates()).get("resumed")?.questsCompleted).toBe(2);
    const fromStore = await positionsFromStore(store, runsDir, NOW);
    expect(fromStore.map((p) => p.questsCompleted)).toEqual([5]);
    expect(JSON.stringify(fromStore)).toBe(JSON.stringify(readPositions(runsDir, NOW)));
  });
});
