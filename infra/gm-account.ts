/**
 * Ensure an operator GM account: idempotently create (or re-password) one
 * named auth account with full GM, gmlevel 3 on every realm. Shared by
 * `spectator-account.ts` (SPECTATOR, the operator's in-game eyes) and
 * `stager-account.ts` (STAGER, the party stager's SOAP credential).
 *
 * This is operator tooling, outside the agent path: the observation/action
 * contracts in wrath-mcp/docs/CONTRACTS.md bind the benchmark agent, not the operator.
 * Neither account is created by bootstrap.ts — the harness accounts never
 * carry GM — and neither is on the module's account allowlist, so no bench
 * session can be opened on either.
 *
 * There is no default password, and it is never on a command line, where the
 * process list would show it: stdin with `--password-stdin` (how `bun wb
 * accounts …` passes it, since `kubectl exec` carries no environment), else
 * the script's own environment variable. AzerothCore uppercases before
 * hashing, and the 3.3.5a login field caps at 16. Re-run with a new password
 * to rotate it.
 */

import { SQL } from "bun";
import { randomBytes } from "node:crypto";
import { calculateVerifier } from "./bootstrap/bootstrap.ts";

/** Expansion 2 = Wrath of the Lich King. */
const EXPANSION = 2;
/** Full GM: SEC_ADMINISTRATOR, which SOAP requires. */
export const GMLEVEL = 3;
/** account_access RealmID -1 = every realm. */
const REALM_ID = -1;

/** The flag that reads the password from stdin. wb checks the runner pod's copy of a script carries it before it runs one. */
export const PASSWORD_STDIN = "--password-stdin";

export type GmAccountSpec = {
  /** The account name, upper case. */
  account: string;
  /** The env variable read when `--password-stdin` is not given. */
  passwordEnv: string;
  /** `account_access.comment`. */
  comment: string;
  /** For the usage line. */
  script: string;
  /** Log prefix. */
  tag: string;
};

function env(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined) throw new Error(`missing required environment variable ${name}`);
  return v;
}

async function readPassword(spec: GmAccountSpec, argv: readonly string[]): Promise<string> {
  // Environment or stdin only: an argument would put the password in the process list.
  if (argv.some((a) => a !== PASSWORD_STDIN)) {
    console.error(`usage: bun ${spec.script} [${PASSWORD_STDIN}]   (the password: stdin with the flag, else ${spec.passwordEnv})`);
    process.exit(2);
  }
  const fromStdin = argv.includes(PASSWORD_STDIN);
  const raw = fromStdin ? (await Bun.stdin.text()).replace(/\r?\n$/, "") : process.env[spec.passwordEnv];
  if (!raw || raw.trim() === "") {
    console.error(
      (fromStdin ? "No password given on stdin.\n" : `No password given. Set ${spec.passwordEnv}, or pass it on stdin with ${PASSWORD_STDIN}.\n`) +
        "There is deliberately no default; pick your own.",
    );
    process.exit(1);
  }
  const pass = raw.toUpperCase();
  if (pass.length > 16) {
    console.error("Password longer than 16 characters; the 3.3.5a client cannot enter it, and AzerothCore truncates nothing for you.");
    process.exit(1);
  }
  return pass;
}

/**
 * The database password, mirroring compose's `${WRATHBENCH_DB_ROOT_PASSWORD:-wrathbench}`:
 * the service env sets WRATHBENCH_DB_PASSWORD, a host shell or `.env` more often
 * sets WRATHBENCH_DB_ROOT_PASSWORD (infra/README), and the compose default is
 * the literal.
 */
function dbPassword(): string {
  return process.env["WRATHBENCH_DB_PASSWORD"] ?? process.env["WRATHBENCH_DB_ROOT_PASSWORD"] ?? "wrathbench";
}

async function connect(): Promise<SQL> {
  const sql = new SQL({
    adapter: "mysql",
    hostname: env("WRATHBENCH_DB_HOST", "db"),
    port: Number(env("WRATHBENCH_DB_PORT", "3306")),
    username: env("WRATHBENCH_DB_USER", "root"),
    password: dbPassword(),
    database: env("WRATHBENCH_AUTH_DB", "acore_auth"),
    // Same reasoning as bootstrap.ts: the private container network only.
    allowPublicKeyRetrieval: true,
    max: 1,
  });
  await sql`SELECT 1`;
  return sql;
}

type AccountRow = { id: number; salt: string; verifier: string; expansion: number };

async function readAccount(sql: SQL, account: string): Promise<AccountRow | undefined> {
  const rows = (await sql`
    SELECT id, HEX(salt) AS salt, HEX(verifier) AS verifier, expansion
    FROM account WHERE username = ${account}
  `) as AccountRow[];
  return rows[0];
}

async function ensureAccount(sql: SQL, spec: GmAccountSpec, password: string): Promise<number> {
  const log = (msg: string) => console.log(`[${spec.tag}] ${msg}`);
  const existing = await readAccount(sql, spec.account);

  if (existing) {
    const expected = calculateVerifier(spec.account, password, Buffer.from(existing.salt, "hex"));
    if (expected.toString("hex").toUpperCase() === existing.verifier && existing.expansion === EXPANSION) {
      log(`account '${spec.account}' (id ${existing.id}) already matches the given password`);
      return existing.id;
    }
    const salt = randomBytes(32);
    const verifier = calculateVerifier(spec.account, password, salt);
    await sql`
      UPDATE account
      SET salt = UNHEX(${salt.toString("hex")}),
          verifier = UNHEX(${verifier.toString("hex")}),
          expansion = ${EXPANSION}
      WHERE id = ${existing.id}
    `;
    log(`account '${spec.account}' (id ${existing.id}) password reset to the given value`);
    return existing.id;
  }

  const salt = randomBytes(32);
  const verifier = calculateVerifier(spec.account, password, salt);
  await sql`
    INSERT INTO account (username, salt, verifier, expansion, email, reg_mail, joindate)
    VALUES (${spec.account}, UNHEX(${salt.toString("hex")}), UNHEX(${verifier.toString("hex")}), ${EXPANSION}, '', '', NOW())
  `;
  const created = await readAccount(sql, spec.account);
  if (!created) throw new Error("account vanished immediately after insert");
  log(`account '${spec.account}' (id ${created.id}) created`);
  return created.id;
}

async function ensureGmAccess(sql: SQL, spec: GmAccountSpec, accountId: number): Promise<void> {
  await sql`
    INSERT INTO account_access (id, gmlevel, RealmID, comment)
    VALUES (${accountId}, ${GMLEVEL}, ${REALM_ID}, ${spec.comment})
    ON DUPLICATE KEY UPDATE gmlevel = VALUES(gmlevel), comment = VALUES(comment)
  `;
}

/** Same repair as bootstrap.ts: character-count row per realm for the client. */
async function ensureRealmCharacters(sql: SQL): Promise<void> {
  await sql`
    INSERT INTO realmcharacters (realmid, acctid, numchars)
    SELECT realmlist.id, account.id, 0
    FROM realmlist, account
    LEFT JOIN realmcharacters ON acctid = account.id
    WHERE acctid IS NULL
  `;
}

async function verify(sql: SQL, spec: GmAccountSpec, password: string): Promise<void> {
  const stored = await readAccount(sql, spec.account);
  if (!stored) throw new Error("account row missing after write");
  if (stored.salt.length !== 64 || stored.verifier.length !== 64) {
    throw new Error(`stored salt/verifier are not 32 bytes: ${stored.salt.length / 2}/${stored.verifier.length / 2}`);
  }
  const recomputed = calculateVerifier(spec.account, password, Buffer.from(stored.salt, "hex"));
  if (recomputed.toString("hex").toUpperCase() !== stored.verifier) {
    throw new Error("stored verifier does not match a recomputation from the stored salt");
  }
  const access = (await sql`
    SELECT gmlevel, RealmID FROM account_access WHERE id = ${stored.id}
  `) as { gmlevel: number; RealmID: number }[];
  const row = access.find((r) => r.RealmID === REALM_ID);
  if (!row || row.gmlevel !== GMLEVEL) {
    throw new Error(`account_access row missing or wrong: ${JSON.stringify(access)}`);
  }
  console.log(
    `[${spec.tag}] verified: id ${stored.id}, expansion ${stored.expansion}, gmlevel ${row.gmlevel} on RealmID ${row.RealmID}, verifier round trip OK`,
  );
}

/** The whole CLI: read the password, ensure the account and its GM row, verify. */
export async function runGmAccountCli(spec: GmAccountSpec, argv: readonly string[]): Promise<void> {
  const password = await readPassword(spec, argv);
  const sql = await connect();
  try {
    const id = await ensureAccount(sql, spec, password);
    await ensureGmAccess(sql, spec, id);
    await ensureRealmCharacters(sql);
    await verify(sql, spec, password);
    console.log(`[${spec.tag}] done`);
  } finally {
    await sql.close().catch(() => {});
  }
}
