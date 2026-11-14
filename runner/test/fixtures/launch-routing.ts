/**
 * The routing a fixture run's tuple stamps when its entry launches on the
 * default base: what `comparabilityOf` writes for every openai run since
 * routing became a key, and what `countsTowardTarget` now compares. A fixture
 * run without it is a pre-routing run, which no longer counts toward a target.
 */
import { DEFAULT_API_BASE } from "../../src/providers";
import { routingForRun, type RoutingSpec } from "../../src/routing";

export function launchRouting(model: string | null, effort?: string | null): { routing?: RoutingSpec } {
  if (model === null) return {};
  const r = routingForRun({ apiBase: DEFAULT_API_BASE, model, ...(effort != null ? { effort } : {}) });
  return r === null ? {} : { routing: r };
}
