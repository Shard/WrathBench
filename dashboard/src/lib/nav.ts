/**
 * The top bar's links, in order. The brand ("WrathBench") is the home link
 * and is not in this list: the homepage is the explainer, and a nav item
 * for it would be a second way to say the same thing. About is last (operator,
 * 2026-08-30) — the meta page closes the pages about runs.
 *
 * Fleet was second-last and is no longer a nav item at all (operator,
 * 2026-08-30, both builds): it is the ops view, and it belongs beside the
 * service badge rather than beside the pages a reader came for. The `/fleet`
 * route stays, reached from the status popout in `components/StatusBadge.tsx`.
 */
export interface NavItem {
  href: string;
  label: string;
}

export const NAV: readonly NavItem[] = [
  { href: "/map", label: "map" },
  { href: "/runs", label: "runs" },
  { href: "/ladder", label: "ladder" },
  { href: "/models", label: "models" },
  { href: "/campaigns", label: "campaigns" },
  { href: "/about", label: "about" },
] as const;

/**
 * The config page's item (item 134). Not in `NAV`: it is an operator surface —
 * the write path into the fleet config — and the routes behind it are not
 * mounted at all when the viewer is in public mode. A reader who cannot use it
 * should not be told it exists.
 */
export const CONFIG_NAV: NavItem = { href: "/config", label: "config" };

/**
 * Which of the two surfaces this is, or null while it is not yet known.
 *
 * One derivation for the header badge AND the config nav item, so the badge
 * and the page can never disagree about which site a reader is on: ADMIN is
 * the operator's own build talking to a private viewer — the one where the
 * config page exists — and PREVIEW is everything else, the public bundle and
 * any viewer in public mode. Null only until `/api/info` has settled on a
 * private build, so neither the badge nor the link flickers through the wrong
 * state on the way.
 */
export type Surface = "ADMIN" | "PREVIEW";

export function surface(snapshot: boolean, publicMode: boolean | undefined): Surface | null {
  if (snapshot) return "PREVIEW";
  if (publicMode === undefined) return null;
  return publicMode ? "PREVIEW" : "ADMIN";
}

/**
 * The bar for this build and this viewer.
 *
 * `operator` is `surface(...) === "ADMIN"`: not the public bundle (which reads
 * a bucket and has no API to write to), and not a viewer in public mode (which
 * 404s the config routes). It comes through `surface` rather than being
 * recomputed, so the bar and the header badge cannot disagree.
 *
 * Config sits before `about`, which stays last (operator, 2026-08-30): the
 * meta page closes the pages about runs, and config is a page about the fleet.
 */
export function navItems(operator: boolean): readonly NavItem[] {
  if (!operator) return NAV;
  const i = NAV.findIndex((n) => n.href === "/about");
  const at = i < 0 ? NAV.length : i;
  return [...NAV.slice(0, at), CONFIG_NAV, ...NAV.slice(at)];
}
