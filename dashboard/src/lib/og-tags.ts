/**
 * The half of the social card that is markup: the `<meta>` tags a crawler
 * reads out of the static `index.html`.
 *
 * Split from the picture (`lib/og.ts`) because they are injected at different
 * times by different tools — the tags by a Vite `transformIndexHtml` hook at
 * build time, the PNG by `infra/render-og.ts` before the build runs — and
 * because the one rule worth a test is stated here: **`og:image` must be an
 * absolute https URL**, so the tags exist only in a build that was told what
 * origin it is being served from. The private viewer build is same-origin,
 * loopback and never crawled; giving it a relative image would put a tag in
 * the page that no crawler could resolve, so it gets none, and `index.html`
 * stays correct in both shapes.
 *
 * The base tags — `og:type`, `og:site_name`, `og:title`, `og:description` —
 * are static in `index.html` and are not repeated here; these are the ones
 * that need the origin.
 */

/** Where the built page will be served from, and what to bust the crawler's image cache with. */
export interface OgTagOptions {
  /** Absolute origin, no trailing slash: `https://wrathbench.example.workers.dev`. */
  origin: string;
  /**
   * A stamp appended to the image URL as `?v=`.
   *
   * Crawlers cache a card by URL and nothing else — Discord's has no
   * revalidation and no purge — so a card at an unchanged URL is the old
   * picture for as long as the crawler feels like it. The stamp is the
   * ship-time render's own content hash (`infra/render-og.ts` prints it), so
   * the URL changes whenever a ship changed the picture.
   *
   * What it cannot do is change *between* ships, and that is a property of the
   * shape rather than an oversight: these tags live in a static `index.html`
   * served as an immutable asset, so only a deploy can rewrite them. Since
   * 2026-09-18 the bytes behind the URL are re-rendered by the publisher every
   * pass, so a crawler that scrapes the page today gets today's ladder — but a
   * crawler that already cached the card keeps its copy until the next ship
   * moves the URL. Changing that would mean a Worker in the read path, which
   * `dashboard/wrangler.jsonc` forecloses on purpose.
   */
  stamp: string;
  /**
   * The origin the card itself is served from, when it is not the app's.
   *
   * It is the data hostname: the publisher writes the picture to the R2 bucket
   * beside the snapshot it rendered it from (`v1/og.png`), and the bucket is a
   * different host from the app. Absent, the tags fall back to the app origin's
   * own `/og.png`, the static asset `bun ship` still writes — which is the
   * private build and the tests, not the public site: `deploy-dashboard.sh`
   * hard-fails on an empty `WRATHBENCH_SNAPSHOT_BASE`, so a public build always
   * has one and `dashboard/public/og.png` ships unreferenced behind it.
   */
  snapshotBase?: string;
  /** The page the card links back to; defaults to the origin's root. */
  path?: string;
}

/**
 * Where the publisher puts the card in the bucket — `infra/og-render.ts`'s
 * `OG_KEY`, restated rather than imported because this module is built into
 * the SPA and nothing under `infra/` may follow it in.
 */
export const OG_IMAGE_KEY = "v1/og.png";

/** The card's title and blurb, which are the page's own — one sentence, unchanged. */
export const OG_TITLE = "WrathBench — an agent workbench for World of Warcraft";
export const OG_DESCRIPTION =
  "An agent workbench for World of Warcraft: AI models play WotLK through a TypeScript SDK on a private AzerothCore server.";
/** What the picture is, for a reader who cannot see it. */
export const OG_IMAGE_ALT =
  "A scatter of model logos plotting cost per run against experience earned, with the Pareto frontier drawn as a step line.";

const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

/**
 * The origin-dependent tags, as HTML — or the empty string when there is no
 * origin, which is the private build.
 *
 * `twitter:card` is `summary_large_image` and not `summary`: the small card
 * crops the picture to a square thumbnail beside the text, and a square crop
 * of a wide scatter is a corner of it. The width and height are declared so a
 * crawler can lay the card out before the image arrives, which is what stops
 * Discord falling back to the small variant on a slow fetch.
 */
export function ogTags(opts: OgTagOptions | null): string {
  if (opts === null) return "";
  const origin = opts.origin.replace(/\/+$/, "");
  const url = `${origin}${opts.path ?? "/"}`;
  const base = (opts.snapshotBase ?? "").replace(/\/+$/, "");
  const image = `${base === "" ? `${origin}/og.png` : `${base}/${OG_IMAGE_KEY}`}?v=${encodeURIComponent(opts.stamp)}`;
  const tags: [string, string][] = [
    ["og:url", url],
    ["og:image", image],
    ["og:image:type", "image/png"],
    ["og:image:width", "1200"],
    ["og:image:height", "630"],
    ["og:image:alt", OG_IMAGE_ALT],
  ];
  const names: [string, string][] = [
    ["twitter:card", "summary_large_image"],
    ["twitter:title", OG_TITLE],
    ["twitter:description", OG_DESCRIPTION],
    ["twitter:image", image],
    ["twitter:image:alt", OG_IMAGE_ALT],
  ];
  return [
    ...tags.map(([p, c]) => `<meta property="${p}" content="${esc(c)}" />`),
    ...names.map(([n, c]) => `<meta name="${n}" content="${esc(c)}" />`),
  ].join("\n    ");
}

/**
 * The build's card options, read from the environment Vite was given, or null
 * when it names no origin.
 *
 * Both variables must be present: an origin with no stamp would publish a URL
 * that never changes, and a stamp with no origin has nothing to hang on.
 */
export function ogTagsFromEnv(env: Record<string, string | undefined>): OgTagOptions | null {
  const origin = env["VITE_WRATHBENCH_PUBLIC_ORIGIN"];
  const stamp = env["VITE_WRATHBENCH_OG_STAMP"];
  if (origin === undefined || origin === "" || stamp === undefined || stamp === "") return null;
  // `https` and not merely absolute: Discord rejects an insecure `og:image`,
  // and the failure is invisible until someone pastes a link.
  if (!origin.startsWith("https://")) throw new Error(`VITE_WRATHBENCH_PUBLIC_ORIGIN must be an https origin, got ${origin}`);
  const base = env["VITE_WRATHBENCH_SNAPSHOT_BASE"];
  if (base === undefined || base === "") return { origin, stamp };
  if (!base.startsWith("https://")) throw new Error(`VITE_WRATHBENCH_SNAPSHOT_BASE must be an https origin, got ${base}`);
  return { origin, stamp, snapshotBase: base };
}
