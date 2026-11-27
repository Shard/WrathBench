/**
 * The homepage's group-owned sections (`src/lib/homegroups.ts`): the tool
 * list is the runner group's and the ladder the evals group's, and neither is
 * shown before `/api/info` answers.
 */

import { describe, expect, test } from "bun:test";
import { homeGroups } from "../src/lib/homegroups";

describe("homeGroups", () => {
  test("nothing before /api/info; a viewer-only deployment shows neither; each follows its own group", () => {
    expect(homeGroups(undefined)).toEqual({ tools: false, ladder: false });
    expect(homeGroups({})).toEqual({ tools: true, ladder: true });
    expect(homeGroups({ groups: { runner: false, evals: false, viewer: true } })).toEqual({ tools: false, ladder: false });
    expect(homeGroups({ groups: { runner: true, evals: false, viewer: true } })).toEqual({ tools: true, ladder: false });
    expect(homeGroups({ groups: { runner: false, evals: true, viewer: true } })).toEqual({ tools: false, ladder: true });
  });
});
