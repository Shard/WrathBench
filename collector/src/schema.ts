/**
 * Applying `schema.sql`.
 *
 * The file is the source of truth and is shipped as SQL rather than generated
 * from TypeScript: an operator debugging a query wants to read the DDL the
 * server actually has, and a `CREATE TABLE` that only exists as a template is
 * one more thing to reconstruct at three in the morning. This splits it on
 * statement boundaries and sends each one; every statement is
 * `IF NOT EXISTS`, so applying it to a live store is a no-op.
 */

import { join } from "node:path";
import type { Sink } from "./sink";

/** Where `schema.sql` lives, relative to this file. */
export const SCHEMA_PATH = join(import.meta.dir, "..", "schema.sql");

/**
 * Split on `;` at the end of a line.
 *
 * Crude, and adequate: every statement in `schema.sql` ends that way and none
 * of them contains a string literal with a semicolon. A schema that needs more
 * than this needs a migration tool, and this store — disposable by design —
 * does not have migrations, it has `--replay`.
 */
export function splitStatements(sql: string): string[] {
  return sql
    .split(/;\s*\n/)
    .map((s) =>
      s
        .split("\n")
        .filter((l) => !l.trimStart().startsWith("--"))
        .join("\n")
        .trim(),
    )
    .filter((s) => s.length > 0)
    .map((s) => (s.endsWith(";") ? s.slice(0, -1) : s));
}

export async function applySchema(sink: Sink, path: string = SCHEMA_PATH): Promise<number> {
  const sql = await Bun.file(path).text();
  const statements = splitStatements(sql);
  for (const s of statements) await sink.exec(s);
  return statements.length;
}
