/**
 * A credential's health, as the supervisor publishes it beside the rest of its
 * status (`CredentialStatus`, infra/run-fleet-credentials.ts) and the admin
 * interface shows it (GitHub issue #427): one state, a line saying why, when
 * it began and what the provider last answered; its usage windows as meters;
 * and the fix, as the control or the instruction the page renders.
 *
 * Derived, never tracked: every input is state that already exists — the
 * store's switch, whether the supervisor's environment has the variable, the
 * budget's holds (`CredentialGate.holdReasonOf`), the newest paused run that
 * indicts the credential (`lastError`), the newest usage reading, and the
 * provider's last read of the credential where a reader makes one
 * (`CredentialRead`: OpenCode Go's usage endpoint today).
 *
 * Operator-only. `reason` and `fix.text` may carry what the gate's public
 * sentences may not, and none of it reaches a public surface.
 */

import { EXHAUSTED_PCT, type SubscriptionUsage } from "./subscription-usage";

/**
 * Why a launch on a credential is held, as a code (`CredentialGate.holdReasonOf`):
 * its budget's (the first four), or the provider's last read of its key
 * (`CredentialRead`: refused, no access to usage, billed past the allowance).
 */
export const HOLD_CODES = ["usage-spent", "usage-threshold", "spend-budget", "runs-budget", "auth-failed", "no-access", "overage"] as const;
export type HoldCode = (typeof HOLD_CODES)[number];

/**
 * What holds a paused run's resume when its credential does: a budget's code,
 * or `credential-off`, the credential it recorded gone from the config or
 * disabled (a resume comes back only on it). One vocabulary for the
 * supervisor's paused listing and the public phrase it maps to
 * (`FleetPausedView.hold`).
 */
export type ResumeHoldCode = HoldCode | "credential-off";

/** A budget's hold on one class of launch, structured. `code` is null from a supervisor that worded it only. */
export interface CredentialHold {
  code: HoldCode | null;
  until: number | null;
}

/**
 * The states, in precedence order: the first that applies is the state.
 * `disabled` is the operator's switch; every other one is observed and clears
 * by itself when the observation changes.
 */
export const HEALTH_STATES = ["disabled", "secret-missing", "auth-failed", "no-access", "overage", "quota-spent", "held", "unread", "ok"] as const;
export type HealthState = (typeof HEALTH_STATES)[number];

/**
 * The provider's last read of a credential (OpenCode Go: its usage GET), as
 * the reader classifies it. The meeting point between a reader and the
 * status: a reader keeps one per credential (`GoUsagePoller.lastRead`,
 * collected by `FleetGoUsage.lastReads()`), and `credentialStatuses` passes it
 * here. Never carries the key or a response body.
 *
 * - `ok`: answered, windows read;
 * - `auth-failed`: the key was refused (401);
 * - `no-access`: the key may not read usage, or the workspace has no plan (403);
 * - `spent`: the provider says an allowance is spent;
 * - `overage`: the provider is billing the balance, past the allowance;
 * - `unread`: no answer (timeout, 5xx, a shape the reader does not know).
 */
export interface CredentialRead {
  at: number;
  http: number | null;
  /** The provider's error code (`api_key_expired`) or the failure's name (`TimeoutError`). */
  code?: string;
  classification: "ok" | "auth-failed" | "no-access" | "spent" | "overage" | "unread";
  /** When this classification began, where the reader knows; else the state's `since` is null. */
  since?: number;
}

export interface CredentialHealth {
  state: HealthState;
  /** One operator line, never a secret. */
  reason: string;
  /** When this state began, where the inputs say. */
  since: number | null;
  /** The provider's newest read of it, whatever the state. */
  lastCheck: { at: number; http: number | null; code?: string } | null;
}

/** One usage window, as a meter. */
export interface CredentialWindow {
  /** `5h`, `week` or `month` by its length; another length as hours or days. */
  name: string;
  /** The model family a per-model window binds, when it binds one. */
  family?: string;
  usedPercent: number;
  resetsAt: number | null;
  /** Spent: it holds every launch until it resets. */
  limited: boolean;
}

export const FIX_KINDS = ["replace-secret", "set-secret", "enable", "wait-reset", "raise-budget"] as const;
export type FixKind = (typeof FIX_KINDS)[number];

/** What makes it well again. A secret-writing fix is the admin page's set key or re-auth. */
export interface CredentialFix {
  kind: FixKind;
  secretEnv?: string;
  until?: number;
  text: string;
}

/** What `credentialHealth` reads. */
export interface HealthInput {
  enabled: boolean;
  secretEnv: string;
  /** What the variable holds: a Codex home's is a directory's path. */
  holds: "token" | "home" | "key";
  /** Whether the variable is set: a secret in the config store, else the supervisor's environment. */
  secretSet: boolean;
  /**
   * Whether the config store holds its secret (`runner/src/store-secrets.ts`).
   * A stored secret reaches every launch from the store, so the chart's
   * `modelKeys` no longer decides whether a model's process gets it.
   */
  stored?: boolean;
  /** Why a stored secret does not open (another key, changed bytes): the variable is then unset, never the environment's. */
  storedUnreadable?: string | null;
  /** Whether the chart hands the variable to the model pods; null or absent when not known. */
  deployed?: boolean | null;
  holdsOf: { scored?: CredentialHold; freeplay?: CredentialHold };
  lastError: { reason: string; at: number } | null;
  read?: CredentialRead | null;
}

const NEW_SECRET: Record<HealthInput["holds"], string> = { token: "a new token", key: "a new key", home: "a fresh login in the Codex home" };

/** The state, its line and its fix: the first state in `HEALTH_STATES` that applies. */
export function credentialHealth(i: HealthInput): { health: CredentialHealth; fix: CredentialFix | null } {
  const read = i.read ?? null;
  const lastCheck = read === null ? null : { at: read.at, http: read.http, ...(read.code !== undefined ? { code: read.code } : {}) };
  const out = (state: HealthState, reason: string, since: number | null, fix: CredentialFix | null) => ({ health: { state, reason, since, lastCheck }, fix });
  const http = (r: CredentialRead): string => [r.http !== null ? `HTTP ${r.http}` : null, r.code ?? null].filter((x) => x !== null).join(" ");
  const env = i.secretEnv;

  if (!i.enabled) return out("disabled", "switched off", null, { kind: "enable", text: "enable it" });
  if (i.storedUnreadable != null) return out("secret-missing", i.storedUnreadable, null, { kind: "replace-secret", secretEnv: env, text: `set ${env} again, or clear it` });
  if (i.deployed === false && i.stored !== true) {
    return out("secret-missing", `${env} not in the chart's modelKeys`, null, { kind: "set-secret", secretEnv: env, text: `set ${env} here, or add it to the chart's modelKeys` });
  }
  if (!i.secretSet) {
    return out("secret-missing", i.holds === "home" ? `${env} not set, or no such directory` : `${env} not set`, null, { kind: "set-secret", secretEnv: env, text: `set ${env}` });
  }
  const replace: CredentialFix = { kind: "replace-secret", secretEnv: env, text: `${NEW_SECRET[i.holds]} in ${env}` };
  if (read?.classification === "auth-failed") return out("auth-failed", `key rejected: ${http(read)}`, read.since ?? null, replace);
  if (i.lastError?.reason === "auth-failed") return out("auth-failed", "a run paused: auth failed", i.lastError.at, replace);
  if (read?.classification === "no-access") {
    return out("no-access", `usage not readable: ${http(read)}`, read.since ?? null, { kind: "replace-secret", secretEnv: env, text: `a key that may read usage in ${env}` });
  }
  const holds = [i.holdsOf.scored, i.holdsOf.freeplay].filter((h): h is CredentialHold => h !== undefined);
  const latest = (hs: readonly CredentialHold[]): number | undefined => {
    const t = hs.map((h) => h.until).filter((u): u is number => u !== null);
    return t.length === 0 ? undefined : Math.max(...t);
  };
  const wait = (until: number | undefined): CredentialFix => ({ kind: "wait-reset", ...(until !== undefined ? { until } : {}), text: "wait for the reset" });
  // Ahead of a spent window: billing the balance spends money, and a run that
  // saw it also marks its allowance spent, which would otherwise hide it.
  if (read?.classification === "overage") return out("overage", "billing the balance past the allowance", read.since ?? null, wait(undefined));
  const spent = holds.filter((h) => h.code === "usage-spent");
  if (spent.length > 0) return out("quota-spent", "a usage window is spent", null, wait(latest(spent)));
  if (read?.classification === "spent") return out("quota-spent", "usage spent, as the provider reports", read.since ?? null, wait(undefined));
  if (i.lastError?.reason === "quota-exhausted") return out("quota-spent", "a run paused: quota exhausted", i.lastError.at, wait(undefined));
  if (holds.length > 0) {
    const classes = (["scored", "freeplay"] as const).filter((c) => i.holdsOf[c] !== undefined);
    const code = holds.find((h) => h.code !== null)?.code ?? null;
    const what =
      code === "spend-budget"
        ? "today's spend budget is used"
        : code === "runs-budget"
          ? "today's runs are used"
          : code === "usage-threshold"
            ? "usage at its threshold"
            : code === "auth-failed"
              ? "its key was refused"
              : code === "no-access"
                ? "its usage is not readable"
                : code === "overage"
                  ? "billed past its allowance"
                  : "held by its budget";
    const perDay = code === "spend-budget" || code === "runs-budget";
    const until = latest(holds);
    return out("held", `${what}${perDay ? "" : ` (${classes.join(", ")})`}`, null, {
      kind: "raise-budget",
      ...(until !== undefined ? { until } : {}),
      text: perDay ? "raise its budget, or wait for 00:00 UTC" : "raise its threshold, or wait for the reset",
    });
  }
  if (read?.classification === "unread") return out("unread", `usage not read${http(read) !== "" ? `: ${http(read)}` : ""}`, read.since ?? null, null);
  return out("ok", "", null, null);
}

/** A window's name by its length: the three a plan states, else hours or days. */
export function windowName(minutes: number | null): string {
  if (minutes === null) return "window";
  if (minutes === 300) return "5h";
  if (minutes === 7 * 1440) return "week";
  if (minutes >= 28 * 1440 && minutes <= 31 * 1440) return "month";
  return minutes % 1440 === 0 ? `${minutes / 1440}d` : `${Math.round(minutes / 60)}h`;
}

/**
 * The newest reading's windows still in force, as meters; null with no
 * reading. The reset is the window's own (or its length from the reading),
 * not capped at the seven days a pause waits at most: a month's meter says
 * when the month resets.
 */
export function credentialWindows(u: SubscriptionUsage | undefined, now: number): CredentialWindow[] | null {
  if (u === undefined) return null;
  return u.windows.flatMap((w): CredentialWindow[] => {
    const resetsAt = w.resetsAt ?? (w.windowMinutes !== null ? u.observedAt + w.windowMinutes * 60_000 : null);
    if (resetsAt !== null && resetsAt <= now) return [];
    return [{ name: windowName(w.windowMinutes), ...(w.family !== undefined ? { family: w.family } : {}), usedPercent: w.usedPercent, resetsAt, limited: w.usedPercent >= EXHAUSTED_PCT }];
  });
}
