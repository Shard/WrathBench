#!/usr/bin/env bun
/**
 * Read the public bucket back and check that what is advertised is what is
 * actually there — the acceptance half of the publish transaction (GitHub
 * issue #31, criteria 1 and 2).
 *
 * The publisher (`infra/publish-core.ts`) proves ordering against a fake
 * bucket, and the renderer (`runner/viewer/snapshot.ts`) proves the projection
 * against a poisoned fixture. Neither proves anything about the objects a real
 * R2 bucket is holding right now: a PUT that succeeded, a prune that raced, a
 * publisher rolled back across a layout change, an object written by an older
 * binary. This walks the live generation instead and answers three questions:
 *
 * 1. **Is the generation complete?** The manifest names a key per aggregate and
 *    `runs.json` names four per run. Every one of them must be fetchable. The
 *    manifest is written last precisely so this cannot be half true, so a miss
 *    here is a real defect and is reported as one.
 * 2. **Does anything in it cross the content boundary?** Two independent
 *    checks, because one of them alone would be a re-statement of the
 *    publisher's own beliefs:
 *    - **Re-projection.** Every published body is fed back through the same
 *      `runner/viewer/public-projection.ts` function the renderer used, and the
 *      result must equal the body it came from. The projection is an allowlist
 *      that builds fresh objects, so it is a fixed point on its own output:
 *      any extra field, any un-nulled `apiBase`, any un-tokenised
 *      `pauseReason`, any entry key outside `ENTRY_FIELDS` shows up as a
 *      difference. This is the check that needs no list of bad words, and it
 *      reuses the predicates the projection suite already pins.
 *    - **Value scans.** Independent of the projection, because the projection
 *      could be wrong in the same way twice: filesystem paths, private/ported
 *      URLs, credential-shaped strings, tile references, an un-redacted
 *      `search_reference` result, a string-valued `objective`, a `pauseReason`
 *      that is neither null nor the fixed token.
 * 3. **What is actually there?** Object, run and byte counts, and the
 *    manifest's generation id, which is the evidence criterion 9 asks for.
 *
 * `cache-control` is reported, not asserted: Bun's S3 writer cannot send the
 * header (see the note at the top of `infra/publish-dashboard.ts`), so objects
 * land without it by design and the TTLs are set at the edge — by the zone's
 * cache rules in the Open shape, by the gate Worker in the Gated one. What the
 * S3 API can tell us is therefore only whether that is still true; the
 * through-host half of criterion 3 is a check against the host, not the bucket.
 *
 * **Read-only, structurally.** The source interface this file consumes has
 * `get` and `head` and nothing else — no put, no delete, not even a typed way
 * to express one — and the CLI at the bottom builds it from `Bun.S3Client` with
 * the same two methods. Running the verifier cannot change the bucket.
 *
 *   bun infra/publish-accept.ts            # S3_* from the environment
 *   bun infra/publish-accept.ts --json     # the report as JSON
 *
 * Exit code is 1 when anything is missing or any finding is raised, so the
 * check is usable from a script; the residual notes (below) never fail it.
 */

import {
  PUBLIC_ATTRIBUTION,
  projectCampaigns,
  projectEntries,
  projectEpisodes,
  projectFleet,
  projectInfo,
  projectModels,
  projectPositions,
  projectResults,
  projectRunDetail,
  projectRuns,
  projectTools,
  projectTrack,
} from "../runner/viewer/public-projection";
import { REDACTED_PROSE } from "../runner/viewer/redact-prose";
import { LOCAL_PATH_ROOTS } from "../runner/viewer/scrub-paths";
import { LIVE_PATH, MANIFEST_PATH } from "./publish-core";

/* ------------------------------------------------------------- the source --- */

/** What one object's metadata says, as far as the S3 API exposes it. */
export interface ObjectHead {
  size: number;
  contentType?: string | null;
  /** `null` when the store reports none — which is the expected state here. */
  cacheControl?: string | null;
}

/**
 * A read-only view of the bucket.
 *
 * Two methods, both reads. This is the whole reason the verifier cannot damage
 * the thing it is inspecting: there is no write path to call by accident, and a
 * caller wiring it to a real client has nothing else to wire.
 */
export interface AcceptSource {
  /** The object's body, or `null` when it is not there. */
  get(key: string): Promise<string | null>;
  /** Metadata, when the store exposes it. Optional: a source may not have it. */
  head?(key: string): Promise<ObjectHead | null>;
}

/* ------------------------------------------------------------- the report --- */

export type FindingKind =
  /** The manifest or a row names a key the bucket does not hold. */
  | "missing-object"
  /** A body did not survive being fed back through its own projection. */
  | "projection-drift"
  /** A local filesystem path in a published string. */
  | "filesystem-path"
  /** A host fact: a private address, a port, an api base. */
  | "host-fact"
  /** Something credential-shaped. */
  | "credential"
  /** A minimap tile reference; no snapshot artifact may name one. */
  | "tile-reference"
  /** A wiki dump archive by name: the operator's local bundle source. */
  | "wiki-dump-source"
  /** Wiki text: a `search_reference` result that is not the placeholder. */
  | "wiki-text"
  /** A field the projection withholds, present with a value. */
  | "withheld-field"
  /** The body is not what the layout says it is. */
  | "malformed"
  /** The attribution line every artifact must carry is missing or altered. */
  | "attribution";

export interface Finding {
  kind: FindingKind;
  /** The bucket key the finding is in. */
  key: string;
  /** Where inside the body, as a JSON path. */
  at: string;
  /** What was found, quoted or summarised — never invented. */
  detail: string;
}

export interface CacheObservation {
  key: string;
  kind: "mutable" | "immutable";
  /** What the store reported, or `null` for "no header on the object". */
  cacheControl: string | null;
}

export interface AcceptReport {
  /** The manifest's own identity (`gen`), which addresses nothing but names the flip. */
  gen: string;
  generatedAt: number | null;
  /** Aggregate name -> bucket key, as the manifest gave them. */
  artifacts: Record<string, string>;
  /** Runs listed in `runs.json`. */
  runs: number;
  /** Runs whose row carried snapshot pointers. */
  runsWithArtifacts: number;
  /** Objects fetched successfully (manifest and live included). */
  objects: number;
  /** Bytes of those objects, as fetched. */
  bytes: number;
  /** Keys named by the generation that the bucket did not hold. */
  missing: string[];
  /** Everything that must not be true of a public object. Empty is the pass. */
  findings: Finding[];
  /**
   * Model-authored strings that tripped a value scan.
   *
   * Not findings. `docs/PUBLIC-DASHBOARD.md` ("The content boundary") states
   * the residual plainly: the model's own turn text, snippet code, scratchpad
   * and episodic log are published as written and are not filtered. A path or
   * a URL the MODEL typed is therefore inside the accepted boundary, and
   * silently dropping it would hide it — so it is counted and shown, and does
   * not fail the run.
   */
  residual: Finding[];
  cache: CacheObservation[];
}

/* --------------------------------------------------------------- scanning --- */

/**
 * A local filesystem path. Anchored on the separator that follows a known root
 * so that a zone name, an in-game phrase or a `1/2` fraction cannot match.
 *
 * The roots come from `runner/viewer/scrub-paths.ts`, the module the projection
 * scrubs with, so the scrub and the verifier cannot drift apart. `wrathbench`
 * is deliberately still on that list after the scrub landed: a published string
 * that still carries the container prefix means the scrub did not run over it,
 * and this finding is how that regression surfaces.
 */
const FS_PATH = new RegExp(
  `(?:^|[\\s"'(=,:[])(\\/(?:${LOCAL_PATH_ROOTS.join("|")})\\/[^\\s"',)\\]]*|[A-Za-z]:\\\\\\\\[^\\s"',)\\]]*)`,
);

/** A host fact: an address or a port where a public reader should see a label. */
const HOST_FACT = /\b(?:https?:\/\/(?:\d{1,3}\.){3}\d{1,3}|https?:\/\/localhost|https?:\/\/[A-Za-z0-9.-]+:\d{2,5})/;

/** Credential shapes, from the providers this project actually holds keys for. */
const CREDENTIAL =
  /\b(?:Bearer\s+[A-Za-z0-9._~+/-]{12,}|sk-[A-Za-z0-9_-]{16,}|csk-[A-Za-z0-9]{16,}|gho_[A-Za-z0-9]{20,}|xox[abprs]-[A-Za-z0-9-]{10,})/;

/**
 * A wiki dump archive by name, as the bundle's `source` stamp carries it
 * (`…-history.xml.7z`).
 *
 * `wikiBundle` is already a withheld key, but that rule only catches the stamp
 * while it keeps its wrapper. The value itself — the operator's local dump file
 * — is a finding wherever it surfaces, including under a bare `source` one
 * layer inside an entry's comparability tuple, which is where it shipped
 * (item 123). The archive suffix is required, the way `FS_PATH` is anchored on
 * a known root: the stamp this exists to catch always carries one, and a bare
 * `.xml` would make every XML filename a model or a tool result happens to name
 * a finding — and a readback that cries wolf is one nobody re-runs.
 */
const WIKI_DUMP_SOURCE = /[A-Za-z0-9._-]+\.xml\.(?:7z|bz2|gz|zst)\b/;

/** A minimap tile: the prefix the tile publisher writes, or a raster file. */
const TILE_REFERENCE = /(?:^|[\s"'(/])tiles\/[^\s"']*|\.png\b/;

/**
 * Keys whose value the projection withholds outright. Presence is not the
 * fault — `apiBase: null` and `dashboardBuild: null` are what the projection
 * emits — a non-empty value is.
 */
const WITHHELD_KEYS: ReadonlySet<string> = new Set([
  "apiBase",
  "token",
  "apiKey",
  "apiKeyEnv",
  "authorization",
  "secret",
  "password",
  "pid",
  "fleetPid",
  "spawnedAt",
  "exitCode",
  "cwd",
  "bin",
  "rosterPath",
  "configPath",
  "wikiBundle",
  "sessionId",
  "moduleUrl",
  "dashboardBuild",
  "objective",
]);

/**
 * Strings the model wrote, by the key they arrive under.
 *
 * `text` and `code` are the model's turn text, its snippet source, the
 * scratchpad body, an episodic line, and the tool-result text it formatted —
 * exactly the surfaces the design doc calls the residual. A scan hit inside one
 * of these is reported as a residual note rather than a finding.
 */
const MODEL_AUTHORED: ReadonlySet<string> = new Set(["text", "code"]);

/** Walk every string in a parsed body, with the JSON path that reached it. */
function walkStrings(value: unknown, at: string, visit: (path: string, key: string, s: string) => void): void {
  if (typeof value === "string") return;
  if (Array.isArray(value)) {
    value.forEach((v, i) => {
      const path = `${at}[${i}]`;
      if (typeof v === "string") visit(path, lastKey(at), v);
      else walkStrings(v, path, visit);
    });
    return;
  }
  if (value === null || typeof value !== "object") return;
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    const path = at === "" ? k : `${at}.${k}`;
    if (typeof v === "string") visit(path, k, v);
    else walkStrings(v, path, visit);
  }
}

/** The object key an array path sits under, so `entries[3]` reports as `entries`. */
function lastKey(at: string): string {
  const tail = at.split(".").at(-1) ?? "";
  return tail.replace(/\[\d+\]$/, "");
}

/** Walk every (path, key, value) pair, strings included, for the key-level rules. */
function walkValues(value: unknown, at: string, visit: (path: string, key: string, v: unknown) => void): void {
  if (Array.isArray(value)) {
    value.forEach((v, i) => walkValues(v, `${at}[${i}]`, visit));
    return;
  }
  if (value === null || typeof value !== "object") return;
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    const path = at === "" ? k : `${at}.${k}`;
    visit(path, k, v);
    walkValues(v, path, visit);
  }
}

/** A quoted excerpt: enough to identify the hit, bounded so a report stays readable. */
function excerpt(s: string, at?: number): string {
  const start = at === undefined ? 0 : Math.max(0, at - 20);
  const cut = s.slice(start, start + 120);
  return JSON.stringify(cut.length < s.length ? `${cut}…` : cut);
}

/**
 * The value-level half of the content check, on one parsed body.
 *
 * Independent of the projection on purpose: if a projection function were
 * wrong, re-projection would agree with the bucket and say nothing.
 */
export function scanBody(key: string, body: unknown): { findings: Finding[]; residual: Finding[] } {
  const findings: Finding[] = [];
  const residual: Finding[] = [];

  walkStrings(body, "", (path, k, s) => {
    const where = MODEL_AUTHORED.has(k) ? residual : findings;
    const fs = FS_PATH.exec(s);
    if (fs !== null) where.push({ kind: "filesystem-path", key, at: path, detail: excerpt(s, fs.index) });
    const host = HOST_FACT.exec(s);
    if (host !== null) where.push({ kind: "host-fact", key, at: path, detail: excerpt(s, host.index) });
    const cred = CREDENTIAL.exec(s);
    // A credential is never inside the residual: the model has no business
    // holding one, and a match there would be a leak whoever typed it.
    if (cred !== null) findings.push({ kind: "credential", key, at: path, detail: excerpt(s, cred.index) });
    const tile = TILE_REFERENCE.exec(s);
    if (tile !== null) findings.push({ kind: "tile-reference", key, at: path, detail: excerpt(s, tile.index) });
    const dump = WIKI_DUMP_SOURCE.exec(s);
    if (dump !== null) where.push({ kind: "wiki-dump-source", key, at: path, detail: excerpt(s, dump.index) });
  });

  walkValues(body, "", (path, k, v) => {
    if (WITHHELD_KEYS.has(k) && v !== null && v !== "" && v !== false) {
      // `objective` is a boolean on the comparability tuple (whether one was
      // allowed) and free prose on a run row; only the prose is withheld.
      if (k === "objective" && typeof v !== "string") return;
      // Serialized, not `String(v)`: a withheld field is often an object (a
      // wiki bundle, a run config), and `[object Object]` would hide exactly
      // the part of the finding that says what leaked.
      findings.push({ kind: "withheld-field", key, at: path, detail: `${k} = ${excerpt(JSON.stringify(v) ?? String(v))}` });
    }
    if (k === "pauseReason" && v !== null && v !== "paused") {
      findings.push({ kind: "withheld-field", key, at: path, detail: `pauseReason = ${excerpt(String(v))}` });
    }
    // The reference tool's whole result is withheld (`WITHHELD_TOOLS` in
    // runner/viewer/redact-prose.ts); anything else there is wiki text.
    if (k === "name" && v === "search_reference") {
      const entry = valueAt(body, path.replace(/\.name$/, "")) as { text?: unknown } | undefined;
      if (entry !== undefined && typeof entry.text === "string" && entry.text !== REDACTED_PROSE) {
        findings.push({ kind: "wiki-text", key, at: `${path.replace(/\.name$/, "")}.text`, detail: excerpt(entry.text) });
      }
    }
  });

  return { findings, residual };
}

/** Resolve a JSON path produced by the walkers back to its value. */
function valueAt(body: unknown, path: string): unknown {
  let cur: unknown = body;
  for (const step of path.split(".")) {
    if (step === "") continue;
    const m = /^([^[]*)((?:\[\d+\])*)$/.exec(step);
    if (m === null) return undefined;
    if (m[1] !== "") {
      if (cur === null || typeof cur !== "object") return undefined;
      cur = (cur as Record<string, unknown>)[m[1]!];
    }
    for (const idx of m[2]!.matchAll(/\[(\d+)\]/g)) {
      if (!Array.isArray(cur)) return undefined;
      cur = cur[Number(idx[1])];
    }
  }
  return cur;
}

/* ---------------------------------------------------------- re-projection --- */

/** Sort keys recursively, so a compare is about content and never about order. */
export function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value === null || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(value as Record<string, unknown>).sort()) {
    out[k] = canonical((value as Record<string, unknown>)[k]);
  }
  return out;
}

/** The two envelope fields the renderer adds after projecting, stripped for the compare. */
function withoutEnvelope(body: Record<string, unknown>): Record<string, unknown> {
  const { generatedAt: _g, attribution: _a, ...rest } = body;
  return rest;
}

/**
 * Which projection a key's body must be a fixed point of.
 *
 * `null` means "no projector": the manifest is the index rather than a
 * projected response, and a scratchpad is the model's own file under one key.
 * Those still get the value scans.
 */
function projectorFor(key: string): ((payload: Record<string, unknown>) => unknown) | null {
  const name = key.split("/").at(-1) ?? "";
  if (key === MANIFEST_PATH) return null;
  if (key === LIVE_PATH) {
    return (p) => ({
      fleet: projectFleet(p["fleet"] as unknown as Parameters<typeof projectFleet>[0]),
      positions: projectPositions(p["positions"] as unknown as Parameters<typeof projectPositions>[0]),
    });
  }
  if (key.startsWith("v1/run/")) {
    if (name === "detail.json") return (p) => projectRunDetail(p as unknown as Parameters<typeof projectRunDetail>[0]);
    if (name === "track.json") return (p) => projectTrack(p as unknown as Parameters<typeof projectTrack>[0]);
    if (name === "entries.json") return (p) => projectEntries(p as unknown as Parameters<typeof projectEntries>[0]);
    return null; // scratchpad.json: `{ text }`, the model's own file.
  }
  if (name === "info.json") return (p) => projectInfo(p as unknown as Parameters<typeof projectInfo>[0]);
  if (name === "runs.json") return (p) => projectRuns(p as unknown as Parameters<typeof projectRuns>[0]);
  if (name === "results.json" || name.startsWith("ladder-")) {
    return (p) => projectResults(p as unknown as Parameters<typeof projectResults>[0]);
  }
  if (name === "episodes.json") return (p) => projectEpisodes(p as unknown as Parameters<typeof projectEpisodes>[0]);
  if (name === "models.json") return (p) => projectModels(p as unknown as Parameters<typeof projectModels>[0]);
  if (name === "campaigns.json") return (p) => projectCampaigns(p as unknown as Parameters<typeof projectCampaigns>[0]);
  if (name === "tools.json") return (p) => projectTools(p as unknown as Parameters<typeof projectTools>[0]);
  return null;
}

/**
 * Drop each row's `snapshot` before re-projecting `runs.json`.
 *
 * The renderer stamps those pointers on AFTER projecting — `projectRunListRow`
 * deliberately does not carry an input's — so a body that still had them would
 * differ from its own re-projection for a reason that is not a leak. They are
 * checked separately, by fetching every key they name.
 */
function stripSnapshotPointers(payload: Record<string, unknown>): Record<string, unknown> {
  const rows = payload["runs"];
  if (!Array.isArray(rows)) return payload;
  return {
    ...payload,
    runs: rows.map((r) => {
      if (r === null || typeof r !== "object") return r;
      const { snapshot: _s, ...rest } = r as Record<string, unknown>;
      return rest;
    }),
  };
}

/**
 * Feed a published body back through its own projection and diff the result.
 *
 * A difference is a finding: the projection builds fresh objects from an
 * allowlist, so its own output is a fixed point. What differs is named by JSON
 * path — the difference IS the leak, or the drift that would become one.
 */
export function reprojectionFindings(key: string, body: Record<string, unknown>): Finding[] {
  const project = projectorFor(key);
  if (project === null) return [];
  // The pointers come off BEFORE the compare as well as before the projection:
  // they are checked by fetching every key they name, not by this.
  const payload = key.endsWith("/runs.json") ? stripSnapshotPointers(withoutEnvelope(body)) : withoutEnvelope(body);
  let again: unknown;
  try {
    again = project(payload);
  } catch (e) {
    return [
      {
        kind: "malformed",
        key,
        at: "",
        detail: `re-projection threw: ${e instanceof Error ? e.message : String(e)}`,
      },
    ];
  }
  const differences: Finding[] = [];
  diff(canonical(payload), canonical(again), "", (at, mine, theirs) => {
    differences.push({
      kind: "projection-drift",
      key,
      at,
      detail: `published ${excerpt(JSON.stringify(mine) ?? "undefined")}, projection yields ${excerpt(JSON.stringify(theirs) ?? "undefined")}`,
    });
  });
  return differences.slice(0, 20);
}

/** Recursive structural diff, reporting the deepest path at which two values part. */
function diff(a: unknown, b: unknown, at: string, report: (at: string, a: unknown, b: unknown) => void): void {
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return report(at, `array of ${a.length}`, `array of ${b.length}`);
    a.forEach((v, i) => diff(v, b[i], `${at}[${i}]`, report));
    return;
  }
  if (a !== null && b !== null && typeof a === "object" && typeof b === "object" && !Array.isArray(a) && !Array.isArray(b)) {
    const keys = new Set([...Object.keys(a as object), ...Object.keys(b as object)]);
    for (const k of keys) {
      const path = at === "" ? k : `${at}.${k}`;
      const av = (a as Record<string, unknown>)[k];
      const bv = (b as Record<string, unknown>)[k];
      // An absent key and a key holding `undefined` are the same object once
      // serialized — `projectRunDetail` writes `foo: d.foo` for optional
      // fields — so only a value difference counts as a difference.
      if (av === undefined && bv === undefined) continue;
      if (av === undefined) report(path, undefined, bv);
      else if (bv === undefined) report(path, av, undefined);
      else diff(av, bv, path, report);
    }
    return;
  }
  if (!Object.is(a, b)) report(at, a, b);
}

/* -------------------------------------------------------------- the walk --- */

export interface VerifyOptions {
  /** Fetch metadata for the cache observation. Default true when the source has `head`. */
  cache?: boolean;
  /** Progress, one line at a time. */
  log?: (line: string) => void;
  /** Runs walked at once. Default 8, matching the renderer's own read pool. */
  concurrency?: number;
}

interface Manifest {
  gen?: unknown;
  artifacts?: unknown;
  generatedAt?: unknown;
  attribution?: unknown;
}

/**
 * Walk the generation the manifest points at and check every object in it.
 *
 * The order is the reader's: manifest first (it is the index), then the
 * aggregates it names, then `live.json`, then the four per-run objects each
 * `runs.json` row points at. Nothing is fetched that the generation does not
 * name — a listing is not consulted at all, because the question is whether
 * what is ADVERTISED resolves, not what else the bucket happens to hold.
 */
export async function verifyPublication(source: AcceptSource, opts: VerifyOptions = {}): Promise<AcceptReport> {
  const log = opts.log ?? ((): void => {});
  const report: AcceptReport = {
    gen: "",
    generatedAt: null,
    artifacts: {},
    runs: 0,
    runsWithArtifacts: 0,
    objects: 0,
    bytes: 0,
    missing: [],
    findings: [],
    residual: [],
    cache: [],
  };

  /** Fetch, count, parse, and run both content checks. Returns the parsed body. */
  const inspect = async (key: string): Promise<Record<string, unknown> | null> => {
    const body = await source.get(key);
    if (body === null) {
      report.missing.push(key);
      report.findings.push({ kind: "missing-object", key, at: "", detail: "named by the generation, not in the bucket" });
      return null;
    }
    report.objects += 1;
    report.bytes += Buffer.byteLength(body, "utf8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(body) as unknown;
    } catch (e) {
      report.findings.push({
        kind: "malformed",
        key,
        at: "",
        detail: `not JSON: ${e instanceof Error ? e.message : String(e)}`,
      });
      return null;
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      report.findings.push({ kind: "malformed", key, at: "", detail: "body is not a JSON object" });
      return null;
    }
    const obj = parsed as Record<string, unknown>;
    if (obj["attribution"] !== PUBLIC_ATTRIBUTION) {
      report.findings.push({
        kind: "attribution",
        key,
        at: "attribution",
        detail: `expected the approved line, found ${excerpt(String(obj["attribution"]))}`,
      });
    }
    const scan = scanBody(key, obj);
    report.findings.push(...scan.findings);
    report.residual.push(...scan.residual);
    report.findings.push(...reprojectionFindings(key, obj));
    return obj;
  };

  const manifest = (await inspect(MANIFEST_PATH)) as Manifest | null;
  if (manifest === null) return report;
  report.gen = typeof manifest.gen === "string" ? manifest.gen : "";
  report.generatedAt = typeof manifest.generatedAt === "number" ? manifest.generatedAt : null;
  if (report.gen === "") {
    report.findings.push({ kind: "malformed", key: MANIFEST_PATH, at: "gen", detail: "no generation id" });
  }
  const artifacts = manifest.artifacts;
  if (artifacts === null || typeof artifacts !== "object" || Array.isArray(artifacts)) {
    report.findings.push({
      kind: "malformed",
      key: MANIFEST_PATH,
      at: "artifacts",
      // A manifest with no `artifacts` map is pre-#38 (docs/PUBLIC-DASHBOARD.md,
      // "Bucket layout"), and its keys sit under one `gen` prefix instead.
      detail: "no artifacts map — a pre-2026-09-04 manifest, or a torn one",
    });
    return report;
  }
  report.artifacts = Object.fromEntries(
    Object.entries(artifacts as Record<string, unknown>).map(([k, v]) => [k, String(v)]),
  );
  log(`manifest gen ${report.gen}, ${Object.keys(report.artifacts).length} aggregates`);

  let runsBody: Record<string, unknown> | null = null;
  for (const [name, key] of Object.entries(report.artifacts)) {
    const body = await inspect(key);
    if (name === "runs.json") runsBody = body;
  }
  await inspect(LIVE_PATH);

  const rows = runsBody === null ? [] : ((runsBody["runs"] as unknown[]) ?? []);
  report.runs = rows.length;
  log(`${rows.length} runs listed`);
  // A run's four objects are four round trips, and a real tree is a thousand
  // runs; the walk is latency-bound, so it overlaps runs the way the renderer
  // overlaps its reads. Findings are sorted afterwards so a report does not
  // depend on which fetch finished first.
  let next = 0;
  const worker = async (): Promise<void> => {
    for (let i = next++; i < rows.length; i = next++) {
      const row = rows[i];
      if (row === null || typeof row !== "object") continue;
      const snapshot = (row as Record<string, unknown>)["snapshot"];
      if (snapshot === null || typeof snapshot !== "object") continue;
      report.runsWithArtifacts += 1;
      for (const which of ["detail", "track", "entries", "scratchpad"] as const) {
        const key = (snapshot as Record<string, unknown>)[which];
        // `entries` and `scratchpad` are optional pointers: a run with no
        // scratchpad.md simply has none, and that is not a missing object.
        if (typeof key !== "string") continue;
        await inspect(key);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(opts.concurrency ?? 8, Math.max(1, rows.length)) }, worker));
  report.missing.sort();
  const order = (f: Finding): string => `${f.key} ${f.at} ${f.kind}`;
  report.findings.sort((a, b) => order(a).localeCompare(order(b)));
  report.residual.sort((a, b) => order(a).localeCompare(order(b)));

  if (opts.cache !== false && source.head !== undefined) {
    const sample = [
      { key: MANIFEST_PATH, kind: "mutable" as const },
      { key: LIVE_PATH, kind: "mutable" as const },
      ...Object.values(report.artifacts).slice(0, 1).map((key) => ({ key, kind: "immutable" as const })),
    ];
    for (const s of sample) {
      const head = await source.head(s.key);
      report.cache.push({ key: s.key, kind: s.kind, cacheControl: head?.cacheControl ?? null });
    }
  }

  return report;
}

/* --------------------------------------------------------------- reporting --- */

export function describeAcceptReport(r: AcceptReport): string {
  const lines = [
    `generation ${r.gen || "(none)"}${r.generatedAt === null ? "" : ` generated ${new Date(r.generatedAt).toISOString()}`}`,
    `${r.objects} objects, ${(r.bytes / 1_000_000).toFixed(2)} MB, ${r.runs} runs (${r.runsWithArtifacts} with published artifacts), ${Object.keys(r.artifacts).length} aggregates`,
    `${r.missing.length} missing, ${r.findings.length} findings, ${r.residual.length} residual notes`,
  ];
  for (const c of r.cache) {
    lines.push(`cache-control ${c.kind} ${c.key}: ${c.cacheControl ?? "(none on the object)"}`);
  }
  for (const f of r.findings.slice(0, 50)) lines.push(`FINDING ${f.kind} ${f.key} ${f.at}: ${f.detail}`);
  if (r.findings.length > 50) lines.push(`… and ${r.findings.length - 50} more findings`);
  const byKind = new Map<string, number>();
  for (const f of r.residual) byKind.set(f.kind, (byKind.get(f.kind) ?? 0) + 1);
  for (const [kind, n] of byKind) lines.push(`residual (model-authored, published as written): ${kind} ×${n}`);
  return lines.join("\n");
}

/* --------------------------------------------------------------- the CLI --- */

if (import.meta.main) {
  const { S3Client } = await import("bun");
  for (const name of ["S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY", "S3_BUCKET", "S3_ENDPOINT"] as const) {
    if ((Bun.env[name] ?? "") === "" && (Bun.env[name.replace("S3_", "AWS_")] ?? "") === "") {
      console.error(`publish-accept: ${name} is not set (docs/OPERATIONS.md, "Public dashboard")`);
      process.exit(2);
    }
  }
  const s3 = new S3Client();
  const source: AcceptSource = {
    // One GET per object rather than an exists-then-get pair: a walk over a
    // thousand-run tree is four thousand objects, and the miss it is looking
    // for is exactly the error this catches.
    get: async (key) => {
      try {
        return await s3.file(key).text();
      } catch (e) {
        const code = (e as { code?: string }).code ?? "";
        if (code === "NoSuchKey" || code === "ERR_S3_FILE_NOT_FOUND" || /404|NoSuchKey/.test(String(e))) return null;
        throw e;
      }
    },
    // The S3 API's own metadata, plus one presigned HEAD so that a
    // `Cache-Control` on the object would be visible if it were ever set. Both
    // are reads; `presign` mints a URL and touches nothing.
    head: async (key) => {
      const file = s3.file(key);
      if (!(await file.exists())) return null;
      const stat = await file.stat();
      let cacheControl: string | null = null;
      try {
        const res = await fetch(s3.presign(key, { method: "HEAD", expiresIn: 60 }), { method: "HEAD" });
        cacheControl = res.headers.get("cache-control");
      } catch {
        cacheControl = null;
      }
      return { size: stat.size, contentType: stat.type ?? null, cacheControl };
    },
  };
  const json = process.argv.includes("--json");
  const report = await verifyPublication(source, { log: json ? undefined : (l) => console.error(l) });
  console.log(json ? JSON.stringify(report, null, 2) : describeAcceptReport(report));
  process.exit(report.missing.length === 0 && report.findings.length === 0 ? 0 : 1);
}
