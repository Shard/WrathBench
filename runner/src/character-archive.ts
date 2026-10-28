/**
 * Export and import a durable character (GitHub issue #331, proposal 2;
 * docs/RUNBOOK.md, "Backing up and moving a character").
 *
 * A freeplay character is two halves that only make sense together. One is
 * the run directory: meta.json, run.sqlite, the trajectory, the scratchpad,
 * the episodic log, the driver's own state. The other is the character's rows
 * in the characters database. An archive holds both, so that a long-lived
 * character can be backed up before risky maintenance, moved to another host,
 * or restored after a database loss. Without it, any of those is a hand edit.
 *
 * **The archive** is one tar file, gzipped when its name ends in `.gz`.
 * Members, in this order:
 *
 * - `manifest.json`: the run id, model, effort, driver and episode; the
 *   character's name, guid, account and level; the harness build the run
 *   recorded and the one that exported it; when it was exported; the size
 *   and sha256 of every other member; and the mode bits of every directory
 *   in the run, so that an import restores them (and empty ones) rather than
 *   whatever the umask gives;
 * - `character.pdump`: the character's rows in AzerothCore's own player-dump
 *   format (`.pdump write`), so the core loads them back with its own code,
 *   which remaps item, mail, pet and equipment-set ids and tells its caches;
 * - `run/…`: the run directory.
 *
 * **What the run directory loses on the way in.** Never a credential:
 *
 * - meta.json's `config.token` is dropped. It is the module session's bearer.
 *   A resume with no token mints and persists a fresh one (`resolveSessionToken`).
 * - The same token is struck, wherever older records still carry it, from
 *   every other member. That is the copy-leaves-the-volume strike the collector
 *   and the viewer already make (`session-token.ts`). It is applied as bytes
 *   to text members and as SQL `replace()` on a copy of each sqlite file.
 * - The whole archive is then scanned with `SecretScanner`, matching every
 *   credential in this process's environment by value plus the credential
 *   shapes. Any finding refuses the export, and the refusal names only the
 *   member and the rule.
 * - A `.credentials.json` or `auth.json` anywhere is refused outright.
 * - Left out: the heartbeat (a copied fresh one would read as a live owner);
 *   temp files; `claude-config/backups/`; `claude-mcp.json`, which the CLI
 *   driver rewrites at every launch with the host's own paths; and sqlite
 *   journals. Each sqlite file is copied by `VACUUM INTO`, which folds any
 *   journal in.
 * - With `trajectory: false` (`--no-trajectory`), `trajectory.jsonl` too. That
 *   gives a small archive that can only continue the character, not reproduce
 *   its record.
 *
 * Export reads the run twice: once to size, hash and scan each member, and
 * once to write it. A member that hashes differently the second time was
 * changed under the export, which is refused, so no reader of the archive
 * ever sees a member that does not match its manifest. Nothing is held in
 * memory but a chunk, because a trajectory can run to hundreds of megabytes.
 *
 * **Refusals.** Export refuses a run with a live owner (`liveOwnerOf`, the
 * check `--resume` makes) or with no verdict (a run that is neither paused nor
 * ended is resumed as `offline` on the fleet's next tick); an archived run; a
 * run that has named no character; a character the database does not have, or
 * has on another account, or has online.
 *
 * Import refuses, writing nothing:
 * - a run id that exists, in the runs directory or under `archive/`;
 * - an account that does not exist;
 * - a character name or guid that exists, which also covers a soft-deleted
 *   character;
 * - any member whose size or sha256 differs from the manifest, and any member
 *   the manifest does not list or lists but the archive lacks.
 *
 * **Import order.** The run directory is extracted into a staging directory
 * in the runs directory. Its name starts with `+`, which no run id may, so no
 * reader of the runs directory takes it for a run. The character is then
 * loaded, read back, and checked. Only then is meta.json rewritten:
 * `config.account` changes when `account` names another account, and the
 * import is appended to its `imports`. Last, the staging directory is renamed
 * into place.
 *
 * The run keeps its id, because it is the same character continuing. It comes
 * back exactly as it left: paused (or ended), never resumed by this. Whether
 * the fleet resumes it is the roster's `idle`, as for any paused run.
 */

import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { once } from "node:events";
import {
  chmodSync,
  closeSync,
  createReadStream,
  createWriteStream,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
  writeSync,
  type WriteStream,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { finished } from "node:stream/promises";
import { createGunzip, createGzip, type Gzip } from "node:zlib";
import { z } from "zod";
import { ARCHIVE_DIR } from "../viewer/archive-dir";
import { DEFAULT_DRIVER } from "./drivers";
import { liveOwnerOf, readRunFact } from "./models";
import { formatLike } from "./move-lane";
import { REDACTED } from "@wrathbench/mcp/redact";
import { describeFindings, envSecrets, SecretScanner, type KnownSecret } from "./secret-scan";
import { strikableSessionToken } from "./session-token";
import { HEARTBEAT_FILE, type CharacterImport } from "./trajectory";
import { isSafeMemberPath, tarEnd, tarHeader, tarPadding, TarReader, type TarEntry, type TarHandler } from "./ustar";

export const ARCHIVE_FORMAT = "wrathbench-character-archive";
export const MANIFEST_MEMBER = "manifest.json";
export const PDUMP_MEMBER = "character.pdump";
export const RUN_PREFIX = "run/";

/** A run id, as every reader of the runs directory accepts one (`models.ts`, `viewer/runs.ts`). */
const RUN_ID = /^[A-Za-z0-9._-]+$/;
const CHUNK = 1 << 20;
/** Characters of the previous window rescanned with each new one, so a secret split across two chunks is still seen. */
const SCAN_OVERLAP = 4096;
const MAX_MANIFEST_BYTES = 16 << 20;
const MAX_PDUMP_BYTES = 256 << 20;
/** A file anywhere in a run directory whose name says it is a credential store. */
const CREDENTIAL_FILES = new Set([".credentials.json", "auth.json"]);

/** Refused before anything was written. */
export class CharacterArchiveRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CharacterArchiveRefused";
  }
}

/** The character was loaded into the game, and the run directory did not land: the message says what is where. */
export class CharacterImportIncomplete extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CharacterImportIncomplete";
  }
}

// ------------------------------------------------------------- game side

/** A character as the characters database holds it. */
export interface GameCharacter {
  guid: number;
  name: string;
  accountId: number;
  /** The account's username, or null when the auth database has no such account. */
  account: string | null;
  online: boolean;
  level: number | null;
}

/**
 * The game half: lookups, and the core's own player dump. The real one
 * (`infra/character-archive.ts`) reads the databases and runs `.pdump` over
 * SOAP; the tests hand in a fake. Dumps are text, never server paths, so
 * nothing on this side knows how the file reached the server.
 */
export interface GameSide {
  characterByName(name: string): Promise<GameCharacter | null>;
  /** Any row with this guid, a soft-deleted character's included. */
  characterByGuid(guid: number): Promise<GameCharacter | null>;
  /** The account's id, or null when it does not exist. */
  accountId(account: string): Promise<number | null>;
  /**
   * The character's rows, as `.pdump write` writes them. Bytes, never text:
   * a column that is not valid UTF-8 must load back as it was dumped.
   */
  dump(name: string): Promise<Uint8Array>;
  /** `.pdump load` onto `account` as `name`, asking for `guid`. */
  load(dump: Uint8Array, account: string, name: string, guid: number): Promise<void>;
}

// --------------------------------------------------------------- manifest

const MemberSchema = z.object({
  path: z.string().min(1),
  size: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  mode: z.number().int().min(0).max(0o7777),
});

const DirectorySchema = z.object({
  /** `run`, or a directory under it. */
  path: z.string().min(1),
  mode: z.number().int().min(0).max(0o7777),
});

const ManifestSchema = z.object({
  format: z.literal(ARCHIVE_FORMAT),
  version: z.literal(1),
  runId: z.string().regex(RUN_ID),
  model: z.string(),
  effort: z.string().nullable(),
  driver: z.string(),
  episode: z.string(),
  /** The harness build the run recorded (meta.json's `harnessVersion`). */
  harnessVersion: z.string().nullable(),
  /** The harness build that wrote the archive. */
  exportedWith: z.string(),
  exportedAt: z.string(),
  state: z.enum(["paused", "ended"]),
  /** The pause reason, or the termination reason. */
  reason: z.string(),
  character: z.object({
    name: z.string().min(1),
    guid: z.number().int().positive(),
    account: z.string().min(1),
    level: z.number().int().nullable(),
  }),
  trajectory: z.boolean(),
  /** Every member but the manifest itself, in archive order. */
  members: z.array(MemberSchema),
  /** Every directory of the run, the run directory itself first, with its mode bits: a tar of files alone would lose both. */
  directories: z.array(DirectorySchema),
});

export type Manifest = z.infer<typeof ManifestSchema>;
export type ManifestMember = z.infer<typeof MemberSchema>;
export type ManifestDirectory = z.infer<typeof DirectorySchema>;

// ---------------------------------------------------------------- export

export interface ExportOptions {
  runsDir: string;
  runId: string;
  /** The archive to write: `.tar.gz` (or `.tgz`) is gzipped, `.tar` is not. Must not exist. */
  file: string;
  /** Include trajectory.jsonl (false: `--no-trajectory`). */
  trajectory: boolean;
  game: GameSide;
  /** Whose credentials the scan matches by value: this process's environment. */
  env: Record<string, string | undefined>;
  /** The harness build doing the export. */
  exportedWith: string;
  now?: () => number;
}

export interface ExportResult {
  file: string;
  manifest: Manifest;
  /** The archive's size on disk. */
  bytes: number;
}

/** One member to be: where its bytes come from, and how they change on the way. */
interface Source {
  path: string;
  mode: number;
  mtime: number;
  /** The member's bytes, struck. Called once per pass. */
  chunks: () => Generator<Uint8Array>;
}

export async function exportCharacter(o: ExportOptions): Promise<ExportResult> {
  const now = o.now ?? Date.now;
  if (!RUN_ID.test(o.runId) || o.runId === "." || o.runId === "..") throw new CharacterArchiveRefused(`${JSON.stringify(o.runId)} is not a run id`);
  const gzip = gzipFor(o.file);
  if (existsSync(o.file)) throw new CharacterArchiveRefused(`${o.file} exists — an archive is never overwritten`);

  const dir = join(o.runsDir, o.runId);
  const metaPath = join(dir, "meta.json");
  if (!existsSync(metaPath)) {
    if (existsSync(join(o.runsDir, ARCHIVE_DIR, o.runId, "meta.json"))) {
      throw new CharacterArchiveRefused(`run ${o.runId} is archived; a character is exported from its head run, which is never archived`);
    }
    throw new CharacterArchiveRefused(`no meta.json for run ${o.runId} under ${o.runsDir}`);
  }
  const metaText = readFileSync(metaPath, "utf8");
  const meta = parseMeta(metaText, o.runId);
  const name = typeof meta.config["character"] === "string" ? meta.config["character"] : "";
  const account = typeof meta.config["account"] === "string" ? meta.config["account"] : "";
  if (name === "") throw new CharacterArchiveRefused(`run ${o.runId} has named no character — there is nothing to export`);
  if (account === "") throw new CharacterArchiveRefused(`run ${o.runId} records no account`);

  refuseOwned(o.runsDir, o.runId, now());
  const fact = readRunFact(o.runsDir, o.runId, now());
  if (fact === null) throw new CharacterArchiveRefused(`run ${o.runId}: meta.json does not read as a run (no episode or no model)`);
  let state: Manifest["state"];
  let reason: string;
  if (fact.terminationReason !== null) {
    state = "ended";
    reason = fact.terminationReason;
  } else if (fact.pause !== null) {
    state = "paused";
    reason = fact.pause.reason;
  } else {
    throw new CharacterArchiveRefused(
      `run ${o.runId} is neither paused nor ended — a run with no verdict is resumed as offline on the fleet's next tick; pause it first (roster idle "none")`,
    );
  }

  const character = await o.game.characterByName(name);
  refuseExportCharacter(character, name, account);

  // The run directory's members, struck, and the scan over all of them.
  const token = strikableSessionToken(dir, o.runId);
  const known: KnownSecret[] = [...envSecrets(o.env).secrets, ...(token !== null ? [{ label: "session-token", value: token }] : [])];
  const scanner = new SecretScanner(known);
  const temps: string[] = [];
  const tempBase = join(dirname(o.file), `.${basename(o.file)}.${process.pid}`);
  const partial = `${tempBase}.partial`;
  try {
    const { sources, directories } = runSources(dir, metaText, meta, token, o.trajectory, (i) => {
      const t = `${tempBase}.${i}.sqlite`;
      temps.push(t);
      return t;
    });
    const sized = new Map<string, { size: number; sha256: string }>();
    const findings: string[] = [];
    for (const s of sources) {
      const r = measure(s.chunks(), scanner);
      sized.set(s.path, r);
      if (r.findings.length > 0) findings.push(`${s.path}: ${r.findings.join(", ")}`);
    }
    if (findings.length > 0) {
      throw new CharacterArchiveRefused(`run ${o.runId} carries what reads as a credential, so nothing was written — ${findings.join("; ")}`);
    }

    // The game half, last of the reads: the character may not have come online meanwhile.
    refuseExportCharacter(await o.game.characterByName(name), name, account);
    const dumpBytes = await o.game.dump(character!.name);
    if (!looksLikePdump(dumpBytes)) throw new CharacterArchiveRefused(`the server's dump of ${character!.name} has no characters row — nothing written`);
    const dumpFindings = scanner.scan(Buffer.from(dumpBytes).toString("latin1"));
    if (dumpFindings.length > 0) throw new CharacterArchiveRefused(`the character's dump carries what reads as a credential (${describeFindings(dumpFindings)}) — nothing written`);

    const stamp = now();
    const members: ManifestMember[] = [
      { path: PDUMP_MEMBER, size: dumpBytes.length, sha256: sha256(dumpBytes), mode: 0o640 },
      ...sources.map((s) => ({ path: s.path, mode: s.mode, ...sized.get(s.path)! })),
    ];
    const manifest: Manifest = {
      format: ARCHIVE_FORMAT,
      version: 1,
      runId: o.runId,
      model: fact.model,
      effort: fact.effort,
      driver: fact.driver ?? DEFAULT_DRIVER,
      episode: fact.episode,
      harnessVersion: fact.harnessVersion,
      exportedWith: o.exportedWith,
      exportedAt: new Date(stamp).toISOString(),
      state,
      reason,
      character: { name: character!.name, guid: character!.guid, account: character!.account!, level: character!.level },
      trajectory: o.trajectory,
      members,
      directories,
    };
    const manifestBytes = new TextEncoder().encode(`${JSON.stringify(manifest, null, 2)}\n`);

    const sink = Sink.open(partial, gzip);
    try {
      const mtime = Math.floor(stamp / 1000);
      await sink.member({ path: MANIFEST_MEMBER, size: manifestBytes.length, mode: 0o640, mtime }, [manifestBytes]);
      await sink.member({ path: PDUMP_MEMBER, size: dumpBytes.length, mode: 0o640, mtime }, [dumpBytes]);
      for (const s of sources) {
        const want = sized.get(s.path)!;
        const got = await sink.member({ path: s.path, size: want.size, mode: s.mode, mtime: s.mtime }, s.chunks());
        if (got !== want.sha256) throw new CharacterArchiveRefused(`${s.path} changed while the archive was written — nothing kept; is the run being resumed?`);
      }
      await sink.close();
    } catch (e) {
      sink.abort();
      throw e;
    }
    refuseOwned(o.runsDir, o.runId, now(), "while the archive was written");
    if (existsSync(o.file)) throw new CharacterArchiveRefused(`${o.file} appeared while the archive was written — nothing kept`);
    renameSync(partial, o.file);
    return { file: o.file, manifest, bytes: statSync(o.file).size };
  } finally {
    for (const t of temps) rmSync(t, { force: true });
    rmSync(partial, { force: true });
  }
}

function refuseExportCharacter(c: GameCharacter | null, name: string, account: string): void {
  if (c === null) throw new CharacterArchiveRefused(`the characters database has no ${name} — nothing to dump`);
  if (c.account === null || c.account.toUpperCase() !== account.toUpperCase()) {
    throw new CharacterArchiveRefused(`${name} is on account ${c.account ?? `#${c.accountId}`}, but the run records ${account} — not this run's character`);
  }
  if (c.online) throw new CharacterArchiveRefused(`${name} is online — a dump of a character in the world misses what it has not saved; pause its run first`);
}

/** The archive name decides the compression: `.tar.gz`/`.tgz` gzipped, `.tar` plain, anything else refused. */
function gzipFor(file: string): boolean {
  if (/\.(tar\.gz|tgz)$/.test(file)) return true;
  if (file.endsWith(".tar")) return false;
  throw new CharacterArchiveRefused(`${file}: name the archive .tar.gz (gzipped) or .tar`);
}

type MetaDoc = Record<string, unknown> & { runId?: unknown; config: Record<string, unknown> };

function parseMeta(text: string, runId: string): MetaDoc {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new CharacterArchiveRefused(`run ${runId}: meta.json does not parse (${e instanceof Error ? e.message : String(e)})`);
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new CharacterArchiveRefused(`run ${runId}: meta.json is not an object`);
  const config = (raw as { config?: unknown }).config;
  if (typeof config !== "object" || config === null || Array.isArray(config)) throw new CharacterArchiveRefused(`run ${runId}: meta.json has no config`);
  return raw as MetaDoc;
}

function refuseOwned(runsDir: string, runId: string, now: number, when = ""): void {
  const owner = liveOwnerOf(runsDir, runId, now);
  if (owner !== null) throw new CharacterArchiveRefused(`run ${runId} has a live owner${when ? ` ${when}` : ""}: ${owner} — pause it first (roster idle "none")`);
}

/** Left out of an archive, by path relative to the run directory. */
function excluded(rel: string, trajectory: boolean): boolean {
  if (rel === HEARTBEAT_FILE || rel === "claude-mcp.json") return true;
  if (!trajectory && rel === "trajectory.jsonl") return true;
  if (rel === "claude-config/backups" || rel.startsWith("claude-config/backups/")) return true;
  const base = basename(rel);
  if (/^\..*\.tmp$/.test(base)) return true;
  return /\.sqlite-(journal|wal|shm)$/.test(base);
}

/** Every member the run directory gives, sorted, meta.json first; and its directories with their modes. */
function runSources(
  dir: string,
  metaText: string,
  meta: MetaDoc,
  token: string | null,
  trajectory: boolean,
  tempFor: (i: number) => string,
): { sources: Source[]; directories: ManifestDirectory[] } {
  const files: string[] = [];
  const directories: ManifestDirectory[] = [{ path: "run", mode: statSync(dir).mode & 0o7777 }];
  const walk = (rel: string): void => {
    const abs = rel === "" ? dir : join(dir, rel);
    for (const name of readdirSync(abs).sort()) {
      const r = rel === "" ? name : `${rel}/${name}`;
      if (excluded(r, trajectory)) continue;
      if (CREDENTIAL_FILES.has(name)) throw new CharacterArchiveRefused(`${r} is a credential store — a run directory must never hold one, and an archive never carries one`);
      const st = lstatSync(join(dir, r));
      if (st.isDirectory()) {
        directories.push({ path: `${RUN_PREFIX}${r}`, mode: st.mode & 0o7777 });
        walk(r);
      } else if (st.isFile()) files.push(r);
      else throw new CharacterArchiveRefused(`${r} is neither a file nor a directory (a link?) — refused rather than followed`);
    }
  };
  walk("");

  const out: Source[] = [];
  const metaStat = statSync(join(dir, "meta.json"));
  const { token: _dropped, ...config } = meta.config;
  const metaBytes = new TextEncoder().encode(formatLike(metaText, { ...meta, config }));
  out.push({ path: `${RUN_PREFIX}meta.json`, mode: metaStat.mode & 0o7777, mtime: Math.floor(metaStat.mtimeMs / 1000), chunks: () => struck([metaBytes][Symbol.iterator](), token) });

  let sqlites = 0;
  for (const rel of files) {
    if (rel === "meta.json") continue;
    const abs = join(dir, rel);
    const st = statSync(abs);
    const base = { path: `${RUN_PREFIX}${rel}`, mode: st.mode & 0o7777, mtime: Math.floor(st.mtimeMs / 1000) };
    if (rel.endsWith(".sqlite")) {
      const copy = tempFor(sqlites++);
      sqliteCopy(abs, copy, token, rel);
      out.push({ ...base, chunks: () => fileChunks(copy) });
    } else {
      out.push({ ...base, chunks: () => struck(fileChunks(abs), token) });
    }
  }
  return { sources: out, directories };
}

/**
 * A consistent copy of a sqlite file, with `token` struck from every text
 * value: `VACUUM INTO` from a read-only handle (the source is never written,
 * and a journal is folded in), then `replace()` on the copy under
 * `secure_delete`, so the old values' bytes do not survive in free pages.
 */
function sqliteCopy(src: string, dest: string, token: string | null, rel: string): void {
  rmSync(dest, { force: true });
  let db: Database | null = null;
  try {
    db = new Database(src, { readonly: true });
    db.query("VACUUM INTO ?").run(dest);
  } catch (e) {
    throw new CharacterArchiveRefused(`${rel}: could not take a consistent copy (${e instanceof Error ? e.message : String(e)})`);
  } finally {
    db?.close();
  }
  if (token === null) return;
  const copy = new Database(dest);
  try {
    copy.exec("PRAGMA secure_delete = ON");
    const tables = copy.query(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND sql NOT LIKE 'CREATE VIRTUAL%'`).all() as { name: string }[];
    for (const { name } of tables) {
      const cols = copy.query(`SELECT name FROM pragma_table_info(?)`).all(name) as { name: string }[];
      for (const c of cols) {
        copy
          .query(`UPDATE ${ident(name)} SET ${ident(c.name)} = replace(${ident(c.name)}, ?1, ?2) WHERE typeof(${ident(c.name)}) = 'text' AND instr(${ident(c.name)}, ?1) > 0`)
          .run(token, REDACTED);
      }
    }
    copy.exec("VACUUM");
  } finally {
    copy.close();
  }
}

function ident(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

function* fileChunks(path: string): Generator<Uint8Array> {
  const fd = openSync(path, "r");
  try {
    for (;;) {
      const buf = Buffer.allocUnsafe(CHUNK);
      const n = readSync(fd, buf, 0, CHUNK, null);
      if (n === 0) return;
      yield buf.subarray(0, n);
    }
  } finally {
    closeSync(fd);
  }
}

/**
 * `chunks` with every occurrence of `token` replaced by `[redacted]`, across
 * chunk boundaries: the last `token.length - 1` bytes of each chunk wait for
 * the next. A token is hex, so the bytes match whatever the encoding.
 */
export function* struck(chunks: Iterator<Uint8Array>, token: string | null): Generator<Uint8Array> {
  if (token === null || token.length === 0) {
    for (let r = chunks.next(); r.done !== true; r = chunks.next()) yield r.value;
    return;
  }
  const tok = Buffer.from(token, "latin1");
  const red = Buffer.from(REDACTED, "latin1");
  let carry: Buffer = Buffer.alloc(0);
  for (let r = chunks.next(); r.done !== true; r = chunks.next()) {
    const buf = carry.length === 0 ? Buffer.from(r.value.buffer, r.value.byteOffset, r.value.byteLength) : Buffer.concat([carry, r.value]);
    const parts: Buffer[] = [];
    let pos = 0;
    for (let i = buf.indexOf(tok, pos); i !== -1; i = buf.indexOf(tok, pos)) {
      parts.push(buf.subarray(pos, i), red);
      pos = i + tok.length;
    }
    const keepFrom = Math.max(pos, buf.length - (tok.length - 1));
    parts.push(buf.subarray(pos, keepFrom));
    carry = Buffer.from(buf.subarray(keepFrom));
    const out = Buffer.concat(parts);
    if (out.length > 0) yield out;
  }
  if (carry.length > 0) yield carry;
}

/** Size, sha256 and scan findings over a member's bytes, a chunk at a time. */
function measure(chunks: Iterable<Uint8Array>, scanner: SecretScanner): { size: number; sha256: string; findings: string[] } {
  const hash = createHash("sha256");
  const rules = new Set<string>();
  let size = 0;
  let tail = "";
  for (const c of chunks) {
    hash.update(c);
    size += c.length;
    const window = tail + Buffer.from(c.buffer, c.byteOffset, c.byteLength).toString("latin1");
    for (const f of scanner.scan(window)) rules.add(f.rule);
    tail = window.slice(-SCAN_OVERLAP);
  }
  return { size, sha256: hash.digest("hex"), findings: [...rules].sort() };
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** A player dump has a `characters` row; a refusal or an empty file has none. */
function looksLikePdump(bytes: Uint8Array): boolean {
  return /INSERT INTO `characters`/.test(Buffer.from(bytes).toString("latin1"));
}

/** The archive being written: a temp file, gzipped or not, with backpressure. */
class Sink {
  private constructor(
    private readonly path: string,
    private readonly fd: number | null,
    private readonly gz: Gzip | null,
    private readonly out: WriteStream | null,
  ) {}

  static open(path: string, gzip: boolean): Sink {
    if (!gzip) return new Sink(path, openSync(path, "wx", 0o640), null, null);
    const out = createWriteStream(path, { flags: "wx", mode: 0o640 });
    const gz = createGzip();
    gz.pipe(out);
    return new Sink(path, null, gz, out);
  }

  private async write(b: Uint8Array): Promise<void> {
    if (b.length === 0) return;
    if (this.fd !== null) {
      for (let at = 0; at < b.length; ) at += writeSync(this.fd, b, at, b.length - at);
      return;
    }
    if (!this.gz!.write(b)) await once(this.gz!, "drain");
  }

  /** One member: its header, its bytes (which must total `e.size`), its padding. Resolves with the bytes' sha256. */
  async member(e: TarEntry, chunks: Iterable<Uint8Array>): Promise<string> {
    await this.write(tarHeader(e));
    const hash = createHash("sha256");
    let size = 0;
    for (const c of chunks) {
      hash.update(c);
      size += c.length;
      if (size > e.size) throw new CharacterArchiveRefused(`${e.path} grew while the archive was written — nothing kept`);
      await this.write(c);
    }
    if (size !== e.size) throw new CharacterArchiveRefused(`${e.path} shrank while the archive was written — nothing kept`);
    await this.write(tarPadding(e.size));
    return hash.digest("hex");
  }

  async close(): Promise<void> {
    await this.write(tarEnd());
    if (this.fd !== null) {
      fsyncSync(this.fd);
      closeSync(this.fd);
      return;
    }
    this.gz!.end();
    await finished(this.out!);
    const fd = openSync(this.path, "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }

  abort(): void {
    if (this.fd !== null) {
      try {
        closeSync(this.fd);
      } catch {
        /* already closed */
      }
    } else {
      this.gz!.destroy();
      this.out!.destroy();
    }
    rmSync(this.path, { force: true });
  }
}

// ---------------------------------------------------------------- import

export interface ImportOptions {
  file: string;
  runsDir: string;
  /** Load onto this account instead of the one the archive records. */
  account?: string;
  game: GameSide;
  actor: string;
  note?: string;
  now?: () => number;
}

export interface ImportResult {
  runId: string;
  dir: string;
  manifest: Manifest;
  account: string;
  /** The guid the character has now: the archive's, unless the server could not give it back (see `warnings`). */
  guid: number;
  /** Things the operator should know that did not stop the import. */
  warnings: string[];
}

/** Read only the manifest, the archive's first member. */
export async function readManifest(file: string): Promise<Manifest> {
  let bytes: Buffer[] = [];
  let size = 0;
  let done: Manifest | null = null;
  const STOP = Symbol("stop");
  let first = true;
  try {
    await readArchive(file, {
      entry(e) {
        if (!first || e.path !== MANIFEST_MEMBER) throw new CharacterArchiveRefused(`${file}: the first member is ${e.path}, not ${MANIFEST_MEMBER} — not a character archive`);
        if (e.size > MAX_MANIFEST_BYTES) throw new CharacterArchiveRefused(`${file}: the manifest is ${e.size} bytes, more than any manifest`);
        first = false;
      },
      data(c) {
        bytes.push(Buffer.from(c));
        size += c.length;
      },
      close() {
        done = parseManifest(Buffer.concat(bytes, size).toString("utf8"), file);
        bytes = [];
        throw STOP;
      },
    });
  } catch (e) {
    if (e !== STOP) throw wrapArchiveError(e, file);
  }
  if (done === null) throw new CharacterArchiveRefused(`${file} holds no manifest — not a character archive`);
  return done;
}

function parseManifest(text: string, file: string): Manifest {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new CharacterArchiveRefused(`${file}: the manifest does not parse (${e instanceof Error ? e.message : String(e)})`);
  }
  const r = ManifestSchema.safeParse(raw);
  if (!r.success) throw new CharacterArchiveRefused(`${file}: the manifest is not one this build reads: ${r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  const m = r.data;
  const paths = new Set<string>();
  for (const member of m.members) {
    if (paths.has(member.path)) throw new CharacterArchiveRefused(`${file}: the manifest lists ${member.path} twice`);
    paths.add(member.path);
    if (member.path !== PDUMP_MEMBER && !(member.path.startsWith(RUN_PREFIX) && member.path.length > RUN_PREFIX.length)) {
      throw new CharacterArchiveRefused(`${file}: the manifest lists ${member.path}, which is neither the dump nor in the run directory`);
    }
  }
  for (const d of m.directories) {
    if (d.path !== "run" && !(d.path.startsWith(RUN_PREFIX) && isSafeMemberPath(d.path))) {
      throw new CharacterArchiveRefused(`${file}: the manifest lists directory ${d.path}, which is not in the run directory`);
    }
  }
  if (!paths.has(PDUMP_MEMBER)) throw new CharacterArchiveRefused(`${file}: the manifest lists no ${PDUMP_MEMBER}`);
  if (!paths.has(`${RUN_PREFIX}meta.json`)) throw new CharacterArchiveRefused(`${file}: the manifest lists no ${RUN_PREFIX}meta.json`);
  return m;
}

/** Feed the archive's bytes, gunzipped when they are gzip, to a tar parser. */
async function readArchive(file: string, handler: TarHandler): Promise<void> {
  const magic = Buffer.alloc(2);
  const fd = openSync(file, "r");
  try {
    readSync(fd, magic, 0, 2, 0);
  } finally {
    closeSync(fd);
  }
  const raw = createReadStream(file, { highWaterMark: CHUNK });
  const gunzip = magic[0] === 0x1f && magic[1] === 0x8b ? createGunzip() : null;
  const src = gunzip === null ? raw : raw.pipe(gunzip);
  if (gunzip !== null) raw.on("error", (e) => gunzip.destroy(e));
  const reader = new TarReader(handler);
  try {
    for await (const chunk of src) reader.push(chunk as Uint8Array);
    reader.finish();
  } finally {
    raw.destroy();
    gunzip?.destroy();
  }
}

function wrapArchiveError(e: unknown, file: string): Error {
  if (e instanceof CharacterArchiveRefused) return e;
  return new CharacterArchiveRefused(`${file}: ${e instanceof Error ? e.message : String(e)}`);
}

export async function importCharacter(o: ImportOptions): Promise<ImportResult> {
  const now = o.now ?? Date.now;
  if (!existsSync(o.file)) throw new CharacterArchiveRefused(`no archive at ${o.file}`);
  const m = await readManifest(o.file);
  const runId = m.runId;
  const final = join(o.runsDir, runId);
  const account = (o.account ?? m.character.account).toUpperCase();
  const name = m.character.name;
  const guid = m.character.guid;

  const refuseTaken = async (): Promise<number> => {
    if (existsSync(final)) throw new CharacterArchiveRefused(`run ${runId} exists under ${o.runsDir} — an import never replaces a run; move it aside first`);
    if (existsSync(join(o.runsDir, ARCHIVE_DIR, runId))) throw new CharacterArchiveRefused(`run ${runId} exists under ${ARCHIVE_DIR}/ — an import never replaces a run`);
    const id = await o.game.accountId(account);
    if (id === null) throw new CharacterArchiveRefused(`account ${account} does not exist — create it first (bun wb accounts ensure ${account})`);
    const byName = await o.game.characterByName(name);
    if (byName !== null) throw new CharacterArchiveRefused(`a character named ${byName.name} exists (guid ${byName.guid}, account ${byName.account ?? `#${byName.accountId}`}) — the core would load this one under another name`);
    const byGuid = await o.game.characterByGuid(guid);
    if (byGuid !== null) throw new CharacterArchiveRefused(`guid ${guid} is taken (${byGuid.name || "a deleted character"}, account ${byGuid.account ?? `#${byGuid.accountId}`})`);
    return id;
  };
  const accountId = await refuseTaken();

  mkdirSync(o.runsDir, { recursive: true });
  // `+` is in no run id, so no reader of the runs directory takes this for a run.
  const staging = join(o.runsDir, `+import-${runId}-${process.pid}`);
  if (existsSync(staging)) throw new CharacterArchiveRefused(`${staging} exists — a previous import died there; remove it`);
  mkdirSync(staging);
  let loaded = false;
  try {
    const dump = await extract(o.file, m, staging);
    const metaPath = join(staging, "meta.json");
    const metaText = readFileSync(metaPath, "utf8");
    const meta = parseMeta(metaText, runId);
    if (meta.runId !== runId) throw new CharacterArchiveRefused(`the archived meta.json is run ${String(meta.runId)}, the manifest ${runId}`);
    if (String(meta.config["character"] ?? "").toLowerCase() !== name.toLowerCase()) {
      throw new CharacterArchiveRefused(`the archived meta.json plays ${String(meta.config["character"])}, the manifest ${name}`);
    }
    if (String(meta.config["account"] ?? "").toUpperCase() !== m.character.account.toUpperCase()) {
      throw new CharacterArchiveRefused(`the archived meta.json is on account ${String(meta.config["account"])}, the manifest ${m.character.account}`);
    }

    // Again, just before the one write that cannot be taken back.
    await refuseTaken();
    await o.game.load(dump, account, name, guid);
    loaded = true;
    const back = await o.game.characterByName(name);
    if (back === null || back.accountId !== accountId) {
      const stray = await o.game.characterByGuid(guid);
      throw new CharacterImportIncomplete(
        `the server took the dump, but ${name} is not on ${account} now${back !== null ? ` (it is on ${back.account ?? `#${back.accountId}`})` : ""}` +
          `${stray !== null ? `; guid ${guid} is ${stray.name}` : ""}. The run directory was not restored; find what was loaded and delete it before trying again`,
      );
    }
    const warnings: string[] = [];
    if (back.guid !== guid) {
      warnings.push(
        `${name} came back as guid ${back.guid}, not ${guid}: the core gives a dump its own guid only below the highest it has handed out, which a fresh database has not reached. Runs find their character by account and name, so nothing reads the old guid`,
      );
    }
    if (account !== m.character.account.toUpperCase()) {
      warnings.push(`the run moved from account ${m.character.account} to ${account}: it resumes there, and only if that account is on the module's allowlist and in the fleet's pool`);
    }
    if (m.state === "ended") {
      warnings.push(`run ${runId} ended (${m.reason}): nothing resumes it, and a freeplay ref's next pick continues from it`);
    }

    const record: CharacterImport = {
      at: now(),
      actor: o.actor,
      note: o.note?.trim() || null,
      archive: basename(o.file),
      exportedAt: m.exportedAt,
      exportedWith: m.exportedWith,
      from: { account: m.character.account, guid },
      to: { account, guid: back.guid },
    };
    const prior = Array.isArray(meta["imports"]) ? (meta["imports"] as unknown[]) : [];
    const next = { ...meta, config: { ...meta.config, account }, imports: [...prior, record] };
    const mode = statSync(metaPath).mode & 0o7777;
    const mtime = statSync(metaPath).mtime;
    writeFileSync(metaPath, formatLike(metaText, next));
    chmodSync(metaPath, mode);
    utimesSync(metaPath, mtime, mtime);

    if (existsSync(final)) {
      throw new CharacterImportIncomplete(`${name} is loaded on ${account} (guid ${back.guid}), but run ${runId} appeared under ${o.runsDir} meanwhile; the restored run directory is at ${staging}`);
    }
    try {
      renameSync(staging, final);
    } catch (e) {
      throw new CharacterImportIncomplete(
        `${name} is loaded on ${account} (guid ${back.guid}), but the run directory could not be moved into place (${e instanceof Error ? e.message : String(e)}); it is at ${staging} — rename it to ${final}`,
      );
    }
    return { runId, dir: final, manifest: m, account, guid: back.guid, warnings };
  } catch (e) {
    // Before the load nothing is kept. After it, the character is in the
    // game, so the staged run directory stays where the message says, except
    // when the load itself went wrong and nothing restored is worth keeping.
    if (loaded && !(e instanceof CharacterImportIncomplete)) {
      throw new CharacterImportIncomplete(
        `${name} is loaded on ${account}, but the run directory was not put in place (${e instanceof Error ? e.message : String(e)}); it is at ${staging}`,
      );
    }
    if (!(e instanceof CharacterImportIncomplete && e.message.includes(staging))) rmSync(staging, { recursive: true, force: true });
    throw e;
  }
}

/**
 * Write every `run/` member into `staging`, checking each against the
 * manifest as it lands, and return the dump. Throws on any member the
 * manifest does not list, lists twice, or sizes or hashes otherwise, and on
 * any it lists that never came.
 */
async function extract(file: string, m: Manifest, staging: string): Promise<Buffer> {
  const byPath = new Map(m.members.map((x) => [x.path, x]));
  const seen = new Set<string>();
  let index = 0;
  type Landing = { member: ManifestMember; hash: ReturnType<typeof createHash>; size: number; fd: number | null; target: string | null; mtime: number };
  // A holder, not a `let`: the callbacks assign it, which control flow cannot see.
  const landing: { current: Landing | null } = { current: null };
  const dump: Buffer[] = [];
  try {
    await readArchive(file, {
      entry(e) {
        if (index++ === 0) {
          if (e.path !== MANIFEST_MEMBER) throw new CharacterArchiveRefused(`the first member is ${e.path}, not ${MANIFEST_MEMBER}`);
          landing.current = null;
          return;
        }
        if (e.path === MANIFEST_MEMBER) throw new CharacterArchiveRefused(`a second ${MANIFEST_MEMBER}`);
        const member = byPath.get(e.path);
        if (member === undefined) throw new CharacterArchiveRefused(`${e.path} is in the archive but not in its manifest`);
        if (seen.has(e.path)) throw new CharacterArchiveRefused(`${e.path} is in the archive twice`);
        seen.add(e.path);
        if (e.size !== member.size) throw new CharacterArchiveRefused(`${e.path} is ${e.size} bytes, the manifest says ${member.size}`);
        if (e.path === PDUMP_MEMBER && e.size > MAX_PDUMP_BYTES) throw new CharacterArchiveRefused(`${PDUMP_MEMBER} is ${e.size} bytes, more than any player dump`);
        let fd: number | null = null;
        let target: string | null = null;
        if (e.path !== PDUMP_MEMBER) {
          target = join(staging, e.path.slice(RUN_PREFIX.length));
          mkdirSync(dirname(target), { recursive: true });
          fd = openSync(target, "wx", 0o600);
        }
        landing.current = { member, hash: createHash("sha256"), size: 0, fd, target, mtime: e.mtime };
      },
      data(c) {
        const cur = landing.current;
        if (cur === null) return;
        cur.hash.update(c);
        cur.size += c.length;
        if (cur.fd !== null) {
          for (let at = 0; at < c.length; ) at += writeSync(cur.fd, c, at, c.length - at);
        } else dump.push(Buffer.from(c));
      },
      close() {
        const cur = landing.current;
        if (cur === null) return;
        landing.current = null;
        if (cur.fd !== null) {
          fsyncSync(cur.fd);
          closeSync(cur.fd);
        }
        const digest = cur.hash.digest("hex");
        if (digest !== cur.member.sha256) throw new CharacterArchiveRefused(`${cur.member.path} does not match its sha256 in the manifest — the archive is damaged`);
        if (cur.target !== null) {
          chmodSync(cur.target, cur.member.mode & 0o777);
          utimesSync(cur.target, cur.mtime, cur.mtime);
        }
      },
    });
  } catch (e) {
    const cur = landing.current;
    if (cur !== null && cur.fd !== null) closeSync(cur.fd);
    throw wrapArchiveError(e, file);
  }
  const missing = m.members.filter((x) => !seen.has(x.path)).map((x) => x.path);
  if (missing.length > 0) throw new CharacterArchiveRefused(`${file}: the manifest lists ${missing.join(", ")}, which the archive does not hold`);
  // Directories last: every one the run had, empty ones too, in its own mode
  // (a mkdir's is cut by the umask, which is how a hand copy loses group-write).
  for (const d of m.directories) {
    const target = d.path === "run" ? staging : join(staging, d.path.slice(RUN_PREFIX.length));
    mkdirSync(target, { recursive: true });
    chmodSync(target, d.mode & 0o7777);
  }
  return Buffer.concat(dump);
}
