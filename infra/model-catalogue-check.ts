#!/usr/bin/env bun
/**
 * `bun wb data catalogue`: the model ids a published generation names that the
 * model catalogue (`infra/model-catalogue.json`) does not list.
 *
 *   bun infra/model-catalogue-check.ts [--base https://wrathbench-data.shard.page]
 *
 * Read-only: plain GETs of the manifest and the aggregates it names, the
 * reader `bun wb site verify --base` uses, and nothing written anywhere. The
 * tests hold every id in the repository's fixtures, roster examples and price
 * rows to the catalogue; this is the same question asked of what actually ran,
 * which no test can see from a bare clone. Every `model` and `resolvedModel` in
 * the runs, results, ladders and models aggregates is checked, except a
 * scripted reference run's, which names a route and not a model. Exit 1 when
 * any id is unlisted, with each id and where it appeared.
 */

import { catalogueKeyOf } from "./model-catalogue";
import { httpSource } from "./publish-accept";
import { driverEntry } from "../runner/src/drivers";

export const DEFAULT_BASE = "https://wrathbench-data.shard.page";
const AGGREGATES = ["runs.json", "results.json", "ladder-e90.json", "ladder-e360.json", "ladder-freeplay.json", "models.json", "campaigns.json"];
const MODEL_KEYS = ["model", "resolvedModel"];

/** Every model id a body names, with the aggregate it came from. Pure. */
export function modelIdsOf(body: unknown, where: string, out = new Map<string, Set<string>>()): Map<string, Set<string>> {
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) {
      for (const x of v) walk(x);
      return;
    }
    if (v === null || typeof v !== "object") return;
    const o = v as Record<string, unknown>;
    // A scripted reference run's model is its route's id, not a model.
    const route = typeof o["driver"] === "string" && driverEntry(o["driver"])?.route === true;
    for (const [k, x] of Object.entries(o)) {
      if (!route && MODEL_KEYS.includes(k) && typeof x === "string" && x.trim() !== "") {
        const seen = out.get(x) ?? new Set<string>();
        seen.add(where);
        out.set(x, seen);
      }
      walk(x);
    }
  };
  walk(body);
  return out;
}

/** The ids the catalogue does not list, sorted, each with where it appeared. Pure. */
export function uncatalogued(ids: ReadonlyMap<string, ReadonlySet<string>>): { id: string; where: string[] }[] {
  return [...ids]
    .filter(([id]) => catalogueKeyOf(id) === null)
    .map(([id, where]) => ({ id, where: [...where].sort() }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  let base = DEFAULT_BASE;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--base" && argv[i + 1] !== undefined) base = argv[++i]!;
    else throw new Error(`unknown argument ${argv[i]} (only --base URL)`);
  }
  const source = httpSource(base);
  const manifestText = await source.get("v1/manifest.json");
  if (manifestText === null) throw new Error(`${base}: no v1/manifest.json`);
  const manifest = JSON.parse(manifestText) as { artifacts?: Record<string, string> };
  const ids = new Map<string, Set<string>>();
  for (const name of AGGREGATES) {
    const key = manifest.artifacts?.[name];
    if (key === undefined) continue;
    const body = await source.get(key);
    if (body !== null) modelIdsOf(JSON.parse(body), name, ids);
  }
  const missing = uncatalogued(ids);
  if (missing.length === 0) {
    console.log(`${base}: all ${ids.size} model ids are in infra/model-catalogue.json`);
    return 0;
  }
  console.log(`${base}: ${missing.length} of ${ids.size} model ids are not in infra/model-catalogue.json:`);
  for (const m of missing) console.log(`  ${m.id}  (${m.where.join(", ")})`);
  return 1;
}

if (import.meta.main) process.exit(await main());
