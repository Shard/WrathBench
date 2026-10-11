#!/usr/bin/env bun
/**
 * Publish a campaign definition: how one reaches the fleet, with no release.
 *
 *   bun runner/src/campaign-publish.ts runner/campaigns/race-probe@1.json [--k8s] [--dry-run]
 *
 * Validates the file (`campaign-def.ts`), computes its hash, checks where it
 * came from, and writes `campaign-defs/<id>@<version>` into the config store
 * as `{ definition, hash, source: { commit, path, branch }, publishedAt }`.
 * The store refuses a second publish of the same key with a different hash
 * (`ConfigStore.publishDefinition`), so the version a run was stamped with
 * still means what it meant.
 *
 * Provenance: the file must be tracked, unmodified, and its last commit
 * reachable from origin (`PUBLISH_RULE`), so every published definition can be
 * read back from the repository by its commit and path. `branch` records which
 * origin branches held the commit at publish time; it is informational, and
 * the hash is the identity.
 *
 * `--k8s` runs the checks here, where git is, and pipes the publication into
 * the runner Deployment's own store (`config-store.ts publish -`), the way
 * every store command reaches the PVC on a cluster.
 */

import { readFileSync } from "node:fs";
import { basename, relative, resolve } from "node:path";
import {
  campaignDefinitionSchema,
  campaignHash,
  campaignRef,
  issuesOf,
  type CampaignDefinition,
  type PublishedCampaignDoc,
} from "./campaign-def";

/**
 * Which commits a definition may be published from.
 *
 * - `any-origin-branch`: reachable from any branch on origin, so a pull
 *   request can carry its own `runner/campaigns/<id>@<v>.json` next to the
 *   code its arms test (operator, 2026-10-11).
 * - `origin-master`: reachable from origin/master only.
 *
 * One constant so the rule can be tightened without touching the checks.
 */
export type PublishRule = "any-origin-branch" | "origin-master";
export const PUBLISH_RULE: PublishRule = "any-origin-branch";

/** Runs git with these args in `cwd`; the seam the tests drive a scratch repository through. */
export type Git = (args: readonly string[]) => { code: number; out: string };

export function gitIn(cwd: string): Git {
  return (args) => {
    const p = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
    return { code: p.exitCode ?? 1, out: `${p.stdout.toString()}${p.exitCode === 0 ? "" : p.stderr.toString()}`.trim() };
  };
}

/** A publish refused before anything was written. The message is the operator's whole notice. */
export class PublishRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PublishRefused";
  }
}

/** Parse a definition file, and check it is named for what it holds. */
export function readDefinitionFile(path: string): CampaignDefinition {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch (err) {
    throw new PublishRefused(`${path}: ${err instanceof Error ? err.message : String(err)}`);
  }
  const parsed = campaignDefinitionSchema.safeParse(raw);
  if (!parsed.success) throw new PublishRefused(`${path}: ${issuesOf(parsed.error)}`);
  const want = `${campaignRef(parsed.data)}.json`;
  if (basename(path) !== want) throw new PublishRefused(`${path} holds ${campaignRef(parsed.data)}; the file must be named ${want}`);
  return parsed.data;
}

/**
 * Where a committed definition file came from: the last commit that touched
 * it, its path in the repository, and the origin branches holding that
 * commit. Refuses an untracked or modified file, and a commit `rule` does
 * not accept. Reads origin as the local remote-tracking refs have it; the CLI
 * fetches first.
 */
export function provenanceOf(repoRoot: string, path: string, git: Git, rule: PublishRule = PUBLISH_RULE): PublishedCampaignDoc["source"] {
  const rel = relative(repoRoot, resolve(path));
  if (git(["ls-files", "--error-unmatch", "--", rel]).code !== 0) throw new PublishRefused(`${rel} is not committed — commit and push it first`);
  const dirty = git(["status", "--porcelain", "--", rel]);
  if (dirty.code !== 0 || dirty.out.length > 0) throw new PublishRefused(`${rel} has uncommitted changes — publish what is committed, or commit it as a new version`);
  const last = git(["log", "-1", "--format=%H", "--", rel]);
  const commit = last.out;
  if (last.code !== 0 || !/^[0-9a-f]{40}$/.test(commit)) throw new PublishRefused(`${rel}: no commit found (${last.out})`);
  const listed = git(["branch", "-r", "--contains", commit, "--format=%(refname:short)"]);
  const branch = listed.code !== 0 ? [] : listed.out
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("origin/") && l !== "origin/HEAD" && l !== "origin")
    .map((l) => l.slice("origin/".length));
  if (rule === "origin-master") {
    if (git(["merge-base", "--is-ancestor", commit, "origin/master"]).code !== 0) {
      throw new PublishRefused(`${rel} was last changed in ${commit.slice(0, 12)}, which is not on origin/master — merge it first`);
    }
  } else if (branch.length === 0) {
    throw new PublishRefused(`${rel} was last changed in ${commit.slice(0, 12)}, which no branch on origin contains — push it first`);
  }
  return { commit, path: rel, branch };
}

/** The document a publish writes. */
export function publication(def: CampaignDefinition, source: PublishedCampaignDoc["source"], now = Date.now()): PublishedCampaignDoc {
  return { definition: def, hash: campaignHash(def), source, publishedAt: now };
}

const USAGE = `usage: bun runner/src/campaign-publish.ts <runner/campaigns/<id>@<version>.json> [options]

  --dry-run             check and print the publication; write nothing
  --no-fetch            skip "git fetch origin" before the provenance check
  --db <path>           the local store (default $WRATHBENCH_CONFIG_DB, else $WRATHBENCH_DATA/config.sqlite)
  --k8s                 write into the runner Deployment's store instead (kubectl exec)
  --namespace <ns>      with --k8s (default $WRATHBENCH_K8S_NAMESPACE, else wrathbench)
  --release <name>      with --k8s (default $WRATHBENCH_K8S_RELEASE, else wrathbench)
  --actor <name>        who to record the publish as (default "cli")
  --note <text>         why

Publish rule: ${PUBLISH_RULE}.
`;

async function main(argv: string[]): Promise<number> {
  const args = [...argv];
  const opt = (name: string): string | undefined => {
    const i = args.indexOf(name);
    if (i < 0) return undefined;
    const v = args[i + 1];
    args.splice(i, 2);
    return v;
  };
  const has = (name: string): boolean => {
    const i = args.indexOf(name);
    if (i < 0) return false;
    args.splice(i, 1);
    return true;
  };
  const dryRun = has("--dry-run");
  const noFetch = has("--no-fetch");
  const k8s = has("--k8s");
  const db = opt("--db");
  const namespace = opt("--namespace") ?? process.env["WRATHBENCH_K8S_NAMESPACE"] ?? "wrathbench";
  const release = opt("--release") ?? process.env["WRATHBENCH_K8S_RELEASE"] ?? "wrathbench";
  const actor = opt("--actor") ?? "cli";
  const note = opt("--note");
  const file = args[0];
  if (file === undefined || args.length !== 1 || file.startsWith("--")) {
    console.error(USAGE);
    return 2;
  }
  const repoRoot = resolve(import.meta.dir, "..", "..");
  const git = gitIn(repoRoot);
  let doc: PublishedCampaignDoc;
  try {
    const def = readDefinitionFile(file);
    if (!noFetch) {
      const f = git(["fetch", "--quiet", "origin"]);
      if (f.code !== 0) throw new PublishRefused(`git fetch origin failed (${f.out}) — pass --no-fetch to check against the refs as they are`);
    }
    doc = publication(def, provenanceOf(repoRoot, file, git));
  } catch (err) {
    if (!(err instanceof PublishRefused)) throw err;
    console.error(`campaign-publish: ${err.message}`);
    return 2;
  }
  const text = JSON.stringify(doc);
  const ref = campaignRef(doc.definition);
  console.error(`${ref}  ${doc.hash}  from ${doc.source.commit.slice(0, 12)} (${doc.source.branch.join(", ")})  ${doc.source.path}`);
  if (dryRun) {
    console.log(JSON.stringify(doc, null, 2));
    return 0;
  }
  const tail = ["--actor", actor, ...(note !== undefined ? ["--note", note] : [])];
  if (k8s) {
    const p = Bun.spawnSync(
      ["kubectl", "-n", namespace, "exec", "-i", `deploy/${release}-runner`, "--", "bun", "runner/src/config-store.ts", "publish", "-", ...tail],
      { stdin: new TextEncoder().encode(text), stdout: "inherit", stderr: "inherit" },
    );
    return p.exitCode ?? 1;
  }
  const { ConfigStore, configDbPath } = await import("./config-store");
  const store = new ConfigStore(db ?? configDbPath());
  try {
    const { key, status } = store.publishDefinition(doc, { actor, ...(note !== undefined ? { note } : {}) });
    console.error(status === "published" ? `published ${key}` : `${key} is already published with this hash — nothing written`);
    return 0;
  } catch (err) {
    console.error(`campaign-publish: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  } finally {
    store.close();
  }
}

if (import.meta.main) {
  process.exit(await main(process.argv.slice(2)));
}
