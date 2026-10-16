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
 * `codex-usage.ts` (and a type from `subscription-usage.ts`), so tests can use
 * it without the driver.
 *
 * The same lines carry the subscription's usage windows (`rate_limits`, read by
 * `rateLimitsOfLine`), and the thread's `turn_context` lines name the model each
 * turn ran on (`turnModelOfLine`); `CodexRolloutFollower` reads both.
 *
 * The end of this file deletes rollouts (`removeThreadRollouts`,
 * `pruneRollouts`): the CLI never does, and a lane's volume filled twice.
 */
import { closeSync, fstatSync, lstatSync, openSync, readFileSync, readSync, readdirSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { normalizeCodexUsage } from "./codex-usage";
import type { UsageWindow } from "./subscription-usage";

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

// ------------------------------------------------------------ compactions

/**
 * One compaction as the Codex CLI's rollout records it (0.159.3, read off a
 * live GPT-6.1 Sol thread). In file order:
 *
 *   {"type":"event_msg","payload":{"type":"token_count","info":{"last_token_usage":{…"total_tokens":446911},"model_context_window":475000}}}
 *   {"type":"compacted","payload":{"message":"","replacement_history":[…user messages…,{"type":"compaction","encrypted_content":"…"}],
 *     "window_number":1,"latest_token_usage_record":{"usage":{"input_tokens":447305,…}},"guardian_history":[…], …}}
 *   {"type":"event_msg","payload":{"type":"token_count","info":{"last_token_usage":{…all zero…,"total_tokens":77759}}}}
 *   {"type":"event_msg","payload":{"type":"item_completed","item":{"type":"ContextCompaction",…},"started_at_ms":…,"completed_at_ms":…}}
 *
 * `message` is the summary when the CLI summarised locally; on a ChatGPT
 * login it compacts remotely and `message` is empty, the summary living only
 * in the encrypted `compaction` item. `preTokens` is the compaction call's
 * own input (`latest_token_usage_record`), else the last total reported
 * before it; `postTokens` is the first total reported after it, the CLI's own
 * estimate of the compacted context. The compacted line can exceed 1.5 MB
 * (`guardian_history` is the whole prior history), so nothing of its arrays
 * but a length and turn numbers is kept.
 */
export interface CodexCompaction {
  at: number | null;
  durationMs: number | null;
  preTokens: number | null;
  postTokens: number | null;
  /** `payload.message` when non-empty. */
  summary: string | null;
  /** Characters of the encrypted summary item, when the compaction was remote. */
  encryptedChars: number | null;
  /** The `[turn N]` of each harness context message the CLI kept verbatim. */
  retainedTurns: number[];
  window: number | null;
}

/** The context the CLI last reported: its last call's input plus output, and the window it reported. */
export interface CodexContextReading {
  total: number;
  window?: number;
}

const finite = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

/**
 * The subscription's usage windows off one rollout line (0.159.3). `codex
 * exec --json` never prints them (codex issue #14728, closed), but every
 * `token_count` the CLI persists carries the account's `rate_limits`:
 *
 *   "rate_limits":{"limit_id":…,"primary":{"used_percent":…,"window_minutes":…,"resets_at":<epoch s>},
 *                  "secondary":null,"credits":{…},"plan_type":…,"rate_limit_reached_type":null,…}
 *
 * Only `primary` and `secondary` are read, and of each only the used percent,
 * the window's length and its reset (ms here): never `credits`, `plan_type`
 * or any other field (operator, 2026-10-16). Undefined for a line that is not
 * a `token_count`, or whose `rate_limits` is null or holds no window.
 */
export function rateLimitsOfLine(line: string): UsageWindow[] | undefined {
  if (!line.includes('"rate_limits"')) return undefined;
  let rec: unknown;
  try {
    rec = JSON.parse(line);
  } catch {
    return undefined;
  }
  const payload = (rec as { payload?: { type?: unknown; rate_limits?: unknown } } | null)?.payload;
  if (payload === null || typeof payload !== "object" || payload.type !== "token_count") return undefined;
  const rl = payload.rate_limits;
  if (rl === null || typeof rl !== "object") return undefined;
  const windows: UsageWindow[] = [];
  for (const key of ["primary", "secondary"] as const) {
    const w = (rl as Record<string, unknown>)[key];
    if (w === null || typeof w !== "object") continue;
    const o = w as Record<string, unknown>;
    const used = finite(o["used_percent"]);
    if (used === undefined) continue;
    const minutes = finite(o["window_minutes"]);
    const resets = finite(o["resets_at"]);
    windows.push({ usedPercent: used, windowMinutes: minutes ?? null, resetsAt: resets !== undefined ? resets * 1000 : null });
  }
  return windows.length > 0 ? windows : undefined;
}

/**
 * The model a turn ran on, off a `turn_context` line — the CLI's own record
 * of the turn's settings, written at its start. Undefined for any other line.
 * It is the model the CLI asked for; a mid-turn reroute by the server is not
 * persisted (exec prints it on stdout, where the driver records it).
 */
export function turnModelOfLine(line: string): string | undefined {
  if (!line.includes('"turn_context"')) return undefined;
  let rec: unknown;
  try {
    rec = JSON.parse(line);
  } catch {
    return undefined;
  }
  const r = rec as { type?: unknown; payload?: { model?: unknown } } | null;
  if (r === null || r.type !== "turn_context") return undefined;
  const model = r.payload?.model;
  return typeof model === "string" && model.length > 0 ? model : undefined;
}

/** A `token_count` line's last-call total and reported window; undefined for any other line. */
export function tokenCountOfLine(line: string): CodexContextReading | undefined {
  if (!line.includes('"token_count"')) return undefined;
  let rec: unknown;
  try {
    rec = JSON.parse(line);
  } catch {
    return undefined;
  }
  const payload = (rec as { payload?: { type?: unknown; info?: unknown } } | null)?.payload;
  if (payload === null || typeof payload !== "object" || payload.type !== "token_count") return undefined;
  const info = payload.info as Record<string, unknown> | null | undefined;
  if (info === null || typeof info !== "object") return undefined;
  const last = info["last_token_usage"] as Record<string, unknown> | null | undefined;
  if (last === null || typeof last !== "object") return undefined;
  const total = finite(last["total_tokens"]) ?? (finite(last["input_tokens"]) ?? 0) + (finite(last["output_tokens"]) ?? 0);
  const window = finite(info["model_context_window"]);
  return window !== undefined && window > 0 ? { total, window } : { total };
}

/** The `[turn N]` prefix of a retained harness context message (`assembleContext`). */
const TURN_PREFIX = /^\[turn (\d+)\]/;

type PendingCompaction = Partial<CodexCompaction> & { seenCompacted: boolean; awaitingPost: boolean };

/**
 * Folds rollout lines, in file order, into compactions and the latest context
 * reading. Pure apart from its own state, so a compaction whose lines
 * straddle two reads is still one compaction. Lines that cannot matter are
 * passed over on a substring test, before any parse.
 */
export class CodexRolloutScan {
  /** The newest `token_count` seen, if any. */
  context: CodexContextReading | undefined;
  /** The newest usage windows a `token_count` carried (`rateLimitsOfLine`); a null `rate_limits` leaves them as they were. */
  rateLimits: UsageWindow[] | undefined;
  /** The model the newest `turn_context` names. */
  model: string | undefined;
  private pending: PendingCompaction | null = null;
  private readonly done: CodexCompaction[] = [];

  line(line: string): void {
    if (line.includes('"turn_context"')) {
      const model = turnModelOfLine(line);
      if (model !== undefined) {
        this.model = model;
        return;
      }
    }
    if (line.includes('"token_count"')) {
      this.rateLimits = rateLimitsOfLine(line) ?? this.rateLimits;
      const reading = tokenCountOfLine(line);
      if (reading === undefined) return;
      const window = reading.window ?? this.context?.window;
      this.context = window !== undefined ? { total: reading.total, window } : { total: reading.total };
      if (this.pending?.awaitingPost === true) {
        this.pending.postTokens = reading.total;
        this.pending.awaitingPost = false;
      }
      return;
    }
    if (line.includes('"type":"compacted"')) this.compacted(line);
    else if (line.includes('"ContextCompaction"')) this.compactionItem(line);
  }

  private compacted(line: string): void {
    let rec: { type?: unknown; payload?: Record<string, unknown> | null };
    try {
      rec = JSON.parse(line) as typeof rec;
    } catch {
      return;
    }
    const p = rec.payload;
    if (rec.type !== "compacted" || p === undefined || p === null || typeof p !== "object") return;
    // A second compacted line closes the one before it.
    if (this.pending?.seenCompacted === true) this.settle();
    const usage = (p["latest_token_usage_record"] as { usage?: Record<string, unknown> } | null | undefined)?.usage;
    const history = Array.isArray(p["replacement_history"]) ? (p["replacement_history"] as unknown[]) : [];
    let encryptedChars: number | null = null;
    const retainedTurns: number[] = [];
    for (const raw of history) {
      if (raw === null || typeof raw !== "object") continue;
      const item = raw as Record<string, unknown>;
      if (item["type"] === "compaction" && typeof item["encrypted_content"] === "string") {
        encryptedChars = (encryptedChars ?? 0) + (item["encrypted_content"] as string).length;
      } else if (item["type"] === "message" && item["role"] === "user" && Array.isArray(item["content"])) {
        const first = (item["content"] as { text?: unknown }[])[0]?.text;
        const m = typeof first === "string" ? TURN_PREFIX.exec(first) : null;
        if (m !== null) retainedTurns.push(Number(m[1]));
      }
    }
    const message = typeof p["message"] === "string" && p["message"].length > 0 ? p["message"] : null;
    this.pending = {
      ...(this.pending ?? {}),
      seenCompacted: true,
      awaitingPost: true,
      preTokens: finite(usage?.["input_tokens"]) ?? this.context?.total ?? null,
      postTokens: null,
      summary: message,
      encryptedChars,
      retainedTurns,
      window: finite(p["window_number"]) ?? null,
    };
  }

  private compactionItem(line: string): void {
    let rec: { payload?: Record<string, unknown> | null };
    try {
      rec = JSON.parse(line) as typeof rec;
    } catch {
      return;
    }
    const p = rec.payload;
    if (p === undefined || p === null || p["type"] !== "item_completed") return;
    if ((p["item"] as { type?: unknown } | null | undefined)?.type !== "ContextCompaction") return;
    const started = finite(p["started_at_ms"]);
    const completed = finite(p["completed_at_ms"]);
    const timing = {
      at: started ?? null,
      durationMs: started !== undefined && completed !== undefined ? Math.max(0, completed - started) : null,
    };
    if (this.pending === null) this.pending = { seenCompacted: false, awaitingPost: false, ...timing };
    else Object.assign(this.pending, timing);
  }

  private settle(): void {
    const p = this.pending;
    this.pending = null;
    if (p === null || !p.seenCompacted) return;
    this.done.push({
      at: p.at ?? null,
      durationMs: p.durationMs ?? null,
      preTokens: p.preTokens ?? null,
      postTokens: p.postTokens ?? null,
      summary: p.summary ?? null,
      encryptedChars: p.encryptedChars ?? null,
      retainedTurns: p.retainedTurns ?? [],
      window: p.window ?? null,
    });
  }

  /**
   * The compactions settled so far, oldest first. With `final` one still open
   * is settled as it stands: at the end of a turn the CLI has exited, so every
   * line it wrote for that compaction is already on disk. A timing item that
   * never met a compacted line is not a compaction and is dropped.
   */
  drain(final: boolean): CodexCompaction[] {
    if (final) this.settle();
    return this.done.splice(0, this.done.length);
  }
}

/** What one `CodexRolloutFollower.read` answers. */
export interface CodexRolloutRead {
  compactions: CodexCompaction[];
  context: CodexContextReading | undefined;
  /** The newest usage windows on the thread (`rateLimitsOfLine`). */
  rateLimits: UsageWindow[] | undefined;
  /** The model the thread's newest `turn_context` names. */
  model: string | undefined;
}

/** How much of the rollout one read step takes. */
export const ROLLOUT_FOLLOW_CHUNK_BYTES = 4 * 1024 * 1024;

/**
 * Follows one thread's rollout across turns: each `read` parses only the
 * bytes the CLI appended since the last one, so every compaction is seen
 * exactly once whatever the file's size. A new thread starts over on its own
 * file. Like `CodexLastCallReader` it touches `sessions/**` only, says why it
 * failed at most once, and never throws.
 */
export class CodexRolloutFollower {
  private threadId: string | undefined;
  private path: string | undefined;
  private offset = 0;
  private carry = "";
  private decoder = new TextDecoder();
  private scan = new CodexRolloutScan();
  private noted = false;

  constructor(
    private readonly codexHome: string | undefined,
    private readonly onFailure: (reason: string) => void,
    private readonly chunkBytes = ROLLOUT_FOLLOW_CHUNK_BYTES,
  ) {}

  /**
   * What the CLI appended since the last read: its compactions, and the newest
   * context reading, usage windows and turn model so far on this thread.
   */
  read(threadId: string | undefined): CodexRolloutRead {
    try {
      if (this.codexHome === undefined || this.codexHome.length === 0) return this.fail("no CODEX_HOME");
      if (threadId === undefined) return this.fail("no thread id");
      if (threadId !== this.threadId) {
        this.threadId = threadId;
        this.path = undefined;
        this.restart();
        this.scan = new CodexRolloutScan();
      }
      this.path ??= findRollout(this.codexHome, threadId);
      if (this.path === undefined) return this.fail("rollout file not found");
      const fd = openSync(this.path, "r");
      try {
        const size = fstatSync(fd).size;
        // A file shorter than what was read is a different file: start it over.
        if (size < this.offset) this.restart();
        const buf = Buffer.alloc(Math.min(this.chunkBytes, Math.max(0, size - this.offset)));
        while (this.offset < size && buf.length > 0) {
          const n = readSync(fd, buf, 0, Math.min(buf.length, size - this.offset), this.offset);
          if (n <= 0) break;
          this.offset += n;
          const lines = (this.carry + this.decoder.decode(buf.subarray(0, n), { stream: true })).split("\n");
          this.carry = lines.pop() ?? "";
          for (const l of lines) this.scan.line(l);
        }
      } finally {
        closeSync(fd);
      }
      return { compactions: this.scan.drain(true), context: this.scan.context, rateLimits: this.scan.rateLimits, model: this.scan.model };
    } catch (err) {
      return this.fail(err instanceof Error ? err.message : String(err));
    }
  }

  private restart(): void {
    this.offset = 0;
    this.carry = "";
    this.decoder = new TextDecoder();
  }

  private fail(reason: string): CodexRolloutRead {
    if (!this.noted) {
      this.noted = true;
      try {
        this.onFailure(reason);
      } catch {
        // a log line never costs a turn
      }
    }
    return { compactions: [], context: undefined, rateLimits: undefined, model: undefined };
  }
}

// ------------------------------------------------------------- deletion

/**
 * Rollouts are deleted when their thread is done with, never archived
 * (operator, 2026-10-16). The CLI keeps one per thread and never removes one;
 * a lane's volume filled twice. Nothing reads a rollout once its thread is
 * finished: what the driver takes from one — compactions, the last call's
 * context, the usage windows, the turn model — is on the trajectory by then,
 * and `exec resume` is only ever pointed at the thread the live episode is on,
 * because every resume of a run starts a new thread (`run.ts`, `resumedFresh`).
 * So:
 *
 * - the driver deletes its own: an old thread's when the episode moves to a
 *   new one, and every one at the episode's end, after the last read
 *   (`removeThreadRollouts`);
 * - the supervisor sweeps up after a runner killed outright: every rollout
 *   that is not the recorded thread of a run with a live owner, and that has
 *   not been written for `ROLLOUT_PRUNE_MIN_AGE_MS` (`pruneRollouts`).
 *
 * Only `sessions/YYYY/MM/DD/rollout-*.jsonl` files are deleted, then the date
 * directories they leave empty; never `auth.json`, the CLI's config or its
 * sqlite stores. Neither ever throws.
 *
 * The CLI's state db keeps its row for a deleted thread, and says "state db
 * returned stale rollout path for thread …" when it next looks one up — the
 * first `exec` of a new thread does, once per old shell snapshot, while it
 * clears those — which `detectCodexFailure` does not classify.
 */

/** The thread a run is on: a sidecar in its run directory, rewritten by the driver when the thread changes. */
export const CODEX_THREAD_FILE = "codex-thread.json";

/** Record the thread a run is on now. Best effort: a failed write leaves the sweep's age floor as the guard. */
export function writeCodexThread(runDir: string, threadId: string, now = Date.now()): void {
  try {
    writeFileSync(join(runDir, CODEX_THREAD_FILE), `${JSON.stringify({ threadId, since: now })}\n`, "utf8");
  } catch {
    // a run directory that cannot be written has bigger problems; never a turn's
  }
}

/** The thread a run last recorded, or undefined when it recorded none. */
export function readCodexThread(runDir: string): string | undefined {
  try {
    const v = (JSON.parse(readFileSync(join(runDir, CODEX_THREAD_FILE), "utf8")) as { threadId?: unknown } | null)?.threadId;
    return typeof v === "string" && v.length > 0 ? v : undefined;
  } catch {
    return undefined;
  }
}

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
/**
 * A rollout's file name as the pinned CLI parses it (`rollout_file_name.rs`):
 * `rollout-<YYYY-MM-DDTHH-MM-SS>-<thread>.jsonl`, or `…-<thread>_<rollout>.jsonl`
 * for a further rollout of the same thread (a revert, which exec never makes).
 */
const ROLLOUT_NAME = new RegExp(`^rollout-\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2}-(${UUID})(?:_${UUID})?\\.jsonl$`, "i");

/** The thread a rollout file name belongs to, lowercased, or undefined for any other name. */
export function rolloutThreadId(name: string): string | undefined {
  return ROLLOUT_NAME.exec(name)?.[1]?.toLowerCase();
}

/** What a deletion removed; `error` is the first failure's message. */
export interface RolloutRemoval {
  files: number;
  bytes: number;
  errors: number;
  error?: string;
}

function failed(out: RolloutRemoval, err: unknown): void {
  out.errors++;
  out.error ??= err instanceof Error ? err.message : String(err);
}

const errCode = (err: unknown): unknown => (err as { code?: unknown } | null)?.code;

/** Unlink one regular file and count it; a symlink or anything else is left where it is. */
function unlinkRollout(path: string, out: RolloutRemoval): void {
  try {
    const st = lstatSync(path);
    if (!st.isFile()) return;
    unlinkSync(path);
    out.files++;
    out.bytes += st.size;
  } catch (err) {
    if (errCode(err) !== "ENOENT") failed(out, err);
  }
}

/** Delete every rollout of one thread under `<codexHome>/sessions`, whatever its age. Never throws. */
export function removeThreadRollouts(codexHome: string | undefined, threadId: string): RolloutRemoval {
  const out: RolloutRemoval = { files: 0, bytes: 0, errors: 0 };
  if (codexHome === undefined || codexHome.length === 0 || !THREAD_ID.test(threadId)) return out;
  const sessions = join(codexHome, "sessions");
  try {
    if (!lstatSync(sessions).isDirectory()) return out;
  } catch {
    return out; // no sessions directory: nothing was written
  }
  try {
    // The thread's own file, and any further rollout of it (`<thread>_<rollout>`).
    const glob = new Bun.Glob(`*/*/*/rollout-*-${threadId}{,_*}.jsonl`);
    for (const rel of glob.scanSync({ cwd: sessions, onlyFiles: true })) unlinkRollout(join(sessions, rel), out);
  } catch (err) {
    failed(out, err);
  }
  return out;
}

/**
 * How long a rollout must have gone unwritten before the sweep may delete one
 * no live run claims. It covers what ownership cannot see: the moment between
 * the CLI creating a thread's rollout and the driver recording the thread, a
 * failed sidecar write, and a `codex` session run by hand on the lane.
 */
export const ROLLOUT_PRUNE_MIN_AGE_MS = 2 * 60 * 60_000;

/** What a sweep did: files and bytes removed, rollouts kept, date directories removed. */
export interface RolloutPrune extends RolloutRemoval {
  kept: number;
  dirs: number;
}

const pad2 = (n: number): string => String(n).padStart(2, "0");

/** `YYYY/MM/DD` of today and yesterday, in UTC and in local time: the date directories the CLI may be writing into. */
function currentDays(now: number): string[] {
  const out = new Set<string>();
  for (const t of [now, now - 24 * 60 * 60_000]) {
    const d = new Date(t);
    out.add(`${d.getUTCFullYear()}/${pad2(d.getUTCMonth() + 1)}/${pad2(d.getUTCDate())}`);
    out.add(`${d.getFullYear()}/${pad2(d.getMonth() + 1)}/${pad2(d.getDate())}`);
  }
  return [...out];
}

/**
 * The supervisor's sweep of one Codex home. A rollout goes when its thread is
 * not in `keep` (the recorded threads of every run with a live owner) AND it
 * has not been written for `minAgeMs`. A date directory goes when it is empty,
 * has not changed for as long, and is not today's or yesterday's or one of
 * their parents: the CLI creates the directory and then the file, so an empty
 * current one may be about to fill. Nothing under `sessions/` that is not a
 * date directory or a rollout is looked at. Never throws: a failure is counted
 * and the sweep goes on.
 */
export function pruneRollouts(codexHome: string, o: { keep: ReadonlySet<string>; now: number; minAgeMs?: number }): RolloutPrune {
  const out: RolloutPrune = { files: 0, bytes: 0, errors: 0, kept: 0, dirs: 0 };
  const minAge = o.minAgeMs ?? ROLLOUT_PRUNE_MIN_AGE_MS;
  const keep = new Set([...o.keep].map((t) => t.toLowerCase()));
  const current = currentDays(o.now);
  const settled = (mtimeMs: number): boolean => o.now - mtimeMs >= minAge;
  const removeDirIfDone = (path: string, key: string): void => {
    if (current.some((day) => day === key || day.startsWith(`${key}/`))) return;
    try {
      if (readdirSync(path).length > 0 || !settled(lstatSync(path).mtimeMs)) return;
      rmdirSync(path);
      out.dirs++;
    } catch {
      // filled again in between, or already gone: not the sweep's to force
    }
  };
  const walk = (dir: string, key: string, depth: number): void => {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch (err) {
      if (errCode(err) !== "ENOENT") failed(out, err);
      return;
    }
    for (const name of names) {
      const path = join(dir, name);
      if (depth < 3) {
        if (!(depth === 0 ? /^\d{4}$/ : /^\d{2}$/).test(name)) continue;
        try {
          if (!lstatSync(path).isDirectory()) continue;
        } catch {
          continue;
        }
        const sub = key === "" ? name : `${key}/${name}`;
        walk(path, sub, depth + 1);
        removeDirIfDone(path, sub);
        continue;
      }
      const thread = rolloutThreadId(name);
      if (thread === undefined) continue;
      try {
        const st = lstatSync(path);
        if (!st.isFile()) continue;
        if (keep.has(thread) || !settled(st.mtimeMs)) {
          out.kept++;
          continue;
        }
      } catch (err) {
        if (errCode(err) !== "ENOENT") failed(out, err);
        continue;
      }
      unlinkRollout(path, out);
    }
  };
  try {
    walk(join(codexHome, "sessions"), "", 0);
  } catch (err) {
    failed(out, err);
  }
  return out;
}
