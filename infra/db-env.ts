/**
 * The AzerothCore MySQL password every infra writer connects with: the
 * runner's own `WRATHBENCH_DB_PASSWORD`, else the root password the database
 * container was started with, else the quickstart default. One rule, so
 * bootstrap, the stagers, the archive and the GM account never disagree.
 */
export function dbPassword(env: Record<string, string | undefined> = process.env): string {
  return env["WRATHBENCH_DB_PASSWORD"] ?? env["WRATHBENCH_DB_ROOT_PASSWORD"] ?? "wrathbench";
}
