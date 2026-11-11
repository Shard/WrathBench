/**
 * A credential's health, as the admin interface shows it (GitHub issue #427):
 * one status and the issues behind it, each a code, a short message, and when
 * it was seen. Derived, never tracked: every issue is read off state that
 * already exists — the store's row, the supervisor's published status
 * (`fleet-state.json`, `credentialStatuses` in infra/run-fleet-credentials.ts)
 * and the chart's `modelKeys` — so nothing here keeps a record of its own.
 *
 * A new kind of issue is a row in `ISSUES` and a branch in `credentialHealth`;
 * the shape a consumer reads (`CredentialIssue`) does not change.
 *
 * Operator-only. Messages may carry what the public sentences of the gate may
 * not (`until` is a reset time), and none of it reaches a public surface.
 */

/** Why the budget holds a launch on a credential, as a code (`CredentialGate.holdReasonOf`). */
export const HOLD_CODES = ["usage-spent", "usage-threshold", "spend-budget", "runs-budget"] as const;
export type HoldCode = (typeof HOLD_CODES)[number];

/** A budget's hold on one class of launch, structured: what holds it and until when, where known. */
export interface CredentialHold {
  code: HoldCode;
  until: number | null;
}

/**
 * What an issue does to the credential, and the status it gives it:
 * `disabled` — no new run starts on it (or every one that does fails);
 * `degraded` — it takes runs, but some are held or something is failing;
 * `unknown` — nobody is up to say.
 */
export type CredentialStatusLevel = "ok" | "degraded" | "disabled" | "unknown";

export const ISSUE_CODES = [
  "switched-off",
  "supervisor-down",
  "not-seen",
  "secret-missing",
  "not-deployed",
  "auth-failed",
  "quota-exhausted",
  "usage-spent",
  "usage-threshold",
  "spend-budget",
  "runs-budget",
  "budget-held",
] as const;
export type CredentialIssueCode = (typeof ISSUE_CODES)[number];

/** Each code's effect and where it comes from (the source is for the docs and the tooltip). */
export const ISSUES: Readonly<Record<CredentialIssueCode, { level: Exclude<CredentialStatusLevel, "ok">; source: string }>> = {
  "switched-off": { level: "disabled", source: "the store: enabled is false" },
  "supervisor-down": { level: "unknown", source: "fleet-state.json: no heartbeat in three ticks" },
  "not-seen": { level: "unknown", source: "fleet-state.json: written or renamed since the supervisor's last tick" },
  "secret-missing": { level: "disabled", source: "fleet-state.json: the supervisor's environment lacks the variable (a Codex home: or its directory)" },
  "not-deployed": { level: "disabled", source: "WRATHBENCH_MODEL_KEYS: the chart does not hand the variable to the model pods" },
  "auth-failed": { level: "disabled", source: "a run on it paused auth-failed and is still paused" },
  "quota-exhausted": { level: "degraded", source: "a run on it paused quota-exhausted and is still paused" },
  "usage-spent": { level: "disabled", source: "the budget: a usage window at 100% holds every launch" },
  "usage-threshold": { level: "degraded", source: "the budget: a usage window at or over a threshold holds that class" },
  "spend-budget": { level: "disabled", source: "the budget: today's spend has reached its limit" },
  "runs-budget": { level: "disabled", source: "the budget: today's runs have reached its limit" },
  "budget-held": { level: "degraded", source: "the budget, as a supervisor that publishes no hold codes words it" },
};

/** One thing wrong with a credential. Times are epoch ms; null where the state does not say. */
export interface CredentialIssue {
  code: CredentialIssueCode;
  level: Exclude<CredentialStatusLevel, "ok">;
  /** A short reason, fit for a status cell. */
  message: string;
  /** When it began, where known. */
  since: number | null;
  /** When it was last seen to hold. */
  lastSeen: number | null;
  /** When it clears by itself, where known (a budget's reset). */
  until: number | null;
}

export interface CredentialHealth {
  status: CredentialStatusLevel;
  issues: CredentialIssue[];
}

/** The slice of the supervisor's per-credential status this reads (`CredentialStatus`). */
export interface SupervisorCredentialView {
  secretSet: boolean;
  held: { scored?: string; freeplay?: string };
  holds?: { scored?: CredentialHold; freeplay?: CredentialHold };
  lastError: { reason: string; at: number } | null;
}

const RANK: Record<CredentialStatusLevel, number> = { ok: 0, unknown: 1, degraded: 2, disabled: 3 };

/** The worst of the issues' levels, `ok` with none. */
export function worstLevel(issues: readonly Pick<CredentialIssue, "level">[]): CredentialStatusLevel {
  let s: CredentialStatusLevel = "ok";
  for (const i of issues) if (RANK[i.level] > RANK[s]) s = i.level;
  return s;
}

function issue(code: CredentialIssueCode, message: string, t: Partial<Pick<CredentialIssue, "since" | "lastSeen" | "until">> = {}): CredentialIssue {
  return { code, level: ISSUES[code].level, message, since: t.since ?? null, lastSeen: t.lastSeen ?? null, until: t.until ?? null };
}

const HOLD_MESSAGE: Record<HoldCode, string> = {
  "usage-spent": "a usage window is spent",
  "usage-threshold": "usage at its threshold",
  "spend-budget": "today's spend budget is used",
  "runs-budget": "today's runs are used",
};

/**
 * One credential's health. `supervisor` is the supervisor's word on this
 * credential, already joined by id and checked to be about the same variable,
 * or undefined when it has none to give (`up` false: nobody is up; `up` true:
 * it has not read this row yet).
 */
export function credentialHealth(o: {
  enabled: boolean;
  secretEnv: string;
  /** What the variable holds: a Codex home's is a directory's path. */
  holds: "token" | "home" | "key";
  up: boolean;
  heartbeatAt: number | null;
  supervisor: SupervisorCredentialView | undefined;
  /** Whether the chart hands the variable to the model pods; null when the viewer was not told. */
  deployed: boolean | null;
}): CredentialHealth {
  const issues: CredentialIssue[] = [];
  const seen = { lastSeen: o.heartbeatAt };
  if (!o.enabled) issues.push(issue("switched-off", "switched off"));
  if (o.deployed === false) issues.push(issue("not-deployed", `${o.secretEnv} not in the chart's modelKeys`));
  const s = o.supervisor;
  if (!o.up) issues.push(issue("supervisor-down", "no supervisor up", seen));
  else if (s === undefined) issues.push(issue("not-seen", "not yet read by the supervisor", seen));
  else {
    if (!s.secretSet) issues.push(issue("secret-missing", o.holds === "home" ? `${o.secretEnv} not set, or no such directory` : `${o.secretEnv} not set`, seen));
    if (s.lastError !== null && (s.lastError.reason === "auth-failed" || s.lastError.reason === "quota-exhausted")) {
      issues.push(issue(s.lastError.reason, s.lastError.reason === "auth-failed" ? "auth failed on a run" : "quota exhausted on a run", { lastSeen: s.lastError.at }));
    }
    // One issue per hold code, naming the classes it holds: spend and runs hold both alike.
    const byCode = new Map<HoldCode | "budget-held", { classes: string[]; until: number | null }>();
    for (const cls of ["scored", "freeplay"] as const) {
      if (s.held[cls] === undefined) continue;
      const h = s.holds?.[cls];
      const code = h?.code ?? "budget-held";
      const at = byCode.get(code) ?? { classes: [], until: null };
      at.classes.push(cls);
      if (h?.until != null) at.until = Math.max(at.until ?? 0, h.until);
      byCode.set(code, at);
    }
    for (const [code, h] of byCode) {
      const what = code === "budget-held" ? "held by its budget" : HOLD_MESSAGE[code];
      const classes = code === "usage-threshold" || code === "budget-held" ? ` (${h.classes.join(", ")})` : "";
      issues.push(issue(code, `${what}${classes}`, { ...seen, until: h.until }));
    }
  }
  return { status: worstLevel(issues), issues };
}
