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
