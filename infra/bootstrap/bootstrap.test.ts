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

async function run(argv: string[], db: ReturnType<typeof fakeDb>, env: Record<string, string | undefined> = {}): Promise<number> {
  const log = console.log;
  const error = console.error;
  console.log = () => {};
  console.error = () => {};
  try {
    return await main(argv, async () => db.sql, env);
  } finally {
    console.log = log;
    console.error = error;
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

  test("creates only the accounts it is named, never the configured runner account the Job owns", async () => {
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

describe("the generated pool", () => {
  test("the plain run creates POOL01 to the size, each with its name as its password, beside the runner account", async () => {
    const db = fakeDb();
    expect(await run([], db, { WRATHBENCH_POOL_SIZE: "3" })).toBe(0);
    expect([...db.accounts.keys()].sort()).toEqual(["POOL01", "POOL02", "POOL03", "RUNNER"]);
    const p2 = db.accounts.get("POOL02")!;
    expect(calculateVerifier("POOL02", "POOL02", Buffer.from(p2.salt, "hex")).toString("hex").toUpperCase()).toBe(p2.verifier);
  });

  test("a pool account that exists is left as it is, and unset or 0 creates none", async () => {
    const seeded = fakeDb({ POOL01: { id: 7, salt: "AA", verifier: "BB" } });
    await run([], seeded, { WRATHBENCH_POOL_SIZE: "2" });
    expect(seeded.accounts.get("POOL01")).toEqual({ id: 7, salt: "AA", verifier: "BB" });
    expect(seeded.accounts.has("POOL02")).toBe(true);
    for (const env of [{}, { WRATHBENCH_POOL_SIZE: "0" }, { WRATHBENCH_POOL_SIZE: "" }]) {
      const db = fakeDb();
      await run([], db, env);
      expect([...db.accounts.keys()]).toEqual(["RUNNER"]);
    }
  });

  test("the account-only mode never creates the pool, and a size that does not read exits 2 before anything connects", async () => {
    const db = fakeDb();
    await run(["--accounts-only", "SMOKE6"], db, { WRATHBENCH_POOL_SIZE: "4" });
    expect([...db.accounts.keys()]).toEqual(["SMOKE6"]);
    for (const size of ["100", "-1", "four"]) {
      let opened = false;
      const code = await (async () => {
        const error = console.error;
        console.error = () => {};
        try {
          return await main([], async () => ((opened = true), fakeDb().sql), { WRATHBENCH_POOL_SIZE: size });
        } finally {
          console.error = error;
        }
      })();
      expect(code).toBe(2);
      expect(opened).toBe(false);
    }
  });
});

describe("hosted mode's tenant pool", () => {
  /** The plain run with every line it printed. */
  async function runLogged(db: ReturnType<typeof fakeDb>, env: Record<string, string | undefined>): Promise<{ code: number; out: string }> {
    const lines: string[] = [];
    const log = console.log;
    const error = console.error;
    console.log = (...a: unknown[]) => void lines.push(a.join(" "));
    console.error = (...a: unknown[]) => void lines.push(a.join(" "));
    try {
      return { code: await main([], async () => db.sql, env), out: lines.join("\n") };
    } finally {
      console.log = log;
      console.error = error;
    }
  }

  test("the plain run creates TENANT01 to the size with a random password it never prints, and no account access", async () => {
    const db = fakeDb();
    const { code, out } = await runLogged(db, { WRATHBENCH_TENANT_POOL_SIZE: "2" });
    expect(code).toBe(0);
    expect([...db.accounts.keys()].sort()).toEqual(["RUNNER", "TENANT01", "TENANT02"]);
    for (const name of ["TENANT01", "TENANT02"]) {
      const row = db.accounts.get(name)!;
      // Not a harness account's password: the name is not it.
      expect(calculateVerifier(name, name, Buffer.from(row.salt, "hex")).toString("hex").toUpperCase()).not.toBe(row.verifier);
      const access = db.statements.filter((s) => s.text.startsWith("DELETE FROM account_access"));
      expect(access.some((s) => s.values[0] === row.id), name).toBe(true);
    }
    // The password is 32 random bytes in hex; nothing that long is printed.
    expect(out).not.toMatch(/[0-9a-f]{32}/i);
    expect(out).toContain("TENANT01 to TENANT02");
  });

  test("two tenants, or two runs, never share a password", async () => {
    const a = fakeDb();
    const b = fakeDb();
    await runLogged(a, { WRATHBENCH_TENANT_POOL_SIZE: "2" });
    await runLogged(b, { WRATHBENCH_TENANT_POOL_SIZE: "1" });
    const one = a.accounts.get("TENANT01")!;
    const two = a.accounts.get("TENANT02")!;
    const other = b.accounts.get("TENANT01")!;
    expect(new Set([one.verifier, two.verifier, other.verifier]).size).toBe(3);
  });

  test("an existing tenant keeps its password but loses any account access; unset or 0 creates none", async () => {
    const seeded = fakeDb({ TENANT01: { id: 7, salt: "AA", verifier: "BB" } });
    await runLogged(seeded, { WRATHBENCH_TENANT_POOL_SIZE: "1" });
    expect(seeded.accounts.get("TENANT01")).toEqual({ id: 7, salt: "AA", verifier: "BB" });
    expect(seeded.statements.filter((s) => s.text.startsWith("DELETE FROM account_access")).map((s) => s.values)).toEqual([[7]]);
    for (const env of [{}, { WRATHBENCH_TENANT_POOL_SIZE: "0" }, { WRATHBENCH_TENANT_POOL_SIZE: "" }]) {
      const db = fakeDb();
      await runLogged(db, env);
      expect([...db.accounts.keys()]).toEqual(["RUNNER"]);
      expect(db.statements.some((s) => s.text.includes("account_access"))).toBe(false);
    }
  });

  test("the account-only mode never creates one and refuses to be named one; a bad size exits 2 before anything connects", async () => {
    const db = fakeDb();
    await run(["--accounts-only", "SMOKE6"], db, { WRATHBENCH_TENANT_POOL_SIZE: "4" });
    expect([...db.accounts.keys()]).toEqual(["SMOKE6"]);
    expect(parseArgs(["--accounts-only", "tenant05"])).toMatchObject({ kind: "error" });
    expect(parseArgs(["--accounts-only", "TENANT"])).toEqual({ kind: "accounts", names: ["TENANT"] });
    for (const size of ["100", "-1", "twenty"]) {
      let opened = false;
      const error = console.error;
      console.error = () => {};
      try {
        expect(await main([], async () => ((opened = true), fakeDb().sql), { WRATHBENCH_TENANT_POOL_SIZE: size })).toBe(2);
      } finally {
        console.error = error;
      }
      expect(opened).toBe(false);
    }
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
