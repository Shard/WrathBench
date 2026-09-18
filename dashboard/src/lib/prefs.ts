/**
 * A single remembered boolean, in `localStorage`, under a caller-chosen key.
 *
 * Blocked storage (private mode, a browser configured to refuse) is not an
 * error here: the caller's toggle still works for the life of the page, it
 * just starts from `fallback` again next visit.
 */

export function readBoolPref(key: string, fallback: boolean): boolean {
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : v === "1";
  } catch {
    return fallback;
  }
}

export function writeBoolPref(key: string, value: boolean): void {
  try {
    localStorage.setItem(key, value ? "1" : "0");
  } catch {
    /* see readBoolPref: not persisting is the only consequence */
  }
}

/**
 * The same, for a small remembered *choice* — a select's value, where `null`
 * is the control's default ("all"). Stored as the string itself; an empty
 * string is not a choice, so it reads back as `null` too. What a stored value
 * means once the data has moved on is the caller's problem, and the rule every
 * caller follows is that a stored value the current data cannot honour resolves
 * to the control's default, so remembering one can never empty a table for no
 * visible reason.
 */

export function readChoicePref(key: string, fallback: string | null = null): string | null {
  try {
    const v = localStorage.getItem(key);
    return v === null || v === "" ? fallback : v;
  } catch {
    return fallback;
  }
}

export function writeChoicePref(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    /* see readBoolPref: not persisting is the only consequence */
  }
}
