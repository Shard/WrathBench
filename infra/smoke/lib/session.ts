/**
 * The session token a smoke opens a module session under, one spelling for
 * every smoke: `smoke-<smoke>[-<role>]-<uuid>`, where `<smoke>` is the file's
 * name (`bun wb smoke <smoke>`), `<role>` tells a smoke's concurrent sessions
 * apart (group's `a` and `b`), and anything a smoke appends after the uuid
 * (`-create`, `-del1`, `-play`) stays that session's.
 *
 * The module audit log names its files after the token, and `bun wb inspect
 * audit --smoke <smoke>[-<role>]` finds them by this prefix: the name exactly,
 * then the uuid. Character names are a separate matter (`./name.ts`).
 */

/** A smoke's name, or a name and role: what `inspect audit --smoke` takes. */
export const SMOKE_SESSION_NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** A fresh uuid, or `id` to share one across a smoke's sessions or with something else it names (mail's subject). */
export function smokeToken(smoke: string, opts: { role?: string; id?: string } = {}): string {
  const name = opts.role === undefined ? smoke : `${smoke}-${opts.role}`;
  if (!SMOKE_SESSION_NAME.test(name)) throw new Error(`smokeToken: ${JSON.stringify(name)} is not lowercase words joined by hyphens`);
  const id = opts.id ?? crypto.randomUUID();
  // The reducer finds a smoke's files by the eight hex digits right after the name.
  if (!/^[0-9a-f]{8}-/.test(id)) throw new Error("smokeToken: the id must open with a uuid's eight hex digits");
  return `smoke-${name}-${id}`;
}
