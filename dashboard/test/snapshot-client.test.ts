/**
 * The snapshot client: the same `Client` the pages consume, over a bucket of
 * published JSON (docs/PUBLIC-DASHBOARD.md).
 *
 * Three things are worth pinning, and they are the three that can go wrong
 * silently:
 *
 * - **Addressing.** Every method has to reach the artifact the publisher
 *   actually writes, through a manifest that names the generation.
 * - **The memo.** Page poll intervals are stated at their call sites and stay
 *   there; what keeps a 5s poller off the network is the ~30s window here, so
 *   the window is asserted on an injected clock rather than a real one.
 * - **Parity.** `/api/results`' query moves client-side, so the filter is
 *   re-run here against a transcription of the server's own rules
 *   (`runner/viewer/api.ts`' `resultsResponse`) rather than against my reading
 *   of them — including the two bookkeeping counts, which are the half a
 *   silently-wrong filter would not show.
 *
 * No network and no `data/`: every response is a fixture served by an injected
 * fetch, and the fixtures are declared as the shared wire types, so a drift
 * between the viewer's shapes and these is a compile error.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type {
  ApiInfoResponse,
  CampaignsResponse,
  EpisodeIdView,
  EpisodesResponse,
  FleetResponse,
  HarnessView,
  ModelsResponse,
  PositionsResponse,
  ResultRun,
  ResultsResponse,
  RunDetailResponse,
  TrackResponse,
} from "../../runner/viewer/api-types";
import { ApiError } from "../src/api/client";
import {
  SNAPSHOT_STALE_MS,
  createSnapshotClient,
  projectResults,
  snapshotBanner,
} from "../src/api/snapshot-client";

const BASE = "https://data.example";
const GEN = "g-42";
const GENERATED_AT = 1_700_000_000_000;
const ATTRIBUTION = "Runs on the AzerothCore community reconstruction of 3.3.5a.";

/* --- the bucket ------------------------------------------------------- */

interface Bucket {
  fetch: typeof globalThis.fetch;
  /** Every URL asked for, in order — the memo is asserted on this. */
  urls: string[];
}

/**
 * A fake bucket: a path → body map, 404 for anything else. Bodies are cloned
 * per response, so a test cannot accidentally assert on a shared object the
 * client mutated.
 */
function bucket(objects: Record<string, unknown>): Bucket {
  const urls: string[] = [];
  const f = (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    urls.push(url);
    const body = objects[url];
    if (body === undefined) {
      return new Response(JSON.stringify({ error: `no such object: ${url}` }), {
        status: 404,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof globalThis.fetch;
  return { fetch: f, urls };
}

const snapUrl = (name: string): string => `${BASE}/v1/snap/${GEN}/${name}`;

function run(over: Partial<ResultRun> = {}): ResultRun {
  return {
    runId: "r1", model: "m", platform: null, harnessVersion: "harness-0.4", harnessSeries: "0.4",
    extra: false, race: null, raceName: null, class: null, className: null, characterLabel: null,
    campaign: null, cell: null, effort: null, harness: "wrathbench", promptHash: null,
    serverBuild: null, wikiCoords: null, episode: "e90", episodeSource: "stamped",
    episodeOverride: false, toolCalls: null, snippets: null, modelResponses: null, unscored: null,
    startedAt: 1, terminationReason: null, levels: [], maxLevel: null, xp: null, money: null,
    questsCompleted: null, maps: [], character: null, playtimeMs: null, tokens: null,
    actualCost: null, pauseReason: null,
    ...over,
  };
}

/** The published `episode=all&includeOverrides=1` projection, at `harness=all`. */
function resultsArtifact(runs: ResultRun[]): ResultsResponse & { generatedAt: number; attribution: string } {
  return {
    runs,
    episode: "all",
    harness: "all",
    includeOverrides: true,
    filteredOut: 0,
    overridesExcluded: 0,
    now: GENERATED_AT,
    generatedAt: GENERATED_AT,
    attribution: ATTRIBUTION,
  };
}

const FLEET: FleetResponse = {
  present: true,
  server: { phase: "running", since: 1, build: "harness-0.4", detail: "", updatedAt: 1 },
  heartbeatAt: GENERATED_AT - 5_000,
  jobs: [],
  accounts: [],
  paused: [],
  ended: [],
  now: GENERATED_AT,
};

const POSITIONS: PositionsResponse = {
  positions: [
    { runId: "r1", character: null, model: "m", map: 0, x: 1, y: 2, ts: GENERATED_AT - 1_000,
      level: 4, xp: 5, money: null, questsCompleted: null, items: null, harnessVersion: "harness-0.4" },
  ],
};

const INFO: ApiInfoResponse = {
  service: "wrathbench-viewer",
  publicMode: true,
  dashboard: true,
  dashboardBuild: null,
  worldserver: null,
  now: GENERATED_AT,
};

const EPISODES: EpisodesResponse = { episodes: [], untiered: 0, now: GENERATED_AT };
const CAMPAIGNS: CampaignsResponse = { campaigns: [], orphans: 0, configPath: null, now: GENERATED_AT };
const MODELS: ModelsResponse = {
  models: [],
  roster: { path: null, shape: "roster", count: 0, excluded: [] },
  policy: { promoteAtLevel: 10, series: "0.4", paid: null, tiers: {} as ModelsResponse["policy"]["tiers"], maxConcurrent: {} },
  ladderMs: [],
  harness: "all",
  now: GENERATED_AT,
};

const DETAIL = {
  run: { runId: "r1" },
  states: [],
  total: 0,
  tokens: null,
  cost: null,
  playtimeMs: null,
} as unknown as RunDetailResponse;

const TRACK: TrackResponse = { runId: "r1", character: null, model: "m", harnessVersion: "harness-0.4", points: [] };

/** The whole bucket a happy-path test reads, with the runs listing's pointers. */
function fullBucket(runs: ResultRun[] = [run()]): Bucket {
  return bucket({
    [`${BASE}/v1/manifest.json`]: { gen: GEN, generatedAt: GENERATED_AT },
    [`${BASE}/v1/live.json`]: { generatedAt: GENERATED_AT, attribution: ATTRIBUTION, fleet: FLEET, positions: POSITIONS },
    [snapUrl("info.json")]: { ...INFO, generatedAt: GENERATED_AT, attribution: ATTRIBUTION },
    [snapUrl("runs.json")]: {
      generatedAt: GENERATED_AT,
      runs: [{ runId: "r1", snapshot: { detail: "v1/run/r1/7/detail.json", track: "v1/run/r1/7/track.json" } },
             { runId: "unpublished" }],
    },
    [snapUrl("results.json")]: resultsArtifact(runs),
    [snapUrl("episodes.json")]: EPISODES,
    [snapUrl("campaigns.json")]: CAMPAIGNS,
    [snapUrl("models.json")]: MODELS,
    [snapUrl("ladder-e90.json")]: { ...resultsArtifact(runs), episode: "e90", includeOverrides: false },
    [`${BASE}/v1/run/r1/7/detail.json`]: DETAIL,
    [`${BASE}/v1/run/r1/7/track.json`]: TRACK,
  });
}

/* --- addressing ------------------------------------------------------- */

describe("addressing", () => {
  test("every method resolves the manifest once and reads its generation's artifact", async () => {
    const b = fullBucket();
    const c = createSnapshotClient(BASE, { fetch: b.fetch });
    await c.info();
    await c.runs();
    await c.episodes();
    await c.campaigns();
    await c.models();
    await c.results("all", true, "all");
    await c.ladder("e90");
    await c.fleet();
    await c.positions();
    expect(b.urls).toEqual([
      `${BASE}/v1/manifest.json`,
      snapUrl("info.json"),
      snapUrl("runs.json"),
      snapUrl("episodes.json"),
      snapUrl("campaigns.json"),
      snapUrl("models.json"),
      snapUrl("results.json"),
      snapUrl("ladder-e90.json"),
      // Both halves of the fast lane ride in one object, fetched once.
      `${BASE}/v1/live.json`,
    ]);
  });

  test("a trailing slash on the base does not double up", async () => {
    const b = fullBucket();
    await createSnapshotClient(`${BASE}/`, { fetch: b.fetch }).info();
    expect(b.urls).toEqual([`${BASE}/v1/manifest.json`, snapUrl("info.json")]);
  });

  test("fleet and positions are the one live object, split into the two response shapes", async () => {
    const c = createSnapshotClient(BASE, { fetch: fullBucket().fetch });
    const fleet = await c.fleet();
    const positions = await c.positions();
    expect(fleet.present).toBe(true);
    expect(fleet.now).toBe(GENERATED_AT);
    expect(positions.positions).toHaveLength(1);
    // The envelope travels onto each half, so a page can age either one.
    expect((fleet as { generatedAt?: number }).generatedAt).toBe(GENERATED_AT);
    expect((positions as { attribution?: string }).attribution).toBe(ATTRIBUTION);
  });

  test("the ladder is one file per tier: it is fetched, never filtered", async () => {
    const b = fullBucket([run(), run({ runId: "r2", harness: "claude-code" })]);
    const got = await createSnapshotClient(BASE, { fetch: b.fetch }).ladder("e90");
    expect(got.runs).toHaveLength(2);
    expect(b.urls).toContain(snapUrl("ladder-e90.json"));
  });
});

/* --- the memo --------------------------------------------------------- */

describe("the memo", () => {
  test("repeats inside the window resolve from memory; past it they go back out", async () => {
    const b = fullBucket();
    let clock = 1_000;
    const c = createSnapshotClient(BASE, { fetch: b.fetch, now: () => clock, ttlMs: 30_000 });
    await c.info();
    expect(b.urls).toHaveLength(2);
    // A page polling at 5s: four more ticks, no more requests.
    for (const at of [6_000, 11_000, 16_000, 21_000]) {
      clock = at;
      await c.info();
    }
    expect(b.urls).toHaveLength(2);
    // Past the window both the manifest and the artifact are asked for again.
    clock = 31_001;
    await c.info();
    expect(b.urls).toHaveLength(4);
  });

  test("concurrent callers share one request rather than racing", async () => {
    const b = fullBucket();
    const c = createSnapshotClient(BASE, { fetch: b.fetch, now: () => 0 });
    await Promise.all([c.info(), c.info(), c.episodes()]);
    expect(b.urls).toEqual([`${BASE}/v1/manifest.json`, snapUrl("info.json"), snapUrl("episodes.json")]);
  });

  test("a failed fetch is not remembered: the next poll is the retry", async () => {
    const b = bucket({});
    const c = createSnapshotClient(BASE, { fetch: b.fetch, now: () => 0 });
    await expect(c.info()).rejects.toThrow(ApiError);
    await expect(c.info()).rejects.toThrow(ApiError);
    // Two attempts at the manifest, not one attempt and a remembered failure.
    expect(b.urls.filter((u) => u.endsWith("manifest.json"))).toHaveLength(2);
  });

  test("a non-2xx carries the status a page needs, and the bucket's own message", async () => {
    const c = createSnapshotClient(BASE, { fetch: bucket({}).fetch });
    const err = (await c.runs().catch((e: unknown) => e)) as ApiError;
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(404);
    expect(err.message).toContain("no such object");
  });
});

/* --- results parity --------------------------------------------------- */

/**
 * `runner/viewer/api.ts`' `resultsResponse`, transcribed.
 *
 * The oracle is deliberately a second copy of the server's rules rather than a
 * call into `projectResults`: the point of the assertion is that two
 * independent readings of the same handler agree, so the filter can be moved
 * client-side without the public site quietly showing a different set from the
 * private one.
 */
function serverResults(
  everything: readonly ResultRun[],
  episode: EpisodeIdView | "all",
  includeOverrides: boolean,
  harness: HarnessView | "all",
): ResultsResponse {
  const all = harness === "all" ? [...everything] : everything.filter((r) => r.harness === harness);
  const tiered =
    episode === "all"
      ? all
      : all.filter(
          (r) => r.episode === episode && r.episodeSource === "stamped" && (includeOverrides || !r.episodeOverride),
        );
  const runs = tiered;
  return {
    runs,
    episode,
    harness,
    includeOverrides,
    filteredOut: everything.length - runs.length,
    overridesExcluded:
      episode === "all" || includeOverrides
        ? 0
        : all.filter((r) => r.episode === episode && r.episodeSource === "stamped" && r.episodeOverride).length,
    now: GENERATED_AT,
  };
}

/**
 * One row of every shape the filter can tell apart: both harnesses, both
 * tiers, a derived label (countable, never a member), an overridden tier run
 * (shown only when asked for by name), and a run belonging to no tier at all.
 */
const CORPUS: ResultRun[] = [
  run({ runId: "a", episode: "e90", episodeSource: "stamped", harness: "wrathbench" }),
  run({ runId: "b", episode: "e90", episodeSource: "stamped", harness: "claude-code" }),
  run({ runId: "c", episode: "e90", episodeSource: "stamped", episodeOverride: true, harness: "wrathbench" }),
  run({ runId: "d", episode: "e90", episodeSource: "stamped", episodeOverride: true, harness: "claude-code" }),
  run({ runId: "e", episode: "e90", episodeSource: "derived", harness: "wrathbench" }),
  run({ runId: "f", episode: "e360", episodeSource: "stamped", harness: "wrathbench" }),
  run({ runId: "g", episode: "e360", episodeSource: "stamped", episodeOverride: true, harness: "claude-code" }),
  run({ runId: "h", episode: "freeplay", episodeSource: "derived", harness: "wrathbench" }),
  run({ runId: "i", episode: "probing", episodeSource: "stamped", harness: "claude-code" }),
  run({ runId: "j", episode: null, episodeSource: "none", harness: null }),
];

const EPISODE_CHOICES: (EpisodeIdView | "all")[] = ["all", "e90", "e360", "probing", "freeplay"];
const HARNESS_CHOICES: (HarnessView | "all")[] = ["all", "wrathbench", "claude-code"];

describe("results, filtered client-side", () => {
  test("every episode × includeOverrides × harness combination matches the server's own rules", () => {
    const source = resultsArtifact(CORPUS);
    let checked = 0;
    for (const episode of EPISODE_CHOICES) {
      for (const includeOverrides of [false, true]) {
        for (const harness of HARNESS_CHOICES) {
          const got = projectResults(source, episode, includeOverrides, harness);
          const want = serverResults(CORPUS, episode, includeOverrides, harness);
          expect({ episode, includeOverrides, harness, got }).toEqual({ episode, includeOverrides, harness, got: want });
          // The rows themselves, by id, so a right count over wrong rows fails.
          expect(got.runs.map((r) => r.runId)).toEqual(want.runs.map((r) => r.runId));
          checked++;
        }
      }
    }
    expect(checked).toBe(EPISODE_CHOICES.length * 2 * HARNESS_CHOICES.length);
  });

  test("the counts are the ones the wire type promises, spelled out", () => {
    const source = resultsArtifact(CORPUS);
    const e90 = projectResults(source, "e90", false, "all");
    // Members only: a, b. Derived `e` and overridden `c`/`d` are not members.
    expect(e90.runs.map((r) => r.runId)).toEqual(["a", "b"]);
    expect(e90.filteredOut).toBe(CORPUS.length - 2);
    expect(e90.overridesExcluded).toBe(2);
    // Asked for by name, the overridden runs come back and none are excluded.
    const wide = projectResults(source, "e90", true, "all");
    expect(wide.runs.map((r) => r.runId)).toEqual(["a", "b", "c", "d"]);
    expect(wide.overridesExcluded).toBe(0);
    /*
     * The harness narrows first, so `overridesExcluded` counts inside the
     * narrowed set — it is what `includeOverrides=1` would bring back for THIS
     * view, not for the unfiltered one.
     */
    const one = projectResults(source, "e90", false, "claude-code");
    expect(one.runs.map((r) => r.runId)).toEqual(["b"]);
    expect(one.overridesExcluded).toBe(1);
    // `filteredOut` is against every row the artifact holds, harness included.
    expect(one.filteredOut).toBe(CORPUS.length - 1);
    // `all` lifts the tier filter, and there is then no override to exclude.
    const every = projectResults(source, "all", false, "all");
    expect(every.runs).toHaveLength(CORPUS.length);
    expect(every.filteredOut).toBe(0);
    expect(every.overridesExcluded).toBe(0);
  });

  test("the response's own clock travels with the rows; the browser's is never stamped on", () => {
    expect(projectResults(resultsArtifact(CORPUS), "all", false, "all").now).toBe(GENERATED_AT);
  });

  test("an omitted episode is the server's default, e90 — not `all`", async () => {
    const c = createSnapshotClient(BASE, { fetch: fullBucket(CORPUS).fetch });
    const got = await c.results();
    expect(got.episode).toBe("e90");
    expect(got.runs.map((r) => r.runId)).toEqual(["a", "b"]);
    expect(got.includeOverrides).toBe(false);
    expect(got.harness).toBe("all");
  });

  test("the runs page's own call — all tiers, overrides in — is the artifact whole", async () => {
    const c = createSnapshotClient(BASE, { fetch: fullBucket(CORPUS).fetch });
    const got = await c.results("all", true, "all");
    expect(got.runs).toHaveLength(CORPUS.length);
    expect((got as { generatedAt?: number }).generatedAt).toBe(GENERATED_AT);
  });
});

describe("models, filtered client-side", () => {
  const row = (name: string, harness: HarnessView): ModelsResponse["models"][number] =>
    ({ name, harness }) as unknown as ModelsResponse["models"][number];

  test("the harness filter is the row predicate the server applies, and is echoed", async () => {
    const objects = {
      [`${BASE}/v1/manifest.json`]: { gen: GEN, generatedAt: GENERATED_AT },
      [snapUrl("models.json")]: { ...MODELS, models: [row("x", "wrathbench"), row("y", "claude-code")] },
    };
    const c = createSnapshotClient(BASE, { fetch: bucket(objects).fetch });
    expect((await c.models()).models.map((m) => m.name)).toEqual(["x", "y"]);
    const one = await c.models("claude-code");
    expect(one.models.map((m) => m.name)).toEqual(["y"]);
    expect(one.harness).toBe("claude-code");
    // The roster and policy halves are harness-independent and pass through.
    expect(one.roster).toEqual(MODELS.roster);
    expect(one.policy).toEqual(MODELS.policy);
  });
});

/* --- per-run artifacts and the withheld routes ------------------------ */

describe("per-run artifacts", () => {
  test("a run's detail and track are found through the listing's pointer", async () => {
    const b = fullBucket();
    const c = createSnapshotClient(BASE, { fetch: b.fetch });
    expect((await c.run("r1")).run.runId).toBe("r1");
    expect((await c.track("r1")).runId).toBe("r1");
    expect(b.urls).toEqual([
      `${BASE}/v1/manifest.json`,
      snapUrl("runs.json"),
      `${BASE}/v1/run/r1/7/detail.json`,
      // The listing is memoised, so the second lookup costs no request.
      `${BASE}/v1/run/r1/7/track.json`,
    ]);
  });

  test("a run the listing does not name is a 404, in the viewer's own words", async () => {
    const c = createSnapshotClient(BASE, { fetch: fullBucket().fetch });
    const err = (await c.run("nope").catch((e: unknown) => e)) as ApiError;
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(404);
    expect(err.message).toContain("no such run: nope");
  });

  test("a run with no published artifact is a 404 too, and says which one is missing", async () => {
    const c = createSnapshotClient(BASE, { fetch: fullBucket().fetch });
    const err = (await c.track("unpublished").catch((e: unknown) => e)) as ApiError;
    expect(err.status).toBe(404);
    expect(err.message).toContain("no published track");
  });
});

describe("what a bucket cannot serve", () => {
  test("entries and raw are 403, the way the viewer's public mode answers", async () => {
    const c = createSnapshotClient(BASE, { fetch: fullBucket().fetch });
    for (const call of [c.entries("r1"), c.raw("r1", 0)]) {
      const err = (await call.catch((e: unknown) => e)) as ApiError;
      expect(err).toBeInstanceOf(ApiError);
      expect(err.status).toBe(403);
      expect(err.message).toContain("withheld in snapshot mode");
    }
  });

  test("there is no stream URL, so nothing can open one by accident", () => {
    expect(createSnapshotClient(BASE).streamUrl("r1")).toBe("");
  });
});

/*
 * The 403 above is the backstop, not the design. A withheld route reached in
 * the public build would reject the continuation that asked for it — on the run
 * page that continuation also owns the summary, the charts and the live poll —
 * so the pages must not ask at all, and what they show instead is a statement
 * of what this build publishes rather than an error.
 *
 * Asserted against the source the way the fleet page's own shape is
 * (`status.test.ts`): this is component wiring with no pure seam to call, and a
 * DOM harness for three build-flag branches would test the harness.
 */
describe("the public build's call sites", () => {
  const read = (p: string): string => readFileSync(join(import.meta.dir, p), "utf8");

  test("the run page asks for neither the entries nor the tail, and says why", () => {
    const src = read("../src/pages/RunDetail.tsx");
    // The first window: taken only on the private path, with the entry count
    // coming off the published detail instead.
    expect(src).toMatch(/if \(SNAPSHOT_MODE\) \{[\s\S]{0,120}\} else \{[\s\S]{0,200}api\.entries\(/);
    // "load earlier": guarded at the call site, not left to an unreachable button.
    expect(src).toMatch(/if \(SNAPSHOT_MODE\) return;[\s\S]{0,300}api\.entries\(/);
    // The tail: no EventSource is constructed in the public build.
    expect(src).toMatch(/if \(SNAPSHOT_MODE\) return;[\s\S]{0,400}subscribeTail\(/);
    // The panel, stated plainly and not in the page's error styling.
    expect(src).toContain("Trajectory entries are withheld on the public site.");
    expect(src).toMatch(/fallback=\{<p class="dim">Trajectory entries are withheld/);
  });

  test("the map draws its labelled grid without asking for a tile", () => {
    // Tiles are the only Blizzard-derived bytes in the stack and never leave
    // the lab, so the public build must not spend a request per visible cell
    // finding that out.
    expect(read("../src/pages/MapPage.tsx")).toContain("useTiles = !SNAPSHOT_MODE &&");
  });
});

/* --- freshness -------------------------------------------------------- */

describe("freshness", () => {
  test("the freshest stamp any artifact carried is what the shell reports", async () => {
    const objects = {
      [`${BASE}/v1/manifest.json`]: { gen: GEN, generatedAt: GENERATED_AT - 60_000 },
      [snapUrl("info.json")]: { ...INFO, generatedAt: GENERATED_AT - 120_000, attribution: ATTRIBUTION },
      [`${BASE}/v1/live.json`]: { generatedAt: GENERATED_AT, fleet: FLEET, positions: POSITIONS },
    };
    const c = createSnapshotClient(BASE, { fetch: bucket(objects).fetch });
    expect(c.snapshot.state()).toEqual({ generatedAt: null, attribution: null });
    await c.info();
    // The aggregates are older than the manifest that points at them; the
    // newest reading is what "data as of" means.
    expect(c.snapshot.state()).toEqual({ generatedAt: GENERATED_AT - 60_000, attribution: ATTRIBUTION });
    await c.fleet();
    expect(c.snapshot.state().generatedAt).toBe(GENERATED_AT);
  });

  test("a subscriber is told on change, and stops being told once it unsubscribes", async () => {
    const c = createSnapshotClient(BASE, { fetch: fullBucket().fetch });
    const seen: string[] = [];
    const off = c.snapshot.subscribe((s) => seen.push(`${String(s.generatedAt)}/${String(s.attribution)}`));
    // Two changes: the manifest's stamp, then the attribution the artifact
    // carries. Only a change notifies — a repeat of what is already held does not.
    await c.info();
    expect(seen).toEqual([`${GENERATED_AT}/null`, `${GENERATED_AT}/${ATTRIBUTION}`]);
    off();
    await c.fleet();
    expect(seen).toHaveLength(2);
  });

  test("the banner says how stale, and turns warning-coloured once a push is evidently missed", () => {
    const at = { generatedAt: GENERATED_AT, attribution: null };
    expect(snapshotBanner({ generatedAt: null, attribution: null }, GENERATED_AT)).toBe(null);
    expect(snapshotBanner(at, GENERATED_AT + 42_000)).toEqual({
      text: "public snapshot · data as of 42s ago",
      tone: "dim",
    });
    expect(snapshotBanner(at, GENERATED_AT + SNAPSHOT_STALE_MS - 1)!.tone).toBe("dim");
    expect(snapshotBanner(at, GENERATED_AT + SNAPSHOT_STALE_MS)!.tone).toBe("warn");
    // A reader whose clock is behind the publisher's reads "0s ago", never a
    // negative age.
    expect(snapshotBanner(at, GENERATED_AT - 60_000)!.text).toBe("public snapshot · data as of 0s ago");
  });
});
