/**
 * The top bar's links, in order. The brand ("WrathBench") is the home link
 * and is not in this list: the homepage is the explainer, and a nav item
 * for it would be a second way to say the same thing. Fleet sits second-last
 * and About last (operator, 2026-08-30) — the operational page and the meta
 * page bracket the pages about runs.
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
  { href: "/fleet", label: "fleet" },
  { href: "/about", label: "about" },
] as const;
