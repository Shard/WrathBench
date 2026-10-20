/**
 * The scripted reference run's public half (operator, 2026-10-19; issue #79):
 * the hook it is loaded through, the adapter it is played through, and the
 * stamp and counting rules that keep it out of every score.
 *
 * The program itself is a private build input (operator, 2026-10-20), so a
 * stub stands in for it here (fixtures/reference-stub). What these pin: a
 * build without the program refuses a reference launch in one plain line and
 * writes nothing; one with it plays through exactly the models' surface, one
 * `run_snippet` per turn through the fixed loop, the program sent as text and
 * evaluated by the sandbox's own compiler; and the run is stamped and never
 * scored — no member of any comparability group, no target counts it, no row
 * order holds it, and the scheduler can neither count nor launch one.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";

import type { ChatMessage } from "../src/context";
import {
  DRIVERS,
  REFERENCE_STAMP,
  STUB_STAMP,
  isNotAModelRun,
  isUnscoredDriver,
  isUnscoredDriverName,
  loadRunConfig,
  unscoredStamp,
} from "../src/config";
import { comparabilityOf } from "../src/comparability";
import { DRIVER_ADAPTERS } from "../src/driver-adapters";
import { configFromArgs } from "../src/run";
import { runLoop } from "../src/loop";
import { EpisodicLog } from "../src/episodic";
import { Scratchpad } from "../src/scratchpad";
import { Trajectory, readMeta, readTrajectory } from "../src/trajectory";
import { Watchdogs } from "../src/watchdogs";
import { DEFAULT_POLICY, isCounted, projectModel, readRunFacts, type RosterModel, type RunFact } from "../src/models";
import { MAX_FAILED_TICKS, REFERENCE_GLOBAL, ReferenceAdapter, lastToolResult, parseReport } from "../src/reference-adapter";
import {
  REFERENCE_PROGRAM_ENV,
  REFERENCE_PROGRAM_PATH,
  loadReferenceProgram,
  referenceModelId,
  referenceProgramPath,
  resolveReferenceLaunch,
  type ReferenceProgram,
} from "../src/reference-program";
import type { SandboxHost, SnippetResult } from "../src/sandbox/host";
import { compileSnippet } from "../src/sandbox/rewrite";
import { createApi } from "../viewer/api";
import { STUB_ROUTE, program as stubProgram } from "./fixtures/reference-stub";
import { tempDirs } from "./fixtures/temp-dirs";

const tempDir = tempDirs();
const STUB_PATH = join(import.meta.dir, "fixtures", "reference-stub", "index.ts");
const MALFORMED_PATH = join(import.meta.dir, "fixtures", "reference-malformed", "index.ts");
const ABSENT_PATH = join(import.meta.dir, "fixtures", "reference-absent", "index.ts");
const MODEL = referenceModelId(STUB_ROUTE);
const ROOT = join(import.meta.dir, "..", "..");

// ------------------------------------------------------------------ the hook

describe("the hook", () => {
  test("reads the program from a fixed path in the build, the runner's own reference/ directory", () => {
    expect(REFERENCE_PROGRAM_PATH).toBe(join(ROOT, "runner", "src", "reference", "index.ts"));
    expect(referenceProgramPath({})).toBe(REFERENCE_PROGRAM_PATH);
    expect(referenceProgramPath({ [REFERENCE_PROGRAM_ENV]: STUB_PATH })).toBe(STUB_PATH);
  });

  test("present: the program's route and its tick's source text", async () => {
    const load = await loadReferenceProgram(STUB_PATH);
    expect(load.ok).toBe(true);
    if (!load.ok) return;
    expect(load.program.route).toEqual(STUB_ROUTE);
    expect(load.program.source).toContain("stub-cursor");
  });

  test("absent: a plain reason, not a throw", async () => {
    const load = await loadReferenceProgram(ABSENT_PATH);
    expect(load).toEqual({ ok: false, reason: expect.stringContaining("the scripted reference program is not in this build") });
  });

  test("a module there that is not a program is refused by what is wrong with it", async () => {
    const load = await loadReferenceProgram(MALFORMED_PATH);
    expect(load.ok ? "" : load.reason).toMatch(/is not a reference program: `program\.route\.steps` is not a non-empty list/);
  });

  test("a launch carries the route as its model, on the route's start", async () => {
    const c = configFromArgs(["--driver", "reference", "--episode", "e90", "--account", "PROBE"], {});
    const launch = await resolveReferenceLaunch(c, STUB_PATH);
    expect(launch.ok).toBe(true);
    if (!launch.ok) return;
    expect(launch.config).toMatchObject({ driver: "reference", episode: "e90", account: "PROBE", model: MODEL, race: 1, class: 2 });
    expect(comparabilityOf(launch.config, "harness-0.9-1-gabc")).toMatchObject({ harness: "wrathbench", episode: "e90", episodeOverride: false, objective: false });
    const adapter = DRIVER_ADAPTERS.reference.prepare(launch.config, undefined as never, { reference: launch.program }).adapter;
    expect(adapter).toBeInstanceOf(ReferenceAdapter);
  });

  test("anything that would steer it or change its start is refused, never ignored", async () => {
    expect(() => loadRunConfig({ driver: "reference", objective: "go to Goldshire" })).toThrow(/objective/);
    expect(() => loadRunConfig({ driver: "reference", continuedFrom: "run-x" })).toThrow(/continuedFrom/);
    const race = await resolveReferenceLaunch(loadRunConfig({ driver: "reference", race: 3 }), STUB_PATH);
    expect(race.ok ? "" : race.reason).toMatch(/race 1, class 2/);
    const model = await resolveReferenceLaunch(loadRunConfig({ driver: "reference", model: "sonnet" }), STUB_PATH);
    expect(model.ok ? "" : model.reason).toMatch(/model/);
    const same = await resolveReferenceLaunch(loadRunConfig({ driver: "reference", model: MODEL }), STUB_PATH);
    expect(same.ok && same.config.model).toBe(MODEL);
  });

  test("prepared without its program, the driver says so rather than playing nothing", () => {
    const config = loadRunConfig({ driver: "reference", model: MODEL });
    expect(() => DRIVER_ADAPTERS.reference.prepare(config, undefined as never)).toThrow(/without its program/);
  });

  test("run.ts in a build without the program refuses the launch in one line and writes nothing", () => {
    const runs = tempDir("wrathbench-reference-absent-");
    const p = Bun.spawnSync(["bun", join(ROOT, "runner", "src", "run.ts"), "--driver", "reference", "--episode", "e90", "--account", "PROBE", "--runs-dir", runs], {
      cwd: ROOT,
      env: { PATH: process.env["PATH"] ?? "/usr/bin:/bin", HOME: process.env["HOME"] ?? "/tmp", [REFERENCE_PROGRAM_ENV]: ABSENT_PATH },
      stdout: "pipe",
      stderr: "pipe",
    });
    const err = p.stderr.toString();
    expect(p.exitCode).toBe(2);
    expect(err).toContain("--driver reference refused: the scripted reference program is not in this build");
    expect(err).not.toMatch(/\n\s+at /);
    expect(readdirSync(runs)).toEqual([]);
  });
});

// ------------------------------------------------------------------ the adapter

const tool = (content: string): ChatMessage[] => [
  { role: "system", content: "s" },
  { role: "assistant", content: "x", tool_calls: [{ id: "1", type: "function", function: { name: "run_snippet", arguments: "{}" } }] },
  { role: "tool", content, tool_call_id: "1" },
  { role: "user", content: "context" },
];
const ref = (o: object): string => `ok (12ms)\n--- console ---\n[log] REF ${JSON.stringify({ v: 1, ...o })}`;
const codeOf = async (a: ReferenceAdapter, messages: ChatMessage[]): Promise<string> => {
  const out = await a.complete({ messages, tools: [] });
  if (out.kind !== "ok") throw new Error(out.kind);
  expect(out.turn.toolCalls).toHaveLength(1);
  expect(out.turn.toolCalls[0]!.name).toBe("run_snippet");
  return (JSON.parse(out.turn.toolCalls[0]!.arguments) as { code: string }).code;
};
/** A longer stand-in route, so a resume has somewhere to jump to. */
const longProgram: ReferenceProgram = {
  route: { ...STUB_ROUTE, steps: Array.from({ length: 12 }, (_, i) => ({ kind: i === 11 ? "hunt" : "walk" })) },
  source: stubProgram.source,
};

describe("the adapter", () => {
  const adapter = (program: ReferenceProgram = longProgram): ReferenceAdapter => new ReferenceAdapter({ program, snippetTimeoutMs: 30_000, race: 1, class: 2 });

  test("reads only the latest tool result, and the report on its console", () => {
    expect(lastToolResult([{ role: "system", content: "s" }, { role: "user", content: "u" }])).toBeUndefined();
    expect(lastToolResult(tool("hello"))).toBe("hello");
    expect(parseReport(ref({ cursor: 3, advance: true, did: [] }))).toMatchObject({ cursor: 3, advance: true });
    expect(parseReport("error (30000ms)\nsnippet abandoned")).toBeUndefined();
    expect(parseReport("[log] REF {not json")).toBeUndefined();
  });

  test("the first turn loads the program; later turns only tick it", async () => {
    const a = adapter();
    const first = await codeOf(a, [{ role: "system", content: "s" }, { role: "user", content: "u" }]);
    expect(first).toContain(`globalThis.${REFERENCE_GLOBAL} = { tick: (`);
    expect(first).toContain(stubProgram.source.slice(0, 40));
    expect(first).toContain(JSON.stringify(longProgram.route));
    expect(first).toContain('"budgetMs":24000');
    const next = await codeOf(a, tool(ref({ cursor: 0, advance: true, did: [] })));
    expect(next).not.toContain("tick: (");
    expect(next).toContain('"cursor":1');
    expect(a.step).toBe(1);
  });

  test("a restarted child answers unloaded, and the program is loaded again on the same step", async () => {
    const a = adapter();
    await codeOf(a, tool(ref({ cursor: 0, advance: true, did: [] })));
    const code = await codeOf(a, tool(ref({ unloaded: true })));
    expect(code).toContain("tick: (");
    expect(code).toContain('"cursor":1');
  });

  test("a resume jumps to the step the program's note restored", async () => {
    const a = adapter();
    const code = await codeOf(a, tool(ref({ cursor: 0, advance: false, did: [], login: true, restored: 9 })));
    expect(a.step).toBe(9);
    expect(code).toContain('"cursor":9');
  });

  test("a step that keeps failing without a report is skipped, so no step wedges the run", async () => {
    const a = adapter();
    for (let i = 0; i < MAX_FAILED_TICKS - 1; i++) await codeOf(a, tool("error (30000ms)\nabandoned"));
    expect(a.step).toBe(0);
    await codeOf(a, tool("error (30000ms)\nabandoned"));
    expect(a.step).toBe(1);
  });

  test("it never ends the run: past the last step it keeps hunting", async () => {
    const a = adapter();
    const last = longProgram.route.steps.length - 1;
    await codeOf(a, tool(ref({ cursor: 0, advance: false, did: [], restored: last })));
    for (let i = 0; i < 3; i++) {
      const out = await a.complete({ messages: tool(ref({ cursor: last, advance: true, did: [] })), tools: [] });
      expect(out.kind).toBe("ok");
    }
    expect(a.step).toBe(last);
  });
});

// ------------------------------------------------------------------ through the loop

const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (body: string) => () => Promise<unknown>;

/**
 * A sandbox that evaluates each snippet as the child does — compiled by the
 * real `compileSnippet`, run as an `AsyncFunction` over the global with the
 * ambient names bound there and `console` captured — over an ambient surface
 * that holds nothing but a scratchpad.
 */
function stubSandbox(pad: { text: string }): SandboxHost & { snippets: string[] } {
  const snippets: string[] = [];
  const g = globalThis as Record<string, unknown>;
  const ambient = {
    sdk: {},
    state: {},
    connect: () => Promise.resolve(),
    sleep: () => Promise.resolve("slept"),
    scratchpad: { read: () => Promise.resolve(pad.text), write: (c: string) => Promise.resolve((pad.text = c)) },
  };
  const fake = {
    snippets,
    evalSnippet: async (code: string): Promise<SnippetResult> => {
      snippets.push(code);
      const saved = Object.fromEntries(["console", ...Object.keys(ambient)].map((k) => [k, g[k]]));
      const logs: SnippetResult["logs"] = [];
      const cap = { ...console, log: (...a: unknown[]) => logs.push({ level: "log", ts: Date.now(), text: a.map(String).join(" ") }) };
      Object.assign(g, { console: cap, ...ambient });
      const t0 = Date.now();
      try {
        await new AsyncFunction(compileSnippet(code).statementsBody).call(globalThis);
        return { ok: true, logs, durationMs: Date.now() - t0 };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? `${err.name}: ${err.message}` : String(err), logs, durationMs: Date.now() - t0 };
      } finally {
        Object.assign(g, saved);
      }
    },
    recentEvents: () => Promise.resolve([]),
    stateSnapshot: () => Promise.resolve({ self: {}, lastSeq: -1, eventCount: 0 }),
    totalRestarts: 0,
    consecutiveRestarts: 0,
    drainNotices: () => [],
    stop: () => Promise.resolve(),
  };
  return fake as unknown as SandboxHost & { snippets: string[] };
}

describe("through the fixed loop and the sandbox's own compiler", () => {
  test("each turn is one snippet; its result is the text a model would read", async () => {
    const dir = tempDir("wrathbench-reference-loop-");
    const pad = { text: "" };
    const sandbox = stubSandbox(pad);
    const config = {
      ...loadRunConfig({ driver: "reference", episode: "e90", account: "PROBE", model: MODEL, stepIntervalMs: 0, stateIntervalMs: 1, maxTurns: 6 }),
      runId: "run-reference-loop",
      token: "t".repeat(32),
    };
    const trajectory = new Trajectory(dir);
    trajectory.writeMeta({ runId: config.runId, harnessVersion: "harness-0.9-1-gabc", startedAt: Date.now(), config, shakeout: unscoredStamp(config.driver)! });
    const adapter = new ReferenceAdapter({ program: stubProgram, snippetTimeoutMs: config.snippetTimeoutMs, race: config.race, class: config.class });
    await runLoop({
      config,
      adapter,
      sandbox,
      scratchpad: new Scratchpad(join(dir, "scratchpad.md")),
      episodic: new EpisodicLog(join(dir, "episodic.jsonl")),
      trajectory,
      watchdogs: new Watchdogs(config.watchdogs),
      sleep: () => Promise.resolve(),
    });
    delete (globalThis as Record<string, unknown>)[REFERENCE_GLOBAL];
    // Loaded once, then ticked: the route walked to its last step and stayed there.
    expect(adapter.step).toBe(STUB_ROUTE.steps.length - 1);
    expect(pad.text).toMatch(/^stub-cursor: \d$/);
    const records = readTrajectory(dir);
    const snippets = records.filter((r) => r.t === "snippet");
    const results = records.filter((r) => r.t === "snippet_result");
    expect(snippets.length).toBe(6);
    expect(results.length).toBe(6);
    expect(String(snippets[0]!["code"])).toContain("tick: (");
    expect(snippets.slice(1).some((r) => String(r["code"]).includes("tick: ("))).toBe(false);
    expect(results.every((r) => /\[log\] REF \{/.test(String(r["text"])))).toBe(true);
    expect(records.filter((r) => r.t === "response").length).toBe(6);
    trajectory.close();
  });
});

// ------------------------------------------------------------------ stamped, never scored

describe("the stamp", () => {
  test("the reference is a driver that is not a model, with its own stamp", () => {
    expect(DRIVERS).toContain("reference");
    expect(isUnscoredDriver("reference")).toBe(true);
    expect(isUnscoredDriverName("reference")).toBe(true);
    expect(isUnscoredDriverName("openai")).toBe(false);
    expect(isUnscoredDriverName(null)).toBe(false);
    expect(unscoredStamp("reference")).toBe(REFERENCE_STAMP);
    expect(unscoredStamp("stub")).toBe(STUB_STAMP);
    expect(REFERENCE_STAMP).not.toBe(STUB_STAMP);
  });

  test("a stored run is not a model's by its driver or by its stamp, either one alone", () => {
    expect(isNotAModelRun({ driver: "reference", unscored: null })).toBe(true);
    expect(isNotAModelRun({ driver: null, unscored: REFERENCE_STAMP })).toBe(true);
    expect(isNotAModelRun({ unscored: `${STUB_STAMP}; unscored (operator objective)` })).toBe(true);
    expect(isNotAModelRun({ driver: "openai", unscored: "unscored (operator objective)" })).toBe(false);
    expect(isNotAModelRun({ driver: "codex", unscored: null })).toBe(false);
  });

  test("meta.json and the run row carry the stamp", () => {
    const dir = tempDir("wrathbench-reference-meta-");
    const config = loadRunConfig({ runId: "run-ref-meta", driver: "reference", episode: "e90", model: MODEL });
    const trajectory = new Trajectory(dir);
    trajectory.writeMeta({ runId: "run-ref-meta", harnessVersion: "t", startedAt: Date.now(), config, shakeout: unscoredStamp(config.driver)! });
    expect(readMeta(dir)?.shakeout).toBe(REFERENCE_STAMP);
    expect(trajectory.runRow("run-ref-meta")?.["shakeout"]).toBe(REFERENCE_STAMP);
    trajectory.close();
  });
});

describe("never counted, never a member, never a row", () => {
  const fact = (o: Partial<RunFact>): RunFact => ({
    runId: "r",
    model: "m",
    effort: null,
    episode: "e90",
    episodeOverride: false,
    harnessVersion: "harness-0.9-1-gabc",
    harnessSeries: "0.9",
    extra: false,
    startedAt: 1,
    endedAt: 2,
    terminationReason: "episode-limit",
    modelResponses: 200,
    bestLevel: 10,
    live: false,
    pause: null,
    account: "PROBE",
    character: "Kobaru",
    episodeMs: 90 * 60_000,
    campaign: null,
    cell: null,
    subscription: null,
    driver: "openai",
    ...o,
  });
  const entry: RosterModel = { name: "m", model: "m", tier: "t1" };
  const policy = { ...DEFAULT_POLICY, series: "0.9" };

  test("isCounted: not under any driver that is not a model, even with a roster entry's model id", () => {
    expect(isCounted(fact({}))).toBe(true);
    expect(isCounted(fact({ driver: "reference" }))).toBe(false);
    expect(isCounted(fact({ driver: "stub" }))).toBe(false);
  });

  test("targets: a colliding reference run is no attempt, no count, no witness and no best level", () => {
    const refRun = fact({ runId: "ref", driver: "reference" });
    const s = projectModel(entry, [refRun], policy, { now: 10 });
    expect(s.perEpisode.e90).toMatchObject({ counted: 0, attempts: 0, bestLevel: null, reachedL5: false });
    expect(s.tier).toBe("t1");
    expect(s.earnedRung1).toBe(false);
    // The same entry's own run counts, beside it.
    const both = projectModel(entry, [refRun, fact({ runId: "own", bestLevel: 4 })], policy, { now: 10 });
    expect(both.perEpisode.e90).toMatchObject({ counted: 1, attempts: 1, bestLevel: 4, reachedL5: false });
  });

  test("on disk: the scheduler's facts, /api/episodes and /api/results all keep it out of the group", async () => {
    const runs = tempDir("wrathbench-reference-runs-");
    const write = (runId: string, raw: Record<string, unknown>, level: number): void => {
      const config = { ...loadRunConfig({ runId, episode: "e90", stateIntervalMs: 1, ...raw }), token: "t".repeat(32) };
      const t = new Trajectory(join(runs, runId));
      const shakeout = unscoredStamp(config.driver);
      t.writeMeta({
        runId,
        harnessVersion: "harness-0.9-1-gabc",
        startedAt: Date.now() - 60_000,
        config,
        comparability: comparabilityOf(config, "harness-0.9-1-gabc"),
        ...(shakeout !== undefined ? { shakeout } : {}),
      });
      t.append({ t: "response", turn: 1, message: { role: "assistant", content: "x" } });
      t.recordState(runId, { level, xp: 10 });
      t.setTermination(runId, "episode-limit", "90m");
      t.close();
    };
    write("model-run", { driver: "openai", model: "m" }, 4);
    write("reference-run", { driver: "reference", model: MODEL }, 9);

    const facts = readRunFacts(runs);
    expect(facts.map((f) => f.runId).sort()).toEqual(["model-run", "reference-run"]);
    const refFact = facts.find((f) => f.runId === "reference-run")!;
    expect(refFact).toMatchObject({ driver: "reference", model: MODEL, episode: "e90" });
    expect(isCounted(refFact)).toBe(false);
    expect(isCounted(facts.find((f) => f.runId === "model-run")!)).toBe(true);

    const handle = createApi({ runsDir: runs, tilesDir: join(runs, "..", "minimap"), moduleUrl: "http://127.0.0.1:1" });
    const get = async (path: string): Promise<Record<string, unknown>> => (await (await handle(new Request(`http://x${path}`))).json()) as Record<string, unknown>;
    const eps = await get("/api/episodes");
    const e90 = (eps["episodes"] as { id: string; members: number }[]).find((e) => e.id === "e90");
    expect(e90?.members).toBe(1);
    const results = (await get("/api/results?episode=e90"))["runs"] as { runId: string; unscored: string | null; driver: string; maxLevel: number | null }[];
    // Listed — it is a run that happened — and unscored with its own reason,
    // which is what keeps it out of every ladder row (`scored()` in the dashboard).
    // It reached no model, so nothing billed and nothing is priced as if it had.
    const refRow = results.find((r) => r.runId === "reference-run") as unknown as Record<string, { usd?: unknown; asIfMetered?: unknown } | unknown>;
    expect(refRow).toMatchObject({ unscored: REFERENCE_STAMP, driver: "reference", maxLevel: 9, billing: "free" });
    expect((refRow["actualCost"] as { usd: unknown }).usd).toBeNull();
    expect((refRow["expectedCost"] as { usd: unknown } | null)?.usd ?? null).toBeNull();
    expect(results.find((r) => r.runId === "model-run")?.unscored).toBeNull();
  });
});
