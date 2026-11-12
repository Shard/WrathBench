/**
 * Re-auth of a Codex home from the admin page: `codex login --device-auth`
 * run against the credential's own home, with only the verification link and
 * the one-time code handed back to the page.
 *
 * The home is a volume only the fleet and runner pods mount, never the
 * viewer's, so the viewer asks and the supervisor does it. The channel is two
 * files per credential beside the config store, which both pods mount:
 *
 *   codex-login/<id>.request.json   the viewer writes it ({ at, actor })
 *   codex-login/<id>.state.json     the supervisor writes it: starting,
 *                                   waiting (link and code), ok or failed
 *
 * Under the config directory, not `runs/`: the publisher and the collector
 * read the runs directory, and a one-time code has no business being near
 * anything that publishes.
 *
 * What it never does: copy `auth.json` anywhere (the CLI writes it into the
 * home it was pointed at, the one the runs use), hand the CLI the fleet's
 * environment (it gets the CLI plumbing and `CODEX_HOME`, nothing else, as a
 * codex run does: the CLI snapshots its environment into the home), log the
 * code, or run two logins on one home at once. It refuses while a run is live
 * on the credential: a login replaces the refresh token a live CLI may be
 * about to spend. A login not completed within the code's 15 minutes is
 * stopped and reads as failed.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { cliBaseEnv, readLines } from "./adapter-shared";
import { homeLooksLoggedIn } from "./adapter-codex";
import { configDbPath } from "./config-store";
import { isCredentialId, providerById, type Credential } from "./credential-slots";

/** How long a device code stays good, and so how long a login may wait for it. */
export const CODEX_LOGIN_TTL_MS = 15 * 60_000;

/** How often the supervisor looks for a request. */
export const CODEX_LOGIN_POLL_MS = 2_000;

export const CODEX_LOGIN_STATES = ["starting", "waiting", "ok", "failed"] as const;
export type CodexLoginState = (typeof CODEX_LOGIN_STATES)[number];

const requestSchema = z.object({ at: z.number().int().nonnegative(), actor: z.string().max(64) }).strict();
export type CodexLoginRequest = z.infer<typeof requestSchema>;

const stateSchema = z
  .object({
    state: z.enum(CODEX_LOGIN_STATES),
    requestedAt: z.number(),
    at: z.number(),
    actor: z.string(),
    url: z.string().optional(),
    code: z.string().optional(),
    expiresAt: z.number().optional(),
    detail: z.string().optional(),
  })
  .strict();
export type CodexLoginStatus = z.infer<typeof stateSchema>;

/** The channel's directory, beside the config store. */
export function codexLoginDir(env: Record<string, string | undefined> = process.env): string {
  return join(dirname(configDbPath(env)), "codex-login");
}

const requestPath = (dir: string, id: string): string => join(dir, `${id}.request.json`);
const statePath = (dir: string, id: string): string => join(dir, `${id}.state.json`);

function writeWhole(path: string, body: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(body)}\n`, "utf8");
  renameSync(tmp, path);
}

/** The login's state for a credential, or null with none. */
export function readCodexLogin(dir: string, id: string): CodexLoginStatus | null {
  try {
    const parsed = stateSchema.safeParse(JSON.parse(readFileSync(statePath(dir, id), "utf8")));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Whether a login is under way: starting or waiting, and not past its code's life. */
export function loginActive(s: CodexLoginStatus | null, now: number): boolean {
  return s !== null && (s.state === "starting" || s.state === "waiting") && now - s.requestedAt < CODEX_LOGIN_TTL_MS + 60_000;
}

/** The viewer's half: ask for a login. Refused while one is under way, or one is already asked for. */
export function requestCodexLogin(dir: string, id: string, actor: string, now: number = Date.now()): { ok: true } | { ok: false; why: string } {
  if (!isCredentialId(id)) return { ok: false, why: `${id} is not a credential id` };
  if (loginActive(readCodexLogin(dir, id), now)) return { ok: false, why: `a login for ${id} is already under way` };
  if (existsSync(requestPath(dir, id))) return { ok: false, why: `a login for ${id} is already asked for, and the supervisor has not taken it yet` };
  writeWhole(requestPath(dir, id), { at: now, actor: actor.slice(0, 64) } satisfies CodexLoginRequest);
  return { ok: true };
}

/** Whether a request is waiting for the supervisor. */
export function codexLoginRequested(dir: string, id: string): boolean {
  return existsSync(requestPath(dir, id));
}

// ------------------------------------------------------------ the CLI's output

const ANSI = /\u001b\[[0-9;?]*[ -\/]*[@-~]/g;

/**
 * The link and the one-time code out of the CLI's device-auth lines (0.153
 * and 0.163 print the link on its own line after "Open this link", and the
 * code on its own line after "one-time code"). Colour codes are stripped.
 */
export function parseDeviceAuth(lines: readonly string[]): { url?: string; code?: string } {
  const out: { url?: string; code?: string } = {};
  for (const raw of lines) {
    const line = raw.replace(ANSI, "").trim();
    if (out.url === undefined) {
      const m = /^(https:\/\/[^\s]+)$/.exec(line);
      if (m !== null) out.url = m[1]!;
    }
    if (out.code === undefined && /^[A-Z0-9]{4,}-[A-Z0-9]{4,}$/.test(line)) out.code = line;
  }
  return out;
}

// --------------------------------------------------------------- the supervisor

export interface CodexLoginDeps {
  /** The credentials in force now. */
  credentials: () => readonly Credential[];
  /** Runs live on a credential now. */
  inUse: (id: string) => number;
  env?: Record<string, string | undefined>;
  dir?: string;
  /** The CLI; `codex` on PATH by default. */
  bin?: string;
  now?: () => number;
  say?: (line: string) => void;
  ttlMs?: number;
}

/**
 * The supervisor's half: take each request, run the login, and keep the
 * state file current. One login per home at a time; `poll` is cheap and
 * never throws.
 */
export class CodexLogins {
  private readonly running = new Map<string, { id: string; kill: () => void }>();
  private readonly env: Record<string, string | undefined>;
  private readonly dir: string;

  constructor(private readonly deps: CodexLoginDeps) {
    this.env = deps.env ?? process.env;
    this.dir = deps.dir ?? codexLoginDir(this.env);
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  private write(id: string, s: CodexLoginStatus): void {
    try {
      writeWhole(statePath(this.dir, id), s);
    } catch (e) {
      this.deps.say?.(`codex login ${id}: could not write its state: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /** Take every waiting request. Returns the logins it started, for a test to await. */
  poll(): Promise<void>[] {
    let names: string[];
    try {
      names = readdirSync(this.dir).filter((n) => n.endsWith(".request.json"));
    } catch {
      return [];
    }
    const started: Promise<void>[] = [];
    for (const n of names) {
      const id = n.slice(0, -".request.json".length);
      let req: CodexLoginRequest | null = null;
      try {
        const parsed = requestSchema.safeParse(JSON.parse(readFileSync(join(this.dir, n), "utf8")));
        req = parsed.success ? parsed.data : null;
      } catch {
        req = null;
      }
      // Taken, whatever comes of it: a request is answered once.
      rmSync(join(this.dir, n), { force: true });
      if (req === null || !isCredentialId(id)) continue;
      const p = this.start(id, req);
      if (p !== null) started.push(p);
    }
    return started;
  }

  private start(id: string, req: CodexLoginRequest): Promise<void> | null {
    const base = { requestedAt: req.at, actor: req.actor };
    const fail = (detail: string): null => {
      this.write(id, { state: "failed", ...base, at: this.now(), detail });
      this.deps.say?.(`codex login ${id}: refused — ${detail}`);
      return null;
    };
    const c = this.deps.credentials().find((x) => x.id === id);
    if (c === undefined) return fail(`no credential ${id}`);
    if (providerById(c.provider)?.holds !== "home") return fail(`${id} is a ${c.provider} credential, not a Codex home`);
    const home = this.env[c.secretEnv];
    if (home === undefined || home.length === 0) return fail(`${c.secretEnv} is not set in the supervisor's environment`);
    if (!existsSync(home)) return fail(`${c.secretEnv} names no directory here`);
    if (this.running.has(home)) return fail(`a login on this home is already under way`);
    const live = this.deps.inUse(id);
    if (live > 0) return fail(`${live} run${live === 1 ? " is" : "s are"} live on ${id}; a login replaces the token a live run refreshes with — disable it and let them finish first`);

    // The CLI's plumbing and the home, never the fleet's environment.
    const env = { ...cliBaseEnv(this.env), CODEX_HOME: home };
    let proc: ReturnType<typeof Bun.spawn>;
    try {
      proc = Bun.spawn([this.deps.bin ?? "codex", "login", "--device-auth"], { env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    } catch (e) {
      return fail(`codex would not start: ${e instanceof Error ? e.message : String(e)}`);
    }
    const startedAt = this.now();
    this.write(id, { state: "starting", ...base, at: startedAt });
    this.deps.say?.(`codex login ${id}: started for ${req.actor}`);
    const kill = (): void => {
      try {
        proc.kill("SIGTERM");
      } catch {
        // gone
      }
    };
    this.running.set(home, { id, kill });
    const ttl = this.deps.ttlMs ?? CODEX_LOGIN_TTL_MS;
    let expired = false;
    const timer = setTimeout(() => {
      expired = true;
      kill();
    }, ttl);
    const lines: string[] = [];
    let shown = false;
    const read = (async () => {
      for await (const line of readLines(proc.stdout as ReadableStream<Uint8Array>)) {
        if (shown) continue;
        lines.push(line);
        const got = parseDeviceAuth(lines);
        if (got.url !== undefined && got.code !== undefined) {
          shown = true;
          this.write(id, { state: "waiting", ...base, at: this.now(), url: got.url, code: got.code, expiresAt: startedAt + ttl });
          this.deps.say?.(`codex login ${id}: waiting for the code to be entered`);
        }
      }
    })();
    // Drained and dropped: the page gets the exit, never the CLI's words.
    const drain = new Response(proc.stderr as ReadableStream<Uint8Array>).arrayBuffer().catch(() => undefined);
    return (async () => {
      const code = await proc.exited;
      clearTimeout(timer);
      await Promise.all([read.catch(() => undefined), drain]);
      this.running.delete(home);
      const ok = code === 0 && !expired && homeLooksLoggedIn(home);
      const detail = expired ? "the code expired before it was entered" : !shown ? `codex printed no link and code (exit ${code})` : `codex login exited ${code}`;
      this.write(id, ok ? { state: "ok", ...base, at: this.now() } : { state: "failed", ...base, at: this.now(), detail });
      this.deps.say?.(`codex login ${id}: ${ok ? "logged in" : `failed — ${detail}`}`);
    })();
  }

  /** Stop every login under way (the supervisor is stopping). */
  stop(): void {
    for (const r of this.running.values()) r.kill();
  }
}
