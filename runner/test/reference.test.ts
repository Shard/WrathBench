/**
 * The scripted reference run (issue #79; operator, 2026-10-19).
 *
 * Two halves, both load-bearing. The run plays through exactly the models'
 * surface: one `run_snippet` per turn through the fixed loop, the program sent
 * as text and evaluated by the sandbox's own compiler, observing only the
 * tool result a model would read. And it is stamped and never scored: it is
 * no member of any comparability group, no target counts it, no row order
 * holds it, and the scheduler can neither count nor launch one.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
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
import { configFromArgs } from "../src/run";
import { runLoop } from "../src/loop";
import { EpisodicLog } from "../src/episodic";
import { Scratchpad } from "../src/scratchpad";
import { Trajectory, readMeta, readTrajectory } from "../src/trajectory";
import { Watchdogs } from "../src/watchdogs";
import { DEFAULT_POLICY, isCounted, projectModel, readRunFacts, type RosterModel, type RunFact } from "../src/models";
import { MAX_FAILED_TICKS, REFERENCE_GLOBAL, ReferenceAdapter, lastToolResult, parseReport } from "../src/reference/adapter";
import { referenceTick, type ReferenceEnv } from "../src/reference/program";
import { NORTHSHIRE_PALADIN, REFERENCE_ROUTE, referenceModelId, type Route } from "../src/reference/route";
import { createApi } from "../viewer/api";
import { tempDirs } from "./fixtures/temp-dirs";
import { requestsOf } from "./fixtures/requests";
import { northshireOpening, referenceSandbox } from "./fixtures/reference-world";

const tempDir = tempDirs();
const MODEL = referenceModelId(REFERENCE_ROUTE);

// ------------------------------------------------------------------ the program

describe("the program", () => {
  test("is self-contained: its text runs in a scope holding nothing but its arguments", async () => {
    // `new Function` closes over the global scope only, so any reference the
    // tick made to a binding of its own module would throw here.
    const tick = new Function(`return (${referenceTick.toString()})`)() as typeof referenceTick;
    const world = northshireOpening();
    const env = { ...world.ambient(), mem: {} } as unknown as ReferenceEnv;
    const login = await tick(env, NORTHSHIRE_PALADIN, { cursor: 0, budgetMs: 20_000, race: 1, class: 2 });
    expect(login).toMatchObject({ v: 1, login: true, advance: false });
    expect(world.calls[0]).toMatch(/^createSession [A-Z][a-z]{5,7} 1\/2$/);
    // The name and the step are the run's own notes, for a restart to read.
    expect(world.pad).toMatch(/reference-character: [A-Za-z]+\nreference-cursor: 0/);
    const visit = await tick(env, NORTHSHIRE_PALADIN, { cursor: 0, budgetMs: 20_000, race: 1, class: 2 });
    expect(visit.advance).toBe(true);
    expect(world.log.has(783)).toBe(true);
    expect(world.pad).toContain("reference-cursor: 1");
  });

  test("its modules import nothing at run time: no SDK of its own, no fetch, no files", () => {
    for (const f of ["program.ts", "adapter.ts", "route.ts"]) {
      const src = readFileSync(join(import.meta.dir, "..", "src", "reference", f), "utf8");
      const imports = [...src.matchAll(/^import (?!type )[^;]+;/gm)].map((m) => m[0]);
      // The adapter imports the program (to send its text) and nothing that reaches the world.
      for (const i of imports) expect(i).toMatch(/from "\.\/program"/);
      expect(src).not.toMatch(/\bfetch\(|node:fs|bun:sqlite|Bun\.file|readFileSync/);
    }
    // The sandbox refuses a snippet's own fetch and WebSocket: the ambient `sdk`
    // is its only path to the module, and the text the snippets carry uses no other.
    for (const text of [referenceTick.toString(), JSON.stringify(REFERENCE_ROUTE)]) {
      expect(text).not.toMatch(/\bfetch\b|WebSocket|new WrathClient|globalThis\.fetch/);
    }
  });

  test("a restarted program picks its step back up from its own scratchpad note", async () => {
    const world = northshireOpening();
    world.pad = "reference-character: Kobaru\nreference-cursor: 6\n";
    const env = { ...world.ambient(), mem: {} } as unknown as ReferenceEnv;
    const r = await referenceTick(env, NORTHSHIRE_PALADIN, { cursor: 0, budgetMs: 20_000, race: 1, class: 2 });
    expect(r).toMatchObject({ login: true, restored: 6 });
    expect(world.calls[0]).toBe("createSession Kobaru 1/2");
  });

  test("full bags divert to the vendor only for junk, and never park the character there", async () => {
    const world = northshireOpening();
    const env = { ...world.ambient(), mem: {} } as unknown as ReferenceEnv;
    const args = { cursor: 0, budgetMs: 20_000, race: 1, class: 2 };
    await referenceTick(env, NORTHSHIRE_PALADIN, args);
    const item = (i: number, quality: number) => ({ bag: 255, slot: 23 + i, guid: `item-${i}`, itemId: 100 + i, name: `i${i}`, count: 1, quality });
    // Full of white gear and quest items: nothing a vendor visit frees, so the step plays on.
    world.bag = { items: [item(0, 1), item(1, 1)], freeSlots: 0 };
    const playing = await referenceTick(env, NORTHSHIRE_PALADIN, args);
    expect(playing.advance).toBe(true);
    expect(world.calls.some((c) => c === "moveTo -8909,-104")).toBe(false);
    // Junk in full bags: one visit sells it, then the vendor is not visited again for a while.
    world.bag = { items: [item(0, 1), item(1, 0), item(2, 0)], freeSlots: 0 };
    const selling = await referenceTick(env, NORTHSHIRE_PALADIN, { ...args, cursor: 1 });
    expect(selling.advance).toBe(false);
    expect(world.calls.filter((c) => c.startsWith("sell "))).toEqual(["sell item-1", "sell item-2"]);
    world.bag = { items: [item(0, 1), item(3, 0)], freeSlots: 0 };
    const after = await referenceTick(env, NORTHSHIRE_PALADIN, { ...args, cursor: 1 });
    expect(after.advance).toBe(true);
    expect(world.calls.filter((c) => c.startsWith("sell "))).toHaveLength(2);
  });

  test("a step whose quest is not offered is noted and passed, never forced", async () => {
    const world = northshireOpening();
    const env = { ...world.ambient(), mem: {} } as unknown as ReferenceEnv;
    const route: Route = { ...NORTHSHIRE_PALADIN, steps: [{ kind: "visit", npc: 197, at: { x: -8903, y: -163, z: 82 }, accept: [7] }, NORTHSHIRE_PALADIN.steps.at(-1)!] };
    await referenceTick(env, route, { cursor: 0, budgetMs: 20_000, race: 1, class: 2 });
    const r = await referenceTick(env, route, { cursor: 0, budgetMs: 20_000, race: 1, class: 2 });
    expect(r.advance).toBe(true);
    expect(r.did.join(" ")).toContain("accept 7: not_offered");
    expect(world.log.has(7)).toBe(false);
  });
});

describe("the route", () => {
  test("is written for one start and ends in a hunt that never finishes", () => {
    expect(REFERENCE_ROUTE).toBe(NORTHSHIRE_PALADIN);
    expect([REFERENCE_ROUTE.race, REFERENCE_ROUTE.class]).toEqual([1, 2]);
    expect(REFERENCE_ROUTE.steps.at(-1)?.kind).toBe("grind");
    expect(REFERENCE_ROUTE.steps.filter((s) => s.kind === "grind")).toHaveLength(1);
    expect(MODEL).toBe("reference/elwynn-human-paladin@1");
  });

  test("starts with the smoke's arc, and every quest it works or turns in it took first", () => {
    const steps = REFERENCE_ROUTE.steps;
    // Compared through a copy: an asymmetric matcher inside toMatchObject can
    // write itself into the object it is matched against.
    const copy = JSON.parse(JSON.stringify(steps.slice(0, 2))) as { kind: string; npc: number; accept?: number[]; turnIn?: number[] }[];
    expect(copy[0]).toMatchObject({ kind: "visit", npc: 823 });
    expect(copy[0]!.accept).toContain(783);
    expect(copy[1]).toMatchObject({ kind: "visit", npc: 197, turnIn: [783], accept: [7] });
    const taken = new Set<number>();
    for (const s of steps) {
      if (s.kind === "objectives") for (const q of s.quests) expect(taken.has(q)).toBe(true);
      if (s.kind === "visit") {
        for (const q of s.turnIn ?? []) expect(taken.has(q)).toBe(true);
        for (const q of s.accept ?? []) taken.add(q);
      }
    }
  });

  test("is data with no game text: entries, ids and finite coordinates only", () => {
    const json = JSON.stringify(REFERENCE_ROUTE);
    // Every string in it is a key, the route id or a step kind.
    const strings = [...json.matchAll(/"([^"]*)"/g)].map((m) => m[1]!);
    const allowed = new Set(["id", "version", "race", "class", "buffs", "heal", "vendors", "steps", "kind", "npc", "at", "x", "y", "z", "turnIn", "accept", "reward", "quests", "drops", "areas", "via", "targets", "minLevel", "maxMinutes", "visit", "objectives", "train", "vendor", "travel", "grind", REFERENCE_ROUTE.id]);
    for (const s of strings) expect(allowed.has(s)).toBe(true);
    const points = [...json.matchAll(/"x":(-?[\d.]+),"y":(-?[\d.]+),"z":(-?[\d.]+)/g)];
    expect(points.length).toBeGreaterThan(20);
    for (const p of points) for (const v of p.slice(1)) expect(Number.isFinite(Number(v))).toBe(true);
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

describe("the adapter", () => {
  const adapter = (): ReferenceAdapter => new ReferenceAdapter({ route: NORTHSHIRE_PALADIN, snippetTimeoutMs: 30_000, race: 1, class: 2 });

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
    expect(first).toContain(referenceTick.toString().slice(0, 60));
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
    const last = NORTHSHIRE_PALADIN.steps.length - 1;
    await codeOf(a, tool(ref({ cursor: 0, advance: false, did: [], restored: last })));
    for (let i = 0; i < 3; i++) {
      const out = await a.complete({ messages: tool(ref({ cursor: last, advance: true, did: [] })), tools: [] });
      expect(out.kind).toBe("ok");
    }
    expect(a.step).toBe(last);
  });
});

// ------------------------------------------------------------------ through the loop

describe("through the fixed loop and the sandbox's own compiler", () => {
  test("plays the smoke's arc as snippets: accept, turn in, kill credit, turn in", async () => {
    const dir = tempDir("wrathbench-reference-loop-");
    const world = northshireOpening();
    const sandbox = referenceSandbox(world);
    const config = {
      ...loadRunConfig({ driver: "reference", episode: "e90", account: "PROBE", stepIntervalMs: 0, stateIntervalMs: 1, maxTurns: 40 }),
      runId: "run-reference-loop",
      token: "t".repeat(32),
    };
    const trajectory = new Trajectory(dir);
    trajectory.writeMeta({ runId: config.runId, harnessVersion: "harness-0.9-1-gabc", startedAt: Date.now(), config, shakeout: unscoredStamp(config.driver)! });
    const adapter = new ReferenceAdapter({ route: NORTHSHIRE_PALADIN, snippetTimeoutMs: config.snippetTimeoutMs, race: config.race, class: config.class });
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
    // The world says what happened: the intro and the vermin quest are done,
    // the kills were credited, and the character was the route's start.
    expect(world.done.has(783)).toBe(true);
    expect(world.done.has(7)).toBe(true);
    expect(world.calls.filter((c) => c === "kill 6").length).toBeGreaterThanOrEqual(3);
    expect(world.calls[0]).toMatch(/ 1\/2$/);
    expect(adapter.step).toBeGreaterThan(6);
    // And the trajectory holds it the way it holds a model's: a snippet per
    // turn, its result as the text the model would have read.
    const records = readTrajectory(dir);
    const snippets = records.filter((r) => r.t === "snippet");
    const results = records.filter((r) => r.t === "snippet_result");
    expect(snippets.length).toBe(40);
    expect(results.length).toBe(40);
    expect(String(snippets[0]!["code"])).toContain("tick: (");
    expect(results.every((r) => /\[log\] REF \{/.test(String(r["text"])))).toBe(true);
    expect(records.filter((r) => r.t === "response").length).toBe(40);
    // Forty turns trim the window and fold its older block's results to one
    // line each; the driver reads only the newest result, which is never
    // folded, so it went on advancing through every folded window.
    const sent = requestsOf(dir);
    const folded = sent.filter((r) => r.messages.some((m) => m.role === "tool" && (m.content ?? "").startsWith("[folded by harness]")));
    expect(folded.length).toBeGreaterThan(0);
    for (const r of folded) {
      const newest = [...r.messages].reverse().find((m) => m.role === "tool");
      expect(newest?.content ?? "").toContain("[log] REF {");
    }
    trajectory.close();
  });

  test("a sandbox restart mid-run costs one turn: the next snippet reloads and the note puts it back", async () => {
    const world = northshireOpening();
    const sandbox = referenceSandbox(world);
    const a = new ReferenceAdapter({ route: NORTHSHIRE_PALADIN, snippetTimeoutMs: 30_000, race: 1, class: 2 });
    let messages: ChatMessage[] = [{ role: "system", content: "s" }, { role: "user", content: "u" }];
    const turn = async (): Promise<string> => {
      const code = await codeOf(a, messages);
      const r = await sandbox.evalSnippet(code);
      const text = [r.ok ? "ok" : `error ${r.error}`, "--- console ---", ...r.logs.map((l) => `[${l.level}] ${l.text}`)].join("\n");
      messages = tool(text);
      return text;
    };
    for (let i = 0; i < 6; i++) await turn();
    const before = a.step;
    expect(before).toBeGreaterThan(1);
    sandbox.dropBindings();
    expect(await turn()).toContain('"unloaded":true');
    await turn(); // load + login, with the note's cursor
    await turn();
    expect(a.step).toBeGreaterThanOrEqual(before);
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

  test("a launch is e90's shape under the fixed loop, carrying the route as its model", () => {
    const c = configFromArgs(["--driver", "reference", "--episode", "e90", "--account", "PROBE"], {});
    expect(c).toMatchObject({ driver: "reference", episode: "e90", account: "PROBE", model: MODEL, race: 1, class: 2 });
    const t = comparabilityOf(c, "harness-0.9-1-gabc");
    expect(t).toMatchObject({ harness: "wrathbench", episode: "e90", episodeOverride: false, objective: false });
  });

  test("anything that would steer it or change its start is refused, never ignored", () => {
    expect(() => loadRunConfig({ driver: "reference", objective: "go to Goldshire" })).toThrow(/objective/);
    expect(() => loadRunConfig({ driver: "reference", race: 3 })).toThrow(/race 1, class 2/);
    expect(() => loadRunConfig({ driver: "reference", model: "sonnet" })).toThrow(/model/);
    expect(() => loadRunConfig({ driver: "reference", continuedFrom: "run-x" })).toThrow(/continuedFrom/);
    expect(loadRunConfig({ driver: "reference", model: MODEL }).model).toBe(MODEL);
  });

  test("meta.json and the run row carry the stamp", () => {
    const dir = tempDir("wrathbench-reference-meta-");
    const config = loadRunConfig({ runId: "run-ref-meta", driver: "reference", episode: "e90" });
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
    const ref = fact({ runId: "ref", driver: "reference" });
    const s = projectModel(entry, [ref], policy, { now: 10 });
    expect(s.perEpisode.e90).toMatchObject({ counted: 0, attempts: 0, bestLevel: null, reachedL5: false });
    expect(s.tier).toBe("t1");
    expect(s.earnedRung1).toBe(false);
    // The same entry's own run counts, beside it.
    const both = projectModel(entry, [ref, fact({ runId: "own", bestLevel: 4 })], policy, { now: 10 });
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
    write("reference-run", { driver: "reference" }, 9);

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
