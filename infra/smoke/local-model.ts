/**
 * Capability probe for a local, OpenAI-compatible model endpoint (an LM Studio
 * box on the LAN is the intended target). It answers ONE question the fleet
 * cares about: can this model drive our tool-based loop the way `adapter.ts`
 * expects — not "can it call a tool" in the abstract, but "does the response it
 * returns satisfy the exact contract `OpenAiChatAdapter` parses".
 *
 * That contract (runner/src/adapter.ts, completionSchema): a 200 with
 * `choices[0].message`, and for a tool call, `tool_calls[].id` a non-empty
 * string plus `function.arguments` a JSON *string* (not an object). If LM
 * Studio returns `arguments` as an object or omits `id`, the adapter's
 * safeParse fails and the run dies as `adapter-error` — so a tool call that
 * looks fine to a human can still be a no-go for the harness. This probe checks
 * the adapter's contract, in the adapter's order, and says which verdict it got.
 *
 * Deliberately mirrors adapter.ts: `tools` is sent with NO `tool_choice`, so we
 * observe whether the model *elects* to call the tool unprompted (the only
 * thing the harness relies on) rather than proving the plumbing with a forced
 * call. No game account, no module, no live world — safe to run any time.
 *
 * Run:
 *   bun infra/smoke/local-model.ts
 *   MODEL_BASE=http://192.0.2.20:1234/v1 MODEL_ID=qwen/qwen3.8-27b \
 *     bun infra/smoke/local-model.ts
 */

const BASE = (process.env.MODEL_BASE ?? "http://192.0.2.20:1234/v1").replace(/\/+$/, "");
const MODEL = process.env.MODEL_ID ?? "qwen/qwen3.8-27b";
// LM Studio ignores the bearer value; the adapter always sends one.
const KEY = process.env.LMSTUDIO_KEY ?? "lm-studio";
const TIMEOUT_MS = Number(process.env.MODEL_TIMEOUT_MS ?? "120000");

function log(msg: string): void {
  console.log(`[probe] ${msg}`);
}
function fail(msg: string): never {
  console.error(`[probe] FAIL: ${msg}`);
  process.exit(1);
}

// One tool, the OpenAI function-calling shape, chosen so a helpful model has to
// call it rather than answer from its own knowledge: today's local weather is
// not something the model can know.
const TOOL = {
  type: "function",
  function: {
    name: "get_current_weather",
    description: "Get the current weather for a city. Call this to answer any question about current weather.",
    parameters: {
      type: "object",
      properties: {
        city: { type: "string", description: "The city name, e.g. 'Paris'" },
        unit: { type: "string", enum: ["celsius", "fahrenheit"], description: "Temperature unit" },
      },
      required: ["city"],
    },
  },
};

async function main(): Promise<void> {
  const url = `${BASE}/chat/completions`;
  const body = JSON.stringify({
    model: MODEL,
    // No tool_choice — same as adapter.ts: we want the model to elect the call.
    messages: [
      { role: "system", content: "You are a helpful assistant with access to tools. Use them when appropriate." },
      { role: "user", content: "What is the current weather in Paris right now? Use your tools." },
    ],
    tools: [TOOL],
  });

  log(`POST ${url}`);
  log(`model ${MODEL}`);

  const started = Date.now();
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` },
      body,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    fail(`request failed (endpoint unreachable or timed out): ${err instanceof Error ? err.message : String(err)}`);
  }
  const text = await res.text();
  const latencyMs = Date.now() - started;

  // (c) latency and status — the operator cares about local round-trip speed.
  log(`HTTP ${res.status} in ${latencyMs} ms`);

  // (a) 200 with a well-formed choices[0].message.
  if (!res.ok) fail(`non-200 (${res.status}): ${text.slice(0, 500)}`);
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    fail(`200 with a non-JSON body: ${text.slice(0, 300)}`);
  }
  const choice = json?.choices?.[0];
  if (choice === undefined || typeof choice !== "object") {
    fail(`no choices[0] in the response: ${JSON.stringify(json).slice(0, 500)}`);
  }
  const msg = choice.message;
  if (msg === undefined || typeof msg !== "object") {
    fail(`choices[0].message is missing or not an object: ${JSON.stringify(choice).slice(0, 500)}`);
  }
  const finishReason: string = choice.finish_reason ?? "(none reported)";
  log(`finish_reason: ${finishReason}`);
  log(`well-formed choices[0].message: yes`);

  // (b) a tool_call that satisfies the ADAPTER'S contract, checked in the
  // adapter's order: id a non-empty string, arguments a JSON string, parsable.
  const toolCalls = msg.tool_calls;
  if (!Array.isArray(toolCalls) || toolCalls.length === 0) {
    // A no-go, but a clear and specific one — the model answered in prose.
    const contentPreview = typeof msg.content === "string" ? msg.content.slice(0, 300) : JSON.stringify(msg.content);
    log(`tool_calls: NONE — the model returned content instead:`);
    log(`  content: ${contentPreview}`);
    fail(
      "the model did not emit a tool_call. It answered in prose, which means it cannot drive the harness's " +
        "tool-based loop as-is. VERDICT: tool-calling NO.",
    );
  }

  log(`tool_calls: ${toolCalls.length}`);
  for (const [i, tc] of toolCalls.entries()) {
    const id = tc?.id;
    const fn = tc?.function;
    const name = fn?.name;
    const args = fn?.arguments;

    if (typeof id !== "string" || id.length === 0) {
      fail(
        `tool_call[${i}] has no string id (got ${JSON.stringify(id)}). The adapter's schema requires it — ` +
          "this response would fail safeParse and terminate the run as adapter-error. VERDICT: tool-calling works, " +
          "but NOT with our adapter as-is.",
      );
    }
    if (typeof args !== "string") {
      fail(
        `tool_call[${i}].function.arguments is ${typeof args}, not a JSON string (got ${JSON.stringify(args).slice(
          0,
          200,
        )}). The adapter requires a string; an object here fails safeParse -> adapter-error. VERDICT: tool-calling ` +
          "works, but NOT with our adapter as-is.",
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(args);
    } catch (err) {
      fail(
        `tool_call[${i}].function.arguments is a string but not parsable JSON: ${err instanceof Error ? err.message : String(err)} ` +
          `— raw: ${args.slice(0, 200)}`,
      );
    }
    log(`tool_call[${i}]: id=${id} name=${name} arguments(parsed)=${JSON.stringify(parsed)}`);
  }

  log(
    `VERDICT: tool-calling YES — the model elected a tool_call that satisfies the adapter's exact contract ` +
      `(id string, arguments JSON string). round-trip ${latencyMs} ms, finish_reason ${finishReason}.`,
  );
  log("PASS");
  process.exit(0);
}

main().catch((err) => fail(String(err)));
