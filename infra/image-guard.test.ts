/**
 * infra/image-guard.sh: the matcher on its own (`--paths`, fixture path lists)
 * and the image mode against a `docker` shim whose `export` tars a fixture
 * directory, so nothing here needs a daemon.
 *
 * Fixture secrets are invented strings, and every assertion that a secret was
 * found also asserts its content was not printed: the guard names paths only.
 * Children get a bare environment, never this process's, which `bun test`
 * fills from the repository's .env.
 */
import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tempDirs } from "./temp-dirs";

const tempDir = tempDirs();
const GUARD = join(import.meta.dir, "image-guard.sh");
const BASE_ENV = { PATH: process.env.PATH ?? "/usr/bin:/bin" };

function match(paths: string[], root?: string): { code: number; flagged: string[]; out: string } {
  const proc = Bun.spawnSync(["bash", GUARD, "--paths", ...(root !== undefined ? ["--root", root] : [])], {
    stdin: new TextEncoder().encode(`${paths.join("\n")}\n`),
    stdout: "pipe",
    stderr: "pipe",
    env: BASE_ENV,
  });
  const out = proc.stdout.toString();
  return { code: proc.exitCode ?? -1, flagged: out.split("\n").filter(Boolean), out: out + proc.stderr.toString() };
}

/** Write files under a fresh directory: {relative path: content}. */
function tree(files: Record<string, string>): string {
  const root = tempDir("wb-guard-root-");
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), body);
  }
  return root;
}

describe("image-guard matcher", () => {
  test("refuses env files at any depth, in every spelling tar prints", () => {
    const paths = ["wrathbench/.env", "./wrathbench/.env.local", "/wrathbench/runner/.env.prod", "wrathbench/sdk/a/b/c/.env.staging"];
    const r = match(paths);
    expect(r.code).toBe(1);
    expect(r.flagged).toEqual(["wrathbench/.env", "wrathbench/.env.local", "wrathbench/runner/.env.prod", "wrathbench/sdk/a/b/c/.env.staging"]);
  });

  test("keys and certificates outside the system CA store, and ssh keys anywhere", () => {
    const paths = [
      "wrathbench/infra/server.pem",
      "opt/app/tls.key",
      "etc/ssl/private/ssl-cert-snakeoil.key",
      "etc/ssl/certs-extra/rogue.pem",
      "usr/lib/ssl/private.pem",
      "home/bun/.ssh/id_ed25519",
      "root/.ssh/id_rsa.pub",
    ];
    expect(match(paths).flagged).toEqual(paths);
  });

  test("credential files: git, Codex, cloud and Claude Code's dotted one", () => {
    const paths = ["root/.git-credentials", "home/bun/.codex/auth.json", "home/bun/.aws/credentials", "wrathbench/credentials.json", "srv/.credentials.json"];
    expect(match(paths).flagged).toEqual(paths);
  });

  test("a .claude or .wrangler tree is named once at its root, however many files it holds", () => {
    const paths = ["wrathbench/.claude/"];
    for (let i = 0; i < 200; i++) paths.push(`wrathbench/.claude/worktrees/agent-${i}/runner/src/x.ts`);
    paths.push("wrathbench/.wrangler/state/v3/cache.json", "wrathbench/dashboard/.wrangler/tmp/a.js", "wrathbench/dashboard/.wrangler/tmp/b.js");
    const r = match(paths);
    expect(r.code).toBe(1);
    expect(r.flagged).toEqual(["wrathbench/.claude/", "wrathbench/.wrangler/", "wrathbench/dashboard/.wrangler/"]);
  });

  test("the data volume's mount point, sqlite under the app directories, and client data anywhere", () => {
    const r = match([
      "wrathbench/data/runs/r1/run.sqlite",
      "wrathbench/data/wiki/page.md",
      "wrathbench/runner/store.sqlite",
      "azerothcore/env/dist/state.sqlite-wal",
      "azerothcore/env/dist/data/dbc/Spell.dbc",
      "azerothcore/env/dist/data/Data/common.MPQ",
      "azerothcore/env/dist/data/mmaps/0004949.mmtile",
      "opt/vmaps/000.vmtree",
    ]);
    expect(r.flagged).toEqual([
      "wrathbench/data/",
      "wrathbench/runner/store.sqlite",
      "azerothcore/env/dist/state.sqlite-wal",
      "azerothcore/env/dist/data/dbc/Spell.dbc",
      "azerothcore/env/dist/data/Data/common.MPQ",
      "azerothcore/env/dist/data/mmaps/0004949.mmtile",
      "opt/vmaps/000.vmtree",
    ]);
  });

  test("passes what the images legitimately carry today", () => {
    const r = match([
      "./",
      ".dockerenv",
      "wrathbench/.env.example",
      "wrathbench/runner/src/env.ts",
      "wrathbench/sdk/src/environment.ts",
      "wrathbench/.envrc.md",
      "wrathbench/node_modules/pkg/index.js.map",
      "etc/ssl/certs/",
      "etc/ssl/certs/ISRG_Root_X1.pem",
      "usr/lib/ssl/cert.pem",
      "home/bun/.claude/",
      "home/bun/.claude/backups/",
      "home/bun/.claude/backups/.claude.json.backup.1791434229625",
      "home/bun/.claude/downloads/",
      "home/bun/.claude/sessions/",
      "home/bun/.claude.json",
      "home/bun/.codex/tmp/arg0/codex-arg0ABC/apply_patch",
      "var/lib/apt/listchanges.sqlite",
      "azerothcore/data/sql/base/db_world/creature.sql",
      "azerothcore/env/dist/data/maps/",
    ]);
    expect(r.flagged).toEqual([]);
    expect(r.code).toBe(0);
  });

  test("the CLI's own .claude directory is allowed entry by entry, and anything else in it is named", () => {
    const r = match([
      "home/bun/.claude/",
      "home/bun/.claude/backups/",
      "home/bun/.claude/.credentials.json",
      "home/bun/.claude/settings.json",
      "home/bun/.claude/projects/",
      "home/bun/.claude/projects/x/session.jsonl",
      "home/bun/.claude/sessions/s.json",
    ]);
    expect(r.flagged).toEqual([
      "home/bun/.claude/.credentials.json",
      "home/bun/.claude/settings.json",
      "home/bun/.claude/projects/",
      "home/bun/.claude/sessions/s.json",
    ]);
  });

  test("an .npmrc is refused unless its content was checked and shows no token", () => {
    const root = tree({
      "home/bun/.npmrc": "registry=https://registry.npmjs.org/\nsave-exact=true\n",
      "wrathbench/.npmrc": "//registry.npmjs.org/:_authToken=npm_FIXTUREnotarealtoken\n",
      "srv/.npmrc": "_auth = Zml4dHVyZQ==\n",
    });
    const paths = ["home/bun/.npmrc", "wrathbench/.npmrc", "srv/.npmrc", "opt/missing/.npmrc"];
    const checked = match(paths, root);
    expect(checked.flagged).toEqual(["wrathbench/.npmrc", "srv/.npmrc", "opt/missing/.npmrc"]);
    expect(checked.out).not.toContain("npm_FIXTURE");
    expect(checked.out).not.toContain("Zml4dHVyZQ");
    // With nothing to read, every .npmrc is refused.
    expect(match(["home/bun/.npmrc"]).flagged).toEqual(["home/bun/.npmrc"]);
  });
});

/** A `docker` with no daemon: `export` tars FAKE_IMAGE_ROOT; argv is logged, never the environment. */
const DOCKER_SHIM = `#!/usr/bin/env bash
printf 'docker %s\\n' "$*" >> "\${FAKE_LOG}"
case "$1" in
  create) echo fake-container ;;
  export) [[ "\${FAKE_EXPORT_FAIL:-0}" == "1" ]] && exit 1; tar -cf - -C "\${FAKE_IMAGE_ROOT}" . ;;
esac
exit 0
`;

function scan(files: Record<string, string>, env: Record<string, string> = {}) {
  const dir = tempDir("wb-guard-image-");
  mkdirSync(join(dir, "bin"));
  writeFileSync(join(dir, "bin", "docker"), DOCKER_SHIM);
  chmodSync(join(dir, "bin", "docker"), 0o755);
  const log = join(dir, "calls.log");
  writeFileSync(log, "");
  const proc = Bun.spawnSync(["bash", GUARD, "reg.example/wrathbench/wrathbench-runner:t1"], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...BASE_ENV, PATH: `${join(dir, "bin")}:${BASE_ENV.PATH}`, FAKE_LOG: log, FAKE_IMAGE_ROOT: tree(files), ...env },
  });
  return { code: proc.exitCode ?? -1, out: proc.stdout.toString() + proc.stderr.toString(), calls: Bun.file(log).text() };
}

describe("image-guard on an image", () => {
  test("a clean image passes, and the container it read is removed", async () => {
    const r = scan({ "wrathbench/package.json": "{}", "wrathbench/.env.example": "KEY=\n" });
    expect(r.code).toBe(0);
    expect(r.out).toContain("clean");
    expect(await r.calls).toContain("docker rm -f fake-container");
  });

  test("a secret-shaped path refuses the image and is named without its content", () => {
    const r = scan({ "wrathbench/package.json": "{}", "wrathbench/.env.prod": "API_KEY=fixture-not-a-secret\n" });
    expect(r.code).toBe(1);
    expect(r.out).toContain("REFUSED");
    expect(r.out).toContain("/wrathbench/.env.prod");
    expect(r.out).not.toContain("fixture-not-a-secret");
  });

  test("an .npmrc is read for a token, and only the .npmrc is read", () => {
    const withToken = scan({ "home/bun/.npmrc": "//r.example/:_authToken=npm_FIXTUREnotarealtoken\n" });
    expect(withToken.code).toBe(1);
    expect(withToken.out).toContain("/home/bun/.npmrc");
    expect(withToken.out).not.toContain("npm_FIXTURE");
    const without = scan({ "home/bun/.npmrc": "registry=https://r.example/\n" });
    expect(without.code).toBe(0);
  });

  test("an image it cannot list is refused, never passed", () => {
    const r = scan({ "wrathbench/package.json": "{}" }, { FAKE_EXPORT_FAIL: "1" });
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("refusing it");
  });
});
