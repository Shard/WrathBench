/**
 * The snippet child's network, exec and scope confinement, against the real
 * child process: `runner/src/sandbox/confine.ts` applies Landlock TCP rules
 * (connect only to the module URL's port, bind nothing), grants EXECUTE on
 * nothing but bun itself, and on a kernel with Landlock scopes keeps the
 * child's signals inside its own domain.
 *
 * Two local servers stand in for "the module" and "something else on the same
 * node": the host is built with a module URL naming the first one's port, so
 * reaching it is the positive control and anything on the second port is the
 * refusal — from `node:net`, from `Bun.connect`, from `fetch`, and from a
 * re-exec'd `bun`, which inherits the domain.
 *
 * Landlock ABI 4 (Linux 6.7+) is the floor the wrapper itself requires, so
 * these tests fail rather than skip without it; only the scope test, which
 * needs ABI 6 (Linux 6.12+), skips with the reason.
 */
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { landlockAbi } from "../src/sandbox/confine";
import { SandboxHost } from "../src/sandbox/host";
import { Scratchpad } from "../src/scratchpad";
import { tempDirs } from "./fixtures/temp-dirs";

const tempDir = tempDirs();

const allowedServer = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("module") });
const otherServer = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("not the module") });
const allowed = { port: allowedServer.port ?? 0 };
const other = { port: otherServer.port ?? 0 };
afterAll(() => {
  allowedServer.stop(true);
  otherServer.stop(true);
});

const hosts: SandboxHost[] = [];
function makeHost(): SandboxHost {
  const host = new SandboxHost({
    moduleUrl: `http://127.0.0.1:${allowed.port}`,
    token: "test-token",
    scratchpad: new Scratchpad(join(tempDir("wrathbench-sbxnet-"), "scratchpad.md")),
    snippetTimeoutMs: 5_000,
    pingGraceMs: 1_000,
  });
  hosts.push(host);
  return host;
}
afterEach(async () => {
  await Promise.all(hosts.splice(0, hosts.length).map((h) => h.stop()));
});

/** `node:net` connect to 127.0.0.1:port in the child: "OPEN" or the error code. */
const netConnect = (port: number): string =>
  `const net = await import("node:net"); return await new Promise((res) => { const s = net.connect(${port}, "127.0.0.1"); s.once("connect", () => { s.destroy(); res("OPEN"); }); s.once("error", (e) => res(e.code ?? String(e))); });`;

/** `Bun.connect` to 127.0.0.1:port in the child: "OPEN" or the error code. */
const bunConnect = (port: number): string =>
  `try { const s = await Bun.connect({ hostname: "127.0.0.1", port: ${port}, socket: { data() {}, open(s) { s.end(); } } }); return "OPEN"; } catch (e) { return e.code ?? String(e); }`;

/** `Bun.spawn(argv)` in the child: "SPAWNED" or the error code. */
const spawn = (argv: string[]): string =>
  `try { const p = Bun.spawn(${JSON.stringify(argv)}, { stdout: "pipe", stderr: "pipe" }); await p.exited; return "SPAWNED"; } catch (e) { return e.code ?? String(e); }`;

const unquote = (v: string | undefined): string => JSON.parse(v ?? '""') as string;

describe("sandbox network confinement", () => {
  test("the module's port is reachable: fetch, node:net and Bun.connect all connect", async () => {
    const host = makeHost();
    const viaFetch = await host.evalSnippet(`return await (await fetch("http://127.0.0.1:${allowed.port}/")).text()`);
    expect(viaFetch.ok).toBe(true);
    expect(viaFetch.value).toBe('"module"');
    expect(unquote((await host.evalSnippet(netConnect(allowed.port))).value)).toBe("OPEN");
    expect(unquote((await host.evalSnippet(bunConnect(allowed.port))).value)).toBe("OPEN");
  });

  test("any other port is EACCES from the kernel, whatever API dials it", async () => {
    const host = makeHost();
    // The server is really there: the test process itself can reach it.
    expect(await (await fetch(`http://127.0.0.1:${other.port}/`)).text()).toBe("not the module");
    expect(unquote((await host.evalSnippet(netConnect(other.port))).value)).toBe("EACCES");
    expect(unquote((await host.evalSnippet(bunConnect(other.port))).value)).toBe("EACCES");
    // fetch: the in-process guard answers first with its own message (the
    // readable layer); the kernel is behind it either way.
    const viaFetch = await host.evalSnippet(`try { await fetch("http://127.0.0.1:${other.port}/"); return "OPEN"; } catch (e) { return e.code ?? e.message; }`);
    expect(unquote(viaFetch.value)).toMatch(/EACCES|not permitted/);
    expect(unquote(viaFetch.value)).not.toBe("OPEN");
  });

  test("the child can bind nothing: Bun.listen, Bun.serve and node:net all get EACCES", async () => {
    const host = makeHost();
    const bunListen = await host.evalSnippet(
      'try { const s = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } }); s.stop(true); return "BOUND"; } catch (e) { return e.code ?? String(e); }',
    );
    expect(unquote(bunListen.value)).toBe("EACCES");
    const bunServe = await host.evalSnippet(
      'try { const s = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") }); s.stop(true); return "BOUND"; } catch (e) { return e.code ?? String(e); }',
    );
    expect(unquote(bunServe.value)).toBe("EACCES");
    const nodeListen = await host.evalSnippet(
      'const net = await import("node:net"); return await new Promise((res) => { const s = net.createServer(); s.once("error", (e) => res(e.code ?? String(e))); s.listen(0, "127.0.0.1", () => { s.close(); res("BOUND"); }); });',
    );
    expect(unquote(nodeListen.value)).toBe("EACCES");
  });

  test("no binary but bun executes: /bin/sh and curl are EACCES at spawn", async () => {
    const host = makeHost();
    expect(unquote((await host.evalSnippet(spawn(["/bin/sh", "-c", "true"]))).value)).toBe("EACCES");
    expect(unquote((await host.evalSnippet(spawn(["sh", "-c", "true"]))).value)).toBe("EACCES");
    const curl = Bun.which("curl");
    if (curl !== null) {
      expect(unquote((await host.evalSnippet(spawn([curl, `http://127.0.0.1:${other.port}/`]))).value)).toBe("EACCES");
    }
  });

  test("a re-exec'd bun inherits the domain: it cannot reach the other port either", async () => {
    const host = makeHost();
    const code = `const net = require("node:net"); const s = net.connect(${other.port}, "127.0.0.1"); s.once("connect", () => { console.log("OPEN"); process.exit(0); }); s.once("error", (e) => { console.log(e.code); process.exit(0); });`;
    const res = await host.evalSnippet(
      `const p = Bun.spawn([process.execPath, "-e", ${JSON.stringify(code)}], { stdout: "pipe", stderr: "pipe" }); const out = await new Response(p.stdout).text(); await p.exited; return JSON.stringify({ out: out.trim(), code: p.exitCode });`,
    );
    expect(res.ok).toBe(true);
    // The new process has a pid of its own, and the ruleset grants /proc only
    // for the child's pid, so a re-exec'd bun does not even start (it cannot
    // read its own /proc entry); if it did, it would still be in the domain
    // and its connect would be EACCES. Either way it never connects.
    const r = JSON.parse(unquote(res.value)) as { out: string; code: number };
    expect(r.out).not.toBe("OPEN");
    expect(r.out === "EACCES" || (r.out === "" && r.code !== 0)).toBe(true);
  });

  test.skipIf(landlockAbi() < 6)("scoped (ABI 6): the child cannot signal the host process", async () => {
    const host = makeHost();
    // Signal 0 is the permission probe: no signal is delivered, but the kernel
    // runs the same check it would for a real one.
    const res = await host.evalSnippet('try { process.kill(process.ppid, 0); return "SIGNALLED"; } catch (e) { return e.code ?? String(e); }');
    expect(unquote(res.value)).toBe("EPERM");
    // Its own process is inside the domain.
    expect(unquote((await host.evalSnippet('try { process.kill(process.pid, 0); return "OK"; } catch (e) { return e.code; }')).value)).toBe("OK");
  });

  test("the SDK still works under the ruleset: client constructed, bindings and routines live", async () => {
    const host = makeHost();
    expect((await host.evalSnippet("typeof sdk.createSession")).value).toBe('"function"');
    await host.evalSnippet("let ticks = 0; const t = setInterval(() => { ticks++; }, 10);");
    await host.evalSnippet("await sleep(100); clearInterval(t);");
    expect((await host.evalSnippet("ticks > 2")).value).toBe("true");
  });
});
