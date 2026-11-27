/**
 * A run's camera video: one player over all its parts, and the model's words
 * under it. `RunVideo` is the run page's (and, compact, the map replay's
 * sidebar), `VideoExcerpt` the home page's few seconds around a chapter, and
 * `LiveFrame` the private run page's newest still while the run plays.
 *
 * The player is the browser's own `<video>` with no library, and it has no
 * bar of its own: the page's timeline (`components/Timeline.tsx`) is the one
 * scrubber, and the frame shows the time in focus there (`follow`) through
 * the time map between the parts and run time (`@viewer/video-time`). A
 * click on the frame, or its corner button, plays the video itself, and
 * while it plays it moves the focus (`onRunTime`, `lib/video-sync.ts`). Two
 * stacked elements play the parts back to back: the next part waits in the hidden one, its head fetched, and takes
 * over on `ended`, so a part boundary does not flash black. Only the current
 * part's poster and the next part's video are ever asked for: on the public
 * site every request under a run counts against the edge's rate limit
 * (`docs/PUBLIC-DASHBOARD.md`). `playsinline` keeps a phone from going full
 * screen on its own. The captions are text from `clips.json`, drawn as a text
 * node, never burned into the picture.
 */

import { For, Show, batch, createEffect, createMemo, createSignal, on, onCleanup, type JSX } from "solid-js";
import { A } from "@solidjs/router";
import { api, type ChapterView, type ClipsResponse, type VideoPartView } from "../api/client";
import { fmtAge, modelDisplay } from "../lib/format";
import { fmtRunClock } from "../lib/timeline";
import { poll } from "../lib/poll";
import { Collapsible } from "./Collapsible";
import { cursorFor, videoSeekFor } from "../lib/video-sync";
import { captionAt, lastAtOrBefore, partAt, partStarts, runToVideo, totalSeconds, videoToRun } from "@viewer/video-time";
import { chaptersOf } from "@viewer/timeline-marks";

/** A chapter's label: our own short detail, or its kind. */
function chapterLabel(c: ChapterView): string {
  return c.detail !== "" ? c.detail : c.type;
}

/** Up to this many chapters are all listed in the chapters pane; past it, the current part's. */
const CHAPTERS_LISTED = 40;

/** How close to a part's end the next part's whole file is asked for. */
const PRELOAD_AHEAD_S = 15;

function partTitle(p: VideoPartView): string {
  const from = new Date(p.from).toISOString().slice(0, 16).replace("T", " ");
  const to = new Date(p.to).toISOString().slice(0, 16).replace("T", " ");
  return `${from} – ${to} UTC`;
}

interface RunVideoProps {
  clips: ClipsResponse;
  /** The map replay's sidebar: the player alone, no heading. */
  compact?: boolean;
  /** A run time to show: the page's focused time. Null shows nothing new: the video stays where it is. */
  follow?: number | null;
  /**
   * Whether `follow` was moved by something other than this video (the bar,
   * the feed, playback, a link). The video's own time coming back is never
   * followed; a move from anywhere else stops a playing video and is.
   */
  foreign?: boolean;
  /** Hands the page a way to stop the video: its bar's pause is the video's while the video plays. */
  control?: (c: { pause(): void }) => void;
  /** Pause the video: the other clock has started. */
  hold?: boolean;
  /** The run time the video shows, as it plays or when its own controls move it. */
  onRunTime?: (ms: number) => void;
  onPlaying?: (playing: boolean) => void;
}

export function RunVideo(props: RunVideoProps) {
  const parts = (): VideoPartView[] => props.clips.parts;
  const starts = createMemo(() => partStarts(parts()));
  const total = createMemo(() => totalSeconds(parts()));
  const els: (HTMLVideoElement | undefined)[] = [undefined, undefined];
  /** Which part each element holds, -1 for none. */
  const held: [number, number] = [-1, -1];
  const [active, setActive] = createSignal(0);
  const [part, setPart] = createSignal(0);
  const [v, setV] = createSignal(0);
  const [playing, setPlaying] = createSignal(false);
  let lastSent: number | null = null;
  let ownSeek = false;

  const other = (): number => 1 - active();
  const load = (slot: number, i: number): void => {
    const el = els[slot];
    const p = parts()[i];
    if (el === undefined || p === undefined || held[slot] === i) return;
    held[slot] = i;
    el.preload = "metadata";
    el.src = api.mediaUrl(p.video);
  };
  /** The next part into the hidden element, so `ended` can hand over at once. */
  const stageNext = (): void => {
    if (part() + 1 < parts().length) load(other(), part() + 1);
  };
  const send = (): void => {
    const ms = cursorFor(props.clips.timemap, v(), { videoPlaying: playing(), ownSeek, lastSent });
    ownSeek = false;
    if (ms === null) return;
    lastSent = ms;
    props.onRunTime?.(ms);
  };
  const setAt = (el: HTMLVideoElement, offset: number): void => {
    if (el.readyState >= 1) el.currentTime = offset;
    else el.addEventListener("loadedmetadata", () => (el.currentTime = offset), { once: true });
  };
  /** Show timeline time `t`: in the element that holds its part, loading it there if neither does. */
  const seek = (t: number, own: boolean): void => {
    const at = partAt(parts(), t);
    if (at === null) return;
    const wasPlaying = playing();
    let slot = active();
    if (held[slot] !== at.index) {
      if (held[other()] === at.index) slot = other();
      else load(slot, at.index);
    }
    if (slot !== active()) {
      els[active()]?.pause();
      setActive(slot);
    }
    setPart(at.index);
    setAt(els[slot]!, at.offset);
    setV(t);
    if (own) {
      ownSeek = true;
      send();
    }
    if (wasPlaying) void els[slot]?.play().catch(() => undefined);
    stageNext();
  };
  const toggle = (): void => {
    const el = els[active()];
    if (el === undefined) return;
    if (playing()) el.pause();
    else {
      if (v() >= total() - 0.05) seek(0, true);
      void els[active()]?.play().catch(() => undefined);
    }
  };
  const onTime = (slot: number): void => {
    const el = els[slot];
    if (el === undefined || slot !== active()) return;
    setV(Math.min(total(), (starts()[part()] ?? 0) + el.currentTime));
    send();
    const p = parts()[part()];
    const next = els[other()];
    if (p !== undefined && next !== undefined && held[other()] === part() + 1 && p.seconds - el.currentTime < PRELOAD_AHEAD_S) next.preload = "auto";
  };
  const onEnded = (slot: number): void => {
    if (slot !== active()) return;
    const next = part() + 1;
    if (next >= parts().length) {
      setPlaying(false);
      return;
    }
    if (held[other()] !== next) load(other(), next);
    const el = els[other()]!;
    setActive(other());
    setPart(next);
    setAt(el, 0);
    void el.play().catch(() => undefined);
    stageNext();
  };
  const setPlay = (slot: number, on: boolean): void => {
    if (slot !== active()) return;
    // An element paused by a hand-over to the other is not the player pausing.
    if (!on && els[slot]?.ended === true && part() + 1 < parts().length) return;
    // One batch, so the page stopping its own clock lands before `hold` is read again.
    batch(() => {
      props.onPlaying?.(on);
      setPlaying(on);
    });
  };

  /** Stop, now: the element's own `pause` event lands a task later, and what follows a foreign seek must not wait on it. */
  const pause = (): void => {
    els[active()]?.pause();
    batch(() => {
      props.onPlaying?.(false);
      setPlaying(false);
    });
  };
  props.control?.({ pause });

  // The page's focus, while the video is still: the frame at or before it.
  createEffect(
    on(
      () => props.follow,
      (cursor) => {
        if (cursor === null || cursor === undefined) return;
        if (props.foreign === true && playing()) pause();
        const t = videoSeekFor(props.clips.timemap, cursor, { current: v(), videoPlaying: playing(), lastSent });
        if (t !== null) seek(t, false);
      },
    ),
  );
  createEffect(
    on(
      () => props.hold === true,
      (h) => {
        if (h && playing()) els[active()]?.pause();
      },
    ),
  );
  /*
   * A new body (the open part re-encoded, one more part) keeps the place on
   * the timeline: an element whose part's file is unchanged is left alone,
   * one whose file moved is loaded again at the same time, playing if it was.
   */
  let refs: (string | undefined)[] = [];
  createEffect(
    on(
      () => props.clips,
      () => {
        const now = parts().map((p) => p.video);
        for (const slot of [0, 1]) {
          const i = held[slot]!;
          if (i >= 0 && refs[i] !== now[i]) held[slot] = -1;
        }
        refs = now;
        if (held[active()] === -1) seek(v(), false);
        else stageNext();
      },
      { defer: true },
    ),
  );
  onCleanup(() => {
    for (const el of els) el?.pause();
  });

  const caption = (): string => captionAt(props.clips.captions, v());
  const posterOf = (slot: number): string | undefined => {
    const p = parts()[slot === active() ? part() : part() + 1]?.poster;
    return p === null || p === undefined ? undefined : api.mediaUrl(p);
  };
  const element = (slot: number): JSX.Element => (
    <video
      ref={(el) => {
        els[slot] = el;
        if (slot === 0) {
          refs = parts().map((p) => p.video);
          load(0, 0);
        } else stageNext();
      }}
      hidden={active() !== slot}
      preload="metadata"
      playsinline
      muted
      poster={slot === active() ? posterOf(slot) : undefined}
      title={parts()[part()] === undefined ? "" : partTitle(parts()[part()]!)}
      onClick={toggle}
      onTimeUpdate={() => onTime(slot)}
      onEnded={() => onEnded(slot)}
      onPlay={() => setPlay(slot, true)}
      onPause={() => setPlay(slot, false)}
    />
  );

  return (
    <>
      <Show when={props.compact !== true}>
        <h2 class="section" title={parts().length > 1 ? `${parts().length} parts of at most six hours of play each` : undefined}>
          replay
        </h2>
      </Show>
      <div class="video-frame">
        {element(0)}
        {element(1)}
        <button class="tbtn play" title={playing() ? "pause the video" : "play the video; the timeline follows it"} aria-label={playing() ? "pause the video" : "play the video"} onClick={toggle}>
          <Show
            when={playing()}
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
      </div>
      <Show when={caption() !== ""}>
        <p class="dim">{caption()}</p>
      </Show>
    </>
  );
}

const CHAPTERS_OPEN_KEY = "wrathbench.runview.chapters";

/**
 * The video's chapters as a list, in a pane of the run page's sidebar under
 * the milestones, closed until the reader opens it (the operator's call): a
 * reference, not something to read past on the way to the figures. A chapter
 * is a level reached or a boss killed (`@viewer/timeline-marks`); a video cut
 * before that rule still lists its turn-ins and zones, and they are not
 * drawn. A chapter's time is a seek on the page's timeline, to the run time
 * the video shows there. Every chapter while there are few; for a long
 * freeplay run's many, those of the part of the video in focus.
 */
export function ChaptersPanel(props: { clips: ClipsResponse; at: number; onSeek: (runMs: number) => void }) {
  const all = createMemo((): ChapterView[] => chaptersOf(props.clips.chapters));
  /** Where the focused time is on the video. */
  const v = (): number => runToVideo(props.clips.timemap, props.at) ?? 0;
  const part = (): number => partAt(props.clips.parts, v())?.index ?? 0;
  const shown = createMemo(() => (all().length <= CHAPTERS_LISTED ? all() : all().filter((c) => c.part === part())));
  const current = (): ChapterView | undefined => all()[lastAtOrBefore(all(), v())];
  return (
    <Show when={all().length > 0}>
      <Collapsible
        title={<span title="the levels and boss kills the replay video is marked at; a time seeks the timeline">replay chapters</span>}
        summary={`${all().length}`}
        storageKey={CHAPTERS_OPEN_KEY}
      >
        <table class="chapters">
          <tbody>
            <For each={shown()}>
              {(c) => (
                <tr class={current() === c ? "hovered" : undefined} title={c.caption === "" ? undefined : c.caption}>
                  <td class="mono">
                    <a
                      href="#"
                      onClick={(e) => {
                        e.preventDefault();
                        const ms = videoToRun(props.clips.timemap, c.t);
                        if (ms !== null) props.onSeek(ms);
                      }}
                    >
                      {fmtRunClock(c.t * 1000)}
                    </a>
                  </td>
                  <td class="dim">{c.type}</td>
                  <td>{chapterLabel(c)}</td>
                </tr>
              )}
            </For>
          </tbody>
        </table>
      </Collapsible>
    </Show>
  );
}

/**
 * The home page's excerpt: a few seconds of a recent run's video around a
 * chapter, played from `from` and stopped at `to` in one part's file, beside
 * the model's name, linking to the run, and the model's words at that moment.
 */
export function VideoExcerpt(props: { runId: string; model: string | null; part: VideoPartView; from: number; to: number; chapter: ChapterView | null }) {
  let el: HTMLVideoElement | undefined;
  const [playing, setPlaying] = createSignal(false);
  const rewind = (): void => {
    if (el !== undefined && el.readyState >= 1) el.currentTime = props.from;
  };
  const toggle = (): void => {
    if (el === undefined) return;
    if (playing()) el.pause();
    else {
      if (el.currentTime < props.from || el.currentTime >= props.to - 0.05) rewind();
      void el.play().catch(() => undefined);
    }
  };
  return (
    <div class="two-col">
      <div>
        <video
          ref={el}
          preload="metadata"
          playsinline
          muted
          src={api.mediaUrl(props.part.video)}
          poster={props.part.poster === null ? undefined : api.mediaUrl(props.part.poster)}
          title={props.chapter === null ? partTitle(props.part) : chapterLabel(props.chapter)}
          onLoadedMetadata={rewind}
          onClick={toggle}
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onTimeUpdate={() => {
            if (el !== undefined && el.currentTime >= props.to) {
              el.pause();
              rewind();
            }
          }}
        />
        <div class="playbar-row transport">
          <button class="tbtn play" title={playing() ? "pause" : "play"} aria-label={playing() ? "pause" : "play"} onClick={toggle}>
            <Show
              when={playing()}
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
          <Show when={props.chapter}>{(c) => <span class="dim">{chapterLabel(c())}</span>}</Show>
        </div>
      </div>
      <div>
        <div class="home-surface-head">
          <A href={`/run/${encodeURIComponent(props.runId)}`}>{props.model === null ? "a run" : modelDisplay(props.model)}</A>
        </div>
        <Show when={props.chapter !== null && props.chapter.caption !== ""}>
          <p class="dim">{props.chapter!.caption}</p>
        </Show>
      </div>
    </div>
  );
}

/** How often the live still is re-read: about the camera's own interval. */
const LIVE_FRAME_POLL_MS = 10_000;
/** Past this a still reads stale: three missed reads. */
const LIVE_FRAME_STALE_MS = 3 * LIVE_FRAME_POLL_MS;

/**
 * The newest camera frame of a run that is still playing, with its age, on the
 * private viewer only: the run page and the live map mount it while the run is
 * live and the build is not the public one, whose client never asks for a
 * frame. Nothing is drawn until there is a frame, so a run with no camera shows
 * nothing. `kv` draws it as a row of the map sidebar's key/value list.
 */
export function LiveFrame(props: { runId: string; now: number; kv?: boolean }) {
  const feed = poll(() => api.cameraLatest(props.runId), LIVE_FRAME_POLL_MS);
  return (
    <Show when={feed.latest}>
      {(f) => {
        const age = (): number => props.now - Date.parse(f().t);
        const taken = (): string => `frame ${f().seq} · ${new Date(f().t).toISOString().slice(0, 19).replace("T", " ")} UTC`;
        const ageClass = (): string => (age() > LIVE_FRAME_STALE_MS ? "warn" : "dim");
        const still = (): JSX.Element => <img src={api.cameraFrameUrl(props.runId, f().seq)} alt="" title={taken()} />;
        return (
          <Show
            when={props.kv === true}
            fallback={
              <>
                <h2 class="section">live</h2>
                {still()}
                <p class={ageClass()} title={taken()}>
                  {fmtAge(age())}
                </p>
              </>
            }
          >
            <div class="k">camera</div>
            <div class="v">
              {still()}
              <span class={ageClass()} title={taken()}>
                {fmtAge(age())}
              </span>
            </div>
          </Show>
        );
      }}
    </Show>
  );
}
