/**
 * The shape of a probe campaign definition: the STATIC half of a campaign.
 *
 * A campaign is split in two (operator decision, 2026-10-09). What a run of it
 * IS — its question, its cells, its start, its leash, what ends it and what
 * counts as a cell done — is checked into git here, one module per campaign id,
 * every version kept. What the operator changes while the definition stands
 * still — whether it is enabled, which models sweep it, how many runs each, the
 * account it is pinned to — is a `campaigns/<id>` row in the config store
 * (`runner/src/campaigns.ts`).
 *
 * A published version is never edited: `runner/test/campaign-defs.test.ts` pins
 * every `id@version`'s content hash, so a change to one fails the suite and has
 * to be a new version instead. That is the rule a wrong episode default is held
 * to ("replaced by a new id, never widened in place"), applied to campaigns —
 * because a cell whose meaning changes under the same id silently re-scopes
 * every run already recorded against it, which is exactly what happened to
 * class-probe's `nightelf-hunter` cell before definitions were checked in.
 *
 * Plain TypeScript, `as const satisfies`, like the episode table: a reviewed
 * module is not an external boundary, so there is no zod here — the
 * typechecker is the validator.
 */

/** One cell of a campaign: a start the sweep runs from. */
export interface CampaignCellDef {
  /** Safe in a run id and a path; recorded on the run as `cell`. */
  readonly id: string;
  /** The client's own race and class ids (`enum Races`/`enum Classes` in SharedDefines.h). */
  readonly race: number;
  readonly class: number;
  /** Why the cell is what it is, when that is not obvious — e.g. a substitute class. */
  readonly note?: string;
}

/** A campaign the fleet and the runner can launch. */
export interface OpenCampaignDef {
  readonly id: string;
  /** 1, 2, …; a published version is never edited. */
  readonly version: number;
  readonly status: "open";
  /** The one question the sweep answers. */
  readonly question: string;
  readonly cells: readonly CampaignCellDef[];
  /**
   * Rendered verbatim into the prompt's delimited operator-objective block, or
   * null for the standing goal alone.
   */
  readonly objective: string | null;
  /**
   * End the run on the first server-observed level at or above this, as the
   * `level-target` termination. Null: the run ends on its clock and watchdogs
   * only.
   */
  readonly stopAtLevel: number | null;
  readonly budget: {
    /** The ceiling, on the play clock (a resumed run continues it). */
    readonly episodeMs: number;
    readonly idleMs: number;
    /** Null: the no-XP watchdog is off. */
    readonly noXpMs: number | null;
    /** The runaway guard, never a task budget. */
    readonly maxToolCalls: number;
  };
  readonly wikiCoords: boolean;
  readonly wiki: boolean;
  /** A paused run resumes, rather than ending as a failed attempt. */
  readonly resume: boolean;
  /** Abandon an (assignment, cell) after this many launches, counted or not; null never. */
  readonly maxAttemptsPerCell: number | null;
  /**
   * Runs stamped with this campaign id and NO version belong to this version.
   * A read-time rule, and the counting of this version's own work: it is never
   * consulted for any other version, so a newer version's cells are never
   * credited with these runs.
   */
  readonly legacy?: { readonly unversioned: true };
}

/** A cell of a retrospective campaign, which may name the build it ran on. */
export interface ClosedCampaignCellDef extends CampaignCellDef {
  readonly build?: string;
}

/**
 * A campaign that is history: written after its runs, or retired by a newer
 * version. Never launchable and never enabled; it exists so its runs are
 * attributed at read time. It states no budget, because what each of its runs
 * was given is on the run.
 */
export interface ClosedCampaignDef {
  readonly id: string;
  readonly version: number;
  readonly status: "closed";
  readonly question: string;
  readonly cells: readonly ClosedCampaignCellDef[];
  readonly legacy: {
    /** As on an open definition: runs stamped with this id and no version are this version's. */
    readonly unversioned?: true;
    /** Runs that recorded no campaign at all, attributed by run id. */
    readonly members?: readonly { readonly runId: string; readonly cell: string }[];
  };
  /** What a reader should know about how this version came to be what it is. */
  readonly history?: string;
}

export type CampaignDef = OpenCampaignDef | ClosedCampaignDef;

/** `race-probe@1`: how a definition is named on the command line and in messages. */
export type CampaignRefString = `${string}@${number}`;
