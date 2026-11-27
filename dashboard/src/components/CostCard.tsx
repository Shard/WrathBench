/**
 * One cost card where there used to be two.
 *
 * A run has two cost figures because two different questions hide behind one
 * number: ACTUAL is what the provider charged (OpenRouter's per-call
 * `usage.cost`, or the Claude SDK's `total_cost_usd`), EXPECTED is this repo's
 * price table applied to the tokens, dated. Both stay on the card, but only one
 * is the headline: the actual where there is one, else the expected. The other
 * rides underneath as a short value, and the paragraph saying where each comes
 * from is behind the card's info hint (the operator's call: the page is for
 * skimming). Three things never move behind the hint, because
 * without them the number reads as something it is not: the `*` a backfilled
 * actual wears (`CostFigure.backfill`), "as-if-metered" on a figure nobody was
 * billed, and the month of the price row an expected figure was taken at.
 */

import type { CharacterCost, CostView } from "@viewer/api-types";
import { backfilledTitle, costMark, expectedLine, fmtUsd } from "../lib/format";
import { InfoHint } from "./InfoHint";

type Figure = CostView["actual"];

const priced = (c: Figure | undefined): c is Figure & { usd: number } =>
  c !== undefined && c.basis !== "none" && c.usd !== null;

/** "2026-10", or "undated": the price row's month, so a stale rate reads as stale. */
const month = (c: Figure): string => (c.asOf === null ? "undated" : c.asOf.slice(0, 7));

interface CostReading {
  /** The headline figure. */
  value: string;
  /** Its own hover: the headline figure's note. */
  title: string;
  /** One short line: which figure the headline is, and the other one. */
  sub: string;
  /** Behind the info hint: both figures' notes. */
  hint: string;
}

/** The card's reading of a run's `cost`, or of none yet (a detail still loading). */
export function runCostReading(cost: CostView | undefined): CostReading {
  const a = cost?.actual;
  const e = cost?.expected;
  const expectedShort = priced(e) ? `${fmtUsd(e.usd)} (${month(e)})` : "unpriced";
  const hint = [a === undefined ? null : `actual: ${a.note}`, e === undefined ? null : `expected: ${e.note}`]
    .filter((s): s is string => s !== null && s !== "")
    .join("\n\n");
  if (priced(a)) {
    return {
      value: `${fmtUsd(a.usd)}${costMark(a)}`,
      title: a.note,
      sub: `${a.asIfMetered ? "actual, as-if-metered" : "actual"} · expected ${expectedShort}`,
      hint,
    };
  }
  if (priced(e)) {
    return {
      value: fmtUsd(e.usd),
      title: e.note,
      // The same line a listing's hover gives an estimate (`listCost`).
      sub: expectedLine(e),
      hint,
    };
  }
  return { value: "—", title: e?.note ?? a?.note ?? "", sub: "unpriced · no actual", hint };
}

/** The same card over a character's summed costs (`CharacterCost`). */
export function characterCostReading(c: CharacterCost): CostReading {
  const coverage = (n: number): string => `${n} of ${c.attempts} attempt${c.attempts === 1 ? "" : "s"}`;
  const hint = [
    c.actualAttempts > 0
      ? `actual: the provider's own charge, summed over the ${coverage(c.actualAttempts)} that report one${c.asIfMetered ? "; as-if-metered: a subscription was billed, not this" : ""}`
      : "actual: no attempt reports a provider charge",
    c.expectedAttempts > 0
      ? `expected: list prices applied to the tokens of ${coverage(c.expectedAttempts)}`
      : "expected: no attempt could be priced",
    backfilledTitle(c.actualBackfilled),
  ]
    .filter((s) => s !== "")
    .join("\n\n");
  const expectedShort = c.expectedUsd === null ? "unpriced" : fmtUsd(c.expectedUsd);
  if (c.actualAttempts > 0 && c.actualUsd !== null) {
    return {
      value: `${fmtUsd(c.actualUsd)}${(c.actualBackfilled ?? 0) > 0 ? "*" : ""}`,
      title: backfilledTitle(c.actualBackfilled),
      // Coverage as "1/2" so the line fits a card one line wide; the hint spells it out.
      sub: `${c.asIfMetered ? "as-if-metered" : "actual"} ${c.actualAttempts}/${c.attempts} · expected ${expectedShort}`,
      hint,
    };
  }
  if (c.expectedUsd !== null) {
    return { value: fmtUsd(c.expectedUsd), title: "", sub: `expected ${c.expectedAttempts}/${c.attempts} · no actual`, hint };
  }
  return { value: "—", title: "", sub: "unpriced · no actual", hint };
}

/** The card itself: a `.card` like every other, the hint beside its label. */
export function CostCard(props: { reading: CostReading }) {
  return (
    <div class="card">
      <div class="k">
        cost
        <InfoHint label="where the cost comes from" text={props.reading.hint} />
      </div>
      <div class="v mono" title={props.reading.title}>
        {props.reading.value}
      </div>
      <div class="sub">{props.reading.sub}</div>
    </div>
  );
}
