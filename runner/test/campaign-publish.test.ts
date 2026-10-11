/**
 * Publishing's provenance check, against a scratch repository with a bare
 * "origin": a definition is published only from a committed, unmodified file
 * whose last commit origin holds — on any branch by default, so a pull request
 * can carry its own campaign, or on origin/master under the stricter rule.
 */

import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PublishRefused, gitIn, provenanceOf, publication, readDefinitionFile } from "../src/campaign-publish";
import { campaignHash } from "../src/campaign-def";
import { definition } from "./fixtures/campaigns";
import { tempDirs } from "./fixtures/temp-dirs";

const tempDir = tempDirs();
const ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.invalid",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.invalid",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
};

function sh(cwd: string, ...args: string[]): string {
  const p = Bun.spawnSync(["git", ...args], { cwd, env: ENV, stdout: "pipe", stderr: "pipe" });
  if (p.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${p.stderr.toString()}`);
  return p.stdout.toString().trim();
}

/** A clone of a fresh bare origin, with one commit on master pushed. */
function repo(): { work: string; file: string } {
  const root = tempDir("wb-publish-");
  const origin = join(root, "origin.git");
  const work = join(root, "work");
  sh(root, "init", "--bare", "-b", "master", origin);
  sh(root, "clone", origin, work);
  sh(work, "checkout", "-b", "master");
  writeFileSync(join(work, "README"), "x\n");
  sh(work, "add", "README");
  sh(work, "commit", "-m", "init");
  sh(work, "push", "-u", "origin", "master");
  mkdirSync(join(work, "runner", "campaigns"), { recursive: true });
  return { work, file: join(work, "runner", "campaigns", "probe@1.json") };
}

function writeDef(file: string, over: Parameters<typeof definition>[0] = {}): void {
  writeFileSync(file, `${JSON.stringify(definition({ id: "probe", ...over }), null, 2)}\n`);
}

function refusal(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(PublishRefused);
    return (err as Error).message;
  }
  throw new Error("accepted");
}

describe("provenance", () => {
  test("a definition committed and pushed to master is published with its commit, path and branch", () => {
    const { work, file } = repo();
    writeDef(file);
    sh(work, "add", ".");
    sh(work, "commit", "-m", "probe@1");
    sh(work, "push");
    const source = provenanceOf(work, file, gitIn(work));
    expect(source).toEqual({ commit: sh(work, "rev-parse", "HEAD"), path: "runner/campaigns/probe@1.json", branch: ["master"] });
    const doc = publication(readDefinitionFile(file), source, 7);
    expect(doc).toMatchObject({ hash: campaignHash(definition({ id: "probe" })), publishedAt: 7 });
  });

  test("an untracked or modified file is refused", () => {
    const { work, file } = repo();
    writeDef(file);
    expect(refusal(() => provenanceOf(work, file, gitIn(work)))).toContain("not committed");
    sh(work, "add", ".");
    sh(work, "commit", "-m", "probe@1");
    sh(work, "push");
    writeDef(file, { question: "edited" });
    expect(refusal(() => provenanceOf(work, file, gitIn(work)))).toContain("uncommitted changes");
  });

  test("a commit origin does not hold is refused: push it first", () => {
    const { work, file } = repo();
    writeDef(file);
    sh(work, "add", ".");
    sh(work, "commit", "-m", "probe@1");
    expect(refusal(() => provenanceOf(work, file, gitIn(work)))).toContain("no branch on origin contains");
  });

  test("a pull request branch may carry its own campaign by default, and not under the master-only rule", () => {
    const { work, file } = repo();
    sh(work, "checkout", "-b", "feat/wake");
    writeDef(file);
    sh(work, "add", ".");
    sh(work, "commit", "-m", "probe@1 on a branch");
    sh(work, "push", "-u", "origin", "feat/wake");
    expect(provenanceOf(work, file, gitIn(work)).branch).toEqual(["feat/wake"]);
    expect(refusal(() => provenanceOf(work, file, gitIn(work), "origin-master"))).toContain("not on origin/master");
  });

  test("the commit is the file's own last change, so a later unrelated commit does not move it", () => {
    const { work, file } = repo();
    writeDef(file);
    sh(work, "add", ".");
    sh(work, "commit", "-m", "probe@1");
    const own = sh(work, "rev-parse", "HEAD");
    writeFileSync(join(work, "README"), "y\n");
    sh(work, "commit", "-am", "unrelated");
    sh(work, "push");
    expect(provenanceOf(work, file, gitIn(work)).commit).toBe(own);
  });
});

describe("the file", () => {
  test("must be named for the id and version it holds", () => {
    const dir = tempDir("wb-publish-name-");
    const wrong = join(dir, "probe@2.json");
    writeDef(wrong);
    expect(refusal(() => readDefinitionFile(wrong))).toContain("must be named probe@1.json");
  });

  test("must parse", () => {
    const dir = tempDir("wb-publish-bad-");
    const bad = join(dir, "probe@1.json");
    writeFileSync(bad, JSON.stringify({ id: "probe", version: 1 }));
    expect(refusal(() => readDefinitionFile(bad))).toContain("question");
  });
});
