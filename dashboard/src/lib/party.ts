/**
 * A party attempt as one thing: the five member runs a Deadmines party is
 * launched, stopped and counted as (docs/proposals/GROUP-PLAY.md §1), read
 * together for the party page and the group replay.
 *
 * Membership is the run's own stamp, `meta.config.party` (`runner/src/party.ts`),
 * as every row carries it (`ResultRun.party`): the party id is the attempt's
 * run-id stem, and runs group by that id, never by parsing a run id. The
 * member order and roles are the stamp's too, the leader first.
 *
 * Built in the browser from what both builds already serve, the way the
 * character page is (docs/PUBLIC-DASHBOARD.md, "The character page over a
 * bucket"): the unfiltered results listing names the members, and each
 * member's run detail carries its own records (`RunDetailResponse.party`, the
 * deaths and the level timeline). So the private viewer and the public bucket
 * run this one derivation, and there is no party route to keep in step.
 */

import type { Client, ResultRun, RunDetailResponse, TrackResponse } from "../api/client";
import type { PartyDetailView, PartyInstanceMark, PartyMemberRefView, PartyWhereView } from "@viewer/api-types";
import { statusOf, type RunStatus } from "./runs";

/**
 * The Deadmines bosses by creature entry (GROUP-PLAY.md §6). Every creature
 * in the instance is rank 1, so the entry, not the rank, says which is a boss.
 * Ids only: the name a page shows is the one the member's client was told.
 */
export const BOSS_ENTRIES: ReadonlySet<number> = new Set([644, 643, 642, 1763, 646, 647, 639, 645]);

/**
 * The terminations that say a run reached its definition's end —
 * `END_REASONS` in `runner/src/end-conditions.ts`, spelled out because the
 * alias does not reach `runner/src` (dashboard/test/party.test.ts pins the
 * two). A party whose member ends on one ends the rest on the same reason.
 */
export const END_REASONS: ReadonlySet<string> = new Set(["level-target", "kill-target"]);

/** The instance the party is launched to clear. */
export const PARTY_INSTANCE_MAP = 36;

/** A party's colours: one per member slot, as `--member-<n>` tokens and `member-<n>` classes. */
export const MEMBER_SLOTS = 5;

/** The class that colours a member's swatch, by its place in the party (0 is the leader). */
export function memberClass(index: number): string {
  return `member-${(((index % MEMBER_SLOTS) + MEMBER_SLOTS) % MEMBER_SLOTS) + 1}`;
}

/** The CSS custom property a member's canvas colour is read from. */
export function memberToken(index: number): string {
  return `--${memberClass(index)}`;
}

export function partyHref(id: string): string {
  return `/party/${encodeURIComponent(id)}`;
}

export function partyReplayHref(id: string): string {
  return `/map?party=${encodeURIComponent(id)}`;
}

/** `?party=` as one id, or undefined: a repeated or empty param is no party. */
export function partyParam(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** A row's place in its party, for ordering: the stamp's index, then the member id. */
function slotOf(r: Pick<ResultRun, "party">): number {
  return r.party?.index ?? Number.MAX_SAFE_INTEGER;
}

/** The rows of one party, in member order. */
export function partyRowsOf(runs: readonly ResultRun[], id: string): ResultRun[] {
  return runs
    .filter((r) => r.party?.id === id)
    .sort((a, b) => slotOf(a) - slotOf(b) || a.party!.member.localeCompare(b.party!.member));
}

/**
 * A sorted listing with each party's rows brought together where its first
 * row stands, in member order — so a sort that puts five members started a
 * second apart in any order still reads as one block. Every other row keeps
 * its place, and nothing is added or dropped.
 */
export function groupParties<T extends Pick<ResultRun, "runId" | "party">>(rows: readonly T[]): T[] {
  const byParty = new Map<string, T[]>();
  for (const r of rows) {
    if (r.party === undefined) continue;
    const list = byParty.get(r.party.id);
    if (list === undefined) byParty.set(r.party.id, [r]);
    else list.push(r);
  }
  const placed = new Set<string>();
  const out: T[] = [];
  for (const r of rows) {
    if (r.party === undefined) {
      out.push(r);
      continue;
    }
    if (placed.has(r.party.id)) continue;
    placed.add(r.party.id);
    const members = byParty.get(r.party.id)!;
    out.push(...[...members].sort((a, b) => slotOf(a) - slotOf(b) || a.party!.member.localeCompare(b.party!.member)));
  }
  return out;
}

/** One member of the party as the page shows it. */
export interface PartyMember {
  member: string;
  role: string;
  runId: string;
  character: string;
  /** Its place in the stamp's member order, the leader at 0; the colour slot. */
  index: number;
  /** The member's row, or null when the listing holds none (a launch that never wrote one). */
  row: ResultRun | null;
  status: RunStatus | null;
  level: number | null;
  xp: number | null;
  deaths: number | null;
  where: PartyWhereView | null;
  terminationReason: string | null;
  terminationDetail: string | null;
}

/** One line of the merged timeline. */
export type PartyEvent =
  | { kind: "death"; ts: number; member: string; map: number | null }
  | { kind: "enter" | "leave"; ts: number; member: string; map: number; from: number }
  | { kind: "kill"; ts: number; member: string | null; entry: number | null; name: string | null; boss: boolean; seenBy: string[] }
  | { kind: "level"; ts: number; member: string; level: number }
  | { kind: "chat"; ts: number; member: string; text: string }
  | { kind: "left"; ts: number; member: string }
  | { kind: "end"; ts: number; member: string; reason: string };

export type PartyEventKind = PartyEvent["kind"];

/** The party at the moment it was read. */
export interface PartyView {
  id: string;
  size: number;
  members: PartyMember[];
  model: string | null;
  harness: ResultRun["harness"];
  harnessVersion: string | null;
  campaign: string | null;
  cell: string | null;
  arm: string | null;
  campaignVersion: number | null;
  startedAt: number | null;
  /** The last member's end; null while any member is unterminated. */
  endedAt: number | null;
  /** Live while any member is; paused when one is and none is live; ended otherwise. */
  status: RunStatus;
  /**
   * How the attempt ended or paused: the first reason that is not the
   * party's own (`party-ended`, `party-paused`), and the member it was only
   * when exactly one member's was (else null: they all stopped that way).
   * Null while the party plays.
   */
  endedBy: { member: string | null; reason: string; detail: string | null } | null;
  /** The attempt ended on its definition's end (`END_REASONS`): the measurement it was launched for was taken. */
  reached: boolean;
  /** The bosses killed, by entry, in kill order (`BOSS_ENTRIES`). */
  bosses: { entry: number; name: string | null; ts: number }[];
  events: PartyEvent[];
}

/** The member list: a member's own stamp where a detail carries one, else the rows'. */
function refsOf(rows: readonly ResultRun[], details: readonly (RunDetailResponse | null)[]): PartyMemberRefView[] {
  for (const d of details) if (d?.party !== undefined && d.party.members.length > 0) return d.party.members;
  return rows.map((r) => ({ member: r.party!.member, role: r.party!.role ?? "", runId: r.runId, character: "" }));
}

/**
 * The kills, one per victim: every member in range is told of the same kill,
 * so the victim guid is the key. The entry and the name are whichever member's
 * unit cache knew them; the killer is the member who landed the blow when one
 * of the five says it did.
 */
function mergedKills(parts: readonly { member: string; party: PartyDetailView }[]): Extract<PartyEvent, { kind: "kill" }>[] {
  const byVictim = new Map<string, Extract<PartyEvent, { kind: "kill" }>>();
  for (const { member, party } of parts) {
    for (const k of party.kills) {
      const have = byVictim.get(k.victimGuid);
      if (have === undefined) {
        byVictim.set(k.victimGuid, {
          kind: "kill",
          ts: k.ts,
          member: k.self ? member : null,
          entry: k.entry,
          name: k.name,
          boss: k.entry !== null && BOSS_ENTRIES.has(k.entry),
          seenBy: [member],
        });
        continue;
      }
      have.ts = Math.min(have.ts, k.ts);
      if (k.self) have.member = member;
      have.entry ??= k.entry;
      have.name ??= k.name;
      have.boss = have.entry !== null && BOSS_ENTRIES.has(have.entry);
      if (!have.seenBy.includes(member)) have.seenBy.push(member);
    }
  }
  return [...byVictim.values()];
}

/**
 * The map a member stood on at `ts`, by its instance transfers (oldest first):
 * the last transfer's destination, or before the first one the map it left.
 * Null for a member that made none.
 */
export function mapAt(instances: readonly PartyInstanceMark[], ts: number): number | null {
  let map: number | null = instances[0]?.from ?? null;
  for (const i of instances) {
    if (i.ts > ts) break;
    map = i.map;
  }
  return map;
}

/**
 * The party from its rows (the unfiltered listing's, any order) and each
 * member's detail, keyed by run id; a member whose detail failed reads from
 * its row alone. Null when the listing holds no row of the party.
 */
export function partyViewOf(id: string, rows: readonly ResultRun[], details: ReadonlyMap<string, RunDetailResponse | null>): PartyView | null {
  const mine = partyRowsOf(rows, id);
  if (mine.length === 0) return null;
  const refs = refsOf(mine, [...details.values()]);
  const rowOf = new Map(mine.map((r) => [r.runId, r]));
  /*
   * A place a member was never served a name for may be one another member
   * was: the zone and area names are the client's for an id, the same on all
   * five, so the party's own readings fill each other's gaps.
   */
  const zoneNames = new Map<number, string>();
  const areaNames = new Map<number, string>();
  for (const d of details.values()) {
    const w = d?.party?.where;
    if (w == null) continue;
    if (w.zone !== null && w.zoneName !== null) zoneNames.set(w.zone, w.zoneName);
    if (w.area !== null && w.areaName !== null) areaNames.set(w.area, w.areaName);
  }
  const named = (w: PartyWhereView | null | undefined): PartyWhereView | null =>
    w == null
      ? null
      : {
          ...w,
          zoneName: w.zoneName ?? (w.zone === null ? null : (zoneNames.get(w.zone) ?? null)),
          areaName: w.areaName ?? (w.area === null ? null : (areaNames.get(w.area) ?? null)),
        };
  const members: PartyMember[] = refs.map((ref, index) => {
    const row = rowOf.get(ref.runId) ?? null;
    const d = details.get(ref.runId) ?? null;
    return {
      member: ref.member,
      role: ref.role,
      runId: ref.runId,
      character: ref.character !== "" ? ref.character : (d?.run.character ?? ""),
      index,
      row,
      status: row === null ? null : statusOf(row),
      level: d?.run.level ?? row?.maxLevel ?? null,
      xp: d?.run.xp ?? row?.xp ?? null,
      deaths: d?.deaths?.deaths ?? null,
      where: named(d?.party?.where),
      terminationReason: row?.terminationReason ?? null,
      terminationDetail: d?.run.terminationDetail ?? null,
    };
  });

  const events: PartyEvent[] = [];
  const parts: { member: string; party: PartyDetailView }[] = [];
  for (const m of members) {
    const d = details.get(m.runId) ?? null;
    if (d === null) continue;
    // The member's death times off its party block, on the map its own transfers put it on then.
    for (const ts of d.party?.deaths ?? []) {
      events.push({ kind: "death", ts, member: m.member, map: mapAt(d.party?.instances ?? [], ts) });
    }
    for (const l of d.leveling?.marks ?? []) {
      if (l.from !== null && l.to > l.from) events.push({ kind: "level", ts: l.ts, member: m.member, level: l.to });
    }
    if (d.party !== undefined) {
      parts.push({ member: m.member, party: d.party });
      for (const i of d.party.instances) {
        events.push({ kind: i.event === "entered" ? "enter" : "leave", ts: i.ts, member: m.member, map: i.event === "entered" ? i.map : i.from, from: i.from });
      }
      for (const c of d.party.chat) events.push({ kind: "chat", ts: c.ts, member: m.member, text: c.text });
      for (const g of d.party.groups) if (g.event === "left") events.push({ kind: "left", ts: g.ts, member: m.member });
    }
    if (m.row?.endedAt != null && m.terminationReason !== null) {
      events.push({ kind: "end", ts: m.row.endedAt, member: m.member, reason: m.terminationReason });
    }
  }
  const kills = mergedKills(parts);
  events.push(...kills);
  // Oldest first; a tie keeps member order, so one instant reads leader first.
  const order = new Map(members.map((m) => [m.member, m.index]));
  events.sort((a, b) => a.ts - b.ts || (order.get(a.member ?? "") ?? 99) - (order.get(b.member ?? "") ?? 99));

  const lead = mine[0]!;
  const statuses = members.map((m) => m.status);
  const status: RunStatus = statuses.includes("live")
    ? "live"
    : statuses.includes("stalled")
      ? "stalled"
      : statuses.includes("paused")
        ? "paused"
        : "ended";
  const starts = mine.map((r) => r.startedAt).filter((t): t is number => t !== null);
  const ends = mine.map((r) => r.endedAt ?? null);
  /*
   * A member is named only where the record says one member's own verdict
   * ended the rest: exactly one terminated (or paused) on a reason that is
   * not the party's. Five stopped the same way at once (an operator's stop)
   * is the reason alone, with nobody to blame.
   */
  // A member ended on the reason another member's run reached carries that
  // member's name as its detail (`<member>: <reason>`, infra/party-fate.ts):
  // the party's end, not its own verdict.
  const inherited = (m: PartyMember): boolean =>
    m.terminationReason === "party-ended" ||
    members.some((o) => o.member !== m.member && m.terminationDetail === `${o.member}: ${m.terminationReason}`);
  const own = members.filter((m) => m.terminationReason !== null && !inherited(m));
  const pausedOwn = members.filter((m) => m.row?.pauseReason != null && m.row.pauseReason !== "party-paused");
  const verdictOf = (list: PartyMember[], reasonOf: (m: PartyMember) => string, detailOf: (m: PartyMember) => string | null): PartyView["endedBy"] => {
    if (list.length === 0) return null;
    const first = [...list].sort((a, b) => (a.row?.endedAt ?? Infinity) - (b.row?.endedAt ?? Infinity))[0]!;
    return { member: list.length === 1 ? first.member : null, reason: reasonOf(first), detail: detailOf(first) };
  };
  const endedBy =
    status === "live"
      ? null
      : (verdictOf(own, (m) => m.terminationReason!, (m) => m.terminationDetail) ??
        verdictOf(pausedOwn, (m) => m.row!.pauseReason!, () => null));
  return {
    id,
    size: lead.party!.size,
    members,
    model: lead.model,
    harness: lead.harness,
    harnessVersion: lead.harnessVersion,
    campaign: lead.campaign,
    cell: lead.cell,
    arm: lead.arm ?? null,
    campaignVersion: lead.campaignVersion ?? null,
    startedAt: starts.length === 0 ? null : Math.min(...starts),
    endedAt: status === "live" || ends.some((e) => e === null) ? null : Math.max(...(ends as number[])),
    status,
    endedBy,
    reached: status === "ended" && endedBy !== null && END_REASONS.has(endedBy.reason),
    bosses: kills
      .filter((k) => k.boss)
      .sort((a, b) => a.ts - b.ts)
      .map((k) => ({ entry: k.entry!, name: k.name, ts: k.ts })),
    events,
  };
}

/**
 * Whether the party page has anything still moving: the party is live. A party
 * the listing does not hold (`null`) has nothing to watch either, until one
 * appears, which the idle period covers.
 */
export function partyIsLive(view: PartyView | null): boolean {
  return view !== null && view.status === "live";
}

/**
 * Fetch and assemble one party: the unfiltered listing for its members, then
 * each member's detail. A member's detail that fails leaves that member to its
 * row; a party the listing does not hold is a 404 from the caller's view.
 */
export async function loadParty(client: Pick<Client, "results" | "run">, id: string): Promise<PartyView | null> {
  const listing = await client.results("all", true, "all");
  const rows = partyRowsOf(listing.runs, id);
  if (rows.length === 0) return null;
  const details = new Map<string, RunDetailResponse | null>();
  await Promise.all(
    rows.map(async (r) => {
      details.set(r.runId, await client.run(r.runId).catch(() => null));
    }),
  );
  // A member the listing has no row for is named by the others' stamps; fetch it too.
  const named = refsOf(rows, [...details.values()]).map((m) => m.runId).filter((runId) => !details.has(runId));
  await Promise.all(
    named.map(async (runId) => {
      details.set(runId, await client.run(runId).catch(() => null));
    }),
  );
  return partyViewOf(id, listing.runs, details);
}

/**
 * What a party's transport steps and scrubs over: every member's 60 s points
 * on one clock, under the party's own key, so the play bar, the step keys and
 * the cursor memory treat the attempt as the one replay it is. No pip is
 * drawn from it; each member's own track places that member.
 */
export function groupTrack(id: string, tracks: readonly TrackResponse[]): TrackResponse {
  const first = tracks[0];
  return {
    runId: `party:${id}`,
    characterName: null,
    model: first?.model ?? null,
    harnessVersion: first?.harnessVersion ?? null,
    points: tracks.flatMap((t) => t.points).sort((a, b) => a.ts - b.ts),
  };
}

/**
 * Where a member last was, as one label: the map, then the zone and the area
 * where the client was served a name for them and it says something the one
 * before it did not. The ids are `whereIds`, for the hover.
 */
export function whereLabel(w: PartyWhereView | null, mapName: (map: number) => string): string {
  if (w === null) return "—";
  const parts = [w.map === null ? null : mapName(w.map), w.zoneName, w.areaName].filter((p): p is string => p !== null && p !== "");
  const out: string[] = [];
  for (const p of parts) if (out[out.length - 1] !== p) out.push(p);
  return out.length === 0 ? "—" : out.join(" · ");
}

export function whereIds(w: PartyWhereView): string {
  return `map ${w.map ?? "—"} · zone ${w.zone ?? "—"} · area ${w.area ?? "—"}`;
}

/** The member a timeline line belongs to, by id. */
export function memberOf(view: Pick<PartyView, "members">, member: string | null): PartyMember | undefined {
  return member === null ? undefined : view.members.find((m) => m.member === member);
}
