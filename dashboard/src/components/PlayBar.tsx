/**
 * The map's one strip, bottom centre of the stage, in both modes.
 *
 * On `/map` it is a live pill with the character count and, with a pip
 * selected, the way into that run's replay. On `/map?run=<id>` it is the
 * replay's identity — the run, its attempt steps, the live link on the right —
 * and, before the track lands, that it is loading. Live→replay→live is this
 * one element saying something different, so the way back is always where it
 * was. The replay's transport is not here: the scrubber, the clock and the
 * play button are the timeline's, fixed to the bottom of the viewport
 * (`components/Timeline.tsx`).
 *
 * It is a component rather than a block of `MapPage` for one reason: the route
 * swap has to be renderable in a test. The swap that used to freeze the page
 * was a JSX expression reading `track()!.points` on its own, which re-ran
 * after the track was cleared and threw inside the graph — an
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
 * The attempt steps are anchors for the same reason, and for one
 * more: a freeplay character is one character across attempts, so following it
 * end to end used to mean going back to the run page for the next id. They
 * link `/map?run=<id>` and nothing else — the route effect swaps the track and
 * `cursormemory` resumes the attempt where it was last left, so stepping away
 * and back keeps each attempt's own place. They render only where the track
 * carries a `character`: a scored run has none, and so does a track served or
 * published before the field existed.
 */

import { A } from "@solidjs/router";
import { Show } from "solid-js";
import type { AgentPosition, TrackResponse } from "../api/client";
import { shortRunId } from "../lib/format";
import { replayHref, replayHrefFor } from "../lib/mapstate";
import { colorOf, pipName } from "../lib/mapview";
import { InfoHint } from "./InfoHint";
import { partyHref } from "../lib/party";

/** What the replayed route's colours and gaps mean (`classifySegments`), the same on both builds. */
export function routeNote(): string {
  return (
    "The route: the run's own colour where it moved under its own power, blue on a flight path, " +
    "and no line across a hearthstone, a release to a graveyard, a portal or a change of map."
  );
}

export interface PlayBarProps {
  /** The route's run id; undefined is the live map. */
  replayId: string | undefined;
  /** The loaded track, once it has landed; a party's, its members' points merged (`groupTrack`). */
  track: TrackResponse | undefined;
  /** A party's replay: the party's id and how many members' tracks it plays. */
  party?: { id: string; members: number } | undefined;
  /** A fan-out run's replay: the run's id and how many characters' tracks it plays. */
  fanout?: { id: string; characters: number } | undefined;
  /** Why the track did not land, already rendered for display. */
  replayError: string | undefined;
  /** The live poll's failure, already rendered for display. */
  feedError: string | undefined;
  /** Live: how many characters the feed shows. */
  count: number;
  /** Live: the reading whose pip was clicked, for the way into its replay. */
  selected: AgentPosition | null;
}

export function PlayBar(props: PlayBarProps) {
  return (
    <div class="playbar" classList={{ replay: props.replayId !== undefined }}>
      <Show
        when={props.replayId !== undefined}
        fallback={
          <div class="playbar-row">
            <span class="live-pill">
              <span class="dot live" />
              live
            </span>
            <span class="playbar-text">
              <Show
                when={props.feedError === undefined}
                fallback={<span class="err">{props.feedError}</span>}
              >
                {props.count} {props.count === 1 ? "character" : "characters"}
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
                <Show
                  when={props.party}
                  fallback={
                    <Show
                      when={props.fanout}
                      fallback={
                        <>
                          <span class="swatch" style={{ background: colorOf(t().runId) }} />
                          <span class="playbar-title" title={t().runId}>
                            {t().characterName ?? shortRunId(t().runId)}
                          </span>
                          <span class="dim mono">{shortRunId(t().runId)}</span>
                        </>
                      }
                    >
                      {(f) => (
                        <>
                          <A class="playbar-title" href={`/run/${encodeURIComponent(f().id)}`} title={f().id}>
                            {shortRunId(f().id)}
                          </A>
                          <span class="dim">· {f().characters} characters</span>
                        </>
                      )}
                    </Show>
                  }
                >
                  {(pt) => (
                    <>
                      <A class="playbar-title" href={partyHref(pt().id)} title={pt().id}>
                        party
                      </A>
                      <span class="dim mono">{shortRunId(pt().id)}</span>
                      <span class="dim">· {pt().members} members</span>
                    </>
                  )}
                </Show>
                <span class="dim">
                  · {t().points.length} {t().points.length === 1 ? "position" : "positions"}
                </span>
                <InfoHint label="about the route" text={routeNote()} />
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
              </>
            )}
          </Show>
          <A class="playbar-btn live-link" href="/map" title="back to the live map">
            <span class="dot live" />
            live
          </A>
        </div>
      </Show>
    </div>
  );
}
