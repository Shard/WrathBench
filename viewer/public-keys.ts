/**
 * Where the public site's session-side objects live in the bucket, how far
 * back its nearby windows reach and how much of a feed a run page holds: the publisher's choices about the
 * inspector's packed windows (`@wrathbench/inspector/codec/trace` and
 * `codec/nearby`), shared by the renderer, the publisher's engine and
 * verifier, and the dashboard's snapshot client, so none of them can drift.
 * Import-free, so the dashboard bundles it.
 */

/**
 * A closed window's object key in the public bucket, the one place it is built:
 * the publisher uploads to it and the snapshot client fetches it, so the two
 * cannot drift. The run id is encoded as every other per-run key is
 * (`snapshot.ts`), so an id with a reserved character still names one object.
 */
export function traceSegmentKey(runId: string, t0: number): string {
  return `v1/run/${encodeURIComponent(runId)}/trace/${t0}.json`;
}

/**
 * What the window `nearby.json` carries for each live run reaches back: what
 * the public live map's playhead needs from one pass to the next, and no more.
 *
 * The public map plays a delay behind the newest `live.json`
 * (`createLiveClock`, `@wrathbench/inspector/views/traceplayer`): a pass's period
 * (about 420 s), plus the client memo, the edge TTL and a poll (65 s), plus a
 * tenth of the period (42 s), so about 8.8 minutes, and from there it runs
 * forward toward the pass's own horizon. Run against the live clock, the
 * furthest back the playhead goes behind the pass in hand is about 9 minutes
 * at the nominal cadence and 11 with passes ten minutes apart; twelve covers
 * both. A slower publisher, or a playhead still catching up after an outage,
 * shows an empty layer for a while rather than an old one. The live clock's
 * test pins the stretch inside it (`dashboard/test/nearbyplayer.test.ts`).
 */
export const PUBLIC_NEARBY_SPAN_MS = 12 * 60_000;
/**
 * The bucket key the public windows are published at, one object rewritten
 * every pass beside `live.json`, which names it (`nearbyKey`) whenever it is
 * written. Apart from `live.json` (operator, 2026-10-24) because the windows
 * were 93% of its bytes and every page's shell reads it, while only the
 * zoomed-in map draws units. Shared by the renderer, the publisher's engine
 * and verifier, and the dashboard's snapshot client.
 */
export const PUBLIC_NEARBY_KEY = "v1/nearby.json";

/**
 * A camera clip's video or poster in the bucket: under the run's prefix, so
 * the zone's `/v1/run/` cache rule and rate limit cover it, and addressed by
 * the clip's name and the first twelve hex of the file's own SHA-256, so a
 * re-publish of the same file lands on the key the bucket already holds and a
 * re-rendered clip gets a new one. `infra/publish-core.ts` classifies the key
 * (`clip`) before it could read as a run object at a version called `clip`.
 */
export function clipMediaKey(runId: string, name: string, hash: string, ext: "mp4" | "jpg"): string {
  return `v1/run/${runId}/clip/${name}-${hash}.${ext}`;
}

/** `clipMediaKey`'s shape, read back: run id, clip name, hash, extension. */
export const CLIP_MEDIA_KEY = /^v1\/run\/([A-Za-z0-9._-]+)\/clip\/([A-Za-z0-9_-]{1,80})-([0-9a-f]{12})\.(mp4|jpg)$/;

/**
 * How many feed entries a run page loads first, and the one window per run
 * the publisher renders (`snapshot.ts`): the feed's tail, the same window in
 * both builds. The private page's "load earlier" walks back a window at a
 * time, and the viewer serves no larger one (`WINDOW_MAX`).
 *
 * A thousand since 2026-11-16, from two hundred: the feed folds a turn's
 * routine actions into one line, so two hundred entries were two or three
 * turns of a run.
 */
export const ENTRIES_WINDOW = 1000;
