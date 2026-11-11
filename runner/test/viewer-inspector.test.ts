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
import { FANOUT_ROSTER_TOKEN, FANOUT_RUN, writeFanoutRun } from "./fixtures/fanout";
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

describe("a fan-out run in the inspector's API", () => {
  test("each character is a session under <run-id>~<Character>, grouped by the run; the single run keeps its bytes", async () => {
    const runs = tempDir("viewer-inspector-fanout-");
    materialiseV1p1(runs);
    const single = viewer(runs);
    const before = await (await get(single, "/api/inspector/sessions")).text();
    await writeFanoutRun(runs);
    const h = viewer(runs);
    const list = (await (await get(h, "/api/inspector/sessions")).json()) as { sessions: { id: string; group?: string; session: { character: { name: string } } }[] };
    const byId = new Map(list.sessions.map((s) => [s.id, s]));
    expect([...byId.keys()].sort()).toEqual([`${FANOUT_RUN}~Alfa`, `${FANOUT_RUN}~Bravo`, V1P1_RUN]);
    expect(byId.get(`${FANOUT_RUN}~Alfa`)!.group).toBe(FANOUT_RUN);
    expect(byId.get(`${FANOUT_RUN}~Bravo`)!.session.character.name).toBe("Bravo");
    // The single-character run's entry carries no group, and is the bytes it was.
    expect("group" in byId.get(V1P1_RUN)!).toBe(false);
    const solo = (JSON.parse(before) as { sessions: unknown[] }).sessions[0];
    expect(list.sessions.find((s) => s.id === V1P1_RUN)).toEqual(solo as (typeof list.sessions)[number]);
    expect(JSON.stringify(list)).not.toContain(FANOUT_ROSTER_TOKEN);
  });

  test("a character opens by its composite id, and its packed windows carry it as `run`", async () => {
    const runs = tempDir("viewer-inspector-fanout-open-");
    await writeFanoutRun(runs);
    const h = viewer(runs);
    const one = (await (await get(h, `/api/inspector/sessions/${FANOUT_RUN}~Alfa`)).json()) as { id: string; session: { character: { name: string } } };
    expect(one.id).toBe(`${FANOUT_RUN}~Alfa`);
    expect(one.session.character.name).toBe("Alfa");
    const index = (await (await get(h, `/api/inspector/sessions/${FANOUT_RUN}~Alfa/trace`)).json()) as { segs: [number, number][] };
    const t0 = index.segs[0]![0];
    const seg = (await (await get(h, `/api/inspector/sessions/${FANOUT_RUN}~Alfa/trace/${t0}`)).json()) as { run: string };
    expect(seg.run).toBe(`${FANOUT_RUN}~Alfa`);
  });

  test("the run's own id, an unknown character and anything but letters open nothing", async () => {
    const runs = tempDir("viewer-inspector-fanout-bad-");
    materialiseV1p1(runs);
    await writeFanoutRun(runs);
    const h = viewer(runs);
    for (const id of [FANOUT_RUN, `${FANOUT_RUN}~Charlie`, `${FANOUT_RUN}~alfa1`, `${FANOUT_RUN}~..%2F..%2F${V1P1_RUN}%2Fsession`, `${FANOUT_RUN}~`, `${V1P1_RUN}~Testwick`, `~Alfa`, `${FANOUT_RUN}~Alfa~Bravo`]) {
      expect({ id, status: (await get(h, `/api/inspector/sessions/${id}`)).status }).toEqual({ id, status: 404 });
    }
  });
});
