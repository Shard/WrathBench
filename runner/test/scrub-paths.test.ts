/**
 * The container-path scrub (`runner/viewer/scrub-paths.ts`), and the
 * projection applying it.
 *
 * The 2026-09-11 acceptance readback found 45 container-internal paths in the
 * public set — sandbox stack traces, console lines, snippet code. The
 * operator's call that day was to strip the runner image's install prefix so
 * they read as repository paths, leaving the rest of the text as written.
 * What is pinned here is that rule and its two edges: a path under the
 * operator's own home (which contains the word `wrathbench` in this repo's
 * usual checkout) is NOT rewritten, because it is never published at all; and
 * the word on its own is not a path.
 */

import { describe, expect, test } from "bun:test";
import { CONTAINER_ROOT, LOCAL_PATH_ROOTS, scrubPathsText, scrubPathsValue } from "../viewer/scrub-paths";
import { projectEntries, projectRunDetail } from "../viewer/public-projection";

describe("the scrub itself", () => {
  test("a container-absolute path becomes the repo-relative one", () => {
    expect(scrubPathsText("at run (/wrathbench/sdk/src/client.ts:123:9)")).toBe("at run (sdk/src/client.ts:123:9)");
    expect(scrubPathsText("/wrathbench/runner/src/tools.ts")).toBe("runner/src/tools.ts");
  });

  test("a path under the operator's home is left whole, word or no word", () => {
    // Never published at all (docs/DATA-AND-LEGAL.md); the verifier's job, not
    // this module's — and rewriting it would hide a real leak.
    const host = "/home/mark/git/wrathbench/sdk/src/client.ts";
    expect(scrubPathsText(host)).toBe(host);
  });

  test("the word on its own is not a path", () => {
    for (const s of ["wrathbench is a benchmark", "the wrathbench/sdk workspace", "/wrathbench"]) {
      expect(scrubPathsText(s)).toBe(s);
    }
  });

  test("scrubbing twice is scrubbing once, which the double projection needs", () => {
    const s = "[error] /wrathbench/sdk/src/a.ts and /wrathbench/runner/b.ts";
    expect(scrubPathsText(scrubPathsText(s))).toBe(scrubPathsText(s));
    expect(scrubPathsText(s)).toBe("[error] sdk/src/a.ts and runner/b.ts");
  });

  test("the deep form walks objects, arrays and nesting, and keeps non-strings", () => {
    expect(
      scrubPathsValue({ a: ["/wrathbench/x.ts", { b: "/wrathbench/y.ts" }], n: 1, z: null }),
    ).toEqual({ a: ["x.ts", { b: "y.ts" }], n: 1, z: null });
  });

  test("the container root is on the verifier's root list, so a miss is a finding", () => {
    expect(LOCAL_PATH_ROOTS).toContain(CONTAINER_ROOT.slice(1));
  });
});

describe("the projection applies it", () => {
  test("a stack trace, a console line and snippet code come out repo-relative", () => {
    const out = projectEntries({
      from: 0,
      total: 3,
      entries: [
        {
          i: 0,
          t: "snippet_result",
          ts: 1,
          start: 0,
          end: 1,
          turn: 1,
          call: 1,
          name: "run_snippet",
          isError: true,
          text:
            "[log] reading /wrathbench/data/runs/x\n" +
            "TypeError: undefined is not a function\n" +
            "    at move (/wrathbench/sdk/src/client.ts:123:9)\n" +
            "    at <anonymous> (/wrathbench/runner/src/sandbox.ts:44:1)",
        },
        { i: 1, t: "snippet", ts: 2, start: 2, end: 3, turn: 1, call: 2, code: 'import { sdk } from "/wrathbench/sdk/src/index.ts";' },
        { i: 2, t: "response", ts: 3, start: 4, end: 5, turn: 1, text: "the trace points at /wrathbench/sdk/src/client.ts", tools: [] },
      ],
    } as never);
    const text = JSON.stringify(out);
    expect(text).not.toContain("/wrathbench/");
    expect(text).toContain("sdk/src/client.ts:123:9");
    expect(text).toContain("data/runs/x");
    expect(text).toContain('import { sdk } from \\"sdk/src/index.ts\\"');
    // The model's sentence is otherwise as written: only the prefix changed.
    expect((out.entries[2] as unknown as { text: string }).text).toBe("the trace points at sdk/src/client.ts");
  });

  test("a free-text field outside the entry window is covered too", () => {
    const out = projectRunDetail({
      run: {
        runId: "r1",
        comparability: null,
        items: null,
        terminationDetail: "sandbox died: /wrathbench/runner/src/confine.ts:8",
      },
      states: [],
      total: 0,
      tokens: {},
      cost: { breakdown: null, actual: { breakdown: null }, expected: { breakdown: null } },
      playtimeMs: 0,
    } as never);
    expect(out.run.terminationDetail).toBe("sandbox died: runner/src/confine.ts:8");
  });
});
