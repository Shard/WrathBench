/**
 * The task episodes' pinned definitions (operator, 2026-11-14): what the id
 * `deadmines` or `deadmines-solo` fixes about a run beyond its clock and
 * watchdogs (`episodes.ts`) — the staged start, the party's characters and
 * roles, the directive each agent is given, and the end.
 *
 * Each is a campaign definition in shape, `runner/episodes/<id>.json`, so the
 * staging, the fan-out grant and the party launch are the machinery the
 * Deadmines campaigns already run on, but it is never published to the config
 * store and never a campaign: it is part of the build, the id names it, and a
 * launch file that holds any other definition under the id is refused
 * (`parseCampaignFile`). A change to any of it is a new id, never an edit.
 *
 * Kept free of the runner's heavier modules: the fleet, the roster and the
 * viewer import it.
 */

import deadminesJson from "../episodes/deadmines.json";
import deadminesSoloJson from "../episodes/deadmines-solo.json";
import { campaignDefinitionSchema, campaignHash, isOneAgentArm, type CampaignDefinition } from "./campaign-def";
import { EPISODES, TASK_EPISODE_IDS, type TaskEpisodeId } from "./episodes";

function parse(id: TaskEpisodeId, raw: unknown): CampaignDefinition {
  const def = campaignDefinitionSchema.parse(raw);
  if (def.id !== id) throw new Error(`runner/episodes/${id}.json names ${def.id}`);
  return def;
}

const DEFINITIONS: Record<TaskEpisodeId, CampaignDefinition> = {
  deadmines: parse("deadmines", deadminesJson),
  "deadmines-solo": parse("deadmines-solo", deadminesSoloJson),
};

/** The definition a task episode's id pins. */
export function taskDefinition(id: TaskEpisodeId): CampaignDefinition {
  return DEFINITIONS[id];
}

/** Its content hash, as a launch file carries it. */
export function taskHash(id: TaskEpisodeId): string {
  return campaignHash(DEFINITIONS[id]);
}

/**
 * Why a task definition does not hold together with its episode's row, or
 * null when it does: one cell, one arm, a party, a staged start, a budget
 * that is the tier's, and as many agents and characters as the tier says.
 * Checked by the tests, so the two tables can never drift apart.
 */
export function taskDefinitionProblem(id: TaskEpisodeId): string | null {
  const def = DEFINITIONS[id];
  const tier = EPISODES[id];
  if (def.cells.length !== 1 || def.arms.length !== 1) return `${id}: a task episode has one cell and one arm`;
  if (def.party === undefined) return `${id}: a task episode is a party's`;
  if (def.start === undefined || def.start === "fresh") return `${id}: a task episode starts staged`;
  if (def.budget.episodeMs !== tier.minutes * 60_000) return `${id}: the definition's clock is not the tier's`;
  if (def.budget.idleMs !== tier.idleMinutes * 60_000) return `${id}: the definition's idle watchdog is not the tier's`;
  if (def.budget.noXpMs !== (tier.noXpMinutes === null ? null : tier.noXpMinutes * 60_000)) return `${id}: the definition's no-XP watchdog is not the tier's`;
  if (def.budget.maxToolCalls !== tier.toolCalls) return `${id}: the definition's call guard is not the tier's`;
  const oneAgent = isOneAgentArm(def, def.arms[0]!);
  const agents = oneAgent ? 1 : def.party.size;
  const characters = oneAgent ? def.party.size : 1;
  if (agents !== tier.task.agents || characters !== tier.task.characters) {
    return `${id}: the definition is ${agents} agent(s) of ${characters} character(s), the tier ${tier.task.agents} of ${tier.task.characters}`;
  }
  if (def.resume) return `${id}: a scored episode never resumes`;
  return null;
}

/** Every task episode id, for the tests and the readers that list them. */
export const TASK_EPISODES: readonly TaskEpisodeId[] = TASK_EPISODE_IDS;
