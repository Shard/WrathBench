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
 * Time on the run's own clock, for the feed's per-row stamp: `0:00`, `12:34`,
 * and `1:05:22` once past an hour.
 *
 * A wall-clock time answers "when did this happen" — a question nobody reading
 * a trajectory has, and one that a run started at 03:41 answers unhelpfully.
 * "How far into the run" is the question, and it is the one figure that reads
 * the same across two runs the operator is comparing side by side.
 *
 * Truncated, not rounded: an entry 59.9 s in belongs to 0:59, and rounding it
 * to 1:00 would put it a minute ahead of the entry that follows it. A negative
 * span — an entry stamped before the run row's start, which a clock step can
 * produce — clamps to zero rather than printing a minus.
 */
export function fmtElapsed(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return "—";
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
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

/**
 * The one sentence every page uses for where a subscription run's cost comes
 * from. A subscription run has no metered bill; for claude-code the figure the
 * runner stores is the Claude Agent SDK's own `total_cost_usd` for the session
 * — provider *reported*, and as-if-metered at the same time
 * (`runner/viewer/pricing.ts`, `reported`); codex reports no cost at all, so a
 * codex figure is only ever the list-price estimate over its tokens. Neither is
 * an invoice, and the wording must not say it is.
 */
export const COST_BASIS_NOTE =
  "claude-code and codex subscription runs carry no bill; a claude-code cost is the as-if-metered figure the Claude SDK reports, a codex cost an as-if-metered estimate over its tokens";

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

/**
 * A run id's tail: `20260827`, `20260830-a6`, `20260830-a6-r2` for a
 * fleet-minted id, whose long prefix (`fleet-<entry>-<episode>-<model>-`)
 * repeats what the row's other columns already say. The `fleet-` prefix is
 * the supervisor's ownership mark and is never a reader's business, so an
 * id of another shape loses that and is otherwise shown whole. The full id
 * always sits in the hover and in the run page's tuple.
 */
export function shortRunId(id: string): string {
  const m = /-(\d{8}(?:-a\d+)?(?:-r\d+)?)$/.exec(id);
  return m === null ? id.replace(/^fleet-/, "") : m[1]!;
}

/** The harness stamp is identical on every row; only the suffix distinguishes. */
export function shortHarness(v: string | null | undefined): string {
  return v === null || v === undefined || v === "" ? "—" : v.replace(/^harness-/, "");
}

/**
 * One inventory list as plain text: "name ×count, name, …" for the rows on
 * one side of `equipped` (item 50). Null items (a run that predates the
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

/**
 * A model id as a reader wants to see it: the model's own name, without the
 * provider prefix that only says where it was bought.
 *
 * `nvidia/nemotron-3-ultra-550b-a55b:free` is a routing address — the part
 * before the slash names the platform, not the model, and it is the same for
 * every row from that provider, so it costs a column's width to say nothing.
 * The version stays: `claude-haiku-4-5-20251001` is a date-stamped version,
 * not a prefix, and `glm-4.7-flash` is not the same model as `glm-5.3-flash`.
 *
 * A `:free` tag is the one suffix worth rephrasing — it is a billing fact, and
 * ` (free)` reads as one rather than as part of the name. Any other `:tag`
 * stays verbatim: we do not know what it means, and guessing would rename a
 * model.
 *
 * Presentation only. The full slug stays the key everywhere — run rows, ladder
 * keys, roster lookups, logo matching, and the hover text beside every one of
 * these labels — so nothing here changes what two rows compare as. Never
 * returns empty: a string that is all prefix (`foo/`, `:free`) is handed back
 * as it came, because a blank cell is worse than a long one.
 */
export function modelDisplay(model: string): string {
  const slash = model.lastIndexOf("/");
  const base = slash === -1 ? model : model.slice(slash + 1);
  if (base.length === 0) return model;
  // A free endpoint is the same fact whether the slug spells it `:free`
  // (OpenRouter) or bakes in `-free` (operator, 2026-08-30).
  for (const suffix of [":free", "-free"]) {
    if (base.endsWith(suffix)) {
      const name = base.slice(0, -suffix.length);
      return name.length === 0 ? model : `${name} (free)`;
    }
  }
  return base;
}
