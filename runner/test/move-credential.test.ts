/**
 * `move-credential`: a paused run moved to another credential of its provider
 * (GitHub issue #331, proposal 1; credentials since #429). Pinned here: every
 * refusal writes nothing; the rewrite keeps meta.json's own format and mode
 * bits and appends to `credentialHistory`; a resume reads the new credential
 * back; and with `--pin` the roster pin is written only after meta.json
 * already names the new credential.
 */

import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { comparabilityOf } from "../src/comparability";
import { loadRunConfig, newSessionToken } from "../src/config";
import { ConfigRejected, ConfigStore } from "../src/config-store";
import { CredentialMoveRefused, CredentialPinFailed, formatLike, moveCredential, type MoveCredentialOptions } from "../src/move-credential";
import { HEARTBEAT_FILE, readMeta, Trajectory, type RunMeta } from "../src/trajectory";
import { ARCHIVE_DIR } from "../viewer/archive-dir";
import { tempDirs } from "./fixtures/temp-dirs";

const tempDir = tempDirs();

const RUN_ID = "fleet-son-freeplay-sonnet-20261023";
const T1 = "CLAUDE_CODE_OAUTH_TOKEN";
const T2 = "CLAUDE_CODE_OAUTH_TOKEN_2";
const C1 = "claude-1";
const C2 = "claude-2";

const CREDENTIALS = {
  [C1]: { provider: "claude", secretEnv: T1, slots: 1, budget: { kind: "usage", scoredMaxPct: 70 }, billing: "paid", enabled: true },
  [C2]: { provider: "claude", secretEnv: T2, slots: 1, billing: "paid", enabled: true },
  "claude-off": { provider: "claude", secretEnv: "CLAUDE_CODE_OAUTH_TOKEN_3", slots: 1, billing: "paid", enabled: false },
  "chatgpt-1": { provider: "chatgpt", secretEnv: "CODEX_HOME", slots: 1, billing: "paid", enabled: true },
  "chatgpt-2": { provider: "chatgpt", secretEnv: "CODEX_HOME_2", slots: 1, billing: "paid", enabled: true },
  "or-free": { provider: "openrouter", secretEnv: "OPENROUTER_KEY", slots: 1, billing: "free", enabled: true },
};

function fleetDoc(son: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    _notes: ["n"],
    accounts: { pool: ["RUNNER", "RUNNER2"] },
    credentials: CREDENTIALS,
    roster: {
      glm: { tier: "t1", model: "z-ai/glm-5.2:free" },
      son: { tier: "t1", model: "sonnet", driver: "claude-code", idle: "unlimited", ...son },
      gpt: { tier: "t1", model: "gpt-5.5", driver: "codex" },
    },
    queue: [],
  };
}

interface Fixture {
  runsDir: string;
  dir: string;
  metaPath: string;
  store: ConfigStore;
  opts: (over?: Partial<MoveCredentialOptions>) => MoveCredentialOptions;
}

/**
 * A paused (or, with `pause: false`, verdict-less and cold) run of `driver`,
 * its meta.json rewritten by hand in a 4-space indent with mode 0664 — the
 * shape the hand move broke — and a store with `doc` seeded.
 */
function fixture(o: { driver?: string; model?: string; credential?: { id: string; env: string } | null; pause?: boolean; doc?: Record<string, unknown> } = {}): Fixture {
  const runsDir = tempDir("wrathbench-move-credential-");
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
    ...(o.credential === null ? {} : { credential: (o.credential ?? { id: C2 }).id, credentialEnv: (o.credential ?? { env: T2 }).env }),
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
  store.seed(o.doc ?? fleetDoc({ credential: C2 }));
  return {
    runsDir,
    dir,
    metaPath,
    store,
    opts: (over = {}) => ({ runsDir, runId: RUN_ID, to: C1, pin: true, actor: "operator", note: "claude-2 is spent", store, env: {}, ...over }),
  };
}

/** The move refuses with `pattern`, and neither meta.json nor the store moved. */
function expectRefused(f: Fixture, over: Partial<MoveCredentialOptions>, pattern: RegExp): void {
  const meta = readFileSync(f.metaPath, "utf8");
  const version = f.store.version();
  let err: unknown;
  try {
    moveCredential(f.opts(over));
  } catch (e) {
    err = e;
  }
  expect(err).toBeInstanceOf(CredentialMoveRefused);
  expect((err as Error).message).toMatch(pattern);
  expect(readFileSync(f.metaPath, "utf8")).toBe(meta);
  expect(f.store.version()).toBe(version);
  expect(readdirSync(f.dir).filter((n) => n.endsWith(".tmp"))).toEqual([]);
}

describe("move-credential refuses, writing nothing", () => {
  test("a run with a live owner", () => {
    const f = fixture();
    writeFileSync(join(f.dir, HEARTBEAT_FILE), "host 1\n");
    expectRefused(f, {}, /has a live owner: its heartbeat is/);
  });

  test("a run with no verdict, which the fleet would resume as offline", () => {
    const f = fixture({ pause: false });
    expectRefused(f, {}, /neither paused nor ended/);
  });

  test("a credential the config does not hold, or one that is disabled", () => {
    const f = fixture();
    expectRefused(f, { to: "claude-9" }, /pinned credential claude-9 is not configured — nothing written/);
    expectRefused(f, { to: "claude-off" }, /pinned credential claude-off is disabled — nothing written/);
  });

  test("a credential of another provider than the run's", () => {
    const f = fixture();
    expectRefused(f, { to: "chatgpt-2" }, /chatgpt-2 is chatgpt's, and this model is served by claude/);
  });

  test("a codex run, whose credential is a home with the CLI's own threads", () => {
    const f = fixture({ driver: "codex", model: "gpt-5.5", credential: { id: "chatgpt-1", env: "CODEX_HOME" } });
    expectRefused(f, { to: "chatgpt-2", pin: false }, /^run \S+ is a codex run: its credential holds more than a secret/);
  });

  test("a run on an endpoint, whose credential is its key", () => {
    const f = fixture({ driver: "openai", model: "z-ai/glm-5.2:free", credential: { id: "or-free", env: "OPENROUTER_KEY" } });
    expectRefused(f, { pin: false }, /is a openai run, whose credential is its endpoint key/);
  });

  test("a run that records no credential, and the credential it is already on", () => {
    const f = fixture({ credential: null, doc: fleetDoc() });
    expectRefused(f, { to: C1, pin: false }, /records no credential .* nothing resumes it on one/);
    const pinned = fixture({ credential: { id: C1, env: T1 }, doc: fleetDoc({ credential: C1 }) });
    expectRefused(pinned, { to: C1 }, /already on claude-1 and roster\/son pins it — nothing written/);
  });

  test("without --pin, an entry that pins the old credential: the fleet would count one and bill another", () => {
    const f = fixture();
    expectRefused(f, { pin: false }, /roster\/son pins claude-2.*Pass --pin/);
  });

  test("--pin with no roster entry the run belongs to", () => {
    const f = fixture({ model: "opus", doc: fleetDoc() });
    expectRefused(f, {}, /--pin: no roster entry is run \S+'s \(model opus\)/);
  });

  test("a value that is not a credential id, and a move with no note", () => {
    const f = fixture();
    expectRefused(f, { to: "sk ant/oat01" }, /is not a credential id/);
    expectRefused(f, { note: "  " }, /needs --note/);
  });

  test("an archived run", () => {
    const f = fixture();
    mkdirSync(join(f.runsDir, ARCHIVE_DIR), { recursive: true });
    renameSync(f.dir, join(f.runsDir, ARCHIVE_DIR, RUN_ID));
    expect(() => moveCredential(f.opts())).toThrow(/is archived/);
  });
});

describe("the move", () => {
  test("rewrites meta.json atomically in its own format and mode, and appends to credentialHistory", () => {
    const f = fixture();
    const before = readFileSync(f.metaPath, "utf8");
    const was = JSON.parse(before) as RunMeta;
    const r = moveCredential(f.opts({ now: () => 1_700_000_000_000 }));
    expect(r).toMatchObject({ from: C2, to: C1, moved: true, pinned: "roster/son", ref: "son", history: 1, warnings: [] });

    const text = readFileSync(f.metaPath, "utf8");
    const meta = JSON.parse(text) as RunMeta;
    // Format: the file's own 4-space indent and trailing newline.
    expect(text).toBe(formatLike(before, meta));
    expect(text.startsWith('{\n    "runId"')).toBe(true);
    expect(text.endsWith("}\n")).toBe(true);
    // Mode: the group-write bit the hand edit lost.
    expect(statSync(f.metaPath).mode & 0o7777).toBe(0o664);
    // Only the credential, its variable, its thresholds and the history moved; key order is kept.
    expect(meta.config.credential).toBe(C1);
    expect(meta.config.credentialEnv).toBe(T1);
    expect(meta.config.usageMaxPct).toEqual({ scored: 70, freeplay: 80 });
    expect(meta.credentialHistory).toEqual([{ from: C2, to: C1, at: 1_700_000_000_000, actor: "operator", note: "claude-2 is spent" }]);
    const { credentialHistory: _h, ...rest } = meta;
    expect(rest).toEqual({ ...was, config: { ...was.config, credential: C1, credentialEnv: T1, usageMaxPct: { scored: 70, freeplay: 80 } } });
    expect(Object.keys(rest)).toEqual(Object.keys(was));
    expect(readdirSync(f.dir).filter((n) => n.endsWith(".tmp"))).toEqual([]);

    // A resume rebuilds the config from meta.json: it now bills the new
    // credential, and the resume's own rewrite (which spreads the stored meta)
    // keeps the record.
    expect(loadRunConfig(readMeta(f.dir)!.config).credentialEnv).toBe(T1);

    // A second move appends, and a credential with no usage budget carries no thresholds.
    const back = moveCredential(f.opts({ to: C2, note: "claude-1 now", now: () => 1_700_000_100_000 }));
    expect(back).toMatchObject({ from: C1, to: C2, history: 2, pinned: "roster/son" });
    const after = JSON.parse(readFileSync(f.metaPath, "utf8")) as RunMeta;
    expect(after.credentialHistory?.map((m) => `${m.from}>${m.to}`)).toEqual([`${C2}>${C1}`, `${C1}>${C2}`]);
    expect(after.config.usageMaxPct).toBeUndefined();
  });

  test("--pin writes the roster pin only after meta.json names the new credential, through the validated path", () => {
    const f = fixture();
    const order: string[] = [];
    const patch = f.store.patch.bind(f.store);
    f.store.patch = (key, partial, opts) => {
      order.push(`patch ${key}: meta says ${(JSON.parse(readFileSync(f.metaPath, "utf8")) as RunMeta).config.credential}`);
      patch(key, partial, opts);
    };
    moveCredential(f.opts());
    expect(order).toEqual([`patch roster/son: meta says ${C1}`]);
    expect(f.store.get("roster/son")).toMatchObject({ credential: C1, idle: "unlimited", model: "sonnet" });
    const audit = f.store.audit(1)[0]!;
    expect(audit).toMatchObject({ key: "roster/son", actor: "operator", note: `move-credential ${RUN_ID}: claude-2 is spent` });
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
    expect(() => moveCredential(f.opts())).toThrow(CredentialPinFailed);
    expect(() => moveCredential(f.opts())).toThrow(/^meta\.json already names claude-1, but roster\/son was not pinned: database is locked\. .*run the same command again/);
    expect(readMeta(f.dir)!.config.credential).toBe(C1);
    expect(f.store.get("roster/son")).toMatchObject({ credential: C2 });
    f.store.patch = patch;
    expect(moveCredential(f.opts())).toMatchObject({ moved: false, pinned: "roster/son", history: 1 });
    expect(f.store.get("roster/son")).toMatchObject({ credential: C1 });
  });

  test("a pin still owed after a partial move is applied by the same command, and meta.json is left alone", () => {
    const f = fixture({ credential: { id: C1, env: T1 } });
    const before = readFileSync(f.metaPath, "utf8");
    const r = moveCredential(f.opts({ to: C1 }));
    expect(r).toMatchObject({ moved: false, pinned: "roster/son", history: 0 });
    expect(readFileSync(f.metaPath, "utf8")).toBe(before);
    expect(f.store.get("roster/son")).toMatchObject({ credential: C1 });
  });

  test("without --pin, an entry that pins nothing: meta.json alone, the store untouched", () => {
    const f = fixture({ doc: fleetDoc() });
    const version = f.store.version();
    const r = moveCredential(f.opts({ pin: false }));
    expect(r).toMatchObject({ moved: true, pinned: null, ref: "son" });
    expect(f.store.version()).toBe(version);
    expect(readMeta(f.dir)!.config.credential).toBe(C1);
  });

  test("an ended run moves too", () => {
    const f = fixture();
    const t = new Trajectory(f.dir);
    t.setTermination(RUN_ID, "manual", "ended by hand");
    t.close();
    expect(moveCredential(f.opts())).toMatchObject({ moved: true });
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
  test("config-store.ts move-credential moves and pins, and says what to do about idle", async () => {
    const f = fixture();
    const db = join(f.runsDir, "config.sqlite");
    f.store.close();
    const proc = Bun.spawn({
      cmd: [process.execPath, join(import.meta.dir, "..", "src", "config-store.ts"), "move-credential", RUN_ID, C1, "--pin", "--note", "two words", "--db", db, "--runs-dir", f.runsDir, "--actor", "operator"],
      env: { ...process.env, WRATHBENCH_RUNS_DIR: "/nonexistent" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const err = await new Response(proc.stderr).text();
    expect(await proc.exited).toBe(0);
    expect(err).toContain(`moved ${RUN_ID}: ${C2} -> ${C1}`);
    expect(err).toContain(`pinned roster/son to ${C1}`);
    expect(err).toContain('patch it back to "unlimited"');
    expect(readMeta(f.dir)!.credentialHistory).toMatchObject([{ from: C2, to: C1, actor: "operator", note: "two words" }]);
    const after = new ConfigStore(db, { env: {} });
    expect(after.get("roster/son")).toMatchObject({ credential: C1 });
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
    const refused = await run(["move-credential", RUN_ID, "chatgpt-2", "--note", "x"]);
    expect(refused).toMatchObject({ code: 1 });
    expect(refused.err).toContain("config-store: pinned credential chatgpt-2 is chatgpt's");
    expect((await run(["move-credential", RUN_ID, C1])).code).toBe(2);
    expect(existsSync(join(f.dir, "meta.json"))).toBe(true);
    expect(readMeta(f.dir)!.config.credential).toBe(C2);
  });
});
