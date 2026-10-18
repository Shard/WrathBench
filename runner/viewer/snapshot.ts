/**
 * Render the viewer API into a set of static public JSON artifacts.
 *
 * The renderer calls the viewer's own `createApi` handler in-process — the
 * same routes, the same derivations — and then passes every parsed body
 * through `public-projection.ts` before it is serialized. That order is the
 * point: the public numbers cannot drift from the private viewer because they
 * ARE the private viewer's, and nothing reaches an artifact without crossing
 * the projection. Entries cross it twice — the public handle already projects
 * and redacts its `/entries` window, and the renderer projects the parsed body
 * again — because the invariant is "every body crosses the projection HERE",
 * not "the handle was public". Raw lines and tiles are never requested, so no
 * artifact exists for them. Tiles are the emphatic case: `WRATHBENCH_VIEWER_TILES_PUBLIC`
 * can open that route on a live viewer, and it reaches nothing here — the
 * renderer's own handle never sets `tilesPublic`, and no pass asks for a tile.
 *
 * Per run, one entries window is published: the tail (`ENTRIES_WINDOW`
 * entries), the same shape the run page's private path loads first. No
 * "load earlier" publicly — a static set would otherwise have to carry every
 * window of every run.
 *
 * Layout (a publisher pushes these to a bucket; a static dashboard reads them):
 * - `v1/manifest.json` and `v1/live.json` are the two mutable keys, cached
 *   briefly — the manifest names the key of every aggregate, live is the
 *   fleet/positions poll.
 * - `v1/snap/<ver>/<name>` and `v1/run/<id>/<ver>/…` are content-addressed and
 *   immutable: a re-render of unchanged input lands on the same keys, so a
 *   client may cache them forever.
 * - `v1/run/<id>/trace/<t0>.json` is one closed trace window
 *   (`runner/viewer/trace.ts`), immutable because a closed window never
 *   changes. The run's track lists them and `live.json` names the newest; both
 *   are written after them, and each is rendered once — the publisher passes
 *   in which windows the bucket already holds.
 *
 * Each aggregate carries its OWN `<ver>` (operator, 2026-09-04, GitHub issue
 * #38). One hash over the whole set meant a single live run taking a turn
 * moved `runs.json`, `results.json`, every `ladder-*.json` and `models.json`,
 * and the pass then rewrote all ten aggregates under a fresh prefix — three of
 * seven compared were byte-identical. Per-artifact versions make a pass rewrite
 * only what changed, and the manifest names a key per artifact rather than one
 * generation. `gen` survives as the manifest's own identity — the hash of the
 * name/version pairs — which is what tells the publisher whether the flip is
 * worth a PUT, and the wave ordering still writes the manifest last.
 *
 * Every `<ver>` is hashed over the PROJECTED payloads before the envelope goes
 * on: the envelope carries `generatedAt`, and a timestamp in the hashed content
 * would make every render a new version even when nothing changed.
 */

import { statSync } from "node:fs";
import { join } from "node:path";
import { createApi, type ApiHandle } from "./api";
import { lineageIndex } from "./lineage";
import { EPISODE_IDS } from "../src/episodes";
import type {
  ApiInfoResponse,
  CampaignsResponse,
  EntriesResponse,
  ToolsResponse,
  EpisodesResponse,
  FleetResponse,
  ModelsResponse,
  PositionsResponse,
  ResultsResponse,
  ResultRun,
  RunDetailResponse,
  RunListRow,
  RunsResponse,
  TraceSegment,
  TrackResponse,
} from "./api-types";
import { traceSegmentKey, unpackSegs } from "./trace";
import {
  PUBLIC_ATTRIBUTION,
  projectCampaigns,
  projectEntries,
  projectTools,
  projectEpisodes,
  projectFleet,
  projectInfo,
  projectModels,
  projectPositions,
  projectResults,
  projectRunDetail,
  projectRuns,
  projectTrack,
  projectTraceSegment,
} from "./public-projection";
import { scrubPathsText } from "./scrub-paths";

/** The two mutable keys are polled; everything else is content-addressed. */
export const MUTABLE_CACHE = "public, max-age=30";
export const IMMUTABLE_CACHE = "public, max-age=31536000, immutable";

export interface SnapshotArtifact {
  /** Bucket key, no leading slash, e.g. `v1/snap/<ver>/runs.json`. */
  path: string;
  /** Serialized JSON. */
  body: string;
  contentType: "application/json";
  cacheControl: string;
}

export interface SnapshotResult {
  /**
   * The manifest's identity: the hash of the aggregate name/version pairs. It
   * moves when the manifest's content moves and not otherwise, which is
   * exactly the question the publisher asks before spending a PUT on the flip.
   * It is no longer a key prefix — nothing is addressed by it.
   */
  gen: string;
  /**
   * Aggregate name (`runs.json`, `ladder-e90.json`, …) -> its bucket key this
   * pass. The manifest's `artifacts` map, handed to the publisher as data so
   * the engine can check that the pass uploads exactly what the manifest names
   * without parsing anyone's JSON.
   */
  snap: Record<string, string>;
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
 * Serialize a projected payload for ADDRESSING (each artifact's `<ver>`), with
 * the two wall-clock-driven fields zeroed.
 *
 * Several responses stamp a top-level `now` (results, ladder, episodes,
 * campaigns, models, info) that moves with wall clock, not with data; hashed
 * as-is it would make every render a new version, and the publisher would
 * re-upload the whole aggregate set every pass of an idle fleet. So the hash
 * sees a copy with `now: 0` while the EMITTED body keeps the real value.
 *
 * `playtimeMs` is zeroed for the same reason, wherever it appears (operator,
 * 2026-09-04, GitHub issue #38 — this reverses the earlier "nothing else is
 * normalized" rule). A live run's active time advances with the clock on every
 * pass, so hashing it made a run's detail — and every row of `runs.json` and
 * `results.json` that carries the figure — churn on passes where nothing had
 * happened. What that gives up is the two cases where the field moves without
 * anything beside it moving: a `LevelMark.playtimeMs` revised by a pause
 * recorded after the fact, and the live figure itself between turns. Both then
 * publish on the next real change rather than immediately, which is the trade
 * the issue asked for.
 *
 * Nothing else is normalized: `lastTs` and the `live` flag are data, and a
 * changed version is then correct. The same holds for the scheduler's
 * clock-crossings in models.json — a cooldown expiring or a pause going stale
 * flips a status the models page shows, so the version moving on those (rare,
 * boundary) events is deliberate. The invariant is "no data change and no
 * state-visible clock crossing ⇒ same version", not "idle wall clock ⇒ same
 * version".
 * (The spread below builds a hash-only local copy of an already-projected
 * payload, never anything emitted — the projection's no-spread rule is about
 * what ships; the replacer likewise touches only what is hashed.)
 */
function addressable(payload: object): string {
  const o = payload as Record<string, unknown>;
  return JSON.stringify(typeof o["now"] === "number" ? { ...o, now: 0 } : o, (key, value) =>
    key === "playtimeMs" && typeof value === "number" ? 0 : (value as unknown),
  );
}

export interface RendererOptions {
  runsDir: string;
  /** The config store the roster is read from; the data volume's by default. */
  configDbPath?: string;
  moduleUrl?: string;
  /**
   * The viewer handle to render from. Built from the options above when
   * omitted; injected by the tests that need to disturb the runs directory
   * partway through a pass. A handle without `release` simply keeps its memos,
   * which is what a plain function injected by a test is.
   */
  api?: ((req: Request) => Promise<Response>) | ApiHandle;
  /**
   * The longest a cold run goes without being rendered in full
   * (`FULL_RENDER_MS` by default). The bound on how stale an input the cold
   * fingerprint cannot see may leave a run's objects.
   */
  fullRenderMs?: number;
  /** The wall clock cold runs are judged on; `Date.now` but in tests. */
  clock?: () => number;
}

/**
 * Every run is rendered in full at least this often, skipped or not. The keys
 * are content-addressed, so a full render that finds nothing changed uploads
 * nothing; one that finds a change the fingerprint missed publishes it.
 */
export const FULL_RENDER_MS = 6 * 60 * 60_000;

/**
 * How many runs are in flight at once in the per-run pass.
 *
 * The two per-run routes are file reads, so the pass is latency-bound rather
 * than CPU-bound and overlapping them is most of the win; the bound is there
 * because a runs directory holds hundreds of runs and the viewer serialises
 * its scans per run, not globally.
 */
const RUN_CONCURRENCY = 8;

/** The one published entries window per run: the feed's tail, as the run page loads it. */
export const ENTRIES_WINDOW = 200;

/**
 * Where a streaming pass hands off each batch of per-run artifacts.
 *
 * The batch is the caller's the moment it arrives: the renderer drops its own
 * reference to those bodies as soon as the sink resolves, which is the whole
 * point of the shape.
 */
export type RunSink = (artifacts: SnapshotArtifact[]) => Promise<void>;

/**
 * Render the per-run artifacts in bounded groups and hand each to `sink`,
 * instead of returning them all at once.
 *
 * A pass over the whole runs tree otherwise holds every projected detail,
 * track, entries window and scratchpad until the last one is made, so what it
 * retains grows with the tree: the artifacts themselves, and — through the
 * handle — one entry index per run, which is far the larger of the two.
 * Streaming bounds both at `batch` runs' worth, which with the scanners reading
 * in windows is what took a pass over the 1,016-run tree from 4.4 GB peak RSS
 * to 0.78 GB (2026-09-08).
 *
 * Nothing about WHAT is rendered changes: the same runs, in the same listing
 * order, on the same keys, with the same bodies. Only the moment the bodies
 * are let go of does.
 *
 * `batch` is runs per group, not artifacts. The groups are barriers, so the
 * read pool is `min(RUN_CONCURRENCY, batch)` wide — a batch of 1 serializes
 * the pass, which is a legitimate (slow) setting and the sharpest test of the
 * invariant that batching changes nothing but memory.
 */
export interface RunStream {
  sink: RunSink;
  batch: number;
  /**
   * Whether to forget each run's viewer memos once its batch has flushed
   * (`ApiHandle.release`). Default true, because a streaming caller is by
   * definition walking the tree once and the memos are otherwise a live set
   * that grows with it — the largest single piece of a pass's memory
   *. The cost is that the next pass reads those
   * runs from disk again. Set false to keep a `--loop` publisher's passes cheap
   * on a tree small enough that its memos fit.
   */
  release?: boolean;
}

/**
 * What the bucket already holds (`infra/publish-core.ts`, `PublishedView`).
 * A trace segment the bucket has is neither fetched nor rendered again, and a
 * cold run whose objects it holds may be skipped whole (`coldFingerprint`).
 * Without a view, everything is rendered: the shape of a first pass, a
 * `--once` backfill and every test that does not pass one.
 */
export interface PublishedTrace {
  traceSegment(runId: string, t0: number): boolean;
  /** Whether the bucket holds this key. Optional: a view without it skips no run. */
  object?(path: string): boolean;
}

/**
 * How long all of a run's files must have been still before a pass may skip
 * it. Past every clock a run's objects read: the listing's live window (two
 * minutes), a trace window's settling (its end plus a minute), and the
 * collector's poll that brings the store level with the files.
 */
export const COLD_MS = 15 * 60_000;

/** The files the per-run routes read. A run's derived-store rows are derived from these. */
const RUN_INPUT_FILES = ["meta.json", "trajectory.jsonl", "run.sqlite", "scratchpad.md"] as const;

/**
 * Everything a cold run's four objects are a function of, hashed, or null when
 * the run is not cold.
 *
 * - **Its files**, by size and mtime. Every per-run route reads a run's own
 *   files or the store rows the collector derives from them.
 * - **Its listing row** as this pass projected it, which is the store's view
 *   of the run (so a collector still catching up moves it) and carries the
 *   cost the detail repeats.
 * - **Its character's rows**, for a run in a chain of attempts. A freeplay
 *   attempt's detail and track name its neighbours and carry the chain's
 *   totals, so a successor appearing or a live attempt progressing changes a
 *   finished attempt's objects without touching its files.
 *
 * **Not watched**, and bounded instead by a full render every
 * `FULL_RENDER_MS`. Code is the main one: the projection, the redaction and
 * path-scrub lists, the codec, `model-cost`. So is the OpenRouter price table,
 * read once at start, which `sync-prices` rewrites. A new process brings in
 * both, and it starts with nothing remembered. Beyond those: a store row the
 * listing row does not reflect (a re-ingest that changes a run's state series
 * but not its totals), and lineage as the viewer's own fifteen-second listing
 * sees it, where it differs from the projected results the chain rows come
 * from. Cold is judged on the wall clock, never the render's `now`, which only
 * stamps `generatedAt`.
 */
function coldFingerprint(runsDir: string, row: RunListRow, character: string, wall: number): string | null {
  const parts = [JSON.stringify(row), character];
  for (const name of RUN_INPUT_FILES) {
    let st: { size: number; mtimeMs: number };
    try {
      st = statSync(join(runsDir, row.runId, name));
    } catch {
      parts.push(`${name} -`);
      continue;
    }
    if (st.mtimeMs > wall - COLD_MS) return null;
    parts.push(`${name} ${st.size} ${st.mtimeMs}`);
  }
  return hash12(parts.join("\n"));
}

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
 * `render(now, stream)` additionally streams the per-run artifacts out as they
 * are made — see `RunStream` — and then leaves them out of the result it
 * returns, which is otherwise identical.
 */
export function createRenderer(
  opts: RendererOptions,
): (now?: number, stream?: RunStream, published?: PublishedTrace) => Promise<SnapshotResult> {
  const handle =
    opts.api ??
    createApi({
      runsDir: opts.runsDir,
      // Never read: the renderer requests no tile, and this handle is built
      // public with `tilesPublic` left off — so `/tiles/` is withheld here
      // regardless of what the live viewer's env says. A directory that need
      // not exist.
      tilesDir: join(opts.runsDir, "tiles-unused"),
      publicMode: true,
      // An unroutable loopback port by default, so a render on a machine with no
      // worldserver reports `worldserver: null` quickly instead of hanging.
      moduleUrl: opts.moduleUrl ?? "http://127.0.0.1:1",
      ...(opts.configDbPath !== undefined ? { configDbPath: opts.configDbPath } : {}),
    });

  /**
   * The handle's own eviction, when it has one. A test may inject a bare
   * function; then a streamed pass simply keeps what it read, as before.
   */
  const releaseRun: ((runId: string) => void) | undefined =
    typeof (handle as Partial<ApiHandle>).release === "function"
      ? (runId): void => (handle as ApiHandle).release(runId)
      : undefined;

  /**
   * What each cold run rendered to, by run: the fingerprint of its inputs, the
   * keys its row pointed at, and the trace windows its track listed.
   *
   * A pass used to render every run in the listing — four routes each, every
   * trajectory re-scanned (the streamed pass releases them) and a handful of
   * store queries apiece — to land almost all of them on keys the bucket
   * already held. Measured on the fleet, that was ~5,000 store queries and
   * ~16 GB of reads a pass for some 580 runs, nearly all of them long
   * finished. A run whose fingerprint is the one it rendered under, and whose
   * objects the bucket still holds, is now published by pointing its row at
   * them again. That is what a render would have produced, by the
   * fingerprint's own argument, without making it.
   *
   * Per process, like the handle: a restart, which is also the only way the
   * code a render runs can change, starts empty and renders everything once.
   * And an entry stands for at most `fullRenderMs`, so every run is rendered
   * in full that often whatever its fingerprint says.
   */
  const coldRuns = new Map<
    string,
    { fingerprint: string; snapshot: NonNullable<RunListRow["snapshot"]>; trace: number[] | null; renderedAt: number }
  >();
  const fullRenderMs = opts.fullRenderMs ?? FULL_RENDER_MS;
  const clock = opts.clock ?? Date.now;

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

  /**
   * A per-run text route, with the same 404 rule as `getIfPresent`.
   *
   * The scrub is applied here as well as on the handle, for the same reason
   * every JSON body crosses the projection here even though the handle is
   * public: the invariant is "nothing reaches an artifact unscrubbed", not
   * "the handle was public". A text route has no projector to carry it, so it
   * says so itself. The scrub is idempotent, so doing it twice is doing it
   * once.
   */
  const getTextIfPresent = async (path: string): Promise<string | null> => {
    const res = await handle(new Request(`http://snapshot.local${path}`));
    if (res.status === 404) return null;
    if (res.status !== 200) throw new Error(`snapshot render: ${path} answered ${res.status}`);
    return scrubPathsText(await res.text());
  };

  return async function render(nowArg?: number, stream?: RunStream, published?: PublishedTrace): Promise<SnapshotResult> {
    const now = nowArg ?? Date.now();
    /*
     * Every trace window a run's published track lists, by run: the ones the
     * bucket held before this pass and the ones this pass renders into the run
     * wave. `live.json` is written after that wave, and its `recent` windows
     * are cut to these, so it can never name a segment the bucket does not
     * hold — a reader that followed one would cache the 404 at the edge for a
     * day.
     */
    const traceListed = new Map<string, ReadonlySet<number>>();

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
    const tools = projectTools(await get<ToolsResponse>("/api/tools"));
    const fleet = projectFleet(await get<FleetResponse>("/api/fleet"));
    const positions = projectPositions(await get<PositionsResponse>("/api/positions"));

    /** Envelope and serialize one projected payload. */
    const envelope = (payload: object): string =>
      JSON.stringify({ generatedAt: now, attribution: PUBLIC_ATTRIBUTION, ...payload });

    /*
     * Per-run artifacts first: `runs.json` rows carry the resulting paths, so
     * the run addressing has to settle before the snap bodies are hashed. `ver`
     * is a hash over the projected detail, track, entries window and
     * scratchpad — a finished run re-renders to the same key, a changed one (a
     * live run that grew) claims a new one, and the row is what tells a client
     * which is current.
     *
     * The pool overlaps the file reads; the results are parked by listing
     * position so the artifact order is the listing's, not the order the pool
     * happened to finish in. A run whose two artifacts are missing leaves its
     * slot empty and its row pointerless, which is what the snapshot client
     * already reads as "no published detail for this run".
     *
     * A group at a time when the caller streams: the rows (small, and needed
     * for `runs.json` either way) survive the pass, the bodies do not.
     */
    const rows = runs.runs;
    // Clamped, and finite: a `NaN` batch would slice one empty group and leave
    // every row without its snapshot pointers on a manifest that still flipped.
    const groupSize =
      stream === undefined || !Number.isFinite(stream.batch) ? Math.max(1, rows.length) : Math.max(1, Math.floor(stream.batch));
    const artifacts: SnapshotArtifact[] = [];
    /*
     * Each run's character, as the rows of all its attempts: part of a chained
     * run's cold fingerprint, built once a pass off the results already in hand
     * (the same rows the public character page derives the chain from). A run
     * of one attempt has none.
     */
    const lineage = lineageIndex(results.runs);
    const attemptsOf = new Map<string, ResultRun[]>();
    for (const r of results.runs) {
      const l = lineage.get(r.runId);
      if (l === undefined || l.attempts < 2) continue;
      const list = attemptsOf.get(l.characterId) ?? [];
      list.push(r);
      attemptsOf.set(l.characterId, list);
    }
    const characterText = new Map<string, string>();
    const characterOf = (runId: string): string => {
      const id = lineage.get(runId)?.characterId;
      const list = id === undefined ? undefined : attemptsOf.get(id);
      if (id === undefined || list === undefined) return "";
      let text = characterText.get(id);
      if (text === undefined) {
        text = JSON.stringify([...list].sort((a, b) => (a.runId < b.runId ? -1 : a.runId > b.runId ? 1 : 0)));
        characterText.set(id, text);
      }
      return text;
    };
    // Only a pass that can see the bucket may skip: it must know the objects are still there.
    const holds = published?.object?.bind(published);
    const wall = clock();
    for (let start = 0; start < rows.length; start += groupSize) {
      const group = rows.slice(start, start + groupSize);
      const perRun: (SnapshotArtifact[] | undefined)[] = new Array(group.length);
      let next = 0;
      const worker = async (): Promise<void> => {
        for (let i = next++; i < group.length; i = next++) {
          const row = group[i]!;
          const id = encodeURIComponent(row.runId);
          // Before the row is stamped, so the fingerprint sees the listing's own row.
          const fingerprint = holds === undefined ? null : coldFingerprint(opts.runsDir, row, characterOf(row.runId), wall);
          const cold = fingerprint === null ? undefined : coldRuns.get(row.runId);
          if (
            cold !== undefined &&
            cold.fingerprint === fingerprint &&
            // The safety net under everything the fingerprint cannot see.
            wall - cold.renderedAt < fullRenderMs &&
            Object.values(cold.snapshot).every((key) => holds!(key)) &&
            (cold.trace ?? []).every((t0) => published!.traceSegment(row.runId, t0))
          ) {
            row.snapshot = cold.snapshot;
            if (cold.trace !== null) traceListed.set(row.runId, new Set(cold.trace));
            continue;
          }
          const [detail, track, entries, scratchpad] = await Promise.all([
            getIfPresent<RunDetailResponse>(`/api/run/${id}`).then((b) => (b === null ? null : projectRunDetail(b))),
            getIfPresent<TrackResponse>(`/api/run/${id}/track`).then((b) => (b === null ? null : projectTrack(b))),
            getIfPresent<EntriesResponse>(`/api/run/${id}/entries?limit=${ENTRIES_WINDOW}`).then((b) =>
              b === null ? null : projectEntries(b),
            ),
            // A run with no scratchpad.md is a 404 here and simply has no artifact.
            getTextIfPresent(`/api/run/${id}/scratchpad`),
          ]);
          // Any of the three JSON halves missing means the run went away
          // mid-pass; a row must never point at part of a set, so all are
          // dropped together.
          if (detail === null || track === null || entries === null) continue;
          /*
           * The run's closed trace windows the bucket does not hold yet, each its
           * own immutable object. Only listed windows are asked for, so a 404 is
           * the run going away mid-pass, and the run is dropped like any other
           * half going missing: its track lists these, and must not land
           * without them. A run with no trace lists none and costs nothing here.
           */
          const segments: SnapshotArtifact[] = [];
          let segmentMissing = false;
          for (const t0 of track.trace === undefined ? [] : unpackSegs(track.trace.segs, track.trace.segMs)) {
            if (published?.traceSegment(row.runId, t0) === true) continue;
            const seg = await getIfPresent<TraceSegment>(`/api/run/${id}/trace/${t0}`);
            if (seg === null) {
              segmentMissing = true;
              break;
            }
            segments.push({
              path: traceSegmentKey(row.runId, t0),
              body: envelope(projectTraceSegment(seg)),
              contentType: "application/json",
              cacheControl: IMMUTABLE_CACHE,
            });
          }
          if (segmentMissing) continue;
          if (track.trace !== undefined) traceListed.set(row.runId, new Set(unpackSegs(track.trace.segs, track.trace.segMs)));
          // The version covers everything the row points at, so a window that
          // grew, a scratchpad rewritten, or a track that gained a field
          // (`travel`) between two identical details still lands on a new key
          // rather than mutating an immutable one. The track used to be left
          // out because a successor attempt moves the detail's `character`
          // with it; that covers nothing else, and a key the edge caches for
          // a year cannot be corrected in place.
          const ver = hash12([addressable(detail), addressable(track), addressable(entries), scratchpad ?? ""].join("\n"));
          // Run ids are `isValidRunId`-safe (`[A-Za-z0-9._-]+`), so they are bucket
          // keys as-is; anything else never got a run directory to be listed from.
          const base = `v1/run/${row.runId}/${ver}`;
          const paths: NonNullable<typeof row.snapshot> = {
            detail: `${base}/detail.json`,
            track: `${base}/track.json`,
            entries: `${base}/entries.json`,
            ...(scratchpad === null ? {} : { scratchpad: `${base}/scratchpad.json` }),
          };
          const immutable = (path: string, body: string): SnapshotArtifact => ({
            path,
            body,
            contentType: "application/json",
            cacheControl: IMMUTABLE_CACHE,
          });
          perRun[i] = [
            immutable(paths.detail, envelope(detail)),
            immutable(paths.track, envelope(track)),
            immutable(paths.entries!, envelope(entries)),
            ...(paths.scratchpad === undefined ? [] : [immutable(paths.scratchpad, envelope({ text: scratchpad }))]),
            // In the same batch, so in the same run wave as the track listing them.
            ...segments,
          ];
          row.snapshot = paths;
          // Remembered whatever this pass's upload does: a later pass skips
          // only once the bucket holds every key, so a failed PUT renders again.
          if (fingerprint !== null) {
            coldRuns.set(row.runId, {
              fingerprint,
              snapshot: paths,
              trace: track.trace === undefined ? null : unpackSegs(track.trace.segs, track.trace.segMs),
              renderedAt: wall,
            });
          } else coldRuns.delete(row.runId);
        }
      };
      await Promise.all(Array.from({ length: Math.min(RUN_CONCURRENCY, group.length) }, worker));
      const made = perRun.flatMap((a) => a ?? []);
      if (stream === undefined) artifacts.push(...made);
      else {
        await stream.sink(made);
        // Only after the sink has taken them: until it returns, this pass may
        // still need the run it is holding.
        if (stream.release !== false && releaseRun !== undefined) {
          for (const row of group) releaseRun(row.runId);
        }
      }
    }

    /*
     * The snap set, in a fixed order. Each aggregate is addressed by its own
     * payload, so an unchanged one lands on the key it already had and costs
     * the publisher nothing; `gen` is then the hash of the name/version pairs,
     * which is the manifest's content and nothing else. The order is part of
     * `gen`, so it must not depend on iteration luck — and the name is part of
     * each key, so two aggregates that happen to serialize identically (two
     * empty ladders) still get their own object.
     */
    const snap: [string, object][] = [
      ["info.json", info],
      ["runs.json", runs],
      ["results.json", results],
      ...ladders.map(([ep, body]): [string, object] => [`ladder-${ep}.json`, body]),
      ["episodes.json", episodes],
      ["models.json", models],
      ["campaigns.json", campaigns],
      ["tools.json", tools],
    ];
    const versions = snap.map(([name, payload]): [string, object, string] => [name, payload, hash12(addressable(payload))]);
    const paths: Record<string, string> = {};
    for (const [name, , ver] of versions) paths[name] = `v1/snap/${ver}/${name}`;
    const gen = hash12(versions.map(([name, , ver]) => `${name} ${ver}`).join("\n"));

    const out: SnapshotArtifact[] = [
      {
        path: "v1/manifest.json",
        // The envelope's fields plus the one fact the manifest exists for:
        // where each aggregate is this pass. `gen` rides along as the set's
        // identity — a reader may use it to tell two manifests apart, but it
        // addresses nothing.
        body: JSON.stringify({ gen, artifacts: paths, generatedAt: now, attribution: PUBLIC_ATTRIBUTION }),
        contentType: "application/json",
        cacheControl: MUTABLE_CACHE,
      },
      {
        path: "v1/live.json",
        body: JSON.stringify({ generatedAt: now, attribution: PUBLIC_ATTRIBUTION, fleet, positions: livePositions(positions, traceListed) }),
        contentType: "application/json",
        cacheControl: MUTABLE_CACHE,
      },
      ...versions.map(
        ([name, payload]): SnapshotArtifact => ({
          path: paths[name]!,
          body: envelope(payload),
          contentType: "application/json",
          cacheControl: IMMUTABLE_CACHE,
        }),
      ),
      // Empty when the caller took the per-run artifacts through a `RunStream`:
      // they are already gone, and holding them here is what the peak was.
      ...artifacts,
    ];

    return { gen, snap: paths, artifacts: out };
  };
}

/**
 * The projected position feed as `live.json` carries it: each position's
 * `recent` trace windows cut to the ones its run's published track lists.
 *
 * The feed is read at the top of a pass and the tracks after it, and a window
 * only ever closes, so in practice the cut removes nothing; it is what makes
 * "`live.json` names only segments in the bucket" a property of the code rather
 * than of the timing — a run whose track was dropped mid-pass names none. The
 * copy is of an already-projected position, and the trace is rebuilt field by
 * field rather than spread.
 */
function livePositions(positions: PositionsResponse, listed: ReadonlyMap<string, ReadonlySet<number>>): PositionsResponse {
  return {
    positions: positions.positions.map((p) => {
      if (p.trace === undefined) return p;
      const known = listed.get(p.runId);
      return {
        ...p,
        trace: { segMs: p.trace.segMs, recent: p.trace.recent.filter((t0) => known?.has(t0) === true), tail: p.trace.tail },
      };
    }),
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
