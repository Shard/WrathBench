/**
 * A `/api/campaigns` body for the campaigns page's tests.
 *
 * Two campaigns. `wake-probe@1` is the shape the page exists for: two arms (a
 * control build and a branch build with one extra flag) × two assignments ×
 * three cells, part-way through — one square live, one with several runs, one
 * whose run started as another start, one capped, one owed, and one whose
 * (assignment, arm) pair is refused since the row changed. `side-probe@2` is
 * published with no store row (`config: null`), which is what an unassigned
 * campaign looks like before anyone writes the row. A store row and the
 * refused pair are in `refused`.
 *
 * Everything is invented: the ids, the image refs, the build stamps. Typed,
 * so a renamed field breaks the typecheck rather than quietly testing nothing.
 */

import type { CampaignsResponse, CampaignView, Square } from "../../../runner/viewer/api-types";

export const NOW = Date.UTC(2026, 9, 11, 12, 0, 0);

const CONTROL = "harbor.example.test/wrathbench/runner:harness-0.5-920-gaaaaaaa";
const BRANCH = "harbor.example.test/wrathbench/runner@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

/** A square with nothing in it yet; tests spread over it. */
export function square(column: string, over: Partial<Square> = {}): Square {
  return {
    column,
    runs: 0,
    counted: 0,
    reached: 0,
    live: 0,
    minutesToStop: null,
    bestLevel: null,
    costUsd: null,
    mismatchedStart: 0,
    builds: [],
    runIds: [],
    ...over,
  };
}

const WAKE: CampaignView = {
  id: "wake-probe",
  version: 1,
  key: "wake-probe@1",
  hash: "f00dfeedcafe0123456789abcdef",
  source: { commit: "0123456789abcdef0123456789abcdef01234567", path: "runner/campaigns/wake-probe@1.json", branch: ["master"] },
  publishedAt: NOW - 2 * 3_600_000,
  note: "both arms pinned to named builds",
  question:
    "Does waking the model on game events instead of a fixed re-prompt reach level 5 with fewer prompt tokens, without slowing the climb?",
  shape: {
    objective: null,
    stopAtLevel: 5,
    end: [{ level: 5 }],
    episodeMs: 4 * 3_600_000,
    idleMs: 20 * 60_000,
    noXpMs: null,
    maxToolCalls: 2000,
    wiki: true,
    wikiCoords: false,
    resume: true,
    maxAttemptsPerCell: 2,
  },
  cells: [
    { id: "north", race: 3, class: 1 },
    { id: "south", race: 2, class: 1 },
    { id: "east", race: 10, class: 4, note: "no warrior for this race; a rogue instead" },
  ],
  arms: [
    { id: "control", note: "release build", image: CONTROL, command: null, args: [] },
    { id: "wake", note: "branch build, wake on", image: BRANCH, command: null, args: ["--wake-on-event", "--wake-cap", "5m"] },
  ],
  config: {
    enabled: true,
    account: "OPERATOR-ONLY",
    assignments: [
      { ref: "sonnet-low", model: "anthropic/claude-sonnet-5.5", effort: "low", compactWindow: null, harness: "claude-code", runsPerCell: 1 },
      { ref: "flash", model: "vendor/flash-model:free", effort: null, compactWindow: null, harness: null, runsPerCell: 1 },
    ],
  },
  state: "running",
  progress: { want: 12, done: 5, attempted: 7, capped: 1, live: 1 },
  columns: [
    { key: "sonnet-low|control", ref: "sonnet-low", arm: "control", model: "anthropic/claude-sonnet-5.5", effort: "low", compactWindow: null, harness: "claude-code" },
    { key: "sonnet-low|wake", ref: "sonnet-low", arm: "wake", model: "anthropic/claude-sonnet-5.5", effort: "low", compactWindow: null, harness: "claude-code" },
    { key: "flash|control", ref: "flash", arm: "control", model: "vendor/flash-model:free", effort: null, compactWindow: null, harness: null },
    { key: "flash|wake", ref: "flash", arm: "wake", model: "vendor/flash-model:free", effort: null, compactWindow: null, harness: null },
  ],
  grid: [
    {
      cell: "north",
      squares: [
        square("sonnet-low|control", {
          runs: 1,
          counted: 1,
          reached: 1,
          minutesToStop: { min: 41, median: 41, max: 41 },
          bestLevel: 5,
          costUsd: 1.25,
          want: 1,
          settled: "done",
          builds: ["harness-0.5-920-gaaaaaaa"],
          runIds: ["fleet-wake-probe-north-sonnet-low-20261011"],
        }),
        square("sonnet-low|wake", {
          runs: 2,
          counted: 1,
          reached: 1,
          minutesToStop: { min: 38, median: 38, max: 38 },
          bestLevel: 5,
          costUsd: 0.9,
          builds: ["harness-0.5-921-gbbbbbbb"],
          runIds: ["fleet-wake-probe-north-sonnet-low-20261011-a1", "fleet-wake-probe-north-sonnet-low-20261011-a2"],
        }),
        square("flash|control", { runs: 1, counted: 1, reached: 0, bestLevel: 3, builds: ["harness-0.5-920-gaaaaaaa"], runIds: ["fleet-wake-probe-north-flash-20261011"] }),
        square("flash|wake", { live: 1, runIds: ["fleet-wake-probe-north-flash-20261011-w"] }),
      ],
    },
    {
      cell: "south",
      // Served out of column order on purpose: the page matches by key.
      squares: [
        // Refused since the north run launched: the row now clashes with the arm's args.
        square("flash|wake", { want: 1, settled: null, refused: "compact window 100k clashes with the arm's --compact-window 50k" }),
        square("sonnet-low|control", {
          runs: 1,
          counted: 1,
          reached: 1,
          minutesToStop: { min: 52, median: 52, max: 52 },
          bestLevel: 5,
          mismatchedStart: 1,
          builds: ["harness-0.5-920-gaaaaaaa"],
          runIds: ["fleet-wake-probe-south-sonnet-low-20261011"],
        }),
        square("sonnet-low|wake", {
          runs: 2,
          counted: 0,
          bestLevel: 3,
          want: 1,
          settled: "capped",
          builds: ["harness-0.5-921-gbbbbbbb"],
          runIds: ["fleet-wake-probe-south-sonnet-low-20261011-a1", "fleet-wake-probe-south-sonnet-low-20261011-a2"],
        }),
        square("flash|control", { want: 1, settled: null }),
      ],
    },
    // `east` has no row at all: every square of it is a gap, not a shift.
  ],
  comparison: [
    {
      ref: "sonnet-low",
      arms: [
        {
          arm: "control",
          runs: 2,
          reached: 2,
          medianMinutesToStop: 46.5,
          medianTurnsToStop: 212.5,
          medianCostToStop: 1.1,
          medianPromptTokensToStop: 1_840_000,
          terminations: { "episode-limit": 0, "level-target": 2 },
          builds: ["harness-0.5-920-gaaaaaaa"],
          costAsIfMetered: 2,
        },
        {
          arm: "wake",
          runs: 2,
          reached: 1,
          medianMinutesToStop: 38,
          medianTurnsToStop: 140,
          medianCostToStop: 0.9,
          medianPromptTokensToStop: 960_000,
          terminations: { "adapter-error": 1, "level-target": 1 },
          builds: ["harness-0.5-921-gbbbbbbb"],
        },
      ],
    },
    {
      ref: "flash",
      arms: [
        {
          arm: "control",
          runs: 1,
          reached: 0,
          medianMinutesToStop: null,
          medianTurnsToStop: null,
          medianCostToStop: null,
          medianPromptTokensToStop: null,
          terminations: { "episode-limit": 1 },
          builds: ["harness-0.5-920-gaaaaaaa"],
        },
        {
          arm: "wake",
          runs: 0,
          reached: 0,
          medianMinutesToStop: null,
          medianTurnsToStop: null,
          medianCostToStop: null,
          medianPromptTokensToStop: null,
          terminations: {},
          builds: [],
        },
      ],
    },
  ],
  costUsd: 3.4,
  newestRunId: "fleet-wake-probe-north-flash-20261011-w",
  newestAt: NOW - 5 * 60_000,
};

const SIDE: CampaignView = {
  id: "side-probe",
  version: 2,
  key: "side-probe@2",
  hash: "abcdef0123456789",
  source: null,
  publishedAt: null,
  question: "Short question?",
  shape: {
    objective: "reach the next zone",
    stopAtLevel: null,
    end: [],
    episodeMs: 3_600_000,
    idleMs: 600_000,
    noXpMs: 900_000,
    maxToolCalls: 500,
    wiki: false,
    wikiCoords: false,
    resume: false,
    maxAttemptsPerCell: null,
  },
  cells: [{ id: "only", race: 1, class: 2 }],
  arms: [{ id: "base", image: null, command: null, args: [] }],
  config: null,
  state: "unassigned",
  progress: { want: 0, done: 0, attempted: 0, capped: 0, live: 0 },
  columns: [],
  grid: [{ cell: "only", squares: [] }],
  comparison: [],
  costUsd: null,
  newestRunId: null,
  newestAt: null,
};

export const CAMPAIGNS: CampaignsResponse = {
  now: NOW,
  campaigns: [WAKE, SIDE],
  refused: [
    { key: "campaigns/old-probe", reason: "names old-probe@3, which is not published" },
    { key: "wake-probe@1:flash:wake", reason: "compact window 100k clashes with the arm's --compact-window 50k" },
  ],
};
