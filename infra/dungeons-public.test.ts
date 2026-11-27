/**
 * The dungeon board on either handle: one table, the Deadmines eval
 * `deadmines-solo`, with its runs, since such an attempt is the one fan-out
 * run a public handle publishes (operator delegated, 2026-11-15). The
 * five-agent `deadmines` has no table and is named on neither About nor a
 * model row: it runs only as a probe campaign for now (operator,
 * 2026-11-15). Every other fan-out run stays withheld: the shots fixture's
 * two probe fan-out runs are in no public body and come back as withdrawn.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApi } from "../viewer/api";
import { renderSnapshot } from "../viewer/snapshot";
import { verifyPublication } from "./publish-accept";
import type { DungeonsResponse, EpisodesResponse } from "../viewer/api-types";
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
  test("either handle serves the one table, deadmines-solo's, with its runs", async () => {
    for (const publicMode of [false, true]) {
      const body = (await (await get(publicMode, "/api/dungeons")).json()) as DungeonsResponse;
      expect({ publicMode, boards: body.boards.map((b) => [b.episode, b.rows.length]) }).toEqual({
        publicMode,
        boards: [["deadmines-solo", 2]],
      });
      const solo = JSON.stringify(body.boards.find((b) => b.episode === "deadmines-solo"));
      for (const id of SOLO) expect({ publicMode, id, named: solo.includes(`"${id}"`) }).toEqual({ publicMode, id, named: true });
      // Each row carries its best attempt's cost, the provider's charge summed over its responses, on either handle.
      const costs = body.boards[0]!.rows.map((r) => [r.best.runIds[0], r.best.costUsd === null ? null : Number(r.best.costUsd.toFixed(2))]).sort();
      expect({ publicMode, costs }).toEqual({ publicMode, costs: [[DUNGEON_SOLO_RUN, 0.36], [DUNGEON_SOLO_CLEARED_RUN, 4.2]].sort() });
      // The route's seven are its bosses; Cookie, killed on the ship, rides beside them as the extra.
      const bosses = body.boards[0]!.rows.map((r) => [r.best.runIds[0], r.best.bosses.length, r.best.cookie]).sort();
      expect({ publicMode, bosses }).toEqual({ publicMode, bosses: [[DUNGEON_SOLO_RUN, 3, false], [DUNGEON_SOLO_CLEARED_RUN, 7, true]].sort() });
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

  test("About lists the Deadmines eval and not the five-agent id; the private list has both", async () => {
    const ids = async (publicMode: boolean) => ((await (await get(publicMode, "/api/episodes")).json()) as EpisodesResponse).episodes.map((e) => e.id);
    expect(await ids(true)).toContain("deadmines-solo");
    expect(await ids(true)).not.toContain("deadmines");
    expect(await ids(false)).toContain("deadmines");
  }, 60_000);
});

describe("a publisher pass over the fixture", () => {
  test("publishes the solo runs and the board, withdraws the probe fan-out runs, and site verify finds nothing", async () => {
    const res = await renderSnapshot({ runsDir });
    const objects = new Map(res.artifacts.map((a) => [a.path, a.body]));
    // A clip's video and poster are streamed beside the bodies; site verify only looks them up.
    const media = new Set((res.media ?? []).map((m) => m.path));
    for (const id of SOLO) expect({ id, published: [...objects.keys()].some((k) => k.startsWith(`v1/run/${id}/`)) }).toEqual({ id, published: true });
    for (const id of PROBES) {
      expect(res.withdrawn).toContain(id);
      for (const [key, body] of objects) expect({ key, id, named: key.includes(id) || body.includes(id) }).toEqual({ key, id, named: false });
    }
    for (const id of SOLO) expect(res.withdrawn).not.toContain(id);
    // The solo runs' grant (FIXTURE2-5 are in no other run's config) and the
    // characters' session ids are in the raw files, and in no published body.
    for (const [key, body] of objects) {
      expect({ key, grant: /FIXTURE[2-5]/.test(body), token: body.includes("fixture-token"), session: SOLO.some((id) => body.includes(`${id}~`)) }).toEqual({ key, grant: false, token: false, session: false });
    }
    const dungeons = JSON.parse(objects.get(res.snap["dungeons.json"]!)!) as DungeonsResponse;
    expect(dungeons.boards.map((b) => b.episode)).toEqual(["deadmines-solo"]);
    const episodes = JSON.parse(objects.get(res.snap["episodes.json"]!)!) as EpisodesResponse;
    expect(episodes.episodes.map((e) => e.id).filter((id) => id.startsWith("deadmines"))).toEqual(["deadmines-solo"]);
    const report = await verifyPublication({ get: async (key) => objects.get(key) ?? (media.has(key) ? "" : null) });
    expect(report.findings).toEqual([]);
    expect(report.missing).toEqual([]);
    expect(report.objects).toBeGreaterThan(50);
    // dungeons.json is re-projected too: a field the projection does not name is drift.
    const key = res.snap["dungeons.json"]!;
    const smuggled = JSON.parse(objects.get(key)!) as { boards: Record<string, unknown>[] };
    smuggled.boards[0]!["accounts"] = ["FIXTURE1"];
    const drifted = await verifyPublication({ get: async (k) => (k === key ? JSON.stringify(smuggled) : (objects.get(k) ?? (media.has(k) ? "" : null))) });
    expect(drifted.findings.some((f) => f.kind === "projection-drift" && f.key === key)).toBe(true);
  }, 120_000);
});
