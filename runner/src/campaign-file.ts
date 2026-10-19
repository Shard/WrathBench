#!/usr/bin/env bun
/**
 * `runs/<id>/campaign.json`: the snapshot of a published campaign a probe run
 * follows, and the only campaign input `run.ts` takes (`--campaign-file`).
 *
 * The file names the campaign, its version and hash, where the definition was
 * published from, the cell and the arm this run is, and the whole definition.
 * It is written before the run starts — by the fleet's roster for a fleet
 * launch, by this module's CLI for a hand launch through
 * `infra/run-episode.sh` — and read by the run for its shape and by the
 * supervisor when it rebuilds a paused probe's job. So a paused run resumes on
 * its own arm, never on a later definition, and a run pod needs no access to
 * the config store.
 *
 * Writing it creates the run directory before the run does. A directory that
 * holds nothing but launch files (`LAUNCH_FILES`) is therefore still free for a
 * fresh launch: the runner and the roster both treat it as unused, and the next
 * launch onto it overwrites the file. Anything else in it is a run.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { holdsOnlyLaunchFiles } from "./launch-files";
import { join } from "node:path";
import { z } from "zod";
import {
  armOf,
  campaignHash,
  campaignRef,
  campaignSourceSchema,
  canonicalJson,
  cellOf,
  issuesOf,
  parseCampaignRef,
  campaignDefinitionSchema,
  type CampaignArm,
  type CampaignCell,
  type CampaignDefinition,
} from "./campaign-def";
import type { PublishedCampaign } from "./campaigns";
import { partyLaunchProblem, partyLaunchSchema, type PartyLaunch } from "./party";

/** The file a probe's run directory holds; one of the `LAUNCH_FILES`. */
export const CAMPAIGN_FILE = "campaign.json";

export { LAUNCH_FILES, holdsOnlyLaunchFiles } from "./launch-files";

export const campaignFileSchema = z
  .object({
    campaign: z.string().min(1),
    version: z.number().int().positive(),
    hash: z.string().min(1),
    source: campaignSourceSchema,
    cell: z.unknown(),
    arm: z.unknown(),
    definition: campaignDefinitionSchema,
    /** A party member's launch: the party id, which member this run is, and every member's run. */
    party: partyLaunchSchema.optional(),
  })
  .strict();

/** What `campaign.json` holds, checked: the cell and arm are the definition's own. */
export interface CampaignFile {
  campaign: string;
  version: number;
  hash: string;
  source: z.infer<typeof campaignSourceSchema>;
  cell: CampaignCell;
  arm: CampaignArm;
  definition: CampaignDefinition;
  /**
   * A party definition's launch half, one per member (`party.ts`): absent on
   * every file that is not a party member's. A file of a party definition
   * without it is a square's file before the spawn has placed its members.
   */
  party?: PartyLaunch;
}

/** A campaign file that cannot be built or read. The message is the operator's whole notice. */
export class CampaignFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CampaignFileError";
  }
}

/**
 * The file for one (cell, arm) of a published definition. `arm` may be
 * omitted only when the definition has exactly one.
 */
export function campaignFileOf(published: PublishedCampaign, cellId: string, armId?: string): CampaignFile {
  const def = published.def;
  const cell = cellOf(def, cellId);
  if (cell === undefined) {
    throw new CampaignFileError(`${cellId} is not a cell of ${published.ref} (one of: ${def.cells.map((c) => c.id).join(", ")})`);
  }
  let arm: CampaignArm | undefined;
  if (armId === undefined) {
    if (def.arms.length !== 1) {
      throw new CampaignFileError(`${published.ref} has ${def.arms.length} arms; name one (${def.arms.map((a) => a.id).join(", ")})`);
    }
    arm = def.arms[0];
  } else {
    arm = armOf(def, armId);
  }
  if (arm === undefined) {
    throw new CampaignFileError(`${armId} is not an arm of ${published.ref} (one of: ${def.arms.map((a) => a.id).join(", ")})`);
  }
  return { campaign: def.id, version: def.version, hash: published.hash, source: published.source, cell, arm, definition: def };
}

/**
 * Parse a campaign file's JSON and check it holds together: the hash is its
 * definition's, and the cell and arm are the definition's own, exactly. A
 * file that disagrees with itself was edited by hand, and a run that followed
 * it would be stamped with a definition it did not run.
 */
export function parseCampaignFile(raw: unknown, where = CAMPAIGN_FILE): CampaignFile {
  const parsed = campaignFileSchema.safeParse(raw);
  if (!parsed.success) throw new CampaignFileError(`${where}: ${issuesOf(parsed.error)}`);
  const f = parsed.data;
  const def = f.definition;
  if (f.campaign !== def.id || f.version !== def.version) {
    throw new CampaignFileError(`${where}: names ${f.campaign}@${f.version} but holds the definition of ${campaignRef(def)}`);
  }
  const hash = campaignHash(def);
  if (f.hash !== hash) throw new CampaignFileError(`${where}: its definition hashes to ${hash}, not the ${f.hash} it claims`);
  const cell = def.cells.find((c) => canonicalJson(c) === canonicalJson(f.cell));
  if (cell === undefined) throw new CampaignFileError(`${where}: its cell is not one of ${campaignRef(def)}'s`);
  const arm = def.arms.find((a) => canonicalJson(a) === canonicalJson(f.arm));
  if (arm === undefined) throw new CampaignFileError(`${where}: its arm is not one of ${campaignRef(def)}'s`);
  if (f.party !== undefined) {
    if (def.party === undefined) throw new CampaignFileError(`${where}: names a party member, and ${campaignRef(def)} is not a party`);
    const problem = partyLaunchProblem(def.party, f.party);
    if (problem !== null) throw new CampaignFileError(`${where}: its party is not ${campaignRef(def)}'s — ${problem}`);
  }
  return {
    campaign: f.campaign,
    version: f.version,
    hash: f.hash,
    source: f.source,
    cell,
    arm,
    definition: def,
    ...(f.party !== undefined ? { party: f.party } : {}),
  };
}

/** Read and check a campaign file from disk. */
export function readCampaignFile(path: string): CampaignFile {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch (err) {
    throw new CampaignFileError(`${path}: ${err instanceof Error ? err.message : String(err)}`);
  }
  return parseCampaignFile(raw, path);
}

/** A run directory's own campaign file, or null when it has none or it does not read. */
export function runCampaignFile(runDir: string): CampaignFile | null {
  const path = join(runDir, CAMPAIGN_FILE);
  if (!existsSync(path)) return null;
  try {
    return readCampaignFile(path);
  } catch {
    return null;
  }
}

/** Write `<runDir>/campaign.json`, creating the directory. Returns the path. */
export function writeCampaignFile(runDir: string, file: CampaignFile): string {
  mkdirSync(runDir, { recursive: true });
  const path = join(runDir, CAMPAIGN_FILE);
  writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`);
  return path;
}

// --------------------------------------------------------------------- CLI

const USAGE = `usage: bun runner/src/campaign-file.ts --campaign <id>@<version> --cell <id> [--arm <id>] [--run-id <id>] [--runs-dir <dir>] [--db <path>]

Writes <runs-dir>/<run-id>/campaign.json from the published definition in the
config store, for a hand launch (bun wb run episode --campaign …), and prints
"<run-id> <path>". The run id defaults to a fresh run-<stamp>. Refuses an arm
that pins an image or a command: a hand launch runs this image's run.ts, and a
pinned arm runs only in a run pod the fleet launches.
`;

async function main(argv: string[]): Promise<number> {
  const opt = (name: string): string | undefined => {
    const i = argv.indexOf(name);
    return i < 0 ? undefined : argv[i + 1];
  };
  const ref = opt("--campaign");
  const cellId = opt("--cell");
  if (ref === undefined || cellId === undefined) {
    console.error(USAGE);
    return 2;
  }
  const { configDbPath, readFleetConfig } = await import("./config-store");
  const { parseCampaignDefinitions } = await import("./campaigns");
  const { newRunId } = await import("./config");
  if (parseCampaignRef(ref) === null) {
    console.error(`--campaign ${ref}: name the version as <id>@<version> (e.g. race-probe@1)`);
    return 2;
  }
  const read = readFleetConfig(opt("--db") ?? configDbPath());
  if (read.status !== "ok") {
    console.error(`campaign-file: the config store at ${read.path} is ${read.status}${read.status === "unreadable" ? ` (${read.error})` : ""}`);
    return 2;
  }
  const { definitions } = parseCampaignDefinitions((JSON.parse(read.text) as Record<string, unknown>)["campaign-defs"]);
  const published = definitions.find((d) => d.ref === ref);
  if (published === undefined) {
    console.error(`campaign-file: ${ref} is not published (published: ${definitions.map((d) => d.ref).join(", ") || "none"})`);
    return 2;
  }
  let file: CampaignFile;
  try {
    file = campaignFileOf(published, cellId, opt("--arm"));
  } catch (err) {
    console.error(`campaign-file: ${err instanceof Error ? err.message : String(err)}`);
    return 2;
  }
  if (file.arm.image !== undefined || file.arm.command !== undefined) {
    console.error(
      `campaign-file: arm ${file.arm.id} of ${ref} pins ${file.arm.image !== undefined ? `image ${file.arm.image}` : `command ${file.arm.command!.join(" ")}`} — ` +
        "a hand launch runs this image's run.ts; let the fleet launch it in a run pod",
    );
    return 2;
  }
  if (file.definition.party !== undefined) {
    console.error(
      `campaign-file: ${ref} is a party of ${file.definition.party.size} — its members are staged, launched and stopped together by the fleet's roster, never one by hand`,
    );
    return 2;
  }
  const runId = opt("--run-id") ?? newRunId();
  const dir = join(opt("--runs-dir") ?? "data/runs", runId);
  if (!holdsOnlyLaunchFiles(dir)) {
    console.error(`campaign-file: ${dir} is already a run — pass another --run-id`);
    return 2;
  }
  const path = writeCampaignFile(dir, file);
  console.log(`${runId} ${path}`);
  return 0;
}

if (import.meta.main) {
  process.exit(await main(process.argv.slice(2)));
}
