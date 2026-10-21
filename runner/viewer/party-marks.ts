/**
 * A party member's own records, as its run page serves them (`RunDetailResponse.party`):
 * who the party was, the map transfers, the kills, the group changes, the
 * party chat and where the member last was. The party page and the group
 * replay merge the five members' (`dashboard/src/lib/party.ts`); this file
 * only reads one run.
 *
 * Everything here is what the character's client was told. The member list is
 * the run's own stamp (`meta.config.party`, `runner/src/party.ts`) with the
 * accounts left off: an account is the lab's, and no page reads it. A kill's
 * name is the run's own client cache answering the victim's entry
 * (`SMSG_CREATURE_QUERY_RESPONSE`), the name that client would have drawn
 * over the corpse; a zone's is the `WB_AREA` the run was served for that id.
 * The chat is the member's own lines as the server echoed them, which is what
 * the trace records (`readTraceChat`), so five members' lists are disjoint.
 *
 * Read-only like the rest of the viewer: meta.json and client-cache.json are
 * read, and run.sqlite is opened readonly.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { openRunDb } from "../src/rundb";
import type { PartyDetailView, PartyKillMark, PartyMemberRefView, PartyWhereView } from "./api-types";
import type { TrajectoryTail } from "./tail";
import { readTraceChat } from "./trace-db";

/** The client cache's file name (`CLIENT_CACHE_FILE`, `runner/src/sandbox/client-cache.ts`; a test holds the two equal). */
export const CLIENT_CACHE_NAME = "client-cache.json";

/** The party stamp off a run's meta.json, or null on a run that is no party member. */
function partyStampOf(dir: string): { id: string; member: string; role: string; size: number; members: PartyMemberRefView[] } | null {
  const path = join(dir, "meta.json");
  if (!existsSync(path)) return null;
  let p: Record<string, unknown> | undefined;
  try {
    const meta = JSON.parse(readFileSync(path, "utf8")) as { config?: { party?: unknown; campaign?: unknown } };
    if (typeof meta.config?.campaign !== "string") return null;
    p = meta.config.party as Record<string, unknown> | undefined;
  } catch {
    return null;
  }
  if (p === null || typeof p !== "object") return null;
  const { id, member, role, size, members } = p;
  if (typeof id !== "string" || typeof member !== "string" || typeof size !== "number" || !Array.isArray(members)) return null;
  const refs: PartyMemberRefView[] = [];
  for (const m of members as unknown[]) {
    const r = m as Record<string, unknown> | null;
    if (r === null || typeof r !== "object") continue;
    if (typeof r["member"] !== "string" || typeof r["runId"] !== "string") continue;
    // Field by field, so the account on the same record never rides along.
    refs.push({
      member: r["member"],
      role: typeof r["role"] === "string" ? r["role"] : "",
      runId: r["runId"],
      character: typeof r["character"] === "string" ? r["character"] : "",
    });
  }
  return { id, member, role: typeof role === "string" ? role : "", size, members: refs };
}

/**
 * Creature names by entry from the run's client cache, or an empty map when it
 * has none. Only the entries asked for are kept: the cache holds every query
 * the client answered, and a kill list is a handful.
 */
export function creatureNamesOf(dir: string, entries: ReadonlySet<number>): Map<number, string> {
  const out = new Map<number, string>();
  if (entries.size === 0) return out;
  const path = join(dir, CLIENT_CACHE_NAME);
  if (!existsSync(path)) return out;
  let frames: unknown;
  try {
    frames = (JSON.parse(readFileSync(path, "utf8")) as { frames?: unknown }).frames;
  } catch {
    return out;
  }
  if (!Array.isArray(frames)) return out;
  for (const f of frames as unknown[]) {
    const fr = f as { opcode?: unknown; data?: Record<string, unknown> } | null;
    if (fr?.opcode !== "SMSG_CREATURE_QUERY_RESPONSE" || fr.data === undefined) continue;
    const { entry, name, found } = fr.data;
    if (found === false || typeof entry !== "number" || !entries.has(entry) || typeof name !== "string" || name === "") continue;
    out.set(entry, name);
  }
  return out;
}

/** The newest state sample's map, zone and area ids, or null when the run recorded none. */
function lastPlace(dir: string, runId: string): { ts: number; map: number | null; zone: number | null; area: number | null } | null {
  const path = join(dir, "run.sqlite");
  if (!existsSync(path)) return null;
  let db;
  try {
    db = openRunDb(path, { readonly: true });
  } catch {
    return null;
  }
  try {
    const cols = new Set((db.query(`PRAGMA table_info(state)`).all() as { name?: unknown }[]).map((c) => String(c.name)));
    if (!cols.has("map")) return null;
    const zone = cols.has("zone") ? "zone" : "NULL AS zone";
    const area = cols.has("area") ? "area" : "NULL AS area";
    const r = db
      .query(`SELECT ts, map, ${zone}, ${area} FROM state WHERE run_id = ? AND map IS NOT NULL ORDER BY ts DESC LIMIT 1`)
      .get(runId) as { ts?: unknown; map?: unknown; zone?: unknown; area?: unknown } | null;
    if (r === null || typeof r.ts !== "number") return null;
    const n = (v: unknown): number | null => (typeof v === "number" ? v : null);
    return { ts: r.ts, map: n(r.map), zone: n(r.zone), area: n(r.area) };
  } catch {
    return null;
  } finally {
    db.close();
  }
}

/**
 * This run's party block, or null when it is no party member. `tail` must
 * already be scanned: the marks are its accumulators.
 */
export function partyDetailOf(runsDir: string, runId: string, dir: string, tail: TrajectoryTail): PartyDetailView | null {
  const stamp = partyStampOf(dir);
  if (stamp === null) return null;
  const raw = tail.kills;
  const names = creatureNamesOf(dir, new Set(raw.map((k) => k.entry).filter((e): e is number => e !== null)));
  const kills: PartyKillMark[] = raw.map((k) => ({ ...k, name: k.entry === null ? null : (names.get(k.entry) ?? null) }));
  const place = lastPlace(dir, runId);
  const where: PartyWhereView | null =
    place === null
      ? null
      : {
          ...place,
          zoneName: place.zone === null ? null : tail.zoneName(place.zone),
          areaName: place.area === null ? null : tail.areaName(place.area),
        };
  return {
    ...stamp,
    instances: tail.instances,
    kills,
    chat: readTraceChat(runsDir, runId, "party"),
    groups: tail.groups,
    where,
  };
}
