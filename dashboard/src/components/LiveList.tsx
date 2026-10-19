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
 */

import type { AgentPosition } from "@viewer/api-types";
import { For, Show, createMemo } from "solid-js";
import { modelDisplay } from "../lib/format";
import { colorOf, liveListOrder, mapName, pipName } from "../lib/mapview";
import { ModelIcon } from "./ModelIcon";

export interface LiveListProps {
  rows: readonly AgentPosition[];
  onPick: (runId: string) => void;
}

export function LiveList(props: LiveListProps) {
  const ids = createMemo(() => liveListOrder(props.rows).map((p) => p.runId), [], {
    equals: (a, b) => a.join("\n") === b.join("\n"),
  });
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
                    class="live-row"
                    title={rowTitle(p())}
                    onClick={() => props.onPick(id)}
                  >
                    <span class="swatch" style={{ background: colorOf(id) }} />
                    <span class="live-name" title={p().runId}>
                      {pipName(p())}
                    </span>
                    {/* With no name yet, `pipName` is the model already; the logo alone says it again. */}
                    <span class="live-model dim" title={p().model ?? ""}>
                      <ModelIcon model={p().model} />
                      <Show when={p().character !== null && p().character !== "" && p().model !== null}>
                        {modelDisplay(p().model!)}
                      </Show>
                    </span>
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
