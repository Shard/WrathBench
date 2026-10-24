/**
 * The model catalogue as the dashboard bundle carries it: what the lookup in
 * `infra/model-catalogue.ts` reads, and nothing else. That is the families,
 * and each model's family, name, weights and aliases. Prices, notes, sources
 * and providers stay out: they were most of the bytes, and no page reads them
 * through the catalogue (a run's cost arrives already computed, from the
 * viewer).
 *
 * `vite.config.ts` serves this in place of `infra/model-catalogue.json`
 * whenever the app imports it, so it is derived at every build and has nothing
 * to drift from. `test/catalogue-subset.test.ts` holds that every lookup
 * answers the same over it as over the whole file. Build-time only: nothing in
 * `src` imports it, and it imports only types.
 */

import type { CatalogueFamily, CatalogueModel, ModelCatalogue } from "../../../infra/model-catalogue.ts";

export function clientCatalogue(cat: ModelCatalogue): ModelCatalogue {
  const families = cat.families.map(({ id, name, company, icon, match, weights }): CatalogueFamily => ({
    id,
    name,
    company,
    match,
    ...(icon !== undefined ? { icon } : {}),
    ...(weights !== undefined ? { weights } : {}),
  }));
  const models: Record<string, CatalogueModel> = {};
  for (const [key, { family, name, weights, aliases }] of Object.entries(cat.models)) {
    models[key] = { family, name, ...(weights !== undefined ? { weights } : {}), ...(aliases !== undefined ? { aliases } : {}) };
  }
  return { version: cat.version, icons: cat.icons, providers: {}, families, models };
}
