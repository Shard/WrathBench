/**
 * Capability probe for a local, OpenAI-compatible model endpoint (an LM Studio
 * or omlx box on the LAN is the intended target). It answers ONE question the
 * fleet cares about: can this model drive our tool-based loop the way
 * `adapter.ts` expects — not "can it call a tool" in the abstract, but "does
 * what it returns survive the exact path `OpenAiChatAdapter` takes".
 *
 * So the probe IS that path: it sends one request through the adapter itself,
 * streamed as the runner streams it (runner/src/adapter.ts, "Streaming and the
 * request clock"), assembled and parsed as the runner parses it, under the
 * same silence timeout. A server that cannot stream, that streams tool calls
 * the assembler cannot put back together, or that returns `arguments` as an
 * object or omits a call's `id` fails here exactly as a run would fail, as
 * `adapter-error` — so a tool call that looks fine to a human can still be a
 * no-go for the harness. On top of the adapter's own checks the probe asks
 * what a run needs next: an id that is not empty and arguments that parse.
 *
 * Deliberately mirrors the run: `tools` is sent with NO `tool_choice`, so we
 * observe whether the model *elects* to call the tool unprompted (the only
 * thing the harness relies on) rather than proving the plumbing with a forced
 * call. One attempt, no retries: a probe reports what it got. No game
 * account, no module, no live world — safe to run any time.
 *
 * Run:
 *   bun infra/smoke/local-model.ts
 *   MODEL_BASE=http://192.0.2.20:1234/v1 MODEL_ID=qwen/qwen3.8-27b \
 *     bun infra/smoke/local-model.ts
 * `MODEL_TIMEOUT_MS` sets the silence timeout (default the adapter's own).
 */

import { AdapterError, OpenAiChatAdapter, SILENCE_TIMEOUT_MS } from "../../runner/src/adapter";

const BASE = (process.env.MODEL_BASE ?? "http://192.0.2.20:1234/v1").replace(/\/+$/, "");
const MODEL = process.env.MODEL_ID ?? "qwen/qwen3.8-27b";
// LM Studio ignores the bearer value; the adapter always sends one.
const KEY = process.env.LMSTUDIO_KEY ?? "lm-studio";
const SILENCE_MS = Number(process.env.MODEL_TIMEOUT_MS ?? String(SILENCE_TIMEOUT_MS));

function log(msg: string): void {
  console.log(`[probe] ${msg}`);
}
function fail(msg: string): never {
  console.error(`[probe] FAIL: ${msg}`);
  process.exit(1);
}

// One tool, chosen so a helpful model has to call it rather than answer from
// its own knowledge: today's local weather is not something the model can know.
const TOOL = {
  name: "get_current_weather",
  description: "Get the current weather for a city. Call this to answer any question about current weather.",
  inputSchema: {
    type: "object",
    properties: {
      city: { type: "string", description: "The city name, e.g. 'Paris'" },
      unit: { type: "string", enum: ["celsius", "fahrenheit"], description: "Temperature unit" },
    },
    required: ["city"],
  },
};

async function main(): Promise<void> {
  log(`POST ${BASE}/chat/completions (streamed, through the adapter)`);
  log(`model ${MODEL}`);

  // Only to report what the server answered with; the adapter reads the body.
  let contentType = "";
  const fetchImpl = Object.assign(
    async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const res = await fetch(url, init);
      contentType = res.headers.get("content-type") ?? "";
      return res;
    },
    { preconnect: fetch.preconnect },
  ) as typeof fetch;
  const adapter = new OpenAiChatAdapter({
    baseUrl: BASE,
    apiKey: KEY,
    model: MODEL,
    maxAttempts: 1,
    silenceTimeoutMs: SILENCE_MS,
    fetchImpl,
  });

  const started = Date.now();
  let outcome;
  try {
    outcome = await adapter.complete({
      messages: [
        { role: "system", content: "You are a helpful assistant with access to tools. Use them when appropriate." },
        { role: "user", content: "What is the current weather in Paris right now? Use your tools." },
      ],
      tools: [TOOL as never],
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    fail(
      `${message}\n  A run would end here as adapter-error. VERDICT: NOT usable with our adapter as-is` +
        (err instanceof AdapterError && err.status !== undefined ? ` (HTTP ${err.status}).` : "."),
    );
  }
  const latencyMs = Date.now() - started;
  log(`answered in ${latencyMs} ms, content-type ${contentType || "(none)"}`);
  log(`streamed: ${contentType.toLowerCase().startsWith("text/event-stream") ? "yes" : "no — read as a plain JSON body"}`);

  if (outcome.kind === "pause") {
    fail(`the adapter paused the run (${outcome.reason}): ${outcome.detail}`);
  }
  if (outcome.kind !== "ok") fail(`unexpected outcome ${outcome.kind}`);
  const turn = outcome.turn;
  const finishReason = turn.finishReason ?? "(none reported)";
  log(`finish_reason: ${finishReason}`);
  log(`usage: ${turn.usage !== undefined ? JSON.stringify(turn.usage) : "NONE — the stream carried no usage block"}`);

  if (turn.toolCalls.length === 0) {
    // A no-go, but a clear and specific one — the model answered in prose.
    log(`tool_calls: NONE — the model returned content instead:`);
    log(`  content: ${turn.content === null ? "null" : turn.content.slice(0, 300)}`);
    fail(
      "the model did not emit a tool_call. It answered in prose, which means it cannot drive the harness's " +
        "tool-based loop as-is. VERDICT: tool-calling NO.",
    );
  }

  log(`tool_calls: ${turn.toolCalls.length}`);
  for (const [i, tc] of turn.toolCalls.entries()) {
    if (tc.id.length === 0) {
      fail(`tool_call[${i}] has an empty id; its result could not be sent back. VERDICT: NOT usable with our adapter as-is.`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(tc.arguments);
    } catch (err) {
      fail(
        `tool_call[${i}].function.arguments is a string but not parsable JSON: ${err instanceof Error ? err.message : String(err)} ` +
          `— raw: ${tc.arguments.slice(0, 200)}`,
      );
    }
    log(`tool_call[${i}]: id=${tc.id} name=${tc.name} arguments(parsed)=${JSON.stringify(parsed)}`);
  }

  log(
    `VERDICT: tool-calling YES — the model elected a tool_call that survives the adapter's streamed path ` +
      `(id string, arguments JSON string). round-trip ${latencyMs} ms, finish_reason ${finishReason}.`,
  );
  log("PASS");
  process.exit(0);
}

main().catch((err) => fail(String(err)));
