/**
 * A run's module session token, as a value to strike from the copies of its
 * record that leave the runs volume: a backstop for runs recorded before the
 * token stopped reaching the record, not the fix.
 *
 * The runner keeps the token in meta.json, its one home, for `--resume`
 * (`Trajectory.writeMeta`). The trajectory is not meant to carry it: the
 * runner keeps it out of the record, and the module out of its action
 * replies. Older trajectories do carry it: in their `meta` records
 * and `config_json`, and wherever a snippet logged a module reply that echoed
 * it, recorded as the model saw it. Those files are never rewritten, and they
 * are re-ingested and re-rendered, so each copy strikes it once: the collector
 * from every text it stores (`collector/src/ingest.ts`), and the viewer's
 * public boundary from every public body that carries a run's text
 * (`publicText`, `runner/viewer/api.ts`).
 *
 * On its own the token is not a capability (the module also wants the run's
 * lease secret or the operator's bearer, `wrath-mcp/module/src/WbManager.cpp`), but it is
 * the session's name and is treated as a secret everywhere it is written.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MIN_TOKEN_LENGTH } from "./config";
import { REDACTED } from "@wrathbench/mcp/redact";

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
