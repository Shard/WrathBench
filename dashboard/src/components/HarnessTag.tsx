/**
 * The harness tag every run row shows (ADR-0035). The episode picker, the
 * harness picker and the filter note that used to live here went with the
 * ladder's `all`/overridden views: the ladder offers one tier at a time, and
 * lists what the shell's series filter removed via `SeriesFilterNote`.
 */

/** A harness tag as every row shows it. Null reads as "not recorded". */
export function HarnessTag(props: { harness: string | null | undefined }) {
  return (
    <span
      class={`badge harness-${props.harness ?? "unknown"}`}
      title="which loop owned the run (ADR-0035): wrathbench is the fixed loop, claude-code the Claude Code CLI scaffold. A tag, not a partition."
    >
      {props.harness ?? "harness?"}
    </span>
  );
}
