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
 * The bar for this build and this viewer.
 *
 * `operator` is the conjunction of both facts the page needs: this is not the
 * public bundle (which reads a bucket and has no API to write to), and the
 * viewer answering is not in public mode (which 404s the config routes). The
 * caller passes `=== false` on the second rather than `!publicMode`, so the
 * link does not flash on before `/api/info` has settled.
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
