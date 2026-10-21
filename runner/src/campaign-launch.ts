/**
 * A fresh probe launch, resolved from its campaign file.
 *
 * The rule (operator decision, 2026-10-09): a `probing` run exists only as a
 * cell of a published, versioned campaign definition. Every way a run starts —
 * the fleet, `infra/run-episode.sh`, a `kubectl exec`, a run pod on another
 * image — ends in `run.ts`, so this is where it is enforced:
 *
 * - `--episode probing` needs `--campaign-file <path>`, a `campaign.json`
 *   (`campaign-file.ts`) naming the definition, the cell and the arm;
 * - `--campaign-file` with another episode is refused, and so is `--ref`
 *   without one;
 * - the run's shape comes from the file and nowhere else, so every flag that
 *   would set part of it is refused — a different shape is a new version, not
 *   a launch flag. An arm's own args were checked against the same list when
 *   the definition was published.
 *
 * A definition whose start is staged runs on a character the operator's
 * stager made before the launch: the launch names it (`--character`), and a
 * party member's must be the one its definition names for it. `--character`
 * means nothing anywhere else — a fresh start's name is the model's — so it is
 * refused on every other launch.
 *
 * Fresh launches only. A `--resume` reloads the run's own stored config and
 * never comes through here.
 */

import { readCampaignFile, CampaignFileError, type CampaignFile } from "./campaign-file";
import { campaignRef, cellDimensions } from "./campaign-def";
import { partyConfigOf, type PartyMember } from "./party";
import { PROBE_SHAPE_FLAGS } from "./run-flags";

export { PROBE_SHAPE_FLAGS } from "./run-flags";

/** A launch the rule refuses. The message is the operator's whole notice. */
export class CampaignLaunchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CampaignLaunchError";
  }
}

/** The environment variable a run pod's launcher names the requested image in. */
export const RUN_IMAGE_ENV = "WRATHBENCH_RUN_IMAGE";

/**
 * The raw config fields a campaign launch contributes, or null when the
 * launch names no campaign file and is not a probe. Throws
 * `CampaignLaunchError` for every launch the rule refuses.
 */
export function campaignLaunch(
  args: Readonly<Record<string, string | boolean>>,
  env: Readonly<Record<string, string | undefined>> = process.env,
): Record<string, unknown> | null {
  const path = args["campaign-file"];
  const episode = args["episode"];
  if (path === undefined) {
    if (episode === "probing") {
      throw new CampaignLaunchError(
        "--episode probing needs --campaign-file <path>: a probe is a cell of a published campaign definition " +
          "(by hand: bun wb run episode --campaign <id>@<version> --cell <id> [--arm <id>], which writes the file from the store)",
      );
    }
    if (args["ref"] !== undefined) throw new CampaignLaunchError("--ref records the roster entry a campaign launch was made as; pass it with --campaign-file");
    if (args["character"] !== undefined) {
      throw new CampaignLaunchError(
        "--character launches on a character the operator staged, which only a campaign whose start is staged has; a fresh start's name is the model's to choose",
      );
    }
    return null;
  }
  if (typeof path !== "string") throw new CampaignLaunchError("--campaign-file takes the path of a campaign.json");
  if (episode !== undefined && episode !== "probing") {
    throw new CampaignLaunchError(`--campaign-file is a probe: it runs --episode probing, not --episode ${String(episode)}`);
  }
  let file: CampaignFile;
  try {
    file = readCampaignFile(path);
  } catch (err) {
    if (err instanceof CampaignFileError) throw new CampaignLaunchError(`--campaign-file ${err.message}`);
    throw err;
  }
  const ref = `${file.campaign}@${file.version}`;
  const shape = PROBE_SHAPE_FLAGS.filter((f) => args[f] !== undefined);
  if (shape.length > 0) {
    throw new CampaignLaunchError(
      `${ref} takes the run's shape from its campaign file; ${shape.map((f) => `--${f}`).join(", ")} ` +
        `${shape.length === 1 ? "is" : "are"} not ${shape.length === 1 ? "a flag" : "flags"} a probe may set — a different shape is a new version`,
    );
  }
  const rosterRef = args["ref"];
  if (rosterRef !== undefined && (typeof rosterRef !== "string" || rosterRef.length === 0)) {
    throw new CampaignLaunchError("--ref takes the roster name the launch was made as");
  }
  // A pinned arm names the build it measures. A process the launcher did not
  // start in that image would run the fleet's own build under the arm's name,
  // which is the silent mismeasure arms exist to rule out.
  const image = env[RUN_IMAGE_ENV];
  if (file.arm.image !== undefined && (image === undefined || image.length === 0)) {
    throw new CampaignLaunchError(
      `arm ${file.arm.id} of ${ref} pins image ${file.arm.image}, and this process was not launched in it ($${RUN_IMAGE_ENV} is unset) — a pinned arm runs in a run pod`,
    );
  }
  const def = file.definition;
  const staged = def.start !== undefined && def.start !== "fresh";
  const character = args["character"];
  if (!staged && character !== undefined) {
    throw new CampaignLaunchError(`${campaignRef(def)} starts fresh, on a character the model names and creates; --character is for a staged start`);
  }
  if (staged && (typeof character !== "string" || character.length === 0)) {
    throw new CampaignLaunchError(`${campaignRef(def)} starts on a staged character: name it with --character <name>`);
  }
  let member: PartyMember | undefined;
  if (def.party !== undefined) {
    const launch = file.party;
    if (launch === undefined) {
      throw new CampaignLaunchError(`${campaignRef(def)} is a party of ${def.party.size}, and this campaign file names no member — a party launches through the fleet's roster`);
    }
    member = def.party.members.find((m) => m.id === launch.member);
    if (member === undefined) throw new CampaignLaunchError(`--campaign-file: ${launch.member} is not a member of ${campaignRef(def)}'s party`);
    if (character !== member.character) {
      throw new CampaignLaunchError(`--character ${String(character)}: member ${member.id} of ${campaignRef(def)} is staged as ${member.character}`);
    }
  }
  const dims = cellDimensions(def, file.cell, member);
  return {
    episode: "probing",
    campaign: file.campaign,
    campaignVersion: file.version,
    campaignHash: file.hash,
    cell: file.cell.id,
    arm: file.arm.id,
    ...(typeof rosterRef === "string" ? { ref: rosterRef } : {}),
    race: dims.race,
    class: dims.class,
    watchdogs: dims.watchdogs,
    maxToolCallsPerEpisode: dims.maxToolCalls,
    wikiCoords: dims.wikiCoords,
    wiki: dims.wiki,
    ...(dims.objective !== undefined ? { objective: dims.objective } : {}),
    ...(dims.stopAtLevel !== undefined ? { stopAtLevel: dims.stopAtLevel } : {}),
    ...(dims.end !== undefined ? { end: dims.end } : {}),
    // Only on a staged start, so every fresh probe's config is what it was.
    ...(staged ? { character } : {}),
    ...(def.party !== undefined && file.party !== undefined ? { party: partyConfigOf(def.party, file.party) } : {}),
  };
}
