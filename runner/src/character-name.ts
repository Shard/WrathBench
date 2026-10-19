/**
 * Kept in a module of its own so the light modules that check a name (the
 * party shapes, read by the fleet and the viewer) need not load the run config.
 */

/**
 * The game's own character-name rules, checked before the server gets to:
 * 2-12 letters, and no three identical consecutive letters — the core refuses
 * that as CHAR_NAME_THREE_CONSECUTIVE (create result 98). One predicate for
 * every boundary that accepts or invents a name (this config, the fleet
 * roster, a campaign cell, the smokes' probeName), so a bad name is a named
 * error where it is WRITTEN, not a create-failure loop where it is played.
 * Both failure shapes happened on 2026-08-24: a 13-char roster name
 * respawn-looped the policy for two hours, and a generated triple
 * (`Bqeee…`) rolled back a worldserver deploy.
 */
export const CHARACTER_NAME_RULE = "character must be 2-12 letters with no three identical in a row (the game's own naming rules)";
export function isValidCharacterName(name: string): boolean {
  return /^[A-Za-z]{2,12}$/.test(name) && !/(.)\1\1/i.test(name);
}
