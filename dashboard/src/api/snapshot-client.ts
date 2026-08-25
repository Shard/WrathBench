/**
 * The same `Client` the pages consume, served out of a bucket of published
 * JSON instead of a viewer's live API (docs/PUBLIC-DASHBOARD.md).
 *
 * The public site is push-based: the lab renders the viewer's own projections
 * on a timer and PUTs them to R2, and no public request ever reaches the lab.
 * So everything here is a GET of a static object, and the only cleverness is
 * where the live API had a query string:
 *
 * - **A generation, resolved once.** `manifest.json` names the current
 *   generation; every aggregate is addressed by it and is immutable. Upload
 *   order is per-run → aggregates → manifest last, so an old manifest points
 *   at a complete old set and a reader can never observe a torn generation.
 * - **Filters move to the client.** `/api/results?episode=…&harness=…` is one
 *   published artifact — the `episode=all&includeOverrides=1` projection —
 *   filtered here by `projectResults`, which reproduces the server's rules
 *   including the bookkeeping counts a page shows.
 * - **A ~30s memo.** Every page states its own poll interval (`lib/poll.ts`)
 *   and those stay exactly as they are; ticks between snapshot refreshes
 *   resolve from memory rather than becoming a request per tick.
 *
 * What a bucket cannot serve is withheld rather than faked: entries and raw
 * bodies answer 403 the way `WRATHBENCH_VIEWER_PUBLIC=1` does, and there is no
 * stream URL.
 */

import type {
  ApiInfoResponse,
  CampaignsResponse,
  EntriesResponse,
  EpisodeIdView,
  EpisodesResponse,
  FleetResponse,
  HarnessView,
  ModelsResponse,
  PositionsResponse,
  ResultsResponse,
  RunDetailResponse,
  RunsResponse,
  SnapshotEnvelope,
  TrackResponse,
} from "@viewer/api-types";
import type { PublicFleetResponse } from "@viewer/public-projection";
import { ApiError, getJson, type Client } from "./client";
import { fmtAge } from "../lib/format";

/**
 * How long a fetched artifact is served from memory.
 *
 * Matched to the `max-age=30` the publisher sets on the two mutable objects:
 * a shorter window would spend requests on an edge that would answer from
 * cache anyway, and a longer one would add staleness the CDN is not adding.
 */
export const SNAPSHOT_TTL_MS = 30_000;

/**
 * Past this age the banner turns warning-coloured.
 *
 * Three clocks exist — the supervisor's heartbeat (30–60s), the publisher's
 * push (60s) and the edge TTL (≤60s) — and this one is about the publisher
 * only: five minutes is several missed pushes, which is a publisher that has
 * evidently stopped rather than a slow one.
 */
export const SNAPSHOT_STALE_MS = 300_000;

/** The server's own `?episode=` default, reproduced client-side. */
const DEFAULT_EPISODE: EpisodeIdView = "e90";

/** What the withheld routes say, in the shape the viewer's public mode says it. */
const WITHHELD = "withheld in snapshot mode";

export interface SnapshotClientOptions {
  /** Injected in tests; defaults to the ambient one. */
  fetch?: typeof globalThis.fetch;
  /** Injected in tests. The memoisation window is measured on this clock. */
  now?: () => number;
  /** The memoisation window; `SNAPSHOT_TTL_MS` by default. */
  ttlMs?: number;
}

/** `v1/manifest.json`: which generation the immutable artifacts are under. */
interface Manifest {
  gen: string;
  generatedAt: number;
}

/**
 * `v1/live.json`: the fast lane, deliberately outside the generation chain.
 * For the fleet pips and the map, freshness beats consistency. The fleet half
 * is the *published* shape — the projection strips the jobs' process facts —
 * so it is typed as what the publisher writes, not as the live API's response.
 */
interface LiveArtifact {
  generatedAt: number;
  attribution?: string;
  fleet: PublicFleetResponse;
  positions: PositionsResponse;
}

/** How fresh the data is, and whose reconstruction it came off. */
export interface SnapshotState {
  /** The freshest `generatedAt` any artifact has carried; null before the first. */
  generatedAt: number | null;
  /** The attribution statement the artifacts carry; null until one does. */
  attribution: string | null;
}

/** The shell's window onto the above: a value now, and a callback on change. */
export interface SnapshotSource {
  state: () => SnapshotState;
  /** Returns the unsubscribe. */
  subscribe: (fn: (state: SnapshotState) => void) => () => void;
}

export interface SnapshotClient extends Client {
  readonly snapshot: SnapshotSource;
}

export interface SnapshotBanner {
  text: string;
  tone: "dim" | "warn";
}

/**
 * The shell's "data as of" line, or null before anything has loaded.
 *
 * This is the one place a server timestamp is aged against the *browser*
 * clock, and it has to be: the question is how long ago the publisher pushed,
 * and every clock inside the artifact was read at the moment it was rendered.
 * A viewer whose clock is wrong reads the age wrong, which is a far smaller
 * lie than the fleet verdict this rule exists to keep off the browser clock
 * (see `supervisorAlive`).
 */
export function snapshotBanner(state: SnapshotState, now: number): SnapshotBanner | null {
  const at = state.generatedAt;
  if (at === null) return null;
  const age = Math.max(0, now - at);
  return {
    text: `public snapshot · data as of ${fmtAge(age)}`,
    tone: age >= SNAPSHOT_STALE_MS ? "warn" : "dim",
  };
}

/**
 * `/api/results`' filter, reproduced over the published projection.
 *
 * The artifact is the `episode=all&includeOverrides=1` projection at
 * `harness=all`, so its rows ARE the server's `everything` and the three
 * filters compose here exactly as they do in `runner/viewer/api.ts`:
 * the harness narrows first (it is a tag on the row, not a partition), then
 * the tier — filtering to a tier means filtering to its *members*, stamped
 * with the id and not overridden, which `includeOverrides` widens.
 *
 * The two counts travel with the rows for the reason the wire type says they
 * do: a chart that silently drops rows is a lie of omission. `filteredOut` is
 * measured against every row the artifact holds (both filters together, as the
 * server measures it), and `overridesExcluded` against the harness-filtered
 * set, which is the set the tier filter actually ran over.
 */
export function projectResults(
  source: ResultsResponse,
  episode: EpisodeIdView | "all",
  includeOverrides: boolean,
  harness: HarnessView | "all",
): ResultsResponse {
  const everything = source.runs;
  const all = harness === "all" ? everything : everything.filter((r) => r.harness === harness);
  const runs =
    episode === "all"
      ? all
      : all.filter(
          (r) =>
            r.episode === episode &&
            r.episodeSource === "stamped" &&
            (includeOverrides || !r.episodeOverride),
        );
  return {
    runs,
    episode,
    harness,
    includeOverrides,
    filteredOut: everything.length - runs.length,
    overridesExcluded:
      episode === "all" || includeOverrides
        ? 0
        : all.filter((r) => r.episode === episode && r.episodeSource === "stamped" && r.episodeOverride)
            .length,
    /*
     * The generation's own clock, not the browser's: `now` is what the runs in
     * this body were read against, and re-stamping it here would claim a
     * freshness the snapshot does not have.
     */
    now: source.now,
  };
}

/** One memoised in-flight or settled fetch. */
interface CacheEntry {
  at: number;
  value: Promise<unknown>;
}

/**
 * Drop every entry whose window has passed. Run on each memo lookup — the only
 * moment the map is touched — because expiry alone does not bound the cache:
 * generation- and version-addressed URLs are never asked for again once the
 * manifest moves on, so an overwrite-on-reuse map would keep every generation
 * a long-lived tab ever saw. Exported for its test.
 */
export function sweepExpired(cache: Map<string, { at: number }>, now: number, ttlMs: number): void {
  for (const [url, entry] of cache) {
    if (now - entry.at >= ttlMs) cache.delete(url);
  }
}

export function createSnapshotClient(base: string, opts: SnapshotClientOptions = {}): SnapshotClient {
  const f = opts.fetch ?? globalThis.fetch;
  const clock = opts.now ?? ((): number => Date.now());
  const ttl = opts.ttlMs ?? SNAPSHOT_TTL_MS;
  const root = base.replace(/\/+$/, "");
  const cache = new Map<string, CacheEntry>();

  let generatedAt: number | null = null;
  let attribution: string | null = null;
  const watchers = new Set<(state: SnapshotState) => void>();
  const state = (): SnapshotState => ({ generatedAt, attribution });

  /**
   * Record what an artifact says about itself. The freshest stamp wins across
   * artifacts, because the fast lane and the aggregates are pushed on
   * different cadences and the shell reports the newest thing it holds.
   */
  function saw(body: unknown): void {
    if (typeof body !== "object" || body === null) return;
    const env = body as { generatedAt?: unknown; attribution?: unknown };
    let changed = false;
    if (typeof env.generatedAt === "number" && (generatedAt === null || env.generatedAt > generatedAt)) {
      generatedAt = env.generatedAt;
      changed = true;
    }
    if (typeof env.attribution === "string" && env.attribution !== "" && env.attribution !== attribution) {
      attribution = env.attribution;
      changed = true;
    }
    if (!changed) return;
    const next = state();
    for (const w of watchers) w(next);
  }

  async function fetchJson<T>(url: string): Promise<T> {
    const body = await getJson<T>(url, f);
    saw(body);
    return body;
  }

  /**
   * The memo. Promises rather than values, so the burst of pollers that starts
   * on a page load shares one request; a rejection is forgotten immediately,
   * because the next poll is the retry and a remembered failure would make a
   * blip last the whole window.
   */
  function memo<T>(url: string): Promise<T> {
    const at = clock();
    sweepExpired(cache, at, ttl);
    const hit = cache.get(url);
    if (hit !== undefined && at - hit.at < ttl) return hit.value as Promise<T>;
    const value = fetchJson<T>(url);
    cache.set(url, { at, value });
    void value.catch(() => {
      if (cache.get(url)?.value === value) cache.delete(url);
    });
    return value;
  }

  const manifest = (): Promise<Manifest> => memo<Manifest>(`${root}/v1/manifest.json`);
  const live = (): Promise<LiveArtifact> => memo<LiveArtifact>(`${root}/v1/live.json`);

  /** One generation-addressed aggregate. Immutable once the manifest names it. */
  async function snap<T>(name: string): Promise<T> {
    const m = await manifest();
    return await memo<T>(`${root}/v1/snap/${encodeURIComponent(m.gen)}/${name}`);
  }

  /*
   * A pointer out of `runs.json` is always a bucket key relative to the root —
   * the publisher rejects leading slashes — so the join is a plain join.
   */
  const artifactUrl = (path: string): string => `${root}/${path}`;

  /**
   * A run's per-run artifact, found through the listing.
   *
   * Per-run bodies are addressed by a content version rather than the
   * generation — they change when the run changes, not when the set does — so
   * the listing is the index, and a run it does not name is a 404 in the same
   * words the viewer uses.
   */
  async function pointer(id: string, which: "detail" | "track"): Promise<string> {
    const artifact = await snap<RunsResponse>("runs.json");
    const row = artifact.runs.find((r) => r.runId === id);
    if (row === undefined) throw new ApiError(404, `no such run: ${id}`);
    const path = row.snapshot?.[which];
    if (path === undefined || path === "") {
      throw new ApiError(404, `no published ${which} for run: ${id}`);
    }
    return artifactUrl(path);
  }

  /** Carry the envelope onto a body split out of a larger artifact. */
  function withEnvelope<T>(body: T, env: SnapshotEnvelope): T {
    const extra: Record<string, unknown> = {};
    if (env.generatedAt !== undefined) extra["generatedAt"] = env.generatedAt;
    if (env.attribution !== undefined) extra["attribution"] = env.attribution;
    if (Object.keys(extra).length === 0) return body;
    return { ...body, ...extra } as T;
  }

  const client: Client = {
    info: (): Promise<ApiInfoResponse> => snap<ApiInfoResponse>("info.json"),
    runs: (): Promise<RunsResponse> => snap<RunsResponse>("runs.json"),
    /*
     * Both halves of the fast lane ride in one object, so the map's pips and
     * the fleet table cannot show two different moments.
     */
    positions: async (): Promise<PositionsResponse> => {
      const l = await live();
      return withEnvelope(l.positions, l);
    },
    fleet: async (): Promise<FleetResponse> => {
      const l = await live();
      /*
       * The one deliberate widening in this file. `Client.fleet()` promises the
       * live shape, but the published fleet's job rows omit the process facts
       * (pid, spawn time, exit code, source — `PublicFleetJobView`). No page
       * reads those fields, so the pages render the projection unchanged; the
       * cast records that the gap is known here rather than hiding it behind a
       * response typed as something the bucket never serves.
       */
      return withEnvelope(l.fleet as FleetResponse, l);
    },
    /*
     * The harness filter is a row predicate the projection already carries, so
     * it reproduces exactly; the roster, policy and ladder halves of the body
     * are harness-independent and pass through untouched.
     */
    models: async (harness: HarnessView | "all" = "all"): Promise<ModelsResponse> => {
      const body = await snap<ModelsResponse>("models.json");
      if (harness === "all") return body;
      return { ...body, models: body.models.filter((m) => m.harness === harness), harness };
    },
    episodes: (): Promise<EpisodesResponse> => snap<EpisodesResponse>("episodes.json"),
    campaigns: (): Promise<CampaignsResponse> => snap<CampaignsResponse>("campaigns.json"),
    results: async (
      episode?: EpisodeIdView | "all",
      includeOverrides = false,
      harness: HarnessView | "all" = "all",
    ): Promise<ResultsResponse> => {
      const source = await snap<ResultsResponse>("results.json");
      // `undefined` is the caller declining to choose, which the server answers
      // with e90 — the one default, kept in one place by reproducing it here.
      return withEnvelope(projectResults(source, episode ?? DEFAULT_EPISODE, includeOverrides, harness), source);
    },
    /*
     * The ladder is published per tier rather than filtered here: it offers
     * neither `all` nor overridden runs, so one file per tier is the whole
     * surface and there is nothing left to narrow.
     */
    ladder: (episode: EpisodeIdView): Promise<ResultsResponse> =>
      snap<ResultsResponse>(`ladder-${encodeURIComponent(episode)}.json`),
    track: async (id: string): Promise<TrackResponse> => await memo<TrackResponse>(await pointer(id, "track")),
    run: async (id: string): Promise<RunDetailResponse> =>
      await memo<RunDetailResponse>(await pointer(id, "detail")),
    /*
     * Entry summaries and raw trajectory lines carry model output and verbatim
     * game text, which docs/DATA-AND-LEGAL.md does not let out of the lab. The
     * publisher never renders them; these answer the way the viewer's public
     * mode answers, which the pages already show as a banner over the rest.
     */
    entries: async (): Promise<EntriesResponse> => {
      throw new ApiError(403, `entries: ${WITHHELD}`);
    },
    raw: async (): Promise<string> => {
      throw new ApiError(403, `raw: ${WITHHELD}`);
    },
    /** There is no stream behind a bucket; the call site guards on the mode. */
    streamUrl: (): string => "",
  };

  return {
    ...client,
    snapshot: {
      state,
      subscribe: (fn: (next: SnapshotState) => void): (() => void) => {
        watchers.add(fn);
        return () => watchers.delete(fn);
      },
    },
  };
}
