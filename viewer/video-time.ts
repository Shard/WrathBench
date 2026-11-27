/**
 * A run's video timeline (`camera/clips.json` version 2, docs/PUBLIC-DASHBOARD.md,
 * "Camera replays"), as pure arithmetic shared by the viewer, the publisher
 * and the pages: the run page's player, the home page's excerpt and the map
 * replay's sync all convert with these and nothing else.
 *
 * The timeline is the parts back to back: a time `v` in seconds on it falls in
 * one part at an offset into that part's file. The time map is
 * `[videoSeconds, runTimeMs]` keypoints, run time linear in video time between
 * two; before the first and after the last it holds the end value.
 */

import type { CaptionCueView, ChapterType, ChapterView } from "./api-types";
import { isChapter } from "./timeline-marks";
import { isRecord } from "../runner/src/values";

/**
 * Every kind a `clips.json` has ever listed, which is what a body is checked
 * against. What a reader is handed is narrower (`fitTimeline`): only the
 * kinds that are chapters, a level and a boss kill (`timeline-marks.ts`).
 */
export const CHAPTER_TYPES: readonly ChapterType[] = ["level", "quest", "death", "zone", "boss"];

export const finiteAtLeast0 = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;

/** As much of a part as the timeline needs. */
export interface TimelinePart {
  seconds: number;
}

export type TimemapPoint = readonly [number, number];

/** Where each part starts on the whole timeline. */
export function partStarts(parts: readonly TimelinePart[]): number[] {
  const out: number[] = [];
  let at = 0;
  for (const p of parts) {
    out.push(at);
    at += p.seconds;
  }
  return out;
}

export function totalSeconds(parts: readonly TimelinePart[]): number {
  return parts.reduce((n, p) => n + p.seconds, 0);
}

/**
 * The part a timeline time falls in, and the offset into its file. Clamped to
 * the timeline; a time on a boundary is the start of the later part. Null
 * with no parts.
 */
export function partAt(parts: readonly TimelinePart[], v: number): { index: number; offset: number } | null {
  if (parts.length === 0) return null;
  const starts = partStarts(parts);
  const t = Math.max(0, Math.min(Number.isFinite(v) ? v : 0, totalSeconds(parts)));
  for (let i = parts.length - 1; i >= 0; i--) {
    if (t >= starts[i]! && (t < starts[i]! + parts[i]!.seconds || i === parts.length - 1)) return { index: i, offset: Math.min(t - starts[i]!, parts[i]!.seconds) };
  }
  return { index: 0, offset: 0 };
}

/** A part's offset back on the whole timeline. */
export function timelineAt(parts: readonly TimelinePart[], index: number, offset: number): number {
  const starts = partStarts(parts);
  return (starts[Math.max(0, Math.min(index, parts.length - 1))] ?? 0) + offset;
}

/** The run time shown at timeline time `v`, or null with no map. */
export function videoToRun(map: readonly TimemapPoint[], v: number): number | null {
  if (map.length === 0) return null;
  if (v <= map[0]![0]) return map[0]![1];
  for (let i = 1; i < map.length; i++) {
    const [vb, rb] = map[i]!;
    if (v < vb) {
      const [va, ra] = map[i - 1]!;
      return vb === va ? ra : ra + ((v - va) * (rb - ra)) / (vb - va);
    }
  }
  return map.at(-1)![1];
}

/**
 * The timeline time that shows run time `ms`: on a stretch where run time
 * stands still (an event held), its start, so the frame shown is the one at
 * or before `ms`. Null with no map.
 */
export function runToVideo(map: readonly TimemapPoint[], ms: number): number | null {
  if (map.length === 0) return null;
  if (ms <= map[0]![1]) return map[0]![0];
  for (let i = 1; i < map.length; i++) {
    const [vb, rb] = map[i]!;
    if (ms < rb) {
      const [va, ra] = map[i - 1]!;
      return rb === ra ? va : va + ((ms - ra) * (vb - va)) / (rb - ra);
    }
    if (ms === rb) {
      // The first point at this run time: the start of a hold.
      return vb;
    }
  }
  return map.at(-1)![0];
}

/** The index of the last entry at or before `v` in a list sorted by `t`, or -1. */
export function lastAtOrBefore(list: readonly { t: number }[], v: number): number {
  let lo = 0;
  let hi = list.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid]!.t <= v) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found;
}

/** The caption up at `v`: the last cue at or before it, or "". */
export function captionAt(captions: readonly { t: number; text: string }[], v: number): string {
  const i = lastAtOrBefore(captions, v);
  return i < 0 ? "" : captions[i]!.text;
}

/** An excerpt's reach around a chapter: a little before it, and its moment after. */
export const EXCERPT_LEAD_S = 1;
export const EXCERPT_TAIL_S = 6;

/**
 * The home page's excerpt around a chapter at timeline time `t`: the part it
 * is in, and the window as offsets into that part's file, clamped to it.
 */
export function excerptAround(parts: readonly TimelinePart[], t: number): { index: number; from: number; to: number } | null {
  const at = partAt(parts, t);
  if (at === null) return null;
  const len = parts[at.index]!.seconds;
  const from = Math.max(0, at.offset - EXCERPT_LEAD_S);
  const to = Math.min(len, at.offset + EXCERPT_TAIL_S);
  return { index: at.index, from: round3(from), to: round3(to) };
}

const round3 = (n: number): number => Math.round(n * 1000) / 1000;

/**
 * The chapters, captions and time map that fall on a timeline of `parts`,
 * each checked: anything past its end or naming a part it does not have is
 * dropped, and so is a time-map point that would run backwards.
 */
export function fitTimeline(
  parts: readonly { seconds: number }[],
  raw: { chapters: unknown; captions: unknown; timemap: unknown },
): { chapters: ChapterView[]; captions: CaptionCueView[]; timemap: [number, number][] } {
  const total = totalSeconds(parts);
  const chapters: ChapterView[] = [];
  for (const c of Array.isArray(raw.chapters) ? raw.chapters : []) {
    if (!isRecord(c) || !finiteAtLeast0(c["t"]) || c["t"] > total) continue;
    const part = c["part"];
    if (typeof part !== "number" || !Number.isInteger(part) || part < 0 || part >= parts.length) continue;
    // A video cut before 2026-11-16 lists its turn-ins, zones and deaths: it still plays, and they are not chapters.
    if (!CHAPTER_TYPES.includes(c["type"] as ChapterType) || !isChapter(c["type"] as string)) continue;
    chapters.push({
      t: c["t"],
      part,
      type: c["type"] as ChapterType,
      detail: typeof c["detail"] === "string" ? c["detail"] : "",
      caption: typeof c["caption"] === "string" ? c["caption"] : "",
    });
  }
  const captions: CaptionCueView[] = [];
  for (const c of Array.isArray(raw.captions) ? raw.captions : []) {
    if (!isRecord(c) || !finiteAtLeast0(c["t"]) || c["t"] > total || typeof c["text"] !== "string") continue;
    captions.push({ t: c["t"], text: c["text"] });
  }
  const timemap: [number, number][] = [];
  for (const p of Array.isArray(raw.timemap) ? raw.timemap : []) {
    if (!Array.isArray(p) || p.length !== 2 || !finiteAtLeast0(p[0]) || p[0] > total || typeof p[1] !== "number" || !Number.isFinite(p[1])) continue;
    const prev = timemap.at(-1);
    if (prev !== undefined && (p[0] <= prev[0] || p[1] < prev[1])) continue;
    timemap.push([p[0], p[1]]);
  }
  chapters.sort((a, b) => a.t - b.t);
  captions.sort((a, b) => a.t - b.t);
  return { chapters, captions, timemap };
}
