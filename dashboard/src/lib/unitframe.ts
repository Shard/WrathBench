/**
 * The unit frame's arithmetic, kept pure so the bars are checked here rather
 * than by looking at a DOM.
 *
 * The frame is modelled on the client's own: a health bar, a power bar tinted
 * by the character's power type, and an experience bar with the level in a
 * badge where the portrait's ring would be. Colours are the client's
 * `PowerBarColor` triples (mana 0/0/1, rage 1/0/0, energy 1/1/0, focus
 * 1/.5/.25, runic power 0/.82/1) pulled toward the page in each scheme, as
 * custom properties in `styles.css`; this file only names them.
 *
 * What the feed carries decides what draws. Level and xp are on every
 * `AgentPosition`; health, power and class are in the SDK's state cache but
 * the runner's state sampler does not write them yet (FOLLOW-UPS 102), so a
 * bar whose numbers are absent renders as *unobserved* — an empty track with a
 * dash — rather than as zero. Undefined means unobserved, never zero, the same
 * rule the SDK holds.
 */

/** 3.3.5a power type ids, as `UNIT_FIELD_BYTES_0` carries them. */
export type PowerType = "mana" | "rage" | "focus" | "energy" | "runic";

const POWER_BY_ID: Record<number, PowerType> = { 0: "mana", 1: "rage", 2: "focus", 3: "energy", 6: "runic" };

/** The power type behind a numeric id; anything the client has no bar for is mana. */
export function powerTypeOf(id: number | null | undefined): PowerType {
  return (id === null || id === undefined ? undefined : POWER_BY_ID[id]) ?? "mana";
}

/**
 * A class's primary power at 3.3.5a, for a feed that carries the class but no
 * per-sample power type. Hunters used mana until Cataclysm; focus is the pet's.
 */
export function classPowerType(klass: number | null | undefined): PowerType {
  switch (klass) {
    case 1: return "rage"; // warrior
    case 4: return "energy"; // rogue
    case 6: return "runic"; // death knight
    default: return "mana";
  }
}

/** The custom property each power type paints with; see `styles.css`. */
export function powerToken(type: PowerType): string {
  return `var(--power-${type})`;
}

/** A bar's fill as 0–100, clamped, and 0 for anything that is not a real ratio. */
export function percentOf(cur: number | null | undefined, max: number | null | undefined): number {
  if (typeof cur !== "number" || typeof max !== "number") return 0;
  if (!Number.isFinite(cur) || !Number.isFinite(max) || max <= 0) return 0;
  return Math.min(100, Math.max(0, (cur / max) * 100));
}

/** What one bar draws: its fill, its label, and whether it has numbers at all. */
export interface BarReading {
  pct: number;
  /** "cur / max" — or a dash when unobserved. */
  text: string;
  /** "42%" for the title; empty when unobserved. */
  title: string;
  observed: boolean;
}

export function barReading(cur: number | null | undefined, max: number | null | undefined): BarReading {
  const observed = typeof cur === "number" && typeof max === "number" && max > 0;
  if (!observed) return { pct: 0, text: "—", title: "", observed: false };
  const pct = percentOf(cur, max);
  return { pct, text: `${fmtInt(cur)} / ${fmtInt(max)}`, title: `${Math.round(pct)}%`, observed: true };
}

/**
 * Dead or a released ghost. The cache's own convention: health 0 is a corpse,
 * 1 is a ghost (`BuildPlayerRepop` sets it), anything above is alive. A feed
 * that says so outright (`dead: true`) wins over the inference.
 */
export function isDead(health: number | null | undefined, dead?: boolean | null): boolean {
  if (dead === true) return true;
  if (dead === false) return false;
  return typeof health === "number" && health <= 1;
}

/**
 * Health as the frame shows it: a dead character's bar is empty and muted
 * even though a ghost technically carries 1 hp.
 */
export function healthReading(cur: number | null | undefined, max: number | null | undefined, dead?: boolean | null): BarReading & { dead: boolean } {
  const d = isDead(cur, dead);
  const r = barReading(cur, max);
  if (d && r.observed) return { ...r, pct: 0, text: `0 / ${fmtInt(max as number)}`, title: "dead", dead: true };
  return { ...r, dead: d };
}

/**
 * XP needed to leave each level at 3.3.5a, indexed by level (index 0 unused),
 * as AzerothCore's `player_xp_for_level` ships it. A fallback for a feed that
 * carries `xp` but not `nextLevelXp`; the stream's own value wins when present.
 * Level 80 is the cap and has no next.
 */
export const XP_FOR_LEVEL: readonly number[] = [
  0,
  400, 900, 1400, 2100, 2800, 3600, 4500, 5400, 6500, 7600,
  8700, 9800, 11000, 12300, 13600, 15000, 16400, 17800, 19300, 20800,
  22400, 24000, 25500, 27200, 28900, 30500, 32200, 33900, 36300, 38800,
  41600, 44600, 48000, 51400, 55000, 58700, 62400, 66200, 70200, 74300,
  78500, 82800, 87100, 91600, 96300, 101000, 105800, 110700, 115700, 120900,
  126100, 131500, 137000, 142500, 148200, 154000, 159900, 165800, 171900, 178100,
  494000, 574700, 614400, 650300, 682300, 710200, 734100, 753700, 768900, 779700,
  1523800, 1539600, 1555700, 1571800, 1587900, 1604200, 1620700, 1637400, 1653900, 1670800,
];

export function xpToNext(level: number | null | undefined, nextLevelXp?: number | null): number | null {
  if (typeof nextLevelXp === "number" && nextLevelXp > 0) return nextLevelXp;
  if (typeof level !== "number" || level < 1 || level >= 80) return null;
  return XP_FOR_LEVEL[level] ?? null;
}

function fmtInt(n: number): string {
  return Math.round(n).toLocaleString("en-US");
}
