/**
 * Tool-argument leniency and strict validation (2026-08 audit, Tier 1 item 4
 * and Tier 2 items 7/8): lenient parsing of argument strings, alias
 * normalization, strict unknown-key rejection, clamped limits, and
 * nearest-tool suggestions.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  callTool,
  coerceToolArgs,
  nearestTool,
  normalizeToolArgs,
  parseToolArgsText,
  type ToolContext,
} from "../src/tools";
import { Scratchpad } from "../src/scratchpad";
import type { SandboxHost } from "../src/sandbox/host";

/** Context for calls that never reach the sandbox (validation failures) or only touch the scratchpad. */
function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  const dir = mkdtempSync(join(tmpdir(), "wrathbench-tools-"));
  return {
    sandbox: undefined as unknown as SandboxHost,
    scratchpad: new Scratchpad(join(dir, "scratchpad.md")),
    sessionLive: () => false,
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

  test("text/markdown map to content, q maps to query", () => {
    expect(normalizeToolArgs("write_scratchpad", { text: "# t" })).toEqual({ content: "# t" });
    expect(normalizeToolArgs("write_scratchpad", { markdown: "# m" })).toEqual({ content: "# m" });
    expect(normalizeToolArgs("search_reference", { q: "kobold" })).toEqual({ query: "kobold" });
  });

  test("aliases work end-to-end through callTool (write_scratchpad via text)", async () => {
    const ctx = makeCtx();
    const res = await callTool(ctx, "write_scratchpad", { text: "# via alias" });
    expect(res.isError ?? false).toBe(false);
    expect(ctx.scratchpad.read()).toContain("# via alias");
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
    expect(seen).toEqual([200, 1, 50]);
  });
});

describe("unknown tool suggestions", () => {
  test("the reply lists all six valid tools", async () => {
    const res = await callTool(makeCtx(), "does_not_exist_at_all", {});
    expect(res.isError).toBe(true);
    for (const name of [
      "run_snippet",
      "recent_events",
      "state_summary",
      "search_reference",
      "read_scratchpad",
      "write_scratchpad",
    ]) {
      expect(res.text).toContain(name);
    }
    expect(res.text).not.toContain("Did you mean");
  });

  test("a near-miss gets a did-you-mean", async () => {
    const res = await callTool(makeCtx(), "run_snipet", {});
    expect(res.text).toContain("Did you mean run_snippet?");
    expect(nearestTool("recent_event")).toBe("recent_events");
    expect(nearestTool("Write_Scratchpad")).toBe("write_scratchpad");
  });

  test("a mangled name containing a valid tool is recognized (observed live)", async () => {
    const res = await callTool(makeCtx(), "connect()<tool_call>run_snippet", {});
    expect(res.text).toContain("Did you mean run_snippet?");
  });
});
