/**
 * `/api/tools` is the runner's own tool list, served rather than copied: the
 * dashboard's inspector shows what a run is actually given, and this pins the
 * route to `TOOLS` at runtime so the two cannot drift.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TOOLS } from "../src/tools";
import { createApi } from "../viewer/api";
import { projectTools } from "../viewer/public-projection";
import { TOOL_EXAMPLES, toolsResponse } from "../viewer/tools";
import type { ToolsResponse } from "../viewer/api-types";

function api(): (r: Request) => Promise<Response> {
  const runs = mkdtempSync(join(tmpdir(), "viewer-tools-"));
  return createApi({ runsDir: runs, tilesDir: join(runs, "minimap"), moduleUrl: "http://127.0.0.1:1" });
}

describe("/api/tools", () => {
  test("names and descriptions are TOOLS, in order, with an example each", async () => {
    const res = await api()(new Request("http://x/api/tools"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as ToolsResponse;
    expect(body.tools.map((t) => t.name)).toEqual(TOOLS.map((t) => t.name));
    expect(body.tools.map((t) => t.description)).toEqual(TOOLS.map((t) => t.description));
    expect(body.tools.map((t) => t.inputSchema)).toEqual(TOOLS.map((t) => t.inputSchema));
    for (const t of body.tools) expect(t.example.length).toBeGreaterThan(0);
  });

  test("every tool has an example and no example names a tool that is gone", () => {
    expect(Object.keys(TOOL_EXAMPLES).sort()).toEqual(TOOLS.map((t) => t.name).sort());
  });

  test("the route serves in public mode, and the projection passes it through whole", async () => {
    const runs = mkdtempSync(join(tmpdir(), "viewer-tools-"));
    const handle = createApi({ runsDir: runs, tilesDir: join(runs, "minimap"), publicMode: true, moduleUrl: "http://127.0.0.1:1" });
    const res = await handle(new Request("http://x/api/tools"));
    expect(res.status).toBe(200);
    expect(projectTools(toolsResponse())).toEqual(toolsResponse());
  });
});
