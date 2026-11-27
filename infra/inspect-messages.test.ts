/**
 * `bun wb inspect messages`: each turn's context message cut into the parts
 * the runner writes (runner/src/context.ts `assembleContext`), sized, and the
 * program loop's wake blocks read back, off the files and off the store alike.
 */

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { loadRunConfig } from "../runner/src/config";
import { assembleContext } from "../runner/src/context";
import { Trajectory } from "../runner/src/trajectory";
import { type InspectStore, main, MESSAGE_PARTS, messageParts } from "./inspect-run";
import { memoryStore } from "./inspect-memory-store";
import { tempDirs } from "./temp-dirs";

const tmp = tempDirs();
const MIN = 60_000;
const NOW = Date.UTC(2030, 0, 2, 12, 0, 0);
const T0 = NOW - 3 * 3_600_000;
const TOKEN = "ab12".repeat(16);
const RUNS = tmp("inspect-messages-");

const EVENT = { seq: 1, ts: T0, opcode: "SMSG_MESSAGECHAT", data: { text: "hello there" } };
const WAKE_BLOCK = "[wake 1 · slept 42s · woke for: routine ended (trip, returned)]\nroutines:\ntrip returned 1s ago: \"done\"\nno routine is running";

function context(turn: number, o: { wake?: string; notices?: boolean; pad: string }): string {
  return assembleContext({
    stateSummary: "== state (seq 4, 9 events seen) ==\nsession: in world\n\nposition: (1, 2, 3)",
    events: [EVENT as never, { ...EVENT, seq: 2 } as never],
    scratchpad: o.pad,
    notices: o.notices === true ? [{ ts: T0, kind: "session_note", text: "a note\n\nwith a gap" }] : [],
    turn,
    ...(o.wake !== undefined ? { wake: o.wake } : {}),
  });
}

describe("messageParts", () => {
  test("cuts what assembleContext writes into its parts, and they join back to the message", () => {
    for (const o of [{ pad: "" }, { pad: "# plan\n\n[scratchpad] quoted", wake: WAKE_BLOCK }, { pad: "x", notices: true }, { pad: "y\n\n[events] quoted", wake: WAKE_BLOCK, notices: true }]) {
      const text = context(3, o);
      const parts = messageParts(text);
      expect(MESSAGE_PARTS.map((k) => parts[k]).filter((p) => p !== "").join("\n\n")).toBe(text);
      expect(parts.turn).toBe("[turn 3]");
      expect(parts.wake).toBe(o.wake ?? "");
      expect(parts.hud).toStartWith("== state");
      expect(parts.events).toStartWith("[events");
      expect(parts.pad).toBe(o.pad === "" ? "[scratchpad]\n(empty — write your plan and durable facts with write_scratchpad)" : `[scratchpad 0.0k/32k]\n${o.pad}`);
      expect(parts.events).toBe(`[events: last 2, newest last]\n${parts.events.split("\n").slice(1).join("\n")}`);
      expect(parts.events.split("\n").length).toBe(3);
      expect(parts.notices === "").toBe(o.notices !== true);
    }
  });
});

/** A codex program-loop run: three turns' messages, a yield's result, and a wake record that carries its block. */
const RUN = "run-messages";
{
  const dir = join(RUNS, RUN);
  let clock = T0;
  const traj = new Trajectory(dir, { now: () => clock });
  traj.writeMeta({ runId: RUN, harnessVersion: "t", startedAt: T0, config: { ...loadRunConfig({ driver: "stub" }), runId: RUN, token: TOKEN, driver: "codex" } });
  const at = (ts: number, r: Record<string, unknown>): void => {
    clock = ts;
    traj.append(r as Parameters<Trajectory["append"]>[0]);
  };
  at(T0 + 1 * MIN, { t: "request", turn: 1, adapter: "codex:sol", messages: [{ role: "user", content: context(1, { pad: "p".repeat(300) }) }] });
  at(T0 + 2 * MIN, { t: "tool_result", turn: 1, name: "yield", isError: false, text: "[wake 1 · slept 5s · woke for: 5s passed]\nroutines: none started" });
  at(T0 + 3 * MIN, { t: "request", turn: 2, adapter: "codex:sol", messages: [{ role: "user", content: context(2, { pad: "p".repeat(300), wake: WAKE_BLOCK }) }] });
  // A slim fixed-loop record carries its message as `user`.
  at(T0 + 4 * MIN, { t: "request", turn: 3, adapter: "openai", slim: 1, user: context(3, { pad: "q".repeat(100) }) });
  traj.close();
}

async function inspect(argv: string[], store?: InspectStore): Promise<{ code: number; out: string[]; err: string[] }> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await main(argv, {}, (l) => out.push(l), (l) => err.push(l), NOW, store === undefined ? {} : { store });
  return { code, out, err };
}

describe("inspect messages", () => {
  test("sizes each request's parts and their mean, and prints the wake blocks off the messages and yield results", async () => {
    const r = await inspect(["messages", RUN, "--runs-dir", RUNS, "--wakes", "--width", "400"]);
    expect(r.err).toEqual([]);
    expect(r.code).toBe(0);
    const text = r.out.join("\n");
    expect(text).toMatch(/^ +turn +total +wake +notices +hud +events +pad$/m);
    const turn2 = context(2, { pad: "p".repeat(300), wake: WAKE_BLOCK });
    expect(text).toMatch(new RegExp(`^\\S+ \\S+ +2 +${turn2.length} +${WAKE_BLOCK.length} +0 +\\d+ +\\d+ +${"[scratchpad 0.3k/32k]\n".length + 300}$`, "m"));
    expect(text).toMatch(/^share +wake \d+% · notices 0% · hud \d+% · events \d+% · pad \d+%$/m);
    expect(text).toContain("wakes     2 block(s), off the messages and the yield results");
    expect(text).toContain("[wake 1 · slept 5s · woke for: 5s passed]");
    expect(text).toContain("trip returned 1s ago: \"done\"");
  });

  test("reads the same off the store, whose request lines it fetches whole", async () => {
    const store = await memoryStore(RUNS);
    const files = await inspect(["messages", RUN, "--runs-dir", RUNS, "--files"]);
    const stored = await inspect(["messages", RUN, "--runs-dir", RUNS], store);
    expect(stored.code).toBe(0);
    const rows = (out: string[]): string[] => out.filter((l) => /^\S+ \S+ +\d|^mean|^share/.test(l));
    expect(rows(stored.out)).toEqual(rows(files.out));
    expect(rows(stored.out).length).toBe(5);
  });
});
