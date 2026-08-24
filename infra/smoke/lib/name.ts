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
export function probeName(prefix: string): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz";
  for (;;) {
    const letters = Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => alphabet[b % 26]!).join("");
    const name = prefix + letters;
    if (!/(.)\1\1/i.test(name)) return name;
  }
}
