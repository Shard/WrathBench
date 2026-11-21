/**
 * A bare session store, read beside the runs: the directory a standalone
 * wrath-mcp records into (`--record-dir`, `wrath-mcp/mcp/README.md`), one
 * session directory per session, each named by its token's fingerprint
 * (`wrath-mcp/docs/SESSION-FORMAT.md`). A session there was driven by
 * whatever MCP client held the token; it has no run around it, no meta.json
 * and no trajectory, only the stack's record.
 *
 * The viewer lists such a session as a run and opens it by a **viewer id**:
 * `mcp-` and the first 16 hex characters of a SHA-256 over a fixed label and
 * the directory's name. The directory's name is the token's fingerprint, the
 * stem of the module's audit files, and nothing the viewer serves (it has no
 * login) names one, so the id is a one-way function of it rather than it.
 * The id is a valid run id (`isValidRunId`) and holds no `~`, so the fan-out
 * split never reads one as a character. A run directory of the same name
 * wins: the session is then not listed, and the collector says so once.
 *
 * Which store a runs directory is read with is process state, attached once
 * at start (`attachSessionStore`): the viewer from `WRATHBENCH_SESSION_STORE`,
 * the collector from its config. Keyed by the runs directory, so every reader
 * that resolves a run id by its runs directory (`runDir`) resolves a bare one
 * the same way, and a test's temp directory never inherits another's store.
 */

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { readSessionFile, SessionStore } from "@wrathbench/mcp/record/read";

/** What every bare session's viewer id starts with. */
export const BARE_SESSION_PREFIX = "mcp-";

/** The env var naming the store the viewer and the collector read beside the runs. */
export const SESSION_STORE_ENV = "WRATHBENCH_SESSION_STORE";

const BARE_ID = /^mcp-[0-9a-f]{16}$/;
/** Domain separation: the id is this label's hash, never a bare hash of the fingerprint. */
const ID_LABEL = "wrathbench/bare-session\0";

const ids = new Map<string, string>();

/** The viewer id of the session whose directory is named `name` (its token's fingerprint). */
export function bareSessionId(name: string): string {
  let id = ids.get(name);
  if (id === undefined) {
    id = BARE_SESSION_PREFIX + createHash("sha256").update(ID_LABEL + name).digest("hex").slice(0, 16);
    ids.set(name, id);
  }
  return id;
}

/** Whether a run id has the shape of a bare session's viewer id. */
export function isBareSessionId(id: string): boolean {
  return BARE_ID.test(id);
}

/** Whether a directory is a session record itself (`session.json` at its root), rather than a run around one. */
export function isBareSessionDir(dir: string): boolean {
  return existsSync(join(dir, "session.json"));
}

export interface BareSession {
  /** The viewer id: never the directory's name. */
  id: string;
  dir: string;
}

/**
 * The store's sessions: every directory named as a session whose
 * `session.json` names a character, read through the stack's own store so its
 * naming rule is the stack's. A server opens its record when it starts,
 * before any tool call, so a client that only connected (or listed its
 * servers) leaves a record that never reached the world: it has no
 * character, played nothing, and is not listed or opened until it does.
 * Unordered; empty when the store is absent or unreadable.
 */
export function listBareSessions(storeDir: string): BareSession[] {
  const out: BareSession[] = [];
  for (const dir of new SessionStore(storeDir).dirs()) {
    const name = readSessionFile(dir)?.character?.name;
    if (typeof name === "string" && name !== "") out.push({ id: bareSessionId(basename(dir)), dir });
  }
  return out;
}

/** A bare session's directory by its viewer id, or null when the store holds none by that id. */
export function bareSessionDir(storeDir: string, id: string): string | null {
  if (!isBareSessionId(id)) return null;
  return listBareSessions(storeDir).find((s) => s.id === id)?.dir ?? null;
}

const attached = new Map<string, string>();

/** Read `storeDir` beside `runsDir` from now on; null detaches. */
export function attachSessionStore(runsDir: string, storeDir: string | null | undefined): void {
  if (storeDir === null || storeDir === undefined || storeDir === "") attached.delete(resolve(runsDir));
  else attached.set(resolve(runsDir), resolve(storeDir));
}

/** The store read beside `runsDir`, or null when none is. */
export function sessionStoreOf(runsDir: string): string | null {
  return attached.get(resolve(runsDir)) ?? null;
}

/** `WRATHBENCH_SESSION_STORE`, or null when unset or empty. */
export function sessionStoreFromEnv(env: Record<string, string | undefined> = process.env): string | null {
  const v = env[SESSION_STORE_ENV];
  return v === undefined || v.trim() === "" ? null : v;
}
