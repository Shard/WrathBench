/**
 * Secrets in the config store (`runner/src/store-secrets.ts`): sealed with the
 * store key, bound to their name, write-only. What this pins is the security
 * bar: the value never comes back out anywhere but the resolver, a changed
 * byte or a different key fails closed, and the config's own readers cannot
 * see a secret at all.
 */

import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { ConfigStore } from "../src/config-store";
import {
  clearStoreSecret,
  launchSecret,
  openSecret,
  parseStoreKey,
  readStoreSecret,
  resolveStoreSecrets,
  sealSecret,
  SEALED_SECRET_ENV,
  secretNameRefusal,
  secretValueRefusal,
  SecretRefused,
  SecretUnreadable,
  setStoreSecret,
  STORE_KEY_ENV,
  storedSecretsAt,
  StoreKeyError,
  unsealLaunchSecret,
} from "../src/store-secrets";
import { KEY_HEX, OTHER_KEY_HEX, SENTINEL } from "./fixtures/store-secrets";
import { tempDirs } from "./fixtures/temp-dirs";

const tempDir = tempDirs();


const EXAMPLE = resolve(import.meta.dir, "..", "..", "infra", "fleet.example.json");

function seeded(): { store: ConfigStore; path: string; env: Record<string, string> } {
  const root = tempDir("store-secrets-");
  const path = join(root, "config.sqlite");
  const store = new ConfigStore(path);
  store.seed(JSON.parse(readFileSync(EXAMPLE, "utf8")) as unknown, { actor: "t" });
  return { store, path, env: { [STORE_KEY_ENV]: KEY_HEX, WRATHBENCH_CONFIG_DB: path } };
}

/** Every byte of the store file and its WAL, as text. */
function fileBytes(path: string): string {
  let s = "";
  for (const p of [path, `${path}-wal`]) {
    try {
      s += readFileSync(p).toString("latin1");
    } catch {
      // no WAL
    }
  }
  return s;
}

describe("the store key", () => {
  test("hex or base64 of 32 bytes; anything else is refused without quoting it", () => {
    expect(parseStoreKey(KEY_HEX).id).toMatch(/^[0-9a-f]{8}$/);
    expect(parseStoreKey(Buffer.from(KEY_HEX, "hex").toString("base64")).id).toBe(parseStoreKey(KEY_HEX).id);
    for (const bad of ["short", KEY_HEX.slice(2), Buffer.alloc(16).toString("base64")]) {
      expect(() => parseStoreKey(bad)).toThrow(StoreKeyError);
      try {
        parseStoreKey(bad);
      } catch (e) {
        expect((e as Error).message).not.toContain(bad);
      }
    }
  });

  test("two keys have two ids", () => {
    expect(parseStoreKey(KEY_HEX).id).not.toBe(parseStoreKey(OTHER_KEY_HEX).id);
  });
});

describe("sealing", () => {
  const key = parseStoreKey(KEY_HEX);

  test("round-trips, and the sealed form carries no plaintext", () => {
    const sealed = sealSecret(key, "OPENROUTER_KEY", SENTINEL);
    expect(sealed).not.toContain("SENTINEL");
    expect(openSecret(key, "OPENROUTER_KEY", sealed)).toBe(SENTINEL);
    // A fresh IV each time.
    expect(sealSecret(key, "OPENROUTER_KEY", SENTINEL)).not.toBe(sealed);
  });

  test("a changed byte anywhere is refused: ciphertext, IV, tag", () => {
    const sealed = sealSecret(key, "OPENROUTER_KEY", SENTINEL);
    const parts = sealed.split(".");
    for (const i of [2, 3, 4]) {
      const b = Buffer.from(parts[i]!, "base64url");
      b[0] = b[0]! ^ 1;
      const tampered = [...parts.slice(0, i), b.toString("base64url"), ...parts.slice(i + 1)].join(".");
      expect(() => openSecret(key, "OPENROUTER_KEY", tampered)).toThrow(SecretUnreadable);
    }
  });

  test("a row moved to another name does not open", () => {
    const sealed = sealSecret(key, "OPENROUTER_KEY", SENTINEL);
    expect(() => openSecret(key, "OPENROUTER_KEY_2", sealed)).toThrow(/sealed for another name|changed/);
  });

  test("another key fails closed, and says so", () => {
    const sealed = sealSecret(key, "OPENROUTER_KEY", SENTINEL);
    expect(() => openSecret(parseStoreKey(OTHER_KEY_HEX), "OPENROUTER_KEY", sealed)).toThrow(/another store key/);
    // The same key id forged onto another key's row still does not open.
    const forged = sealSecret(parseStoreKey(OTHER_KEY_HEX), "OPENROUTER_KEY", "x").split(".");
    forged[1] = key.id;
    expect(() => openSecret(key, "OPENROUTER_KEY", forged.join("."))).toThrow(SecretUnreadable);
  });
});

describe("names and values", () => {
  test("only a token's or a key's variable", () => {
    for (const ok of ["OPENROUTER_KEY", "OPENROUTER_KEY_2", "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN_2", "OPENCODE_KEY", "LMSTUDIO_KEY"]) {
      expect(secretNameRefusal(ok)).toBeNull();
    }
    for (const bad of ["LD_PRELOAD", "NODE_OPTIONS", "BUN_OPTIONS", "PATH", "WRATHBENCH_MODULE_SECRET", STORE_KEY_ENV, "OPENROUTER_KEYX", "openrouter_key"]) {
      expect(secretNameRefusal(bad)).not.toBeNull();
    }
    expect(secretNameRefusal("CODEX_HOME")).toMatch(/Codex home/);
    expect(secretNameRefusal("CODEX_HOME_2")).toMatch(/Codex home/);
  });

  test("a value is a non-empty single line, and a refusal never quotes it", () => {
    expect(secretValueRefusal(SENTINEL)).toBeNull();
    for (const bad of ["", "   ", `${SENTINEL}\nX=1`, `${SENTINEL}\u0000`, "x".repeat(9000), 42]) {
      const why = secretValueRefusal(bad);
      expect(why).not.toBeNull();
      expect(why!).not.toContain("SENTINEL");
    }
  });
});

describe("the table", () => {
  test("set, read, rotate, clear; the audit says so with a fingerprint and nothing else", () => {
    const { store, path, env } = seeded();
    const v0 = store.version();
    const { fingerprint } = setStoreSecret(store, "OPENROUTER_KEY", `  ${SENTINEL}  `, { actor: "mark", note: "new key", env });
    expect(store.version()).toBeGreaterThan(v0);
    expect(readStoreSecret("OPENROUTER_KEY", { env, dbPath: path })).toMatchObject({ status: "ok", value: SENTINEL });
    setStoreSecret(store, "OPENROUTER_KEY", `${SENTINEL}-rotated`, { actor: "mark", note: "rotated", env });
    expect(clearStoreSecret(store, "OPENROUTER_KEY", { actor: "mark", note: "back to SOPS", env })).toBe(true);
    expect(clearStoreSecret(store, "OPENROUTER_KEY", { env })).toBe(false);
    expect(readStoreSecret("OPENROUTER_KEY", { env, dbPath: path })).toEqual({ status: "absent" });

    const rows = store.audit(10).filter((r) => r.key === "secrets/OPENROUTER_KEY").reverse();
    expect(rows.map((r) => [r.before === null, r.after === null])).toEqual([
      [true, false],
      [false, false],
      [false, true],
    ]);
    expect(rows[0]!.after).toEqual({ fingerprint });
    expect(rows[0]!.actor).toBe("mark");
    expect(rows[1]!.before).toEqual({ fingerprint });
    const all = JSON.stringify(store.audit(100));
    expect(all).not.toContain("SENTINEL");
    expect(all).not.toContain("v1.");
    store.close();
  });

  test("the config's own readers never see a secret: rows, render, get, export, keys", () => {
    const { store, path, env } = seeded();
    setStoreSecret(store, "OPENROUTER_KEY", SENTINEL, { env });
    const sealed = (store.db.query("SELECT sealed FROM config_secrets").get() as { sealed: string }).sealed;
    const rendered = JSON.stringify(store.render());
    for (const s of [rendered, JSON.stringify(store.rows()), JSON.stringify(store.get("secrets/OPENROUTER_KEY") ?? null)]) {
      expect(s).not.toContain("SENTINEL");
      expect(s).not.toContain(sealed);
    }
    expect(store.rows().some((r) => r.key.startsWith("secrets"))).toBe(false);
    // The generic write path cannot reach one either.
    expect(() => store.put("secrets/OPENROUTER_KEY", "x")).toThrow(/not a config key/);
    // The plaintext is nowhere in the file, WAL included.
    store.close();
    expect(fileBytes(path)).not.toContain("SENTINEL");
    expect(storedSecretsAt(path).map((m) => Object.keys(m).sort())).toEqual([["actor", "keyId", "name", "updatedAt"]]);
  });

  test("a reseed keeps the secrets", () => {
    const { store, path, env } = seeded();
    setStoreSecret(store, "OPENROUTER_KEY", SENTINEL, { env });
    store.seed(JSON.parse(readFileSync(EXAMPLE, "utf8")) as unknown, { force: true });
    expect(readStoreSecret("OPENROUTER_KEY", { env, dbPath: path }).status).toBe("ok");
    store.close();
  });

  test("refused without a key, for a bad name, for a bad value — writing nothing", () => {
    const { store, path, env } = seeded();
    const v0 = store.version();
    expect(() => setStoreSecret(store, "OPENROUTER_KEY", SENTINEL, { env: {} })).toThrow(/refused — no store key/);
    expect(() => setStoreSecret(store, "OPENROUTER_KEY", SENTINEL, { env: { [STORE_KEY_ENV]: "nope" } })).toThrow(SecretRefused);
    expect(() => setStoreSecret(store, "NODE_OPTIONS", SENTINEL, { env })).toThrow(/no provider's secret variable/);
    expect(() => setStoreSecret(store, "CODEX_HOME", "/tmp/x", { env })).toThrow(/Codex home/);
    expect(() => setStoreSecret(store, "OPENROUTER_KEY", "a\nb", { env })).toThrow(/line break/);
    expect(store.version()).toBe(v0);
    expect(storedSecretsAt(path)).toEqual([]);
    store.close();
  });
});

describe("resolution", () => {
  test("a stored secret wins over the environment's; without one the environment stands", () => {
    const { store, path, env } = seeded();
    const base = { ...env, OPENROUTER_KEY: "from-sops", OPENCODE_KEY: "go-from-sops" };
    setStoreSecret(store, "OPENROUTER_KEY", SENTINEL, { env });
    store.close();
    const r = resolveStoreSecrets(base, { dbPath: path });
    expect(r.env["OPENROUTER_KEY"]).toBe(SENTINEL);
    expect(r.env["OPENCODE_KEY"]).toBe("go-from-sops");
    expect([...r.stored]).toEqual(["OPENROUTER_KEY"]);
    expect(r.unreadable.size).toBe(0);
    expect(launchSecret("OPENROUTER_KEY", { env: base, dbPath: path })).toMatchObject({ source: "store", value: SENTINEL });
    expect(launchSecret("OPENCODE_KEY", { env: base, dbPath: path })).toEqual({ source: "env" });
  });

  test("a wrong or missing key fails closed: the variable is unset, not the environment's", () => {
    const { store, path, env } = seeded();
    setStoreSecret(store, "OPENROUTER_KEY", SENTINEL, { env });
    store.close();
    for (const keyEnv of [{ [STORE_KEY_ENV]: OTHER_KEY_HEX }, {}]) {
      const base = { ...keyEnv, OPENROUTER_KEY: "from-sops" };
      const r = resolveStoreSecrets(base, { dbPath: path });
      expect(r.env["OPENROUTER_KEY"]).toBeUndefined();
      expect(r.unreadable.get("OPENROUTER_KEY")).toMatch(/another store key|no store key/);
      expect(launchSecret("OPENROUTER_KEY", { env: base, dbPath: path }).source).toBe("refused");
    }
  });

  test("a tampered row fails closed", () => {
    const { store, path, env } = seeded();
    setStoreSecret(store, "OPENROUTER_KEY", SENTINEL, { env });
    store.close();
    const db = new Database(path);
    const { sealed } = db.query("SELECT sealed FROM config_secrets").get() as { sealed: string };
    const parts = sealed.split(".");
    parts[3] = Buffer.from(Buffer.from(parts[3]!, "base64url").map((b, i) => (i === 0 ? b ^ 0x80 : b))).toString("base64url");
    db.run("UPDATE config_secrets SET sealed = ?", [parts.join(".")]);
    // And a row copied onto another name.
    db.run("INSERT INTO config_secrets (name, sealed, key_id, updated_at, actor) VALUES ('OPENROUTER_KEY_2', ?, 'x', 0, 'x')", [sealed]);
    db.close();
    const r = resolveStoreSecrets({ ...env, OPENROUTER_KEY: "from-sops", OPENROUTER_KEY_2: "from-sops" }, { dbPath: path });
    expect(r.env["OPENROUTER_KEY"]).toBeUndefined();
    expect(r.env["OPENROUTER_KEY_2"]).toBeUndefined();
    expect(r.unreadable.size).toBe(2);
  });

  test("no store file, or a store no secret was written to, is no secret", () => {
    expect(resolveStoreSecrets({ X: "1" }, { dbPath: "/nonexistent/x.sqlite" }).env).toEqual({ X: "1" });
    const { store, path, env } = seeded();
    store.close();
    expect(resolveStoreSecrets(env, { dbPath: path }).stored.size).toBe(0);
  });
});

describe("a run pod's sealed variable", () => {
  test("opens into its variable and drops the sealed form and the key", () => {
    const key = parseStoreKey(KEY_HEX);
    const env: Record<string, string | undefined> = { [STORE_KEY_ENV]: KEY_HEX, [SEALED_SECRET_ENV]: `OPENROUTER_KEY:${sealSecret(key, "OPENROUTER_KEY", SENTINEL)}` };
    expect(unsealLaunchSecret(env)).toBe("OPENROUTER_KEY");
    expect(env).toEqual({ OPENROUTER_KEY: SENTINEL });
  });

  test("nothing sealed still drops the key", () => {
    const env: Record<string, string | undefined> = { [STORE_KEY_ENV]: KEY_HEX };
    expect(unsealLaunchSecret(env)).toBeNull();
    expect(env).toEqual({});
  });

  test("refuses another name, another key, a renamed variable", () => {
    const key = parseStoreKey(KEY_HEX);
    const sealed = sealSecret(key, "OPENROUTER_KEY", SENTINEL);
    expect(() => unsealLaunchSecret({ [STORE_KEY_ENV]: KEY_HEX, [SEALED_SECRET_ENV]: `LD_PRELOAD:${sealed}` })).toThrow(/no provider's secret variable/);
    expect(() => unsealLaunchSecret({ [STORE_KEY_ENV]: KEY_HEX, [SEALED_SECRET_ENV]: `OPENROUTER_KEY_2:${sealed}` })).toThrow(SecretUnreadable);
    expect(() => unsealLaunchSecret({ [STORE_KEY_ENV]: OTHER_KEY_HEX, [SEALED_SECRET_ENV]: `OPENROUTER_KEY:${sealed}` })).toThrow(/another store key/);
    expect(() => unsealLaunchSecret({ [SEALED_SECRET_ENV]: `OPENROUTER_KEY:${sealed}` })).toThrow(StoreKeyError);
  });
});

describe("the CLI", () => {
  const CLI = resolve(import.meta.dir, "..", "src", "config-store.ts");
  const run = (args: string[], env: Record<string, string>, stdin?: string) => {
    const p = Bun.spawnSync(["bun", CLI, ...args], { env: { PATH: process.env["PATH"]!, HOME: process.env["HOME"] ?? "/tmp", ...env }, stdin: stdin === undefined ? "ignore" : Buffer.from(stdin), stdout: "pipe", stderr: "pipe" });
    return { code: p.exitCode, out: p.stdout.toString() + p.stderr.toString() };
  };

  test("set reads the value from stdin only; list, audit and export never print it", () => {
    const { store, path } = seeded();
    store.close();
    const env = { [STORE_KEY_ENV]: KEY_HEX };
    // A value on argv is refused before anything is written.
    expect(run(["secrets", "set", "OPENROUTER_KEY", SENTINEL, "--db", path], env).code).toBe(2);
    const set = run(["secrets", "set", "OPENROUTER_KEY", "--db", path, "--actor", "mark"], env, `${SENTINEL}\n`);
    expect(set.code).toBe(0);
    expect(readStoreSecret("OPENROUTER_KEY", { env, dbPath: path })).toMatchObject({ status: "ok", value: SENTINEL });
    const outs = [set, run(["secrets", "list", "--db", path], env), run(["audit", "--db", path], env), run(["export", "--db", path], env), run(["get", "--db", path], env)];
    expect(outs[1]!.out).toContain("OPENROUTER_KEY");
    expect(outs[1]!.out).toContain("opens");
    expect(outs[2]!.out).toContain("secrets/OPENROUTER_KEY");
    for (const o of outs) expect(o.out).not.toContain("SENTINEL");
    expect(run(["secrets", "list", "--db", path], { [STORE_KEY_ENV]: OTHER_KEY_HEX }).out).toContain("sealed under another key");
    expect(run(["secrets", "clear", "OPENROUTER_KEY", "--db", path], {}).code).toBe(0);
    expect(storedSecretsAt(path)).toEqual([]);
  });
});
