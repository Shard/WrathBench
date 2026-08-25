import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  classifyPath,
  DEFAULT_KEEP_GENS,
  DEFAULT_KEEP_RUN_VERSIONS,
  describeReport,
  emptyState,
  hashBody,
  LIVE_PATH,
  loadState,
  MANIFEST_PATH,
  needsPut,
  parseState,
  planPrune,
  publish,
  publishLoop,
  PublishError,
  saveState,
  sleepMs,
  waveOf,
  type ObjectStore,
  type PublishState,
  type SnapshotArtifact,
  type SnapshotResult,
  type StateIo,
} from "./publish-core";

/**
 * The engine's whole job is ordering, diffing and pruning, and all three are
 * invisible until something goes wrong in production — a torn generation, a
 * bucket that costs a PUT per object per minute, a bucket that grows forever.
 * So the bucket is a fake that records every call in order, and these tests
 * assert against that transcript. No network, no `data/`, no credentials.
 */

// ------------------------------------------------------------- the fake bucket

interface Call {
  op: "put" | "delete";
  path: string;
  body?: string;
  contentType?: string;
  cacheControl?: string;
}

class FakeStore implements ObjectStore {
  readonly calls: Call[] = [];
  readonly objects = new Map<string, string>();
  /** Keys whose PUT rejects, simulating a transient S3 failure. */
  failPuts = new Set<string>();
  /** Keys whose DELETE rejects. */
  failDeletes = new Set<string>();

  async put(path: string, body: string, opts: { contentType: string; cacheControl: string }): Promise<void> {
    this.calls.push({ op: "put", path, body, contentType: opts.contentType, cacheControl: opts.cacheControl });
    if (this.failPuts.has(path)) throw new Error(`fake S3: PUT ${path} refused`);
    this.objects.set(path, body);
  }

  async delete(path: string): Promise<void> {
    this.calls.push({ op: "delete", path });
    if (this.failDeletes.has(path)) throw new Error(`fake S3: DELETE ${path} refused`);
    this.objects.delete(path);
  }

  puts(): string[] {
    return this.calls.filter((c) => c.op === "put").map((c) => c.path);
  }

  deletes(): string[] {
    return this.calls.filter((c) => c.op === "delete").map((c) => c.path);
  }

  reset(): void {
    this.calls.length = 0;
  }
}

// ------------------------------------------------------------------- fixtures

const IMMUTABLE = "public, max-age=31536000, immutable";
const MUTABLE = "public, max-age=30";

function json(path: string, body: unknown, cacheControl = IMMUTABLE): SnapshotArtifact {
  return { path, body: JSON.stringify(body), contentType: "application/json", cacheControl };
}

interface RunSpec {
  id: string;
  ver: string;
  /** Anything that changes the body; defaults to the version stamp. */
  payload?: unknown;
}

/**
 * A full artifact set: two aggregates under the generation, a detail and a
 * track per run, plus the two mutable files. Shaped like the layout in
 * `docs/PUBLIC-DASHBOARD.md`.
 *
 * Every body carries a `generatedAt` envelope, exactly as the renderer's do —
 * which is the whole reason key-addressed diffing exists. Pass `stamp` to
 * re-render the same logical snapshot a minute later: same generation, same run
 * versions, every body different.
 */
function snapshot(gen: string, runs: RunSpec[], aggregate: unknown = "aggregate", stamp: string = gen): SnapshotResult {
  const env = { generatedAt: stamp };
  const artifacts: SnapshotArtifact[] = [];
  for (const r of runs) {
    artifacts.push(json(`v1/run/${r.id}/${r.ver}/detail.json`, { ...env, body: r.payload ?? r.ver }));
    artifacts.push(json(`v1/run/${r.id}/${r.ver}/track.json`, { ...env, body: r.payload ?? r.ver }));
  }
  artifacts.push(json(`v1/snap/${gen}/runs.json`, { ...env, gen, aggregate, runs: runs.map((r) => r.id) }));
  artifacts.push(json(`v1/snap/${gen}/ladder.json`, { ...env, gen, aggregate }));
  artifacts.push(json(LIVE_PATH, { ...env, gen }, MUTABLE));
  artifacts.push(json(MANIFEST_PATH, { ...env, gen }, MUTABLE));
  return { gen, artifacts };
}

/** Index of a key in a call transcript; -1 when it never happened. */
const at = (paths: string[], path: string): number => paths.indexOf(path);

// ---------------------------------------------------------------------- layout

describe("classifyPath", () => {
  test("reads run id and content version out of a per-run key", () => {
    expect(classifyPath("v1/run/roster-abc-20260825/7f3a/detail.json")).toEqual({ kind: "run", runId: "roster-abc-20260825", version: "7f3a" });
  });

  test("reads the generation stamp out of an aggregate key", () => {
    expect(classifyPath("v1/snap/20260825T120000Z/runs.json")).toEqual({ kind: "gen", gen: "20260825T120000Z" });
  });

  test("the two mutable files are their own kind", () => {
    expect(classifyPath(MANIFEST_PATH)).toEqual({ kind: "mutable" });
    expect(classifyPath(LIVE_PATH)).toEqual({ kind: "mutable" });
  });

  test("a malformed or unknown key is `other`, never a guess", () => {
    // `other` is the kind pruning refuses to touch, so misreading a key here is
    // the one classification mistake that could delete something live.
    expect(classifyPath("v1/run/only-an-id/detail.json").kind).toBe("other");
    expect(classifyPath("v1/snap/20260825T120000Z").kind).toBe("other");
    expect(classifyPath("v1/attribution.json").kind).toBe("other");
    expect(classifyPath("").kind).toBe("other");
  });
});

describe("waveOf", () => {
  test("per-run first, aggregates second, the mutable pair last", () => {
    expect(waveOf("v1/run/a/1/detail.json")).toBe("run");
    expect(waveOf("v1/snap/g/runs.json")).toBe("aggregate");
    expect(waveOf(LIVE_PATH)).toBe("mutable");
    expect(waveOf(MANIFEST_PATH)).toBe("mutable");
  });

  test("an unrecognized key rides with the aggregates — before the flip, never after", () => {
    expect(waveOf("v1/attribution.json")).toBe("aggregate");
  });
});

// --------------------------------------------------------------------- ordering

describe("upload ordering", () => {
  test("every run object precedes every aggregate, live precedes the manifest, and the manifest is strictly last", async () => {
    const store = new FakeStore();
    const state = emptyState();
    const result = snapshot("gen1", [
      { id: "runA", ver: "v1" },
      { id: "runB", ver: "v1" },
    ]);

    await publish(result, store, state);
    const puts = store.puts();

    const lastRun = Math.max(...puts.filter((p) => p.startsWith("v1/run/")).map((p) => at(puts, p)));
    const firstSnap = Math.min(...puts.filter((p) => p.startsWith("v1/snap/")).map((p) => at(puts, p)));
    expect(lastRun).toBeLessThan(firstSnap);
    expect(firstSnap).toBeLessThan(at(puts, LIVE_PATH));
    expect(at(puts, LIVE_PATH)).toBeLessThan(at(puts, MANIFEST_PATH));
    expect(at(puts, MANIFEST_PATH)).toBe(puts.length - 1);
    expect(puts).toHaveLength(result.artifacts.length);
  });

  test("cache-control and content-type reach the store per object", async () => {
    const store = new FakeStore();
    await publish(snapshot("gen1", [{ id: "runA", ver: "v1" }]), store, emptyState());
    const manifest = store.calls.find((c) => c.path === MANIFEST_PATH);
    const detail = store.calls.find((c) => c.path === "v1/run/runA/v1/detail.json");
    expect(manifest?.cacheControl).toBe(MUTABLE);
    expect(detail?.cacheControl).toBe(IMMUTABLE);
    expect(detail?.contentType).toBe("application/json");
  });

  test("a result renders no manifest: nothing flips and nothing is pruned", async () => {
    const store = new FakeStore();
    const state = emptyState();
    const result = snapshot("gen1", [{ id: "runA", ver: "v1" }]);
    result.artifacts = result.artifacts.filter((a) => a.path !== MANIFEST_PATH);

    const report = await publish(result, store, state);
    expect(report.flipped).toBe(false);
    expect(state.gens).toEqual([]);
    expect(store.deletes()).toEqual([]);
  });
});

describe("rendered results are validated before anything is written", () => {
  test("an aggregate stamped with another generation is refused", async () => {
    const store = new FakeStore();
    const result = snapshot("gen2", []);
    result.artifacts.push(json("v1/snap/gen1/stale.json", {}));
    await expect(publish(result, store, emptyState())).rejects.toThrow(/belongs to generation gen1 but the pass renders gen2/);
    expect(store.calls).toEqual([]);
  });

  test("two artifacts on one key are refused", async () => {
    const store = new FakeStore();
    const result = snapshot("gen1", []);
    result.artifacts.push(json(`v1/snap/gen1/runs.json`, { other: true }));
    await expect(publish(result, store, emptyState())).rejects.toThrow(/two artifacts claim the key/);
    expect(store.calls).toEqual([]);
  });

  test("a key with a leading slash is refused", async () => {
    const result = snapshot("gen1", []);
    result.artifacts.push(json("/v1/snap/gen1/x.json", {}));
    await expect(publish(result, new FakeStore(), emptyState())).rejects.toThrow(/is not a bucket key/);
  });
});

// ---------------------------------------------------------------------- diffing

describe("diffing", () => {
  test("re-publishing an identical result costs zero PUTs", async () => {
    const store = new FakeStore();
    const state = emptyState();
    const result = snapshot("gen1", [{ id: "runA", ver: "v1" }]);

    const first = await publish(result, store, state);
    expect(first.put).toHaveLength(result.artifacts.length);
    expect(first.unchanged).toBe(0);

    store.reset();
    const second = await publish(result, store, state);
    expect(second.put).toEqual([]);
    expect(second.unchanged).toBe(result.artifacts.length);
    expect(store.puts()).toEqual([]);
    // The flip is still true: the bucket's manifest already IS this one.
    expect(second.flipped).toBe(true);
  });

  test("a changed aggregate writes the new generation and flips the manifest, leaving unchanged runs alone", async () => {
    const store = new FakeStore();
    const state = emptyState();
    await publish(snapshot("gen1", [{ id: "runA", ver: "v1" }]), store, state);

    store.reset();
    // Same run, same content version — only the aggregate moved on.
    await publish(snapshot("gen2", [{ id: "runA", ver: "v1" }], "moved-on"), store, state);

    const puts = store.puts();
    expect(puts.filter((p) => p.startsWith("v1/run/"))).toEqual([]);
    expect(puts).toContain("v1/snap/gen2/runs.json");
    expect(puts).toContain("v1/snap/gen2/ladder.json");
    expect(at(puts, MANIFEST_PATH)).toBe(puts.length - 1);
    expect(state.lastGen).toBe("gen2");
    expect(store.objects.get(MANIFEST_PATH)).toContain("gen2");
  });

  test("a run whose content version advances writes the new version only", async () => {
    const store = new FakeStore();
    const state = emptyState();
    await publish(snapshot("gen1", [{ id: "runA", ver: "v1" }, { id: "runB", ver: "v1" }]), store, state);

    store.reset();
    await publish(snapshot("gen2", [{ id: "runA", ver: "v2" }, { id: "runB", ver: "v1" }]), store, state);

    expect(store.puts().filter((p) => p.startsWith("v1/run/")).sort()).toEqual(["v1/run/runA/v2/detail.json", "v1/run/runA/v2/track.json"]);
    expect(state.runVersions["runA"]).toEqual(["v1", "v2"]);
    expect(state.runVersions["runB"]).toEqual(["v1"]);
  });

  test("hashing is by body, so a re-render that produced the same bytes is free", () => {
    expect(hashBody('{"a":1}')).toBe(hashBody('{"a":1}'));
    expect(hashBody('{"a":1}')).not.toBe(hashBody('{"a":2}'));
  });
});

// ------------------------------------------------------- path-addressed skipping

describe("needsPut", () => {
  test("an immutable key already in the bucket is skipped whatever its body says", () => {
    const state = emptyState();
    state.uploaded["v1/run/runA/v1/detail.json"] = "old-hash";
    state.uploaded["v1/snap/gen1/runs.json"] = "old-hash";
    expect(needsPut("v1/run/runA/v1/detail.json", "new-hash", state, "gen1")).toBe(false);
    expect(needsPut("v1/snap/gen1/runs.json", "new-hash", state, "gen1")).toBe(false);
  });

  test("an immutable key the bucket has never held is always written", () => {
    const state = emptyState();
    expect(needsPut("v1/run/runA/v1/detail.json", "h", state, "gen1")).toBe(true);
    expect(needsPut("v1/snap/gen1/runs.json", "h", state, "gen1")).toBe(true);
  });

  test("the manifest is skipped when the generation it advertises is already this one", () => {
    const state = emptyState();
    state.uploaded[MANIFEST_PATH] = "old-hash";
    state.lastGen = "gen1";
    expect(needsPut(MANIFEST_PATH, "new-hash", state, "gen1")).toBe(false);
    expect(needsPut(MANIFEST_PATH, "new-hash", state, "gen2")).toBe(true);
  });

  test("a manifest we have no record of writing is written even at an unchanged gen", () => {
    const state = emptyState();
    state.lastGen = "gen1";
    expect(needsPut(MANIFEST_PATH, "h", state, "gen1")).toBe(true);
  });

  test("live.json and unrecognized keys stay on body-hash diffing", () => {
    const state = emptyState();
    state.uploaded[LIVE_PATH] = "h";
    state.uploaded["v1/attribution.json"] = "h";
    state.lastGen = "gen1";
    expect(needsPut(LIVE_PATH, "h", state, "gen1")).toBe(false);
    expect(needsPut(LIVE_PATH, "moved-on", state, "gen1")).toBe(true);
    expect(needsPut("v1/attribution.json", "h", state, "gen1")).toBe(false);
    expect(needsPut("v1/attribution.json", "moved-on", state, "gen1")).toBe(true);
  });
});

describe("immutable keys are addressed by path, not by body", () => {
  test("a re-render with a fresh generatedAt envelope re-PUTs nothing under run/ or snap/", async () => {
    const store = new FakeStore();
    const state = emptyState();
    const runs = [{ id: "runA", ver: "v1" }, { id: "runB", ver: "v1" }];
    await publish(snapshot("gen1", runs, "agg", "12:00:00"), store, state);

    store.reset();
    // A minute later: identical content, every body different because the
    // envelope moved. Hash-only diffing would re-upload all six objects.
    const later = snapshot("gen1", runs, "agg", "12:01:00");
    expect(later.artifacts.every((a) => hashBody(a.body) !== state.uploaded[a.path])).toBe(true);

    const report = await publish(later, store, state);
    expect(store.puts()).toEqual([LIVE_PATH]);
    expect(report.unchanged).toBe(later.artifacts.length - 1);
  });

  test("an idle fleet costs exactly one PUT per pass — live.json and nothing else", async () => {
    const store = new FakeStore();
    const state = emptyState();
    const runs = [{ id: "runA", ver: "v1" }, { id: "runB", ver: "v2" }];
    await publish(snapshot("gen1", runs, "agg", "t0"), store, state);

    store.reset();
    for (let pass = 1; pass <= 10; pass++) await publish(snapshot("gen1", runs, "agg", `t${pass}`), store, state);
    expect(store.puts()).toEqual(Array.from({ length: 10 }, () => LIVE_PATH));
  });

  test("an unchanged generation skips the manifest but still counts as flipped, and still prunes", async () => {
    const store = new FakeStore();
    const state = emptyState();
    for (let i = 1; i <= 6; i++) await publish(snapshot(`gen${i}`, [], `agg${i}`), store, state);
    // gen1 is now out of the keep window and was pruned on the sixth pass.
    expect(state.gens).toEqual(["gen2", "gen3", "gen4", "gen5", "gen6"]);

    // Hold the delete back so the seventh pass has something left to prune
    // even though its generation did not move.
    store.failDeletes.add("v1/snap/gen2/runs.json");
    await publish(snapshot("gen7", [], "agg7"), store, state);
    store.failDeletes.clear();
    store.reset();

    const report = await publish(snapshot("gen7", [], "agg7", "later"), store, state);
    expect(store.puts()).toEqual([LIVE_PATH]);
    expect(report.flipped).toBe(true);
    expect(state.lastGen).toBe("gen7");
    // The flip being a no-op does not make the pass one: the deferred delete
    // was retried and the generation history is still bounded.
    expect(store.deletes()).toEqual(["v1/snap/gen2/runs.json"]);
    expect(state.pendingDeletes).toEqual([]);
  });

  test("the manifest is written again the moment the generation moves", async () => {
    const store = new FakeStore();
    const state = emptyState();
    await publish(snapshot("gen1", []), store, state);
    await publish(snapshot("gen1", [], "agg", "later"), store, state);

    store.reset();
    await publish(snapshot("gen2", []), store, state);
    const puts = store.puts();
    expect(puts).toContain(MANIFEST_PATH);
    expect(at(puts, MANIFEST_PATH)).toBe(puts.length - 1);
    expect(store.objects.get(MANIFEST_PATH)).toContain("gen2");
  });

  test("a manifest whose PUT failed is retried on the next pass at the same generation", async () => {
    const store = new FakeStore();
    const state = emptyState();
    store.failPuts.add(MANIFEST_PATH);
    await expect(publish(snapshot("gen1", []), store, state)).rejects.toThrow(PublishError);
    expect(state.lastGen).toBeUndefined();

    store.failPuts.clear();
    store.reset();
    await publish(snapshot("gen1", [], "agg", "later"), store, state);
    // Not skipped: nothing ever recorded a manifest for gen1.
    expect(store.puts()).toContain(MANIFEST_PATH);
    expect(state.lastGen).toBe("gen1");
  });

  test("discarding the state file is the repair path for a bad immutable object", async () => {
    // First write wins on an immutable key, so a bad body is only repairable by
    // forgetting that the key was ever written.
    const store = new FakeStore();
    const state = emptyState();
    await publish(snapshot("gen1", [{ id: "runA", ver: "v1" }], "wrong"), store, state);

    store.reset();
    const fresh = emptyState();
    await publish(snapshot("gen1", [{ id: "runA", ver: "v1" }], "right"), store, fresh);
    expect(store.puts()).toHaveLength(6);
    expect(store.objects.get("v1/snap/gen1/runs.json")).toContain("right");
  });

  test("an immutable key that pruning deleted is uploaded again if it comes back", async () => {
    const store = new FakeStore();
    const state = emptyState();
    for (let i = 1; i <= 7; i++) await publish(snapshot(`gen${i}`, [{ id: "runA", ver: `v${i}` }], `agg${i}`), store, state);
    expect(store.objects.has("v1/run/runA/v1/detail.json")).toBe(false);

    store.reset();
    await publish(snapshot("gen8", [{ id: "runA", ver: "v1" }], "agg8"), store, state);
    expect(store.puts()).toContain("v1/run/runA/v1/detail.json");
  });
});

// ---------------------------------------------------------------- torn-read safety

describe("a failed wave aborts before the flip", () => {
  test("a per-run PUT failure leaves the manifest untouched and records the successes", async () => {
    const store = new FakeStore();
    const state = emptyState();
    store.failPuts.add("v1/run/runB/v1/detail.json");
    const result = snapshot("gen1", [
      { id: "runA", ver: "v1" },
      { id: "runB", ver: "v1" },
    ]);

    await expect(publish(result, store, state)).rejects.toThrow(PublishError);

    const puts = store.puts();
    expect(puts).not.toContain(MANIFEST_PATH);
    expect(puts).not.toContain(LIVE_PATH);
    expect(puts.some((p) => p.startsWith("v1/snap/"))).toBe(false);
    // Partial progress is kept: the siblings that landed are remembered, the
    // one that failed is not.
    expect(state.uploaded["v1/run/runA/v1/detail.json"]).toBeDefined();
    expect(state.uploaded["v1/run/runB/v1/track.json"]).toBeDefined();
    expect(state.uploaded["v1/run/runB/v1/detail.json"]).toBeUndefined();
    expect(state.gens).toEqual([]);
    expect(state.lastGen).toBeUndefined();
  });

  test("the next pass re-PUTs only what is still missing, then flips", async () => {
    const store = new FakeStore();
    const state = emptyState();
    store.failPuts.add("v1/run/runB/v1/detail.json");
    const result = snapshot("gen1", [
      { id: "runA", ver: "v1" },
      { id: "runB", ver: "v1" },
    ]);
    await expect(publish(result, store, state)).rejects.toThrow(PublishError);

    store.failPuts.clear();
    store.reset();
    const report = await publish(result, store, state);

    expect(store.puts().filter((p) => p.startsWith("v1/run/"))).toEqual(["v1/run/runB/v1/detail.json"]);
    expect(report.flipped).toBe(true);
    expect(at(store.puts(), MANIFEST_PATH)).toBe(store.puts().length - 1);
    expect(state.lastGen).toBe("gen1");
  });

  test("an aggregate PUT failure also stops short of the flip, keeping the previous generation whole", async () => {
    const store = new FakeStore();
    const state = emptyState();
    await publish(snapshot("gen1", [{ id: "runA", ver: "v1" }]), store, state);

    store.failPuts.add("v1/snap/gen2/ladder.json");
    store.reset();
    const err = await publish(snapshot("gen2", [{ id: "runA", ver: "v1" }], "next"), store, state).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(PublishError);
    expect((err as PublishError).wave).toBe("aggregate");
    expect((err as PublishError).failures.map((f) => f.path)).toEqual(["v1/snap/gen2/ladder.json"]);
    expect(store.puts()).not.toContain(MANIFEST_PATH);
    // The bucket still advertises the old, complete generation.
    expect(store.objects.get(MANIFEST_PATH)).toContain("gen1");
    expect(state.lastGen).toBe("gen1");
  });

  test("a live.json failure stops the flip too — the manifest never rides on a half-written pass", async () => {
    const store = new FakeStore();
    const state = emptyState();
    store.failPuts.add(LIVE_PATH);
    await expect(publish(snapshot("gen1", []), store, state)).rejects.toThrow(PublishError);
    expect(store.puts()).not.toContain(MANIFEST_PATH);
  });
});

// ----------------------------------------------------------------------- pruning

describe("planPrune", () => {
  function stateWith(gens: string[], runVersions: Record<string, string[]>): PublishState {
    const state = emptyState();
    state.gens = gens;
    state.runVersions = runVersions;
    for (const g of gens) state.uploaded[`v1/snap/${g}/runs.json`] = "h";
    for (const [id, versions] of Object.entries(runVersions)) for (const v of versions) state.uploaded[`v1/run/${id}/${v}/detail.json`] = "h";
    state.uploaded[MANIFEST_PATH] = "h";
    state.uploaded[LIVE_PATH] = "h";
    return state;
  }

  test("the newest five generations survive, everything older goes", () => {
    const state = stateWith(["g1", "g2", "g3", "g4", "g5", "g6", "g7"], {});
    expect(planPrune(state)).toEqual(["v1/snap/g1/runs.json", "v1/snap/g2/runs.json"]);
    expect(DEFAULT_KEEP_GENS).toBe(5);
  });

  test("the newest two versions of each run survive", () => {
    const state = stateWith([], { runA: ["v1", "v2", "v3", "v4"], runB: ["v1"] });
    expect(planPrune(state)).toEqual(["v1/run/runA/v1/detail.json", "v1/run/runA/v2/detail.json"]);
    expect(DEFAULT_KEEP_RUN_VERSIONS).toBe(2);
  });

  test("the mutable files and unrecognized keys are never prunable", () => {
    const state = stateWith(["g1", "g2", "g3", "g4", "g5", "g6"], {});
    state.uploaded["v1/attribution.json"] = "h";
    const plan = planPrune(state);
    expect(plan).not.toContain(MANIFEST_PATH);
    expect(plan).not.toContain(LIVE_PATH);
    expect(plan).not.toContain("v1/attribution.json");
  });

  test("nothing from the current or previous generation is ever planned", () => {
    // A pass renders at most one version per run, so the version live in the
    // previous generation is at most one behind the current one — which is
    // exactly what keep-last-two protects.
    const state = stateWith(["g1", "g2", "g3", "g4", "g5", "g6"], { runA: ["v1", "v2", "v3"] });
    const plan = planPrune(state);
    expect(plan).not.toContain("v1/snap/g6/runs.json");
    expect(plan).not.toContain("v1/snap/g5/runs.json");
    expect(plan).not.toContain("v1/run/runA/v3/detail.json");
    expect(plan).not.toContain("v1/run/runA/v2/detail.json");
  });

  test("limits below one are clamped rather than pruning the live generation", () => {
    const state = stateWith(["g1", "g2"], { runA: ["v1", "v2"] });
    expect(planPrune(state, { keepGens: 0, keepRunVersions: 0 })).toEqual(["v1/run/runA/v1/detail.json", "v1/snap/g1/runs.json"]);
  });
});

describe("pruning against the bucket", () => {
  test("after enough passes the old generations and old run versions are deleted, and the live ones are not", async () => {
    const store = new FakeStore();
    const state = emptyState();
    for (let i = 1; i <= 7; i++) {
      await publish(snapshot(`gen${i}`, [{ id: "runA", ver: `v${i}` }], `agg${i}`), store, state);
    }

    const remaining = [...store.objects.keys()].sort();
    expect(remaining).toEqual([
      LIVE_PATH,
      MANIFEST_PATH,
      "v1/run/runA/v6/detail.json",
      "v1/run/runA/v6/track.json",
      "v1/run/runA/v7/detail.json",
      "v1/run/runA/v7/track.json",
      "v1/snap/gen3/ladder.json",
      "v1/snap/gen3/runs.json",
      "v1/snap/gen4/ladder.json",
      "v1/snap/gen4/runs.json",
      "v1/snap/gen5/ladder.json",
      "v1/snap/gen5/runs.json",
      "v1/snap/gen6/ladder.json",
      "v1/snap/gen6/runs.json",
      "v1/snap/gen7/ladder.json",
      "v1/snap/gen7/runs.json",
    ]);
    // The state forgets what it deleted, or the object could never come back.
    expect(Object.keys(state.uploaded).sort()).toEqual(remaining);
    expect(state.gens).toEqual(["gen3", "gen4", "gen5", "gen6", "gen7"]);
    expect(state.runVersions["runA"]).toEqual(["v6", "v7"]);
  });

  test("no delete ever names the current or previous generation", async () => {
    const store = new FakeStore();
    const state = emptyState();
    for (let i = 1; i <= 8; i++) await publish(snapshot(`gen${i}`, [{ id: "runA", ver: `v${i}` }], `agg${i}`), store, state);
    const deleted = store.deletes();
    for (const path of deleted) {
      expect(path).not.toContain("gen8");
      expect(path).not.toContain("gen7");
      expect(path).not.toContain("/v8/");
      expect(path).not.toContain("/v7/");
    }
    expect(deleted.length).toBeGreaterThan(0);
  });

  test("pruning only runs after the flip: a failed pass deletes nothing", async () => {
    const store = new FakeStore();
    const state = emptyState();
    for (let i = 1; i <= 6; i++) await publish(snapshot(`gen${i}`, [{ id: "runA", ver: `v${i}` }], `agg${i}`), store, state);

    store.failPuts.add("v1/snap/gen7/runs.json");
    store.reset();
    await expect(publish(snapshot("gen7", [{ id: "runA", ver: "v7" }], "agg7"), store, state)).rejects.toThrow(PublishError);
    expect(store.deletes()).toEqual([]);
  });

  test("`prune: false` uploads and flips but deletes nothing", async () => {
    const store = new FakeStore();
    const state = emptyState();
    for (let i = 1; i <= 7; i++) await publish(snapshot(`gen${i}`, [{ id: "runA", ver: `v${i}` }]), store, state, { prune: false });
    expect(store.deletes()).toEqual([]);
    expect(state.lastGen).toBe("gen7");
  });
});

describe("a delete that fails", () => {
  test("does not fail the pass, and is retried on the next one", async () => {
    const store = new FakeStore();
    const state = emptyState();
    store.failDeletes.add("v1/snap/gen1/runs.json");

    for (let i = 1; i <= 6; i++) await publish(snapshot(`gen${i}`, []), store, state);

    // gen1 was due for pruning on pass 6 and refused.
    expect(state.pendingDeletes).toContain("v1/snap/gen1/runs.json");
    expect(state.lastGen).toBe("gen6");
    expect(state.uploaded["v1/snap/gen1/runs.json"]).toBeUndefined();

    store.failDeletes.clear();
    store.reset();
    const report = await publish(snapshot("gen7", []), store, state);
    expect(store.deletes()).toContain("v1/snap/gen1/runs.json");
    expect(state.pendingDeletes).toEqual([]);
    expect(report.flipped).toBe(true);
  });

  test("is reported rather than thrown", async () => {
    const store = new FakeStore();
    const state = emptyState();
    store.failDeletes.add("v1/snap/gen1/ladder.json");
    let report = await publish(snapshot("gen1", []), store, state);
    for (let i = 2; i <= 6; i++) report = await publish(snapshot(`gen${i}`, []), store, state);
    expect(report.deleteFailures).toEqual(["v1/snap/gen1/ladder.json"]);
    expect(report.deleted).toEqual(["v1/snap/gen1/runs.json"]);
    expect(describeReport(report)).toContain("deletes deferred");
  });
});

// ------------------------------------------------------------------- state file

describe("state persistence", () => {
  test("round-trips through a file", () => {
    const dir = mkdtempSync(join(tmpdir(), "wb-publish-"));
    try {
      const path = join(dir, "nested", "publish-state.json");
      const state = emptyState();
      state.uploaded[MANIFEST_PATH] = "abc";
      state.gens = ["gen1", "gen2"];
      state.runVersions["runA"] = ["v1"];
      state.pendingDeletes = ["v1/snap/gen0/runs.json"];
      state.lastGen = "gen2";
      state.lastFlipAt = 1_700_000_000_000;

      saveState(path, state);
      expect(loadState(path)).toEqual(state);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a missing file starts empty rather than throwing", () => {
    expect(loadState(join(tmpdir(), "wb-publish-does-not-exist", "state.json"))).toEqual(emptyState());
  });

  test("a corrupt file starts empty, loudly", () => {
    const dir = mkdtempSync(join(tmpdir(), "wb-publish-"));
    try {
      const path = join(dir, "state.json");
      writeFileSync(path, "{not json");
      const lines: string[] = [];
      expect(loadState(path, (l) => lines.push(l))).toEqual(emptyState());
      expect(lines.join("\n")).toContain("re-uploads everything");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("unknown and mistyped fields are dropped, not trusted", () => {
    const parsed = parseState(JSON.stringify({ uploaded: { a: 1, b: "h" }, gens: ["g1", 7], runVersions: { r: "nope" }, pendingDeletes: null, lastGen: 5 }));
    expect(parsed.uploaded).toEqual({ b: "h" });
    expect(parsed.gens).toEqual(["g1"]);
    expect(parsed.runVersions).toEqual({});
    expect(parsed.pendingDeletes).toEqual([]);
    expect(parsed.lastGen).toBeUndefined();
  });

  test("a state written by a previous pass resumes the diff — no re-uploads", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wb-publish-"));
    try {
      const path = join(dir, "state.json");
      const store = new FakeStore();
      const result = snapshot("gen1", [{ id: "runA", ver: "v1" }]);
      const first = emptyState();
      await publish(result, store, first);
      saveState(path, first);

      store.reset();
      const resumed = loadState(path);
      const report = await publish(result, store, resumed);
      expect(report.put).toEqual([]);
      expect(store.calls).toEqual([]);
      expect(readFileSync(path, "utf8")).toContain("gen1");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// -------------------------------------------------------------------- the loop

/** A state io that never touches disk, so the loop's tests do not either. */
function memoryIo(initial: PublishState = emptyState()): StateIo & { saved: number; state: PublishState } {
  const held = { state: initial, saved: 0 };
  return {
    saved: 0,
    state: initial,
    load(): PublishState {
      return held.state;
    },
    save(_path: string, state: PublishState): void {
      held.state = state;
      this.saved++;
      this.state = state;
    },
  };
}

describe("publishLoop", () => {
  test("`once` runs exactly one pass and does not sleep", async () => {
    const store = new FakeStore();
    const io = memoryIo();
    const sleeps: number[] = [];
    let rendered = 0;

    const summary = await publishLoop(
      async () => {
        rendered++;
        return snapshot("gen1", []);
      },
      store,
      "state.json",
      { once: true, io, log: () => {}, sleep: async (ms) => void sleeps.push(ms) },
    );

    expect(rendered).toBe(1);
    expect(sleeps).toEqual([]);
    expect(summary).toEqual({ passes: 1, published: 1, failed: 0, lastGen: "gen1" });
    expect(io.saved).toBe(1);
  });

  test("sleeps the configured interval between passes and stops when aborted", async () => {
    const store = new FakeStore();
    const io = memoryIo();
    const controller = new AbortController();
    const sleeps: number[] = [];
    let rendered = 0;

    const summary = await publishLoop(
      async () => snapshot(`gen${++rendered}`, []),
      store,
      "state.json",
      {
        intervalMs: 12_345,
        signal: controller.signal,
        io,
        log: () => {},
        sleep: async (ms) => {
          sleeps.push(ms);
          if (sleeps.length === 3) controller.abort();
        },
      },
    );

    expect(sleeps).toEqual([12_345, 12_345, 12_345]);
    expect(summary.passes).toBe(3);
    expect(summary.published).toBe(3);
    expect(summary.lastGen).toBe("gen3");
    expect(store.objects.get(MANIFEST_PATH)).toContain("gen3");
  });

  test("a signal already aborted publishes nothing", async () => {
    const summary = await publishLoop(
      async () => {
        throw new Error("render must not be called");
      },
      new FakeStore(),
      "state.json",
      { signal: AbortSignal.abort(), io: memoryIo(), log: () => {} },
    );
    expect(summary).toEqual({ passes: 0, published: 0, failed: 0 });
  });

  test("a failing pass is logged and the loop carries on — and the retry is cheap", async () => {
    const store = new FakeStore();
    const io = memoryIo();
    const controller = new AbortController();
    const lines: string[] = [];
    let pass = 0;

    store.failPuts.add("v1/run/runA/v1/track.json");
    await publishLoop(
      async () => {
        pass++;
        if (pass === 2) store.failPuts.clear();
        return snapshot("gen1", [{ id: "runA", ver: "v1" }]);
      },
      store,
      "state.json",
      {
        intervalMs: 1,
        signal: controller.signal,
        io,
        log: (l) => lines.push(l),
        sleep: async () => {
          if (pass >= 2) controller.abort();
        },
      },
    );

    expect(pass).toBe(2);
    expect(lines.some((l) => l.includes("pass 1 failed"))).toBe(true);
    expect(lines.some((l) => l.includes("manifest flipped"))).toBe(true);
    // The second pass re-PUT only the object the first one could not write,
    // plus the aggregates and mutable files it never reached.
    expect(store.puts().filter((p) => p === "v1/run/runA/v1/detail.json")).toHaveLength(1);
    // State is persisted after the failed pass too — that is what makes it cheap.
    expect(io.saved).toBe(2);
  });

  test("a render that throws is a failed pass, not a crashed publisher", async () => {
    const controller = new AbortController();
    let calls = 0;
    const summary = await publishLoop(
      async () => {
        if (++calls >= 2) controller.abort();
        throw new Error("the viewer is not up yet");
      },
      new FakeStore(),
      "state.json",
      { signal: controller.signal, intervalMs: 1, io: memoryIo(), log: () => {}, sleep: async () => {} },
    );
    expect(summary.failed).toBe(2);
    expect(summary.published).toBe(0);
  });

  test("a state file it cannot write does not stop the loop", async () => {
    const lines: string[] = [];
    const io: StateIo = {
      load: () => emptyState(),
      save: () => {
        throw new Error("read-only filesystem");
      },
    };
    const summary = await publishLoop(async () => snapshot("gen1", []), new FakeStore(), "state.json", { once: true, io, log: (l) => lines.push(l) });
    expect(summary.published).toBe(1);
    expect(lines.some((l) => l.includes("read-only filesystem"))).toBe(true);
  });
});

describe("sleepMs", () => {
  test("resolves early when the signal aborts", async () => {
    const controller = new AbortController();
    const started = Date.now();
    const waited = sleepMs(30_000, controller.signal);
    controller.abort();
    await waited;
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  test("an already-aborted signal resolves immediately", async () => {
    await sleepMs(30_000, AbortSignal.abort());
  });

  test("a real, tiny interval elapses", async () => {
    await sleepMs(2);
  });
});

describe("describeReport", () => {
  test("says what the pass cost and whether it flipped", async () => {
    const store = new FakeStore();
    const report = await publish(snapshot("gen1", [{ id: "runA", ver: "v1" }]), store, emptyState());
    const line = describeReport(report);
    expect(line).toContain("gen gen1");
    expect(line).toContain("6 put");
    expect(line).toContain("manifest flipped");
  });
});
