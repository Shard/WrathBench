/**
 * The runner group's side of the viewer's API (`groups.ts`): the fleet
 * supervisor's published state and what only the runs directory knows about
 * it (`readFleet`, `heldAccounts`, `coldRuns`), and the group's routes,
 * `/api/fleet`, `/api/models` and `/api/tools`, which `createApi` (`api.ts`)
 * imports and mounts only with the group on.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { json } from "./http";
import { HARNESSES } from "../runner/src/drivers";
import type {
  FleetAccountView,
  FleetJobView,
  FleetPausedView,
  FleetRunFacts,
  FleetResponse,
  FleetServerView,
  FleetSessionView,
  ModelsResponse,
} from "./api-types";
import { fullRosterOf, modelsResponse } from "./models";
import { modelStates, outstandingWork } from "../runner/src/models";
import { toolsResponse } from "./tools";
import { runCost } from "./pricing";
import { projectFleet, projectModels, projectRunFacts, projectTools } from "./public-projection";
import { isValidRunId, readRun } from "../runner/src/run-list";
import { STORE_LAG_MS, type RunListingRow } from "./clickhouse";
import { STORE_SHARE_MS } from "./shared-store";
import { isArchiveDir } from "../runner/src/archive-dir";
import type { ApiContext } from "./api-context";

/**
 * How stale a run's files may be and still be read as holding its account.
 *
 * This is `run-roster.ts`'s `LIVE_TRAJECTORY_MS`, not `runner/src/run-list.ts`'s
 * `LIVE_WINDOW_MS` (120s): the job's run has to be resolved the same way the
 * account guard and `--status` resolve it, or the dashboard would disagree with
 * the supervisor about which run a job holds near the boundary. The constant
 * is duplicated rather than imported because importing from `infra/` would drag
 * its repo-root and process assumptions into the viewer.
 */
const ACCOUNT_HELD_MS = 3 * 60_000;

/**
 * Age of the most recently touched artefact of a run — either file, whichever.
 *
 * Deliberately narrower than `archive.ts`'s four-file version: an account is
 * held only while the run is still WRITING, and `meta.json` and `scratchpad.md`
 * are written once at launch, so counting them would keep an account held for
 * minutes after the writer died.
 */
function runActivityAge(dir: string, now: number): number | undefined {
  let newest: number | undefined;
  // `run.sqlite-wal`: a 0.5 run's database writes land there until a checkpoint;
  // a v1 run's session writer rewrites `live.json` on every tick.
  for (const name of ["trajectory.jsonl", "run.sqlite", "run.sqlite-wal", "session/live.json"]) {
    try {
      const m = statSync(join(dir, name)).mtimeMs;
      if (newest === undefined || m > newest) newest = m;
    } catch {
      // not written yet
    }
  }
  return newest === undefined ? undefined : now - newest;
}

/** The account a run was launched against, straight off its own meta.json. */
function accountOfRun(dir: string): string | undefined {
  try {
    const meta = JSON.parse(readFileSync(join(dir, "meta.json"), "utf8")) as {
      config?: { account?: unknown };
    };
    const a = meta.config?.account;
    // No recorded account means no claim: `accountHeldBy` skips such a run too,
    // rather than guessing that it took the default one.
    return typeof a === "string" && a.length > 0 ? a : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Which run holds each account right now, by the same inference `--status`
 * makes (`accountHeldBy` in `run-roster.ts`): a run whose files are warm, with
 * no termination row and no pause row. A paused run has already given its
 * session back, so it holds nothing — the job reads as idle, not as driving a
 * run it has finished with.
 *
 * The map is keyed on account, not on job: a hand-started run, or a previous
 * cycle that has not gone cold, holds the account just as hard as a fleet one
 * and will show under the job that shares it. That is the honest reading of
 * "what has this account" — `--status` says the same, adding only that the
 * holder is "not fleet-managed" when the job's own process is gone.
 *
 * The prefilter is the point. `/api/fleet` polls every five seconds and a runs
 * directory holds hundreds of finished runs; only the handful whose files were
 * touched inside the window are opened. Where `accountHeldBy` takes the first
 * readdir match, this takes the freshest, which is the honest answer when a
 * crashed run and its successor briefly overlap.
 *
 * `cold` goes one step earlier, for a caller with the derived store: the runs
 * the store already knows cannot hold an account (`coldRuns`), which are not
 * even stat'ed. Two stats per run directory on the fleet's iSCSI volume were
 * 55-74 ms a poll over ~1,900 directories, nearly all of them long finished.
 * A directory the store has no row for is never in it: that is a run in its
 * first seconds, exactly when its job holds the account.
 */
export function heldAccounts(
  runsDir: string,
  now = Date.now(),
  cold: ReadonlySet<string> = new Set(),
): Map<string, { runId: string; model: string | null }> {
  const out = new Map<string, { runId: string; model: string | null; age: number }>();
  let names: string[];
  try {
    names = readdirSync(runsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && isValidRunId(d.name) && !isArchiveDir(d.name) && !cold.has(d.name))
      .map((d) => d.name);
  } catch {
    return new Map();
  }
  for (const id of names) {
    const dir = join(runsDir, id);
    const age = runActivityAge(dir, now);
    if (age === undefined || age >= ACCOUNT_HELD_MS) continue;
    const account = accountOfRun(dir);
    if (account === undefined) continue;
    const row = readRun(runsDir, id, now);
    if (row.terminationReason !== null || row.pauseReason !== null) continue;
    const key = account.toUpperCase();
    const prev = out.get(key);
    if (prev === undefined || age < prev.age) out.set(key, { runId: id, model: row.model, age });
  }
  return new Map([...out].map(([k, v]) => [k, { runId: v.runId, model: v.model }]));
}

/**
 * The run ids the store already knows hold no account: terminated (final; a
 * resume clears a pause, never a termination), or with a trajectory the store
 * last saw older than the hold window plus its own lag. The pause column is
 * not read: the files, not the store, answer whether a warm run is paused.
 *
 * The one lag this admits: a run paused for longer than that window and then
 * resumed in place (same run id) is ruled out until the collector's next pass
 * records its fresh trajectory, so its job shows no run for up to one
 * collector poll (five seconds, more when the collector is behind). The map's
 * feed has the same prefilter and the same delay.
 */
export function coldRuns(rows: readonly RunListingRow[], now: number): Set<string> {
  const out = new Set<string>();
  for (const r of rows) {
    const quiet = r.trajectory_mtime !== 0 && now - r.trajectory_mtime >= ACCOUNT_HELD_MS + STORE_LAG_MS;
    if (r.termination_reason.length > 0 || quiet) out.add(r.run_id);
  }
  return out;
}

/** Keyed by the union, so the compiler holds this set to `FleetServerView["phase"]` both ways. */
const SERVER_PHASE_KEYS: Record<FleetServerView["phase"], true> = {
  running: true,
  draining: true,
  waiting: true,
  verifying: true,
  resuming: true,
  failed: true,
};
export const SERVER_PHASES: ReadonlySet<string> = new Set(Object.keys(SERVER_PHASE_KEYS));

/**
 * Read the deploy script's phase file. Absent (or unreadable, or nonsense) is
 * `running` with nothing to say: the only state a page can safely assume.
 */
export function readServerState(runsDir: string, now = Date.now()): FleetServerView {
  const rest: FleetServerView = { phase: "running", since: now, build: "", detail: "", updatedAt: now };
  const path = join(runsDir, "server-state.json");
  if (!existsSync(path)) return rest;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<FleetServerView>;
    if (typeof raw.phase !== "string" || !SERVER_PHASES.has(raw.phase)) return rest;
    return {
      phase: raw.phase,
      since: typeof raw.since === "number" ? raw.since : now,
      build: typeof raw.build === "string" ? raw.build : "",
      detail: typeof raw.detail === "string" ? raw.detail : "",
      updatedAt: typeof raw.updatedAt === "number" ? raw.updatedAt : now,
    };
  } catch {
    return rest;
  }
}

/** Read the fleet supervisor's published state. Absent is normal, not an error. */
export function readFleet(runsDir: string, now = Date.now(), cold: ReadonlySet<string> = new Set()): FleetResponse {
  const path = join(runsDir, "fleet-state.json");
  const server = readServerState(runsDir, now);
  const absent: FleetResponse = { present: false, server, jobs: [], accounts: [], paused: [], ended: [], now };
  if (!existsSync(path)) return absent;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as {
      fleetPid?: number;
      startedAt?: number;
      heartbeatAt?: number;
      containerized?: boolean;
      stamp?: string;
      configLoadedAt?: number;
      configRejected?: { since: number; error: string; mtime: number };
      preflight?: FleetResponse["preflight"];
      jobs?: Record<string, Omit<FleetJobView, "name" | "accountClass" | "runId" | "model">>;
      accounts?: { pinned?: Record<string, string>; pool?: Record<string, string | null> };
      credentials?: FleetResponse["credentials"];
      worlds?: FleetResponse["worlds"];
      worldsHold?: string;
      paused?: FleetPausedView[];
      ended?: FleetResponse["ended"];
      session?: FleetSessionView;
    };
    const held = heldAccounts(runsDir, now, cold);
    const classOf = new Map<string, FleetAccountView["class"]>();
    for (const a of Object.keys(raw.accounts?.pool ?? {})) classOf.set(a.toUpperCase(), "pool");
    /*
     * Jobs as the supervisor wrote them — the job (ref, tier, account, source)
     * and its process — plus what only the runs directory knows: the run
     * holding the job's account. `rosterPath`/`jsonl`/`log` stay behind: they
     * are paths on the supervisor's side of the mount.
     */
    const jobs: FleetJobView[] = Object.entries(raw.jobs ?? {})
      .map(([name, j]) => {
        const run = held.get(j.account.toUpperCase());
        return {
          name,
          ref: j.ref,
          // Unknown stays unknown: the supervisor writes null rather than a guess.
          episode: j.episode ?? null,
          account: j.account,
          accountClass: classOf.get(j.account.toUpperCase()) ?? "pinned",
          source: j.source,
          ...(j.attempt !== undefined ? { attempt: j.attempt } : {}),
          ...(j.resuming !== undefined ? { resuming: j.resuming } : {}),
          models: Array.isArray(j.models) ? j.models : [],
          runId: run?.runId ?? null,
          model: run?.model ?? null,
          pid: j.pid,
          spawnedAt: j.spawnedAt,
          exitCode: j.exitCode ?? null,
          draining: j.draining === true,
          alive: j.alive === true,
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
    /*
     * Accounts, pinned then the pool, with what holds each: the idle rows of
     * the fleet table. A pinned account the pool also lists (the coexistence
     * rule) is the pool's, so `pinned` is filtered against the pool rather
     * than concatenated with it.
     */
    const accounts: FleetAccountView[] = [
      ...Object.entries(raw.accounts?.pinned ?? {})
        .filter(([a]) => !classOf.has(a.toUpperCase()))
        .map(([account, job]) => ({ account, class: "pinned" as const, job })),
      ...Object.entries(raw.accounts?.pool ?? {}).map(([account, job]) => ({ account, class: "pool" as const, job })),
    ];
    // `fleetConfig` is deliberately not forwarded: it is a host path, and the
    // API says what the fleet is doing, not where this machine keeps things.
    // The rejection's file mtime stays behind for the same reason.
    return {
      present: true,
      server,
      fleetPid: raw.fleetPid,
      startedAt: raw.startedAt,
      heartbeatAt: raw.heartbeatAt,
      containerized: raw.containerized,
      stamp: raw.stamp,
      ...(raw.configLoadedAt !== undefined ? { configLoadedAt: raw.configLoadedAt } : {}),
      ...(raw.configRejected !== undefined ? { configRejected: { since: raw.configRejected.since, error: raw.configRejected.error } } : {}),
      ...(raw.preflight !== undefined ? { preflight: raw.preflight } : {}),
      jobs,
      accounts,
      paused: Array.isArray(raw.paused) ? raw.paused : [],
      ended: Array.isArray(raw.ended) ? raw.ended : [],
      ...(raw.session !== undefined ? { session: raw.session } : {}),
      ...(Array.isArray(raw.credentials) ? { credentials: raw.credentials } : {}),
      ...(Array.isArray(raw.worlds) ? { worlds: raw.worlds } : {}),
      ...(typeof raw.worldsHold === "string" ? { worldsHold: raw.worldsHold } : {}),
      now,
    };
  } catch {
    return absent;
  }
}

/**
 * The runs the fleet table has a row for, by the table's own rule
 * (`fleetRows` in `dashboard/src/lib/fleet.ts`): each job's run, and on each
 * account no job is on, the first paused run the supervisor lists against it.
 * The rest of the paused list is the page's folded list of ids, which shows no
 * figures.
 */
export function fleetRunIds(f: Pick<FleetResponse, "jobs" | "accounts" | "paused">): string[] {
  const ids = new Set<string>();
  const busy = new Set<string>();
  for (const j of f.jobs) {
    busy.add(j.account.toUpperCase());
    if (j.runId !== null) ids.add(j.runId);
  }
  for (const a of f.accounts) {
    if (busy.has(a.account.toUpperCase())) continue;
    const here = f.paused.find((p) => (p.account ?? "").toUpperCase() === a.account.toUpperCase());
    if (here !== undefined) ids.add(here.runId);
  }
  return [...ids];
}

/**
 * The supervisor's state without the rows that name a withheld run. The
 * supervisor never schedules one, but a hand launch can still be paused or
 * ended on its watch, and a job row names its run.
 */
export function withoutRuns(f: FleetResponse, withheld: ReadonlySet<string>): FleetResponse {
  if (withheld.size === 0) return f;
  return {
    ...f,
    jobs: f.jobs.map((j) => (j.runId !== null && withheld.has(j.runId) ? { ...j, runId: null, model: null } : j)),
    paused: f.paused.filter((p) => !withheld.has(p.runId)),
    ended: f.ended.filter((e) => !withheld.has(e.runId)),
    ...(f.runFacts !== undefined ? { runFacts: f.runFacts.filter((r) => !withheld.has(r.runId)) } : {}),
  };
}

/**
 * The runner group's routes over the handle's shared state (`ApiContext`):
 * `/api/fleet`, `/api/models` and `/api/tools`, or null for any other path.
 */
export function createFleetApi(ctx: ApiContext): (url: URL, path: string) => Promise<Response | null> {
  const {
    runsDir,
    store,
    publicMode,
    groups,
    pub,
    fleetRoster,
    harnessFilter,
    runRows,
    allTotals,
    withResolved,
    runFacts,
    unpublishedRuns,
    runRowOne,
    runTotals,
    listRowOf,
  } = ctx;

  /**
   * The fleet table's figures for the runs it shows: every run a job is
   * driving, and the paused run each idle account's row names (`fleetRunIds`)
   * — a handful, where the runs index is every run on disk and the
   * supervisor's paused list can be long. Point reads per run (`runRowOne`,
   * `runTotals`), never the corpus-wide ones: on the five-second fleet poll
   * those would be megabytes a tick that only `/api/runs` and `/api/models`
   * ever shared. `runRowOne` falls back to the run's own files only for a run
   * the store has not seen yet, its first seconds, whose files the account
   * scan (`heldAccounts`) has just opened anyway. A run that cannot be read
   * is left out, and its row shows dashes, as a run missing from the index did.
   *
   * Shared over `STORE_SHARE_MS` for the same set of runs, as the corpus-wide
   * reads are: every open tab's status badge polls this route, so N tabs cost
   * one set of reads a window rather than N.
   */
  function fleetRunFacts(f: FleetResponse, now: number): Promise<FleetRunFacts[]> {
    const ids = fleetRunIds(f).filter(isValidRunId);
    const key = [...ids].sort().join("\n");
    if (factsHeld !== undefined && factsHeld.key === key && Date.now() - factsHeld.at < STORE_SHARE_MS) return factsHeld.value;
    const value = readFleetRunFacts(ids, now);
    const held = { at: Date.now(), key, value };
    factsHeld = held;
    value.catch(() => {
      if (factsHeld === held) factsHeld = undefined;
    });
    return value;
  }
  let factsHeld: { at: number; key: string; value: Promise<FleetRunFacts[]> } | undefined;

  async function readFleetRunFacts(ids: readonly string[], now: number): Promise<FleetRunFacts[]> {
    const facts = await Promise.all(
      ids.map(async (id) => {
        try {
          const [raw, totals] = await Promise.all([runRowOne(id, now), runTotals(id)]);
          return projectRunFacts(listRowOf(raw, totals));
        } catch {
          return null;
        }
      }),
    );
    return facts.filter((x): x is FleetRunFacts => x !== null);
  }

  async function fleetRoute(url: URL, path: string): Promise<Response | null> {
    /* The model-facing tool list, off `toolsFor` at request time (`tools.ts`); harness text only. */
    if (path === "/api/tools") return pub(toolsResponse(), projectTools);
    if (path === "/api/fleet") {
      /*
       * The supervisor's published state, plus one thing only the roster and
       * the run history know: how many counted runs the policy still owes
       * (`outstandingWork` in `runner/src/models.ts`, where the bounds and the
       * ETA formula are written out). Computed here rather than published by
       * the supervisor so it is right with the fleet down, and off the same
       * projection `/api/models` serves — the page cannot disagree with the
       * models table about who owes what.
       */
      const now = Date.now();
      const listing = await store.runListing();
      const cold = coldRuns(listing, now);
      const withheld: ReadonlySet<string> = publicMode ? new Set(await unpublishedRuns()) : new Set();
      const body = withoutRuns(readFleet(runsDir, now, cold), withheld);
      /*
       * What the table's rows show, and the count its link to the runs index
       * names, carried here so the fleet page need not read that whole index
       * (2.4 MB) to fill five rows. The count is the index's own set — the
       * store's unarchived runs, less what a public handle withholds — off the
       * liveness listing this route reads anyway.
       */
      body.runFacts = await fleetRunFacts(body, now);
      body.runCount = listing.filter((r) => r.archived === 0 && !withheld.has(r.run_id)).length;
      const roster = fullRosterOf(fleetRoster());
      if (roster.shape === "roster") {
        const runs = await runFacts(now);
        const states = modelStates({ runsDir, roster: roster.models, policy: roster.policy, runs, now });
        body.outstanding = outstandingWork({
          states,
          excluded: roster.excluded.map((e) => e.name),
          accounts: roster.accounts,
          credentials: roster.credentials,
          maxSessions: roster.policy.maxSessions,
        });
      }
      return pub(body, projectFleet);
    }
    /*
     * `/api/models` is the scheduler's own verdict, served rather than
     * recomputed: `modelStates` in `runner/src/models.ts` is what the fleet
     * supervisor schedules on and what `--status` prints, so the page and the
     * supervisor cannot disagree about why a model is not running. The route
     * adds only the run ids behind each count and the last error text.
     */
    if (path === "/api/models") {
      const harness = harnessFilter(url);
      if (harness === null) {
        return json({ error: `unknown harness; one of: ${[...HARNESSES, "all"].join(", ")}` }, 400);
      }
      const now = Date.now();
      const roster = fullRosterOf(fleetRoster());
      const runs = await runFacts(now);
      const states = modelStates({ runsDir, roster: roster.models, policy: roster.policy, runs, now });
      // The refs with a job in flight, off the supervisor's state: the verdict
      // says "running (one character per model)" exactly where --status does.
      const cold = coldRuns(await store.runListing(), now);
      const jobs = readFleet(runsDir, now, cold).jobs;
      const running = new Set(jobs.flatMap((j) => j.ref.split("+")));
      // A probe in flight holds only its own entry, never the model's others.
      const holding = new Set(jobs.filter((j) => j.episode !== "probing").flatMap((j) => j.ref.split("+")));
      const body: ModelsResponse = modelsResponse({ states, runs, runsDir, roster, now, harness, running, holding, evals: groups.evals });
      /*
       * Cost is attached here rather than in the projection: `runner/src/models.ts`
       * is what the supervisor schedules on and knows nothing about prices, and
       * the figure must be the listing's own — same memoised totals, same
       * `runCost` — or the two pages would quote different dollars for one run.
       */
      const [rowList, totalsByRun] = await Promise.all([runRows(now), allTotals()]);
      const rows = new Map(rowList.map((r) => [r.runId, r]));
      for (const row of body.models) {
        for (const r of row.runs) {
          const totals = totalsByRun.get(r.runId) ?? null;
          // The run's own record, not the roster entry: whether a model is local
          // is a fact about the `apiBase` it was actually served from.
          const rawRow = rows.get(r.runId);
          const runRow = rawRow === undefined ? undefined : withResolved(rawRow, totals);
          r.cost =
            totals === null || runRow === undefined
              ? null
              : runCost({
                  run: runRow,
                  tokens: totals.tokens,
                  reportedUsd: totals.reportedCostUsd,
                  coverage: totals.responseCost,
                });
          /*
           * The starting character rides along from the same row, so the panel
           * can label an extras-cycle run without the scheduler's
           * projection having to learn about races.
           */
          r.race = runRow?.race ?? null;
          r.raceName = runRow?.raceName ?? null;
          r.class = runRow?.class ?? null;
          r.className = runRow?.className ?? null;
          r.characterLabel = runRow?.characterLabel ?? null;
          /*
           * Which model this run was really on. The row keeps its roster
           * grouping — that is the unit the scheduler counts in — and the ids
           * are collected below, so an alias that resolved two ways shows both
           * rather than one of them standing for the other.
           */
          r.resolvedModel = runRow?.resolvedModel ?? null;
        }
        row.resolvedModels = [
          ...new Set(row.runs.map((r) => r.resolvedModel).filter((m): m is string => typeof m === "string")),
        ].sort();
      }
      return pub(body, projectModels);
    }
    return null;
  }

  return fleetRoute;
}
