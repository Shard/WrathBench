/**
 * The three groups a deployment is made of, and the admin switch beside them
 * (GitHub issue #427). Pure, so the viewer, the supervisor, the publisher and
 * the dashboard read one definition.
 *
 * - **runner**: the agent loop, drivers, providers and credentials, and the
 *   fleet supervisor that launches runs.
 * - **evals**: episodes, campaigns, scoring, the ladder and comparability.
 * - **viewer**: the inspector, run pages and the public site.
 *
 * A group that is off is absent, not hidden: its pages are not in the
 * dashboard's routes, its API routes answer 404 as any unknown path does, and
 * its background work does not run (the supervisor launches no scored or
 * probing episode with evals off; the chart renders no fleet, runner or run
 * pod with runner off, and no viewer, publisher or collector with viewer off).
 *
 * Which groups are on is deployment config, not fleet config: it decides
 * which workloads the chart renders and which routes a process mounts, so it
 * is a chart value (`groups.<name>.enabled`) handed to each process as
 * `WRATHBENCH_GROUPS`, read once at start. The config store holds what the
 * deployment runs; this says what the deployment is.
 *
 * The admin switch (`admin.enabled`, `WRATHBENCH_ADMIN=1`) mounts the
 * operator's write surface: the config API and the admin pages. Off, which is
 * the chart's default, a viewer has no write route at all. A public handle
 * never has it, whatever the switch says.
 */

export const GROUPS = ["runner", "evals", "viewer"] as const;
export type Group = (typeof GROUPS)[number];
export type Groups = Readonly<Record<Group, boolean>>;

/** Every group on: what an unset `WRATHBENCH_GROUPS` means, and today's deployment. */
export const ALL_GROUPS: Groups = { runner: true, evals: true, viewer: true };

export const GROUPS_ENV = "WRATHBENCH_GROUPS";
export const ADMIN_ENV = "WRATHBENCH_ADMIN";

export function allGroupsOn(g: Groups): boolean {
  return GROUPS.every((name) => g[name]);
}

/**
 * The groups a process runs with, from `WRATHBENCH_GROUPS`: a comma-separated
 * list of the groups that are ON. Unset is every group; set and empty is none.
 * A name that is not a group throws, so a typo in the chart is a startup
 * failure rather than a group silently off.
 */
export function groupsFromEnv(env: Record<string, string | undefined>): Groups {
  const raw = env[GROUPS_ENV];
  if (raw === undefined) return ALL_GROUPS;
  const names = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  for (const n of names) {
    if (!(GROUPS as readonly string[]).includes(n)) {
      throw new Error(`${GROUPS_ENV}=${raw}: ${JSON.stringify(n)} is not a group (one of ${GROUPS.join(", ")})`);
    }
  }
  return { runner: names.includes("runner"), evals: names.includes("evals"), viewer: names.includes("viewer") };
}

/** The env spelling of a set of groups, as the chart renders it. */
export function groupsEnvValue(g: Groups): string {
  return GROUPS.filter((name) => g[name]).join(",");
}

/** Whether the admin switch is on: `WRATHBENCH_ADMIN=1` and nothing else. */
export function adminFromEnv(env: Record<string, string | undefined>): boolean {
  return env[ADMIN_ENV] === "1";
}

/**
 * The group an API path belongs to, or null for the viewer's own routes, which
 * are there whenever a viewer is.
 *
 * - runner: the supervisor's state (`/api/fleet`) and its scheduling verdict
 *   per roster entry (`/api/models`).
 * - evals: the ladder, the campaigns, and the episodes and tiers the about
 *   page reads (`/api/episodes`).
 *
 * `/api/results` stays the viewer's: it is the runs index and the character
 * and party pages' listing, not the ladder (which is `/api/ladder`).
 */
export function groupOfApiPath(path: string): Group | null {
  switch (path) {
    case "/api/fleet":
    case "/api/models":
      return "runner";
    case "/api/ladder":
    case "/api/campaigns":
    case "/api/episodes":
      return "evals";
    default:
      return null;
  }
}

/**
 * The group a dashboard page belongs to, by its first path segment, or null
 * for the viewer's own pages. The config page is the admin switch's, not a
 * group's (`isAdminPage`).
 */
export function groupOfPage(pathname: string): Group | null {
  const head = `/${pathname.split("/")[1] ?? ""}`;
  switch (head) {
    case "/fleet":
    case "/models":
      return "runner";
    case "/ladder":
    case "/campaigns":
    case "/about":
    case "/episodes":
      return "evals";
    default:
      return null;
  }
}

/** Whether a page is part of the admin interface. */
export function isAdminPage(pathname: string): boolean {
  const head = `/${pathname.split("/")[1] ?? ""}`;
  return head === "/config";
}

/**
 * Whether a page is mounted for these groups and this admin switch. The
 * viewer's own pages always are; the dashboard reaches none of this before
 * `/api/info` says what the deployment is.
 */
export function pageMounted(pathname: string, groups: Groups, admin: boolean): boolean {
  if (isAdminPage(pathname)) return admin;
  const g = groupOfPage(pathname);
  return g === null || groups[g];
}
