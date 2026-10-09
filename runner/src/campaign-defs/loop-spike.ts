/**
 * loop-spike: the next-minor loop spike and its same-endpoint 0.5 comparison,
 * written after its runs to attribute them.
 *
 * These nine were launched by hand with `--episode probing` and no campaign,
 * because `probing` was the only unscored switch for a branch build that still
 * described itself as 0.5; nothing at launch required a campaign then. They
 * vary the harness build, not the start, so the cells are loop shapes and each
 * run's exact build is its own `harnessVersion`. Closed: a cell that names a
 * build cannot be launched by the fleet, and the definition states no budget
 * because the nine did not share one (two ran through OpenRouter and seven on
 * the DeepSeek platform; five carried the runner's 500-call default and four
 * carried 3000). Every dimension is read off the run.
 */

import type { ClosedCampaignDef } from "./types";

export const LOOP_SPIKE_V1 = {
  id: "loop-spike",
  version: 1,
  status: "closed",
  question:
    "On one endpoint and one start, does a workspace or entrypoint loop beat the 0.5 snippet loop on cost to level 5?",
  cells: [
    { id: "workspace", race: 1, class: 2, build: "harness/workspace: run-scoped file workspace" },
    { id: "entrypoint", race: 1, class: 2, build: "harness/workspace: entrypoint loop, including load-on-save" },
    { id: "reference-0.5", race: 1, class: 2, build: "0.5 snippet loop, production image" },
    { id: "0.5-fixes", race: 1, class: 2, build: "0.5 with transport events out of the window and SDK early returns" },
  ],
  legacy: {
    members: [
      { runId: "probe-workspace-20260925", cell: "workspace" },
      { runId: "probe-spike-20260925-1", cell: "entrypoint" },
      { runId: "probe-spike-20260926-2b", cell: "entrypoint" },
      { runId: "probe-spike-20260926-3", cell: "entrypoint" },
      { runId: "probe-spike-20260926-5", cell: "entrypoint" },
      { runId: "probe-ref05-20260926", cell: "reference-0.5" },
      { runId: "probe-05fix-20260926-1", cell: "0.5-fixes" },
      { runId: "probe-05fix-20260926-2", cell: "0.5-fixes" },
      { runId: "probe-05fix-20260926-3", cell: "0.5-fixes" },
    ],
  },
} as const satisfies ClosedCampaignDef;
