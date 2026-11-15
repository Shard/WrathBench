/**
 * A run's camera replay: the native player, the caption under it, and the
 * run's other clips as posters to switch to. The timelapse plays first.
 *
 * The player is the browser's own `<video>` with no library: `preload=
 * "metadata"` fetches only the head of the file until someone presses play,
 * and `playsinline` keeps a phone from going full screen on its own. The
 * caption is text from `clips.json`, drawn as a text node, never burned into
 * the picture. `HighlightClip` is the home page's single small player.
 */

import { For, Show, createMemo, createSignal } from "solid-js";
import { A } from "@solidjs/router";
import { api, type ClipView, type ClipsResponse } from "../api/client";
import { modelDisplay } from "../lib/format";

/** The timelapse first, then the event clips in the order they happened. */
export function orderClips(clips: readonly ClipView[]): ClipView[] {
  return [...clips].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "timelapse" ? -1 : 1;
    return Date.parse(a.from) - Date.parse(b.from);
  });
}

/** A clip's short label: what it shows a moment of, or the whole run. */
export function clipLabel(c: ClipView): string {
  if (c.kind === "timelapse") return "timelapse";
  return c.event !== undefined && c.event.detail !== "" ? c.event.detail : (c.event?.type ?? "clip");
}

function clipTitle(c: ClipView): string {
  const from = new Date(c.from).toISOString().slice(0, 16).replace("T", " ");
  return `${clipLabel(c)} · ${from} UTC · ${Math.round(c.seconds)} s of video`;
}

export function ReplayBlock(props: { clips: ClipsResponse }) {
  const ordered = createMemo(() => orderClips(props.clips.clips));
  const [picked, setPicked] = createSignal(0);
  const current = (): ClipView | undefined => ordered()[Math.min(picked(), ordered().length - 1)];
  let video: HTMLVideoElement | undefined;
  const pick = (i: number): void => {
    setPicked(i);
    // A click is the gesture a browser asks for before it plays; the new source is set by now.
    queueMicrotask(() => void video?.play().catch(() => undefined));
  };
  return (
    <Show when={current()}>
      {(c) => (
        <>
          <h2 class="section">replay</h2>
          <video
            ref={video}
            controls
            preload="metadata"
            playsinline
            src={api.mediaUrl(c().video)}
            poster={c().poster === null ? undefined : api.mediaUrl(c().poster!)}
            title={clipTitle(c())}
          />
          <Show when={c().caption !== ""}>
            <p class="dim">{c().caption}</p>
          </Show>
          <Show when={ordered().length > 1}>
            <div class="chips">
              <For each={ordered()}>
                {(clip, i) => (
                  <button class={i() === picked() ? "on" : ""} title={clipTitle(clip)} onClick={() => pick(i())}>
                    <Show when={clip.poster}>{(p) => <img src={api.mediaUrl(p())} alt="" loading="lazy" />}</Show>
                    {clipLabel(clip)}
                  </button>
                )}
              </For>
            </div>
          </Show>
        </>
      )}
    </Show>
  );
}

/** The home page's one clip: a small player beside the model's name and the caption. */
export function HighlightClip(props: { runId: string; model: string | null; clip: ClipView }) {
  return (
    <div class="two-col">
      <video
        controls
        preload="metadata"
        playsinline
        src={api.mediaUrl(props.clip.video)}
        poster={props.clip.poster === null ? undefined : api.mediaUrl(props.clip.poster)}
        title={clipTitle(props.clip)}
      />
      <div>
        <div class="home-surface-head">
          <A href={`/run/${encodeURIComponent(props.runId)}`}>{props.model === null ? "a run" : modelDisplay(props.model)}</A>
        </div>
        <Show when={props.clip.caption !== ""}>
          <p class="dim">{props.clip.caption}</p>
        </Show>
        <div class="dim">{clipLabel(props.clip)}</div>
      </div>
    </div>
  );
}
