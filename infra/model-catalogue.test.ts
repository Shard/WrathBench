/**
 * The model catalogue: its file, its lookup, and the guard that keeps every
 * model id the repository names in it.
 *
 * Fixture-based throughout: the committed file, the repository's own fixtures
 * and documents built in-process. No network, no `data/`.
 */

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  ANTHROPIC_PRICES,
  ANTHROPIC_UNPRICED,
  CATALOGUE,
  ENDPOINT_PRICES,
  FAMILIES,
  OPENROUTER_DELISTED,
  OPENROUTER_PRICES,
  canonicalModelId,
  catalogueKeyOf,
  familyOf,
  formatCatalogue,
  modelOf,
  parseCatalogue,
  priceTables,
  weightsOf,
  type ModelCatalogue,
} from "./model-catalogue";
import { applyOpenRouterWindows, catalogueWindows, mergeWindows } from "./sync-prices";
import { modelIdsOf, uncatalogued } from "./model-catalogue-check";

const ROOT = join(import.meta.dir, "..");
const FILE = join(import.meta.dir, "model-catalogue.json");
const TEXT = readFileSync(FILE, "utf8");
const idOf = (model: string | null | undefined): string | null => familyOf(model)?.id ?? null;

describe("the committed file", () => {
  test("parses, and is written in the file's one spelling", () => {
    expect(() => parseCatalogue(TEXT)).not.toThrow();
    // A hand edit and a sync write the same bytes, so a diff shows what moved.
    expect(formatCatalogue(JSON.parse(TEXT))).toBe(TEXT);
  });

  test("an entry a family's globs claim is filed under that family", () => {
    // The globs are the fallback for an unlisted id; an entry filed elsewhere
    // would make the same model read two ways depending on its spelling.
    for (const [key, e] of Object.entries(CATALOGUE.models)) {
      for (const id of [key, ...(e.aliases ?? [])]) {
        const byGlob = FAMILIES.find((f) => f.match.some((p) => new RegExp(`^${p.replace(/[.+?^${}()|[\]\\/]/g, "\\$&").replace(/\*/g, ".*")}$`).test(id)));
        if (byGlob !== undefined) expect({ id, family: e.family }).toEqual({ id, family: byGlob.id });
      }
    }
  });
});

/*
 * Ids in this repository that are invented on purpose and must never be
 * catalogued: the shots fixture's `fixture/` namespace (its every-id-invented
 * promise) and the test fixtures' stand-ins. Anything else a fixture or the
 * roster example names is a real model and needs an entry.
 */
const INVENTED = new Set([
  "anthropic/fixture-model",
  "anthropic/claude-sonnet-5.5",
  "vendor/flash-model:free",
  "z-ai/glm-6",
  "test/model",
  // The shots fixture's `fixture/e90-model` as OpenCode Go records it, bare.
  "e90-model",
]);
const invented = (id: string): boolean => id.startsWith("fixture/") || INVENTED.has(id);

/** `model: "…"`, `"model": "…"` and `models: [ … ]`, as the fixtures spell them. */
function fixtureIds(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/\bmodels?"?\s*:\s*(\[[^\]]*\]|"[^"]+")/g)) {
    for (const q of m[1]!.matchAll(/"([^"]+)"/g)) out.push(q[1]!);
  }
  return out;
}

function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? filesUnder(p) : /\.(ts|json)$/.test(f) ? [p] : [];
  });
}

describe("no model id the repository names falls through to the fallback", () => {

  test("every fixture's models are catalogued, or invented on purpose", () => {
    const files = [join(ROOT, "infra/shots/fixture.ts"), ...filesUnder(join(ROOT, "runner/test/fixtures")), ...filesUnder(join(ROOT, "dashboard/test/fixtures"))];
    const found: string[] = [];
    for (const f of files) for (const id of fixtureIds(readFileSync(f, "utf8"))) found.push(id);
    expect(found).toContain("fixture/e90-model");
    expect(found).toContain("sonnet");
    expect([...new Set(found)].filter((id) => !invented(id) && catalogueKeyOf(id) === null)).toEqual([]);
    // …and nothing invented has crept into the catalogue either.
    expect([...new Set(found)].filter((id) => invented(id) && catalogueKeyOf(id) !== null)).toEqual([]);
  });

  test("every id a price row names is a catalogued model", () => {
    const priced = [
      ...Object.keys(OPENROUTER_PRICES.models),
      ...Object.keys(OPENROUTER_DELISTED),
      ...ANTHROPIC_PRICES.flatMap((r) => r.ids),
      ...Object.keys(ANTHROPIC_UNPRICED),
      ...ENDPOINT_PRICES.map((r) => r.model),
    ];
    expect(priced.length).toBeGreaterThan(40);
    expect(priced.filter((id) => catalogueKeyOf(id) === null)).toEqual([]);
  });

  test("the published-data check names exactly the ids nothing lists, and skips a scripted reference", () => {
    const body = {
      runs: [
        { model: "opus", resolvedModel: "claude-opus-5-5", driver: "claude-code" },
        { model: "acme-labs/acme-1", resolvedModel: null, driver: "openai" },
        { model: "reference/elwynn-human-paladin@1", driver: "reference" },
      ],
    };
    expect(uncatalogued(modelIdsOf(body, "runs.json"))).toEqual([{ id: "acme-labs/acme-1", where: ["runs.json"] }]);
  });
});

describe("lookup", () => {
  test("a CLI alias, a dated snapshot and a vendor-prefixed id land on their entries", () => {
    expect(modelOf("opus")).toMatchObject({ key: "opus", name: "Claude Opus (CLI alias)", weights: "closed" });
    expect(modelOf("claude-haiku-4-5-20251001")).toMatchObject({ key: "claude-haiku-4-5", weights: "closed" });
    // A codex slug is the same model as OpenRouter's prefixed id.
    expect(modelOf("gpt-6-astra").key).toBe("openai/gpt-6-astra");
    // The id Cerebras serves Qwen3.8 27B under is that model.
    expect(modelOf("qwen-3.8-27b")).toMatchObject({ key: "qwen/qwen3.8-27b", weights: "open" });
  });

  test("the billing suffix is stripped, not matched on; a Zen `-free` id is an alias", () => {
    expect(modelOf("nvidia/nemotron-3-ultra-550b-a55b:free").key).toBe("nvidia/nemotron-3-ultra-550b-a55b");
    expect(modelOf("poolside/laguna-s-2.1:free").key).toBe("poolside/laguna-s-2.1");
    expect(modelOf("laguna-s-2.1-free").key).toBe("poolside/laguna-s-2.1");
    expect(modelOf("ling-3.0-flash-fin-free").key).toBe("inclusionai/ling-3.0-flash-fin");
  });

  test("an unlisted id falls back to the first family whose glob claims it", () => {
    expect(modelOf("anthropic/claude-opus-4-1")).toMatchObject({ key: null, family: { id: "claude" }, name: null });
    expect(idOf("z-ai/glm-5.2:free")).toBe("glm");
    // A glob is anchored at both ends: a prefix pattern is not a substring search.
    expect(idOf("gpt-4o-mini")).toBe("openai");
    expect(idOf("acme/not-gpt-at-all")).toBeNull();
    expect(idOf("openai-router/thing")).toBeNull();
    // File order is the precedence: deepseek/* is deepseek's, which sits above qwen.
    const first = FAMILIES.findIndex((f) => f.id === "deepseek");
    expect(first).toBeGreaterThanOrEqual(0);
    expect(first).toBeLessThan(FAMILIES.findIndex((f) => f.id === "qwen"));
    expect(familyOf("opus")).toMatchObject({ id: "claude", name: "Claude", company: "Anthropic" });
  });
});

describe("canonicalModelId — one model whichever provider served it (operator, 2026-11-16)", () => {
  test("OpenCode Go's bare id and OpenRouter's vendor-prefixed id are one model", () => {
    expect(canonicalModelId("deepseek-v4.1-flash")).toBe("deepseek/deepseek-v4.1-flash");
    expect(canonicalModelId("deepseek/deepseek-v4.1-flash")).toBe("deepseek/deepseek-v4.1-flash");
  });

  test("the general rule needs no alias: either form finds the entry by its bare id", () => {
    // Listed under its prefixed key only, with no bare alias.
    expect(CATALOGUE.models["cohere/north-mini-code"]!.aliases).toBeUndefined();
    expect(canonicalModelId("north-mini-code")).toBe("cohere/north-mini-code");
    // Listed under its bare key, with the prefixed spelling an alias.
    expect(canonicalModelId("xiaomi/mimo-v2.5")).toBe("mimo-v2.5");
    expect(canonicalModelId("mimo-v2.5")).toBe("mimo-v2.5");
  });

  test("a literally free endpoint is never the paid model: it is the model marked free, on any free endpoint (operator, 2026-11-16)", () => {
    // OpenRouter's `:free` endpoint and a Zen `-free` id of one model: one free model, apart from the paid one.
    expect(canonicalModelId("deepseek/deepseek-v4.1-flash:free")).toBe("deepseek/deepseek-v4.1-flash:free");
    expect(canonicalModelId("deepseek-v4.1-flash-free")).toBe("deepseek/deepseek-v4.1-flash:free");
    // A `-free` alias of a paid entry.
    expect(canonicalModelId("laguna-s-2.1-free")).toBe("poolside/laguna-s-2.1:free");
    expect(canonicalModelId("poolside/laguna-s-2.1")).toBe("poolside/laguna-s-2.1");
    // An entry spelled free is its own key, and so is its alias; a contributor-free one too.
    expect(canonicalModelId("catjam")).toBe("cat-jam-free");
    expect(canonicalModelId("muse-spark-1.2-contributor-free")).toBe("muse-spark-1.2-contributor-free");
    // Every one still resolves in the catalogue: its mark, its family.
    for (const id of ["deepseek/deepseek-v4.1-flash:free", "poolside/laguna-s-2.1:free", "cat-jam-free"]) expect(familyOf(canonicalModelId(id))).not.toBeNull();
  });

  test("an uncatalogued model's bare and prefixed runs still meet, on the bare form", () => {
    expect(canonicalModelId("fixture/some-model")).toBe("some-model");
    expect(canonicalModelId("some-model")).toBe("some-model");
    expect(canonicalModelId("")).toBe("");
  });

  test("every entry is its own canonical id, and no two entries share one", () => {
    const seen = new Map<string, string>();
    for (const [key, e] of Object.entries(CATALOGUE.models)) {
      expect({ key, canonical: canonicalModelId(key) }).toEqual({ key, canonical: key });
      // A `-free` alias of a paid entry is that entry's free endpoint.
      const free = (id: string): boolean => /(?::free|-free)$/.test(id);
      for (const alias of e.aliases ?? []) expect({ alias, canonical: canonicalModelId(alias) }).toEqual({ alias, canonical: free(alias) && !free(key) ? `${key}:free` : key });
      const bare = key.slice(key.lastIndexOf("/") + 1);
      expect({ bare, canonical: canonicalModelId(bare) }).toEqual({ bare, canonical: key });
      expect(seen.get(canonicalModelId(key))).toBeUndefined();
      seen.set(canonicalModelId(key), key);
    }
  });
});

describe("weights", () => {

  test("every spelling of one model reads the same", () => {
    for (const id of ["opus", "sonnet", "claude-haiku-4-5-20251001", "anthropic/claude-opus-4-1"]) expect(weightsOf(id)).toBe("closed");
    expect(weightsOf("poolside/laguna-s-2.1:free")).toBe("open");
    expect(weightsOf("laguna-s-2.1-free")).toBe("open");
    expect(weightsOf("qwen-3.8-27b")).toBe(weightsOf("qwen/qwen3.8-27b"));
    expect(weightsOf("NVIDIA/Nemotron-3-Ultra-550B-A55B:FREE")).toBe("open");
  });

  test("an id the catalogue does not list is unknown, never its family's guess — unless the family is closed throughout", () => {
    expect(weightsOf("openai/gpt-9-unreleased")).toBe("unknown");
    expect(weightsOf("mistralai/mistral-large")).toBe("unknown");
    // Anthropic publishes no weights at all: the family says so for every id.
    expect(weightsOf("anthropic/fixture-model")).toBe("closed");
    // An operator verdict where the developer's own pages are silent.
    expect(weightsOf("meta/muse-spark-1.3-contributor")).toBe("closed");
  });
});

/** A small document in the catalogue's shape, for the refusals and the sync. */
function doc(): Record<string, unknown> {
  return {
    _notes: ["fixture"],
    version: 2,
    icons: { package: "@lobehub/icons-static-svg", version: "1.94.0" },
    providers: {
      openrouter: { name: "OpenRouter", asOf: "2026-10-01" },
      anthropic: { name: "Anthropic" },
      acmehost: { name: "Acme Host", apiBase: "https://api.acme.example/v1", label: "acme", source: "list", note: "Acme's list, read {asOf}" },
    },
    families: [
      { id: "claude", name: "Claude", company: "Anthropic", icon: "claude-color", match: ["anthropic/*", "claude*"], weights: "closed", source: "no weights" },
      { id: "acme", name: "Acme", company: "Acme Labs", match: ["acme-labs/*"] },
    ],
    models: {
      "acme-labs/acme-1": {
        family: "acme",
        name: "Acme 1",
        weights: "open",
        source: "https://example.com/acme-1",
        aliases: ["acme-1"],
        prices: {
          openrouter: {
            "acme-labs/acme-1": { windows: [{ input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1 }] },
            "acme-labs/acme-1:free": { windows: [{ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }] },
          },
          endpoints: { acmehost: { ids: ["acme-1"], asOf: "2026-09-01", windows: [{ input: 3, output: 4, cacheRead: 3, cacheWrite: 3 }] } },
        },
      },
      "acme-labs/acme-0": {
        family: "acme",
        name: "Acme 0",
        weights: "unknown",
        prices: { openrouter: { "acme-labs/acme-0": { windows: [], delisted: "gone" } } },
      },
      "claude-x-1": { family: "claude", name: "Claude X 1", prices: { anthropic: { asOf: "2026-10-16", windows: [{ input: 5, output: 25, cacheRead: 0.5, cacheWrite: 10 }] } } },
    },
  };
}
const json = (d: unknown): string => JSON.stringify(d);
const mutate = (f: (d: any) => void): string => {
  const d = doc();
  f(d);
  return json(d);
};

describe("parseCatalogue", () => {
  test("a well-formed document parses, and its tables resolve against its providers", () => {
    const cat = parseCatalogue(json(doc()));
    const t = priceTables(cat as ModelCatalogue);
    expect(t.endpoints).toEqual([
      { id: "acme/acme-1", apiBase: "https://api.acme.example/v1", model: "acme-1", windows: [{ input: 3, output: 4, cacheRead: 3, cacheWrite: 3 }], asOf: "2026-09-01", source: "list", note: "Acme's list, read 2026-09-01", subscription: false },
    ]);
    expect(Object.keys(t.openrouter.models)).toEqual(["acme-labs/acme-1", "acme-labs/acme-1:free"]);
    expect(t.delisted).toEqual({ "acme-labs/acme-0": "gone" });
    expect(t.anthropic).toEqual([{ ids: ["claude-x-1"], windows: [{ input: 5, output: 25, cacheRead: 0.5, cacheWrite: 10 }], asOf: "2026-10-16" }]);
  });

  test("a subscription provider marks its rows, and the flag is only ever true, on an endpoint provider", () => {
    const sub = priceTables(parseCatalogue(mutate((d) => (d.providers.acmehost.subscription = true))) as ModelCatalogue);
    expect(sub.endpoints.map((r) => r.subscription)).toEqual([true]);
    expect(() => parseCatalogue(mutate((d) => (d.providers.acmehost.subscription = false)))).toThrow(/subscription must be true, on an endpoint provider/);
    expect(() => parseCatalogue(mutate((d) => (d.providers.anthropic.subscription = true)))).toThrow(/subscription must be true, on an endpoint provider/);
  });

  test("an id is written as the catalogue compares it, and names one entry only", () => {
    expect(() => parseCatalogue(mutate((d) => (d.models["Acme-Labs/Acme-2"] = { family: "acme", name: "x", weights: "open" })))).toThrow(/must be written as the catalogue compares it \("acme-labs\/acme-2"\)/);
    expect(() => parseCatalogue(mutate((d) => (d.models["acme-labs/acme-0"].aliases = ["acme-1"])))).toThrow(/"acme-1" names two entries/);
    // A bare form two entries share: a Go-served and an OpenRouter-served run would land on two models.
    expect(() => parseCatalogue(mutate((d) => (d.models["other-host/acme-1"] = { family: "acme", name: "x", weights: "open" })))).toThrow(/the bare id "acme-1" names two entries/);
  });

  test("rate windows are ordered, dated after the first, and never a suffixless zero", () => {
    const w = (d: any): any[] => d.models["acme-labs/acme-1"].prices.openrouter["acme-labs/acme-1"].windows;
    expect(() => parseCatalogue(mutate((d) => (w(d)[0].from = "2026-01-01")))).toThrow(/first window carries no `from`/);
    expect(() => parseCatalogue(mutate((d) => w(d).push({ input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1 })))).toThrow(/from must be a YYYY-MM-DD day/);
    expect(() => parseCatalogue(mutate((d) => w(d).push({ input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1, from: "2026-09-02" }, { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1, from: "2026-09-01" })))).toThrow(/must come after the window before it/);
    expect(() => parseCatalogue(mutate((d) => (w(d)[0].input = -1)))).toThrow(/input must be a non-negative number/);
    // A paid model reading as free is the one shape no row may hold; a free slug's 0/0 is fine.
    expect(() => parseCatalogue(mutate((d) => (w(d)[0] = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })))).toThrow(/suffixless id is never priced at zero/);
  });
});

describe("the sync writes onto the catalogue", () => {
  const base = doc() as Parameters<typeof applyOpenRouterWindows>[0];
  const priced = { input: 2, output: 4, cacheRead: 0.2, cacheWrite: 2 };

  test("a merge round-trip changes nothing but OpenRouter windows and the provider's asOf", () => {
    const windows = { ...catalogueWindows(base), "acme-labs/acme-1": [{ input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1 }, { ...priced, from: "2026-10-20" }] };
    delete (windows as Record<string, unknown>)["acme-labs/acme-0"];
    const { doc: out, unlisted } = applyOpenRouterWindows(base, windows, "2026-10-20");
    expect(unlisted).toEqual([]);
    const strip = (d: any): any => {
      const c = structuredClone(d);
      delete c.providers.openrouter.asOf;
      for (const e of Object.values(c.models) as any[]) if (e.prices?.openrouter) for (const r of Object.values(e.prices.openrouter) as any[]) delete r.windows;
      return c;
    };
    expect(strip(out)).toEqual(strip(base));
    expect(out.providers["openrouter"]!["asOf"]).toBe("2026-10-20");
    expect(out.models["acme-labs/acme-1"]!.prices!.openrouter!["acme-labs/acme-1"]!.windows).toHaveLength(2);
    // The input is not touched, and the output is still a valid catalogue.
    expect(base.models["acme-labs/acme-1"]!.prices!.openrouter!["acme-labs/acme-1"]!.windows).toHaveLength(1);
    expect(() => parseCatalogue(formatCatalogue(out))).not.toThrow();
  });

  test("an id absent from the sync's answer keeps its block exactly as it was; the model is never removed", () => {
    const { doc: out } = applyOpenRouterWindows(base, {}, "2026-10-20");
    expect(Object.keys(out.models)).toEqual(Object.keys(base.models));
    expect(out.models["acme-labs/acme-1"]!.prices!.openrouter).toEqual(base.models["acme-labs/acme-1"]!.prices!.openrouter);
    expect(out.models["acme-labs/acme-0"]!.prices!.openrouter!["acme-labs/acme-0"]).toEqual({ windows: [], delisted: "gone" });
  });

  test("a sync after OpenRouter drops an id leaves every window it had, dated ones included, byte for byte", () => {
    // The real path with the fetch taken out: the catalogue's windows, merged
    // against a quote that no longer carries acme-1, written back.
    const history = [
      { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1 },
      { input: 1.5, output: 3, cacheRead: 0.15, cacheWrite: 1.5, from: "2026-09-15" },
    ];
    const before = mutate((d) => (d.models["acme-labs/acme-1"].prices.openrouter["acme-labs/acme-1"].windows = history));
    const start = JSON.parse(before) as Parameters<typeof applyOpenRouterWindows>[0];
    const quoted = { "acme-labs/acme-1:free": { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
    const merged = mergeWindows(catalogueWindows(start), quoted, "2026-10-20");
    expect(merged["acme-labs/acme-1"]).toEqual(history);
    const { doc: out, unlisted } = applyOpenRouterWindows(start, merged, "2026-10-20");
    expect(unlisted).toEqual([]);
    expect(out.models["acme-labs/acme-1"]).toEqual(start.models["acme-labs/acme-1"]);
    expect(out.models["acme-labs/acme-0"]).toEqual(start.models["acme-labs/acme-0"]);
    // Only the provider's stamp moved.
    expect(formatCatalogue({ ...out, providers: start.providers })).toBe(formatCatalogue(start));
    expect(out.providers["openrouter"]!["asOf"]).toBe("2026-10-20");
  });

  test("a new id lands on the entry its alias names; one no entry lists is reported, never written", () => {
    const { doc: out, unlisted } = applyOpenRouterWindows(base, { "acme-1": [priced], "acme-labs/acme-9": [priced] }, "2026-10-20");
    expect(out.models["acme-labs/acme-1"]!.prices!.openrouter!["acme-1"]!.windows).toEqual([priced]);
    expect(unlisted).toEqual(["acme-labs/acme-9"]);
    expect(JSON.stringify(out)).not.toContain("acme-9");
  });
});
