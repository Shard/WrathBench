/**
 * Render the viewer API into a set of static public JSON artifacts.
 *
 * The renderer calls the viewer's own `createApi` handler in-process — the
 * same routes, the same derivations — and then passes every parsed body
 * through `public-projection.ts` before it is serialized. That order is the
 * point: the public numbers cannot drift from the private viewer because they
 * ARE the private viewer's, and nothing reaches an artifact without crossing
 * the projection. The routes that carry verbatim game text or Blizzard bytes
 * (entries, raw lines, scratchpads, tiles) are simply never requested, so no
 * artifact exists for them.
 *
 * Layout (a publisher pushes these to a bucket; a static dashboard reads them):
 * - `v1/manifest.json` and `v1/live.json` are the two mutable keys, cached
 *   briefly — the manifest names the current generation, live is the
 *   fleet/positions poll.
 * - `v1/snap/<gen>/…` and `v1/run/<id>/<ver>/…` are content-addressed and
 *   immutable: a re-render of unchanged input lands on the same keys, so a
 *   client may cache them forever.
 *
 * `gen` and each run's `<ver>` are hashed over the PROJECTED payloads before
 * the envelope goes on: the envelope carries `generatedAt`, and a timestamp in
 * the hashed content would make every render a new generation even when
 * nothing changed.
 */

import { join } from "node:path";
import { createApi } from "./api";
import { EPISODE_IDS } from "../src/episodes";
import type {
  ApiInfoResponse,
  CampaignsResponse,
  EpisodesResponse,
  FleetResponse,
  ModelsResponse,
  PositionsResponse,
  ResultsResponse,
  RunDetailResponse,
  RunsResponse,
  TrackResponse,
} from "./api-types";
import {
  PUBLIC_ATTRIBUTION,
  projectCampaigns,
  projectEpisodes,
  projectFleet,
  projectInfo,
  projectModels,
  projectPositions,
  projectResults,
  projectRunDetail,
  projectRuns,
  projectTrack,
} from "./public-projection";

/** The two mutable keys are polled; everything else is content-addressed. */
export const MUTABLE_CACHE = "public, max-age=30";
export const IMMUTABLE_CACHE = "public, max-age=31536000, immutable";

export interface SnapshotArtifact {
  /** Bucket key, no leading slash, e.g. `v1/snap/<gen>/runs.json`. */
  path: string;
  /** Serialized JSON. */
  body: string;
  contentType: "application/json";
  cacheControl: string;
}

export interface SnapshotResult {
  gen: string;
  artifacts: SnapshotArtifact[];
}

/**
 * First 12 hex of SHA-256: enough to address content, short enough for keys.
 *
 * Exported for the addressing test, which pins the digest against a reference
 * SHA-256 — these twelve characters are bucket keys a client may cache
 * forever, so the hasher underneath them is not free to change.
 */
export function hash12(body: string): string {
  return new Bun.CryptoHasher("sha256").update(body, "utf8").digest("hex").slice(0, 12);
}

/**
 * Serialize a projected payload for ADDRESSING (`gen`, per-run `<ver>`), with
 * the volatile clock zeroed.
 *
 * Several responses stamp a top-level `now` (results, ladder, episodes,
 * campaigns, models, info) that moves with wall clock, not with data; hashed
 * as-is it would make every render a new generation, and the publisher would
 * re-upload the whole aggregate set every pass of an idle fleet. So the hash
 * sees a copy with `now: 0` while the EMITTED body keeps the real value.
 * Nothing else is normalized on purpose: a live run's growing playtime,
 * `lastTs` or `live` flag are data, and a changed generation is then correct.
 * The same holds for the scheduler's clock-crossings in models.json — a
 * cooldown expiring or a pause going stale flips a status the models page
 * shows, so the gen moving on those (rare, boundary) events is deliberate.
 * The invariant is "no data change and no state-visible clock crossing ⇒
 * same gen", not "idle wall clock ⇒ same gen".
 * (The spread below builds a hash-only local copy of an already-projected
 * payload, never anything emitted — the projection's no-spread rule is about
 * what ships.)
 */
function addressable(payload: object): string {
  const o = payload as Record<string, unknown>;
  return JSON.stringify(typeof o["now"] === "number" ? { ...o, now: 0 } : o);
}

export interface RendererOptions {
  runsDir: string;
  fleetConfigPath?: string;
  moduleUrl?: string;
  /**
   * The viewer handle to render from. Built from the options above when
   * omitted; injected by the tests that need to disturb the runs directory
   * partway through a pass.
   */
  api?: (req: Request) => Promise<Response>;
}

/**
 * How many runs are in flight at once in the per-run pass.
 *
 * The two per-run routes are file reads, so the pass is latency-bound rather
 * than CPU-bound and overlapping them is most of the win; the bound is there
 * because a runs directory holds hundreds of runs and the viewer serialises
 * its scans per run, not globally.
 */
const RUN_CONCURRENCY = 8;

/**
 * Build a renderer that can run pass after pass over one viewer handle.
 *
 * The handle is the reason this exists. `createApi` keeps its trajectory
 * memos — the (size, mtime) totals cache and the per-run fact cache — in its
 * own closure, so a publisher that built a fresh handle every pass would
 * re-read every trajectory in the runs directory once a minute, forever. One
 * handle across passes means a finished run is read once per process and a
 * live one only as it grows, which is exactly what those caches were for.
 *
 * `render(now)` is otherwise self-contained: nothing but the handle survives a
 * pass, so two renders of unchanged input still land on the same addresses.
 */
export function createRenderer(opts: RendererOptions): (now?: number) => Promise<SnapshotResult> {
  const handle =
    opts.api ??
    createApi({
      runsDir: opts.runsDir,
      // Never read: public mode withholds /tiles before the path is resolved,
      // and the renderer requests no tile anyway. A directory that need not exist.
      tilesDir: join(opts.runsDir, "tiles-unused"),
      publicMode: true,
      // An unroutable loopback port by default, so a render on a machine with no
      // worldserver reports `worldserver: null` quickly instead of hanging.
      moduleUrl: opts.moduleUrl ?? "http://127.0.0.1:1",
      ...(opts.fleetConfigPath !== undefined ? { fleetConfigPath: opts.fleetConfigPath } : {}),
    });

  /** A route that must answer, or the pass is not a snapshot. */
  const get = async <T>(path: string): Promise<T> => {
    const res = await handle(new Request(`http://snapshot.local${path}`));
    if (res.status !== 200) throw new Error(`snapshot render: ${path} answered ${res.status}`);
    return (await res.json()) as T;
  };

  /**
   * A per-run route, where a 404 is a fact about the world rather than a fault.
   *
   * The runner archives a finished run by moving its directory out of the runs
   * directory, and a run listed at the top of a pass may be gone by the time
   * this pass asks about it. That must cost the run's two artifacts and
   * nothing else: throwing here would drop `live.json` too, so an archive
   * would blind the whole dashboard for an interval. Any other status is still
   * a fault and still throws.
   */
  const getIfPresent = async <T>(path: string): Promise<T | null> => {
    const res = await handle(new Request(`http://snapshot.local${path}`));
    if (res.status === 404) return null;
    if (res.status !== 200) throw new Error(`snapshot render: ${path} answered ${res.status}`);
    return (await res.json()) as T;
  };

  return async function render(nowArg?: number): Promise<SnapshotResult> {
    const now = nowArg ?? Date.now();

    // Everything below is projected the moment it is parsed, so no unprojected
    // body exists past this block for a later step to serialize by mistake.
    const info = projectInfo(await get<ApiInfoResponse>("/api/info"));
    const runs = projectRuns(await get<RunsResponse>("/api/runs"));
    const results = projectResults(await get<ResultsResponse>("/api/results?episode=all&includeOverrides=1"));
    const ladders: [string, ResultsResponse][] = [];
    // `probing` has no ladder (operator, 2026-08-29; the reason is at
    // `LADDER_EPISODES` in api.ts), so no `ladder-probing.json` is published.
    for (const ep of EPISODE_IDS.filter((id) => id !== "probing")) {
      ladders.push([ep, projectResults(await get<ResultsResponse>(`/api/ladder?episode=${ep}`))]);
    }
    const episodes = projectEpisodes(await get<EpisodesResponse>("/api/episodes"));
    const models = projectModels(await get<ModelsResponse>("/api/models"));
    const campaigns = projectCampaigns(await get<CampaignsResponse>("/api/campaigns"));
    const fleet = projectFleet(await get<FleetResponse>("/api/fleet"));
    const positions = projectPositions(await get<PositionsResponse>("/api/positions"));

    /** Envelope and serialize one projected payload. */
    const envelope = (payload: object): string =>
      JSON.stringify({ generatedAt: now, attribution: PUBLIC_ATTRIBUTION, ...payload });

    /*
     * Per-run artifacts first: `runs.json` rows carry the resulting paths, so
     * the run addressing has to settle before the snap bodies are hashed. `ver`
     * is the projected detail payload's own hash — a finished run re-renders to
     * the same key, a changed one (a live run that grew) claims a new one, and
     * the row is what tells a client which is current.
     *
     * The pool overlaps the file reads; the results are parked by listing
     * position so the artifact order is the listing's, not the order the pool
     * happened to finish in. A run whose two artifacts are missing leaves its
     * slot empty and its row pointerless, which is what the snapshot client
     * already reads as "no published detail for this run".
     */
    const rows = runs.runs;
    const perRun: (SnapshotArtifact[] | undefined)[] = new Array(rows.length);
    let next = 0;
    const worker = async (): Promise<void> => {
      for (let i = next++; i < rows.length; i = next++) {
        const row = rows[i]!;
        const id = encodeURIComponent(row.runId);
        const [detail, track] = await Promise.all([
          getIfPresent<RunDetailResponse>(`/api/run/${id}`).then((b) => (b === null ? null : projectRunDetail(b))),
          getIfPresent<TrackResponse>(`/api/run/${id}/track`).then((b) => (b === null ? null : projectTrack(b))),
        ]);
        // Either half missing means the run went away mid-pass; a row must
        // never point at half a set, so both are dropped together.
        if (detail === null || track === null) continue;
        const ver = hash12(addressable(detail));
        // Run ids are `isValidRunId`-safe (`[A-Za-z0-9._-]+`), so they are bucket
        // keys as-is; anything else never got a run directory to be listed from.
        const base = `v1/run/${row.runId}/${ver}`;
        const paths = { detail: `${base}/detail.json`, track: `${base}/track.json` };
        perRun[i] = [
          { path: paths.detail, body: envelope(detail), contentType: "application/json", cacheControl: IMMUTABLE_CACHE },
          { path: paths.track, body: envelope(track), contentType: "application/json", cacheControl: IMMUTABLE_CACHE },
        ];
        row.snapshot = paths;
      }
    };
    await Promise.all(Array.from({ length: Math.min(RUN_CONCURRENCY, rows.length) }, worker));
    const artifacts: SnapshotArtifact[] = perRun.flatMap((a) => a ?? []);

    /*
     * The snap set, in a fixed order: `gen` is the hash of these payloads
     * concatenated, so the order is part of the address and must not depend on
     * iteration luck.
     */
    const snap: [string, object][] = [
      ["info.json", info],
      ["runs.json", runs],
      ["results.json", results],
      ...ladders.map(([ep, body]): [string, object] => [`ladder-${ep}.json`, body]),
      ["episodes.json", episodes],
      ["models.json", models],
      ["campaigns.json", campaigns],
    ];
    const gen = hash12(snap.map(([, payload]) => addressable(payload)).join("\n"));

    const out: SnapshotArtifact[] = [
      {
        path: "v1/manifest.json",
        // The envelope's fields plus the one fact the manifest exists for.
        body: JSON.stringify({ gen, generatedAt: now, attribution: PUBLIC_ATTRIBUTION }),
        contentType: "application/json",
        cacheControl: MUTABLE_CACHE,
      },
      {
        path: "v1/live.json",
        body: JSON.stringify({ generatedAt: now, attribution: PUBLIC_ATTRIBUTION, fleet, positions }),
        contentType: "application/json",
        cacheControl: MUTABLE_CACHE,
      },
      ...snap.map(
        ([name, payload]): SnapshotArtifact => ({
          path: `v1/snap/${gen}/${name}`,
          body: envelope(payload),
          contentType: "application/json",
          cacheControl: IMMUTABLE_CACHE,
        }),
      ),
      ...artifacts,
    ];

    return { gen, artifacts: out };
  };
}

/**
 * One pass, one handle: the `--once` shape, and what every existing caller of
 * the renderer wants. A publisher looping every minute should build the
 * renderer once instead — see `createRenderer` for why the handle is worth
 * keeping.
 */
export async function renderSnapshot(
  opts: RendererOptions & {
    /** Injectable clock for tests; stamps `generatedAt` only. Default `Date.now()`. */
    now?: number;
  },
): Promise<SnapshotResult> {
  return await createRenderer(opts)(opts.now);
}
