/**
 * The one extension the pi driver loads into the pi CLI (`adapter-pi.ts`,
 * `-e <this file>`, after `--no-extensions`).
 *
 * It makes the system prompt pi sends exactly the bytes `--system-prompt`
 * named — the harness's render (`PI_SYSTEM_PROMPT`) — and nothing else.
 * Without it the pinned pi 1.3.0 appends a `<cwd>` section
 * (`buildSystemPromptSections`, `dist/core/system-prompt.js:110`), so the
 * prompt on the wire would differ from the hashed one and from run to run
 * (the cwd is a fresh temp directory). The mechanism is pi's documented one:
 * a `before_agent_start` handler that returns `systemPrompt` replaces the
 * whole prompt for that run, and providers receive the forced text as their
 * leading system prompt (`docs/extensions.md`); the session transcript keeps
 * the structured sections, which nothing here reads.
 *
 * **Fail closed.** If the text to force is not there — `--system-prompt`
 * missing, or a pin whose event no longer carries `customPrompt` — the run
 * must not go ahead on pi's own default prompt. The handler then appends a
 * `PI_PROMPT_MISSING` custom entry, which RPC mode streams as
 * `entry_appended` before the prompt's own response and which the driver ends
 * the run on as `harness-error`, and aborts the run before any request is
 * made (checked against the 1.3.0 binary: the stub endpoint saw no request).
 * `before_provider_request` aborts again, belt and braces, should a request
 * still be about to go.
 *
 * Runs inside the pi process, loaded by pi's own TypeScript loader, so it
 * imports nothing: the shape it relies on is typed here, minimally, against
 * the pinned version.
 */

/** The custom entry type the driver ends the run on (`adapter-pi.ts`). */
export const PI_PROMPT_MISSING = "wrathbench_prompt_missing";

interface BeforeAgentStart {
  systemPromptOptions?: { customPrompt?: unknown };
}

interface PiContext {
  abort(): void;
}

interface PiExtensionApi {
  on(event: "before_agent_start", handler: (event: BeforeAgentStart, ctx: PiContext) => { systemPrompt: string } | undefined): void;
  on(event: "before_provider_request", handler: (event: unknown, ctx: PiContext) => undefined): void;
  appendEntry(customType: string, data?: unknown): void;
}

export default function wrathbenchPromptExtension(pi: PiExtensionApi): void {
  let missing = false;
  pi.on("before_agent_start", (event, ctx) => {
    const prompt = event.systemPromptOptions?.customPrompt;
    if (typeof prompt === "string" && prompt.length > 0) {
      missing = false;
      return { systemPrompt: prompt };
    }
    missing = true;
    pi.appendEntry(PI_PROMPT_MISSING, { reason: "before_agent_start carried no customPrompt to force" });
    ctx.abort();
    return undefined;
  });
  pi.on("before_provider_request", (_event, ctx) => {
    if (missing) ctx.abort();
    return undefined;
  });
}
