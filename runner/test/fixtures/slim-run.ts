/**
 * A fixed-loop run driven through the real `runLoop` by a scripted model, for
 * the tests that prove slim request records replay and that every reader
 * takes both shapes.
 *
 * The script is built to reach every way a message enters the history or is
 * shaped on the way out: several tool calls in one turn, a malformed argument
 * string, an unknown tool, a reply with no text, a reply and a snippet result
 * each longer than the per-message cap, a reflection opened at rest and closed
 * by leaving it, a status entry written on every turn the harness asks for one
 * before a trim, and enough turns to cross more than one block trim. It is
 * then resumed as a second process segment on the same trajectory, whose tool
 * call ids repeat the first's — the way a real adapter's ids are only unique
 * per process, if at all.
 *
 * `sent` is every message array as it was handed to the adapter, serialised
 * on the way in: the bytes a replay has to reproduce.
 *
 * `legacyVariant` writes the same run as the pre-slim writer would have: each
 * slim request of the chosen segments expanded into `{ t, turn, adapter,
 * messages }` with the messages that were sent. Old, new and mixed files of
 * one and the same run are what the reader tests compare.
 */

import { copyFileSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AdapterOutcome, ChatAdapter, ChatRequest, ToolCall } from "../../src/adapter";
import { loadRunConfig } from "../../src/config";
import { EpisodicLog } from "../../src/episodic";
import { runLoop } from "../../src/loop";
import { Replayer } from "../../src/replay";
import { Scratchpad } from "../../src/scratchpad";
import type { SandboxHost, SnippetResult } from "../../src/sandbox/host";
import type { EventSummary } from "../../src/sandbox/ipc";
import { Trajectory } from "../../src/trajectory";
import { Watchdogs } from "../../src/watchdogs";

export const SLIM_RUN_ID = "run-slim";

/** Turns the scripted model plays in each segment, before it answers stub-complete. */
export const SEGMENT_TURNS = [48, 12] as const;

export interface SlimRun {
  dir: string;
  /** `JSON.stringify(req.messages)` of every adapter call, in order, across both segments. */
  sent: string[];
}

interface World {
  resting: boolean;
  seq: number;
}

function sandbox(world: World): SandboxHost {
  const opcodes = ["SMSG_MESSAGECHAT", "SMSG_MONSTER_MOVE", "SMSG_ATTACKERSTATEUPDATE", "SMSG_UPDATE_OBJECT"];
  return {
    evalSnippet: (code: string): Promise<SnippetResult> =>
      Promise.resolve({ ok: true, value: `ran:${code}`, logs: [], durationMs: 1 }),
    recentEvents: (): Promise<EventSummary[]> => {
      const out: EventSummary[] = [];
      for (let k = 0; k < 12; k++) {
        world.seq++;
        out.push({ seq: world.seq, ts: 1_000 + world.seq, opcode: opcodes[world.seq % opcodes.length]!, data: { n: world.seq, text: `event ${world.seq}` } });
      }
      return Promise.resolve(out);
    },
    stateSnapshot: () =>
      Promise.resolve({
        self: { resting: { value: world.resting, seq: 1, ts: 1 } },
        lastSeq: world.seq,
        eventCount: world.seq,
      }),
    totalRestarts: 0,
    consecutiveRestarts: 0,
    drainNotices: () => [],
    stop: () => Promise.resolve(),
  } as unknown as SandboxHost;
}

/** The scripted model. Model-agnostic test code: it reads only the request it is handed. */
function scriptedModel(turns: number, world: World, sent: string[]): ChatAdapter {
  let call = 0;
  return {
    label: "stub",
    complete(req: ChatRequest): Promise<AdapterOutcome> {
      sent.push(JSON.stringify(req.messages));
      call++;
      if (call > turns) return Promise.resolve({ kind: "stub-complete" });
      const user = String(req.messages[req.messages.length - 1]?.content ?? "");
      // A stay at rest across turns 9-13: the sample before each request reads
      // what the previous answer left here.
      if (call === 8) world.resting = true;
      if (call === 13) world.resting = false;
      let k = 0;
      const tc = (name: string, args: unknown): ToolCall => ({
        id: `stub-${call}-${k++}`,
        name,
        arguments: typeof args === "string" ? args : JSON.stringify(args),
      });
      let content: string | null = `turn ${call}`;
      let toolCalls: ToolCall[];
      if (user.includes("- trim_pending:")) {
        toolCalls = [tc("log_status", { text: `status before the trim, turn ${call}` })];
      } else if (call === 3) {
        toolCalls = [tc("run_snippet", "{not json")];
      } else if (call === 4) {
        content = null;
        toolCalls = [tc("write_scratchpad", { content: `# plan\n- reach level 5\n- turn ${call}` })];
      } else if (call === 5) {
        content = `long reply ${"r".repeat(6_000)}`;
        toolCalls = [tc("run_snippet", { code: "1" })];
      } else if (call === 7) {
        toolCalls = [tc("no_such_tool", {})];
      } else if (call === 10) {
        toolCalls = [tc("reflect", {})];
      } else if (call === 11) {
        toolCalls = [tc("read_log", {})];
      } else if (call % 12 === 1) {
        toolCalls = [tc("run_snippet", { code: `/* ${"x".repeat(4_500)} */ ${call}` })];
      } else if (call % 6 === 0) {
        toolCalls = [tc("run_snippet", { code: `a(${call})` }), tc("state_summary", {}), tc("run_snippet", { code: `b(${call})` })];
      } else {
        toolCalls = [tc("run_snippet", { code: `ping(${call})` })];
      }
      return Promise.resolve({ kind: "ok", turn: { content, toolCalls } });
    },
  };
}

/** Run the two segments into `dir`; the trajectory is closed when this returns. */
export async function slimRun(dir: string): Promise<SlimRun> {
  const config = {
    ...loadRunConfig({ driver: "stub", stepIntervalMs: 0, stateIntervalMs: 1 }),
    runId: SLIM_RUN_ID,
    token: SLIM_RUN_ID,
  };
  const trajectory = new Trajectory(dir);
  trajectory.writeMeta({ runId: SLIM_RUN_ID, harnessVersion: "t", startedAt: 1_000, config });
  const world: World = { resting: false, seq: 0 };
  const sent: string[] = [];
  const scratchpad = new Scratchpad(join(dir, "scratchpad.md"));
  const episodic = new EpisodicLog(join(dir, "episodic.jsonl"));
  let turnOffset = 0;
  for (const [s, turns] of SEGMENT_TURNS.entries()) {
    if (s > 0) {
      // What run.ts writes on a resume; the loop's history starts empty again.
      trajectory.clearPause(SLIM_RUN_ID);
      trajectory.append({ t: "resume", harnessVersion: "t" });
    }
    await runLoop({
      config,
      adapter: scriptedModel(turns, world, sent),
      sandbox: sandbox(world),
      scratchpad,
      episodic,
      trajectory,
      watchdogs: new Watchdogs(config.watchdogs),
      sleep: () => Promise.resolve(),
      turnOffset,
      ...(s > 0 ? { initialNotices: [{ ts: 1, kind: "session_note" as const, text: "resumed after a pause" }] } : {}),
    });
    turnOffset += turns + 1;
  }
  trajectory.close();
  return { dir, sent };
}

/**
 * Write `src`'s run into `dst` with the slim requests of the segments `expand`
 * picks rewritten as the pre-slim writer wrote them. Every other line, and
 * every other file of the run, is copied as it is.
 */
export function legacyVariant(src: string, dst: string, expand: (segment: number) => boolean): void {
  for (const name of readdirSync(src)) {
    if (name !== "trajectory.jsonl") copyFileSync(join(src, name), join(dst, name));
  }
  const replayer = new Replayer();
  const out: string[] = [];
  readFileSync(join(src, "trajectory.jsonl"), "utf8")
    .split("\n")
    .forEach((line, k) => {
      if (line.length === 0) return;
      const rec = JSON.parse(line) as Record<string, unknown>;
      const taken = replayer.take(rec, k + 1);
      if (taken === null || !expand(taken.verdict.segment)) {
        out.push(line);
        return;
      }
      if (!taken.verdict.ok || taken.messages === undefined) throw new Error(`line ${k + 1} did not replay: ${taken.verdict.detail}`);
      // The old writer: `trajectory.append({ t: "request", turn, adapter, messages })`.
      out.push(JSON.stringify({ ts: rec["ts"], t: "request", turn: rec["turn"], adapter: rec["adapter"], messages: taken.messages }));
    });
  writeFileSync(join(dst, "trajectory.jsonl"), `${out.join("\n")}\n`);
}
