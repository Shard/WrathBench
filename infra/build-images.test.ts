/**
 * infra/build-images.sh against a throwaway repository and a `docker` with no
 * daemon behind it. The property under test is where the build context comes
 * from: a `git archive` of the commit, never the working tree. The shim tars
 * whatever context each `docker build` was handed, so the assertions read the
 * context itself rather than trusting the script's account of it.
 *
 * The real infra/image-guard.sh runs on every "image"; the shim's `export`
 * hands it a fixture directory standing in for the image filesystem.
 *
 * Children get a bare environment (never this process's, which `bun test`
 * fills from the repository's .env) and git runs with no global or system
 * config, so the operator's own settings cannot decide a result.
 */
import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tempDirs } from "./temp-dirs";

const tempDir = tempDirs();
const REPO_ROOT = join(import.meta.dir, "..");
const SCRIPT = join(REPO_ROOT, "infra", "build-images.sh");

const GIT_ENV = {
  PATH: process.env.PATH ?? "/usr/bin:/bin",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.invalid",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.invalid",
};

function git(cwd: string, ...args: string[]): string {
  const p = Bun.spawnSync(["git", "-c", "protocol.file.allow=always", "-C", cwd, ...args], { env: GIT_ENV, stdout: "pipe", stderr: "pipe" });
  if (p.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${p.stderr.toString()}`);
  return p.stdout.toString().trim();
}

function put(root: string, files: Record<string, string>) {
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), body);
  }
}

/** An AzerothCore stand-in: the paths server.Dockerfile copies, and some it does not. */
function makeAzerothcore(dir: string): { first: string } {
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q", "-b", "master");
  put(dir, {
    "CMakeLists.txt": "project(ac)\n",
    "conf/dist/config.cmake": "#\n",
    "deps/dep/dep.h": "//\n",
    "src/main.cpp": "one\n",
    "modules/.gitkeep": "",
    "apps/docker/entrypoint.sh": "#!/bin/sh\n",
    "apps/docker/Dockerfile": "FROM scratch\n",
    "data/sql/base/world.sql": "--\n",
    "README.md": "upstream\n",
    ".claude/skills/upstream.md": "upstream agent settings\n",
  });
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "ac one");
  return { first: git(dir, "rev-parse", "HEAD") };
}

/**
 * The superproject: tracked files plus the clutter a working checkout really
 * has — an untracked scratch file, gitignored env files at two depths, and an
 * agent worktree under .claude/.
 */
function makeRepo(opts: { submodule?: boolean } = {}): { tree: string; ac: string; acFirst: string; sha: string } {
  const dir = tempDir("wb-build-images-repo-");
  const tree = join(dir, "tree");
  const ac = join(dir, "azerothcore");
  const { first } = makeAzerothcore(ac);
  mkdirSync(tree);
  git(tree, "init", "-q", "-b", "master");
  put(tree, {
    "a.txt": "one\n",
    ".gitignore": ".env\n.env.*\n!.env.example\n.claude/worktrees/\n",
    ".env.example": "KEY=\n",
    "infra/docker/runner.Dockerfile": "FROM scratch\n",
    "infra/docker/runner.Dockerfile.dockerignore": ".git\n",
    "infra/docker/server.Dockerfile": "FROM scratch\n",
  });
  git(tree, "add", "-A");
  git(tree, "commit", "-q", "-m", "one");
  if (opts.submodule !== false) {
    git(tree, "submodule", "add", "-q", ac, "deps/azerothcore");
    git(tree, "commit", "-q", "-m", "pin azerothcore");
  }
  put(tree, {
    "scratch.txt": "untracked\n",
    ".env.local": "API_KEY=fixture-not-a-secret\n",
    "runner/.env.prod": "API_KEY=fixture-not-a-secret\n",
    ".claude/worktrees/agent-x/notes.txt": "agent worktree\n",
  });
  return { tree, ac, acFirst: first, sha: git(tree, "rev-parse", "HEAD") };
}

/**
 * argv to the log, never the environment; each build's context tarred beside
 * it. `buildx build` (the --builder path) also writes a stand-in image tarball
 * where its `--output ...,dest=` says, and `buildx inspect` knows one builder.
 */
const DOCKER_SHIM = `#!/usr/bin/env bash
printf 'docker %s\\n' "$*" >> "\${FAKE_LOG}"
save_context() {
  ctx="\${!#}"
  n="$(grep -cE '^docker (buildx )?build ' "\${FAKE_LOG}")"
  printf '%s\\n' "\${ctx}" > "\${FAKE_LOG}.context-\${n}.dir"
  tar -cf "\${FAKE_LOG}.context-\${n}.tar" -C "\${ctx}" .
}
case "$1" in
  build)
    save_context "$@"
    exit "\${FAKE_BUILD_RC:-0}"
    ;;
  buildx)
    case "$2" in
      inspect) [[ "$3" == "\${FAKE_BUILDER:-wb}" ]] || exit 1 ;;
      build)
        save_context "$@"
        for a in "$@"; do
          if [[ "$a" == type=docker,* ]]; then printf 'image tarball for %s\\n' "\${a}" > "\${a##*dest=}"; fi
        done
        exit "\${FAKE_BUILD_RC:-0}"
        ;;
    esac
    ;;
  create) echo fake-container ;;
  export) tar -cf - -C "\${FAKE_IMAGE_ROOT}" . ;;
  image)
    if [[ "$2" == "inspect" ]]; then
      ref="\${!#}"
      if [[ "$*" == *Size* ]]; then echo 1073741824
      elif [[ "$*" == *RepoDigests* ]]; then [[ -n "\${FAKE_NO_REPODIGESTS:-}" ]] || echo "\${ref%:*}@sha256:\${FAKE_DIGEST}"
      else echo sha256:0123456789abcdef0123; fi
    fi
    ;;
esac
exit 0
`;

/**
 * A crane with no registry: `export - -` tars FAKE_IMAGE_ROOT (after checking
 * it was handed an existing tarball on stdin), `push` checks its tarball
 * exists, `digest` answers FAKE_DIGEST.
 */
const CRANE_SHIM = `#!/usr/bin/env bash
printf 'crane %s\\n' "$*" >> "\${FAKE_LOG}"
case "$1" in
  export) [[ "$(head -c 13)" == "image tarball" ]] || exit 9; tar -cf - -C "\${FAKE_IMAGE_ROOT}" . ;;
  push) [[ -f "$2" ]] || exit 9 ;;
  digest) echo "sha256:\${FAKE_DIGEST}" ;;
esac
exit 0
`;

const FAKE_DIGEST = "ab".repeat(32);

interface Run {
  code: number;
  out: string;
  calls: string[];
  /** Every context a `docker build` was handed: its path, entries and a reader. */
  contexts: { dir: string; entries: string[]; read: (rel: string) => string }[];
  /** What is left in TMPDIR after the run (the export must be gone). */
  leftovers: string[];
}

function run(cwdRepo: string, args: string[], opts: { imageFiles?: Record<string, string>; env?: Record<string, string> } = {}): Run {
  const dir = tempDir("wb-build-images-run-");
  const bin = join(dir, "bin");
  const tmp = join(dir, "tmp");
  const image = join(dir, "image");
  mkdirSync(bin);
  mkdirSync(tmp);
  mkdirSync(image);
  put(image, opts.imageFiles ?? { "wrathbench/package.json": "{}" });
  writeFileSync(join(bin, "docker"), DOCKER_SHIM);
  chmodSync(join(bin, "docker"), 0o755);
  writeFileSync(join(bin, "crane"), CRANE_SHIM);
  chmodSync(join(bin, "crane"), 0o755);
  const log = join(dir, "calls.log");
  writeFileSync(log, "");

  const proc = Bun.spawnSync(["bash", SCRIPT, ...args], {
    cwd: cwdRepo,
    env: {
      ...GIT_ENV,
      PATH: `${bin}:${GIT_ENV.PATH}`,
      TMPDIR: tmp,
      FAKE_LOG: log,
      FAKE_IMAGE_ROOT: image,
      FAKE_DIGEST,
      WRATHBENCH_BUILD_REPO_ROOT: cwdRepo,
      ...opts.env,
    },
    stdout: "pipe",
    stderr: "pipe",
  });

  const contexts: Run["contexts"] = [];
  for (let n = 1; existsSync(`${log}.context-${n}.tar`); n++) {
    const tarPath = `${log}.context-${n}.tar`;
    const list = Bun.spawnSync(["tar", "-tf", tarPath], { stdout: "pipe" }).stdout.toString();
    contexts.push({
      dir: readFileSync(`${log}.context-${n}.dir`, "utf8").trim(),
      entries: list
        .split("\n")
        .filter(Boolean)
        .map((e) => e.replace(/^\.\//, "").replace(/\/$/, "")),
      read: (rel) => Bun.spawnSync(["tar", "-xOf", tarPath, `./${rel}`], { stdout: "pipe" }).stdout.toString(),
    });
  }
  return {
    code: proc.exitCode ?? -1,
    out: proc.stdout.toString() + proc.stderr.toString(),
    calls: readFileSync(log, "utf8").split("\n").filter(Boolean),
    contexts,
    leftovers: readdirSync(tmp),
  };
}

const builds = (r: Run) => r.calls.filter((l) => l.startsWith("docker build "));
const pushes = (r: Run) => r.calls.filter((l) => l.startsWith("docker push"));
const buildxBuilds = (r: Run) => r.calls.filter((l) => l.startsWith("docker buildx build"));
const cranePushes = (r: Run) => r.calls.filter((l) => l.startsWith("crane push"));

describe("build-images.sh builds from git, never the working tree", () => {
  test("the runner's context is an archive of the commit: tracked files in, untracked and ignored files out", () => {
    const { tree, sha } = makeRepo();
    const r = run(tree, ["--only", "runner"]);
    expect(r.code).toBe(0);
    expect(builds(r)).toHaveLength(1);
    const [ctx] = r.contexts;
    expect(ctx).toBeDefined();
    // Not the checkout, and both the Dockerfile and the context are inside the export.
    expect(ctx!.dir).not.toBe(tree);
    expect(builds(r)[0]).toContain(`-f ${ctx!.dir}/infra/docker/runner.Dockerfile ${ctx!.dir}`);
    expect(ctx!.entries).toContain("a.txt");
    expect(ctx!.entries).toContain(".env.example");
    expect(ctx!.entries).toContain("infra/docker/runner.Dockerfile");
    for (const absent of ["scratch.txt", ".env.local", "runner/.env.prod", "runner", ".claude", ".git"]) {
      expect(ctx!.entries).not.toContain(absent);
    }
    // The runner needs no AzerothCore, so none is exported for it.
    expect(ctx!.entries.some((e) => e.startsWith("deps/azerothcore/"))).toBe(false);
    expect(r.out).toContain(`exporting ${sha}`);
    // The export is removed on the way out.
    expect(r.leftovers).toEqual([]);
  });

  test("the default registry is harbor.local/wrathbench, and the image guard runs on what was built", () => {
    const { tree, sha } = makeRepo();
    const r = run(tree, ["--only", "runner"]);
    const ref = `harbor.local/wrathbench/wrathbench-runner:${sha.slice(0, 7)}`;
    expect(builds(r)[0]).toContain(`-t ${ref}`);
    expect(r.calls).toContain(`docker create ${ref} true`);
    expect(r.calls).toContain("docker export fake-container");
    expect(pushes(r)).toEqual([]);
  });

  test("the server images take AzerothCore from the commit the superproject pins, and only what server.Dockerfile copies", () => {
    const { tree } = makeRepo();
    // The submodule's checkout moves on and gathers clutter; neither may reach the context.
    const sub = join(tree, "deps", "azerothcore");
    put(sub, { "src/main.cpp": "two\n" });
    git(sub, "commit", "-q", "-am", "ac two");
    put(sub, { "var/extractors/dbc/Spell.dbc": "client data\n", "env/dist/etc/worldserver.conf": "local\n" });
    // The moved submodule makes the superproject dirty, so this needs --allow-dirty.
    const r = run(tree, ["--only", "worldserver", "--allow-dirty"]);
    expect(r.code).toBe(0);
    expect(builds(r)[0]).toContain("--target worldserver");
    const [ctx] = r.contexts;
    expect(builds(r)[0]).toContain(`-f ${ctx!.dir}/infra/docker/server.Dockerfile ${ctx!.dir}`);
    expect(ctx!.read("deps/azerothcore/src/main.cpp")).toBe("one\n");
    for (const present of ["CMakeLists.txt", "conf/dist/config.cmake", "deps/dep/dep.h", "modules/.gitkeep", "apps/docker/entrypoint.sh", "data/sql/base/world.sql"]) {
      expect(ctx!.entries).toContain(`deps/azerothcore/${present}`);
    }
    for (const absent of ["README.md", ".claude", "apps/docker/Dockerfile", "var", "env"]) {
      expect(ctx!.entries).not.toContain(`deps/azerothcore/${absent}`);
    }
    expect(r.leftovers).toEqual([]);
  });

  test("a server image with no initialised submodule stops before anything is built; the runner still builds", () => {
    const { tree } = makeRepo();
    const clone = join(tempDir("wb-build-images-clone-"), "clone");
    git(dirname(clone), "clone", "-q", tree, clone);
    const server = run(clone, ["--only", "worldserver"]);
    expect(server.code).toBe(1);
    expect(server.out).toContain("git submodule update --init deps/azerothcore");
    expect(builds(server)).toEqual([]);
    expect(server.leftovers).toEqual([]);
    expect(run(clone, ["--only", "runner"]).code).toBe(0);
  });
});

describe("build-images.sh dirty trees and named commits", () => {
  test("a dirty tree is refused before anything is exported or built", () => {
    const { tree } = makeRepo();
    writeFileSync(join(tree, "a.txt"), "two\n");
    const r = run(tree, ["--only", "runner"]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("--allow-dirty");
    expect(r.calls).toEqual([]);
  });

  test("--allow-dirty builds the commit with the edit left out, tags it -dirty, and never pushes it", () => {
    const { tree, sha } = makeRepo();
    writeFileSync(join(tree, "a.txt"), "two\n");
    const r = run(tree, ["--only", "runner", "--allow-dirty", "--push"]);
    expect(r.contexts[0]!.read("a.txt")).toBe("one\n");
    expect(builds(r)[0]).toContain(`:${sha.slice(0, 7)}-dirty`);
    expect(r.out).toContain("NOT in these images");
    expect(r.code).toBe(1);
    expect(r.out).toContain("refusing to push a --allow-dirty tag");
    expect(pushes(r)).toEqual([]);
  });

  test("--commit builds the named commit; one that is not HEAD needs its own --tag", () => {
    const { tree, sha: first } = makeRepo();
    writeFileSync(join(tree, "a.txt"), "two\n");
    git(tree, "commit", "-q", "-am", "two");
    const named = run(tree, ["--only", "runner", "--commit", first, "--tag", "t-first"]);
    expect(named.code).toBe(0);
    expect(named.contexts[0]!.read("a.txt")).toBe("one\n");
    expect(builds(named)[0]).toContain("wrathbench-runner:t-first");
    const untagged = run(tree, ["--only", "runner", "--commit", first]);
    expect(untagged.code).toBe(1);
    expect(untagged.out).toContain("pass --tag as well");
    expect(builds(untagged)).toEqual([]);
  });
});

describe("build-images.sh and the image guard", () => {
  test("a secret-shaped path in a built image stops the run before any push, and the image loses its tag", () => {
    const { tree, sha } = makeRepo();
    const r = run(tree, ["--only", "runner", "--push", "--registry", "reg.example/wrathbench"], {
      imageFiles: { "wrathbench/package.json": "{}", "wrathbench/.env.prod": "API_KEY=fixture-not-a-secret\n" },
    });
    const ref = `reg.example/wrathbench/wrathbench-runner:${sha.slice(0, 7)}`;
    expect(r.code).toBe(1);
    expect(r.out).toContain("/wrathbench/.env.prod");
    expect(r.out).not.toContain("fixture-not-a-secret");
    expect(r.calls).toContain(`docker image rm ${ref}`);
    expect(pushes(r)).toEqual([]);
    expect(r.leftovers).toEqual([]);
  });

  test("--push pushes only after the image passed the guard, to the --registry given", () => {
    const { tree, sha } = makeRepo();
    const r = run(tree, ["--only", "runner", "--push", "--registry", "reg.example/wrathbench"]);
    const ref = `reg.example/wrathbench/wrathbench-runner:${sha.slice(0, 7)}`;
    expect(r.code).toBe(0);
    const at = (line: string) => r.calls.indexOf(line);
    expect(at(`docker push ${ref}`)).toBeGreaterThan(at("docker export fake-container"));
    expect(at("docker export fake-container")).toBeGreaterThan(r.calls.findIndex((l) => l.startsWith("docker build")));
    expect(r.out).toContain(`pushed ${ref}@sha256:${FAKE_DIGEST}`);
  });

  test("--digests records <ref>@<digest> for each pushed image, and nothing when nothing is pushed", () => {
    const { tree, sha } = makeRepo();
    const file = join(tempDir("wb-build-images-digests-"), "digests.txt");
    const ref = `reg.example/wrathbench/wrathbench-runner:${sha.slice(0, 7)}`;
    expect(run(tree, ["--only", "runner", "--registry", "reg.example/wrathbench", "--digests", file]).code).toBe(0);
    expect(existsSync(file)).toBe(false);
    expect(run(tree, ["--only", "runner", "--push", "--registry", "reg.example/wrathbench", "--digests", file]).code).toBe(0);
    expect(readFileSync(file, "utf8")).toBe(`${ref}@sha256:${FAKE_DIGEST}\n`);
  });

  test("a daemon that kept no digest for the push does not stop a release, but does stop --digests", () => {
    const { tree } = makeRepo();
    const env = { FAKE_NO_REPODIGESTS: "1" };
    const release = run(tree, ["--push", "--registry", "reg.example/wrathbench", "--only", "runner"], { env });
    expect(release.code).toBe(0);
    expect(release.out).toContain("its digest could not be read back");
    const file = join(tempDir("wb-build-images-digests-"), "digests.txt");
    const recorded = run(tree, ["--push", "--registry", "reg.example/wrathbench", "--only", "runner", "--digests", file], { env });
    expect(recorded.code).toBe(1);
    expect(recorded.out).toContain("--digests needs it");
  });
});

describe("build-images.sh --builder (buildx, no Docker daemon)", () => {
  test("builds into a tarball, guards that tarball, and pushes that same tarball with crane", () => {
    const { tree, sha } = makeRepo();
    const file = join(tempDir("wb-build-images-digests-"), "digests.txt");
    const r = run(tree, ["--only", "runner", "--builder", "wb", "--push", "--registry", "reg.example/wrathbench", "--digests", file]);
    const ref = `reg.example/wrathbench/wrathbench-runner:${sha.slice(0, 7)}`;
    expect(r.code).toBe(0);
    expect(builds(r)).toEqual([]);
    expect(buildxBuilds(r)).toHaveLength(1);
    const line = buildxBuilds(r)[0]!;
    const [ctx] = r.contexts;
    // The same archive context and Dockerfile as the daemon path, one plain manifest.
    expect(line).toContain("--builder wb --provenance=false --sbom=false");
    expect(line).toContain(`-f ${ctx!.dir}/infra/docker/runner.Dockerfile ${ctx!.dir}`);
    expect(line).toContain(`--build-arg WRATHBENCH_BUILD_VERSION=${sha.slice(0, 7)}`);
    expect(ctx!.entries).toContain("a.txt");
    expect(ctx!.entries).not.toContain(".env.local");
    const dest = /--output type=docker,name=(\S+),dest=(\S+)/.exec(line);
    expect(dest?.[1]).toBe(ref);
    // Guarded from the tarball, then that tarball pushed, then the digest read back.
    const at = (prefix: string) => r.calls.findIndex((l) => l.startsWith(prefix));
    expect(at("crane export - -")).toBeGreaterThan(at("docker buildx build"));
    expect(cranePushes(r)).toEqual([`crane push ${dest![2]} ${ref}`]);
    expect(at("crane push")).toBeGreaterThan(at("crane export - -"));
    expect(r.calls).toContain(`crane digest ${ref}`);
    expect(at(`crane digest ${ref}`)).toBeGreaterThan(at("crane push"));
    expect(readFileSync(file, "utf8")).toBe(`${ref}@sha256:${FAKE_DIGEST}\n`);
    // No daemon call of any kind, and the export and the tarball are gone.
    expect(r.calls.filter((l) => l.startsWith("docker ") && !l.startsWith("docker buildx "))).toEqual([]);
    expect(r.leftovers).toEqual([]);
  });

  test("a secret-shaped path in the tarball stops the run before any push", () => {
    const { tree } = makeRepo();
    const r = run(tree, ["--only", "runner", "--builder", "wb", "--push"], {
      imageFiles: { "wrathbench/package.json": "{}", "wrathbench/.env.prod": "API_KEY=fixture-not-a-secret\n" },
    });
    expect(r.code).toBe(1);
    expect(r.out).toContain("/wrathbench/.env.prod");
    expect(r.out).not.toContain("fixture-not-a-secret");
    expect(r.out).toContain("its tarball is removed and nothing was pushed");
    expect(cranePushes(r)).toEqual([]);
    expect(r.leftovers).toEqual([]);
  });

  test("an unknown builder stops before anything is exported or built", () => {
    const { tree } = makeRepo();
    const r = run(tree, ["--only", "runner", "--builder", "nope"]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("no such builder");
    expect(buildxBuilds(r)).toEqual([]);
    expect(r.leftovers).toEqual([]);
  });

  test("a --allow-dirty build through a builder is never pushed either", () => {
    const { tree, sha } = makeRepo();
    writeFileSync(join(tree, "a.txt"), "two\n");
    const r = run(tree, ["--only", "runner", "--builder", "wb", "--allow-dirty", "--push"]);
    expect(buildxBuilds(r)[0]).toContain(`:${sha.slice(0, 7)}-dirty`);
    expect(r.code).toBe(1);
    expect(r.out).toContain("refusing to push a --allow-dirty tag");
    expect(cranePushes(r)).toEqual([]);
  });
});

describe("build-images.sh and image-tag.sh", () => {
  test("the computed tag is image-tag.sh's, so a release and the branch workflow name a commit alike", () => {
    const { tree } = makeRepo();
    git(tree, "tag", "-a", "harness-0.5", "-m", "harness 0.5", "HEAD~1");
    const expected = Bun.spawnSync(["bash", join(REPO_ROOT, "infra", "image-tag.sh")], { cwd: tree, env: GIT_ENV, stdout: "pipe" }).stdout.toString().trim();
    expect(expected).toMatch(/^harness-0\.5-1-g[0-9a-f]{7,}$/);
    const r = run(tree, ["--only", "runner"]);
    expect(r.code).toBe(0);
    expect(builds(r)[0]).toContain(`wrathbench-runner:${expected} `);
  });
});

describe("the AzerothCore export list", () => {
  test("names exactly the deps/azerothcore sources server.Dockerfile copies", () => {
    const script = readFileSync(SCRIPT, "utf8");
    const listed = /^AC_PATHS=\(([^)]*)\)/m.exec(script)?.[1]?.trim().split(/\s+/) ?? [];
    expect(listed.length).toBeGreaterThan(0);
    const dockerfile = readFileSync(join(REPO_ROOT, "infra", "docker", "server.Dockerfile"), "utf8");
    const copied = new Set<string>();
    for (const line of dockerfile.split("\n")) {
      if (line.trimStart().startsWith("#")) continue;
      for (const m of line.matchAll(/deps\/azerothcore\/(\S+)/g)) copied.add(m[1]!);
    }
    expect(copied.size).toBeGreaterThan(0);
    // Every source the Dockerfile copies is exported...
    for (const c of copied) expect(listed.some((p) => c === p || c.startsWith(`${p}/`))).toBe(true);
    // ...and nothing it does not copy.
    for (const p of listed) expect([...copied].some((c) => c === p || c.startsWith(`${p}/`))).toBe(true);
  });
});
