/**
 * Credentials with slots: the one answer to "can this run start now, and on
 * what" (Shard/WrathBench#429).
 *
 * The scarce things a run spends are a provider credential and a game
 * account, so those are what the fleet models. A credential is one provider
 * secret — an OpenRouter key, a Claude subscription token, a Codex home (a
 * ChatGPT login), an OpenCode key — and carries:
 *
 * - **slots**: how many runs may be live on it at once;
 * - **a budget**: the limit on its total use per window. A subscription's is
 *   its usage window (`usage`: hold new starts at a share of it, as the
 *   subscription usage gate did); a key the provider reports spend for can
 *   have spend per day (`spend`); anything can have runs per day (`runs`);
 *   none is no limit beyond the slots;
 * - **billing**: free or paid. On a metered provider it says which models the
 *   credential carries — a free key only models whose billing verdict is free,
 *   a paid key only paid ones (`credentialCarries`) — so a free tier's shared
 *   key and a paid key are two credentials even when one secret serves both.
 *   On a subscription every model bills the subscription and it is
 *   descriptive. It never reaches a run's recorded billing, the price table or
 *   a ladder (`billingOf` and `runBilling` are the model's and the run's);
 * - **enabled**.
 *
 * The store holds where the secret lives, never the secret: `secretEnv` is the
 * NAME of the env var holding it (for a Codex home, the var naming the
 * directory), and it must be its provider's own name or that name with a
 * numbered suffix (`CLAUDE_CODE_OAUTH_TOKEN_2`, `OPENROUTER_KEY_2`), so a value
 * pasted where a name belongs is refused by shape, and a key name still goes
 * only where its provider's key goes (`keyProviderOf`, providers.ts).
 *
 * A credential is a plain record keyed by its id (`credentials/<id>` in the
 * config store, in preference order). Nothing here assumes one operator owns
 * every record: which credentials a pick may take is asked in exactly one
 * place, `credentialCandidates`, which is where an owner filter would plug in.
 */

import { z } from "zod";
import { DEFAULT_CLAUDE_TOKEN_ENV, DEFAULT_CODEX_HOME_ENV, DEFAULT_DRIVER, driverEntry } from "./drivers";
import { billingOf, isLocalBase, type Billing } from "./model-cost";
import { hostOfBase, isOpenCodeGoBase } from "./platform";
import { apiKeyRefusal, DEFAULT_API_BASE, KEY_PROVIDERS, localModelHosts, piProviderOf } from "./providers";

// ------------------------------------------------------------------ providers

/** A budget's kind (`Budget`). */
export const BUDGET_KINDS = ["usage", "spend", "runs"] as const;
export type BudgetKind = (typeof BUDGET_KINDS)[number];

/** What a credential's provider is and which budgets mean something on it. */
export interface CredentialProvider {
  id: string;
  /** For the operator's lines. */
  label: string;
  /**
   * `subscription`: a flat plan every model on it bills, so `billing` only
   * describes the credential. `metered`: per call, so `billing` decides which
   * models the credential carries (`credentialCarries`).
   */
  bill: "subscription" | "metered";
  /** The env var NAME its secret lives in: this, or this with a numbered suffix. */
  envBase: string;
  /** What the var holds: a secret token or key, or a Codex home directory's path. */
  holds: "token" | "home" | "key";
  /**
   * The budgets it can be held to: `usage` where a reader reports its usage
   * windows (the CLIs, OpenCode Go's endpoint), `spend` where its responses
   * carry the provider's own charge (OpenRouter), `runs` everywhere.
   */
  budgets: readonly BudgetKind[];
}

const keyRow = (keyEnv: string) => KEY_PROVIDERS.find((p) => p.keyEnv === keyEnv)!;

/**
 * Every provider a credential may name. A new one is a row here (and, for an
 * endpoint, a row in `KEY_PROVIDERS`), reviewed like any other code — never
 * config. Order is the operator's lines' order.
 */
export const CREDENTIAL_PROVIDERS: readonly CredentialProvider[] = [
  { id: "claude", label: "Claude subscription", bill: "subscription", envBase: DEFAULT_CLAUDE_TOKEN_ENV, holds: "token", budgets: ["usage", "runs"] },
  { id: "chatgpt", label: "ChatGPT subscription (a Codex home)", bill: "subscription", envBase: DEFAULT_CODEX_HOME_ENV, holds: "home", budgets: ["usage", "runs"] },
  { id: "openrouter", label: "OpenRouter", bill: "metered", envBase: keyRow("OPENROUTER_KEY").keyEnv, holds: "key", budgets: ["spend", "runs"] },
  { id: "opencode", label: "OpenCode Zen", bill: "metered", envBase: keyRow("OPENCODE_KEY").keyEnv, holds: "key", budgets: ["runs"] },
  { id: "opencode-go", label: "OpenCode Go", bill: "metered", envBase: keyRow("OPENCODE_KEY").keyEnv, holds: "key", budgets: ["usage", "runs"] },
  { id: "cerebras", label: "Cerebras", bill: "metered", envBase: keyRow("CEREBRAS_KEY").keyEnv, holds: "key", budgets: ["runs"] },
  { id: "deepseek", label: "DeepSeek", bill: "metered", envBase: keyRow("DEEPSEEK_KEY").keyEnv, holds: "key", budgets: ["runs"] },
  { id: "local", label: "the self-hosted model server", bill: "metered", envBase: keyRow("LMSTUDIO_KEY").keyEnv, holds: "key", budgets: ["runs"] },
];

export const PROVIDER_IDS = CREDENTIAL_PROVIDERS.map((p) => p.id) as [string, ...string[]];

export function providerById(id: string): CredentialProvider | undefined {
  return CREDENTIAL_PROVIDERS.find((p) => p.id === id);
}

/** Whether `name` is a var a credential of `provider` may name: its own, or that with a numbered suffix. */
export function isProviderEnvName(provider: CredentialProvider, name: string): boolean {
  return new RegExp(`^${provider.envBase}(_[0-9]+)?$`).test(name);
}

/**
 * The provider a roster entry's (or a run's) model is served through, or null
 * for a run that needs no credential (the scripted stub and reference). A CLI
 * subscription by its driver; an endpoint by its api base's host, matched
 * exactly (`hostOfBase`), with OpenCode Go told apart from Zen by its path. A
 * base no cloud row owns is the self-hosted server when it is on the LAN or a
 * host the deployment lists (`WRATHBENCH_LOCAL_MODEL_HOSTS`), else no provider.
 */
export function providerOfModel(
  m: { driver?: string | null | undefined; apiBase?: string | null | undefined },
  env: Record<string, string | undefined> = process.env,
): string | null {
  const driver = driverEntry(m.driver ?? DEFAULT_DRIVER);
  if (driver === undefined) return null;
  // A CLI subscription driver bills the provider whose secret its CLI reads.
  const cli = driver.credential;
  if (cli !== undefined) return CREDENTIAL_PROVIDERS.find((p) => p.bill === "subscription" && p.envBase === cli.defaultEnv)?.id ?? null;
  if (driver.endpoint !== true) return null;
  const base = m.apiBase ?? DEFAULT_API_BASE;
  const host = hostOfBase(base);
  if (host === null) return null;
  if (host === "opencode.ai") return isOpenCodeGoBase(base) ? "opencode-go" : "opencode";
  const row = KEY_PROVIDERS.find((p) => p.hosts.includes(host));
  if (row !== undefined) return CREDENTIAL_PROVIDERS.find((p) => p.holds === "key" && p.envBase === row.keyEnv)?.id ?? null;
  let port = "";
  try {
    port = new URL(base).host.toLowerCase();
  } catch {
    // hostOfBase already parsed it
  }
  if (isLocalBase(base) || localModelHosts(env).some((h) => h === host || h === port)) return "local";
  return null;
}

/**
 * Why a roster entry's endpoint cannot be served by any credential, or null.
 * Only an endpoint driver (openai, pi) reaches a base; a CLI subscription's
 * provider is its driver's. The entry names a base and never a key: the key
 * is its credential's (`secretEnv`), which is its provider's own name, so the
 * base must be a host one of the provider table's rows owns — a self-hosted
 * one only where the deployment lists it — and is checked here as the
 * credential's key would be sent to it (`apiKeyRefusal`). A driver that
 * reaches the base through its CLI's own provider (`cliProvider`, pi) also
 * needs one named on that row, or every launch would fail.
 */
export function rosterProviderRefusal(e: { driver?: unknown; apiBase?: unknown }, env: Record<string, string | undefined> = process.env): string | null {
  const driver = driverEntry(e.driver ?? DEFAULT_DRIVER);
  if (driver?.endpoint !== true) return null;
  if (e.apiBase !== undefined && typeof e.apiBase !== "string") return "apiBase must be a URL";
  const base = (e.apiBase as string | undefined) ?? DEFAULT_API_BASE;
  const provider = providerOfModel({ driver: driver.id, apiBase: base }, env);
  if (provider === null) {
    return `apiBase ${hostOfBase(base) ?? base} is no credential provider's host (${KEY_PROVIDERS.flatMap((p) => p.hosts).join(", ")}, or a self-hosted host the deployment lists) — a new provider is a row in runner/src/providers.ts and runner/src/credentials.ts`;
  }
  const keyEnv = providerById(provider)!.envBase;
  const pair = apiKeyRefusal(keyEnv, base, env);
  if (pair !== null) return pair;
  if (driver.cliProvider === true) {
    const pi = piProviderOf(keyEnv);
    if ("refusal" in pi) return pi.refusal;
  }
  return null;
}

// ------------------------------------------------------------------ the record

const pct = z.number().gt(0).lte(100);

/**
 * The budget, by kind. Every kind holds only NEW starts and resumes; the one
 * thing that also pauses a live run is a subscription's freeplay threshold,
 * which is what the usage gate always did (docs/RUNBOOK.md, "Credentials").
 *
 * - `usage` — the subscription's usage windows. A scored run does not start
 *   while any window is at or over `scoredMaxPct`; a freeplay run does not
 *   start or resume at or over `freeplayMaxPct`, and a live one pauses at its
 *   next turn boundary. Both default 80; 100 turns that one off. A window at
 *   100% holds every launch, probes included, until it resets, whatever the
 *   two say. A credential billing a plan with usage windows (a subscription,
 *   OpenCode Go's paid side) whose row names no budget gets this one at its
 *   defaults.
 * - `spend` — the provider's own reported charge on this credential's runs
 *   since 00:00 UTC, in dollars.
 * - `runs` — launches on this credential since 00:00 UTC, each segment a
 *   resume starts included.
 */
export const budgetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("usage"), scoredMaxPct: pct.optional(), freeplayMaxPct: pct.optional() }).strict(),
  z.object({ kind: z.literal("spend"), usdPerDay: z.number().positive() }).strict(),
  z.object({ kind: z.literal("runs"), perDay: z.number().int().positive() }).strict(),
]);

/** One credential row as written (`credentials/<id>`): the shape a GUI edits. */
export const credentialRowSchema = z
  .object({
    provider: z.enum(PROVIDER_IDS),
    /** The NAME of the env var holding the secret (a Codex home: the var naming the directory). Never the secret. */
    secretEnv: z.string(),
    slots: z.number().int().min(1).max(64),
    budget: budgetSchema.optional(),
    billing: z.enum(["free", "paid"]),
    enabled: z.boolean(),
  })
  .strict()
  .superRefine((row, ctx) => {
    const p = providerById(row.provider)!;
    if (!isProviderEnvName(p, row.secretEnv)) {
      ctx.addIssue({
        code: "custom",
        path: ["secretEnv"],
        message: `must be the NAME of the env var holding the ${p.label} ${p.holds === "home" ? "home's path" : "secret"} — ${p.envBase}, or ${p.envBase}_<n> for another — never the secret itself`,
      });
    }
    if (row.budget !== undefined && !p.budgets.includes(row.budget.kind)) {
      ctx.addIssue({
        code: "custom",
        path: ["budget", "kind"],
        message: `a ${p.label} credential's budget is one of ${p.budgets.join(", ")}, not ${row.budget.kind}`,
      });
    }
  });

export type CredentialRow = z.infer<typeof credentialRowSchema>;

/** The budget with its defaults filled. */
export type Budget =
  | { kind: "usage"; scoredMaxPct: number; freeplayMaxPct: number }
  | { kind: "spend"; usdPerDay: number }
  | { kind: "runs"; perDay: number };

/** A credential as the scheduler reads it. */
export interface Credential {
  id: string;
  provider: string;
  secretEnv: string;
  slots: number;
  budget: Budget | null;
  billing: Billing;
  enabled: boolean;
}

/** Both usage thresholds' default (operator, 2026-10-16). */
export const DEFAULT_USAGE_MAX_PCT = 80;

/** A credential id: what a run records, an argv carries and a store key ends in. */
export function isCredentialId(id: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(id);
}

function issuesOf(error: z.ZodError): string {
  return error.issues.map((i) => `${i.path.length > 0 ? `${i.path.join(".")}: ` : ""}${i.message}`).join("; ");
}

/**
 * The `credentials` block (`{ <id>: row }`, in preference order) as the
 * scheduler reads it. Throws with the row's key on the first row that does
 * not read: a credential is shape, like a roster entry, and the store refuses
 * the write before it lands.
 *
 * Two credentials naming one secret are refused unless that is the free/paid
 * split of a metered key: two records on one subscription would split its
 * slots and its usage readings between two ids.
 */
export function parseCredentials(raw: unknown): Credential[] {
  if (raw === undefined) return [];
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error("credentials must be an object of id -> credential");
  const out: Credential[] = [];
  for (const [id, row] of Object.entries(raw as Record<string, unknown>)) {
    if (!isCredentialId(id)) throw new Error(`credentials: id ${JSON.stringify(id)} must be [A-Za-z0-9._-], at most 64 characters, starting with a letter or digit`);
    const parsed = credentialRowSchema.safeParse(row);
    if (!parsed.success) {
      throw new Error(
        `credentials/${id}: ${issuesOf(parsed.error)} — a credential is { provider, secretEnv, slots, budget?, billing, enabled }`,
      );
    }
    const r = parsed.data;
    const p = providerById(r.provider)!;
    const same = out.find((c) => c.provider === r.provider && c.secretEnv === r.secretEnv && (p.bill === "subscription" || c.billing === r.billing));
    if (same !== undefined) {
      throw new Error(
        `credentials/${id}: ${r.secretEnv} is already credentials/${same.id}'s${p.bill === "metered" ? ` (${r.billing})` : ""} — one credential per secret; raise its slots instead`,
      );
    }
    // A credential that bills a plan with usage windows (a subscription, OpenCode
    // Go's paid side) gets the usage budget at its defaults when the row names
    // none (operator, 2026-11-11); `usage` at 100/100 or another kind is the
    // way out of it. Go's free side bills no plan, so it gets none.
    const budget: Budget | null =
      r.budget === undefined
        ? p.budgets.includes("usage") && (p.bill === "subscription" || r.billing === "paid")
          ? { kind: "usage", scoredMaxPct: DEFAULT_USAGE_MAX_PCT, freeplayMaxPct: DEFAULT_USAGE_MAX_PCT }
          : null
        : r.budget.kind === "usage"
          ? { kind: "usage", scoredMaxPct: r.budget.scoredMaxPct ?? DEFAULT_USAGE_MAX_PCT, freeplayMaxPct: r.budget.freeplayMaxPct ?? DEFAULT_USAGE_MAX_PCT }
          : r.budget;
    out.push({ id, provider: r.provider, secretEnv: r.secretEnv, slots: r.slots, budget, billing: r.billing, enabled: r.enabled });
  }
  return out;
}

// ------------------------------------------------------------------ matching

/**
 * Whether a credential carries a model of this billing verdict: any model on a
 * subscription, the matching side on a metered key.
 */
export function credentialCarries(c: Pick<Credential, "provider" | "billing">, modelBilling: Billing): boolean {
  const p = providerById(c.provider);
  return p !== undefined && (p.bill === "subscription" || c.billing === modelBilling);
}

/** What `credentialCandidates` is asked about: a roster entry, or a run's own config. */
export interface CredentialSeeker {
  model: string;
  driver?: string | null | undefined;
  apiBase?: string | null | undefined;
  /** The entry's billing override (`roster.<name>.billing`); absent: derived. */
  billing?: Billing | null | undefined;
}

/**
 * The credentials a pick may take, in preference order, or why there are none.
 * The ONE place the question is asked: the supervisor's placement, the
 * dry-run, the status table and a resume's check all come through here, so a
 * filter on who owns a credential is one more condition in this function.
 *
 * `pin` is a roster entry's, queue job's or campaign's `credential`: the pick
 * takes that one or waits for it, never another.
 */
export function credentialCandidates(
  credentials: readonly Credential[],
  m: CredentialSeeker,
  opts: { pin?: string | undefined; env?: Record<string, string | undefined> } = {},
): { provider: string | null; candidates: Credential[]; why?: string } {
  const provider = providerOfModel(m, opts.env);
  if (provider === null) return { provider, candidates: [] };
  const billing = billingOf({ model: m.model, apiBase: m.apiBase ?? null, driver: m.driver ?? null, ...(m.billing != null ? { billing: m.billing } : {}) });
  const label = providerById(provider)?.label ?? provider;
  if (opts.pin !== undefined) {
    const c = credentials.find((x) => x.id === opts.pin);
    if (c === undefined) return { provider, candidates: [], why: `pinned credential ${opts.pin} is not configured` };
    if (c.provider !== provider) return { provider, candidates: [], why: `pinned credential ${opts.pin} is ${c.provider}'s, and this model is served by ${provider}` };
    if (!credentialCarries(c, billing)) return { provider, candidates: [], why: `pinned credential ${opts.pin} is ${c.billing}, and this model is ${billing}` };
    if (!c.enabled) return { provider, candidates: [], why: `pinned credential ${opts.pin} is disabled` };
    return { provider, candidates: [c] };
  }
  const candidates = credentials.filter((c) => c.enabled && c.provider === provider && credentialCarries(c, billing));
  if (candidates.length > 0) return { provider, candidates };
  const metered = providerById(provider)?.bill === "metered";
  return { provider, candidates, why: `no enabled ${label} credential${metered ? ` carries ${billing} models` : ""} — add one under credentials` };
}

/** The operator's one-line description of a budget. */
export function describeBudget(b: Budget | null): string {
  if (b === null) return "no budget";
  if (b.kind === "usage") return b.scoredMaxPct === b.freeplayMaxPct ? `usage < ${b.scoredMaxPct}%` : `usage < ${b.scoredMaxPct}% scored, ${b.freeplayMaxPct}% freeplay`;
  if (b.kind === "spend") return `$${b.usdPerDay}/day`;
  return `${b.perDay} runs/day`;
}

/**
 * What paid for a run, as its launch config recorded it: a v1 run's
 * credential id (`RunConfig.credential`), or a 0.5 run's subscription lane —
 * the env var NAME a claude-code or codex run billed (`RunConfig.subscription`),
 * which v1 reads and never writes. Empty when the run recorded neither (a 0.5
 * run on the default lane or an endpoint, a run launched by hand). Only the
 * fields recorded are present, so a reader of an old run sees what it saw.
 */
export function runCredentialOf(config: unknown): { credential?: string; lane?: string } {
  if (typeof config !== "object" || config === null) return {};
  const c = config as { credential?: unknown; subscription?: unknown };
  return {
    ...(typeof c.credential === "string" && c.credential.length > 0 ? { credential: c.credential } : {}),
    ...(typeof c.subscription === "string" && c.subscription.length > 0 ? { lane: c.subscription } : {}),
  };
}
