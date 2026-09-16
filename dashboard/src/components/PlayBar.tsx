/**
 * The map's one control strip, bottom centre of the stage, in both modes.
 *
 * On `/map` it is a live pill with the character count and, with a pip
 * selected, the way into that run's replay. On `/map?run=<id>` it is the
 * transport — step, play/pause, step, the clock, the scrubber, the speed — with
 * the run's identity above and the live link on the right; between the two it
 * says the replay is loading. Live→replay→live is this one element saying
 * something different, so the way back is always where it was.
 *
 * It is a component rather than a block of `MapPage` for one reason: the route
 * swap has to be renderable in a test. The swap that used to freeze the page
 * (worklogs/2026-09-05) was a JSX expression reading `track()!.points` on its
 * own, which re-ran after the track was cleared and threw inside the graph — an
 * uncaught throw in a computation stops every computation after it, and the
 * page sat on the dead replay until a reload. The rule here is that no
 * expression narrows a signal by assertion: every read of the track, the
 * selection or the route goes through a `Show` accessor or a default, and
 * `test/playbar-swap.test.tsx` performs the swap against a DOM to hold it.
 *
 * The live link is an anchor rather than a button with a handler: the swap is
 * owned by the page's route effect, so the control needs no logic of its own,
 * and an anchor keeps what an anchor gives — a real history entry, middle-click
 * and the focus ring.
 *
 * The attempt steps (item 119) are anchors for the same reason, and for one
 * more: a freeplay character is one character across attempts, so following it
 * end to end used to mean going back to the run page for the next id. They
 * link `/map?run=<id>` and nothing else — the route effect swaps the track and
 * `cursormemory` resumes the attempt where it was last left, so stepping away
 * and back keeps each attempt's own place. They render only where the track
 * carries a `character`: a scored run has none, and so does a track served or
 * published before the field existed.
 */

import { A } from "@solidjs/router";
import { Show, createMemo } from "solid-js";
import type { AgentPosition, TrackResponse } from "../api/client";
import { shortRunId, stamp } from "../lib/format";
import { replayHref, replayHrefFor } from "../lib/mapstate";
import { colorOf, pipName } from "../lib/mapview";
import { type Speed, playbackClock, prevSampleBefore, progressOf } from "../lib/playback";
import { nextSampleAfter, trackSpan } from "../lib/replay";

export interface PlayBarProps {
  /** The route's run id; undefined is the live map. */
  replayId: string | undefined;
  /** The loaded track, once it has landed. */
  track: TrackResponse | undefined;
  /** Why the track did not land, already rendered for display. */
  replayError: string | undefined;
  /** The live poll's failure, already rendered for display. */
  feedError: string | undefined;
  cursor: number;
  playing: boolean;
  speed: Speed;
  /** Live: how many characters the feed shows, and how many the series hid. */
  count: number;
  seriesHidden: number;
  liveSeries: string | null;
  /** Live: the reading whose pip was clicked, for the way into its replay. */
  selected: AgentPosition | null;
  /** A scrub: the page pauses and moves the cursor. */
  onSeek: (ts: number) => void;
  onTogglePlay: () => void;
  onStepBack: () => void;
  onStepForward: () => void;
  onCycleSpeed: () => void;
}

export function PlayBar(props: PlayBarProps) {
  const span = createMemo(() => (props.track === undefined ? null : trackSpan(props.track.points)));
  /** A replay is scrubbable only where its samples span some time. */
  const scrubbable = (): boolean => {
    const sp = span();
    return sp !== null && sp.to > sp.from;
  };
  const clock = createMemo(() => playbackClock(span(), props.cursor));

  return (
    <div class="playbar" classList={{ replay: props.replayId !== undefined }}>
      <Show
        when={props.replayId !== undefined}
        fallback={
          <div class="playbar-row">
            <span class="live-pill">
              <span class="live-dot" />
              live
            </span>
            <span class="playbar-text">
              <Show
                when={props.feedError === undefined}
                fallback={<span class="err">{props.feedError}</span>}
              >
                {props.count} {props.count === 1 ? "character" : "characters"}
                <Show when={props.seriesHidden > 0}>
                  {" "}
                  · {props.seriesHidden} hidden by series {props.liveSeries}
                </Show>
              </Show>
            </span>
            <span class="grow" />
            <Show when={props.selected}>
              {(p) => (
                <Show when={replayHrefFor(props.track, p())}>
                  {(href) => (
                    <A class="playbar-btn" href={href()} title="replay this run's recorded track">
                      replay {pipName(p())} →
                    </A>
                  )}
                </Show>
              )}
            </Show>
          </div>
        }
      >
        <div class="playbar-row">
          <Show
            when={props.track}
            fallback={
              <span class="playbar-text">
                <Show
                  when={props.replayError === undefined}
                  fallback={<span class="err">{props.replayError}</span>}
                >
                  <span class="dim">loading replay of {shortRunId(props.replayId ?? "")}…</span>
                </Show>
              </span>
            }
          >
            {(t) => (
              <>
                <span class="swatch" style={{ background: colorOf(t().runId) }} />
                <span class="playbar-title" title={t().runId}>
                  {t().characterName ?? shortRunId(t().runId)}
                </span>
                <span class="dim mono">{shortRunId(t().runId)}</span>
                <span class="dim">
                  · {t().points.length} {t().points.length === 1 ? "position" : "positions"}
                </span>
                <Show when={t().character}>
                  {(s) => (
                    <span class="attempt-steps">
                      <Show when={s().previous}>
                        {(id) => (
                          <A
                            class="playbar-btn step"
                            href={replayHref(id())}
                            title="replay the previous attempt of this character"
                            aria-label="previous attempt"
                          >
                            ‹
                          </A>
                        )}
                      </Show>
                      <span class="dim">
                        attempt {s().attempt} of {s().attempts}
                      </span>
                      <Show when={s().next}>
                        {(id) => (
                          <A
                            class="playbar-btn step"
                            href={replayHref(id())}
                            title="replay the next attempt of this character"
                            aria-label="next attempt"
                          >
                            ›
                          </A>
                        )}
                      </Show>
                    </span>
                  )}
                </Show>
                <span class="grow" />
                <Show when={t().points.length > 0}>
                  <span class="dim mono playbar-stamp" title="the cursor's wall-clock time">
                    {stamp(props.cursor)}
                  </span>
                </Show>
              </>
            )}
          </Show>
          <A class="playbar-btn live-link" href="/map" title="back to the live map">
            <span class="live-dot" />
            live
          </A>
        </div>
        <Show when={props.track}>
          {(t) => (
            <div class="playbar-row transport">
              <Show when={t().points.length > 0} fallback={<span class="dim">no recorded positions</span>}>
                <button
                  class="tbtn"
                  title="previous sample (←)"
                  aria-label="previous sample"
                  disabled={!scrubbable() || prevSampleBefore(t().points, props.cursor) === undefined}
                  onClick={() => props.onStepBack()}
                >
                  <svg viewBox="0 0 16 16" aria-hidden="true">
                    <path d="M3 3h2v10H3zM13 3v10L6 8z" />
                  </svg>
                </button>
                <button
                  class="tbtn play"
                  title={props.playing ? "pause (space)" : "play (space)"}
                  aria-label={props.playing ? "pause" : "play"}
                  disabled={!scrubbable()}
                  onClick={() => props.onTogglePlay()}
                >
                  <Show
                    when={props.playing}
                    fallback={
                      <svg viewBox="0 0 16 16" aria-hidden="true">
                        <path d="M4 2.5v11L13 8z" />
                      </svg>
                    }
                  >
                    <svg viewBox="0 0 16 16" aria-hidden="true">
                      <path d="M3.5 2.5h3v11h-3zM9.5 2.5h3v11h-3z" />
                    </svg>
                  </Show>
                </button>
                <button
                  class="tbtn"
                  title="next sample (→)"
                  aria-label="next sample"
                  disabled={!scrubbable() || nextSampleAfter(t().points, props.cursor) === undefined}
                  onClick={() => props.onStepForward()}
                >
                  <svg viewBox="0 0 16 16" aria-hidden="true">
                    <path d="M11 3h2v10h-2zM3 3v10l7-5z" />
                  </svg>
                </button>
                <span class="tclock mono">{clock().elapsed}</span>
                {/*
                  A track with one sample has nothing to scrub: min === max
                  leaves a slider pinned at one end that answers no drag, which
                  reads as broken rather than as "there is only one reading".
                */}
                <Show when={scrubbable()} fallback={<span class="dim grow center">one reading</span>}>
                  <input
                    type="range"
                    class="scrubber"
                    aria-label="replay position"
                    min={span()?.from ?? 0}
                    max={span()?.to ?? 0}
                    value={props.cursor}
                    style={{ "--p": String(progressOf(span(), props.cursor)) }}
                    onInput={(e) => props.onSeek(Number(e.currentTarget.value))}
                  />
                </Show>
                <span class="tclock mono">{clock().total}</span>
                <button
                  class="tbtn speed mono"
                  title="playback speed: samples per tick"
                  disabled={!scrubbable()}
                  onClick={() => props.onCycleSpeed()}
                >
                  {props.speed}×
                </button>
              </Show>
            </div>
          )}
        </Show>
      </Show>
    </div>
  );
}
