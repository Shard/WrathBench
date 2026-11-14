/**
 * The benchmark's own wording for what a model reads at fan-out when it names
 * no character: the roll-up (`state_summary` with no `character`, and the
 * fixed loop's turn context), a merged feed line's "who saw it", and
 * `list_characters`.
 *
 * A COPY of the stack's plain default (`PLAIN_FANOUT_RENDER` in
 * `@wrathbench/mcp/fanout`), owned here so a stack bump cannot move scored
 * model surface silently: `deadmines-solo` is scored on it. Its texts are
 * today's stack default, byte for byte, and `runner/test/fanout-wording.test.ts`
 * holds them to literal goldens and to the stack's own output. The freeze is
 * PENDING: whether this wording stands for the series waits on the
 * operator's read of deadmines@5, and until then a change here is made only
 * on that read. From the freeze on, `ROLLUP` below is a context-policy
 * constant and changing one is a harness change.
 *
 * Partial by construction: the tool descriptions, the `character` argument's
 * text and the refusals are built inside the stack's `fanoutTools` and are not
 * a render it takes, so they still come from the pinned stack.
 */

import { groupCentre, type CharacterDigest, type CharacterView, type FanoutRender } from "@wrathbench/mcp/fanout";

/** What the roll-up measures against: the stack default's values, owned here. */
export const ROLLUP = {
  /** Health at or below this share is an exception. */
  LOW_HEALTH: 0.35,
  /** Mana at or below this share counts as out of power. */
  OUT_OF_POWER: 0.1,
  /** Farther than this (yards, on the map plane) from where most of the group stands is an exception. */
  FAR_YARDS: 100,
} as const;

const NO_CHARACTERS = "No character is logged in; use login_character.";

/** What is unusual about one character, as short phrases; empty when nothing is. */
function exceptionsOf(d: CharacterDigest, centre: ReturnType<typeof groupCentre>): string[] {
  if (!d.inWorld) return ["not in the world"];
  const out: string[] = [];
  if (!d.connected) out.push("disconnected");
  if (d.dead) out.push("dead");
  else if (d.health !== null && d.health.max > 0 && d.health.current / d.health.max <= ROLLUP.LOW_HEALTH) {
    out.push(`health ${Math.round((100 * d.health.current) / d.health.max)}%`);
  }
  if (centre !== null && d.map !== null && d.x !== null && d.y !== null) {
    if (d.map !== centre.map) out.push(`on map ${d.map}`);
    else {
      const far = Math.hypot(d.x - centre.x, d.y - centre.y);
      if (far > ROLLUP.FAR_YARDS) out.push(`${Math.round(far)}y from the group`);
    }
  }
  if (d.moveRefused !== null) out.push(`last move ${d.moveRefused}`);
  return out;
}

function rollup(digests: readonly CharacterDigest[], o: { maxCharacters: number; views: readonly CharacterView[] }): string {
  const detached = o.views.filter((v) => v.state === "detached");
  if (digests.length === 0 && detached.length === 0) return NO_CHARACTERS;
  const world = digests.filter((d) => d.inWorld);
  const count = (f: (d: CharacterDigest) => boolean): number => world.filter(f).length;
  const lines = [
    `${digests.length} of ${o.maxCharacters} characters logged in: ${count((d) => !d.dead)} alive, ${count((d) => d.dead)} dead, ` +
      `${count((d) => d.inCombat)} in combat, ${count((d) => d.casting)} casting, ` +
      `${count((d) => d.mana && d.power !== null && d.power.max > 0 && d.power.current / d.power.max <= ROLLUP.OUT_OF_POWER)} out of mana`,
  ];
  // Where most of the group stands is arithmetic, not wording: the stack's.
  const centre = groupCentre(digests);
  if (centre !== null) {
    const zones = [...new Set(world.filter((d) => d.map === centre.map && d.zone !== null).map((d) => d.zone))];
    lines.push(`group: ${centre.count} on map ${centre.map} around (${centre.x.toFixed(0)}, ${centre.y.toFixed(0)})${zones.length === 1 ? `, ${zones[0]}` : ""}`);
  }
  const exceptions = digests.map((d) => ({ d, why: exceptionsOf(d, centre) })).filter((e) => e.why.length > 0);
  for (const e of exceptions) lines.push(`${e.d.character}: ${e.why.join(", ")}`);
  for (const v of detached) lines.push(`${v.character}: not attached${v.error !== undefined ? ` (${v.error})` : ""}`);
  if (exceptions.length === 0 && detached.length === 0) lines.push("no exceptions");
  return lines.join("\n");
}

function list(views: readonly CharacterView[], digests: readonly CharacterDigest[], o: { maxCharacters: number }): string {
  const byName = new Map(digests.map((d) => [d.character, d]));
  const lines: string[] = [];
  for (const v of views.filter((x) => x.state !== "out")) {
    const d = byName.get(v.character);
    if (v.state === "detached") {
      lines.push(`${v.character}: not attached${v.error !== undefined ? ` (${v.error})` : ""}`);
      continue;
    }
    const parts = [
      d?.level !== null && d?.level !== undefined ? `level ${d.level}` : null,
      d?.health !== null && d?.health !== undefined ? `health ${d.health.current}/${d.health.max}` : null,
      d?.map !== null && d?.map !== undefined ? `map ${d.map}${d.zone !== null ? ` (${d.zone})` : ""}` : null,
      d?.dead === true ? "dead" : null,
      d !== undefined && !d.connected ? "disconnected" : null,
    ].filter((p): p is string => p !== null);
    lines.push(`${v.character}${parts.length > 0 ? `: ${parts.join(", ")}` : ""}`);
  }
  const inNow = views.filter((x) => x.state !== "out").length;
  lines.push(`${inNow} of ${o.maxCharacters} characters logged in.`);
  const out = views.filter((x) => x.state === "out").map((x) => x.character);
  if (out.length > 0) lines.push(`Not logged in: ${out.join(", ")}.`);
  return lines.join("\n");
}

/** The runner's fan-out wording: today's stack default, held here (see above). */
export const WRATHBENCH_FANOUT_RENDER: FanoutRender = {
  rollup,
  seenBy: (names) => (names.length === 1 ? ` [${names[0]}]` : ` [seen by ${names.length}]`),
  list,
};
