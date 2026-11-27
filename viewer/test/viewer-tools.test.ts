/**
 * `/api/tools` is the runner's own tool list, served rather than copied: the
 * dashboard's inspector shows what a run is actually given, and this pins the
 * route to `toolsFor` at runtime, over the fixed loop's launch default, so the
 * two cannot drift.
 */

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { defaultLoopOf } from "../../runner/src/config";
import { DEFAULT_DRIVER, harnessOf } from "../../runner/src/drivers";
import { toolsFor } from "../../runner/src/tools";
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
  test("the list is the fixed loop's launch default: the program loop with yield", () => {
    // A change of the default moves the homepage with it; this names the move.
    expect(harnessOf(DEFAULT_DRIVER)).toBe("wrathbench");
    expect(defaultLoopOf({ driver: DEFAULT_DRIVER })).toEqual({ loop: "program", yield: true });
    expect(servedTools()).toEqual(toolsFor({ programTools: { yield: true } }));
    expect(servedTools().map((t) => t.name)).toEqual([
      "run_snippet",
      "read_file",
      "write_file",
      "edit_file",
      "delete_file",
      "start_routine",
      "stop_routine",
      "yield",
      "recent_events",
      "state_summary",
      "search_reference",
      "write_scratchpad",
      "edit_scratchpad",
      "reflect",
      "log_status",
      "read_log",
    ]);
  });

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

  test("the file and routine examples tell one story: the edit finds its text, the routine is the one written", () => {
    const write = JSON.parse(TOOL_EXAMPLES["write_file"]!) as { path: string; content: string };
    const edit = JSON.parse(TOOL_EXAMPLES["edit_file"]!) as { path: string; old: string };
    const start = JSON.parse(TOOL_EXAMPLES["start_routine"]!) as { name: string; args: Record<string, unknown> };
    expect(edit.path).toBe(write.path);
    expect(write.content.split(edit.old).length).toBe(2);
    expect(write.content).toContain(`export async function ${start.name}(args)`);
    for (const k of Object.keys(start.args)) expect(write.content).toContain(`args.${k}`);
    expect(JSON.parse(TOOL_EXAMPLES["stop_routine"]!)).toEqual({ name: start.name });
  });

  test("the route serves in public mode, and the projection passes it through whole", async () => {
    const runs = tempDir("viewer-tools-");
    const handle = createApi({ runsDir: runs, tilesDir: join(runs, "minimap"), publicMode: true, moduleUrl: "http://127.0.0.1:1" });
    const res = await handle(new Request("http://x/api/tools"));
    expect(res.status).toBe(200);
    expect(projectTools(toolsResponse())).toEqual(toolsResponse());
  });
});
