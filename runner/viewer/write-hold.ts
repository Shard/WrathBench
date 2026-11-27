/**
 * The admin write hold: while this viewer runs a different build from the
 * fleet, it refuses every admin write and serves every read.
 *
 * A viewer release (`infra/k8s-release-viewer.sh`) moves the viewer group to a
 * newer build B while the fleet stays on A. Every config write the admin pages
 * make is validated by the viewer's own copy of the parser the supervisor runs
 * (`config-api.ts`), and the point of that is that the two reach one verdict.
 * At B the viewer could accept a shape A's supervisor refuses, and a supervisor
 * that refuses the store runs an empty board (docs/RUNBOOK.md, "Changing the
 * config shape"). So until a full release brings the fleet to the viewer's
 * build, writes go through `bun wb config` in the runner pod, which is the
 * fleet's own code.
 *
 * The two builds are already in the viewer's environment, so this needs no
 * plumbing: `WRATHBENCH_BUILD_VERSION` is baked into the image at build time
 * (infra/docker/runner.Dockerfile), and `WRATHBENCH_HARNESS_VERSION` is the
 * chart's `image.tag`, the fleet's, on every pod. A full release makes them
 * one string. Either one empty means a viewer outside the cluster image (a
 * compose stack, a hand-run `serve.ts`, a test), which has no fleet build to
 * be ahead of, so nothing is held there.
 */

import { ADMIN_API_PREFIX, CONFIG_API_PREFIX } from "./groups";
import { json } from "./http";

/** Why writes are held, and the two builds that differ. */
export interface WriteHold {
  /** The build this viewer process runs (`WRATHBENCH_BUILD_VERSION`). */
  viewer: string;
  /** The fleet's tag (`WRATHBENCH_HARNESS_VERSION`, the chart's `image.tag`). */
  fleet: string;
  /** One sentence: what is refused, why, and where to write instead. */
  why: string;
}

/** The hold the environment implies: both builds named and different, else none. */
export function writeHoldFromEnv(env: Record<string, string | undefined>): WriteHold | null {
  const viewer = (env["WRATHBENCH_BUILD_VERSION"] ?? "").trim();
  const fleet = (env["WRATHBENCH_HARNESS_VERSION"] ?? "").trim();
  if (viewer === "" || fleet === "" || viewer === fleet) return null;
  return {
    viewer,
    fleet,
    why:
      `admin writes are held: this viewer is ${viewer} and the fleet runs ${fleet}, so a write validated here may be one the fleet refuses. ` +
      "They open again with the full release that brings the fleet to this build; until then write with `bun wb config` in the runner pod, which runs the fleet's own code.",
  };
}

/** Methods that change nothing. */
const SAFE = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * The refusal for a held write, or null. Only the admin surfaces' unsafe
 * methods are held, every one of them (config rows, drafts, secrets, a Codex
 * login request), since each writes state the fleet reads; `POST
 * /api/config/export` is the one unsafe method that only reads.
 */
export function heldWrite(hold: WriteHold | null, method: string, path: string): Response | null {
  if (hold === null || SAFE.has(method.toUpperCase())) return null;
  const under = (prefix: string): boolean => path === prefix || path.startsWith(`${prefix}/`);
  if (!under(CONFIG_API_PREFIX) && !under(ADMIN_API_PREFIX)) return null;
  if (path === `${CONFIG_API_PREFIX}/export`) return null;
  return json({ error: hold.why, held: { viewer: hold.viewer, fleet: hold.fleet } }, 409);
}
