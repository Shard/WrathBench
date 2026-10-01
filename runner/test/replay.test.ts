/**
 * Slim request records replay into exactly what was sent.
 *
 * The test that makes the slim shape safe: the real loop, driven by a scripted
 * model across two process segments and several block trims, then every
 * request rebuilt from the written trajectory alone and byte-compared with
 * what the adapter was handed. Anything the window or the user message needs
 * that the trajectory does not hold fails it. Then the same file, tampered
 * with, must fail the replay at the right line and turn.
 */

import { beforeAll, describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ChatMessage } from "../src/context";
import { Replayer, replayFile, type ReplayReport } from "../src/replay";
import {
  HistoryRebuilder,
  fixedLoopRequestRecord,
  isSlimRequest,
  requestHash,
  requestStats,
} from "../src/request-record";
import { comparabilityOf } from "../src/comparability";
import { readMeta, readTrajectory } from "../src/trajectory";
import { SEGMENT_TURNS, slimRun, type SlimRun } from "./fixtures/slim-run";
import { tempDirs } from "./fixtures/temp-dirs";

const tempDir = tempDirs();
const REPLAY_CLI = join(import.meta.dir, "..", "src", "replay.ts");

let run: SlimRun;
let lines: string[];
beforeAll(async () => {
  run = await slimRun(tempDir("wrathbench-replay-"));
  lines = readFileSync(join(run.dir, "trajectory.jsonl"), "utf8").split("\n").filter((l) => l.length > 0);
});

/** 1-based line of the first record matching `pred`. */
function lineOf(pred: (r: Record<string, unknown>) => boolean): number {
  const k = lines.findIndex((l) => pred(JSON.parse(l) as Record<string, unknown>));
  if (k < 0) throw new Error("no such record");
  return k + 1;
}

/** A copy of the run's trajectory with `edit` applied, replayed. */
async function replayTampered(edit: (lines: string[]) => string[]): Promise<{ dir: string; report: ReplayReport }> {
  const dir = tempDir("wrathbench-replay-tampered-");
  writeFileSync(join(dir, "trajectory.jsonl"), `${edit([...lines]).join("\n")}\n`);
  return { dir, report: await replayFile(join(dir, "trajectory.jsonl")) };
}

function rewrite(line: string, change: (r: Record<string, unknown>) => void): string {
  const r = JSON.parse(line) as Record<string, unknown>;
  change(r);
  return JSON.stringify(r);
}

const segment1Turn = (t: string, turn: number) => (r: Record<string, unknown>) => r["t"] === t && r["turn"] === turn;

describe("a stub-driven run replays byte for byte", () => {
  test("the run reached every way a message enters or is shaped in the window", () => {
    const records = readTrajectory(run.dir);
    const requests = records.filter((r) => r.t === "request");
    const users = requests.map((r) => String(r["user"]));
    // More than one block trim, each announced and each carried out.
    expect(users.filter((u) => u.includes("- trim_pending:")).length).toBeGreaterThanOrEqual(2);
    expect(users.filter((u) => u.includes("- window_trimmed:")).length).toBeGreaterThanOrEqual(2);
    // The status entry written on the turn before a trim.
    expect(records.filter((r) => r.t === "episodic").length).toBeGreaterThanOrEqual(2);
    // A reflection opened at rest and closed by leaving it.
    const windows = records.filter((r) => r.t === "reflect_window").map((r) => [r["event"], r["reason"]]);
    expect(windows).toContainEqual(["open", undefined]);
    expect(windows).toContainEqual(["close", "left_rest"]);
    const responses = records.filter((r) => r.t === "response").map((r) => r["message"] as ChatMessage);
    expect(responses.some((m) => m.content === null)).toBe(true);
    expect(responses.some((m) => (m.tool_calls?.length ?? 0) >= 3)).toBe(true);
    // The malformed argument string and the unknown tool both answer as errors.
    const results = records.filter((r) => r.t === "snippet_result" || r.t === "tool_result");
    expect(results.filter((r) => r["isError"] === true).length).toBeGreaterThanOrEqual(2);
    // Both a long reply and a long result were cut by the per-message cap.
    expect(run.sent.filter((s) => s.includes("…[truncated")).length).toBeGreaterThan(1);
    // Every request is slim, and the system text rides once per segment.
    expect(requests.every((r) => isSlimRequest(r) && !("messages" in r))).toBe(true);
    expect(requests.filter((r) => typeof r["systemText"] === "string")).toHaveLength(2);
    expect(requests.filter((r) => (r["window"] as { to: number }).to === 0)).toHaveLength(2);
  });

  test("every request rebuilds from the trajectory alone to the bytes handed to the adapter", async () => {
    const rebuilt: string[] = [];
    const report = await replayFile(join(run.dir, "trajectory.jsonl"), (v, messages) => {
      expect(v.ok).toBe(true);
      rebuilt.push(JSON.stringify(messages));
    });
    expect(report.failures).toEqual([]);
    expect(report.segments).toBe(2);
    expect(report.full).toBe(0);
    // Each segment's scripted turns plus the stub-complete turn that ends it.
    expect(report.slim).toBe(SEGMENT_TURNS[0] + SEGMENT_TURNS[1] + 2);
    expect(report.verified).toBe(report.slim);
    expect(rebuilt).toHaveLength(run.sent.length);
    for (let k = 0; k < rebuilt.length; k++) {
      if (rebuilt[k] !== run.sent[k]) throw new Error(`request ${k + 1} rebuilt to different bytes than were sent`);
    }
  });

  test("the record's hash is of the bytes that were sent, and its counts are theirs", () => {
    const requests = readTrajectory(run.dir).filter((r) => r.t === "request");
    requests.forEach((r, k) => {
      const sent = JSON.parse(run.sent[k]!) as ChatMessage[];
      expect(r["requestHash"]).toBe(requestHash(sent));
      expect({ messageCount: r["messageCount"], systemChars: r["systemChars"], promptChars: r["promptChars"] }).toEqual(
        requestStats(sent),
      );
    });
  });

  test("the system prompt's hash is the one the comparability tuple stamps", () => {
    const meta = readMeta(run.dir)!;
    const stamped = comparabilityOf(meta.config, "t").promptHash;
    const requests = readTrajectory(run.dir).filter((r) => r.t === "request");
    expect(requests.every((r) => r["systemHash"] === stamped)).toBe(true);
  });

  test("a slim record is a fraction of the full one it stands for", () => {
    const requests = readTrajectory(run.dir).filter((r) => r.t === "request");
    let slim = 0;
    let full = 0;
    requests.forEach((r, k) => {
      slim += JSON.stringify(r).length;
      full += JSON.stringify({ ts: r.ts, t: "request", turn: r["turn"], adapter: r["adapter"], messages: JSON.parse(run.sent[k]!) }).length;
    });
    expect(slim).toBeLessThan(full / 3);
  });
});

describe("a tampered trajectory fails the replay where it was tampered", () => {
  test("an edited tool result fails the first request whose window holds it", async () => {
    const at = lineOf(segment1Turn("snippet_result", 2));
    const { report } = await replayTampered((ls) => {
      ls[at - 1] = rewrite(ls[at - 1]!, (r) => {
        r["text"] = `${String(r["text"])} (edited)`;
      });
      return ls;
    });
    expect(report.failures.length).toBeGreaterThan(0);
    expect(report.failures[0]).toMatchObject({ line: lineOf(segment1Turn("request", 3)), segment: 1, turn: 3 });
    expect(report.failures[0]!.detail).toContain("request hash mismatch");
  });

  test("an edited user message fails exactly its own request", async () => {
    const at = lineOf(segment1Turn("request", 5));
    const { report } = await replayTampered((ls) => {
      ls[at - 1] = rewrite(ls[at - 1]!, (r) => {
        r["user"] = String(r["user"]).replace("[turn 5]", "[turn five]");
      });
      return ls;
    });
    expect(report.failures).toEqual([
      { line: at, segment: 1, turn: 5, ok: false, detail: "request hash mismatch: the rebuilt request is not the one that was sent" },
    ]);
  });

  test("an edited system prompt text fails its segment and names the text", async () => {
    const at = lineOf(segment1Turn("request", 1));
    const { report } = await replayTampered((ls) => {
      ls[at - 1] = rewrite(ls[at - 1]!, (r) => {
        r["systemText"] = `${String(r["systemText"])} `;
      });
      return ls;
    });
    expect(report.failures[0]).toMatchObject({ line: at, segment: 1, turn: 1 });
    expect(report.failures[0]!.detail).toContain("does not hash to");
    // Every later request of that segment points at a text the replay refused;
    // the next segment carries its own and replays.
    expect(report.failures).toHaveLength(SEGMENT_TURNS[0] + 1);
    expect(report.failures.every((f) => f.segment === 1)).toBe(true);
    expect(report.verified).toBe(SEGMENT_TURNS[1] + 1);
  });

  test("a deleted result line fails every later request of its segment, with the count it is short", async () => {
    const at = lineOf(segment1Turn("snippet_result", 2));
    const { report } = await replayTampered((ls) => ls.filter((_, k) => k !== at - 1));
    // Line numbers after the deletion move up by one.
    expect(report.failures[0]).toMatchObject({ line: lineOf(segment1Turn("request", 3)) - 1, segment: 1, turn: 3 });
    expect(report.failures[0]!.detail).toMatch(/held \d+ messages; the trajectory rebuilds \d+/);
    // Turns 1 and 2 were sent before the deleted record existed; every later
    // request of the segment is short, and the next segment is untouched.
    expect(report.failures).toHaveLength(SEGMENT_TURNS[0] + 1 - 2);
    expect(report.failures.every((f) => f.segment === 1)).toBe(true);
    expect(report.verified).toBe(2 + SEGMENT_TURNS[1] + 1);
  });

  test("the CLI exits non-zero and names the line, segment and turn", async () => {
    const at = lineOf(segment1Turn("request", 5));
    const { dir } = await replayTampered((ls) => {
      ls[at - 1] = rewrite(ls[at - 1]!, (r) => {
        r["user"] = `${String(r["user"])}!`;
      });
      return ls;
    });
    const bad = Bun.spawnSync(["bun", REPLAY_CLI, dir]);
    expect(bad.exitCode).toBe(1);
    expect(bad.stdout.toString()).toContain(`line ${at}, segment 1, turn 5: request hash mismatch`);
    const good = Bun.spawnSync(["bun", REPLAY_CLI, run.dir]);
    expect(good.exitCode).toBe(0);
    expect(good.stdout.toString()).toContain("every slim request rebuilt to the bytes that were sent");
  });

  test("the CLI prints one request rebuilt, as it was sent", () => {
    const at = lineOf(segment1Turn("request", 30));
    const out = Bun.spawnSync(["bun", REPLAY_CLI, run.dir, "--line", String(at)]);
    expect(out.exitCode).toBe(0);
    const printed = JSON.parse(out.stdout.toString()) as { ok: boolean; turn: number; messages: ChatMessage[] };
    expect(printed.ok).toBe(true);
    expect(printed.turn).toBe(30);
    expect(JSON.stringify(printed.messages)).toBe(run.sent[29]!);
  });
});

describe("the writer's own check", () => {
  const system = "the system prompt";
  const history: ChatMessage[] = [
    { role: "assistant", content: "a", tool_calls: [{ id: "c1", type: "function", function: { name: "run_snippet", arguments: "{}" } }] },
    { role: "tool", content: "r", tool_call_id: "c1" },
  ];

  test("a request that is [system, ...window, user] is written slim", () => {
    const messages: ChatMessage[] = [{ role: "system", content: system }, ...history, { role: "user", content: "u" }];
    const { record, mismatch } = fixedLoopRequestRecord({ turn: 2, adapter: "a", messages, history, from: 0, withSystemText: false });
    expect(mismatch).toBeNull();
    expect(isSlimRequest(record)).toBe(true);
    expect(record["requestHash"]).toBe(requestHash(messages));
    expect(record["window"]).toEqual({ from: 0, to: 2, fromTurn: 1, cap: 4_000 });
    expect("systemText" in record).toBe(false);
  });

  test("one the rebuild would not reproduce keeps its whole message array, and replays around it", () => {
    // Something the rebuild does not know about went into the request.
    const odd: ChatMessage[] = [
      { role: "system", content: system },
      { role: "user", content: "an extra message" },
      ...history,
      { role: "user", content: "u" },
    ];
    const { record, mismatch } = fixedLoopRequestRecord({ turn: 2, adapter: "a", messages: odd, history, from: 0, withSystemText: false });
    expect(mismatch).toContain("does not reproduce");
    expect(isSlimRequest(record)).toBe(false);
    expect(record["messages"]).toEqual(odd);
    expect(record["slimFallback"]).toBe(mismatch);

    // A segment with that record in the middle still replays the requests
    // after it: the fallback keeps the window it would have had.
    const first = fixedLoopRequestRecord({
      turn: 1,
      adapter: "a",
      messages: [{ role: "system", content: system }, { role: "user", content: "u1" }],
      history: [],
      from: 0,
      withSystemText: true,
    }).record;
    const later: ChatMessage[] = [
      ...history,
      { role: "assistant", content: "b", tool_calls: [{ id: "c2", type: "function", function: { name: "reflect", arguments: "{}" } }] },
      { role: "tool", content: "q", tool_call_id: "c2" },
    ];
    const third = fixedLoopRequestRecord({
      turn: 3,
      adapter: "a",
      messages: [{ role: "system", content: system }, ...later, { role: "user", content: "u3" }],
      history: later,
      from: 0,
      withSystemText: false,
    }).record;
    const replayer = new Replayer();
    const feed: Record<string, unknown>[] = [
      first,
      { t: "response", turn: 1, message: history[0] },
      { t: "snippet_result", turn: 1, name: "run_snippet", text: "r" },
      record,
      { t: "response", turn: 2, message: later[2] },
      { t: "tool_result", turn: 2, name: "reflect", text: "q", reflect: true },
      third,
    ];
    const verdicts = feed.map((r, k) => replayer.take(r, k + 1)?.verdict).filter((v) => v !== undefined);
    expect(verdicts.map((v) => v.ok)).toEqual([true, true]);
    expect(replayer.report.full).toBe(1);
  });

  test("a result that does not answer its call is named, not guessed", () => {
    const h = new HistoryRebuilder();
    h.take({ t: "response", turn: 4, message: history[0] });
    h.take({ t: "tool_result", turn: 4, name: "state_summary", text: "r" });
    expect(h.window(0, 2)).toContain('answers call 0 of turn 4, which is "run_snippet"');
  });
});
