/**
 * Sandbox eval semantics against the real child process. No game stack: the
 * SDK client is constructed but never connected.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SandboxHost } from "../src/sandbox/host";
import { Scratchpad } from "../src/scratchpad";

const hosts: SandboxHost[] = [];

function makeHost(opts: Partial<ConstructorParameters<typeof SandboxHost>[0]> = {}): SandboxHost {
  const dir = mkdtempSync(join(tmpdir(), "wrathbench-sbx-"));
  const host = new SandboxHost({
    moduleUrl: "http://worldserver:8086",
    token: "test-token",
    scratchpad: new Scratchpad(join(dir, "scratchpad.md")),
    snippetTimeoutMs: 2_000,
    pingGraceMs: 1_000,
    ...opts,
  });
  hosts.push(host);
  return host;
}

afterEach(async () => {
  await Promise.all(hosts.splice(0, hosts.length).map((h) => h.stop()));
});

describe("sandbox evaluation", () => {
  test("single expression returns its value, REPL-style", async () => {
    const host = makeHost();
    const res = await host.evalSnippet("40 + 2");
    expect(res.ok).toBe(true);
    expect(res.value).toBe("42");
  });

  test("top-level bindings persist across snippets", async () => {
    const host = makeHost();
    expect((await host.evalSnippet("const base: number = 10; let acc = base * 2;")).ok).toBe(true);
    expect((await host.evalSnippet("function bump(n: number) { return n + acc; }")).ok).toBe(true);
    const res = await host.evalSnippet("bump(base)");
    expect(res.ok).toBe(true);
    expect(res.value).toBe("30");
  });

  test("routines started in one snippet run and can be stopped in another", async () => {
    const host = makeHost();
    await host.evalSnippet("let ticks = 0; const timer = setInterval(() => { ticks++; }, 20);");
    await host.evalSnippet("await sleep(150);");
    const res = await host.evalSnippet("clearInterval(timer); ticks > 2");
    // `clearInterval(timer); ticks > 2` is statements; final value not returned,
    // so check via an expression snippet instead.
    expect(res.ok).toBe(true);
    const check = await host.evalSnippet("ticks > 2");
    expect(check.value).toBe("true");
    const frozen = await host.evalSnippet("const was = ticks; await sleep(100); return ticks === was;");
    expect(frozen.value).toBe("true");
  });

  test("console output and errors are captured", async () => {
    const host = makeHost();
    const res = await host.evalSnippet('console.log("hello", { a: 1n }); console.warn("careful");');
    expect(res.ok).toBe(true);
    expect(res.logs.map((l) => l.level)).toEqual(["log", "warn"]);
    expect(res.logs[0]!.text).toContain("hello");
    const err = await host.evalSnippet("throw new Error('boom')");
    expect(err.ok).toBe(false);
    expect(err.error).toContain("boom");
  });

  test("await-timeout abandons the eval but leaves the runtime alive", async () => {
    const host = makeHost({ snippetTimeoutMs: 300 });
    await host.evalSnippet("let alive = 'yes';");
    const res = await host.evalSnippet("await sleep(5_000); alive = 'no';");
    expect(res.ok).toBe(false);
    expect(res.timedOut).toBe(true);
    expect(res.restarted).toBeUndefined();
    // runtime survived, bindings intact
    const after = await host.evalSnippet("alive");
    expect(after.value).toBe(JSON.stringify("yes"));
    expect(host.totalRestarts).toBe(0);
  });

  test("event-loop-blocking snippet gets the process killed and restarted", async () => {
    const host = makeHost({ snippetTimeoutMs: 300, pingGraceMs: 300 });
    await host.evalSnippet("let precious = 'state';");
    const res = await host.evalSnippet("for (;;) {}");
    expect(res.ok).toBe(false);
    expect(res.timedOut).toBe(true);
    expect(res.restarted).toBe(true);
    expect(host.totalRestarts).toBe(1);
    const notices = host.drainNotices();
    expect(notices.some((n) => n.kind === "sandbox_restarted")).toBe(true);
    // state was lost, runtime is fresh and working
    const after = await host.evalSnippet("typeof precious");
    expect(after.value).toBe(JSON.stringify("undefined"));
  }, 15_000);

  test("child dying mid-snippet surfaces state loss and a notice (gate2-ox-3 bug)", async () => {
    const host = makeHost();
    await host.evalSnippet("let precious = 'state';");
    const res = await host.evalSnippet("process.exit(7)");
    expect(res.ok).toBe(false);
    expect(res.restarted).toBe(true);
    expect(res.error).toContain("exited");
    expect(res.error).toContain("bindings");
    expect(host.totalRestarts).toBe(1);
    const notices = host.drainNotices();
    expect(notices.some((n) => n.kind === "sandbox_restarted" && n.text.includes("unexpectedly"))).toBe(true);
    // lazy respawn: the next snippet gets a fresh, working runtime
    const after = await host.evalSnippet("typeof precious");
    expect(after.value).toBe(JSON.stringify("undefined"));
  }, 15_000);

  test("child dying between snippets still produces the notice before the next eval", async () => {
    const host = makeHost();
    await host.evalSnippet("setTimeout(() => process.exit(3), 50);");
    await new Promise((r) => setTimeout(r, 500));
    expect(host.totalRestarts).toBe(1);
    expect(host.drainNotices().some((n) => n.kind === "sandbox_restarted")).toBe(true);
    const res = await host.evalSnippet("1 + 1");
    expect(res.ok).toBe(true);
    expect(res.value).toBe("2");
  }, 15_000);

  test("scratchpad helpers bridge to the host-owned file", async () => {
    const host = makeHost();
    const write = await host.evalSnippet('await scratchpad.write("# notes\\nline one")');
    expect(write.ok).toBe(true);
    const read = await host.evalSnippet("await scratchpad.read()");
    expect(read.value).toContain("line one");
    await host.evalSnippet('await scratchpad.append("line two")');
    const again = await host.evalSnippet("await scratchpad.read()");
    expect(again.value).toContain("line two");
  });

  test("fetch to a non-module host is refused in-process", async () => {
    const host = makeHost();
    const res = await host.evalSnippet('await fetch("http://example.com/")');
    expect(res.ok).toBe(false);
    expect(res.error).toContain("not permitted");
  });

  test("sdk and state are ambient without a connection", async () => {
    const host = makeHost();
    const res = await host.evalSnippet("[typeof sdk, typeof state, typeof events, state.self.name]");
    expect(res.ok).toBe(true);
    expect(res.value).toContain(JSON.stringify("object"));
    // recent_events rpc works with an empty buffer
    expect(await host.recentEvents(10)).toEqual([]);
    const snap = await host.stateSnapshot();
    expect(snap["eventCount"]).toBe(0);
  });
});
