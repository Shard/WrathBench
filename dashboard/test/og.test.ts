import { describe, expect, test } from "bun:test";
import type { ResultRun } from "../src/api/client";
import { COST, XP } from "../src/lib/axes";
import { HOME_EPISODE } from "../src/lib/homeladder";
import { keepLabels, OG_H, OG_W, ogSvgOf, type LabelBox } from "../src/lib/og";
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

  test("every text element is one of the four the card allows, and each can be turned off", () => {
    const svg = ogSvgOf(RUNS);
    // The wordmark, three identity lines, the cue's word and one name per
    // frontier entry (two of the three). The cue's arrow is a path, not a glyph.
    expect(svg).toContain(">WrathBench</text>");
    expect(count(ogSvgOf(RUNS, { wordmark: false, cue: false, identity: false, labels: false }), /<text/g)).toBe(0);
    // The reading cue is one text, in the better corner (top-left for cost × xp).
    const withCue = ogSvgOf(RUNS, { wordmark: false, identity: false, labels: false });
    expect(count(withCue, /<text/g)).toBe(1);
    expect(withCue).toContain("better");
    expect(withCue).toContain('text-anchor="start"');
  });

  test("the identity block names both axes in the words `lib/axes.ts` uses, and the tier's length", () => {
    const svg = ogSvgOf(RUNS, { wordmark: false, cue: false, labels: false });
    // Verbatim from the specs, so the card cannot drift from the chart.
    expect(svg).toContain(`>${XP.caption(HOME_EPISODE)} vs</text>`);
    expect(svg).toContain(`>${COST.caption(HOME_EPISODE)}</text>`);
    expect(svg).toContain(">90-minute episodes</text>");
    // Right-aligned against the card's own margin, which is what puts it in
    // the corner the wordmark is not in.
    expect(count(svg, /text-anchor="end"/g)).toBe(3);
  });

  test("only the frontier is named, and the name is the site's display name", () => {
    const svg = ogSvgOf(RUNS, { wordmark: false, cue: false, identity: false });
    // `openai/gpt-5` is dominated by `claude-sonnet-4-5` on both axes.
    expect(svg).toContain(">claude-sonnet-4-5</text>");
    expect(svg).toContain(">gemini-3-pro</text>");
    expect(svg).not.toContain(">gpt-5</text>");
    // The provider prefix is dropped, as everywhere else on the site.
    expect(svg).not.toContain("anthropic/");
  });

  test("the font stack is the site's, not a build host's idea of sans-serif", () => {
    const svg = ogSvgOf(RUNS);
    expect(svg).not.toContain("Helvetica");
    // Named explicitly so a container with only DejaVu still draws text.
    expect(svg).toContain("DejaVu Sans Mono");
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

  test("the image is the publisher's object on the data hostname when there is one", () => {
    const html = ogTags({ origin: "https://app.example", stamp: "abc123", snapshotBase: "https://data.example" });
    // The picture the publisher rewrites every pass, not the static asset the
    // app origin serves — that one only ever changes when the SPA ships.
    expect(html).toContain('<meta property="og:image" content="https://data.example/v1/og.png?v=abc123" />');
    expect(html).toContain('<meta name="twitter:image" content="https://data.example/v1/og.png?v=abc123" />');
    // The page the card links back to is still the app.
    expect(html).toContain('<meta property="og:url" content="https://app.example/" />');
    // A trailing slash on the data hostname does not double up either.
    expect(ogTags({ origin: "https://app.example", stamp: "x", snapshotBase: "https://data.example/" })).toContain(
      'content="https://data.example/v1/og.png?v=x"',
    );
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

  test("the data hostname comes from the build's own snapshot base", () => {
    expect(
      ogTagsFromEnv({
        VITE_WRATHBENCH_PUBLIC_ORIGIN: "https://x.dev",
        VITE_WRATHBENCH_OG_STAMP: "abc",
        VITE_WRATHBENCH_SNAPSHOT_BASE: "https://d.dev",
      }),
    ).toEqual({ origin: "https://x.dev", stamp: "abc", snapshotBase: "https://d.dev" });
    // Insecure is refused for the same reason the app origin is: Discord drops
    // an http `og:image` and says nothing about it.
    expect(() =>
      ogTagsFromEnv({
        VITE_WRATHBENCH_PUBLIC_ORIGIN: "https://x.dev",
        VITE_WRATHBENCH_OG_STAMP: "abc",
        VITE_WRATHBENCH_SNAPSHOT_BASE: "http://d.dev",
      }),
    ).toThrow();
  });
});

/**
 * The collision rule on its own, over boxes and scores — no text measurement,
 * no chart. The card's promise is that it always renders cleanly, and this is
 * the whole of what makes that true.
 */
describe("keepLabels", () => {
  const box = (key: string, l: number, score: number, w = 10): LabelBox => ({ key, l, r: l + w, t: 0, b: 10, score });

  test("boxes that do not touch are all kept, in the order they came in", () => {
    const cands = [box("a", 0, 1), box("b", 20, 9), box("c", 40, 5)];
    expect(keepLabels(cands).map((c) => c.key)).toEqual(["a", "b", "c"]);
  });

  test("of two that collide, the lower-scored one is dropped", () => {
    // `b` overlaps `a` by half a box; `a` is the better entry on the axis.
    expect(keepLabels([box("a", 0, 9), box("b", 5, 1)]).map((c) => c.key)).toEqual(["a"]);
    // …and the rule does not depend on input order.
    expect(keepLabels([box("b", 5, 1), box("a", 0, 9)]).map((c) => c.key)).toEqual(["a"]);
  });

  test("a chain drops only what it has to: the best keeps its name, the next clear one keeps its own", () => {
    const cands = [box("a", 0, 9), box("b", 5, 8), box("c", 11, 7)];
    // `b` collides with `a` and goes; `c` clears `a` (a ends at 10) and stays.
    expect(keepLabels(cands).map((c) => c.key)).toEqual(["a", "c"]);
  });

  test("touching edges do not collide — the boxes carry their own padding", () => {
    expect(keepLabels([box("a", 0, 9), box("b", 10, 1)]).map((c) => c.key)).toEqual(["a", "b"]);
  });

  test("a reserved box wins against everything, whatever it scores against", () => {
    // This is the wordmark and the identity block defending their corners.
    expect(keepLabels([box("a", 0, 1e9)], [{ l: 0, t: 0, r: 4, b: 4 }])).toEqual([]);
  });

  test("ties break on key, so the same roster always yields the same card", () => {
    expect(keepLabels([box("b", 0, 5), box("a", 5, 5)]).map((c) => c.key)).toEqual(["a"]);
    expect(keepLabels([box("a", 5, 5), box("b", 0, 5)]).map((c) => c.key)).toEqual(["a"]);
  });

  test("nothing in, nothing out", () => {
    expect(keepLabels([])).toEqual([]);
  });
});
