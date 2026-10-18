/**
 * The render rig's parts that need no browser: the fixture runs read the way
 * the rig relies on (one live with a trace to now, one ended), the named
 * states follow the runs it picked, and the CLI's arguments. The browser half
 * is run by hand (`bun wb dashboard shots`); CI has no Chromium.
 */

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { createApi } from "../runner/viewer/api";
import { localRunStore } from "../runner/viewer/clickhouse";
import { defaultStates, parseCli, pathName } from "./dashboard-shots";
import { ENDED_RUN, LIVE_RUN, writeFixture } from "./shots/fixture";
import { tempDirs } from "./temp-dirs";

const tmp = tempDirs();

describe("the fixture", () => {
  test("the viewer reads one live run with a trace to now and one ended run, and the sheet travels with the trace", async () => {
    const root = tmp("shots-fixture-");
    const runsDir = join(root, "runs");
    const now = Date.now();
    const f = writeFixture(runsDir, now);
    f.tick(now + 5_000);
    try {
      const api = createApi({ runsDir, tilesDir: join(root, "no-tiles"), store: localRunStore(runsDir), configDbPath: join(root, "config.sqlite") });
      const body = (await (await api(new Request("http://127.0.0.1/api/runs"))).json()) as unknown;
      const rows = (Array.isArray(body) ? body : (body as { runs: unknown[] }).runs) as { runId: string; live: boolean; terminationReason: string | null; character: string | null }[];
      const live = rows.find((r) => r.runId === LIVE_RUN)!;
      const ended = rows.find((r) => r.runId === ENDED_RUN)!;
      expect(live).toMatchObject({ live: true, terminationReason: null, character: "Fixturewick" });
      expect(ended).toMatchObject({ live: false, terminationReason: "episode-limit" });
      const index = (await (await api(new Request(`http://127.0.0.1/api/run/${LIVE_RUN}/trace`))).json()) as { segs: [number, number][]; tail: unknown };
      // Twenty minutes written close three five-minute windows at least, and leave an open tail.
      expect(index.segs.reduce((n, r) => n + r[1], 0)).toBeGreaterThanOrEqual(3);
      expect(index.tail).not.toBeNull();
      const replay = (await (await api(new Request(`http://127.0.0.1/api/run/${ENDED_RUN}/trace`))).json()) as { segs: [number, number][] };
      expect(replay.segs.reduce((n, r) => n + r[1], 0)).toBeGreaterThan(25);
    } finally {
      f.close();
    }
  });
});

describe("the named states", () => {
  test("follow the runs the rig picked", () => {
    expect(defaultStates("a", "b", "Cee").map((s) => s.name)).toEqual(["home", "run-live", "map-live", "map-live-selected", "map-replay"]);
    expect(defaultStates(null, null, null).map((s) => s.name)).toEqual(["home", "map-live"]);
    expect(defaultStates(null, "b", null).find((s) => s.name === "map-replay")).toMatchObject({ path: "/map?run=b", seek: 0.5 });
  });

  test("a --path is named after itself", () => {
    expect(pathName("/run/x?y=1")).toBe("path-run-x-y-1");
    expect(pathName("/")).toBe("path-root");
  });
});

describe("the CLI", () => {
  test("defaults: both sites, a desktop viewport, the dark scheme, Wowhead stubbed", () => {
    const c = parseCli([], new Date(0));
    if ("error" in c) throw new Error(c.error);
    expect(c).toMatchObject({ sites: ["private", "public"], viewport: { width: 1440, height: 900 }, scheme: "dark", wowhead: "stub", serve: false });
  });

  test("flags", () => {
    const c = parseCli(["--site", "public", "--viewport", "390x844", "--scheme", "light", "--real-wowhead", "--run", "a", "--run", "b", "--path", "/runs"]);
    if ("error" in c) throw new Error(c.error);
    expect(c).toMatchObject({ sites: ["public"], viewport: { width: 390, height: 844 }, scheme: "light", wowhead: "real", runs: ["a", "b"], paths: ["/runs"] });
    expect("error" in parseCli(["--path", "runs"])).toBe(true);
    expect("error" in parseCli(["--viewport", "big"])).toBe(true);
    expect("error" in parseCli(["--nope"])).toBe(true);
  });
});
