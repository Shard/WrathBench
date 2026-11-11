/**
 * The inspector inside the viewer: its API mounted over the runs
 * (`runs-source.ts`) on a private handle, a v1 run listed and read under its
 * run id, a 0.5 run opened through the adapter though never listed, and the
 * packed trace the same bytes whether asked of the inspector or of the run's
 * own route. The public handle withholds the mount whole
 * (`viewer-public-mode.test.ts`).
 */

import { describe, expect, setSystemTime, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createApi } from "../viewer/api";
import { renderSnapshot } from "../viewer/snapshot";
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
    const list = (await (await get(h, "/api/inspector/sessions")).json()) as { sessions: { id: string; session: { id: string; character: { name: string } } }[] };
    expect(list.sessions.map((s) => s.id)).toEqual([V1P1_RUN]);
    expect(list.sessions[0]!.session.character.name).toBe("Testwick");
    // The record's own `id` is presented as the run id, here and in the detail.
    expect(list.sessions[0]!.session.id).toBe(V1P1_RUN);
    const one = (await (await get(h, `/api/inspector/sessions/${V1P1_RUN}`)).json()) as { id: string; session: { id: string } };
    expect(one).toMatchObject({ id: V1P1_RUN, session: { id: V1P1_RUN } });
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

/**
 * The record's `id` is the session token's fingerprint, which is also the
 * stem of the module's audit files: never served (skill `fleet-readonly`).
 * The viewer has no login on the LAN, so no response it gives, private or
 * public, and no object the publisher renders, may carry it.
 */
describe("the session token's fingerprint", () => {
  /** `v1p1-solo`'s `session.json` id; the fixture is frozen, so this is too. */
  const FINGERPRINT = "f1c7a5e5e5510001";
  const T0 = 1762000200000;
  const RANGE = "from=1762000000000&to=1762002000000";
  const STREAMS = ["trace", "events", "calls", "nearby"] as const;

  const paths = [
    "/api/inspector/sessions",
    `/api/inspector/sessions/${V1P1_RUN}`,
    ...STREAMS.map((s) => `/api/inspector/sessions/${V1P1_RUN}/rows/${s}?${RANGE}`),
    ...STREAMS.map((s) => `/api/inspector/sessions/${V1P1_RUN}/tail/${s}?from=start`),
    `/api/inspector/sessions/${V1P1_RUN}/trace`,
    `/api/inspector/sessions/${V1P1_RUN}/trace/${T0}`,
    `/api/inspector/sessions/${V1P1_RUN}/recent`,
    `/api/inspector/sessions/${V1P1_RUN}/nearby`,
    `/api/inspector/sessions/${V1P1_RUN}/moves`,
    "/api",
    "/api/info",
    "/api/runs",
    "/api/positions",
    "/api/episodes",
    "/api/campaigns",
    "/api/results",
    "/api/ladder",
    "/api/fleet",
    "/api/models",
    `/api/character/${V1P1_RUN}`,
    `/api/run/${V1P1_RUN}`,
    `/api/run/${V1P1_RUN}/track`,
    `/api/run/${V1P1_RUN}/trace`,
    `/api/run/${V1P1_RUN}/trace/${T0}`,
    `/api/run/${V1P1_RUN}/nearby`,
    `/api/run/${V1P1_RUN}/entries?from=0`,
    ...[0, 1, 2, 3].map((n) => `/api/run/${V1P1_RUN}/raw/${n}`),
    `/api/run/${V1P1_RUN}/scratchpad`,
    `/api/run/${V1P1_RUN}/stream`,
  ];

  /** A response's body as text; an event stream is read for a few frames and then cancelled. */
  async function bodyOf(res: Response): Promise<string> {
    if (!(res.headers.get("content-type") ?? "").startsWith("text/event-stream")) return await res.text();
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let out = "";
    for (let i = 0; i < 8; i++) {
      const next = await Promise.race([reader.read(), Bun.sleep(250).then(() => null)]);
      if (next === null || next.done) break;
      out += dec.decode(next.value);
    }
    await reader.cancel();
    return out;
  }

  for (const publicMode of [false, true]) {
    test(`no response of the ${publicMode ? "public" : "private"} viewer carries it`, async () => {
      const runs = tempDir("viewer-inspector-fp-");
      const dir = materialiseV1p1(runs, { sqlite: true });
      expect(readFileSync(join(dir, "session", "session.json"), "utf8")).toContain(FINGERPRINT);
      const h = createApi({ runsDir: runs, tilesDir: join(runs, "no-tiles"), publicMode, moduleUrl: "http://127.0.0.1:1" });
      const served: string[] = [];
      for (const path of paths) {
        const res = await get(h, path);
        const body = await bodyOf(res);
        if (res.status === 200) served.push(path);
        expect({ path, leaks: body.includes(FINGERPRINT) }).toEqual({ path, leaks: false });
      }
      // The walk reached the routes that read the record, not only 404s.
      if (!publicMode) expect(served).toEqual(expect.arrayContaining(paths.filter((p) => p.startsWith("/api/inspector/"))));
    });
  }

  test("no object the publisher renders carries it", async () => {
    const runs = tempDir("viewer-inspector-fp-pub-");
    materialiseV1p1(runs);
    const r = await renderSnapshot({ runsDir: runs, configDbPath: join(runs, "no-config.sqlite"), moduleUrl: "http://127.0.0.1:1" });
    expect(r.artifacts.length).toBeGreaterThan(0);
    expect(r.artifacts.filter((a) => a.body.includes(FINGERPRINT)).map((a) => a.path)).toEqual([]);
  });
});
