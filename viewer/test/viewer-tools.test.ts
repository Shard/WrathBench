/**
 * `/api/tools` is the runner's own tool list, served rather than copied: the
 * dashboard's inspector shows what a run is actually given, and this pins the
 * route to `toolsFor` at runtime, over the fixed loop's launch default, so the
 * two cannot drift.
 */

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { createApi } from "../api";
import { projectTools } from "../public-projection";
import { TOOL_EXAMPLES, TOOL_RETURNS, servedTools, toolsResponse } from "../tools";
import type { ToolsResponse } from "../api-types-runner";
import { tempDirs } from "../../runner/test/fixtures/temp-dirs";

const tempDir = tempDirs();

function api(): (r: Request) => Promise<Response> {
  const runs = tempDir("viewer-tools-");
  return createApi({ runsDir: runs, tilesDir: join(runs, "minimap"), moduleUrl: "http://127.0.0.1:1" });
}

describe("/api/tools", () => {
  test("names, descriptions and schemas are the served list's, in order, with an example or a returns line each", async () => {
    const res = await api()(new Request("http://x/api/tools"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as ToolsResponse;
    const served = servedTools();
    expect(body.tools.map((t) => t.name)).toEqual(served.map((t) => t.name));
    expect(body.tools.map((t) => t.description)).toEqual(served.map((t) => t.description));
    expect(body.tools.map((t) => t.inputSchema)).toEqual(served.map((t) => t.inputSchema));
    // Exactly one of the two per tool: an example where there are arguments, a returns line where there are none.
    for (const t of body.tools) {
      const hasArgs = Object.keys((t.inputSchema["properties"] as object) ?? {}).length > 0;
      expect(t.example !== null).toBe(hasArgs);
      expect(t.returns !== null).toBe(!hasArgs);
    }
  });

  test("examples and returns lines together cover every tool once, and name no tool that is gone", () => {
    expect([...Object.keys(TOOL_EXAMPLES), ...Object.keys(TOOL_RETURNS)].sort()).toEqual(servedTools().map((t) => t.name).sort());
  });

  test("every example is a call the tool would take: JSON, with its required arguments and no others", () => {
    // A newcomer reads these as valid calls.
    for (const t of servedTools()) {
      const ex = TOOL_EXAMPLES[t.name];
      if (ex === undefined) continue;
      const args = JSON.parse(ex) as Record<string, unknown>;
      const props = Object.keys((t.inputSchema["properties"] as object) ?? {});
      const required = (t.inputSchema["required"] as string[] | undefined) ?? [];
      expect([t.name, Object.keys(args).filter((k) => !props.includes(k))]).toEqual([t.name, []]);
      expect([t.name, required.filter((k) => !(k in args))]).toEqual([t.name, []]);
    }
  });

  test("the route serves in public mode, and the projection passes it through whole", async () => {
    const runs = tempDir("viewer-tools-");
    const handle = createApi({ runsDir: runs, tilesDir: join(runs, "minimap"), publicMode: true, moduleUrl: "http://127.0.0.1:1" });
    const res = await handle(new Request("http://x/api/tools"));
    expect(res.status).toBe(200);
    expect(projectTools(toolsResponse())).toEqual(toolsResponse());
  });
});
