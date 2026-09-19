/**
 * The data hostname's robots.txt.
 *
 * The published record has two kinds of object. The aggregates under `v1/snap/`,
 * the manifest, the live file, the social card and the minimap tiles are the
 * headline material and are open to any crawler. Per-run detail under `v1/run/`
 * carries the models' own transcripts, and that is what a crawler would bulk-
 * pull; it is disallowed here for every agent, and the zone's rate limit on the
 * same prefix is the enforcement for the ones that do not read this file
 * (docs/PUBLIC-DASHBOARD.md, "Crawlers").
 *
 * The content-signal line is Cloudflare's convention for stating what an AI
 * crawler may do with what it is allowed to fetch: answer search queries and
 * feed a live prompt, not train. It is a statement of terms, not a control.
 *
 * Published by the publisher at start-up, one PUT per process, at the bucket
 * root so the data hostname serves it at `/robots.txt`.
 */
export const ROBOTS_KEY = "robots.txt";

export const ROBOTS_TXT = `# The published run record behind the WrathBench dashboard.
#
# Aggregates, the manifest, the live file, the social card and the map tiles
# are open. Per-run detail (/v1/run/) is the models' own transcripts and is not
# for bulk crawling: it is disallowed here and rate-limited at the edge.

User-agent: *
Allow: /v1/snap/
Allow: /v1/manifest.json
Allow: /v1/live.json
Allow: /v1/og.png
Allow: /tiles/
Disallow: /v1/run/
Content-Signal: search=yes, ai-input=yes, ai-train=no
`;
