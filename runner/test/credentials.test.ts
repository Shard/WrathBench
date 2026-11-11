/**
 * Credentials with slots (runner/src/credentials.ts): the record, what it
 * refuses, which provider serves a model, and which credentials a pick may
 * take. Every secret here is a NAME; no test holds a value.
 */

import { describe, expect, test } from "bun:test";
import { join, resolve } from "node:path";
import {
  credentialCandidates,
  credentialCarries,
  describeBudget,
  parseCredentials,
  providerOfModel,
  type Credential,
} from "../src/credentials";
import { ConfigRejected, ConfigStore } from "../src/config-store";
import { parseFleet } from "../../infra/run-fleet-config";
import { apiKeyRefusal } from "../src/providers";
import { tempDirs } from "./fixtures/temp-dirs";

const tempDir = tempDirs();

const claude = (over: Record<string, unknown> = {}) => ({
  provider: "claude",
  secretEnv: "CLAUDE_CODE_OAUTH_TOKEN",
  slots: 1,
  budget: { kind: "usage" },
  billing: "paid",
  enabled: true,
  ...over,
});

describe("the record", () => {
  test("a row reads with its budget's defaults filled, in the order written", () => {
    const creds = parseCredentials({
      "claude-1": claude(),
      "claude-2": claude({ secretEnv: "CLAUDE_CODE_OAUTH_TOKEN_2", budget: { kind: "usage", scoredMaxPct: 70 } }),
      openrouter: { provider: "openrouter", secretEnv: "OPENROUTER_KEY", slots: 2, budget: { kind: "spend", usdPerDay: 5 }, billing: "paid", enabled: false },
      lmstudio: { provider: "local", secretEnv: "LMSTUDIO_KEY", slots: 1, billing: "free", enabled: true },
    });
    expect(creds.map((c) => c.id)).toEqual(["claude-1", "claude-2", "openrouter", "lmstudio"]);
    expect(creds[0]!.budget).toEqual({ kind: "usage", scoredMaxPct: 80, freeplayMaxPct: 80 });
    expect(creds[1]!.budget).toEqual({ kind: "usage", scoredMaxPct: 70, freeplayMaxPct: 80 });
    expect(creds[3]!.budget).toBeNull();
    expect(describeBudget(creds[1]!.budget)).toBe("usage < 70% scored, 80% freeplay");
    expect(describeBudget(creds[2]!.budget)).toBe("$5/day");
  });

  test("a secret where a name belongs is refused by shape", () => {
    expect(() => parseCredentials({ c: claude({ secretEnv: "sk-ant-oat01-FAKEFAKEFAKE" }) })).toThrow(/NAME of the env var/);
    // Another provider's name is refused too: a key goes only where its provider's key goes.
    expect(() => parseCredentials({ c: claude({ secretEnv: "OPENROUTER_KEY" }) })).toThrow(/CLAUDE_CODE_OAUTH_TOKEN/);
    expect(() => parseCredentials({ c: { provider: "chatgpt", secretEnv: "CODEX_HOME_2", slots: 1, billing: "paid", enabled: true } })).not.toThrow();
  });

  test("a budget the provider cannot be measured by is refused", () => {
    expect(() => parseCredentials({ c: claude({ budget: { kind: "spend", usdPerDay: 1 } }) })).toThrow(/usage, runs, not spend/);
    expect(() => parseCredentials({ c: { provider: "cerebras", secretEnv: "CEREBRAS_KEY", slots: 1, budget: { kind: "usage" }, billing: "paid", enabled: true } })).toThrow(/runs, not usage/);
    expect(() => parseCredentials({ c: claude({ budget: { kind: "usage", scoredMaxPct: 0 } }) })).toThrow();
    expect(() => parseCredentials({ c: claude({ slots: 0 }) })).toThrow();
  });

  test("strict: an unknown key, a missing field, a bad id", () => {
    expect(() => parseCredentials({ c: claude({ token: "x" }) })).toThrow(/token/);
    const { enabled: _, ...noEnabled } = claude();
    expect(() => parseCredentials({ c: noEnabled })).toThrow(/enabled/);
    expect(() => parseCredentials({ "a/b": claude() })).toThrow(/id/);
  });

  test("one credential per secret, except a metered key's free/paid split", () => {
    expect(() => parseCredentials({ a: claude(), b: claude({ billing: "free" }) })).toThrow(/already credentials\/a's/);
    const split = parseCredentials({
      "or-free": { provider: "openrouter", secretEnv: "OPENROUTER_KEY", slots: 1, billing: "free", enabled: true },
      "or-paid": { provider: "openrouter", secretEnv: "OPENROUTER_KEY", slots: 1, billing: "paid", enabled: true },
    });
    expect(split.map((c) => c.id)).toEqual(["or-free", "or-paid"]);
  });

  test("a numbered provider key goes where its provider's key goes, and nowhere else", () => {
    expect(apiKeyRefusal("OPENROUTER_KEY_2", "https://openrouter.ai/api/v1")).toBeNull();
    expect(apiKeyRefusal("OPENROUTER_KEY_2", "https://api.cerebras.ai/v1")).toMatch(/OpenRouter's key/);
    expect(apiKeyRefusal("OPENROUTER_KEYX", "https://openrouter.ai/api/v1")).toMatch(/not a provider key/);
  });
});

describe("which provider serves a model", () => {
  test("by driver for a CLI subscription, by host for an endpoint", () => {
    expect(providerOfModel({ driver: "claude-code" })).toBe("claude");
    expect(providerOfModel({ driver: "codex" })).toBe("chatgpt");
    expect(providerOfModel({})).toBe("openrouter");
    expect(providerOfModel({ driver: "openai", apiBase: "https://openrouter.ai/api/v1" })).toBe("openrouter");
    expect(providerOfModel({ apiBase: "https://opencode.ai/zen/v1" })).toBe("opencode");
    expect(providerOfModel({ apiBase: "https://opencode.ai/inference/go/openai/v1" })).toBe("opencode-go");
    expect(providerOfModel({ apiBase: "https://api.cerebras.ai/v1" })).toBe("cerebras");
    expect(providerOfModel({ driver: "pi", apiBase: "https://api.deepseek.com/v1" })).toBe("deepseek");
    expect(providerOfModel({ apiBase: "http://192.168.1.20:1234/v1" })).toBe("local");
    expect(providerOfModel({ apiBase: "http://gpu-box:1234/v1" }, {})).toBeNull();
    expect(providerOfModel({ apiBase: "http://gpu-box:1234/v1" }, { WRATHBENCH_LOCAL_MODEL_HOSTS: "gpu-box:1234" })).toBe("local");
    expect(providerOfModel({ apiBase: "https://evil-openrouter.ai/v1" }, {})).toBeNull();
    // The scripted runs need no credential.
    expect(providerOfModel({ driver: "stub" })).toBeNull();
    expect(providerOfModel({ driver: "reference" })).toBeNull();
  });
});

describe("which credentials a pick may take", () => {
  const creds: Credential[] = parseCredentials({
    "claude-1": claude(),
    "claude-2": claude({ secretEnv: "CLAUDE_CODE_OAUTH_TOKEN_2" }),
    "claude-3": claude({ secretEnv: "CLAUDE_CODE_OAUTH_TOKEN_3", enabled: false }),
    "or-free": { provider: "openrouter", secretEnv: "OPENROUTER_KEY", slots: 1, billing: "free", enabled: true },
    "or-paid": { provider: "openrouter", secretEnv: "OPENROUTER_KEY", slots: 1, billing: "paid", enabled: true },
  });
  const sonnet = { model: "sonnet", driver: "claude-code" };

  test("every enabled credential of the provider, in preference order", () => {
    expect(credentialCandidates(creds, sonnet).candidates.map((c) => c.id)).toEqual(["claude-1", "claude-2"]);
  });

  test("on a metered provider, only the side of the model's billing", () => {
    expect(credentialCandidates(creds, { model: "z-ai/glm-5.3-flash:free" }).candidates.map((c) => c.id)).toEqual(["or-free"]);
    expect(credentialCandidates(creds, { model: "google/gemini-3.7-flash" }).candidates.map((c) => c.id)).toEqual(["or-paid"]);
    // The entry's own billing override decides, as it does everywhere else.
    expect(credentialCandidates(creds, { model: "google/gemini-3.7-flash", billing: "free" }).candidates.map((c) => c.id)).toEqual(["or-free"]);
    expect(credentialCarries({ provider: "claude", billing: "free" }, "paid")).toBe(true);
  });

  test("a pin takes that one or none, and says why", () => {
    expect(credentialCandidates(creds, sonnet, { pin: "claude-2" }).candidates.map((c) => c.id)).toEqual(["claude-2"]);
    expect(credentialCandidates(creds, sonnet, { pin: "claude-3" }).why).toMatch(/disabled/);
    expect(credentialCandidates(creds, sonnet, { pin: "or-paid" }).why).toMatch(/openrouter's/);
    expect(credentialCandidates(creds, sonnet, { pin: "nope" }).why).toMatch(/not configured/);
  });

  test("no credential is held with a reason; a scripted run needs none", () => {
    expect(credentialCandidates(creds, { model: "gpt-6", driver: "codex" }).why).toMatch(/no enabled ChatGPT subscription/);
    expect(credentialCandidates([], { model: "x", driver: "stub" })).toEqual({ provider: null, candidates: [] });
  });
});

describe("in the config store", () => {
  const doc = (credentials: Record<string, unknown>) => ({ accounts: { pool: ["RUNNER"] }, credentials, roster: {}, queue: [] });

  test("credentials are rows of their own and round-trip through parseFleet", () => {
    const root = tempDir("credentials-");
    const store = new ConfigStore(join(root, "config.sqlite"));
    try {
      store.seed(doc({ "claude-1": claude() }));
      expect(store.rows().map((r) => r.key)).toContain("credentials/claude-1");
      store.put("credentials/claude-2", claude({ secretEnv: "CLAUDE_CODE_OAUTH_TOKEN_2" }));
      expect(parseFleet(store.render()).credentials.map((c) => c.id)).toEqual(["claude-1", "claude-2"]);
      // A write the parser refuses never lands.
      expect(() => store.put("credentials/bad", claude({ secretEnv: "not a name" }))).toThrow(ConfigRejected);
      expect(store.get("credentials/bad")).toBeUndefined();
    } finally {
      store.close();
    }
  });

  test("the CLI lists, adds, edits and disables, and prints no secret", () => {
    const root = tempDir("credentials-cli-");
    const db = join(root, "config.sqlite");
    const cli = resolve(import.meta.dir, "..", "src", "config-store.ts");
    const run = (...args: string[]) => {
      const p = Bun.spawnSync(["bun", cli, "--db", db, ...args], { env: { ...process.env, CLAUDE_CODE_OAUTH_TOKEN_2: "sk-ant-oat01-FAKE-NEVER-PRINTED" } });
      return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
    };
    const seed = new ConfigStore(db);
    seed.seed(doc({}));
    seed.close();
    expect(run("credentials").out).toContain("no credentials");
    expect(run("credentials", "add", "claude-2", JSON.stringify(claude({ secretEnv: "CLAUDE_CODE_OAUTH_TOKEN_2" }))).code).toBe(0);
    expect(run("credentials", "add", "claude-2", JSON.stringify(claude())).code).toBe(1);
    expect(run("credentials", "edit", "claude-2", '{"slots":2}').code).toBe(0);
    expect(run("credentials", "edit", "nope", '{"slots":2}').code).toBe(1);
    expect(run("credentials", "disable", "claude-2").code).toBe(0);
    const list = run("credentials", "list");
    expect(list.out).toContain("claude-2");
    expect(list.out).toContain("CLAUDE_CODE_OAUTH_TOKEN_2");
    expect(list.out).toContain("2 slots");
    expect(list.out).toContain("disabled");
    expect(list.out + list.err).not.toContain("FAKE-NEVER-PRINTED");
    const refused = run("credentials", "add", "x", JSON.stringify(claude({ secretEnv: "sk-ant-oat01-FAKE" })));
    expect(refused.code).toBe(1);
    expect(refused.err).toMatch(/NAME of the env var/);
  });
});
