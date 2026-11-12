/**
 * The supervisor's reads of its providers' model lists (`runner/src/model-lists.ts`):
 * each list a roster entry is on, at most once per `MODEL_LIST_READ_EVERY_MS`,
 * folded into `fleet-model-lists.json` beside the runs, where the projection
 * reads it and retires an entry its provider has stopped listing.
 *
 * The first read of each list is at boot; a restart re-reads them, which is
 * one GET per list. The confirmation lives in the file, so a restart neither
 * shortens nor restarts it.
 */

import type { Credential } from "../runner/src/credential-slots";
import {
  applyModelListRead,
  GONE_CONFIRM_MS,
  MODEL_LIST_READ_EVERY_MS,
  modelListSourceOf,
  readModelList,
  readModelListsSidecar,
  writeModelListsSidecar,
  type ModelListResult,
  type ModelListSource,
  type ModelListsSidecar,
  type ReadModelListOptions,
} from "../runner/src/model-lists";
import { providerById } from "../runner/src/credential-slots";

/** A roster entry as far as its list is concerned. */
type ListedEntry = { model: string; driver?: string | null | undefined; apiBase?: string | null | undefined };

/** Every list the roster's entries are on, each with the models on it. */
export function modelListsToRead(
  roster: Readonly<Record<string, ListedEntry>>,
  env: Record<string, string | undefined> = process.env,
): { source: ModelListSource; models: string[] }[] {
  const byUrl = new Map<string, { source: ModelListSource; models: string[] }>();
  for (const e of Object.values(roster)) {
    const source = modelListSourceOf(e, env);
    if (source === null) continue;
    const row = byUrl.get(source.url) ?? { source, models: [] };
    if (!row.models.includes(e.model)) row.models.push(e.model);
    byUrl.set(source.url, row);
  }
  return [...byUrl.values()];
}

/**
 * The key a list that needs one is read with: the first enabled credential of
 * its provider whose variable is set, else the provider's own variable. Only
 * the variable's NAME leaves this function besides the value itself.
 */
export function modelListKey(
  source: ModelListSource,
  credentials: readonly Pick<Credential, "provider" | "secretEnv" | "enabled">[],
  env: Record<string, string | undefined> = process.env,
): { env: string; value: string } | undefined {
  if (source.auth !== "key") return undefined;
  const names = [
    ...credentials.filter((c) => c.enabled && c.provider === source.provider).map((c) => c.secretEnv),
    ...(providerById(source.provider) !== undefined ? [providerById(source.provider)!.envBase] : []),
  ];
  for (const name of names) {
    const value = env[name];
    if (value !== undefined && value.length > 0) return { env: name, value };
  }
  return undefined;
}

export class FleetModelLists {
  /** List url -> when it was last attempted, in this process. */
  private readonly attempted = new Map<string, number>();

  constructor(
    private readonly o: {
      runsDir: string;
      env?: Record<string, string | undefined>;
      fetcher?: typeof globalThis.fetch;
      now?: () => number;
      say?: (line: string) => void;
      /** Seam for tests: the read itself. */
      read?: (source: ModelListSource, opts: ReadModelListOptions) => Promise<ModelListResult>;
    },
  ) {}

  /**
   * Read every list that is due and fold the results into the file. Resolves
   * when done; never rejects. A failed read is said once per failure and
   * changes nothing but the read's own row.
   */
  async refresh(
    roster: Readonly<Record<string, ListedEntry>>,
    credentials: readonly Pick<Credential, "provider" | "secretEnv" | "enabled">[],
    /** Where the keys are read from this time: the supervisor passes its environment with the config store's secrets over it. */
    env: Record<string, string | undefined> = this.o.env ?? process.env,
  ): Promise<void> {
    const now = this.o.now ?? Date.now;
    const due = modelListsToRead(roster, env).filter(({ source }) => {
      const at = this.attempted.get(source.url);
      return at === undefined || now() - at >= MODEL_LIST_READ_EVERY_MS;
    });
    if (due.length === 0) return;
    const read = this.o.read ?? readModelList;
    const results = await Promise.all(
      due.map(async (d) => {
        this.attempted.set(d.source.url, now());
        const key = modelListKey(d.source, credentials, env);
        try {
          return { ...d, result: await read(d.source, { ...(this.o.fetcher !== undefined ? { fetcher: this.o.fetcher } : {}), ...(key !== undefined ? { key } : {}) }) };
        } catch (e) {
          return { ...d, result: { ok: false as const, why: e instanceof Error ? e.message : String(e) } };
        }
      }),
    );
    try {
      let lists: ModelListsSidecar = readModelListsSidecar(this.o.runsDir);
      for (const { source, models, result } of results) {
        const before = lists.missing[source.url] ?? {};
        lists = applyModelListRead(lists, source, models, result, now());
        if (!result.ok) {
          this.o.say?.(`model list ${source.label} (${source.url}) not read: ${result.why} — nothing retired or restored on it`);
          continue;
        }
        const after = lists.missing[source.url] ?? {};
        for (const m of Object.keys(after)) if (before[m] === undefined) this.o.say?.(`model list ${source.label}: ${m} is not on it (retired once a day of reads agree)`);
        for (const m of Object.keys(before)) if (after[m] === undefined && models.includes(m)) this.o.say?.(`model list ${source.label}: ${m} is listed again`);
      }
      writeModelListsSidecar(this.o.runsDir, lists);
    } catch (e) {
      this.o.say?.(`model lists: could not write the file: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

/** The `--status` block: each list's newest read, and what is missing from it. Pure. */
export function formatModelLists(lists: ModelListsSidecar, now: number): string[] {
  const ago = (ms: number): string => `${Math.round((now - ms) / 60_000)}m ago`;
  const day = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
  const head =
    `model lists (each read every ${Math.round(MODEL_LIST_READ_EVERY_MS / 3_600_000)}h; ` +
    `a model every successful read has left out for ${Math.round(GONE_CONFIRM_MS / 3_600_000)}h is retired until listed again; ` +
    "the claude, chatgpt and local lists are not read)";
  const rows = Object.entries(lists.reads).sort(([a], [b]) => a.localeCompare(b));
  if (rows.length === 0) return [`${head}: none read yet`];
  const out = [`${head}:`];
  for (const [url, r] of rows) {
    const label = providerById(r.provider)?.label ?? r.provider;
    const read = r.ok
      ? `${r.count ?? 0} ids, read ${ago(r.at)}`
      : `NOT READ ${ago(r.at)} (${r.why ?? "unknown"}); ${r.lastOkAt !== undefined ? `last read ${ago(r.lastOkAt)}` : "never read"}`;
    const missing = Object.entries(lists.missing[url] ?? {}).sort(([a], [b]) => a.localeCompare(b));
    const gone = missing.map(([m, x]) => `${m} since ${day(x.since)} (${x.reads} read${x.reads === 1 ? "" : "s"})`).join(", ");
    out.push(`  ${label} ${url}: ${read}${missing.length > 0 ? ` — not listed: ${gone}` : ""}`);
  }
  return out;
}
