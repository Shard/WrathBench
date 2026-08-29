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
 */

export interface HygieneOptions {
  moduleUrl: string;
  /** The run's session secret; per-call throwaway tokens derive from it. */
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
    }
  | { ok: false; reason: string; seen: Map<string, string> };

type Listing =
  | { ok: true; chars: { name: string; guid: string }[] }
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

  const list = async (i: number): Promise<Listing> => {
    try {
      const res = await f(`${o.moduleUrl}/characters`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: `${o.token}-hygiene-${i}`, account: o.account }),
      });
      const j = (await res.json()) as {
        ok?: boolean;
        error?: string;
        enum?: { characters?: { name?: string; guid?: string | number }[] };
      };
      if (j.ok !== true || j.enum === undefined) return { ok: false, error: j.error ?? `http ${res.status}`, transport: false };
      const chars = (j.enum.characters ?? [])
        .filter((c): c is { name: string; guid?: string | number } => typeof c.name === "string" && c.name !== "")
        .map((c) => ({ name: c.name, guid: String(c.guid ?? "") }));
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
        headers: { "content-type": "application/json" },
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
      return { ok: true, cleared: 0, leftover: [], seen, kept: [] };
    }
    if (!last.ok) continue;
    const disposable = last.chars.filter((c) => !isKept(c.name));
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
  const disposable = last.chars.filter((c) => !isKept(c.name));
  const cleared = Math.max(0, (initial ?? 0) - disposable.length);
  return {
    ok: true,
    cleared,
    leftover: disposable.map((c) => c.name),
    seen,
    kept: last.chars.filter((c) => isKept(c.name)).map((c) => ({ name: c.name, guid: c.guid })),
  };
}
