/**
 * What is being tested: the subject kind, and how a local build is served.
 *
 * The operator's decision (2026-11-14), on #407's "describing what is being
 * tested":
 *
 * - **A subject kind**, `hosted`, `local` or `external`. A hosted model is
 *   reached on its provider's endpoint (or an aggregator's, whose routing the
 *   tuple already keys). A local build is served by a box the operator runs.
 *   An external subject is an agent loop that is not ours (the `external`
 *   harness).
 * - **A `serving` key for a local build**: the weights (a repository or model
 *   name, never a file path), the quantisation and the runtime. Declared on the
 *   roster entry and stamped at launch, it keys the tuple the way `routing`
 *   does for an aggregator, so a quantised local build and the hosted model of
 *   the same id never share a row. A local entry without one is refused: an
 *   unstated local build cannot be launched.
 * - **Labels, never keys and never published**: the machine and the runtime's
 *   own version (`servingLabels`). A key nobody else can reproduce would
 *   fragment rows without telling a reader anything.
 * - **Annotations**: what the server reports it served (`resolved.model`, as
 *   for any provider) and the observed generation rate, which the viewer
 *   derives from the run's own request and response records (`TpsFacts`).
 *
 * Pure, and import-light: the roster's refusal, the fleet's parser, the runner
 * and the viewer all read it.
 */

import { z } from "zod";

export const SUBJECT_KINDS = ["hosted", "local", "external"] as const;
export type SubjectKind = (typeof SUBJECT_KINDS)[number];

/** A local build as the roster states it and the tuple stamps it. */
export interface ServingSpec {
  /** The weights: a repository or model name (`Qwen/Qwen3.8-27B-GGUF`), never a path. */
  weights: string;
  /** The quantisation (`Q4_K_M`, `MLX 4-bit`, `bf16`). */
  quant: string;
  /** The runtime that serves it (`LM Studio`, `llama.cpp`, `vLLM`). */
  runtime: string;
}

/** The machine and the runtime's version: labels a run carries in its config, never a key and never public. */
export interface ServingLabels {
  machine?: string;
  runtimeVersion?: string;
}

export const SERVING_KEYS = ["weights", "quant", "runtime"] as const;
export const SERVING_LABEL_KEYS = ["machine", "runtimeVersion"] as const;

/**
 * The stored shape, for the tuple and the run config. Looser than
 * `parseServing` for the reason `routingSchema` is: it reads what a build
 * wrote, and a tuple that will not parse costs a viewer the whole run.
 */
export const servingSchema = z.object({ weights: z.string(), quant: z.string(), runtime: z.string() });
export const servingLabelsSchema = z.object({ machine: z.string().optional(), runtimeVersion: z.string().optional() });

/**
 * An external agent as its operator declares it: name and version, each null
 * when not stated. A key of the `external` harness's group, which is never
 * ranked with ours (operator, 2026-11-14).
 */
export const agentSchema = z.object({ name: z.string().nullable(), version: z.string().nullable() });
export type AgentSpec = z.infer<typeof agentSchema>;

const MAX_FIELD = 120;

/** Whether a weights name reads as a filesystem path rather than a repository or model name. */
function looksLikePath(s: string): boolean {
  return /^[~./\\]/.test(s) || s.includes("\\") || /^[A-Za-z]:/.test(s) || s.includes("//") || /\.(gguf|safetensors|bin|pt)$/i.test(s);
}

function field(raw: Record<string, unknown>, key: string, where: string): string {
  const v = raw[key];
  if (typeof v !== "string" || v.trim().length === 0) throw new Error(`${where}: serving.${key} must be a non-empty string`);
  if (v.length > MAX_FIELD) throw new Error(`${where}: serving.${key} is longer than ${MAX_FIELD} characters`);
  return v.trim();
}

/**
 * The strict gate, where a person writes config: exactly the three keys, each
 * a non-empty string, and weights a name rather than a path (a path is the
 * operator's disk, and every stamped field may be published).
 */
export function parseServing(raw: unknown, where: string): ServingSpec {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`${where}: serving must be an object { weights, quant, runtime }`);
  }
  const o = raw as Record<string, unknown>;
  const unknown = Object.keys(o).filter((k) => !(SERVING_KEYS as readonly string[]).includes(k));
  if (unknown.length > 0) {
    const hint = unknown.some((k) => (SERVING_LABEL_KEYS as readonly string[]).includes(k)) ? " (the machine and the runtime version are servingLabels, never a key)" : "";
    throw new Error(`${where}: serving has unknown key ${unknown.map((k) => `\`${k}\``).join(", ")}${hint}; it takes ${SERVING_KEYS.join(", ")}`);
  }
  const weights = field(o, "weights", where);
  if (looksLikePath(weights)) {
    throw new Error(`${where}: serving.weights names a file path (${weights}); state the repository or model name the weights were published under`);
  }
  return { weights, quant: field(o, "quant", where), runtime: field(o, "runtime", where) };
}

/** The labels block, as strict as `parseServing`. */
export function parseServingLabels(raw: unknown, where: string): ServingLabels {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`${where}: servingLabels must be an object { machine?, runtimeVersion? }`);
  }
  const o = raw as Record<string, unknown>;
  const unknown = Object.keys(o).filter((k) => !(SERVING_LABEL_KEYS as readonly string[]).includes(k));
  if (unknown.length > 0) throw new Error(`${where}: servingLabels has unknown key ${unknown.map((k) => `\`${k}\``).join(", ")}; it takes ${SERVING_LABEL_KEYS.join(", ")}`);
  const out: ServingLabels = {};
  for (const k of SERVING_LABEL_KEYS) {
    const v = o[k];
    if (v === undefined) continue;
    if (typeof v !== "string" || v.trim().length === 0 || v.length > MAX_FIELD) {
      throw new Error(`${where}: servingLabels.${k} must be a non-empty string of at most ${MAX_FIELD} characters`);
    }
    out[k] = v.trim();
  }
  return out;
}

/** "Q4_K_M · LM Studio" — how a row names its build beside the model. */
export function servingLabel(s: Pick<ServingSpec, "quant" | "runtime">): string {
  return `${s.quant} · ${s.runtime}`;
}

/** Why a local entry or launch is refused for stating no build. */
export const LOCAL_WITHOUT_SERVING =
  "a local model states what it serves: serving { weights, quant, runtime } (operator, 2026-11-14) — an unstated local build would share a row with the hosted model of the same id";

/** Why a serving block on a hosted entry is refused: a hosted backend is its routing's to state. */
export const SERVING_OFF_LOCAL =
  "serving describes a local build; this entry is hosted, and a hosted backend is stated by its routing, not by serving";
