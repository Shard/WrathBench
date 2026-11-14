/**
 * A scored task episode's launch file, as the fleet writes it
 * (`runner/src/task-episodes.ts`): the pinned definition the id names, plus
 * the hash of the stager's fixtures the party will be staged from — the
 * definition's scenario and each member's loadout (`infra/fixtures/`). The
 * run stamps both as comparability keys (`comparability.ts`, `task`), so an
 * edit to a loadout or the scenario splits the episode's group instead of
 * pooling across it, without anyone having to remember a version number.
 */

import { canonicalJson, type CampaignDefinition } from "../runner/src/campaign-def";
import { taskFileOf, type CampaignFile } from "../runner/src/campaign-file";
import type { TaskEpisodeId } from "../runner/src/episodes";
import { loadoutFor } from "./fixtures/loadouts";
import { SCENARIOS } from "./fixtures/scenarios";

/**
 * `sha256:<16 hex>` over the scenario a definition stages and every member's
 * loadout, in member order. Throws when the build has no scenario or
 * loadout for one, which the tests hold never to be the case for a task
 * episode: that launch could not be staged at all.
 */
export function stagingHash(def: CampaignDefinition): string {
  const start = def.start;
  if (start === undefined || start === "fresh" || def.party === undefined) throw new Error(`${def.id}: not a staged party`);
  const scenario = (SCENARIOS as Record<string, unknown>)[start.staged];
  if (scenario === undefined) throw new Error(`${def.id}: no scenario ${start.staged} in this build`);
  const loadouts = def.party.members.map((m) => {
    const l = loadoutFor(m);
    if (typeof l === "string") throw new Error(`${def.id}: member ${m.id}: ${l}`);
    return l;
  });
  const text = canonicalJson({ scenario: { name: start.staged, level: start.level, def: scenario }, loadouts });
  return `sha256:${new Bun.CryptoHasher("sha256").update(text).digest("hex").slice(0, 16)}`;
}

/** The launch file a fresh attempt of `episode` takes, before the spawn adds its party or fan-out half. */
export function taskLaunchFile(episode: TaskEpisodeId): CampaignFile {
  const file = taskFileOf(episode);
  return { ...file, staging: stagingHash(file.definition) };
}
