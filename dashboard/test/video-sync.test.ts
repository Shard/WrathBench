/**
 * The run video's timeline (`@viewer/video-time`) and its sync with the map
 * replay (`lib/video-sync.ts`), as pure functions: a time on the whole
 * timeline lands in the right part at the right offset, the time map converts
 * both ways (a held event and a long pause included), and neither clock
 * chases the other's echo. Every number here is invented.
 */

import { describe, expect, test } from "bun:test";
import { partAt, partStarts, runToVideo, timelineAt, totalSeconds, videoToRun } from "@viewer/video-time";
import { cursorFor, videoSeekFor } from "../src/lib/video-sync";

const T0 = Date.parse("2026-11-15T10:00:00.000Z");
const H = 3_600_000;
/** Two parts: 270 s, then 90 s. */
const PARTS = [{ seconds: 270 }, { seconds: 90 }];
/**
 * Six hours at 80 s of play a second of video, an event held a second at
 * 100 s, then a pause of two days before the second part.
 */
const MAP: [number, number][] = [
  [0, T0],
  [100, T0 + 100 * 80_000],
  [101, T0 + 100 * 80_000],
  [270, T0 + 6 * H],
  [270.125, T0 + 54 * H],
  [360, T0 + 56 * H],
];

describe("the timeline over parts", () => {
  test("a time lands in its part at the offset into that part's file, and back", () => {
    expect(partStarts(PARTS)).toEqual([0, 270]);
    expect(totalSeconds(PARTS)).toBe(360);
    expect(partAt(PARTS, 0)).toEqual({ index: 0, offset: 0 });
    expect(partAt(PARTS, 269.5)).toEqual({ index: 0, offset: 269.5 });
    // A boundary is the start of the later part.
    expect(partAt(PARTS, 270)).toEqual({ index: 1, offset: 0 });
    expect(partAt(PARTS, 300)).toEqual({ index: 1, offset: 30 });
    // Clamped to the timeline.
    expect(partAt(PARTS, -5)).toEqual({ index: 0, offset: 0 });
    expect(partAt(PARTS, 999)).toEqual({ index: 1, offset: 90 });
    expect(partAt([], 3)).toBeNull();
    for (const t of [0, 12.5, 269.875, 270, 333]) {
      const at = partAt(PARTS, t)!;
      expect(timelineAt(PARTS, at.index, at.offset)).toBe(t);
    }
  });
});

describe("the time map", () => {
  test("video to run time is linear between points and holds at the ends", () => {
    expect(videoToRun(MAP, 0)).toBe(T0);
    expect(videoToRun(MAP, 50)).toBe(T0 + 50 * 80_000);
    // The held event: run time stands still for its second of video.
    expect(videoToRun(MAP, 100.5)).toBe(T0 + 100 * 80_000);
    expect(videoToRun(MAP, -1)).toBe(T0);
    expect(videoToRun(MAP, 400)).toBe(T0 + 56 * H);
    expect(videoToRun([], 1)).toBeNull();
  });

  test("the two directions agree: run to video to run is the identity off a hold, and a pause maps to its edge", () => {
    for (const v of [0, 33.3, 99.9, 150, 269, 300, 359]) {
      const r = videoToRun(MAP, v)!;
      expect(runToVideo(MAP, r)).toBeCloseTo(v, 6);
    }
    // Inside the two-day pause: within the eighth of a second between its frames.
    const paused = runToVideo(MAP, T0 + 30 * H)!;
    expect(paused).toBeGreaterThanOrEqual(270);
    expect(paused).toBeLessThan(270.125);
  });
});

describe("the sync with the map", () => {
  test("no echo: the video's own value coming back from the map seeks nothing, in either direction", () => {
    // The video plays at 50.3 s: it sends the run time there.
    const sent = cursorFor(MAP, 50.3, { videoPlaying: true, ownSeek: false, lastSent: null })!;
    expect(sent).toBe(Math.round(T0 + 50.3 * 80_000));
    // The map's cursor is set to it and comes back as `follow`: not a seek, playing or paused.
    expect(videoSeekFor(MAP, sent, { current: 50.3, videoPlaying: true, lastSent: sent })).toBeNull();
    expect(videoSeekFor(MAP, sent, { current: 50.3, videoPlaying: false, lastSent: sent })).toBeNull();
    // The same time is not sent twice.
    expect(cursorFor(MAP, 50.3, { videoPlaying: true, ownSeek: false, lastSent: sent })).toBeNull();
    // A seek the map caused moves the paused video; its time updates send nothing back.
    expect(cursorFor(MAP, 199, { videoPlaying: false, ownSeek: false, lastSent: sent })).toBeNull();
    // The video's own controls do send.
    expect(cursorFor(MAP, 199, { videoPlaying: false, ownSeek: true, lastSent: sent })).toBe(Math.round(videoToRun(MAP, 199)!));
  });
});
