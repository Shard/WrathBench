/**
 * The campaign definition registry: every version of every probe campaign,
 * and the read-time rules that attach a run to one.
 *
 * One registry, imported by the runner (which takes a fresh probe's shape from
 * it), the fleet (which plans with its ceiling and its resume rule) and the
 * viewer (which attributes runs and draws the grid). The definitions
 * themselves are in the sibling modules; `types.ts` says what a definition is
 * and why it is static.
 */

import { CLASS_PROBE_V1, CLASS_PROBE_V2 } from "./class-probe";
import { LOOP_SPIKE_V1 } from "./loop-spike";
import { NAV_PROBE_V1 } from "./nav-probe";
import { RACE_PROBE_V1 } from "./race-probe";
import type { CampaignDef, CampaignRefString, OpenCampaignDef } from "./types";

export type {
  CampaignCellDef,
  CampaignDef,
  CampaignRefString,
  ClosedCampaignCellDef,
  ClosedCampaignDef,
  OpenCampaignDef,
} from "./types";

/** Every version of every campaign, in the order the campaigns page lists them. */
export const CAMPAIGN_DEFS: readonly CampaignDef[] = [
  RACE_PROBE_V1,
  CLASS_PROBE_V2,
  CLASS_PROBE_V1,
  NAV_PROBE_V1,
  LOOP_SPIKE_V1,
];

/** Names a campaign id and a cell id must both survive: safe in a run id and a path. */
export const CAMPAIGN_NAME = /^[A-Za-z0-9._-]+$/;

/** The definition for `id@version`, or undefined when this checkout has none. */
export function campaignDef(
  id: string,
  version: number,
  defs: readonly CampaignDef[] = CAMPAIGN_DEFS,
): CampaignDef | undefined {
  return defs.find((d) => d.id === id && d.version === version);
}

/** Every version of one campaign, oldest first. */
export function campaignVersions(id: string, defs: readonly CampaignDef[] = CAMPAIGN_DEFS): CampaignDef[] {
  return defs.filter((d) => d.id === id).sort((a, b) => a.version - b.version);
}

/**
 * The version that claims runs stamped with `id` and no version
 * (`legacy.unversioned`), or undefined when none does. At most one version of
 * an id may claim them; the registry test enforces it.
 */
export function unversionedOwner(id: string, defs: readonly CampaignDef[] = CAMPAIGN_DEFS): CampaignDef | undefined {
  return defs.find((d) => d.id === id && d.legacy?.unversioned === true);
}

/** `race-probe@1`. */
export function campaignRef(def: Pick<CampaignDef, "id" | "version">): CampaignRefString {
  return `${def.id}@${def.version}`;
}

/**
 * Parse `id@version` as the command line and the store spell it. Null for
 * anything else — a bare id included, because a launch that does not say
 * which version it is would let a merged definition re-target it silently.
 */
export function parseCampaignRef(s: string): { id: string; version: number } | null {
  const m = /^([A-Za-z0-9._-]+)@([1-9][0-9]*)$/.exec(s);
  if (m === null) return null;
  return { id: m[1]!, version: Number(m[2]) };
}

/** JSON with every object's keys sorted, so the hash is a function of content, not of key order. */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v !== null && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v);
}

/**
 * The content hash a run is stamped with and the registry test pins: the same
 * `sha256:<16 hex>` shape as the prompt hash, over the definition's canonical
 * JSON. A run stamped with one hash and a checkout holding another for the
 * same `id@version` is a definition that was edited after publication.
 */
export function campaignHash(def: CampaignDef): string {
  return `sha256:${new Bun.CryptoHasher("sha256").update(canonical(def)).digest("hex").slice(0, 16)}`;
}

/** How a run came to belong to a campaign, as a reader says it. */
export type CampaignSource =
  /** The run recorded the campaign id (and, since definitions were versioned, the version). */
  | "stamped"
  /** The run recorded the id but no version; the version is the one whose definition claims such runs. */
  | "unversioned"
  /** The run recorded no campaign; a closed definition lists it by run id. */
  | "listed";

export interface CampaignAttribution {
  campaign: string;
  /** Null only for a stamped id no checked-in definition claims a version of. */
  version: number | null;
  cell: string | null;
  source: CampaignSource;
}

/**
 * The campaign a run belongs to, read — never written back.
 *
 * Three rules, in order: the run's own stamp; a stamp with no version, which
 * belongs to the version that claims unversioned runs of that id; and a run
 * with no campaign at all that a closed definition names by run id. An old run
 * is read differently, not relabelled: nothing here touches the run, and the
 * `source` says which rule placed it.
 */
export function attributeCampaign(
  run: { runId: string; campaign: string | null; campaignVersion: number | null; cell: string | null },
  defs: readonly CampaignDef[] = CAMPAIGN_DEFS,
): CampaignAttribution | null {
  if (run.campaign !== null) {
    if (run.campaignVersion !== null) {
      return { campaign: run.campaign, version: run.campaignVersion, cell: run.cell, source: "stamped" };
    }
    const owner = unversionedOwner(run.campaign, defs);
    if (owner !== undefined) return { campaign: run.campaign, version: owner.version, cell: run.cell, source: "unversioned" };
    return { campaign: run.campaign, version: null, cell: run.cell, source: "stamped" };
  }
  for (const d of defs) {
    const hit = d.status === "closed" ? d.legacy.members?.find((m) => m.runId === run.runId) : undefined;
    if (hit !== undefined) return { campaign: d.id, version: d.version, cell: hit.cell, source: "listed" };
  }
  return null;
}

/** The cell a definition declares under `cellId`, or undefined. */
export function cellOf(def: CampaignDef, cellId: string | null): CampaignDef["cells"][number] | undefined {
  return cellId === null ? undefined : def.cells.find((c) => c.id === cellId);
}

/**
 * Whether a run's recorded start differs from the start its cell declares —
 * the check that would have caught class-probe's `nightelf-hunter` cell, whose
 * first runs were Night Elf Rogues under a hunter's id. Only a reading both
 * sides recorded can disagree; a run with no race or class on record does not.
 */
export function startMismatch(
  cell: { race: number; class: number } | undefined,
  run: { race: number | null; class: number | null },
): boolean {
  if (cell === undefined) return false;
  return (run.race !== null && run.race !== cell.race) || (run.class !== null && run.class !== cell.class);
}

/** The open definitions, for callers that only ever launch. */
export function isOpen(def: CampaignDef): def is OpenCampaignDef {
  return def.status === "open";
}
