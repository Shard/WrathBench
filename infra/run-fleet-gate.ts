/**
 * The subscription usage gate, the fleet's half (operator, 2026-10-16;
 * `runner/src/subscription-usage.ts` has the rule and the drivers' half).
 *
 * The supervisor reads the newest usage observation per subscription lane off
 * the runs on disk (meta.json's `subscriptionUsage`, carried on `RunFact`) —
 * and, for OpenCode Go, off Go's usage endpoint itself (`FleetGoUsage`) — and
 * asks one question of it at every place a launch can happen: is a launch of
 * this class (scored, freeplay, or a probe) held on this lane right now?
 *
 * - the policy's picks, where a held lane is passed over like a full cap — a
 *   claude pick takes another subscription if one is open, and the pick is
 *   HELD with the reason when none is (`planPolicyHeld`);
 * - the manual queue (a skip with the reason), the resume planner (the paused
 *   run is listed with the reason) and the pinned jobs (`gateSpawns`);
 * - a running roster's next episode: a running job whose lane is held for a
 *   scored or probe launch is drained, so its live episode finishes untouched
 *   and nothing more starts; the roster checks the same gate before every
 *   launch, for the episode that ends between two ticks. A running freeplay
 *   job is left alone: its driver pauses it at the turn boundary.
 *
 * The sentences here can reach a public surface (a held pick's reason, a
 * paused run's `why`), so they name the lane and the threshold's class and
 * never a percentage or a reset time; `formatSubscriptionGate` is the
 * operator's `--status` block, which carries both.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_CODEX_HOME_ENV } from "../runner/src/config";
import { goKeyEnvOf, subscriptionLaneOfConfig, type RunFact } from "../runner/src/models";
import { GoUsagePoller, goUsageUrl, type GoFetch } from "../runner/src/opencode-go";
import {
  SUB_FREEPLAY_MAX_ENV,
  SUB_SCORED_MAX_ENV,
  describeWindows,
  gateClassOf,
  newestByLane,
  parseSubscriptionUsage,
  subscriptionLaneOf,
  thresholdOf,
  usageHold,
  type SubscriptionThresholds,
  type SubscriptionUsage,
  type UsageHold,
} from "../runner/src/subscription-usage";
import type { FleetJob, FleetRosterEntry, JobSpawn } from "./run-fleet-config";
import type { RosterSpec } from "./run-roster";
import { ARCHIVE_DIR } from "../runner/viewer/archive-dir";

export interface FleetSubscriptionGate {
  thresholds: Pick<SubscriptionThresholds, "scored" | "freeplay">;
  now: number;
  /** The newest observation per lane. */
  usage: ReadonlyMap<string, SubscriptionUsage>;
  /** The hold on a launch of `episode`'s class on `lane`, or null (`usageHold`). */
  hold(lane: string | null, episode: string | null | undefined): UsageHold | null;
  /** Why such a launch is held, in words fit for any surface (no figures), or undefined. */
  holdOf(lane: string | null, episode: string | null | undefined): string | undefined;
}

/** The words for a hold: the lane and the class, never a figure. */
function holdWords(lane: string, episode: string | null | undefined, threshold: number): string {
  const cls = gateClassOf(episode);
  return threshold >= 100 || cls === "spent-only"
    ? `subscription gate: ${lane} has a spent usage window — held until it resets`
    : `subscription gate: ${lane} is at or over the ${cls} threshold — held until its usage window resets`;
}

/** The gate over a set of observations. Pure. */
export function subscriptionGate(
  observations: Iterable<SubscriptionUsage | null | undefined>,
  thresholds: Pick<SubscriptionThresholds, "scored" | "freeplay">,
  now: number,
): FleetSubscriptionGate {
  const usage = newestByLane(observations);
  const hold = (lane: string | null, episode: string | null | undefined): UsageHold | null =>
    lane === null ? null : usageHold(usage.get(lane), thresholdOf(gateClassOf(episode), thresholds), now);
  return {
    thresholds,
    now,
    usage,
    hold,
    holdOf: (lane, episode) => {
      const h = hold(lane, episode);
      return h === null || lane === null ? undefined : holdWords(lane, episode, h.threshold);
    },
  };
}

/** The gate over the runs on disk: each run's own newest reading, the newest per lane wins. */
export function subscriptionGateFromRuns(
  runs: readonly Pick<RunFact, "subscriptionUsage">[],
  thresholds: Pick<SubscriptionThresholds, "scored" | "freeplay">,
  now: number,
): FleetSubscriptionGate {
  return subscriptionGate(
    runs.map((f) => f.subscriptionUsage),
    thresholds,
    now,
  );
}

/**
 * Every run's newest usage reading, off meta.json alone (the archive's too):
 * the light read for the roster's pre-launch check and `--status`, which have
 * no run facts in hand. A directory without one, or with an unreadable
 * meta.json, contributes nothing.
 */
export function readLaneUsage(runsDir: string): SubscriptionUsage[] {
  const out: SubscriptionUsage[] = [];
  const scan = (dir: string): void => {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      if (name === ARCHIVE_DIR) continue;
      const path = join(dir, name, "meta.json");
      if (!existsSync(path)) continue;
      try {
        const meta = JSON.parse(readFileSync(path, "utf8")) as { subscriptionUsage?: unknown };
        const u = parseSubscriptionUsage(meta.subscriptionUsage);
        if (u !== undefined) out.push(u);
      } catch {
        // a torn or foreign meta.json is no reading
      }
    }
  };
  scan(runsDir);
  scan(join(runsDir, ARCHIVE_DIR));
  // The supervisor's own Go readings (`writeLaneUsageSidecar`).
  try {
    const raw = JSON.parse(readFileSync(join(runsDir, LANE_USAGE_SIDECAR), "utf8")) as { lanes?: unknown };
    for (const l of Array.isArray(raw.lanes) ? raw.lanes : []) {
      const u = parseSubscriptionUsage(l);
      if (u !== undefined) out.push(u);
    }
  } catch {
    // no sidecar yet
  }
  return out;
}

/** A run's lane, from what it recorded: its driver and its lane variable. */
export function laneOfRun(f: Pick<RunFact, "subscription"> & { driver?: string | null | undefined; lane?: string | null | undefined }): string | null {
  // `lane` is what `readRunFact` derived off the whole config (a Go key
  // included); the two fields are the fallback for a fact built by hand.
  return f.lane !== undefined ? f.lane : subscriptionLaneOf({ driver: f.driver ?? null, lane: f.subscription });
}

/** A roster spec's lane, as the roster will launch it. */
export function laneOfSpec(spec: Pick<RosterSpec, "driver" | "tokenEnv" | "model" | "apiBase" | "apiKeyEnv" | "billing">): string | null {
  return subscriptionLaneOfConfig({
    driver: spec.driver ?? "openai",
    model: spec.model,
    apiBase: spec.apiBase ?? null,
    apiKeyEnv: spec.apiKeyEnv ?? null,
    billing: spec.billing ?? null,
    subscription: spec.tokenEnv ?? null,
  });
}

/**
 * A roster entry's lane for a pick: a claude pick's candidate subscription
 * (`claudeLane`, the cap loop's choice), a codex pick's default home — the
 * lane a policy job's spawn runs on — or null for a driver with none.
 */
export function laneOfEntry(
  entry: Pick<FleetRosterEntry, "driver" | "model" | "apiBase" | "apiKeyEnv" | "billing"> | undefined,
  claudeLane?: string,
): string | null {
  if (entry === undefined) return null;
  if (entry.driver === "claude-code") return subscriptionLaneOf({ driver: "claude-code", lane: claudeLane !== undefined && claudeLane !== "" ? claudeLane : null });
  if (entry.driver === "codex") return subscriptionLaneOf({ driver: "codex", lane: DEFAULT_CODEX_HOME_ENV });
  // An OpenCode Go allowance entry (a Go base, paid billing), or nothing.
  return subscriptionLaneOfConfig({ ...entry, driver: entry.driver ?? "openai" });
}

/**
 * Why a queue or pinned job may not start, or undefined. A claude job with no
 * lane of its own is held only when every subscription it could take is: the
 * lane assignment then prefers an open one (`openClaudeLane`).
 */
export function jobHoldOf(
  job: Pick<FleetJob, "refs" | "episode" | "subscription">,
  roster: Readonly<Record<string, FleetRosterEntry>>,
  lanes: readonly string[],
  gate: FleetSubscriptionGate,
): string | undefined {
  for (const ref of job.refs) {
    const e = roster[ref];
    if (e?.driver === "claude-code") {
      const pinned = job.subscription ?? e.subscription;
      const candidates = pinned !== undefined ? [pinned] : lanes.length > 0 ? lanes : [undefined];
      const whys = candidates.map((l) => gate.holdOf(subscriptionLaneOf({ driver: "claude-code", lane: l ?? null }), job.episode));
      if (whys.every((w) => w !== undefined)) return whys[0];
    } else if (e?.driver === "codex") {
      const why = gate.holdOf(subscriptionLaneOf({ driver: "codex", lane: job.subscription ?? null }), job.episode);
      if (why !== undefined) return why;
    } else if (e !== undefined) {
      const why = gate.holdOf(laneOfEntry(e), job.episode);
      if (why !== undefined) return why;
    }
  }
  return undefined;
}

/** Whether a claude subscription is open for a launch of `episode`'s class. */
export function claudeLaneOpen(gate: FleetSubscriptionGate | undefined, lane: string, episode: string | null | undefined): boolean {
  return gate === undefined || gate.holdOf(subscriptionLaneOf({ driver: "claude-code", lane }), episode) === undefined;
}

/** A spawn the gate changed, and why. */
export interface GatedSpawn {
  name: string;
  why: string;
  /** True for a running job drained to its episode boundary; false for a start held. */
  drained: boolean;
}

/**
 * The gate applied to a tick's spawns (after the planners, beside the pause
 * switch): an enabled spawn with an entry whose lane is held for that entry's
 * class does not start, and a RUNNING one is drained to its episode boundary
 * — its live episode finishes untouched, the next does not launch — unless
 * it is a freeplay job, which its own driver pauses at the turn boundary
 * (`subscription-budget`). Pure; the supervisor logs `gated` once per change.
 */
export function gateSpawns(
  spawns: JobSpawn[],
  gate: FleetSubscriptionGate | undefined,
  running: ReadonlySet<string>,
): { spawns: JobSpawn[]; gated: GatedSpawn[] } {
  if (gate === undefined) return { spawns, gated: [] };
  const gated: GatedSpawn[] = [];
  const out = spawns.map((s) => {
    if (!s.enabled) return s;
    let why: string | undefined;
    for (const e of s.entries) {
      why = gate.holdOf(laneOfSpec(e), e.episode);
      if (why !== undefined) break;
    }
    if (why === undefined) return s;
    const live = running.has(s.name);
    if (live && s.entries.some((e) => e.episode === "freeplay")) return s;
    gated.push({ name: s.name, why, drained: live });
    return { ...s, enabled: false };
  });
  return { spawns: out, gated };
}

/** The lanes worth a row in `--status`: every one observed, and every one the config could launch on. */
export function gateLanes(
  gate: FleetSubscriptionGate,
  roster: Readonly<Record<string, Pick<FleetRosterEntry, "driver" | "model" | "apiBase" | "apiKeyEnv" | "billing">>>,
  claudeLanes: readonly string[],
): string[] {
  const out = new Set<string>(gate.usage.keys());
  const drivers = new Set(Object.values(roster).map((e) => e.driver));
  if (drivers.has("claude-code")) for (const l of claudeLanes) out.add(subscriptionLaneOf({ driver: "claude-code", lane: l })!);
  if (drivers.has("codex")) out.add(subscriptionLaneOf({ driver: "codex", lane: DEFAULT_CODEX_HOME_ENV })!);
  for (const go of goLanesOf(roster)) out.add(go.lane);
  return [...out].sort();
}

// ---------------------------------------------------------------- OpenCode Go

/** One OpenCode Go allowance the roster draws on: its lane, its usage endpoint, its key's env NAME. */
export interface GoLane {
  lane: string;
  url: string;
  keyEnv: string;
}

/** The Go allowances the roster's entries draw on (a Go base, paid billing), one per key. */
export function goLanesOf(roster: Readonly<Record<string, Pick<FleetRosterEntry, "driver" | "model" | "apiBase" | "apiKeyEnv" | "billing">>>): GoLane[] {
  const out = new Map<string, GoLane>();
  for (const e of Object.values(roster)) {
    const keyEnv = goKeyEnvOf({ ...e, driver: e.driver ?? "openai" });
    const url = goUsageUrl(e.apiBase);
    const lane = laneOfEntry(e);
    if (keyEnv === undefined || url === undefined || lane === null || out.has(lane)) continue;
    out.set(lane, { lane, url, keyEnv });
  }
  return [...out.values()];
}

/**
 * The supervisor's reader for the Go lanes (`opencode-go.ts`): one poller per
 * lane, each calling its endpoint at most once a minute, refreshed before a
 * tick decides anything. A key missing from the environment, or a reading that
 * fails, is no observation — said once per boot — and holds nothing. The key
 * is read from the environment at the call and never logged.
 */
export class FleetGoUsage {
  private readonly pollers = new Map<string, GoUsagePoller>();
  private readonly missingKey = new Set<string>();

  constructor(
    private readonly o: {
      env?: Record<string, string | undefined>;
      fetch?: GoFetch;
      now?: () => number;
      say?: (line: string) => void;
    } = {},
  ) {}

  /** Read every due lane the roster draws on; resolves when done. Never rejects. */
  async refresh(roster: Readonly<Record<string, Pick<FleetRosterEntry, "driver" | "model" | "apiBase" | "apiKeyEnv" | "billing">>>): Promise<void> {
    const env = this.o.env ?? process.env;
    const due: Promise<void>[] = [];
    for (const go of goLanesOf(roster)) {
      const key = env[go.keyEnv];
      if (key === undefined || key.length === 0) {
        if (!this.missingKey.has(go.lane)) {
          this.missingKey.add(go.lane);
          this.o.say?.(`subscription gate: ${go.keyEnv} is not set, so ${go.lane} is not read and holds nothing`);
        }
        continue;
      }
      let poller = this.pollers.get(go.lane);
      if (poller === undefined) {
        poller = new GoUsagePoller(go.lane, go.url, key, {
          ...(this.o.fetch !== undefined ? { fetch: this.o.fetch } : {}),
          ...(this.o.now !== undefined ? { now: this.o.now } : {}),
          ...(this.o.say !== undefined ? { onNote: (t: string) => this.o.say!(`subscription gate: ${t}`) } : {}),
        });
        this.pollers.set(go.lane, poller);
      }
      due.push(poller.refresh());
    }
    await Promise.all(due);
  }

  /** The newest reading of every lane read so far. */
  observations(): SubscriptionUsage[] {
    return [...this.pollers.values()].flatMap((p) => (p.current !== undefined ? [p.current] : []));
  }
}

/**
 * Where the supervisor leaves its own Go readings for the readers without a
 * poller — the roster's pre-launch check and `--status` (`readLaneUsage`).
 * Under the runs directory, operator-only like everything there.
 */
export const LANE_USAGE_SIDECAR = "fleet-subscription-usage.json";

/** Write the supervisor's readings beside the runs. Best effort: a failure is no reading for the others, never a stopped tick. */
export function writeLaneUsageSidecar(runsDir: string, usage: readonly SubscriptionUsage[]): void {
  try {
    writeFileSync(join(runsDir, LANE_USAGE_SIDECAR), `${JSON.stringify({ lanes: usage }, null, 2)}\n`, "utf8");
  } catch {
    // the runs on disk still carry their own readings
  }
}

/** "4m ago" — how old an observation is. */
function ago(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60_000));
  return m < 60 ? `${m}m ago` : m < 48 * 60 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`;
}

/**
 * `--status` / `--dry-run`: the gate per subscription lane — the newest
 * windows with their percentages and resets, how old the reading is, whether
 * a scored and a freeplay launch are held, and the thresholds. Operator-only:
 * the figures here never go to a public surface. `local` is the thresholds
 * this process read, shown when they differ from the supervisor's own.
 */
export function formatSubscriptionGate(
  gate: FleetSubscriptionGate,
  lanes: readonly string[],
  opts: { local?: Pick<SubscriptionThresholds, "scored" | "freeplay">; notes?: readonly string[] } = {},
): string[] {
  if (lanes.length === 0) return [];
  const t = gate.thresholds;
  const off = (pct: number): string => (pct >= 100 ? "off" : `at ${pct}%`);
  const out = [
    `subscription gate: scored starts held ${off(t.scored)}, freeplay held ${off(t.freeplay)} ` +
      `(${SUB_SCORED_MAX_ENV}, ${SUB_FREEPLAY_MAX_ENV}; 100 = off) — a spent window holds every launch on its lane until it resets:`,
  ];
  if (opts.local !== undefined && (opts.local.scored !== t.scored || opts.local.freeplay !== t.freeplay)) {
    out.push(`  (the fleet container's thresholds, off its state file; this shell's env reads scored ${opts.local.scored}%, freeplay ${opts.local.freeplay}%)`);
  }
  for (const n of opts.notes ?? []) out.push(`  !! ${n}`);
  for (const lane of lanes) {
    const u = gate.usage.get(lane);
    if (u === undefined) {
      out.push(`  ${lane}: no observation — open`);
      continue;
    }
    const state = (episode: string): string => {
      const h = gate.hold(lane, episode);
      return h === null ? "open" : `HELD until ${new Date(h.until).toISOString()}`;
    };
    const windows = u.windows.length > 0 ? describeWindows(u.windows, u.observedAt) : "no windows";
    out.push(`  ${lane}: ${windows}; observed ${ago(gate.now - u.observedAt)} — scored ${state("e90")}, freeplay ${state("freeplay")}`);
  }
  return out;
}
