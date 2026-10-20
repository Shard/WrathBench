/**
 * The scripted reference line as the ladder publishes it: per tier and
 * harness series, the level the newest finished reference run reached, and
 * nothing that names the run (operator, 2026-10-20; docs/PUBLIC-DASHBOARD.md,
 * "The scripted reference line"). A reference run is itself never published
 * ("Runs that are never published"); this is the one fact of it that is.
 *
 * A run is the reference by its driver's registry entry (`route`) or by the
 * stamp that driver leaves, either one alone, as everywhere else.
 */

import { REFERENCE_STAMP, driverEntry } from "../src/drivers";
import type { EpisodeIdView, ResultRun, ScriptedReferenceLine } from "./api-types";

export function isReferenceResult(r: Pick<ResultRun, "driver" | "unscored">): boolean {
  return driverEntry(r.driver)?.route === true || (r.unscored ?? "").startsWith(REFERENCE_STAMP);
}

/**
 * One line per tier and series: the newest started reference run that
 * finished with a level reading. A live one is still climbing, and a missing
 * reading is not recorded. Newest first, so a reader with no series chosen
 * takes the first line of its tier.
 */
export function scriptedReferenceLines(rows: readonly ResultRun[], episode: EpisodeIdView | "all"): ScriptedReferenceLine[] {
  const best = new Map<string, ResultRun>();
  for (const r of rows) {
    if (!isReferenceResult(r) || r.episode === null || (episode !== "all" && r.episode !== episode)) continue;
    if (r.terminationReason === null || r.maxLevel === null) continue;
    const key = `${r.episode} ${r.harnessSeries ?? ""}`;
    const held = best.get(key);
    if (held === undefined || (r.startedAt ?? 0) > (held.startedAt ?? 0)) best.set(key, r);
  }
  return [...best.values()]
    .sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0))
    .map((r) => ({ episode: r.episode!, series: r.harnessSeries, route: r.model, level: r.maxLevel!, xp: r.xp }));
}
