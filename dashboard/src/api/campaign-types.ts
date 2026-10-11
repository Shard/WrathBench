/**
 * `/api/campaigns`, the shape the campaigns page reads (probe campaigns v3).
 *
 * Declared here only until `runner/viewer/api-types.ts` carries it: the viewer
 * side of this shape is being rebuilt in parallel, and the page is built
 * against the agreed declaration rather than the one it replaces. Once the
 * viewer's types land, this file is deleted and its importers take the same
 * four names from `@viewer/api-types`, as every other response does
 * (dashboard/README.md, "Structure"). Only those four names are exported, and
 * everything else is reached through them (`CampaignView["arms"][number]`), so
 * the swap changes import lines and nothing else.
 *
 * A campaign is a matrix: cells (the start: race, class) × arms (the harness:
 * image, command, args) × assignments (the models). Every figure in it —
 * state, progress, live, cost — is decided server-side by the one counting
 * function the scheduler also uses, so the page and the supervisor cannot
 * disagree about whether a campaign is done.
 */

import type { SnapshotEnvelope } from "@viewer/api-types";

export type CampaignsResponse = SnapshotEnvelope & {
  now: number;
  campaigns: CampaignView[];
  /** Store rows the viewer could not read as a campaign, with why. Never swallowed. */
  refused: { key: string; reason: string }[];
};

export type CampaignView = {
  /** `key` is `id@version`. */
  id: string;
  version: number;
  key: string;
  hash: string;
  source: { commit: string; path: string } | null;
  publishedAt: number | null;
  question: string;
  shape: {
    objective: string | null;
    stopAtLevel: number | null;
    episodeMs: number;
    idleMs: number;
    noXpMs: number | null;
    maxToolCalls: number;
    wiki: boolean;
    wikiCoords: boolean;
    resume: boolean;
    maxAttemptsPerCell: number | null;
  };
  cells: { id: string; race: number; class: number; note?: string }[];
  /** `image` null is the fleet's release image at launch; `command` null is the runner's own. */
  arms: { id: string; note?: string; image: string | null; command: string[] | null; args: string[] }[];
  /**
   * The store row; null when the definition is published but no row names it.
   * `account` is operator detail: the public projection omits it, and the page
   * never reads it.
   */
  config: {
    enabled: boolean;
    account: string | null;
    assignments: {
      ref: string;
      model: string;
      effort: string | null;
      compactWindow: string | null;
      harness: string | null;
      runsPerCell: number;
    }[];
  } | null;
  state: "running" | "queued" | "complete" | "disabled" | "unassigned";
  progress: { want: number; done: number; attempted: number; capped: number; live: number };
  /** Assignments in priority order, each split by arm in the definition's order. */
  columns: {
    key: string;
    ref: string;
    arm: string;
    model: string;
    effort: string | null;
    compactWindow: string | null;
    harness: string | null;
  }[];
  /** One row per cell, in the definition's order; squares in `columns` order. */
  grid: { cell: string; squares: Square[] }[];
  /** Per assignment, one row per arm. */
  comparison: { ref: string; arms: ArmSummary[] }[];
  costUsd: number | null;
  newestRunId: string | null;
  newestAt: number | null;
};

export type Square = {
  column: string;
  runs: number;
  counted: number;
  reached: number;
  live: number;
  minutesToStop: { min: number; median: number; max: number } | null;
  bestLevel: number | null;
  costUsd: number | null;
  mismatchedStart: number;
  builds: string[];
  runIds: string[];
};

export type ArmSummary = {
  arm: string;
  runs: number;
  reached: number;
  medianMinutesToStop: number | null;
  medianTurnsToStop: number | null;
  medianCostToStop: number | null;
  medianPromptTokensToStop: number | null;
  terminations: Record<string, number>;
  builds: string[];
};
