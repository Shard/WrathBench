/**
 * Freeplay lineage: which run continues which.
 *
 * A durable freeplay character is one character across attempts (docs/RUNBOOK.md,
 * "Freeplay characters are durable"), and `continuedFrom` is the only link between
 * them. Two pages read that link — the ladder collapses a chain to one row
 * (`dashboard/src/lib/ladder.ts`, `characterRows`), the runs table and the run page
 * show a run's place in its chain — so the walk lives here once rather than
 * twice. A second spelling of it is a way for the two pages to disagree about
 * what a character is.
 *
 * It lives in the viewer rather than the dashboard because the server needs it
 * too: `/api/run/<id>` aggregates a whole character (`character.ts`, `CharacterView`),
 * and the aggregation and the page's attempt strip must count the same
 * attempts. The dashboard reaches it over the `@viewer/*` alias, which is why
 * this module imports nothing — the same rule `worldmap.ts` keeps.
 *
 * The walk is written for production, not for the happy path:
 *
 * - a `continuedFrom` naming a run this set does not hold — archived, outside
 *   the shell's series filter, or dropped when the character went away
 *   (`dropContinuation`) — makes this run a root rather than dropping it;
 * - two runs claiming the same predecessor both keep it as a parent, and the
 *   later-started one is its `next` (a re-launch that lost its race). That is
 *   the same tie-break `characterRows` picks its row with, so the two cannot
 *   disagree;
 * - a cycle cannot happen, and if a malformed one ever did, the visited set
 *   ends the walk instead of the page hanging;
 * - a stillborn launch is not an attempt at the character and is cut before the
 *   walk, so no page counts one or points at one.
 *
 * Typed structurally rather than on `ResultRun`: the run page holds a `RunRow`,
 * the runs table a `ResultRun`, and the lineage is the fields both have.
 */

/**
 * The fields a lineage is derived from. Both wire shapes carry the first three;
 * `stillborn` is the listing's own annotation and absent on the run page's row,
 * which is why it is optional.
 */
export interface LineageRun {
  runId: string;
  continuedFrom: string | null;
  startedAt: number | null;
  /** A launch that produced nothing (`stillbornOf`). Not an attempt. */
  stillborn?: boolean | null;
}

export interface Lineage {
  /** The chain root's run id: the character's identity across attempts. */
  characterId: string;
  /** This run's ancestors and itself, oldest first. */
  chain: string[];
  /** This run's 1-based place in the character. */
  attempt: number;
  /** How many attempts the character has: the longest chain under this root. */
  attempts: number;
  /** The run this one continues, when the set holds it. */
  previous: string | null;
  /** The run that continues this one, when the set holds it. */
  next: string | null;
}

/**
 * Every run's ancestor chain, oldest first and ending in the run itself. A run
 * with no resolvable predecessor is a chain of one — it is its own root.
 */
export function chainsOf(runs: readonly LineageRun[]): Map<string, string[]> {
  const byId = new Map(runs.map((r) => [r.runId, r]));
  const chains = new Map<string, string[]>();
  for (const r of runs) {
    const ids: string[] = [r.runId];
    const seen = new Set<string>([r.runId]);
    let cur = r;
    for (;;) {
      const prev = cur.continuedFrom;
      if (prev === null || seen.has(prev)) break;
      const parent = byId.get(prev);
      if (parent === undefined) break;
      ids.unshift(prev);
      seen.add(prev);
      cur = parent;
    }
    chains.set(r.runId, ids);
  }
  return chains;
}

/**
 * One entry per run: where it sits in its character, and the runs either side.
 *
 * `attempts` is the length of the longest chain under the run's root — the
 * character as a whole, not the part before this run — so an attempt in the middle
 * of a chain reads "attempt 2 of 3" rather than "attempt 2 of 2".
 */
export function lineageIndex(all: readonly LineageRun[]): Map<string, Lineage> {
  /*
   * A stillborn launch is not an attempt at the character, so it is neither
   * counted nor pointed at — the same cut `characterRows` makes before it walks,
   * made here so the runs table, the run page and the ladder cannot disagree
   * about how long a character is. Such a run still *lists* on the inventory: it
   * simply gets no entry here and so no lineage line.
   */
  const runs = all.filter((r) => r.stillborn !== true);
  const byId = new Map(runs.map((r) => [r.runId, r]));
  const chains = chainsOf(runs);

  // The character's length, per root: the furthest any attempt got down the chain.
  const length = new Map<string, number>();
  for (const chain of chains.values()) {
    const root = chain[0]!;
    length.set(root, Math.max(length.get(root) ?? 0, chain.length));
  }

  // Who continues whom. A fork keeps the later start, ties broken by id so the
  // answer does not depend on the order the server happened to serve rows in.
  const next = new Map<string, LineageRun>();
  for (const r of runs) {
    const prev = r.continuedFrom;
    if (prev === null || prev === r.runId || !byId.has(prev)) continue;
    const held = next.get(prev);
    if (
      held === undefined ||
      (r.startedAt ?? -Infinity) > (held.startedAt ?? -Infinity) ||
      ((r.startedAt ?? -Infinity) === (held.startedAt ?? -Infinity) && r.runId.localeCompare(held.runId) > 0)
    ) {
      next.set(prev, r);
    }
  }

  const index = new Map<string, Lineage>();
  for (const r of runs) {
    const chain = chains.get(r.runId)!;
    const root = chain[0]!;
    index.set(r.runId, {
      characterId: root,
      chain,
      attempt: chain.length,
      attempts: length.get(root) ?? chain.length,
      previous: chain.length > 1 ? chain[chain.length - 2]! : null,
      next: next.get(r.runId)?.runId ?? null,
    });
  }
  return index;
}

/**
 * Does this run have lineage worth printing? A lone freeplay run is not a
 * character, and saying "attempt 1 of 1" about every run on the table would be
 * noise standing where a fact should be.
 */
export function hasLineage(l: Lineage | undefined): l is Lineage {
  return l !== undefined && (l.attempts > 1 || l.previous !== null || l.next !== null);
}
