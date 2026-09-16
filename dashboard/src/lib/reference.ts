/**
 * The two reference lines the ladder draws behind its level readings.
 *
 * A level on the ladder is otherwise legible only against other models' level
 * readings: nothing on the page says what a good ninety minutes in this world
 * *is*. The operator's direction (2026-09-16) was that neither line is a
 * scripted baseline — no greedy XP grinder and no deterministic walkthrough is
 * built or run. One line is derived from runs that already exist, the other is
 * a committed constant with its sources written down beside it.
 *
 * Neither is a score and neither enters an ordering. They are drawn where
 * levels are read and nowhere else — not on the cost × xp scatter, whose y is
 * xp and never level (a `cost × level` view was offered and withdrawn,
 * `lib/axes.ts`), and not on the freeplay stream chart, which plots a durable
 * character across attempts and is a different claim than a scored episode.
 */

import type { ResultRun } from "@viewer/api-types";

/* ------------------------------------------------------- empirical ceiling */

/**
 * The best level any scored run of the current series actually reached on a
 * tier, with the run that reached it and how many runs tied it.
 *
 * Never hardcoded: it is a maximum over the runs on hand, so it moves when a
 * run beats it and the label says which series it is a maximum over. The
 * caller passes the *series-filtered scored* set, before the reader's own
 * race, class, harness and "exclude free" filters — a ceiling that moved when
 * someone ticked a checkbox would make its own label false.
 *
 * A run with no level reading is not recorded, not zero (METHODOLOGY,
 * "Scoring"), so it neither sets nor lowers the ceiling.
 */
export interface EmpiricalCeiling {
  /** The highest level observed. */
  level: number;
  /** The run that observed it; when several tied, the first in the list. */
  runId: string;
  /** How many runs reached `level`. */
  at: number;
  /** How many runs carried a level reading at all. */
  of: number;
  /** The next distinct level below the ceiling — the practical cluster, when one exists. */
  next: number | null;
  /** How many runs reached `next`. */
  nextAt: number;
}

export function empiricalCeiling(runs: readonly ResultRun[]): EmpiricalCeiling | null {
  const withLevel = runs.filter((r) => r.maxLevel !== null);
  if (withLevel.length === 0) return null;
  let top: ResultRun | null = null;
  for (const r of withLevel) if (top === null || r.maxLevel! > top.maxLevel!) top = r;
  const level = top!.maxLevel!;
  const below = withLevel.map((r) => r.maxLevel!).filter((l) => l < level);
  const next = below.length > 0 ? Math.max(...below) : null;
  return {
    level,
    runId: top!.runId,
    at: withLevel.filter((r) => r.maxLevel === level).length,
    of: withLevel.length,
    next,
    nextAt: next === null ? 0 : withLevel.filter((r) => r.maxLevel === next).length,
  };
}

/** The line's label: what it is a maximum over, named so it cannot be misread as a target. */
export function ceilingLabel(episode: string, series: string | null): string {
  return `best observed ${episode}, harness ${series ?? "—"}`;
}

/* ------------------------------------------------------ human speedrun band */

/** One figure the band rests on, with where it came from and what it is not. */
export interface BandSource {
  what: string;
  url: string;
  note: string;
}

/**
 * Roughly where a practised human is at ninety minutes from a fresh character:
 * **level 10–11**.
 *
 * A band and not a point, because the two records it is bracketed by are not
 * the same game. Classic Era runs vanilla XP rates, which are slower than
 * 3.3.5a's; Cataclysm Classic runs the post-Cataclysm 1–60 revamp, which is
 * faster. Wrath's own rates sit between them, and the WotLK Classic board was
 * folded into the Cataclysm Classic one, so there is no board to read them off
 * directly.
 *
 * **Loosely sourced, and labelled that way on the page.** speedrun.com's run
 * pages answer 403 to a fetcher, so the two times below came from search
 * snippets rather than from the run pages themselves and have not been
 * confirmed in a browser. Interpolating 1–10 records into a 90-minute level is
 * a judgement, not an arithmetic: a speedrun is a pre-planned route with death
 * warps, a class picked for its early tier and a runner who has done it
 * hundreds of times, so the band is an upper bound on what the ninety minutes
 * can contain and not a par score. Nothing on the ladder is ranked against it.
 */
export interface SpeedrunBand {
  /** The band's floor and ceiling in levels, inclusive. */
  low: number;
  high: number;
  /** The minutes the band is stated at — the e90 budget. */
  minutes: number;
  label: string;
  sources: readonly BandSource[];
}

export const HUMAN_SPEEDRUN_BAND: SpeedrunBand = {
  low: 10,
  high: 11,
  minutes: 90,
  label: "human speedrun band, loosely sourced",
  sources: [
    {
      what: "Classic Era Level 1–10, ~1:16:46 (Tommysalami)",
      url: "https://www.speedrun.com/wowclassicera",
      note: "vanilla XP rates, slower than 3.3.5a — the slow edge of the band",
    },
    {
      what: "Cataclysm Classic Level 1–10, ~39:03 (Dedreama)",
      url: "https://www.speedrun.com/wowcata",
      note:
        "post-Cataclysm 1–60 revamp, faster than 3.3.5a — the fast edge; the WotLK Classic board was folded into this one",
    },
    {
      what: "What a speedrun actually is",
      url: "https://www.warcrafttavern.com/wow-classic/guides/speedrunning",
      note: "pre-planned routes, death warps, a class picked for its early tier — not a first attempt",
    },
  ],
};

/* ------------------------------------------------------------------ drawing */

/** One reference mark on a level scale: a band (`low < high`) or a line (`low === high`). */
export interface ReferenceMark {
  id: "ceiling" | "speedrun";
  low: number;
  high: number;
  label: string;
  /** The provenance sentence, for the hover and the footnote. */
  provenance: string;
}

/**
 * The marks to draw for one tier, and the level range wide enough to hold them
 * plus whatever the ladder itself reached.
 *
 * The speedrun band is stated at ninety minutes, so it is offered on `e90`
 * alone; quoting it beside a six-hour tier would compare two different
 * budgets. The ceiling is a maximum over whatever tier is in view and names
 * that tier in its label, so it travels everywhere.
 */
export interface ReferenceScale {
  marks: readonly ReferenceMark[];
  /** The scale's ends: level 1 through the highest thing drawn, with a little air. */
  min: number;
  max: number;
}

export function referenceScale(opts: {
  episode: string;
  series: string | null;
  ceiling: EmpiricalCeiling | null;
  /** The highest level any row on screen reached, so the scale never cuts one off. */
  reached: number | null;
}): ReferenceScale | null {
  const marks: ReferenceMark[] = [];
  if (opts.ceiling !== null) {
    const c = opts.ceiling;
    marks.push({
      id: "ceiling",
      low: c.level,
      high: c.level,
      label: ceilingLabel(opts.episode, opts.series),
      provenance:
        `Derived, not fixed: the highest level any scored ${opts.episode} run of harness ${opts.series ?? "—"} ` +
        `reached — L${c.level}, by ${c.at === 1 ? "one run" : `${c.at} runs`} of ${c.of} carrying a level reading` +
        (c.next === null
          ? ""
          : `; the next best is L${c.next} (${c.nextAt === 1 ? "one run" : `${c.nextAt} runs`})`) +
        ".",
    });
  }
  const band = HUMAN_SPEEDRUN_BAND;
  if (opts.episode === "e90") {
    marks.push({
      id: "speedrun",
      low: band.low,
      high: band.high,
      label: band.label,
      provenance:
        `Roughly L${band.low}–${band.high} by ${band.minutes} minutes, bracketed between a Classic Era 1–10 ` +
        `record (~1:16:46, slower rates) and a Cataclysm Classic one (~39:03, faster rates); ` +
        `WotLK Classic has no board of its own. Read off search snippets, not confirmed in a browser — ` +
        `sources in dashboard/src/lib/reference.ts.`,
    });
  }
  if (marks.length === 0) return null;
  const highest = Math.max(...marks.map((m) => m.high), opts.reached ?? 1);
  return { marks, min: 1, max: Math.max(highest + 1, 2) };
}
