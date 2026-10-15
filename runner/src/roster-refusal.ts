/**
 * Why the fleet refuses a whole roster entry: one verdict, read by the
 * supervisor's parser (`parseFleet`, which keeps the entry in the catalog and
 * schedules nothing under it) and by the viewer's campaign squares
 * (`readFleetRoster`, which parks that entry's squares as refused rather than
 * owed). Two copies of the rule were how the page came to agree with the
 * scheduler on provider-key refusals and on nothing else.
 *
 * Pure: the entry as the document holds it, the policy's subscriptions, and the
 * deploy-time env the provider table reads its self-hosted hosts from.
 */

import { rosterKeyRefusal } from "./providers";

/**
 * The keys a ROSTER ENTRY may carry, and the keys a QUEUE JOB may carry.
 *
 * An entry is a catalog card and a job is a scheduling instruction; anything
 * else on either of them is a key the harness does not read. It used to be
 * dropped in silence, which is how `"enabled": false` sat on a roster entry
 * for a day while the character it was meant to pause kept running (2026-08-30).
 * A key outside these sets now REFUSES that entry or job by name — scheduling
 * only, never a drain — so the operator's edit either takes effect or says why
 * it did not. Whole-file rejection stays for shape errors, and the retired
 * spellings (`tiers`, `runsPerEpisode`, `objective`, `character`, ...) keep
 * their own `fail()`s ahead of this check: they meant something specific, and
 * naming them is worth taking the file down for.
 */
export const ROSTER_ENTRY_KEYS = [
  "model", "tier", "idle", "driver", "effort", "apiBase", "apiKeyEnv",
  "billing", "subscription", "race", "class", "watchdogs", "maxToolCalls",
  "routing", "wiki", "compactWindow",
] as const;

export const QUEUE_JOB_KEYS = ["ref", "episode", "repeat", "enabled", "account", "subscription"] as const;

/**
 * The nearest valid alternative, where there is an obvious one. Both entries
 * are keys that LOOK like they would work and quietly would not: `enabled` is
 * the queue job's word, not the entry's, and `tokenEnv` is the runner-side
 * spelling of a lane that an entry states as `subscription`.
 */
const ROSTER_KEY_HINTS: Record<string, string> = {
  enabled: 'roster entries have no `enabled`; to pause a character set `idle: "none"`; to stop scheduling set tier/idle accordingly',
  tokenEnv: "use `subscription`, the NAME of the env var holding the token",
};

/** The keys of `entry` that are outside `allowed`, in the file's own order. */
export function unknownKeysOf(entry: object, allowed: readonly string[]): string[] {
  return Object.keys(entry).filter((k) => !allowed.includes(k));
}

/** The refusal text for an entry or job carrying keys the harness does not read. */
export function strictKeyWhy(kind: "roster entry" | "queue job", keys: readonly string[], allowed: readonly string[]): string {
  const named = keys.map((k) => `\`${k}\``).join(", ");
  const hint = kind === "roster entry" ? keys.map((k) => ROSTER_KEY_HINTS[k]).find((h) => h !== undefined) : undefined;
  return (
    `unknown key ${named} on a ${kind} — ` +
    (hint ?? `not a ${kind === "roster entry" ? "roster-entry" : "queue-job"} key`) +
    ` (valid keys: ${allowed.join(", ")})`
  );
}

/** Which rule refused an entry. The parser acts on one of them (`subscription`). */
export type RosterRefusalKind = "unknown-key" | "provider-key" | "subscription";

export interface RosterEntryRefusal {
  kind: RosterRefusalKind;
  /**
   * The operator's line. It can name a key, a host or a subscription's env
   * var, so it goes to `--status` and the supervisor log, never to a page:
   * the campaign squares say only that the entry is refused
   * (`campaignPairRefusals`).
   */
  why: string;
}

/**
 * Why the fleet refuses this roster entry, or null when it does not. The first
 * rule that applies, in this order, since one refusal line per entry is
 * enough to take it out of scheduling:
 *
 * - **a key the harness does not read** (`ROSTER_ENTRY_KEYS`);
 * - **a provider key towards a host its provider does not own**
 *   (`rosterKeyRefusal`, runner/src/providers.ts);
 * - **a subscription the policy does not list** (`policy.subscriptions`).
 *
 * Each is a refusal of the ENTRY, not the file: the rest of the roster stays in
 * effect, and a rejected re-read would make every other flag in the file inert.
 */
export function rosterEntryRefusal(
  e: { driver?: unknown; apiBase?: unknown; apiKeyEnv?: unknown; subscription?: unknown },
  subscriptions: readonly string[],
  env: Record<string, string | undefined> = process.env,
): RosterEntryRefusal | null {
  const keys = unknownKeysOf(e, ROSTER_ENTRY_KEYS);
  if (keys.length > 0) return { kind: "unknown-key", why: strictKeyWhy("roster entry", keys, ROSTER_ENTRY_KEYS) };
  const key = rosterKeyRefusal(e, env);
  if (key !== null) return { kind: "provider-key", why: key };
  if (e.subscription !== undefined && !subscriptions.includes(e.subscription as string)) {
    return {
      kind: "subscription",
      why: `subscription ${String(e.subscription)} is not in policy.subscriptions (${subscriptions.join(", ")})`,
    };
  }
  return null;
}
