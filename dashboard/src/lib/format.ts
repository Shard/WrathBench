/**
 * Display formatting. Pure, and shared by every page so one reading of "—"
 * holds everywhere: a missing value gets the dash, a recorded zero never does.
 */

export function num(v: number | null | undefined): string {
  return v === null || v === undefined ? "—" : String(v);
}

/** Copper → g/s/c, the way the client shows it. */
export function fmtMoney(copper: number | null | undefined): string {
  if (copper === null || copper === undefined) return "—";
  const g = Math.floor(copper / 10000);
  const s = Math.floor((copper % 10000) / 100);
  const c = copper % 100;
  const parts: string[] = [];
  if (g > 0) parts.push(`${g}g`);
  if (g > 0 || s > 0) parts.push(`${s}s`);
  parts.push(`${c}c`);
  return parts.join(" ");
}

export function fmtAge(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${String(s % 60).padStart(2, "0")}s ago`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m ago`;
}

/** A wall clock span, for playtime. */
export function fmtDuration(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms) || ms < 0) return "—";
  const s = Math.round(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h}h${String(m).padStart(2, "0")}m`;
  return `${m}m${String(s % 60).padStart(2, "0")}s`;
}

/**
 * The tool-call half of the run page's episode-budget line. Null is no ceiling
 * at all — the policy's `idle: "unlimited"` freeplay lane — and it reads the
 * way the null `maxTurns` beside it already does, rather than as a blank or a 0
 * that would look like a ceiling of zero.
 */
export function fmtToolCallBudget(n: number | null): string {
  return n === null ? "unlimited tool calls" : `${n} tool calls`;
}

/**
 * A short span for the feed's latency figures: "840ms", "12.3s", then
 * `fmtDuration`'s m:ss/h:mm forms. Empty string, not a dash, when there is
 * nothing to say — these render inline in a crowded header where a
 * placeholder would just be noise.
 */
export function fmtLatency(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms) || ms < 0) return "";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  // 59.95s would print as "60.0s"; from there fmtDuration takes over.
  if (ms < 59_950) return `${(ms / 1000).toFixed(1)}s`;
  return fmtDuration(ms);
}

/**
 * Dollars. Small figures keep three decimals because a cent's resolution is
 * useless at $0.004, and a recorded $0 prints as "$0.00" rather than the dash —
 * a free model costing nothing is a fact, not a missing value.
 */
export function fmtUsd(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—";
  if (v === 0) return "$0.00";
  return v < 1 ? `$${v.toFixed(3)}` : `$${v.toFixed(2)}`;
}

/**
 * The one-line reading of a cost, provenance included: a bare number invites
 * the reader to take a reconstruction for an invoice.
 *
 * `blank` is what stands in when there is no figure — the two costs blank for
 * different reasons (a provider that reported nothing, a model with no price)
 * and the caller knows which one it is asking about.
 */
export function fmtCost(
  c: { usd: number | null; basis: string; asIfMetered: boolean; asOf: string | null } | null | undefined,
  blank = "— (unpriced model)",
): string {
  if (c === undefined || c === null || c.basis === "none" || c.usd === null) return blank;
  if (c.basis === "reported") return `${fmtUsd(c.usd)} ${c.asIfMetered ? "as-if-metered (reported)" : "reported"}`;
  // The date is the server's, off the price row that was actually applied: a
  // rate that lapses must not keep being announced under the old date.
  const when = c.asOf === null ? "undated" : c.asOf.slice(0, 7);
  return `${fmtUsd(c.usd)} ${c.asIfMetered ? "as-if-metered " : ""}(list price, ${when})`;
}

export function fmtTokens(n: number | null | undefined): string {
  if (n === null || n === undefined) return "—";
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

/**
 * Output tokens per second. One decimal below a hundred and none above it: the
 * difference between 12.4 and 12 tok/s is worth reading, the difference between
 * 340 and 340.2 is not. A dash where there is no rate — a run with no completed
 * turn has not been slow, it has produced nothing yet.
 */
export function fmtTps(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—";
  return v < 100 ? v.toFixed(1) : String(Math.round(v));
}

/** "2h ago", "yesterday" — with the exact stamp left for a title attribute. */
export function fmtWhen(ts: number | null, now = Date.now()): string {
  if (ts === null) return "—";
  const d = now - ts;
  if (d < 0) return "just now";
  const s = Math.round(d / 1000);
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const days = Math.floor(h / 24);
  if (days === 1) return "yesterday";
  return `${days}d ago`;
}

export function stamp(ts: number | null): string {
  return ts === null ? "" : new Date(ts).toLocaleString();
}

/** The harness stamp is identical on every row; only the suffix distinguishes. */
export function shortHarness(v: string | null | undefined): string {
  return v === null || v === undefined || v === "" ? "—" : v.replace(/^harness-/, "");
}

/**
 * One inventory list as plain text: "name ×count, name, …" for the rows on
 * one side of `equipped` (FOLLOW-UPS 50). Null items (a run that predates the
 * column) is the dash; a recorded empty side reads "none".
 */
export function fmtItems(
  items: readonly { name: string; count: number; equipped: boolean }[] | null | undefined,
  equipped: boolean,
): string {
  if (items === null || items === undefined) return "—";
  const rows = items.filter((i) => i.equipped === equipped);
  if (rows.length === 0) return "none";
  return rows.map((i) => (i.count > 1 ? `${i.name} ×${i.count}` : i.name)).join(", ");
}

/**
 * The resolved model id, when it is worth showing.
 *
 * A run records the string it was launched with; the provider answers with what
 * it actually served. Those are the same string for most rows — an OpenRouter
 * slug served as itself — and printing it twice is noise. So this returns the
 * resolved id only where it differs from what was asked for, which is exactly
 * the case that could not be read off a page before: an alias (`sonnet`) that
 * the CLI resolved to a real id (`claude-sonnet-5`).
 */
export function resolvedLabel(
  model: string | null | undefined,
  resolved: string | null | undefined,
): string | null {
  if (typeof resolved !== "string" || resolved.length === 0) return null;
  return resolved === model ? null : resolved;
}
