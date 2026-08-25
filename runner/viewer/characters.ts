/**
 * Race and class ids as 3.3.5a spells them, for display only.
 *
 * The extras cycle gives free models a different starting character
 * per extra run, so `race: 3, class: 3` has to reach a page as "Dwarf Hunter"
 * or the dimension is unreadable. The ids are the client's own — `enum Races`
 * and `enum Classes` in AzerothCore's `SharedDefines.h`, which is where these
 * tables were copied from — so the gaps are real: 9 is an unplayable goblin in
 * 3.3.5a and class 10 does not exist.
 *
 * Two nulls are kept apart on purpose, the way the rest of the viewer keeps
 * them apart: a run whose metadata never recorded a race reads `null`
 * ("not recorded", never back-labeled), while an id no table knows renders as
 * its own number rather than being dropped or guessed into a neighbour.
 *
 * Import-free, like `api-types.ts`, so the dashboard could bundle it — though
 * today it does not need to: the composed label travels on the wire.
 */

export const RACE_NAMES: Readonly<Record<number, string>> = {
  1: "Human",
  2: "Orc",
  3: "Dwarf",
  4: "Night Elf",
  5: "Undead",
  6: "Tauren",
  7: "Gnome",
  8: "Troll",
  10: "Blood Elf",
  11: "Draenei",
};

export const CLASS_NAMES: Readonly<Record<number, string>> = {
  1: "Warrior",
  2: "Paladin",
  3: "Hunter",
  4: "Rogue",
  5: "Priest",
  6: "Death Knight",
  7: "Shaman",
  8: "Mage",
  9: "Warlock",
  11: "Druid",
};

function nameOf(table: Readonly<Record<number, string>>, id: number | null | undefined): string | null {
  if (id === null || id === undefined || !Number.isFinite(id)) return null;
  return table[id] ?? String(id);
}

/** "Dwarf" for 3; the bare number for an id the client has no race for. */
export function raceName(id: number | null | undefined): string | null {
  return nameOf(RACE_NAMES, id);
}

/** "Hunter" for 3; the bare number for an id the client has no class for. */
export function className(id: number | null | undefined): string | null {
  return nameOf(CLASS_NAMES, id);
}

/**
 * The compact label a row shows: "Dwarf Hunter", or the half that was recorded
 * when only one was, or null when neither was.
 */
export function characterLabel(race: number | null | undefined, klass: number | null | undefined): string | null {
  const parts = [raceName(race), className(klass)].filter((p): p is string => p !== null);
  return parts.length === 0 ? null : parts.join(" ");
}
