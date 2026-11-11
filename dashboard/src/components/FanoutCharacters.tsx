/**
 * A fan-out run's characters on the run page: one agent drove several, each
 * with its own session record, so the run's own figures name none of them.
 * The inspector's session list picks one, and its character panel and event
 * feed show that one, read through the inspector's API under the session's
 * id (`<run-id>~<Character>`, `runner/viewer/runs-source.ts`). The pick is
 * the `character` search parameter, so a link names the character it opens
 * on; with none, the first by name.
 *
 * Private only: the public build has no inspector mount, and a fan-out run is
 * never published.
 */

import { useSearchParams } from "@solidjs/router";
import { Show, createMemo, createResource } from "solid-js";
import { CharacterPanel, EventFeed, SessionList, type InspectorClient, type SessionSummary } from "@wrathbench/inspector/views";
import type { FanoutSessionView } from "@viewer/api-types";

export function FanoutCharacters(props: { client: InspectorClient; runId: string; sessions: readonly FanoutSessionView[]; live: boolean; now: number }) {
  const [search] = useSearchParams<{ character?: string }>();
  const ids = createMemo(() => props.sessions.map((s) => s.id).join("\n"));
  // One `session.json` and `live.json` per character: never the whole listing.
  const [summaries] = createResource(ids, async () => {
    const got = await Promise.all(props.sessions.map((s) => props.client.session(s.id).catch(() => null)));
    return got.filter((s): s is SessionSummary => s !== null);
  });
  const selected = createMemo(() => {
    const named = props.sessions.find((s) => s.character === search.character);
    return (named ?? props.sessions[0])?.id ?? null;
  });
  const summary = createMemo(() => summaries()?.find((s) => s.id === selected()) ?? null);
  const href = (id: string): string => `/run/${encodeURIComponent(props.runId)}?character=${encodeURIComponent(props.sessions.find((s) => s.id === id)?.character ?? "")}`;
  return (
    <>
      <h2 class="section" title="one agent, a session record per character">characters · {props.sessions.length}</h2>
      <SessionList sessions={summaries() ?? []} now={props.now} href={href} selected={selected()} />
      {/* Mounted once the pick's summary is in, so the feed reads back from where the session ended. */}
      <Show when={summary()} keyed>
        {(s) => (
          <>
            <CharacterPanel client={props.client} id={s.id} live={props.live} klass={s.session?.character?.class ?? null} />
            <h2 class="section">session events</h2>
            <EventFeed client={props.client} id={s.id} live={props.live} end={s.session?.ended ?? null} />
          </>
        )}
      </Show>
    </>
  );
}
