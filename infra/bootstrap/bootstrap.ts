/**
 * Realm and account bootstrap.
 *
 * The chart runs it as the `bootstrap` Job, a Helm hook after db-import on
 * every install and upgrade; the quickstart runs it as compose's `bootstrap`
 * service, after db-import and before the servers. With no arguments it
 * converges the auth database on two things: realm 1's realmlist row at the
 * configured address (loopback in both: a spectator's client connects through
 * a forwarded port), and a runner account whose password is the configured
 * one. Safe to re-run; every write is an upsert and the account is only
 * rewritten when the stored verifier does not match the configured password.
 *
 * `--accounts-only NAME…` (`bun wb accounts ensure NAME…`) does neither. It
 * creates each named account that does not exist yet, with its own name as its
 * password, and changes nothing else: not the realm rows, not an account that
 * already exists, not the configured runner account. It uses no
 * WRATHBENCH_REALM_* or WRATHBENCH_ACCOUNT_* variable, which is what makes it
 * safe in the runner pod, where none is set and a plain run would advertise the
 * realm at this file's defaults. The names are always given, never defaulted,
 * because this writes game accounts. A harness account's password is its name
 * by convention: the module opens its sessions in-process and never uses it,
 * and only a game client would.
 *
 * Why direct SQL and not SOAP or the worldserver console
 * ------------------------------------------------------
 * SOAP is unusable for the *first* account: ACSoap.cpp requires the calling
 * account to be SEC_ADMINISTRATOR, and data/sql/base/db_auth/account.sql seeds
 * zero rows, so there is no account to authenticate with. It is a chicken and
 * egg by construction. It also requires SOAP.Enabled, which the quickstart
 * leaves off. On the cluster SOAP serves one thing: the operator's party
 * staging, in-cluster only, on an admin account no bench session can open
 * (docs/proposals/GROUP-PLAY.md). wrath-mcp/docs/CONTRACTS.md binds the agent's path,
 * not the operator's, and the agent can reach neither SOAP nor this tool.
 *
 * The console (attaching to the worldserver and typing `account create ...`,
 * which is what AzerothCore's own docker README tells you to do by hand) is
 * interactive, not idempotent, and only available after the world has finished
 * loading, which is minutes. Piping into it is a race, not a bootstrap.
 *
 * So we write the row ourselves. The cost is reimplementing AzerothCore's SRP6
 * registration derivation. It is small and pinned by
 * src/common/Cryptography/Authentication/SRP6.cpp at the pinned commit:
 *
 *   v = g^H(salt || H(UPPER(user) || ":" || UPPER(pass))) mod N
 *
 * with g = 7, N the standard WoW 3.3.5a modulus, H = SHA1, and every digest or
 * result converted to/from a BigNumber little-endian (BigNumber's default).
 * `salt` and `verifier` are binary(32) columns; we write them with UNHEX() so
 * no driver-side charset handling can touch the bytes, and then read the row
 * back and recompute to prove the round trip.
 *
 * If AzerothCore ever changes that derivation, login fails loudly at the
 * authserver and this file is the place to look.
 *
 * NOT YET VERIFIED AGAINST AZEROTHCORE ITSELF. The round-trip check below only
 * proves the bytes survive storage, not that the derivation is right. The
 * decisive test needs no game client; run it once the server images boot, on
 * the quickstart:
 *
 *   docker compose -f infra/compose.yml attach worldserver
 *   AC> account create TESTACC TESTPASS
 *
 * then read that row's salt and verifier and check that
 * calculateVerifier("TESTACC", "TESTPASS", salt) reproduces the verifier
 * AzerothCore wrote. AC's own output is the oracle; a match settles both the
 * little-endian handling and the uppercasing in one shot.
 */

import { SQL } from "bun";
import { createHash, randomBytes } from "node:crypto";

// --------------------------------------------------------------------- SRP6

/** The 3.3.5a SRP6 modulus, as written in SRP6.cpp. */
const N = 0x894b645e89e1535bbdad5b8b290650530801b18ebfbf5e8fab3c82872a3e9bb7n;
const G = 7n;

function sha1(...parts: (string | Uint8Array)[]): Buffer {
  const h = createHash("sha1");
  for (const p of parts) h.update(typeof p === "string" ? Buffer.from(p, "utf8") : p);
  return h.digest();
}

/** Bytes -> integer, little-endian first byte. Matches BigNumber::SetBinary. */
function fromLE(bytes: Uint8Array): bigint {
  let v = 0n;
  for (let i = bytes.length - 1; i >= 0; i--) v = (v << 8n) | BigInt(bytes[i]!);
  return v;
}

/** Integer -> fixed-width little-endian bytes. Matches BigNumber::ToByteArray. */
function toLE(value: bigint, width: number): Buffer {
  const out = Buffer.alloc(width);
  let v = value;
  for (let i = 0; i < width; i++) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  if (v !== 0n) throw new Error(`value does not fit in ${width} bytes`);
  return out;
}

function modPow(base: bigint, exp: bigint, mod: bigint): bigint {
  let result = 1n;
  let b = base % mod;
  let e = exp;
  while (e > 0n) {
    if (e & 1n) result = (result * b) % mod;
    b = (b * b) % mod;
    e >>= 1n;
  }
  return result;
}

/** AzerothCore uppercases username and password before hashing. */
export function calculateVerifier(username: string, password: string, salt: Uint8Array): Buffer {
  const inner = sha1(username.toUpperCase(), ":", password.toUpperCase());
  const exponent = fromLE(sha1(salt, inner));
  return toLE(modPow(G, exponent, N), 32);
}

// ---------------------------------------------------------------- plumbing

function env(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined) throw new Error(`missing required environment variable ${name}`);
  return v;
}

/**
 * The database password, mirroring compose's `${WRATHBENCH_DB_ROOT_PASSWORD:-wrathbench}`:
 * the service env sets WRATHBENCH_DB_PASSWORD, a host shell or `.env` more often
 * sets WRATHBENCH_DB_ROOT_PASSWORD (infra/README), and the compose default is
 * the literal. Without the last step every invocation from a container that
 * predates the env block would throw instead of connecting.
 */
function dbPassword(): string {
  return process.env["WRATHBENCH_DB_PASSWORD"] ?? process.env["WRATHBENCH_DB_ROOT_PASSWORD"] ?? "wrathbench";
}

const cfg = {
  host: env("WRATHBENCH_DB_HOST", "db"),
  port: Number(env("WRATHBENCH_DB_PORT", "3306")),
  user: env("WRATHBENCH_DB_USER", "root"),
  password: dbPassword(),
  database: env("WRATHBENCH_AUTH_DB", "acore_auth"),
  realmId: Number(env("WRATHBENCH_REALM_ID", "1")),
  realmName: env("WRATHBENCH_REALM_NAME", "WrathBench"),
  realmAddress: env("WRATHBENCH_REALM_ADDRESS", "worldserver"),
  realmPort: Number(env("WRATHBENCH_REALM_PORT", "8085")),
  accountUser: env("WRATHBENCH_ACCOUNT_USER", "RUNNER").toUpperCase(),
  accountPassword: env("WRATHBENCH_ACCOUNT_PASSWORD", "RUNNER").toUpperCase(),
} as const;

/** WotLK client build. Must match the realmlist row or the client is refused. */
const GAMEBUILD = 12340;
/** Expansion 2 = Wrath of the Lich King, matching account.sql's default. */
const EXPANSION = 2;

const log = (msg: string) => console.log(`[bootstrap] ${msg}`);

async function connect(): Promise<SQL> {
  const deadline = Date.now() + 120_000;
  let lastError: unknown;
  for (;;) {
    const sql = new SQL({
      adapter: "mysql",
      hostname: cfg.host,
      port: cfg.port,
      username: cfg.user,
      password: cfg.password,
      database: cfg.database,
      // MySQL 8.4 defaults to caching_sha2_password, whose first handshake for
      // a given user needs the server's RSA public key. The connection never
      // leaves the private container network (compose's, or the cluster's), so
      // fetching it in the clear is fine; the alternative is TLS certificates we
      // would have to manage.
      allowPublicKeyRetrieval: true,
      max: 1,
    });
    try {
      await sql`SELECT 1`;
      return sql;
    } catch (err) {
      lastError = err;
      await sql.close().catch(() => {});
      if (Date.now() > deadline) break;
      await Bun.sleep(2000);
    }
  }
  throw new Error(`could not reach ${cfg.host}:${cfg.port}/${cfg.database}: ${lastError}`);
}

// ---------------------------------------------------------------- the work

async function ensureRealm(sql: SQL): Promise<void> {
  // Keyed on id, not name: idx_name is UNIQUE, and the worldserver selects its
  // row by RealmID. Renaming the stock row in place avoids a duplicate.
  await sql`
    INSERT INTO realmlist (id, name, address, localAddress, localSubnetMask, port, gamebuild)
    VALUES (${cfg.realmId}, ${cfg.realmName}, ${cfg.realmAddress}, ${cfg.realmAddress}, '255.255.255.0', ${cfg.realmPort}, ${GAMEBUILD})
    ON DUPLICATE KEY UPDATE
      name = VALUES(name),
      address = VALUES(address),
      localAddress = VALUES(localAddress),
      localSubnetMask = VALUES(localSubnetMask),
      port = VALUES(port),
      gamebuild = VALUES(gamebuild)
  `;
  // Anything left over from a previous realm layout would confuse the client's
  // realm list; there is exactly one realm in this harness.
  await sql`DELETE FROM realmlist WHERE id <> ${cfg.realmId}`;
  log(`realm ${cfg.realmId} '${cfg.realmName}' -> ${cfg.realmAddress}:${cfg.realmPort} (build ${GAMEBUILD})`);
}

type AccountRow = { id: number; salt: string; verifier: string };

async function readAccount(sql: SQL, username: string = cfg.accountUser): Promise<AccountRow | undefined> {
  const rows = (await sql`
    SELECT id, HEX(salt) AS salt, HEX(verifier) AS verifier
    FROM account WHERE username = ${username}
  `) as AccountRow[];
  return rows[0];
}

/**
 * AccountMgr::CreateAccount runs this immediately after inserting an account
 * (LOGIN_INS_REALM_CHARACTERS_INIT). Copied verbatim. The LEFT JOIN guard makes
 * it a no-op on re-runs, and it repairs the row after realmlist pruning, so it
 * runs on every path through ensureAccount, not just the create path.
 */
async function ensureRealmCharacters(sql: SQL): Promise<void> {
  await sql`
    INSERT INTO realmcharacters (realmid, acctid, numchars)
    SELECT realmlist.id, account.id, 0
    FROM realmlist, account
    LEFT JOIN realmcharacters ON acctid = account.id
    WHERE acctid IS NULL
  `;
}

async function ensureAccount(sql: SQL): Promise<void> {
  const existing = await readAccount(sql);

  if (existing) {
    const salt = Buffer.from(existing.salt, "hex");
    const expected = calculateVerifier(cfg.accountUser, cfg.accountPassword, salt);
    if (expected.toString("hex").toUpperCase() === existing.verifier) {
      log(`account '${cfg.accountUser}' (id ${existing.id}) already matches the configured password`);
      await ensureRealmCharacters(sql);
      return;
    }
    const newSalt = randomBytes(32);
    const newVerifier = calculateVerifier(cfg.accountUser, cfg.accountPassword, newSalt);
    await sql`
      UPDATE account
      SET salt = UNHEX(${newSalt.toString("hex")}),
          verifier = UNHEX(${newVerifier.toString("hex")}),
          expansion = ${EXPANSION}
      WHERE id = ${existing.id}
    `;
    log(`account '${cfg.accountUser}' (id ${existing.id}) password reset to the configured value`);
  } else {
    const salt = randomBytes(32);
    const verifier = calculateVerifier(cfg.accountUser, cfg.accountPassword, salt);
    await sql`
      INSERT INTO account (username, salt, verifier, expansion, email, reg_mail, joindate)
      VALUES (${cfg.accountUser}, UNHEX(${salt.toString("hex")}), UNHEX(${verifier.toString("hex")}), ${EXPANSION}, '', '', NOW())
    `;
    log(`account '${cfg.accountUser}' created`);
  }

  // No account_access row: the runner account is an ordinary player. The agent
  // gets no GM privileges, by contract. To add an operator account by hand,
  // see infra/README.md.

  await ensureRealmCharacters(sql);
  await verifyRoundTrip(sql, cfg.accountUser, cfg.accountPassword);
}

/**
 * Round trip check. Catches any encoding or truncation damage on the binary
 * columns; it cannot catch a wrong derivation, only a wrong storage.
 */
async function verifyRoundTrip(sql: SQL, username: string, password: string): Promise<AccountRow> {
  const stored = await readAccount(sql, username);
  if (!stored) throw new Error("account vanished immediately after write");
  const recomputed = calculateVerifier(
    username,
    password,
    Buffer.from(stored.salt, "hex"),
  );
  if (stored.salt.length !== 64 || stored.verifier.length !== 64) {
    throw new Error(`stored salt/verifier are not 32 bytes: ${stored.salt.length / 2}/${stored.verifier.length / 2}`);
  }
  if (recomputed.toString("hex").toUpperCase() !== stored.verifier) {
    throw new Error("stored verifier does not match a recomputation from the stored salt");
  }
  log("verifier round trip verified against the stored salt");
  return stored;
}

// ------------------------------------------------------- --accounts-only

/**
 * ensureRealmCharacters for one account: the same insert, kept to the account
 * just created, so the mode writes no row of any other account.
 */
async function ensureRealmCharactersOf(sql: SQL, accountId: number): Promise<void> {
  await sql`
    INSERT INTO realmcharacters (realmid, acctid, numchars)
    SELECT realmlist.id, account.id, 0
    FROM realmlist, account
    LEFT JOIN realmcharacters ON acctid = account.id
    WHERE acctid IS NULL AND account.id = ${accountId}
  `;
}

/**
 * Create each named account that is missing, its password its name. An
 * account that exists is reported and left exactly as it is, whatever its
 * password or access: this mode only ever adds.
 */
async function ensureNamedAccounts(sql: SQL, names: readonly string[]): Promise<void> {
  for (const name of names) {
    const existing = await readAccount(sql, name);
    if (existing) {
      log(`account '${name}' (id ${existing.id}) exists; left as it is`);
      continue;
    }
    const salt = randomBytes(32);
    const verifier = calculateVerifier(name, name, salt);
    await sql`
      INSERT INTO account (username, salt, verifier, expansion, email, reg_mail, joindate)
      VALUES (${name}, UNHEX(${salt.toString("hex")}), UNHEX(${verifier.toString("hex")}), ${EXPANSION}, '', '', NOW())
    `;
    const created = await verifyRoundTrip(sql, name, name);
    await ensureRealmCharactersOf(sql, created.id);
    log(`account '${name}' (id ${created.id}) created; its password is its name`);
  }
  log(
    "the module serves an account only once it is in its allowlist (the chart's worldserver.accounts, " +
      "AC_WRATH_BENCH_ACCOUNTS on the quickstart), which it reads when the worldserver is recreated",
  );
}

// ---------------------------------------------------------------- the CLI

/** The flag of the account-only mode. wb checks the runner pod's copy of this file carries it before it runs one. */
export const ACCOUNTS_ONLY = "--accounts-only";

/** A harness account name, uppercased: a letter, then letters and digits, 16 at most (the client's password field, and the password is the name). */
const ACCOUNT_NAME = /^[A-Z][A-Z0-9]{0,15}$/;

const USAGE = `usage: bun infra/bootstrap/bootstrap.ts                    the realm row and the configured runner account
       bun infra/bootstrap/bootstrap.ts ${ACCOUNTS_ONLY} NAME…   create each named account that is missing, password = its name;
                                                             nothing else is written`;

export type Mode = { kind: "bootstrap" } | { kind: "accounts"; names: string[] } | { kind: "help" } | { kind: "error"; message: string };

/** No arguments is the Job's bootstrap, unchanged; anything else is the account-only mode or a refusal. */
export function parseArgs(argv: readonly string[]): Mode {
  if (argv.length === 0) return { kind: "bootstrap" };
  if (argv[0] === "-h" || argv[0] === "--help") return { kind: "help" };
  if (argv[0] !== ACCOUNTS_ONLY) return { kind: "error", message: `unknown argument ${argv[0]}` };
  const names: string[] = [];
  for (const raw of argv.slice(1)) {
    if (raw === "-h" || raw === "--help") return { kind: "help" };
    if (raw.startsWith("-")) return { kind: "error", message: `unknown flag ${raw}` };
    const name = raw.toUpperCase();
    if (!ACCOUNT_NAME.test(name)) return { kind: "error", message: `${JSON.stringify(raw)} is not an account name: a letter, then letters and digits, 16 at most` };
    if (name === "SPECTATOR") return { kind: "error", message: "SPECTATOR is the operator's GM account; infra/spectator-account.ts (bun wb accounts spectator) owns it" };
    if (!names.includes(name)) names.push(name);
  }
  if (names.length === 0) return { kind: "error", message: `${ACCOUNTS_ONLY} needs the accounts to create, by name; it has no default` };
  return { kind: "accounts", names };
}

/** The whole program, with the connection injectable for the tests. Arguments are checked before anything connects. */
export async function main(argv: readonly string[], open: () => Promise<SQL> = connect): Promise<number> {
  const mode = parseArgs(argv);
  if (mode.kind === "help") {
    console.log(USAGE);
    return 0;
  }
  if (mode.kind === "error") {
    console.error(`bootstrap: ${mode.message}\n${USAGE}`);
    return 2;
  }
  const sql = await open();
  try {
    if (mode.kind === "accounts") {
      await ensureNamedAccounts(sql, mode.names);
    } else {
      await ensureRealm(sql);
      await ensureAccount(sql);
    }
    log("done");
  } finally {
    await sql.close().catch(() => {});
  }
  return 0;
}

if (import.meta.main) process.exit(await main(Bun.argv.slice(2)));
