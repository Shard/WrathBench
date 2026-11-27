/**
 * A roster entry's identity as every reader of the roster shares it: the tier
 * and idle names an entry may carry (`TIER_TABLE` in `models.ts` says what
 * each buys), why a roster name is outside the policy, and which runs an
 * entry's compaction window owns. Split out of `models.ts` (which re-exports
 * all of it unchanged) so a reader that only names a run's roster row — the
 * viewer's run page — does not load the scheduler.
 */

import { AUTO_COMPACT_WINDOW } from "./config";
import { defaultCompactWindowOf } from "./drivers";
import type { ServingSpec } from "./serving";

export const TIERS = ["t0", "t1", "t2", "t3"] as const;
export type Tier = (typeof TIERS)[number];

export const IDLE_MODES = ["none", "unlimited"] as const;
export type IdleMode = (typeof IDLE_MODES)[number];

/**
 * A job as the membership predicate needs it: which roster names it holds, and
 * the account it is pinned to when it is pinned to one.
 *
 * Deliberately structural. The supervisor's `FleetJob` carries a spawn's worth
 * of fields and lives beside the process path; the viewer parses a narrow
 * slice of the same file at its own boundary. Both can satisfy this, so the
 * question "is this roster name the policy's to schedule" has one answer
 * rather than one per reader.
 */
export interface PolicyJob {
  refs: readonly string[];
  /** Set: the job is pinned to this account. Absent: it takes a pool account. */
  account?: string | undefined;
  /** The job's name, for the exclusion sentence. */
  name?: string | undefined;
}

/**
 * A roster as the two predicates below need it: the NAMES, and nothing else.
 *
 * It used to need each entry's `objective`, because an entry carrying one was
 * outside the policy. A catalog entry cannot carry one any more, so nothing
 * about an entry excludes it — only a pinned job holding its
 * account does, and that is a property of the queue.
 */
export type PolicyRoster = Readonly<Record<string, unknown>>;

/** Roster names a pinned job references: never the policy's to schedule. */
export function pinnedRefs(jobs: readonly PolicyJob[]): Set<string> {
  return new Set(jobs.filter((j) => j.account !== undefined).flatMap((j) => [...j.refs]));
}

/**
 * The roster names the policy may schedule: every name not referenced by a
 * pinned job, whose account is spoken for.
 *
 * It used to also exclude an entry carrying an objective. An entry cannot
 * carry one any more — steering is a campaign, which BORROWS a catalog
 * entry rather than taking it out of the schedule — so that clause described a
 * state the parser now refuses.
 */
export function policyRefs(
  jobs: readonly PolicyJob[],
  roster: PolicyRoster,
): Set<string> {
  const pinned = pinnedRefs(jobs);
  return new Set(Object.keys(roster).filter((n) => !pinned.has(n) && refusalOf(roster, n) === undefined));
}

/** A per-entry refusal the parser recorded, if any (`FleetRosterEntry.refused`). */
function refusalOf(roster: PolicyRoster, name: string): string | undefined {
  const e = roster[name] as { refused?: unknown } | undefined;
  return typeof e?.refused === "string" ? e.refused : undefined;
}

/** Why a roster name is outside the policy, or undefined when it is inside. */
export function policyExclusion(
  jobs: readonly PolicyJob[],
  roster: PolicyRoster,
  name: string,
): string | undefined {
  const job = jobs.find((j) => j.account !== undefined && j.refs.includes(name));
  if (job !== undefined) return `pinned to ${job.account} by job ${job.name ?? job.refs.join("+")}`;
  // An entry the parser refused: it stays in the catalog (so a job naming it is
  // gated rather than taking the whole file down) and is scheduled by nothing.
  return refusalOf(roster, name);
}

/** What a run and a roster entry must share for the run to be that entry's. */
export interface RosterIdentity {
  model: string | null;
  /**
   * An entry's providers (`provider-options.ts`): a run of any one of them is
   * the entry's. Absent on a run, and on a single-provider entry.
   */
  providers?: readonly { model?: string | undefined }[] | undefined;
  effort?: string | null | undefined;
  compactWindow?: string | null | undefined;
  /** The driver a run or entry names (absent: the default driver); read for `probeOnly` and the default window. */
  driver?: string | null | undefined;
  /** The harness tag, where a projection keeps that and not the driver; read for the same two facts. */
  harness?: string | null | undefined;
  /**
   * A local build (`serving.ts`). On an entry, absent is a hosted model. On a
   * run, null is "stated none" and absent is "this caller does not know",
   * which matches either way: a run fact always knows (`RunFact.serving`).
   */
  serving?: ServingSpec | null | undefined;
}

/**
 * Whether an entry's declared window owns a run stamped with `runWindow`
 * (null: the CLI's own `auto`, which is every run that recorded none).
 *
 * - A stated window owns exactly its runs, so a 100k copy of an entry owns
 *   its own.
 * - `"auto"`, stated on a driver that defaults a window, owns the `auto` runs
 *   and no others.
 * - No window owns the runs launched at the driver's default, whatever the
 *   default was when they launched: the `auto` runs, and on claude-code the
 *   300k runs since that became its default (operator, 2026-11-10). The entry
 *   did not change, so its earlier runs stay its own: its targets stay met,
 *   its paused run is still its to resume, its freeplay character continues.
 *   Nothing pools for that, since results group on the run's tuple, where
 *   `auto` and 300k stay two rows. A later change of a driver's default must
 *   keep the earlier one owned here.
 */
export function entryOwnsWindow(entry: Pick<RosterIdentity, "compactWindow" | "driver" | "harness">, runWindow: string | null | undefined): boolean {
  const declared = entry.compactWindow ?? null;
  const stamped = runWindow ?? null;
  if (declared === AUTO_COMPACT_WINDOW) return stamped === null;
  if (declared !== null) return stamped === declared;
  return stamped === null || stamped === defaultCompactWindowOf(entry);
}

/**
 * The windows `entryOwnsWindow` gives an entry, in a reader's spelling
 * (`"auto"` for the CLI's own): what a page filters an entry's runs by.
 */
export function ownedWindows(entry: Pick<RosterIdentity, "compactWindow" | "driver" | "harness">): string[] {
  const declared = entry.compactWindow ?? null;
  if (declared !== null) return [declared];
  const dflt = defaultCompactWindowOf(entry);
  return dflt === undefined ? [AUTO_COMPACT_WINDOW] : [AUTO_COMPACT_WINDOW, dflt];
}

/**
 * A run's window as a key that is one per roster entry: `""` for the CLI's
 * `auto` and for the default of the run's driver, which an entry with no
 * window owns alike (`entryOwnsWindow`); any other window as stamped. For the
 * places that group runs by model without an entry in hand.
 */
export function rosterWindowKey(run: Pick<RosterIdentity, "compactWindow" | "driver" | "harness">): string {
  const stamped = run.compactWindow ?? null;
  return stamped === null || stamped === defaultCompactWindowOf(run) ? "" : stamped;
}
