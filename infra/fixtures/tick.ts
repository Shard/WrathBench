/**
 * A tick's snapshot for a test: the config, the runs, and whatever else a
 * test names, everything else empty (`TickSnapshot`), so a test plans the
 * supervisor's own tick (`planTick`) over a fixture without the I/O.
 */
import type { FleetConfig, FleetJob, JobSource } from "../run-fleet-config";
import type { EpisodeId } from "../../runner/src/episodes";
import { holdsAssignment, planTick, type TickPlan, type TickSnapshot } from "../run-fleet-plan";
import type { ReadHold, RunPodsSetting, WorldsSetting } from "../run-fleet-credentials";
import type { RunFact, UnstampedRun } from "../../runner/src/run-fact";
import { emptyModelLists } from "../../runner/src/model-lists";
import type { SubscriptionUsage } from "../../runner/src/subscription-usage";
import type { CampaignFile } from "../../runner/src/campaign-file";

/** A job of the supervisor's with a live process. */
export interface RunningJob {
  name: string;
  account: string;
  refs: readonly string[];
  /** Absent: a policy job, which holds its refs whatever the config says. */
  source?: JobSource;
  placed?: FleetJob["placed"];
  accounts?: readonly string[];
  fanout?: true;
  episode?: EpisodeId | null;
  probe?: FleetJob["probe"];
  /** The run ids its process plays. */
  runIds?: readonly string[];
  /** The job as the tick that spawned it planned it, kept verbatim; the fields above then only name it. */
  job?: FleetJob;
}

export interface TickFixture {
  runs?: readonly RunFact[];
  unstamped?: readonly UnstampedRun[];
  now?: number;
  stamp?: string;
  /** Who holds an account; asked of every account the config and the runs name. */
  held?: (account: string) => string | undefined;
  running?: readonly RunningJob[];
  finished?: readonly string[];
  /** The `repeat` each finished job was spawned with. */
  finishedRepeat?: Readonly<Record<string, number>>;
  usage?: readonly SubscriptionUsage[];
  readHolds?: ReadonlyMap<string, ReadHold>;
  evals?: boolean;
  scoredWait?: string;
  runPods?: RunPodsSetting;
  worlds?: WorldsSetting;
  cooling?: Readonly<Record<string, string>>;
  campaignFiles?: Readonly<Record<string, CampaignFile>>;
  imageRecords?: readonly string[];
}

export function snapshotOf(config: FleetConfig, o: TickFixture = {}): TickSnapshot {
  const runs = o.runs ?? [];
  const running = o.running ?? [];
  const accounts = new Set(
    [
      ...config.accounts.pool,
      ...Object.keys(config.accounts.pinned),
      ...(config.accounts.evalPool ?? []),
      ...config.jobs.flatMap((j) => j.account ?? []),
      ...runs.flatMap((f) => [...(f.account !== null ? [f.account] : []), ...(f.fanoutAccounts ?? [])]),
      ...running.flatMap((j) => [j.account, ...(j.accounts ?? [])]),
    ].map((a) => a.toUpperCase()),
  );
  const holders = new Map<string, string>();
  for (const a of accounts) {
    const by = o.held?.(a);
    if (by !== undefined) holders.set(a, by);
  }
  const liveJobs = new Map<string, FleetJob>();
  const assigned = new Map<string, string>();
  for (const j of running) {
    const source = j.source ?? "policy";
    const job: FleetJob = j.job ?? {
      refs: [...j.refs],
      ref: j.refs.join("+"),
      episode: j.episode ?? "e90",
      repeat: 1,
      name: j.name,
      enabled: true,
      source,
      ...(source === "pinned" ? { account: j.account } : {}),
      ...(j.placed !== undefined ? { placed: j.placed } : {}),
      ...(j.accounts !== undefined ? { accounts: [...j.accounts] } : {}),
      ...(j.fanout !== undefined ? { fanout: j.fanout } : {}),
      ...(j.probe !== undefined ? { probe: j.probe } : {}),
    };
    liveJobs.set(j.name, job);
    if (holdsAssignment(job)) assigned.set(j.name, j.account);
  }
  return {
    config,
    evals: o.evals ?? true,
    stamp: o.stamp ?? "20300314",
    now: o.now ?? 1_800_000_000_000,
    scoredWait: o.scoredWait ?? null,
    paused: false,
    facts: runs,
    unstamped: o.unstamped ?? [],
    modelsSidecar: { version: 1, cleared: {} },
    modelLists: emptyModelLists(),
    usage: o.usage ?? [],
    readHolds: o.readHolds ?? new Map(),
    runPods: o.runPods,
    worlds: o.worlds,
    holders,
    cooling: new Map(Object.entries(o.cooling ?? {})),
    campaignFiles: new Map(Object.entries(o.campaignFiles ?? {})),
    imageRecords: new Set(o.imageRecords ?? []),
    supervisor: {
      ownRunIds: new Set(running.flatMap((j) => j.runIds ?? [])),
      running: new Set(running.map((j) => j.name)),
      finished: new Set(o.finished ?? []),
      finishedRepeat: new Map(Object.entries(o.finishedRepeat ?? {})),
      assigned,
      liveJobs,
      pending: new Set(),
      placedMemo: new Map(),
    },
  };
}

/** The supervisor's tick over the fixture. */
export function planOf(config: FleetConfig, o: TickFixture = {}): TickPlan {
  return planTick(snapshotOf(config, o));
}
