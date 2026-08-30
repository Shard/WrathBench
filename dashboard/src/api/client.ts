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

function get<T>(path: string, opts: ClientOptions = {}): Promise<T> {
  return getJson<T>(`${opts.base ?? ""}${path}`, opts.fetch ?? globalThis.fetch);
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
  return {
    info: (): Promise<ApiInfoResponse> => get<ApiInfoResponse>("/api/info", opts),
    /**
     * The run listing: every run on disk. A launch that produced no model
     * response is archived by the runner as it terminates, so there is nothing
     * to filter here.
     */
    runs: (): Promise<RunsResponse> => get<RunsResponse>("/api/runs", opts),
    positions: (): Promise<PositionsResponse> => get<PositionsResponse>("/api/positions", opts),
    fleet: (): Promise<FleetResponse> => get<FleetResponse>("/api/fleet", opts),
    /**
     * The roster's models with the scheduler's verdict on each.
     * The projection is the supervisor's own, so this page and `--status`
     * cannot disagree about why a model is not running.
     */
    models: (harness: HarnessView | "all" = "all"): Promise<ModelsResponse> =>
      get<ModelsResponse>(`/api/models${harness === "all" ? "" : `?harness=${harness}`}`, opts),
    /** The episode tiers and how many runs sit against each. */
    episodes: (): Promise<EpisodesResponse> => get<EpisodesResponse>("/api/episodes", opts),
    campaigns: (): Promise<CampaignsResponse> => get<CampaignsResponse>("/api/campaigns", opts),
    /** The model-facing tool list, read off the runner at request time (the homepage inspector). */
    tools: (): Promise<ToolsResponse> => get<ToolsResponse>("/api/tools", opts),
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
      get<ResultsResponse>(`/api/results${resultsQuery(episode, includeOverrides, harness)}`, opts),
    /**
     * The same projection the ladder reads; the rung rules stay client-side.
     * One tier's members only: the ladder offers neither `all` nor overridden
     * runs, because a rung is a claim about one comparability group.
     */
    ladder: (episode: EpisodeIdView): Promise<ResultsResponse> =>
      get<ResultsResponse>(`/api/ladder${resultsQuery(episode, false)}`, opts),
    /** One run's recorded track, for map replay. */
    track: (id: string): Promise<TrackResponse> =>
      get<TrackResponse>(`/api/run/${encodeURIComponent(id)}/track`, opts),
    run: (id: string): Promise<RunDetailResponse> =>
      get<RunDetailResponse>(`/api/run/${encodeURIComponent(id)}`, opts),
    entries: (id: string, from?: number, limit = 200): Promise<EntriesResponse> => {
      const q = new URLSearchParams({ limit: String(limit) });
      if (from !== undefined) q.set("from", String(from));
      return get<EntriesResponse>(`/api/run/${encodeURIComponent(id)}/entries?${q.toString()}`, opts);
    },
    /** The raw JSONL line for one entry, secrets already stripped server-side. */
    raw: async (id: string, i: number): Promise<string> => {
      const f = opts.fetch ?? globalThis.fetch;
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
 * cannot answer: the SSE tail, and the minimap tiles that never leave the lab.
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
