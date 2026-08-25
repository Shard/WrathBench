/**
 * The publish engine behind the public dashboard's push loop.
 *
 * A renderer produces a full artifact set per pass (every object the public
 * bucket should hold for one generation); this file decides what to actually
 * PUT, in what order, and what to delete afterwards. It holds no CLI, no
 * credentials and no S3 SDK: the store is an interface and the state is a plain
 * object, so everything here is exercised against a fake bucket in memory.
 *
 * Three ideas carry the whole design.
 *
 * **Ordering is the point.** Readers resolve `manifest.json` and then follow it
 * to generation-addressed objects. So the manifest is written LAST, after every
 * object the new manifest can name is already in the bucket, and a failure
 * anywhere earlier aborts before the flip. A reader then sees either the whole
 * old generation or the whole new one — never a torn mix. Waves are barriers:
 * per-run objects, then aggregates, then the two mutable files.
 *
 * **Diffing is by key first, body hash second.** The renderer is free to
 * re-render everything every minute; almost none of it should cost a PUT. A
 * `v1/run/<id>/<ver>/` or `v1/snap/<gen>/` key is immutable by construction —
 * the key embeds the content version — so a key the bucket already holds is
 * skipped outright, whatever its body hashes to. That distinction is not
 * pedantry: every artifact carries a fresh `generatedAt` envelope, so bodies
 * differ on every pass and a hash-only diff would re-upload the entire corpus
 * every minute (hundreds of runs × 1,440 passes a day, straight through R2's
 * free Class A tier). Only the two mutable keys, and anything unrecognized, are
 * diffed by hash. `uploaded` is the memory of all this, and it is the reason
 * pruning must also *forget* a key it deletes — a key still remembered would
 * never be re-uploaded after the object behind it was removed.
 *
 * **Pruning is bounded and best-effort.** Immutable objects accumulate forever
 * otherwise. We keep the last few generations and the last couple of versions
 * per run; a delete that fails is retried next pass and never fails a publish,
 * because a leaked object costs a fraction of a cent and a failed publish costs
 * a minute of staleness.
 *
 * `docs/PUBLIC-DASHBOARD.md` is the design this implements.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

// ------------------------------------------------------------------ contracts

/**
 * One object to write to the bucket. Structurally identical to the renderer's
 * own type (`runner/viewer/snapshot.ts`); declared here so the engine and its
 * tests stand alone, and exported so the CLI that imports both can
 * `satisfies`-check that they still agree.
 */
export interface SnapshotArtifact {
  /** Bucket key, e.g. `v1/snap/<gen>/runs.json`. No leading slash. */
  path: string;
  /** Serialized JSON. */
  body: string;
  contentType: "application/json";
  cacheControl: string;
}

/** One rendered pass: the generation stamp and every object it consists of. */
export interface SnapshotResult {
  gen: string;
  artifacts: SnapshotArtifact[];
}

/**
 * The bucket, reduced to what publishing needs. Production wires this to
 * `Bun.S3Client` against R2; tests wire it to a recording fake. Deliberately
 * without a list operation: the engine's state is the inventory, so a pass
 * costs zero LIST requests and works the same against a fake.
 */
export interface ObjectStore {
  put(path: string, body: string, opts: { contentType: string; cacheControl: string }): Promise<void>;
  delete(path: string): Promise<void>;
}

// --------------------------------------------------------------------- layout

export const MANIFEST_PATH = "v1/manifest.json";
export const LIVE_PATH = "v1/live.json";
export const RUN_PREFIX = "v1/run/";
export const SNAP_PREFIX = "v1/snap/";

/** Generations kept in the bucket, newest first. Older ones are pruned. */
export const DEFAULT_KEEP_GENS = 5;
/** Content versions kept per run. See `planPrune` for why two is enough. */
export const DEFAULT_KEEP_RUN_VERSIONS = 2;
/** In-flight PUTs (or deletes) per wave. Waves themselves are barriers. */
export const DEFAULT_CONCURRENCY = 8;
/**
 * Deletes that keep failing are retried every pass; past this many the oldest
 * are dropped so a permanently unreachable object cannot grow the state file
 * without bound. Dropping one leaks the object, which is cheaper than the
 * alternative and is reported when it happens.
 */
export const PENDING_DELETE_CAP = 1000;

/** What a bucket key is, which decides both its wave and its prunability. */
export type PathKind =
  | { kind: "run"; runId: string; version: string }
  | { kind: "gen"; gen: string }
  | { kind: "mutable" }
  | { kind: "other" };

/**
 * Classify a bucket key. Only `run` and `gen` keys are ever prunable — anything
 * unrecognized is left alone rather than guessed at, so a layout change cannot
 * cause the engine to delete objects it does not understand.
 */
export function classifyPath(path: string): PathKind {
  if (path === MANIFEST_PATH || path === LIVE_PATH) return { kind: "mutable" };
  if (path.startsWith(RUN_PREFIX)) {
    const [runId, version, ...rest] = path.slice(RUN_PREFIX.length).split("/");
    if (runId !== undefined && runId !== "" && version !== undefined && version !== "" && rest.length > 0) {
      return { kind: "run", runId, version };
    }
    return { kind: "other" };
  }
  if (path.startsWith(SNAP_PREFIX)) {
    const [gen, ...rest] = path.slice(SNAP_PREFIX.length).split("/");
    if (gen !== undefined && gen !== "" && rest.length > 0) return { kind: "gen", gen };
    return { kind: "other" };
  }
  return { kind: "other" };
}

/** The three upload waves, in order. Named for the errors and the logs. */
export const WAVES = ["run", "aggregate", "mutable"] as const;
export type WaveName = (typeof WAVES)[number];

/**
 * Which wave a key belongs to. Anything unrecognized rides with the aggregates
 * — i.e. before the flip — because being written early is always safe and being
 * written after the manifest never is.
 */
export function waveOf(path: string): WaveName {
  const c = classifyPath(path);
  if (c.kind === "run") return "run";
  if (c.kind === "mutable") return "mutable";
  return "aggregate";
}

/**
 * Order inside the mutable wave: `live.json` first, `manifest.json` strictly
 * last. `live.json` is outside the generation chain (freshness beats
 * consistency for the fleet pips) but still precedes the flip, so a pass that
 * advertises a generation has already written everything a reader on that
 * manifest will ask for.
 */
function mutableRank(path: string): number {
  return path === MANIFEST_PATH ? 1 : 0;
}

// ---------------------------------------------------------------------- state

/**
 * Everything a pass needs to remember, and nothing else. Plain JSON: the CLI
 * persists it with `saveState`, the engine never reads a file.
 */
export interface PublishState {
  version: 1;
  /** Bucket key -> sha256 of the body we believe is behind it. */
  uploaded: Record<string, string>;
  /** Generation stamps whose manifest flip completed, oldest first. */
  gens: string[];
  /** Run id -> content versions in first-seen order, oldest first. */
  runVersions: Record<string, string[]>;
  /** Prune deletes that failed, retried best-effort on later passes. */
  pendingDeletes: string[];
  /** The generation the bucket's manifest last advertised. */
  lastGen?: string;
  /** Epoch ms of that flip. Operational breadcrumb; nothing reads it. */
  lastFlipAt?: number;
}

export function emptyState(): PublishState {
  return { version: 1, uploaded: {}, gens: [], runVersions: {}, pendingDeletes: [] };
}

/** sha256 of a body, hex. The only thing diffing compares. */
export function hashBody(body: string): string {
  return new Bun.CryptoHasher("sha256").update(body).digest("hex");
}

const asStringArray = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

/**
 * Coerce whatever is on disk into a usable state. Lenient on purpose: a state
 * file is a cache, not a source of truth. A field we cannot read costs at worst
 * some redundant PUTs and some un-pruned objects, which is a far better failure
 * than a publisher that refuses to start.
 */
export function parseState(json: string): PublishState {
  const raw = JSON.parse(json) as Record<string, unknown>;
  const state = emptyState();
  const uploaded = raw["uploaded"];
  if (uploaded !== null && typeof uploaded === "object") {
    for (const [k, v] of Object.entries(uploaded as Record<string, unknown>)) if (typeof v === "string") state.uploaded[k] = v;
  }
  state.gens = asStringArray(raw["gens"]);
  const runVersions = raw["runVersions"];
  if (runVersions !== null && typeof runVersions === "object") {
    for (const [k, v] of Object.entries(runVersions as Record<string, unknown>)) {
      const versions = asStringArray(v);
      if (versions.length > 0) state.runVersions[k] = versions;
    }
  }
  state.pendingDeletes = asStringArray(raw["pendingDeletes"]);
  if (typeof raw["lastGen"] === "string") state.lastGen = raw["lastGen"];
  if (typeof raw["lastFlipAt"] === "number") state.lastFlipAt = raw["lastFlipAt"];
  return state;
}

export function serializeState(state: PublishState): string {
  return `${JSON.stringify(state, null, 2)}\n`;
}

/**
 * Read the state file. A missing or unreadable one starts empty — the next pass
 * simply re-PUTs everything, which is correct, just wasteful once.
 */
export function loadState(path: string, log: (line: string) => void = () => {}): PublishState {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return emptyState();
  }
  try {
    return parseState(text);
  } catch (e) {
    log(`publish: ${path} is unreadable (${errorText(e)}) — starting from an empty state, this pass re-uploads everything`);
    return emptyState();
  }
}

/** Written tmp+rename: a pass killed mid-write must not leave a torn state file. */
export function saveState(path: string, state: PublishState): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, serializeState(state));
  renameSync(tmp, path);
}

/** Record a run's content version the first time we see it, preserving order. */
function registerRunVersion(state: PublishState, runId: string, version: string): void {
  const versions = (state.runVersions[runId] ??= []);
  if (!versions.includes(version)) versions.push(version);
}

/** Record a completed flip. Re-publishing the same generation is not history. */
function recordGen(state: PublishState, gen: string, at: number): void {
  const without = state.gens.filter((g) => g !== gen);
  without.push(gen);
  state.gens = without;
  state.lastGen = gen;
  state.lastFlipAt = at;
}

// ------------------------------------------------------------------ execution

export function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** A PUT wave that did not complete. Carries every failure, not just the first. */
export class PublishError extends Error {
  readonly wave: WaveName;
  readonly failures: { path: string; error: unknown }[];

  constructor(wave: WaveName, failures: { path: string; error: unknown }[]) {
    const first = failures[0];
    super(
      `publish: ${failures.length} of the ${wave} wave's uploads failed (${first?.path ?? "?"}: ${errorText(first?.error)})` +
        ` — the manifest was not flipped, the previous generation is still whole`,
    );
    this.name = "PublishError";
    this.wave = wave;
    this.failures = failures;
  }
}

/**
 * Run `fn` over `items` with at most `limit` in flight, settling all of them.
 *
 * By default a failure does not cancel its siblings: every object that *can*
 * land this pass should land, because the recorded successes are what make the
 * next pass cheap. `halt` inverts that for the mutable wave, where the point is
 * that `manifest.json` must not be written when the write before it failed.
 * Start order follows `items`, so a fake store sees a stable sequence.
 */
async function pooled<T>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<void>,
  halt = false,
): Promise<{ ok: T[]; failed: { item: T; error: unknown }[] }> {
  const ok: T[] = [];
  const failed: { item: T; error: unknown }[] = [];
  let next = 0;
  let stop = false;
  const worker = async (): Promise<void> => {
    for (;;) {
      if (stop) return;
      const i = next++;
      const item = items[i];
      if (item === undefined) return;
      try {
        await fn(item);
        ok.push(item);
      } catch (error) {
        failed.push({ item, error });
        if (halt) stop = true;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return { ok, failed };
}

// ---------------------------------------------------------------------- prune

export interface PruneLimits {
  keepGens?: number;
  keepRunVersions?: number;
}

/**
 * Which remembered objects are now surplus. Pure over the state, so the policy
 * is testable without a bucket.
 *
 * Two rules, and the second subsumes the "never touch the current or previous
 * generation" guarantee: a pass produces at most one version per run, so the
 * version a run had in the previous generation is at most one behind its
 * current one — keeping the last two per run keeps both by construction.
 * Generations are kept by stamp, newest `keepGens` of them.
 */
export function planPrune(state: PublishState, limits: PruneLimits = {}): string[] {
  const keepGens = Math.max(1, limits.keepGens ?? DEFAULT_KEEP_GENS);
  const keepRunVersions = Math.max(1, limits.keepRunVersions ?? DEFAULT_KEEP_RUN_VERSIONS);

  const liveGens = new Set(state.gens.slice(-keepGens));
  const liveVersions = new Map<string, Set<string>>();
  for (const [runId, versions] of Object.entries(state.runVersions)) liveVersions.set(runId, new Set(versions.slice(-keepRunVersions)));

  const surplus: string[] = [];
  for (const path of Object.keys(state.uploaded)) {
    const c = classifyPath(path);
    if (c.kind === "gen") {
      if (!liveGens.has(c.gen)) surplus.push(path);
    } else if (c.kind === "run") {
      if (liveVersions.get(c.runId)?.has(c.version) !== true) surplus.push(path);
    }
    // `mutable` and `other` are never prunable — see classifyPath.
  }
  return surplus.sort();
}

/** Drop the history the prune just acted on, so the lists stay bounded too. */
function trimHistory(state: PublishState, limits: PruneLimits): void {
  const keepGens = Math.max(1, limits.keepGens ?? DEFAULT_KEEP_GENS);
  const keepRunVersions = Math.max(1, limits.keepRunVersions ?? DEFAULT_KEEP_RUN_VERSIONS);
  if (state.gens.length > keepGens) state.gens = state.gens.slice(-keepGens);
  for (const [runId, versions] of Object.entries(state.runVersions)) {
    if (versions.length > keepRunVersions) state.runVersions[runId] = versions.slice(-keepRunVersions);
  }
}

// -------------------------------------------------------------------- publish

export interface PublishOptions extends PruneLimits {
  /** In-flight PUTs per wave. The mutable wave is always sequential. */
  concurrency?: number;
  /** Skip pruning entirely (backfill, or a first pass you want to inspect). */
  prune?: boolean;
  /** Where the engine's few narrative lines go. Silent by default. */
  log?: (line: string) => void;
  now?: () => number;
}

export interface PublishReport {
  gen: string;
  /** Keys PUT this pass, in the order they were written. */
  put: string[];
  /** Artifacts the bucket already held — by immutable key, or by body hash. */
  unchanged: number;
  /** Bytes uploaded — what the pass actually cost. */
  bytes: number;
  /** Keys deleted by pruning. */
  deleted: string[];
  /** Prune deletes that failed and will be retried next pass. */
  deleteFailures: string[];
  /** Whether the bucket's manifest now advertises `gen`. */
  flipped: boolean;
}

/**
 * Whether an artifact has to be written at all, given what the bucket already
 * holds. The whole cost model of the publisher lives in this function.
 *
 * Three regimes, and which one a key falls into is decided by `classifyPath`:
 *
 * - **Immutable keys** (`v1/run/<id>/<ver>/…`, `v1/snap/<gen>/…`) are
 *   *path-addressed*: the key names the content version, so the same key means
 *   the same logical content and first write wins. Present in the bucket ⇒
 *   never rewritten. This is what makes an idle fleet cost nothing: the bodies
 *   still differ every pass, because each carries a fresh `generatedAt`
 *   envelope, and honouring that difference would re-PUT the whole corpus every
 *   minute for a timestamp nobody reads off an immutable object.
 * - **The manifest** is the flip, and the flip is a generation. Re-writing it
 *   for a generation the bucket already advertises buys nothing and costs a PUT
 *   every pass forever, so an unchanged `gen` skips it. (Guarded on the key
 *   actually being in state: if we have no record of ever writing the manifest,
 *   write it.)
 * - **Everything else** — `live.json`, and any key the layout does not
 *   recognize — is diffed by body hash. `live.json` genuinely changes every
 *   pass: it carries the fleet clock the client reads staleness from, and it is
 *   deliberately outside the generation chain. An unrecognized key has no
 *   immutability guarantee to lean on, so it gets the conservative treatment.
 *
 * First write wins on an immutable key, which means a bad body written to one
 * is never repaired by a later pass. The repair is to delete the state file: an
 * empty state remembers no keys, so the next pass re-uploads everything. That
 * is the only recovery path, and it is why the state file is a cache the
 * operator may throw away rather than a record they must keep.
 */
export function needsPut(path: string, bodyHash: string, state: PublishState, gen: string): boolean {
  const kind = classifyPath(path).kind;
  if (kind === "run" || kind === "gen") return state.uploaded[path] === undefined;
  if (path === MANIFEST_PATH && gen === state.lastGen && state.uploaded[path] !== undefined) return false;
  return state.uploaded[path] !== bodyHash;
}

/**
 * Validate the renderer's output before a single byte moves. Each of these
 * would corrupt the bucket quietly rather than loudly: two artifacts on one key
 * make the winner arbitrary, and a `v1/snap/<other>/` key would attribute this
 * pass's objects to a generation the pruner is free to delete.
 */
function assertResult(result: SnapshotResult): void {
  if (result.gen === "") throw new Error("publish: the rendered result has no generation stamp");
  const seen = new Set<string>();
  for (const a of result.artifacts) {
    if (a.path === "" || a.path.startsWith("/")) throw new Error(`publish: ${JSON.stringify(a.path)} is not a bucket key (non-empty, no leading slash)`);
    if (seen.has(a.path)) throw new Error(`publish: two artifacts claim the key ${a.path}`);
    seen.add(a.path);
    const c = classifyPath(a.path);
    if (c.kind === "gen" && c.gen !== result.gen) {
      throw new Error(`publish: ${a.path} belongs to generation ${c.gen} but the pass renders ${result.gen}`);
    }
  }
}

/**
 * Publish one rendered pass.
 *
 * `state` is updated **in place** as objects land, including on the failure
 * path: when a wave throws, the successes before it are already recorded, so
 * the caller can persist the state and the next pass re-PUTs only what is
 * still missing. Callers that want the old state back should copy it first.
 */
export async function publish(result: SnapshotResult, store: ObjectStore, state: PublishState, opts: PublishOptions = {}): Promise<PublishReport> {
  const concurrency = Math.max(1, opts.concurrency ?? DEFAULT_CONCURRENCY);
  const log = opts.log ?? ((): void => {});
  const now = opts.now ?? Date.now;

  assertResult(result);

  const hashes = new Map(result.artifacts.map((a) => [a.path, hashBody(a.body)] as const));
  for (const a of result.artifacts) {
    const c = classifyPath(a.path);
    if (c.kind === "run") registerRunVersion(state, c.runId, c.version);
  }

  const report: PublishReport = { gen: result.gen, put: [], unchanged: 0, bytes: 0, deleted: [], deleteFailures: [], flipped: false };

  for (const wave of WAVES) {
    const inWave = result.artifacts.filter((a) => waveOf(a.path) === wave);
    // Stable start order: by path, except the mutable wave whose order is the
    // whole safety property (live.json, then manifest.json).
    inWave.sort((x, y) => (wave === "mutable" ? mutableRank(x.path) - mutableRank(y.path) : x.path < y.path ? -1 : x.path > y.path ? 1 : 0));

    const todo = inWave.filter((a) => needsPut(a.path, hashes.get(a.path)!, state, result.gen));
    report.unchanged += inWave.length - todo.length;

    const { failed } = await pooled(
      todo,
      wave === "mutable" ? 1 : concurrency,
      async (a) => {
        await store.put(a.path, a.body, { contentType: a.contentType, cacheControl: a.cacheControl });
        state.uploaded[a.path] = hashes.get(a.path)!;
        report.put.push(a.path);
        report.bytes += Buffer.byteLength(a.body, "utf8");
      },
      wave === "mutable",
    );
    if (failed.length > 0) throw new PublishError(wave, failed.map(({ item, error }) => ({ path: item.path, error })));
  }

  // The flip happened if the bucket's manifest now advertises this generation —
  // whether we wrote it this pass, or skipped it because it already did. The
  // skip is not a lesser outcome: pruning still proceeds, because the objects
  // the live manifest names are exactly the ones this pass just guaranteed.
  const manifest = result.artifacts.find((a) => a.path === MANIFEST_PATH);
  if (manifest === undefined) {
    log(`publish: gen ${result.gen} rendered no ${MANIFEST_PATH} — nothing was flipped and nothing was pruned`);
    return report;
  }
  report.flipped = true;
  recordGen(state, result.gen, now());

  if (opts.prune !== false) await runPrune(store, state, report, { keepGens: opts.keepGens, keepRunVersions: opts.keepRunVersions }, concurrency, log);
  return report;
}

/**
 * Delete surplus objects, plus whatever failed to delete on an earlier pass.
 * Never throws: the manifest is already flipped, the public site is already
 * correct, and a delete that fails is a retry, not an incident.
 */
async function runPrune(
  store: ObjectStore,
  state: PublishState,
  report: PublishReport,
  limits: PruneLimits,
  concurrency: number,
  log: (line: string) => void,
): Promise<void> {
  const targets = [...new Set([...state.pendingDeletes, ...planPrune(state, limits)])].sort();
  if (targets.length === 0) {
    trimHistory(state, limits);
    return;
  }

  const stillPending = new Set(state.pendingDeletes);
  const { ok, failed } = await pooled(targets, concurrency, async (path) => {
    await store.delete(path);
  });

  for (const path of ok) {
    delete state.uploaded[path];
    stillPending.delete(path);
    report.deleted.push(path);
  }
  for (const { item: path, error } of failed) {
    // Forgotten as uploaded either way: we no longer believe it is current.
    delete state.uploaded[path];
    stillPending.add(path);
    report.deleteFailures.push(path);
    log(`publish: could not delete ${path} (${errorText(error)}) — retrying next pass`);
  }

  let pending = [...stillPending].sort();
  if (pending.length > PENDING_DELETE_CAP) {
    const dropped = pending.length - PENDING_DELETE_CAP;
    pending = pending.slice(-PENDING_DELETE_CAP);
    log(`publish: ${dropped} object(s) have failed to delete for too long and are being forgotten — they stay in the bucket`);
  }
  state.pendingDeletes = pending;
  report.deleted.sort();
  report.deleteFailures.sort();
  trimHistory(state, limits);
}

/** The one line a pass is worth in a log. */
export function describeReport(report: PublishReport): string {
  const parts = [`${report.put.length} put`, `${(report.bytes / 1024).toFixed(1)} KiB`, `${report.unchanged} unchanged`];
  if (report.deleted.length > 0) parts.push(`${report.deleted.length} pruned`);
  if (report.deleteFailures.length > 0) parts.push(`${report.deleteFailures.length} deletes deferred`);
  parts.push(report.flipped ? "manifest flipped" : "no flip");
  return `publish: gen ${report.gen} — ${parts.join(", ")}`;
}

// ----------------------------------------------------------------------- loop

/** How the loop reaches its state file. Swapped for memory in tests. */
export interface StateIo {
  load(path: string, log: (line: string) => void): PublishState;
  save(path: string, state: PublishState): void;
}

export const fsStateIo: StateIo = { load: loadState, save: saveState };

export interface PublishLoopOptions extends PublishOptions {
  intervalMs?: number;
  /** One pass and return — backfill, smoke tests, cron-shaped invocations. */
  once?: boolean;
  signal?: AbortSignal;
  /** Injectable so tests do not wait on wall-clock time. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  io?: StateIo;
}

export interface PublishLoopSummary {
  passes: number;
  published: number;
  failed: number;
  lastGen?: string;
}

/** A sleep that a shutdown can cut short. */
export function sleepMs(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal?.aborted === true || ms <= 0) return resolve();
    let timer: ReturnType<typeof setTimeout>;
    const done = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });
}

/**
 * Render → publish → sleep, forever.
 *
 * A pass that throws is logged and the loop continues: transient S3 and network
 * errors are the expected weather for a publisher, and the design already makes
 * a failed pass harmless (the previous generation stays whole, and the next
 * pass re-PUTs only what is missing). The state is persisted after every pass,
 * failures included, because that partial progress is what makes the retry
 * cheap. Only an abort ends the loop.
 */
export async function publishLoop(
  render: () => Promise<SnapshotResult>,
  store: ObjectStore,
  statePath: string,
  opts: PublishLoopOptions = {},
): Promise<PublishLoopSummary> {
  const { intervalMs = 60_000, once = false, signal, io = fsStateIo, sleep = sleepMs, ...publishOpts } = opts;
  const log = opts.log ?? ((line: string): void => console.log(line));

  const state = io.load(statePath, log);
  const summary: PublishLoopSummary = { passes: 0, published: 0, failed: 0 };

  while (signal?.aborted !== true) {
    summary.passes++;
    try {
      const report = await publish(await render(), store, state, { ...publishOpts, log });
      summary.published++;
      summary.lastGen = report.gen;
      log(describeReport(report));
    } catch (e) {
      summary.failed++;
      log(`publish: pass ${summary.passes} failed — ${errorText(e)}`);
    }
    try {
      io.save(statePath, state);
    } catch (e) {
      // Losing the state costs redundant uploads next pass, not correctness.
      log(`publish: could not write ${statePath} (${errorText(e)}) — the next pass will re-upload more than it needs to`);
    }
    if (once) break;
    await sleep(intervalMs, signal);
  }
  return summary;
}
