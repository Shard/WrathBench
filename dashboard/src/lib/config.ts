/**
 * The pure half of the config page.
 *
 * The page is a client of `/api/config`, and everything that decides *what to
 * send* lives here rather than in the JSX, because the two decisions worth
 * getting right are both invisible on screen:
 *
 * **Absence is a value.** `infra/fleet.json`'s own notes make an absent
 * `routing` mean "the model author's own provider, fallbacks off", an absent
 * `idle` mean none, and an absent `billing` mean derived. The API's PATCH is a
 * shallow merge (`config-store.ts`, `patch`) and JSON cannot carry
 * `undefined`, so there is no PATCH that removes a key: a cleared field would
 * have to travel as `null`, which is a different document. So a write that only
 * *sets* fields is a PATCH, and a write that clears one is a PUT of the whole
 * entry with that key omitted. `rosterWrite` is that decision.
 *
 * **Routing has three shapes.** A provider name, a list in preference order, or
 * the object form — one text field for all three, so the field parses JSON when
 * it looks like JSON, splits on commas when it has them, and is a bare name
 * otherwise.
 *
 * Nothing here fetches. The page's writes are checked against the server's own
 * `parseFleet` and the refusal comes back verbatim; none of this second-guesses
 * it, and the one validation below (`isRosterName`) exists only because the
 * name is in the URL rather than in the body.
 *
 * The drafts' half — the toggle, the promote form, the estimate's labels — is
 * at the bottom, for the same reason: what a promotion sends is decided here.
 */

import type { DraftFetchResponse, DraftPriceView, DraftPromoteBody, E90TokenProfileView } from "@viewer/api-types";
import { fmtTokens, fmtUsd } from "./format";

/** The tiers a roster entry may carry. The policy names them; these are the ones the page offers. */
export const TIERS = ["t0", "t1", "t2"] as const;
/** What an entry does with an account once its tier is spent. Absent = none. */
export const IDLES = ["none", "unlimited"] as const;
/** Where a run may physically execute. Absent = derived from the model and its base. */
export const BILLINGS = ["free", "paid"] as const;

/** The fields the roster table edits inline. Everything else is a JSON edit. */
export const EDITABLE_FIELDS = ["tier", "idle", "billing", "routing"] as const;
export type EditableField = (typeof EDITABLE_FIELDS)[number];

/** One roster entry, as the store holds it: the document exactly as written. */
export type RosterEntry = Record<string, unknown>;

/**
 * The name half of a row key, as `config-store.ts` accepts it. Checked here
 * only because the name travels in the path — a bad one would be a 400 about a
 * config key rather than about the name the operator typed.
 */
const ROSTER_NAME = /^[A-Za-z0-9_.:-]+$/;

export function isRosterName(name: string): boolean {
  return ROSTER_NAME.test(name);
}

/** A routing value as one text field: "" for absent, a bare name, or JSON. */
export function formatRouting(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value) && value.every((v) => typeof v === "string")) return value.join(", ");
  return JSON.stringify(value);
}

/** Thrown by `parseRouting` for text that is neither a name nor JSON. */
export class RoutingParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RoutingParseError";
  }
}

/**
 * The text field back to a routing document. `undefined` means "remove the
 * key", which is the deliberate absent state and not the same as any value.
 */
export function parseRouting(text: string): unknown {
  const t = text.trim();
  if (t.length === 0) return undefined;
  if (t.startsWith("{") || t.startsWith("[") || t.startsWith('"')) {
    try {
      return JSON.parse(t) as unknown;
    } catch {
      throw new RoutingParseError("routing is not valid JSON — a provider name, a comma-separated list, or a JSON object");
    }
  }
  if (t.includes(",")) {
    const names = t.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
    if (names.length === 0) throw new RoutingParseError("routing is a list of nothing");
    return names;
  }
  return t;
}

/** The form's value for one editable field of an entry. */
export function fieldValue(entry: RosterEntry, field: EditableField): string {
  const v = entry[field];
  if (field === "routing") return formatRouting(v);
  return typeof v === "string" ? v : "";
}

/** Every editable field of an entry, as the form holds them. */
export function formOf(entry: RosterEntry): Record<EditableField, string> {
  return {
    tier: fieldValue(entry, "tier"),
    idle: fieldValue(entry, "idle"),
    billing: fieldValue(entry, "billing"),
    routing: fieldValue(entry, "routing"),
  };
}

/** One write to `/api/config/roster/<name>`, or null when nothing changed. */
export interface RosterWrite {
  method: "PATCH" | "PUT";
  body: Record<string, unknown>;
  /** The fields this write touches, for the note the operator is asked for. */
  changed: EditableField[];
}

/**
 * What to send for an edited roster row.
 *
 * A pure set is a PATCH of just the changed keys — the smallest audit diff,
 * and the merge the store's `patch` performs. A clear is a PUT, because the
 * key has to be *gone* rather than null; the whole entry is rewritten and the
 * cleared key is left out of it. `tier` is required on every entry, so it is
 * never cleared: an empty tier is treated as no change.
 */
export function rosterWrite(entry: RosterEntry, form: Record<EditableField, string>): RosterWrite | null {
  const sets: Record<string, unknown> = {};
  const removes: EditableField[] = [];
  const changed: EditableField[] = [];
  for (const field of EDITABLE_FIELDS) {
    const raw = form[field];
    const next = field === "routing" ? parseRouting(raw) : raw.trim().length === 0 ? undefined : raw.trim();
    const before = entry[field];
    if (next === undefined) {
      // Tier is required; an emptied tier select is a slip, not a request to
      // ship a config the server would refuse.
      if (field === "tier") continue;
      if (before === undefined) continue;
      removes.push(field);
      changed.push(field);
      continue;
    }
    if (JSON.stringify(next) === JSON.stringify(before)) continue;
    sets[field] = next;
    changed.push(field);
  }
  if (changed.length === 0) return null;
  if (removes.length === 0) return { method: "PATCH", body: sets, changed };
  const whole: Record<string, unknown> = { ...entry, ...sets };
  for (const field of removes) delete whole[field];
  return { method: "PUT", body: whole, changed };
}

/** The form behind "add a roster entry". Everything but the first three is optional. */
export interface NewEntryForm {
  name: string;
  model: string;
  tier: string;
  billing: string;
  idle: string;
  routing: string;
  race: string;
  class: string;
  apiBase: string;
  apiKeyEnv: string;
}

export const EMPTY_NEW_ENTRY: NewEntryForm = {
  name: "",
  model: "",
  tier: "t0",
  billing: "",
  idle: "",
  routing: "",
  race: "",
  class: "",
  apiBase: "",
  apiKeyEnv: "",
};

/**
 * The document a new roster entry is PUT as. An empty optional field is left
 * out entirely rather than sent empty — see the header: absence is a value, and
 * `""` is not the same request as "say nothing about this".
 *
 * `race` and `class` are the numeric dimensions the harness fixes a character
 * on; they are typed as numbers here because the config carries numbers.
 */
export function newEntryDoc(form: NewEntryForm): Record<string, unknown> {
  const doc: Record<string, unknown> = { model: form.model.trim(), tier: form.tier.trim() };
  const routing = parseRouting(form.routing);
  if (routing !== undefined) doc["routing"] = routing;
  for (const [key, raw] of [["billing", form.billing], ["idle", form.idle], ["apiBase", form.apiBase], ["apiKeyEnv", form.apiKeyEnv]] as const) {
    const v = raw.trim();
    if (v.length > 0) doc[key] = v;
  }
  for (const [key, raw] of [["race", form.race], ["class", form.class]] as const) {
    const v = raw.trim();
    if (v.length === 0) continue;
    const n = Number(v);
    if (!Number.isFinite(n)) throw new RoutingParseError(`${key} must be a number`);
    doc[key] = n;
  }
  return doc;
}

/* ------------------------------------------------------------- drafts --- */

/** The review list's billing toggle. */
export const DRAFT_FILTERS = ["all", "free", "paid"] as const;
export type DraftFilter = (typeof DRAFT_FILTERS)[number];

/** The drafts the toggle shows, in the server's order (newest first). */
export function draftsShown<T extends { billing: "free" | "paid" }>(drafts: readonly T[], filter: DraftFilter): T[] {
  return filter === "all" ? [...drafts] : drafts.filter((d) => d.billing === filter);
}

/** The promote form. The tier starts empty: promotion never picks one. */
export interface PromoteForm {
  name: string;
  tier: string;
  race: string;
  class: string;
}

export function promoteFormOf(suggestedName: string): PromoteForm {
  return { name: suggestedName, tier: "", race: "", class: "" };
}

/**
 * The body a promotion is POSTed as, or a thrown sentence when the form cannot
 * make one. Only what the path cannot carry and the server would otherwise
 * refuse less clearly is checked here: a name, a chosen tier, numbers for
 * race and class. Everything else is the parser's, verbatim.
 */
export function promoteBody(model: string, form: PromoteForm): DraftPromoteBody {
  const name = form.name.trim();
  if (!isRosterName(name)) throw new Error("a roster name is letters, digits and _ . : - (it is the row key)");
  const tier = form.tier.trim();
  if (tier.length === 0) throw new Error("choose a tier");
  const body: DraftPromoteBody = { model, name, tier };
  for (const key of ["race", "class"] as const) {
    const v = form[key].trim();
    if (v.length === 0) continue;
    const n = Number(v);
    if (!Number.isInteger(n)) throw new Error(`${key} must be a whole number`);
    body[key] = n;
  }
  return body;
}

/** "~$0.42": the tilde is the label that says it is an estimate. */
export function fmtEstimate(usd: number | null): string {
  return usd === null ? "—" : `~${fmtUsd(usd)}`;
}

/** A per-million rate in as few digits as say it: 0.075, 0.6, 15. */
function rate(v: number): string {
  return String(Number(v.toPrecision(3)));
}

/** Input / output, dollars per million tokens. */
export function fmtPrice(p: DraftPriceView | null): string {
  return p === null ? "—" : `${rate(p.input)} / ${rate(p.output)}`;
}

/** The estimate column's tooltip: what it was priced at, and why it reads low. */
export function estimateHint(profile: E90TokenProfileView | null): string {
  if (profile === null) {
    return "no estimate: no counted e90 in this series on the wrathbench harness with provider-reported tokens";
  }
  return (
    `estimate: catalogue list price × the median counted e90 (${profile.runs} run${profile.runs === 1 ? "" : "s"}, ` +
    `${profile.series ?? "every series"}: ${fmtTokens(profile.promptTokens)} prompt, ${fmtTokens(profile.completionTokens)} completion, ` +
    `${fmtTokens(profile.cacheReadTokens)} cached). List price under-reads reasoning-heavy models 2–3× (docs/COSTS.md)`
  );
}

/** One fetch's result, as a status line. */
export function fetchSummary(r: DraftFetchResponse): string {
  return `${r.added.length} new · ${r.refreshed} refreshed · ${r.removed.length} dropped · ${r.skipped} skipped · ${r.toolModels} tool-calling in the catalogue`;
}

/** What one audit row did. Null on either side is a create or a delete. */
export function auditVerb(row: { before: unknown; after: unknown }): "created" | "deleted" | "changed" {
  if (row.before === null) return "created";
  if (row.after === null) return "deleted";
  return "changed";
}

/**
 * The row keys that get a JSON editor, in the order `/api/config` lists them.
 *
 * Driven off the server's own `keys` rather than a list of top-level names,
 * because `campaigns` and `queue` are collections: when they hold entries they
 * exist only as `campaigns/<name>` and `queue/<n>` rows, and a PUT to the bare
 * `campaigns` key would be accepted, stored, and then ignored by the renderer —
 * a write that reports success and changes nothing. Roster rows are excluded:
 * the table above is their editor.
 */
export function jsonEditorKeys(keys: readonly string[]): string[] {
  return keys.filter((k) => k !== "roster" && !k.startsWith("roster/"));
}

/**
 * The typographic characters this repository's prose is full of, and the ASCII
 * a header can carry instead.
 */
const HEADER_FOLD: readonly [RegExp, string][] = [
  [/[\u2010-\u2015]/g, "-"],
  [/[\u2018\u2019\u201B]/g, "'"],
  [/[\u201C\u201D\u201F]/g, '"'],
  [/\u2026/g, "..."],
  [/[\u00A0\u2002-\u200B]/g, " "],
];

/**
 * An actor or a note as an HTTP header can carry it.
 *
 * The API takes both as headers (`x-wrathbench-actor`, `x-wrathbench-note`),
 * and a header value is ISO-8859-1: `fetch` REFUSES the whole request — not
 * just the header — when a value holds a code point above U+00FF. An em dash
 * in a note is the likeliest thing an operator here types, and without this
 * the write failed with a browser's message about `RequestInit` that said
 * nothing about config. Folded to ASCII rather than rejected, because the note
 * is prose and "\u2014" recorded as "-" loses nothing; anything left above
 * U+00FF becomes "?" so the rest of the sentence still lands, and a line break
 * becomes a space because a header cannot carry one either.
 */
export function headerSafe(text: string): string {
  let out = text;
  for (const [re, to] of HEADER_FOLD) out = out.replace(re, to);
  return out.replace(/[\u0100-\uFFFF]/g, "?").replace(/[\r\n]+/g, " ");
}

/**
 * Pretty-print a stored document for a textarea, stably.
 *
 * `?? null` because `JSON.stringify(undefined)` is `undefined`, not a string,
 * and a textarea handed that renders the word rather than an empty document.
 * A row key the render does not emit is the only way to get there, which is
 * rare and not worth reasoning about twice.
 */
export function editorText(value: unknown): string {
  return JSON.stringify(value ?? null, null, 2);
}
