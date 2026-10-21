/**
 * A campaign's end conditions: what, observed in the world, ends a run as a
 * measurement taken rather than a clock spent (docs/EPISODES.md, "Ends").
 *
 * Two kinds, one list:
 *
 *   { level: N }          the first server-observed level at or above N
 *                         (`level-target`). The older spelling is the
 *                         definition's `stopAtLevel`, which every definition
 *                         published before `end` carries and keeps.
 *   { kill: { entry } }   a kill of that creature template credited to this
 *                         character or to a member of its group
 *                         (`kill-target`; operator, 2026-10-21: deadmines@4
 *                         ends on Edwin VanCleef).
 *
 * The kill reading is the `kill` milestone the sandbox child latches off
 * `SMSG_PARTYKILLLOG` (`sandbox/party-watch.ts`): the server sends it to every
 * member of the tapping group, wherever each stands, naming the loot
 * recipient as the killer, or to the killer alone when it has no group. A
 * kill a client outside that group made is never sent to it, and a killer
 * guid that is neither this character nor one of its group's members is
 * not credited. Nothing here is told to the model.
 *
 * Import-light (zod only) so the viewer, the fleet and the party machine can
 * all read it.
 */

import { z } from "zod";

export const endConditionSchema = z.union([
  z.object({ level: z.number().int().min(2).max(80) }).strict(),
  z.object({ kill: z.object({ entry: z.number().int().positive() }).strict() }).strict(),
]);
export type EndCondition = z.infer<typeof endConditionSchema>;

/**
 * The terminations that say a run reached its definition's end: a verdict
 * that counts, and the one a party's other members inherit when a member's
 * run ends on it (`infra/party-fate.ts`).
 */
export const END_REASONS = ["level-target", "kill-target"] as const;
export type EndReason = (typeof END_REASONS)[number];

export function isEndReason(reason: string | null | undefined): reason is EndReason {
  return reason != null && (END_REASONS as readonly string[]).includes(reason);
}

/** A definition's ends as one list: `stopAtLevel` as a level end, then `end`. */
export function endConditionsOf(def: { stopAtLevel?: number | null; end?: readonly EndCondition[] | undefined }): EndCondition[] {
  return [...(def.stopAtLevel != null ? [{ level: def.stopAtLevel }] : []), ...(def.end ?? [])];
}

/** The lowest level end, or null: what "minutes to the stop" is measured to. */
export function levelTargetOf(ends: readonly EndCondition[]): number | null {
  const levels = ends.flatMap((e) => ("level" in e ? [e.level] : []));
  return levels.length === 0 ? null : Math.min(...levels);
}

/** The creature entries a kill end names. */
export function killEntriesOf(ends: readonly EndCondition[]): number[] {
  return ends.flatMap((e) => ("kill" in e ? [e.kill.entry] : []));
}

/**
 * The creature entry a 3.3.5a unit guid carries in bits 24..47 (high type
 * 0xF130 a creature, 0xF150 a vehicle) — the client's own reading of a guid,
 * for a kill whose victim this character's unit cache never held. Undefined
 * for any other guid.
 */
export function creatureEntryOfGuid(guid: string): number | undefined {
  try {
    const g = BigInt(guid);
    const high = Number(g >> 48n);
    if (high !== 0xf130 && high !== 0xf150) return undefined;
    const entry = Number((g >> 24n) & 0xffffffn);
    return entry > 0 ? entry : undefined;
  } catch {
    return undefined;
  }
}

/** A kill as the end check reads it. */
export interface KillReading {
  killerGuid: string;
  victimGuid: string;
  entry?: number | undefined;
  /** The killer is this character. */
  self: boolean;
  /** The killer is this character or a member of its group when the kill was told; absent on a record from before the field. */
  member?: boolean | undefined;
}

/** The entry a kill names: its own, else its victim guid's. */
export function killEntry(k: Pick<KillReading, "entry" | "victimGuid">): number | undefined {
  return k.entry ?? creatureEntryOfGuid(k.victimGuid);
}

/** The kill end a credited kill meets, or null. */
export function killEndMet(ends: readonly EndCondition[], k: KillReading, members?: ReadonlySet<string>): { entry: number } | null {
  const credited = k.member ?? (k.self || (members?.has(k.killerGuid) ?? false));
  if (!credited) return null;
  const entry = killEntry(k);
  if (entry === undefined) return null;
  return killEntriesOf(ends).includes(entry) ? { entry } : null;
}

export function killEndDetail(k: { entry: number; killerGuid: string; self: boolean }): string {
  return `entry ${k.entry} killed (killer ${k.self ? "this character" : `party member ${k.killerGuid}`})`;
}

/** The milestone records the retro reading folds. */
export type EndMilestone =
  | { kind: "level"; to: number }
  | { kind: "group"; event: "joined" | "changed" | "left"; members: readonly string[] }
  | ({ kind: "kill"; observedTs?: number | undefined } & KillReading)
  | { kind: string };

/**
 * Whether a run's recorded milestones meet its ends, and on which record:
 * the same reading the live watchdog makes, over a trajectory after the fact.
 * The group's members are folded from the `group` milestones before each
 * kill, for a kill record written before kills carried `member`.
 */
export function endFromMilestones(
  ends: readonly EndCondition[],
  milestones: readonly EndMilestone[],
): { reason: EndReason; detail: string; observedTs?: number } | null {
  const target = levelTargetOf(ends);
  let members = new Set<string>();
  for (const m of milestones) {
    if (m.kind === "level" && "to" in m) {
      if (target !== null && m.to >= target) return { reason: "level-target", detail: `level ${m.to} observed (target ${target})` };
    } else if (m.kind === "group" && "members" in m) {
      members = m.event === "left" ? new Set() : new Set(m.members);
    } else if (m.kind === "kill" && "killerGuid" in m) {
      const met = killEndMet(ends, m, members);
      if (met !== null) {
        return {
          reason: "kill-target",
          detail: killEndDetail({ entry: met.entry, killerGuid: m.killerGuid, self: m.self }),
          ...(m.observedTs !== undefined ? { observedTs: m.observedTs } : {}),
        };
      }
    }
  }
  return null;
}
