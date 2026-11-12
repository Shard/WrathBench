/**
 * The admin pages' pure half (GitHub issue #427): what each section reads out
 * of the config document and what each of its forms writes. Every write is a
 * config-store row through `/api/config`, which runs the whole candidate
 * config through `parseFleet`, so nothing here validates beyond the shape a
 * form needs to send something at all: a refusal is the parser's sentence.
 */

import type { Groups } from "@viewer/groups";
import type { AdminCodexLoginView, AdminCredentialView, AdminProviderView, CredentialFix, CredentialHealth, HealthState } from "@viewer/api-types";

/** A credential row as the store holds it (`runner/src/credential-slots.ts`). */
export interface CredentialDoc {
  provider?: unknown;
  secretEnv?: unknown;
  slots?: unknown;
  budget?: unknown;
  billing?: unknown;
  enabled?: unknown;
}

/** A budget's kind on the form; `none` writes no budget, which is the provider's default. */
export type BudgetKind = "none" | "usage" | "spend" | "runs";

export interface NewCredentialForm {
  id: string;
  provider: string;
  secretEnv: string;
  slots: string;
  billing: "paid" | "free";
  budget: BudgetKind;
  /** The budget's number: the scored usage percentage, dollars a day, or runs a day. */
  limit: string;
  /** A usage budget's freeplay percentage; empty is the same as `limit`. */
  freeplayLimit: string;
}

export const EMPTY_CREDENTIAL: NewCredentialForm = { id: "", provider: "", secretEnv: "", slots: "1", billing: "paid", budget: "none", limit: "", freeplayLimit: "" };

/**
 * A form as the row it writes, or the sentence that says what is missing. The
 * whole row, so an edit is a PUT: a PATCH merges shallowly and could not take
 * a budget away. `enabled` is the row's own on an edit; a new row is written
 * disabled, so the operator turns it on once it reads right.
 */
export function credentialDoc(f: NewCredentialForm, opts: { enabled?: boolean } = {}): { key: string; body: Record<string, unknown> } | string {
  const id = f.id.trim();
  if (id === "") return "a credential needs an id";
  if (f.provider === "") return "pick a provider";
  if (f.secretEnv.trim() === "") return "name the env var its secret is in";
  const slots = Number(f.slots);
  if (f.slots.trim() === "" || !Number.isInteger(slots) || slots < 0) return "slots is a whole number";
  const n = Number(f.limit);
  let budget: Record<string, unknown> | undefined;
  if (f.budget !== "none") {
    if (f.limit.trim() === "" || !Number.isFinite(n) || n <= 0) return `a ${f.budget} budget needs its limit`;
    const fp = f.freeplayLimit.trim() === "" ? n : Number(f.freeplayLimit);
    if (f.budget === "usage" && (!Number.isFinite(fp) || fp <= 0)) return "the freeplay share is a percentage";
    budget =
      f.budget === "usage"
        ? { kind: "usage", scoredMaxPct: n, freeplayMaxPct: fp }
        : f.budget === "spend"
          ? { kind: "spend", usdPerDay: n }
          : { kind: "runs", perDay: n };
  }
  return {
    key: `credentials/${id}`,
    body: { provider: f.provider, secretEnv: f.secretEnv.trim(), slots, ...(budget !== undefined ? { budget } : {}), billing: f.billing, enabled: opts.enabled ?? false },
  };
}

/**
 * A stored credential row as the form that edits it. Seeded from the row as
 * written, not from `/api/admin`'s budget, which is the effective one: a
 * subscription that names no budget reads there as usage at 80/80, and
 * saving that back would write a budget the operator never set.
 */
export function credentialFormOf(id: string, row: unknown): NewCredentialForm {
  const r = (typeof row === "object" && row !== null ? row : {}) as Record<string, unknown>;
  const b = (typeof r["budget"] === "object" && r["budget"] !== null ? r["budget"] : {}) as Record<string, unknown>;
  const num = (v: unknown): string => (typeof v === "number" ? String(v) : "");
  const kind: BudgetKind = b["kind"] === "usage" || b["kind"] === "spend" || b["kind"] === "runs" ? b["kind"] : "none";
  const limit = kind === "usage" ? num(b["scoredMaxPct"]) : kind === "spend" ? num(b["usdPerDay"]) : kind === "runs" ? num(b["perDay"]) : "";
  const fp = kind === "usage" ? num(b["freeplayMaxPct"]) : "";
  return {
    id,
    provider: typeof r["provider"] === "string" ? r["provider"] : "",
    secretEnv: typeof r["secretEnv"] === "string" ? r["secretEnv"] : "",
    slots: num(r["slots"]),
    billing: r["billing"] === "free" ? "free" : "paid",
    budget: kind,
    limit,
    // Shown only where it differs: an equal pair reads as one number.
    freeplayLimit: fp === limit ? "" : fp,
  };
}

/** The credential rows the store holds, by id, from the config document. */
export function storedCredentialRows(config: Record<string, unknown>): Record<string, unknown> {
  const c = config["credentials"];
  return typeof c === "object" && c !== null && !Array.isArray(c) ? (c as Record<string, unknown>) : {};
}

/**
 * A health state's tone, as the shared `ok` / `warn` / `err` / `dim` classes:
 * held and unread clear by themselves, the rest want someone, and the
 * operator's own switch is no alarm; null is no supervisor up to say.
 */
export function healthTone(s: HealthState | null): "ok" | "warn" | "err" | "dim" {
  if (s === null || s === "disabled") return "dim";
  if (s === "ok") return "ok";
  return s === "held" || s === "unread" ? "warn" : "err";
}

/** A health's hover: since when, and what the provider last answered, where known. */
export function healthTitle(h: CredentialHealth, fmt: (t: number) => string): string {
  const check = h.lastCheck === null ? null : `last check ${fmt(h.lastCheck.at)}${h.lastCheck.http !== null ? ` · HTTP ${h.lastCheck.http}` : ""}${h.lastCheck.code !== undefined ? ` ${h.lastCheck.code}` : ""}`;
  return [h.since !== null ? `since ${fmt(h.since)}` : null, check].filter((x): x is string => x !== null).join(" · ");
}

/** A fix as a label, its sentence left for the hover: `wait · until <when>`. */
export function fixLabel(f: CredentialFix, fmt: (t: number) => string): string {
  const what = { "wait-reset": "wait", "raise-budget": "raise budget", enable: "enable", "set-secret": "set secret", "replace-secret": "replace secret" }[f.kind];
  return f.until !== undefined ? `${what} · until ${fmt(f.until)}` : what;
}

// ------------------------------------------------------------------ sections

/** The config page's sections, in sidebar order, and the group each belongs to (null: every deployment has it). */
export const CONFIG_SECTIONS = [
  { id: "providers", label: "providers", group: "runner" },
  { id: "roster", label: "roster", group: "runner" },
  { id: "freeplay", label: "freeplay", group: "runner" },
  { id: "campaigns", label: "campaigns", group: "evals" },
  { id: "queue", label: "queue", group: "runner" },
  { id: "policy", label: "policy", group: null },
  { id: "deployment", label: "deployment", group: null },
  { id: "history", label: "history", group: null },
] as const satisfies readonly { id: string; label: string; group: keyof Groups | null }[];

export type ConfigSectionId = (typeof CONFIG_SECTIONS)[number]["id"];

/** The sections a deployment has: a group that is off takes its sections with it. */
export function sectionsShown(groups: Groups): (typeof CONFIG_SECTIONS)[number][] {
  return CONFIG_SECTIONS.filter((s) => s.group === null || groups[s.group]);
}

/** The section a route names, or null when it names none this deployment has. */
export function sectionOf(param: string | undefined, groups: Groups): ConfigSectionId | null {
  return sectionsShown(groups).find((s) => s.id === param)?.id ?? null;
}

/**
 * The section a store row key's raw editor sits in: each collection beside the
 * table that edits it, and every other singleton (policy, accounts, preflight)
 * in `policy`. The roster has its own table and no raw editor.
 */
export function sectionOfKey(key: string): ConfigSectionId {
  const head = key.split("/")[0]!;
  if (head === "credentials") return "providers";
  if (head === "campaigns" || head === "campaign-defs") return "campaigns";
  if (head === "queue") return "queue";
  if (head === "roster") return "roster";
  return "policy";
}

/** A roster entry as the store holds it, for the freeplay section. */
export interface FreeplayRow {
  name: string;
  model: string;
  /** `unlimited`: the entry keeps a freeplay character playing; anything else: it does not. */
  playing: boolean;
}

/** Every roster entry, with whether it keeps a freeplay character playing (`idle: "unlimited"`). */
export function freeplayRows(roster: unknown): FreeplayRow[] {
  if (typeof roster !== "object" || roster === null || Array.isArray(roster)) return [];
  return Object.entries(roster as Record<string, Record<string, unknown>>).map(([name, e]) => ({
    name,
    model: typeof e?.["model"] === "string" ? e["model"] : "",
    playing: e?.["idle"] === "unlimited",
  }));
}

/** A campaign row as the store holds it: the dynamic half (`runner/src/campaigns.ts`). */
export interface CampaignRow {
  name: string;
  version: number | null;
  enabled: boolean;
  assignments: { model: string; runsPerCell: number }[];
  account: string | null;
  credential: string | null;
  concluded: number[];
}

export function campaignRows(campaigns: unknown): CampaignRow[] {
  if (typeof campaigns !== "object" || campaigns === null || Array.isArray(campaigns)) return [];
  return Object.entries(campaigns as Record<string, Record<string, unknown>>).map(([name, c]) => ({
    name,
    version: typeof c?.["version"] === "number" ? c["version"] : null,
    enabled: c?.["enabled"] === true,
    assignments: Array.isArray(c?.["assignments"])
      ? (c["assignments"] as Record<string, unknown>[]).map((a) => ({
          model: typeof a?.["model"] === "string" ? a["model"] : "?",
          runsPerCell: typeof a?.["runsPerCell"] === "number" ? a["runsPerCell"] : 0,
        }))
      : [],
    account: typeof c?.["account"] === "string" ? c["account"] : null,
    credential: typeof c?.["credential"] === "string" ? c["credential"] : null,
    concluded: Array.isArray(c?.["concluded"]) ? (c["concluded"] as unknown[]).filter((v): v is number => typeof v === "number") : [],
  }));
}

/** A published definition, as its store key names it: `<id>@<version>`. */
export interface PublishedDef {
  id: string;
  version: number;
}

/** Every published campaign definition the store holds, newest version of each id first. */
export function publishedDefs(defs: unknown): PublishedDef[] {
  if (typeof defs !== "object" || defs === null || Array.isArray(defs)) return [];
  const out: PublishedDef[] = [];
  for (const key of Object.keys(defs)) {
    const m = /^(.+)@([1-9][0-9]*)$/.exec(key);
    if (m !== null) out.push({ id: m[1]!, version: Number(m[2]) });
  }
  return out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : b.version - a.version));
}

export interface NewCampaignForm {
  /** `<id>@<version>` of a published definition. */
  def: string;
  /** Roster names, one per assignment. */
  models: string[];
  runsPerCell: string;
}

/**
 * A new campaign row: a published definition and its assignments, written
 * disabled, so the operator turns it on once it reads right. Keyed by the
 * definition's id, the way the store keys campaign rows.
 */
export function campaignDoc(f: NewCampaignForm): { key: string; body: Record<string, unknown> } | string {
  const m = /^(.+)@([1-9][0-9]*)$/.exec(f.def);
  if (m === null) return "pick a published definition";
  if (f.models.length === 0) return "assign at least one roster entry";
  const runs = Number(f.runsPerCell);
  if (!Number.isInteger(runs) || runs < 1) return "runs per cell is a whole number, 1 or more";
  return {
    key: `campaigns/${m[1]!}`,
    body: { version: Number(m[2]), enabled: false, assignments: f.models.map((model) => ({ model, runsPerCell: runs })) },
  };
}

/** One queue job, with the store key it is written under. */
export interface QueueRow {
  key: string;
  refs: string[];
  episode: string;
  repeat: number | "loop" | null;
  enabled: boolean;
  account: string | null;
  credential: string | null;
}

/**
 * The queue's jobs beside their row keys. The document's `queue` is the rows
 * in render order, and so is the key list, so the two zip.
 */
export function queueRows(queue: unknown, keys: readonly string[]): QueueRow[] {
  if (!Array.isArray(queue)) return [];
  const qk = keys.filter((k) => /^queue\/\d+$/.test(k));
  return queue.map((j, i): QueueRow => {
    const o = (typeof j === "object" && j !== null ? j : {}) as Record<string, unknown>;
    const ref = o["ref"];
    return {
      key: qk[i] ?? `queue/${i}`,
      refs: Array.isArray(ref) ? ref.filter((r): r is string => typeof r === "string") : typeof ref === "string" ? [ref] : [],
      episode: typeof o["episode"] === "string" ? o["episode"] : "?",
      repeat: o["repeat"] === "loop" ? "loop" : typeof o["repeat"] === "number" ? o["repeat"] : null,
      enabled: o["enabled"] === true,
      account: typeof o["account"] === "string" ? o["account"] : null,
      credential: typeof o["credential"] === "string" ? o["credential"] : null,
    };
  });
}

/** The key a new queue job is written under: one past the highest. */
export function nextQueueKey(keys: readonly string[]): string {
  const ns = keys.map((k) => /^queue\/(\d+)$/.exec(k)).filter((m): m is RegExpExecArray => m !== null).map((m) => Number(m[1]));
  return `queue/${ns.length === 0 ? 0 : Math.max(...ns) + 1}`;
}

export const QUEUE_EPISODES = ["e90", "e360", "freeplay"] as const;

export interface NewJobForm {
  ref: string;
  episode: string;
  repeat: string;
  enabled: boolean;
}

export function jobDoc(f: NewJobForm): Record<string, unknown> | string {
  if (f.ref === "") return "pick a roster entry";
  const loop = f.repeat.trim() === "loop";
  const n = Number(f.repeat);
  if (!loop && (!Number.isInteger(n) || n < 1)) return "repeat is a whole number, or loop";
  return { ref: f.ref, episode: f.episode, repeat: loop ? "loop" : n, enabled: f.enabled };
}

/** What each group holds, and the chart value that switches it: a group's row on the deployment section. */
export const GROUP_ROWS: readonly { group: keyof Groups; holds: string }[] = [
  { group: "runner", holds: "fleet supervisor, run pods, credentials" },
  { group: "evals", holds: "scored episodes, campaigns, ladder" },
  { group: "viewer", holds: "viewer, inspector, public site" },
];

/** A duration for the publishing row: `15 min`, `30 s`, or `none`. */
export function fmtDelay(ms: number): string {
  if (ms <= 0) return "none";
  return ms < 60_000 ? `${Math.round(ms / 1000)} s` : `${Math.round(ms / 60_000)} min`;
}

// ------------------------------------------------------------------ secrets

/**
 * How a credential's secret is replaced from the page: a key typed in (an
 * endpoint), a `claude setup-token` pasted in (a Claude subscription), or a
 * Codex home logged in again by the supervisor. Null for a provider the page
 * does not know.
 */
export function secretControl(p: AdminProviderView | undefined): "key" | "token" | "login" | null {
  if (p === undefined) return null;
  return p.holds === "home" ? "login" : p.holds === "token" ? "token" : "key";
}

/** The control's label: a new key on an endpoint, logging in again on a subscription. */
export function secretControlLabel(kind: "key" | "token" | "login"): string {
  return kind === "key" ? "set key" : "re-auth";
}

/** Whether a Codex login is under way, so the page polls for its link and its end. */
export function loginInFlight(l: AdminCodexLoginView | null): boolean {
  return l !== null && (l.state === "requested" || l.state === "starting" || l.state === "waiting");
}

/** Why a secret control is off, or null when it may be used. */
export function secretControlOff(
  kind: "key" | "token" | "login",
  c: Pick<AdminCredentialView, "login" | "inUse">,
  o: { storeKey: { ok: true } | { ok: false; why: string }; fleetUp: boolean },
): string | null {
  if (kind !== "login") return o.storeKey.ok ? null : o.storeKey.why;
  if (!o.fleetUp) return "no supervisor is up to run the login";
  if (loginInFlight(c.login)) return "a login is under way";
  if (c.inUse !== null && c.inUse > 0) return "a run is live on it: disable it and let its runs finish first";
  return null;
}
