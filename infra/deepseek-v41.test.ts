import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseFleet } from "./run-fleet-config";
import { episodeArgv, resolve } from "./run-roster";

const examplePath = join(import.meta.dir, "fleet-deepseek-v41.example.json");
const exampleRaw = JSON.parse(readFileSync(examplePath, "utf8")) as unknown;
const example = parseFleet(exampleRaw);
const beta = example.roster["deepseek-v41-beta"]!;

describe("DeepSeek V4.1 beta example", () => {
  test("is isolated from the live fleet and disabled by default", () => {
    const live = JSON.parse(readFileSync(join(import.meta.dir, "fleet.json"), "utf8")) as {
      roster?: Record<string, unknown>;
    };

    expect(live.roster?.["deepseek-v41-beta"]).toBeUndefined();
    expect(Object.keys(example.roster)).toEqual(["deepseek-v41-beta"]);
    expect(beta).toMatchObject({
      model: "deepseek-v4.1-flash-expires-on-0910",
      driver: "openai",
      apiBase: "https://api.deepseek.com",
      apiKeyEnv: "DEEPSEEK_KEY",
      billing: "paid",
      tier: "t0",
      idle: "none",
    });
    expect(example.jobs).toHaveLength(1);
    expect(example.jobs[0]).toMatchObject({
      ref: "deepseek-v41-beta",
      episode: "e90",
      repeat: 1,
      enabled: false,
      account: "RUNNER7",
    });
  });

  test("uses the existing OpenAI-compatible runner path without model tuning", () => {
    const [resolved] = resolve(
      [
        {
          model: beta.model,
          driver: beta.driver,
          apiBase: beta.apiBase,
          apiKeyEnv: beta.apiKeyEnv,
          episode: "e90",
        },
      ],
      "20260908",
    );
    const argv = episodeArgv(resolved!, false);

    expect(argv[argv.indexOf("--api-base") + 1]).toBe("https://api.deepseek.com");
    expect(argv[argv.indexOf("--api-key-env") + 1]).toBe("DEEPSEEK_KEY");
    expect(argv[argv.indexOf("--episode") + 1]).toBe("e90");
    expect(argv).not.toContain("--effort");
    expect(argv).not.toContain("--objective");
  });

  test("the container credential paths name the beta env without embedding a secret", () => {
    const envExample = readFileSync(join(import.meta.dir, "..", ".env.example"), "utf8");
    const launcher = readFileSync(join(import.meta.dir, "run-episode.sh"), "utf8");
    const values = readFileSync(join(import.meta.dir, "chart", "wrathbench", "values.yaml"), "utf8");

    expect(envExample).toContain("DEEPSEEK_KEY=");
    expect(launcher).toContain("DEEPSEEK_*=*");
    expect(values).toContain("  - DEEPSEEK_KEY");
    expect(envExample).not.toMatch(/DEEPSEEK_KEY=\S+/);
  });
});
