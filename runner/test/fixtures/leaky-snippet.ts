/**
 * A snippet result, a harness notice and a scratchpad that each carry the
 * run's lease secret, for the driver tests that check what reaches the model.
 * A fake sandbox returns them in place of a real child's; every driver must
 * hand the model `[redacted]` where the secret was.
 */
import type { HarnessNotice, SnippetResult } from "../../src/sandbox/host";

/** Obviously fake, and the length of nothing real. */
export const LEAKED_SECRET = "fake-lease-secret-0123456789abcdef0123456789abcdef";

/** What a snippet that returned, logged and threw the secret comes back as. */
export function leakySnippetResult(): SnippetResult {
  return {
    ok: false,
    value: `{ WRATHBENCH_SECRET: "${LEAKED_SECRET}", account: "RUNNER" }`,
    error: `Error: refused with ${LEAKED_SECRET}`,
    logs: [
      { level: "log", ts: 1, text: `WRATHBENCH_SECRET=${LEAKED_SECRET}` },
      { level: "log", ts: 2, text: "plain line, é ✓  " },
    ],
    durationMs: 1,
  };
}

/** `leakySnippetResult()` as the model reads it: the same text, the secret replaced. */
export const LEAKY_RESULT_AS_READ = [
  "error (1ms)",
  '=> { WRATHBENCH_SECRET: "[redacted]", account: "RUNNER" }',
  "Error: refused with [redacted]",
  "--- console ---",
  "[log] WRATHBENCH_SECRET=[redacted]",
  "[log] plain line, é ✓  ",
].join("\n");

/** The crash notice a child that wrote the secret to stderr before dying would raise. */
export function leakyCrashNotice(): HarnessNotice {
  return {
    ts: 1,
    kind: "sandbox_restarted",
    text: `sandbox process exited unexpectedly (exit code 9, signal none). Last stderr: dumping ${LEAKED_SECRET}\n`,
  };
}

/** What a snippet's `scratchpad.write` stored before the host scrubbed pad writes. */
export const LEAKY_PAD = `# plan\nkey: ${LEAKED_SECRET}\n`;
