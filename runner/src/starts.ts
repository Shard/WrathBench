/**
 * The race and class pairs a fresh character may be created as, for a run
 * whose model chooses its own start (`RunConfig.chooseStart`; operator,
 * 2026-11-15).
 *
 * The pairs are what a 3.3.5a client's character-creation screen offers: the
 * pinned AzerothCore tree's `playercreateinfo` rows, by the client's own ids
 * (`enum Races`/`enum Classes` in SharedDefines.h, named in
 * `runner/src/characters.ts`). The Death Knight (class 6) is left out: the
 * server creates one only on an account that already holds a level-55
 * character (`CharacterCreating.MinLevelForHeroicCharacter`), which a fresh
 * run's account does not, so it is not a start this harness can offer.
 */

/** Race id -> the class ids it may be, in id order. */
export const VALID_STARTS: Readonly<Record<number, readonly number[]>> = {
  1: [1, 2, 4, 5, 8, 9],
  2: [1, 3, 4, 7, 9],
  3: [1, 2, 3, 4, 5],
  4: [1, 3, 4, 5, 11],
  5: [1, 4, 5, 8, 9],
  6: [1, 3, 7, 11],
  7: [1, 4, 8, 9],
  8: [1, 3, 4, 5, 7, 8],
  10: [2, 3, 4, 5, 8, 9],
  11: [1, 2, 3, 5, 7, 8],
};

/** Whether a fresh character may be created as this race and class. */
export function isValidStart(race: unknown, klass: unknown): boolean {
  return typeof race === "number" && typeof klass === "number" && (VALID_STARTS[race]?.includes(klass) ?? false);
}

/**
 * The failures a createSession with a race and class no character can have
 * comes back with, in the words the model sees them: the SDK's own refusal
 * of a non-numeric id (`invalid_race`, `invalid_class`), the module's for an
 * id out of range (`invalid_race_class`), and the server's character-create
 * codes for a pair it has no start for (48, `CHAR_CREATE_ERROR`), a class it
 * does not know (49, `CHAR_CREATE_FAILED`) and a Death Knight without a
 * level-55 character (59, `CHAR_CREATE_LEVEL_REQUIREMENT`).
 */
export const INVALID_START_FAILURE = /\binvalid_race\b|\binvalid_class\b|\binvalid_race_class\b|\bchar_create_failed_code_(?:48|49|59)\b/;
