/**
 * Tool-argument leniency and strict validation (2026-08 audit): lenient parsing of argument strings, alias
 * normalization, strict unknown-key rejection, clamped limits, and
 * nearest-tool suggestions.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ACTION_HINT_RENDER,
  callTool,
  coerceToolArgs,
  nearestTool,
  normalizeToolArgs,
  parseToolArgsText,
  renderActionHints,
  type ToolContext,
} from "../src/tools";
import type { ActionHintNote } from "../src/sandbox/ipc";
import { EpisodicLog } from "../src/episodic";
import { ReflectGate } from "../src/reflect";
import { Workspace } from "../src/workspace";
import type { SandboxHost } from "../src/sandbox/host";

/** Context for calls that never reach the sandbox (validation failures) or only touch the workspace. */
function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  const dir = mkdtempSync(join(tmpdir(), "wrathbench-tools-"));
  return {
    sandbox: undefined as unknown as SandboxHost,
    workspace: new Workspace(join(dir, "workspace")),
    sessionLive: () => false,
    reflect: new ReflectGate(),
    episodic: new EpisodicLog(join(dir, "episodic.jsonl")),
    turn: () => 1,
    ...overrides,
  };
}

describe("parseToolArgsText leniency ladder", () => {
  test("plain JSON parses", () => {
    expect(parseToolArgsText('{"code":"1+1"}')).toEqual({ ok: true, args: { code: "1+1" } });
  });

  test("empty string means no arguments", () => {
    expect(parseToolArgsText("  ")).toEqual({ ok: true, args: {} });
  });

  test("a ```json fence is stripped", () => {
    const raw = '```json\n{"code":"await connect()"}\n```';
    expect(parseToolArgsText(raw)).toEqual({ ok: true, args: { code: "await connect()" } });
  });

  test("a bare ``` fence is stripped", () => {
    const raw = '```\n{"query":"Northshire quests"}\n```';
    expect(parseToolArgsText(raw)).toEqual({ ok: true, args: { query: "Northshire quests" } });
  });

  test("trailing commas before } and ] are repaired", () => {
    expect(parseToolArgsText('{"code":"x", }')).toEqual({ ok: true, args: { code: "x" } });
    expect(parseToolArgsText('{"a":[1,2,],}')).toEqual({ ok: true, args: { a: [1, 2] } });
  });

  test("fence plus trailing comma repairs together", () => {
    const raw = '```json\n{"content":"# plan",}\n```';
    expect(parseToolArgsText(raw)).toEqual({ ok: true, args: { content: "# plan" } });
  });

  test("trailing-comma repair never mutates content inside string literals", () => {
    // Outer JSON has a real trailing comma (so the repair pass runs), and the
    // code string itself contains `, ]` — which the old global regex deleted.
    const res = parseToolArgsText('{"code": "await sdk.say(\', ]\')", }');
    expect(res.ok).toBe(true);
    if (res.ok) expect((res.args as { code: string }).code).toBe("await sdk.say(', ]')");
  });

  test("repair leaves comma-bracket sequences inside strings byte-identical", () => {
    const res = parseToolArgsText('{"code":"const arr = [1, 2, ]; log(\\"x, ]\\")",}');
    expect(res.ok).toBe(true);
    // The structural trailing comma (before the outer }) is stripped; the two
    // `, ]` sequences inside the JS string are preserved verbatim.
    if (res.ok) expect((res.args as { code: string }).code).toBe('const arr = [1, 2, ]; log("x, ]")');
  });

  test("escaped quotes inside a string do not desync the tokenizer", () => {
    const res = parseToolArgsText('{"code":"a = \\"b, ]\\"; c = 1, ]",}');
    expect(res.ok).toBe(true);
    if (res.ok) expect((res.args as { code: string }).code).toBe('a = "b, ]"; c = 1, ]');
  });

  test("final failure echoes what was received", () => {
    const raw = "definitely {not json at all";
    const res = parseToolArgsText(raw);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toContain("not valid JSON");
      expect(res.error).toContain("definitely {not json at all");
    }
  });
});

describe("coerceToolArgs", () => {
  test("passes non-string arguments through untouched", () => {
    expect(coerceToolArgs("run_snippet", { code: "1" })).toEqual({ ok: true, args: { code: "1" } });
  });

  test("failure restates the tool's expected parameters in prose", () => {
    const res = coerceToolArgs("run_snippet", "{broken");
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toContain("{broken");
      expect(res.error).toContain("run_snippet expects { code: string }");
    }
  });
});

describe("alias normalization", () => {
  test("cmd/snippet/source/script/ts map to code when code is absent", () => {
    for (const alias of ["cmd", "snippet", "source", "script", "ts"]) {
      expect(normalizeToolArgs("run_snippet", { [alias]: "1+1" })).toEqual({ code: "1+1" });
    }
  });

  test("the canonical key wins when both are present", () => {
    expect(normalizeToolArgs("run_snippet", { code: "keep", snippet: "drop" })).toEqual({
      code: "keep",
      snippet: "drop", // left in place; strict validation names it
    });
  });

  test("q maps to query; the file tools have no aliases", () => {
    expect(normalizeToolArgs("search_reference", { q: "kobold" })).toEqual({ query: "kobold" });
    expect(normalizeToolArgs("write_file", { file_path: "x", text: "y" })).toEqual({ file_path: "x", text: "y" });
    expect(normalizeToolArgs("edit_file", { old: "a", new: "b", replaceAll: true })).toEqual({ old: "a", new: "b", replaceAll: true });
  });

  test("aliases work end-to-end through callTool (log_status via content)", async () => {
    const ctx = makeCtx();
    const res = await callTool(
      { ...ctx, sandbox: { stateSnapshot: () => Promise.reject(new Error("no sandbox")) } as unknown as SandboxHost },
      "log_status",
      { content: "via alias" },
    );
    expect(res.isError ?? false).toBe(false);
    expect(res.text).toContain("logged (entry 1");
  });
});

describe("snippet result rendering", () => {
  test("the uncalled-function hint reaches the model under the value", async () => {
    const ctx = makeCtx({
      sandbox: {
        evalSnippet: async () => ({
          ok: true,
          value: "[AsyncFunction (anonymous)]",
          hint: "the snippet returned a function it never called — call it (await fn()).",
          logs: [],
          durationMs: 3,
        }),
      } as unknown as SandboxHost,
    });
    const res = await callTool(ctx, "run_snippet", { code: "async () => 1" });
    expect(res.isError ?? false).toBe(false);
    expect(res.text).toContain("=> [AsyncFunction (anonymous)]");
    expect(res.text).toContain("the snippet returned a function it never called");
  });
});

describe("harness-delivered action hints", () => {
  const note = (over: Partial<ActionHintNote> = {}): ActionHintNote => ({
    action: "moveTo",
    status: "too_far",
    count: 1,
    hint: "(-6048, 367) is 312y away in a straight line; a single moveTo covers ~250y. Walk to an intermediate point first.",
    ts: 1,
    ...over,
  });

  test("nothing recorded renders nothing", () => {
    expect(renderActionHints([])).toBeUndefined();
  });

  test("one line per status, most recent first — 41 refusals do not cost 41 lines", () => {
    const text = renderActionHints([
      note({ count: 41, ts: 10 }),
      note({ status: "drop", count: 1, hint: "steps off a ledge", ts: 20 }),
    ]);
    expect(text).toBeDefined();
    const lines = (text as string).split("\n");
    expect(lines[0]).toBe("--- harness ---");
    // A single occurrence carries no count; a repeat carries the collapse marker
    // and nothing else — no threshold, no escalation, no added advice.
    expect(lines[1]).toBe("moveTo drop: steps off a ledge");
    expect(lines[2]).toBe(
      "moveTo too_far ×41: (-6048, 367) is 312y away in a straight line; a single moveTo covers ~250y. Walk to an intermediate point first.",
    );
    expect(lines.length).toBe(3);
  });

  test("the block is capped per snippet and each hint is truncated", () => {
    const many = ["a", "b", "c", "d", "e", "f"].map((st, i) =>
      note({ status: st, count: 10 - i, hint: "x".repeat(600), ts: 100 - i }),
    );
    const lines = (renderActionHints(many) as string).split("\n");
    expect(lines.length).toBe(1 + ACTION_HINT_RENDER.MAX_GROUPS + 1);
    expect(lines.at(-1)).toBe("(+2 other failure statuses this snippet)");
    for (const l of lines.slice(1, 1 + ACTION_HINT_RENDER.MAX_GROUPS)) {
      expect(l.length).toBeLessThan(ACTION_HINT_RENDER.MAX_HINT_CHARS + 40);
      expect(l.endsWith("…")).toBe(true);
    }
  });

  test("a snippet that returned ok and kept only .status still gets the hint", async () => {
    const ctx = makeCtx({
      sandbox: {
        evalSnippet: async () => ({
          ok: true,
          value: '[ "too_far", "too_far" ]',
          actionHints: [note({ count: 2 })],
          logs: [],
          durationMs: 5,
        }),
      } as unknown as SandboxHost,
    });
    const res = await callTool(ctx, "run_snippet", { code: "results.map(r => r.status)" });
    expect(res.isError ?? false).toBe(false);
    expect(res.text).toContain("--- harness ---");
    expect(res.text).toContain("moveTo too_far ×2:");
    expect(res.text).toContain("Walk to an intermediate point first.");
  });
});

describe("strict schemas", () => {
  test("an unknown key is an error naming it and the valid keys", async () => {
    const res = await callTool(makeCtx(), "run_snippet", { code: "1", foo: 1, bar: 2 });
    expect(res.isError).toBe(true);
    expect(res.text).toContain('unknown key(s) "foo", "bar"');
    expect(res.text).toContain("valid keys for run_snippet: code");
    expect(res.text).toContain("run_snippet expects { code: string }");
  });

  test("a wrong-typed value renders as a sentence with what was received", async () => {
    const res = await callTool(makeCtx(), "run_snippet", { code: 42 });
    expect(res.isError).toBe(true);
    expect(res.text).toContain("code:");
    expect(res.text).not.toContain('"code":"invalid_type"'); // no raw issue arrays
    expect(res.text).toContain("Received:");
  });

  test("recent_events limit coerces numeric strings and clamps to 1-200", async () => {
    const seen: number[] = [];
    const ctx = makeCtx({
      sandbox: {
        recentEvents: async (limit: number) => {
          seen.push(limit);
          return [];
        },
      } as unknown as SandboxHost,
    });
    expect((await callTool(ctx, "recent_events", { limit: "500" })).text).toBe("no events yet");
    expect((await callTool(ctx, "recent_events", { limit: 0 })).text).toBe("no events yet");
    expect((await callTool(ctx, "recent_events", {})).text).toBe("no events yet");
    // The clamped limit counts events AFTER the fold, so the sandbox is scanned
    // 8x wider, capped at the SDK's 500-event retained buffer.
    expect(seen).toEqual([500, 8, 400]);
  });
});

/**
 * The ambient-movement fold, shared with the context window: the
 * tool used to serve up to 200 raw lines, of which SMSG_MONSTER_MOVE alone was
 * 69% on gate2-ox-1.
 */
describe("recent_events movement fold", () => {
  const ev = (seq: number, opcode: string) => ({ seq, ts: seq, opcode, data: {} });

  /** A stream where every third event is signal and the rest is ambient motion. */
  function streamCtx(events: ReturnType<typeof ev>[], seen: number[] = []) {
    return makeCtx({
      sandbox: {
        recentEvents: async (limit: number) => {
          seen.push(limit);
          return events.slice(-limit);
        },
      } as unknown as SandboxHost,
    });
  }

  test("ambient movement is dropped and reported in a trailing note", async () => {
    const events = [
      ev(1, "SMSG_MESSAGECHAT"),
      ev(2, "SMSG_MONSTER_MOVE"),
      ev(3, "MSG_MOVE_HEARTBEAT"),
      ev(4, "SMSG_ATTACKERSTATEUPDATE"),
    ];
    const res = await callTool(streamCtx(events), "recent_events", {});
    expect(res.text).toContain("#1 SMSG_MESSAGECHAT");
    expect(res.text).toContain("#4 SMSG_ATTACKERSTATEUPDATE");
    expect(res.text).not.toContain("SMSG_MONSTER_MOVE");
    expect(res.text).not.toContain("MSG_MOVE_HEARTBEAT");
    expect(res.text).toContain("(+2 ambient movement events folded into state");
    expect(res.text).toContain("{includeMovement: true}");
  });

  test("includeMovement passes the raw stream through, and scans exactly limit", async () => {
    const events = [ev(1, "SMSG_MESSAGECHAT"), ev(2, "SMSG_MONSTER_MOVE")];
    const seen: number[] = [];
    const res = await callTool(streamCtx(events, seen), "recent_events", {
      limit: 10,
      includeMovement: true,
    });
    expect(res.text).toContain("SMSG_MONSTER_MOVE");
    expect(res.text).not.toContain("folded into state");
    expect(seen).toEqual([10]);
  });

  test("limit counts signal events, and the note covers only that span", async () => {
    // 30 events, 10 of them signal, interleaved 1 signal : 2 ambient.
    const events = Array.from({ length: 30 }, (_, i) =>
      i % 3 === 0 ? ev(i, "SMSG_SPELL_GO") : ev(i, "SMSG_MONSTER_MOVE"),
    );
    const res = await callTool(streamCtx(events), "recent_events", { limit: 3 });
    const lines = res.text.split("\n");
    expect(lines).toHaveLength(4); // 3 signal events + the fold note
    expect(lines.slice(0, 3).every((l) => l.includes("SMSG_SPELL_GO"))).toBe(true);
    // The span starts at the oldest visible event (#21), so only the 6 ambient
    // events inside it are reported — not all 20 in the scanned buffer.
    expect(lines[3]).toContain("(+6 ambient movement events folded into state");
  });

  test("an all-movement stream says so instead of claiming no events", async () => {
    const events = Array.from({ length: 5 }, (_, i) => ev(i, "SMSG_MONSTER_MOVE"));
    const res = await callTool(streamCtx(events), "recent_events", {});
    expect(res.text).toContain("no non-movement events yet");
    expect(res.text).toContain("(+5 ambient movement events folded into state");
  });

  test('includeMovement coerces "true"/"false" by value, not JS truthiness', async () => {
    const events = [ev(1, "SMSG_MONSTER_MOVE")];
    const on = await callTool(streamCtx(events), "recent_events", { includeMovement: "true" });
    expect(on.text).toContain("SMSG_MONSTER_MOVE");
    const off = await callTool(streamCtx(events), "recent_events", { includeMovement: "false" });
    expect(off.text).not.toContain("#1 SMSG_MONSTER_MOVE");
    expect(off.text).toContain("no non-movement events yet");
    // snake_case is normalized like the other aliases
    const alias = await callTool(streamCtx(events), "recent_events", { include_movement: true });
    expect(alias.text).toContain("SMSG_MONSTER_MOVE");
  });

  test("onEventsServed logs the visible events and the folded count", async () => {
    const events = [ev(1, "SMSG_MONSTER_MOVE"), ev(2, "SMSG_MESSAGECHAT")];
    let served: unknown[] = [];
    let folded: number | undefined;
    const ctx = makeCtx({
      sandbox: {
        recentEvents: async (limit: number) => events.slice(-limit),
      } as unknown as SandboxHost,
      onEventsServed: (e, f) => {
        served = e;
        folded = f;
      },
    });
    await callTool(ctx, "recent_events", {});
    expect(served).toHaveLength(1);
    expect((served[0] as { opcode: string }).opcode).toBe("SMSG_MESSAGECHAT");
    expect(folded).toBe(1);
  });

  test("the arg-error hint names includeMovement and what changed", async () => {
    const res = await callTool(makeCtx(), "recent_events", { nope: 1 });
    expect(res.isError).toBe(true);
    expect(res.text).toContain("includeMovement");
    expect(res.text).toContain("counted after ambient movement is folded out");
  });
});

describe("unknown tool suggestions", () => {
  test("the reply lists the valid tools", async () => {
    const res = await callTool(makeCtx(), "does_not_exist_at_all", {});
    expect(res.isError).toBe(true);
    for (const name of [
      "run_snippet",
      "recent_events",
      "state_summary",
      "search_reference",
      "read_file",
      "write_file",
      "edit_file",
      "delete_file",
    ]) {
      expect(res.text).toContain(name);
    }
    expect(res.text).not.toContain("Did you mean");
  });

  test("a near-miss gets a did-you-mean", async () => {
    const res = await callTool(makeCtx(), "run_snipet", {});
    expect(res.text).toContain("Did you mean run_snippet?");
    expect(nearestTool("recent_event")).toBe("recent_events");
    expect(nearestTool("Write_File")).toBe("write_file");
  });

  test("a mangled name containing a valid tool is recognized (observed live)", async () => {
    const res = await callTool(makeCtx(), "connect()<tool_call>run_snippet", {});
    expect(res.text).toContain("Did you mean run_snippet?");
  });
});
