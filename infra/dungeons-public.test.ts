/**
 * The dungeon board on a public handle: both tables are served, the
 * one-agent id's with its runs, since a `deadmines-solo` attempt is the one
 * fan-out run a public handle publishes (operator delegated, 2026-11-15).
 * Every other fan-out run stays withheld: the shots fixture's two probe
 * fan-out runs are in no public body and come back as withdrawn.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApi } from "../runner/viewer/api";
import { renderSnapshot } from "../runner/viewer/snapshot";
import { verifyPublication } from "./publish-accept";
import type { DungeonsResponse, EpisodesResponse } from "../runner/viewer/api-types";
import { DUNGEON_SOLO_CLEARED_RUN, DUNGEON_SOLO_RUN, FANOUT_LIVE_RUN, FANOUT_RUN, writeFixture } from "./shots/fixture";

const SOLO = [DUNGEON_SOLO_RUN, DUNGEON_SOLO_CLEARED_RUN];
const PROBES = [FANOUT_RUN, FANOUT_LIVE_RUN];

let runsDir: string;
const handle = (publicMode: boolean) => createApi({ runsDir, tilesDir: join(runsDir, "no-tiles"), publicMode, moduleUrl: "http://127.0.0.1:1" } as Parameters<typeof createApi>[0]);
const get = async (publicMode: boolean, path: string): Promise<Response> => await handle(publicMode)(new Request(`http://x${path}`));

beforeAll(async () => {
  delete process.env["CLICKHOUSE_URL"];
  runsDir = mkdtempSync(join(tmpdir(), "wb-dungeons-"));
  await writeFixture(runsDir).ready;
}, 60_000);

describe("/api/dungeons", () => {
  test("either handle serves both tables, with the one-agent id's runs", async () => {
    for (const publicMode of [false, true]) {
      const body = (await (await get(publicMode, "/api/dungeons")).json()) as DungeonsResponse;
      expect({ publicMode, boards: body.boards.map((b) => [b.episode, b.rows.length]) }).toEqual({
        publicMode,
        boards: [
          ["deadmines-solo", 2],
          ["deadmines", 1],
        ],
      });
      const solo = JSON.stringify(body.boards.find((b) => b.episode === "deadmines-solo"));
      for (const id of SOLO) expect({ publicMode, id, named: solo.includes(`"${id}"`) }).toEqual({ publicMode, id, named: true });
    }
  }, 60_000);
});

describe("the one fan-out exception, on a public handle", () => {
  test("the solo runs are listed and served; the probe fan-out runs are not", async () => {
    for (const route of ["/api/runs", "/api/results?episode=all&includeOverrides=1", "/api/results?episode=deadmines-solo"]) {
      const text = await (await get(true, route)).text();
      for (const id of SOLO) expect({ route, id, named: text.includes(`"${id}"`) }).toEqual({ route, id, named: true });
      for (const id of PROBES) expect({ route, id, named: text.includes(id) }).toEqual({ route, id, named: false });
    }
    for (const route of ["/api/positions", "/api/fleet", "/api/dungeons", "/api/episodes", "/api/models", "/api/campaigns"]) {
      const text = await (await get(true, route)).text();
      for (const id of PROBES) expect({ route, id, named: text.includes(id) }).toEqual({ route, id, named: false });
    }
    for (const id of SOLO) expect({ id, status: (await get(true, `/api/run/${id}`)).status }).toEqual({ id, status: 200 });
    for (const id of PROBES) {
      for (const rest of ["", "/track", "/entries?limit=10"]) {
        expect({ id, rest, status: (await get(true, `/api/run/${id}${rest}`)).status }).toEqual({ id, rest, status: 404 });
      }
    }
    const withdrawn = await handle(true).unpublishedRuns();
    for (const id of PROBES) expect(withdrawn).toContain(id);
    for (const id of SOLO) expect(withdrawn).not.toContain(id);
  }, 60_000);

  test("a solo run's public detail names no character session and no account", async () => {
    for (const id of SOLO) {
      const text = await (await get(true, `/api/run/${id}`)).text();
      const detail = JSON.parse(text) as Record<string, unknown>;
      expect({ id, fanout: "fanout" in detail, lead: "fanoutLead" in detail }).toEqual({ id, fanout: false, lead: false });
      expect(text).not.toContain(`${id}~`);
      expect(text).not.toMatch(/"FIXTURE\d"/);
      expect(text).not.toContain("fixture-token");
    }
  }, 60_000);

  test("About lists both Deadmines ids", async () => {
    const body = (await (await get(true, "/api/episodes")).json()) as EpisodesResponse;
    const ids = body.episodes.map((e) => e.id);
    expect(ids).toContain("deadmines-solo");
    expect(ids).toContain("deadmines");
  }, 60_000);
});

describe("a publisher pass over the fixture", () => {
  test("publishes the solo runs and the board, withdraws the probe fan-out runs, and site verify finds nothing", async () => {
    const res = await renderSnapshot({ runsDir });
    const objects = new Map(res.artifacts.map((a) => [a.path, a.body]));
    for (const id of SOLO) expect({ id, published: [...objects.keys()].some((k) => k.startsWith(`v1/run/${id}/`)) }).toEqual({ id, published: true });
    for (const id of PROBES) {
      expect(res.withdrawn).toContain(id);
      for (const [key, body] of objects) expect({ key, id, named: key.includes(id) || body.includes(id) }).toEqual({ key, id, named: false });
    }
    for (const id of SOLO) expect(res.withdrawn).not.toContain(id);
    const dungeons = JSON.parse(objects.get(res.snap["dungeons.json"]!)!) as DungeonsResponse;
    expect(dungeons.boards.map((b) => b.episode)).toEqual(["deadmines-solo", "deadmines"]);
    const report = await verifyPublication({ get: async (key) => objects.get(key) ?? null });
    expect(report.findings).toEqual([]);
    expect(report.missing).toEqual([]);
    expect(report.objects).toBeGreaterThan(50);
    // dungeons.json is re-projected too: a field the projection does not name is drift.
    const key = res.snap["dungeons.json"]!;
    const smuggled = JSON.parse(objects.get(key)!) as { boards: Record<string, unknown>[] };
    smuggled.boards[0]!["accounts"] = ["FIXTURE1"];
    const drifted = await verifyPublication({ get: async (k) => (k === key ? JSON.stringify(smuggled) : (objects.get(k) ?? null)) });
    expect(drifted.findings.some((f) => f.kind === "projection-drift" && f.key === key)).toBe(true);
  }, 120_000);
});
