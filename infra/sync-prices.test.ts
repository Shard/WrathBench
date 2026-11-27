/**
 * The price sync's own-listing stage (OpenCode Go's `/models`) and the inputs
 * that tell it what the fleet runs. Fixture listings in OpenCode's shape; no
 * network, no config store, no corpus.
 */

import { describe, expect, test } from "bun:test";
import { formatCatalogue, parseCatalogue, priceTables, type ModelCatalogue } from "./model-catalogue";
import {
  foldListing,
  listingAsks,
  listingQuote,
  listingRows,
  peakNote,
  rosterLaunches,
  rosterModels,
  type ListingRow,
} from "./sync-prices";

const BASE = "https://llm.acme.example/go/v1";
const TODAY = "2026-11-18";

type Doc = Parameters<typeof foldListing>[0];

/** A small catalogue with one listing provider: a kept row, a hand-held row, and an entry with only an OpenRouter row. */
function doc(): Doc {
  return {
    _notes: ["fixture"],
    version: 2,
    icons: { package: "@lobehub/icons-static-svg", version: "1.94.0" },
    providers: {
      openrouter: { name: "OpenRouter", asOf: "2026-11-01" },
      anthropic: { name: "Anthropic" },
      acmego: {
        name: "Acme Go",
        apiBase: BASE,
        label: "acme-go",
        source: "list",
        subscription: true,
        listing: `${BASE}/models`,
        note: "Acme Go's own listing (row since {asOf}, read {read})",
        asOf: "2026-11-01",
      },
    },
    families: [{ id: "acme", name: "Acme", company: "Acme Labs", match: ["acme-labs/*"] }],
    models: {
      "acme-labs/kept-1": {
        family: "acme",
        name: "Kept 1",
        weights: "open",
        aliases: ["kept-1"],
        prices: {
          openrouter: { "acme-labs/kept-1": { windows: [{ input: 0.1, output: 0.2, cacheRead: 0.01, cacheWrite: 0.1 }] } },
          endpoints: { acmego: { ids: ["kept-1"], asOf: "2026-10-01", windows: [{ input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1 }], note: "typed by hand" } },
        },
      },
      "held-1": {
        family: "acme",
        name: "Held 1",
        weights: "unknown",
        prices: { endpoints: { acmego: { asOf: "2026-10-01", windows: [{ input: 5, output: 6, cacheRead: 5, cacheWrite: 5 }], note: "a third party's listing, read 2026-10-01", source: "catalogue" } } },
      },
      "acme-labs/new-1": {
        family: "acme",
        name: "New 1",
        weights: "open",
        aliases: ["new-1"],
        prices: { openrouter: { "acme-labs/new-1": { windows: [{ input: 0.3, output: 0.6, cacheRead: 0.03, cacheWrite: 0.3 }] } } },
      },
      "bare-1": { family: "acme", name: "Bare 1", weights: "unknown" },
    },
  } as unknown as Doc;
}

/** A listing row as OpenCode writes one: `cost.text` in dollars per million, `api` naming where it is served. */
function row(id: string, text: Record<string, unknown>, extra: Partial<ListingRow> = {}): ListingRow {
  return { id, cost: { text: text as never }, api: { "chat-completions": { base_url: BASE } }, ...extra };
}
const flat = (input: number, output: number, read?: number) => ({ input: { price: input, ...(read === undefined ? {} : { cache: { read } }) }, output: { price: output } });
/** OpenCode's DeepSeek multiplier, verbatim in shape. */
const PEAK = {
  when: {
    utc_days: { in: ["mon", "tue", "wed", "thu", "fri"] },
    any: [
      { all: [{ utc_hours: { gte: "01:00" } }, { utc_hours: { lt: "04:00" } }] },
      { all: [{ utc_hours: { gte: "06:00" } }, { utc_hours: { lt: "10:00" } }] },
    ],
  },
  factor: 2,
};

describe("listingQuote: what one listing row says a model costs on a base", () => {
  test("a flat rate in dollars per million; a cache tier the listing leaves out bills as input", () => {
    expect(listingQuote(row("m", flat(1.4, 4.4, 0.26)), BASE)).toEqual({ price: { input: 1.4, output: 4.4, cacheRead: 0.26, cacheWrite: 1.4 }, peak: null });
    expect(listingQuote(row("m", flat(2, 10)), BASE)).toEqual({ price: { input: 2, output: 10, cacheRead: 2, cacheWrite: 2 }, peak: null });
    const written = row("m", { input: { price: 3, cache: { read: 0.3, write: 3.75 } }, output: { price: 15 } });
    expect(listingQuote(written, BASE)).toEqual({ price: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }, peak: null });
  });

  test("a peak-hours multiplier keeps the off-peak rate and says when it doubles", () => {
    const q = listingQuote(row("m", flat(0.15, 0.6, 0.003), { cost: { text: flat(0.15, 0.6, 0.003) as never, multipliers: [PEAK] } }), BASE);
    expect(q).toEqual({ price: { input: 0.15, output: 0.6, cacheRead: 0.003, cacheWrite: 0.15 }, peak: "2× in peak hours, 01:00–04:00 and 06:00–10:00 UTC Monday to Friday" });
    expect(peakNote((q as { peak: string }).peak)).toContain("off-peak rate");
  });

  test("no row, with the reason, wherever one flat rate is not the price", () => {
    const skip = (r: ListingRow): string => {
      const q = listingQuote(r, BASE);
      if (!("skip" in q)) throw new Error(`expected a skip, got ${JSON.stringify(q)}`);
      return q.skip;
    };
    // Served on another API, or another base: another endpoint, whatever the id.
    expect(skip(row("m", flat(1, 2), { api: { responses: {} } }))).toContain("responses");
    expect(skip(row("m", flat(1, 2), { api: { "chat-completions": { base_url: "https://llm.acme.example/zen/v1" } } }))).toContain("not on this base");
    // Tiered by context size: a run's totals cannot split the calls.
    expect(skip(row("m", { input: { price: 0.3, overrides: [{ when: { context: { gt: 512000 } }, price: 0.6 }] }, output: { price: 1.2 } }))).toContain("tiers");
    // Cache writes priced by retention.
    expect(skip(row("m", { input: { price: 0.2, cache: { read: 0.02, write: { "30m": 0.25, "12h": 0.5 } } }, output: { price: 1.2 } }))).toContain("retention");
    // A rate that moves on a date is not a peak-hours caveat.
    expect(skip(row("m", flat(2, 10), { cost: { text: flat(2, 10) as never, multipliers: [{ when: { date: { gte: "2026-12-01" } }, factor: 2 }] } }))).toContain("date");
    // No text price at all.
    expect(skip(row("m", { input: {} }))).toContain("no text price");
  });
});

describe("what the fleet runs, as the sync is told it", () => {
  const fleet = JSON.stringify({
    roster: {
      "go-and-or": { model: "kept-1", providers: [{ credential: "go", apiBase: BASE }, { credential: "or", model: "acme-labs/kept-1" }] },
      plain: { model: "acme-labs/new-1" },
      older: { model: "new-1", apiBase: BASE },
      codex: { model: "gpt-6-astra", driver: "codex" },
    },
  });

  test("one launch per provider leg, each leg with its own model and base where it names one", () => {
    expect(rosterLaunches(fleet)).toEqual([
      { model: "kept-1", driver: undefined, apiBase: BASE },
      { model: "acme-labs/kept-1", driver: undefined, apiBase: null },
      { model: "acme-labs/new-1", driver: undefined, apiBase: null },
      { model: "new-1", driver: undefined, apiBase: BASE },
      { model: "gpt-6-astra", driver: "codex", apiBase: null },
    ]);
    // The OpenRouter leg's own id is asked for, and a codex slug under its vendor.
    expect(rosterModels(fleet)).toContain("acme-labs/kept-1");
    expect(rosterModels(fleet)).toContain("openai/gpt-6-astra");
  });
});

describe("the listing's asks", () => {
  test("the ids the kept rows price, and the launches on the provider's base, never a free slug or a hand-held row", () => {
    const launches = [
      { model: "new-1", apiBase: BASE },
      { model: "new-1", apiBase: "https://openrouter.ai/api/v1" },
      { model: "other-2", apiBase: "https://llm.acme.example/zen/v1" },
      { model: "cat-jam-free", apiBase: BASE },
      { model: "muse-contributor-free", apiBase: BASE },
      { model: "held-1", apiBase: `${BASE}/` },
    ];
    expect(listingAsks(doc(), "acmego", launches)).toEqual(["kept-1", "new-1"]);
    expect(listingRows(doc(), "acmego").held).toEqual(["held-1"]);
    // A provider with no base asks for nothing.
    expect(listingAsks(doc(), "openrouter", launches)).toEqual([]);
  });
});

describe("folding a listing into the catalogue", () => {
  const listing: ListingRow[] = [
    row("kept-1", flat(1, 2, 0.1)),
    row("new-1", flat(0.15, 0.6, 0.003), { cost: { text: flat(0.15, 0.6, 0.003) as never, multipliers: [PEAK] } }),
    row("held-1", flat(9, 9)),
    row("tiered-1", { input: { price: 1, overrides: [{ when: { context: { gt: 1 } }, price: 2 }] }, output: { price: 1 } }),
  ];
  const launches = [{ model: "new-1", apiBase: BASE }, { model: "tiered-1", apiBase: BASE }];

  test("an unchanged rate leaves the kept row's windows byte-identical; a new id gets a row dated today on the entry its alias names", () => {
    const before = doc();
    const { doc: out, report } = foldListing(before, "acmego", listing, launches, TODAY);
    const kept = out.models["acme-labs/kept-1"]!.prices!.endpoints!["acmego"]!;
    expect(kept.windows).toEqual(before.models["acme-labs/kept-1"]!.prices!.endpoints!["acmego"]!.windows);
    expect(kept.asOf).toBe("2026-10-01");
    // Quoted with no caveat: the provider's note, not the hand-typed one.
    expect(kept.note).toBeUndefined();
    const fresh = out.models["acme-labs/new-1"]!.prices!.endpoints!["acmego"]!;
    expect(fresh).toEqual({ ids: ["new-1"], asOf: TODAY, windows: [{ input: 0.15, output: 0.6, cacheRead: 0.003, cacheWrite: 0.15 }], note: `Acme Go's own listing (row since {asOf}, read {read}). ${peakNote("2× in peak hours, 01:00–04:00 and 06:00–10:00 UTC Monday to Friday")}` });
    // The OpenRouter rows beside them are not the listing's to touch.
    expect(out.models["acme-labs/new-1"]!.prices!.openrouter).toEqual(before.models["acme-labs/new-1"]!.prices!.openrouter);
    expect(out.providers["acmego"]!["asOf"]).toBe(TODAY);
    expect(report.priced.sort()).toEqual(["kept-1", "new-1"]);
    expect(report.appended).toEqual([]);
    expect(report.skipped).toEqual(["tiered-1 (priced in tiers by context size, which a run's totals cannot split)"]);
    // The input is not touched, and the output is a valid catalogue whose rows resolve their placeholders.
    expect(before.providers["acmego"]!["asOf"]).toBe("2026-11-01");
    const cat = parseCatalogue(formatCatalogue(out)) as ModelCatalogue;
    const rows = priceTables(cat).endpoints;
    expect(rows.find((r) => r.model === "new-1")!.note).toStartWith(`Acme Go's own listing (row since ${TODAY}, read ${TODAY}). The listing bills 2×`);
    expect(rows.find((r) => r.model === "kept-1")!.note).toBe(`Acme Go's own listing (row since 2026-10-01, read ${TODAY})`);
  });

  test("a hand-held row is never touched, even when the listing quotes its id", () => {
    const before = doc();
    const { doc: out } = foldListing(before, "acmego", listing, [...launches, { model: "held-1", apiBase: BASE }], TODAY);
    expect(out.models["held-1"]).toEqual(before.models["held-1"]!);
  });

  test("a moved rate appends a window from today; the earlier ones stay as they were", () => {
    const moved = [row("kept-1", flat(1.5, 3, 0.15))];
    const { doc: out, report } = foldListing(doc(), "acmego", moved, [], TODAY);
    expect(out.models["acme-labs/kept-1"]!.prices!.endpoints!["acmego"]!.windows).toEqual([
      { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1 },
      { input: 1.5, output: 3, cacheRead: 0.15, cacheWrite: 1.5, from: TODAY },
    ]);
    expect(report.appended).toEqual(["kept-1"]);
  });

  test("an id the listing drops keeps every window and its note, and is reported as kept", () => {
    const before = doc();
    const { doc: out, report } = foldListing(before, "acmego", [], [], TODAY);
    expect(out.models["acme-labs/kept-1"]).toEqual(before.models["acme-labs/kept-1"]!);
    expect(report.kept).toEqual(["kept-1"]);
    // Only the provider's stamp moved.
    expect(formatCatalogue({ ...out, providers: before.providers })).toBe(formatCatalogue(before));
  });

  test("a suffixless id quoted at 0/0 gets no row", () => {
    const { doc: out, report } = foldListing(doc(), "acmego", [row("new-1", flat(0, 0))], [{ model: "new-1", apiBase: BASE }], TODAY);
    expect(out.models["acme-labs/new-1"]!.prices!.endpoints).toBeUndefined();
    expect(report.skipped).toEqual(["new-1 (quoted at 0/0 without a free suffix)"]);
  });
});
