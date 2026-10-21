/*
 * The map sidebar with nothing selected: every live character, one row each,
 * and a click on a row is a click on its pip plus a camera move to it
 * (`MapPage`'s `focusOn`).
 *
 * A row is a button, so the list is reachable by keyboard the way the canvas
 * is not. The rows are keyed by run id over `liveListOrder`, and the order is
 * kept equal while it says the same thing: the feed hands back fresh objects
 * on every poll, and rows rebuilt under the pointer every five seconds would
 * swallow a click landing on a node being replaced.
 *
 * A party's replay uses the same list as its legend (`member`): the rows in
 * the party's member order, each swatch the member's own colour, where the
 * member is in place of the model it shares with the other four, and the
 * member the map follows marked.
 */

import type { AgentPosition } from "@viewer/api-types";
import { For, Show, createMemo } from "solid-js";
import { modelDisplay } from "../lib/format";
import { colorOf, liveListOrder, mapName, pipName } from "../lib/mapview";
import { memberClass } from "../lib/party";
import { ModelIcon } from "./ModelIcon";

export interface LiveListProps {
  rows: readonly AgentPosition[];
  onPick: (runId: string) => void;
  /** A party's members: each row's place in the party, which orders the rows and colours the swatch. */
  member?: (runId: string) => number | undefined;
  /** In place of the model, where the row's character is. */
  place?: (p: AgentPosition) => string;
  /** The row the map follows. */
  selectedId?: string | null;
}

export function LiveList(props: LiveListProps) {
  const ids = createMemo(
    () => {
      const by = props.member;
      if (by === undefined) return liveListOrder(props.rows).map((p) => p.runId);
      return [...props.rows].sort((a, b) => (by(a.runId) ?? 99) - (by(b.runId) ?? 99)).map((p) => p.runId);
    },
    [],
    { equals: (a, b) => a.join("\n") === b.join("\n") },
  );
  const byId = createMemo(() => new Map(props.rows.map((p) => [p.runId, p])));
  return (
    <Show when={ids().length > 0}>
      <ul class="inv-list live-list">
        <For each={ids()}>
          {(id) => (
            <Show when={byId().get(id)}>
              {(p) => (
                <li>
                  <button
                    type="button"
                    class={props.selectedId === id ? "live-row on" : "live-row"}
                    title={rowTitle(p())}
                    onClick={() => props.onPick(id)}
                  >
                    {props.member === undefined ? (
                      <span class="swatch" style={{ background: colorOf(id) }} />
                    ) : (
                      <span class={`swatch ${memberClass(props.member(id) ?? 0)}`} />
                    )}
                    <span class="live-name" title={p().runId}>
                      {pipName(p())}
                    </span>
                    <Show
                      when={props.place}
                      fallback={
                        /* With no name yet, `pipName` is the model already; the logo alone says it again. */
                        <span class="live-model dim" title={p().model ?? ""}>
                          <ModelIcon model={p().model} />
                          <Show when={p().character !== null && p().character !== "" && p().model !== null}>
                            {modelDisplay(p().model!)}
                          </Show>
                        </span>
                      }
                    >
                      {(place) => <span class="live-model dim">{place()(p())}</span>}
                    </Show>
                    <span class="inv-list-count" title="level">
                      {p().level === null ? "—" : `L${p().level}`}
                    </span>
                  </button>
                </li>
              )}
            </Show>
          )}
        </For>
      </ul>
    </Show>
  );
}

/**
 * A row's hover: where the character is (the zone its newest log entry
 * recorded, else the continent) and that entry's text. Neither fits a row
 * beside the name and the model at the sidebar's width, and the chips over
 * the map already count who is on which continent.
 */
function rowTitle(p: AgentPosition): string {
  const place = p.status?.zone ?? mapName(p.map);
  const text = p.status?.text ?? "";
  return text === "" ? place : `${place} — ${text}`;
}
