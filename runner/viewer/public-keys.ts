/**
 * Where the public site's session-side objects live in the bucket, and how far
 * back its nearby windows reach: the publisher's choices about the
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
 * (`createLiveClock` in `dashboard/src/lib/traceplayer.ts`): a pass's period
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
