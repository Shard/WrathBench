import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readLatestPosition, readLatestStatus, readPositions, readReflecting } from "../viewer/positions";
import { trackFrom } from "../viewer/results";
import { readStates } from "../viewer/runs";
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
  /** Omit the position columns entirely, as a run from before position recording does. */
  noPositionColumns?: boolean;
  /** Add the `items` column (FOLLOW-UPS 50) and set it on the newest state row. */
  items?: string | null;
  /**
   * Add the player-frame columns (FOLLOW-UPS 104) and set them on the newest
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
      map: 0,
      x: -6240,
      y: 380,
      ts: NOW - 5000,
      level: 4,
      xp: 900,
      money: 12345,
      questsCompleted: 7,
      items: null,
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

  test("the popout carries the newest recorded inventory, null before the column existed", () => {
    const items = JSON.stringify([
      { name: "Worn Mace", count: 1, equipped: true },
      { name: "Tough Jerky", count: 5, equipped: false },
    ]);
    const runsDir = fixture([
      { id: "live-items", states: [[NOW - 5000, 4, 900, 0, -6240, 380, 380, 1, 0]], items },
      { id: "live-bare", states: [[NOW - 4000, 4, 900, 0, -6240, 380, 380, 1, 0]] },
    ]);
    const byId = new Map(readPositions(runsDir, NOW).map((p) => [p.runId, p]));
    expect(byId.get("live-items")?.items).toEqual(JSON.parse(items));
    expect(byId.get("live-bare")?.items).toBeNull();
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
    const [p] = trackFrom(readStates(runsDir, "track-hp"));
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
    expect(trackFrom(readStates(old, "track-old"))[0]).toMatchObject({ health: null, maxPower: null });
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
