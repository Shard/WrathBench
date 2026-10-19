/**
 * The units around a live run on the public site: the publisher carries each
 * live run's window inside `live.json` and nowhere else, through
 * `projectNearby`, no further back than `PUBLIC_NEARBY_SPAN_MS`, and drops it
 * on the pass after the run's ring goes; the bucket's verifier accepts what
 * it wrote and flags a planted token, a planted player and a window that is
 * not live.
 *
 * Over the poisoned runs directory, with the live run's ring rewritten by the
 * runner's own `NearbyWriter` to reach back fourteen minutes: a plain
 * creature that walks, a vendor with a subname and a quest mark, another
 * player and their pet, and a creature that chases that player and then the
 * character. Names, entries and guids are invented. The ring is stamped on
 * the wall clock, because the viewer's route reads the ring at `Date.now()`.
 */

import { describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { NearbyWriter } from "../src/nearby";
import type { NearbyRow, NearbyUnit } from "../src/nearby-row";
import type { LiveNearby, PositionsResponse } from "../viewer/api-types";
import { PUBLIC_NEARBY_SPAN_MS, decodeNearby, nearbyAt } from "../viewer/nearby";
import { PUBLIC_NEARBY_KEYS, projectLiveNearby } from "../viewer/public-projection";
import { createRenderer, type SnapshotArtifact } from "../viewer/snapshot";
import { emptyState, publishPass, LIVE_PATH, type ObjectStore } from "../../infra/publish-core";
import { NEARBY_PUBLIC_STATE, verifyPublication, type AcceptSource } from "../../infra/publish-accept";
import { LIVE_RUN, DEAD_RUN, poisonedRunsDir } from "./fixtures/poisoned-runs";

const guid = (entry: number, low: number, high = 0xf130): string => ((BigInt(high) << 48n) | (BigInt(entry) << 24n) | BigInt(low)).toString(10);
const WOLF = guid(299, 11);
const VENDOR = guid(1250, 12);
const CHASER = guid(40, 13);
const OTHER = "554433";
const OTHER_PET = guid(416, 14, 0xf140);

const NAMES = {
  wolf: "Invented Ringwolf",
  vendor: "Invented Ringvendor",
  chaser: "Invented Ringchaser",
  other: "Ringplayer",
  otherPet: "Ringpet of another",
  sub: "ring-subname Bowyer",
} as const;

/** How far back the ring reaches when the pass runs: past the public span, inside the ring's own reach. */
const RING_BACK_MS = 14 * 60_000;

/**
 * The scene, fourteen minutes back to a second ago: the wolf walks, the chaser
 * goes after the other player and then the character. `aheadMs` stamps the
 * child's horizon that far past now instead, as a runner pod's clock ahead of
 * the publisher's would.
 */
async function writeRing(runDir: string, aheadMs = -1_000): Promise<{ from: number; chaseSelfAt: number }> {
  const now = Date.now();
  const from = now - RING_BACK_MS;
  const at = (x: number, t: number): NonNullable<NearbyUnit["m"]> => ({ k: "pos", t, p: [-6230 + x, 380, 385, 0] });
  const units: NearbyUnit[] = [
    { id: WOLF, ty: "creature", s: { entry: 299, name: NAMES.wolf, level: 3, hp: 100 }, m: at(0, from) },
    { id: VENDOR, ty: "creature", s: { entry: 1250, name: NAMES.vendor, sub: NAMES.sub, nf: 0x80, qg: 8 }, m: at(8, from) },
    { id: CHASER, ty: "creature", s: { entry: 40, name: NAMES.chaser, level: 4, hp: 100 }, m: at(-8, from) },
    { id: OTHER, ty: "player", s: { name: NAMES.other, level: 9 }, m: at(12, from) },
    { id: OTHER_PET, ty: "pet", s: { entry: 416, name: NAMES.otherPet, ow: OTHER }, m: at(13, from) },
  ];
  const rows: NearbyRow[] = [{ ts: from, kind: "key", self: { guid: "7", map: 0, target: null, down: false }, units }];
  for (let t = from + 10_000; t < now - 1_000; t += 10_000) {
    rows.push({ ts: t, kind: "pos", id: WOLF, m: at(((t - from) / 10_000) % 20, t) });
  }
  // The chaser targets the other player for two minutes, then the character.
  const chaseOtherAt = now - 5 * 60_000;
  const chaseSelfAt = now - 3 * 60_000;
  rows.push({ ts: chaseOtherAt, kind: "st", id: CHASER, s: { tg: OTHER, tgs: false } });
  rows.push({ ts: chaseSelfAt, kind: "st", id: CHASER, s: { tg: "7", tgs: true } });
  rows.sort((a, b) => a.ts - b.ts);
  const writer = new NearbyWriter({
    runDir,
    sandbox: { nearbyDrain: async () => ({ rows, dropped: 0, through: now + aheadMs }) },
    log: () => {},
  });
  await writer.drain();
  return { from, chaseSelfAt };
}

/** A bucket in memory that remembers every PUT, so a test can ask what was ever written. */
function memoryBucket(): { store: ObjectStore; objects: Map<string, string>; puts: { path: string; body: string }[]; source: AcceptSource } {
  const objects = new Map<string, string>();
  const puts: { path: string; body: string }[] = [];
  return {
    objects,
    puts,
    store: {
      put: async (path, body) => {
        puts.push({ path, body });
        objects.set(path, body);
      },
      delete: async (path) => void objects.delete(path),
    },
    source: { get: async (key) => objects.get(key) ?? null },
  };
}

interface Live {
  generatedAt: number;
  positions: PositionsResponse;
  nearby?: LiveNearby;
}

async function setup(aheadMs?: number): Promise<{ runs: string; ring: { from: number; chaseSelfAt: number } }> {
  const runs = poisonedRunsDir();
  const ring = await writeRing(join(runs, LIVE_RUN), aheadMs);
  return { runs, ring };
}

describe("the public nearby layer", () => {
  test("a pass carries the live run's public window inside live.json, and no other object names a unit", async () => {
    const { runs, ring } = await setup();
    try {
      const render = createRenderer({ runsDir: runs });
      const before = Date.now();
      const out = await render(before);
      const liveArt = out.artifacts.find((a) => a.path === LIVE_PATH)!;
      const live = JSON.parse(liveArt.body) as Live;
      expect(Object.keys(live.nearby ?? {})).toEqual([LIVE_RUN]);
      expect(live.positions.positions.find((p) => p.runId === LIVE_RUN)?.nearby).toBe(true);
      expect(live.positions.positions.some((p) => p.runId === DEAD_RUN)).toBe(false);

      const w = live.nearby![LIVE_RUN]!;
      // Live only: no further back than the span, though the ring reaches further.
      expect(w.t1 - w.t0).toBeLessThanOrEqual(PUBLIC_NEARBY_SPAN_MS);
      expect(w.t0).toBeGreaterThan(ring.from);
      expect(w.t0).toBeGreaterThanOrEqual(before - PUBLIC_NEARBY_SPAN_MS);
      // Creatures only, cut to the public keys, the self to its map.
      expect(new Set(w.ty)).toEqual(new Set([0]));
      expect(w.ids.sort()).toEqual([CHASER, VENDOR, WOLF].sort());
      for (const s of w.k.s) for (const k of Object.keys(s)) expect(NEARBY_PUBLIC_STATE.has(k)).toBe(true);
      expect(w.k.self).toMatchObject({ guid: null, target: null, map: 0 });
      for (const v of [NAMES.other, NAMES.otherPet, NAMES.sub, OTHER, OTHER_PET]) expect(liveArt.body).not.toContain(v);
      for (const v of [NAMES.wolf, NAMES.vendor, NAMES.chaser]) expect(liveArt.body).toContain(v);
      // The chaser is withheld while it targets the other player, and back once it targets the character.
      const d = decodeNearby(w);
      const chaser = (t: number) => nearbyAt(d, t).find((u) => u.id === CHASER);
      expect(chaser(ring.chaseSelfAt - 30_000)).toBeUndefined();
      expect(chaser(ring.chaseSelfAt + 30_000)?.s).toMatchObject({ name: NAMES.chaser, tgs: true });
      // A fixed point of the boundary, as the verifier reads it.
      expect(projectLiveNearby(JSON.parse(JSON.stringify(live.nearby)), live.positions)).toEqual(live.nearby!);

      // No history: nothing but live.json names a unit, and no key is the ring's.
      for (const a of out.artifacts) {
        expect(a.path).not.toContain("nearby");
        if (a.path === LIVE_PATH) continue;
        for (const v of [NAMES.wolf, NAMES.vendor, NAMES.chaser, WOLF, VENDOR, CHASER]) expect(`${a.path}: ${a.body}`).not.toContain(v);
      }
    } finally {
      rmSync(runs, { recursive: true, force: true });
    }
  });

  test("published, the window is overwritten each pass and gone the pass after the ring goes; the verifier finds nothing", async () => {
    const { runs } = await setup();
    try {
      const bucket = memoryBucket();
      const state = emptyState();
      const render = createRenderer({ runsDir: runs });
      const pass = async (): Promise<void> => {
        await publishPass(async (sink, published) => await render(Date.now(), { sink: (b: SnapshotArtifact[]) => sink(b), batch: 1 }, published), bucket.store, state);
      };
      await pass();
      const first = JSON.parse(bucket.objects.get(LIVE_PATH)!) as Live;
      expect(Object.keys(first.nearby ?? {})).toEqual([LIVE_RUN]);
      const report = await verifyPublication(bucket.source, { cache: false });
      expect(report.missing).toEqual([]);
      expect(report.findings).toEqual([]);

      // The run's ring goes (a pause, a stop, an exit): the next pass carries no window and no flag.
      rmSync(join(runs, LIVE_RUN, "nearby"), { recursive: true, force: true });
      await pass();
      const second = JSON.parse(bucket.objects.get(LIVE_PATH)!) as Live;
      expect(second.nearby).toBeUndefined();
      expect(second.positions.positions.find((p) => p.runId === LIVE_RUN)?.nearby).toBeUndefined();
      expect((await verifyPublication(bucket.source, { cache: false })).findings).toEqual([]);

      // Across both passes, no key other than live.json ever held a unit, and none holds one now.
      for (const p of bucket.puts) {
        expect(p.path).not.toContain("nearby");
        if (p.path === LIVE_PATH) continue;
        for (const v of [NAMES.wolf, NAMES.vendor, NAMES.chaser]) expect(`${p.path}: ${p.body}`).not.toContain(v);
      }
      for (const [k, body] of bucket.objects) for (const v of [NAMES.wolf, NAMES.vendor, NAMES.chaser]) expect(`${k}: ${body}`).not.toContain(v);
    } finally {
      rmSync(runs, { recursive: true, force: true });
    }
  });

  test("a ring stamped ahead of the publisher's clock is cut to the span, and the cut window verifies", async () => {
    // The window is keyed at the publisher's now minus the span and runs to the child's horizon, a few seconds on.
    const { runs } = await setup(4_000);
    try {
      const bucket = memoryBucket();
      const render = createRenderer({ runsDir: runs });
      await publishPass(async (sink, p) => await render(Date.now(), { sink, batch: 1 }, p), bucket.store, emptyState());
      const w = (JSON.parse(bucket.objects.get(LIVE_PATH)!) as Live).nearby![LIVE_RUN]!;
      expect(w.t1 - w.t0).toBe(PUBLIC_NEARBY_SPAN_MS);
      expect(w.ids.length).toBeGreaterThan(0);
      expect((await verifyPublication(bucket.source, { cache: false })).findings).toEqual([]);
    } finally {
      rmSync(runs, { recursive: true, force: true });
    }
  });

  test("a run that stops being live takes its window with it, whatever the windows handed in", () => {
    const w = { v: 1, run: "r1", t0: 0, t1: 1, q: { p: 10, o: 1024 }, ids: [], ty: [], k: { self: {}, u: [], s: [], m: [] }, dt: [], mt: [], u: [], mk: [], x: [], y: [], z: [], o: [], sp: [], ev: [] };
    const flagged = { positions: [{ runId: "r1", nearby: true }] } as unknown as PositionsResponse;
    const unflagged = { positions: [{ runId: "r1" }] } as unknown as PositionsResponse;
    expect(Object.keys(projectLiveNearby({ r1: w }, flagged))).toEqual(["r1"]);
    expect(projectLiveNearby({ r1: w }, unflagged)).toEqual({});
    expect(projectLiveNearby({ r1: w }, { positions: [] })).toEqual({});
    // Filed under another run's id, or not an object of windows at all.
    expect(projectLiveNearby({ r1: { ...w, run: "r2" } }, flagged)).toEqual({});
    expect(projectLiveNearby([w], flagged)).toEqual({});
  });
});

describe("the verifier on live.json's units", () => {
  /** One clean published pass over the fixture, and a way to rewrite its live.json. */
  async function published(): Promise<{ bucket: ReturnType<typeof memoryBucket>; edit: (fn: (live: Live & Record<string, unknown>) => void) => void; done: () => void }> {
    const { runs } = await setup();
    const bucket = memoryBucket();
    const render = createRenderer({ runsDir: runs });
    await publishPass(async (sink, p) => await render(Date.now(), { sink, batch: 1 }, p), bucket.store, emptyState());
    return {
      bucket,
      edit: (fn) => {
        const live = JSON.parse(bucket.objects.get(LIVE_PATH)!) as Live & Record<string, unknown>;
        fn(live);
        bucket.objects.set(LIVE_PATH, JSON.stringify(live));
      },
      done: () => rmSync(runs, { recursive: true, force: true }),
    };
  }
  const kindsAt = (findings: { kind: string; at: string }[]): string[] => [...new Set(findings.filter((f) => f.at.startsWith("nearby") || f.at.startsWith("positions")).map((f) => f.kind))].sort();

  test("the public state keys are the projection's, restated", () => {
    expect([...NEARBY_PUBLIC_STATE].sort()).toEqual([...PUBLIC_NEARBY_KEYS].sort());
  });

  test("a token planted in a unit's name is a credential finding", async () => {
    const p = await published();
    try {
      p.edit((live) => {
        live.nearby![LIVE_RUN]!.k.s[0]!.name = `token=${"ab".repeat(16)}`;
      });
      const report = await verifyPublication(p.bucket.source, { cache: false });
      const cred = report.findings.filter((f) => f.kind === "credential");
      expect(cred).toHaveLength(1);
      expect(cred[0]!.at).toBe(`nearby.${LIVE_RUN}.k.s[0].name`);
      // A unit's name is the server's answer, never the model's: not a residual note.
      expect(report.residual.filter((f) => f.at.startsWith("nearby"))).toEqual([]);
    } finally {
      p.done();
    }
  });

  test("a path or a host in a unit's name is a finding, not a residual note", async () => {
    const p = await published();
    try {
      p.edit((live) => {
        live.nearby![LIVE_RUN]!.k.s[0]!.name = "see http://10.0.0.5:8080/x";
      });
      const report = await verifyPublication(p.bucket.source, { cache: false });
      expect(report.findings.map((f) => f.kind)).toContain("host-fact");
      expect(report.residual).toEqual([]);
    } finally {
      p.done();
    }
  });

  test("a planted player, a guid key or a self that names the character is caught twice: drift and a withheld field", async () => {
    for (const plant of [
      (live: Live) => {
        const w = live.nearby![LIVE_RUN]!;
        w.ids.push(OTHER);
        w.ty.push(3);
      },
      (live: Live) => {
        live.nearby![LIVE_RUN]!.k.s[0]!.tg = OTHER;
      },
      (live: Live) => {
        live.nearby![LIVE_RUN]!.k.self.guid = "7";
      },
    ]) {
      const p = await published();
      try {
        p.edit(plant);
        const report = await verifyPublication(p.bucket.source, { cache: false });
        expect(kindsAt(report.findings)).toEqual(["projection-drift", "withheld-field"]);
      } finally {
        p.done();
      }
    }
  });

  test("a window reaching back past the live span, or for a run live.json does not flag, is not live", async () => {
    for (const plant of [
      (live: Live) => {
        const w = live.nearby![LIVE_RUN]!;
        w.t0 = w.t1 - PUBLIC_NEARBY_SPAN_MS - 60_000;
      },
      (live: Live) => {
        delete live.positions.positions.find((x) => x.runId === LIVE_RUN)!.nearby;
      },
    ]) {
      const p = await published();
      try {
        p.edit(plant);
        const report = await verifyPublication(p.bucket.source, { cache: false });
        expect(kindsAt(report.findings)).toContain("live-only");
        expect(kindsAt(report.findings)).toContain("projection-drift");
      } finally {
        p.done();
      }
    }
  });
});
