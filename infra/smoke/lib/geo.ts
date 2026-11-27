/**
 * Distances and positions as the smokes measure and print them. Nothing
 * else: the raw-HTTP smokes import this without the SDK.
 */

/** Yards on the ground plane; height is ignored. */
export const dist2d = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);

/** `(x, y, z)` to a tenth of a yard, or `(x, y)` for a point with no z. */
export const fmt = (p: { x: number; y: number; z?: number }) => `(${p.x.toFixed(1)}, ${p.y.toFixed(1)}${p.z === undefined ? "" : `, ${p.z.toFixed(1)}`})`;
