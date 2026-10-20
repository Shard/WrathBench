/**
 * The Every Eval Ever export, over ladder bodies built the way the snapshot
 * renderer builds them: result rows pushed through the public projection.
 *
 * Every record is checked against EEE's own aggregate schema, vendored at
 * `infra/eee/eval.schema.json` (schema 0.3.0; THIRD-PARTY-NOTICES.md), by the
 * small draft-07 reader at the bottom of this file, which knows exactly the
 * keywords that schema uses. EEE's CLI adds checks the schema cannot state —
 * the datastore path, UUID4 file names, a score inside its bounds, the
 * deployment enums — and those are asserted here directly.
 *
 * No network, no `data/`, no credentials.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ResultRun, ResultsResponse } from "../runner/viewer/api-types";
import { projectResults } from "../runner/viewer/public-projection";
import {
  availabilityOf,
  COLLECTION,
  datastorePath,
  eeeExport,
  eeeFromLadder,
  EEE_SCHEMA_VERSION,
  evaluationIdOf,
  laddersFromPublished,
  MODEL_AVAILABILITY,
  modelIdOf,
  parseArgs,
  scanFiles,
  uuidOf,
  type EeeFile,
} from "./eee-export";

const NOW = 1_792_480_934_137;

function run(p: Partial<ResultRun> = {}): ResultRun {
  return {
    runId: "r",
    model: "deepseek/deepseek-v4.1-flash",
    platform: "openrouter",
    harnessVersion: "harness-0.5-12-gabc1234",
    harnessSeries: "0.5",
    extra: false,
    campaign: null,
    cell: null,
    effort: null,
    race: 1,
    raceName: "Human",
    class: 2,
    className: "Paladin",
    characterLabel: "Human Paladin",
    modelResponses: 10,
    harness: "wrathbench",
    promptHash: "sha256:aaaa",
    serverBuild: null,
    wikiCoords: false,
    toolCalls: 100,
    snippets: 90,
    episode: "e90",
    episodeSource: "stamped",
    episodeOverride: false,
    unscored: null,
    startedAt: NOW - 10 * 3_600_000,
    endedAt: NOW - 9 * 3_600_000,
    live: false,
    terminationReason: "episode-time-limit",
    levels: [],
    maxLevel: 6,
    xp: 300,
    money: 1234,
    questsCompleted: 4,
    maps: [0],
    character: "Toon",
    playtimeMs: 5_400_000,
    tokens: null,
    actualCost: null,
    billing: "paid",
    areas: { startArea: 9, distinctAreas: 3, leftStartArea: true, capitalZone: null, zoneMarks: 2, areaMarks: 3 },
    taxi: null,
    pauseReason: null,
    continuedFrom: null,
    stillborn: null,
    ...p,
  } as ResultRun;
}

/** A ladder body as the publisher writes it: projected, enveloped. */
function ladder(episode: "e90" | "e360", runs: ResultRun[]): ResultsResponse {
  return projectResults({ runs, episode, harness: "all", includeOverrides: false, filteredOut: 0, overridesExcluded: 0, now: NOW });
}

const E90 = [
  // One model at two efforts, three runs at the default.
  run({ runId: "ds-a", maxLevel: 6, xp: 300, money: 900 }),
  run({ runId: "ds-b", maxLevel: 6, xp: 450, money: 100 }),
  run({ runId: "ds-c", maxLevel: 4, xp: 10, money: 5000, harnessVersion: "harness-0.5-14-gdef5678" }),
  run({ runId: "ds-high", effort: "high", maxLevel: 11, xp: 7, money: 0 }),
  // The same model on the previous series: its own record.
  run({ runId: "ds-old", harnessVersion: "harness-0.4-3-g1111111", harnessSeries: "0.4", maxLevel: 9 }),
  // A CLI alias the provider resolved.
  run({ runId: "opus-a", model: "opus", resolvedModel: "claude-opus-5", harness: "claude-code", driver: "claude-code", effort: "low", maxLevel: 7 }),
  // A free endpoint, with no level recorded.
  run({ runId: "free-a", model: "minimax/minimax-m3:free", billing: "free", maxLevel: null, xp: null, money: null }),
  // Never in a record: live, paused, steered, the scripted reference.
  run({ runId: "live", unscored: "unscored (live)", maxLevel: 80 }),
  run({ runId: "paused", unscored: "unscored (paused)", maxLevel: 80 }),
  run({ runId: "steered", unscored: "unscored (operator objective)", maxLevel: 80 }),
  run({ runId: "reference", model: "reference", driver: "reference", unscored: "unscored (scripted reference)", maxLevel: 80 }),
  // A flat id nothing in the lineup claims, and a run that names no series.
  run({ runId: "stealth", model: "omen-alpha", resolvedModel: "omen-alpha" }),
  run({ runId: "unstamped", harnessVersion: null, harnessSeries: null }),
];
const E360 = [run({ runId: "long-a", episode: "e360", maxLevel: 14, harness: "codex", driver: "codex", model: "gpt-6-luna" })];

const ladders = new Map([
  ["e90", ladder("e90", E90)],
  ["e360", ladder("e360", E360)],
] as const);

const byId = (files: readonly EeeFile[], id: string): EeeFile => {
  const f = files.find((x) => x.record.evaluation_id === id);
  if (f === undefined) throw new Error(`no record ${id}; have ${files.map((x) => x.record.evaluation_id).join(", ")}`);
  return f;
};
const resultOf = (f: EeeFile, metric: string) => f.record.evaluation_results.find((r) => r.metric_config.metric_id === `${COLLECTION}.${metric}`);

describe("cells", () => {
  // Free runs too, so the free cell's record can be read; the default leaves
  // them out, which the --include-free test pins.
  const { files, skipped } = eeeExport(ladders, { includeFree: true });

  test("one record per (series, episode, harness, model, effort), e90 first, and only scored runs in any", () => {
    expect(files.map((f) => f.record.evaluation_id)).toEqual([
      "wrathbench/0.4/e90/wrathbench/deepseek/deepseek-v4.1-flash/default",
      "wrathbench/0.5/e90/claude-code/opus/low",
      "wrathbench/0.5/e90/wrathbench/deepseek/deepseek-v4.1-flash/default",
      "wrathbench/0.5/e90/wrathbench/deepseek/deepseek-v4.1-flash/high",
      "wrathbench/0.5/e90/wrathbench/minimax/minimax-m3:free/default",
      "wrathbench/0.5/e360/codex/gpt-6-luna/default",
    ]);
    const ids = files.flatMap((f) => JSON.parse(f.record.evaluation_results[0]!.generation_config.additional_details.run_ids!) as string[]);
    for (const out of ["live", "paused", "steered", "reference", "stealth", "unstamped"]) expect(ids).not.toContain(out);
  });

  test("what is left out is counted, with its reason", () => {
    expect(skipped).toEqual([
      { reason: "e90: no developer known for the flat model id omen-alpha", runs: 1 },
      { reason: "e90: no harness series", runs: 1 },
    ]);
  });

  test("a record carries the series, every exact version, the harness, the effort and n", () => {
    const f = byId(files, "wrathbench/0.5/e90/wrathbench/deepseek/deepseek-v4.1-flash/default");
    expect(f.record.eval_library).toEqual({
      name: "wrathbench",
      version: "0.5",
      additional_details: { harness_versions: '["harness-0.5-12-gabc1234","harness-0.5-14-gdef5678"]', harness: "wrathbench" },
    });
    const details = resultOf(f, "highest_rung")!.generation_config.additional_details;
    expect(details).toMatchObject({ harness_series: "0.5", harness: "wrathbench", effort: "default", episode: "e90", runs: "3" });
    expect(JSON.parse(details.run_ids!)).toEqual(["ds-a", "ds-b", "ds-c"]);
    expect(f.record.model_info.additional_details).toMatchObject({ agent_scaffold: "wrathbench", inference_effort: "default" });
  });

  test("the ladder's three numbers, each a maximum, with the level distribution beside them", () => {
    const f = byId(files, "wrathbench/0.5/e90/wrathbench/deepseek/deepseek-v4.1-flash/default");
    const rung = resultOf(f, "highest_rung")!;
    expect(rung.score_details.score).toBe(2);
    expect(rung.score_details.uncertainty.num_samples).toBe(3);
    expect(rung.score_details.details).toMatchObject({ rung_1: "2 of 3 askable runs", rung_2: "3 of 3 askable runs", rung_6: "not instrumented" });
    const level = resultOf(f, "best_level")!;
    // The (level, xp) pair comes from one run: level 6 at 450 xp is ds-b.
    expect(level.score_details.score).toBe(6);
    expect(level.score_details.details).toMatchObject({ xp_within_level: "450", level_min: "4", level_median: "6", level_max: "6", levels: "[4,6,6]" });
    expect(resultOf(f, "best_money")!.score_details.score).toBe(5000);
  });

  test("a null reading is no result, never a zero; a zero is a reading", () => {
    const free = byId(files, "wrathbench/0.5/e90/wrathbench/minimax/minimax-m3:free/default");
    expect(free.record.evaluation_results.map((r) => r.metric_config.metric_id)).toEqual(["wrathbench.highest_rung"]);
    const high = byId(files, "wrathbench/0.5/e90/wrathbench/deepseek/deepseek-v4.1-flash/high");
    expect(resultOf(high, "best_money")!.score_details.score).toBe(0);
  });

  test("--series keeps one series; free runs are left out unless --include-free, and counted", () => {
    const only = eeeExport(ladders, { series: "0.4" }).files.map((f) => f.record.evaluation_id);
    expect(only).toEqual(["wrathbench/0.4/e90/wrathbench/deepseek/deepseek-v4.1-flash/default"]);
    const paid = eeeExport(ladders);
    expect(paid.files.map((f) => f.record.evaluation_id)).not.toContain("wrathbench/0.5/e90/wrathbench/minimax/minimax-m3:free/default");
    expect(paid.skipped).toContainEqual({ reason: "e90: free (--include-free exports them)", runs: 1 });
    expect(files.map((f) => f.record.evaluation_id)).toContain("wrathbench/0.5/e90/wrathbench/minimax/minimax-m3:free/default");
    expect(skipped.map((x) => x.reason)).not.toContain("e90: free (--include-free exports them)");
  });

  test("a compaction window is its own cell", () => {
    const r = eeeFromLadder("e90", ladder("e90", [run({ runId: "a" }), run({ runId: "b", compactWindow: "200k" })]));
    expect(r.files.map((f) => f.record.evaluation_id)).toEqual([
      "wrathbench/0.5/e90/wrathbench/deepseek/deepseek-v4.1-flash/default",
      "wrathbench/0.5/e90/wrathbench/deepseek/deepseek-v4.1-flash/default/compact-200k",
    ]);
  });
});

describe("identity and paths", () => {
  test("a provider slug is the id without its :free variant; a flat id takes its family's prefix", () => {
    expect(modelIdOf("deepseek/deepseek-v4.1-flash", [])).toMatchObject({ id: "deepseek/deepseek-v4.1-flash", developer: "deepseek" });
    expect(modelIdOf("minimax/minimax-m3:free", [])).toMatchObject({ id: "minimax/minimax-m3" });
    expect(modelIdOf("opus", ["claude-opus-5"])).toMatchObject({ id: "anthropic/claude-opus-5", developer: "Anthropic" });
    expect(modelIdOf("gpt-6-luna", [])).toMatchObject({ id: "openai/gpt-6-luna", developer: "OpenAI" });
    expect(modelIdOf("qwen-3.8-27b", ["qwen-3.8-27b"])).toMatchObject({ id: "qwen/qwen-3.8-27b" });
    expect(modelIdOf("deepseek-v4.1-flash", ["deepseek/deepseek-v4.1-flash"])).toMatchObject({ id: "deepseek/deepseek-v4.1-flash", basis: "provider-reported id" });
    // An alias that resolved two ways keeps the alias rather than picking one.
    expect(modelIdOf("sonnet", ["claude-sonnet-5", "claude-sonnet-5-5"])).toMatchObject({ id: "anthropic/sonnet" });
    expect(modelIdOf("omen-alpha", ["omen-alpha"])).toBeNull();
  });

  test("the path is the id's prefix and its flattened rest, under a UUID4 that the record identity fixes", () => {
    const id = evaluationIdOf({ series: "0.5", episode: "e90", harness: "wrathbench", model: "x/y", effort: null, compactWindow: null });
    const uuid = uuidOf(id);
    expect(uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(uuidOf(id)).toBe(uuid);
    expect(uuidOf(`${id}/high`)).not.toBe(uuid);
    expect(datastorePath("openai/azure/gpt-x:2", uuid)).toBe(`data/wrathbench/openai/azure_gpt-x_2/${uuid}.json`);
    expect(datastorePath("unknown/m", uuid)).toBeNull();
    expect(datastorePath("data/m", uuid)).toBeNull();
    expect(datastorePath("flat", uuid)).toBeNull();
  });
});

describe("what EEE's CLI checks beyond the schema", () => {
  const { files } = eeeExport(ladders, { includeFree: true });

  test("every file sits at data/<collection>/<id prefix>/<model>/<uuid4>.json, named by its own record", () => {
    for (const f of files) {
      const [, collection, dev, , name] = f.path.split("/");
      expect(collection).toBe(COLLECTION);
      expect(dev).toBe(f.record.model_info.id.split("/")[0]!.replace(/:/g, "_"));
      expect(name).toBe(`${uuidOf(f.record.evaluation_id)}.json`);
      for (const r of f.record.evaluation_results) expect(r.source_data.dataset_name).toBe(COLLECTION);
    }
  });

  test("every score is finite and inside its declared bounds", () => {
    for (const f of files) {
      for (const r of f.record.evaluation_results) {
        const { score } = r.score_details;
        const max = r.metric_config.max_score === "Infinity" ? Infinity : r.metric_config.max_score;
        expect(Number.isFinite(score)).toBe(true);
        expect(score).toBeGreaterThanOrEqual(r.metric_config.min_score);
        expect(score).toBeLessThanOrEqual(max);
      }
    }
  });

  test("the deployment axes are set from EEE's own enums", () => {
    for (const f of files) {
      expect(["self_deployed", "externally_managed", "unknown"]).toContain(f.record.model_info.additional_details.deployment_type);
      expect(["open_weights", "closed_weights", "unknown"]).toContain(f.record.model_info.additional_details.model_availability);
    }
    expect(byId(files, "wrathbench/0.5/e90/wrathbench/minimax/minimax-m3:free/default").record.model_info.additional_details.deployment_type).toBe("externally_managed");
  });

  test("model_availability is the lineup's weights verdict in EEE's names", () => {
    const availability = (id: string): string => byId(files, id).record.model_info.additional_details.model_availability;
    // DeepSeek V4.1 Flash and MiniMax M3 publish their weights; Claude and GPT-6 do not.
    expect(availability("wrathbench/0.5/e90/wrathbench/deepseek/deepseek-v4.1-flash/default")).toBe("open_weights");
    expect(availability("wrathbench/0.5/e90/wrathbench/minimax/minimax-m3:free/default")).toBe("open_weights");
    // A CLI alias reads through the id the provider resolved.
    expect(availability("wrathbench/0.5/e90/claude-code/opus/low")).toBe("closed_weights");
    expect(availability("wrathbench/0.5/e360/codex/gpt-6-luna/default")).toBe("closed_weights");
    expect(MODEL_AVAILABILITY).toEqual({ open: "open_weights", closed: "closed_weights", unknown: "unknown" });
    // An id the lineup's rules do not name is unknown, never a family guess.
    expect(availabilityOf("openai/gpt-9-unreleased", "gpt-9-unreleased")).toBe("unknown");
    // The recorded slug is the fallback: a `-free` OpenCode Zen id is named as itself.
    expect(availabilityOf("poolside/laguna-s-2.1-free", "laguna-s-2.1-free")).toBe("open_weights");
  });
});

describe("content", () => {
  const { files } = eeeExport(ladders, { includeFree: true });
  const text = JSON.stringify(files);

  test("no game text and no character: no rung title, race, class, name, zone or map", () => {
    for (const s of ["Human", "Paladin", "Toon", "Quest chain", "capital", "Northrend", "Icecrown", "startArea", "maps"]) {
      expect(text).not.toContain(s);
    }
  });

  test("the publisher's scans find nothing, and do find a planted credential", () => {
    expect(scanFiles(files, {})).toEqual([]);
    const planted = structuredClone(files[0]!);
    planted.record.model_info.name = "sk-or-v1-" + "a".repeat(64);
    expect(scanFiles([planted], {}).length).toBeGreaterThan(0);
  });
});

describe("the published source", () => {
  test("the manifest names each scored ladder, which is read by its key", async () => {
    const bodies: Record<string, string> = {
      "v1/manifest.json": JSON.stringify({ gen: "g", artifacts: { "ladder-e90.json": "v1/snap/a/ladder-e90.json", "ladder-e360.json": "v1/snap/b/ladder-e360.json" } }),
      "v1/snap/a/ladder-e90.json": JSON.stringify(ladder("e90", E90)),
      "v1/snap/b/ladder-e360.json": JSON.stringify(ladder("e360", E360)),
    };
    const read: string[] = [];
    const got = await laddersFromPublished({ get: async (k) => (read.push(k), bodies[k] ?? null) });
    expect(read).toEqual(["v1/manifest.json", "v1/snap/a/ladder-e90.json", "v1/snap/b/ladder-e360.json"]);
    expect(eeeExport(got).files.length).toBe(eeeExport(ladders).files.length);
  });

  test("a manifest without a scored ladder is an error, not an empty export", async () => {
    const src = { get: async (k: string) => (k === "v1/manifest.json" ? JSON.stringify({ artifacts: {} }) : null) };
    await expect(laddersFromPublished(src)).rejects.toThrow(/ladder-e90/);
  });
});

describe("arguments", () => {
  test("exactly one source, and checked values", () => {
    expect(parseArgs(["--base", "https://x.example"])).toMatchObject({ base: "https://x.example", runs: null });
    expect(parseArgs(["--runs", "data/runs", "--series", "0.5", "--include-free"])).toMatchObject({ runs: "data/runs", series: "0.5", includeFree: true });
    expect(parseArgs(["--base", "https://x.example"])).toMatchObject({ includeFree: false });
    // The old flag is gone, not silently accepted: free runs are already out by default.
    expect(parseArgs(["--runs", "d", "--exclude-free"])).toHaveProperty("error");
    expect(parseArgs([])).toHaveProperty("error");
    expect(parseArgs(["--base", "https://x.example", "--runs", "d"])).toHaveProperty("error");
    expect(parseArgs(["--base", "ftp://x"])).toHaveProperty("error");
    expect(parseArgs(["--runs", "d", "--series", "latest"])).toHaveProperty("error");
    expect(parseArgs(["--runs", "d", "--nope"])).toHaveProperty("error");
  });
});

/* -------------------------------------------------- EEE's aggregate schema --- */

type Schema = Record<string, unknown>;
const SCHEMA = JSON.parse(readFileSync(join(import.meta.dir, "eee", "eval.schema.json"), "utf8")) as Schema;

/**
 * Draft-07 over the keywords `eval.schema.json` uses and no others: type,
 * required, properties, additionalProperties, enum, const, items, minItems,
 * oneOf, $ref into `$defs`, if/then/else, minimum, maximum and pattern. A
 * keyword it does not know fails the test rather than passing silently.
 */
const KNOWN = new Set([
  "$schema", "version", "description", "default", "$defs", "type", "required", "properties", "additionalProperties",
  "enum", "const", "items", "minItems", "oneOf", "$ref", "if", "then", "else", "minimum", "maximum", "pattern",
]);

function typeOk(t: string, v: unknown): boolean {
  switch (t) {
    case "object": return typeof v === "object" && v !== null && !Array.isArray(v);
    case "array": return Array.isArray(v);
    case "string": return typeof v === "string";
    case "number": return typeof v === "number" && Number.isFinite(v);
    case "integer": return Number.isInteger(v);
    case "boolean": return typeof v === "boolean";
    case "null": return v === null;
    default: throw new Error(`schema type ${t}`);
  }
}

function errorsOf(schema: Schema, v: unknown, at = "$"): string[] {
  for (const k of Object.keys(schema)) if (!KNOWN.has(k)) throw new Error(`schema keyword ${k} at ${at}`);
  if (typeof schema.$ref === "string") {
    const name = /^#\/\$defs\/(.+)$/.exec(schema.$ref)?.[1];
    if (name === undefined) throw new Error(`ref ${schema.$ref}`);
    return errorsOf((SCHEMA.$defs as Record<string, Schema>)[name]!, v, at);
  }
  const out: string[] = [];
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? (schema.type as string[]) : [schema.type as string];
    if (!types.some((t) => typeOk(t, v))) return [`${at}: not ${types.join("|")}`];
  }
  if (schema.enum !== undefined && !(schema.enum as unknown[]).includes(v)) out.push(`${at}: not in enum`);
  if ("const" in schema && schema.const !== v) out.push(`${at}: not ${String(schema.const)}`);
  if (typeof v === "number") {
    if (typeof schema.minimum === "number" && v < schema.minimum) out.push(`${at}: below minimum`);
    if (typeof schema.maximum === "number" && v > schema.maximum) out.push(`${at}: above maximum`);
  }
  if (typeof v === "string" && typeof schema.pattern === "string" && !new RegExp(schema.pattern).test(v)) out.push(`${at}: pattern`);
  if (Array.isArray(v)) {
    if (typeof schema.minItems === "number" && v.length < schema.minItems) out.push(`${at}: too few items`);
    if (schema.items !== undefined) v.forEach((x, i) => out.push(...errorsOf(schema.items as Schema, x, `${at}[${i}]`)));
  }
  if (typeOk("object", v)) {
    const obj = v as Record<string, unknown>;
    for (const r of (schema.required as string[] | undefined) ?? []) if (!(r in obj)) out.push(`${at}: missing ${r}`);
    const props = (schema.properties as Record<string, Schema> | undefined) ?? {};
    for (const [k, x] of Object.entries(obj)) {
      if (k in props) out.push(...errorsOf(props[k]!, x, `${at}.${k}`));
      else if (schema.additionalProperties === false) out.push(`${at}: unexpected ${k}`);
      else if (typeof schema.additionalProperties === "object") out.push(...errorsOf(schema.additionalProperties as Schema, x, `${at}.${k}`));
    }
  }
  if (schema.oneOf !== undefined) {
    const passing = (schema.oneOf as Schema[]).filter((s) => errorsOf(s, v, at).length === 0).length;
    if (passing !== 1) out.push(`${at}: matches ${passing} of oneOf`);
  }
  if (schema.if !== undefined) {
    const branch = errorsOf(schema.if as Schema, v, at).length === 0 ? schema.then : schema.else;
    if (branch !== undefined) out.push(...errorsOf(branch as Schema, v, at));
  }
  return out;
}

describe("EEE's aggregate schema", () => {
  test("the vendored schema is the version the records claim", () => {
    expect(SCHEMA.version).toBe(EEE_SCHEMA_VERSION);
  });

  test("every record validates", () => {
    const { files } = eeeExport(ladders, { includeFree: true });
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) expect(errorsOf(SCHEMA, f.record), f.record.evaluation_id).toEqual([]);
  });

  test("the reader rejects what EEE rejects", () => {
    const f = structuredClone(eeeExport(ladders).files[0]!.record) as unknown as Record<string, unknown>;
    expect(errorsOf(SCHEMA, { ...f, extra: 1 })).toContain("$: unexpected extra");
    const noDeploy = structuredClone(f) as { model_info: { additional_details: Record<string, string> } };
    delete noDeploy.model_info.additional_details.deployment_type;
    expect(errorsOf(SCHEMA, noDeploy).join("\n")).toContain("missing deployment_type");
    const badDetail = structuredClone(f) as { source_metadata: { additional_details: Record<string, unknown> } };
    badDetail.source_metadata.additional_details.n = 3;
    expect(errorsOf(SCHEMA, badDetail).join("\n")).toContain("source_metadata.additional_details.n: not string");
  });
});
