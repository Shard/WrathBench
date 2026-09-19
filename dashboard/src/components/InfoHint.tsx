/**
 * The explanation a chart or a table used to print under itself.
 *
 * Every derived view on this site has a paragraph's worth of "and here is what
 * that actually means" behind it, and for a long time each one was printed on
 * the page. A reader who already knows reads past three sentences every visit;
 * a reader who does not is reading an essay where they wanted a number. The
 * operator's call: the page shows the heading and the axes, and
 * the sentences live one hover away — here, and at length in
 * `docs/PUBLIC-DASHBOARD.md`, which is where an explanation belongs.
 *
 * A `title` rather than a popover of our own: it works on a keyboard focus, it
 * is announced, it wraps at the reader's own width, and it costs no mechanism.
 * The glyph is a button so that a focus ring lands on it at all — a bare
 * `<span title>` is unreachable without a pointer.
 */

export function InfoHint(props: { text: string; label?: string }) {
  return (
    <button
      type="button"
      class="info-hint"
      title={props.text}
      aria-label={props.label === undefined ? props.text : `${props.label}: ${props.text}`}
      // It explains rather than does: a click is not an action, and a button
      // that scrolls the page to itself on every tap would be worse than none.
      onClick={(ev) => ev.preventDefault()}
    >
      i
    </button>
  );
}
