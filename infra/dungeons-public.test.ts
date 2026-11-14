/**
 * The dungeon board on a public handle (operator's call pending): the
 * one-agent id's table is not served at all, since every run of it is a
 * fan-out run and a public handle withholds those; the five-agent table is
 * served with its rows. A private handle serves both.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApi } from "../runner/viewer/api";
import type { DungeonsResponse } from "../runner/viewer/api-types";
import { writeFixture } from "./shots/fixture";

describe("/api/dungeons", () => {
  test("a public handle serves the five-agent table only; a private one both", async () => {
    delete process.env["CLICKHOUSE_URL"];
    const runsDir = mkdtempSync(join(tmpdir(), "wb-dungeons-"));
    const f = writeFixture(runsDir);
    await f.ready;
    const read = async (publicMode: boolean): Promise<DungeonsResponse> =>
      (await (await createApi({ runsDir, tilesDir: join(runsDir, "no-tiles"), publicMode, moduleUrl: "http://127.0.0.1:1" } as Parameters<typeof createApi>[0])(new Request("http://x/api/dungeons"))).json()) as DungeonsResponse;
    const priv = await read(false);
    expect(priv.boards.map((b) => [b.episode, b.rows.length])).toEqual([
      ["deadmines-solo", 2],
      ["deadmines", 1],
    ]);
    const pub = await read(true);
    expect(pub.boards.map((b) => [b.episode, b.rows.length])).toEqual([["deadmines", 1]]);
    expect(JSON.stringify(pub)).not.toContain("fixture-dm-solo");
  }, 60_000);
});
