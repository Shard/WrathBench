/**
 * A run's module session token, as a value to strike from the copies of its
 * record that leave the runs volume.
 *
 * The runner keeps the token in meta.json, its one home, for `--resume`
 * (`Trajectory.writeMeta`). It still reaches the trajectory another way: the
 * module names the token in nearly every action reply, a snippet that logs a
 * reply puts it in that snippet's result, and the result is recorded as the
 * model saw it. That record stays as it is — it is what the model read. The
 * copies are what this is for: the collector strikes it from every line it
 * stores, and the viewer in public mode from every body that carries a run's
 * model-written text (the run's own routes, the live map's status lines, a
 * character's attempts), so neither the derived store nor the public site
 * holds one.
 *
 * On its own the token is not a capability (the module also wants the run's
 * lease secret or the operator's bearer, `module/src/WbManager.cpp`), but it is
 * the session's name and is treated as a secret everywhere it is written.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MIN_TOKEN_LENGTH } from "./config";
import { REDACTED } from "./redact";

/**
 * The token meta.json holds for the run in `dir`, or null when there is none
 * worth striking. A run from before token hardening used its run id as its
 * token, and striking that would blank every mention of the run's own id, so
 * a token under the module's length floor, or equal to the run id, is never
 * struck.
 */
export function strikableSessionToken(dir: string, runId: string): string | null {
  let token: unknown;
  try {
    token = (JSON.parse(readFileSync(join(dir, "meta.json"), "utf8")) as { config?: { token?: unknown } }).config?.token;
  } catch {
    return null;
  }
  return typeof token === "string" && token.length >= MIN_TOKEN_LENGTH && token !== runId ? token : null;
}

/**
 * `text` with every occurrence of `token` replaced by `[redacted]`; `text` as
 * it is when there is none. Safe on serialised JSON: a token is hex, so the
 * replacement never touches a quote or an escape.
 */
export function strikeSessionToken(text: string, token: string | null): string {
  return token === null ? text : text.replaceAll(token, REDACTED);
}

/** `text` with each of several runs' tokens struck: a body that is about more than one run. */
export function strikeSessionTokens(text: string, tokens: readonly string[]): string {
  let out = text;
  for (const t of tokens) out = out.replaceAll(t, REDACTED);
  return out;
}
