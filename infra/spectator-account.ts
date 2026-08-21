/**
 * Operator spectator account.
 *
 * Idempotently ensures the SPECTATOR account exists with the given password
 * and full GM (gmlevel 3 on every realm), so the operator can log in with
 * their own client and watch benchmark characters. See infra/SPECTATOR.md.
 *
 * This is operator tooling, outside the agent path: the observation/action
 * contracts in docs/CONTRACTS.md bind the benchmark agent, not the human at
 * the keyboard. The account is deliberately not created by bootstrap.ts —
 * the harness accounts never carry GM, and this one never runs unattended.
 *
 * There is no default password. Pass one:
 *
 *   docker compose -f infra/compose.yml run --rm --no-deps \
 *     -e WRATHBENCH_SPECTATOR_PASSWORD=<password> \
 *     bootstrap bun run infra/spectator-account.ts
 *
 * (or `--password <password>` as an argument). Re-run with a new password to
 * rotate it.
 */

import { SQL } from "bun";
import { randomBytes } from "node:crypto";
import { calculateVerifier } from "./bootstrap/bootstrap.ts";

const ACCOUNT = "SPECTATOR";
/** Expansion 2 = Wrath of the Lich King. */
const EXPANSION = 2;
/** Full GM. */
const GMLEVEL = 3;
/** account_access RealmID -1 = every realm. */
const REALM_ID = -1;

const log = (msg: string) => console.log(`[spectator] ${msg}`);

function env(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined) throw new Error(`missing required environment variable ${name}`);
  return v;
}

function readPassword(): string {
  const flagIndex = process.argv.indexOf("--password");
  const fromFlag = flagIndex >= 0 ? process.argv[flagIndex + 1] : undefined;
  const raw = fromFlag ?? process.env["WRATHBENCH_SPECTATOR_PASSWORD"];
  if (!raw || raw.trim() === "") {
    console.error(
      "No password given. Set WRATHBENCH_SPECTATOR_PASSWORD or pass --password <password>.\n" +
        "There is deliberately no default; pick your own.",
    );
    process.exit(1);
  }
  // AzerothCore uppercases before hashing; the 3.3.5a login field caps at 16.
  const pass = raw.toUpperCase();
  if (pass.length > 16) {
    console.error("Password longer than 16 characters; the 3.3.5a client cannot enter it.");
    process.exit(1);
  }
  return pass;
}

const cfg = {
  host: env("WRATHBENCH_DB_HOST", "db"),
  port: Number(env("WRATHBENCH_DB_PORT", "3306")),
  user: env("WRATHBENCH_DB_USER", "root"),
  password: env("WRATHBENCH_DB_PASSWORD"),
  database: env("WRATHBENCH_AUTH_DB", "acore_auth"),
} as const;

async function connect(): Promise<SQL> {
  const sql = new SQL({
    adapter: "mysql",
    hostname: cfg.host,
    port: cfg.port,
    username: cfg.user,
    password: cfg.password,
    database: cfg.database,
    // Same reasoning as bootstrap.ts: private compose network only.
    allowPublicKeyRetrieval: true,
    max: 1,
  });
  await sql`SELECT 1`;
  return sql;
}

type AccountRow = { id: number; salt: string; verifier: string; expansion: number };

async function readAccount(sql: SQL): Promise<AccountRow | undefined> {
  const rows = (await sql`
    SELECT id, HEX(salt) AS salt, HEX(verifier) AS verifier, expansion
    FROM account WHERE username = ${ACCOUNT}
  `) as AccountRow[];
  return rows[0];
}

async function ensureAccount(sql: SQL, password: string): Promise<number> {
  const existing = await readAccount(sql);

  if (existing) {
    const expected = calculateVerifier(ACCOUNT, password, Buffer.from(existing.salt, "hex"));
    if (expected.toString("hex").toUpperCase() === existing.verifier && existing.expansion === EXPANSION) {
      log(`account '${ACCOUNT}' (id ${existing.id}) already matches the given password`);
      return existing.id;
    }
    const salt = randomBytes(32);
    const verifier = calculateVerifier(ACCOUNT, password, salt);
    await sql`
      UPDATE account
      SET salt = UNHEX(${salt.toString("hex")}),
          verifier = UNHEX(${verifier.toString("hex")}),
          expansion = ${EXPANSION}
      WHERE id = ${existing.id}
    `;
    log(`account '${ACCOUNT}' (id ${existing.id}) password reset to the given value`);
    return existing.id;
  }

  const salt = randomBytes(32);
  const verifier = calculateVerifier(ACCOUNT, password, salt);
  await sql`
    INSERT INTO account (username, salt, verifier, expansion, email, reg_mail, joindate)
    VALUES (${ACCOUNT}, UNHEX(${salt.toString("hex")}), UNHEX(${verifier.toString("hex")}), ${EXPANSION}, '', '', NOW())
  `;
  const created = await readAccount(sql);
  if (!created) throw new Error("account vanished immediately after insert");
  log(`account '${ACCOUNT}' (id ${created.id}) created`);
  return created.id;
}

async function ensureGmAccess(sql: SQL, accountId: number): Promise<void> {
  await sql`
    INSERT INTO account_access (id, gmlevel, RealmID, comment)
    VALUES (${accountId}, ${GMLEVEL}, ${REALM_ID}, 'wrathbench operator spectator')
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

async function verify(sql: SQL, password: string): Promise<void> {
  const stored = await readAccount(sql);
  if (!stored) throw new Error("account row missing after write");
  if (stored.salt.length !== 64 || stored.verifier.length !== 64) {
    throw new Error(
      `stored salt/verifier are not 32 bytes: ${stored.salt.length / 2}/${stored.verifier.length / 2}`,
    );
  }
  const recomputed = calculateVerifier(ACCOUNT, password, Buffer.from(stored.salt, "hex"));
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
  log(`verified: id ${stored.id}, expansion ${stored.expansion}, gmlevel ${row.gmlevel} on RealmID ${row.RealmID}, verifier round trip OK`);
}

if (import.meta.main) {
  const password = readPassword();
  const sql = await connect();
  try {
    const id = await ensureAccount(sql, password);
    await ensureGmAccess(sql, id);
    await ensureRealmCharacters(sql);
    await verify(sql, password);
    log("done");
  } finally {
    await sql.close().catch(() => {});
  }
}
