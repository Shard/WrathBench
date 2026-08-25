/**
 * Shared maths for the dashboard's hand-drawn SVG charts (`LadderChart`,
 * `XpChart`): the linear value→pixel map and the "nice" tick step. Pulled out
 * once the same formulas started appearing in both charts and in
 * `lib/ladder.ts`'s own layout pass — one definition, so a chart's scale and
 * its gridlines can never drift apart. Pure and DOM-free, so it is testable
 * without a browser.
 */

/**
 * A linear map from a domain interval to a range interval — the value→pixel
 * conversion every axis needs. `domain[0]` need not be below `domain[1]`, and
 * neither need `range`: `LadderChart`'s y-axis runs top-to-bottom in SVG units
 * (`range[0] > range[1]`) while its x-axis runs left-to-right, and this one
 * function serves both. A zero-width domain (a single sample, or every point
 * at the same value) maps everything to `range[0]` rather than dividing by
 * zero.
 */
export function scaleLinear(domain: readonly [number, number], range: readonly [number, number]): (v: number) => number {
  const [d0, d1] = domain;
  const [r0, r1] = range;
  const span = d1 - d0 || 1;
  return (v: number) => r0 + ((v - d0) / span) * (r1 - r0);
}

/**
 * Linear ticks from zero: a 1/2/5 × 10^k step, chosen so there are about
 * `want` of them, with the axis top being the first tick at or past `max`.
 * A max of zero (every model free, a run with no xp yet) still gets an axis,
 * so the points have somewhere to sit rather than dividing by nothing.
 */
export function niceTicks(max: number, want = 5): number[] {
  const top = Math.max(max, 0);
  if (top === 0) return [0, 1];
  const rough = top / want;
  const pow = 10 ** Math.floor(Math.log10(rough));
  const step = [1, 2, 5, 10].map((m) => m * pow).find((s) => top / s <= want) ?? 10 * pow;
  const ticks: number[] = [];
  for (let v = 0; v < top + step / 2; v += step) ticks.push(Number(v.toPrecision(12)));
  if (ticks[ticks.length - 1]! < top) ticks.push(Number((ticks[ticks.length - 1]! + step).toPrecision(12)));
  return ticks;
}
