#!/usr/bin/env bun
/**
 * Export and import a durable character: `bun wb accounts export-character`
 * and `bun wb accounts import-character`, run in the runner pod, where the
 * runs volume, the databases and SOAP all are (docs/RUNBOOK.md, "Backing up
 * and moving a character"). The archive and its checks are
 * runner/src/character-archive.ts; this file is the CLI and the real game
 * half behind its `GameSide`.
 *
 * The game half is the core's own player dump, never SQL of ours. Our SQL
 * would leave the server's item, mail and pet id generators and its character
 * cache behind the rows. `.pdump write <file> <name>` and `.pdump load <file>
 * <account> <name> <guid>` run over SOAP (infra/fixtures/soap.ts, the STAGER
 * admin account) and read or write a file on the worldserver's filesystem. The
 * file reaches this side through the data volume's `characters` subPath,
 * which the chart mounts in both pods with `staging.enabled`: here at
 * data/characters, in the worldserver at /azerothcore/env/dist/characters.
 * The exchange file lives in its `pdump/` and is removed as soon as it has
 * been read or loaded. The same switch sets `PlayerDump.DisallowPaths` to 0,
 * which the core otherwise defaults to 1, refusing any file name with a `/`.
 *
 * Lookups (does the account, the name, the guid exist; is the character
 * online) are read-only SELECTs over the runner's own database env, the one
 * `bun wb accounts ensure` writes through.
 *
 * Usage, in the runner pod:
 *
 *   bun infra/character-archive.ts export <run-id> [file] [--no-trajectory] [--runs-dir D]
 *   bun infra/character-archive.ts import <file> [--account NAME] [--note TEXT] [--actor NAME] [--runs-dir D]
 *
 * A file named without a `/` is in the characters directory
 * ($WRATHBENCH_CHARACTERS_DIR, else data/characters in the checkout). The
 * export's default name is `<run-id>-<UTC stamp>.tar.gz`.
 */

import { SQL } from "bun";
import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  CharacterArchiveRefused,
  CharacterImportIncomplete,
  exportCharacter,
  importCharacter,
  type GameCharacter,
  type GameSide,
} from "../runner/src/character-archive";
import { harnessVersion } from "../runner/src/version";
import { SoapError, soapFromEnv, type SoapClient } from "./fixtures/soap.ts";

const REPO_ROOT = resolve(import.meta.dir, "..");

/** Where the worldserver sees the exchange directory (the chart's mount of the `characters` subPath, plus `pdump`). */
export const SERVER_PDUMP_DIR = "/azerothcore/env/dist/characters/pdump";

/** A character name the core would take, and nothing a console line could be split on. */
const NAME = /^[A-Za-z]{2,12}$/;
const ACCOUNT = /^[A-Za-z0-9_]{2,16}$/;

export function charactersDir(env: Record<string, string | undefined> = process.env): string {
  return env["WRATHBENCH_CHARACTERS_DIR"] || join(REPO_ROOT, "data", "characters");
}

/** A file argument: a bare name is in the characters directory, anything with a `/` is as given. */
export function archivePath(arg: string, env: Record<string, string | undefined> = process.env): string {
  return arg.includes("/") ? resolve(arg) : join(charactersDir(env), arg);
}

/** `<run-id>-20261023T101500Z.tar.gz`. */
export function defaultArchiveName(runId: string, now: number): string {
  return `${runId}-${new Date(now).toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z")}.tar.gz`;
}

/** The pdump half over SOAP, and the lookups over SQL. */
export class SoapGameSide implements GameSide {
  constructor(
    private readonly o: {
      soap: Pick<SoapClient, "execute">;
      /** The auth database. */
      auth: SQL;
      /** The characters database. */
      chars: SQL;
      /** The exchange directory as this process sees it. */
      localDir: string;
      /** The same directory as the worldserver sees it. */
      serverDir: string;
    },
  ) {}

  private async withAccount(rows: unknown[]): Promise<GameCharacter | null> {
    const r = rows[0] as { guid: number | string; name: string | null; account: number | string; online: number | string; level: number | string } | undefined;
    if (r === undefined) return null;
    const accountId = Number(r.account);
    const acct = (await this.o.auth`SELECT username FROM account WHERE id = ${accountId}`) as { username: string }[];
    return {
      guid: Number(r.guid),
      name: r.name ?? "",
      accountId,
      account: acct[0]?.username ?? null,
      online: Number(r.online) !== 0,
      level: r.level === null ? null : Number(r.level),
    };
  }

  async characterByName(name: string): Promise<GameCharacter | null> {
    return this.withAccount(await this.o.chars`SELECT guid, name, account, online, level FROM characters WHERE name = ${name} LIMIT 1`);
  }

  async characterByGuid(guid: number): Promise<GameCharacter | null> {
    return this.withAccount(await this.o.chars`SELECT guid, name, account, online, level FROM characters WHERE guid = ${guid} LIMIT 1`);
  }

  async accountId(account: string): Promise<number | null> {
    const rows = (await this.o.auth`SELECT id FROM account WHERE username = ${account.toUpperCase()}`) as { id: number | string }[];
    return rows[0] === undefined ? null : Number(rows[0].id);
  }

  private exchange(): { local: string; server: string } {
    mkdirSync(this.o.localDir, { recursive: true });
    const file = `${Date.now()}-${randomBytes(6).toString("hex")}.pdump`;
    return { local: join(this.o.localDir, file), server: `${this.o.serverDir}/${file}` };
  }

  async dump(name: string): Promise<string> {
    if (!NAME.test(name)) throw new CharacterArchiveRefused(`refusing .pdump write for ${JSON.stringify(name)}: not a character name`);
    const f = this.exchange();
    try {
      await this.soap(`.pdump write ${f.server} ${name}`);
      try {
        return readFileSync(f.local, "utf8");
      } catch (e) {
        throw new CharacterArchiveRefused(
          `the server wrote ${f.server}, but it is not at ${f.local} here (${e instanceof Error ? e.message : String(e)}): ` +
            "the worldserver and this pod must mount the same `characters` subPath (the chart does with staging.enabled)",
        );
      }
    } finally {
      rmSync(f.local, { force: true });
    }
  }

  async load(dump: string, account: string, name: string, guid: number): Promise<void> {
    if (!NAME.test(name)) throw new CharacterArchiveRefused(`refusing .pdump load as ${JSON.stringify(name)}: not a character name`);
    if (!ACCOUNT.test(account)) throw new CharacterArchiveRefused(`refusing .pdump load onto ${JSON.stringify(account)}: not an account name`);
    if (!Number.isSafeInteger(guid) || guid <= 0) throw new CharacterArchiveRefused(`refusing .pdump load with guid ${guid}`);
    const f = this.exchange();
    try {
      writeFileSync(f.local, dump, { mode: 0o640, flag: "wx" });
      chmodSync(f.local, 0o640);
      await this.soap(`.pdump load ${f.server} ${account} ${name} ${guid}`);
    } finally {
      rmSync(f.local, { force: true });
    }
  }

  private async soap(command: string): Promise<string> {
    try {
      return await this.o.soap.execute(command);
    } catch (e) {
      if (e instanceof SoapError) throw new CharacterArchiveRefused(`the server refused '${command.split(" ").slice(0, 2).join(" ")}': ${e.refusal.message}`);
      throw e;
    }
  }
}

function dbPassword(env: Record<string, string | undefined>): string {
  return env["WRATHBENCH_DB_PASSWORD"] ?? env["WRATHBENCH_DB_ROOT_PASSWORD"] ?? "wrathbench";
}

function connect(env: Record<string, string | undefined>, database: string): SQL {
  return new SQL({
    adapter: "mysql",
    hostname: env["WRATHBENCH_DB_HOST"] ?? "db",
    port: Number(env["WRATHBENCH_DB_PORT"] ?? "3306"),
    username: env["WRATHBENCH_DB_USER"] ?? "root",
    password: dbPassword(env),
    database,
    // As bootstrap.ts: MySQL 8.4's caching_sha2_password wants the server's
    // RSA key on first handshake, over a network that never leaves the cluster.
    allowPublicKeyRetrieval: true,
    max: 1,
  });
}

/** The real game side, from this process's environment; refuses by name when SOAP is not configured here. */
function gameFromEnv(env: Record<string, string | undefined>): { game: SoapGameSide; close: () => Promise<void> } {
  let soap: SoapClient;
  try {
    soap = soapFromEnv(env);
  } catch (e) {
    throw new CharacterArchiveRefused(
      `the character's game half runs over SOAP, which is not configured here: ${e instanceof Error ? e.message : String(e)}. ` +
        "The compose quickstart keeps SOAP off; on the cluster it comes with staging.enabled",
    );
  }
  const auth = connect(env, env["WRATHBENCH_AUTH_DB"] ?? "acore_auth");
  const chars = connect(env, env["WRATHBENCH_CHARACTERS_DB"] ?? "acore_characters");
  const game = new SoapGameSide({ soap, auth, chars, localDir: join(charactersDir(env), "pdump"), serverDir: env["WRATHBENCH_PDUMP_SERVER_DIR"] || SERVER_PDUMP_DIR });
  return {
    game,
    close: async () => {
      await auth.close().catch(() => {});
      await chars.close().catch(() => {});
    },
  };
}

const USAGE = `usage: bun infra/character-archive.ts <command>

  export <run-id> [file] [--no-trajectory]
      Write a paused or ended run and its character to one archive: the run directory (no session token,
      no credential), the character's rows as the core's own pdump, and a manifest with every member's
      sha256. Default file: <run-id>-<UTC stamp>.tar.gz in the characters directory.
      --no-trajectory  leave trajectory.jsonl out: enough to continue the character, not its record
  import <file> [--account NAME] [--note TEXT]
      Restore an archive: load the character (onto NAME, or the account it left) and put the run directory
      back under its own run id, paused or ended as it was exported. Never resumes it.

  --runs-dir <dir>  the runs directory (default $WRATHBENCH_RUNS_DIR, else data/runs in the checkout)
  --actor <name>    who to record the import as (default "cli")

A file named without a "/" is in the characters directory ($WRATHBENCH_CHARACTERS_DIR, else data/characters).`;

export async function main(argv: readonly string[], env: Record<string, string | undefined> = process.env): Promise<number> {
  const args = [...argv];
  const flag = (name: string): string | undefined => {
    const i = args.indexOf(name);
    if (i < 0) return undefined;
    const v = args[i + 1];
    args.splice(i, v === undefined ? 1 : 2);
    return v;
  };
  const has = (name: string): boolean => {
    const i = args.indexOf(name);
    if (i < 0) return false;
    args.splice(i, 1);
    return true;
  };
  if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
    console.log(USAGE);
    return args.length === 0 ? 2 : 0;
  }
  const runsDir = flag("--runs-dir") ?? (env["WRATHBENCH_RUNS_DIR"] || join(REPO_ROOT, "data", "runs"));
  const actor = flag("--actor") ?? "cli";
  const account = flag("--account");
  const note = flag("--note");
  const noTrajectory = has("--no-trajectory");
  const [cmd, ...rest] = args;
  const unknown = rest.find((a) => a.startsWith("-"));
  if (unknown !== undefined) {
    console.error(`character-archive: unknown flag ${unknown}\n\n${USAGE}`);
    return 2;
  }

  let closer: (() => Promise<void>) | undefined;
  try {
    if (cmd === "export") {
      const [runId, fileArg] = rest;
      if (runId === undefined || rest.length > 2 || account !== undefined) {
        console.error(USAGE);
        return 2;
      }
      const file = archivePath(fileArg ?? defaultArchiveName(runId, Date.now()), env);
      mkdirSync(dirname(file), { recursive: true });
      const { game, close } = gameFromEnv(env);
      closer = close;
      const r = await exportCharacter({ runsDir, runId, file, trajectory: !noTrajectory, game, env, exportedWith: harnessVersion(env) });
      const c = r.manifest.character;
      console.error(`exported ${runId}: ${c.name} (guid ${c.guid}, level ${c.level ?? "?"}) on ${c.account}, ${r.manifest.state} (${r.manifest.reason})`);
      console.error(`  ${r.manifest.members.length} members${r.manifest.trajectory ? "" : ", trajectory left out"}; ${r.bytes} bytes`);
      console.log(r.file);
      return 0;
    }
    if (cmd === "import") {
      const [fileArg] = rest;
      if (fileArg === undefined || rest.length > 1 || noTrajectory) {
        console.error(USAGE);
        return 2;
      }
      const { game, close } = gameFromEnv(env);
      closer = close;
      const r = await importCharacter({
        file: archivePath(fileArg, env),
        runsDir,
        ...(account !== undefined ? { account } : {}),
        game,
        actor,
        ...(note !== undefined ? { note } : {}),
      });
      const m = r.manifest;
      console.error(`imported ${r.runId}: ${m.character.name} (guid ${r.guid}) on ${r.account}, ${m.state} (${m.reason})`);
      for (const w of r.warnings) console.error(`warning: ${w}`);
      console.error(
        m.state === "paused"
          ? `it stays paused until something resumes it: the fleet does once its roster entry is idle "unlimited", or bun wb run episode --resume ${r.runId}`
          : "it stays ended",
      );
      console.log(r.dir);
      return 0;
    }
    console.error(USAGE);
    return 2;
  } catch (e) {
    if (e instanceof CharacterImportIncomplete) {
      console.error(`character-archive: INCOMPLETE: ${e.message}`);
      return 1;
    }
    console.error(`character-archive: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  } finally {
    await closer?.();
  }
}

if (import.meta.main) process.exit(await main(Bun.argv.slice(2)));
