/**
 * Which of the homepage's group-owned sections a deployment has
 * (`@viewer/groups`): the tool list is the runner group's, the ladder the
 * evals group's. Nothing is shown before `/api/info` has answered, so a
 * viewer-only deployment never draws a section, or asks for its data, only to
 * take it away again.
 */

import type { ApiInfoResponse } from "@viewer/api-types";
import { groupsOf } from "./nav";

export interface HomeGroups {
  tools: boolean;
  ladder: boolean;
}

export function homeGroups(info: Pick<ApiInfoResponse, "groups"> | undefined): HomeGroups {
  if (info === undefined) return { tools: false, ladder: false };
  const g = groupsOf(info);
  return { tools: g.runner, ladder: g.evals };
}
