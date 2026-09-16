/**
 * The typed client over the viewer's read-only API.
 *
 * Every shape here comes from `runner/viewer/api-types.ts`, which the viewer
 * itself imports — the two sides share one declaration rather than each keeping
 * a copy that drifts. Nothing in this file writes: there is no method that
 * sends a body, because there is no route that takes one.
 *
 * Paths are root-relative, so the same code runs behind Vite's dev proxy and
 * same-origin off the Bun viewer. That is why there is no CORS anywhere.
 */

import type {
  ApiInfoResponse,
  CharacterResponse,
  EntriesResponse,
  EpisodeIdView,
  EpisodesResponse,
  CampaignsResponse,
  ToolsResponse,
  ResultsResponse,
  FleetResponse,
  HarnessView,
  ModelsResponse,
  PositionsResponse,
  RunDetailResponse,
  RunsResponse,
  TrackResponse,
} from "@viewer/api-types";
import { createSnapshotClient, type SnapshotSource } from "./snapshot-client";

export type {
  AgentPosition,
  ApiInfoResponse,
  ComparabilityView,
  CostBreakdown,
  CostView,
  HarnessView,
  EntriesResponse,
  EventsServedEntry,
  EpisodeIdView,
  EpisodeTierView,
  EpisodesResponse,
  CampaignsResponse,
  ToolsResponse,
  ToolView,
  CampaignRowView,
  ResultsResponse,
  ResultRun,
  LevelMark,
  TrackPoint,
  TrackResponse,
  FeedEntry,
  FleetResponse,
  ModelEpisodeView,
  ModelLastErrorView,
  ModelRowView,
  ModelRunView,
  ModelStatusView,
  ModelsResponse,
  PositionsResponse,
  RunDetailResponse,
  RunListRow,
  RunRow,
  RunsResponse,
  StatePoint,
  CharacterAttempt,
  CharacterResponse,
  CharacterStatePoint,
  CharacterCost,
  CharacterTotals,
  CharacterView,
  TokenTotals,
  TpsFacts,
} from "@viewer/api-types";

/** Thrown for any non-2xx. Carries the status so a page can tell 404 from 500. */
export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

/** Path of one entry's raw JSONL line — shared by the fetcher and page hrefs. */
export function rawPath(id: string, i: number): string {
  return `/api/run/${encodeURIComponent(id)}/raw/${i}`;
}

export interface ClientOptions {
  /** Injected in tests; defaults to the ambient one. */
  fetch?: typeof globalThis.fetch;
  /** Prefix for every path. Empty in the browser — the API is same-origin. */
  base?: string;
  /** Injected in tests. The memoisation window is measured on this clock. */
  now?: () => number;
  /** The memoisation window; `LIVE_TTL_MS` by default. */
  ttlMs?: number;
}

/**
 * How long a fetched body is served from memory on the live path.
 *
 * Below the shortest interval any page polls at (5s — the fleet strip and the
 * map's positions, `dashboard/src/lib/poll.ts` states them at their call
 * sites), so no feed's cadence is reduced by this: a tick that comes due always
 * finds its entry expired. Above a page flip, which is what it is for. Flipping
 * between the runs table, the ladder and the fleet page refetches the same
 * ~1MB listing on every mount, and the several feeds a page mounts at once all
 * start their first request in the same tick.
 *
 * Deliberately shorter than `SNAPSHOT_TTL_MS`: that window is matched to the
 * `max-age=30` a CDN is already applying, and there is no edge cache here — a
 * longer window would be staleness this path invents rather than staleness it
 * inherits.
 */
export const LIVE_TTL_MS = 4_000;

/** One memoised in-flight or settled fetch. */
interface CacheEntry {
  at: number;
  value: Promise<unknown>;
}

/**
 * Drop every entry whose window has passed. Run on each memo lookup — the only
 * moment the map is touched — because expiry alone does not bound the cache:
 * a URL carries an episode, a harness and a run id, so a session's worth of
 * navigation mints keys that are never asked for again and an
 * overwrite-on-reuse map would keep every one of them. Exported for its test,
 * and shared with the snapshot client, whose generation-addressed URLs make
 * the same argument more sharply.
 */
export function sweepExpired(cache: Map<string, { at: number }>, now: number, ttlMs: number): void {
  for (const [url, entry] of cache) {
    if (now - entry.at >= ttlMs) cache.delete(url);
  }
}

/**
 * The one JSON GET both clients share (the snapshot client wraps it to record
 * each body's envelope). Exported so the bucket-backed client does not keep a
 * near-verbatim copy that drifts.
 */
export async function getJson<T>(url: string, f: typeof globalThis.fetch = globalThis.fetch): Promise<T> {
  const res = await f(url, { headers: { accept: "application/json" } });
  if (!res.ok) {
    // The API answers errors as `{ error }`; a proxy or a bucket in the way may not.
    let detail = `${res.status}`;
    try {
      const body = (await res.json()) as { error?: unknown };
      if (typeof body.error === "string") detail = body.error;
    } catch {
      /* a non-JSON error body is still an error */
    }
    throw new ApiError(res.status, `${url}: ${detail}`);
  }
  return (await res.json()) as T;
}

/** The shared `?episode=`/`?includeOverrides=`/`?harness=` query. */
function resultsQuery(
  episode: EpisodeIdView | "all" | undefined,
  includeOverrides: boolean,
  harness: HarnessView | "all" = "all",
): string {
  const q = new URLSearchParams();
  if (episode !== undefined) q.set("episode", episode);
  if (includeOverrides) q.set("includeOverrides", "1");
  // `all` is the server default (harness is a tag, not a partition).
  if (harness !== "all") q.set("harness", harness);
  const s = q.toString();
  return s === "" ? "" : `?${s}`;
}

export function createClient(opts: ClientOptions = {}) {
  const f = opts.fetch ?? globalThis.fetch;
  const clock = opts.now ?? ((): number => Date.now());
  const ttl = opts.ttlMs ?? LIVE_TTL_MS;
  const cache = new Map<string, CacheEntry>();

  /**
   * The memo, the same one `snapshot-client.ts` runs and for the same two
   * reasons. Promises rather than values, so the burst of feeds a page mounts
   * shares one request per URL; a rejection is forgotten immediately, because
   * the next poll is the retry and a remembered failure would make a blip last
   * the whole window.
   *
   * Every route here is a GET with no body and no side effect, so two callers
   * within the window genuinely want the same answer. `poll()`'s `refresh()`
   * rides on it too: the two call sites that use it either change the URL
   * (the ladder's episode) or sit on a 5s feed, so neither can be served
   * anything older than the page's own cadence already allows.
   */
  function get<T>(path: string): Promise<T> {
    const url = `${opts.base ?? ""}${path}`;
    const at = clock();
    sweepExpired(cache, at, ttl);
    const hit = cache.get(url);
    if (hit !== undefined && at - hit.at < ttl) return hit.value as Promise<T>;
    const value = getJson<T>(url, f);
    cache.set(url, { at, value });
    void value.catch(() => {
      if (cache.get(url)?.value === value) cache.delete(url);
    });
    return value;
  }

  return {
    info: (): Promise<ApiInfoResponse> => get<ApiInfoResponse>("/api/info"),
    /**
     * The run listing: every run on disk. A launch that produced no model
     * response is archived by the runner as it terminates, so there is nothing
     * to filter here.
     */
    runs: (): Promise<RunsResponse> => get<RunsResponse>("/api/runs"),
    positions: (): Promise<PositionsResponse> => get<PositionsResponse>("/api/positions"),
    fleet: (): Promise<FleetResponse> => get<FleetResponse>("/api/fleet"),
    /**
     * The roster's models with the scheduler's verdict on each.
     * The projection is the supervisor's own, so this page and `--status`
     * cannot disagree about why a model is not running.
     */
    models: (harness: HarnessView | "all" = "all"): Promise<ModelsResponse> =>
      get<ModelsResponse>(`/api/models${harness === "all" ? "" : `?harness=${harness}`}`),
    /** The episode tiers and how many runs sit against each. */
    episodes: (): Promise<EpisodesResponse> => get<EpisodesResponse>("/api/episodes"),
    campaigns: (): Promise<CampaignsResponse> => get<CampaignsResponse>("/api/campaigns"),
    /** The model-facing tool list, read off the runner at request time (the homepage inspector). */
    tools: (): Promise<ToolsResponse> => get<ToolsResponse>("/api/tools"),
    /**
     * Every run projected onto the results surface: level marks and comparability.
     *
     * `episode` defaults to `e90` server-side, and a tier filter means that
     * tier's *members* — stamped, un-overridden runs. `"all"` lifts the filter;
     * `includeOverrides` widens it to tier runs whose leash was overridden.
     */
    results: (
      episode?: EpisodeIdView | "all",
      includeOverrides = false,
      harness: HarnessView | "all" = "all",
    ): Promise<ResultsResponse> =>
      get<ResultsResponse>(`/api/results${resultsQuery(episode, includeOverrides, harness)}`),
    /**
     * The same projection the ladder reads; the rung rules stay client-side.
     * One tier's members only: the ladder offers neither `all` nor overridden
     * runs, because a rung is a claim about one comparability group.
     */
    ladder: (episode: EpisodeIdView): Promise<ResultsResponse> =>
      get<ResultsResponse>(`/api/ladder${resultsQuery(episode, false)}`),
    /** One run's recorded track, for map replay. */
    track: (id: string): Promise<TrackResponse> =>
      get<TrackResponse>(`/api/run/${encodeURIComponent(id)}/track`),
    run: (id: string): Promise<RunDetailResponse> =>
      get<RunDetailResponse>(`/api/run/${encodeURIComponent(id)}`),
    /**
     * One character, whole: the aggregate across every attempt plus the state
     * series over all of them (item 128). `id` is any run in the chain — the
     * server resolves it and answers with the canonical `characterId`.
     */
    character: (id: string): Promise<CharacterResponse> =>
      get<CharacterResponse>(`/api/character/${encodeURIComponent(id)}`),
    entries: (id: string, from?: number, limit = 200): Promise<EntriesResponse> => {
      const q = new URLSearchParams({ limit: String(limit) });
      if (from !== undefined) q.set("from", String(from));
      return get<EntriesResponse>(`/api/run/${encodeURIComponent(id)}/entries?${q.toString()}`);
    },
    /** The raw JSONL line for one entry, secrets already stripped server-side. */
    raw: async (id: string, i: number): Promise<string> => {
      // Not memoised: one raw line is fetched when a reader opens it, never polled.
      const res = await f(`${opts.base ?? ""}${rawPath(id, i)}`);
      if (!res.ok) throw new ApiError(res.status, `raw ${i}: ${res.status}`);
      return await res.text();
    },
    /** The SSE URL for a run's live tail. Opening it is the caller's business. */
    streamUrl: (id: string): string => `${opts.base ?? ""}/api/run/${encodeURIComponent(id)}/stream`,
  };
}

export type Client = ReturnType<typeof createClient>;

/**
 * The bucket the public build reads, or "" for the private one.
 *
 * A build-time Vite env rather than a runtime probe: one flag produces the
 * public bundle, and the private build keeps its same-origin, CORS-free
 * posture with the snapshot path dead-code-eliminated behind a constant.
 */
const snapshotBase = ((): string => {
  const configured: unknown = import.meta.env.VITE_WRATHBENCH_SNAPSHOT_BASE;
  return typeof configured === "string" ? configured.trim() : "";
})();

/**
 * True in the public build. The guards that read it are the ones a bucket
 * cannot answer: the SSE tail, and the same-origin `/tiles` path, which only a
 * viewer serves (`lib/tiles.ts` names the public host instead).
 */
export const SNAPSHOT_MODE: boolean = snapshotBase !== "";

const snapshot = SNAPSHOT_MODE ? createSnapshotClient(snapshotBase) : null;

/**
 * How fresh the published data is, for the shell's banner. Null in the
 * private build, where the API is the live one and there is nothing to age.
 */
export const snapshotSource: SnapshotSource | null = snapshot?.snapshot ?? null;

/** The one the pages use. */
export const api: Client = snapshot ?? createClient();
