/**
 * No secret the runner holds is within a snippet's reach, by any path a
 * snippet has: its own environment, the parent's, a sibling run's child, a
 * process with a secret on its command line, the files the lanes keep their
 * logins in, and `/dev/shm`. Against the real confined child, with sentinel
 * values planted where the real ones live on the fleet — no game stack.
 *
 * Each planted value carries one marker, so the assertion is a single
 * question asked of everything the snippet returns: did the marker come back?
 * The one credential the child is meant to hold, its own leased session
 * secret, is the positive control: it is in the child's environment, and a
 * sibling's lease is not.
 *
 * The environment allowlist is `sandboxChildEnv` (host.ts); the filesystem,
 * `/proc` and `/dev` rules are `confinementPlan` (confine.ts), pinned on their
 * own in sandbox-confine.test.ts.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Subprocess } from "bun";
import { SandboxHost } from "../src/sandbox/host";
import { Scratchpad } from "../src/scratchpad";
import { tempDirs } from "./fixtures/temp-dirs";

const tempDir = tempDirs();

/** In every planted value and in nothing else: a hit anywhere is a leak. */
const MARK = "WBSENTINEL";
const planted = (what: string): string => `${MARK}-${what}-0123456789abcdef`;

/** Every credential the fleet and runner pods hold in their environment, plus the ones a CLI would bill with. */
const PARENT_ENV = [
  "OPENROUTER_KEY",
  "OPENCODE_KEY",
  "DEEPSEEK_KEY",
  "CEREBRAS_KEY",
  "LMSTUDIO_KEY",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN_2",
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "CODEX_API_KEY",
  "WRATHBENCH_MODULE_SECRET",
  "WRATHBENCH_DB_PASSWORD",
  "WRATHBENCH_ACCOUNT_PASSWORD",
  "CLICKHOUSE_PASSWORD",
  "MYSQL_PWD",
  "S3_ACCESS_KEY_ID",
  "S3_SECRET_ACCESS_KEY",
  "CF_API_KEY_DEPLOY",
  "WRATHBENCH_CF_DEPLOY_TOKEN",
] as const;

const OWN_LEASE = "own-lease-secret-0123456789abcdef0123456789abcdef";
const SIBLING_LEASE = planted("sibling-lease");

const saved = new Map<string, string | undefined>();
const files: Record<string, string> = {};
let shmFile: string | null = null;
let decoy: Subprocess | null = null;
const hosts: SandboxHost[] = [];

function makeHost(secret: string): SandboxHost {
  const host = new SandboxHost({
    moduleUrl: "http://127.0.0.1:8086",
    token: `tok-${secret.slice(0, 8)}-0123456789abcdef`,
    secret,
    scratchpad: new Scratchpad(join(tempDir("wrathbench-sbxsec-"), "scratchpad.md")),
    snippetTimeoutMs: 10_000,
    pingGraceMs: 1_000,
  });
  hosts.push(host);
  return host;
}

beforeAll(() => {
  // The lanes' and the run's files, where the fleet keeps them: a codex
  // home's login, a Claude config dir's credentials, a run's meta.json with its
  // session token, and a repo-root .env. All in temp directories here; on the
  // fleet they sit under $HOME and data/, which the ruleset grants as little.
  const home = tempDir("wrathbench-sbxsec-home-");
  mkdirSync(join(home, ".codex"), { recursive: true });
  mkdirSync(join(home, "claude-config"), { recursive: true });
  mkdirSync(join(home, "runs", "r1"), { recursive: true });
  files["codexAuth"] = join(home, ".codex", "auth.json");
  files["claudeCredentials"] = join(home, "claude-config", ".credentials.json");
  files["meta"] = join(home, "runs", "r1", "meta.json");
  files["dotenv"] = join(home, ".env");
  writeFileSync(files["codexAuth"], JSON.stringify({ tokens: { access_token: planted("codex-auth") } }));
  writeFileSync(files["claudeCredentials"], JSON.stringify({ claudeAiOauth: { accessToken: planted("claude-oauth-file") } }));
  writeFileSync(files["meta"], JSON.stringify({ config: { token: planted("session-token") } }));
  writeFileSync(files["dotenv"], `OPENROUTER_KEY=${planted("dotenv")}\n`);
  for (const name of PARENT_ENV) {
    saved.set(name, process.env[name]);
    process.env[name] = planted(name);
  }
  saved.set("CODEX_HOME", process.env["CODEX_HOME"]);
  process.env["CODEX_HOME"] = join(home, ".codex");
  // Shared memory another process left: readable by the user, so only the
  // ruleset keeps the child out of it.
  if (existsSync("/dev/shm")) {
    try {
      shmFile = join("/dev/shm", `wrathbench-sbxsec-${process.pid}`);
      writeFileSync(shmFile, planted("dev-shm"));
    } catch {
      shmFile = null;
    }
  }
  // A process with a secret on its command line, the shape a `mysql -p…` or a
  // `curl -H "Authorization: …"` has.
  decoy = Bun.spawn([process.execPath, "-e", "setTimeout(() => {}, 60000)", planted("argv")], { stdout: "ignore", stderr: "ignore" });
});

afterAll(async () => {
  await Promise.all(hosts.splice(0).map((h) => h.stop()));
  decoy?.kill();
  if (shmFile !== null) rmSync(shmFile, { force: true });
  for (const [name, value] of saved) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

/**
 * The sweep a snippet would run to collect secrets: everything readable is
 * read, and the answer is the error code or "READ" plus whether the marker
 * was in it. `marks` lists every place the marker came back from.
 */
function sweep(o: { pids: Record<string, number>; files: Record<string, string>; shm: string | null }): string {
  return `
const fs = await import("node:fs");
const marks = [];
const out = {};
const read = (label, path) => {
  try {
    const text = fs.readFileSync(path, "latin1");
    if (text.includes(${JSON.stringify(MARK)})) marks.push(label);
    out[label] = "READ";
  } catch (e) {
    out[label] = e.code ?? String(e);
  }
};
const env = JSON.stringify(process.env);
if (env.includes(${JSON.stringify(MARK)})) marks.push("process.env");
out.ownLeaseInEnv = process.env.WRATHBENCH_SECRET === ${JSON.stringify(OWN_LEASE)};
out.sdkCreate = typeof sdk.createSession;
read("self/environ", "/proc/self/environ");
read("self/status", "/proc/self/status");
const pids = ${JSON.stringify(o.pids)};
pids.parent = process.ppid;
for (const [who, pid] of Object.entries(pids)) {
  for (const f of ["environ", "cmdline", "status", "mem", "root/etc/hostname"]) read(who + "/" + f, "/proc/" + pid + "/" + f);
}
try {
  const listed = fs.readdirSync("/proc").filter((d) => /^[0-9]+$/.test(d));
  out.procListing = listed.length;
  for (const pid of listed) read("listed/" + pid, "/proc/" + pid + "/cmdline");
} catch (e) {
  out.procListing = e.code ?? String(e);
}
for (const [label, path] of Object.entries(${JSON.stringify(o.files)})) read(label, path);
${o.shm === null ? "" : `read("devShm", ${JSON.stringify(o.shm)}); try { out.devShmListing = fs.readdirSync("/dev/shm").length; } catch (e) { out.devShmListing = e.code ?? String(e); }`}
return JSON.stringify({ marks, out });
`;
}

describe("no secret is within a snippet's reach", () => {
  test("not in its environment, not in any process's, not on any command line, not in any file a lane or run keeps", async () => {
    const sibling = makeHost(SIBLING_LEASE);
    const siblingPid = JSON.parse((await sibling.evalSnippet("process.pid")).value ?? "0") as number;
    expect(siblingPid).toBeGreaterThan(0);
    const host = makeHost(OWN_LEASE);
    const res = await host.evalSnippet(sweep({ pids: { decoy: decoy?.pid ?? 0, sibling: siblingPid, init: 1 }, files, shm: shmFile }));
    expect(res.ok).toBe(true);
    const raw = res.value ?? "";
    // The whole answer, as the model would read it, carries no planted value.
    expect(raw.includes(MARK)).toBe(false);
    const { marks, out } = JSON.parse(JSON.parse(raw) as string) as { marks: string[]; out: Record<string, unknown> };
    expect(marks).toEqual([]);

    // Positive controls: the child is confined, not broken. Its own /proc entry
    // reads and the ambient sdk works. The lease the child authenticates with is
    // not even in its own environment any more: entry.ts strikes it at startup,
    // so a snippet cannot read it back and build another client (#74; operator,
    // 2026-10-19). The client kept it in a #-private field before it was struck.
    expect(out["ownLeaseInEnv"]).toBe(false);
    expect(out["sdkCreate"]).toBe("function");
    expect(out["self/environ"]).toBe("READ");
    expect(out["self/status"]).toBe("READ");

    // Every other process is out of reach, its command line included.
    for (const who of ["parent", "decoy", "sibling", "init"]) {
      for (const f of ["environ", "cmdline", "status", "mem", "root/etc/hostname"]) {
        expect([`${who}/${f}`, out[`${who}/${f}`]]).toEqual([`${who}/${f}`, "EACCES"]);
      }
    }
    expect(out["procListing"]).toBe("EACCES");
    // The lanes' logins, the run's meta.json and a .env, by absolute path.
    for (const label of Object.keys(files)) expect([label, out[label]]).toEqual([label, "EACCES"]);
    if (shmFile !== null) {
      expect(out["devShm"]).toBe("EACCES");
      expect(out["devShmListing"]).toBe("EACCES");
    }
  });

  test("the parent's planted credentials never reach the child's environment, by name either", async () => {
    const host = makeHost(OWN_LEASE);
    const names = JSON.parse(JSON.parse((await host.evalSnippet("JSON.stringify(Object.keys(process.env).sort())")).value ?? '""') as string) as string[];
    for (const name of [...PARENT_ENV, "CODEX_HOME"]) expect(names).not.toContain(name);
    // Nor the leased secret or the bound account: the host passes them in the
    // spawn env but entry.ts strikes them at startup, so neither is in the
    // running child's environment (#74; operator, 2026-10-19).
    expect(names).not.toContain("WRATHBENCH_SECRET");
    expect(names).not.toContain("WRATHBENCH_ACCOUNT");
    // What it does get: the plumbing and the two values the host passes that
    // are not credentials (module URL and the session token).
    for (const name of names) {
      expect(["PATH", "HOME", "TMPDIR", "WRATHBENCH_MODULE_URL", "WRATHBENCH_TOKEN", "NODE_CHANNEL_FD", "NODE_CHANNEL_SERIALIZATION_MODE"]).toContain(name);
    }
  });
});
