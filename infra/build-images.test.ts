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
 * The operator's private checkout as the build finds it: the reference
 * program committed under reference/src/, its tests and notes beside it (never
 * exported), and an untracked file that must not reach the image either.
 */
function makePrivate(): { dir: string; sha: string } {
  const dir = join(tempDir("wb-build-images-private-"), "private");
  mkdirSync(dir);
  git(dir, "init", "-q", "-b", "master");
  put(dir, {
    "reference/src/index.ts": "export const program = 1;\n",
    "reference/src/route.ts": "export const route = 1;\n",
    "reference/test/reference.test.ts": "// private test\n",
    "reference/README.md": "private notes\n",
    "worklogs/2026-01-01.md": "private\n",
  });
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "reference");
  put(dir, { "reference/src/scratch.ts": "untracked\n" });
  return { dir, sha: git(dir, "rev-parse", "HEAD") };
}

/** argv to the log, never the environment; each build's context tarred beside it. */
const DOCKER_SHIM = `#!/usr/bin/env bash
printf 'docker %s\\n' "$*" >> "\${FAKE_LOG}"
case "$1" in
  build)
    ctx="\${!#}"
    n="$(grep -c '^docker build' "\${FAKE_LOG}")"
    printf '%s\\n' "\${ctx}" > "\${FAKE_LOG}.context-\${n}.dir"
    tar -cf "\${FAKE_LOG}.context-\${n}.tar" -C "\${ctx}" .
    exit "\${FAKE_BUILD_RC:-0}"
    ;;
  create) echo fake-container ;;
  export) tar -cf - -C "\${FAKE_IMAGE_ROOT}" . ;;
  image)
    if [[ "$2" == "inspect" ]]; then
      if [[ "$*" == *Size* ]]; then echo 1073741824; else echo sha256:0123456789abcdef0123; fi
    fi
    ;;
esac
exit 0
`;

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
      WRATHBENCH_BUILD_REPO_ROOT: cwdRepo,
      // Pinned, never the default: the default path exists on the operator's
      // host and nowhere else, so an unpinned run would differ by machine.
      WRATHBENCH_PRIVATE_DIR: makePrivate().dir,
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

const builds = (r: Run) => r.calls.filter((l) => l.startsWith("docker build"));
const pushes = (r: Run) => r.calls.filter((l) => l.startsWith("docker push"));

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
    for (const absent of ["scratch.txt", ".env.local", "runner/.env.prod", ".claude", ".git"]) {
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

describe("build-images.sh and the private reference program", () => {
  test("the runner's context carries the program from the private HEAD at runner/src/reference/, and nothing else of that checkout", () => {
    const { tree } = makeRepo();
    const priv = makePrivate();
    const r = run(tree, ["--only", "runner"], { env: { WRATHBENCH_PRIVATE_DIR: priv.dir } });
    expect(r.code).toBe(0);
    const [ctx] = r.contexts;
    expect(ctx!.read("runner/src/reference/index.ts")).toBe("export const program = 1;\n");
    expect(ctx!.read("runner/src/reference/route.ts")).toBe("export const route = 1;\n");
    const fromPrivate = ctx!.entries.filter((e) => e.startsWith("runner/src/reference/"));
    expect(fromPrivate.sort()).toEqual(["runner/src/reference/index.ts", "runner/src/reference/route.ts"]);
    for (const absent of ["reference", "worklogs", "runner/src/reference/scratch.ts", "runner/test"]) expect(ctx!.entries).not.toContain(absent);
    expect(builds(r)[0]).toContain(`--label wrathbench.reference=${priv.sha}`);
    expect(r.out).toContain(`reference program: ${priv.dir}/reference/src at ${priv.sha}`);
  });

  test("a runner build that cannot find it stops before anything is exported or built, saying how to proceed", () => {
    const { tree } = makeRepo();
    for (const missing of [join(tempDir("wb-build-images-none-"), "nope"), tempDir("wb-build-images-empty-")]) {
      const r = run(tree, ["--only", "runner"], { env: { WRATHBENCH_PRIVATE_DIR: missing } });
      expect(r.code).toBe(1);
      expect(r.out).toContain("the scripted reference program is not at");
      expect(r.out).toContain("--without-reference");
      expect(r.calls).toEqual([]);
      expect(r.leftovers).toEqual([]);
    }
    // --private-dir wins over the environment.
    const priv = makePrivate();
    const flagged = run(tree, ["--only", "runner", "--private-dir", priv.dir], { env: { WRATHBENCH_PRIVATE_DIR: "/nonexistent" } });
    expect(flagged.code).toBe(0);
  });

  test("--without-reference builds a local image without it, and never pushes one to the release registry", () => {
    const { tree } = makeRepo();
    const env = { WRATHBENCH_PRIVATE_DIR: "/nonexistent" };
    const local = run(tree, ["--only", "runner", "--without-reference"], { env });
    expect(local.code).toBe(0);
    expect(local.out).toContain("no scripted reference program");
    expect(local.contexts[0]!.entries.some((e) => e.startsWith("runner/src/reference"))).toBe(false);
    expect(builds(local)[0]).not.toContain("wrathbench.reference");
    const pushed = run(tree, ["--only", "runner", "--without-reference", "--push"], { env });
    expect(pushed.code).toBe(1);
    expect(pushed.out).toContain("refusing --without-reference with --push");
    expect(pushed.calls).toEqual([]);
  });

  test("an image carrying it is never pushed to a public registry host; a branch image there is built without it", () => {
    const { tree, sha } = makeRepo();
    for (const registry of ["ghcr.io/shard", "docker.io/shard", "shard"]) {
      const r = run(tree, ["--only", "runner", "--push", "--registry", registry]);
      expect(r.code).toBe(1);
      expect(r.out).toContain("a public registry host");
      expect(r.calls).toEqual([]);
    }
    const branch = run(tree, ["--only", "runner", "--push", "--registry", "ghcr.io/shard", "--without-reference"]);
    expect(branch.code).toBe(0);
    expect(branch.contexts[0]!.entries.some((e) => e.startsWith("runner/src/reference"))).toBe(false);
    expect(pushes(branch)).toEqual([`docker push ghcr.io/shard/wrathbench-runner:${sha.slice(0, 7)}`]);
    // A server image carries no program, so its registry is not this rule's business.
    expect(run(tree, ["--only", "worldserver", "--push", "--registry", "ghcr.io/shard"]).code).toBe(0);
  });

  test("uncommitted changes to the program are refused like a dirty tree", () => {
    const { tree } = makeRepo();
    const priv = makePrivate();
    writeFileSync(join(priv.dir, "reference/src/route.ts"), "export const route = 2;\n");
    const r = run(tree, ["--only", "runner"], { env: { WRATHBENCH_PRIVATE_DIR: priv.dir } });
    expect(r.code).toBe(1);
    expect(r.out).toContain("has uncommitted changes");
    expect(r.calls).toEqual([]);
  });

  test("a server-only build needs no private checkout", () => {
    const { tree } = makeRepo();
    const sub = join(tree, "deps", "azerothcore");
    expect(existsSync(sub)).toBe(true);
    const r = run(tree, ["--only", "worldserver"], { env: { WRATHBENCH_PRIVATE_DIR: "/nonexistent" } });
    expect(r.code).toBe(0);
    expect(r.contexts[0]!.entries.some((e) => e.startsWith("runner/src/reference"))).toBe(false);
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
