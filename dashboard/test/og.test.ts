import { describe, expect, test } from "bun:test";
import type { ResultRun } from "../src/api/client";
import { keepLabels, OG_H, OG_W, ogSvgOf, type LabelBox } from "../src/lib/og";
import { ogTags, ogTagsFromEnv } from "../src/lib/og-tags";

/**
 * The public site's share card: what it plots is what the homepage plots, and
 * the tags that point a crawler at it are absolute and refuse an insecure host.
 *
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
  test("only the frontier is named, by the site's display name", () => {
    const svg = ogSvgOf(RUNS, { wordmark: false, cue: false, identity: false });
    // `openai/gpt-5` is dominated by `claude-sonnet-4-5` on both axes.
    expect(svg).toContain(">claude-sonnet-4-5</text>");
    expect(svg).toContain(">gemini-3-pro</text>");
    expect(svg).not.toContain(">gpt-5</text>");
    expect(svg).not.toContain("anthropic/");
  });

  test("free runs and a preview series are out, exactly as on the homepage", () => {
    const free = { ...run("z/free-model", 0, 99999), billing: "free" } as ResultRun;
    expect(count(ogSvgOf([...RUNS, free]), /fill="#ffffff"/g)).toBe(3);
    const next = { ...run("z/next-model", 1, 99999), harnessVersion: "harness-1.0-1-gabc", harnessSeries: "1.0" } as ResultRun;
    // Unset, the newer series is the card's, as it is the homepage's.
    expect(count(ogSvgOf([...RUNS, next]), /fill="#ffffff"/g)).toBe(1);
    expect(count(ogSvgOf([...RUNS, next], { preview: "1.0" }), /fill="#ffffff"/g)).toBe(3);
  });

  test("nothing to plot is still a valid card, not a missing image", () => {
    const svg = ogSvgOf([]);
    expect(svg).toContain(`<rect width="${OG_W}" height="${OG_H}"`);
    expect(svg.endsWith("</svg>")).toBe(true);
  });
});

describe("ogTags", () => {
  test("the image is absolute, on the data hostname when there is one, and the stamp busts the crawler's cache", () => {
    const html = ogTags({ origin: "https://example.workers.dev/", stamp: "abc123" });
    expect(html).toContain('<meta property="og:image" content="https://example.workers.dev/og.png?v=abc123" />');
    expect(html).toContain('<meta property="og:url" content="https://example.workers.dev/" />');
    const data = ogTags({ origin: "https://app.example", stamp: "abc123", snapshotBase: "https://data.example/" });
    expect(data).toContain('<meta property="og:image" content="https://data.example/v1/og.png?v=abc123" />');
    expect(data).toContain('<meta property="og:url" content="https://app.example/" />');
  });

  test("the private build gets no image tag, half the pair is none, and an insecure data host is refused", () => {
    expect(ogTags(null)).toBe("");
    expect(ogTagsFromEnv({})).toBeNull();
    expect(ogTagsFromEnv({ VITE_WRATHBENCH_PUBLIC_ORIGIN: "https://x.dev" })).toBeNull();
    expect(ogTagsFromEnv({ VITE_WRATHBENCH_OG_STAMP: "abc" })).toBeNull();
    expect(
      ogTagsFromEnv({ VITE_WRATHBENCH_PUBLIC_ORIGIN: "https://x.dev", VITE_WRATHBENCH_OG_STAMP: "abc", VITE_WRATHBENCH_SNAPSHOT_BASE: "https://d.dev" }),
    ).toEqual({ origin: "https://x.dev", stamp: "abc", snapshotBase: "https://d.dev" });
    // Discord drops an http `og:image` and says nothing about it.
    expect(() =>
      ogTagsFromEnv({ VITE_WRATHBENCH_PUBLIC_ORIGIN: "https://x.dev", VITE_WRATHBENCH_OG_STAMP: "abc", VITE_WRATHBENCH_SNAPSHOT_BASE: "http://d.dev" }),
    ).toThrow();
  });
});

/** The collision rule on its own, over boxes and scores: what keeps the card rendering cleanly. */
describe("keepLabels", () => {
  const box = (key: string, l: number, score: number, w = 10): LabelBox => ({ key, l, r: l + w, t: 0, b: 10, score });

  test("of two that collide the lower-scored goes, whatever the input order; a clear one stays", () => {
    expect(keepLabels([box("a", 0, 9), box("b", 5, 1)]).map((c) => c.key)).toEqual(["a"]);
    expect(keepLabels([box("b", 5, 1), box("a", 0, 9)]).map((c) => c.key)).toEqual(["a"]);
    expect(keepLabels([box("a", 0, 9), box("b", 5, 8), box("c", 11, 7)]).map((c) => c.key)).toEqual(["a", "c"]);
  });

  test("a reserved box wins against everything", () => {
    expect(keepLabels([box("a", 0, 1e9)], [{ l: 0, t: 0, r: 4, b: 4 }])).toEqual([]);
  });
});
