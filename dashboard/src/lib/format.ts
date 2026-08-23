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
