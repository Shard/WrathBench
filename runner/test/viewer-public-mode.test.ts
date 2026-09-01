/**
 * Public mode is a boundary, not a set of routes an operator has to remember.
 *
 * GitHub issue #30: a viewer started with `WRATHBENCH_VIEWER_PUBLIC=1` used to
 * serve `/track`, the run detail and every aggregate route unprojected, so
 * whether a public deployment leaked depended on which URL was asked for. It
 * now serves every JSON body through the same allowlist the static snapshot
 * publishes through, and withholds what has no projected form (raw lines,
 * tiles, the SSE tail).
 *
 * The assertions below are value-based, over a poisoned runs directory
 * (`fixtures/poisoned-runs.ts`): each `POISON` string sits in a field the
 * projection withholds, and none may appear in any public body — while each
 * `SURVIVES` string sits in a field the operator decided is published (names
 * and ids, the character name, the model's own words: docs/DATA-AND-LEGAL.md,
 * "Trajectory logs", 2026-08-30) and is asserted PRESENT, so tightening the
 * projection past the operator's decision fails here rather than passing
 * quietly.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createApi } from "../viewer/api";
import {
  CHARACTER_NAME,
  DEAD_RUN,
  LIVE_RUN,
  POISON,
  POISON_PID,
  SECRET,
  SURVIVES,
  poisonedRunsDir,
} from "./fixtures/poisoned-runs";

function handleFor(runs: string, publicMode: boolean): (req: Request) => Promise<Response> {
  return createApi({
    runsDir: runs,
    tilesDir: join(runs, "tiles-unused"),
    publicMode,
    moduleUrl: "http://127.0.0.1:1",
  });
}

async function get(handle: (req: Request) => Promise<Response>, path: string): Promise<Response> {
  return await handle(new Request(`http://viewer.local${path}`));
}

/** Every JSON route a public reader could reach, with a run id substituted in. */
const JSON_ROUTES = [
  "/api",
  "/api/info",
  "/api/runs",
  "/api/positions",
  "/api/episodes",
  "/api/tools",
  "/api/campaigns",
  "/api/results?episode=all&includeOverrides=1",
  "/api/results?episode=e90",
  "/api/ladder?episode=e90",
  "/api/ladder?episode=freeplay",
  "/api/fleet",
  "/api/models",
  `/api/run/${DEAD_RUN}`,
  `/api/run/${DEAD_RUN}/track`,
  `/api/run/${DEAD_RUN}/entries?limit=200`,
  `/api/run/${LIVE_RUN}`,
  `/api/run/${LIVE_RUN}/track`,
  `/api/run/${LIVE_RUN}/entries?limit=200`,
] as const;

/** Routes with no projected form: public mode answers 403 rather than guessing. */
const WITHHELD_ROUTES = [`/api/run/${DEAD_RUN}/raw/0`, `/api/run/${DEAD_RUN}/stream`, "/tiles/0/0_0.png"] as const;

describe("public mode is projected everywhere", () => {
  test("no poisoned value reaches any public JSON body", async () => {
    const runs = poisonedRunsDir();
    try {
      const handle = handleFor(runs, true);
      for (const route of JSON_ROUTES) {
        const res = await get(handle, route);
        expect(`${route} -> ${res.status}`).toBe(`${route} -> 200`);
        const text = await res.text();
        for (const [name, value] of Object.entries(POISON)) {
          if (text.includes(value)) throw new Error(`${route} leaked POISON.${name}`);
        }
        if (text.includes(SECRET)) throw new Error(`${route} leaked the bearer token`);
        if (text.includes(String(POISON_PID))) throw new Error(`${route} leaked the supervisor pid`);
      }
    } finally {
      rmSync(runs, { recursive: true, force: true });
    }
  });

  test("the private handle does carry those values — the fixture is really poisoned", async () => {
    const runs = poisonedRunsDir();
    try {
      const handle = handleFor(runs, false);
      const detail = await (await get(handle, `/api/run/${DEAD_RUN}`)).text();
      expect(detail).toContain(POISON.pauseReason);
      const entries = await (await get(handle, `/api/run/${DEAD_RUN}/entries?limit=200`)).text();
      expect(entries).toContain(POISON.questDetails);
      expect(entries).toContain(POISON.wikiText);
      expect(entries).toContain(POISON.driverBin);
      const fleet = await (await get(handle, "/api/fleet")).text();
      expect(fleet).toContain(POISON.preflightTail);
      expect(fleet).toContain(String(POISON_PID));
      const runsBody = await (await get(handle, "/api/runs")).text();
      expect(runsBody).toContain(POISON.apiHost);
    } finally {
      rmSync(runs, { recursive: true, force: true });
    }
  });

  test("what the operator decided is public still ships", async () => {
    const runs = poisonedRunsDir();
    try {
      const handle = handleFor(runs, true);
      // Character names and race/class labels: operator decision, 2026-08-30.
      const track = await (await get(handle, `/api/run/${DEAD_RUN}/track`)).text();
      expect(track).toContain(CHARACTER_NAME);
      const detail = await (await get(handle, `/api/run/${DEAD_RUN}`)).text();
      expect(detail).toContain(CHARACTER_NAME);
      expect(detail).toContain(SURVIVES.terminationDetail);
      expect(detail).toContain(SURVIVES.itemName);
      // Names and ids in the feed, and the model's own words as written.
      const entries = await (await get(handle, `/api/run/${DEAD_RUN}/entries?limit=200`)).text();
      expect(entries).toContain(SURVIVES.questTitle);
      expect(entries).toContain(SURVIVES.npcName);
      expect(entries).toContain(SURVIVES.snippetCode);
      expect(entries).toContain(SURVIVES.responseText);
      // The scratchpad is the model's own notes and is served in public mode.
      const scratchpad = await (await get(handle, `/api/run/${DEAD_RUN}/scratchpad`)).text();
      expect(scratchpad).toContain(SURVIVES.scratchpad);
    } finally {
      rmSync(runs, { recursive: true, force: true });
    }
  });

  test("raw lines, tiles and the live tail are withheld", async () => {
    const runs = poisonedRunsDir();
    try {
      const handle = handleFor(runs, true);
      for (const route of WITHHELD_ROUTES) {
        const res = await get(handle, route);
        expect(`${route} -> ${res.status}`).toBe(`${route} -> 403`);
      }
    } finally {
      rmSync(runs, { recursive: true, force: true });
    }
  });

  test("the private handle still serves the SSE tail", async () => {
    const runs = poisonedRunsDir();
    try {
      const handle = handleFor(runs, false);
      const res = await get(handle, `/api/run/${DEAD_RUN}/stream`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("text/event-stream");
      // Cancel the body, or the poll interval outlives the test.
      await res.body?.cancel();
    } finally {
      rmSync(runs, { recursive: true, force: true });
    }
  });

  /*
   * The routes above are a list a future route can be added without. This is
   * the check that notices: every `/api` body in the handler is emitted
   * through `pub`, which projects it when the handle is public, so a new
   * `return json(body)` fails here rather than shipping unprojected.
   */
  test("no /api route emits a body outside the projection helper", () => {
    const src = readFileSync(join(import.meta.dir, "..", "viewer", "api.ts"), "utf8");
    expect(src).not.toContain("return json(body);");
  });
});
