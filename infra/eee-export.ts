#!/usr/bin/env bun
/**
 * `bun wb export eee`: the scored ladders as Every Eval Ever records.
 *
 *   bun infra/eee-export.ts --base https://wrathbench-data.shard.page
 *   bun infra/eee-export.ts --runs data/runs [--series 0.5] [--include-free]
 *                           [--out DIR] [--bundle FILE]
 *
 * Every Eval Ever (github.com/evaleval/every_eval_ever, MIT) is an open results
 * schema with a datastore on Hugging Face. This writes records in its aggregate
 * format, schema 0.3.0, laid out as the datastore lays them out
 * (`<out>/data/wrathbench/<developer>/<model>/<uuid>.json`), so EEE's own
 * validator can be pointed at the tree as it stands. It writes files and
 * nothing else: submitting them is the operator's call, and the steps are in
 * docs/RUNBOOK.md ("Every Eval Ever export").
 *
 * **One source, the public ladder's.** The rows are the `ladder-e90.json` and
 * `ladder-e360.json` artifacts the snapshot renderer makes for the public site
 * (`runner/viewer/snapshot.ts`): with `--base`, read from the published
 * generation over plain GET (`httpSource`, the reader `bun wb site verify
 * --base` uses); with `--runs`, rendered from a runs tree exactly as
 * `infra/render-og.ts` renders the social card. Either way the bodies have
 * already crossed the public projection, so nothing the site withholds can
 * reach a record. Freeplay and probing have no scored rows and are not read.
 *
 * **The derivation is the ladder page's own.** `scored`, `ladderRows` and the
 * rung rules come from `dashboard/src/lib/ladder.ts`, called once per cell, so
 * a record's highest rung, `(level, xp)` pair and money are the numbers the
 * site prints. A cell is one (series, episode, harness, model, effort,
 * compaction window): the series is the comparability group, and effort and
 * the window are run dimensions, so a cell never mixes what the methodology
 * keeps apart. Free runs are left out by default, as the public site's own
 * default reading leaves them out (the operator's decision, 2026-10-20);
 * `--include-free` exports them too. The page's representative-effort filter
 * is not applied: it is a way of reading the table, not membership.
 *
 * **What a record carries.** The series and every exact harness version in
 * the cell, the harness label, model and effort, whether the model's weights
 * are published (`model_availability`, from the model catalogue's `weightsOf`), `n`,
 * the levels each counted run reached, and per-rung counts. Never game text: rung numbers, not rung
 * titles; no character, race, class, zone or map. Every record is scanned
 * before anything is written, with the publisher's own scans, and a finding
 * writes nothing.
 */

import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { ResultRun, ResultsResponse } from "../runner/viewer/api-types";
import { EPISODES, EPISODE_IDS, type EpisodeId } from "../runner/src/episodes";
import { isContributorSlug, isFreeSlug } from "../runner/src/model-cost";
import { describeFindings, envSecrets, SecretScanner } from "../runner/src/secret-scan";
import { ladderRows, RUNGS, scored, type LadderRow } from "../dashboard/src/lib/ladder";
import { seriesOf } from "../dashboard/src/lib/harness";
import { familyOf, weightsOf, type Weights } from "./model-catalogue";
import { httpSource, scanBody, type AcceptSource } from "./publish-accept";

const REPO_ROOT = resolve(import.meta.dir, "..");

/** The EEE aggregate schema these records are written against (`infra/eee/eval.schema.json`). */
export const EEE_SCHEMA_VERSION = "0.3.0";
/** The datastore collection: `data/<collection>/…`, routed by `source_data.dataset_name`. */
export const COLLECTION = "wrathbench";
const SITE_URL = "https://wrathbench.shard.page";
const REPO_URL = "https://github.com/Shard/WrathBench";
/** The milestone ladder's top rung; `highest_rung` lies in [0, this]. */
const TOP_RUNG = Math.max(...RUNGS.map((r) => r.n));
/** The game's level cap in 3.3.5a; `best_level` lies in [1, this]. */
const LEVEL_CAP = 80;

/** The episodes with a scored ladder, read off the tier table. */
export const SCORED_EPISODES: readonly EpisodeId[] = EPISODE_IDS.filter((id) => EPISODES[id].scored);

/** How the ladder orders rows, stated on every record because EEE has no field for a non-scalar order. */
export const LADDER_ORDER =
  "highest_rung desc, then the (best_level, xp within that level) pair lexicographically desc, then best_money desc; " +
  "three separate numbers and no aggregate score";

/* ------------------------------------------------------------- the records --- */

type Details = Record<string, string>;

interface MetricConfig {
  evaluation_description: string;
  metric_id: string;
  metric_name: string;
  metric_kind: string;
  metric_unit: string;
  lower_is_better: false;
  score_type: "continuous";
  min_score: number;
  max_score: number | "Infinity";
  additional_details?: Details;
}

interface EvaluationResult {
  evaluation_result_id: string;
  evaluation_name: string;
  source_data: { dataset_name: string; source_type: "url"; url: string[]; additional_details: Details };
  evaluation_timestamp?: string;
  metric_config: MetricConfig;
  score_details: { score: number; details: Details; uncertainty: { num_samples: number } };
  generation_config: {
    generation_args: { eval_limits: { time_limit: number } };
    additional_details: Details;
  };
}

/** One EEE aggregate record (`EvaluationLog`), the subset of fields this export fills. */
export interface EeeRecord {
  schema_version: string;
  evaluation_id: string;
  evaluation_timestamp?: string;
  retrieved_timestamp: string;
  source_metadata: {
    source_name: string;
    source_type: "documentation";
    source_organization_name: string;
    source_organization_url: string;
    evaluator_relationship: "third_party";
    additional_details: Details;
  };
  eval_library: { name: string; version: string; additional_details: Details };
  model_info: {
    name: string;
    id: string;
    developer: string;
    additional_details: Details & {
      deployment_type: "externally_managed" | "unknown";
      model_availability: "open_weights" | "closed_weights" | "unknown";
    };
  };
  evaluation_results: EvaluationResult[];
}

/** A record and where it goes, relative to the output directory. */
export interface EeeFile {
  path: string;
  record: EeeRecord;
}

/** Scored runs left out of every record, by reason, so a coverage line can be written. */
export interface Skipped {
  reason: string;
  runs: number;
}

export interface ExportResult {
  files: EeeFile[];
  skipped: Skipped[];
}

export interface ExportOptions {
  /** Keep only this series; every series present when absent. */
  series?: string;
  /** Keep runs whose `billing` is `free`; they are dropped by default, the public site's default reading. */
  includeFree?: boolean;
}

/** A cell's identity: the axes a record never mixes. */
interface CellKey {
  series: string;
  episode: EpisodeId;
  harness: string;
  model: string;
  effort: string | null;
  compactWindow: string | null;
}

/** The record identity, keyed on the raw recorded values (never on a resolved id, never on now). */
export function evaluationIdOf(k: CellKey): string {
  const parts = [COLLECTION, k.series, k.episode, k.harness, k.model, k.effort ?? "default"];
  if (k.compactWindow !== null) parts.push(`compact-${k.compactWindow}`);
  return parts.join("/");
}

/**
 * A UUID4-shaped name derived from the record identity: EEE files a record as
 * `<uuid4>.json`, and a deterministic one makes a re-export of the same cell
 * land on the same file rather than minting a second logical record.
 */
export function uuidOf(evaluationId: string): string {
  const b = new Uint8Array(new Bun.CryptoHasher("sha256").update(evaluationId).digest().buffer).slice(0, 16);
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const hex = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const stripFree = (id: string): string => (id.toLowerCase().endsWith(":free") ? id.slice(0, -":free".length) : id);
const slug = (s: string): string => s.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");

/**
 * The model's EEE id, `developer/model`, and how it was reached.
 *
 * A slug that already names its provider (`deepseek/deepseek-v4.1-flash`) is
 * the id, without OpenRouter's `:free` variant suffix — the endpoint is not the
 * model, and the record says which endpoint it was. A flat id (`opus` under
 * claude-code, `gpt-6-luna` under codex) takes the one id the provider
 * reported serving where the cell's runs agree on one, and its model
 * catalogue family's provider prefix. A flat id the catalogue cannot place has
 * no developer, and EEE cannot file it, so the cell is skipped rather than given
 * an invented one. The registry's canonical id is not resolved here: that is a
 * call to a hosted service, and so part of submitting, not of exporting.
 */
export function modelIdOf(model: string, resolvedModels: readonly string[]): { id: string; developer: string; basis: string } | null {
  const raw = stripFree(model.trim());
  const resolved = resolvedModels.length === 1 ? stripFree(resolvedModels[0]!.trim()) : null;
  for (const [candidate, basis] of [
    [raw, "recorded slug"],
    [resolved, "provider-reported id"],
  ] as const) {
    if (candidate !== null && candidate.includes("/")) {
      return { id: candidate, developer: candidate.slice(0, candidate.indexOf("/")), basis };
    }
  }
  const name = resolved ?? raw;
  const family = familyOf(name) ?? familyOf(raw);
  if (family === null) return null;
  // The prefix the family's own provider-prefixed slugs carry (`qwen/*`), so a
  // flat `qwen-3.8-27b` files beside `qwen/qwen3.8-27b` rather than under a
  // second spelling of the same developer; the company's name only when the
  // family lists no such slug.
  const prefixed = family.match.find((m) => /^[^*/]+\/\*$/.test(m));
  return {
    id: `${prefixed !== undefined ? prefixed.slice(0, -2) : slug(family.company)}/${name}`,
    developer: family.company,
    basis: resolved !== null ? "provider-reported id, catalogue family prefix" : "recorded id, catalogue family prefix",
  };
}

/** EEE's path rules for one component (`helpers/io.py`): `:` becomes `_`, and the rest must already be portable. */
function pathComponent(value: string): string | null {
  const v = value.replace(/:/g, "_");
  if (v === "" || v === "." || v === ".." || v === "data" || v.toLowerCase() === "unknown") return null;
  if (/[<>"\\|?*\u0000-\u001f/]/.test(v) || /[. ]$/.test(v)) return null;
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(v.split(".")[0]!)) return null;
  return v;
}

/** `data/<collection>/<developer>/<model>/<uuid>.json`, the developer being the id's prefix and the rest flattened. */
export function datastorePath(modelId: string, uuid: string): string | null {
  const [dev, ...rest] = modelId.split("/");
  const developer = pathComponent(dev ?? "");
  const parts = rest.map(pathComponent);
  if (developer === null || parts.length === 0 || parts.some((p) => p === null)) return null;
  return `data/${COLLECTION}/${developer}/${parts.join("_")}/${uuid}.json`;
}

/** Whether the provider ran the model: a run we paid a provider for, or a hosted free endpoint. */
function deploymentOf(runs: readonly ResultRun[]): "externally_managed" | "unknown" {
  const hosted = (r: ResultRun): boolean =>
    r.billing === "paid" || (r.model !== null && (isFreeSlug(r.model) || isContributorSlug(r.model)));
  return runs.length > 0 && runs.every(hosted) ? "externally_managed" : "unknown";
}

/** EEE's `model_availability` names for the catalogue's three weights verdicts. */
export const MODEL_AVAILABILITY: Readonly<Record<Weights, "open_weights" | "closed_weights" | "unknown">> = {
  open: "open_weights",
  closed: "closed_weights",
  unknown: "unknown",
};

/**
 * The cell's weights verdict: the catalogue's answer for the EEE id, else for
 * the recorded slug, which is the spelling an entry may list instead (`-free`
 * on an OpenCode Zen id is part of the slug, not a suffix the catalogue strips).
 */
export function availabilityOf(id: string, recorded: string): (typeof MODEL_AVAILABILITY)[Weights] {
  const w = weightsOf(id);
  return MODEL_AVAILABILITY[w !== "unknown" ? w : weightsOf(recorded)];
}

const json = (v: unknown): string => JSON.stringify(v);
const isoOf = (ms: number): string => new Date(ms).toISOString();

/** The cell's runs, levels and versions as strings, the only value type EEE's detail maps take. */
function cellRecord(k: CellKey, runs: readonly ResultRun[], row: LadderRow, model: NonNullable<ReturnType<typeof modelIdOf>>, now: number): EeeRecord {
  const tier = EPISODES[k.episode];
  const evaluationId = evaluationIdOf(k);
  const versions = [...new Set(runs.map((r) => r.harnessVersion).filter((v): v is string => v !== null))].sort();
  const drivers = [...new Set(runs.map((r) => r.driver).filter((v): v is string => typeof v === "string"))].sort();
  const billing = [...new Set(runs.map((r) => r.billing ?? "unknown"))].sort();
  const ended = runs.map((r) => r.endedAt ?? r.startedAt).filter((t): t is number => typeof t === "number");
  const evaluationTimestamp = ended.length > 0 ? isoOf(Math.max(...ended)) : undefined;
  const levels = runs.map((r) => r.maxLevel).filter((l): l is number => l !== null).sort((a, b) => a - b);
  const effort = k.effort ?? "default";

  const cellDetails: Details = {
    harness_series: k.series,
    harness_versions: json(versions),
    harness: k.harness,
    effort,
    ...(k.compactWindow !== null ? { compact_window: k.compactWindow } : {}),
    episode: k.episode,
    runs: String(runs.length),
    run_ids: json(runs.map((r) => r.runId).sort()),
    billing: json(billing),
    ...(drivers.length > 0 ? { drivers: json(drivers) } : {}),
    ladder_order: LADDER_ORDER,
  };
  const sourceData: EvaluationResult["source_data"] = {
    dataset_name: COLLECTION,
    source_type: "url",
    url: [SITE_URL, REPO_URL],
    additional_details: {
      episode: k.episode,
      episode_minutes: String(tier.minutes),
      ...(tier.toolCalls !== null ? { tool_call_ceiling: String(tier.toolCalls) } : {}),
      start: "a fresh level-1 character, no operator objective",
    },
  };
  const result = (metric: string, config: Omit<MetricConfig, "metric_id" | "lower_is_better" | "score_type">, score: number, n: number, details: Details): EvaluationResult => ({
    evaluation_result_id: `${evaluationId}#${metric}`,
    evaluation_name: `${COLLECTION}.${k.episode}`,
    source_data: sourceData,
    ...(evaluationTimestamp !== undefined ? { evaluation_timestamp: evaluationTimestamp } : {}),
    metric_config: { metric_id: `${COLLECTION}.${metric}`, lower_is_better: false, score_type: "continuous", ...config },
    score_details: { score, details, uncertainty: { num_samples: n } },
    generation_config: {
      generation_args: { eval_limits: { time_limit: (tier.minutes ?? 0) * 60 } },
      additional_details: { ...cellDetails, time_limit_unit: "seconds" },
    },
  });

  const results: EvaluationResult[] = [];
  const rungDetails: Details = { ladder_position: "1 of 3 (primary key)" };
  for (const c of row.cells) {
    rungDetails[`rung_${c.n}`] = c.status === "not-instrumented" ? "not instrumented" : `${c.reached} of ${c.askable} askable runs`;
  }
  results.push(
    result(
      "highest_rung",
      {
        evaluation_description:
          `Highest milestone rung (0-${TOP_RUNG}) any counted run reached; 0 is none. Rung ${RUNGS.find((r) => r.test === null)?.n ?? "6"} ` +
          "is not instrumented, so a rung above it does not claim it. A maximum over the cell's runs. Ladder order: " +
          LADDER_ORDER,
        metric_name: "Highest rung reached",
        metric_kind: "ordinal",
        metric_unit: "rung",
        min_score: 0,
        max_score: TOP_RUNG,
      },
      row.highest,
      row.runs,
      rungDetails,
    ),
  );
  if (row.bestLevel !== null && row.levelRange !== null) {
    results.push(
      result(
        "best_level",
        {
          evaluation_description:
            "Highest character level any counted run reached; ties within a level are broken by the xp within it " +
            "(details.xp_within_level, same run), which is the ladder's second key. Levels are integers the game " +
            "awarded: the median is an observed level (the lower middle), never a mean.",
          metric_name: "Best level reached",
          metric_kind: "level",
          metric_unit: "level",
          min_score: 1,
          max_score: LEVEL_CAP,
        },
        row.bestLevel,
        row.levelRange.n,
        {
          ladder_position: "2 of 3",
          ...(row.bestXp !== null ? { xp_within_level: String(row.bestXp) } : {}),
          level_min: String(row.levelRange.min),
          level_median: String(row.levelRange.median),
          level_max: String(row.levelRange.max),
          levels: json(levels),
        },
      ),
    );
  }
  if (row.bestMoney !== null) {
    results.push(
      result(
        "best_money",
        {
          evaluation_description:
            "The most copper any counted run ended holding (100 copper = 1 silver, 10000 = 1 gold), maxed " +
            "independently of best_level, so usually another run. The ladder's third key.",
          metric_name: "Best money held",
          metric_kind: "currency",
          metric_unit: "copper",
          min_score: 0,
          max_score: "Infinity",
        },
        row.bestMoney,
        runs.filter((r) => r.money !== null).length,
        { ladder_position: "3 of 3" },
      ),
    );
  }

  return {
    schema_version: EEE_SCHEMA_VERSION,
    evaluation_id: evaluationId,
    ...(evaluationTimestamp !== undefined ? { evaluation_timestamp: evaluationTimestamp } : {}),
    retrieved_timestamp: String(now / 1000),
    source_metadata: {
      source_name: "WrathBench",
      source_type: "documentation",
      source_organization_name: "WrathBench",
      source_organization_url: REPO_URL,
      evaluator_relationship: "third_party",
      additional_details: {
        harness_series: k.series,
        episode: k.episode,
        published_at: SITE_URL,
        ladder_order: LADDER_ORDER,
      },
    },
    eval_library: {
      name: "wrathbench",
      version: k.series,
      additional_details: { harness_versions: json(versions), harness: k.harness },
    },
    model_info: {
      name: k.model,
      id: model.id,
      developer: model.developer,
      additional_details: {
        deployment_type: deploymentOf(runs),
        model_availability: availabilityOf(model.id, k.model),
        agent_scaffold: k.harness,
        inference_effort: effort,
        model_id_basis: model.basis,
        registry_resolution: "not attempted",
        ...(row.resolvedModels.length > 0 ? { resolved_models: json(row.resolvedModels) } : {}),
      },
    },
    evaluation_results: results,
  };
}

/**
 * Every cell of one scored ladder body as a record.
 *
 * The body is `/api/ladder?episode=<id>` as the snapshot renderer publishes
 * it: members of the tier only, stamped and not overridden. `scored` then
 * keeps what the ladder ranks — no live, paused, lapsed or steered run, and
 * no scripted reference.
 */
export function eeeFromLadder(episode: EpisodeId, body: Pick<ResultsResponse, "runs" | "now">, opts: ExportOptions = {}): ExportResult {
  const skipped = new Map<string, number>();
  const skip = (reason: string, n = 1): void => {
    skipped.set(reason, (skipped.get(reason) ?? 0) + n);
  };
  const cells = new Map<string, { key: CellKey; runs: ResultRun[] }>();
  for (const r of scored(body.runs)) {
    if (r.episode !== episode) {
      skip(`not an ${episode} run`);
      continue;
    }
    const series = r.harnessSeries ?? seriesOf(r.harnessVersion);
    if (series === null) {
      skip("no harness series");
      continue;
    }
    if (opts.series !== undefined && series !== opts.series) continue;
    if (opts.includeFree !== true && r.billing === "free") {
      skip("free (--include-free exports them)");
      continue;
    }
    if (r.harness === null) {
      skip("no harness tag");
      continue;
    }
    if (r.model === null) {
      skip("no model recorded");
      continue;
    }
    const key: CellKey = { series, episode, harness: r.harness, model: r.model, effort: r.effort, compactWindow: r.compactWindow ?? null };
    const id = evaluationIdOf(key);
    const cell = cells.get(id);
    if (cell === undefined) cells.set(id, { key, runs: [r] });
    else cell.runs.push(r);
  }

  const files: EeeFile[] = [];
  for (const { key, runs } of cells.values()) {
    const rows = ladderRows(runs);
    // One model and one harness by construction; anything else would be a
    // record mixing rows, which is the one thing this must never write.
    if (rows.length !== 1 || rows[0]!.harnesses.length !== 1) throw new Error(`cell ${evaluationIdOf(key)} derived ${rows.length} ladder rows`);
    const row = rows[0]!;
    const model = modelIdOf(key.model, row.resolvedModels);
    if (model === null) {
      skip(`no developer known for the flat model id ${key.model}`, runs.length);
      continue;
    }
    const record = cellRecord(key, runs, row, model, body.now);
    const path = datastorePath(model.id, uuidOf(record.evaluation_id));
    if (path === null) {
      skip(`the model id ${model.id} is not a portable datastore path`, runs.length);
      continue;
    }
    files.push({ path, record });
  }
  files.sort((a, b) => a.record.evaluation_id.localeCompare(b.record.evaluation_id));
  return { files, skipped: [...skipped].map(([reason, runs]) => ({ reason, runs })).sort((a, b) => a.reason.localeCompare(b.reason)) };
}

/** Both scored ladders, one result. */
export function eeeExport(ladders: ReadonlyMap<EpisodeId, Pick<ResultsResponse, "runs" | "now">>, opts: ExportOptions = {}): ExportResult {
  const files: EeeFile[] = [];
  const skipped = new Map<string, number>();
  for (const ep of SCORED_EPISODES) {
    const body = ladders.get(ep);
    if (body === undefined) continue;
    const r = eeeFromLadder(ep, body, opts);
    files.push(...r.files);
    for (const s of r.skipped) skipped.set(`${ep}: ${s.reason}`, s.runs);
  }
  return { files, skipped: [...skipped].map(([reason, runs]) => ({ reason, runs })) };
}

/**
 * What the publisher would refuse, applied to every record: filesystem paths,
 * host facts and credential shapes (`scanBody`), and this process's own
 * credentials by value (`SecretScanner`). Empty when the export may be written.
 */
export function scanFiles(files: readonly EeeFile[], env: Record<string, string | undefined> = Bun.env): string[] {
  const scanner = new SecretScanner(envSecrets(env).secrets);
  const out: string[] = [];
  for (const f of files) {
    const { findings } = scanBody(f.path, f.record);
    for (const x of findings) out.push(`${f.path} ${x.at}: ${x.kind}`);
    const known = scanner.scan(JSON.stringify(f.record));
    if (known.length > 0) out.push(`${f.path}: ${describeFindings(known)}`);
  }
  return out;
}

/* ----------------------------------------------------------------- sources --- */

/** The scored ladders from the published generation: the manifest, then each ladder it names. */
export async function laddersFromPublished(source: AcceptSource): Promise<Map<EpisodeId, ResultsResponse>> {
  const manifestBody = await source.get("v1/manifest.json");
  if (manifestBody === null) throw new Error("the published generation has no v1/manifest.json");
  const manifest = JSON.parse(manifestBody) as { artifacts?: Record<string, string> };
  const out = new Map<EpisodeId, ResultsResponse>();
  for (const ep of SCORED_EPISODES) {
    const key = manifest.artifacts?.[`ladder-${ep}.json`];
    if (key === undefined) throw new Error(`the manifest names no ladder-${ep}.json`);
    const body = await source.get(key);
    if (body === null) throw new Error(`the manifest names ${key}, which is not there`);
    out.set(ep, JSON.parse(body) as ResultsResponse);
  }
  return out;
}

/** The scored ladders rendered from a runs tree, as the publisher and the social card render them. */
async function laddersFromRuns(runsDir: string): Promise<Map<EpisodeId, ResultsResponse>> {
  const { createRenderer } = await import("../runner/viewer/snapshot");
  const result = await createRenderer({ runsDir })();
  const out = new Map<EpisodeId, ResultsResponse>();
  for (const ep of SCORED_EPISODES) {
    const artifact = result.artifacts.find((a) => a.path.endsWith(`/ladder-${ep}.json`));
    if (artifact === undefined) throw new Error(`the snapshot pass produced no ladder-${ep}.json`);
    out.set(ep, JSON.parse(artifact.body) as ResultsResponse);
  }
  return out;
}

/* --------------------------------------------------------------------- CLI --- */

export const USAGE = `usage: bun infra/eee-export.ts (--base URL | --runs DIR) [--series S] [--include-free] [--out DIR] [--bundle FILE]
  --base URL      read the published ladders, e.g. --base https://wrathbench-data.shard.page
  --runs DIR      render the ladders from a runs tree, as the publisher does
  --series S      only this harness series (e.g. 0.5); every series when absent, each its own records
  --include-free  also export free runs, which are left out by default as the public site leaves them out
  --out DIR       write <DIR>/data/${COLLECTION}/…; default data/eee/<snapshot time>
  --bundle FILE   also write every record, with its path and the skipped counts, as one JSON file`;

export interface Args {
  base: string | null;
  runs: string | null;
  series: string | undefined;
  includeFree: boolean;
  out: string | null;
  bundle: string | null;
}

export function parseArgs(argv: readonly string[]): Args | { error: string } {
  const a: Args = { base: null, runs: null, series: undefined, includeFree: false, out: null, bundle: null };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]!;
    if (flag === "--include-free") {
      a.includeFree = true;
      continue;
    }
    if (!["--base", "--runs", "--series", "--out", "--bundle"].includes(flag)) return { error: `unknown argument ${flag}` };
    const v = argv[++i];
    if (v === undefined || v === "" || v.startsWith("--")) return { error: `${flag} needs a value` };
    if (flag === "--base") {
      if (!/^https?:\/\/\S+$/.test(v)) return { error: `--base must be an http(s) URL, got ${v}` };
      a.base = v;
    } else if (flag === "--runs") a.runs = v;
    else if (flag === "--series") {
      if (!/^\d+\.\d+$/.test(v)) return { error: `--series is major.minor, got ${v}` };
      a.series = v;
    } else if (flag === "--out") a.out = v;
    else a.bundle = v;
  }
  if ((a.base === null) === (a.runs === null)) return { error: "give exactly one source: --base URL or --runs DIR" };
  return a;
}

/** A compact stamp for the default output directory, from the snapshot's own clock. */
const stampOf = (ms: number): string => isoOf(ms).replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");

async function main(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv);
  if ("error" in args) {
    console.error(`eee-export: ${args.error}\n${USAGE}`);
    return 2;
  }
  const ladders = args.base !== null ? await laddersFromPublished(httpSource(args.base)) : await laddersFromRuns(args.runs!);
  const result = eeeExport(ladders, { series: args.series, includeFree: args.includeFree });
  const findings = scanFiles(result.files);
  if (findings.length > 0) {
    console.error(`eee-export: nothing written; the scan found ${findings.length} finding(s):`);
    for (const f of findings.slice(0, 20)) console.error(`  ${f}`);
    return 1;
  }
  const now = Math.max(...[...ladders.values()].map((b) => b.now));
  const out = resolve(REPO_ROOT, args.out ?? join("data", "eee", stampOf(now)));
  const tree = join(out, "data", COLLECTION);
  if (existsSync(tree) && readdirSync(tree).length > 0) {
    console.error(`eee-export: ${tree} already holds records; pick an empty --out`);
    return 1;
  }
  for (const f of result.files) {
    const path = join(out, f.path);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(f.record, null, 2)}\n`);
  }
  if (args.bundle !== null) {
    const bundle = resolve(REPO_ROOT, args.bundle);
    mkdirSync(dirname(bundle), { recursive: true });
    writeFileSync(bundle, `${JSON.stringify({ schemaVersion: EEE_SCHEMA_VERSION, files: result.files, skipped: result.skipped }, null, 2)}\n`);
    console.error(`eee-export: bundle ${bundle}`);
  }
  const bySeries = new Map<string, number>();
  for (const f of result.files) {
    const k = `${f.record.source_metadata.additional_details.harness_series} ${f.record.source_metadata.additional_details.episode}`;
    bySeries.set(k, (bySeries.get(k) ?? 0) + 1);
  }
  console.log(`${result.files.length} records under ${tree}`);
  for (const [k, n] of [...bySeries].sort()) console.log(`  series ${k}: ${n}`);
  for (const s of result.skipped) console.log(`  skipped ${s.runs} run(s): ${s.reason}`);
  return 0;
}

if (import.meta.main) process.exit(await main(Bun.argv.slice(2)));
