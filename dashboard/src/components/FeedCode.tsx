/**
 * Code and edits in the run feed: a script highlighted (`lib/syntax.ts`) and
 * an edit drawn as a compact diff (`lib/textdiff.ts`). Spans with `syn-*`
 * classes, never inline colours, so the stylesheet themes them from the
 * tokens it already has. Both fold with the toggle every feed block uses.
 */

import { For, Show, createEffect, createMemo, createSignal, on } from "solid-js";
import { highlight, type SynKind, type SynToken } from "../lib/syntax";
import { lineDiff, type DiffLine, type Range } from "../lib/textdiff";

/** Highlighted code, as the spans inside a `pre`. */
export function Code(props: { text: string }) {
  const tokens = createMemo(() => highlight(props.text));
  return <For each={tokens()}>{([k, s]) => (k === "" ? s : <span class={`syn-${k}`}>{s}</span>)}</For>;
}

/** One run of a diff line: its token class, and whether it is inside a changed word. */
type Segment = readonly [SynKind, string, boolean];

/** A line's tokens cut at its changed words' edges, so each piece is one class and one mark. */
export function segments(tokens: readonly SynToken[], words: readonly Range[]): Segment[] {
  const out: Segment[] = [];
  let at = 0;
  for (const [kind, text] of tokens) {
    let from = 0;
    while (from < text.length) {
      const pos = at + from;
      const inside = words.find(([a, b]) => pos >= a && pos < b);
      // The next edge: the end of the word we are in, or the start of the next one.
      let edge = text.length;
      if (inside !== undefined) edge = Math.min(edge, inside[1] - at);
      else {
        const next = words.find(([a]) => a > pos);
        if (next !== undefined) edge = Math.min(edge, next[0] - at);
      }
      out.push([kind, text.slice(from, edge), inside !== undefined]);
      from = edge;
    }
    at += text.length;
  }
  return out;
}

function DiffRow(props: { line: DiffLine; code: boolean }) {
  const parts = createMemo(() => segments(props.code ? highlight(props.line.text) : [["", props.line.text]], props.line.words ?? []));
  const cls = props.line.op === "-" ? "dl del" : props.line.op === "+" ? "dl add" : "dl ctx";
  return (
    <span class={cls}>
      <For each={parts()}>
        {([k, s, marked]) => {
          const c = [k === "" ? "" : `syn-${k}`, marked ? "dw" : ""].filter((x) => x.length > 0).join(" ");
          return c.length === 0 ? s : <span class={c}>{s}</span>;
        }}
      </For>
    </span>
  );
}

/** A diff past this many lines folds, and folded shows about ten. */
const DIFF_FOLD_LINES = 12;

/**
 * An edit as removed lines over added ones, the shared lines either side
 * trimmed to a little context. `code` highlights the lines as TypeScript.
 */
export function DiffBlock(props: { old: string; new: string; code: boolean; defaultOpen: boolean }) {
  const diff = createMemo(() => lineDiff(props.old, props.new));
  const [over, setOver] = createSignal<boolean | null>(null);
  createEffect(on(() => props.defaultOpen, () => setOver(null), { defer: true }));
  const open = (): boolean => over() ?? props.defaultOpen;
  const count = (): number => diff().lines.length + (diff().hiddenBefore > 0 ? 1 : 0) + (diff().hiddenAfter > 0 ? 1 : 0);
  const foldable = (): boolean => count() > DIFF_FOLD_LINES;
  return (
    <>
      <pre class="block diff" classList={{ fold: foldable() && !open() }}>
        <Show when={diff().hiddenBefore > 0}>
          <span class="dl gap">… {diff().hiddenBefore} lines</span>
        </Show>
        <For each={diff().lines}>{(l) => <DiffRow line={l} code={props.code} />}</For>
        <Show when={diff().hiddenAfter > 0}>
          <span class="dl gap">… {diff().hiddenAfter} lines</span>
        </Show>
      </pre>
      <Show when={foldable()}>
        <button class="toggle" onClick={() => setOver(!open())}>
          {open() ? "collapse" : `expand · ${count()} lines`}
        </button>
      </Show>
    </>
  );
}
