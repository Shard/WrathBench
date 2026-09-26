/**
 * The entrypoint loop's snippets, in the real Landlock-confined child: a
 * snippet is a one-off. Its declarations are its own, and what it starts —
 * timers, event listeners, a routine it launched without awaiting — ends when
 * it returns, with its signal aborted and no fault reported for the stop. The
 * snippet loop's sandbox (`sandbox-workspace.test.ts`) keeps its REPL. No game
 * stack: events are fed through the stream's own `ingest`.
 *
 * Tests read and write `globalThis` directly to observe the child from
 * outside a snippet's scope; that is test plumbing, never model-facing text.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SandboxHost } from "../src/sandbox/host";
import { Workspace } from "../src/workspace";

const hosts: SandboxHost[] = [];

function makeHost(loop: "snippet" | "entrypoint" = "entrypoint"): { host: SandboxHost; ws: Workspace } {
  const ws = new Workspace(join(mkdtempSync(join(tmpdir(), "wrathbench-sbxep-")), "workspace"), {
    memory: loop === "entrypoint",
  });
  const host = new SandboxHost({
    moduleUrl: "http://worldserver:8086",
    token: "test-token",
    workspace: ws,
    snippetTimeoutMs: 5_000,
    pingGraceMs: 1_000,
    loop,
  });
  hosts.push(host);
  return { host, ws };
}

afterEach(async () => {
  await Promise.all(hosts.splice(0, hosts.length).map((h) => h.stop()));
});

/** A frame the stream's `ingest` takes, for an event no module sent. */
function frame(seq: number, opcode = "SMSG_PROBE"): string {
  return JSON.stringify(JSON.stringify({ seq, opcode, opcodeId: 1, ts: 1_000 + seq, data: {} }));
}

describe("entrypoint snippets are one-offs", () => {
  test("a declaration is the snippet's own and is gone when it returns", async () => {
    const { host } = makeHost();
    expect((await host.evalSnippet("const x = 41;\nreturn x + 1;")).value).toBe("42");
    expect((await host.evalSnippet("typeof x")).value).toBe('"undefined"');
    // The snippet loop keeps its REPL: the same two snippets see the binding.
    const repl = makeHost("snippet").host;
    await repl.evalSnippet("const x = 41;");
    expect((await repl.evalSnippet("x + 1")).value).toBe("42");
  });

  test("a timer the snippet started stops when it returns", async () => {
    const { host } = makeHost();
    const first = await host.evalSnippet(
      "globalThis.hits = 0;\nsetInterval(() => { globalThis.hits++; }, 5);\nawait sleep(60, { wake: false });\nreturn globalThis.hits > 0;",
    );
    expect(first.value).toBe("true");
    const a = (await host.evalSnippet("globalThis.hits")).value;
    await Bun.sleep(80);
    const b = (await host.evalSnippet("globalThis.hits")).value;
    expect(b).toBe(a);
  });

  test("an event listener the snippet registered is removed when it returns", async () => {
    const { host } = makeHost();
    const first = await host.evalSnippet(
      `globalThis.heard = 0;\nevents.on("SMSG_PROBE", () => { globalThis.heard++; });\nevents.ingest(${frame(1)});\nreturn globalThis.heard;`,
    );
    expect(first.value).toBe("1");
    expect((await host.evalSnippet(`events.ingest(${frame(2)});\nreturn globalThis.heard;`)).value).toBe("1");
  });

  test("off() by the handler the snippet passed still finds an owned registration", async () => {
    const { host } = makeHost();
    const res = await host.evalSnippet(
      [
        "let n = 0;",
        "const h = () => { n++; };",
        'events.on("SMSG_PROBE", h);',
        `events.ingest(${frame(1)});`,
        'const found = events.off("SMSG_PROBE", h);',
        `events.ingest(${frame(2)});`,
        "return [found, n];",
      ].join("\n"),
    );
    expect(res.value).toBe("[ true, 1 ]");
  });

  test("its signal is aborted at return, so a routine it launched stops, and the stop is not a fault", async () => {
    const { host } = makeHost();
    const launched = await host.evalSnippet(
      [
        "globalThis.sig = signal;",
        "globalThis.spins = 0;",
        "void (async () => { for (;;) { await sleep(5, { wake: false }); globalThis.spins++; } })();",
        "await sleep(40, { wake: false });",
      ].join("\n"),
    );
    expect(launched.ok).toBe(true);
    expect((await host.evalSnippet("globalThis.sig.aborted")).value).toBe("true");
    const a = (await host.evalSnippet("globalThis.spins")).value;
    await Bun.sleep(60);
    const after = await host.evalSnippet("globalThis.spins");
    expect(after.value).toBe(a);
    // The routine rejected on the abort that stopped it: nothing reports that.
    expect(after.logs).toEqual([]);
    expect(host.drainNotices()).toEqual([]);
  });

  test("a handler that throws is reported in the snippet's console, and the stream keeps dispatching", async () => {
    const { host } = makeHost();
    const res = await host.evalSnippet(
      [
        "let later = 0;",
        'events.on("SMSG_PROBE", () => { throw new TypeError("handler boom"); });',
        'events.on("SMSG_PROBE", () => { later++; });',
        `events.ingest(${frame(1)});`,
        "return later;",
      ].join("\n"),
    );
    expect(res.value).toBe("1");
    expect(res.logs.map((l) => l.text).join("\n")).toContain("handler boom");
  });

  test("a snippet past its time limit is told where long work belongs on this loop, and what it started is gone", async () => {
    const ws = new Workspace(join(mkdtempSync(join(tmpdir(), "wrathbench-sbxep-")), "workspace"), { memory: true });
    const host = new SandboxHost({
      moduleUrl: "http://worldserver:8086",
      token: "test-token",
      workspace: ws,
      snippetTimeoutMs: 200,
      pingGraceMs: 1_000,
      loop: "entrypoint",
    });
    hosts.push(host);
    const res = await host.evalSnippet(
      "globalThis.ticks = 0;\nsetInterval(() => { globalThis.ticks++; }, 5);\nawait new Promise(() => {});",
    );
    expect(res.timedOut).toBe(true);
    expect(res.error).toContain("snippet evaluation exceeded 200ms and was abandoned");
    expect(res.error).toContain("the timers and event listeners it started were removed");
    expect(res.error).toContain("belongs in your program: a tick of loop has 120s");
    expect(res.error).toContain("sdk.moveToAsync(target)");
    for (const phrase of ["background routine", "bindings", "globalThis"]) expect(res.error).not.toContain(phrase);
    const a = (await host.evalSnippet("globalThis.ticks")).value;
    await Bun.sleep(60);
    expect((await host.evalSnippet("globalThis.ticks")).value).toBe(a);
  });

  test("the workspace's absolute path is not in the environment a snippet reads, and its imports still resolve", async () => {
    const { host, ws } = makeHost();
    const read = 'return [process.env.WRATHBENCH_WORKSPACE, Bun.env.WRATHBENCH_WORKSPACE, "WRATHBENCH_WORKSPACE" in process.env];';
    expect((await host.evalSnippet(read)).value).toBe("[ undefined, undefined, false ]");
    const w = ws.write("lib/answer.ts", "export const answer = 42;\n");
    expect(w.ok).toBe(true);
    expect((await host.evalSnippet('import { answer } from "./lib/answer.ts";\nanswer')).value).toBe("42");
  });

  test("an import of memory.json is refused with what it is", async () => {
    const { host, ws } = makeHost();
    ws.writeMemory('{"phase":"grind"}');
    const res = await host.evalSnippet('import m from "./memory.json";\nm');
    expect(res.ok).toBe(false);
    expect(res.error).toContain("memory.json is your program's memory, not a module");
  });
});
