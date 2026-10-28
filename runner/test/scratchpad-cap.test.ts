/**
 * The scratchpad cap refuses; it never cuts (operator, 2026-10-14;
 * docs/METHODOLOGY.md, "Context policy"). A write, append or edit whose result
 * would exceed SCRATCHPAD_MAX_CHARS saves nothing and says why. The snippet
 * path (a rejecting promise, awaited or not) is in sandbox.test.ts; this file
 * is the pad itself and the two tools.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Scratchpad, SCRATCHPAD_MAX_CHARS, scratchpadSizeLabel, stripLegacyMarker } from "@wrathbench/mcp";
import { callTool, type ToolContext } from "../src/tools";
import { EpisodicLog } from "../src/episodic";
import { ReflectGate } from "../src/reflect";
import type { SandboxHost } from "../src/sandbox/host";
import { SecretRedactor } from "@wrathbench/mcp";
import { tempDirs } from "./fixtures/temp-dirs";

const tempDir = tempDirs();
const MAX = SCRATCHPAD_MAX_CHARS;
const MARKER = `\n\n[scratchpad truncated at ${MAX} chars]`;

function makePad(): Scratchpad {
  return new Scratchpad(join(tempDir("wrathbench-pad-cap-"), "scratchpad.md"));
}

function makeCtx(scratchpad: Scratchpad): ToolContext {
  return {
    sandbox: undefined as unknown as SandboxHost,
    scratchpad,
    sessionLive: () => false,
    reflect: new ReflectGate(),
    episodic: new EpisodicLog(join(tempDir("wrathbench-pad-cap-ctx-"), "episodic.jsonl")),
    turn: () => 1,
    secrets: new SecretRedactor(),
  };
}

describe("the cap refuses rather than cuts", () => {
  test("exactly the cap is accepted; one over is refused and nothing is saved", () => {
    const pad = makePad();
    expect(pad.write("x".repeat(MAX))).toEqual({ ok: true, chars: MAX });
    expect(pad.write("y".repeat(MAX + 1))).toEqual({ ok: false, reason: "over_cap", chars: MAX + 1 });
    expect(pad.read()).toBe("x".repeat(MAX));
  });

  test("an append that would cross the cap saves none of the new text", () => {
    // The old cut kept the head and dropped the tail, so an append at the cap
    // vanished whole while answering `{ truncated: true }`.
    const pad = makePad();
    pad.write("n".repeat(MAX - 10));
    expect(pad.append("123456789")).toEqual({ ok: true, chars: MAX });
    expect(pad.append("more")).toEqual({ ok: false, reason: "over_cap", chars: MAX + 5 });
    expect(pad.read()).toBe(`${"n".repeat(MAX - 10)}\n123456789`);
  });

  test("a prepend that pushes durable notes past the cap is refused, not trimmed off the end", () => {
    const pad = makePad();
    const notes = `# Durable\n${"fact\n".repeat((MAX - 20) / 5)}`;
    pad.write(notes);
    expect(pad.write(`# Turn log\n${"t".repeat(100)}\n${pad.read()}`).ok).toBe(false);
    expect(pad.read()).toBe(notes);
  });

  test("write_scratchpad answers the refusal as an error and saves nothing", async () => {
    const pad = makePad();
    pad.write("# Plan\n");
    const ctx = makeCtx(pad);
    const res = await callTool(ctx, "write_scratchpad", { content: "z".repeat(MAX + 42) });
    expect(res.isError).toBe(true);
    expect(res.text).toBe(
      `write_scratchpad refused: the scratchpad would be ${MAX + 42} chars, over its ${MAX}-char cap. ` +
        "Nothing was saved. Condense the scratchpad, then try again.",
    );
    expect(pad.read()).toBe("# Plan\n");
    const ok = await callTool(ctx, "write_scratchpad", { content: "z".repeat(MAX) });
    expect(ok).toEqual({ text: `written (${MAX} chars)` });
  });
});

describe("the old truncation marker", () => {
  test("is stripped on read wherever it sits, and never written back", () => {
    // A model's read-modify-write carried it mid-file once it prepended.
    const pad = makePad();
    writeFileSync(pad.path, `# Log\nturn 9\n# Notes\nkeep this${MARKER}\nappended later`, "utf8");
    expect(pad.read()).toBe("# Log\nturn 9\n# Notes\nkeep this\nappended later");
    expect(pad.write(`top\n${readFileSync(pad.path, "utf8")}`).ok).toBe(true);
    expect(readFileSync(pad.path, "utf8")).not.toContain("[scratchpad truncated");
  });

  test("a pad the old cut left at the cap plus its marker reads as at the cap, and edits in place", () => {
    const pad = makePad();
    writeFileSync(pad.path, `${"a".repeat(MAX - 5)}tail.${MARKER}`, "utf8");
    expect(pad.read().length).toBe(MAX);
    expect(pad.edit("tail.", "TAIL.").ok).toBe(true);
    expect(readFileSync(pad.path, "utf8")).toBe(`${"a".repeat(MAX - 5)}TAIL.`);
    expect(stripLegacyMarker("no marker here")).toBe("no marker here");
  });
});

describe("a pad already over the cap at resume", () => {
  // Possible only from outside the refusal: a pad written before it, or a cap
  // lowered under one. It stays readable; the next write that would grow it is
  // refused, and a write that leaves it no larger — the condensing the refusal
  // asks for, one edit at a time — is accepted.
  const over = (): Scratchpad => {
    const pad = makePad();
    writeFileSync(pad.path, `# Old notes\n${"o".repeat(MAX + 488)}`, "utf8");
    return pad;
  };

  test("stays readable and says it is over the cap", () => {
    const pad = over();
    expect(pad.read().length).toBe(MAX + 500);
    expect(scratchpadSizeLabel(pad.read().length)).toBe("32.5k/32k, over the cap");
  });

  test("a growing write is refused; a shrinking one is accepted even while still over", () => {
    const pad = over();
    expect(pad.append("one more").ok).toBe(false);
    expect(pad.edit("# Old notes", "# Old notes, longer").ok).toBe(false);
    expect(pad.read().length).toBe(MAX + 500);
    const shrink = pad.edit("# Old notes\n", "");
    expect(shrink).toMatchObject({ ok: true, chars: MAX + 488 });
    expect(pad.write(pad.read().slice(0, MAX - 2)).ok).toBe(true);
    // Under the cap now, it is held to it like any other pad (an append adds
    // a newline before its text).
    expect(pad.append("xy").ok).toBe(false);
    expect(pad.append("x")).toEqual({ ok: true, chars: MAX });
  });
});
