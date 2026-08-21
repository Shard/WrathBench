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

export class SandboxHost {
  private proc: Subprocess | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly abandonedEvals = new Set<number>();
  private ready: Promise<void> = Promise.resolve();
  private readonly notices: HarnessNotice[] = [];
  /** Consecutive restarts without an intervening successful snippet. */
  consecutiveRestarts = 0;
  totalRestarts = 0;

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
    let markReady: () => void = () => {};
    this.ready = new Promise((r) => {
      markReady = r;
    });
    this.proc = Bun.spawn(["bun", this.entryPath], {
      env: {
        ...process.env,
        WRATHBENCH_MODULE_URL: this.opts.moduleUrl,
        WRATHBENCH_TOKEN: this.opts.token,
      },
      stdio: ["ignore", "inherit", "inherit"],
      serialization: "json",
      ipc: (message) => {
        this.onMessage(message as ChildToHost, markReady);
      },
      onExit: () => {
        // Reject anything still pending; a restart decides what happens next.
        for (const [, p] of this.pending) p.reject(new Error("sandbox process exited"));
        this.pending.clear();
      },
    });
    await this.ready;
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
      if (!(err instanceof SandboxTimeoutError)) {
        return { ok: false, error: String(err), logs: [], durationMs: this.opts.snippetTimeoutMs };
      }
      // Timed out. Abandon this eval's eventual result, then check liveness.
      this.abandonedEvals.add(id);
      const alive = await this.pingAlive();
      if (alive) {
        return {
          ok: false,
          timedOut: true,
          error: `snippet evaluation exceeded ${this.opts.snippetTimeoutMs}ms and was abandoned; the runtime (bindings, routines, session) is still alive`,
          logs: [],
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
          `the sandbox process was killed and restarted — all top-level bindings, running ` +
          `routines, and the in-process SDK connection were lost`,
        logs: [],
        durationMs: this.opts.snippetTimeoutMs,
      };
    }
  }

  private async pingAlive(): Promise<boolean> {
    const id = this.nextId++;
    try {
      await this.request<{ t: "pong"; id: number }>({ t: "ping", id }, this.opts.pingGraceMs);
      return true;
    } catch {
      return false;
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
    this.notice(
      "sandbox_restarted",
      `sandbox restarted (${reason}). All top-level bindings and routines were lost. ` +
        `The game session may still exist server-side under the same token: run ` +
        `\`await connect()\` to resubscribe to events, then \`await sdk.createSession({...})\` ` +
        `— a \`token_in_use\` error means the session is still alive and \`sdk\` works as-is.`,
    );
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

class SandboxTimeoutError extends Error {
  constructor(readonly evalId: number) {
    super("sandbox request timed out");
  }
}
