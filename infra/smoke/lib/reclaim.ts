/**
 * Taking a smoke account back from a session nobody owns any more.
 *
 * A smoke process that is killed (SIGKILL, its pod replaced) never sends its
 * `DELETE /session`, and the module has no idle reaper, so its character
 * stays in world under a token no live process holds. On that account
 * `POST /characters` then answers `400 account_in_use` and
 * `POST /character-delete` `409 account_owned_by_other_token`, for every
 * caller, until something ends the session. A `POST /session` is the one
 * request that does: a create on a permitted account reclaims it, tearing the
 * old session down and answering `504 timeout` (retryable) while the core
 * releases the account (wrath-mcp/module/PROTOCOL.md, "POST /session").
 *
 * `reclaimAccount` is that step for the suite (infra/smoke/suite.ts), run on
 * each of its accounts before any member logs in. The module requires a
 * character on `POST /session`, and a held account cannot list its own, so
 * the reclaim creates a throwaway one and deletes it again. `POST /characters`
 * goes first: on an account nothing holds it answers `200`, and the reclaim
 * does nothing and says nothing.
 *
 * The request helpers are module-reclaim's (infra/smoke/module-reclaim.ts),
 * which proves the reclaim itself against the live module.
 */

import type { ModuleReply, ModuleRequest } from "./module";
import { probeName } from "./name";
import { smokeSubToken } from "./session";

// The request helper itself is lib/module.ts's; the reply type is re-exported
// here only because infra/smoke-reclaim.test.ts imports it from this file.
export type { ModuleReply } from "./module";

type Sleep = (ms: number) => Promise<void>;
const bunSleep: Sleep = (ms) => Bun.sleep(ms);

/**
 * A `POST /session`, retried through the core's account-release window: while
 * a stale session on the account drains, the reclaiming create answers
 * `504 timeout`. Only that is retried. `account_in_use` never comes from
 * `POST /session` on a module that reclaims, so it, like any other refusal, is
 * returned at once rather than retried into a long, confusing wait.
 */
export async function createWithReclaim(o: {
  request: ModuleRequest;
  body: { token: string; account: string; character: string; race: number; class: number };
  log: (msg: string) => void;
  attempts?: number;
  gapMs?: number;
  sleep?: Sleep;
}): Promise<ModuleReply> {
  const sleep = o.sleep ?? bunSleep;
  for (let attempt = 0; attempt < (o.attempts ?? 25); attempt++) {
    const r = await o.request("POST", "/session", o.body);
    if (r.status === 200) return r;
    if (r.json?.error !== "timeout") return r;
    o.log(`create for ${o.body.character} still draining the account (${r.status} ${r.json?.error}); retrying`);
    await sleep(o.gapMs ?? 2_000);
  }
  return { status: 0, json: { error: "reclaim_never_converged" } };
}

/**
 * Delete a character, retrying through the window after its session ends
 * (`account_in_use` while the session is torn down, `504 timeout` through the
 * core's post-logout linger), as the runner's deleteCharacter does. True once
 * it is deleted, or once the module says there is no such character.
 */
export async function deleteCharacterRetrying(o: {
  request: ModuleRequest;
  account: string;
  character: string;
  /** A fresh token for each attempt. */
  token: (attempt: number) => string;
  log: (msg: string) => void;
  attempts?: number;
  gapMs?: number;
  sleep?: Sleep;
}): Promise<boolean> {
  const sleep = o.sleep ?? bunSleep;
  for (let attempt = 0; attempt < (o.attempts ?? 25); attempt++) {
    const del = await o.request("POST", "/character-delete", { token: o.token(attempt), account: o.account, character: o.character });
    if (del.status === 200 && del.json?.deleted) return true;
    if (del.json?.error === "character_not_found") return true;
    if (del.json?.error !== "account_in_use" && del.json?.error !== "timeout") {
      o.log(`character delete (${o.character}) got unexpected ${del.status} ${JSON.stringify(del.json)}`);
    }
    await sleep(o.gapMs ?? 3_000);
  }
  return false;
}

export type ReclaimOutcome =
  /** `POST /characters` answered 200: nothing held the account, and nothing was done. */
  | { leaked: false }
  /** Something held it; it was reclaimed and the throwaway character deleted. */
  | { leaked: true; ok: true; held: string }
  | { leaked: true; ok: false; held: string; why: string };

/**
 * Free `account` of any session left on it. `token` is a fresh smoke token
 * (lib/session.ts) for this account's reclaim; the listing and each delete
 * attempt run under tokens derived from it. Silent when the account is free.
 */
export async function reclaimAccount(o: {
  request: ModuleRequest;
  account: string;
  token: string;
  log: (msg: string) => void;
  /** The throwaway character's name; random by default. */
  character?: string;
  sleep?: Sleep;
}): Promise<ReclaimOutcome> {
  const list = await o.request("POST", "/characters", { token: smokeSubToken(o.token, "list"), account: o.account });
  if (list.status === 200) return { leaked: false };
  const held = `${list.status} ${list.json?.error ?? JSON.stringify(list.json)}`;
  const log = (msg: string) => o.log(`reclaim ${o.account}: ${msg}`);
  log(`POST /characters answered ${held}, so a session is still on the account; reclaiming it under a fresh token`);

  const character = o.character ?? probeName("Rcl");
  const created = await createWithReclaim({
    request: o.request,
    body: { token: o.token, account: o.account, character, race: 1, class: 1 },
    log,
    ...(o.sleep ? { sleep: o.sleep } : {}),
  });
  // A create answered 504 still runs when the world thread reaches it, so the
  // session and the throwaway are cleaned up whatever the create said.
  const bye = await o.request("DELETE", "/session", { token: o.token }).catch(() => undefined);
  const deleted = await deleteCharacterRetrying({
    request: o.request,
    account: o.account,
    character,
    token: (n) => smokeSubToken(o.token, `del${n}`),
    log,
    ...(o.sleep ? { sleep: o.sleep } : {}),
  });
  if (created.status !== 200 || !created.json?.inWorld) {
    return { leaked: true, ok: false, held, why: `the reclaiming create for ${character} answered ${created.status} ${JSON.stringify(created.json)}` };
  }
  if (bye?.status !== 200) log(`warning: deleting the reclaiming session answered ${bye?.status ?? "nothing"} ${JSON.stringify(bye?.json)}`);
  if (!deleted) return { leaked: true, ok: false, held, why: `reclaimed, but the throwaway character ${character} was never deleted; sweep the ${o.account} account` };
  log(`reclaimed; the throwaway ${character} is deleted`);
  return { leaked: true, ok: true, held };
}
