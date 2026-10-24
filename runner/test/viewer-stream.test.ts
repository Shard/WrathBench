/**
 * The SSE tail delivers every entry to every open stream.
 *
 * One `TrajectoryTail` per run is shared by every reader, and its `scan()`
 * returns only what *that* call newly read. A stream that forwarded its own
 * scan's return value lost whatever another reader's scan had consumed first:
 * a second tab, the run page's own detail poll, `/entries`, `/track`. Each
 * stream keeps its own cursor into the tail's entries instead.
 *
 * And it starts where the client says. The run page reads `/entries` first and
 * opens the stream after; a stream starting at the tail's end dropped whatever
 * was written in between. `?from=` names the first entry the page does not
 * hold, and every frame that moves the cursor carries it as the SSE id, so a
 * reconnect's `Last-Event-ID` resumes without a gap or a replay.
 */

import { describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createApi, streamStart } from "../viewer/api";
import { tempDirs } from "./fixtures/temp-dirs";

const tempDir = tempDirs();
const RUN = "stream-run";

function fixture(): { runs: string; traj: string } {
  const runs = tempDir("viewer-stream-");
  const dir = join(runs, RUN);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "meta.json"), JSON.stringify({ runId: RUN, startedAt: 1000, config: { model: "m" } }));
  const traj = join(dir, "trajectory.jsonl");
  writeFileSync(
    traj,
    [
      { ts: 1000, t: "meta", runId: RUN },
      { ts: 1100, t: "request", turn: 1, promptChars: 400 },
      { ts: 1200, t: "response", turn: 1, message: { role: "assistant", content: "hello" } },
    ]
      .map((l) => JSON.stringify(l))
      .join("\n") + "\n",
  );
  return { runs, traj };
}

function api(runs: string): (r: Request) => Promise<Response> {
  return createApi({ runsDir: runs, tilesDir: join(runs, "..", "minimap"), moduleUrl: "http://127.0.0.1:1" });
}

function append(traj: string, lines: object[]): void {
  appendFileSync(traj, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
}

interface Msg {
  /** The frame's SSE id, when it carried one. */
  id?: number;
  hello?: string;
  total?: number;
  entries?: { i: number; t: string; ts: number }[];
  tokens?: { turns: number };
  tick?: number;
}

/** An open stream, its messages collected as they arrive. */
function open(res: Response): { msgs: Msg[]; until: (ok: (m: Msg[]) => boolean, ms?: number) => Promise<void>; close: () => Promise<void> } {
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  const msgs: Msg[] = [];
  let buf = "";
  let done = false;
  const pump = (async () => {
    while (!done) {
      const r = await reader.read().catch(() => ({ done: true, value: undefined }));
      if (r.done) break;
      buf += dec.decode(r.value);
      let k: number;
      while ((k = buf.indexOf("\n\n")) >= 0) {
        const frame = buf.slice(0, k);
        buf = buf.slice(k + 2);
        let id: number | undefined;
        for (const line of frame.split("\n")) {
          if (line.startsWith("id: ")) id = Number(line.slice(4));
          else if (line.startsWith("data: ")) msgs.push({ ...(JSON.parse(line.slice(6)) as Msg), ...(id !== undefined ? { id } : {}) });
        }
      }
    }
  })();
  return {
    msgs,
    async until(ok, ms = 3_000) {
      const deadline = Date.now() + ms;
      while (!ok(msgs) && Date.now() < deadline) await Bun.sleep(25);
    },
    async close() {
      done = true;
      await reader.cancel().catch(() => undefined);
      await pump;
    },
  };
}

const delivered = (msgs: readonly Msg[]): number[] => msgs.flatMap((m) => (m.entries ?? []).map((e) => e.ts));

describe("the live tail", () => {
  test("two streams on one run both receive every appended entry", async () => {
    const { runs, traj } = fixture();
    const handle = api(runs);
    const a = open(await handle(new Request(`http://x/api/run/${RUN}/stream`)));
    const b = open(await handle(new Request(`http://x/api/run/${RUN}/stream`)));
    try {
      await a.until((m) => m.length > 0);
      await b.until((m) => m.length > 0);
      append(traj, [
        { ts: 2000, t: "request", turn: 2, promptChars: 400 },
        { ts: 2100, t: "response", turn: 2, message: { role: "assistant", content: "two" } },
        { ts: 2200, t: "snippet", turn: 2, code: "1" },
      ]);
      const want = [2000, 2100, 2200];
      await a.until((m) => delivered(m).length >= 3);
      await b.until((m) => delivered(m).length >= 3);
      expect(delivered(a.msgs)).toEqual(want);
      expect(delivered(b.msgs)).toEqual(want);
    } finally {
      await a.close();
      await b.close();
    }
  });

  test("entries another route's scan consumed first still reach the stream", async () => {
    const { runs, traj } = fixture();
    const handle = api(runs);
    const s = open(await handle(new Request(`http://x/api/run/${RUN}/stream`)));
    try {
      await s.until((m) => m.length > 0);
      append(traj, [
        { ts: 3000, t: "request", turn: 2, promptChars: 400 },
        { ts: 3100, t: "response", turn: 2, message: { role: "assistant", content: "two" } },
      ]);
      // The run page's own poll and the feed window both scan the shared tail
      // before the stream's next tick does.
      expect((await handle(new Request(`http://x/api/run/${RUN}`))).status).toBe(200);
      expect((await handle(new Request(`http://x/api/run/${RUN}/entries`))).status).toBe(200);
      await s.until((m) => delivered(m).length >= 2);
      expect(delivered(s.msgs)).toEqual([3000, 3100]);
      // The batch's token figure is the whole run's, as before.
      const batch = s.msgs.find((m) => m.entries !== undefined)!;
      expect(batch.tokens?.turns).toBe(2);
    } finally {
      await s.close();
    }
  });

  test("a truncated file restarts the stream's cursor from the top", async () => {
    const { runs, traj } = fixture();
    const handle = api(runs);
    const s = open(await handle(new Request(`http://x/api/run/${RUN}/stream`)));
    try {
      await s.until((m) => m.length > 0);
      expect(s.msgs[0]).toMatchObject({ hello: RUN, total: 3, id: 3 });
      // Rotated: shorter than what was read, so the tail re-reads it whole.
      writeFileSync(traj, JSON.stringify({ ts: 5000, t: "meta", runId: RUN }) + "\n");
      await s.until((m) => delivered(m).length >= 1);
      expect(delivered(s.msgs)).toEqual([5000]);
    } finally {
      await s.close();
    }
  });

  test("entries written between the page's /entries read and the stream opening still arrive", async () => {
    const { runs, traj } = fixture();
    const handle = api(runs);
    // The page's first read: the three entries on disk, and where they end.
    const page = (await (await handle(new Request(`http://x/api/run/${RUN}/entries`))).json()) as { total: number };
    expect(page.total).toBe(3);
    // The gap: written after that read, before the stream is open.
    append(traj, [
      { ts: 4000, t: "request", turn: 2, promptChars: 400 },
      { ts: 4100, t: "response", turn: 2, message: { role: "assistant", content: "gap" } },
    ]);
    const s = open(await handle(new Request(`http://x/api/run/${RUN}/stream?from=${page.total}`)));
    try {
      await s.until((m) => delivered(m).length >= 2);
      expect(delivered(s.msgs)).toEqual([4000, 4100]);
      // The batch's id is the cursor after it: what a reconnect sends back.
      expect(s.msgs.find((m) => m.entries !== undefined)?.id).toBe(5);
      // And the stream goes on live from there.
      append(traj, [{ ts: 4200, t: "snippet", turn: 2, code: "1" }]);
      await s.until((m) => delivered(m).length >= 3);
      expect(delivered(s.msgs)).toEqual([4000, 4100, 4200]);
    } finally {
      await s.close();
    }
  });

  test("without a start the stream begins at the tail's end, as before", async () => {
    const { runs, traj } = fixture();
    const handle = api(runs);
    append(traj, [{ ts: 4000, t: "request", turn: 2, promptChars: 400 }]);
    const s = open(await handle(new Request(`http://x/api/run/${RUN}/stream`)));
    try {
      await s.until((m) => m.some((x) => x.tick !== undefined));
      expect(delivered(s.msgs)).toEqual([]);
      expect(s.msgs[0]).toMatchObject({ hello: RUN, total: 4, id: 4 });
    } finally {
      await s.close();
    }
  });

  test("a reconnect's Last-Event-ID wins over a stale from: no gap and no replay", async () => {
    const { runs, traj } = fixture();
    const handle = api(runs);
    append(traj, [
      { ts: 6000, t: "request", turn: 2, promptChars: 400 },
      { ts: 6100, t: "response", turn: 2, message: { role: "assistant", content: "seen" } },
      { ts: 6200, t: "snippet", turn: 2, code: "1" },
    ]);
    // The URL still says 3 (the page's first read); the last connection had
    // delivered through entry 4 before it dropped, so the browser sends 5.
    const s = open(
      await handle(new Request(`http://x/api/run/${RUN}/stream?from=3`, { headers: { "last-event-id": "5" } })),
    );
    try {
      await s.until((m) => delivered(m).length >= 1);
      await s.until((m) => m.some((x) => x.tick !== undefined));
      expect(delivered(s.msgs)).toEqual([6200]);
    } finally {
      await s.close();
    }
  });

  test("a start past the tail's end means the file was rebuilt: it starts over at 0", async () => {
    const { runs } = fixture();
    const handle = api(runs);
    const s = open(await handle(new Request(`http://x/api/run/${RUN}/stream?from=99`)));
    try {
      await s.until((m) => delivered(m).length >= 3);
      expect(delivered(s.msgs)).toEqual([1000, 1100, 1200]);
    } finally {
      await s.close();
    }
  });

  test("a start that is not a count is no start", () => {
    const at = (url: string, lastId?: string): number | null =>
      streamStart(new Request(url, lastId === undefined ? {} : { headers: { "last-event-id": lastId } }), new URL(url));
    expect(at("http://x/s")).toBeNull();
    expect(at("http://x/s?from=7")).toBe(7);
    expect(at("http://x/s?from=0")).toBe(0);
    expect(at("http://x/s?from=-1")).toBeNull();
    expect(at("http://x/s?from=1.5")).toBeNull();
    expect(at("http://x/s?from=abc")).toBeNull();
    expect(at("http://x/s?from=7", "9")).toBe(9);
    // A garbled header falls back to the URL rather than to the tail's end.
    expect(at("http://x/s?from=7", "nope")).toBe(7);
  });

  test("an idle stream sends heartbeats and nothing else", async () => {
    const { runs } = fixture();
    const handle = api(runs);
    const s = open(await handle(new Request(`http://x/api/run/${RUN}/stream`)));
    try {
      await s.until((m) => m.some((x) => x.tick !== undefined), 3_000);
      expect(delivered(s.msgs)).toEqual([]);
      expect(s.msgs.some((x) => x.tick !== undefined)).toBe(true);
    } finally {
      await s.close();
    }
  });
});
