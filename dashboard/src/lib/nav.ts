/**
 * The top bar's links, in order. The brand ("WrathBench") is the home link
 * and is not in this list: the homepage is the explainer, and a nav item
 * for it would be a second way to say the same thing. About is last — the
 * meta page closes the pages about runs.
 *
 * Fleet was second-last and is no longer a nav item at all, in either build:
 * it is the ops view, and it belongs beside the
 * service badge rather than beside the pages a reader came for. The `/fleet`
 * route stays, reached from the status popout in `components/StatusBadge.tsx`.
 */
import type { ApiInfoResponse } from "@viewer/api-types";
import { ALL_GROUPS, pageMounted, type Groups, type PageSite } from "@viewer/groups";
import { pageSiteOf } from "./site";

export interface NavItem {
  href: string;
  label: string;
}

export const NAV: readonly NavItem[] = [
  { href: "/map", label: "map" },
  { href: "/ladder", label: "ladder" },
  { href: "/runs", label: "runs" },
  { href: "/models", label: "models" },
  { href: "/campaigns", label: "campaigns" },
  { href: "/about", label: "about" },
] as const;

/**
 * The admin page's item. Not in `NAV`: it is the admin interface — the write
 * path into the config store — and the routes behind it are mounted only on a
 * viewer with the admin switch on (`@viewer/groups`), never in public mode.
 * A reader who cannot use it should not be told it exists.
 */
export const ADMIN_NAV: NavItem = { href: "/admin", label: "admin" };

/**
 * Which of the surfaces this is, or null when there is no word to show.
 *
 * One derivation for the header badge AND the admin nav item, so the badge
 * and the page can never disagree about which site a reader is on: ADMIN is
 * the operator's own build talking to a viewer with the admin switch on — the
 * one where the admin page exists — and PREVIEW is the public bundle and any
 * viewer in public mode. A private viewer without the switch claims neither,
 * and nothing is claimed until `/api/info` has settled on a private build, so
 * neither the badge nor the link flickers through the wrong state.
 */
export type Surface = "ADMIN" | "PREVIEW";

export function surface(snapshot: boolean, info: Pick<ApiInfoResponse, "publicMode" | "admin"> | undefined): Surface | null {
  if (snapshot) return "PREVIEW";
  if (info === undefined) return null;
  if (info.publicMode) return "PREVIEW";
  return info.admin === true ? "ADMIN" : null;
}

/** The deployment's groups as `/api/info` (or a snapshot's `info.json`) states them: absent is every group. */
export function groupsOf(info: Pick<ApiInfoResponse, "groups"> | undefined): Groups {
  return info?.groups ?? ALL_GROUPS;
}

/**
 * Whether a link to `href` may render on this deployment: its page is mounted
 * for the groups `/api/info` states (`pageMounted`, on the path alone, so a
 * query or a fragment does not hide which page it is). False until `/api/info`
 * has settled, so a link into an off group never flashes on; the caller draws
 * the text without the link instead.
 */
export function linkable(info: Pick<ApiInfoResponse, "groups" | "site"> | undefined, href: string): boolean {
  if (info === undefined) return false;
  return pageMounted(href.replace(/[?#].*$/, ""), groupsOf(info), false, pageSiteOf(info));
}

/**
 * The bar for this deployment: the reader's items whose group is on
 * (`pageMounted`), and the admin item where the badge says ADMIN.
 *
 * `admin` is `surface(...) === "ADMIN"`, so the bar and the header badge
 * cannot disagree. Admin sits before `about`, which stays last: the meta page
 * closes the pages about runs, and admin is a page about the deployment.
 */
export function navItems(o: { admin: boolean; groups?: Groups; site?: PageSite }): readonly NavItem[] {
  const groups = o.groups ?? ALL_GROUPS;
  const shown = NAV.filter((n) => pageMounted(n.href, groups, false, o.site));
  if (!o.admin) return shown.length === NAV.length ? NAV : shown;
  const i = shown.findIndex((n) => n.href === "/about");
  const at = i < 0 ? shown.length : i;
  return [...shown.slice(0, at), ADMIN_NAV, ...shown.slice(at)];
}
