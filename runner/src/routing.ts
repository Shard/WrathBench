/**
 * Provider routing: which backend behind an aggregator may serve a run.
 *
 * OpenRouter answers one model slug from many backends, and which one it picks
 * is invisible unless the request says. Two runs of `z-ai/glm-5.3-flash` have
 * been served by Z.AI, Together, Parasail, Reka, Cloudflare and GMICloud — six
 * machines with six quantisations, six throughputs and six prompt caches — and
 * pooled as one row they are not one measurement.
 *
 * **Operator decision, 2026-09-16: routing is pinned, and it is config.** Prefer
 * the lab's own endpoint unless there is a specific reason; a third-party
 * provider is a deliberate, named datapoint (the way qwen 3.8 ran on Cerebras),
 * never a silent fallback. So the default is `allow_fallbacks: false` with the
 * model author's own provider first, and anything else is written down in the
 * entry, stamped into the comparability tuple, and therefore visibly a
 * different condition rather than the same row on a different machine.
 *
 * This module owns the whole of that: the shape the config states, the one
 * validator both the file and the config store run, the precedence between
 * entry and policy, and the `provider` object the adapter puts on the wire.
 * Nothing here is OpenRouter-specific except `providerBodyOf`'s spelling — the
 * *gate* is the adapter's, which sends the object only to an OpenRouter base.
 */

import { z } from "zod";

/** How a routed request picks among the backends it is allowed. */
export const ROUTING_SORTS = ["price", "throughput", "latency"] as const;
export type RoutingSort = (typeof ROUTING_SORTS)[number];

/**
 * Routing as the config states it and the tuple stamps it.
 *
 * `allowFallbacks` is required rather than optional because it is the whole
 * point: a tuple that left it out would read as "not recorded" for the one
 * fact the decision above is about.
 */
export interface RoutingSpec {
  /** Providers to try, in order, by the name OpenRouter reports them under. */
  order?: string[];
  /** How to pick when no order is given. Refused alongside `order`. */
  sort?: RoutingSort;
  /** Whether a provider outside `order` may serve the request. Default false. */
  allowFallbacks: boolean;
  /** Whether a provider that would drop a request parameter is skipped. */
  requireParameters?: boolean;
}

/**
 * The stored shape, for the comparability tuple and the run config.
 *
 * Deliberately looser than `parseRouting`: this reads what an older build
 * wrote, and a tuple that will not parse costs a viewer the whole run. The
 * strict gate — unknown keys, `sort` against `order`, duplicate providers — is
 * `parseRouting`, and it runs where a human writes config, not where a file is
 * read back.
 */
export const routingSchema = z.object({
  order: z.array(z.string()).optional(),
  sort: z.enum(ROUTING_SORTS).optional(),
  allowFallbacks: z.boolean(),
  requireParameters: z.boolean().optional(),
});

/** The keys a `routing` block may carry. Anything else is refused by name. */
export const ROUTING_KEYS = ["order", "sort", "allowFallbacks", "requireParameters"] as const;

/**
 * The provider names a model author is served under on OpenRouter, keyed by the
 * author prefix of the slug (`z-ai/glm-5.3` -> `z-ai`).
 *
 * **Every entry here is evidence, not inference.** Each name is one this
 * harness has actually seen OpenRouter report in a response body for a model
 * of that author (the `provider` field on `t:"response"` records, docs/COSTS.md).
 * A prefix is listed only once a run has come back from the author's own
 * endpoint, because the default pins with fallbacks OFF: one wrong string and
 * every run of that model dies at the first request. Google appears twice
 * because both names are Google's own endpoints and either is the lab.
 *
 * An author not listed here gets no `order` — fallbacks still off, but nothing
 * pinned — rather than a guess. `minimax` and `deepseek` are the standing
 * examples: this harness has only ever seen their models served by third
 * parties (DeepInfra, Morph, GMICloud, OpenInference, Relace), so whether the
 * lab has a first-party endpoint at all is not something the trajectories say.
 * Pin those by naming the provider in the entry, which is what the decision
 * asks for anyway: a third party is a named datapoint.
 */
export const LAB_PROVIDERS: Readonly<Record<string, readonly string[]>> = {
  cohere: ["Cohere"],
  google: ["Google", "Google AI Studio"],
  meta: ["Meta"],
  nvidia: ["Nvidia"],
  openai: ["OpenAI"],
  poolside: ["Poolside"],
  "x-ai": ["xAI"],
  "z-ai": ["Z.AI"],
};

/** The author prefix of a slug, or null for a bare id (`omen-alpha`). */
export function authorOf(model: string): string | null {
  const slash = model.indexOf("/");
  if (slash <= 0) return null;
  return model.slice(0, slash).toLowerCase();
}

/** The model author's own provider names, or null when none is known. */
export function labProvidersOf(model: string): string[] | null {
  const author = authorOf(model);
  if (author === null) return null;
  const names = LAB_PROVIDERS[author];
  return names === undefined ? null : [...names];
}

/** Whether an api base is OpenRouter — the one host whose routing this speaks. */
export function isOpenRouterBase(apiBase: string | null | undefined): boolean {
  if (apiBase === null || apiBase === undefined || apiBase === "") return false;
  let host = apiBase;
  try {
    host = new URL(apiBase).hostname;
  } catch {
    /* a malformed base still names a host often enough to match on */
  }
  return host.includes("openrouter.ai");
}

/**
 * Validate a `routing` block, as the file or an edit through the store wrote it.
 *
 * Three spellings, because the common case is one provider: a string, an array
 * of strings, or the full object. `where` names the entry in every error, the
 * way `parseTier` and `parseIdle` do, so a refusal says which line to fix.
 */
export function parseRouting(raw: unknown, where: string): RoutingSpec {
  if (typeof raw === "string" || Array.isArray(raw)) {
    return parseRouting({ order: typeof raw === "string" ? [raw] : raw }, where);
  }
  if (typeof raw !== "object" || raw === null) {
    throw new Error(
      `${where}: routing must be a provider name, a list of them, or an object like { "order": ["Together"], "allowFallbacks": false }`,
    );
  }
  const o = raw as Record<string, unknown>;
  const unknown = Object.keys(o).filter((k) => !(ROUTING_KEYS as readonly string[]).includes(k));
  if (unknown.length > 0) {
    throw new Error(`${where}: routing has unknown key ${unknown.map((k) => `\`${k}\``).join(", ")} — valid keys: ${ROUTING_KEYS.join(", ")}`);
  }
  const out: RoutingSpec = { allowFallbacks: false };
  if (o["order"] !== undefined) {
    if (!Array.isArray(o["order"]) || o["order"].length === 0) {
      throw new Error(`${where}: routing.order must be a non-empty array of provider names`);
    }
    const order: string[] = [];
    for (const v of o["order"] as unknown[]) {
      if (typeof v !== "string" || v.trim().length === 0) {
        throw new Error(`${where}: routing.order entries are provider names as OpenRouter reports them (e.g. "Z.AI", "Together")`);
      }
      const name = v.trim();
      if (order.includes(name)) throw new Error(`${where}: routing.order names ${name} twice`);
      order.push(name);
    }
    out.order = order;
  }
  if (o["sort"] !== undefined) {
    // A sort is the tie-break among providers the request did NOT name. With an
    // order it either says nothing or contradicts it, and a contradiction the
    // harness silently resolves is exactly the silent routing this decision is
    // about.
    if (out.order !== undefined) {
      throw new Error(`${where}: routing.sort and routing.order are alternatives — an order already says which provider comes first`);
    }
    if (typeof o["sort"] !== "string" || !(ROUTING_SORTS as readonly string[]).includes(o["sort"])) {
      throw new Error(`${where}: routing.sort must be one of ${ROUTING_SORTS.join(", ")}`);
    }
    out.sort = o["sort"] as RoutingSort;
  }
  if (o["allowFallbacks"] !== undefined) {
    if (typeof o["allowFallbacks"] !== "boolean") throw new Error(`${where}: routing.allowFallbacks must be true or false`);
    out.allowFallbacks = o["allowFallbacks"];
  }
  if (o["requireParameters"] !== undefined) {
    if (typeof o["requireParameters"] !== "boolean") throw new Error(`${where}: routing.requireParameters must be true or false`);
    out.requireParameters = o["requireParameters"];
  }
  return out;
}

/**
 * The routing a run actually gets: the entry's, else the policy's, else the
 * model author's own provider with fallbacks off.
 *
 * `effort` is what makes `require_parameters` matter. A run declares a
 * reasoning effort as a *dimension of the matrix*, and a backend that quietly
 * drops `reasoning_effort` would put the run in the matrix under a level it
 * never used — the same argument that keeps the adapter from host-gating the
 * field. So an effort run defaults to requiring the parameter, and a provider
 * that cannot honour it is skipped rather than silently ignoring it. Without an
 * effort there is nothing to require, and the key is omitted.
 */
export function resolveRouting(
  declared: RoutingSpec | undefined,
  policy: RoutingSpec | undefined,
  model: string,
  opts: { effort?: string | undefined } = {},
): RoutingSpec {
  const stated = declared ?? policy;
  const order = stated?.order ?? (stated === undefined ? labProvidersOf(model) ?? undefined : undefined);
  const requireParameters = stated?.requireParameters ?? (opts.effort !== undefined ? true : undefined);
  return {
    ...(order !== undefined ? { order } : {}),
    ...(stated?.sort !== undefined && order === undefined ? { sort: stated.sort } : {}),
    allowFallbacks: stated?.allowFallbacks ?? false,
    ...(requireParameters !== undefined ? { requireParameters } : {}),
  };
}

/** The `provider` object an OpenRouter chat request carries, in its spelling. */
export function providerBodyOf(routing: RoutingSpec): Record<string, unknown> {
  return {
    ...(routing.order !== undefined ? { order: routing.order } : {}),
    ...(routing.sort !== undefined ? { sort: routing.sort } : {}),
    allow_fallbacks: routing.allowFallbacks,
    ...(routing.requireParameters !== undefined ? { require_parameters: routing.requireParameters } : {}),
  };
}

/** A one-line rendering for `--status` and refusal messages. */
export function routingLabel(routing: RoutingSpec): string {
  const who = routing.order !== undefined ? routing.order.join(" > ") : routing.sort !== undefined ? `by ${routing.sort}` : "provider default";
  return `${who}${routing.allowFallbacks ? " (fallbacks on)" : ""}${routing.requireParameters === true ? " (requires parameters)" : ""}`;
}

/**
 * The routing a run will actually be sent with, or null when its endpoint has
 * no routing to state.
 *
 * One function so the adapter and the comparability tuple cannot disagree:
 * what the tuple stamps is what the wire carries. Null — not an "unrouted"
 * spec — for a claude-code, codex, LM Studio, Cerebras or OpenCode Zen run,
 * because those have exactly one backend and a field claiming otherwise would
 * be a fabricated fact. The tuple omits the field entirely for those, which is
 * also what keeps every non-OpenRouter run stamping the way it always did.
 */
export function routingForRun(
  run: {
    apiBase?: string | undefined;
    model?: string | undefined;
    effort?: string | undefined;
    routing?: RoutingSpec | undefined;
  },
  policy?: RoutingSpec | undefined,
): RoutingSpec | null {
  if (!isOpenRouterBase(run.apiBase) || run.model === undefined) return null;
  return resolveRouting(run.routing, policy, run.model, { effort: run.effort });
}
