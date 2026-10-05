/**
 * The Codex CLI's token accounting, and the one rule for turning it into a
 * per-turn count.
 *
 * `turn.completed.usage` in `codex exec --json` is the THREAD's running total,
 * not the turn's: `exec resume <id>` rebuilds the thread from its rollout,
 * token counts included, and reports the total so far when the turn closes.
 * On a 2,082-turn freeplay run the first turn read 184,145 input tokens, the
 * second 494,311, the third 733,398, and the last 2,012,351,346 — the thread
 * total, which summed per turn read as 1.69 trillion. A one-turn thread (the
 * first codex e90, CLI 0.153.4, whose whole episode was one turn) cannot tell
 * the two readings apart, and a delta from a zero baseline equals the raw
 * value there, so reading every unmarked codex figure as thread-cumulative is
 * right for both shapes the corpus holds.
 *
 * The total is not strictly monotonic. When the CLI cannot write its rollout
 * (a full disk), the next resume rebuilds the thread without the turns whose
 * items were lost, and the total goes DOWN. A drop is therefore read as a new
 * baseline: the turn that shows it counts zero for the fields that fell, and
 * the turn after it is measured from the lower figure. The tokens of the lost
 * turns are not recoverable from the counter; the floor is the honest reading.
 *
 * Two users, one rule: the driver (`adapter-codex.ts`) writes the per-turn
 * delta as `usage` with the thread figure beside it as `usageCumulative`, and
 * the viewer (`runner/viewer/tail.ts`) derives the same delta at read time for
 * records written before the driver did — told apart by `usageCumulative`
 * being absent. This module imports nothing, so the viewer and the collector
 * can read it without pulling the driver in.
 */

/**
 * The CLI's accounting in the one shape the harness reads. Codex counts like
 * OpenAI: `input_tokens` is the whole prompt with the cached part as a subset,
 * which is already the runner's `prompt_tokens` convention, so nothing is
 * summed. `cache_write_input_tokens` and `reasoning_output_tokens` are kept
 * only when present, because "unknown" and "zero" must not render alike.
 */
export interface CodexUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  cached_tokens?: number;
  cache_write_tokens?: number;
  reasoning_tokens?: number;
}

export function normalizeCodexUsage(raw: unknown): CodexUsage | undefined {
  if (raw === null || typeof raw !== "object") return undefined;
  const u = raw as Record<string, unknown>;
  const n = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
  const input = n(u["input_tokens"]);
  const output = n(u["output_tokens"]);
  const read = n(u["cached_input_tokens"]);
  const write = n(u["cache_write_input_tokens"]);
  const reasoning = n(u["reasoning_output_tokens"]);
  if (input === undefined && output === undefined) return undefined;
  const prompt = input ?? 0;
  const completion = output ?? 0;
  const usage: CodexUsage = { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion };
  if (read !== undefined) usage.cached_tokens = read;
  if (write !== undefined) usage.cache_write_tokens = write;
  if (reasoning !== undefined) usage.reasoning_tokens = reasoning;
  return usage;
}

/** A `CodexUsage` already in the normalised shape, as a record's `usage` carries it; undefined otherwise. */
export function codexUsageOf(v: unknown): CodexUsage | undefined {
  if (v === null || typeof v !== "object") return undefined;
  const u = v as Record<string, unknown>;
  const n = (x: unknown): number | undefined => (typeof x === "number" && Number.isFinite(x) ? x : undefined);
  const prompt = n(u["prompt_tokens"]);
  const completion = n(u["completion_tokens"]);
  if (prompt === undefined && completion === undefined) return undefined;
  const out: CodexUsage = {
    prompt_tokens: prompt ?? 0,
    completion_tokens: completion ?? 0,
    total_tokens: (prompt ?? 0) + (completion ?? 0),
  };
  const read = n(u["cached_tokens"]);
  const write = n(u["cache_write_tokens"]);
  const reasoning = n(u["reasoning_tokens"]);
  if (read !== undefined) out.cached_tokens = read;
  if (write !== undefined) out.cache_write_tokens = write;
  if (reasoning !== undefined) out.reasoning_tokens = reasoning;
  return out;
}

/**
 * One turn's usage: this thread total minus the previous one, each field on
 * its own and never below zero (see the header for why a drop is a new
 * baseline). No previous total — the thread's first turn — is the total itself.
 * An optional field is present in the delta exactly when it is in `cur`.
 */
export function codexUsageDelta(prev: CodexUsage | undefined, cur: CodexUsage): CodexUsage {
  if (prev === undefined) return { ...cur };
  const d = (a: number | undefined, b: number | undefined): number => Math.max(0, (a ?? 0) - (b ?? 0));
  const prompt = d(cur.prompt_tokens, prev.prompt_tokens);
  const completion = d(cur.completion_tokens, prev.completion_tokens);
  const out: CodexUsage = { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion };
  if (cur.cached_tokens !== undefined) out.cached_tokens = d(cur.cached_tokens, prev.cached_tokens);
  if (cur.cache_write_tokens !== undefined) out.cache_write_tokens = d(cur.cache_write_tokens, prev.cache_write_tokens);
  if (cur.reasoning_tokens !== undefined) out.reasoning_tokens = d(cur.reasoning_tokens, prev.reasoning_tokens);
  return out;
}

/** Whether a thread total went backwards: the input or the output counter fell. */
export function codexUsageRegressed(prev: CodexUsage | undefined, cur: CodexUsage): boolean {
  return prev !== undefined && (cur.prompt_tokens < prev.prompt_tokens || cur.completion_tokens < prev.completion_tokens);
}

/**
 * The read-time half: fed every trajectory record of a run in file order, it
 * rewrites the `usage` of a codex `response` written before the driver logged
 * per-turn deltas into that delta, in place, keeping the thread figure as
 * `usageCumulative` (and `usageDerived: true`, so a reader can tell the
 * viewer's derivation from the driver's own record).
 *
 * The baseline follows the driver's: a `driver` record opens an episode, and
 * every codex episode starts a new thread; a `codex_thread` record names the
 * thread the following turns run on, and a different id is a new baseline.
 * Records of any other driver pass through untouched, and so does a codex
 * record that already carries `usageCumulative`.
 */
export class CodexUsageCorrector {
  private codex = false;
  private thread: string | null = null;
  private prev: CodexUsage | undefined;

  reset(): void {
    this.codex = false;
    this.thread = null;
    this.prev = undefined;
  }

  note(rec: Record<string, unknown>): void {
    const t = rec["t"];
    if (t === "driver") {
      this.codex = rec["driver"] === "codex";
      this.thread = null;
      this.prev = undefined;
      return;
    }
    if (t === "codex_thread") {
      this.codex = true;
      const id = typeof rec["threadId"] === "string" ? (rec["threadId"] as string) : null;
      if (id !== this.thread) {
        this.thread = id;
        this.prev = undefined;
      }
      return;
    }
    if (!this.codex || t !== "response") return;
    if (rec["usageCumulative"] !== undefined) return;
    const cum = codexUsageOf(rec["usage"]);
    if (cum === undefined) return;
    rec["usage"] = codexUsageDelta(this.prev, cum);
    rec["usageCumulative"] = cum;
    rec["usageDerived"] = true;
    this.prev = cum;
  }
}
