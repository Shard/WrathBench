/**
 * The inspector inside the viewer: its API mounted over the runs
 * (`runs-source.ts`) on a private handle, a v1 run listed and read under its
 * run id, a 0.5 run opened through the adapter though never listed, and the
 * packed trace the same bytes whether asked of the inspector or of the run's
 * own route. The public handle withholds the mount whole
 * (`viewer-public-mode.test.ts`).
 */

import { describe, expect, setSystemTime, test } from "bun:test";
import { join } from "node:path";
import { createApi } from "../viewer/api";
import { LEGACY05_NOW, LEGACY05_WINDOWS, materialiseLegacy05 } from "./fixtures/legacy05";
import { V1P1_RUN, materialiseV1p1 } from "./fixtures/v1p1";
import { tempDirs } from "./fixtures/temp-dirs";

const tempDir = tempDirs();

function viewer(runsDir: string): (req: Request) => Promise<Response> {
  return createApi({ runsDir, tilesDir: join(runsDir, "no-tiles"), publicMode: false, moduleUrl: "http://127.0.0.1:1" });
}

const get = async (h: (req: Request) => Promise<Response>, path: string): Promise<Response> => await h(new Request(`http://127.0.0.1:8090${path}`));

describe("the inspector's API in the viewer", () => {
  test("a v1 run is a session under its run id, with its record as written", async () => {
    const runs = tempDir("viewer-inspector-v1-");
    materialiseV1p1(runs);
    const h = viewer(runs);
    const list = (await (await get(h, "/api/inspector/sessions")).json()) as { sessions: { id: string; session: { character: { name: string } } }[] };
    expect(list.sessions.map((s) => s.id)).toEqual([V1P1_RUN]);
    expect(list.sessions[0]!.session.character.name).toBe("Testwick");
    const rows = (await (await get(h, `/api/inspector/sessions/${V1P1_RUN}/rows/events?from=1762000200000&to=1762001500000`)).json()) as { rows: { kind: string }[] };
    expect(rows.rows.length).toBeGreaterThan(0);
    const fromInspector = await (await get(h, `/api/inspector/sessions/${V1P1_RUN}/trace`)).json();
    const fromRun = await (await get(h, `/api/run/${V1P1_RUN}/trace`)).json();
    expect({ ...(fromInspector as object), now: 0 }).toEqual({ ...(fromRun as object), now: 0 });
  });

  test("a 0.5 run is not listed, and opens through the adapter with the same packed windows", async () => {
    const runs = tempDir("viewer-inspector-05-");
    materialiseLegacy05(runs);
    setSystemTime(LEGACY05_NOW);
    try {
      const h = viewer(runs);
      expect(((await (await get(h, "/api/inspector/sessions")).json()) as { sessions: unknown[] }).sessions).toEqual([]);
      const t0 = LEGACY05_WINDOWS["l05-party-a1"][0]!;
      const a = await (await get(h, `/api/inspector/sessions/l05-party-a1/trace/${t0}`)).text();
      const b = await (await get(h, `/api/run/l05-party-a1/trace/${t0}`)).text();
      expect(a).toBe(b);
      expect((await get(h, "/api/inspector/sessions/l05-no-such-run")).status).toBe(404);
      expect((await get(h, "/api/inspector/sessions/..%2Fetc")).status).toBe(404);
    } finally {
      setSystemTime();
    }
  });
});
