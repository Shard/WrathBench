/**
 * The snippet child's filesystem confinement (part 3): the
 * child is exec'd under a Landlock ruleset by `runner/src/sandbox/confine.ts`,
 * so a snippet cannot read `.env` — or anything else outside the interpreter,
 * `runner/`, `sdk/` and `node_modules/` — by any path or API. Against the real
 * child process, no game stack.
 *
 * Positive controls first: the child came up, can import its SDK, and can read
 * a file the allowlist admits, so an `EACCES` below is the ruleset and not a
 * broken sandbox. The repo-root `.env` need not exist on a bare clone, so a
 * tracked file at the root (`LICENSE`) stands in as the always-present
 * negative control, and `.env` is asserted refused whichever error the kernel
 * gives (`EACCES` when present, `ENOENT` when absent — never a read).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { SandboxHost, sandboxChildEnv } from "../src/sandbox/host";
import { Scratchpad } from "../src/scratchpad";

const REPO_ROOT = resolve(import.meta.dir, "..", "..");
const hosts: SandboxHost[] = [];

function makeHost(opts: Partial<ConstructorParameters<typeof SandboxHost>[0]> = {}): SandboxHost {
  const dir = mkdtempSync(join(tmpdir(), "wrathbench-sbxfs-"));
  const host = new SandboxHost({
    moduleUrl: "http://worldserver:8086",
    token: "test-token",
    scratchpad: new Scratchpad(join(dir, "scratchpad.md")),
    snippetTimeoutMs: 5_000,
    pingGraceMs: 1_000,
    ...opts,
  });
  hosts.push(host);
  return host;
}

afterEach(async () => {
  await Promise.all(hosts.splice(0, hosts.length).map((h) => h.stop()));
});

/**
 * `readFileSync(path)` in the child; the value is the error code, or "READ"
 * on success. Snippets have no static import, but `node:fs` is one dynamic
 * import away — which is exactly why an in-process guard could never be the
 * boundary here.
 */
const readCode = (path: string): string =>
  `try { (await import("node:fs")).readFileSync(${JSON.stringify(path)}, "utf8"); return "READ"; } catch (e) { return e.code ?? String(e); }`;

describe("sandbox filesystem confinement", () => {
  test("the child runs confined: allowlisted reads work, everything else is EACCES", async () => {
    const host = makeHost();
    // Positive controls: the SDK imported (the child is up) and an allowlisted
    // file reads — the ruleset admits sdk/, so a refusal below is not "all
    // reads fail".
    expect((await host.evalSnippet("typeof sdk.createSession")).value).toBe('"function"');
    expect((await host.evalSnippet(readCode(join(REPO_ROOT, "sdk", "API.md")))).value).toBe('"READ"');

    // Repo root: tracked file present on every clone, outside the allowlist.
    expect((await host.evalSnippet(readCode(join(REPO_ROOT, "LICENSE")))).value).toBe('"EACCES"');
    // The item's own case, both spellings.
    const absEnv = (await host.evalSnippet(readCode(join(REPO_ROOT, ".env")))).value ?? "";
    expect(["\"EACCES\"", "\"ENOENT\""]).toContain(absEnv);
    expect(absEnv).not.toBe('"READ"');
    const relEnv = (await host.evalSnippet(readCode("../../.env"))).value ?? "";
    expect(["\"EACCES\"", "\"ENOENT\""]).toContain(relEnv);
    expect(relEnv).not.toBe('"READ"');
    // Home and /tmp are not the child's either.
    const home = process.env["HOME"];
    if (home !== undefined) {
      expect((await host.evalSnippet(readCode(home))).value).toBe('"EACCES"');
    }
    expect((await host.evalSnippet(readCode("/tmp"))).value).toBe('"EACCES"');
  });

  test("the refusal is the kernel's, not the module's: Bun.file and a child process hit it too", async () => {
    const host = makeHost();
    const bunFile = await host.evalSnippet(
      `try { await Bun.file(${JSON.stringify(join(REPO_ROOT, "LICENSE"))}).text(); return "READ"; } catch (e) { return e.code ?? String(e); }`,
    );
    expect(bunFile.value).toBe('"EACCES"');
    // A spawned `cat` inherits the ruleset.
    const cat = await host.evalSnippet(
      `const p = Bun.spawn(["cat", ${JSON.stringify(join(REPO_ROOT, "LICENSE"))}], { stdout: "pipe", stderr: "pipe" }); await p.exited; return p.exitCode;`,
    );
    expect(cat.ok).toBe(true);
    expect(cat.value).not.toBe("0");
  });

  test("the child's environment carries the leased session secret and never the port secret", async () => {
    const prev = process.env["WRATHBENCH_MODULE_SECRET"];
    process.env["WRATHBENCH_MODULE_SECRET"] = "port-secret-must-not-cross";
    try {
      // The allowlist itself, on the parent side.
      const env = sandboxChildEnv(process.env, { WRATHBENCH_SECRET: "leased" });
      expect(env["WRATHBENCH_MODULE_SECRET"]).toBeUndefined();
      expect(env["WRATHBENCH_SECRET"]).toBe("leased");
      // And the child as actually spawned.
      const host = makeHost({ secret: "leased-session-secret" });
      const res = await host.evalSnippet(
        'JSON.stringify({ s: process.env.WRATHBENCH_SECRET, m: process.env.WRATHBENCH_MODULE_SECRET ?? null })',
      );
      expect(res.ok).toBe(true);
      expect(JSON.parse(JSON.parse(res.value ?? '""') as string)).toEqual({ s: "leased-session-secret", m: null });
    } finally {
      if (prev === undefined) delete process.env["WRATHBENCH_MODULE_SECRET"];
      else process.env["WRATHBENCH_MODULE_SECRET"] = prev;
    }
  });
});
