/**
 * The harness tag every run row shows. The episode picker, the
 * harness picker and the filter note that used to live here went with the
 * ladder's `all`/overridden views: the ladder offers one tier at a time, and
 * is filtered by the shell's series selector.
 */

/** A harness tag as every row shows it. Null reads as "not recorded". */
export function HarnessTag(props: { harness: string | null | undefined }) {
  return (
    <span
      class={`badge harness-${props.harness ?? "unknown"}`}
      title="which loop owned the run: wrathbench is the fixed loop, claude-code the Claude Code CLI scaffold, codex the OpenAI Codex CLI scaffold. A tag, not a partition."
    >
      {props.harness ?? "—"}
    </span>
  );
}
