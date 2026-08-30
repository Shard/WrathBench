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
