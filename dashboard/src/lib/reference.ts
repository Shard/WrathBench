/**
 * The two reference lines the ladder drew behind its level readings until
 * 2026-09-18.
 *
 * **Withdrawn from the page, kept in the repository** (operator, 2026-09-18):
 * the rail was complicated to read and one human speedrun entry per category
 * is not enough data to earn the space it took. Nothing here is deleted — the
 * figures, their provenance and the caveats that go with them are written
 * record, and the rail goes back on the page if and when there are several
 * runs to state a distribution from. What was removed is the drawing:
 * `ReferenceStrip` in `pages/Ladder.tsx` and its styles. The prose account is
 * in `docs/PUBLIC-DASHBOARD.md`, "The human reference".
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
 * `lib/axes.ts`), and not on the freeplay character chart, which plots a durable
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
  /** Absent when the operator confirmed the figure in a browser without giving a run URL. */
  url?: string;
  note: string;
}

/**
 * Roughly where a practised human is at the tier's budget from a fresh
 * character: **level 9–10 at ninety minutes**, **level 18–19 at six hours**.
 *
 * Both edges rest on the same board. speedrun.com does carry a Wrath-era
 * leveling board — the "Wrath of the Lich King Classic Archive" — and the
 * operator confirmed two entries on it in a browser on 2026-09-16: one 1–10
 * category entry, an Orc Hunter in 1:31, and one 1–20 entry in 7:02:39. Those
 * are the first 3.3.5a-rate figures the band has had; the Classic Era (vanilla
 * rates, slower) and Cataclysm Classic (post-Cataclysm 1–60 revamp, faster)
 * records stay as the bracket they always were.
 *
 * **Still thin, and labelled that way on the page.** One entry per category is
 * one entry: it fixes a pace, not a distribution, and turning a 1–10 or a 1–20
 * time into "a level at minute N" is a judgement rather than an arithmetic. A
 * speedrun is a pre-planned route with death warps, a class picked for its
 * early tier, and a runner who has done it hundreds of times — and the Hunter
 * those entries were set on is a top-tier leveling class, where WrathBench's
 * fixed character is a mid-tier Dwarf Paladin. So each band is an upper bound
 * on what its budget can contain, not a par score. Nothing on the ladder is
 * ranked against either.
 */
export interface SpeedrunBand {
  /** The band's floor and ceiling in levels, inclusive. */
  low: number;
  high: number;
  /** The minutes the band is stated at — the tier's budget. */
  minutes: number;
  /** The episode tier it is stated for. */
  episode: string;
  label: string;
  /** The sentence the hover and the footnote repeat. */
  provenance: string;
  sources: readonly BandSource[];
}

/** What a speedrun is, cited by every band: the caveat that makes it an upper bound. */
const WHAT_A_SPEEDRUN_IS: BandSource = {
  what: "What a speedrun actually is",
  url: "https://www.warcrafttavern.com/wow-classic/guides/speedrunning",
  note:
    "pre-planned routes, death warps, and a class picked for its early tier — the entries are Hunter runs, " +
    "where WrathBench's fixed character is a mid-tier Dwarf Paladin — so this is an upper bound, not a first attempt",
};

/**
 * The band per tier. A band is quoted only where its budget is the tier's
 * budget: quoting ninety minutes beside a six-hour tier would compare two
 * different things, which is why this is a map and not a constant.
 */
export const HUMAN_SPEEDRUN_BANDS: Readonly<Record<string, SpeedrunBand>> = {
  e90: {
    low: 9,
    high: 10,
    minutes: 90,
    episode: "e90",
    label: "human speedrun band, one Wrath entry, bracketed by Classic Era and Cataclysm Classic",
    provenance:
      "Roughly L9–10 by 90 minutes. The floor is the one Wrath-rate figure there is: the single 1–10 entry " +
      "on speedrun.com's Wrath of the Lich King Classic Archive board reaches 10 at 1:31, so at minute 90 that " +
      "runner is at the top of level 9. The ceiling is inference, not data — Cataclysm Classic's faster-rate " +
      "1–10 record (~39:03) is where a little more room comes from, with Classic Era's slower-rate ~1:16:46 on " +
      "the other side. One confirmed entry is thin, and it is a Hunter route with death warps against " +
      "WrathBench's Dwarf Paladin: an upper bound, not a par score.",
    sources: [
      {
        what: "Wrath Level 1–10, 1:31 (Orc Hunter)",
        url: "https://www.speedrun.com/World_of_Warcraft_Wrath_of_the_Lich_King_Classic_Archive/runs/z0dr63jy",
        note:
          "speedrun.com Wrath leveling board, single 1–10 entry, Orc Hunter, 1:31, confirmed by the operator " +
          "2026-09-16 — the only 3.3.5a-rate figure the band has, and it sets the floor",
      },
      {
        what: "Classic Era Level 1–10, ~1:16:46 (Tommysalami)",
        url: "https://www.speedrun.com/wowclassicera",
        note: "vanilla XP rates, slower than 3.3.5a — context on the slow side",
      },
      {
        what: "Cataclysm Classic Level 1–10, ~39:03 (Dedreama)",
        url: "https://www.speedrun.com/wowcata",
        note: "post-Cataclysm 1–60 revamp, faster than 3.3.5a — context on the fast side, and where the band's ceiling comes from",
      },
      WHAT_A_SPEEDRUN_IS,
    ],
  },
  e360: {
    low: 18,
    high: 19,
    minutes: 360,
    episode: "e360",
    label: "human speedrun band, interpolated from one Wrath 1–20 entry",
    provenance:
      "Roughly L18–19 by 360 minutes, interpolated from the one Wrath-rate 1–20 entry on the same board: " +
      "level 20 at 7:02:39, which is 422 minutes, so six hours lands short of 20. It is a band and not a point " +
      "because a 1–20 run is not linear in level — each level costs more than the last — so where exactly minute " +
      "360 falls is a judgement about the shape of that curve, not a division. One entry, a Hunter route, " +
      "against WrathBench's Dwarf Paladin: an upper bound, not a par score.",
    sources: [
      {
        what: "Wrath Level 1–20, 7:02:39",
        note:
          "speedrun.com Wrath of the Lich King Classic Archive board, single 1–20 entry, confirmed by the " +
          "operator 2026-09-16; no run URL was given, so the board and that confirmation are the citation",
      },
      WHAT_A_SPEEDRUN_IS,
    ],
  },
};

/** The band stated at this tier's budget, or nothing when no figure covers it. */
export function speedrunBand(episode: string): SpeedrunBand | null {
  return HUMAN_SPEEDRUN_BANDS[episode] ?? null;
}

/** The ninety-minute band, kept named because e90 is the tier most of the site is about. */
export const HUMAN_SPEEDRUN_BAND: SpeedrunBand = HUMAN_SPEEDRUN_BANDS.e90!;

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
 * A speedrun band is stated at one tier's budget, so each is offered on that
 * tier alone (`speedrunBand`): quoting ninety minutes beside a six-hour tier
 * would compare two different things. The ceiling is a maximum over whatever
 * tier is in view and names that tier in its label, so it travels everywhere.
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
  const band = speedrunBand(opts.episode);
  if (band !== null) {
    marks.push({
      id: "speedrun",
      low: band.low,
      high: band.high,
      label: band.label,
      provenance: `${band.provenance} Sources in dashboard/src/lib/reference.ts.`,
    });
  }
  if (marks.length === 0) return null;
  const highest = Math.max(...marks.map((m) => m.high), opts.reached ?? 1);
  return { marks, min: 1, max: Math.max(highest + 1, 2) };
}
