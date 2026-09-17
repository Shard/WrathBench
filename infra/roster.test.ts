import { describe, expect, test } from "bun:test";
import { CHILD_TERM_GRACE_MS, episodeArgv, forCycle, harnessVersion, inContainer, planFreshLaunch, resolve, type RosterSpec } from "./run-roster";
import { harnessSeries } from "../runner/src/comparability";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The roster is config, and the config's whole job is to become an argv for
 * run-episode.sh. These pin the two things that would silently break a night:
 * the old bare-model roster shape still producing the argv it always did, and
 * a claude-code entry not carrying OpenAI-only flags.
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
      race: 1,
      class: 2,
      episodeMs: 5_400_000,
    });
  });

  test("every field is overridable per entry", () => {
    const spec: RosterSpec = {
      model: "sonnet",
      driver: "claude-code",
      account: "SHAKEOUT2",
      race: 3,
      class: 2,
      episodeMs: 60_000,
    };
    const [s] = resolve([spec], "20260101");
    expect(s).toMatchObject({ driver: "claude-code", account: "SHAKEOUT2", race: 3 });
  });

  test("routing rides its own flag, and only when the entry stated one", () => {
    // Issue #25 / 2026-09-16. An unstated routing produces the argv it always
    // did: the runner derives the same default from the model slug, so the
    // flag is a statement of intent rather than a restatement of a default.
    const plain = resolve([{ model: "z-ai/glm-5.2:free" }], "20260916")[0]!;
    expect(episodeArgv(plain, false)).not.toContain("--routing-json");
    const pinned = resolve([{ model: "z-ai/glm-5.2:free", routing: ["Z.AI", "Together"] as never }], "20260916")[0]!;
    // The shorthand normalises on the way through, so what the argv carries is
    // one shape whatever the config said.
    expect(pinned.routing).toEqual({ order: ["Z.AI", "Together"], allowFallbacks: false });
    const argv = episodeArgv(pinned, false);
    expect(JSON.parse(argv[argv.indexOf("--routing-json") + 1]!)).toEqual({
      order: ["Z.AI", "Together"],
      allowFallbacks: false,
    });
    // A resumed run restates no identity, routing included.
    expect(episodeArgv(pinned, true)).not.toContain("--routing-json");
  });

  test("routing on an endpoint with one backend is refused at resolve, not dropped", () => {
    expect(() =>
      resolve([{ model: "qwen-3.8-27b", apiBase: "https://api.cerebras.ai/v1", routing: ["Cerebras"] as never }], "20260916"),
    ).toThrow(/routing is an OpenRouter setting/);
  });

  test("an unknown driver is refused rather than passed through", () => {
    expect(() => resolve([{ model: "x", driver: "anthropic" as never }], "20260101")).toThrow(/unknown driver/);
  });

  test("a codex entry resolves like a claude one: no api flags, a lane by NAME, effort in the id", () => {
    const s = resolve([{ model: "gpt-6-astra", driver: "codex", effort: "high", tokenEnv: "CODEX_HOME_2", account: "SHAKEOUT" }], "20260905")[0]!;
    expect(s).toMatchObject({ driver: "codex", tokenEnv: "CODEX_HOME_2", effort: "high", account: "SHAKEOUT" });
    expect(s.runId).toBe("roster-gpt-6-astra-high-20260905");
    const argv = episodeArgv(s, false);
    expect(argv[argv.indexOf("--driver") + 1]).toBe("codex");
    expect(argv).not.toContain("--api-base");
    expect(argv).not.toContain("--api-key-env");
    expect(argv[argv.indexOf("--token-env") + 1]).toBe("CODEX_HOME_2");
    // The default lane is not restated, exactly as for claude-code.
    const plain = resolve([{ model: "gpt-5.5", driver: "codex" }], "20260905")[0]!;
    expect(plain.tokenEnv).toBeUndefined();
    expect(episodeArgv(plain, false)).not.toContain("--token-env");
    // A lane name on an openai entry is dropped: nothing there bills a subscription.
    const oa = resolve([{ model: "x:free", tokenEnv: "CODEX_HOME" }], "20260905")[0]!;
    expect(oa.tokenEnv).toBeUndefined();
  });

  test("resumeOnPause follows the lane, and falls back to the episode", () => {
    // What the fleet writes wins; a hand-written roster with no episode keeps
    // the lane's resume, and a scored one does not.
    expect(resolve([{ model: "x" }], "20260101")[0]!.resumeOnPause).toBe(true);
    expect(resolve([{ model: "x", episode: "e90" }], "20260101")[0]!.resumeOnPause).toBe(false);
    expect(resolve([{ model: "x", episode: "freeplay" }], "20260101")[0]!.resumeOnPause).toBe(true);
    expect(resolve([{ model: "x", episode: "probing" }], "20260101")[0]!.resumeOnPause).toBe(false);
    expect(resolve([{ model: "x", episode: "probing", resumeOnPause: true }], "20260101")[0]!.resumeOnPause).toBe(true);
  });
});

describe("episodeArgv", () => {
  test("a continuation and the kept names are launch inputs: on a fresh launch, never on a resume", () => {
    const [s] = resolve([{ model: "opus", driver: "claude-code", episode: "freeplay", continueFrom: "a11", keepCharacters: ["Ironvowen", "Vespers"] }], "20260829");
    const fresh = episodeArgv(s!, false);
    expect(fresh[fresh.indexOf("--continue-from") + 1]).toBe("a11");
    expect(fresh[fresh.indexOf("--keep-characters") + 1]).toBe("Ironvowen,Vespers");
    const resumed = episodeArgv(s!, true);
    expect(resumed).not.toContain("--continue-from");
    expect(resumed).not.toContain("--keep-characters");
    // Absent: nothing new in the argv of a spec written before either existed.
    const [plain] = resolve([{ model: "opus", driver: "claude-code" }], "20260829");
    expect(episodeArgv(plain!, false)).not.toContain("--keep-characters");
    // A dropped head travels the same way: the record's inputs, fresh launch only.
    const [d] = resolve([{ model: "opus", driver: "claude-code", episode: "freeplay", continueDropped: { runId: "f1", reason: "account_occupied_by opuslo" } }], "20260829");
    const droppedArgv = episodeArgv(d!, false);
    expect(droppedArgv[droppedArgv.indexOf("--continue-dropped") + 1]).toBe("f1");
    expect(droppedArgv[droppedArgv.indexOf("--continue-dropped-reason") + 1]).toBe("account_occupied_by opuslo");
    expect(droppedArgv).not.toContain("--continue-from");
    expect(episodeArgv(d!, true)).not.toContain("--continue-dropped");
  });

  test("openai entries are unchanged: driver, endpoint, no account flag", () => {
    const [s] = resolve([{ model: "z-ai/glm-5.2:free" }], "20260101");
    const argv = episodeArgv(s!, false);
    expect(argv).toContain("--api-base");
    expect(argv).toContain("--api-key-env");
    expect(argv).not.toContain("--account");
    expect(argv[argv.indexOf("--driver") + 1]).toBe("openai");
  });

  test("no name reaches the runner: race and class are the launch dimensions", () => {
    // A spec has no character to pass and the flag is gone from the runner —
    // the model names its own at createSession and the run records it.
    const [s] = resolve([{ model: "opus", driver: "claude-code", race: 3, class: 2 }], "20260101");
    const argv = episodeArgv(s!, false);
    expect(argv).not.toContain("--character");
    expect(argv[argv.indexOf("--race") + 1]).toBe("3");
    expect(argv[argv.indexOf("--class") + 1]).toBe("2");
  });

  test("claude entries carry no api flags and do carry their account", () => {
    const [s] = resolve([{ model: "opus", driver: "claude-code", account: "SHAKEOUT" }], "20260101");
    const argv = episodeArgv(s!, false);
    for (const flag of OPENAI_ONLY) expect(argv).not.toContain(flag);
    expect(argv[argv.indexOf("--driver") + 1]).toBe("claude-code");
    expect(argv[argv.indexOf("--account") + 1]).toBe("SHAKEOUT");
  });

  test("a driver outside the vocabulary is refused by name", () => {
    expect(() => resolve([{ model: "opus", driver: "claude-subscription" as never }], "20260101")).toThrow(/unknown driver claude-subscription/);
  });

  test("effort is passed only when the entry declares one", () => {
    const [plain] = resolve([{ model: "opus", driver: "claude-code" }], "20260101");
    expect(episodeArgv(plain!, false)).not.toContain("--effort");

    const [low] = resolve([{ model: "opus", driver: "claude-code", effort: "low" }], "20260101");
    const argv = episodeArgv(low!, false);
    expect(argv[argv.indexOf("--effort") + 1]).toBe("low");
  });

  test("effort is part of the derived run id, so opus@low is its own run", () => {
    const specs = resolve(
      [
        { model: "opus", driver: "claude-code" },
        { model: "opus", driver: "claude-code", effort: "low" },
      ],
      "20260101",
    );
    expect(specs.map((s) => s.runId)).toEqual(["roster-opus-20260101", "roster-opus-low-20260101"]);
  });

  // The fleet supervisor runs inside the runner image, where there is
  // no docker CLI to exec with. Only the launcher head changes; every flag after
  // it is identical, because run-episode.sh passes them through verbatim.
  test("in the container the episode is a direct bun runner/src/run.ts child", () => {
    const [s] = resolve([{ model: "z-ai/glm-5.2:free" }], "20260101");
    const host = episodeArgv(s!, false);
    const inside = episodeArgv(s!, false, { container: true });
    expect(host[0]).toMatch(/run-episode\.sh$/);
    expect(inside[0]).toBe("bun");
    expect(inside[1]).toMatch(/runner\/src\/run\.ts$/);
    expect(inside.slice(2)).toEqual(host.slice(1));
  });

  test("inContainer reads the explicit flag, never a docker sniff", () => {
    expect(inContainer({})).toBe(false);
    expect(inContainer({ WRATHBENCH_IN_CONTAINER: "0" })).toBe(false);
    expect(inContainer({ WRATHBENCH_IN_CONTAINER: "1" })).toBe(true);
  });

  test("a resume passes the run id and the current leash — identity comes from meta.json", () => {
    // Identity is the stored run's. The leash is not: run.ts keeps whatever
    // watchdogs meta.json holds unless a flag overrides them, so the roster
    // restates today's clock on every resume — here the numeric spelling.
    const [s] = resolve([{ model: "opus", driver: "claude-code" }], "20260101");
    expect(episodeArgv(s!, true).slice(1)).toEqual(["--resume", "roster-opus-20260101", "--episode-ms", "5400000"]);
  });
});

describe("forCycle", () => {
  test("cycle 1 is the roster as written", () => {
    const [s] = resolve([{ model: "opus" }], "20260101");
    expect(forCycle(s!, 1).runId).toBe("roster-opus-20260101");
  });

  test("later cycles get their own run id and keep every other dimension", () => {
    const [s] = resolve([{ model: "opus", race: 3, class: 2 }], "20260101");
    const c3 = forCycle(s!, 3);
    expect(c3.runId).toBe("roster-opus-20260101-c3");
    expect(c3.race).toBe(3);
  });
});

/**
 * Run dimensions: an entry may carry an operator objective, partial
 * watchdog overrides, and its own tool-call ceiling, and all three have to
 * survive the trip into run.ts's argv.
 */
describe("run dimensions: objective, watchdogs, maxToolCalls", () => {
  const OBJECTIVE = "Travel to the nearest capital city.";

  test("an entry without them is unchanged", () => {
    const [s] = resolve([{ model: "z-ai/glm-5.2:free" }], "20260101");
    expect(s).toMatchObject({ objective: undefined, watchdogs: {}, maxToolCalls: undefined, episodeMs: 5_400_000 });
    const argv = episodeArgv(s!, false);
    expect(argv).not.toContain("--objective");
    expect(argv).not.toContain("--wiki-coords");
    expect(argv).not.toContain("--watchdogs-json");
    expect(argv).not.toContain("--max-tool-calls");
    expect(argv[argv.indexOf("--episode-ms") + 1]).toBe("5400000");
  });

  test("the objective reaches argv verbatim, as one argument", () => {
    const [s] = resolve([{ model: "z-ai/glm-5.2:free", objective: OBJECTIVE }], "20260101");
    const argv = episodeArgv(s!, false);
    expect(argv[argv.indexOf("--objective") + 1]).toBe(OBJECTIVE);
  });

  test("wikiCoords reaches argv as an explicit `--wiki-coords true`", () => {
    const [s] = resolve([{ model: "m", wikiCoords: true }], "20260101");
    expect(s!.wikiCoords).toBe(true);
    const argv = episodeArgv(s!, false);
    expect(argv[argv.indexOf("--wiki-coords") + 1]).toBe("true");
    expect(resolve([{ model: "m", wikiCoords: false }], "20260101")[0]!.wikiCoords).toBe(false);
    expect(() => resolve([{ model: "m", wikiCoords: "true" as never }], "20260101")).toThrow(/wikiCoords/);
  });

  test("the reference wiki is on by default, and `wiki: false` reaches argv (issue #61)", () => {
    const [plain] = resolve([{ model: "m" }], "20260101");
    expect(plain!.wiki).toBe(true);
    // Nothing is emitted for the default, so every pre-#61 argv is unchanged.
    expect(episodeArgv(plain!, false)).not.toContain("--wiki");
    const [off] = resolve([{ model: "m", wiki: false }], "20260101");
    expect(off!.wiki).toBe(false);
    const argv = episodeArgv(off!, false);
    expect(argv[argv.indexOf("--wiki") + 1]).toBe("false");
    expect(() => resolve([{ model: "m", wiki: "false" as never }], "20260101")).toThrow(/wiki must be a boolean/);
    // Coordinates are a setting of a surface this entry does not have.
    expect(() => resolve([{ model: "m", wiki: false, wikiCoords: true }], "20260101")).toThrow(
      /wikiCoords needs the reference wiki/,
    );
  });

  test("an extra run reaches argv as `--extra true` and is off by default", () => {
    const [s] = resolve([{ model: "m", extra: true }], "20260101");
    expect(s!.extra).toBe(true);
    const argv = episodeArgv(s!, false);
    expect(argv[argv.indexOf("--extra") + 1]).toBe("true");
    const [plain] = resolve([{ model: "m" }], "20260101");
    expect(plain!.extra).toBe(false);
    expect(episodeArgv(plain!, false)).not.toContain("--extra");
  });

  test("an empty objective or a bad watchdog key is a config error", () => {
    expect(() => resolve([{ model: "m", objective: "" }], "20260101")).toThrow(/objective/);
    expect(() => resolve([{ model: "m", watchdogs: { noXpMS: 5 } as never }], "20260101")).toThrow(/watchdogs/);
  });

  test("a disabled watchdog travels as JSON null — argv cannot carry it any other way", () => {
    const [s] = resolve(
      [{ model: "m", watchdogs: { noXpMs: null, idleMs: 1_200_000, episodeMs: 21_600_000 } }],
      "20260101",
    );
    const argv = episodeArgv(s!, false);
    expect(JSON.parse(argv[argv.indexOf("--watchdogs-json") + 1]!)).toEqual({
      noXpMs: null,
      idleMs: 1_200_000,
    });
    // The wall clock keeps its own flag when it is a number.
    expect(argv[argv.indexOf("--episode-ms") + 1]).toBe("21600000");
  });

  test("0 is the argv spelling of disabled and normalises to null", () => {
    const [s] = resolve([{ model: "m", watchdogs: { noXpMs: 0 } }], "20260101");
    const argv = episodeArgv(s!, false);
    expect(JSON.parse(argv[argv.indexOf("--watchdogs-json") + 1]!)).toEqual({ noXpMs: null });
  });

  test("watchdogs.episodeMs wins over the entry's episodeMs, and can disable the wall clock", () => {
    const [both] = resolve([{ model: "m", episodeMs: 60_000, watchdogs: { episodeMs: 21_600_000 } }], "20260101");
    expect(both!.episodeMs).toBe(21_600_000);
    expect(episodeArgv(both!, false)[episodeArgv(both!, false).indexOf("--episode-ms") + 1]).toBe("21600000");

    const [off] = resolve([{ model: "m", episodeMs: 60_000, watchdogs: { episodeMs: null } }], "20260101");
    expect(off!.episodeMs).toBeNull();
    const argv = episodeArgv(off!, false);
    expect(argv).not.toContain("--episode-ms");
    expect(JSON.parse(argv[argv.indexOf("--watchdogs-json") + 1]!)).toEqual({ episodeMs: null });
  });

  test("maxToolCalls maps onto --max-tool-calls", () => {
    const [s] = resolve([{ model: "m", maxToolCalls: 2500 }], "20260101");
    expect(episodeArgv(s!, false)[episodeArgv(s!, false).indexOf("--max-tool-calls") + 1]).toBe("2500");
  });

  test("maxToolCalls null is no ceiling, and travels as --max-tool-calls 0 on both paths", () => {
    // argv cannot carry null, so 0 is the transport spelling — the same trick
    // `--no-xp-ms 0` uses — and run.ts normalises it back to null on read. It
    // has to be restated on a resume for the same reason `--watchdogs-json`
    // is: run.ts reloads the stored config and only overrides what a flag
    // names, so a run stored under the old 500 keeps the 500 without it.
    const [s] = resolve([{ model: "m", episode: "freeplay", maxToolCalls: null, watchdogs: { episodeMs: null } }], "20260101");
    expect(s!.maxToolCalls).toBeNull();
    const fresh = episodeArgv(s!, false);
    expect(fresh[fresh.indexOf("--max-tool-calls") + 1]).toBe("0");
    const resumed = episodeArgv(s!, true);
    expect(resumed[resumed.indexOf("--max-tool-calls") + 1]).toBe("0");
    expect(resumed[resumed.indexOf("--resume") + 1]).toBe(s!.runId);
  });

  test("a resumed freeplay episode restates the leash: episodeMs null in the JSON, never a numeric cap", () => {
    // run.ts reloads the stored meta.json config on --resume and only overrides
    // a watchdog when the flag is explicitly present. A freeplay run created
    // before the six-hour cap was removed stored `episodeMs: 21600000`, so the
    // ABSENCE of --episode-ms is not the absence of a cap — it just leaves the
    // stored one standing. Only `--watchdogs-json {"episodeMs":null}` migrates
    // that run onto today's no-wall-clock freeplay policy.
    const [s] = resolve(
      [{ model: "opus", effort: "low", episode: "freeplay", watchdogs: { idleMs: 1_200_000, noXpMs: null, episodeMs: null } }],
      "20260101",
    );
    const argv = episodeArgv(s!, true);
    expect(argv[argv.indexOf("--resume") + 1]).toBe(s!.runId);
    expect(argv).not.toContain("--episode-ms");
    expect(JSON.parse(argv[argv.indexOf("--watchdogs-json") + 1]!)).toEqual({
      idleMs: 1_200_000,
      noXpMs: null,
      episodeMs: null,
    });
  });

  test("a resumed episode carries the leash but none of the identity: that comes back from meta.json", () => {
    const [s] = resolve([{ model: "m", objective: OBJECTIVE, maxToolCalls: 2500, watchdogs: { noXpMs: null } }], "20260101");
    // Identity — driver, model, account, effort, objective, wiki, race/class,
    // episode, campaign/cell — is the stored run's and is never restated.
    expect(episodeArgv(s!, true)).toEqual([
      expect.any(String),
      "--resume",
      s!.runId,
      "--max-tool-calls",
      "2500",
      "--episode-ms",
      "5400000",
      "--watchdogs-json",
      JSON.stringify({ noXpMs: null }),
    ]);
  });
});

describe("the version stamp a spawned episode inherits", () => {
  // 2026-09-08: the k8s fleet pod has the repo baked in and no git, so
  // `git describe` failed here and every run it launched or RESUMED was
  // stamped "0.0.0-phase0" — a stamp that names no series. Out of the policy's
  // series, a paused freeplay head was invisible to planResumes and to the
  // projection, and the policy started a fresh attempt off the ended run
  // before it. The chart passes the image tag; it is the honest marker for a
  // checkout that cannot describe itself, and it must win.
  test("WRATHBENCH_HARNESS_VERSION wins, and it carries a series", () => {
    expect(harnessVersion({ WRATHBENCH_HARNESS_VERSION: "harness-0.5-513-g803bd42" })).toBe("harness-0.5-513-g803bd42");
    expect(harnessSeries(harnessVersion({ WRATHBENCH_HARNESS_VERSION: "harness-0.5-513-g803bd42" }))).toBe("0.5");
    // Blank is not a stamp: fall through to git (or the fallback), as before.
    expect(harnessVersion({ WRATHBENCH_HARNESS_VERSION: "   " })).not.toBe("   ");
  });

  test("the pod's drain grace covers the pause the roster owes its child", () => {
    // SIGKILL before run-roster's child has written its pause record loses the
    // record the next supervisor resumes from, so the chart's number is not
    // free to drift below the code's own grace.
    const chart = readFileSync(join(import.meta.dir, "chart", "wrathbench", "templates", "fleet.yaml"), "utf8");
    const m = /terminationGracePeriodSeconds:\s*(\d+)/.exec(chart);
    expect(m).not.toBeNull();
    expect(Number(m![1]) * 1000).toBeGreaterThan(CHILD_TERM_GRACE_MS);
  });
});

/**
 * A fresh launch onto a run id that already has a directory: the runner refuses
 * it (`assertRunDirFree`), so the roster must skip rather than hand the
 * supervisor a crashed child. Gated on the directory, not the run row — an
 * unreadable row is the very case the collision comes from.
 */
describe("planFreshLaunch", () => {
  const spec = { runId: "roster-glm-5-2-20260101", dirExists: false, resumeRoster: false };

  test("a run id with nothing on disk launches", () => {
    expect(planFreshLaunch(spec)).toEqual({ kind: "launch" });
    expect(planFreshLaunch({ ...spec, resumeRoster: true })).toEqual({ kind: "launch" });
  });

  test("a directory already on disk is skipped, not launched onto", () => {
    const plan = planFreshLaunch({ ...spec, dirExists: true });
    expect(plan.kind).toBe("skip");
    expect(plan.kind === "skip" ? plan.reason : "").toContain("roster-glm-5-2-20260101 is already a run directory on disk");
    expect(plan.kind === "skip" ? plan.reason : "").toContain("this is not --resume-roster");
  });

  test("under --resume-roster the reason names the unreadable row, which is why no resume was planned", () => {
    const plan = planFreshLaunch({ ...spec, dirExists: true, resumeRoster: true });
    expect(plan.kind).toBe("skip");
    expect(plan.kind === "skip" ? plan.reason : "").toContain("no readable run row");
  });
});
