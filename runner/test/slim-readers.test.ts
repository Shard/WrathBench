/**
 * Every reader of `request` records takes the slim shape, the full shape, and
 * a file that switches from one to the other — the freeplay run that started
 * on a build before slim records and resumed on one after.
 *
 * One run, three files: the stub-driven run as written (slim), the same run
 * as the pre-slim writer would have written it (legacy), and the first segment
 * legacy with the second slim (mixed). Each reader must give the same answer
 * on all three, because they are the same run.
 */

import { beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { EntriesResponse } from "../viewer/api-types";
import { projectEntries } from "../viewer/public-projection";
import { TrajectoryTail, scanRunTotals, type EntrySummary } from "../viewer/tail";
import { replayFile } from "../src/replay";
import { readTrajectory } from "../src/trajectory";
import { SEGMENT_TURNS, legacyVariant, slimRun } from "./fixtures/slim-run";
import { tempDirs } from "./fixtures/temp-dirs";

const tempDir = tempDirs();

const variants: Record<"slim" | "legacy" | "mixed", string> = { slim: "", legacy: "", mixed: "" };

beforeAll(async () => {
  variants.slim = (await slimRun(tempDir("wrathbench-readers-slim-"))).dir;
  variants.legacy = tempDir("wrathbench-readers-legacy-");
  legacyVariant(variants.slim, variants.legacy, () => true);
  variants.mixed = tempDir("wrathbench-readers-mixed-");
  legacyVariant(variants.slim, variants.mixed, (segment) => segment === 1);
});

const path = (dir: string): string => join(dir, "trajectory.jsonl");

async function tailOf(dir: string): Promise<TrajectoryTail> {
  const tail = new TrajectoryTail(path(dir));
  await tail.scan();
  return tail;
}

/** A summary without its byte range, which is all that differs between the files. */
function withoutRange(e: EntrySummary): Record<string, unknown> {
  const { start: _s, end: _e, ...rest } = e;
  return rest;
}

describe("the three files are the run they claim to be", () => {
  test("legacy carries full requests only, mixed switches once, slim carries none", () => {
    const shapes = (dir: string): string =>
      readTrajectory(dir)
        .filter((r) => r.t === "request")
        .map((r) => (Array.isArray(r["messages"]) ? "F" : "S"))
        .join("");
    const n1 = SEGMENT_TURNS[0] + 1;
    const n2 = SEGMENT_TURNS[1] + 1;
    expect(shapes(variants.legacy)).toBe("F".repeat(n1 + n2));
    expect(shapes(variants.mixed)).toBe("F".repeat(n1) + "S".repeat(n2));
    expect(shapes(variants.slim)).toBe("S".repeat(n1 + n2));
  });
});

describe("the viewer reads old, new and mixed alike", () => {
  test("entry summaries are identical, request counts included", async () => {
    const legacy = (await tailOf(variants.legacy)).entries.map(withoutRange);
    for (const dir of [variants.slim, variants.mixed]) {
      expect((await tailOf(dir)).entries.map(withoutRange)).toEqual(legacy);
    }
    // And the request counts are real numbers, not the zeros a reader that
    // looked for `messages` on a slim record would report.
    const requests = legacy.filter((e) => e["t"] === "request");
    expect(requests.every((e) => (e["messageCount"] as number) >= 2 && (e["promptChars"] as number) > 10_000)).toBe(true);
  });

  test("run totals — tokens, segments, tps — are identical", async () => {
    const legacy = await scanRunTotals(path(variants.legacy));
    expect(legacy.tokens.promptTokens).toBeGreaterThan(0);
    expect(await scanRunTotals(path(variants.slim))).toEqual(legacy);
    expect(await scanRunTotals(path(variants.mixed))).toEqual(legacy);
  });

  test("the public projection publishes the same request fields, and nothing a slim record adds", async () => {
    // Projected, then compared without the byte ranges the projection carries.
    const projected = async (dir: string): Promise<Record<string, unknown>[]> => {
      const tail = await tailOf(dir);
      const page = { from: 0, total: tail.entries.length, entries: tail.entries } as unknown as EntriesResponse;
      return (projectEntries(page).entries as unknown as EntrySummary[]).map(withoutRange);
    };
    const legacy = await projected(variants.legacy);
    for (const dir of [variants.slim, variants.mixed]) expect(await projected(dir)).toEqual(legacy);
    const requests = legacy.filter((e) => e["t"] === "request");
    expect(requests.length).toBeGreaterThan(0);
    expect(requests.every((e) => typeof e["promptChars"] === "number" && (e["promptChars"] as number) > 0)).toBe(true);
    for (const e of requests) {
      for (const k of ["user", "systemText", "systemHash", "requestHash", "window", "messages", "slim"]) {
        expect(k in e).toBe(false);
      }
    }
  });

  test("a raw request is what the model saw, whichever shape is on disk", async () => {
    const legacy = await tailOf(variants.legacy);
    const slim = await tailOf(variants.slim);
    const mixed = await tailOf(variants.mixed);
    const requestAt = legacy.entries.filter((e) => e.t === "request").map((e) => e.i);
    expect(requestAt.length).toBe(SEGMENT_TURNS[0] + SEGMENT_TURNS[1] + 2);
    for (const i of requestAt) {
      const want = (JSON.parse((await legacy.raw(i))!) as { messages: unknown }).messages;
      for (const tail of [slim, mixed]) {
        const got = JSON.parse((await tail.raw(i))!) as { messages?: unknown; rebuilt?: unknown; slim?: unknown };
        expect(got.messages).toEqual(want);
        // A rebuilt body says so, and says it verified.
        if (got.slim !== undefined) expect(got.rebuilt).toEqual({ verified: true });
        else expect(got.rebuilt).toBeUndefined();
      }
    }
  });

  test("a raw request whose window no longer matches is served with a failed verdict, never as verified", async () => {
    const dir = tempDir("wrathbench-readers-tampered-");
    legacyVariant(variants.slim, dir, () => false);
    // Edit a result the turn-3 request's window holds.
    const file = path(dir);
    const lines = (await Bun.file(file).text()).split("\n");
    const k = lines.findIndex((l) => l.includes('"t":"snippet_result"') && l.includes('"turn":2,'));
    expect(k).toBeGreaterThanOrEqual(0);
    const edited = JSON.parse(lines[k]!) as { text: string };
    edited.text = `edited ${edited.text}`;
    lines[k] = JSON.stringify(edited);
    await Bun.write(file, lines.join("\n"));
    const tail = await tailOf(dir);
    const req3 = tail.entries.find((e) => e.t === "request" && e.turn === 3)!;
    const got = JSON.parse((await tail.raw(req3.i))!) as { rebuilt: { verified: boolean; error?: string } };
    expect(got.rebuilt.verified).toBe(false);
    expect(got.rebuilt.error).toContain("request hash mismatch");
  });
});

describe("the replay reads old, new and mixed", () => {
  test("full requests are counted, slim ones verified, and the switch is a segment", async () => {
    const legacy = await replayFile(path(variants.legacy));
    expect(legacy).toMatchObject({ slim: 0, verified: 0, failures: [], full: SEGMENT_TURNS[0] + SEGMENT_TURNS[1] + 2 });
    const mixed = await replayFile(path(variants.mixed));
    expect(mixed).toMatchObject({
      slim: SEGMENT_TURNS[1] + 1,
      verified: SEGMENT_TURNS[1] + 1,
      failures: [],
      full: SEGMENT_TURNS[0] + 1,
      segments: 1,
    });
  });
});
