/**
 * Wake-on-event (`runner/src/wake.ts`), the probe arm's harness change.
 *
 * Four things are pinned here:
 *
 * - **Off is master.** With both options off the prompt hashes as master's
 *   did (the literals below were computed from master's `prompt.ts`), the
 *   stored config and the tuple carry no field, the CLI flags and the child's
 *   environment are what they were, and the loop sleeps the fixed step.
 * - **The turn-end wait** fires on every mandatory wake and on the cap; an
 *   `attacked` does not wake it unless asked; every wait writes its record and
 *   the next message says what fired.
 * - **The in-snippet wait** holds a snippet past its limit, against the real
 *   sandbox child, wakes on what it was given and on the mandatory wakes, and
 *   writes its record.
 * - **The arms do not pool**: three arms of `wake-probe@1` on one image, under
 *   one harness version with no series, are three columns and three tuples.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { StubAdapter } from "../src/adapter";
import { codexArgs } from "../src/adapter-codex";
import { parseCampaignBlocks } from "../src/campaigns";
import { comparabilityOf, promptHash, sameComparability } from "../src/comparability";
import { loadRunConfig, type Harness } from "../src/config";
import type { EpisodeId } from "../src/episodes";
import { EpisodicLog } from "../src/episodic";
import { runLoop } from "../src/loop";
import { CLAUDE_CODE_SYSTEM_PROMPT, CODEX_SYSTEM_PROMPT, SYSTEM_PROMPT, buildSystemPrompt } from "../src/prompt";
import { configFromArgs } from "../src/run";
import { ARM_RESERVED_FLAGS, RUN_FLAGS, parseRunArgs } from "../src/run-flags";
import { SandboxHost, type SnippetResult } from "../src/sandbox/host";
import { Scratchpad } from "../src/scratchpad";
import { Trajectory, readTrajectory } from "../src/trajectory";
import { Watchdogs } from "../src/watchdogs";
import {
  MANDATORY_WAKES,
  TURN_END_OPTIONAL_WAKES,
  WAIT_BULLET,
  WAKE_CAP_MS,
  codexToolTimeoutSec,
  turnEndSentence,
  waitForTurnEndWake,
  wakeCursor,
  wakeEnv,
  wakeOptionsOf,
  wakeWords,
  wokeNotice,
  type OptionalWake,
  type WakeFact,
  type WakeFactKey,
  type WakeRecord,
  type WakeSource,
} from "../src/wake";
import type { CampaignsRoster } from "../viewer/campaigns";
import { campaignsView } from "../viewer/campaigns";
import type { ResultRun } from "../viewer/api-types";
import { checkedIn, defsBlock } from "./fixtures/campaigns";
import { tempDirs } from "./fixtures/temp-dirs";

const tempDir = tempDirs();
const MODEL = ["--driver", "openai", "--model", "deepseek/deepseek-v4.1-flash"];
const OFF = { turnEnd: false, inSnippet: false } as const;
const TURN_END = { turnEnd: true, inSnippet: false } as const;
const BOTH = { turnEnd: true, inSnippet: true } as const;

describe("off is master", () => {
  // Computed from master's prompt.ts before this branch: the prompt every run
  // without the options renders, by harness, tier and wiki.
  const MASTER: { episode?: EpisodeId; harness: Harness; wiki: boolean; hash: string; chars?: number }[] = [
    { harness: "wrathbench", wiki: true, hash: "sha256:c97877408a428fc0", chars: 19_171 },
    { harness: "claude-code", wiki: true, hash: "sha256:8d3dab50f9cd0fe4" },
    { harness: "codex", wiki: true, hash: "sha256:8d3dab50f9cd0fe4" },
    { episode: "e90", harness: "wrathbench", wiki: true, hash: "sha256:d15c6917ac78750a" },
    { episode: "probing", harness: "claude-code", wiki: false, hash: "sha256:0754bad6bcc70931" },
  ];

  test("the prompt hashes as master's did, with the options absent or both off", () => {
    for (const m of MASTER) {
      for (const wake of [undefined, OFF]) {
        const p = buildSystemPrompt(undefined, m.episode, m.harness, m.wiki, wake);
        expect(promptHash(p)).toBe(m.hash);
        if (m.chars !== undefined) expect(p.length).toBe(m.chars);
      }
    }
    expect(buildSystemPrompt()).toBe(SYSTEM_PROMPT);
    expect(buildSystemPrompt(undefined, undefined, "claude-code", true, OFF)).toBe(CLAUDE_CODE_SYSTEM_PROMPT);
    expect(buildSystemPrompt(undefined, undefined, "codex", true, OFF)).toBe(CODEX_SYSTEM_PROMPT);
  });

  test("the turn-end sentence is the operator's, and names every wake the wait fires on", () => {
    expect(turnEndSentence()).toBe(
      "A reply without a tool call ends your turn and you sleep until something wakes you — your character dying, a level gained, a quest's objectives completed, the event stream closing, a sandbox restart or a harness notice — or five minutes pass; the next turn says which and how long you slept.",
    );
    for (const k of [...MANDATORY_WAKES, ...TURN_END_OPTIONAL_WAKES]) expect(turnEndSentence()).toContain(wakeWords(k));
    expect(turnEndSentence()).not.toContain(wakeWords("attacked"));
  });

  test("each option is one insertion into master's prompt and nothing else", () => {
    for (const harness of ["wrathbench", "claude-code", "codex"] as const) {
      const off = buildSystemPrompt(undefined, "probing", harness);
      const turnEnd = buildSystemPrompt(undefined, "probing", harness, true, TURN_END);
      expect(turnEnd).toBe(`${off} ${turnEndSentence()}`);
      const inSnippet = buildSystemPrompt(undefined, "probing", harness, true, { turnEnd: false, inSnippet: true });
      expect(inSnippet).not.toBe(off);
      expect(inSnippet.replace(`\n${WAIT_BULLET}`, "")).toBe(off);
      expect(buildSystemPrompt(undefined, "probing", harness, true, BOTH)).toBe(`${inSnippet} ${turnEndSentence()}`);
    }
  });

  test("the stored config and the tuple carry no wake field with both off", () => {
    const plain = configFromArgs([...MODEL, "--run-id", "x", "--token", "t".repeat(32)], {});
    expect("wake" in plain).toBe(false);
    expect("wake" in loadRunConfig({})).toBe(false);
    const explicitOff = configFromArgs([...MODEL, "--run-id", "x", "--token", "t".repeat(32), "--wake-turn-end", "false", "--wake-in-snippet", "false"], {});
    expect(JSON.stringify(explicitOff)).toBe(JSON.stringify(plain));
    const tuple = comparabilityOf(plain, "harness-0.5-1-gabc", null, null);
    expect("wake" in tuple).toBe(false);
    expect(tuple.promptHash).toBe("sha256:c97877408a428fc0");
  });

  test("the CLI drivers' flags and env are master's with both off", () => {
    const base = { instructionsPath: "/i", bunBin: "/b", bridgePath: "/p", mcpPort: 1 };
    expect(codexArgs(base)).toContain("mcp_servers.wrathbench.tool_timeout_sec=300");
    expect(codexToolTimeoutSec(undefined)).toBe(300);
    expect(codexToolTimeoutSec(TURN_END)).toBe(300);
    expect(wakeEnv(undefined)).toEqual({});
    expect(wakeEnv(TURN_END)).toEqual({});
    // The in-snippet wait raises both, past the longest call it can hold.
    expect(codexToolTimeoutSec(BOTH) * 1000).toBeGreaterThan(WAKE_CAP_MS + 30_000);
    expect(Number(wakeEnv(BOTH)["MCP_TOOL_TIMEOUT"])).toBeGreaterThan(WAKE_CAP_MS + 30_000);
  });

  test("the loop sleeps the fixed step after every turn and writes no wake record", async () => {
    const { dir, options, sleeps } = loopSetup({}, [{ content: "idle", toolCalls: [] }, { content: "act", toolCalls: [{ name: "run_snippet", arguments: { code: "1" } }] }]);
    await runLoop(options);
    expect(sleeps).toEqual([3_000, 3_000]);
    const records = readTrajectory(dir);
    expect(records.filter((r) => r.t === "wake")).toEqual([]);
    expect(records.filter((r) => r.t === "request").map((r) => String(r["user"])).join("\n")).not.toContain("woke:");
    options.trajectory.close();
  });
});

describe("the options, as an arm sets them", () => {
  test("two run.ts flags, which an arm may set and the supervisor never does", () => {
    for (const f of ["wake-turn-end", "wake-in-snippet"]) {
      expect(RUN_FLAGS as readonly string[]).toContain(f);
      expect(ARM_RESERVED_FLAGS).not.toContain(f);
    }
    expect(wakeOptionsOf(parseRunArgs(["--wake-turn-end", "true"]))).toEqual(TURN_END);
    expect(wakeOptionsOf(parseRunArgs(["--wake-turn-end", "true", "--wake-in-snippet", "true"]))).toEqual(BOTH);
    expect(wakeOptionsOf(parseRunArgs([]))).toBeNull();
    expect(() => wakeOptionsOf(parseRunArgs(["--wake-turn-end", "yes please"]))).toThrow(/true or false/);
  });

  test("on, the config and the tuple say so, last, and the prompt hash moves", () => {
    const c = configFromArgs([...MODEL, "--run-id", "x", "--token", "t".repeat(32), "--wake-turn-end", "true"], {});
    expect(c.wake).toEqual(TURN_END);
    const tuple = comparabilityOf(c, "harness-0.5-1-gabc", null, null);
    expect(tuple.wake).toEqual(TURN_END);
    expect(Object.keys(tuple).at(-1)).toBe("wake");
    expect(tuple.promptHash).not.toBe("sha256:c97877408a428fc0");
  });

  test("a scored episode refuses the options", () => {
    expect(() => configFromArgs([...MODEL, "--episode", "e90", "--wake-turn-end", "true"], {})).toThrow(/probe-campaign arm's option/);
    expect(() => configFromArgs([...MODEL, "--episode", "e360", "--wake-in-snippet", "true"], {})).toThrow(/scored/);
  });
});

/** A wake source the test drives: facts, notices and restarts as a host would count them. */
class FakeSource implements WakeSource {
  private readonly facts: WakeFact[] = [];
  noticesRaised = 0;
  totalRestarts = 0;
  get wakeFactSeq(): number {
    return this.facts.length;
  }
  wakeFactsAfter(seq: number): readonly WakeFact[] {
    return this.facts.filter((f) => f.seq > seq);
  }
  push(key: WakeFactKey, detail?: string): void {
    this.facts.push({ seq: this.facts.length + 1, key, ts: 0, ...(detail !== undefined ? { detail } : {}) });
  }
}

/** A fake clock whose sleep advances it, running `at` hooks as their time passes. */
function clock(start = 1_000_000): { now: () => number; sleep: (ms: number) => Promise<void>; at: (ms: number, fn: () => void) => void } {
  let t = start;
  const hooks: { at: number; fn: () => void }[] = [];
  return {
    now: () => t,
    sleep: async (ms) => {
      t += ms;
      for (const h of hooks.filter((h) => h.at <= t)) {
        hooks.splice(hooks.indexOf(h), 1);
        h.fn();
      }
    },
    at: (ms, fn) => hooks.push({ at: start + ms, fn }),
  };
}

function wait(o: { source: FakeSource; keys?: readonly OptionalWake[]; queued?: () => number; stopped?: () => boolean; c?: ReturnType<typeof clock> }) {
  const c = o.c ?? clock();
  return {
    c,
    run: () =>
      waitForTurnEndWake({
        source: o.source,
        cursor: wakeCursor(o.source),
        keys: o.keys ?? TURN_END_OPTIONAL_WAKES,
        queuedNotices: o.queued ?? (() => 0),
        stopped: o.stopped ?? (() => false),
        minMs: 3_000,
        now: c.now,
        sleep: c.sleep,
      }),
  };
}

describe("the turn-end wait", () => {
  test("with nothing happening it sleeps the full five minutes, and says so", async () => {
    const w = await wait({ source: new FakeSource() }).run();
    expect(w).toEqual({ fired: "cap", sleptMs: WAKE_CAP_MS });
    expect(wokeNotice(w, 0)?.text).toContain("nothing woke you before the five-minute limit");
  });

  test("each mandatory wake ends it, whatever the keys", async () => {
    const fire: Record<(typeof MANDATORY_WAKES)[number], (s: FakeSource) => void> = {
      died: (s) => s.push("died"),
      streamClosed: (s) => s.push("streamClosed"),
      sandboxRestart: (s) => s.totalRestarts++,
      notice: (s) => s.noticesRaised++,
    };
    for (const key of MANDATORY_WAKES) {
      const source = new FakeSource();
      const w = wait({ source, keys: [] });
      w.c.at(42_000, () => fire[key](source));
      const r = await w.run();
      expect(r).toEqual({ fired: key, sleptMs: 42_000 });
      expect(wokeNotice(r, 0)?.text).toMatch(/^you slept 42s after ending your turn without a tool call; woken by /);
    }
  });

  test("a notice the driver queued itself wakes it too", async () => {
    const queue: unknown[] = [];
    const w = wait({ source: new FakeSource(), queued: () => queue.length });
    w.c.at(10_000, () => queue.push("provider_truncated"));
    expect((await w.run()).fired).toBe("notice");
  });

  test("an attack does not wake it unless asked", async () => {
    const source = new FakeSource();
    const w = wait({ source });
    w.c.at(5_000, () => source.push("attacked"));
    expect(TURN_END_OPTIONAL_WAKES).not.toContain("attacked");
    expect((await w.run()).fired).toBe("cap");

    const asked = new FakeSource();
    const v = wait({ source: asked, keys: ["attacked"] });
    v.c.at(5_000, () => asked.push("attacked"));
    expect(await v.run()).toEqual({ fired: "attacked", sleptMs: 5_000 });
  });

  test("a level and a quest's objectives wake it in the harness's set, with what they were", async () => {
    for (const [key, detail] of [["levelUp", "level 5"], ["questComplete", "Kobold Camp Cleanup"]] as const) {
      const source = new FakeSource();
      const w = wait({ source });
      w.c.at(61_000, () => source.push(key, detail));
      const r = await w.run();
      expect(r).toEqual({ fired: key, sleptMs: 61_000, detail });
      expect(wokeNotice(r, 0)?.text).toContain(`(${detail})`);
    }
    // ...and not with an empty set.
    const source = new FakeSource();
    const w = wait({ source, keys: [] });
    w.c.at(1_000, () => source.push("levelUp", "level 2"));
    expect((await w.run()).fired).toBe("cap");
  });

  test("a wake from before the request is old news; one during the reply wakes it at the step", async () => {
    const source = new FakeSource();
    source.push("died");
    source.noticesRaised = 3;
    expect((await wait({ source }).run()).fired).toBe("cap");

    const during = new FakeSource();
    const cursor = wakeCursor(during);
    during.push("levelUp", "level 3");
    const c = clock();
    const r = await waitForTurnEndWake({ source: during, cursor, keys: TURN_END_OPTIONAL_WAKES, queuedNotices: () => 0, stopped: () => false, minMs: 3_000, now: c.now, sleep: c.sleep });
    expect(r).toEqual({ fired: "levelUp", sleptMs: 3_000, detail: "level 3" });
  });

  test("a mandatory wake outranks an optional one pending beside it", async () => {
    const source = new FakeSource();
    const w = wait({ source });
    w.c.at(7_000, () => {
      source.push("levelUp", "level 4");
      source.push("died");
    });
    expect((await w.run()).fired).toBe("died");
  });

  test("a run that is ending stops it, and says nothing to a model with no next turn", async () => {
    let stop = false;
    const w = wait({ source: new FakeSource(), stopped: () => stop });
    w.c.at(20_000, () => (stop = true));
    const r = await w.run();
    expect(r).toEqual({ fired: "stopped", sleptMs: 20_000 });
    expect(wokeNotice(r, 0)).toBeNull();
  });
});

/** A fake sandbox that is also a wake source, for the loop. */
function wakeSandbox(source: FakeSource): SandboxHost {
  const fake = {
    evalSnippet: (code: string): Promise<SnippetResult> => Promise.resolve({ ok: true, value: `ran:${code}`, logs: [], durationMs: 1 }),
    recentEvents: () => Promise.resolve([]),
    stateSnapshot: () => Promise.resolve({ self: {}, lastSeq: -1, eventCount: 0 }),
    get totalRestarts() {
      return source.totalRestarts;
    },
    consecutiveRestarts: 0,
    drainNotices: () => [],
    get noticesRaised() {
      return source.noticesRaised;
    },
    get wakeFactSeq() {
      return source.wakeFactSeq;
    },
    wakeFactsAfter: (seq: number) => source.wakeFactsAfter(seq),
    stop: () => Promise.resolve(),
  };
  return fake as unknown as SandboxHost;
}

function loopSetup(extra: Record<string, unknown>, turns: ConstructorParameters<typeof StubAdapter>[0], source = new FakeSource(), c = clock()) {
  const dir = tempDir("wrathbench-wake-loop-");
  const config = { ...loadRunConfig({ driver: "stub", stepIntervalMs: 3_000, stateIntervalMs: 1, ...extra }), runId: "run-test", token: "run-test" };
  const trajectory = new Trajectory(dir);
  trajectory.writeMeta({ runId: "run-test", harnessVersion: "t", startedAt: Date.now(), config });
  const sleeps: number[] = [];
  return {
    dir,
    source,
    c,
    sleeps,
    options: {
      config,
      adapter: new StubAdapter(turns),
      sandbox: wakeSandbox(source),
      scratchpad: new Scratchpad(join(dir, "scratchpad.md")),
      episodic: new EpisodicLog(join(dir, "episodic.jsonl")),
      trajectory,
      watchdogs: new Watchdogs(config.watchdogs),
      now: c.now,
      sleep: (ms: number) => {
        sleeps.push(ms);
        return c.sleep(ms);
      },
    },
  };
}

describe("the turn-end wait in the fixed loop", () => {
  test("a reply with no tool call sleeps until woken; the record says what fired and the next message says so", async () => {
    const source = new FakeSource();
    const c = clock();
    c.at(95_000, () => source.push("levelUp", "level 2"));
    const { dir, options } = loopSetup(
      { wake: TURN_END, episode: "probing" },
      [
        { content: "my routine is running; waiting", toolCalls: [] },
        { content: "act", toolCalls: [{ name: "run_snippet", arguments: { code: "1" } }] },
      ],
      source,
      c,
    );
    await runLoop(options);
    const records = readTrajectory(dir);
    const wakes = records.filter((r) => r.t === "wake") as unknown as WakeRecord[];
    // One wait: after the reply with no tool call. The turn with a call sleeps the step.
    expect(wakes).toHaveLength(1);
    expect(wakes[0]).toMatchObject({ via: "turn-end", turn: 1, fired: "levelUp", detail: "level 2", maxMs: WAKE_CAP_MS });
    expect(wakes[0]!.sleptMs).toBe(95_000);
    const requests = records.filter((r) => r.t === "request");
    expect(String(requests[1]!["user"])).toContain("woke: you slept 1m 35s after ending your turn without a tool call; woken by a level gained (level 2).");
    expect(String(requests[0]!["user"])).not.toContain("woke:");
    options.trajectory.close();
  });

  test("a watchdog verdict wakes a snippet held in a wait, so the boundary enforces it on time", async () => {
    // The loop reads its watchdogs at the turn boundary; a wait could hold
    // that boundary for minutes past the clock, which the control arm's
    // 30 s snippets never could.
    const source = new FakeSource();
    const dir = tempDir("wrathbench-wake-held-");
    const config = {
      ...loadRunConfig({ driver: "stub", stepIntervalMs: 0, stateIntervalMs: 1, episode: "probing", wake: BOTH, watchdogs: { episodeMs: 300 } }),
      runId: "run-test",
      token: "run-test",
    };
    const trajectory = new Trajectory(dir);
    trajectory.writeMeta({ runId: "run-test", harnessVersion: "t", startedAt: Date.now(), config });
    let release: (() => void) | undefined;
    const sandbox = wakeSandbox(source) as unknown as Record<string, unknown>;
    sandbox["evalSnippet"] = () =>
      new Promise<SnippetResult>((resolve) => {
        release = () => resolve({ ok: true, value: `"stopped"`, logs: [], durationMs: 1 });
      });
    sandbox["wakeWaits"] = () => release?.();
    const started = Date.now();
    const outcome = await runLoop({
      config,
      adapter: new StubAdapter([{ content: "hold", toolCalls: [{ name: "run_snippet", arguments: { code: "await wait({ maxMs: 300000 })" } }] }]),
      sandbox: sandbox as unknown as SandboxHost,
      scratchpad: new Scratchpad(join(dir, "scratchpad.md")),
      episodic: new EpisodicLog(join(dir, "episodic.jsonl")),
      trajectory,
      watchdogs: new Watchdogs(config.watchdogs),
      sleep: () => Promise.resolve(),
      stateTickMs: 50,
    });
    expect(outcome).toMatchObject({ kind: "terminated", reason: "episode-limit" });
    expect(Date.now() - started).toBeLessThan(3_000);
    trajectory.close();
  });

  test("with nothing to wake it the loop sleeps the cap, then carries on", async () => {
    const { dir, options } = loopSetup({ wake: TURN_END, episode: "probing" }, [{ content: "nothing to do", toolCalls: [] }]);
    await runLoop(options);
    const wakes = readTrajectory(dir).filter((r) => r.t === "wake");
    expect(wakes).toEqual([expect.objectContaining({ fired: "cap", sleptMs: WAKE_CAP_MS })]);
    options.trajectory.close();
  });
});

describe("the in-snippet wait, in the real sandbox child", () => {
  const hosts: SandboxHost[] = [];
  afterEach(async () => {
    await Promise.all(hosts.splice(0).map((h) => h.stop()));
  });
  function host(wake: typeof OFF | typeof BOTH | typeof TURN_END | undefined, records: WakeRecord[] = [], snippetTimeoutMs = 500): SandboxHost {
    const dir = tempDir("wrathbench-wake-sbx-");
    const h = new SandboxHost({
      moduleUrl: "http://worldserver:8086",
      token: "test-token",
      scratchpad: new Scratchpad(join(dir, "scratchpad.md")),
      snippetTimeoutMs,
      pingGraceMs: 1_000,
      ...(wake !== undefined ? { wake, onWait: (r) => records.push(r) } : {}),
    });
    hosts.push(h);
    return h;
  }
  const PRELUDE = `
state.seedSelf({ guid: "7", name: "Fenwick" });
globalThis.seq = 1;
globalThis.feed = (opcode, opcodeId, data) => events.ingest(JSON.stringify({ seq: seq++, opcode, opcodeId, ts: Date.now(), data }));
globalThis.selfFields = (fields) => feed("SMSG_UPDATE_OBJECT", 0xa9, { blocks: 1, objects: [{ update: "values", guid: "7", fields }] });
globalThis.attackStart = (victimGuid) => feed("SMSG_ATTACKSTART", 0x143, { attackerGuid: "99", victimGuid });
selfFields({ health: 40, maxHealth: 40, level: 1 });
`;

  test("off, there is no wait, no wake env and the reference is API.md", async () => {
    const h = host(undefined);
    expect((await h.evalSnippet(`[typeof wait, process.env.WRATHBENCH_WAKE ?? "unset", API_MD_PATH.split("/").pop()]`)).value).toBe(
      `[ "undefined", "unset", "API.md" ]`,
    );
    // A child with only the turn-end option reports facts but has no wait either.
    const t = host(TURN_END);
    expect((await t.evalSnippet(`[typeof wait, API_MD_PATH.split("/").pop()]`)).value).toBe(`[ "undefined", "API.md" ]`);
  });

  test("it holds a snippet past its limit, and every wait writes its record", async () => {
    const records: WakeRecord[] = [];
    const h = host(BOTH, records);
    expect((await h.evalSnippet(`API_MD_PATH.split("/").pop()`)).value).toBe(`"API-wake.md"`);
    const r = await h.evalSnippet(`(await wait({ maxMs: 1500 })).woke`, { turn: 4, callTs: 1234 });
    expect(r.timedOut).toBeUndefined();
    expect(r.value).toBe(`"maxMs"`);
    // The limit is back once the wait is over.
    const plain = await h.evalSnippet(`await sleep(1500, { wake: false })`);
    expect(plain.timedOut).toBe(true);
    expect(records).toEqual([expect.objectContaining({ t: "wake", via: "in-snippet", turn: 4, callTs: 1234, fired: "maxMs", maxMs: 1500 })]);
    expect(records[0]!.sleptMs).toBeGreaterThanOrEqual(1_400);
  });

  test("it wakes on a predicate, a promise and an opcode", async () => {
    const h = host(BOTH);
    expect((await h.evalSnippet(PRELUDE)).ok).toBe(true);
    const pred = await h.evalSnippet(`setTimeout(() => (globalThis.flag = true), 700); return (await wait({ on: () => globalThis.flag === true, maxMs: 5000 })).woke`);
    expect(pred.value).toBe(`"predicate"`);
    const prom = await h.evalSnippet(`const p = new Promise((r) => setTimeout(r, 700)); return (await wait({ on: [p, "levelUp"], maxMs: 5000 })).woke`);
    expect(prom.value).toBe(`"promise"`);
    const op = await h.evalSnippet(`setTimeout(() => feed("WB_MOVE_RESULT", 0xff01, { moveId: 1, status: "arrived" }), 700); return (await wait({ on: "WB_MOVE_RESULT", maxMs: 5000 })).woke`);
    expect(op.value).toBe(`"WB_MOVE_RESULT"`);
  });

  test("a death and a harness notice always wake it; an attack only when asked", async () => {
    const h = host(BOTH);
    expect((await h.evalSnippet(PRELUDE)).ok).toBe(true);
    const attacked = await h.evalSnippet(`setTimeout(() => attackStart("7"), 200); return (await wait({ on: "levelUp", maxMs: 1200 })).woke`);
    expect(attacked.value).toBe(`"maxMs"`);
    const asked = await h.evalSnippet(`setTimeout(() => attackStart("7"), 200); return (await wait({ on: "attacked", maxMs: 5000 })).woke`);
    expect(asked.value).toBe(`"attacked"`);
    const level = await h.evalSnippet(`setTimeout(() => selfFields({ level: 2 }), 200); return (await wait({ on: "levelUp", maxMs: 5000 })).woke`);
    expect(level.value).toBe(`"levelUp"`);
    const notice = await h.evalSnippet(`setTimeout(() => { throw new Error("routine broke"); }, 200); return (await wait({ maxMs: 5000 })).woke`);
    expect(notice.value).toBe(`"notice"`);
    const died = await h.evalSnippet(`setTimeout(() => selfFields({ health: 0 }), 200); return (await wait({ on: "levelUp", maxMs: 5000 })).woke`);
    expect(died.value).toBe(`"died"`);
  });

  test("a stopping run wakes it at once", async () => {
    const h = host(BOTH);
    const pending = h.evalSnippet(`(await wait({ maxMs: 5000 })).woke`);
    await Bun.sleep(300);
    h.wakeWaits();
    const r = await pending;
    expect(r.value).toBe(`"stopped"`);
  });

  test("a wait it cannot honour is refused and says why", async () => {
    const h = host(BOTH);
    expect((await h.evalSnippet(`await wait({ maxMs: ${WAKE_CAP_MS + 1} })`)).error).toContain("five minutes");
    expect((await h.evalSnippet(`await wait({ on: "boarKilled" })`)).error).toContain("a wake name");
    expect((await h.evalSnippet(`await wait({ until: 3 })`)).error).toContain("has no option until");
  });

  test("with the turn-end option the child pushes its facts, and an attack is one of them", async () => {
    const h = host(TURN_END);
    expect((await h.evalSnippet(PRELUDE)).ok).toBe(true);
    const from = h.wakeFactSeq;
    await h.evalSnippet(`attackStart("7"); selfFields({ level: 2 }); selfFields({ health: 0 }); 1`);
    await Bun.sleep(100);
    expect(h.wakeFactsAfter(from).map((f) => [f.key, f.detail ?? null])).toEqual([
      ["attacked", null],
      ["levelUp", "level 2"],
      ["died", null],
    ]);
    // A quest log arriving already holding a complete quest (the login backlog
    // after a restart or a resume) is the run's past; a quest completing later is news.
    const before = h.wakeFactSeq;
    await h.evalSnippet(`selfFields({ quest0Id: 33, quest0State: 1, quest1Id: 34, quest1State: 0 }); 1`);
    await h.evalSnippet(`selfFields({ quest1State: 1 }); 1`);
    await Bun.sleep(100);
    expect(h.wakeFactsAfter(before).map((f) => [f.key, f.detail ?? null])).toEqual([["questComplete", "quest 34"]]);
    // Without it, nothing is pushed.
    const off = host(undefined);
    expect((await off.evalSnippet(PRELUDE)).ok).toBe(true);
    await off.evalSnippet(`selfFields({ level: 2 }); 1`);
    await Bun.sleep(100);
    expect(off.wakeFactsAfter(0)).toEqual([]);
  });
});

describe("the arms of wake-probe@1 do not pool", () => {
  const def = checkedIn("wake-probe@1");

  test("three arms on one image, told apart only by their args", () => {
    expect(def.arms.map((a) => a.id)).toEqual(["control", "turn-end", "turn-end-wait"]);
    expect(new Set(def.arms.map((a) => a.image)).size).toBe(1);
    expect(def.arms.map((a) => wakeOptionsOf(parseRunArgs(a.args ?? [])))).toEqual([null, TURN_END, BOTH]);
    // The idle watchdog sits above the cap, so a sleeping model is never idle.
    expect(def.budget.idleMs).toBeGreaterThan(WAKE_CAP_MS);
  });

  test("under one harness version with no series, each arm is its own column and summary", () => {
    const MODELS: CampaignsRoster["models"] = [{ name: "sonnet", model: "sonnet", effort: "low", driver: "claude-code" }];
    const r = parseCampaignBlocks(defsBlock(def), { "wake-probe": { version: 1, assignments: [{ model: "sonnet" }] } }, { sonnet: { driver: "claude-code" } });
    const roster: CampaignsRoster = { campaigns: r.campaigns, campaignDefs: r.definitions, campaignRefusals: r.refused, models: MODELS };
    const run = (runId: string, arm: string): ResultRun =>
      ({
        runId,
        model: "sonnet",
        effort: "low",
        harness: "claude-code",
        harnessVersion: "harness-wake-draft",
        harnessSeries: null,
        campaign: "wake-probe",
        campaignVersion: 1,
        cell: "dwarf-paladin",
        arm,
        ref: "sonnet",
        race: 3,
        class: 2,
        episode: "probing",
        terminationReason: "episode-limit",
        modelResponses: 10,
        startedAt: 1000,
        levels: [],
        maxLevel: 3,
        tokens: null,
        actualCost: null,
      }) as unknown as ResultRun;
    const v = campaignsView([run("a", "control"), run("b", "control"), run("c", "turn-end")], roster, () => true).campaigns[0]!;
    expect(v.columns.map((c) => c.key)).toEqual(["sonnet/control", "sonnet/turn-end", "sonnet/turn-end-wait"]);
    expect(v.grid[0]!.squares.map((s) => s.runs)).toEqual([2, 1, 0]);
    expect(v.comparison[0]!.arms.map((a) => [a.arm, a.runs])).toEqual([
      ["control", 2],
      ["turn-end", 1],
      ["turn-end-wait", 0],
    ]);
  });

  test("and their tuples differ on the wake key, not the version", () => {
    const argv = [...MODEL, "--run-id", "x", "--token", "t".repeat(32)];
    const tuples = def.arms.map((a) => comparabilityOf(configFromArgs([...argv, ...(a.args ?? [])], {}), "harness-wake-draft", null, null));
    expect(tuples.map((t) => t.harnessVersion)).toEqual(["harness-wake-draft", "harness-wake-draft", "harness-wake-draft"]);
    expect(tuples.map((t) => t.wake ?? null)).toEqual([null, TURN_END, BOTH]);
    expect(sameComparability(tuples[0]!, tuples[1]!)).toBe(false);
    expect(sameComparability(tuples[1]!, tuples[2]!)).toBe(false);
  });
});
