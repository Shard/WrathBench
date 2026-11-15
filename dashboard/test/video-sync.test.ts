/**
 * The run video's timeline (`@viewer/video-time`) and its sync with the map
 * replay (`lib/video-sync.ts`), as pure functions: a time on the whole
 * timeline lands in the right part at the right offset, the time map converts
 * both ways (a held event and a long pause included), and neither clock
 * chases the other's echo. Every number here is invented.
 */

import { describe, expect, test } from "bun:test";
import { captionAt, excerptAround, partAt, partStarts, runToVideo, timelineAt, totalSeconds, videoToRun } from "@viewer/video-time";
import { cursorFor, leader, videoSeekFor } from "../src/lib/video-sync";

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

  test("the caption up is the last cue at or before the playhead", () => {
    const cues = [
      { t: 0, text: "a" },
      { t: 10, text: "b" },
      { t: 280, text: "c" },
    ];
    expect(captionAt(cues, 9.9)).toBe("a");
    expect(captionAt(cues, 10)).toBe("b");
    expect(captionAt(cues, 300)).toBe("c");
    expect(captionAt([], 3)).toBe("");
  });

  test("an excerpt is clamped to the one part its chapter is in", () => {
    expect(excerptAround(PARTS, 100)).toEqual({ index: 0, from: 99, to: 106 });
    expect(excerptAround(PARTS, 268)).toEqual({ index: 0, from: 267, to: 270 });
    expect(excerptAround(PARTS, 270.5)).toEqual({ index: 1, from: 0, to: 6.5 });
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

  test("run time to video finds the frame at or before it: a hold's start, a pause's edge", () => {
    expect(runToVideo(MAP, T0 + 50 * 80_000)).toBe(50);
    expect(runToVideo(MAP, T0 + 100 * 80_000)).toBe(100);
    // Inside the two-day pause: within the eighth of a second between its frames.
    const paused = runToVideo(MAP, T0 + 30 * H)!;
    expect(paused).toBeGreaterThanOrEqual(270);
    expect(paused).toBeLessThan(270.125);
    expect(runToVideo(MAP, T0 - 1)).toBe(0);
    expect(runToVideo(MAP, T0 + 99 * H)).toBe(360);
  });

  test("the two directions agree: run to video to run is the identity off a hold", () => {
    for (const v of [0, 33.3, 99.9, 150, 269, 300, 359]) {
      const r = videoToRun(MAP, v)!;
      expect(runToVideo(MAP, r)).toBeCloseTo(v, 6);
    }
  });
});

describe("the sync with the map", () => {
  test("the video leads while it plays, the map otherwise", () => {
    expect(leader(true)).toBe("video");
    expect(leader(false)).toBe("map");
  });

  test("a map move seeks the paused video to the matching time, and nothing while it plays", () => {
    const cursor = videoToRun(MAP, 199)!;
    expect(videoSeekFor(MAP, cursor, { current: 10, videoPlaying: false, lastSent: null })).toBeCloseTo(199, 6);
    expect(videoSeekFor(MAP, cursor, { current: 10, videoPlaying: true, lastSent: null })).toBeNull();
    // Into the second part.
    expect(videoSeekFor(MAP, T0 + 55 * H, { current: 10, videoPlaying: false, lastSent: null })).toBeGreaterThan(270);
  });

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

  test("inside a held event the video already shows the cursor's moment: no seek back to the hold's start", () => {
    const held = T0 + 100 * 80_000;
    // Paused in the middle of the hold, with the map's cursor on the event's own run time.
    expect(videoSeekFor(MAP, held, { current: 100.6, videoPlaying: false, lastSent: null })).toBeNull();
    // A cursor a little off still finds the video showing it.
    expect(videoSeekFor(MAP, held + 300, { current: 100.6, videoPlaying: false, lastSent: null })).toBeNull();
    // Within two video frames of where it is: not worth a seek.
    expect(videoSeekFor(MAP, T0 + 50.1 * 80_000, { current: 50, videoPlaying: false, lastSent: null })).toBeNull();
  });

  test("a map playing seeks the video forward step by step, and the steps settle", () => {
    // The map's playhead ticks 250 ms at 600×: 150 s of play each tick.
    let current = 0;
    let seeks = 0;
    for (let cursor = T0; cursor < T0 + 2 * H; cursor += 150_000) {
      const t = videoSeekFor(MAP, cursor, { current, videoPlaying: false, lastSent: null });
      if (t !== null) {
        current = t;
        seeks++;
      }
      // Where the video stands always shows a moment at or near the cursor.
      expect(Math.abs(videoToRun(MAP, current)! - cursor)).toBeLessThanOrEqual(0.25 * 80_000 + 1);
    }
    expect(seeks).toBeGreaterThan(0);
    // Once at the cursor, the same cursor again is no seek.
    const last = T0 + 2 * H;
    const t = videoSeekFor(MAP, last, { current, videoPlaying: false, lastSent: null }) ?? current;
    expect(videoSeekFor(MAP, last, { current: t, videoPlaying: false, lastSent: null })).toBeNull();
  });
});
