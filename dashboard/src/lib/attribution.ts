/**
 * The attribution statement every published artifact must carry
 * (docs/DATA-AND-LEGAL.md), as a build-time constant so the public shell's
 * footer renders before — and regardless of whether — any artifact fetch
 * succeeds. A copy of `PUBLIC_ATTRIBUTION` in `runner/viewer/public-projection.ts`
 * rather than an import: that module drags the runner's config and zod into
 * the bundle, and a one-line copy pinned equal by `test/attribution.test.ts`
 * cannot drift silently. Wording is the operator's; change it there first.
 */
export const PUBLIC_ATTRIBUTION =
  "WrathBench is a fan-made research project, not affiliated with or endorsed by Blizzard Entertainment. World of Warcraft is a trademark of Blizzard Entertainment, Inc.";
