/**
 * The two guards every reader of a parsed record spells, written once.
 *
 * `num` is the finite reading: `NaN` and the infinities are no number. A few
 * readers keep their own on purpose because they mean something else — any
 * `number` (`run-list.ts`, `positions.ts`), a non-negative one, or `undefined`
 * for absent — and are not this.
 */

/** A plain object: not null, not an array. */
export function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** A finite number, or null. */
export function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}
