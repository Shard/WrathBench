/**
 * Episode hygiene: clear the account's characters before a fresh episode
 * (one fresh level-1 character per episode).
 *
 * The invariant that matters is that the account was actually LOOKED AT when
 * the run starts, and that has exactly one witness: an OK `/characters`
 * listing. Anything else is unknown, never "clear":
 *
 * - A refused listing (`account_in_use` while the core still holds the
 *   previous episode's session — the post-logout linger of up to ~a minute,
 *   see module/PROTOCOL.md) has no `enum`; reading it as an empty list is the
 *   2026-08-24 defect that let `fleet-sonnet-e90-sonnet-20260824-a8` start on
 *   the level-6 character its predecessor had left standing 39s earlier: the
 *   delete timed out (the player was still loaded, so the core silently drops
 *   `CMSG_CHAR_DELETE`), the re-list was refused, and `[]` read as an account
 *   with nothing left on it.
 * - A delete that does not answer `deleted: true` proves nothing either way; a
 *   timed-out delete may still have landed. The listing decides.
 *
 * So the loop is: list; if refused, wait and list again; delete what is
 * listed; wait for the core to release; list again. It gives up only after a
 * budget that comfortably covers the linger, and then the caller refuses to
 * start the run. The guids it saw are returned so the loop can recognise the
 * character it tried to remove should it ever come back in the world.
 *
 * What it deletes is a LEFTOVER and nothing else: a character the launch
 * was not told to keep, that no un-ended run on the account still owns
 * (`characterOwners`), and that is either level 1 or accounted for by a run
 * that ended. On 2026-09-20 hygiene deleted a level-7 freeplay character
 * whose run had no verdict because its runner had been SIGKILLed; the run
 * was minutes from being resumed. A character that belongs to a run that
 * has not been explicitly ended is never deleted, and a levelled character
 * nobody accounts for is deleted only under `--allow-character-delete`.
 */

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { moduleAuthHeaders } from "./module-auth";
import { openRunDb } from "./rundb";
import { readMeta } from "./trajectory";
import { ARCHIVE_DIR } from "../viewer/archive-dir";

/** The newest run on an account that played a character name, and whether it ended. */
export interface CharacterOwner {
  runId: string;
  /** A termination is on record. A run without one still owns its character. */
  ended: boolean;
}

/**
 * Who owns each character name on `account`, from the run directories: for
 * every run (archived ones included) launched on the account that recorded a
 * character, the NEWEST such run per name, case-folded as the realm folds
 * names. `exceptRunId` is the launch asking — its own directory already
 * exists, with the name it was merely suggested.
 *
 * This is what lets hygiene tell a leftover from a character somebody is
 * still playing: a scored episode's level-5 leftover belongs to a run that
 * ended `episode-limit`, and goes; a level-7 freeplay character whose runner
 * was killed before it could write a verdict (2026-09-20) belongs to a run
 * with no termination, and stays. Tolerant everywhere — an unreadable
 * directory is simply not an owner.
 */
export function characterOwners(runsDir: string, account: string, exceptRunId?: string): Map<string, CharacterOwner> {
  const out = new Map<string, CharacterOwner & { startedAt: number }>();
  const scan = (dir: string): void => {
    if (!existsSync(dir)) return;
    let names: string[];
    try {
      names = readdirSync(dir, { withFileTypes: true })
        .filter((d) => d.isDirectory() && d.name !== ARCHIVE_DIR)
        .map((d) => d.name);
    } catch {
      return;
    }
    for (const runId of names) {
      if (runId === exceptRunId) continue;
      const meta = readMeta(join(dir, runId));
      if (meta === null) continue;
      if (meta.config.account?.toUpperCase() !== account.toUpperCase()) continue;
      const name = meta.config.character;
      if (name === undefined || name === "") continue;
      const owner = { runId, ended: terminated(join(dir, runId), runId), startedAt: meta.startedAt };
      const key = name.toLowerCase();
      const prev = out.get(key);
      if (prev === undefined || prev.startedAt < owner.startedAt) out.set(key, owner);
    }
  };
  scan(runsDir);
  scan(join(runsDir, ARCHIVE_DIR));
  return new Map([...out].map(([k, { runId, ended }]) => [k, { runId, ended }]));
}

/** Whether the run's row carries a termination. A missing or unreadable store is "not ended". */
function terminated(dir: string, runId: string): boolean {
  const path = join(dir, "run.sqlite");
  if (!existsSync(path)) return false;
  let db: Database | null = null;
  try {
    db = openRunDb(path, { readonly: true });
    const r = db.query(`SELECT termination_reason FROM run WHERE run_id = ?`).get(runId) as { termination_reason?: unknown } | null;
    return r !== null && typeof r.termination_reason === "string" && r.termination_reason !== "";
  } catch {
    return false;
  } finally {
    db?.close();
  }
}

export interface HygieneOptions {
  moduleUrl: string;
  /** The run's session token; per-call throwaway tokens derive from it. */
  token: string;
  account: string;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
  /** Listing/delete rounds before giving up. Each round waits 5s * round. */
  maxAttempts?: number;
  /**
   * Characters to KEEP. A freeplay continuation (`--continue-from`) plays the
   * character its predecessor left on this account, and any fresh launch on
   * an account that holds another ref's freeplay character must leave that
   * one standing (`--keep-characters`): hygiene clears everything else and
   * reports which of them were actually there. Matched case-insensitively,
   * as the realm matches names.
   */
  keep?: readonly string[];
  /**
   * Who owns each name on this account (`characterOwners`). A character whose
   * newest run has NOT ended is never deleted: the run may be about to be
   * resumed, and a character is the one thing a resume cannot recreate.
   */
  owners?: ReadonlyMap<string, CharacterOwner>;
  /**
   * `--allow-character-delete`. Without it a character above level 1 that no
   * ENDED run on this account accounts for is left standing too: it may be a
   * run this launch cannot see, and a levelled character is hours of play and
   * money. A level-1 leftover, or one an ended run owns, is deleted as always.
   */
  allowCharacterDelete?: boolean;
}

/** A character hygiene refused to delete, and why. */
export interface ProtectedCharacter {
  name: string;
  guid: string;
  level: number | null;
  why: string;
}

export type HygieneOutcome =
  | {
      ok: true;
      /** Characters deleted (confirmed by a later OK listing). */
      cleared: number;
      /**
       * Survivors — slot-eaters, and the names the model must not pick
       * (`createSession` reuses a character of the name it is given).
       */
      leftover: string[];
      /** name (lower-cased) -> guid of every character a listing showed. */
      seen: Map<string, string>;
      /**
       * The `keep` characters the final listing actually shows (name and
       * guid). A kept name that is not on the account any more is absent.
       */
      kept: { name: string; guid: string }[];
      /**
       * Characters the guard refused to delete (an un-ended run's, or a
       * levelled one nobody accounts for), still standing on the final
       * listing. Taken names to the model, exactly like `kept`.
       */
      protected: ProtectedCharacter[];
    }
  | { ok: false; reason: string; seen: Map<string, string> };

type Listing =
  | { ok: true; chars: { name: string; guid: string; level: number | null }[] }
  /** `transport`: the request never reached the module (nothing listening). */
  | { ok: false; error: string; transport: boolean };

export async function clearAccountCharacters(o: HygieneOptions): Promise<HygieneOutcome> {
  const f = o.fetch ?? fetch;
  const sleep = o.sleep ?? ((ms: number) => Bun.sleep(ms));
  const log = o.log ?? (() => {});
  const maxAttempts = o.maxAttempts ?? 6;
  const seen = new Map<string, string>();
  const keep = new Set((o.keep ?? []).map((n) => n.toLowerCase()));
  const isKept = (name: string): boolean => keep.has(name.toLowerCase());
  const owners = o.owners ?? new Map<string, CharacterOwner>();
  /** Why the guard keeps a character that nobody asked to keep, or null when it is a leftover. */
  const guarded = (c: { name: string; level: number | null }): string | null => {
    const owner = owners.get(c.name.toLowerCase());
    if (owner !== undefined && !owner.ended) return `belongs to run ${owner.runId}, which has not ended`;
    if (owner === undefined && c.level !== null && c.level > 1 && o.allowCharacterDelete !== true) {
      return `level ${c.level} and no ended run on ${o.account} accounts for it — pass --allow-character-delete to delete it`;
    }
    return null;
  };
  const announced = new Set<string>();
  /** The leftovers: not kept, not guarded. Guards are said once, loudly. */
  const disposableOf = (chars: { name: string; guid: string; level: number | null }[]): typeof chars =>
    chars.filter((c) => {
      if (isKept(c.name)) return false;
      const why = guarded(c);
      if (why === null) return true;
      if (!announced.has(c.name.toLowerCase())) {
        announced.add(c.name.toLowerCase());
        log(`hygiene: KEEPING ${c.name} (guid ${c.guid || "?"}${c.level !== null ? `, level ${c.level}` : ""}) — ${why}`);
      }
      return false;
    });

  const list = async (i: number): Promise<Listing> => {
    try {
      const res = await f(`${o.moduleUrl}/characters`, {
        method: "POST",
        // Operator class: /characters is one of the routes only the port
        // secret opens (module/PROTOCOL.md, "Authentication").
        headers: { "content-type": "application/json", ...moduleAuthHeaders() },
        body: JSON.stringify({ token: `${o.token}-hygiene-${i}`, account: o.account }),
      });
      const j = (await res.json()) as {
        ok?: boolean;
        error?: string;
        enum?: { characters?: { name?: string; guid?: string | number; level?: unknown }[] };
      };
      if (j.ok !== true || j.enum === undefined) return { ok: false, error: j.error ?? `http ${res.status}`, transport: false };
      const chars = (j.enum.characters ?? [])
        .filter((c): c is { name: string; guid?: string | number; level?: unknown } => typeof c.name === "string" && c.name !== "")
        .map((c) => ({ name: c.name, guid: String(c.guid ?? ""), level: typeof c.level === "number" && Number.isFinite(c.level) ? c.level : null }));
      for (const c of chars) if (c.guid !== "") seen.set(c.name.toLowerCase(), c.guid);
      return { ok: true, chars };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err), transport: true };
    }
  };

  const del = async (name: string, attempt: number): Promise<string | null> => {
    try {
      const res = await f(`${o.moduleUrl}/character-delete`, {
        method: "POST",
        headers: { "content-type": "application/json", ...moduleAuthHeaders() },
        body: JSON.stringify({
          token: `${o.token}-hygiene-del-${attempt}-${name}`,
          account: o.account,
          character: name,
        }),
      });
      const j = (await res.json()) as { deleted?: boolean; error?: string };
      return j.deleted === true ? null : (j.error ?? `http ${res.status}`);
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  };

  let initial: number | null = null;
  let last: Listing | null = null;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (attempt > 0) {
      const waitMs = 5000 * attempt;
      log(
        last !== null && last.ok
          ? `hygiene: ${last.chars.length} character(s) survived delete — retrying in ${waitMs / 1000}s (a logout save may still be landing)`
          : `hygiene: listing refused (${last === null ? "?" : last.ok ? "" : last.error}) — retrying in ${waitMs / 1000}s (the core may still hold the previous session)`,
      );
      await sleep(waitMs);
    }
    last = await list(attempt);
    if (!last.ok && last.transport && initial === null) {
      // The module is not reachable at all: no listing, but no character to
      // play on either — the model's createSession will fail the same way.
      // Skip, as before; the first-observation tripwire still stands.
      log(`hygiene: skipped (${last.error})`);
      return { ok: true, cleared: 0, leftover: [], seen, kept: [], protected: [] };
    }
    if (!last.ok) continue;
    const disposable = disposableOf(last.chars);
    initial ??= disposable.length;
    if (disposable.length === 0) break;
    for (const c of disposable) {
      const err = await del(c.name, attempt);
      if (err !== null) log(`hygiene: could not delete leftover character ${c.name} (${err})`);
    }
  }

  // The verdict comes from the last OK listing, and only from one.
  if (last === null || !last.ok) {
    return {
      ok: false,
      reason: `hygiene: could not obtain a character listing for ${o.account} (${last === null ? "no attempt" : (last as { error: string }).error}) — cannot prove the account is clear`,
      seen,
    };
  }
  // `initial` is the first OK listing's count; whatever the final OK listing
  // still carries was not cleared.
  const disposable = disposableOf(last.chars);
  const cleared = Math.max(0, (initial ?? 0) - disposable.length);
  return {
    ok: true,
    cleared,
    leftover: disposable.map((c) => c.name),
    seen,
    kept: last.chars.filter((c) => isKept(c.name)).map((c) => ({ name: c.name, guid: c.guid })),
    protected: last.chars
      .filter((c) => !isKept(c.name) && guarded(c) !== null)
      .map((c) => ({ name: c.name, guid: c.guid, level: c.level, why: guarded(c)! })),
  };
}
