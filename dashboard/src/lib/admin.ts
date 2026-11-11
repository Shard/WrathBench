/**
 * The admin pages' pure half (GitHub issue #427): what each section reads out
 * of the config document and what each of its forms writes. Every write is a
 * config-store row through `/api/config`, which runs the whole candidate
 * config through `parseFleet`, so nothing here validates beyond the shape a
 * form needs to send something at all: a refusal is the parser's sentence.
 */

import type { Groups } from "@viewer/groups";

/** A credential row as the store holds it (`runner/src/credential-slots.ts`). */
export interface CredentialDoc {
  provider?: unknown;
  secretEnv?: unknown;
  slots?: unknown;
  budget?: unknown;
  billing?: unknown;
  enabled?: unknown;
}

export type BudgetKind = "none" | "usage" | "spend" | "runs";

export interface NewCredentialForm {
  id: string;
  provider: string;
  secretEnv: string;
  slots: string;
  billing: "paid" | "free";
  budget: BudgetKind;
  /** The budget's one number: a usage percentage, dollars a day, or runs a day. */
  limit: string;
}

export const EMPTY_CREDENTIAL: NewCredentialForm = { id: "", provider: "", secretEnv: "", slots: "1", billing: "paid", budget: "none", limit: "" };

/** A form as the row it writes, or the sentence that says what is missing. */
export function credentialDoc(f: NewCredentialForm): { key: string; body: Record<string, unknown> } | string {
  const id = f.id.trim();
  if (id === "") return "a credential needs an id";
  if (f.provider === "") return "pick a provider";
  if (f.secretEnv.trim() === "") return "name the env var its secret is in";
  const slots = Number(f.slots);
  if (!Number.isInteger(slots) || slots < 0) return "slots is a whole number";
  const n = Number(f.limit);
  let budget: Record<string, unknown> | undefined;
  if (f.budget !== "none") {
    if (f.limit.trim() === "" || !Number.isFinite(n) || n <= 0) return `a ${f.budget} budget needs its limit`;
    budget =
      f.budget === "usage"
        ? { kind: "usage", scoredMaxPct: n, freeplayMaxPct: n }
        : f.budget === "spend"
          ? { kind: "spend", usdPerDay: n }
          : { kind: "runs", perDay: n };
  }
  return {
    key: `credentials/${id}`,
    body: { provider: f.provider, secretEnv: f.secretEnv.trim(), slots, ...(budget !== undefined ? { budget } : {}), billing: f.billing, enabled: false },
  };
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
