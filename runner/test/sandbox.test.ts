/**
 * Sandbox eval semantics against the real child process. No game stack: the
 * SDK client is constructed but never connected.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { formatStateSummary, type SnapshotLike } from "../src/context";
import { SANDBOX_FORWARDED_ENV, SandboxHost, sandboxChildEnv } from "../src/sandbox/host";
import type { ActionHintNote } from "@wrathbench/mcp";
import { Scratchpad, SCRATCHPAD_MAX_CHARS } from "@wrathbench/mcp";
import { tempDirs } from "./fixtures/temp-dirs";

const tempDir = tempDirs();

const hosts: SandboxHost[] = [];

function makeHost(opts: Partial<ConstructorParameters<typeof SandboxHost>[0]> = {}): SandboxHost {
  const dir = tempDir("wrathbench-sbx-");
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

  test("a completion value that is an uncalled function says so", async () => {
    // north-mini-code wrapped all 120 of its snippets in an async arrow it never
    // invoked and was told `ok` every time.
    const host = makeHost();
    const res = await host.evalSnippet("async () => { return 1; }");
    expect(res.ok).toBe(true);
    expect(res.hint).toContain("the snippet returned a function it never called");
    expect(res.hint).toContain("await fn()");
    // A plain value carries no hint.
    expect((await host.evalSnippet("1 + 1")).hint).toBeUndefined();
  });

  test("hint-bearing failures reach the host whatever the snippet returned", async () => {
    // The SDK records them (sdk/test/client.test.ts covers that from real move
    // results); here the point is the channel: the tally leaves the child on
    // the eval result, drained exactly once, regardless of the snippet's value.
    const host = makeHost();
    const record =
      '(sdk as any).noteActionHint("moveTo", "too_far", "walk to an intermediate point first", ' +
      '{ x: 1, y: 2, z: 3 });';
    const res = await host.evalSnippet(`${record} ${record} return "status only";`);
    expect(res.ok).toBe(true);
    expect(res.value).toBe('"status only"');
    expect(res.actionHints).toEqual([
      expect.objectContaining({
        action: "moveTo",
        status: "too_far",
        count: 2,
        hint: "walk to an intermediate point first",
        point: { x: 1, y: 2, z: 3 },
      }),
    ]);
    // Drained: the next snippet does not repeat them.
    expect((await host.evalSnippet("1 + 1")).actionHints).toEqual([]);
  });

  test("hints from a snippet that then threw still come home", async () => {
    const host = makeHost();
    const res = await host.evalSnippet(
      '(sdk as any).noteActionHint("moveTo", "no_mesh", "nothing to retry here", { x: 0, y: 0, z: 0 }); throw new Error("boom");',
    );
    expect(res.ok).toBe(false);
    expect(res.actionHints?.[0]?.status).toBe("no_mesh");
  });

  test("a background routine's hint is drained by the host for a non-snippet result, once", async () => {
    // What lets the next tool result of any kind carry it (tools.ts): the
    // tally leaves the child on its own rpc, not only on a snippet's result.
    const host = makeHost();
    // No child yet: nothing to drain, and draining does not spawn one.
    expect(await host.drainActionHints()).toEqual([]);
    expect((host as unknown as { proc: unknown }).proc).toBeNull();
    const record = '(sdk as any).noteActionHint("moveTo", "drop", "steps off a ledge", { x: 1, y: 2, z: 3 })';
    const launched = await host.evalSnippet(`setTimeout(() => ${record}, 20); "launched"`);
    expect(launched.actionHints).toEqual([]);
    let drained: ActionHintNote[] = [];
    const until = Date.now() + 1_000;
    while (drained.length === 0 && Date.now() < until) {
      drained = await host.drainActionHints();
      if (drained.length === 0) await Bun.sleep(10);
    }
    expect(drained).toEqual([
      expect.objectContaining({ action: "moveTo", status: "drop", count: 1, hint: "steps off a ledge" }),
    ]);
    expect(await host.drainActionHints()).toEqual([]);
    // And the next snippet does not repeat it either.
    expect((await host.evalSnippet("1 + 1")).actionHints).toEqual([]);
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

  test("a background loop over an SDK refusal that sends nothing does not starve the sandbox", async () => {
    // A party run's fight loop awaited `sdk.killTarget` forever; once the
    // character died every call was refused locally, the loop only ever
    // yielded to microtasks, the next snippet and the host's ping were never
    // read, and the sandbox was killed as blocked. An unknown name is the same
    // locally answered refusal on a client that never connected.
    const host = makeHost({ snippetTimeoutMs: 1_000, pingGraceMs: 500 });
    const started = await host.evalSnippet(
      "globalThis.spins = 0;" +
        " globalThis.spin = (async () => { for (;;) { const r = await sdk.moveTo('Nobody By This Name'); if (r.status !== 'unknown_target') return r.status; spins++; } })().catch(String);" +
        " 'started'",
    );
    expect(started.ok).toBe(true);
    const next = await host.evalSnippet("await sleep(20); return [spins > 0, await Promise.race([spin, 'running'])];");
    expect(next.ok).toBe(true);
    expect(next.restarted).toBeUndefined();
    expect(next.value).toBe('[ true, "running" ]');
    expect(host.totalRestarts).toBe(0);
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

  test("the crash notice quotes the stderr the child wrote, every repeat of it, while the log copy is folded", async () => {
    let logged = "";
    const host = makeHost({ logSink: (stream, text) => void (stream === "stderr" ? (logged += text) : undefined) });
    const res = await host.evalSnippet(
      'for (let i = 0; i < 4; i++) console.error("stuck again"); await sleep(20); process.exit(9);',
    );
    expect(res.restarted).toBe(true);
    const crash = host.drainNotices().find((n) => n.kind === "sandbox_restarted")!;
    // What the model reads: the tail as the child wrote it, unfolded.
    expect(crash.text).toContain("Last stderr: stuck again\nstuck again\nstuck again\nstuck again\n");
    await host.stop();
    expect(logged).toBe("stuck again\n[sandbox] the line above repeated ×3 more\n");
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
    // A write resolves to the pad's new size.
    expect((await host.evalSnippet('await scratchpad.write("abc")')).value).toBe("{\n  chars: 3,\n}");
  });

  test("snippet fetch is refused in-process, the module host included, pointing at the ambient sdk", async () => {
    const host = makeHost();
    const other = await host.evalSnippet('await fetch("http://example.com/")');
    expect(other.ok).toBe(false);
    expect(other.error).toContain("not available");
    expect(other.error).toContain("ambient sdk");
    // The module host too: a snippet may not open its own connection to the
    // module (#74; operator, 2026-10-19). The ambient client reaches it through
    // its own transport, which does not go through `globalThis.fetch`.
    const mod = await host.evalSnippet('await fetch("http://worldserver:8086/action", { method: "POST", body: "{}" })');
    expect(mod.ok).toBe(false);
    expect(mod.error).toContain("not available");
  });

  test("snippet WebSocket is refused, the module host included", async () => {
    const host = makeHost();
    const res = await host.evalSnippet('new WebSocket("ws://worldserver:8086/events")');
    expect(res.ok).toBe(false);
    expect(res.error).toContain("not available");
    expect(res.error).toContain("ambient sdk");
  });

  test("a snippet cannot lose the session by nulling or overwriting sdk/state/events", async () => {
    const host = makeHost();
    // Null all three within one snippet; the no-op setter swallows it.
    const within = await host.evalSnippet('sdk = null; state = null; events = null; return JSON.stringify({ sdk: typeof sdk, state: typeof state, events: typeof events })');
    expect(within.ok).toBe(true);
    expect(JSON.parse(JSON.parse(within.value ?? '""') as string)).toEqual({ sdk: "object", state: "object", events: "object" });
    // And a `let sdk = …` (keyword-stripped to a global assignment by
    // rewrite.ts) cannot clobber it either: the getter is intact next snippet.
    const after = await host.evalSnippet('let sdk = undefined; typeof sdk');
    expect(after.ok).toBe(true);
    const next = await host.evalSnippet('typeof sdk.createSession');
    expect(next.value).toBe('"function"');
  });

  test("a snippet cannot build a usable client of its own (constructor reach-through)", async () => {
    const host = makeHost();
    // The class is reachable as `sdk.constructor`, but a client built from it
    // has no credential (the leased secret is a #-private field, struck from
    // the env) and its default transport is the refusing `globalThis.fetch`, so
    // it cannot send to the module.
    const res = await host.evalSnippet(
      'const C = sdk.constructor; const c2 = new C({ baseUrl: "http://worldserver:8086", token: "tok-0123456789abcdef0123456789abcdef" }); try { await c2.createSession({ character: "Xx", race: 1, class: 1 }); return "CREATED"; } catch (e) { return String(e.message ?? e); }',
    );
    expect(res.ok).toBe(true);
    expect(res.value).not.toContain("CREATED");
    expect(res.value).toContain("not available");
  });

  test("the leased secret is not readable off the ambient sdk, by field, reflection or stringify", async () => {
    const host = makeHost({ secret: "leaked-secret-0123456789abcdef0123456789abcdef" });
    const res = await host.evalSnippet(
      'JSON.stringify({ secret: sdk.secret ?? null, evSecret: sdk.events.secret ?? null, inKeys: Object.keys(sdk).includes("secret"), inOwn: Object.getOwnPropertyNames(sdk).includes("secret"), inInspect: Bun.inspect(sdk).includes("leaked-secret"), inJson: (() => { try { return JSON.stringify(sdk).includes("leaked-secret"); } catch { return false; } })() })',
    );
    expect(res.ok).toBe(true);
    expect(JSON.parse(JSON.parse(res.value ?? '""') as string)).toEqual({ secret: null, evSecret: null, inKeys: false, inOwn: false, inInspect: false, inJson: false });
  });

  test("the leased secret and account are struck from the child's environment", async () => {
    const host = makeHost({ secret: "env-secret-0123456789abcdef0123456789abcdef", account: "RUNNER" });
    const res = await host.evalSnippet('JSON.stringify({ secret: process.env.WRATHBENCH_SECRET ?? null, account: process.env.WRATHBENCH_ACCOUNT ?? null, bunSecret: Bun.env.WRATHBENCH_SECRET ?? null })');
    expect(res.ok).toBe(true);
    expect(JSON.parse(JSON.parse(res.value ?? '""') as string)).toEqual({ secret: null, account: null, bunSecret: null });
    // The session still works: the client read and kept the secret before it
    // was struck.
    expect((await host.evalSnippet("typeof sdk.createSession")).value).toBe('"function"');
  });

  test("the child env is exactly the allowlist: host credentials never reach a snippet", async () => {
    // A canary secret in the runner's own env, plus a real provider key name.
    // Neither must be visible to a snippet dumping process.env — the model
    // authors snippets and its exfil channel is the result stream itself. The
    // snippet returns KEY NAMES only, so a failure never prints a credential
    // value into test output.
    process.env["WB_CANARY_SECRET"] = "canary-do-not-leak-42";
    process.env["OPENROUTER_KEY"] = "sk-or-must-not-leak";
    // WRATHBENCH_-spelled credentials: the `runner` and `fleet` services carry
    // the database ones so the gate's smokes can stage a fixture, and wherever
    // Bun autoloads a `.env` every WRATHBENCH_ value in it is in the runner's
    // environment. The child forwards a NAMED list, never the prefix.
    const prefixed = {
      WRATHBENCH_DB_PASSWORD: "fake-db-password",
      WRATHBENCH_SOMETHING_SECRET: "fake-something-secret",
      WRATHBENCH_R2_SECRET_ACCESS_KEY: "fake-r2-secret",
      WRATHBENCH_R2_ACCESS_KEY_ID: "fake-r2-key-id",
      WRATHBENCH_ACCOUNT_PASSWORD: "fake-account-password",
      WRATHBENCH_CF_DEPLOY_TOKEN: "fake-cf-token",
      WRATHBENCH_CLICKHOUSE_PASSWORD: "fake-clickhouse-password",
    };
    Object.assign(process.env, prefixed);
    try {
      const host = makeHost();
      const res = await host.evalSnippet('Object.keys(process.env).sort().join(",")');
      expect(res.ok).toBe(true);
      // res.value is Bun.inspect of the joined string: a quoted plain string.
      const keys = (JSON.parse(res.value ?? '""') as string).split(",");
      // Positive control: the snippet ran and the allowlisted vars ARE present,
      // so absence of the secrets means the allowlist works, not that we threw.
      expect(keys).toContain("WRATHBENCH_TOKEN");
      expect(keys).toContain("WRATHBENCH_MODULE_URL");
      // Exact-shape check, independent of the test's cwd: every key must be one
      // the allowlist admits. This catches both spawn-env inheritance AND the
      // child re-importing a `.env` from its own cwd at startup (Bun auto-loads
      // it unless spawned with --env-file=/dev/null) — the path that leaked the
      // repo-root provider keys when the suite ran from the repo root.
      const admitted = new Set([
        ...SANDBOX_FORWARDED_ENV,
        "WRATHBENCH_MODULE_URL",
        "WRATHBENCH_TOKEN",
        "WRATHBENCH_SECRET",
        "WRATHBENCH_ACCOUNT",
      ]);
      expect(keys.filter((k) => !admitted.has(k))).toEqual([]);
      expect(keys).not.toContain("WB_CANARY_SECRET");
      expect(keys).not.toContain("OPENROUTER_KEY");
      expect(keys).not.toContain("OPENCODE_KEY");
      expect(keys).not.toContain("CLAUDE_CODE_OAUTH_TOKEN");
      for (const k of Object.keys(prefixed)) expect(keys).not.toContain(k);
      // The leased secret and the bound account reach the child's spawn env but
      // entry.ts strikes them before any snippet runs, so even the credential
      // the child legitimately uses is not readable from its own environment
      // (#74; operator, 2026-10-19).
      expect(keys).not.toContain("WRATHBENCH_SECRET");
      expect(keys).not.toContain("WRATHBENCH_ACCOUNT");
    } finally {
      delete process.env["WB_CANARY_SECRET"];
      delete process.env["OPENROUTER_KEY"];
      for (const k of Object.keys(prefixed)) delete process.env[k];
    }
  });

  test("sandboxChildEnv forwards the named variables and nothing else under the prefix", () => {
    const parent = {
      PATH: "/usr/bin",
      HOME: "/home/bun",
      TMPDIR: "/tmp",
      WRATHBENCH_FAULT_WINDOW_MS: "1000",
      WRATHBENCH_FAULT_ROLLUP_MS: "2000",
      WRATHBENCH_FAULT_ESCALATION_THRESHOLD: "3",
      WRATHBENCH_FAULT_IMMEDIATE_CAP: "4",
      // A knob-shaped name that entry.ts does not read is not forwarded either.
      WRATHBENCH_FAULT_SOMETHING_NEW: "5",
      WRATHBENCH_SOMETHING_SECRET: "fake-something-secret",
      WRATHBENCH_R2_SECRET_ACCESS_KEY: "fake-r2-secret",
      WRATHBENCH_ACCOUNT_PASSWORD: "fake-account-password",
      WRATHBENCH_CF_DEPLOY_TOKEN: "fake-cf-token",
      WRATHBENCH_MODULE_SECRET: "fake-port-secret",
      WRATHBENCH_DB_PASSWORD: "fake-db-password",
      // Stray copies of the explicit four, from an operator's shell.
      WRATHBENCH_ACCOUNT: "STRAY",
      WRATHBENCH_SECRET: "stray-secret",
      WRATHBENCH_TOKEN: "stray-token",
      WRATHBENCH_MODULE_URL: "http://stray:1",
      OPENROUTER_KEY: "fake-openrouter-key",
    };
    const env = sandboxChildEnv(parent, {
      WRATHBENCH_MODULE_URL: "http://worldserver:8086",
      WRATHBENCH_TOKEN: "t",
      WRATHBENCH_SECRET: "leased",
      WRATHBENCH_ACCOUNT: "RUNNER",
    });
    expect(env).toEqual({
      PATH: "/usr/bin",
      HOME: "/home/bun",
      TMPDIR: "/tmp",
      WRATHBENCH_FAULT_WINDOW_MS: "1000",
      WRATHBENCH_FAULT_ROLLUP_MS: "2000",
      WRATHBENCH_FAULT_ESCALATION_THRESHOLD: "3",
      WRATHBENCH_FAULT_IMMEDIATE_CAP: "4",
      WRATHBENCH_MODULE_URL: "http://worldserver:8086",
      WRATHBENCH_TOKEN: "t",
      WRATHBENCH_SECRET: "leased",
      WRATHBENCH_ACCOUNT: "RUNNER",
    });
  });

  test("the named list is what the child actually reads", () => {
    // Every env read in the child — the stack's runtime, the runner's entry
    // and its extension — is a name the host forwards or sets, so a knob added
    // to any of them without a line here fails rather than silently reading
    // its default in production.
    const files = [
      Bun.resolveSync("@wrathbench/mcp/sandbox-child", import.meta.dir),
      join(import.meta.dir, "..", "src", "sandbox", "entry.ts"),
      join(import.meta.dir, "..", "src", "sandbox", "child-extension.ts"),
    ];
    const read = files.flatMap((f) => [...readFileSync(f, "utf8").matchAll(/process\.env\["([A-Z0-9_]+)"\]/g)].map((m) => m[1]!));
    const provided = new Set([...SANDBOX_FORWARDED_ENV, "WRATHBENCH_MODULE_URL", "WRATHBENCH_TOKEN", "WRATHBENCH_SECRET", "WRATHBENCH_ACCOUNT"]);
    expect(read.length).toBeGreaterThan(0);
    expect(read.filter((k) => !provided.has(k))).toEqual([]);
  });

  test("a snippet can read the generated API.md at the ambient path", async () => {
    const host = makeHost();
    // The path is ambient and absolute.
    const path = await host.evalSnippet("API_MD_PATH");
    expect(path.ok).toBe(true);
    expect(path.value).toContain("sdk/API.md");
    // A snippet reads a real row out of it, in a slice (the file is larger than
    // one snippet result), proving the doc is present and readable — not merely
    // that a read succeeded.
    const row = await host.evalSnippet(
      '(await Bun.file(API_MD_PATH).text()).split("\\n").filter((l) => l.includes("gossipSelect")).join("\\n")',
    );
    expect(row.ok).toBe(true);
    expect(row.value).toContain("gossipSelect");
    expect(row.value).toContain("visible text");
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

describe("cooperative abort on timeout", () => {
  /**
   * A stand-in module: acks `move_to` with a moveId and never sends the
   * verdict, so a `moveTo` hangs until something settles it; records every
   * action so the test can count the `stop`.
   */
  function startModuleStub(): { url: string; actions: string[]; stop(): Promise<void> } {
    const actions: string[] = [];
    let moveId = 0;
    const server = Bun.serve<{ token: string }, never>({
      port: 0,
      fetch(req, srv) {
        const url = new URL(req.url);
        if (url.pathname === "/events") {
          return srv.upgrade(req, { data: { token: "" } }) ? undefined : new Response("no", { status: 400 });
        }
        if (url.pathname === "/session" && req.method === "POST") {
          return Response.json({ ok: true, account: "RUNNER", character: "Fenwick", guid: 7, inWorld: true });
        }
        if (url.pathname === "/action") {
          return req.json().then((body) => {
            const action = String((body as { action?: string }).action);
            actions.push(action);
            return Response.json(
              action === "move_to" ? { ok: true, action, moveId: ++moveId } : { ok: true, action },
            );
          });
        }
        return new Response("not found", { status: 404 });
      },
      websocket: { message() {} },
    });
    return {
      url: `http://127.0.0.1:${server.port}`,
      actions,
      stop: () => server.stop(true),
    };
  }

  /**
   * The SDK's abort-path stop() is deliberately fire-and-forget (the signal
   * holder has already moved on — sdk/src/client.ts), so under load the stub
   * can record it a beat after the timed-out eval returns. Wait for it,
   * bounded; the assertions after still pin the exact action sequence.
   */
  async function eventually(cond: () => boolean, ms = 1_000): Promise<void> {
    const deadline = Date.now() + ms;
    while (!cond() && Date.now() < deadline) await Bun.sleep(10);
  }

  test("signal is ambient, per-eval, and unfired while the snippet runs", async () => {
    const host = makeHost();
    const res = await host.evalSnippet("[signal instanceof AbortSignal, signal.aborted]");
    expect(res.value).toBe("[ true, false ]");
    // A snippet's own `const signal` copy-back must not throw (defineProperty setter).
    const own = await host.evalSnippet("const signal = 1; signal");
    expect(own.ok).toBe(true);
  });

  test("timeout aborts the signal, stops one in-flight move, drops the late result, keeps the runtime", async () => {
    const stub = startModuleStub();
    const host = makeHost({ moduleUrl: stub.url, snippetTimeoutMs: 400 });
    await host.evalSnippet("await connect(); await sdk.createSession({ character: 'Fenwick' });");
    const timed = await host.evalSnippet(
      "globalThis.fired = false; signal.addEventListener('abort', () => { globalThis.fired = true; });" +
        " globalThis.walk = sdk.moveTo({ x: 1, y: 2, z: 3 });" +
        " await walk; globalThis.reached = 'after the wall';",
    );
    expect(timed.timedOut).toBe(true);
    const after = await host.evalSnippet("[fired, await walk.catch((e) => e.name), globalThis.reached]");
    expect(after.value).toBe('[ true, "EventAbortedError", undefined ]');
    // Exactly one stop followed the move_to; a later snippet's work is unaffected.
    await eventually(() => stub.actions.includes("stop"));
    expect(stub.actions).toEqual(["move_to", "stop"]);
    expect(host.totalRestarts).toBe(0);
    await host.stop();
    await stub.stop();
  });

  test("the abandonment message states the abort and the stop; the late result never reaches the model", async () => {
    const stub = startModuleStub();
    const host = makeHost({ moduleUrl: stub.url, snippetTimeoutMs: 400 });
    await host.evalSnippet("await connect(); await sdk.createSession({ character: 'Fenwick' });");
    const res = await host.evalSnippet("await sdk.moveTo({ x: 1, y: 2, z: 3 }); 'walked'");
    expect(res.ok).toBe(false);
    expect(res.timedOut).toBe(true);
    expect(res.error).toContain("`signal` was aborted");
    expect(res.error).toContain("move in flight was stopped");
    expect(res.error).toContain("EventAbortedError");
    // The aborted eval settled (rejected) before the ping; its result was
    // discarded and the next eval gets a clean answer, not "walked".
    const next = await host.evalSnippet("'next'");
    expect(next.ok).toBe(true);
    expect(next.value).toBe(JSON.stringify("next"));
    await eventually(() => stub.actions.includes("stop"));
    expect(stub.actions.filter((a) => a === "stop")).toHaveLength(1);
    await host.stop();
    await stub.stop();
  });

  test("the abandon message states the interrupted move and names moveToAsync (2026-08-23 fan-out)", async () => {
    // 6 of 7 runs in the navigation fan-out hit this wall with a moveTo in
    // flight; one re-issued the identical blocking call five times. The message
    // now carries what the SDK knew as it unwound, and the call that survives.
    const stub = startModuleStub();
    const host = makeHost({ moduleUrl: stub.url, snippetTimeoutMs: 400 });
    await host.evalSnippet("await connect(); await sdk.createSession({ character: 'Fenwick' });");
    const res = await host.evalSnippet("await sdk.moveTo({ x: 1, y: 2, z: 3 }); 'walked'");
    expect(res.timedOut).toBe(true);
    expect(res.error).toContain("a moveTo was still walking when this was abandoned");
    // This stub never reports a position, so the distances degrade to saying so
    // rather than to a made-up number.
    expect(res.error).toContain("(1.0, 2.0)");
    expect(res.error).toContain("sdk.moveToAsync(target)");
    // The note is drained: a later, move-free abandon does not repeat it.
    const again = await host.evalSnippet("await new Promise(() => {});");
    expect(again.timedOut).toBe(true);
    expect(again.error).not.toContain("still walking when this was abandoned");
    await host.stop();
    await stub.stop();
  });

  test("the abandon message names reclaimCorpse and what it was waiting on (2026-10-20 party runs)", async () => {
    // sleep(15000) and then a reclaim with its 25s default wait ran members
    // past the snippet limit, and the message said only that it timed out.
    const stub = startModuleStub();
    const host = makeHost({ moduleUrl: stub.url, snippetTimeoutMs: 400 });
    await host.evalSnippet("await connect(); await sdk.createSession({ character: 'Fenwick' });");
    const ghost =
      `events.ingest(JSON.stringify({ seq: 1, opcode: "SMSG_UPDATE_OBJECT", opcodeId: 0x0a9, ts: Date.now(),` +
      ` data: { blocks: 1, objects: [{ update: "values", guid: "7", fields: { health: 1, playerFlags: 16 } }] } }));` +
      ` events.ingest(JSON.stringify({ seq: 2, opcode: "SMSG_CORPSE_RECLAIM_DELAY", opcodeId: 0x269, ts: Date.now(),` +
      ` data: { delayMs: 20000 } })); 'ghost'`;
    expect((await host.evalSnippet(ghost)).ok).toBe(true);
    const res = await host.evalSnippet("await sdk.reclaimCorpse(); 'reclaimed'");
    expect(res.timedOut).toBe(true);
    expect(res.error).toContain("reclaimCorpse was waiting out the server's reclaim delay (~");
    expect(res.error).toContain("Give it a snippet of its own, or pass a timeout that fits the time the snippet has left, as the second argument: sdk.reclaimCorpse(undefined, { timeout: 20000 }).");
    await host.stop();
    await stub.stop();
  });

  test("the HUD snapshot carries our own auras by name, and the summary lists them", async () => {
    const stub = startModuleStub();
    const host = makeHost({ moduleUrl: stub.url });
    await host.evalSnippet("await connect(); await sdk.createSession({ character: 'Fenwick' });");
    const auras =
      `events.ingest(JSON.stringify({ seq: 1, opcode: "SMSG_INITIAL_SPELLS", opcodeId: 0x12a, ts: Date.now(),` +
      ` data: { spells: [{ spellId: 501, rank: 1, name: "Mending Word" }], cooldowns: [] } }));` +
      ` events.ingest(JSON.stringify({ seq: 2, opcode: "SMSG_AURA_UPDATE_ALL", opcodeId: 0x495, ts: Date.now(),` +
      ` data: { targetGuid: "7", auras: [{ slot: 0, spellId: 9002, flags: 160, level: 20, stacks: 1, maxDuration: 600000, duration: 600000, name: "Spirit Weariness" },` +
      ` { slot: 1, spellId: 501, flags: 24, level: 20, stacks: 1 }] } })); 'ok'`;
    expect((await host.evalSnippet(auras)).ok).toBe(true);
    const snap = (await host.stateSnapshot()) as SnapshotLike;
    expect(snap.selfAuras?.map((a) => a.name)).toEqual(["Spirit Weariness", "Mending Word"]);
    const summary = formatStateSummary(snap, { sessionLive: true });
    expect(summary).toMatch(/\nauras: Spirit Weariness \(debuff, (9m 5\ds|10m 00s) left\), Mending Word \[state\.aurasOf\(state\.self\.guid\)\]\n/);
    await host.stop();
    await stub.stop();
  });

  test("the HUD snapshot carries the party frames, and a member's health in view but never a mob's", async () => {
    const stub = startModuleStub();
    const host = makeHost({ moduleUrl: stub.url });
    await host.evalSnippet("await connect(); await sdk.createSession({ character: 'Fenwick' });");
    const party =
      `events.ingest(JSON.stringify({ seq: 1, opcode: "SMSG_GROUP_LIST", opcodeId: 0x07d, ts: Date.now(), data: { groupType: 0, left: false,` +
      ` raid: false, subGroup: 0, memberFlags: 0, roles: 0, groupGuid: "1", counter: 1, leaderGuid: "940", lootMethod: 0,` +
      ` members: [{ name: "Brannoc", guid: "940", online: true, subGroup: 0, flags: 0, roles: 0 },` +
      ` { name: "Ysolde", guid: "941", online: true, subGroup: 0, flags: 0, roles: 0 }] } }));` +
      ` events.ingest(JSON.stringify({ seq: 2, opcode: "SMSG_UPDATE_OBJECT", opcodeId: 0x0a9, ts: Date.now(), data: { blocks: 2, objects: [` +
      ` { update: "create", guid: "941", objectType: "player", pos: { x: 3, y: 4, z: 0, o: 0 }, fields: { health: 261, maxHealth: 300, level: 20, playerFlags: 0 } },` +
      ` { update: "create", guid: "17379391", objectType: "unit", entry: 657, pos: { x: 6, y: 8, z: 0, o: 0 }, fields: { health: 900, maxHealth: 1000, level: 18 } }] } }));` +
      ` events.ingest(JSON.stringify({ seq: 3, opcode: "SMSG_PARTY_MEMBER_STATS", opcodeId: 0x07e, ts: Date.now(), data: { guid: "940", full: false,` +
      ` mask: 0x1ff, status: 9, health: 1, maxHealth: 515, powerType: 1, power: 0, maxPower: 100, level: 20, zoneId: 40, zoneName: "Westfall", x: -10546, y: 1197 } })); 'ok'`;
    expect((await host.evalSnippet(party)).ok).toBe(true);
    const snap = (await host.stateSnapshot()) as SnapshotLike;
    const members = snap.group?.members ?? [];
    expect(members.find((m) => m.guid === "940")?.stats).toMatchObject({ ghost: true, zone: { id: 40, name: "Westfall" }, position: { x: -10546, y: 1197 } });
    expect(members.find((m) => m.guid === "941")?.inView).toBe(true);
    const units = snap.units ?? [];
    expect(units.find((u) => u.guid === "941")).toMatchObject({ health: 261, maxHealth: 300, ghost: false });
    const mob = units.find((u) => u.guid === "17379391");
    expect(mob).toBeDefined();
    expect(mob!.health).toBeUndefined();
    expect(mob!.maxHealth).toBeUndefined();
    const summary = formatStateSummary(snap, { sessionLive: true });
    expect(summary).toMatch(/\nparty: Brannoc ghost, Westfall \(-10546, 1197\), out of view; Ysolde alive 87%( \d+y)?\n/);
    await host.stop();
    await stub.stop();
  });

  test("a routine launched by a snippet that returned normally is never aborted by a later timeout", async () => {
    // The routine must outlive the second snippet's timeout (sleep > timeout)
    // to prove it was not aborted, and resolve inside the third snippet's
    // budget: two timeouts minus the sleep is the margin, so 400+400-600 keeps
    // 200ms of slack where 300+300-600 had none and failed under load.
    const host = makeHost({ snippetTimeoutMs: 400 });
    // The trailing value matters: a lone expression is awaited REPL-style,
    // which would make the *launching* snippet wait on the trip and time out.
    await host.evalSnippet("globalThis.trip = (async () => { await sleep(600); return 'done'; })().catch((e) => 'aborted:' + e.message); 'started'");
    const timed = await host.evalSnippet("await sleep(5_000);");
    expect(timed.timedOut).toBe(true);
    const trip = await host.evalSnippet("await trip");
    expect(trip.value).toBe(JSON.stringify("done"));
  });

  test("sleep() in an abandoned snippet rejects with the abort reason", async () => {
    const host = makeHost({ snippetTimeoutMs: 300 });
    const timed = await host.evalSnippet(
      "globalThis.outcome = 'pending'; try { await sleep(5_000); globalThis.outcome = 'slept'; } catch (e) { globalThis.outcome = 'rejected: ' + e.message; }",
    );
    expect(timed.timedOut).toBe(true);
    const outcome = await host.evalSnippet("outcome");
    expect(outcome.value).toContain("rejected: snippet abandoned by the harness");
  });

  test("an abandoned snippet's unawaited calls are cancelled quietly, not reported as a sandbox fault", async () => {
    // deadmines@4 tank 06:55:07: a snippet left a sleep running unawaited and
    // timed out; the sleep's rejection with the abandonment's own reason read
    // as "sandbox reported fatal error: unhandled promise rejection".
    // The sleeps reject with the reason itself and as a sleep that could never
    // fit (its `cause`); the SDK wait as an EventAbortedError carrying it.
    const stub = startModuleStub();
    const host = makeHost({ moduleUrl: stub.url, snippetTimeoutMs: 400 });
    await host.evalSnippet("await connect(); await sdk.createSession({ character: 'Fenwick' });");
    const timed = await host.evalSnippet(
      "sleep(5_000); sleep(20_000); sdk.waitForChat('never said', { timeout: 10_000 }).then(() => 'heard');\n" +
        "await new Promise(() => {});",
    );
    expect(timed.timedOut).toBe(true);
    const next = await host.evalSnippet("await sleep(100); return 'next';");
    expect(next.value).toBe(JSON.stringify("next"));
    expect(next.logs).toEqual([]);
    expect(host.drainNotices().filter((n) => n.kind === "session_note")).toEqual([]);
    await host.stop();
    await stub.stop();
  });

  test("a wait cancelled by the snippet's own AbortController is still the snippet's fault to hear about", async () => {
    const host = makeHost();
    await host.evalSnippet(
      "const c = new AbortController(); sdk.events.waitFor(() => false, { timeout: 10_000, signal: c.signal });\n" +
        "c.abort(new Error('mine')); await sleep(100);",
    );
    const notes = host.drainNotices().filter((n) => n.kind === "session_note");
    expect(notes).toHaveLength(1);
    expect(notes[0]!.text).toContain("unhandled promise rejection");
    expect(notes[0]!.text).toContain("mine");
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
    // The session outlives the process, and a resubscribe replays what a
    // client holds (module/PROTOCOL.md, "/events"); the guidance says so, and
    // no longer sends the model to createSession first.
    expect(res.error).toContain("await connect()");
    expect(res.error).toContain("replays your own state");
    expect(res.error).not.toContain("token_in_use");
  }, 15_000);
});

describe("a thrown value that is not an Error", () => {
  // The eval's catch read the abandon notes off whatever was thrown, and that
  // read threw on `undefined` and `null`: no result was sent, and the host
  // reported a timeout at the snippet ceiling for a snippet that had failed at
  // once. Each case renders as the value itself, the form a thrown string or
  // number always had, and the runtime keeps the bindings made before it.
  const cases: [snippet: string, rendered: string][] = [
    ["throw undefined;", "undefined"],
    ["throw null;", "null"],
    ['throw "boom";', '"boom"'],
    ["throw 42;", "42"],
    ["await Promise.reject(undefined);", "undefined"],
  ];
  for (const [snippet, rendered] of cases) {
    test(`\`${snippet}\` comes back at once as an error reading ${rendered}`, async () => {
      const host = makeHost();
      await host.evalSnippet("let before = 'kept';");
      const res = await host.evalSnippet(snippet);
      expect(res.ok).toBe(false);
      expect(res.timedOut).toBeUndefined();
      expect(res.error).toBe(rendered);
      expect(res.durationMs).toBeLessThan(1_000);
      const after = await host.evalSnippet("before");
      expect(after.ok).toBe(true);
      expect(after.value).toBe(JSON.stringify("kept"));
      // A fault in the handler surfaces as an unhandled rejection after the
      // result; the next result is ordered after it, so by now it would show.
      expect(after.logs).toEqual([]);
      expect(host.drainNotices()).toEqual([]);
      expect(host.totalRestarts).toBe(0);
    });
  }

  for (const reason of ["undefined", "null"]) {
    test(`an abandoned snippet whose wait rejects with ${reason} reads as the timeout and nothing else`, async () => {
      const host = makeHost({ snippetTimeoutMs: 300 });
      await host.evalSnippet("let before = 'kept';");
      const res = await host.evalSnippet(
        `await new Promise((_, reject) => signal.addEventListener("abort", () => reject(${reason})));`,
      );
      expect(res.ok).toBe(false);
      expect(res.timedOut).toBe(true);
      expect(res.error).toContain("was abandoned");
      expect(res.logs).toEqual([]);
      const after = await host.evalSnippet("before");
      expect(after.value).toBe(JSON.stringify("kept"));
      expect(after.logs).toEqual([]);
      expect(host.drainNotices()).toEqual([]);
      expect(host.totalRestarts).toBe(0);
    });
  }
});

describe("background fault storm control (morning-laguna-2)", () => {
  const setEnv = (vars: Record<string, string>): (() => void) => {
    const prev = new Map<string, string | undefined>();
    for (const [k, v] of Object.entries(vars)) {
      prev.set(k, process.env[k]);
      process.env[k] = v;
    }
    return () => {
      for (const [k, v] of prev) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    };
  };

  test("rapid-fire identical faults produce bounded notices: first report + one escalation", async () => {
    const restore = setEnv({
      WRATHBENCH_FAULT_ESCALATION_THRESHOLD: "10",
      WRATHBENCH_FAULT_ROLLUP_MS: "60000",
    });
    try {
      const host = makeHost();
      const res = await host.evalSnippet(
        "for (let i = 0; i < 40; i++) Promise.reject(new Error('storm')); await sleep(300);",
      );
      expect(res.ok).toBe(true);
      const notes = host.drainNotices().filter((n) => n.kind === "session_note");
      expect(notes.length).toBe(2); // not 40
      expect(notes[0]!.text).toContain("unhandled promise rejection");
      expect(notes[0]!.text).toContain("storm");
      expect(notes[1]!.text).toContain("background routine broken");
      expect(notes[1]!.text).toContain("clearInterval");
      // ...and the log buffer collapsed the repeats rather than holding 40 lines
      const stormLines = res.logs.filter((l) => l.text.includes("storm"));
      expect(stormLines.length).toBe(1);
      expect(stormLines[0]!.text).toMatch(/×40$/);
    } finally {
      restore();
    }
  });

  test("distinct fault signatures each get their first report", async () => {
    const host = makeHost();
    await host.evalSnippet(
      "const a = new Error('alpha'); a.name = 'AlphaFault';\n" +
        "const b = new Error('beta'); b.name = 'BetaFault';\n" +
        "Promise.reject(a); Promise.reject(b);\n" +
        "await sleep(200);",
    );
    const notes = host.drainNotices().filter((n) => n.kind === "session_note");
    expect(notes.some((n) => n.text.includes("AlphaFault"))).toBe(true);
    expect(notes.some((n) => n.text.includes("BetaFault"))).toBe(true);
  });

  test("continuing repeats aggregate into a single ×N rollup notice", async () => {
    const restore = setEnv({
      WRATHBENCH_FAULT_ROLLUP_MS: "150",
      WRATHBENCH_FAULT_ESCALATION_THRESHOLD: "1000",
    });
    try {
      const host = makeHost();
      // One shared thrower: the signature is name + first stack line, so both
      // batches must fault from the same source line to count as one storm.
      await host.evalSnippet(
        "const drip = () => Promise.reject(new Error('drip'));\n" +
          "for (let i = 0; i < 5; i++) drip();\n" +
          "await sleep(300);\n" +
          "for (let i = 0; i < 5; i++) drip();\n" +
          "await sleep(200);",
      );
      const notes = host.drainNotices().filter((n) => n.kind === "session_note");
      expect(notes.length).toBe(2); // first report + exactly one rollup
      expect(notes[1]!.text).toContain("aggregated");
      expect(notes[1]!.text).toMatch(/×\d+/);
      expect(notes[1]!.text).toContain("unhandled promise rejection");
    } finally {
      restore();
    }
  });

  test("varying fault signatures cannot bypass storm control (global immediate cap)", async () => {
    const restore = setEnv({
      WRATHBENCH_FAULT_IMMEDIATE_CAP: "3",
      WRATHBENCH_FAULT_ROLLUP_MS: "80", // let overflow flush as periodic rollups
      WRATHBENCH_FAULT_ESCALATION_THRESHOLD: "1000",
    });
    try {
      const host = makeHost();
      // Each rejection carries a per-iteration string: a brand-new signature
      // every time, so every one used to take the immediate-report path. Spread
      // over time (a rollup only flushes when a later fault arrives past the
      // interval), which is the realistic broken-routine shape.
      const res = await host.evalSnippet(
        "let i = 0; const t = setInterval(() => Promise.reject(`tick ${i++}`), 25); " +
          "await sleep(500); clearInterval(t);",
      );
      expect(res.ok).toBe(true);
      const notes = host.drainNotices().filter((n) => n.kind === "session_note");
      // Bounded far below the ~20 unique signatures: the immediate cap (3) of
      // first-reports plus a handful of periodic rollups, never one notice per
      // unique signature.
      expect(notes.length).toBeLessThanOrEqual(9);
      // The overflow aggregated rather than each reporting immediately.
      expect(notes.some((n) => n.text.includes("aggregated"))).toBe(true);
    } finally {
      restore();
    }
  });

  test("repeated identical console lines collapse to one ×N entry", async () => {
    const host = makeHost();
    const res = await host.evalSnippet(
      'for (let i = 0; i < 25; i++) console.log("same line");\nconsole.log("different");',
    );
    expect(res.ok).toBe(true);
    expect(res.logs.length).toBe(2);
    expect(res.logs[0]!.text).toBe("same line ×25");
    expect(res.logs[1]!.text).toBe("different");
  });

  test("the child's mirrored stdout prints a repeated line once and its count, not every copy", async () => {
    const logged = { stdout: "", stderr: "" };
    const host = makeHost({ logSink: (stream, text) => void (logged[stream] += text) });
    const res = await host.evalSnippet(
      [
        'for (let i = 0; i < 1000; i++) console.log("Target 0x1 is not a valid hostile or is dead.");',
        'console.log("different");',
        'for (let i = 0; i < 3; i++) console.error("stuck");',
      ].join("\n"),
    );
    expect(res.ok).toBe(true);
    // The result's own log is the fold it always was.
    expect(res.logs.map((l) => l.text)).toEqual(["Target 0x1 is not a valid hostile or is dead. ×1000", "different", "stuck ×3"]);
    // The pumps flush when the child's streams end.
    await host.stop();
    expect(logged.stdout).toBe(
      "Target 0x1 is not a valid hostile or is dead.\n[sandbox] the line above repeated ×999 more\ndifferent\n",
    );
    // A run still repeating when the snippet's logs are drained is counted then.
    expect(logged.stderr).toBe("stuck\n[sandbox] the line above repeated ×2 more\n");
  });
});

/**
 * The snippet side of the scratchpad cap (operator, 2026-10-14): a refused
 * write rejects. Awaited, the rejection is the snippet's error like any other;
 * not awaited — the shape that lost a run eighty turns of notes — the
 * snippet's own result still reports it, beside its value. Only a write the
 * snippet attached to is its own business.
 */
describe("scratchpad writes over the cap, from a snippet", () => {
  const MAX = SCRATCHPAD_MAX_CHARS;
  const refusal = (op: string, chars: number): string =>
    `Error: ${op} refused: the scratchpad would be ${chars} chars, over its ${MAX}-char cap. ` +
    "Nothing was saved. Condense the scratchpad, then try again.";

  function fullHost(): { host: SandboxHost; pad: Scratchpad } {
    const pad = new Scratchpad(join(tempDir("wrathbench-sbx-pad-"), "scratchpad.md"));
    pad.write("p".repeat(MAX - 3));
    return { host: makeHost({ scratchpad: pad }), pad };
  }

  test("an awaited append rejects, and the snippet fails with the refusal", async () => {
    const { host, pad } = fullHost();
    const res = await host.evalSnippet('await scratchpad.append("too long"); "after"');
    expect(res.ok).toBe(false);
    expect(res.error).toBe(refusal("scratchpad.append", MAX + 6));
    expect(pad.read()).toBe("p".repeat(MAX - 3));
  });

  test("an unawaited append is the snippet's error, and its value still comes back", async () => {
    const { host, pad } = fullHost();
    const res = await host.evalSnippet('scratchpad.append("note the model never awaited"); return 41 + 1');
    expect(res.ok).toBe(false);
    expect(res.value).toBe("42");
    expect(res.error).toBe(refusal("scratchpad.append", MAX + 26));
    expect(pad.read()).toBe("p".repeat(MAX - 3));
    // Reported once: not again as a background fault.
    await new Promise((r) => setTimeout(r, 100));
    expect(host.drainNotices().some((n) => n.text.includes("refused"))).toBe(false);
    expect((await host.evalSnippet("1")).logs).toEqual([]);
  });

  test("an unawaited write in a statement snippet that returns nothing is still reported", async () => {
    const { host } = fullHost();
    const res = await host.evalSnippet(`scratchpad.write("w".repeat(${MAX + 1}));\nconst kept = 1;`);
    expect(res.ok).toBe(false);
    expect(res.error).toBe(refusal("scratchpad.write", MAX + 1));
  });

  test("a refusal the snippet caught is its own business", async () => {
    const { host } = fullHost();
    const res = await host.evalSnippet('await scratchpad.append("too long").catch((e) => "caught: " + e.message.slice(0, 25))');
    expect(res.ok).toBe(true);
    expect(res.value).toBe(JSON.stringify("caught: scratchpad.append refused"));
    const chained = await host.evalSnippet('scratchpad.append("too long").catch(() => {}); "fine"');
    expect(chained.ok).toBe(true);
  });

  test("an abandoned snippet's unawaited refusal rides the abandon's report", async () => {
    // Its result is discarded, so the refusal goes the background way: the
    // pong's logs, which the timeout result carries.
    const { host } = fullHost();
    const res = await host.evalSnippet('scratchpad.append("too long"); await new Promise(() => {});');
    expect(res.timedOut).toBe(true);
    expect(res.logs.some((l) => l.level === "error" && l.text.includes("scratchpad.append refused"))).toBe(true);
  }, 15_000);

  test("a background routine's refused write is reported as a background fault", async () => {
    const { host } = fullHost();
    const res = await host.evalSnippet(
      'setTimeout(() => { scratchpad.append("from a routine, long after"); }, 50); "started"',
    );
    expect(res.ok).toBe(true);
    await new Promise((r) => setTimeout(r, 400));
    const notes = host.drainNotices();
    expect(notes.some((n) => n.kind === "session_note" && n.text.includes("scratchpad.append refused"))).toBe(true);
    const next = await host.evalSnippet("1");
    expect(next.ok).toBe(true);
    expect(next.logs.some((l) => l.level === "error" && l.text.includes("scratchpad.append refused"))).toBe(true);
  }, 15_000);
});
