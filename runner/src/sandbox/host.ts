/**
 * Sandbox host: owns the child process lifecycle, the per-snippet timeout, and
 * the restart-with-state-loss path.
 *
 * Semantics, exactly:
 *  - `evalSnippet` resolves with the child's result, or with a timeout result.
 *  - A timeout does NOT kill the runtime. The evaluation is abandoned (its
 *    late result is discarded) and the child is pinged; only if the ping also
 *    goes unanswered (the event loop is blocked) is the child killed and
 *    respawned. The loss is recorded as a harness notice the model will see.
 *  - Consecutive restarts are counted for the `snippet-runaway` watchdog; a
 *    successful evaluation resets the count.
 */

import { join } from "node:path";
import type { Subprocess } from "bun";
import type { Scratchpad } from "../scratchpad";
import type { ChildToHost, EventSummary, EvalResultMsg, HostToChild, HostcallResult, LogEntry } from "./ipc";

export interface SnippetResult {
  ok: boolean;
  value?: string | undefined;
  error?: string | undefined;
  logs: LogEntry[];
  durationMs: number;
  timedOut?: boolean;
  /** Set when the timeout escalated to a kill: all sandbox state was lost. */
  restarted?: boolean;
}

export interface HarnessNotice {
  ts: number;
  kind: "sandbox_restarted" | "sandbox_started" | "session_note";
  text: string;
}

export interface SandboxHostOptions {
  moduleUrl: string;
  token: string;
  scratchpad: Scratchpad;
  snippetTimeoutMs: number;
  pingGraceMs: number;
  entryPath?: string;
  /** Called for every notice, so the loop can log it as it happens. */
  onNotice?: (notice: HarnessNotice) => void;
  now?: () => number;
}

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
}

/**
 * The environment the sandbox child is spawned with — an explicit allowlist,
 * not the runner's inherited env. The model authors the snippets and is the
 * untrusted party (entry.ts's network guard is topology, not a secret gate);
 * its exfiltration channel is the snippet result stream that flows back into
 * its own context. Inheriting `process.env` therefore leaks every provider
 * credential present in the runner (OPENROUTER_KEY, OPENCODE_KEY,
 * CLAUDE_CODE_OAUTH_TOKEN, …) to a `console.log(process.env)` snippet.
 *
 * Unlike `childEnv` in adapter-claude.ts (a denylist, because the CLI needs a
 * broad environment), this is an allowlist: the child needs only a runnable
 * `bun` (PATH), a home/temp for the runtime, and the WRATHBENCH_* knobs. The
 * SDK reads no env. WRATHBENCH_* is forwarded as a prefix so operators (and
 * the storm-control tests) can tune the fault knobs from the parent.
 */
export function sandboxChildEnv(
  parent: Record<string, string | undefined>,
  explicit: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of ["PATH", "HOME", "TMPDIR"] as const) {
    const v = parent[key];
    if (v !== undefined) out[key] = v;
  }
  for (const [k, v] of Object.entries(parent)) {
    if (v !== undefined && k.startsWith("WRATHBENCH_")) out[k] = v;
  }
  return { ...out, ...explicit };
}

/** Appended to every state-loss notice so the model knows the recovery steps. */
const STATE_LOSS_RECOVERY =
  "All top-level bindings and routines were lost. " +
  "The game session may still exist server-side under the same token: run " +
  "`await connect()` to resubscribe to events, then `await sdk.createSession({...})` " +
  "— a `token_in_use` error means the session is still alive and `sdk` works as-is.";

export class SandboxHost {
  private proc: Subprocess | null = null;
  private markReady: () => void = () => {};
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly abandonedEvals = new Set<number>();
  private ready: Promise<void> = Promise.resolve();
  private readonly notices: HarnessNotice[] = [];
  /** Consecutive restarts without an intervening successful snippet. */
  consecutiveRestarts = 0;
  totalRestarts = 0;
  /**
   * Per-child stderr holder. A fresh one is allocated in start() and closed over
   * by that child's onExit/emit, so a crash notice reads the crashed child's
   * tail even if the replacement child has already started and is refilling its
   * own buffer (a shared field would be reset to "" by start() before emit ran,
   * losing or polluting the "Last stderr" diagnostic).
   */
  private stderr: { tail: string; done: Promise<void> } = { tail: "", done: Promise.resolve() };

  constructor(private readonly opts: SandboxHostOptions) {}

  get entryPath(): string {
    return this.opts.entryPath ?? join(import.meta.dir, "entry.ts");
  }

  private notice(kind: HarnessNotice["kind"], text: string): void {
    const n: HarnessNotice = { ts: (this.opts.now ?? Date.now)(), kind, text };
    this.notices.push(n);
    if (this.notices.length > 50) this.notices.splice(0, this.notices.length - 50);
    this.opts.onNotice?.(n);
  }

  /** Notices not yet consumed by a context assembly. Drained by the loop. */
  drainNotices(): HarnessNotice[] {
    return this.notices.splice(0, this.notices.length);
  }

  async start(): Promise<void> {
    if (this.proc !== null) return;
    this.ready = new Promise((r) => {
      this.markReady = r;
    });
    const markReady = this.markReady;
    // Own this child's stderr in a fresh holder; onExit/emit close over it, not
    // over the mutable field, so the next child's start() cannot clear it.
    const stderr = { tail: "", done: Promise.resolve() };
    this.stderr = stderr;
    // --env-file=/dev/null: Bun auto-loads `.env` from the child's cwd into
    // process.env AT STARTUP, regardless of the spawn env — so a repo-root
    // `.env` (where provider keys live) would re-enter the child right past the
    // allowlist. Pointing the flag at /dev/null disables that load (verified on
    // Bun 1.4.0), making the child's env exactly `sandboxChildEnv`.
    this.proc = Bun.spawn(["bun", "--env-file=/dev/null", this.entryPath], {
      env: sandboxChildEnv(process.env, {
        WRATHBENCH_MODULE_URL: this.opts.moduleUrl,
        WRATHBENCH_TOKEN: this.opts.token,
      }),
      stdio: ["ignore", "inherit", "pipe"],
      serialization: "json",
      ipc: (message) => {
        this.onMessage(message as ChildToHost, markReady);
      },
      onExit: (sub, exitCode, signalCode) => {
        // Deliberate kills (restart/stop) null `this.proc` before killing, so a
        // match here means the child died on its own — crash, OOM, exit(). The
        // state loss must reach the model as a notice (it did not in gate2-ox-3)
        // and count toward the snippet-runaway watchdog; the next evalSnippet's
        // start() respawns lazily.
        if (sub === this.proc) {
          this.proc = null;
          this.consecutiveRestarts++;
          this.totalRestarts++;
          // Let the stderr pipe drain (briefly) so the crash output makes it
          // into the notice — Bun prints the fatal error just before exiting.
          const emit = (): void => {
            const cause = `exit code ${exitCode ?? "?"}, signal ${signalCode ?? "none"}`;
            const tail = stderr.tail.trim().slice(-600);
            this.notice(
              "sandbox_restarted",
              `sandbox process exited unexpectedly (${cause}).` +
                (tail ? ` Last stderr: ${tail}\n` : " ") +
                STATE_LOSS_RECOVERY,
            );
            this.markReady(); // never leave a start() awaiting a dead child
          };
          void Promise.race([stderr.done, new Promise((r) => setTimeout(r, 100))]).then(emit);
        }
        for (const [, p] of this.pending) p.reject(new SandboxExitedError());
        this.pending.clear();
        this.abandonedEvals.clear();
      },
    });
    stderr.done = this.pumpStderr(this.proc, stderr);
    await this.ready;
  }

  /** Mirror the child's stderr to ours while keeping a tail for crash notices. */
  private async pumpStderr(proc: Subprocess, stderr: { tail: string }): Promise<void> {
    const stream = proc.stderr;
    if (!(stream instanceof ReadableStream)) return;
    const decoder = new TextDecoder();
    try {
      for await (const chunk of stream) {
        const text = decoder.decode(chunk as Uint8Array, { stream: true });
        process.stderr.write(text);
        stderr.tail = (stderr.tail + text).slice(-4_000);
      }
    } catch {
      // stream torn down with the process; the tail keeps what we saw
    }
  }

  private onMessage(msg: ChildToHost, markReady: () => void): void {
    switch (msg.t) {
      case "ready":
        markReady();
        return;
      case "result":
      case "pong":
      case "rpc_result": {
        if (this.abandonedEvals.delete(msg.id)) return; // late result of a timed-out eval
        const p = this.pending.get(msg.id);
        if (p) {
          this.pending.delete(msg.id);
          p.resolve(msg);
        }
        return;
      }
      case "hostcall": {
        const reply = (ok: boolean, value?: unknown, error?: string): void => {
          const res: HostcallResult = { t: "hostcall_result", id: msg.id, ok, value, error };
          this.proc?.send(res);
        };
        try {
          const pad = this.opts.scratchpad;
          if (msg.method === "scratchpad_read") reply(true, pad.read());
          else if (msg.method === "scratchpad_write") reply(true, pad.write(msg.params.content ?? ""));
          else reply(true, pad.append(msg.params.content ?? ""));
        } catch (err) {
          reply(false, undefined, String(err));
        }
        return;
      }
      case "fatal":
        this.notice("session_note", `sandbox reported fatal error: ${msg.error}`);
        return;
    }
  }

  private send(msg: HostToChild): void {
    if (this.proc === null) throw new Error("sandbox not started");
    this.proc.send(msg);
  }

  private request<T extends ChildToHost>(msg: HostToChild & { id: number }, timeoutMs: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(msg.id);
        reject(new SandboxTimeoutError(msg.id));
      }, timeoutMs);
      this.pending.set(msg.id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v as T);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      try {
        this.send(msg);
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(msg.id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  /** Evaluate one snippet with the configured hard timeout. */
  async evalSnippet(code: string): Promise<SnippetResult> {
    await this.start();
    const id = this.nextId++;
    try {
      const res = await this.request<EvalResultMsg>(
        { t: "eval", id, code },
        this.opts.snippetTimeoutMs,
      );
      this.consecutiveRestarts = 0;
      return {
        ok: res.ok,
        value: res.value,
        error: res.error,
        logs: res.logs,
        durationMs: res.durationMs,
      };
    } catch (err) {
      if (err instanceof SandboxExitedError) {
        return {
          ok: false,
          restarted: true,
          error: `the sandbox process exited while this snippet was running — ${STATE_LOSS_RECOVERY}`,
          logs: [],
          durationMs: 0,
        };
      }
      if (!(err instanceof SandboxTimeoutError)) {
        return { ok: false, error: String(err), logs: [], durationMs: this.opts.snippetTimeoutMs };
      }
      // Timed out. Abandon this eval's eventual result, then check liveness.
      // The ping doubles as a log drain: the pong carries whatever the
      // abandoned snippet printed so far, so the model is not shown `logs: []`
      // for code that was in fact talking.
      this.abandonedEvals.add(id);
      const ping = await this.pingAlive();
      if (ping.alive) {
        return {
          ok: false,
          timedOut: true,
          error:
            `snippet evaluation exceeded ${this.opts.snippetTimeoutMs}ms and was abandoned; ` +
            `the runtime (bindings, routines, session) is still alive. ` +
            `Work longer than ${Math.round(this.opts.snippetTimeoutMs / 1000)}s belongs in a background ` +
            `routine (launch it without awaiting, or use setInterval, and poll it from a later snippet); ` +
            `the abandoned code may still be running, so check state/events before assuming it failed.`,
          logs: ping.logs,
          durationMs: this.opts.snippetTimeoutMs,
        };
      }
      await this.restart("a snippet blocked the event loop past the timeout");
      return {
        ok: false,
        timedOut: true,
        restarted: true,
        error:
          `snippet blocked the sandbox event loop past ${this.opts.snippetTimeoutMs}ms; ` +
          `the sandbox process was killed and restarted — ${STATE_LOSS_RECOVERY}`,
        logs: [],
        durationMs: this.opts.snippetTimeoutMs,
      };
    }
  }

  private async pingAlive(): Promise<{ alive: boolean; logs: LogEntry[] }> {
    const id = this.nextId++;
    try {
      const pong = await this.request<{ t: "pong"; id: number; logs?: LogEntry[] }>(
        { t: "ping", id },
        this.opts.pingGraceMs,
      );
      return { alive: true, logs: pong.logs ?? [] };
    } catch {
      return { alive: false, logs: [] };
    }
  }

  private async restart(reason: string): Promise<void> {
    this.consecutiveRestarts++;
    this.totalRestarts++;
    const old = this.proc;
    this.proc = null;
    this.abandonedEvals.clear();
    if (old !== null) {
      try {
        old.kill(9);
      } catch {
        // already dead
      }
    }
    await this.start();
    this.notice("sandbox_restarted", `sandbox restarted (${reason}). ${STATE_LOSS_RECOVERY}`);
  }

  /** Recent events as JSON-safe summaries, via the child's SDK event buffer. */
  async recentEvents(limit: number): Promise<EventSummary[]> {
    await this.start();
    const id = this.nextId++;
    const res = await this.request<{ t: "rpc_result"; id: number; ok: boolean; value?: unknown; error?: string }>(
      { t: "rpc", id, method: "recent_events", params: { limit } },
      5_000,
    );
    if (!res.ok) throw new Error(res.error ?? "recent_events rpc failed");
    return (res.value ?? []) as EventSummary[];
  }

  /** JSON-safe snapshot of the child's StateCache. */
  async stateSnapshot(): Promise<Record<string, unknown>> {
    await this.start();
    const id = this.nextId++;
    const res = await this.request<{ t: "rpc_result"; id: number; ok: boolean; value?: unknown; error?: string }>(
      { t: "rpc", id, method: "state_summary", params: {} },
      5_000,
    );
    if (!res.ok) throw new Error(res.error ?? "state_summary rpc failed");
    return (res.value ?? {}) as Record<string, unknown>;
  }

  async stop(): Promise<void> {
    const proc = this.proc;
    this.proc = null;
    if (proc === null) return;
    try {
      proc.send({ t: "shutdown" } satisfies HostToChild);
    } catch {
      // ignore
    }
    const exited = Promise.race([proc.exited, new Promise((r) => setTimeout(r, 1_000))]);
    await exited;
    try {
      proc.kill(9);
    } catch {
      // already gone
    }
  }
}

class SandboxExitedError extends Error {
  constructor() {
    super("sandbox process exited");
  }
}

class SandboxTimeoutError extends Error {
  constructor(readonly evalId: number) {
    super("sandbox request timed out");
  }
}
