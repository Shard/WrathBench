/**
 * `move-lane`: a paused run moved to another subscription lane (GitHub issue
 * #331, proposal 1). Pinned here: every refusal writes nothing; the rewrite
 * keeps meta.json's own format and mode bits and appends to `laneHistory`; a
 * resume reads the new lane back; and with `--pin` the roster pin is written
 * only after meta.json already names the new lane.
 */

import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { comparabilityOf } from "../src/comparability";
import { loadRunConfig, newSessionToken } from "../src/config";
import { ConfigRejected, ConfigStore } from "../src/config-store";
import { formatLike, LaneMoveRefused, LanePinFailed, moveLane, type MoveLaneOptions } from "../src/move-lane";
import { HEARTBEAT_FILE, readMeta, Trajectory, type RunMeta } from "../src/trajectory";
import { ARCHIVE_DIR } from "../viewer/archive-dir";
import { tempDirs } from "./fixtures/temp-dirs";

const tempDir = tempDirs();

const RUN_ID = "fleet-son-freeplay-sonnet-20261023";
const T1 = "CLAUDE_CODE_OAUTH_TOKEN";
const T2 = "CLAUDE_CODE_OAUTH_TOKEN_2";

function fleetDoc(son: Record<string, unknown> = {}, subscriptions: string[] = [T1, T2, "CODEX_HOME", "CODEX_HOME_2"]): Record<string, unknown> {
  return {
    _notes: ["n"],
    accounts: { pool: ["RUNNER", "RUNNER2"] },
    roster: {
      glm: { tier: "t1", model: "z-ai/glm-5.2:free" },
      son: { tier: "t1", model: "sonnet", driver: "claude-code", idle: "unlimited", ...son },
      gpt: { tier: "t1", model: "gpt-5.5", driver: "codex" },
    },
    policy: { subscriptions },
    queue: [],
  };
}

interface Fixture {
  runsDir: string;
  dir: string;
  metaPath: string;
  store: ConfigStore;
  opts: (over?: Partial<MoveLaneOptions>) => MoveLaneOptions;
}

/**
 * A paused (or, with `pause: false`, verdict-less and cold) run of `driver`,
 * its meta.json rewritten by hand in a 4-space indent with mode 0664 — the
 * shape the hand move broke — and a store with `doc` seeded.
 */
function fixture(o: { driver?: string; model?: string; subscription?: string | null; pause?: boolean; doc?: Record<string, unknown> } = {}): Fixture {
  const runsDir = tempDir("wrathbench-move-lane-");
  const dir = join(runsDir, RUN_ID);
  const t = new Trajectory(dir);
  const config = loadRunConfig({
    runId: RUN_ID,
    token: newSessionToken(),
    driver: o.driver ?? "claude-code",
    model: o.model ?? "sonnet",
    episode: "freeplay",
    runsDir,
    moduleUrl: "http://127.0.0.1:9",
    account: "RUNNER2",
    character: "Brenna",
    race: 3,
    class: 2,
    ...(o.subscription === null ? {} : { subscription: o.subscription ?? T2 }),
  });
  t.writeMeta({ runId: RUN_ID, harnessVersion: "harness-0.5-1", startedAt: Date.now() - 3_600_000, config, comparability: comparabilityOf(config, "harness-0.5-1") });
  t.append({ t: "response", text: "…" });
  if (o.pause !== false) t.setPause(RUN_ID, "operator-pause", "SIGTERM: supervisor stop", 58 * 3_600_000);
  t.close();
  const metaPath = join(dir, "meta.json");
  writeFileSync(metaPath, `${JSON.stringify(JSON.parse(readFileSync(metaPath, "utf8")), null, 4)}\n`);
  chmodSync(metaPath, 0o664);
  if (o.pause === false) {
    const cold = new Date(Date.now() - 3_600_000);
    utimesSync(join(dir, "trajectory.jsonl"), cold, cold);
  }
  const store = new ConfigStore(join(runsDir, "config.sqlite"), { env: {} });
  store.seed(o.doc ?? fleetDoc({ subscription: T2 }));
  return {
    runsDir,
    dir,
    metaPath,
    store,
    opts: (over = {}) => ({ runsDir, runId: RUN_ID, to: T1, pin: true, actor: "operator", note: "lane 2 is spent", store, env: {}, ...over }),
  };
}

/** The move refuses with `pattern`, and neither meta.json nor the store moved. */
function expectRefused(f: Fixture, over: Partial<MoveLaneOptions>, pattern: RegExp): void {
  const meta = readFileSync(f.metaPath, "utf8");
  const version = f.store.version();
  let err: unknown;
  try {
    moveLane(f.opts(over));
  } catch (e) {
    err = e;
  }
  expect(err).toBeInstanceOf(LaneMoveRefused);
  expect((err as Error).message).toMatch(pattern);
  expect(readFileSync(f.metaPath, "utf8")).toBe(meta);
  expect(f.store.version()).toBe(version);
  expect(readdirSync(f.dir).filter((n) => n.endsWith(".tmp"))).toEqual([]);
}

describe("move-lane refuses, writing nothing", () => {
  test("a run with a live owner", () => {
    const f = fixture();
    writeFileSync(join(f.dir, HEARTBEAT_FILE), "host 1\n");
    expectRefused(f, {}, /has a live owner: its heartbeat is/);
  });

  test("a run with no verdict, which the fleet would resume as offline", () => {
    const f = fixture({ pause: false });
    expectRefused(f, {}, /neither paused nor ended/);
  });

  test("a lane policy.subscriptions does not list", () => {
    const f = fixture();
    expectRefused(f, { to: "CLAUDE_CODE_OAUTH_TOKEN_3" }, /CLAUDE_CODE_OAUTH_TOKEN_3 is not in policy\.subscriptions/);
  });

  test("a lane of another kind than the run's driver bills", () => {
    const f = fixture();
    expectRefused(f, { to: "CODEX_HOME_2" }, /CODEX_HOME_2 is not a claude-code lane/);
  });

  test("a codex run, whose lane is a home with the CLI's own threads", () => {
    const f = fixture({ driver: "codex", model: "gpt-5.5", subscription: "CODEX_HOME" });
    expectRefused(f, { to: "CODEX_HOME_2", pin: false }, /^run \S+ is a codex run: its lane holds more than a credential/);
  });

  test("a run whose driver bills no subscription", () => {
    const f = fixture({ driver: "openai", model: "z-ai/glm-5.2:free", subscription: null });
    expectRefused(f, { pin: false }, /is a openai run, which bills no subscription lane/);
  });

  test("the lane it is already on, an absent lane reading as the default", () => {
    const f = fixture({ subscription: null, doc: fleetDoc() });
    expectRefused(f, { to: T1, pin: false }, /already on CLAUDE_CODE_OAUTH_TOKEN — nothing written/);
    const pinned = fixture({ subscription: null, doc: fleetDoc({ subscription: T1 }) });
    expectRefused(pinned, { to: T1 }, /already on CLAUDE_CODE_OAUTH_TOKEN and roster\/son pins it — nothing written/);
  });

  test("without --pin, an entry that pins the old lane: the fleet would count one account and bill another", () => {
    const f = fixture();
    expectRefused(f, { pin: false }, /roster\/son pins CLAUDE_CODE_OAUTH_TOKEN_2.*Pass --pin/);
  });

  test("--pin with no roster entry the run belongs to", () => {
    const f = fixture({ model: "opus", doc: fleetDoc() });
    expectRefused(f, {}, /--pin: no roster entry is run \S+'s \(model opus\)/);
  });

  test("a value that is not an env var name, and a move with no note", () => {
    const f = fixture();
    expectRefused(f, { to: "sk-ant-oat01-abc" }, /is not an env var name/);
    expectRefused(f, { note: "  " }, /needs --note/);
  });

  test("an archived run", () => {
    const f = fixture();
    mkdirSync(join(f.runsDir, ARCHIVE_DIR), { recursive: true });
    renameSync(f.dir, join(f.runsDir, ARCHIVE_DIR, RUN_ID));
    expect(() => moveLane(f.opts())).toThrow(/is archived/);
  });
});

describe("the move", () => {
  test("rewrites meta.json atomically in its own format and mode, and appends to laneHistory", () => {
    const f = fixture();
    const before = readFileSync(f.metaPath, "utf8");
    const was = JSON.parse(before) as RunMeta;
    const r = moveLane(f.opts({ now: () => 1_700_000_000_000 }));
    expect(r).toMatchObject({ from: T2, to: T1, moved: true, pinned: "roster/son", ref: "son", history: 1, warnings: [] });

    const text = readFileSync(f.metaPath, "utf8");
    const meta = JSON.parse(text) as RunMeta;
    // Format: the file's own 4-space indent and trailing newline.
    expect(text).toBe(formatLike(before, meta));
    expect(text.startsWith('{\n    "runId"')).toBe(true);
    expect(text.endsWith("}\n")).toBe(true);
    // Mode: the group-write bit the hand edit lost.
    expect(statSync(f.metaPath).mode & 0o7777).toBe(0o664);
    // Only the lane and the history moved; key order is kept.
    expect(meta.config.subscription).toBe(T1);
    expect(meta.laneHistory).toEqual([{ from: T2, to: T1, at: 1_700_000_000_000, actor: "operator", note: "lane 2 is spent" }]);
    const { laneHistory: _h, ...rest } = meta;
    expect(rest).toEqual({ ...was, config: { ...was.config, subscription: T1 } });
    expect(Object.keys(rest)).toEqual(Object.keys(was));
    expect(readdirSync(f.dir).filter((n) => n.endsWith(".tmp"))).toEqual([]);

    // A resume rebuilds the config from meta.json: it now bills the new lane,
    // and the resume's own rewrite (which spreads the stored meta) keeps the record.
    expect(loadRunConfig(readMeta(f.dir)!.config).subscription).toBe(T1);

    // A second move appends.
    const back = moveLane(f.opts({ to: T2, note: "lane 1 now", now: () => 1_700_000_100_000 }));
    expect(back).toMatchObject({ from: T1, to: T2, history: 2, pinned: "roster/son" });
    expect((JSON.parse(readFileSync(f.metaPath, "utf8")) as RunMeta).laneHistory?.map((m) => `${m.from}>${m.to}`)).toEqual([`${T2}>${T1}`, `${T1}>${T2}`]);
  });

  test("--pin writes the roster pin only after meta.json names the new lane, through the validated path", () => {
    const f = fixture();
    const order: string[] = [];
    const patch = f.store.patch.bind(f.store);
    f.store.patch = (key, partial, opts) => {
      order.push(`patch ${key}: meta says ${(JSON.parse(readFileSync(f.metaPath, "utf8")) as RunMeta).config.subscription}`);
      patch(key, partial, opts);
    };
    moveLane(f.opts());
    expect(order).toEqual([`patch roster/son: meta says ${T1}`]);
    expect(f.store.get("roster/son")).toMatchObject({ subscription: T1, idle: "unlimited", model: "sonnet" });
    const audit = f.store.audit(1)[0]!;
    expect(audit).toMatchObject({ key: "roster/son", actor: "operator", note: `move-lane ${RUN_ID}: lane 2 is spent` });
  });

  test("a pin the store would refuse refuses the whole move before meta.json is touched", () => {
    const f = fixture();
    let patched = false;
    f.store.checkPatch = () => {
      throw new ConfigRejected("roster/son: refused for this test");
    };
    f.store.patch = () => {
      patched = true;
    };
    expectRefused(f, {}, /^--pin: roster\/son would be refused: roster\/son: refused for this test — nothing written$/);
    expect(patched).toBe(false);
  });

  test("a pin that fails after meta.json moved says so, and the same command then applies only the pin", () => {
    const f = fixture();
    const patch = f.store.patch.bind(f.store);
    f.store.patch = () => {
      throw new Error("database is locked");
    };
    expect(() => moveLane(f.opts())).toThrow(LanePinFailed);
    expect(() => moveLane(f.opts())).toThrow(/^meta\.json already names CLAUDE_CODE_OAUTH_TOKEN, but roster\/son was not pinned: database is locked\. .*run the same command again/);
    expect(readMeta(f.dir)!.config.subscription).toBe(T1);
    expect(f.store.get("roster/son")).toMatchObject({ subscription: T2 });
    f.store.patch = patch;
    expect(moveLane(f.opts())).toMatchObject({ moved: false, pinned: "roster/son", history: 1 });
    expect(f.store.get("roster/son")).toMatchObject({ subscription: T1 });
  });

  test("a pin still owed after a partial move is applied by the same command, and meta.json is left alone", () => {
    const f = fixture({ subscription: T1 });
    const before = readFileSync(f.metaPath, "utf8");
    const r = moveLane(f.opts({ to: T1 }));
    expect(r).toMatchObject({ moved: false, pinned: "roster/son", history: 0 });
    expect(readFileSync(f.metaPath, "utf8")).toBe(before);
    expect(f.store.get("roster/son")).toMatchObject({ subscription: T1 });
  });

  test("without --pin, an entry that pins nothing: meta.json alone, the store untouched", () => {
    const f = fixture({ doc: fleetDoc() });
    const version = f.store.version();
    const r = moveLane(f.opts({ pin: false }));
    expect(r).toMatchObject({ moved: true, pinned: null, ref: "son" });
    expect(f.store.version()).toBe(version);
    expect(readMeta(f.dir)!.config.subscription).toBe(T1);
  });

  test("an ended run moves too", () => {
    const f = fixture();
    const t = new Trajectory(f.dir);
    t.setTermination(RUN_ID, "manual", "ended by hand");
    t.close();
    expect(moveLane(f.opts())).toMatchObject({ moved: true });
  });
});

describe("formatLike", () => {
  test("keeps an indent unit and the trailing newline, or their absence", () => {
    const v = { a: 1, b: [2] };
    expect(formatLike('{\n  "a": 0\n}\n', v)).toBe(`${JSON.stringify(v, null, 2)}\n`);
    expect(formatLike('{\n\t"a": 0\n}', v)).toBe(JSON.stringify(v, null, "\t"));
    expect(formatLike('{"a":0}', v)).toBe('{"a":1,"b":[2]}');
  });
});

describe("the CLI", () => {
  test("config-store.ts move-lane moves and pins, and says what to do about idle", async () => {
    const f = fixture();
    const db = join(f.runsDir, "config.sqlite");
    f.store.close();
    const proc = Bun.spawn({
      cmd: [process.execPath, join(import.meta.dir, "..", "src", "config-store.ts"), "move-lane", RUN_ID, T1, "--pin", "--note", "two words", "--db", db, "--runs-dir", f.runsDir, "--actor", "operator"],
      env: { ...process.env, WRATHBENCH_RUNS_DIR: "/nonexistent" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const err = await new Response(proc.stderr).text();
    expect(await proc.exited).toBe(0);
    expect(err).toContain(`moved ${RUN_ID}: ${T2} -> ${T1}`);
    expect(err).toContain(`pinned roster/son to ${T1}`);
    expect(err).toContain('patch it back to "unlimited"');
    expect(readMeta(f.dir)!.laneHistory).toMatchObject([{ from: T2, to: T1, actor: "operator", note: "two words" }]);
    const after = new ConfigStore(db, { env: {} });
    expect(after.get("roster/son")).toMatchObject({ subscription: T1 });
    after.close();
  });

  test("a refusal exits 1 with the reason, and no --note is a usage error", async () => {
    const f = fixture();
    const db = join(f.runsDir, "config.sqlite");
    f.store.close();
    const run = async (args: string[]): Promise<{ code: number; err: string }> => {
      const proc = Bun.spawn({ cmd: [process.execPath, join(import.meta.dir, "..", "src", "config-store.ts"), ...args, "--db", db, "--runs-dir", f.runsDir], stdout: "pipe", stderr: "pipe" });
      const err = await new Response(proc.stderr).text();
      return { code: await proc.exited, err };
    };
    const refused = await run(["move-lane", RUN_ID, "CODEX_HOME_2", "--note", "x"]);
    expect(refused).toMatchObject({ code: 1 });
    expect(refused.err).toContain("config-store: CODEX_HOME_2 is not a claude-code lane");
    expect((await run(["move-lane", RUN_ID, T1])).code).toBe(2);
    expect(existsSync(join(f.dir, "meta.json"))).toBe(true);
    expect(readMeta(f.dir)!.config.subscription).toBe(T2);
  });
});
