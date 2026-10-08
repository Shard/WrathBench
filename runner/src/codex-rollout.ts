/**
 * The size of the last API call's prompt, read from the Codex CLI's own
 * rollout file.
 *
 * `codex exec --json` reports only the thread's running total on
 * `turn.completed` (`codex-usage.ts`), and one harness turn is a whole
 * `codex exec`, many API calls long: a turn can total 63M prompt tokens against
 * a 258k window. What "context" means for every other driver is the prompt of
 * the last call, and that figure exists only in the rollout the CLI keeps at
 * `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-<timestamp>-<thread_id>.jsonl`, in
 * its `token_count` events:
 *
 *   {"type":"event_msg","payload":{"type":"token_count","info":{
 *     "total_token_usage":{"input_tokens":…,"cached_input_tokens":…,"output_tokens":…,…},
 *     "last_token_usage":{"input_tokens":…,"cached_input_tokens":…,"output_tokens":…,…},
 *     "model_context_window":258400}, "rate_limits":{…}}}
 *
 * Rollouts reach hundreds of megabytes, so only the tail is ever read. Nothing
 * here may fail or delay a turn: every failure is an absent figure. Only
 * `sessions/**` is touched, never `auth.json`. No imports beyond
 * `codex-usage.ts`, so tests can use it without the driver.
 */
import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { join } from "node:path";
import { normalizeCodexUsage } from "./codex-usage";

/** The last API call's accounting as the response record carries it. */
export interface CodexLastCall {
  prompt_tokens: number;
  completion_tokens: number;
  cached_tokens?: number;
  context_window?: number;
}

/** First read, and the one widening if that holds no `token_count`. */
export const ROLLOUT_TAIL_BYTES = 256 * 1024;
export const ROLLOUT_TAIL_WIDE_BYTES = 4 * 1024 * 1024;

/** One rollout line as a `CodexLastCall`, or undefined where it is not a usable `token_count`. */
export function lastCallOfLine(line: string): CodexLastCall | undefined {
  if (!line.includes('"token_count"')) return undefined;
  let rec: unknown;
  try {
    rec = JSON.parse(line);
  } catch {
    return undefined;
  }
  const payload = (rec as { payload?: { type?: unknown; info?: unknown } } | null)?.payload;
  if (payload === null || typeof payload !== "object" || payload.type !== "token_count") return undefined;
  const info = payload.info;
  if (info === null || typeof info !== "object") return undefined;
  const i = info as Record<string, unknown>;
  const u = normalizeCodexUsage(i["last_token_usage"]);
  if (u === undefined) return undefined;
  const out: CodexLastCall = { prompt_tokens: u.prompt_tokens, completion_tokens: u.completion_tokens };
  if (u.cached_tokens !== undefined) out.cached_tokens = u.cached_tokens;
  const w = i["model_context_window"];
  if (typeof w === "number" && Number.isFinite(w) && w > 0) out.context_window = w;
  return out;
}

/**
 * The last `token_count` in a chunk of rollout text. `partialHead` is true when
 * the chunk starts mid-file: its first line is then a fragment and is skipped.
 * A malformed or unusable line is passed over for the one before it.
 */
export function lastCallOfText(text: string, partialHead: boolean): CodexLastCall | undefined {
  const lines = text.split("\n");
  if (partialHead) lines.shift();
  for (let k = lines.length - 1; k >= 0; k--) {
    const found = lastCallOfLine(lines[k]!);
    if (found !== undefined) return found;
  }
  return undefined;
}

/** Up to `bytes` from the end of a file, and whether that left the head of the file unread. */
function readTail(path: string, bytes: number): { text: string; partialHead: boolean } {
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    const len = Math.min(size, bytes);
    const buf = Buffer.alloc(len);
    let got = 0;
    while (got < len) {
      const n = readSync(fd, buf, got, len - got, size - len + got);
      if (n <= 0) break;
      got += n;
    }
    return { text: buf.subarray(0, got).toString("utf8"), partialHead: size > len };
  } finally {
    closeSync(fd);
  }
}

/**
 * The last call of a rollout file: a bounded tail read, widened once when the
 * first holds no `token_count`. Throws on an unreadable file; the caller turns
 * that into an absent figure.
 */
export function lastCallOfRollout(
  path: string,
  o: { tailBytes?: number; wideBytes?: number } = {},
): CodexLastCall | undefined {
  const narrow = o.tailBytes ?? ROLLOUT_TAIL_BYTES;
  const first = readTail(path, narrow);
  const found = lastCallOfText(first.text, first.partialHead);
  if (found !== undefined || !first.partialHead) return found;
  const wide = readTail(path, Math.max(narrow, o.wideBytes ?? ROLLOUT_TAIL_WIDE_BYTES));
  return lastCallOfText(wide.text, wide.partialHead);
}

/** A thread id is a UUID; anything else is not interpolated into a glob. */
const THREAD_ID = /^[0-9a-fA-F-]{8,64}$/;

/** The thread's rollout under `<codexHome>/sessions`, or undefined. Looks at `sessions/` only. */
export function findRollout(codexHome: string, threadId: string): string | undefined {
  if (!THREAD_ID.test(threadId)) return undefined;
  const glob = new Bun.Glob(`*/*/*/rollout-*-${threadId}.jsonl`);
  let newest: string | undefined;
  try {
    for (const rel of glob.scanSync({ cwd: join(codexHome, "sessions"), onlyFiles: true })) {
      if (newest === undefined || rel > newest) newest = rel;
    }
  } catch {
    return undefined; // no sessions directory yet
  }
  return newest === undefined ? undefined : join(codexHome, "sessions", newest);
}

/**
 * Per-run reader: caches each thread's rollout path, and says why it failed at
 * most once (`onFailure`), however many turns follow. Never throws.
 */
export class CodexLastCallReader {
  private readonly paths = new Map<string, string>();
  private noted = false;

  constructor(
    private readonly codexHome: string | undefined,
    private readonly onFailure: (reason: string) => void,
    private readonly tail: { tailBytes?: number; wideBytes?: number } = {},
  ) {}

  read(threadId: string | undefined): CodexLastCall | undefined {
    try {
      if (this.codexHome === undefined || this.codexHome.length === 0) return this.fail("no CODEX_HOME");
      if (threadId === undefined) return this.fail("no thread id");
      let path = this.paths.get(threadId);
      if (path === undefined) {
        path = findRollout(this.codexHome, threadId);
        if (path === undefined) return this.fail("rollout file not found");
        this.paths.set(threadId, path);
      }
      const found = lastCallOfRollout(path, this.tail);
      return found ?? this.fail("no token_count in the rollout tail");
    } catch (err) {
      return this.fail(err instanceof Error ? err.message : String(err));
    }
  }

  private fail(reason: string): undefined {
    if (!this.noted) {
      this.noted = true;
      try {
        this.onFailure(reason);
      } catch {
        // a log line never costs a turn
      }
    }
    return undefined;
  }
}
