/**
 * `bun wb inspect tools|pad` over one scenario played by each driver's
 * writer shape: the fixed loop (a slim `request` per turn, no `call` index),
 * codex (a `messages` request per turn, a `call` index, the records appended
 * after the call ran) and claude-code (one request at the session's start,
 * `turn` 1 throughout, the reflect gate drained late). The same calls must
 * count the same on all three; what the pad view can size is what differs.
 */

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { loadRunConfig, type RunConfig } from "../runner/src/config";
import { assembleContext, type ChatMessage } from "../runner/src/context";
import { REFLECT_ALREADY_USED, REFLECT_NOT_RESTING, READ_LOG_CLOSED, REFLECTION_PROMPT } from "../runner/src/reflect";
import { fixedLoopRequestRecord } from "../runner/src/request-record";
import { overCapText, Scratchpad, SCRATCHPAD_MAX_CHARS as RUNNER_MAX, scratchpadSizeLabel } from "../runner/src/scratchpad";
import { normalizeToolArgs } from "../runner/src/tools";
import { Trajectory } from "../runner/src/trajectory";
import {
  DEFAULT_WIDTH,
  main,
  PAD_ARG_ALIASES,
  PAD_EMPTY,
  PAD_REFUSED,
  padAt,
  padOfSection,
  padSizeLabel,
  REFLECT_ALREADY_USED_HEAD,
  REFLECT_NOT_RESTING_HEAD,
  REDACTED,
  SCRATCHPAD_MAX_CHARS,
} from "./inspect-run";
import { tempDirs } from "./temp-dirs";

const tmp = tempDirs();
const NOW = Date.UTC(2030, 0, 2, 12, 0, 0);
const T0 = NOW - 3_600_000;
const TOKEN = "cd34".repeat(16);

type Shape = "loop" | "codex" | "claude";

/** One run written the way its driver writes it. */
class Fixture {
  clock = T0;
  readonly traj: Trajectory;
  readonly pad: Scratchpad;
  turn = 0;
  call = 0;
  private requested = false;
  /** The claude-code driver's gate transitions, held until a context is built. */
  private gate: Record<string, unknown>[] = [];

  constructor(
    readonly dir: string,
    readonly runId: string,
    readonly shape: Shape,
  ) {
    this.traj = new Trajectory(dir, { now: () => this.clock });
    const driver = shape === "loop" ? "openai" : shape === "codex" ? "codex" : "claude-code";
    const config = { ...loadRunConfig({ driver: "stub" }), driver, runId, token: TOKEN, character: "Testwick", model: "test/model" } as RunConfig;
    this.traj.writeMeta({ runId, harnessVersion: "harness-test", startedAt: T0, config });
    this.pad = new Scratchpad(join(dir, "scratchpad.md"));
  }

  tick(ms = 1_000): void {
    this.clock += ms;
  }

  /** A driver turn: the context with the pad as it stands, then the model's answer. */
  request(): void {
    this.tick(60_000);
    if (this.shape === "claude" && this.requested) {
      this.traj.append({ t: "response", turn: this.turn, message: { role: "assistant", content: "…" } });
      return;
    }
    this.requested = true;
    this.turn++;
    const context = assembleContext({ turn: this.turn, notices: [], stateSummary: "[state]\nL3 in Elwynn", events: [], scratchpad: this.pad.read() });
    if (this.shape === "loop") {
      const messages: ChatMessage[] = [
        { role: "system", content: "system prompt" },
        { role: "user", content: context },
      ];
      const { record } = fixedLoopRequestRecord({ turn: this.turn, adapter: "openai-compatible:test/model", messages, history: [], from: 0, foldTo: 0, withSystemText: true });
      this.traj.append(record as { t: string });
    } else {
      const adapter = this.shape === "codex" ? "codex:test-model" : "claude-code:test-model";
      this.traj.append({ t: "request", turn: this.turn, adapter, messages: [{ role: "user", content: context }], ...(this.shape === "codex" ? { threadId: "th-1" } : {}) });
    }
    this.tick();
    this.traj.append({ t: "response", turn: this.turn, message: { role: "assistant", content: null } });
  }

  /** One tool call and its result, in the order and with the fields its driver writes. */
  tool(name: string, args: Record<string, unknown>, result: { text: string; isError?: boolean }): void {
    this.tick();
    this.call++;
    const call = this.shape === "loop" ? {} : { call: this.call };
    const dispatchTs = this.clock;
    this.traj.append({ t: "tool_call", turn: this.turn, ...call, name, args, dispatchTs });
    if (name === "run_snippet") this.traj.append({ t: "snippet", turn: this.turn, ...call, code: args["code"] });
    this.traj.append({
      t: name === "run_snippet" ? "snippet_result" : "tool_result",
      turn: this.turn,
      ...call,
      name,
      isError: result.isError ?? false,
      text: result.text,
      ...(name === "reflect" ? { reflect: true } : {}),
    });
  }

  snippet(code: string, result: { text: string; isError?: boolean }): void {
    this.tool("run_snippet", { code }, result);
  }

  write(args: Record<string, unknown>): void {
    const content = (args["content"] ?? args["text"]) as string;
    const res = this.pad.write(content);
    this.tool("write_scratchpad", args, res.ok ? { text: `written (${res.chars} chars)` } : { text: overCapText("write_scratchpad", res.chars), isError: true });
  }

  edit(args: Record<string, unknown>): void {
    const res = this.pad.edit((args["old"] ?? args["old_string"]) as string, (args["new"] ?? args["new_string"]) as string);
    if (!res.ok) throw new Error(`fixture edit refused: ${res.reason}`);
    this.tool("edit_scratchpad", args, { text: `edited (1 replacement; ${res.chars} chars, ${res.lines} lines)` });
  }

  /** A reflect_window transition: written at once by a per-turn driver, held to the next context by claude-code's. */
  window(event: "open" | "close", reason?: string): void {
    const rec = { t: "reflect_window", turn: this.turn, event, ...(reason !== undefined ? { reason } : {}) };
    if (this.shape === "claude") this.gate.push(rec);
    else this.traj.append(rec);
  }

  end(): void {
    this.tick(60_000);
    for (const r of this.gate) this.traj.append(r as { t: string });
    this.traj.close();
  }
}

/** The pad text after the first write: 1000 chars. */
const A = `# plan\n${"a".repeat(993)}`;
/** A rewrite that drops most of it. */
const B = `# plan\n${"b".repeat(593)}`;

/** Moments in the scenario, for the views' windows. */
const marks: Record<Shape, Record<string, number>> = { loop: {}, codex: {}, claude: {} };

/** The same calls on every driver; what each writes around them is its own. */
function play(f: Fixture): void {
  f.request(); // turn 1: an empty pad
  f.write({ content: A });
  f.snippet("return 1", { text: "ok (5ms)\n=> 1" });
  f.request(); // turn 2
  f.snippet('scratchpad.append("note one"); return "noted"', ((): { text: string } => (f.pad.append("note one"), { text: "ok (3ms)\n=> noted" }))());
  f.snippet("state.units({ guid: 1 })", { text: `error (12ms)\nTypeError: bad key for session ${TOKEN}`, isError: true });
  f.request(); // turn 3
  marks[f.shape]["turn3"] = f.clock;
  f.edit({ old_string: "note one", new_string: "note 1" }); // the alias spelling a model sent
  marks[f.shape]["afterEdit"] = f.clock;
  f.tool("search_reference", { query: "Hogger" }, { text: "1 result" });
  f.tool("read_log", {}, { text: READ_LOG_CLOSED, isError: true });
  f.tool("reflect", {}, { text: REFLECT_NOT_RESTING, isError: true });
  f.request(); // turn 4
  f.write({ text: B });
  marks[f.shape]["afterDrop"] = f.clock;
  f.write({ content: "z".repeat(SCRATCHPAD_MAX_CHARS + 1_000) });
  f.tool("reflect", {}, { text: REFLECTION_PROMPT });
  f.window("open");
  f.request(); // turn 5
  const big = "y".repeat(SCRATCHPAD_MAX_CHARS);
  const refused = f.pad.append(big);
  if (refused.ok) throw new Error("fixture: the append should be refused");
  f.snippet(`await scratchpad.append("y".repeat(${SCRATCHPAD_MAX_CHARS}))`, { text: `error (3ms)\nError: ${overCapText("scratchpad.append", refused.chars)}`, isError: true });
  f.tool("log_status", { text: "resting at the inn" }, { text: "logged (entry 1, 18 chars)" });
  f.window("close", "left_rest");
  f.request(); // turn 6
  f.end();
}

const RUNS = tmp("inspect-tools-pad-");
for (const shape of ["loop", "codex", "claude"] as const) play(new Fixture(join(RUNS, `run-${shape}`), `run-${shape}`, shape));

function inspect(argv: string[]): { code: number; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  const code = main([...argv, "--runs-dir", RUNS], {}, (l) => out.push(l), (l) => err.push(l), NOW);
  return { code, out, err };
}

const row = (out: string[], name: string): string => out.find((l) => l.startsWith(`${name} `)) ?? "";
const nums = (line: string): number[] => line.trim().split(/\s+/).slice(1, 4).map(Number);

describe("the constants it shares with the runner", () => {
  test("the cap, its refusal, its size label and the empty pad's text are the runner's", () => {
    expect(SCRATCHPAD_MAX_CHARS).toBe(RUNNER_MAX);
    expect(overCapText("write_scratchpad", 33_000)).toContain(`write_scratchpad ${PAD_REFUSED}33000 chars`);
    expect(overCapText("scratchpad.append", 1)).toContain(`scratchpad.append ${PAD_REFUSED}`);
    for (const n of [0, 99, 100, 950, 31_299, 32_000, 32_001, 40_000]) expect(padSizeLabel(n)).toBe(scratchpadSizeLabel(n));
    const empty = assembleContext({ turn: 1, notices: [], stateSummary: "", events: [], scratchpad: "" });
    expect(padOfSection(empty.slice(empty.indexOf("\n\n[scratchpad")))).toBe("");
    expect(empty.endsWith(PAD_EMPTY)).toBe(true);
    const full = assembleContext({ turn: 1, notices: [], stateSummary: "", events: [], scratchpad: A });
    expect(padOfSection(full.slice(full.indexOf("\n\n[scratchpad")))).toBe(A);
  });

  test("the reflect refusals and the pad tools' alias keys are the runner's", () => {
    expect(REFLECT_NOT_RESTING.startsWith(REFLECT_NOT_RESTING_HEAD)).toBe(true);
    expect(REFLECT_ALREADY_USED.startsWith(REFLECT_ALREADY_USED_HEAD)).toBe(true);
    for (const [tool, aliases] of Object.entries(PAD_ARG_ALIASES)) {
      for (const [alias, canonical] of Object.entries(aliases)) {
        expect(normalizeToolArgs(tool, { [alias]: "v" })).toEqual({ [canonical]: "v" });
      }
    }
  });
});

describe("inspect tools", () => {
  for (const shape of ["loop", "codex", "claude"] as const) {
    test(`counts every tool the same on the ${shape} shape`, () => {
      const r = inspect(["tools", `run-${shape}`]);
      expect(r.code).toBe(0);
      expect(nums(row(r.out, "run_snippet"))).toEqual([4, 2, 2]);
      expect(row(r.out, "run_snippet")).toContain("TypeError 1");
      expect(row(r.out, "run_snippet")).toContain("over cap 1");
      expect(nums(row(r.out, "write_scratchpad"))).toEqual([3, 2, 1]);
      expect(nums(row(r.out, "edit_scratchpad"))).toEqual([1, 1, 0]);
      expect(nums(row(r.out, "reflect"))).toEqual([2, 1, 1]);
      expect(nums(row(r.out, "read_log"))).toEqual([1, 0, 1]);
      expect(nums(row(r.out, "search_reference"))).toEqual([1, 1, 0]);
      expect(nums(row(r.out, "log_status"))).toEqual([1, 1, 0]);
      const at = (label: string): string => r.out.find((l) => l.startsWith(label)) ?? "";
      expect(at("reflection")).toContain("granted 1 · refused 1: not resting 1 · the reflect marker on 2 of 2");
      expect(at("windows")).toContain("opened 1 · closed 1: left_rest 1");
      expect(at("pad ")).toContain("write_scratchpad 3 (1 over cap), edit_scratchpad 1");
      expect(at("pad ")).toContain("snippets calling scratchpad.write/append: append 2 (1 refused over cap)");
      for (const l of r.out) expect(l.length).toBeLessThanOrEqual(DEFAULT_WIDTH);
      expect(r.out.join("\n")).not.toContain(TOKEN);
    });
  }

  test("names the driver and its requests: one per turn, or one per session", () => {
    expect(inspect(["tools", "run-loop"]).out[1]).toContain("driver    openai · 6 request(s) · 6 model response(s)");
    expect(inspect(["tools", "run-codex"]).out[1]).toContain("driver    codex · 6 request(s)");
    expect(inspect(["tools", "run-claude"]).out[1]).toContain("driver    claude-code · 1 request(s) · 6 model response(s)");
  });

  test("a window drained late reads zero-length, and says why", () => {
    const claude = inspect(["tools", "run-claude"]).out;
    expect(claude.find((l) => l.startsWith("windows"))).toContain("1 zero-length");
    expect(claude.some((l) => l.includes("zero-length: the gate's open and close are written when the harness builds a context"))).toBe(true);
    expect(inspect(["tools", "run-loop"]).out.find((l) => l.startsWith("windows"))).toContain("0 zero-length");
  });

  test("a long error result is classed in linear time", () => {
    // A refusal matcher run over a whole result backtracks quadratically on a page of one word character.
    const f = new Fixture(join(RUNS, "run-long-error"), "run-long-error", "loop");
    f.request();
    f.snippet("return dump()", { text: `error (1ms)\nError: ${"w".repeat(200_000)}`, isError: true });
    f.tool("search_reference", { query: "x" }, { text: "w".repeat(200_000), isError: true });
    f.end();
    const r = inspect(["tools", "run-long-error"]);
    expect(nums(row(r.out, "run_snippet"))).toEqual([1, 0, 1]);
    expect(nums(row(r.out, "search_reference"))).toEqual([1, 0, 1]);
  });

  test("--since and --until window the counts", () => {
    const r = inspect(["tools", "run-loop", "--since", String(marks.loop["turn3"]), "--until", String(marks.loop["afterDrop"])]);
    expect(r.out[0]).toContain("since 2030-01-02T11:03:");
    expect(r.out[0]).toContain("until ");
    expect(nums(row(r.out, "edit_scratchpad"))).toEqual([1, 1, 0]);
    expect(nums(row(r.out, "write_scratchpad"))).toEqual([1, 1, 0]);
    expect(row(r.out, "run_snippet")).toBe("");
  });
});

describe("inspect pad", () => {
  test("the fixed loop: a size per turn, every write with its size before and after, the drop flagged", () => {
    const r = inspect(["pad", "run-loop"]);
    expect(r.code).toBe(0);
    const at = (label: string): string => r.out.find((l) => l.startsWith(label)) ?? "";
    expect(at("sizes")).toContain("driver openai · the pad's text on 6 of 6 request(s)");
    expect(r.out.some((l) => l.startsWith("per-turn"))).toBe(false);
    expect(at("now")).toContain("scratchpad.md 600 chars (0.6k/32k)");
    expect(at("cap")).toContain("2 refusal(s)");
    const writes = r.out.slice(r.out.findIndex((l) => l.startsWith("writes")) + 1);
    expect(writes.length).toBe(6);
    expect(writes[0]).toMatch(/tool write\s+0 → 1000 \+0%|tool write\s+0 → 1000$/);
    expect(writes[1]).toMatch(/snippet append\s+1000 → 1009 \(next request\)\s+\+1%/);
    expect(writes[2]).toMatch(/tool edit\s+1009 → 1007/);
    expect(writes[3]).toMatch(/tool write\s+1007 → 600\s+-40%\s+DROP/);
    expect(writes[4]).toContain(`refused, would be ${SCRATCHPAD_MAX_CHARS + 1_000}`);
    expect(writes[5]).toMatch(/snippet append\s+600 → refused, would be \d+/);
    const timeline = r.out.slice(r.out.findIndex((l) => l.startsWith("timeline")) + 1, r.out.findIndex((l) => l.startsWith("writes")));
    expect(timeline.length).toBeGreaterThan(0);
    expect(timeline.length).toBeLessThanOrEqual(24);
    expect(timeline.some((l) => l.includes("drops 1"))).toBe(true);
    for (const l of r.out) expect(l.length).toBeLessThanOrEqual(DEFAULT_WIDTH);
  });

  test("codex sizes per turn the same way", () => {
    const writes = inspect(["pad", "run-codex"]).out;
    expect(writes.some((l) => /snippet append\s+1000 → 1009 \(next request\)/.test(l))).toBe(true);
    expect(writes.some((l) => l.startsWith("per-turn"))).toBe(false);
  });

  test("claude-code: says plainly there is no per-turn size, and sizes only what a tool result states", () => {
    const r = inspect(["pad", "run-claude"]);
    expect(r.out.find((l) => l.startsWith("per-turn"))).toContain("none: driver claude-code wrote the pad on 1 request(s) for 6 model response(s)");
    expect(r.out.some((l) => /snippet append\s+1000 → \?$/.test(l))).toBe(true);
    expect(r.out.some((l) => /tool write\s+1007 → 600\s+-40%\s+DROP/.test(l))).toBe(true);
  });

  test("--last bounds the writes listed, --until the window", () => {
    const last = inspect(["pad", "run-loop", "--last", "2"]).out;
    expect(last.find((l) => l.startsWith("writes"))).toContain("the last 2 of 6");
    const early = inspect(["pad", "run-loop", "--until", String(marks.loop["afterEdit"])]).out;
    expect(early.find((l) => l.startsWith("writes"))).toContain("the last 3 of 3");
  });

  test("--at rebuilds the pad from the newest request, replaying the edits after it", () => {
    const r = inspect(["pad", "run-loop", "--at", String(marks.loop["afterEdit"])]);
    expect(r.code).toBe(0);
    expect(r.out[0]).toContain("1007 chars");
    expect(r.out[1]).toContain("the request at");
    expect(r.out[1]).toContain("then 1 edit_scratchpad call(s) replayed");
    expect(r.out.some((l) => l.startsWith("uncertain"))).toBe(false);
    // Printed a line at a time, each capped; the rebuild itself is whole.
    expect(r.out.slice(r.out.indexOf("---") + 1)).toEqual(["# plan", `${"a".repeat(DEFAULT_WIDTH - 1)}…`, "note 1"]);
    expect(padAt(join(RUNS, "run-loop", "trajectory.jsonl"), marks.loop["afterEdit"]!)?.text).toBe(`${A}\nnote 1`);
  });

  test("--at starts from a write_scratchpad's content, under its alias key too", () => {
    const p = padAt(join(RUNS, "run-codex", "trajectory.jsonl"), marks.codex["afterDrop"]!);
    expect(p?.from.what).toBe("write_scratchpad");
    expect(p?.text).toBe(B);
  });

  test("--at on claude-code: a snippet's write between makes the text uncertain, and says so", () => {
    const r = inspect(["pad", "run-claude", "--at", String(marks.claude["afterEdit"])]);
    expect(r.out[1]).toContain("write_scratchpad at");
    expect(r.out.some((l) => l.startsWith("uncertain 1 snippet(s) after that call scratchpad.write/append"))).toBe(true);
    expect(r.out.some((l) => l.startsWith("uncertain 1 edit(s) did not find their text"))).toBe(true);
  });

  test("--at before anything recorded the pad says so", () => {
    const r = inspect(["pad", "run-loop", "--at", String(T0)]);
    expect(r.code).toBe(1);
    expect(r.out[0]).toContain("records the pad");
  });

  test("the token is struck from every new view, the rebuilt pad's text included", () => {
    // An older run's pad could carry it; the runner never registered it as a secret then.
    const f = new Fixture(join(RUNS, "run-token"), "run-token", "loop");
    f.request();
    f.write({ content: `module key ${TOKEN}` });
    f.request();
    f.end();
    for (const argv of [["tools"], ["pad"], ["pad", "--at", String(f.clock)]]) {
      const all = inspect([argv[0]!, "run-token", ...argv.slice(1)]).out.join("\n");
      expect(all).not.toContain(TOKEN);
    }
    expect(inspect(["pad", "run-token", "--at", String(f.clock)]).out).toContain(`module key ${REDACTED}`);
  });

  test("a flag a command does not take is refused, never ignored", () => {
    expect(inspect(["tools", "run-loop", "--at", "1h"]).code).toBe(2);
    expect(inspect(["pad", "run-loop", "--at", "1h", "--since", "2h"]).code).toBe(2);
    expect(inspect(["run", "run-loop", "--next", "3"]).code).toBe(2);
    expect(inspect(["pad", "run-loop", "--grep", "x"]).err[0]).toContain("--grep does not apply to pad");
  });
});
