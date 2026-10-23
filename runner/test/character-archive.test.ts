/**
 * The character archive (GitHub issue #331, proposal 2): the run-directory
 * half against fixture runs, the game half against a fake `GameSide` that
 * plays the server's part of `.pdump write` and `.pdump load`.
 *
 * Pinned here:
 * - the manifest and its per-member sha256;
 * - what an archive leaves out and what it strikes (the session token,
 *   wherever older records still carry it);
 * - `--no-trajectory`;
 * - every refusal, each of which writes nothing;
 * - an import into an empty runs directory, which comes back paused and
 *   byte for byte;
 * - a round trip whose second export matches the first.
 */

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import {
  CharacterArchiveRefused,
  exportCharacter,
  importCharacter,
  readManifest,
  struck,
  type ExportOptions,
  type GameCharacter,
  type GameSide,
  type ImportOptions,
} from "../src/character-archive";
import { comparabilityOf } from "../src/comparability";
import { loadRunConfig, newSessionToken } from "../src/config";
import { readRunFact } from "../src/models";
import { HEARTBEAT_FILE, readMeta, Trajectory } from "../src/trajectory";
import { tarEnd, tarHeader, tarPadding, TarReader } from "../src/ustar";
import { ARCHIVE_DIR } from "../viewer/archive-dir";
import { tempDirs } from "./fixtures/temp-dirs";

const tempDir = tempDirs();

const RUN_ID = "fleet-son-freeplay-sonnet-20261023";
const NAME = "Brenna";
const GUID = 57;

/** The server, as far as the archive can tell: accounts, characters, and the core's pdump. */
class FakeGame implements GameSide {
  accounts = new Map<string, number>([
    ["RUNNER2", 2],
    ["RUNNER3", 3],
  ]);
  chars: GameCharacter[] = [];
  dumps = 0;
  loads: { dump: string; account: string; name: string; guid: number }[] = [];
  /** A fresh database's generator: the guid a load gets when the asked one is at or past it. */
  nextGuid: number | null = null;
  dumpText: (c: GameCharacter) => string = (c) =>
    `IMPORTANT NOTE: THIS DUMPFILE IS MADE FOR USE WITH THE 'PDUMP' COMMAND ONLY\n\nINSERT INTO \`characters\` VALUES ('${c.guid}','${c.accountId}','${c.name}','3','2','0','12');\n`;

  constructor(withCharacter = true) {
    if (withCharacter) this.chars.push({ guid: GUID, name: NAME, accountId: 2, account: "RUNNER2", online: false, level: 12 });
  }

  private named(id: number): string | null {
    for (const [k, v] of this.accounts) if (v === id) return k;
    return null;
  }

  async characterByName(name: string): Promise<GameCharacter | null> {
    const c = this.chars.find((x) => x.name.toLowerCase() === name.toLowerCase());
    return c === undefined ? null : { ...c, account: this.named(c.accountId) };
  }
  async characterByGuid(guid: number): Promise<GameCharacter | null> {
    const c = this.chars.find((x) => x.guid === guid);
    return c === undefined ? null : { ...c, account: this.named(c.accountId) };
  }
  async accountId(account: string): Promise<number | null> {
    return this.accounts.get(account.toUpperCase()) ?? null;
  }
  async dump(name: string): Promise<string> {
    this.dumps++;
    const c = this.chars.find((x) => x.name === name);
    if (c === undefined) throw new Error("Player not found!");
    return this.dumpText(c);
  }
  async load(dump: string, account: string, name: string, guid: number): Promise<void> {
    this.loads.push({ dump, account, name, guid });
    const id = this.accounts.get(account)!;
    const got = this.nextGuid ?? guid;
    this.chars.push({ guid: got, name, accountId: id, account, online: false, level: 12 });
  }
}

interface Run {
  runsDir: string;
  dir: string;
  token: string;
  out: string;
}

/**
 * A paused claude-code freeplay run on RUNNER2 playing Brenna. Older records
 * still carry its session token (a trajectory line, run.sqlite's config_json),
 * as every run recorded before the token stopped reaching the record does.
 */
function fixture(o: { pause?: boolean; character?: boolean } = {}): Run {
  const runsDir = tempDir("wb-char-runs-");
  const out = tempDir("wb-char-out-");
  const dir = join(runsDir, RUN_ID);
  const token = newSessionToken();
  const t = new Trajectory(dir);
  const config = loadRunConfig({
    runId: RUN_ID,
    token,
    driver: "claude-code",
    model: "sonnet",
    episode: "freeplay",
    runsDir,
    moduleUrl: "http://127.0.0.1:9",
    account: "RUNNER2",
    ...(o.character === false ? {} : { character: NAME }),
    race: 3,
    class: 2,
  });
  t.writeMeta({ runId: RUN_ID, harnessVersion: "harness-0.5-1", startedAt: Date.now() - 3_600_000, config, comparability: comparabilityOf(config, "harness-0.5-1") });
  t.append({ t: "response", text: "…" });
  if (o.pause !== false) t.setPause(RUN_ID, "operator-pause", "SIGTERM: supervisor stop", 58 * 3_600_000);
  t.close();
  appendFileSync(join(dir, "trajectory.jsonl"), `${JSON.stringify({ t: "meta", ts: 1, config: { token } })}\n`);
  const db = new Database(join(dir, "run.sqlite"));
  db.query("UPDATE run SET config_json = ? WHERE run_id = ?").run(JSON.stringify({ token, model: "sonnet" }), RUN_ID);
  db.close();
  writeFileSync(join(dir, "scratchpad.md"), "# notes\nsell the linen at Goldshire\n");
  writeFileSync(join(dir, "episodic.jsonl"), `${JSON.stringify({ at: 1, text: "Hogger is up the road" })}\n`);
  writeFileSync(join(dir, "client-cache.json"), "{}\n");
  writeFileSync(join(dir, "claude-mcp.json"), `{"mcpServers":{"wrathbench":{"command":"/usr/local/bin/bun"}}}\n`);
  mkdirSync(join(dir, "claude-config", "backups"), { recursive: true });
  mkdirSync(join(dir, "claude-config", "projects", "-tmp-wrathbench-claude-AbC123"), { recursive: true });
  writeFileSync(join(dir, "claude-config", ".claude.json"), `{"userID":"${"ab".repeat(32)}"}\n`);
  writeFileSync(join(dir, "claude-config", "backups", ".claude.json.backup.1"), "{}\n");
  writeFileSync(join(dir, "claude-config", "projects", "-tmp-wrathbench-claude-AbC123", "s.jsonl"), '{"type":"user"}\n');
  // A cold heartbeat: a runner that died long ago. It reads as no owner, and is never archived.
  writeFileSync(join(dir, HEARTBEAT_FILE), "pid 1\n");
  const cold = new Date(Date.now() - 3_600_000);
  utimesSync(join(dir, HEARTBEAT_FILE), cold, cold);
  if (o.pause === false) utimesSync(join(dir, "trajectory.jsonl"), cold, cold);
  return { runsDir, dir, token, out };
}

const exportOpts = (r: Run, game: GameSide, over: Partial<ExportOptions> = {}): ExportOptions => ({
  runsDir: r.runsDir,
  runId: RUN_ID,
  file: join(r.out, `${RUN_ID}.tar.gz`),
  trajectory: true,
  game,
  env: {},
  exportedWith: "harness-0.5-9",
  ...over,
});

/** Every member of an archive, by path, as bytes. */
function members(file: string): Map<string, Buffer> {
  let bytes: Uint8Array = readFileSync(file);
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) bytes = gunzipSync(bytes);
  const out = new Map<string, Buffer>();
  let path = "";
  let parts: Buffer[] = [];
  const r = new TarReader({
    entry: (e) => {
      path = e.path;
      parts = [];
    },
    data: (c) => {
      parts.push(Buffer.from(c));
    },
    close: () => {
      out.set(path, Buffer.concat(parts));
    },
  });
  r.push(bytes);
  r.finish();
  return out;
}

const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

/** Every file under `dir`, relative, sorted. */
function tree(dir: string, rel = ""): string[] {
  const out: string[] = [];
  for (const n of readdirSync(join(dir, rel)).sort()) {
    const r = rel === "" ? n : `${rel}/${n}`;
    if (statSync(join(dir, r)).isDirectory()) out.push(...tree(dir, r));
    else out.push(r);
  }
  return out;
}

async function refusal(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(CharacterArchiveRefused);
    return (e as Error).message;
  }
  throw new Error("expected a refusal");
}

describe("export", () => {
  test("writes the manifest, the dump and the run directory, with a sha256 per member that matches", async () => {
    const r = fixture();
    const game = new FakeGame();
    const res = await exportCharacter(exportOpts(r, game, { now: () => Date.UTC(2026, 9, 23, 10, 15) }));
    expect(res.file).toBe(join(r.out, `${RUN_ID}.tar.gz`));
    const m = res.manifest;
    expect(m).toMatchObject({
      format: "wrathbench-character-archive",
      version: 1,
      runId: RUN_ID,
      model: "sonnet",
      driver: "claude-code",
      episode: "freeplay",
      harnessVersion: "harness-0.5-1",
      exportedWith: "harness-0.5-9",
      exportedAt: "2026-10-23T10:15:00.000Z",
      state: "paused",
      reason: "operator-pause",
      character: { name: NAME, guid: GUID, account: "RUNNER2", level: 12 },
      trajectory: true,
    });
    const got = members(res.file);
    expect([...got.keys()]).toEqual(["manifest.json", ...m.members.map((x) => x.path)]);
    expect(JSON.parse(got.get("manifest.json")!.toString("utf8"))).toEqual(m);
    for (const x of m.members) {
      expect(got.get(x.path)!.length).toBe(x.size);
      expect(sha(got.get(x.path)!)).toBe(x.sha256);
    }
    expect(m.members.map((x) => x.path)).toEqual([
      "character.pdump",
      "run/meta.json",
      "run/claude-config/.claude.json",
      "run/claude-config/projects/-tmp-wrathbench-claude-AbC123/s.jsonl",
      "run/client-cache.json",
      "run/episodic.jsonl",
      "run/run.sqlite",
      "run/scratchpad.md",
      "run/trajectory.jsonl",
    ]);
    expect(got.get("character.pdump")!.toString("utf8")).toContain("INSERT INTO `characters`");
    expect(game.dumps).toBe(1);
    // Unchanged where nothing needed striking.
    expect(got.get("run/scratchpad.md")!.equals(readFileSync(join(r.dir, "scratchpad.md")))).toBe(true);
    // The run directory itself is untouched.
    expect(readMeta(r.dir)!.config.token).toBe(r.token);
  });

  test("carries no session token: dropped from meta.json, struck from the older records and the sqlite copy", async () => {
    const r = fixture();
    const res = await exportCharacter(exportOpts(r, new FakeGame()));
    const got = members(res.file);
    for (const [path, bytes] of got) expect([path, bytes.includes(r.token)]).toEqual([path, false]);
    const meta = JSON.parse(got.get("run/meta.json")!.toString("utf8")) as { config: Record<string, unknown> };
    expect("token" in meta.config).toBe(false);
    expect(meta.config["character"]).toBe(NAME);
    expect(got.get("run/trajectory.jsonl")!.toString("utf8")).toContain('"config":{"token":"[redacted]"}');
    const copy = join(tempDir("wb-char-sql-"), "run.sqlite");
    writeFileSync(copy, got.get("run/run.sqlite")!);
    const db = new Database(copy, { readonly: true });
    const row = db.query("SELECT config_json, pause_reason FROM run WHERE run_id = ?").get(RUN_ID) as { config_json: string; pause_reason: string };
    db.close();
    expect(JSON.parse(row.config_json)).toEqual({ token: "[redacted]", model: "sonnet" });
    expect(row.pause_reason).toBe("operator-pause");
  });

  test("--no-trajectory leaves trajectory.jsonl out, and only that", async () => {
    const r = fixture();
    const full = await exportCharacter(exportOpts(r, new FakeGame()));
    const lean = await exportCharacter(exportOpts(r, new FakeGame(), { trajectory: false, file: join(r.out, "lean.tar") }));
    expect(lean.manifest.trajectory).toBe(false);
    expect(lean.manifest.members.map((x) => x.path)).toEqual(full.manifest.members.map((x) => x.path).filter((p) => p !== "run/trajectory.jsonl"));
    // .tar is written plain.
    expect(readFileSync(lean.file).subarray(257, 262).toString("latin1")).toBe("ustar");
  });

  test("an ended run exports as ended", async () => {
    const r = fixture();
    const t = new Trajectory(r.dir);
    t.setTermination(RUN_ID, "manual", "operator");
    t.close();
    const res = await exportCharacter(exportOpts(r, new FakeGame()));
    expect(res.manifest).toMatchObject({ state: "ended", reason: "manual" });
  });

  describe("refuses, writing nothing", () => {
    async function expectRefused(r: Run, game: GameSide, over: Partial<ExportOptions>, pattern: RegExp): Promise<void> {
      const before = readdirSync(r.out);
      expect(await refusal(exportCharacter(exportOpts(r, game, over)))).toMatch(pattern);
      expect(readdirSync(r.out)).toEqual(before);
    }

    test("a run with a live owner, or with no verdict", async () => {
      const live = fixture();
      writeFileSync(join(live.dir, HEARTBEAT_FILE), "pid 2\n");
      await expectRefused(live, new FakeGame(), {}, /live owner/);
      await expectRefused(fixture({ pause: false }), new FakeGame(), {}, /neither paused nor ended/);
    });

    test("an archived run, a missing run, a run with no character", async () => {
      const r = fixture();
      mkdirSync(join(r.runsDir, ARCHIVE_DIR));
      renameSync(r.dir, join(r.runsDir, ARCHIVE_DIR, RUN_ID));
      await expectRefused(r, new FakeGame(), {}, /archived/);
      await expectRefused(r, new FakeGame(), { runId: "fleet-nope" }, /no meta.json/);
      await expectRefused(r, new FakeGame(), { runId: "../x" }, /not a run id/);
      await expectRefused(fixture({ character: false }), new FakeGame(), {}, /named no character/);
    });

    test("a character the database lacks, has on another account, or has online", async () => {
      await expectRefused(fixture(), new FakeGame(false), {}, /has no Brenna/);
      const moved = new FakeGame();
      moved.chars[0]!.accountId = 3;
      await expectRefused(fixture(), moved, {}, /on account RUNNER3, but the run records RUNNER2/);
      const online = new FakeGame();
      online.chars[0]!.online = true;
      await expectRefused(fixture(), online, {}, /online/);
      expect(online.dumps).toBe(0);
    });

    test("a credential: a credential store, a known value from the environment, a credential shape — named, never shown", async () => {
      const store = fixture();
      writeFileSync(join(store.dir, "claude-config", ".credentials.json"), "{}");
      await expectRefused(store, new FakeGame(), {}, /claude-config\/\.credentials\.json is a credential store/);

      const known = fixture();
      const secret = "oat01-Zq3vR8kP2mX7wN4tB9yH6cJ1";
      appendFileSync(join(known.dir, "scratchpad.md"), `pasted: ${secret}\n`);
      const game = new FakeGame();
      const msg = await refusal(exportCharacter(exportOpts(known, game, { env: { CLAUDE_CODE_OAUTH_TOKEN: secret } })));
      expect(msg).toMatch(/run\/scratchpad\.md: known:CLAUDE_CODE_OAUTH_TOKEN/);
      expect(msg).not.toContain(secret);
      expect(game.dumps).toBe(0);

      const shape = fixture();
      appendFileSync(join(shape.dir, "episodic.jsonl"), `${JSON.stringify({ text: "sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAA" })}\n`);
      await expectRefused(shape, new FakeGame(), {}, /run\/episodic\.jsonl: anthropic-key/);
    });

    test("an archive that exists, or a name that says neither tar nor tar.gz", async () => {
      const r = fixture();
      writeFileSync(join(r.out, "x.tar.gz"), "keep me");
      await expectRefused(r, new FakeGame(), { file: join(r.out, "x.tar.gz") }, /never overwritten/);
      expect(readFileSync(join(r.out, "x.tar.gz"), "utf8")).toBe("keep me");
      await expectRefused(r, new FakeGame(), { file: join(r.out, "x.zip") }, /\.tar\.gz/);
    });
  });
});

describe("struck", () => {
  test("strikes a token split across any chunk boundary, and nothing else", () => {
    const token = "0123456789abcdef0123456789abcdef";
    const text = `a${token}b${token}${token}c`;
    const bytes = Buffer.from(text);
    for (let size = 1; size <= bytes.length; size++) {
      const chunks: Uint8Array[] = [];
      for (let at = 0; at < bytes.length; at += size) chunks.push(bytes.subarray(at, at + size));
      expect(Buffer.concat([...struck(chunks[Symbol.iterator](), token)]).toString()).toBe("a[redacted]b[redacted][redacted]c");
    }
    expect(Buffer.concat([...struck([bytes][Symbol.iterator](), null)]).toString()).toBe(text);
  });
});

describe("import", () => {
  async function exported(over: Partial<ExportOptions> = {}): Promise<{ r: Run; file: string }> {
    const r = fixture();
    const res = await exportCharacter(exportOpts(r, new FakeGame(), over));
    return { r, file: res.file };
  }
  const importOpts = (file: string, runsDir: string, game: GameSide, over: Partial<ImportOptions> = {}): ImportOptions => ({
    file,
    runsDir,
    game,
    actor: "operator",
    note: "restore after the db loss",
    now: () => 1_761_000_000_000,
    ...over,
  });

  test("into an empty runs directory: the run under its own id, paused, every member byte for byte, the character loaded as it was", async () => {
    const { r, file } = await exported();
    const runsDir = join(tempDir("wb-char-dest-"), "runs");
    const game = new FakeGame(false);
    const res = await importCharacter(importOpts(file, runsDir, game));
    expect(res).toMatchObject({ runId: RUN_ID, dir: join(runsDir, RUN_ID), account: "RUNNER2", guid: GUID, warnings: [] });
    expect(game.loads).toHaveLength(1);
    expect(game.loads[0]).toMatchObject({ account: "RUNNER2", name: NAME, guid: GUID });
    expect(game.loads[0]!.dump).toContain("INSERT INTO `characters`");
    expect(readdirSync(runsDir)).toEqual([RUN_ID]);

    const dir = res.dir;
    expect(tree(dir)).toEqual(tree(r.dir).filter((p) => p !== HEARTBEAT_FILE && p !== "claude-mcp.json" && !p.startsWith("claude-config/backups/")));
    const got = members(file);
    for (const p of tree(dir)) expect([p, sha(readFileSync(join(dir, p)))]).toEqual([p, p === "meta.json" ? sha(readFileSync(join(dir, p))) : sha(got.get(`run/${p}`)!)]);
    // Modification times come back too: a last-activity read off the trajectory is still the run's own.
    expect(Math.floor(statSync(join(dir, "trajectory.jsonl")).mtimeMs / 1000)).toBe(Math.floor(statSync(join(r.dir, "trajectory.jsonl")).mtimeMs / 1000));

    const meta = readMeta(dir)!;
    expect(meta.config.token).toBeUndefined();
    expect(meta.config.account).toBe("RUNNER2");
    expect(meta.config.character).toBe(NAME);
    expect(meta.imports).toEqual([
      {
        at: 1_761_000_000_000,
        actor: "operator",
        note: "restore after the db loss",
        archive: `${RUN_ID}.tar.gz`,
        exportedAt: res.manifest.exportedAt,
        exportedWith: "harness-0.5-9",
        from: { account: "RUNNER2", guid: GUID },
        to: { account: "RUNNER2", guid: GUID },
      },
    ]);
    const fact = readRunFact(runsDir, RUN_ID)!;
    expect(fact.pause?.reason).toBe("operator-pause");
    expect(fact.live).toBe(false);
    expect(fact.account).toBe("RUNNER2");
    expect(fact.character).toBe(NAME);
  });

  test("onto another account, and with the guid the server gave instead of the one asked for", async () => {
    const { file } = await exported();
    const runsDir = tempDir("wb-char-dest-");
    const game = new FakeGame(false);
    game.nextGuid = 3;
    const res = await importCharacter(importOpts(file, runsDir, game, { account: "runner3" }));
    expect(res.account).toBe("RUNNER3");
    expect(res.guid).toBe(3);
    expect(game.loads[0]).toMatchObject({ account: "RUNNER3", guid: GUID });
    expect(res.warnings.join("\n")).toMatch(/came back as guid 3, not 57/);
    expect(res.warnings.join("\n")).toMatch(/moved from account RUNNER2 to RUNNER3/);
    const meta = readMeta(res.dir)!;
    expect(meta.config.account).toBe("RUNNER3");
    expect(meta.imports![0]).toMatchObject({ from: { account: "RUNNER2", guid: GUID }, to: { account: "RUNNER3", guid: 3 } });
  });

  test("a --no-trajectory archive restores a run without its trajectory, still paused", async () => {
    const { file } = await exported({ trajectory: false });
    const runsDir = tempDir("wb-char-dest-");
    const res = await importCharacter(importOpts(file, runsDir, new FakeGame(false)));
    expect(existsSync(join(res.dir, "trajectory.jsonl"))).toBe(false);
    expect(readRunFact(runsDir, RUN_ID)!.pause?.reason).toBe("operator-pause");
  });

  test("a round trip: export, import, export again — every member the same but meta.json, which gained the import", async () => {
    const { file } = await exported();
    const runsDir = tempDir("wb-char-dest-");
    const game = new FakeGame(false);
    await importCharacter(importOpts(file, runsDir, game));
    const again = await exportCharacter({ ...exportOpts({ runsDir, dir: "", token: "", out: tempDir("wb-char-out2-") }, game) });
    const first = (await readManifest(file)).members;
    const second = again.manifest.members;
    expect(second.map((x) => x.path)).toEqual(first.map((x) => x.path));
    for (const [i, x] of second.entries()) {
      if (x.path === "run/meta.json" || x.path === "run/run.sqlite") continue;
      expect([x.path, x.sha256]).toEqual([first[i]!.path, first[i]!.sha256]);
    }
    // The database is the same rows; its file need not be the same bytes.
    const a = members(file).get("run/run.sqlite")!;
    const b = members(again.file).get("run/run.sqlite")!;
    const rows = (bytes: Buffer): unknown => {
      const p = join(tempDir("wb-char-rows-"), "r.sqlite");
      writeFileSync(p, bytes);
      const db = new Database(p, { readonly: true });
      const out = db.query("SELECT * FROM run").all();
      db.close();
      return out;
    };
    expect(rows(b)).toEqual(rows(a));
    expect(again.manifest.character).toEqual((await readManifest(file)).character);
  });

  describe("refuses, writing nothing and loading nothing", () => {
    async function expectRefused(file: string, runsDir: string, game: FakeGame, over: Partial<ImportOptions>, pattern: RegExp): Promise<void> {
      const before = existsSync(runsDir) ? tree(runsDir) : [];
      expect(await refusal(importCharacter(importOpts(file, runsDir, game, over)))).toMatch(pattern);
      expect(existsSync(runsDir) ? tree(runsDir) : []).toEqual(before);
      if (existsSync(runsDir)) expect(readdirSync(runsDir).filter((n) => n.startsWith("+"))).toEqual([]);
      expect(game.loads).toEqual([]);
    }

    test("a run id that exists, in the runs directory or archived", async () => {
      const { r, file } = await exported();
      await expectRefused(file, r.runsDir, new FakeGame(false), {}, /exists under/);
      const runsDir = tempDir("wb-char-dest-");
      mkdirSync(join(runsDir, ARCHIVE_DIR, RUN_ID), { recursive: true });
      await expectRefused(file, runsDir, new FakeGame(false), {}, /exists under archive\//);
    });

    test("an account that does not exist; a name or guid that does", async () => {
      const { file } = await exported();
      await expectRefused(file, tempDir("wb-char-dest-"), new FakeGame(false), { account: "NOBODY" }, /account NOBODY does not exist/);
      await expectRefused(file, tempDir("wb-char-dest-"), new FakeGame(true), {}, /a character named Brenna exists/);
      const guidTaken = new FakeGame(false);
      guidTaken.chars.push({ guid: GUID, name: "Other", accountId: 3, account: "RUNNER3", online: false, level: 1 });
      await expectRefused(file, tempDir("wb-char-dest-"), guidTaken, {}, /guid 57 is taken \(Other/);
    });

    test("a member that does not match the manifest, one it does not list, and one it lists that is missing", async () => {
      const { r } = await exported();
      const plain = join(r.out, "plain.tar");
      await exportCharacter(exportOpts(r, new FakeGame(), { file: plain }));
      const bytes = readFileSync(plain);

      const damaged = Buffer.from(bytes);
      const at = damaged.indexOf("sell the linen");
      damaged[at] = "S".charCodeAt(0);
      writeFileSync(join(r.out, "damaged.tar"), damaged);
      await expectRefused(join(r.out, "damaged.tar"), tempDir("wb-char-dest-"), new FakeGame(false), {}, /run\/scratchpad\.md does not match its sha256/);

      const all = members(plain);
      const rebuild = (drop: string | null, extra: [string, Buffer] | null): Buffer => {
        const parts: Uint8Array[] = [];
        for (const [path, body] of [...all, ...(extra === null ? [] : [extra])]) {
          if (path === drop) continue;
          parts.push(tarHeader({ path, size: body.length, mode: 0o644, mtime: 0 }), body, tarPadding(body.length));
        }
        parts.push(tarEnd());
        return Buffer.concat(parts);
      };
      writeFileSync(join(r.out, "extra.tar"), rebuild(null, ["run/planted.sh", Buffer.from("echo hi\n")]));
      await expectRefused(join(r.out, "extra.tar"), tempDir("wb-char-dest-"), new FakeGame(false), {}, /run\/planted\.sh is in the archive but not in its manifest/);
      writeFileSync(join(r.out, "short.tar"), rebuild("run/episodic.jsonl", null));
      await expectRefused(join(r.out, "short.tar"), tempDir("wb-char-dest-"), new FakeGame(false), {}, /lists run\/episodic\.jsonl, which the archive does not hold/);
      writeFileSync(join(r.out, "junk.tar.gz"), "not an archive at all");
      await expectRefused(join(r.out, "junk.tar.gz"), tempDir("wb-char-dest-"), new FakeGame(false), {}, /junk\.tar\.gz/);
    });
  });
});
