/**
 * Why the fleet refuses a whole roster entry: one verdict, read by the
 * supervisor's parser (`parseFleet`, which keeps the entry in the catalog and
 * schedules nothing under it) and by the viewer's campaign squares
 * (`readFleetRoster`, which parks that entry's squares as refused rather than
 * owed). Two copies of the rule were how the page came to agree with the
 * scheduler on provider-key refusals and on nothing else.
 *
 * Pure: the entry as the document holds it, the configured credentials, and
 * the deploy-time env the provider table reads its self-hosted hosts from.
 */

import { credentialCandidates, rosterProviderRefusal, type Credential } from "./credential-slots";

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
  "model", "tier", "idle", "driver", "effort", "apiBase",
  "billing", "credential", "race", "class", "watchdogs", "maxToolCalls",
  "routing", "wiki", "compactWindow", "campaignOnly",
] as const;

export const QUEUE_JOB_KEYS = ["ref", "episode", "repeat", "enabled", "account", "credential"] as const;

/**
 * The nearest valid alternative, where there is an obvious one. Each is a key
 * that LOOKS like it would work and quietly would not: `enabled` is the queue
 * job's word, not the entry's, and a key or a subscription is a credential's
 * (`credentials/<id>`), which an entry may only pin.
 */
const ROSTER_KEY_HINTS: Record<string, string> = {
  enabled: 'roster entries have no `enabled`; to pause a character set `idle: "none"`; to stop scheduling set tier/idle accordingly',
  apiKeyEnv: "a key is a credential's (credentials/<id>.secretEnv); pin one with `credential`",
  subscription: "a subscription is a credential (credentials/<id>); pin one with `credential`",
  tokenEnv: "a subscription is a credential (credentials/<id>); pin one with `credential`",
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

/** Which rule refused an entry. The parser acts on one of them (`credential`). */
export type RosterRefusalKind = "unknown-key" | "provider" | "credential";

export interface RosterEntryRefusal {
  kind: RosterRefusalKind;
  /**
   * The operator's line. It can name a key, a host or a credential, so it goes
   * to `--status` and the supervisor log, never to a page:
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
 * - **a base no credential provider serves**, or one its provider's key may
 *   not go to (`rosterProviderRefusal`, runner/src/credential-slots.ts);
 * - **a pinned credential that cannot carry it** — not configured, another
 *   provider's, the other billing side (`credentialCandidates`). A pinned
 *   credential that is merely disabled is no refusal: the entry waits for it.
 *
 * Each is a refusal of the ENTRY, not the file: the rest of the roster stays in
 * effect, and a rejected re-read would make every other flag in the file inert.
 */
export function rosterEntryRefusal(
  e: { model?: unknown; driver?: unknown; apiBase?: unknown; billing?: unknown; credential?: unknown },
  credentials: readonly Credential[],
  env: Record<string, string | undefined> = process.env,
): RosterEntryRefusal | null {
  const keys = unknownKeysOf(e, ROSTER_ENTRY_KEYS);
  if (keys.length > 0) return { kind: "unknown-key", why: strictKeyWhy("roster entry", keys, ROSTER_ENTRY_KEYS) };
  const provider = rosterProviderRefusal(e, env);
  if (provider !== null) return { kind: "provider", why: provider };
  if (e.credential !== undefined) {
    const fit = credentialCandidates(
      credentials.map((c) => ({ ...c, enabled: true })),
      {
        model: typeof e.model === "string" ? e.model : "",
        driver: typeof e.driver === "string" ? e.driver : undefined,
        apiBase: typeof e.apiBase === "string" ? e.apiBase : undefined,
        billing: e.billing === "free" || e.billing === "paid" ? e.billing : undefined,
      },
      { pin: String(e.credential), env },
    );
    if (fit.why !== undefined) return { kind: "credential", why: fit.why };
  }
  return null;
}
