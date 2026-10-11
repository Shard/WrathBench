/**
 * The provider table: which key may be sent to which host, and the three
 * places that hold a run to it — the parser and the store are covered beside
 * their own suites (infra/fleet.test.ts, config-store.test.ts); the launch and
 * the adapter are here.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { OpenAiChatAdapter } from "../src/adapter";
import {
  KEY_PROVIDERS,
  LOCAL_MODEL_HOSTS_ENV,
  NEVER_A_PROVIDER_KEY,
  apiKeyRefusal,
  localModelHosts,
} from "../src/providers";
import { tempDirs } from "./fixtures/temp-dirs";

const tempDir = tempDirs();
const REPO = resolve(import.meta.dir, "..", "..");

describe("the table", () => {
  test("no row names a harness or infrastructure credential, and every key name is an env var name", () => {
    for (const row of KEY_PROVIDERS) {
      expect([row.keyEnv, NEVER_A_PROVIDER_KEY.some((re) => re.test(row.keyEnv))]).toEqual([row.keyEnv, false]);
      expect(row.keyEnv).toMatch(/^[A-Z][A-Z0-9_]*$/);
      // A cloud row names its hosts; only the self-hosted row takes them from the deployment.
      expect(row.local === true ? row.hosts.length === 0 : row.hosts.length > 0).toBe(true);
    }
    expect(new Set(KEY_PROVIDERS.map((r) => r.keyEnv)).size).toBe(KEY_PROVIDERS.length);
  });

  test("the forbidden families cover the names a run's environment actually holds", () => {
    for (const name of [
      "CLAUDE_CODE_OAUTH_TOKEN",
      "CLAUDE_CODE_OAUTH_TOKEN_2",
      "ANTHROPIC_API_KEY",
      "CODEX_HOME",
      "CODEX_API_KEY",
      "WRATHBENCH_MODULE_SECRET",
      "WRATHBENCH_DB_PASSWORD",
      "WRATHBENCH_CLICKHOUSE_PASSWORD",
      "WRATHBENCH_CF_DEPLOY_TOKEN",
      "CLICKHOUSE_PASSWORD",
      "S3_SECRET_ACCESS_KEY",
      "AWS_SECRET_ACCESS_KEY",
      "AC_LOGIN_DATABASE_INFO",
    ]) {
      expect([name, apiKeyRefusal(name, "https://openrouter.ai/api/v1", {})]).toEqual([
        name,
        `apiKeyEnv ${name} names a harness or infrastructure credential, never a model provider's key`,
      ]);
    }
  });

  test("every table key is one the chart forwards and .env.example documents", () => {
    const values = readFileSync(join(REPO, "infra", "chart", "wrathbench", "values.yaml"), "utf8");
    const envExample = readFileSync(join(REPO, ".env.example"), "utf8");
    for (const { keyEnv } of KEY_PROVIDERS) {
      expect([keyEnv, values.includes(`  - ${keyEnv}\n`)]).toEqual([keyEnv, true]);
      expect([keyEnv, envExample.includes(`\n${keyEnv}=`)]).toEqual([keyEnv, true]);
    }
    expect(envExample.includes(`\n${LOCAL_MODEL_HOSTS_ENV}=\n`)).toBe(true);
  });
});

describe("apiKeyRefusal", () => {
  test("each cloud key reaches its own host over https and nothing else", () => {
    expect(apiKeyRefusal("OPENROUTER_KEY", "https://openrouter.ai/api/v1", {})).toBeNull();
    expect(apiKeyRefusal("OPENCODE_KEY", "https://opencode.ai/zen/v1", {})).toBeNull();
    expect(apiKeyRefusal("OPENCODE_KEY", "https://opencode.ai/zen/go/v1", {})).toBeNull();
    expect(apiKeyRefusal("CEREBRAS_KEY", "https://api.cerebras.ai/v1", {})).toBeNull();
    expect(apiKeyRefusal("DEEPSEEK_KEY", "https://api.deepseek.com/v1", {})).toBeNull();
    // Swapped, lookalike, plain http, a password in the base, no base, not a URL.
    expect(apiKeyRefusal("CEREBRAS_KEY", "https://openrouter.ai/api/v1", {})).toMatch(/may be sent only to api.cerebras.ai — not openrouter.ai/);
    expect(apiKeyRefusal("OPENROUTER_KEY", "https://openrouter.ai.collector.example/v1", {})).toMatch(/not openrouter.ai.collector.example/);
    expect(apiKeyRefusal("OPENROUTER_KEY", "https://evil-openrouter.ai/v1", {})).toMatch(/not evil-openrouter.ai/);
    expect(apiKeyRefusal("OPENROUTER_KEY", "http://openrouter.ai/api/v1", {})).toMatch(/https only/);
    const withPassword = apiKeyRefusal("OPENROUTER_KEY", "https://u:fake-pass@openrouter.ai/api/v1", {});
    expect(withPassword).toBe("apiBase must not carry a user or password");
    expect(apiKeyRefusal("OPENROUTER_KEY", undefined, {})).toMatch(/no apiBase/);
    expect(apiKeyRefusal("OPENROUTER_KEY", "openrouter.ai", {})).toMatch(/is not a URL/);
  });

  test("the self-hosted key reaches only what the deployment names, port-exact when it names one", () => {
    const env = { [LOCAL_MODEL_HOSTS_ENV]: " 192.168.100.20:1234,lmbox.local  10.0.0.7 " };
    expect(localModelHosts(env)).toEqual(["192.168.100.20:1234", "lmbox.local", "10.0.0.7"]);
    expect(apiKeyRefusal("LMSTUDIO_KEY", "http://192.168.100.20:1234/v1", env)).toBeNull();
    expect(apiKeyRefusal("LMSTUDIO_KEY", "http://LMBOX.local:8080/v1", env)).toBeNull();
    expect(apiKeyRefusal("LMSTUDIO_KEY", "https://10.0.0.7/v1", env)).toBeNull();
    expect(apiKeyRefusal("LMSTUDIO_KEY", "http://192.168.100.20:9999/v1", env)).toMatch(/192.168.100.20:9999 is not one/);
    expect(apiKeyRefusal("LMSTUDIO_KEY", "http://192.168.100.21:1234/v1", env)).toMatch(/is not one/);
    // A cloud host is not a self-hosted one either.
    expect(apiKeyRefusal("LMSTUDIO_KEY", "https://openrouter.ai/api/v1", env)).toMatch(/is not one/);
    // Nothing configured: the key goes nowhere.
    expect(apiKeyRefusal("LMSTUDIO_KEY", "http://192.168.100.20:1234/v1", {})).toMatch(/names no self-hosted model host/);
    expect(apiKeyRefusal("LMSTUDIO_KEY", "http://192.168.100.20:1234/v1", { [LOCAL_MODEL_HOSTS_ENV]: " , " })).toMatch(/names no self-hosted model host/);
    // The deployment can widen hosts, never key names.
    expect(apiKeyRefusal("SOME_OTHER_KEY", "http://192.168.100.20:1234/v1", env)).toMatch(/not a provider key this harness sends anywhere/);
  });
});

describe("the adapter", () => {
  const base = { apiKey: "fake-key-for-tests", model: "m", fetchImpl: (() => Promise.reject(new Error("no network"))) as unknown as typeof fetch };

  test("refuses to be built with a pairing the table does not hold", () => {
    expect(() => new OpenAiChatAdapter({ ...base, baseUrl: "https://collector.example/v1", apiKeyEnv: "OPENROUTER_KEY", env: {} })).toThrow(
      /refusing to send the key: OPENROUTER_KEY is OpenRouter's key/,
    );
    expect(() => new OpenAiChatAdapter({ ...base, baseUrl: "https://openrouter.ai/api/v1", apiKeyEnv: "WRATHBENCH_MODULE_SECRET", env: {} })).toThrow(
      /harness or infrastructure credential/,
    );
    expect(() => new OpenAiChatAdapter({ ...base, baseUrl: "https://openrouter.ai/api/v1", apiKeyEnv: "OPENROUTER_KEY", env: {} })).not.toThrow();
  });
});

describe("the launch", () => {
  /** run.ts under the openai driver, from a cwd without a `.env`, with a fake key in its environment. */
  async function launch(args: string[], env: Record<string, string>): Promise<{ code: number; stderr: string }> {
    const dir = tempDir("wrathbench-keys-launch-");
    const proc = Bun.spawn({
      cmd: [process.execPath, join(REPO, "runner", "src", "run.ts"), "--driver", "openai", "--model", "vendor/m", "--runs-dir", dir, ...args],
      cwd: dir,
      env: { PATH: process.env["PATH"] ?? "", HOME: process.env["HOME"] ?? "/tmp", ...env },
      stdout: "pipe",
      stderr: "pipe",
    });
    const stderr = await new Response(proc.stderr).text();
    return { code: await proc.exited, stderr };
  }

  test("run.ts refuses to start rather than send a key anywhere the table does not allow", async () => {
    const away = await launch(["--api-base", "https://collector.example/v1", "--api-key-env", "OPENROUTER_KEY"], { OPENROUTER_KEY: "fake-key-for-tests" });
    expect(away.code).toBe(2);
    expect(away.stderr).toContain("openai driver refuses to start: OPENROUTER_KEY is OpenRouter's key");
    expect(away.stderr).not.toContain("fake-key-for-tests");

    const secret = await launch(["--api-base", "https://openrouter.ai/api/v1", "--api-key-env", "WRATHBENCH_MODULE_SECRET"], {
      WRATHBENCH_MODULE_SECRET: "fake-port-secret-for-tests",
    });
    expect(secret.code).toBe(2);
    expect(secret.stderr).toContain("WRATHBENCH_MODULE_SECRET names a harness or infrastructure credential");
    expect(secret.stderr).not.toContain("fake-port-secret-for-tests");

    // The OPENAI_BASE_URL fallback is held to the same table.
    const fallback = await launch(["--api-key-env", "CEREBRAS_KEY"], { CEREBRAS_KEY: "fake-key-for-tests", OPENAI_BASE_URL: "https://collector.example/v1" });
    expect(fallback.code).toBe(2);
    expect(fallback.stderr).toContain("CEREBRAS_KEY is Cerebras's key");
  }, 30_000);
});
