/**
 * Out-of-game reference pages.
 *
 * The wiki documents more than the world. It also documents the patch history,
 * the Lua addon API, the client UI, the boxed products, and the company that
 * makes them. A character standing in Elwynn has no use for any of it, but the
 * full-text index does not know that: trajectory mining over 462
 * `search_reference` calls found `Hotfixes/2015 Archive` served fifteen times,
 * pop-culture-reference lists thirty-eight, and an addon page, an expansion
 * product page and `UI coordinates` besides. Every one of those is a slot of
 * the model's reference budget spent on something it cannot act on.
 *
 * So: classify, and the build does not emit a classified page. This used to
 * label and demote at query time instead; the bundle is now a concise Wrath
 * reference and what is not in the world is not in it (ADR-0040). The
 * carve-out that kept an exact-title hit at the top goes with the band — the
 * page is not there to return.
 *
 * The rules are deterministic and read the **title** only — no body text, no
 * heuristics over prose. They are also deliberately conservative: a rule earns
 * its place by being unambiguous across the whole bundle, and several plausible
 * ones were dropped for a single counterexample. `Widget*` looked safe until
 * `Widget the Departed` turned out to be an NPC. `* (old)` looked safe until it
 * turned out to be mostly superseded spell and quest versions — `Holy Shield
 * (old)`, `Ignite (old)` — which are an era problem (`post-wrath.ts` owns
 * that), not an out-of-game problem. Precision matters more than recall here:
 * a missed hotfix archive costs a page of bundle, a dropped quest page costs
 * the run.
 */

/** Why a page is out of the world. Reported so the caller can see the rule. */
export type MetaReason =
  | "hotfixes"
  | "patch-notes"
  | "pop-culture"
  | "addon"
  | "api"
  | "ui"
  | "macro"
  | "product"
  | "real-world"
  | "meta-category"
  | "legacy-meta";

/**
 * Legacy meta pages. `* (old)` is not a safe rule (see the module note), so the
 * handful of glossary/UI pages that carry the suffix are named outright rather
 * than dragging every old spell revision down with them.
 */
const LEGACY_META = new Set([
  "Zone (old)",
  "Zones by level (old)",
  "Zones by faction (old)",
  "Slash commands (old)",
  "List of slash commands (old)",
  "Useful macros (old)",
  "Pet abilities (old)",
]);

/** Macro and slash-command documentation that does not carry the `MACRO ` prefix. */
const MACRO_PAGES = new Set([
  "Macro",
  "Macros",
  "Macro API",
  "Macro FAQ",
  "Useful macros",
  "Slash commands",
  "Slash command",
  "List of slash commands",
]);

/**
 * Client UI documentation whose titles are not prefixed. `Widget` alone is the
 * widget-system article; `Widget the Departed` is an NPC, which is why this is
 * a set and not a prefix.
 */
const UI_PAGES = new Set(["Widget", "Widget API", "Widget handlers", "UI"]);

/** `Category:` prefixes that name a meta topic rather than a thing in the world. */
const META_CATEGORY_PREFIXES = [
  "Category:API",
  "Category:AddOn",
  "Category:Macro",
  "Category:Widget",
  "Category:Interface",
  "Category:Patch",
  "Category:Removed in patch",
  "Category:WoW Icons",
  "Category:Blizzard",
  "Category:Web API",
  "Category:User:",
];

/** A title and every subpage of it: `X`, `X/…`. */
function isPageOrSubpage(title: string, base: string): boolean {
  return title === base || title.startsWith(`${base}/`);
}

/**
 * Prefix match that stops at a word boundary, so `Category:Patch` catches
 * `Category:Patch images` and `Category:Patches` but not `Category:Patchwerk`
 * (a raid boss). A prefix that ends in `:` is already a namespace and matches
 * whatever follows.
 */
function prefixMatches(title: string, prefix: string): boolean {
  if (!title.startsWith(prefix)) return false;
  if (prefix.endsWith(":")) return true;
  let rest = title.slice(prefix.length);
  if (rest.startsWith("s")) rest = rest.slice(1);
  return rest === "" || !/^[A-Za-z]/.test(rest);
}

/**
 * Classify a page title as out-of-game, or return null.
 *
 * A pure function of the title, which is what lets it run at query time with no
 * schema change. It took a `wikitext` argument for symmetry with the other
 * extractors and never read it; a future structural rule (an
 * `{{addon}}`/`{{patchnote}}` template, say) would earn the argument back.
 *
 * Case matters for the namespace-style prefixes: the wiki namespaces its API,
 * UI, XML and macro documentation by title prefix (`API GetSpellInfo`,
 * `MACRO cast`), and lowercasing them would start matching prose titles.
 */
export function classifyMetaPage(title: string): MetaReason | null {
  const t = title.replace(/_/g, " ").trim();
  if (t === "") return null;

  // --- Category: meta topics. Checked first: a category page is never a thing
  // in the world, only a list of them, and the prefixes below are unambiguous.
  for (const prefix of META_CATEGORY_PREFIXES) {
    if (prefixMatches(t, prefix)) return "meta-category";
  }

  // --- Hotfix archives: `Hotfixes`, `Hotfixes/2015 Archive`.
  if (isPageOrSubpage(t, "Hotfixes")) return "hotfixes";

  // --- Patch notes. `Patch ` alone is NOT safe: `Patch of Bat Hair` is an item.
  // A digit after `Patch ` is, and the remaining patch-infrastructure pages are
  // named outright.
  if (/^Patch \d/.test(t)) return "patch-notes";
  if (isPageOrSubpage(t, "Patches") || /^Patches\/\d/.test(t)) return "patch-notes";
  for (const base of ["Patch", "Patch mirrors", "Patch FAQ", "Patch Day", "Patch notes"]) {
    if (isPageOrSubpage(t, base)) return "patch-notes";
  }
  if (t.startsWith("Patch mirrors (")) return "patch-notes";

  // --- Pop-culture reference lists and their per-expansion subpages.
  if (t.startsWith("List of pop culture references")) return "pop-culture";

  // --- Addons: the wiki disambiguates them with a parenthesised suffix.
  if (/\((AddOn|Addon|addon)\)(\/|$)/.test(t)) return "addon";

  // --- Lua API function pages, namespaced by prefix. Both `API GetSpellInfo`
  // and the Lua-builtin pages (`API pcall`) live here.
  if (t.startsWith("API ")) return "api";

  // --- Client UI and XML documentation, namespaced the same way.
  if (t.startsWith("UI ") || t.startsWith("XML ")) return "ui";
  if (t.startsWith("Widget API") || t.startsWith("Widget Anchor")) return "ui";
  if (UI_PAGES.has(t)) return "ui";

  // --- Macros and slash commands. `MACRO ` is the wiki's prefix for the
  // per-command pages and is upper-case by convention.
  if (t.startsWith("MACRO ")) return "macro";
  if (MACRO_PAGES.has(t)) return "macro";

  // --- Boxed products: expansions, novels, comics, board games, soundtracks,
  // strategy guides. All 94 in the bundle are products, none is in the world.
  if (t.startsWith("World of Warcraft: ")) return "product";

  // --- Real world. Only the two prefixes that cannot mean anything else:
  // `Blizzard` alone is a mage spell, so no bare `Blizzard*` rule.
  if (t === "Blizzard Entertainment" || t.startsWith("Blizzard Entertainment ")) return "real-world";
  if (isPageOrSubpage(t, "BlizzCon") || /^BlizzCon \d/.test(t)) return "real-world";

  // --- Named legacy meta pages (see LEGACY_META).
  if (LEGACY_META.has(t)) return "legacy-meta";

  return null;
}
