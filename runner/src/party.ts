/**
 * A party: several runs of one model, one character each, launched together
 * as one attempt (docs/proposals/GROUP-PLAY.md, the operator's decisions of
 * 2026-10-19). The shapes every side of a party launch shares, and nothing
 * else:
 *
 * - the definition's half (`PartyDefinition`), a block of a campaign
 *   definition: the size, and per member its id, role, start and staged
 *   character name, and the objective it is given;
 * - the launch's half (`PartyLaunch`), in each member's `campaign.json`: the
 *   party id and which member this run is, with every member's run id and
 *   account, so the five trajectories name each other;
 * - the run's stamp (`PartyConfig`), `meta.config.party`, built from the two.
 *
 * The party id is the job's run-id stem and a member's run id is
 * `<stem>-<member>` (`memberRunId`), so the five directories sort together
 * and the stem alone names the attempt.
 *
 * Kept free of the runner's heavier modules: the fleet, the roster and the
 * viewer import it.
 */

import { z } from "zod";
import { CHARACTER_NAME_RULE, isValidCharacterName } from "./character-name";

/** The roles a member is, one word each, the same for every model (GROUP-PLAY.md §8). */
export const PARTY_ROLES = ["tank", "healer", "damage"] as const;
export type PartyRole = (typeof PARTY_ROLES)[number];

/** Safe in a run id and a path: a member id is the run id's suffix. */
const MEMBER_ID = /^[a-z][a-z0-9]{0,15}$/;

const characterSchema = z.string().refine(isValidCharacterName, { message: CHARACTER_NAME_RULE });

export const partyMemberSchema = z
  .object({
    /** The run id's suffix: `tank`, `healer`, `mage`, … */
    id: z.string().regex(MEMBER_ID, "a member id is 1-16 lowercase letters and digits, starting with a letter"),
    role: z.enum(PARTY_ROLES),
    /** The client's own race and class ids, as a cell declares them. */
    race: z.number().int().positive(),
    class: z.number().int().positive(),
    /**
     * The name the stager creates the member under, and the one its run is
     * launched with (`--character`). In the definition, and so in its hash,
     * because the objective text names the other members by it.
     */
    character: characterSchema,
    /** Rendered verbatim into this member's operator-objective block. */
    objective: z.string().min(1).max(4000),
  })
  .strict();
export type PartyMember = z.infer<typeof partyMemberSchema>;

export const partyDefinitionSchema = z
  .object({
    size: z.number().int().min(2).max(5),
    /** In member order; the first is the party leader. */
    members: z.array(partyMemberSchema).min(2),
  })
  .strict()
  .superRefine((p, ctx) => {
    if (p.members.length !== p.size) {
      ctx.addIssue({ code: "custom", path: ["members"], message: `a party of size ${p.size} declares ${p.members.length} member(s)` });
    }
    const dupes = <T>(xs: readonly T[]): T[] => [...new Set(xs.filter((x, i) => xs.indexOf(x) !== i))];
    for (const id of dupes(p.members.map((m) => m.id))) ctx.addIssue({ code: "custom", path: ["members"], message: `member ${id} is declared twice` });
    for (const n of dupes(p.members.map((m) => m.character.toLowerCase()))) {
      ctx.addIssue({ code: "custom", path: ["members"], message: `character ${n} is declared twice` });
    }
  });
export type PartyDefinition = z.infer<typeof partyDefinitionSchema>;

/** One member as a launch knows it: which run is whose. */
export const partyMemberRecordSchema = z
  .object({
    member: z.string().regex(MEMBER_ID),
    role: z.enum(PARTY_ROLES),
    runId: z.string().min(1),
    account: z.string().min(2).max(16),
    character: characterSchema,
  })
  .strict();
export type PartyMemberRecord = z.infer<typeof partyMemberRecordSchema>;

/** The launch half, as a member's `campaign.json` carries it. */
export const partyLaunchSchema = z
  .object({
    /** The run-id stem the five member ids hang off. */
    id: z.string().min(1).max(200),
    /** Which member this run is. */
    member: z.string().regex(MEMBER_ID),
    members: z.array(partyMemberRecordSchema).min(2),
  })
  .strict();
export type PartyLaunch = z.infer<typeof partyLaunchSchema>;

/** `meta.config.party`: the launch, with this member's role and the party's size spelled out. */
export const partyConfigSchema = z
  .object({
    id: z.string().min(1).max(200),
    member: z.string().regex(MEMBER_ID),
    role: z.enum(PARTY_ROLES),
    size: z.number().int().min(2).max(5),
    members: z.array(partyMemberRecordSchema).min(2),
  })
  .strict();
export type PartyConfig = z.infer<typeof partyConfigSchema>;

/** The stamp each of a party's roster entries carries (`RosterSpec.party`). */
export interface PartyStamp {
  id: string;
  member: string;
  role: PartyRole;
  size: number;
}

/** A member's run id: `<stem>-<member>`. */
export function memberRunId(stem: string, member: string): string {
  return `${stem}-${member}`;
}

/**
 * Why a launch half does not belong to a definition, or null when it does:
 * the members are the definition's, in its order, each with the definition's
 * role and character, and each run id is the stem's.
 */
export function partyLaunchProblem(def: PartyDefinition, launch: PartyLaunch): string | null {
  if (launch.members.length !== def.size) return `the launch names ${launch.members.length} member(s), the party is ${def.size}`;
  for (const [i, m] of def.members.entries()) {
    const l = launch.members[i]!;
    if (l.member !== m.id) return `member ${i + 1} is ${l.member}, the definition's is ${m.id}`;
    if (l.role !== m.role) return `member ${m.id} is launched as ${l.role}, the definition says ${m.role}`;
    if (l.character !== m.character) return `member ${m.id} is launched as ${l.character}, the definition names ${m.character}`;
    if (l.runId !== memberRunId(launch.id, m.id)) return `member ${m.id}'s run id ${l.runId} is not ${memberRunId(launch.id, m.id)}`;
  }
  if (!def.members.some((m) => m.id === launch.member)) return `${launch.member} is not a member of the party`;
  const accounts = launch.members.map((m) => m.account.toUpperCase());
  if (new Set(accounts).size !== accounts.length) return "two members share an account — the module holds one session per account";
  return null;
}

/** The run's stamp for one member of a launch. */
export function partyConfigOf(def: PartyDefinition, launch: PartyLaunch): PartyConfig {
  const me = def.members.find((m) => m.id === launch.member)!;
  return { id: launch.id, member: launch.member, role: me.role, size: def.size, members: launch.members.map((m) => ({ ...m })) };
}
