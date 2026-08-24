/**
 * The 3.3.5a world DB's entity id sets, as a file the build reads.
 *
 * The wiki tooling reads nothing from the server at run time and never will
 * (CONTRACTS.md). This is a **build-time** input and the one deliberate crack
 * in that rule, approved by the operator on 2026-08-24 (ADR-0042): of the
 * 20,407 pages with no pre-cutoff revision, ~18,700 say nothing about their era
 * either way, and most of them are quests, NPCs and items that are real in this
 * world and were simply documented late. The only evidence that separates them
 * is whether the id the page states about itself exists on this server.
 *
 * The server is used as an **existence oracle**, once, offline:
 * `infra/export-world-ids.sh` writes the id sets to `data/wiki/world-ids.json`
 * and the build reads that file. So the build stays a pure function of files —
 * dump plus export — and reproducible from them, and nothing the agent sees
 * changes: it still reads wiki text and only wiki text.
 *
 * The export is server-derived and lives under `data/`, gitignored. It never
 * enters git.
 */

import type { IdKind } from "./ids";

/** The kinds the world DB has a table for. `spell` is client DBC and has none. */
const KIND_TABLE: Partial<Record<IdKind, "quest" | "creature" | "item" | "gameobject">> = {
  quest: "quest",
  npc: "creature",
  item: "item",
  object: "gameobject",
};

/** The shape `infra/export-world-ids.sh` writes. */
interface WorldIdsFile {
  source?: string;
  exported_at?: string;
  counts?: Record<string, number>;
  quest: number[];
  creature: number[];
  item: number[];
  gameobject: number[];
}

/**
 * Loaded id sets, plus the identity of the export they came from.
 *
 * `has` is the whole interface the admission rule needs, and it is deliberately
 * the only thing passed into `admitPage`: the rule reads an oracle, not a file
 * and not a database.
 */
export interface WorldIdIndex {
  has(kind: IdKind, id: number): boolean;
  /** ISO instant the export was taken, or "" when the file did not state one. */
  exportedAt: string;
  /** Rows per kind, for the bundle's `meta`: a rebuild against another export is visible. */
  counts: Record<string, number>;
}

function toSet(values: unknown, kind: string, path: string): Set<number> {
  if (!Array.isArray(values)) {
    throw new Error(`${path}: missing or malformed "${kind}" id array`);
  }
  const out = new Set<number>();
  for (const v of values) {
    if (typeof v === "number" && Number.isInteger(v) && v > 0) out.add(v);
  }
  if (out.size === 0) throw new Error(`${path}: "${kind}" is empty`);
  return out;
}

/**
 * Read an export written by `infra/export-world-ids.sh`.
 *
 * Fails loudly rather than degrading: a malformed or empty export would silently
 * shrink the bundle back to what it was, which is exactly the failure this rule
 * exists to fix, and a build that quietly ignores its own flag is worse than one
 * that stops.
 */
export async function loadWorldIds(path: string): Promise<WorldIdIndex> {
  const raw = (await Bun.file(path).json()) as WorldIdsFile;
  const sets: Record<string, Set<number>> = {
    quest: toSet(raw.quest, "quest", path),
    creature: toSet(raw.creature, "creature", path),
    item: toSet(raw.item, "item", path),
    gameobject: toSet(raw.gameobject, "gameobject", path),
  };
  return {
    has(kind, id) {
      const table = KIND_TABLE[kind];
      // `spell` and `unknown` never match: spells live in the client's DBC
      // files, not the world DB, so an absent spell id is no evidence at all,
      // and an `unknown` id is a number whose kind the page did not state.
      if (table === undefined) return false;
      return sets[table]!.has(id);
    },
    exportedAt: typeof raw.exported_at === "string" ? raw.exported_at : "",
    counts: Object.fromEntries(Object.entries(sets).map(([k, s]) => [k, s.size])),
  };
}
