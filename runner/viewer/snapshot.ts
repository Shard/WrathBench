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

import { join } from "node:path";
import { createApi, type ApiHandle } from "./api";
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
  RunDetailResponse,
  RunsResponse,
  TrackResponse,
} from "./api-types";
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
} from "./public-projection";

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
  fleetConfigPath?: string;
  moduleUrl?: string;
  /**
   * Where the handle persists its per-run fact cache (`fact-store.ts`). A
   * publisher restarts on every runner-image bump and on `bun ship
   * --publisher`, and without this each restart re-counts every trajectory in
   * the tree before its first pass.
   */
  factCachePath?: string;
  /**
   * The viewer handle to render from. Built from the options above when
   * omitted; injected by the tests that need to disturb the runs directory
   * partway through a pass. A handle without `release` simply keeps its memos,
   * which is what a plain function injected by a test is.
   */
  api?: ((req: Request) => Promise<Response>) | ApiHandle;
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
 * to 0.78 GB (2026-09-08, docs/FOLLOW-UPS.md item 121).
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
   * (docs/FOLLOW-UPS.md item 121). The cost is that the next pass reads those
   * runs from disk again. Set false to keep a `--loop` publisher's passes cheap
   * on a tree small enough that its memos fit.
   */
  release?: boolean;
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
export function createRenderer(opts: RendererOptions): (now?: number, stream?: RunStream) => Promise<SnapshotResult> {
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
      ...(opts.fleetConfigPath !== undefined ? { fleetConfigPath: opts.fleetConfigPath } : {}),
      ...(opts.factCachePath !== undefined ? { factCachePath: opts.factCachePath } : {}),
    });

  /**
   * The handle's own eviction, when it has one. A test may inject a bare
   * function; then a streamed pass simply keeps what it read, as before.
   */
  const releaseRun: ((runId: string) => void) | undefined =
    typeof (handle as Partial<ApiHandle>).release === "function"
      ? (runId): void => (handle as ApiHandle).release(runId)
      : undefined;

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

  /** A per-run text route, with the same 404 rule as `getIfPresent`. */
  const getTextIfPresent = async (path: string): Promise<string | null> => {
    const res = await handle(new Request(`http://snapshot.local${path}`));
    if (res.status === 404) return null;
    if (res.status !== 200) throw new Error(`snapshot render: ${path} answered ${res.status}`);
    return await res.text();
  };

  return async function render(nowArg?: number, stream?: RunStream): Promise<SnapshotResult> {
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
    const tools = projectTools(await get<ToolsResponse>("/api/tools"));
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
    for (let start = 0; start < rows.length; start += groupSize) {
      const group = rows.slice(start, start + groupSize);
      const perRun: (SnapshotArtifact[] | undefined)[] = new Array(group.length);
      let next = 0;
      const worker = async (): Promise<void> => {
        for (let i = next++; i < group.length; i = next++) {
          const row = group[i]!;
          const id = encodeURIComponent(row.runId);
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
          // The version covers everything the row points at, so a window that
          // grew or a scratchpad rewritten between two identical details still
          // lands on a new key rather than mutating an immutable one.
          const ver = hash12([addressable(detail), addressable(entries), scratchpad ?? ""].join("\n"));
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
          ];
          row.snapshot = paths;
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
        body: JSON.stringify({ generatedAt: now, attribution: PUBLIC_ATTRIBUTION, fleet, positions }),
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
      // they are already gone, and holding them here is what item 121 was.
      ...artifacts,
    ];

    return { gen, snap: paths, artifacts: out };
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
