/**
 * A fresh probe launch, resolved against the checked-in campaign definitions.
 *
 * The rule (operator decision, 2026-10-09): a `probing` run exists only as a
 * cell of a checked-in, versioned campaign definition. Every way a run starts —
 * the fleet, `infra/run-episode.sh`, a `kubectl exec`, a branch pod — ends in
 * `run.ts`, so this is where it is enforced:
 *
 * - `--episode probing` needs `--campaign <id>@<version> --cell <id>` naming an
 *   open definition in this checkout and one of its cells;
 * - `--campaign` without `probing` (or with another episode) is refused, and
 *   so is `--cell` without `--campaign`;
 * - with `--campaign`, the run's shape comes from the definition and nowhere
 *   else, so every flag that would set part of it is refused — a different
 *   shape is a new version, not a launch flag.
 *
 * Fresh launches only. A `--resume` reloads the run's own stored config and
 * never comes through here, so a run from before the rule still loads.
 *
 * Before this, nothing refused `--episode probing` on its own: nine hand
 * launches of a harness spike used `probing` as an off-board switch and
 * recorded no campaign at all.
 */

import {
  CAMPAIGN_DEFS,
  campaignDef,
  campaignHash,
  campaignRef,
  parseCampaignRef,
  type CampaignDef,
} from "./campaign-defs";
import { cellDimensions } from "./campaigns";

/** A launch the rule refuses. The message is the operator's whole notice. */
export class CampaignLaunchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CampaignLaunchError";
  }
}

/** The flags that set part of a run's shape, which a campaign launch takes from its definition instead. */
export const PROBE_SHAPE_FLAGS = [
  "objective",
  "race",
  "class",
  "wiki-coords",
  "wiki",
  "max-tool-calls",
  "idle-ms",
  "no-xp-ms",
  "episode-ms",
  "watchdogs-json",
] as const;

function openRefs(defs: readonly CampaignDef[]): string {
  const open = defs.filter((d) => d.status === "open").map(campaignRef);
  return open.length === 0 ? "none" : open.join(", ");
}

/**
 * The raw config fields a campaign launch contributes, or null when the
 * launch names no campaign and is not a probe. Throws `CampaignLaunchError`
 * for every launch the rule refuses.
 */
export function campaignLaunch(
  args: Readonly<Record<string, string | boolean>>,
  defs: readonly CampaignDef[] = CAMPAIGN_DEFS,
): Record<string, unknown> | null {
  const campaign = args["campaign"];
  const cell = args["cell"];
  const episode = args["episode"];
  if (campaign === undefined) {
    if (episode === "probing") {
      throw new CampaignLaunchError(
        `--episode probing needs --campaign <id>@<version> --cell <id>: a probe is a cell of a checked-in campaign definition (runner/src/campaign-defs/; open: ${openRefs(defs)})`,
      );
    }
    if (cell !== undefined) throw new CampaignLaunchError("--cell names a cell of a campaign; pass --campaign <id>@<version> with it");
    if (args["ref"] !== undefined) throw new CampaignLaunchError("--ref records the roster entry a campaign launch was made as; pass it with --campaign");
    return null;
  }
  if (typeof campaign !== "string") throw new CampaignLaunchError("--campaign takes <id>@<version>, e.g. race-probe@1");
  const ref = parseCampaignRef(campaign);
  if (ref === null) {
    throw new CampaignLaunchError(
      `--campaign ${campaign}: name the version as <id>@<version> (e.g. race-probe@1); a bare id would let a newer definition re-target the launch`,
    );
  }
  if (episode !== undefined && episode !== "probing") {
    throw new CampaignLaunchError(`--campaign is a probe: it runs --episode probing, not --episode ${String(episode)}`);
  }
  const def = campaignDef(ref.id, ref.version, defs);
  if (def === undefined) {
    throw new CampaignLaunchError(`--campaign ${campaign}: no such definition in this checkout (open: ${openRefs(defs)})`);
  }
  if (def.status !== "open") {
    throw new CampaignLaunchError(`--campaign ${campaign} is closed: it attributes past runs and launches nothing`);
  }
  if (typeof cell !== "string") {
    throw new CampaignLaunchError(`--campaign ${campaign} needs --cell <id> (one of: ${def.cells.map((c) => c.id).join(", ")})`);
  }
  const c = def.cells.find((x) => x.id === cell);
  if (c === undefined) {
    throw new CampaignLaunchError(`--cell ${cell} is not a cell of ${campaign} (one of: ${def.cells.map((x) => x.id).join(", ")})`);
  }
  const shape = PROBE_SHAPE_FLAGS.filter((f) => args[f] !== undefined);
  if (shape.length > 0) {
    throw new CampaignLaunchError(
      `--campaign ${campaign} takes the run's shape from its definition; ${shape.map((f) => `--${f}`).join(", ")} ` +
        `${shape.length === 1 ? "is" : "are"} not ${shape.length === 1 ? "a flag" : "flags"} a probe may set — a different shape is a new version`,
    );
  }
  const rosterRef = args["ref"];
  if (rosterRef !== undefined && (typeof rosterRef !== "string" || rosterRef.length === 0)) {
    throw new CampaignLaunchError("--ref takes the roster name the launch was made as");
  }
  const dims = cellDimensions(def, c);
  return {
    episode: "probing",
    campaign: def.id,
    campaignVersion: def.version,
    campaignHash: campaignHash(def),
    cell: c.id,
    ...(typeof rosterRef === "string" ? { ref: rosterRef } : {}),
    race: dims.race,
    class: dims.class,
    watchdogs: dims.watchdogs,
    maxToolCallsPerEpisode: dims.maxToolCalls,
    wikiCoords: dims.wikiCoords,
    wiki: dims.wiki,
    ...(dims.objective !== undefined ? { objective: dims.objective } : {}),
    ...(dims.stopAtLevel !== undefined ? { stopAtLevel: dims.stopAtLevel } : {}),
  };
}
