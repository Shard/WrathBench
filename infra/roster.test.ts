import { describe, expect, test } from "bun:test";
import { episodeArgv, forCycle, resolve, type RosterSpec } from "./run-roster";

/**
 * The roster is config, and the config's whole job is to become an argv for
 * run-episode.sh. These pin the two things that would silently break a night:
 * the old bare-model roster shape still producing the argv it always did, and
 * a claude-subscription entry not carrying OpenAI-only flags.
 */

const OPENAI_ONLY = ["--api-base", "--api-key-env"];

describe("resolve", () => {
  test("a bare model entry keeps every old default", () => {
    const [s] = resolve([{ model: "z-ai/glm-5.2:free" }], "20260101");
    expect(s).toMatchObject({
      driver: "openai",
      account: undefined,
      apiBase: "https://openrouter.ai/api/v1",
      apiKeyEnv: "OPENROUTER_KEY",
      runId: "roster-glm-5-2-20260101",
      character: "Glm",
      race: 1,
      class: 2,
      episodeMs: 5_400_000,
    });
  });

  test("every field is overridable per entry", () => {
    const spec: RosterSpec = {
      model: "sonnet",
      driver: "claude-subscription",
      account: "SHAKEOUT2",
      character: "Burnsonn",
      race: 3,
      class: 2,
      episodeMs: 60_000,
    };
    const [s] = resolve([spec], "20260101");
    expect(s).toMatchObject({ driver: "claude-subscription", account: "SHAKEOUT2", character: "Burnsonn", race: 3 });
  });

  test("an unknown driver is refused rather than passed through", () => {
    expect(() => resolve([{ model: "x", driver: "anthropic" as never }], "20260101")).toThrow(/unknown driver/);
  });
});

describe("episodeArgv", () => {
  test("openai entries are unchanged: driver, endpoint, no account flag", () => {
    const [s] = resolve([{ model: "z-ai/glm-5.2:free" }], "20260101");
    const argv = episodeArgv(s!, false);
    expect(argv).toContain("--api-base");
    expect(argv).toContain("--api-key-env");
    expect(argv).not.toContain("--account");
    expect(argv[argv.indexOf("--driver") + 1]).toBe("openai");
  });

  test("claude entries carry no api flags and do carry their account", () => {
    const [s] = resolve([{ model: "opus", driver: "claude-subscription", account: "SHAKEOUT" }], "20260101");
    const argv = episodeArgv(s!, false);
    for (const flag of OPENAI_ONLY) expect(argv).not.toContain(flag);
    expect(argv[argv.indexOf("--driver") + 1]).toBe("claude-subscription");
    expect(argv[argv.indexOf("--account") + 1]).toBe("SHAKEOUT");
  });

  test("a resume passes only the run id — identity comes from meta.json", () => {
    const [s] = resolve([{ model: "opus", driver: "claude-subscription" }], "20260101");
    expect(episodeArgv(s!, true).slice(1)).toEqual(["--resume", "roster-opus-20260101"]);
  });
});

describe("forCycle", () => {
  test("cycle 1 is the roster as written", () => {
    const [s] = resolve([{ model: "opus" }], "20260101");
    expect(forCycle(s!, 1).runId).toBe("roster-opus-20260101");
  });

  test("later cycles get their own run id but keep the character", () => {
    const [s] = resolve([{ model: "opus", character: "Burnopus" }], "20260101");
    const c3 = forCycle(s!, 3);
    expect(c3.runId).toBe("roster-opus-20260101-c3");
    expect(c3.character).toBe("Burnopus");
  });
});
