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
