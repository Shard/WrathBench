/**
 * The homepage's group-owned sections (`src/lib/homegroups.ts`): the tool
 * list is the runner group's and the ladder the evals group's, neither shown
 * before `/api/info` answers, and the page asks for neither's data until the
 * shell's groups say it is there.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { homeGroups } from "../src/lib/homegroups";

const home = readFileSync(fileURLToPath(new URL("../src/pages/Home.tsx", import.meta.url)), "utf8");

describe("homeGroups", () => {
  test("nothing before /api/info, everything on an info that names no groups", () => {
    expect(homeGroups(undefined)).toEqual({ tools: false, ladder: false });
    expect(homeGroups({})).toEqual({ tools: true, ladder: true });
  });

  test("a viewer-only deployment shows neither; each follows its own group", () => {
    expect(homeGroups({ groups: { runner: false, evals: false, viewer: true } })).toEqual({ tools: false, ladder: false });
    expect(homeGroups({ groups: { runner: true, evals: false, viewer: true } })).toEqual({ tools: true, ladder: false });
    expect(homeGroups({ groups: { runner: false, evals: true, viewer: true } })).toEqual({ tools: false, ladder: true });
  });

  test("the page asks for the tools only through the groups, and draws them only when shown", () => {
    expect(home).toContain("(await feeds.groups()).runner ? api.tools()");
    expect(home).toContain("<Show when={shown().tools}>");
    expect(home).toContain("<Show when={evals()}>");
  });
});
