/**
 * `edit_scratchpad` (issue #41, operator decision 2026-09-01): the in-place
 * edit beside the full write. Two layers, tested separately — `Scratchpad.edit`
 * decides found/unique/ambiguous/identical/empty and the cap, `callTool`
 * validates the arguments and renders the refusal hints.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Scratchpad, SCRATCHPAD_MAX_CHARS } from "../src/scratchpad";
import { callTool, nearestTool, normalizeToolArgs, TOOLS, type ToolContext } from "../src/tools";
import { EpisodicLog } from "../src/episodic";
import { ReflectGate } from "../src/reflect";
import type { SandboxHost } from "../src/sandbox/host";

function makePad(): Scratchpad {
  const dir = mkdtempSync(join(tmpdir(), "wrathbench-pad-edit-"));
  return new Scratchpad(join(dir, "scratchpad.md"));
}

function makeCtx(scratchpad: Scratchpad): ToolContext {
  const dir = mkdtempSync(join(tmpdir(), "wrathbench-pad-ctx-"));
  return {
    sandbox: undefined as unknown as SandboxHost,
    scratchpad,
    sessionLive: () => false,
    reflect: new ReflectGate(),
    episodic: new EpisodicLog(join(dir, "episodic.jsonl")),
    turn: () => 1,
  };
}

describe("Scratchpad.edit", () => {
  test("a unique match is replaced and nothing else moves", () => {
    const pad = makePad();
    pad.write("# Plan\n- [ ] turn in Kobold Camp\n- [ ] train at 4\n");
    const res = pad.edit("- [ ] turn in Kobold Camp", "- [x] turned in Kobold Camp");
    expect(res.ok).toBe(true);
    expect(pad.read()).toBe("# Plan\n- [x] turned in Kobold Camp\n- [ ] train at 4\n");
    if (res.ok) {
      expect(res.replaced).toBe(1);
      expect(res.chars).toBe(pad.read().length);
      expect(res.lines).toBe(4);
      expect(res.truncated).toBe(false);
    }
  });

  test("an empty new deletes the text", () => {
    const pad = makePad();
    pad.write("keep\nstale line\n");
    expect(pad.edit("stale line\n", "").ok).toBe(true);
    expect(pad.read()).toBe("keep\n");
  });

  test("a missing old is refused, and the pad is untouched", () => {
    const pad = makePad();
    pad.write("# Plan\n");
    const res = pad.edit("# plan", "# Notes");
    expect(res).toEqual({ ok: false, reason: "not_found", matches: 0 });
    expect(pad.read()).toBe("# Plan\n");
  });

  test("two matches are refused with the count rather than guessed", () => {
    const pad = makePad();
    pad.write("boar\nwolf\nboar\n");
    const res = pad.edit("boar", "kobold");
    expect(res).toEqual({ ok: false, reason: "ambiguous", matches: 2 });
    expect(pad.read()).toBe("boar\nwolf\nboar\n");
  });

  test("replaceAll takes every occurrence", () => {
    const pad = makePad();
    pad.write("boar\nwolf\nboar\n");
    const res = pad.edit("boar", "kobold", true);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.replaced).toBe(2);
    expect(pad.read()).toBe("kobold\nwolf\nkobold\n");
  });

  test("an empty old is refused — there is nothing to match", () => {
    const pad = makePad();
    pad.write("# Plan\n");
    expect(pad.edit("", "x")).toEqual({ ok: false, reason: "empty_old", matches: 0 });
    expect(pad.read()).toBe("# Plan\n");
  });

  test("old === new is refused as a no-op", () => {
    const pad = makePad();
    pad.write("same\n");
    expect(pad.edit("same", "same")).toEqual({ ok: false, reason: "identical", matches: 0 });
  });

  test("the text is literal: metacharacters and $& are not interpreted", () => {
    const pad = makePad();
    pad.write("coords: (a+b)*c [1]\n");
    const res = pad.edit("(a+b)*c [1]", "$& $1 (x)");
    expect(res.ok).toBe(true);
    expect(pad.read()).toBe("coords: $& $1 (x)\n");
  });

  test("the 32k cap applies exactly as it does to a write", () => {
    const pad = makePad();
    pad.write(`HEAD\n${"x".repeat(SCRATCHPAD_MAX_CHARS - 10)}`);
    const res = pad.edit("HEAD", "H".repeat(200));
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.truncated).toBe(true);
    expect(readFileSync(pad.path, "utf8")).toContain(`[scratchpad truncated at ${SCRATCHPAD_MAX_CHARS} chars]`);
  });
});

describe("edit_scratchpad, the tool", () => {
  test("it is registered with the documented schema", () => {
    const def = TOOLS.find((t) => t.name === "edit_scratchpad");
    expect(def).toBeDefined();
    expect(def?.inputSchema["required"]).toEqual(["old", "new"]);
    expect(Object.keys(def?.inputSchema["properties"] as object)).toEqual(["old", "new", "replaceAll"]);
    expect(def?.inputSchema["additionalProperties"]).toBe(false);
    // The description says which of the two scratchpad tools to reach for.
    expect(def?.description).toContain("write_scratchpad");
    // write_scratchpad is still there: full replacement is its own operation.
    expect(TOOLS.some((t) => t.name === "write_scratchpad")).toBe(true);
  });

  test("a successful edit answers short — the pad itself is re-injected next turn", async () => {
    const pad = makePad();
    pad.write("# Plan\n- [ ] train\n");
    const ctx = makeCtx(pad);
    const res = await callTool(ctx, "edit_scratchpad", { old: "- [ ] train", new: "- [x] trained" });
    expect(res.isError).toBeUndefined();
    expect(res.text).toBe("edited (1 replacement; 21 chars, 3 lines)");
    expect(res.text).not.toContain("# Plan");
    expect(pad.read()).toBe("# Plan\n- [x] trained\n");
  });

  test("each refusal is a hint saying what to fix, not what to do in the world", async () => {
    const pad = makePad();
    pad.write("boar\nboar\n");
    const ctx = makeCtx(pad);

    const missing = await callTool(ctx, "edit_scratchpad", { old: "wolf", new: "kobold" });
    expect(missing.isError).toBe(true);
    expect(missing.text).toContain("not found in the scratchpad");
    expect(missing.text).toContain("whitespace included");

    const ambiguous = await callTool(ctx, "edit_scratchpad", { old: "boar", new: "kobold" });
    expect(ambiguous.isError).toBe(true);
    expect(ambiguous.text).toContain("matches 2 places");
    expect(ambiguous.text).toContain("replaceAll");

    const empty = await callTool(ctx, "edit_scratchpad", { old: "", new: "x" });
    expect(empty.isError).toBe(true);
    expect(empty.text).toContain("write_scratchpad");

    const identical = await callTool(ctx, "edit_scratchpad", { old: "boar", new: "boar" });
    expect(identical.isError).toBe(true);
    expect(identical.text).toContain("same text");

    // Every refusal left the pad exactly as it was.
    expect(pad.read()).toBe("boar\nboar\n");
  });

  test("replaceAll goes through the tool, booleanish like every other flag", async () => {
    const pad = makePad();
    pad.write("boar\nboar\n");
    const res = await callTool(makeCtx(pad), "edit_scratchpad", {
      old: "boar",
      new: "kobold",
      replaceAll: "true",
    });
    expect(res.isError).toBeUndefined();
    expect(res.text).toContain("2 replacements");
    expect(pad.read()).toBe("kobold\nkobold\n");
  });

  test("the Claude-Code-shaped argument names are repaired, not refused", async () => {
    expect(
      normalizeToolArgs("edit_scratchpad", { old_string: "a", new_string: "b", replace_all: true }),
    ).toEqual({ old: "a", new: "b", replaceAll: true });
    expect(normalizeToolArgs("edit_scratchpad", { oldString: "a", newString: "b" })).toEqual({
      old: "a",
      new: "b",
    });
    const pad = makePad();
    pad.write("alpha\n");
    const res = await callTool(makeCtx(pad), "edit_scratchpad", { old_string: "alpha", new_string: "beta" });
    expect(res.isError).toBeUndefined();
    expect(pad.read()).toBe("beta\n");
  });

  test("an unknown key is still refused, with the parameter restatement", async () => {
    const pad = makePad();
    pad.write("alpha\n");
    const res = await callTool(makeCtx(pad), "edit_scratchpad", { old: "alpha", new: "beta", where: "top" });
    expect(res.isError).toBe(true);
    expect(res.text).toContain('unknown key(s) "where"');
    expect(res.text).toContain("replaceAll?: boolean");
  });

  test("the two scratchpad tools still resolve to themselves under the fuzzy matcher", () => {
    expect(nearestTool("edit_scratchpad")).toBe("edit_scratchpad");
    expect(nearestTool("Edit_Scratchpad")).toBe("edit_scratchpad");
    expect(nearestTool("write_scratchpad")).toBe("write_scratchpad");
    expect(nearestTool("Write_Scratchpad")).toBe("write_scratchpad");
  });
});
