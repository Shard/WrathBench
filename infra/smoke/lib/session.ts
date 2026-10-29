/**
 * The session token a smoke opens a module session under, one spelling for
 * every smoke: `smoke-<smoke>[-<role>]-<uuid>[-<suffix>]`, where `<smoke>` is
 * the file's name (`bun wb smoke <smoke>`), `<role>` tells a smoke's
 * concurrent sessions apart (group's `a` and `b`), and `<suffix>` a session
 * the smoke opens beside its main one (`create`, `play`, a step number).
 *
 * The module names its audit files by a fingerprint of the token, never the
 * token (wrath-mcp/module/PROTOCOL.md, "Audit log"), so nothing in the audit
 * directory says which smoke a file is. Each token minted here is therefore
 * recorded with its smoke's name in a ledger on the runs volume
 * (`SMOKE_SESSIONS_FILE`), fingerprint only, and `bun wb inspect audit --smoke
 * <smoke>[-<role>]` reads the ledger to find the smoke's files. A session the
 * SDK opens on its own under a derived token (`deleteCharacter`'s
 * `<token>-del<n>`) is not in it. Character names are a separate matter
 * (`./name.ts`).
 */

import { appendFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tokenFingerprint } from "@wrathbench/mcp/module-auth";

/** A smoke's name, or a name and role: what `inspect audit --smoke` takes. */
export const SMOKE_SESSION_NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** The smoke-session ledger's file name, in the runs directory. */
export const SMOKE_SESSIONS_NAME = "smoke-sessions.jsonl";

/**
 * Where minted smoke tokens are recorded: `WRATHBENCH_SMOKE_SESSIONS`, else
 * `data/runs/smoke-sessions.jsonl` in this checkout, the runs volume in the
 * runner pod and under compose. Undefined under `bun test` unless the
 * variable names a file, so no test writes to a checkout's data.
 */
export function smokeSessionsFile(env: Readonly<Record<string, string | undefined>> = process.env): string | undefined {
  const named = env["WRATHBENCH_SMOKE_SESSIONS"];
  if (named !== undefined && named !== "") return named;
  if (env["NODE_ENV"] === "test") return undefined;
  return join(resolve(import.meta.dir, "..", "..", ".."), "data", "runs", SMOKE_SESSIONS_NAME);
}

/** One ledger line: when a smoke minted a token, the smoke's name (and role), and the token's audit fingerprint. */
export interface SmokeSession {
  ts: number;
  smoke: string;
  fingerprint: string;
}

/** The fingerprints of `smoke`'s sessions in a ledger's text, oldest first and once each; unreadable lines are skipped. */
export function smokeFingerprints(ledger: string, smoke: string): string[] {
  const seen = new Set<string>();
  for (const line of ledger.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const s = JSON.parse(line) as Partial<SmokeSession>;
      if (s.smoke === smoke && typeof s.fingerprint === "string" && /^[0-9a-f]{16}$/.test(s.fingerprint)) seen.add(s.fingerprint);
    } catch {
      // a torn last line from a smoke killed mid-write
    }
  }
  return [...seen];
}

/** A fresh uuid, or `id` to share one across a smoke's sessions or with something else it names (mail's subject). */
export function smokeToken(smoke: string, opts: { role?: string; id?: string; suffix?: string } = {}): string {
  const name = opts.role === undefined ? smoke : `${smoke}-${opts.role}`;
  if (!SMOKE_SESSION_NAME.test(name)) throw new Error(`smokeToken: ${JSON.stringify(name)} is not lowercase words joined by hyphens`);
  const id = opts.id ?? crypto.randomUUID();
  if (!/^[0-9a-f]{8}-/.test(id)) throw new Error("smokeToken: the id must open with a uuid's eight hex digits");
  if (opts.suffix !== undefined && !/^[A-Za-z0-9_-]+$/.test(opts.suffix)) throw new Error(`smokeToken: ${JSON.stringify(opts.suffix)} is not a plain suffix`);
  const token = `smoke-${name}-${id}${opts.suffix === undefined ? "" : `-${opts.suffix}`}`;
  minted.set(token, name);
  noteSmokeSession(name, token);
  return token;
}

/** The smoke names of the tokens minted in this process, for the sessions derived from them. */
const minted = new Map<string, string>();

/**
 * `<token>-<suffix>`, a session a smoke derives from one of its tokens (a
 * fixture's create, a character delete's attempt), recorded under the same
 * smoke when `smokeToken` minted `token` in this process. Never throws: a
 * token from elsewhere is derived and left unrecorded.
 */
export function smokeSubToken(token: string, suffix: string): string {
  const sub = `${token}-${suffix}`;
  const name = minted.get(token);
  if (name !== undefined) noteSmokeSession(name, sub);
  return sub;
}

/** Best effort: a smoke whose ledger cannot be written still runs, and `inspect audit --smoke` says it found nothing. */
function noteSmokeSession(smoke: string, token: string): void {
  const file = smokeSessionsFile();
  if (file === undefined) return;
  const line: SmokeSession = { ts: Date.now(), smoke, fingerprint: tokenFingerprint(token) };
  try {
    appendFileSync(file, `${JSON.stringify(line)}\n`);
  } catch {
    // no runs directory here: nothing to record into
  }
}
