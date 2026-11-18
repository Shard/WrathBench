/**
 * What the runner would read from its sibling runs, read by the launcher
 * instead and handed to the run in its environment.
 *
 * A run pod mounts its own run directory and nothing else of the runs tree
 * (`infra/run-pod.ts`, `buildRunPod`): a codex model's own runtime can read
 * any file in the pod, and the other runs' records are not its to read. Three
 * things run.ts takes from the runs directory as a whole are therefore taken
 * here, by the fleet pod, at launch:
 *
 * - hygiene's character owners on every account the launch drives
 *   (`characterOwners`, on `hygieneAccountsOf`'s accounts), which keep a
 *   character an un-ended run still plays from being deleted.
 *   A fresh launch only, the one hygiene runs on; a run pod's fresh launch
 *   without them is refused, never run on an empty map.
 * - the newest usage reading of the run's credential (`newestCredentialUsage`),
 *   the seed of the driver's tracker.
 * - the character guids the other runs on the same world have recorded
 *   (`deploymentOwnGuids`), the deployment's own sessions as the write gate
 *   counts them. A sibling that records its character after the launch is
 *   not in it, and reads as foreign.
 *
 * It travels as one environment variable, `WRATHBENCH_LAUNCH_CONTEXT`, rather
 * than a file in the run directory: the launcher then writes nothing into a
 * directory a model can write to, and a runner image built before this
 * existed, which would take an unknown file there for a run already on disk,
 * simply never reads it. Read through a parser all the same. The snippet
 * sandbox's env allowlist does not forward it.
 */

import { z } from "zod";
import { DEFAULT_ACCOUNT } from "./config";
import { characterOwners, type CharacterOwner } from "./hygiene";
import { deploymentOwnGuids } from "./session-record";
import { newestByCredential, parseSubscriptionUsage, readCredentialUsage, type SubscriptionUsage } from "./subscription-usage";

export const LAUNCH_CONTEXT_ENV = "WRATHBENCH_LAUNCH_CONTEXT";

const Owner = z.object({ runId: z.string(), ended: z.boolean() });
const LaunchContextSchema = z.object({
  /** Account (upper-cased) → character name (lower-cased) → its owner; a fresh launch's only. */
  characterOwners: z.record(z.string(), z.record(z.string(), Owner)).optional(),
  /** Each read as a meta.json's reading is (`parseSubscriptionUsage`). */
  subscriptionUsage: z.array(z.unknown()),
  ownGuids: z.array(z.string()),
});

export interface LaunchContext {
  characterOwners?: Record<string, Record<string, CharacterOwner>>;
  subscriptionUsage: SubscriptionUsage[];
  ownGuids: string[];
}

export interface BuildLaunchContextOptions {
  runsDir: string;
  runId: string;
  resume: boolean;
  /** The accounts hygiene clears on a fresh launch. */
  accounts: readonly string[];
  /** The usage keys the run's tracker may use (`usageKeyOf`); null for every `env:` key, a launch with no placed credential. */
  credentials: readonly string[] | null;
  /** The run's world (`runWorldOf`, `SHARED_WORLD` when it names none). */
  world: string;
}

/** The context, read from the runs directory as the runner would read it. */
export function buildLaunchContext(o: BuildLaunchContextOptions): LaunchContext {
  const usage = [...newestByCredential(readCredentialUsage(o.runsDir)).values()].filter((u) =>
    o.credentials === null ? u.credential.startsWith("env:") : o.credentials.includes(u.credential),
  );
  return {
    ...(o.resume
      ? {}
      : { characterOwners: Object.fromEntries(o.accounts.map((a) => [a.toUpperCase(), Object.fromEntries(characterOwners(o.runsDir, a, o.runId))])) }),
    subscriptionUsage: usage,
    ownGuids: deploymentOwnGuids(o.runsDir, o.world, o.runId),
  };
}

/** The context as the variable's value. */
export function encodeLaunchContext(ctx: LaunchContext): string {
  return JSON.stringify(ctx);
}

/** The context the launcher handed this process, or undefined when it handed none or it does not parse. */
export function launchContextOf(env: Readonly<Record<string, string | undefined>>): LaunchContext | undefined {
  const value = env[LAUNCH_CONTEXT_ENV];
  if (value === undefined || value === "") return undefined;
  let raw: unknown;
  try {
    raw = JSON.parse(value);
  } catch {
    return undefined;
  }
  const parsed = LaunchContextSchema.safeParse(raw);
  if (!parsed.success) return undefined;
  return {
    ...(parsed.data.characterOwners !== undefined ? { characterOwners: parsed.data.characterOwners } : {}),
    subscriptionUsage: parsed.data.subscriptionUsage.flatMap((u) => parseSubscriptionUsage(u) ?? []),
    ownGuids: parsed.data.ownGuids,
  };
}

/**
 * The accounts a fresh launch's hygiene clears: run.ts's own flags, its
 * `--account` (the config's default when it names none) and a fan-out grant's
 * `--accounts` (`fanoutFromArgs`), and `drives`, the accounts a one-agent
 * arm's campaign file names for its party (`fanoutAccountsOf`), whose argv
 * carries one `--account` and takes the rest from the file. A superset is
 * harmless; one it missed refuses the launch in the pod.
 */
export function hygieneAccountsOf(args: Readonly<Record<string, string | boolean>>, drives: readonly string[] = []): string[] {
  const fanout = typeof args["accounts"] === "string" ? args["accounts"].split(",").map((a) => a.trim()).filter((a) => a.length > 0) : [];
  const single = typeof args["account"] === "string" ? args["account"] : DEFAULT_ACCOUNT;
  return [...new Set([...drives, ...fanout, single].map((a) => a.toUpperCase()))];
}

/** Hygiene's owners on `account` as the launcher read them, or undefined when it read none for it. */
export function launchOwners(ctx: LaunchContext | undefined, account: string): Map<string, CharacterOwner> | undefined {
  const owners = ctx?.characterOwners?.[account.toUpperCase()];
  return owners === undefined ? undefined : new Map(Object.entries(owners));
}
