/**
 * The 3.3.5a world DB's entity ids and names, as a file the build reads.
 *
 * The wiki tooling reads nothing from the server at run time and never will
 * (CONTRACTS.md). This is a **build-time** input and the one deliberate crack
 * in that rule, approved by the operator on 2026-08-24: of the
 * 20,407 pages with no pre-cutoff revision, ~18,700 say nothing about their era
 * either way, and the only evidence that separates the ones that are in this
 * world is what they say about themselves — an id, and the name that id has.
 *
 * The **name** is not a refinement, it is what makes the rule worth having. An
 * id on its own admitted 151 rows at 0.62 precision, because a Cataclysm page
 * inherits the entry of the thing it replaced (the new Zul'Aman boss states
 * Zul'jin's) and a battle-pet page copy-pastes another page's tooltip (seven
 * unrelated pages all state `itemid=44822`). The world DB's name for the id is
 * what tells those apart from a page that is honestly about entry 1366.
 *
 * The server is used as an **existence-and-name oracle**, once, offline:
 * `infra/export-world-ids.sh` writes the four id→name maps to
 * `data/wiki/world-ids.json` and the build reads that file. So the build stays
 * a pure function of files — dump plus export — and reproducible from them, and
 * nothing the agent sees changes: it still reads wiki text and only wiki text.
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

/** The shape `infra/export-world-ids.sh` writes: id (as a JSON key) -> name. */
interface WorldIdsFile {
  source?: string;
  exported_at?: string;
  counts?: Record<string, number>;
  quest: Record<string, string>;
  creature: Record<string, string>;
  item: Record<string, string>;
  gameobject: Record<string, string>;
}

/**
 * Loaded id→name maps, plus the identity of the export they came from.
 *
 * `name` is the whole interface the admission rule needs, and it is deliberately
 * the only thing passed into `admitPage`: the rule reads an oracle, not a file
 * and not a database.
 */
export interface WorldIdIndex {
  /** The world DB's name for this id, or undefined when it has none. */
  name(kind: IdKind, id: number): string | undefined;
  /** ISO instant the export was taken, or "" when the file did not state one. */
  exportedAt: string;
  /** Rows per kind, for the bundle's `meta`: a rebuild against another export is visible. */
  counts: Record<string, number>;
}

function toMap(values: unknown, kind: string, path: string): Map<number, string> {
  if (Array.isArray(values)) {
    throw new Error(
      `${path}: "${kind}" is a bare id array — that is the id-only export, which admits a ` +
        "page whose id belongs to something else. Re-run infra/export-world-ids.sh.",
    );
  }
  if (values === null || typeof values !== "object") {
    throw new Error(`${path}: missing or malformed "${kind}" id→name map`);
  }
  const out = new Map<number, string>();
  for (const [key, value] of Object.entries(values as Record<string, unknown>)) {
    const id = Number.parseInt(key, 10);
    if (!Number.isInteger(id) || id <= 0) continue;
    if (typeof value !== "string") continue;
    out.set(id, value);
  }
  if (out.size === 0) throw new Error(`${path}: "${kind}" is empty`);
  return out;
}

/**
 * Read an export written by `infra/export-world-ids.sh`.
 *
 * Fails loudly rather than degrading: a malformed, empty or id-only export would
 * silently change which pages the bundle holds, and a build that quietly ignores
 * its own flag is worse than one that stops.
 */
export async function loadWorldIds(path: string): Promise<WorldIdIndex> {
  const raw = (await Bun.file(path).json()) as WorldIdsFile;
  const maps: Record<string, Map<number, string>> = {
    quest: toMap(raw.quest, "quest", path),
    creature: toMap(raw.creature, "creature", path),
    item: toMap(raw.item, "item", path),
    gameobject: toMap(raw.gameobject, "gameobject", path),
  };
  return {
    name(kind, id) {
      const table = KIND_TABLE[kind];
      // `spell` and `unknown` never resolve: spells live in the client's DBC
      // files, not the world DB, so an absent spell id is no evidence at all,
      // and an `unknown` id is a number whose kind the page did not state.
      if (table === undefined) return undefined;
      return maps[table]!.get(id);
    },
    exportedAt: typeof raw.exported_at === "string" ? raw.exported_at : "",
    counts: Object.fromEntries(Object.entries(maps).map(([k, m]) => [k, m.size])),
  };
}
