/**
 * The dashboard bundle carries a subset of the model catalogue
 * (`src/lib/catalogue-subset.ts`, served by `vite.config.ts` in place of
 * `infra/model-catalogue.json`). It is derived at every build, so it cannot go
 * stale; what can go wrong is the subset dropping a field the lookup reads.
 * So the catalogue module is loaded here the way the build loads it, through
 * the app's own Vite config, and every lookup the dashboard makes is asked of
 * it and of the whole file, for every id and alias the catalogue knows and
 * for ids only a family glob claims.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { createServer, type ViteDevServer } from "vite";
import * as full from "../../infra/model-catalogue";
import { clientCatalogue } from "../src/lib/catalogue-subset";

const dashboardRoot = fileURLToPath(new URL("..", import.meta.url));
const catalogueModule = fileURLToPath(new URL("../../infra/model-catalogue.ts", import.meta.url));

let server: ViteDevServer;
let served: typeof full;

beforeAll(async () => {
  server = await createServer({
    root: dashboardRoot,
    configFile: fileURLToPath(new URL("../vite.config.ts", import.meta.url)),
    optimizeDeps: { noDiscovery: true },
    server: { middlewareMode: true },
    logLevel: "silent",
  });
  served = (await server.ssrLoadModule(catalogueModule)) as typeof full;
});

afterAll(async () => {
  await server.close();
});

/** Every id the catalogue can answer for, plus some it answers only by glob, plus nonsense. */
function ids(): string[] {
  const out = new Set<string>();
  for (const [key, entry] of Object.entries(full.CATALOGUE.models)) {
    out.add(key);
    out.add(key.toUpperCase());
    out.add(`${key}:free`);
    for (const alias of entry.aliases ?? []) out.add(alias);
  }
  for (const family of full.FAMILIES) for (const glob of family.match) out.add(glob.replaceAll("*", "unlisted-x"));
  for (const odd of ["", "  ", "nobody/knows", "?"]) out.add(odd);
  return [...out];
}

describe("the bundle's catalogue", () => {
  test("is the subset, not the file: no prices, notes, sources or providers", () => {
    expect(served.CATALOGUE).toEqual(clientCatalogue(full.CATALOGUE));
    const text = JSON.stringify(served.CATALOGUE);
    for (const gone of ["prices", "_notes", "\"source\"", "\"note\"", "openrouter"]) expect(text).not.toContain(gone);
  });

  test("answers every lookup the dashboard makes exactly as the whole file does", () => {
    // A family's `source` (where a weights verdict was checked) is the one
    // family field left behind; nothing on a page reads it.
    const fam = (f: full.CatalogueFamily | null) => (f === null ? null : { ...f, source: undefined });
    const all = ids();
    expect(all.length).toBeGreaterThan(50);
    for (const id of [...all, null, undefined]) {
      expect(fam(served.familyOf(id))).toEqual(fam(full.familyOf(id)));
      expect(served.catalogueKeyOf(id)).toBe(full.catalogueKeyOf(id));
      expect(served.weightsOf(id)).toBe(full.weightsOf(id));
      const a = served.modelOf(id);
      const b = full.modelOf(id);
      expect([a.key, a.name, a.weights, fam(a.family)]).toEqual([b.key, b.name, b.weights, fam(b.family)]);
    }
  });

  test("still says which families have a logo", () => {
    expect(served.FAMILIES.filter((f) => f.icon !== undefined).map((f) => f.id)).toEqual(
      full.FAMILIES.filter((f) => f.icon !== undefined).map((f) => f.id),
    );
  });
});
