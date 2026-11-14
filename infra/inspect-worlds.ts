/**
 * `bun wb inspect worlds`: every world per eval the fleet has made, read-only
 * (infra/world.ts). From the records under data/worlds: each world's state,
 * runs, realm, accounts, boots and teardown, and whether failed boots hold new
 * ones. With the database reachable, the world schemas and realm rows no open
 * record holds — what the fleet's reconcile lists and never drops. Nothing
 * here writes, deletes or opens a session.
 */

import { join } from "node:path";
import { mysqlWorldDb, WorldStore, worldsHold, WORLDS_DIR, type WorldRecord } from "./world";

const REPO_ROOT = join(import.meta.dir, "..");

function ago(ms: number, now: number): string {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 120) return `${s}s ago`;
  if (s < 7200) return `${Math.round(s / 60)}m ago`;
  return `${Math.round(s / 3600)}h ago`;
}

/** One world, in a few lines. */
export function formatWorld(r: WorldRecord, now: number): string[] {
  const boots = r.boots.map((b) => (b.failed !== undefined ? `failed (${b.failed.slice(0, 120)})` : b.bootMs !== undefined ? `${Math.round(b.bootMs / 1000)}s` : "booting"));
  const lines = [
    `${r.id}  ${r.state.padEnd(7)}  realm ${r.realmId}  made ${ago(r.createdAt, now)}${r.endedAt !== undefined ? `, ended ${ago(r.endedAt, now)}` : ""}`,
    `  runs      ${r.runIds.join(", ")}`,
    `  accounts  ${r.accounts.join(", ")}`,
    `  boots     ${boots.length > 0 ? boots.join("; ") : "none"}`,
  ];
  if (r.images.worldserver !== undefined) lines.push(`  image     ${r.images.worldserver}`);
  if (r.teardown !== undefined) {
    const t = r.teardown;
    lines.push(`  teardown  ${t.why}; schema ${t.schemaDropped ? "dropped" : "KEPT"}, realm ${t.realmDeleted ? "deleted" : "KEPT"}, log ${t.logSaved ? "saved" : "not saved"}`);
  }
  return lines;
}

export async function main(argv: string[] = Bun.argv.slice(2)): Promise<void> {
  const all = argv.includes("--all");
  const store = new WorldStore(join(REPO_ROOT, WORLDS_DIR));
  const now = Date.now();
  const records = store.list().sort((a, b) => b.createdAt - a.createdAt);
  const open = records.filter((r) => r.state !== "ended");
  const shown = all ? records : open;
  console.log(`worlds: ${open.length} open, ${records.length - open.length} ended${all ? "" : " (--all lists those too)"}`);
  const hold = worldsHold(store.dir, now);
  if (hold !== undefined) console.log(hold);
  for (const r of shown) for (const line of formatWorld(r, now)) console.log(line);
  try {
    const db = await mysqlWorldDb();
    try {
      const schemas = new Set(open.map((r) => r.schema));
      const realms = new Set(open.map((r) => r.realmId));
      const orphanSchemas = (await db.schemas()).filter((s) => !schemas.has(s));
      const orphanRealms = (await db.realmIds()).filter((id) => !realms.has(id));
      console.log(`database: ${orphanSchemas.length === 0 ? "no world schema" : `schemas no open record holds: ${orphanSchemas.join(", ")}`}; ${orphanRealms.length === 0 ? "no realm row" : `realm rows no open record holds: ${orphanRealms.join(", ")}`} outside the records`);
    } finally {
      await db.close();
    }
  } catch (e) {
    console.log(`database: not read (${e instanceof Error ? e.message : String(e)})`);
  }
}

if (import.meta.main) await main();
