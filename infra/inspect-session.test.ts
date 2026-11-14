/**
 * `bun wb inspect` over v1 and fan-out runs: the `marks` line read off a
 * session record's `events` stream, the `cost` line, a fan-out run's
 * characters one by one in `run` and `live`, and the `session` view of the
 * `events` and `calls` streams. Each run is written by the runner's own
 * Trajectory and the stack's own SessionWriter, and every view that reads
 * the store is read over the files and over the collector's rows alike.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { emptyTraceSheet, emptyTraceState, type EventRow, type RecordDrain, SessionWriter } from "@wrathbench/mcp/record";
import { loadRunConfig } from "../runner/src/config";
import { FANOUT_SEP as RUNNER_FANOUT_SEP, SESSIONS_DIR as RUNNER_SESSIONS_DIR } from "../runner/src/run-reader";
import { Trajectory } from "../runner/src/trajectory";
import { readRunRow } from "../runner/src/run-reader";
import { writeLegacy05Run } from "../runner/test/fixtures/legacy05-writer";
import { reportedCostUsd } from "../runner/viewer/tail";
import { FANOUT_SEP, type InspectStore, main, SESSIONS_DIR, usageSql } from "./inspect-run";
import { memoryStore } from "./inspect-memory-store";
import { tempDirs } from "./temp-dirs";

const tmp = tempDirs();
const NOW = Date.UTC(2030, 0, 2, 12, 0, 0);
const MIN = 60_000;
const T0 = NOW - 30 * MIN;
const TOKEN = "cd34".repeat(16);

interface Character {
  name: string;
  guid: string;
  level: number;
  /** Null: none read yet, as a character at exactly 0 has none until its first gain. */
  xp: number | null;
  /** The bar's length, when the key carries it. */
  xpMax?: number;
  events: EventRow[];
}

/** A character's session record: a key reading at T0, its events, and the calls `calls` writes into it. */
function writeRecord(session: string, id: string, c: Character, calls: (w: SessionWriter, at: (ts: number) => void) => void, live: boolean): SessionWriter {
  let clock = T0;
  const writer = new SessionWriter({ dir: session, id, stack: { version: "test" }, now: () => clock, log: () => {} });
  writer.open();
  const character = { guid: c.guid, name: c.name, race: 1, class: 1 };
  const drain = (trace: RecordDrain["trace"]["rows"], events: EventRow[]): RecordDrain => ({
    trace: { rows: trace, dropped: 0 },
    events: { rows: events, dropped: 0 },
    nearby: { rows: [], dropped: 0, through: 0 },
    moves: [],
    character,
    stream: { connected: true, events: 1, seq: 1 },
  });
  writer.ingest(drain([{ ts: T0, kind: "key", map: 0, x: 1, y: 2, z: 3, o: 0, data: { ...emptyTraceState(), ...emptyTraceSheet(), level: c.level, xp: c.xp, ...(c.xpMax !== undefined ? { xpMax: c.xpMax } : {}), money: 1234, zone: 12 } }], []));
  // What the trace says beside an event: a level gained, a turn-in.
  for (const e of c.events) {
    clock = e.ts;
    const trace: RecordDrain["trace"]["rows"] =
      e.kind === "level" ? [{ ts: e.ts, kind: "state", data: { level: e.to, xp: e.xp ?? 0 } }] : e.kind === "quest" ? [{ ts: e.ts, kind: "state", data: { qdone: [e.id] } }] : [];
    writer.ingest(drain(trace, [e]));
  }
  calls(writer, (ts) => (clock = ts));
  clock = NOW - 2_000;
  writer.ingest(null);
  if (live) return writer;
  return writer;
}

/** The run's trajectory and meta.json, and a heartbeat when `live`. */
function writeRun(dir: string, runId: string, config: Record<string, unknown>, records: Record<string, unknown>[], live: boolean): void {
  let clock = T0;
  const traj = new Trajectory(dir, { now: () => clock });
  traj.writeMeta({ runId, harnessVersion: "harness-test", startedAt: T0, config: { ...loadRunConfig({ driver: "stub" }), runId, token: TOKEN, model: "test/model", ...config } });
  for (const [i, r] of records.entries()) {
    clock = T0 + (i + 1) * MIN;
    traj.append(r as Parameters<Trajectory["append"]>[0]);
  }
  traj.close();
  if (live) {
    writeFileSync(join(dir, "heartbeat"), "a-host 1\n");
    utimesSync(join(dir, "heartbeat"), (NOW - 5_000) / 1000, (NOW - 5_000) / 1000);
  }
}

/** OpenRouter's shape: the usage on every response, its charge with it. */
const OPENROUTER_TURNS = [1, 2, 3].flatMap((turn) => [
  { t: "request", turn, adapter: "openai", messages: "m".repeat(200) },
  { t: "response", turn, message: { role: "assistant", content: "On it." }, usage: { prompt_tokens: 1000, completion_tokens: 50, prompt_tokens_details: { cached_tokens: 600 }, cost: 0.0125 } },
]);

/** The Claude Code CLI's shape: usage on the responses, the charge cumulative per session on its results. */
const CLAUDE_TURNS = [
  { t: "response", turn: 1, message: { role: "assistant", content: "a" }, usage: { input_tokens: 2000, output_tokens: 10, cache_read_input_tokens: 1500, cache_creation_input_tokens: 400 } },
  { t: "claude_result", turn: 1, sessionId: "s-one", costUsd: 0.5 },
  { t: "response", turn: 2, message: { role: "assistant", content: "b" }, usage: { input_tokens: 2000, output_tokens: 20 } },
  { t: "claude_result", turn: 2, sessionId: "s-one", costUsd: 1.25 },
  { t: "pause", reason: "operator-pause" },
  { t: "response", turn: 3, message: { role: "assistant", content: "c" }, usage: { input_tokens: 500, output_tokens: 5 } },
  { t: "claude_result", turn: 3, sessionId: "s-two", costUsd: 0.75 },
];

/**
 * The claude-code driver as it writes now: one usage-bearing response per
 * message (an earlier envelope carries none), its output the opening snapshot;
 * the result's `num_turns` and finished usage, after the termination in the
 * wind-down's grace; then a resumed process killed before its turn's result.
 */
const claudeUsage = (prompt: number, cached: number, out: number, write?: number): Record<string, unknown> => ({
  prompt_tokens: prompt,
  completion_tokens: out,
  total_tokens: prompt + out,
  cached_tokens: cached,
  ...(write !== undefined ? { cache_write_tokens: write } : {}),
});
const CLAUDE_CLI_TURNS = [
  { t: "driver", driver: "claude-code" },
  { t: "request", turn: 1, adapter: "claude-code", messages: "m".repeat(200) },
  { t: "response", turn: 1, message: { role: "assistant", content: "a" } },
  { t: "response", turn: 1, message: { role: "assistant", content: "b" }, usage: claudeUsage(3000, 2000, 2, 500) },
  { t: "response", turn: 1, message: { role: "assistant", content: "c" }, usage: claudeUsage(4000, 3500, 1) },
  { t: "termination", reason: "episode-limit" },
  { t: "response", turn: 1, message: { role: "assistant", content: "d" }, usage: claudeUsage(4200, 4000, 3) },
  {
    t: "claude_result",
    turn: 1,
    sessionId: "s-one",
    numTurns: 5,
    costUsd: 0.9,
    usageRaw: { input_tokens: 1200, output_tokens: 1800, cache_read_input_tokens: 9500, cache_creation_input_tokens: 500 },
    usage: { prompt_tokens: 11200, completion_tokens: 1800, total_tokens: 13000, cached_tokens: 9500, cache_write_tokens: 500 },
  },
  { t: "driver", driver: "claude-code" },
  { t: "response", turn: 1, message: { role: "assistant", content: "e" }, usage: claudeUsage(5000, 4500, 4) },
  { t: "pause", reason: "operator-pause" },
];

const RUNS = tmp("inspect-session-");

/** A v1 run: one record in `session/`, its events across several segments, and every kind of `calls` row. */
const V1 = "run-v1";
{
  const dir = join(RUNS, V1);
  writeRun(dir, V1, { character: "Testwick", account: "TESTACCT" }, [...OPENROUTER_TURNS, { t: "termination", reason: "episode-limit" }], false);
  const events: EventRow[] = [
    { ts: T0 + 1 * MIN, kind: "achievements_at_login", ids: [1], points: 10 },
    { ts: T0 + 2 * MIN, kind: "quest", id: 101 },
    { ts: T0 + 7 * MIN, kind: "level", from: 4, to: 5, xp: 10 },
    { ts: T0 + 8 * MIN, kind: "death", zone: 12 },
    { ts: T0 + 9 * MIN, kind: "release" },
    { ts: T0 + 12 * MIN, kind: "zone", from: 12, to: 40 },
    { ts: T0 + 20 * MIN, kind: "quest", id: 102 },
  ] as EventRow[];
  const w = writeRecord(join(dir, "session"), "0123456789abcdef", { name: "Testwick", guid: "5", level: 4, xp: 900, events }, (w, at) => {
    at(T0 + 3 * MIN);
    const a = w.call("state_summary", {}, T0 + 3 * MIN);
    at(T0 + 3 * MIN + 200);
    w.result(a, { text: "Testwick, level 4." });
    at(T0 + 14 * MIN);
    const b = w.call("run_snippet", { code: `await moveTo(1, 2, 3) // ${TOKEN}` }, T0 + 14 * MIN);
    at(T0 + 14 * MIN + 100);
    w.actions({ call: b, inCall: true }, [
      { ts: T0 + 14 * MIN + 50, action: "move_to", status: 200, ms: 4, moveId: 77 },
      { ts: T0 + 14 * MIN + 60, action: "cast_spell", status: 409, ms: 2, error: "not_ready", count: 3 },
    ]);
    w.eventsServed(b, [
      { seq: 1, ts: T0 + 14 * MIN, opcode: "SMSG_ATTACKSTART", data: {} },
      { seq: 2, ts: T0 + 14 * MIN, opcode: "SMSG_ATTACKSTART", data: {} },
      { seq: 3, ts: T0 + 14 * MIN, opcode: "SMSG_SPELL_GO", data: {}, schemaError: "bad" },
    ]);
    at(T0 + 14 * MIN + 900);
    w.result(b, { text: "error (900ms)\nError: moveTo target_off_mesh", isError: true });
  }, false);
  await w.close();
}

/** A fan-out run: two characters, a call written to both (it named neither) and one to Alfa alone, claude-code's charge. */
const FAN = "run-fan";
const ALFA: Character = { name: "Alfa", guid: "901", level: 5, xp: 900, events: [{ ts: T0 + 4 * MIN, kind: "level", from: 5, to: 6, xp: 5 }, { ts: T0 + 6 * MIN, kind: "death" }] as EventRow[] };
const BRAVO: Character = { name: "Bravo", guid: "902", level: 3, xp: 120, events: [{ ts: T0 + 5 * MIN, kind: "quest", id: 7 }] as EventRow[] };
{
  const dir = join(RUNS, FAN);
  writeRun(dir, FAN, { character: "Alfa", account: "FANA", fanout: { characters: 3, accounts: ["FANA", "FANB", "FANC"] } }, CLAUDE_TURNS, true);
  const rollup = T0 + 10 * MIN;
  for (const [i, c] of [ALFA, BRAVO].entries()) {
    writeRecord(join(dir, SESSIONS_DIR, c.name), `fa0f0f0f0f0f0f0${i}`, c, (w, at) => {
      at(rollup);
      const id = w.call("party_status", {}, rollup);
      at(rollup + 300);
      w.result(id, { text: "two of us" });
      if (c.name !== "Alfa") return;
      at(rollup + MIN);
      const own = w.call("state_summary", { character: "Alfa" }, rollup + MIN);
      at(rollup + MIN + 100);
      w.result(own, { text: "Alfa, level 6." });
    }, true);
  }
}

/** A claude-code run, its turns and tokens the CLI's. */
const CLI = "run-claude-cli";
writeRun(join(RUNS, CLI), CLI, { driver: "claude-code", character: "Clawick" }, CLAUDE_CLI_TURNS, false);

/** A 0.5 run: its row and samples in run.sqlite, its turns' usage the same shape. */
const OLD = "run-05";
writeRun(join(RUNS, OLD), OLD, { character: "Oldwick" }, OPENROUTER_TURNS, false);
writeLegacy05Run(join(RUNS, OLD), readRunRow(join(RUNS, OLD), OLD)!, [{ ts: T0 + MIN, level: 3, xp: 40, money: 5, questsCompleted: 1, turn: 1, zone: 12 }]);

/** A v1 run's fresh character: the bar's length read, and no xp, which is how exactly 0 arrives. */
const FRESH = "run-fresh";
{
  const dir = join(RUNS, FRESH);
  writeRun(dir, FRESH, { character: "Newwick", account: "NEWACCT" }, [...OPENROUTER_TURNS, { t: "termination", reason: "episode-limit" }], false);
  await writeRecord(join(dir, "session"), "0123456789abcdee", { name: "Newwick", guid: "6", level: 1, xp: null, xpMax: 400, events: [] }, () => {}, false).close();
}

const STORE = await memoryStore(RUNS);

async function inspect(argv: string[], store?: InspectStore): Promise<{ code: number; out: string[]; err: string[] }> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await main([...argv, "--runs-dir", RUNS], {}, (l) => out.push(l), (l) => err.push(l), NOW, store === undefined ? {} : { store });
  return { code, out, err };
}

const line = (out: string[], label: string): string => out.find((l) => l.startsWith(label)) ?? "";

describe("what it shares with the runner and the collector", () => {
  test("a fan-out run's layout and the store's key for a character", () => {
    expect(SESSIONS_DIR).toBe(RUNNER_SESSIONS_DIR);
    expect(FANOUT_SEP).toBe(RUNNER_FANOUT_SEP);
  });

  test("the cost reads the collector's usage columns of a run's responses, never a line's text", () => {
    const sql = usageSql("run-x");
    expect(sql).toContain("FROM turns WHERE run_id = 'run-x' AND kind = 'response' GROUP BY line_no");
    expect(sql).not.toContain("raw");
    const turns = /CREATE TABLE IF NOT EXISTS wrathbench\.turns\b[\s\S]*?\n\)/.exec(readFileSync(join(import.meta.dir, "../collector/schema.sql"), "utf8"))?.[0] ?? "";
    for (const col of ["input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens", "cost_usd"]) expect({ col, in: turns.includes(`  ${col} `) }).toEqual({ col, in: true });
  });
});

for (const [where, store] of [["the files", undefined], ["ClickHouse", STORE]] as const) {
  describe(`inspect run on v1 and fan-out runs, over ${where}`, () => {
    test("a v1 run's marks are its record's events: what happened, never a baseline or a first reading", async () => {
      const r = await inspect(["run", V1], store);
      expect(r.code).toBe(0);
      const marks = line(r.out, "marks");
      expect(marks).toContain("termination 1");
      expect(marks).toContain("quest 2");
      expect(marks).toContain("level 1 (L4→L5)");
      expect(marks).toContain("death 1");
      expect(marks).toContain("release 1");
      expect(marks).toContain("zone 1");
      expect(marks).not.toContain("achievements_at_login");
      expect(line(r.out, "quests")).toBe("quests     2 over the run");
    });

    test("a character at exactly 0 xp reads 0 once its bar's length is known", async () => {
      expect(line((await inspect(["run", FRESH], store)).out, "level")).toStartWith("level      L1 0xp of 400");
    });

    test("--since and --until bound the marks", async () => {
      const r = await inspect(["run", V1, "--since", String(T0 + 6 * MIN), "--until", String(T0 + 13 * MIN)], store);
      const marks = line(r.out, "marks");
      expect(marks).toContain("level 1");
      expect(marks).toContain("zone 1");
      expect(marks).not.toContain("quest");
    });

    test("the cost is the provider's charge and the tokens its responses reported, over the whole run", async () => {
      const cost = line((await inspect(["run", V1], store)).out, "cost");
      expect(cost).toContain("$0.0375 reported by the provider on 3 of 3 responses");
      expect(cost).toContain("tokens in 3.0k (cache read 1.8k), out 150, reported on 3 of 3 responses");
      // The window bounds the activity, never the cost.
      expect(line((await inspect(["run", V1, "--since", String(T0 + 5 * MIN)], store)).out, "cost")).toBe(cost);
    });

    test("claude-code's charge is each session's largest cumulative figure, summed over sessions, as the viewer reads it", async () => {
      const cost = line((await inspect(["run", FAN, "--width", "1000"], store)).out, "cost");
      expect(cost).toContain("$2.00 the CLI's total_cost_usd over 2 session(s) · ");
      expect(reportedCostUsd(CLAUDE_TURNS as { t: string }[])).toBe(2);
      // Results with no usage of their own: the responses' figures, their output named for what it is.
      expect(cost).toContain("no CLI result reported usage, snapshot output only: 3 message(s) in 3 driver turn(s), in 4.5k (cache read 1.5k, write 400), out 35 (opening snapshots)");
      // At the terminal's width too, the figure is never shown without its label ahead of it.
      const cut = line((await inspect(["run", FAN], store)).out, "cost");
      expect(cut).toContain("snapshot output only");
      expect(cut.indexOf("snapshot")).toBeLessThan(Math.max(cut.indexOf("out 35"), cut.length));
      expect(line((await inspect(["run", FAN], store)).out, "activity")).toContain("model turns unknown (no CLI result reported num_turns) · 3 response records");
    });

    test("claude-code's model turns and tokens are its CLI results', and what no result covers is said to be a snapshot", async () => {
      const r = await inspect(["run", CLI, "--width", "1000"], store);
      expect(r.code).toBe(0);
      expect(line(r.out, "activity")).toContain(" · 5 model turns (num_turns on 1 CLI result(s)) · 5 response records · ");
      expect(line(r.out, "cost")).toBe(
        "cost       over the run: $0.9000 the CLI's total_cost_usd over 1 session(s), which leaves out the 1 driver turn(s) that got no result" +
          " · tokens on 1 CLI result(s): in 11.2k (cache read 9.5k, write 500), out 1.8k over 5 model turns" +
          " · with no result, snapshot output only: 1 message(s) in 1 driver turn(s), in 5.0k (cache read 4.5k), out 4 (opening snapshots)" +
          " · 5 response records, 4 with usage (one per message; the rest are its earlier envelopes)",
      );
      // Another driver's run keeps the plain reading: a response record is a request.
      expect(line((await inspect(["run", V1, "--width", "1000"], store)).out, "activity")).toContain(" · 3 responses · ");
    });

    test("a fan-out run is its characters, one block each, its lead on the level line", async () => {
      const r = await inspect(["run", FAN], store);
      expect(r.code).toBe(0);
      expect(line(r.out, "run")).toContain("(fan-out)");
      expect(line(r.out, "verdict")).toContain("live");
      expect(line(r.out, "characters")).toBe("characters 2 of 3 logged in: Alfa, Bravo · accounts FANA, FANB, FANC");
      expect(line(r.out, "level")).toContain("the lead is Alfa, L6");
      expect(line(r.out, "sessions")).toContain("2 character record(s)");
      const at = r.out.findIndex((l) => l.startsWith("Alfa "));
      expect(r.out[at]).toMatch(/^Alfa\s+L6 5xp/);
      expect(r.out.slice(at, at + 5).find((l) => l.startsWith("  marks"))).toContain("death 1");
      expect(r.out.find((l) => l.startsWith("Bravo "))).toMatch(/^Bravo\s+L3 120xp/);
      expect(r.out.filter((l) => l.startsWith("  session")).map((l) => l.replace(/ · .*/, ""))).toEqual(["  session  wrath-session/1 (Alfa), open", "  session  wrath-session/1 (Bravo), open"]);
      expect(r.out.join("\n")).not.toContain(TOKEN);
    });

    test("live lists a fan-out run with its lead, and a line per character", async () => {
      const r = await inspect(["live"], store);
      const at = r.out.findIndex((l) => l.includes(FAN));
      expect(r.out[at]).toContain("L6 5xp (Alfa)");
      expect(r.out[at]).toContain("fan-out, 2 character(s)");
      expect(r.out[at + 1]).toMatch(/^\s+Alfa {2}L6 5xp/);
      expect(r.out[at + 2]).toMatch(/^\s+Bravo {2}L3 120xp/);
    });
  });
}

describe("ClickHouse and the files give the same run view", () => {
  for (const id of [V1, FAN, OLD]) {
    test(id, async () => {
      // A v1 trace carries no turn: the store joins one from the trajectory, the files' reading has none.
      const view = async (s?: InspectStore): Promise<string[]> =>
        (await inspect(["run", id], s)).out.filter((l) => !l.startsWith("source")).map((l) => (id === V1 ? l.replace(/ · turn \d+/, "") : l));
      expect(await view(STORE)).toEqual(await view());
    });
  }
});

describe("inspect session", () => {
  test("a v1 run's events, oldest first, the stream's restating rows left out", async () => {
    const r = await inspect(["session", V1]);
    expect(r.code).toBe(0);
    expect(r.out[0]).toBe(`${V1}: the events stream of Testwick · the last 7, UTC`);
    expect(r.out.slice(2).map((l) => l.split(/\s{2,}/)[1])).toEqual(["achievements_at_login", "quest", "level", "death", "release", "zone", "quest"]);
    expect(r.out.find((l) => / level /.test(l))).toContain('{"from":4,"to":5,"xp":10}');
  });

  test("--kind, --grep, --last, --next and a window narrow it", async () => {
    expect((await inspect(["session", V1, "--kind", "death,release"])).out.slice(2).map((l) => l.split(/\s{2,}/)[1])).toEqual(["death", "release"]);
    expect((await inspect(["session", V1, "--kind", "key"])).out.length).toBeGreaterThan(3);
    expect((await inspect(["session", V1, "--grep", '"id":102'])).out.slice(2)).toHaveLength(1);
    expect((await inspect(["session", V1, "--last", "2"])).out.slice(2).map((l) => l.split(/\s{2,}/)[1])).toEqual(["zone", "quest"]);
    expect((await inspect(["session", V1, "--next", "2"])).out.slice(2).map((l) => l.split(/\s{2,}/)[1])).toEqual(["achievements_at_login", "quest"]);
    const w = await inspect(["session", V1, "--since", String(T0 + 6 * MIN), "--until", String(T0 + 13 * MIN)]);
    expect(w.out.slice(2).map((l) => l.split(/\s{2,}/)[1])).toEqual(["level", "death", "release", "zone"]);
  });

  test("the calls stream: each call and its result, the actions and the batch it served, the token struck", async () => {
    const r = await inspect(["session", V1, "--stream", "calls"]);
    expect(r.code).toBe(0);
    const of = (kind: string): string[] => r.out.filter((l) => l.split(/\s{2,}/)[1] === kind);
    expect(of("call").map((l) => l.replace(/^.*?call\s+/, ""))).toEqual([`#${T0 + 3 * MIN} state_summary {}`, `#${T0 + 14 * MIN} run_snippet {"code":"await moveTo(1, 2, 3) // [redacted]"}`]);
    expect(of("result")[1]).toContain("ERROR 900ms error (900ms)⏎Error: moveTo target_off_mesh");
    expect(of("actions")[0]).toContain(`tool #${T0 + 14 * MIN}: move_to 200, cast_spell 409 not_ready ×3`);
    expect(of("events")[0]).toContain("3 event(s), 1 with a schemaError: SMSG_ATTACKSTART 2, SMSG_SPELL_GO 1");
    expect(r.out.join("\n")).not.toContain(TOKEN);
  });

  test("a fan-out run's characters together, each line naming its own, a call written to both shown once", async () => {
    const r = await inspect(["session", FAN]);
    expect(r.out[0]).toContain("the events stream of 2 character(s): Alfa, Bravo");
    expect(r.out.slice(2).map((l) => l.split(/\s{2,}/).slice(1, 3).join(" "))).toEqual(["Alfa level", "Bravo quest", "Alfa death"]);
    const calls = await inspect(["session", FAN, "--stream", "calls", "--kind", "call"]);
    expect(calls.out.slice(2).map((l) => l.split(/\s{2,}/).slice(1, 3).join(" "))).toEqual(["Alfa+1 call", "Alfa call"]);
    const bravo = await inspect(["session", FAN, "--character", "bravo", "--stream", "calls", "--kind", "call"]);
    expect(bravo.out[0]).toContain("of 1 character(s): Bravo");
    expect(bravo.out.slice(2)).toHaveLength(1);
  });

  test("a character's session id, as the viewer names it, is that character: session reads it alone, every other view the run", async () => {
    const id = `${FAN}${FANOUT_SEP}Bravo`;
    const byFlag = await inspect(["session", FAN, "--character", "Bravo", "--stream", "calls", "--kind", "call"]);
    const byId = await inspect(["session", id, "--stream", "calls", "--kind", "call"]);
    expect(byId).toEqual(byFlag);
    expect((await inspect(["session", `${FAN}${FANOUT_SEP}bravo`, "--character", "Bravo"])).code).toBe(0);
    const clash = await inspect(["session", id, "--character", "Alfa"]);
    expect(clash.code).toBe(2);
    expect(clash.err[0]).toContain("is Bravo's session; --character Alfa names another");
    const missing = await inspect(["session", `${FAN}${FANOUT_SEP}Charlie`]);
    expect(missing.code).toBe(1);
    expect(missing.out[0]).toContain("has no character Charlie: Alfa, Bravo");
    for (const view of [["run"], ["stuck"], ["trajectory"], ["tools"], ["pad"]]) {
      const r = await inspect([view[0]!, id]);
      const whole = await inspect([view[0]!, FAN]);
      expect({ view, code: r.code }).toEqual({ view, code: whole.code });
      expect(r.out[0]).toBe(`${id} is Bravo's session: this view is the run's, every character's together; session ${id} is Bravo's alone`);
      expect(r.out.slice(1)).toEqual(whole.out);
      expect((await inspect([view[0]!, `${FAN}${FANOUT_SEP}Charlie`])).out[0]).toContain("has no character Charlie");
    }
    expect((await inspect(["run", `${FAN}${FANOUT_SEP}../x`])).code).toBe(2);
    expect((await inspect(["run", `${FANOUT_SEP}Bravo`])).code).toBe(2);
  });

  test("a run with no record, a character it does not have, and a bad flag each say so", async () => {
    const old = await inspect(["session", OLD]);
    expect(old.code).toBe(1);
    expect(old.out[0]).toContain("a 0.5 run");
    const none = await inspect(["session", FAN, "--character", "Charlie"]);
    expect(none.code).toBe(1);
    expect(none.out[0]).toContain("has no character Charlie: Alfa, Bravo");
    expect((await inspect(["session", V1, "--stream", "trace"])).code).toBe(2);
    expect((await inspect(["session", V1, "--character", "../x"])).code).toBe(2);
    expect((await inspect(["trajectory", V1, "--kind", "death"])).code).toBe(2);
  });
});
