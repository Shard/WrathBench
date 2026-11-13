/**
 * A scaffold's thread context (`ThreadContext`, context.ts): on codex, the
 * program loop and the `snippet-slim` arm send a turn's message the events
 * newer than the last one the thread was sent and the pad only when the
 * thread does not hold it (D8), and send both whole after the thread lost
 * them. The released snippet loop's messages, prompt and tools are its own,
 * untouched. Against fakes: the fake codex CLI and a scripted sandbox.
 */
import { describe, expect, test } from "bun:test";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PROGRAM_EDIT_SCRATCHPAD_NOT_FOUND, Scratchpad, type EventSummary } from "@wrathbench/mcp";
import { runCodexEpisode } from "../src/adapter-codex";
import { campaignPairRefusals, type PairRosterEntry } from "../src/campaigns";
import { comparabilityOf, promptHash } from "../src/comparability";
import { loadRunConfig, programLoopRefusal, threadContextOf } from "../src/config";
import { assembleContext, EVENTS_RESENT_NOTE, EventsSeen, eventsNewHeader, eventsPart, formatEventLine, ThreadContext } from "../src/context";
import { EpisodicLog } from "../src/episodic";
import { buildSystemPrompt, snippetSlimPromptOf } from "../src/prompt";
import { configFromArgs } from "../src/run";
import type { SandboxHost, SnippetResult } from "../src/sandbox/host";
import { callTool, TOOLS, toolsFor } from "../src/tools";
import { readTrajectory, Trajectory } from "../src/trajectory";
import { Watchdogs } from "../src/watchdogs";
import { eventsForm, messageParts } from "../../infra/inspect-run";
import { tempDirs } from "./fixtures/temp-dirs";

const tempDir = tempDirs();

const T0 = Date.UTC(2030, 0, 2, 12, 0, 0);

/** The n-th chat event, seq n. */
function ev(n: number, o: Partial<EventSummary> = {}): EventSummary {
  return { seq: n, ts: T0 + n * 1000, opcode: "SMSG_MESSAGECHAT", data: { text: `line ${n}` }, ...o } as EventSummary;
}
const evs = (from: number, to: number): EventSummary[] => Array.from({ length: to - from + 1 }, (_, i) => ev(from + i));

/** One message's event part, as the thread context renders it, and what the thread then holds. */
function send(seen: EventsSeen, events: EventSummary[]): string {
  const part = eventsPart(events, 0, seen.held());
  seen.carried(part.shown);
  return part.text;
}

describe("the event delta, as a pure rule", () => {
  test("consecutive messages carry only what is new; none new says so", () => {
    const seen = new EventsSeen();
    expect(send(seen, evs(1, 3))).toBe(`[events: last 3, newest last]\n${evs(1, 3).map(formatEventLine).join("\n")}`);
    expect(send(seen, evs(1, 5))).toBe(`${eventsNewHeader(2)}\n${evs(4, 5).map(formatEventLine).join("\n")}`);
    expect(send(seen, evs(1, 5))).toBe("[events: none new since your last message; earlier ones are above in this conversation]");
    expect(send(seen, evs(1, 6))).toBe("[events: 1 new since your last message; earlier ones are above in this conversation]\n" + formatEventLine(ev(6)));
  });

  test("more new than the window holds is the plain window: some never reached the thread", () => {
    const seen = new EventsSeen();
    send(seen, evs(1, 3));
    const text = send(seen, evs(4, 100));
    expect(text).toStartWith("[events: last 64, newest last]\n");
    expect(send(seen, evs(4, 101))).toStartWith(eventsNewHeader(1));
  });

  test("an event is found by its identity, not its seq: a gap carrying the next seq, and a counter that restarts", () => {
    const seen = new EventsSeen();
    const gap = ev(7, { opcode: "stream_gap", data: {} });
    send(seen, [...evs(1, 6), gap]);
    // The real event at seq 7 follows the gap that carried its seq: it is new.
    expect(send(seen, [...evs(1, 6), gap, ev(7)])).toBe(`${eventsNewHeader(1)}\n${formatEventLine(ev(7))}`);
    // The module recreated the session: seq starts over below what was sent, at later times.
    const restarted = [ev(1, { ts: T0 + 900_000 }), ev(2, { ts: T0 + 901_000 })];
    expect(send(seen, restarted)).toBe(`[events: last 2, newest last]\n${restarted.map(formatEventLine).join("\n")}`);
    expect(send(seen, [...restarted, ev(3, { ts: T0 + 902_000 })])).toStartWith(eventsNewHeader(1));
  });

  test("after the thread lost them the window goes whole, saying so once; a first message and a forgotten one say nothing", () => {
    const seen = new EventsSeen();
    // A thread's first message: nothing to have lost.
    seen.reset();
    expect(send(seen, evs(1, 2))).toStartWith("[events: last 2, newest last]\n");
    seen.reset();
    expect(send(seen, evs(1, 3))).toStartWith(`[events: last 3, newest last, ${EVENTS_RESENT_NOTE}]\n`);
    expect(EVENTS_RESENT_NOTE).toBe("sent in full again: this conversation no longer holds the earlier ones");
    expect(send(seen, evs(1, 4))).toStartWith(eventsNewHeader(1));
    seen.forget();
    expect(send(seen, evs(1, 5))).toStartWith("[events: last 5, newest last]\n");
  });

  test("a message with no thread context renders the window as it always has", () => {
    const inputs = { stateSummary: "== state ==", events: evs(1, 2), folded: 3, scratchpad: "x", notices: [], turn: 2 };
    expect(assembleContext(inputs)).toContain(`[events: last 2, newest last; 3 ambient movement and party-frame events folded into state only]\n${formatEventLine(ev(1))}`);
    // Under the rule the new part has no ambient count: it spans the whole window.
    expect(assembleContext({ ...inputs, eventsHeld: { kind: "through", last: `${ev(1).seq}:${ev(1).ts}:${ev(1).opcode}` } })).toContain(`\n\n${eventsNewHeader(1)}\n${formatEventLine(ev(2))}\n\n[scratchpad`);
  });

  test("one reset reaches the pad and the events alike", () => {
    const t = new ThreadContext();
    expect(t.pad.sendWhole("# plan")).toBe(true);
    t.events.carried(evs(1, 2));
    expect(t.pad.sendWhole("# plan")).toBe(false);
    t.reset();
    expect(t.pad.sendWhole("# plan")).toBe(true);
    expect(t.events.held()).toEqual({ kind: "lost" });
  });
});

// ------------------------------------------------------------ the codex driver

/** A sandbox whose window grows by the script: `counts[i]` events at its i-th window, then the last count. */
function scriptedSandbox(counts: number[]): SandboxHost {
  let calls = 0;
  return {
    evalSnippet: (code: string): Promise<SnippetResult> => Promise.resolve({ ok: true, value: `ran:${code}`, logs: [], durationMs: 1 }),
    recentEvents: () => Promise.resolve([]),
    contextEvents: () => Promise.resolve({ events: evs(1, counts[Math.min(calls++, counts.length - 1)]!), folded: 0 }),
    stateSnapshot: () => Promise.resolve({ self: {}, lastSeq: -1, eventCount: 0 }),
    totalRestarts: 0,
    consecutiveRestarts: 0,
    drainNotices: () => [],
    stop: () => Promise.resolve(),
  } as unknown as SandboxHost;
}

function fakeBinDir(): string {
  const dir = tempDir("wrathbench-thread-bin-");
  writeFileSync(join(dir, "codex"), `#!/bin/sh\nexec ${process.execPath} ${join(import.meta.dir, "fixtures", "fake-codex.ts")} "$@"\n`, "utf8");
  chmodSync(join(dir, "codex"), 0o755);
  return dir;
}

function fakeCodexHome(): string {
  const dir = tempDir("wrathbench-thread-home-");
  writeFileSync(join(dir, "auth.json"), '{"auth_mode":"chatgpt","tokens":{"access_token":"fake"}}\n', "utf8");
  return dir;
}

const THREAD = "01a119da-ef89-7a63-ac51-314ac6a70a61";

interface CodexRun {
  loop?: "snippet-slim";
  counts: number[];
  turns: number;
  /** `WB_FAKE_ROLLOUT`'s entries; absent writes none, so every read fails. */
  rollout?: unknown[] | null;
  calls?: unknown[][];
  mode?: string;
  runDir?: string;
}

/** A codex episode over the scripted sandbox and the fake CLI: the messages it sent, the CLI's record, the trajectory. */
async function codexRun(o: CodexRun) {
  const runDir = o.runDir ?? tempDir("wrathbench-thread-run-");
  const record = join(runDir, `fake-${Date.now()}-${Math.random()}.json`);
  const config = {
    ...loadRunConfig({
      driver: "codex",
      model: "gpt-5.5",
      runsDir: tempDir("wrathbench-thread-runs-"),
      stepIntervalMs: 0,
      stateIntervalMs: 1,
      credential: "chatgpt-1",
      usageMaxPct: { scored: 80, freeplay: 80 },
      episode: "probing",
      maxTurns: o.turns,
      ...(o.loop !== undefined ? { loop: o.loop } : {}),
    }),
    runId: "run-thread",
    token: "run-thread",
  };
  const trajectory = new Trajectory(runDir);
  trajectory.writeMeta({ runId: config.runId, harnessVersion: "t", startedAt: Date.now(), config });
  const rollout = o.rollout === null ? undefined : (o.rollout ?? Array.from({ length: o.turns }, (_, i) => ({ total: 10_000 * (i + 1) })));
  await runCodexEpisode({
    config: config as typeof config & { runId: string; token: string },
    runDir,
    sandbox: scriptedSandbox(o.counts),
    scratchpad: new Scratchpad(join(runDir, "scratchpad.md")),
    episodic: new EpisodicLog(join(runDir, "episodic.jsonl")),
    trajectory,
    watchdogs: new Watchdogs(config.watchdogs),
    sleep: () => Promise.resolve(),
    env: { PATH: `${fakeBinDir()}:${process.env["PATH"] ?? ""}`, HOME: process.env["HOME"] ?? "/tmp", CODEX_HOME: fakeCodexHome() },
    extraEnv: {
      WB_FAKE_MODE: o.mode ?? "tools",
      WB_FAKE_RECORD: record,
      WB_FAKE_THREAD_ID: THREAD,
      ...(rollout !== undefined ? { WB_FAKE_ROLLOUT: JSON.stringify(rollout) } : {}),
      ...(o.calls !== undefined ? { WB_FAKE_CALLS: JSON.stringify(o.calls) } : {}),
    },
  });
  trajectory.close();
  const rec = JSON.parse(readFileSync(record, "utf8")) as Record<string, unknown>;
  return { runDir, rec, messages: rec["userMessages"] as string[], records: readTrajectory(runDir) };
}

const eventsOf = (message: string): string => messageParts(message).events;

describe("the snippet-slim arm on the codex driver, through the fake CLI", () => {
  test("consecutive turns carry the window, then only the new events, then none new; the record logs what was shown", async () => {
    const r = await codexRun({ loop: "snippet-slim", counts: [3, 5, 5, 6], turns: 4 });
    expect(r.messages.map(eventsOf)).toEqual([
      `[events: last 3, newest last]\n${evs(1, 3).map(formatEventLine).join("\n")}`,
      `${eventsNewHeader(2)}\n${evs(4, 5).map(formatEventLine).join("\n")}`,
      eventsNewHeader(0),
      `${eventsNewHeader(1)}\n${formatEventLine(ev(6))}`,
    ]);
    const served = r.records.filter((x) => x.t === "events_served" && x["via"] === "context");
    expect(served.map((x) => [x["count"], x["mode"] ?? "window"])).toEqual([
      [3, "window"],
      [2, "new"],
      [0, "new"],
      [1, "new"],
    ]);
    expect(r.messages.map((m) => eventsForm(eventsOf(m)))).toEqual(["window", "new", "new", "new"]);
  }, 30_000);

  test("a compaction resets the window and the pad to whole, saying so for the events; the turn after is a delta again", async () => {
    const r = await codexRun({
      loop: "snippet-slim",
      counts: [3, 4, 5, 6],
      turns: 4,
      calls: [[{ name: "write_scratchpad", arguments: { content: "# plan\nGoldshire" } }], [], [], []],
      rollout: [{ total: 100_000 }, { total: 60_000, compact: { pre: 440_000, post: 50_000 } }, { total: 70_000 }, { total: 80_000 }],
    });
    expect(r.messages[1]).toEndWith("[scratchpad 0.0k/32k: unchanged since you last saw it in this conversation, so not repeated]");
    expect(eventsOf(r.messages[1]!)).toStartWith(eventsNewHeader(1));
    // Turn 2 compacted: turn 3 sends both whole.
    expect(eventsOf(r.messages[2]!)).toBe(`[events: last 5, newest last, ${EVENTS_RESENT_NOTE}]\n${evs(1, 5).map(formatEventLine).join("\n")}`);
    expect(r.messages[2]).toEndWith("[scratchpad 0.0k/32k]\n# plan\nGoldshire");
    expect(eventsOf(r.messages[3]!)).toBe(`${eventsNewHeader(1)}\n${formatEventLine(ev(6))}`);
    expect(r.messages[3]).toContain("so not repeated]");
  }, 30_000);

  test("after the CLI moved to another thread the next message sends the window whole, saying so", async () => {
    const r = await codexRun({ loop: "snippet-slim", counts: [3, 4, 5, 6], turns: 4, mode: "new-thread", rollout: [{ total: 1 }, { total: 2 }, { total: 3 }, { total: 4 }] });
    // Every turn starts a thread of its own. The driver learns it only once the
    // turn's message is on its way (the CLI names its thread as the turn
    // starts), so that message is the delta it meant for the old thread, as
    // D8's pad line is; the message after it is whole.
    expect(eventsOf(r.messages[1]!)).toStartWith(eventsNewHeader(1));
    expect(eventsOf(r.messages[2]!)).toStartWith(`[events: last 5, newest last, ${EVENTS_RESENT_NOTE}]\n`);
    expect(eventsOf(r.messages[3]!)).toStartWith(`[events: last 6, newest last, ${EVENTS_RESENT_NOTE}]\n`);
  }, 30_000);

  test("a resumed run's first message is the plain window: its thread is new, and nothing was lost from it", async () => {
    const first = await codexRun({ loop: "snippet-slim", counts: [3, 4], turns: 2 });
    expect(eventsOf(first.messages[1]!)).toStartWith(eventsNewHeader(1));
    const resumed = await codexRun({ loop: "snippet-slim", counts: [6, 7], turns: 2, runDir: first.runDir });
    expect(eventsOf(resumed.messages[0]!)).toBe(`[events: last 6, newest last]\n${evs(1, 6).map(formatEventLine).join("\n")}`);
    expect(eventsOf(resumed.messages[1]!)).toStartWith(eventsNewHeader(1));
  }, 30_000);

  test("a turn whose rollout cannot be read sends the next window plainly and whole: a compaction may have gone unseen", async () => {
    const r = await codexRun({ loop: "snippet-slim", counts: [3, 4, 5], turns: 3, rollout: null });
    expect(r.messages.map((m) => eventsForm(eventsOf(m)))).toEqual(["window", "window", "window"]);
    expect(r.messages.every((m) => !m.includes(EVENTS_RESENT_NOTE))).toBe(true);
  }, 30_000);

  test("the arm's prompt says the pad may be a line or earlier, its tools are the snippet loop's, and its pad miss says where the pad may be", async () => {
    const r = await codexRun({ loop: "snippet-slim", counts: [1], turns: 1 });
    const snippet = buildSystemPrompt(undefined, "probing", "codex", true, 5_400_000);
    const delta = String(r.rec["instructions"]);
    expect(delta).toBe(buildSystemPrompt(undefined, "probing", "codex", true, 5_400_000, undefined, true));
    // Exactly the program arms' two pad sentences, and nothing else.
    expect(
      delta
        .replace(
          "There is no read tool: the scratchpad as last written is in this turn's context or earlier in this conversation,",
          "There is no read tool: every turn's context already carries the scratchpad as last written,",
        )
        .replace("and your scratchpad, or a line saying it is unchanged since you last saw it in this conversation.", "and your scratchpad."),
    ).toBe(snippet);
    expect(delta).not.toContain("[wake]");
    const served = (r.rec["mcpToolsLists"] as { tools: unknown[] }[])[0]!.tools;
    expect(served).toEqual(toolsFor({ wikiCoords: false, wikiSearch: true }).map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })) as never);
    const dir = tempDir("wrathbench-thread-pad-");
    const ctx = (threadContext: boolean) =>
      ({ sandbox: {}, scratchpad: new Scratchpad(join(dir, "pad.md")), sessionLive: () => true, turn: () => 1, secrets: { scrub: (t: string) => t }, ...(threadContext ? { threadContext: true } : {}) }) as never;
    const miss = { old: "absent", new: "x" };
    expect((await callTool(ctx(true), "edit_scratchpad", miss)).text).toBe(PROGRAM_EDIT_SCRATCHPAD_NOT_FOUND);
    expect((await callTool(ctx(false), "edit_scratchpad", miss)).text).toEndWith("The scratchpad as last written is in this turn's context.");
  }, 30_000);

  test("the released snippet loop on codex is untouched: every turn the whole window and the whole pad", async () => {
    const r = await codexRun({ counts: [3, 5, 5], turns: 3, calls: [[{ name: "write_scratchpad", arguments: { content: "# plan" } }], [], []] });
    expect(r.messages.map(eventsOf)).toEqual([3, 5, 5].map((n) => `[events: last ${n}, newest last]\n${evs(1, n).map(formatEventLine).join("\n")}`));
    expect(r.messages.slice(1).every((m) => m.endsWith("[scratchpad 0.0k/32k]\n# plan"))).toBe(true);
    expect(String(r.rec["instructions"])).toBe(buildSystemPrompt(undefined, "probing", "codex", true, 5_400_000));
    expect(r.records.some((x) => x.t === "events_served" && "mode" in x)).toBe(false);
  }, 30_000);
});

describe("--loop snippet-slim: config, tuple and refusals", () => {
  const CODEX = ["--driver", "codex", "--model", "gpt-5.5", "--credential", "chatgpt-1", "--run-id", "r1", "--token", "tok-aaaaaaaaaaaaaaaaaaaaaa", "--module-url", "http://x"];

  test("a config and tuple key of its own, absent on the snippet loop, with its own prompt hash", () => {
    const snippet = configFromArgs(CODEX, {});
    const slim = configFromArgs([...CODEX, "--loop", "snippet-slim"], {});
    expect(slim.loop).toBe("snippet-slim");
    expect(snippetSlimPromptOf(slim)).toBe(true);
    expect(snippetSlimPromptOf(snippet)).toBe(false);
    const tSnippet = comparabilityOf(snippet, "harness-1.0-1-gabc");
    const tSlim = comparabilityOf(slim, "harness-1.0-1-gabc");
    expect("loop" in tSnippet).toBe(false);
    expect(tSlim.loop).toBe("snippet-slim");
    expect(tSlim.context).toBe("slim");
    expect("context" in tSnippet).toBe(false);
    expect(Object.keys(tSlim).slice(-2)).toEqual(["loop", "context"]);
    // The program loop on codex sends the same context; on the fixed loop the full one.
    const program = configFromArgs([...CODEX, "--loop", "program"], {});
    expect(comparabilityOf(program, "harness-1.0-1-gabc")).toMatchObject({ loop: "program", context: "slim" });
    const fixed = configFromArgs(["--driver", "stub", "--run-id", "r1", "--token", "tok-aaaaaaaaaaaaaaaaaaaaaa", "--module-url", "http://x", "--loop", "program"], {});
    expect("context" in comparabilityOf(fixed, "harness-1.0-1-gabc")).toBe(false);
    expect(tSlim.promptHash).not.toBe(tSnippet.promptHash);
    expect(tSnippet.promptHash).toBe(promptHash(buildSystemPrompt(undefined, undefined, "codex", true, snippet.watchdogs.episodeMs)));
    expect(loadRunConfig(JSON.parse(JSON.stringify(slim))).loop).toBe("snippet-slim");
    expect(threadContextOf(slim)).toBe(true);
    expect(threadContextOf(snippet)).toBe(false);
    expect(threadContextOf({ loop: "program", driver: "codex" })).toBe(true);
    expect(threadContextOf({ loop: "program", driver: "openai" })).toBe(false);
  });

  test("codex only, never scored, never fan-out, and --yield is still the program loop's", () => {
    expect(programLoopRefusal({ loop: "snippet-slim", driver: "codex", episode: "probing" })).toBeNull();
    expect(programLoopRefusal({ loop: "snippet-slim", driver: "openai", episode: "probing" })).toContain("rebuilds its window every turn");
    expect(programLoopRefusal({ loop: "snippet-slim", driver: "stub" })).toContain("rebuilds its window every turn");
    expect(programLoopRefusal({ loop: "snippet-slim", driver: "claude-code" })).toContain("a turn that runs for hours");
    expect(programLoopRefusal({ loop: "snippet-slim", driver: "pi" })).toContain("a turn that runs for hours");
    expect(programLoopRefusal({ loop: "snippet-slim", driver: "codex", episode: "e90" })).toContain("is a scored episode");
    expect(programLoopRefusal({ loop: "snippet-slim", driver: "codex", fanout: { maxCharacters: 2 } as never })).toContain("fan-out");
    expect(programLoopRefusal({ loop: "snippet-slim", yield: true, driver: "codex" })).toContain("needs --loop program");
  });

  test("a campaign pair refuses it off codex", () => {
    const roster: Record<string, PairRosterEntry> = { ds: { driver: "openai" }, cc: { driver: "claude-code" }, cx: { driver: "codex" }, pi: { driver: "pi" } };
    const arms = [{ id: "snippet" }, { id: "snippet-slim", args: ["--loop", "snippet-slim"] }, { id: "program", args: ["--loop", "program"] }];
    const c = { name: "program-probe", version: 4, arms, assignments: ["ds", "cc", "cx", "pi"].map((model) => ({ model, runsPerCell: 1 })) };
    const out = campaignPairRefusals(c, roster).map((r) => `${r.ref}:${r.arm}`);
    expect(out.sort()).toEqual(["cc:program", "cc:snippet-slim", "ds:snippet-slim", "pi:program", "pi:snippet-slim"]);
  });

  test("the released snippet tool list is the one it always was", () => {
    expect(toolsFor({})).toEqual(TOOLS);
  });
});
