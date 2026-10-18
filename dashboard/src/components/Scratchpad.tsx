/**
 * The run's scratchpad on the run page: the model's own markdown notes, which
 * it rewrites and the harness hands back every turn.
 *
 * Model-written and untrusted, so it is drawn as text and nothing else: one
 * `<pre>` whose only child is the text, which Solid inserts as a text node.
 * No markdown is rendered — the dashboard has no renderer, the monospace page
 * reads the raw markdown fine, and text that is never parsed as markup cannot
 * carry a script, a handler or a link (`test/scratchpad-panel.test.tsx` pins
 * that against a hostile pad). Long pads scroll inside the panel and an
 * unbroken line wraps rather than widening the page (`.scratchpad`).
 *
 * The text is a string prop, so a poll that brings back the same pad is not a
 * change and the reader's place in the panel survives it.
 */

import { Collapsible } from "./Collapsible";
import { fmtTokens } from "../lib/format";

const OPEN_KEY = "wrathbench.runview.scratchpad";

export function ScratchpadPanel(props: { text: string }) {
  return (
    <Collapsible
      title={<span title="the model's own notes, rewritten by it and handed back every turn">scratchpad</span>}
      summary={`${fmtTokens(props.text.length)} chars`}
      defaultOpen
      storageKey={OPEN_KEY}
    >
      <pre class="block scratchpad">{props.text}</pre>
    </Collapsible>
  );
}
