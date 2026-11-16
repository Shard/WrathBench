/**
 * A roster entry's providers: one model, served by more than one provider
 * (operator, 2026-11-16). "I don't think we need to have separate models for
 * different providers when they're literally the same model and version but
 * just different serving infra": one entry per model, with an ordered list of
 * where it may run.
 *
 * An entry with `providers` names each provider by the credential that pays
 * for it, and per provider the base it is served from, the id that provider
 * knows the model by and, on OpenRouter, the routing. Order is preference:
 * a launch takes the first provider whose credential is enabled, under its
 * gate and with a slot (`placeRef`, infra/run-fleet-credentials.ts). A run
 * records the provider it used — its credential, base, model id and routing —
 * exactly as a single-provider entry's run always has. A paused run comes back
 * only on the provider it started on (`placeResume`).
 *
 * An entry without the list is a single-provider entry, as every entry was
 * before: its `model`, `apiBase`, `credential` and `routing` are that one
 * provider, and nothing about it changes. With the list those four live in
 * the options, and the parser sets the entry's own `model`, `apiBase` and
 * `routing` from the first, so a reader that knows one provider reads the
 * preferred one.
 *
 * Pure, and free of the fleet's config module so the viewer and the
 * scheduler read it alike.
 */

import type { RoutingSpec } from "./routing";

/** The keys one provider option may carry. */
export const PROVIDER_OPTION_KEYS = ["credential", "apiBase", "model", "routing"] as const;

/** One provider of an entry's model, as the parser leaves it: its model id always stated. */
export interface ProviderOption {
  /** The credential that pays for it (`credentials/<id>`): the option's identity, unique in the list. */
  credential: string;
  /** The base it is served from; absent is the driver's default (OpenRouter on the openai driver). */
  apiBase?: string;
  /** The id this provider knows the model by: the entry's `model` when the option states none. */
  model: string;
  /** OpenRouter only: which backend may serve it (`routing.ts`). */
  routing?: RoutingSpec;
}

/** What an entry is, for the readers here: its own model and, when it has them, its providers. */
export interface WithProviders {
  model: string | null;
  providers?: readonly { model?: string | undefined }[] | undefined;
}

/**
 * Every model id an entry's runs may record: each provider's, in order, or
 * the entry's own when it lists none. What owns a run (`entryOwnsRun`).
 */
export function entryModelIds(entry: WithProviders): string[] {
  if (entry.providers === undefined || entry.providers.length === 0) return entry.model === null ? [] : [entry.model];
  return [...new Set(entry.providers.map((p) => p.model ?? entry.model).filter((m): m is string => m !== null))];
}

/** The option a credential names, or undefined: how a placement or a recorded run maps back to its provider. */
export function optionOf<O extends { credential: string }>(providers: readonly O[] | undefined, credential: string | null | undefined): O | undefined {
  if (providers === undefined || credential === null || credential === undefined) return undefined;
  return providers.find((p) => p.credential === credential);
}

/**
 * The entry as one provider serves it: the option's model, base and routing in
 * place of the entry's own, and no list. What a placement checks and a launch
 * spawns.
 */
export function asProvider<E extends { model: string; apiBase?: string | undefined; routing?: RoutingSpec | undefined; providers?: unknown; credential?: string | undefined }>(
  entry: E,
  option: ProviderOption,
): Omit<E, "providers"> {
  const { providers: _providers, apiBase: _apiBase, routing: _routing, ...rest } = entry;
  return {
    ...rest,
    model: option.model,
    credential: option.credential,
    ...(option.apiBase !== undefined ? { apiBase: option.apiBase } : {}),
    ...(option.routing !== undefined ? { routing: option.routing } : {}),
  } as Omit<E, "providers">;
}
