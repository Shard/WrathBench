/**
 * Deleting last run's character before a smoke creates it again, through
 * `POST /character-delete` (the client's CMSG_CHAR_DELETE path). Two
 * policies, each the one its smokes always had; they differ on purpose.
 *
 * - `deletePreviousCharacter`: four tries two seconds apart, retrying only a
 *   504, for the SDK smokes that recreate a fixed name each run.
 * - `deletePreviousThroughLinger`: the core's post-logout linger waited out
 *   on lib/transient.ts's budget, announced as a retry, for the raw smokes
 *   the suite runs.
 *
 * Every attempt runs under its own sub-token of the smoke's, so `inspect
 * audit --smoke` finds it. A failure goes through the smoke's own `fail`.
 */

import { authHeaders } from "./auth";
import type { ModuleRequest } from "./module";
import { smokeSubToken } from "./session";
import { deleteThroughLinger } from "./transient";

type Who = { token: string; account: string; character: string; log: (msg: string) => void; fail: (msg: string) => never };

export async function deletePreviousCharacter(o: Who & { base: string }): Promise<void> {
  for (let attempt = 0; attempt < 4; ++attempt) {
    const res = await fetch(`${o.base}/character-delete`, {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders() },
      body: JSON.stringify({ token: smokeSubToken(o.token, `del${attempt}`), account: o.account, character: o.character }),
    });
    const json: any = await res.json().catch(() => undefined);
    if (json?.deleted === true) return o.log(`deleted last run's ${o.character}`);
    if (json?.error === "character_not_found") return o.log(`no previous ${o.character}`);
    o.log(`character-delete attempt ${attempt}: ${res.status} ${JSON.stringify(json)}`);
    if (res.status !== 504) break;
    await Bun.sleep(2000);
  }
  o.fail(`could not delete last run's ${o.character}`);
}

export async function deletePreviousThroughLinger(o: Who & { request: ModuleRequest }): Promise<void> {
  const r = await deleteThroughLinger({
    post: (attempt) => o.request("POST", "/character-delete", { token: smokeSubToken(o.token, `del${attempt}`), account: o.account, character: o.character }),
    character: o.character,
    log: o.log,
  });
  if (!r.ok) o.fail(`could not delete last run's ${o.character}: ${r.why}`);
  const waited = r.retries > 0 ? ` after ${r.retries} retr${r.retries === 1 ? "y" : "ies"} over ${Math.round(r.waitedMs / 1000)}s` : "";
  o.log(r.deleted ? `deleted last run's ${o.character}${waited}` : `no previous ${o.character} to delete (first run on this realm)`);
}
