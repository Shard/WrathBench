import { describe, expect, test } from "bun:test";
import type { ResultRun } from "../src/api/client";
import { OG_H, OG_W, ogSvgOf } from "../src/lib/og";
import { OG_DESCRIPTION, OG_TITLE, ogTags, ogTagsFromEnv } from "../src/lib/og-tags";

/**
 * A run in the shape the ladder's aggregation reads, built the way
 * `ladder.test.ts` builds one: a price and an xp reading on the latest series,
 * paid and scorable, so `homeLadderRuns` keeps it and `ladderPoints` places it.
 */
const fig = (usd: number) => ({
  usd,
  basis: "reported" as const,
  asIfMetered: false,
  breakdown: null,
  priceId: null,
  asOf: null,
});

const run = (model: string, usd: number, xpEarned: number): ResultRun =>
  ({
    runId: `${model}-${usd}`,
    model,
    effort: null,
    platform: "openrouter",
    harnessVersion: "harness-0.5-1-gabc",
    harnessSeries: "0.5",
    harness: "wrathbench",
    episode: "e90",
    billing: "paid",
    unscored: null,
    race: 1,
    raceName: "Human",
    class: 2,
    className: "Paladin",
    modelResponses: 1,
    toolCalls: null,
    levels: [],
    maxLevel: null,
    xp: null,
    questsCompleted: 0,
    playtimeMs: null,
    tokens: null,
    actualCost: fig(usd),
    expectedCost: null,
    xpEarned,
  }) as unknown as ResultRun;

/** Three entries; `b` is beaten by `a` on both axes, so the front is two of them. */
const RUNS = [
  run("anthropic/claude-sonnet-4-5", 1, 5000),
  run("openai/gpt-5", 2, 3000),
  run("google/gemini-3-pro", 8, 9000),
];

const count = (svg: string, re: RegExp): number => svg.match(re)?.length ?? 0;

describe("ogSvgOf", () => {
  test("the card is the declared 1200×630 and paints its own ground", () => {
    const svg = ogSvgOf(RUNS);
    expect(svg.startsWith(`<svg xmlns="http://www.w3.org/2000/svg" width="${OG_W}" height="${OG_H}"`)).toBe(true);
    expect(svg).toContain(`viewBox="0 0 ${OG_W} ${OG_H}"`);
    // Transparency is wrong on a card: Discord composites it on its own chrome.
    expect(svg).toContain(`<rect width="${OG_W}" height="${OG_H}" fill="#14161a"/>`);
    expect(svg.endsWith("</svg>")).toBe(true);
  });

  test("one puck per entry, and a frontier segment for every step but the first", () => {
    const svg = ogSvgOf(RUNS);
    // Each mark is a separation disc, a white puck, and its art or fallback.
    expect(count(svg, /fill="#ffffff"/g)).toBe(3);
    // Two of the three are on the front (`b` is dominated), so the staircase
    // is one step: a horizontal and a vertical.
    const path = /<path d="M [^"]*"/.exec(svg)?.[0] ?? "";
    expect(count(path, / L /g)).toBe(2);
  });

  test("no text but the wordmark, and none at all when it is off", () => {
    const svg = ogSvgOf(RUNS);
    expect(count(svg, /<text/g)).toBe(1);
    expect(svg).toContain(">WrathBench</text>");
    expect(count(ogSvgOf(RUNS, { wordmark: false }), /<text/g)).toBe(0);
  });

  test("colours are literal — resvg has no cascade, so a var() would paint nothing", () => {
    expect(ogSvgOf(RUNS)).not.toContain("var(");
  });

  test("a logo is placed for a family that has one, and a plain disc for one that does not", () => {
    const svg = ogSvgOf(RUNS, { logoHref: (m) => (m.startsWith("openai/") ? "data:image/svg+xml,%3Csvg%2F%3E" : null) });
    expect(count(svg, /<image /g)).toBe(1);
  });

  test("nothing to plot is still a valid card, not a missing image", () => {
    const svg = ogSvgOf([]);
    expect(svg).toContain(`<rect width="${OG_W}" height="${OG_H}"`);
    expect(count(svg, /fill="#ffffff"/g)).toBe(0);
    expect(svg.endsWith("</svg>")).toBe(true);
  });

  test("free runs are out, exactly as on the homepage", () => {
    const free = { ...run("z/free-model", 0, 99999), billing: "free" } as ResultRun;
    expect(count(ogSvgOf([...RUNS, free]), /fill="#ffffff"/g)).toBe(3);
  });
});

describe("ogTags", () => {
  test("the image and the page URL are absolute, and the stamp busts the crawler's cache", () => {
    const html = ogTags({ origin: "https://example.workers.dev", stamp: "abc123" });
    expect(html).toContain('<meta property="og:image" content="https://example.workers.dev/og.png?v=abc123" />');
    expect(html).toContain('<meta property="og:url" content="https://example.workers.dev/" />');
    expect(html).toContain('<meta property="og:image:width" content="1200" />');
    expect(html).toContain('<meta property="og:image:height" content="630" />');
    // The wide card, not the square crop.
    expect(html).toContain('<meta name="twitter:card" content="summary_large_image" />');
    expect(html).toContain(`<meta name="twitter:title" content="${OG_TITLE}" />`);
    expect(html).toContain(`<meta name="twitter:description" content="${OG_DESCRIPTION}" />`);
    expect(html).toContain('<meta name="twitter:image" content="https://example.workers.dev/og.png?v=abc123" />');
  });

  test("a trailing slash on the origin does not double up", () => {
    expect(ogTags({ origin: "https://example.workers.dev/", stamp: "x" })).toContain(
      'content="https://example.workers.dev/og.png?v=x"',
    );
  });

  test("the private build gets no image tag rather than an unresolvable relative one", () => {
    expect(ogTags(null)).toBe("");
    expect(ogTagsFromEnv({})).toBeNull();
    // Half the pair is not enough: an origin with no stamp would publish a URL
    // that never changes.
    expect(ogTagsFromEnv({ VITE_WRATHBENCH_PUBLIC_ORIGIN: "https://x.dev" })).toBeNull();
    expect(ogTagsFromEnv({ VITE_WRATHBENCH_OG_STAMP: "abc" })).toBeNull();
    expect(ogTagsFromEnv({ VITE_WRATHBENCH_PUBLIC_ORIGIN: "https://x.dev", VITE_WRATHBENCH_OG_STAMP: "abc" })).toEqual({
      origin: "https://x.dev",
      stamp: "abc",
    });
  });
});
