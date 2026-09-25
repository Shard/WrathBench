/**
 * Sandbox host: owns the child process lifecycle, the per-snippet timeout, and
 * the restart-with-state-loss path.
 *
 * Semantics, exactly:
 *  - `evalSnippet` resolves with the child's result, or with a timeout result.
 *  - A timeout does NOT kill the runtime. The evaluation is abandoned (its
 *    late result is discarded), its abort signal is fired in the child (so the
 *    SDK waits it left behind settle and an in-flight move is stopped),
 *    and the child is pinged; only if the ping also goes
 *    unanswered (the event loop is blocked) is the child killed and respawned.
 *    The loss is recorded as a harness notice the model will see.
 *  - Consecutive restarts are counted for the `snippet-runaway` watchdog; a
 *    successful evaluation resets the count.
 *  - The first snippet result from a new sandbox process — after a restart,
 *    an unexpected exit, or on a resumed run — begins with a one-line state-reset
 *    notice (`STATE_RESET_NOTICE`), so the model learns its bindings and
 *    routines are gone from the result it is reading, not a turn later.
 *  - The workspace is this process's to write. The child's `files` calls
 *    arrive as hostcalls and are answered from the one `Workspace`, and every
 *    change to an importable file, from a hostcall or a tool, is announced to
 *    the child as a new import version before anything else is said to it.
 */

import { join } from "node:path";
import type { Subprocess } from "bun";
import { SNIPPET_VOCABULARY, type Workspace, type WorkspaceResult } from "../workspace";
import type {
  ActionHintNote,
  ChildToHost,
  DeathSignal,
  DeployAnswer,
  EventSummary,
  EvalResultMsg,
  HostToChild,
  HostcallResult,
  LogEntry,
  ProgramErrorNote,
  ProgramReport,
} from "./ipc";
import { MAIN_PATH, PROGRAM_LIMITS, PROGRAM_LIMITS_ENV, type ProgramLimits } from "./program";

export interface SnippetResult {
  ok: boolean;
  value?: string | undefined;
  error?: string | undefined;
  /** A note about the completion value; see `EvalResultMsg.hint`. */
  hint?: string | undefined;
  /**
   * Hint-bearing action failures the SDK recorded while the snippet ran. The
   * harness renders these itself (tools.ts) because the hint inside the result
   * object only reaches the model if the snippet's own code kept it.
   */
  actionHints?: ActionHintNote[] | undefined;
  logs: LogEntry[];
  durationMs: number;
  timedOut?: boolean;
  /** Set when the timeout escalated to a kill: all sandbox state was lost. */
  restarted?: boolean;
  /**
   * Set on the first result from a new sandbox process (after a restart, or
   * on a resumed run): the line the rendered result must begin with.
   */
  resetNotice?: string | undefined;
}

export interface HarnessNotice {
  ts: number;
  kind:
    | "sandbox_restarted"
    | "sandbox_started"
    | "session_note"
    | "provider_truncated"
    // The fixed loop's message window dropped a block of older messages
    // (context.ts, `messageWindowCut`). Never raised by the claude-code
    // driver, which runs no window of ours.
    | "window_trimmed"
    // The turn before the block trim is expected: the harness asks for an
    // episodic status entry (METHODOLOGY, "An episodic log"). Fixed-loop only.
    | "trim_pending"
    // A reflection window closed on its circuit breaker (`reflect.ts`).
    | "reflect_ended";
  text: string;
}

export interface SandboxHostOptions {
  moduleUrl: string;
  token: string;
  /**
   * The session secret leased for `token` (module/PROTOCOL.md,
   * "Authentication"), forwarded to the child as `WRATHBENCH_SECRET` and
   * bound onto its SDK client. The only credential the child holds: it
   * reaches this token's session and nothing else. Undefined (tests, a
   * pre-auth module) sends the child in with no credential.
   */
  secret?: string;
  /**
   * The game account this run occupies, forwarded to the child as
   * `WRATHBENCH_ACCOUNT` and bound onto the SDK client. Operator
   * infra like `token`: it makes `sdk.createSession`/`deleteCharacter` land on
   * the assigned account regardless of what a snippet passes. Undefined leaves
   * the client unbound (standalone behavior).
   */
  account?: string;
  /**
   * The run's workspace. Required: the child is granted read access to its
   * directory when it is spawned, and answers every `files` call from it.
   */
  workspace: Workspace;
  /**
   * The run resumed (or continued) with state a new sandbox does not have:
   * the first snippet result carries the state-reset notice even though this
   * host never restarted anything itself.
   */
  resumed?: boolean;
  snippetTimeoutMs: number;
  pingGraceMs: number;
  /**
   * Which agent loop the run is under. `entrypoint` (a probing spike) makes the
   * child run snippets as one-offs that own what they start, and hosts the
   * model's program; absent or `snippet` is the snippet loop, unchanged.
   */
  loop?: "snippet" | "entrypoint";
  /** Entrypoint loop: the program's limits, for tests; the defaults are `PROGRAM_LIMITS`. */
  program?: Partial<ProgramLimits>;
  /** Entrypoint loop: the report cadence and the block grace, for tests (`PROGRAM_POLL_MS`, `BLOCK_GRACE_MS`). */
  heartbeat?: { pollMs?: number; blockGraceMs?: number };
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
 *
 * Two holes the prefix forwarding would otherwise open are closed here, at the
 * one place every snippet child is spawned, rather than by keeping the values
 * off a service. WRATHBENCH_DB_*: the `fleet` and `runner` services carry the
 * database host/user/password so the preflight gate's smokes can stage a
 * fixture, and an episode is a child of one of those; root on acore_characters
 * is exactly the server-side shortcut docs/CONTRACTS.md forbids — a snippet
 * holding it could write its own level and money. WRATHBENCH_MODULE_SECRET:
 * the module's port secret (module/PROTOCOL.md "Authentication"), which the
 * host process holds from `.env`; a snippet holding it could lease, list and
 * delete on any allowlisted account. The child gets its own per-token session
 * secret instead (`WRATHBENCH_SECRET`, passed explicitly below).
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
    if (v === undefined || !k.startsWith("WRATHBENCH_")) continue;
    if (k.startsWith("WRATHBENCH_DB_") || k === "WRATHBENCH_MODULE_SECRET") continue;
    // The loop is the run's, set explicitly by the host for an entrypoint run
    // only: a stray value in the operator's shell must never switch a
    // snippet-loop sandbox into the other loop.
    if (k === "WRATHBENCH_LOOP") continue;
    out[k] = v;
  }
  return { ...out, ...explicit };
}

/** Appended to every state-loss notice so the model knows the recovery steps. */
export const STATE_LOSS_RECOVERY =
  "Top-level bindings and background routines lived only in that sandbox and are gone; " +
  "your workspace files, notes.md included, are unchanged, so import what you need again. " +
  "The game session may still exist server-side under the same token: run " +
  "`await connect()` to resubscribe to events, then `await sdk.createSession({...})` " +
  "— a `token_in_use` error means the session is still alive and `sdk` works as-is.";

/**
 * The first line of the first snippet result a new sandbox process returns.
 * One line, and first, because it is the fact the model most needs before it
 * reads anything else in that result: a name that resolved a snippet ago may
 * not resolve now.
 */
export const STATE_RESET_NOTICE =
  "[state reset] this snippet ran in a new sandbox: top-level bindings and background routines from before are gone; workspace files are unchanged.";

/**
 * The entrypoint loop's versions of the two strings above (a probing spike).
 * A snippet there leaves nothing behind, so what a restart loses is only what
 * was running: the program, which the harness loads again itself.
 */
export const STATE_LOSS_RECOVERY_ENTRYPOINT =
  "Nothing that was running in that sandbox survived it; your workspace files, notes.md and memory.json included, are unchanged. " +
  "The game session may still exist server-side under the same token: run " +
  "`await connect()` to resubscribe to events, then `await sdk.createSession({...})` " +
  "— a `token_in_use` error means the session is still alive and `sdk` works as-is.";

export const STATE_RESET_NOTICE_ENTRYPOINT =
  "[state reset] this snippet ran in a new sandbox: nothing from the old one is running; workspace files and memory.json are unchanged.";

/** How often the entrypoint loop's host drains the program's report — which is also its liveness check. */
export const PROGRAM_POLL_MS = 1_000;
/** How long a report may go unanswered before the child is taken to have blocked its event loop. */
export const BLOCK_GRACE_MS = 10_000;

/**
 * The program as the host tracks it. `halted`: it blocked the event loop, the
 * sandbox was restarted, and it waits for the model's next yield. `stopped`:
 * the sandbox restarted for another reason while files had changed since the
 * deploy, so reloading would run code the model has not yet ended its turn on.
 */
export type ProgramState =
  | { kind: "none" }
  | { kind: "running"; deploy: number; version: number; at: number }
  | { kind: "halted"; deploy: number; version: number; at: number; since: number }
  | { kind: "stopped"; deploy: number; version: number; at: number; since: number };

/** What the host tells the loop about the program between reports. */
export type ProgramHostEvent =
  | { kind: "report"; report: ProgramReport }
  | { kind: "halted"; deploy: number; at: number }
  | { kind: "restart"; cause: "snippet" | "exit"; at: number; detail: string }
  | { kind: "reload"; deploy: number; version: number; at: number; answer: DeployAnswer }
  | { kind: "stopped"; deploy: number; at: number };

/** One deploy the loop asked for at a yield, as the trajectory records it. */
export interface DeployRecord {
  deploy: number;
  version: number;
  ok: boolean;
  error?: string;
  exports?: string[];
  /** What the deploy did to the program: loaded it, unloaded it (main.ts is gone), or failed. */
  action: "load" | "unload";
}

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
  /**
   * Whether the next snippet result is the first from a sandbox that lost
   * state. Taken when an eval starts, so the snippet whose timeout caused a
   * restart never carries it — the one after does.
   */
  private resetPending: boolean;

  // ---- the entrypoint loop (a probing spike); all idle in the snippet loop
  /** The program as the host knows it. */
  programState: ProgramState = { kind: "none" };
  /** The number the last deploy attempt was given; the next one is one more. */
  private deploys = 0;
  /** The import version the last deploy attempt loaded (or failed to); null before the first. */
  private lastAttemptedVersion: number | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private beating = false;
  /** Set by `stop()`: nothing respawns or reloads after it. */
  private stopping = false;
  /** Snippet evaluations in flight: a block while one runs is the snippet's. */
  private evalsInFlight = 0;
  /** The child was killed because a snippet blocked it: that snippet's result says so. */
  private killedForSnippetBlock = false;
  private readonly programListeners = new Set<(e: ProgramHostEvent) => void>();

  constructor(private readonly opts: SandboxHostOptions) {
    this.resetPending = opts.resumed === true;
    // Every import-version bump, whoever caused it, reaches the child before
    // anything else is said to it — for a hostcall, before the reply to the
    // call that made it.
    opts.workspace.onImportVersion((version) => {
      try {
        this.proc?.send({ t: "workspace_version", version } satisfies HostToChild);
      } catch {
        // the child is gone; a new one starts with an empty module registry
      }
    });
  }

  /** Whether this sandbox runs the entrypoint loop (`SandboxHostOptions.loop`). */
  get entrypoint(): boolean {
    return this.opts.loop === "entrypoint";
  }

  /** The program's limits, always set explicitly so a stray value in the operator's shell never wins. */
  get programLimits(): ProgramLimits {
    return { ...PROGRAM_LIMITS, ...this.opts.program };
  }

  private programEnv(): Record<string, string> {
    const limits = this.programLimits;
    const out: Record<string, string> = {};
    for (const k of Object.keys(PROGRAM_LIMITS_ENV) as (keyof ProgramLimits)[]) out[PROGRAM_LIMITS_ENV[k]] = String(limits[k]);
    return out;
  }

  get entryPath(): string {
    return this.opts.entryPath ?? join(import.meta.dir, "entry.ts");
  }

  /** The Landlock wrapper the child is exec'd through (see start()). */
  get confinePath(): string {
    return join(import.meta.dir, "confine.ts");
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
    //
    // The child is exec'd through confine.ts, which applies a Landlock
    // filesystem ruleset first: the snippet process can then
    // read the interpreter, runner/, sdk/, node_modules/ and the run's
    // workspace and nothing else — not `.env` by any path, not $HOME, not
    // /tmp — and write nowhere; the wrapper exits instead of exec'ing when the
    // kernel or container refuses the ruleset.
    // The IPC channel and stdio are inherited descriptors and survive the exec.
    this.proc = Bun.spawn(["bun", this.confinePath, "bun", "--env-file=/dev/null", this.entryPath], {
      env: sandboxChildEnv(process.env, {
        WRATHBENCH_MODULE_URL: this.opts.moduleUrl,
        WRATHBENCH_TOKEN: this.opts.token,
        // Explicit, like the two below: confine.ts grants read access to this
        // directory, so a stray value from the operator's shell must never
        // stand in for the run's own.
        WRATHBENCH_WORKSPACE: this.opts.workspace.dir,
        // Explicit and possibly empty, for the same reason as WRATHBENCH_ACCOUNT
        // below: nothing leaked from the operator's shell may stand in for it.
        WRATHBENCH_SECRET: this.opts.secret ?? "",
        // Always set explicitly (empty when unbound) so it wins over any
        // WRATHBENCH_ACCOUNT that leaked in from the operator's own shell via
        // sandboxChildEnv's WRATHBENCH_* forwarding — the child must bind only
        // the account this run was actually assigned, never a stray one.
        WRATHBENCH_ACCOUNT: this.opts.account ?? "",
        ...(this.entrypoint ? { WRATHBENCH_LOOP: "entrypoint", ...this.programEnv() } : {}),
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
          this.resetPending = true;
          // Let the stderr pipe drain (briefly) so the crash output makes it
          // into the notice — Bun prints the fatal error just before exiting.
          const emit = (): void => {
            const cause = `exit code ${exitCode ?? "?"}, signal ${signalCode ?? "none"}`;
            const tail = stderr.tail.trim().slice(-600);
            this.notice(
              "sandbox_restarted",
              `sandbox process exited unexpectedly (${cause}).` +
                (tail ? ` Last stderr: ${tail}\n` : " ") +
                this.lossRecovery,
            );
            this.markReady(); // never leave a start() awaiting a dead child
            // Entrypoint loop: the program runs whether the model is awake or
            // not, so a dead child is brought back at once and its program
            // with it, and the loop is told (a `restart` wake).
            if (this.entrypoint && !this.stopping) {
              this.emitProgram({ kind: "restart", cause: "exit", at: this.nowMs(), detail: `the sandbox process exited unexpectedly (${cause})` });
              void this.start().then(() => this.reloadAfterRestart()).catch(() => undefined);
            }
          };
          void Promise.race([stderr.done, new Promise((r) => setTimeout(r, 100))]).then(emit);
        }
        for (const [, p] of this.pending) p.reject(new SandboxExitedError());
        this.pending.clear();
        this.abandonedEvals.clear();
      },
    });
    stderr.done = this.pumpStderr(this.proc, stderr);
    const proc = this.proc;
    await this.ready;
    if (this.entrypoint && proc !== null && proc === this.proc) {
      // A new child starts at import version 0; tell it the current one, so a
      // snippet's import and the next deploy load one graph of the same files,
      // not two.
      try {
        proc.send({ t: "workspace_version", version: this.opts.workspace.importVersion } satisfies HostToChild);
      } catch {
        // gone already; its exit is handled where exits are
      }
      this.startHeartbeat();
    }
  }

  // ------------------------------------------------------ entrypoint heartbeat

  /** The recovery sentence a state-loss notice ends with, for this sandbox's loop. */
  get lossRecovery(): string {
    return this.entrypoint ? STATE_LOSS_RECOVERY_ENTRYPOINT : STATE_LOSS_RECOVERY;
  }

  private nowMs(): number {
    return (this.opts.now ?? Date.now)();
  }

  /** Hear about the program between reports: every report, halts, restarts, reloads. */
  onProgramEvent(listener: (e: ProgramHostEvent) => void): () => void {
    this.programListeners.add(listener);
    return () => this.programListeners.delete(listener);
  }

  private emitProgram(e: ProgramHostEvent): void {
    for (const l of this.programListeners) {
      try {
        l(e);
      } catch {
        // a listener's fault is its own
      }
    }
  }

  /**
   * The report drain on a timer: what the program did reaches the loop about
   * once a second, asleep or awake, and a child that cannot answer within the
   * grace has blocked its event loop. Unref'd; stopped by `stop()`.
   */
  private startHeartbeat(): void {
    if (this.heartbeat !== null || this.stopping) return;
    this.heartbeat = setInterval(() => void this.beat(), this.opts.heartbeat?.pollMs ?? PROGRAM_POLL_MS);
    this.heartbeat.unref?.();
  }

  private async beat(): Promise<void> {
    if (this.beating || this.stopping || this.proc === null) return;
    this.beating = true;
    try {
      const report = await this.programReport(this.opts.heartbeat?.blockGraceMs ?? BLOCK_GRACE_MS);
      this.emitProgram({ kind: "report", report });
    } catch (err) {
      // An exit is the exit handler's; a timeout is a blocked event loop.
      if (err instanceof SandboxTimeoutError && !this.stopping) await this.blocked();
    } finally {
      this.beating = false;
    }
  }

  /**
   * The child stopped answering. A snippet in flight is blamed, as the snippet
   * timeout always blamed it, and the program comes back once the new child is
   * ready; with none in flight the program is, and it stays halted until the
   * model's next yield. Either way the restart counts toward
   * `snippet-runaway`.
   */
  private async blocked(): Promise<void> {
    const grace = this.opts.heartbeat?.blockGraceMs ?? BLOCK_GRACE_MS;
    if (this.evalsInFlight > 0) {
      this.killedForSnippetBlock = true;
      await this.restart(`a snippet blocked the event loop for ${grace}ms`);
      this.emitProgram({ kind: "restart", cause: "snippet", at: this.nowMs(), detail: `a snippet blocked the event loop for ${grace}ms` });
      await this.reloadAfterRestart();
      return;
    }
    const s = this.programState;
    const blamed = s.kind === "running" ? `your program (main.ts, deploy ${s.deploy})` : "code started by your program";
    await this.restart(
      `${blamed} blocked the event loop for ${grace}ms; it stays stopped until you end your turn, when main.ts loads again`,
    );
    if (s.kind === "running") {
      this.programState = { kind: "halted", deploy: s.deploy, version: s.version, at: s.at, since: this.nowMs() };
      this.emitProgram({ kind: "halted", deploy: s.deploy, at: this.nowMs() });
    }
  }

  /**
   * After a restart the program was not blamed for, load it again in the new
   * child — the same deploy, from the files as they are — unless the files
   * moved since it was deployed: then running them would put code the model
   * has not ended its turn on into play, so it stays stopped until the yield.
   */
  private async reloadAfterRestart(): Promise<void> {
    const s = this.programState;
    if (s.kind !== "running" || this.stopping) return;
    if (this.opts.workspace.importVersion !== s.version) {
      this.programState = { kind: "stopped", deploy: s.deploy, version: s.version, at: s.at, since: this.nowMs() };
      this.emitProgram({ kind: "stopped", deploy: s.deploy, at: this.nowMs() });
      return;
    }
    let answer: DeployAnswer;
    try {
      answer = await this.deployProgram(s.deploy);
    } catch (err) {
      answer = { ok: false, deploy: s.deploy, error: err instanceof Error ? err.message : String(err) };
    }
    if (!answer.ok) this.programState = { kind: "stopped", deploy: s.deploy, version: s.version, at: s.at, since: this.nowMs() };
    this.emitProgram({ kind: "reload", deploy: s.deploy, version: s.version, at: this.nowMs(), answer });
  }

  /**
   * What ending a turn does to the program: load main.ts when a code or JSON
   * file changed since the last attempt, when the program is halted or
   * stopped, or when none was ever tried at this version; unload it when
   * main.ts is gone; otherwise nothing (null). A failed load leaves a running
   * deploy running and is not retried until something changes.
   */
  async deployAtYield(): Promise<DeployRecord | null> {
    const version = this.opts.workspace.importVersion;
    const main = this.opts.workspace.read(MAIN_PATH);
    const s = this.programState;
    if (!main.ok) {
      if (s.kind === "none") return null;
      try {
        await this.unloadProgram();
      } catch {
        // a dead child unloads nothing; the state below is the truth either way
      }
      this.programState = { kind: "none" };
      this.lastAttemptedVersion = version;
      return { deploy: s.deploy, version, ok: true, action: "unload" };
    }
    const due = s.kind === "halted" || s.kind === "stopped" || this.lastAttemptedVersion !== version;
    if (!due) return null;
    const deploy = ++this.deploys;
    this.lastAttemptedVersion = version;
    let answer: DeployAnswer;
    try {
      answer = await this.deployProgram(deploy);
    } catch (err) {
      answer = { ok: false, deploy, error: err instanceof Error ? err.message : String(err) };
    }
    if (answer.ok) {
      this.programState = { kind: "running", deploy, version, at: this.nowMs() };
      return { deploy, version, ok: true, exports: answer.exports, action: "load" };
    }
    // The previous deploy keeps running if it was; a halted or stopped one is gone.
    if (s.kind === "halted" || s.kind === "stopped") this.programState = { kind: "none" };
    return { deploy, version, ok: false, error: answer.error, action: "load" };
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
          const ws = this.opts.workspace;
          const p = msg.params;
          const answer = (r: WorkspaceResult, op: string): void =>
            r.ok ? reply(true, r.text) : reply(false, undefined, `files.${op}: ${r.error}`);
          switch (msg.method) {
            case "files_read":
              answer(ws.read(p.path, SNIPPET_VOCABULARY), "read");
              break;
            case "files_write":
              answer(ws.write(p.path, p.content), "write");
              break;
            case "files_edit":
              answer(ws.edit(p.path, p.old_string, p.new_string, p.replace_all ?? false, SNIPPET_VOCABULARY), "edit");
              break;
            case "files_delete":
              answer(ws.delete(p.path, SNIPPET_VOCABULARY), "delete");
              break;
            case "files_list":
              reply(true, ws.list().map((f) => ({ path: f.path, bytes: f.bytes })));
              break;
            default:
              reply(false, undefined, `unknown hostcall ${String((msg as { method?: unknown }).method)}`);
          }
        } catch (err) {
          reply(false, undefined, String(err));
        }
        return;
      }
      case "fatal":
        this.notice("session_note", `sandbox reported fatal error: ${msg.error}`);
        return;
      case "memory": {
        // The child checked the size and the shape; the workspace checks the
        // limits again, and a refusal (a workspace full to its total) is an
        // error the next report carries like any of the program's own.
        const r = this.opts.workspace.writeMemory(msg.json);
        if (!r.ok) this.noteHostError("memory", "memory not saved: workspace full", r.error);
        return;
      }
    }
  }

  // ------------------------------------------------------ the entrypoint program

  /** Errors the host itself raised for the program (a memory it could not write), for the next report. */
  private readonly hostErrors = new Map<string, ProgramErrorNote>();
  /** Signatures the host has raised before: a repeat is only counted. */
  private readonly hostErrorsSeen = new Set<string>();

  private noteHostError(hook: string, signature: string, text: string): void {
    const now = (this.opts.now ?? Date.now)();
    const row = this.hostErrors.get(signature);
    if (row !== undefined) {
      row.count++;
      row.lastTs = now;
      return;
    }
    const isNew = !this.hostErrorsSeen.has(signature);
    this.hostErrorsSeen.add(signature);
    this.hostErrors.set(signature, { signature, hook, text, count: 1, isNew, deploy: null, firstTs: now, lastTs: now });
  }

  /**
   * Load main.ts at the workspace's current import version as deploy `deploy`.
   * The previous deploy keeps running unless this one loaded; the answer says
   * which, and why not.
   */
  async deployProgram(deploy: number): Promise<DeployAnswer> {
    await this.start();
    const id = this.nextId++;
    const res = await this.request<{ t: "rpc_result"; id: number; ok: boolean; value?: unknown; error?: string }>(
      { t: "rpc", id, method: "program_deploy", params: { version: this.opts.workspace.importVersion, deploy } },
      this.programLimits.deployConnectMs + 60_000,
    );
    if (!res.ok) throw new Error(res.error ?? "program_deploy rpc failed");
    return res.value as DeployAnswer;
  }

  /** Stop the program: its calls aborted, its timers and listeners removed. */
  async unloadProgram(): Promise<void> {
    if (this.proc === null) return;
    const id = this.nextId++;
    const res = await this.request<{ t: "rpc_result"; id: number; ok: boolean; error?: string }>(
      { t: "rpc", id, method: "program_unload", params: {} },
      5_000,
    );
    if (!res.ok) throw new Error(res.error ?? "program_unload rpc failed");
  }

  /** Drain what the program did since the last report, with the host's own errors folded in. */
  async programReport(timeoutMs = 5_000): Promise<ProgramReport> {
    await this.start();
    const id = this.nextId++;
    const res = await this.request<{ t: "rpc_result"; id: number; ok: boolean; value?: unknown; error?: string }>(
      { t: "rpc", id, method: "program_report", params: {} },
      timeoutMs,
    );
    if (!res.ok) throw new Error(res.error ?? "program_report rpc failed");
    const report = res.value as ProgramReport;
    if (this.hostErrors.size > 0) {
      report.errors.push(...this.hostErrors.values());
      this.hostErrors.clear();
    }
    return report;
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
    // Taken now, before this eval can itself cause a restart: that restart's
    // notice belongs on the next result, the first from the new process.
    const reset = this.resetPending;
    this.resetPending = false;
    this.evalsInFlight++;
    let res: SnippetResult;
    try {
      res = await this.evalOnce(code);
    } finally {
      this.evalsInFlight--;
    }
    return reset ? { ...res, resetNotice: this.entrypoint ? STATE_RESET_NOTICE_ENTRYPOINT : STATE_RESET_NOTICE } : res;
  }

  private async evalOnce(code: string): Promise<SnippetResult> {
    const id = this.nextId++;
    try {
      const res = await this.request<EvalResultMsg>(
        // The budget is the host's fact, so the host states it: the child hands
        // it to the SDK, which uses it to explain a walk that never fit (see
        // ipc.ts). Wall-clock, not `opts.now` — it is compared against
        // `Date.now()` in another process.
        { t: "eval", id, code, deadline: Date.now() + this.opts.snippetTimeoutMs },
        this.opts.snippetTimeoutMs,
      );
      this.consecutiveRestarts = 0;
      return {
        ok: res.ok,
        value: res.value,
        error: res.error,
        hint: res.hint,
        actionHints: res.hints ?? [],
        logs: res.logs,
        durationMs: res.durationMs,
      };
    } catch (err) {
      if (err instanceof SandboxExitedError) {
        // Entrypoint loop: the heartbeat found the event loop blocked while
        // this snippet ran, and killed the child for it.
        if (this.killedForSnippetBlock) {
          this.killedForSnippetBlock = false;
          const grace = this.opts.heartbeat?.blockGraceMs ?? BLOCK_GRACE_MS;
          return {
            ok: false,
            timedOut: true,
            restarted: true,
            error:
              `snippet blocked the sandbox event loop for ${grace}ms; the sandbox process was killed and ` +
              `restarted — ${this.lossRecovery} Your program loads again by itself unless files changed since its deploy.`,
            logs: [],
            durationMs: grace,
          };
        }
        return {
          ok: false,
          restarted: true,
          error: `the sandbox process exited while this snippet was running — ${this.lossRecovery}`,
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
      // Cooperative abort first, then the liveness ping: the pong then carries
      // whatever the abort made the snippet print.
      try {
        this.send({ t: "abort", id });
      } catch {
        // not started / already gone — the ping path reports that
      }
      const ping = await this.pingAlive();
      if (ping.alive && this.entrypoint) {
        return {
          ok: false,
          timedOut: true,
          error:
            `snippet evaluation exceeded ${this.opts.snippetTimeoutMs}ms and was abandoned: its \`signal\` was ` +
            `aborted, so pending SDK waits (moveTo, killTarget, waitForTransfer, …) rejected with ` +
            `EventAbortedError and any move in flight was stopped, and the timers and event listeners it ` +
            `started were removed. ` +
            (ping.note !== undefined ? `${ping.note} ` : "") +
            `Work longer than ${Math.round(this.opts.snippetTimeoutMs / 1000)}s belongs in your program: a ` +
            `tick of loop has ${Math.round(this.programLimits.tickBudgetMs / 1000)}s, and a walk longer than ` +
            `that is dispatched with sdk.moveToAsync(target), which returns as soon as the move is queued, and ` +
            `followed on later ticks through state.self.position or the WB_MOVE_RESULT event. Check state/events ` +
            `before assuming the snippet failed.`,
          logs: ping.logs,
          actionHints: ping.hints,
          durationMs: this.opts.snippetTimeoutMs,
        };
      }
      if (ping.alive) {
        return {
          ok: false,
          timedOut: true,
          error:
            `snippet evaluation exceeded ${this.opts.snippetTimeoutMs}ms and was abandoned: its \`signal\` was ` +
            `aborted, so pending SDK waits (moveTo, killTarget, waitForTransfer, …) rejected with ` +
            `EventAbortedError and any move in flight was stopped. ` +
            // What the abort itself learned, when it learned anything: today
            // that is the distance an in-flight moveTo had covered and had
            // left, named by the SDK and carried home on the pong. A generic
            // "it timed out" is what the 2026-08-23 fan-out showed models
            // failing to act on (one retried the same blocking call 5 times).
            (ping.note !== undefined ? `${ping.note} ` : "") +
            `The runtime (bindings, routines, session) is still alive. ` +
            `A walk longer than this limit is dispatched, not awaited: sdk.moveToAsync(target) returns as soon ` +
            `as the move is queued, and you poll state.self.position or the WB_MOVE_RESULT event for the ` +
            `verdict. ` +
            `Work longer than ${Math.round(this.opts.snippetTimeoutMs / 1000)}s belongs in a background ` +
            `routine: launch it without awaiting and keep a handle to stop it, e.g. ` +
            `\`const job = new AbortController(); void (async (stop) => { for (const p of waypoints) { if (stop.aborted) return; await sdk.moveTo(p); } console.log("arrived"); })(job.signal).catch((e) => console.log(String(e)));\` ` +
            `— the snippet returns at once with no value, what the routine prints arrives with later snippet ` +
            `results, and job.abort() from a later snippet stops it at its next check. Code you will launch again belongs in a ` +
            `workspace file you import. Code that was not awaiting the SDK may still be running, so check ` +
            `state/events before assuming it failed.`,
          logs: ping.logs,
          // The abandoned snippet's hints: its result is discarded, so this
          // pong is the only channel that still reaches the model.
          actionHints: ping.hints,
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
          `the sandbox process was killed and restarted — ${this.lossRecovery}`,
        logs: [],
        durationMs: this.opts.snippetTimeoutMs,
      };
    }
  }

  private async pingAlive(): Promise<{ alive: boolean; logs: LogEntry[]; note?: string; hints: ActionHintNote[] }> {
    const id = this.nextId++;
    try {
      const pong = await this.request<{ t: "pong"; id: number; logs?: LogEntry[]; note?: string; hints?: ActionHintNote[] }>(
        { t: "ping", id },
        this.opts.pingGraceMs,
      );
      return {
        alive: true,
        logs: pong.logs ?? [],
        hints: pong.hints ?? [],
        ...(pong.note !== undefined ? { note: pong.note } : {}),
      };
    } catch {
      return { alive: false, logs: [], hints: [] };
    }
  }

  private async restart(reason: string): Promise<void> {
    this.consecutiveRestarts++;
    this.totalRestarts++;
    this.resetPending = true;
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
    this.notice("sandbox_restarted", `sandbox restarted (${reason}). ${this.lossRecovery}`);
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

  /**
   * Drain the death-window transitions the child latched since the last call.
   *
   * The child sees every event; the host samples on a 60s clock, and a whole
   * death fits between two samples (`ipc.ts`, `DeathSignal`). Draining is
   * destructive by design: these are the record, so every drained signal must
   * be written, and one caller (the loop's state sample) owns the drain.
   */
  async deathSignals(): Promise<DeathSignal[]> {
    await this.start();
    const id = this.nextId++;
    const res = await this.request<{ t: "rpc_result"; id: number; ok: boolean; value?: unknown; error?: string }>(
      { t: "rpc", id, method: "death_signals", params: {} },
      5_000,
    );
    if (!res.ok) throw new Error(res.error ?? "death_signals rpc failed");
    return (res.value ?? []) as DeathSignal[];
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
    // Entrypoint loop: nothing reports, respawns or reloads once a stop began.
    this.stopping = true;
    if (this.heartbeat !== null) {
      clearInterval(this.heartbeat);
      this.heartbeat = null;
    }
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
