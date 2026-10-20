/**
 * Which model-provider key may be sent to which host.
 *
 * An openai-driver run names an `apiBase` and the NAME of the env var holding
 * its key (`apiKeyEnv`); the runner reads that variable and sends its value as
 * a bearer to `${apiBase}/chat/completions`. Both fields are config, and the
 * config is edited through the viewer. Left unchecked, the pair is a way to
 * send any variable the runner holds — a subscription token, the module's port
 * secret, another provider's key — to any host that asks for it. This table is
 * what removes that: a key name is usable only when it is listed here, and only
 * towards the hosts listed beside it.
 *
 * The cloud rows are code, changed in review like any other. The self-hosted
 * row (an OpenAI-compatible server on the operator's own network) has no host
 * that could be checked in, so its hosts come from deploy-time configuration —
 * `LOCAL_MODEL_HOSTS_ENV`, set by the chart value `localModelHosts` or by
 * `.env` — and never from the config store, which is the thing being guarded.
 * The key NAMES are never configurable.
 *
 * One function, three places: where a roster entry is parsed (`parseFleet`
 * refuses the entry by name and schedules nothing under it), where the config
 * store writes (`ConfigStore.put` and `seed` refuse the write), and at launch
 * (`run.ts` refuses to start, and the adapter refuses to be built with a pair
 * the table does not hold).
 */

import { DEFAULT_DRIVER, driverEntry } from "./drivers";

/** One provider: the env var holding its key, and where that key may go. */
export interface KeyProvider {
  /** The env var holding the key. A name, never a value. */
  readonly keyEnv: string;
  /** For refusal text only. */
  readonly provider: string;
  /** Exact hostnames the key may be sent to, over https. Empty for the self-hosted row. */
  readonly hosts: readonly string[];
  /** The self-hosted row: hosts come from `LOCAL_MODEL_HOSTS_ENV`, and plain http is allowed. */
  readonly local?: true;
  /**
   * The pi CLI's own provider id for this endpoint (`adapter-pi.ts`): the pi
   * driver points that built-in provider at the run's `apiBase` and keeps the
   * model metadata — context window, output cap, request quirks — from pi's
   * pinned catalogue, so the repository keeps no per-model table. Absent: the
   * pi driver does not run on this provider. Earned per provider, by a run
   * that needs it.
   */
  readonly piProvider?: string;
}

/**
 * The deploy-time list of self-hosted model hosts, `host` or `host:port`,
 * separated by commas or whitespace. Empty or unset means this deployment has
 * none, and the self-hosted key goes nowhere.
 */
export const LOCAL_MODEL_HOSTS_ENV = "WRATHBENCH_LOCAL_MODEL_HOSTS";

/** Every provider key a run may name, and the only hosts each may be sent to. */
export const KEY_PROVIDERS: readonly KeyProvider[] = [
  { keyEnv: "OPENROUTER_KEY", provider: "OpenRouter", hosts: ["openrouter.ai"] },
  // Every OpenCode gateway is on the one host: Zen and Go, under `/inference/` and the older `/zen/`.
  { keyEnv: "OPENCODE_KEY", provider: "OpenCode", hosts: ["opencode.ai"] },
  { keyEnv: "CEREBRAS_KEY", provider: "Cerebras", hosts: ["api.cerebras.ai"] },
  // pi's `deepseek` provider: the #257 campaign's endpoint (operator, 2026-10-20).
  { keyEnv: "DEEPSEEK_KEY", provider: "DeepSeek", hosts: ["api.deepseek.com"], piProvider: "deepseek" },
  { keyEnv: "LMSTUDIO_KEY", provider: "the self-hosted model server", hosts: [], local: true },
];

/** What an openai-driver run uses when it states no base and no key name. */
export const DEFAULT_API_BASE = "https://openrouter.ai/api/v1";
export const DEFAULT_API_KEY_ENV = "OPENROUTER_KEY";

/**
 * Names that are never a model provider's key, whatever the table says: the
 * subscription lanes, the harness's own secrets, and the infrastructure
 * credentials (database, derived store, object storage, CDN). Checked first so
 * the refusal says why, and pinned by a test against the table, so a row for
 * one of these can never be added by mistake.
 */
export const NEVER_A_PROVIDER_KEY: readonly RegExp[] = [
  /^CLAUDE_CODE_/,
  /^ANTHROPIC_/,
  /^CODEX_/,
  /^WRATHBENCH_/,
  /^AC_/,
  /^MYSQL_/,
  /DB_/,
  /^CLICKHOUSE_/,
  /^S3_/,
  /^AWS_/,
  /^R2_/,
  /^CF_/,
  /^CLOUDFLARE_/,
];

/** The self-hosted hosts this deployment allows, lowercased. */
export function localModelHosts(env: Record<string, string | undefined> = process.env): string[] {
  const raw = env[LOCAL_MODEL_HOSTS_ENV];
  if (raw === undefined) return [];
  return raw
    .split(/[\s,]+/)
    .map((h) => h.trim().toLowerCase())
    .filter((h) => h.length > 0);
}

/**
 * Why the key in `keyEnv` may not be sent to `apiBase`, or null when the table
 * allows it. The text names the variable and the host, never a value.
 */
export function apiKeyRefusal(
  keyEnv: string,
  apiBase: string | undefined,
  env: Record<string, string | undefined> = process.env,
): string | null {
  if (NEVER_A_PROVIDER_KEY.some((re) => re.test(keyEnv))) {
    return `apiKeyEnv ${keyEnv} names a harness or infrastructure credential, never a model provider's key`;
  }
  const row = KEY_PROVIDERS.find((p) => p.keyEnv === keyEnv);
  if (row === undefined) {
    return (
      `apiKeyEnv ${keyEnv} is not a provider key this harness sends anywhere ` +
      `(one of: ${KEY_PROVIDERS.map((p) => p.keyEnv).join(", ")}) — a new provider is a row in runner/src/providers.ts`
    );
  }
  if (apiBase === undefined || apiBase.trim().length === 0) return `${keyEnv} has no apiBase to be sent to`;
  let url: URL;
  try {
    url = new URL(apiBase);
  } catch {
    return `apiBase ${apiBase} is not a URL`;
  }
  // Not echoed: a base carrying a password is the one string not to repeat.
  if (url.username !== "" || url.password !== "") return "apiBase must not carry a user or password";
  if (row.local === true) {
    if (url.protocol !== "http:" && url.protocol !== "https:") return `apiBase ${apiBase} is not http or https`;
    const allowed = localModelHosts(env);
    if (allowed.length === 0) {
      return `${keyEnv} is ${row.provider}'s key, and this deployment names no self-hosted model host (${LOCAL_MODEL_HOSTS_ENV})`;
    }
    const host = url.host.toLowerCase();
    const hostname = url.hostname.toLowerCase();
    if (!allowed.some((a) => a === host || a === hostname)) {
      return `${keyEnv} may be sent only to a host ${LOCAL_MODEL_HOSTS_ENV} lists, and ${url.host} is not one`;
    }
    return null;
  }
  if (url.protocol !== "https:") return `${keyEnv} is sent over https only, and ${apiBase} is not https`;
  if (!row.hosts.includes(url.hostname.toLowerCase())) {
    return `${keyEnv} is ${row.provider}'s key and may be sent only to ${row.hosts.join(", ")} — not ${url.hostname}`;
  }
  return null;
}

/**
 * The pi provider id for a run's key, or a refusal naming why the pi driver
 * cannot run on it: the key's row carries no `piProvider`. Asked after
 * `apiKeyRefusal`, so the pair itself is already one the table allows.
 */
export function piProviderOf(keyEnv: string): { provider: string } | { refusal: string } {
  const row = KEY_PROVIDERS.find((p) => p.keyEnv === keyEnv);
  if (row?.piProvider !== undefined) return { provider: row.piProvider };
  const have = KEY_PROVIDERS.filter((p) => p.piProvider !== undefined).map((p) => `${p.keyEnv} (${p.provider})`);
  return {
    refusal:
      `the pi driver has no pi provider for ${keyEnv} — it runs on ${have.join(", ")}; ` +
      "another endpoint is a piProvider on its row in runner/src/providers.ts",
  };
}

/**
 * Why a roster entry's `apiKeyEnv` may not be sent to its `apiBase`
 * (the table above), or null when the pairing holds. The defaults
 * are the runner's: no base is OpenRouter and no key name is `OPENROUTER_KEY`,
 * so an entry stating only a non-OpenRouter base is refused — it would send
 * the OpenRouter key there. Only the openai driver sends a key; the CLI
 * drivers are given no `--api-key-env` at all (`episodeArgv` in
 * `infra/run-roster.ts`). Every reader of a roster entry asks this: the store's
 * write path, and the fleet parser and the viewer's campaign squares through
 * `rosterEntryRefusal` (runner/src/roster-refusal.ts).
 *
 * `env` is where the self-hosted hosts are read from (deploy-time config),
 * injected so a test states the deployment it means.
 */
export function rosterKeyRefusal(
  e: { driver?: unknown; apiBase?: unknown; apiKeyEnv?: unknown },
  env: Record<string, string | undefined> = process.env,
): string | null {
  if (driverEntry(e.driver ?? DEFAULT_DRIVER)?.endpoint !== true) return null;
  if (e.apiKeyEnv !== undefined && typeof e.apiKeyEnv !== "string") return "apiKeyEnv must be the NAME of the env var holding the key";
  if (e.apiBase !== undefined && typeof e.apiBase !== "string") return "apiBase must be a URL";
  return apiKeyRefusal(e.apiKeyEnv ?? DEFAULT_API_KEY_ENV, e.apiBase ?? DEFAULT_API_BASE, env);
}
