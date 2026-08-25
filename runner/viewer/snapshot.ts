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

import { createHash } from "node:crypto";
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

/** First 12 hex of SHA-256: enough to address content, short enough for keys. */
function hash12(body: string): string {
  return createHash("sha256").update(body, "utf8").digest("hex").slice(0, 12);
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
 * (The spread below builds a hash-only local copy of an already-projected
 * payload, never anything emitted — the projection's no-spread rule is about
 * what ships.)
 */
function addressable(payload: object): string {
  const o = payload as Record<string, unknown>;
  return JSON.stringify(typeof o["now"] === "number" ? { ...o, now: 0 } : o);
}

export async function renderSnapshot(opts: {
  runsDir: string;
  fleetConfigPath?: string;
  moduleUrl?: string;
  /** Injectable clock for tests; stamps `generatedAt` only. Default `Date.now()`. */
  now?: number;
}): Promise<SnapshotResult> {
  const now = opts.now ?? Date.now();
  const handle = createApi({
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

  const get = async <T>(path: string): Promise<T> => {
    const res = await handle(new Request(`http://snapshot.local${path}`));
    if (res.status !== 200) throw new Error(`snapshot render: ${path} answered ${res.status}`);
    return (await res.json()) as T;
  };

  // Everything below is projected the moment it is parsed, so no unprojected
  // body exists past this block for a later step to serialize by mistake.
  const info = projectInfo(await get<ApiInfoResponse>("/api/info"));
  const runs = projectRuns(await get<RunsResponse>("/api/runs"));
  const results = projectResults(await get<ResultsResponse>("/api/results?episode=all&includeOverrides=1"));
  const ladders: [string, ResultsResponse][] = [];
  for (const ep of EPISODE_IDS) {
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

  const artifacts: SnapshotArtifact[] = [];

  /*
   * Per-run artifacts first: `runs.json` rows carry the resulting paths, so
   * the run addressing has to settle before the snap bodies are hashed. `ver`
   * is the projected detail payload's own hash — a finished run re-renders to
   * the same key, a changed one (a live run that grew) claims a new one, and
   * the row is what tells a client which is current.
   */
  for (const row of runs.runs) {
    const detail = projectRunDetail(await get<RunDetailResponse>(`/api/run/${encodeURIComponent(row.runId)}`));
    const track = projectTrack(await get<TrackResponse>(`/api/run/${encodeURIComponent(row.runId)}/track`));
    const ver = hash12(addressable(detail));
    // Run ids are `isValidRunId`-safe (`[A-Za-z0-9._-]+`), so they are bucket
    // keys as-is; anything else never got a run directory to be listed from.
    const base = `v1/run/${row.runId}/${ver}`;
    const paths = { detail: `${base}/detail.json`, track: `${base}/track.json` };
    artifacts.push({ path: paths.detail, body: envelope(detail), contentType: "application/json", cacheControl: IMMUTABLE_CACHE });
    artifacts.push({ path: paths.track, body: envelope(track), contentType: "application/json", cacheControl: IMMUTABLE_CACHE });
    row.snapshot = paths;
  }

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
}
