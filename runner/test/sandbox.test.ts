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
    // the notice carries the exit code so a crash is diagnosable from the trajectory
    expect(notices.some((n) => n.kind === "sandbox_restarted" && n.text.includes("exit code 7"))).toBe(true);
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

  test("unhandled rejection from a fire-and-forget promise does not kill the runtime (night-laguna-oc-1 bug)", async () => {
    const host = makeHost();
    await host.evalSnippet("let precious = 'state';");
    // The night-laguna-oc-1 shape: an async SDK call fired without await whose
    // promise rejects after the snippet result has already been sent.
    const res = await host.evalSnippet(
      "void (async () => { await sleep(50); throw new Error('late-boom'); })(); 'done'",
    );
    expect(res.ok).toBe(true);
    await new Promise((r) => setTimeout(r, 400));
    expect(host.totalRestarts).toBe(0);
    // the error was reported, not fatal: a session_note notice, never a restart
    const notices = host.drainNotices();
    expect(notices.some((n) => n.kind === "sandbox_restarted")).toBe(false);
    expect(notices.some((n) => n.kind === "session_note" && n.text.includes("late-boom"))).toBe(true);
    // bindings survived, and the next snippet's logs carry the background error
    const after = await host.evalSnippet("precious");
    expect(after.value).toBe(JSON.stringify("state"));
    expect(after.logs.some((l) => l.level === "error" && l.text.includes("late-boom"))).toBe(true);
  }, 15_000);

  test("background uncaught exception is reported, not fatal", async () => {
    const host = makeHost();
    await host.evalSnippet("let precious = 'state'; setTimeout(() => { throw new Error('timer-boom'); }, 50);");
    await new Promise((r) => setTimeout(r, 400));
    expect(host.totalRestarts).toBe(0);
    expect(host.drainNotices().some((n) => n.kind === "session_note" && n.text.includes("timer-boom"))).toBe(true);
    const after = await host.evalSnippet("precious");
    expect(after.value).toBe(JSON.stringify("state"));
  }, 15_000);

  test("crash notice carries the child's last stderr", async () => {
    const host = makeHost();
    const res = await host.evalSnippet(
      "process.stderr.write('doom marker 42\\n'); await sleep(20); process.exit(9);",
    );
    expect(res.restarted).toBe(true);
    const notices = host.drainNotices();
    const crash = notices.find((n) => n.kind === "sandbox_restarted");
    expect(crash).toBeDefined();
    expect(crash!.text).toContain("exit code 9");
    expect(crash!.text).toContain("doom marker 42");
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

describe("error rendering (2026-08 audit fixes)", () => {
  test("multi-error parse failure flattens sub-errors with wrapper-corrected line numbers", async () => {
    const host = makeHost();
    // Two parse errors; the first sits on user line 2, which the transpiler
    // reports as line 3 because of the one-line compile wrapper.
    const res = await host.evalSnippet("const ok = 1;\nconst x = {;\nlet y ==== 4;");
    expect(res.ok).toBe(false);
    expect(res.error).toContain("AggregateError");
    // Not the bare "AggregateError: Parse error" the models used to get:
    expect(res.error).toContain('Expected identifier but found ";"');
    expect(res.error).toContain("at line 2");
    expect(res.error).toContain("const x = {;");
  });

  test("a single parse error (BuildMessage) renders its position too", async () => {
    const host = makeHost();
    const res = await host.evalSnippet("const a = 1;\nconst b = ;");
    expect(res.ok).toBe(false);
    expect(res.error).toContain("Unexpected ;");
    expect(res.error).toContain("at line 2");
    expect(res.error).toContain("const b = ;");
  });

  test("JSON.stringify on a snippet-conjured bigint names the fix (SDK guids are strings now)", async () => {
    const host = makeHost();
    const res = await host.evalSnippet("JSON.stringify({ n: 123n })");
    expect(res.ok).toBe(false);
    expect(res.error).toContain("BigInt");
    expect(res.error).toContain("guids are already plain strings");
    expect(res.error).toContain("String(x)");
  });

  test("timed-out snippet returns its buffered console logs and background-routine guidance", async () => {
    const host = makeHost({ snippetTimeoutMs: 300 });
    const res = await host.evalSnippet('console.log("before the wall"); await sleep(5_000);');
    expect(res.ok).toBe(false);
    expect(res.timedOut).toBe(true);
    // The abandoned snippet's logs come back via the liveness ping's drain.
    expect(res.logs.map((l) => l.text).join("\n")).toContain("before the wall");
    expect(res.error).toContain("background");
    expect(res.error).toContain("may still be running");
    // ...and were consumed: they do not repeat on the next snippet.
    const next = await host.evalSnippet("1 + 1");
    expect(next.logs).toEqual([]);
  });

  test("event-loop-kill message carries the state-loss recovery guidance", async () => {
    const host = makeHost({ snippetTimeoutMs: 300, pingGraceMs: 300 });
    const res = await host.evalSnippet("for (;;) {}");
    expect(res.restarted).toBe(true);
    expect(res.error).toContain("token_in_use");
    expect(res.error).toContain("await connect()");
  }, 15_000);
});
