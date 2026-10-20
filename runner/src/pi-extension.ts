/**
 * The one extension the pi driver loads into the pi CLI (`adapter-pi.ts`,
 * `-e <this file>`, after `--no-extensions`).
 *
 * It does one thing: it makes the system prompt pi sends exactly the bytes
 * `--system-prompt` named — the harness's render (`PI_SYSTEM_PROMPT`) — and
 * nothing else. Without it the pinned pi 1.3.0 appends a `<cwd>` section
 * (`buildSystemPromptSections`, `dist/core/system-prompt.js`), so the prompt
 * on the wire would differ from the hashed one and from run to run (the cwd is
 * a fresh temp directory). The mechanism is pi's documented one: a
 * `before_agent_start` handler that returns `systemPrompt` replaces the whole
 * prompt for that run, and providers receive the forced text as their leading
 * system prompt (`docs/extensions.md`); the session transcript keeps the
 * structured sections, which nothing here reads.
 *
 * Runs inside the pi process, loaded by pi's own TypeScript loader, so it
 * imports nothing: the shape it relies on is typed here, minimally, against
 * the pinned version. Verified against that version by the driver's
 * end-to-end check (runner/README.md, "The pi driver").
 */

interface BeforeAgentStart {
  systemPromptOptions?: { customPrompt?: unknown };
}

interface PiExtensionApi {
  on(event: "before_agent_start", handler: (event: BeforeAgentStart) => { systemPrompt: string } | undefined): void;
}

export default function wrathbenchPromptExtension(pi: PiExtensionApi): void {
  pi.on("before_agent_start", (event) => {
    const prompt = event.systemPromptOptions?.customPrompt;
    return typeof prompt === "string" && prompt.length > 0 ? { systemPrompt: prompt } : undefined;
  });
}
