/**
 * bootstrap.ts, against a recording stand-in for the auth database.
 *
 * The property pinned here is the one `--accounts-only` exists for: it writes
 * accounts and nothing else. Run in the runner pod, which carries no
 * WRATHBENCH_REALM_* variable, the plain bootstrap would re-advertise the realm
 * at this file's defaults and delete every other realm row; the account-only
 * mode must not touch realmlist at all. The plain run is checked alongside, as
 * the control: it is what the chart's Job runs, and it must still write both.
 */
import { describe, expect, test } from "bun:test";
import type { SQL } from "bun";
import { calculateVerifier, main, parseArgs } from "./bootstrap";

type Row = { id: number; salt: string; verifier: string };

/**
 * A tagged-template stand-in for Bun's SQL: records every statement with its
 * whitespace collapsed, and keeps just enough of the account table for the
 * reads that follow a write to see it.
 */
function fakeDb(seed: Record<string, Row> = {}) {
  const accounts = new Map(Object.entries(seed));
  const statements: { text: string; values: unknown[] }[] = [];
  let nextId = 100;
  const sql = async (strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]> => {
    const text = strings.join("?").replace(/\s+/g, " ").trim();
    statements.push({ text, values });
    if (text.startsWith("SELECT id, HEX(salt)")) {
      const row = accounts.get(values[0] as string);
      return row === undefined ? [] : [row];
    }
    if (text.startsWith("INSERT INTO account ")) {
      const [username, salt, verifier] = values as [string, string, string];
      accounts.set(username, { id: nextId++, salt: salt.toUpperCase(), verifier: verifier.toUpperCase() });
    }
    return [];
  };
  let closed = false;
  Object.assign(sql, { close: async () => void (closed = true) });
  return { sql: sql as unknown as SQL, statements, accounts, isClosed: () => closed };
}

const REALM_WRITE = /^(INSERT INTO|UPDATE|DELETE FROM|REPLACE INTO) realmlist\b/i;
const ACCOUNT_WRITE = /^(INSERT INTO|UPDATE|DELETE FROM|REPLACE INTO) account\b/i;

async function run(argv: string[], db: ReturnType<typeof fakeDb>): Promise<number> {
  const log = console.log;
  console.log = () => {};
  try {
    return await main(argv, async () => db.sql);
  } finally {
    console.log = log;
  }
}

describe("--accounts-only", () => {
  test("creates the named account with its name as its password, and writes no realm row", async () => {
    const db = fakeDb();
    expect(await run(["--accounts-only", "smoke5"], db)).toBe(0);
    expect(db.statements.filter((s) => REALM_WRITE.test(s.text))).toEqual([]);
    const row = db.accounts.get("SMOKE5")!;
    expect(row).toBeDefined();
    expect(calculateVerifier("SMOKE5", "SMOKE5", Buffer.from(row.salt, "hex")).toString("hex").toUpperCase()).toBe(row.verifier);
    expect(db.isClosed()).toBe(true);
  });

  test("its realmcharacters row is the new account's alone", async () => {
    const db = fakeDb();
    await run(["--accounts-only", "SMOKE5"], db);
    const rc = db.statements.filter((s) => s.text.startsWith("INSERT INTO realmcharacters"));
    expect(rc.length).toBe(1);
    expect(rc[0]!.text).toContain("AND account.id = ?");
    expect(rc[0]!.values).toEqual([db.accounts.get("SMOKE5")!.id]);
  });

  test("an account that exists is left exactly as it is, whatever its password", async () => {
    const db = fakeDb({ PROBE: { id: 7, salt: "AB".repeat(32), verifier: "CD".repeat(32) } });
    expect(await run(["--accounts-only", "PROBE"], db)).toBe(0);
    expect(db.statements.filter((s) => REALM_WRITE.test(s.text) || ACCOUNT_WRITE.test(s.text))).toEqual([]);
    expect(db.statements.some((s) => s.text.startsWith("INSERT INTO realmcharacters"))).toBe(false);
    expect(db.accounts.get("PROBE")).toEqual({ id: 7, salt: "AB".repeat(32), verifier: "CD".repeat(32) });
  });

  test("never the configured runner account: the Job owns it, and the mode reads none of its variables", async () => {
    const db = fakeDb();
    await run(["--accounts-only", "SMOKE6", "PROBE"], db);
    expect([...db.accounts.keys()].sort()).toEqual(["PROBE", "SMOKE6"]);
  });
});

describe("no arguments: the chart's Job, unchanged", () => {
  test("still writes realm 1 and prunes the other realm rows, then converges the runner account", async () => {
    const db = fakeDb();
    expect(await run([], db)).toBe(0);
    const realm = db.statements.filter((s) => REALM_WRITE.test(s.text)).map((s) => s.text.split(" (")[0]!.split(" WHERE")[0]);
    expect(realm).toEqual(["INSERT INTO realmlist", "DELETE FROM realmlist"]);
    expect(db.accounts.size).toBe(1);
    // The Job's realmcharacters repair covers every account, as AccountMgr's does.
    const rc = db.statements.find((s) => s.text.startsWith("INSERT INTO realmcharacters"))!;
    expect(rc.text).not.toContain("account.id = ?");
  });
});

describe("arguments", () => {
  test("the account-only mode always names its accounts", () => {
    expect(parseArgs(["--accounts-only"])).toMatchObject({ kind: "error" });
  });

  test("names are uppercased, deduplicated and kept to what a 3.3.5a login can type", () => {
    expect(parseArgs(["--accounts-only", "smoke5", "SMOKE5", "Probe"])).toEqual({ kind: "accounts", names: ["SMOKE5", "PROBE"] });
    for (const bad of ["5SMOKE", "SMOKE-5", "", "A".repeat(17), "x y", "SMOKE5;DROP"]) {
      expect(parseArgs(["--accounts-only", bad]), bad).toMatchObject({ kind: "error" });
    }
  });

  test("SPECTATOR is the GM account's tool's, never this mode's", () => {
    expect(parseArgs(["--accounts-only", "spectator"])).toMatchObject({ kind: "error" });
  });

  test("an unknown argument or flag is refused, and --help is help", () => {
    expect(parseArgs(["SMOKE5"])).toMatchObject({ kind: "error" });
    expect(parseArgs(["--accounts-only", "SMOKE5", "--force"])).toMatchObject({ kind: "error" });
    expect(parseArgs(["--help"])).toEqual({ kind: "help" });
    expect(parseArgs(["--accounts-only", "--help"])).toEqual({ kind: "help" });
  });

  test("a refusal exits 2 before anything connects", async () => {
    let opened = false;
    const err = console.error;
    console.error = () => {};
    try {
      const code = await main(["--accounts-only"], async () => {
        opened = true;
        return fakeDb().sql;
      });
      expect(code).toBe(2);
    } finally {
      console.error = err;
    }
    expect(opened).toBe(false);
  });
});
