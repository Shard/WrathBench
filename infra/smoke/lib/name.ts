/**
 * A throwaway character name the server will actually accept.
 *
 * The old spelling — `Date.now().toString(26)` with digits mapped to letters —
 * collided with the game's own naming rules: whenever the timestamp's base-26
 * digits repeat, every name generated carries three identical consecutive
 * letters, which the core refuses as CHAR_NAME_THREE_CONSECUTIVE (create
 * result 98). The repeats sit in the HIGH digits, so the failure arrives in
 * multi-hour stretches, not as a rare flake: from ~19:00 on 2026-08-24 every
 * name began `Bqeee…`, and the full-arc deploy smoke rolled back the 0.5
 * worldserver deploy on it. Random letters, re-rolled while a triple exists.
 */
import { isValidCharacterName } from "../../../runner/src/character-name";

export function probeName(prefix: string): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz";
  for (;;) {
    const letters = Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => alphabet[b % 26]!).join("");
    const name = prefix + letters;
    // The shared game-rule predicate (runner/src/config.ts), so the reroll
    // condition can never drift from what the boundaries accept.
    if (isValidCharacterName(name)) return name;
  }
}

/**
 * The module probes' throwaway name: `Bench` and five random letters, as
 * module-accounts, module-reclaim, module-session-state and module-slice
 * have always spelled it. Unlike `probeName` it does not re-roll, so a draw
 * with three identical letters in a row is refused by the core; the probes
 * keep it as it was rather than change their names here.
 */
export function randomName(): string {
  const letters = "abcdefghijklmnopqrstuvwxyz";
  let s = "Bench";
  for (let i = 0; i < 5; i++) s += letters[Math.floor(Math.random() * letters.length)];
  return s;
}
