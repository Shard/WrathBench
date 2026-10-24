/**
 * The model catalogue: its file, its lookup, and the guard that keeps every
 * model id the repository names in it.
 *
 * Fixture-based throughout: the committed file, the repository's own fixtures
 * and roster example, and documents built in-process. No network, no `data/`.
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
  WEIGHTS,
  catalogueKeyOf,
  familyOf,
  formatCatalogue,
  modelOf,
  parseCatalogue,
  priceTables,
  weightsOf,
  type ModelCatalogue,
} from "./model-catalogue";
import { applyOpenRouterWindows, catalogueOpenRouterIds, catalogueWindows } from "./sync-prices";
import { modelIdsOf, reformat, uncatalogued } from "./model-catalogue-check";

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

  test("every entry has a weights verdict, its own or its family's", () => {
    for (const [key, e] of Object.entries(CATALOGUE.models)) {
      const family = FAMILIES.find((f) => f.id === e.family);
      expect({ key, weights: e.weights ?? family?.weights }).toEqual({ key, weights: expect.stringMatching(/^(open|closed|unknown)$/) });
    }
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
const INVENTED = new Set(["anthropic/fixture-model", "anthropic/claude-sonnet-5.5", "vendor/flash-model:free", "z-ai/glm-6", "test/model"]);
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
  test("the roster example's models are all catalogued", () => {
    const example = JSON.parse(readFileSync(join(ROOT, "infra/fleet.example.json"), "utf8")) as { roster: Record<string, { model: string }> };
    const ids = Object.values(example.roster).map((e) => e.model);
    expect(ids.length).toBeGreaterThan(0);
    expect(ids.filter((id) => catalogueKeyOf(id) === null)).toEqual([]);
  });

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

  test("ids are compared trimmed and lowercased, and a provider's own casing of an id resolves", () => {
    expect(idOf("OpenAI/GPT-5.6-Luna")).toBe("openai");
    expect(idOf("NVIDIA/Nemotron-3-Ultra-550B-A55B:FREE")).toBe("nvidia");
    expect(modelOf("LongCat-2.5-Preview").key).toBe("longcat-2.5-preview-free");
    expect(modelOf("CatJam").key).toBe("cat-jam-free");
    expect(modelOf("  sonnet  ").key).toBe("sonnet");
  });

  test("vendors no family claimed before the catalogue now have their families", () => {
    expect(idOf("mimo-v2.5")).toBe("mimo");
    expect(idOf("xiaomi/mimo-v2.5")).toBe("mimo");
    expect(idOf("inclusionai/ling-3.0-flash-vl:free")).toBe("ling");
    expect(idOf("liquid/lfm-2.5-2.6b:free")).toBe("lfm");
    expect(idOf("inception/mercury-2.5")).toBe("mercury");
    expect(idOf("longcat-2.5-preview-free")).toBe("longcat");
    expect(idOf("nex-agi/nex-n2.5-pro:free")).toBe("nex");
    expect(idOf("dots-studio/dots-3-note-preview:free")).toBe("dots");
    expect(idOf("thinkingmachines/inkling-small:free")).toBe("inkling");
    expect(idOf("hy3-free")).toBe("hunyuan");
    expect(idOf("cat-jam-free")).toBe("beam");
    // Revealed stealth ids under their developers.
    expect(idOf("stealth/ox-alpha")).toBe("glm");
    expect(idOf("space-bunny")).toBe("minimax");
    expect(idOf("stealth/space-bunny-alpha")).toBe("minimax");
  });

  test("Muse Spark 1.2 is Meta's, and closed", () => {
    expect(modelOf("muse-spark-1.2-contributor-free")).toMatchObject({ family: { id: "llama", company: "Meta" }, weights: "closed" });
  });

  test("an unrevealed developer is a listed entry with no family: the UI's monogram", () => {
    expect(catalogueKeyOf("omen-alpha")).toBe("omen-alpha");
    expect(familyOf("omen-alpha")).toBeNull();
    expect(weightsOf("omen-alpha")).toBe("unknown");
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

  test("every family is well formed, and each of its globs claims for it", () => {
    for (const f of FAMILIES) {
      expect(f.id).toMatch(/^[a-z0-9-]+$/);
      expect(f.name.length).toBeGreaterThan(0);
      expect(f.company.length).toBeGreaterThan(0);
      expect(f.match.length).toBeGreaterThan(0);
      for (const pattern of f.match) expect(familyOf(pattern.replace(/\*/g, "x"))?.id).toBe(f.id);
    }
  });

  test("nothing at all is nothing: null, undefined, empty, blank", () => {
    for (const v of [null, undefined, "", "   ", ":free"]) {
      expect(familyOf(v)).toBeNull();
      expect(weightsOf(v)).toBe("unknown");
      expect(catalogueKeyOf(v)).toBeNull();
    }
  });
});

describe("weights", () => {
  test("a closed model in a family with open siblings is closed, and the open sibling is open", () => {
    expect(weightsOf("openai/gpt-oss-120b")).toBe("open");
    expect(weightsOf("openai/gpt-5.6-luna")).toBe("closed");
    expect(weightsOf("gpt-6-luna")).toBe("closed");
    expect(weightsOf("google/gemma-4-31b-it:free")).toBe("open");
    expect(weightsOf("google/gemini-4-argon")).toBe("closed");
  });

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
    expect(WEIGHTS).toEqual(["open", "closed", "unknown"]);
  });
});

describe("prices", () => {
  test("the flat views are the file's, keyed on the ids each provider bills under", () => {
    expect(OPENROUTER_PRICES.asOf).toBe(CATALOGUE.providers["openrouter"]!.asOf!);
    expect(ANTHROPIC_PRICES.find((r) => r.ids.includes("claude-haiku-4-5-20251001"))?.ids).toEqual(["claude-haiku-4-5", "claude-haiku-4-5-20251001"]);
    expect(ANTHROPIC_UNPRICED["claude-haiku-5-5"]).toContain("tiered per request");
    expect(ENDPOINT_PRICES.map((r) => r.id).sort()).toEqual([
      "cerebras/qwen-3.8-27b",
      "deepseek/deepseek-flash",
      "opencode-go/deepseek-v4.1-flash",
      "opencode-go/kimi-k3.1-pro",
      "opencode-go/mimo-v2.5",
      "opencode-go/mimo-v2.6-flash",
      "opencode-go/omen-alpha",
      "opencode-go/space-bunny",
    ]);
    // A provider's default note is the row's, with the row's own date in it.
    const go = ENDPOINT_PRICES.find((r) => r.id === "opencode-go/mimo-v2.5")!;
    expect(go.note).toStartWith("models.dev registry listing for the opencode-go provider, read 2026-10-16.");
    expect(go.source).toBe("catalogue");
  });

  test("an emptied OpenRouter id reads as no row at all, and a delisted one says why", () => {
    expect(OPENROUTER_PRICES.models["stealth/ox-alpha"]).toBeUndefined();
    expect(OPENROUTER_DELISTED["stealth/ox-alpha"]).toContain("delisted");
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
      { id: "acme/acme-1", apiBase: "https://api.acme.example/v1", model: "acme-1", windows: [{ input: 3, output: 4, cacheRead: 3, cacheWrite: 3 }], asOf: "2026-09-01", source: "list", note: "Acme's list, read 2026-09-01" },
    ]);
    expect(Object.keys(t.openrouter.models)).toEqual(["acme-labs/acme-1", "acme-labs/acme-1:free"]);
    expect(t.delisted).toEqual({ "acme-labs/acme-0": "gone" });
    expect(t.anthropic).toEqual([{ ids: ["claude-x-1"], windows: [{ input: 5, output: 25, cacheRead: 0.5, cacheWrite: 10 }], asOf: "2026-10-16" }]);
  });

  test("a model needs a weights verdict unless its family states one for all", () => {
    expect(() => parseCatalogue(mutate((d) => delete d.models["acme-labs/acme-1"].weights))).toThrow(/acme-labs\/acme-1: weights is required/);
    expect(() => parseCatalogue(mutate((d) => (d.models["acme-labs/acme-1"].weights = "maybe")))).toThrow(/weights must be one of open, closed, unknown/);
    // The Claude family is closed throughout, so its entry states none.
    expect(() => parseCatalogue(json(doc()))).not.toThrow();
  });

  test("an id is written as the catalogue compares it, and names one entry only", () => {
    expect(() => parseCatalogue(mutate((d) => (d.models["Acme-Labs/Acme-2"] = { family: "acme", name: "x", weights: "open" })))).toThrow(/must be written as the catalogue compares it \("acme-labs\/acme-2"\)/);
    expect(() => parseCatalogue(mutate((d) => (d.models["acme-labs/acme-0"].aliases = ["acme-1"])))).toThrow(/"acme-1" names two entries/);
  });

  test("a price names only its own entry's ids, and a provider prices an id once", () => {
    expect(() => parseCatalogue(mutate((d) => (d.models["acme-labs/acme-1"].prices.endpoints.acmehost.ids = ["acme-9"])))).toThrow(/served id "acme-9" is not this entry's key or one of its aliases/);
    expect(() => parseCatalogue(mutate((d) => (d.models["acme-labs/acme-0"].prices.openrouter["acme-labs/acme-1"] = { windows: [] })))).toThrow(/OpenRouter id "acme-labs\/acme-1" is not this entry's/);
    expect(() => parseCatalogue(mutate((d) => (d.models["acme-labs/acme-1"].prices.endpoints.nowhere = { asOf: "2026-09-01", windows: [{ input: 1, output: 1, cacheRead: 1, cacheWrite: 1 }] })))).toThrow(/nowhere is not an endpoint provider/);
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

  test("an Anthropic row is windows or a decided blank, not both", () => {
    expect(() => parseCatalogue(mutate((d) => (d.models["claude-x-1"].prices.anthropic.unpriced = "why")))).toThrow(/give windows \(with asOf\) or unpriced/);
    expect(() => parseCatalogue(mutate((d) => (d.models["claude-x-1"].prices.anthropic = { unpriced: "tiered" })))).not.toThrow();
  });

  test("families: ids are safe file names, unique, and an icon-less family is allowed", () => {
    expect(() => parseCatalogue(mutate((d) => (d.families[1].id = "../escape")))).toThrow(/must match/);
    expect(() => parseCatalogue(mutate((d) => d.families.push({ ...d.families[1] })))).toThrow(/duplicate family id "acme"/);
    expect(() => parseCatalogue(mutate((d) => delete d.families[1].company))).toThrow(/family acme company/);
    expect(() => parseCatalogue(mutate((d) => (d.families[1].match = [])))).toThrow(/family acme match/);
    expect(() => parseCatalogue(mutate((d) => (d.models["acme-labs/acme-1"].family = "nope")))).toThrow(/family must be a family id or null/);
    expect(parseCatalogue(json(doc())).families[1]!.icon).toBeUndefined();
  });

  test("bad shapes are refused by name, not coerced", () => {
    expect(() => parseCatalogue("{oops")).toThrow(/not valid JSON/);
    expect(() => parseCatalogue(mutate((d) => (d.version = "2")))).toThrow(/version must be a number/);
    expect(() => parseCatalogue(mutate((d) => (d.icons.version = "")))).toThrow(/icons\.version/);
    expect(() => parseCatalogue(mutate((d) => (d.extra = 1)))).toThrow(/unknown key `extra`/);
    expect(() => parseCatalogue(mutate((d) => (d.models["acme-labs/acme-1"].vendor = "x")))).toThrow(/unknown key `vendor`/);
    expect(() => parseCatalogue(mutate((d) => delete d.providers.openrouter))).toThrow(/providers\.openrouter is required/);
  });
});

describe("formatCatalogue", () => {
  test("--format turns a hand edit's spelling into the file's, and refuses an invalid one", () => {
    expect(reformat(JSON.stringify(doc(), null, 4))).toBe(formatCatalogue(doc()));
    expect(reformat(TEXT)).toBe(TEXT);
    expect(() => reformat(mutate((d) => (d.models["acme-labs/acme-1"].weights = "maybe")))).toThrow(/weights must be one of/);
  });

  test("short objects and arrays stay on one line, long ones break, and the result is valid JSON", () => {
    const text = formatCatalogue(doc());
    expect(text).toContain('"aliases": ["acme-1"]');
    expect(text).toContain('{ "input": 1, "output": 2, "cacheRead": 0.1, "cacheWrite": 1 }');
    expect(JSON.parse(text)).toEqual(doc());
    expect(formatCatalogue(JSON.parse(text))).toBe(text);
  });
});

describe("the sync writes onto the catalogue", () => {
  const base = doc() as Parameters<typeof applyOpenRouterWindows>[0];
  const priced = { input: 2, output: 4, cacheRead: 0.2, cacheWrite: 2 };

  test("the standing asks are every OpenRouter id the catalogue carries, emptied ones included", () => {
    expect(catalogueOpenRouterIds(base).sort()).toEqual(["acme-labs/acme-0", "acme-labs/acme-1", "acme-labs/acme-1:free"]);
    expect(catalogueWindows(base)["acme-labs/acme-0"]).toEqual([]);
  });

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

  test("an id OpenRouter dropped is emptied where it is, its delisted note kept; the model is never removed", () => {
    const { doc: out } = applyOpenRouterWindows(base, {}, "2026-10-20");
    expect(Object.keys(out.models)).toEqual(Object.keys(base.models));
    expect(out.models["acme-labs/acme-1"]!.prices!.openrouter!["acme-labs/acme-1"]!.windows).toEqual([]);
    expect(out.models["acme-labs/acme-0"]!.prices!.openrouter!["acme-labs/acme-0"]).toEqual({ windows: [], delisted: "gone" });
  });

  test("a new id lands on the entry its alias names; one no entry lists is reported, never written", () => {
    const { doc: out, unlisted } = applyOpenRouterWindows(base, { "acme-1": [priced], "acme-labs/acme-9": [priced] }, "2026-10-20");
    expect(out.models["acme-labs/acme-1"]!.prices!.openrouter!["acme-1"]!.windows).toEqual([priced]);
    expect(unlisted).toEqual(["acme-labs/acme-9"]);
    expect(JSON.stringify(out)).not.toContain("acme-9");
  });

  test("a relisted id loses the note that said it never would be", () => {
    const { doc: out } = applyOpenRouterWindows(base, { "acme-labs/acme-0": [priced] }, "2026-10-20");
    expect(out.models["acme-labs/acme-0"]!.prices!.openrouter!["acme-labs/acme-0"]).toEqual({ windows: [priced] });
  });
});
