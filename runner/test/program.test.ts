/**
 * The entrypoint loop's program runtime (`sandbox/program.ts`), in the real
 * Landlock-confined child: main.ts deployed at an import version, ticks that
 * never overlap, budgets that abort, errors counted under signatures with the
 * workspace line they came from, a failed load that leaves the running deploy
 * alone, memory saved to memory.json by the host and read back by a new child,
 * and an edit that waits for the next deploy. No game stack: the module URL
 * refuses at once, and events are fed through the stream's own `ingest`.
 *
 * Limits are shortened through the host's `program` option, never through
 * `process.env`, and every wait is on a condition with a deadline.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SandboxHost, STATE_RESET_NOTICE_ENTRYPOINT } from "../src/sandbox/host";
import type { ProgramErrorNote, ProgramReport } from "../src/sandbox/ipc";
import { PROGRAM_EVENT_NAMES, nearEventNames, unknownEventWarnings } from "../src/sandbox/program";
import { Workspace } from "../src/workspace";

const hosts: SandboxHost[] = [];

const FAST = { tickMs: 20, tickBudgetMs: 400, eventBudgetMs: 200, deployConnectMs: 20 };

function makeHost(ws?: Workspace, heartbeat?: { pollMs?: number; blockGraceMs?: number }): { host: SandboxHost; ws: Workspace } {
  const workspace = ws ?? new Workspace(join(mkdtempSync(join(tmpdir(), "wrathbench-prog-")), "workspace"), { memory: true });
  const host = new SandboxHost({
    moduleUrl: "http://127.0.0.1:9",
    token: "test-token",
    workspace,
    snippetTimeoutMs: 5_000,
    pingGraceMs: 1_000,
    loop: "entrypoint",
    program: FAST,
    // Slow enough by default that no test here races the heartbeat's drain
    // against its own; the heartbeat tests below shorten it.
    heartbeat: heartbeat ?? { pollMs: 60_000, blockGraceMs: 10_000 },
  });
  hosts.push(host);
  return { host, ws: workspace };
}

afterEach(async () => {
  await Promise.all(hosts.splice(0, hosts.length).map((h) => h.stop()));
});

function write(ws: Workspace, path: string, content: string): void {
  const r = ws.write(path, content);
  if (!r.ok) throw new Error(r.error);
}

/** Poll until `probe` returns a value, or fail after `ms`. */
async function until<T>(probe: () => Promise<T | undefined> | T | undefined, ms = 5_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await probe();
    if (v !== undefined) return v;
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await Bun.sleep(15);
  }
}

/** Reports accumulated until `probe` finds what it wants in the running total. */
async function reportsUntil(host: SandboxHost, probe: (all: ProgramReport[]) => boolean, ms = 5_000): Promise<ProgramReport[]> {
  const all: ProgramReport[] = [];
  await until(async () => {
    all.push(await host.programReport());
    return probe(all) ? true : undefined;
  }, ms);
  return all;
}

const errorsOf = (all: ProgramReport[]): ProgramErrorNote[] => all.flatMap((r) => r.errors);

async function memoryValue(host: SandboxHost, expr: string): Promise<string | undefined> {
  return (await host.evalSnippet(expr)).value;
}

describe("deploy and ticks", () => {
  test("loop runs once per tick, ticks never overlap, and ctx carries tick and deploy", async () => {
    const { host, ws } = makeHost();
    write(
      ws,
      "main.ts",
      [
        "export async function loop(ctx) {",
        "  ctx.memory.active = (ctx.memory.active ?? 0) + 1;",
        "  if (ctx.memory.active > 1) ctx.memory.overlap = true;",
        "  ctx.memory.lastTick = ctx.tick;",
        "  ctx.memory.deploy = ctx.deploy;",
        "  await new Promise((r) => setTimeout(r, 35));",
        "  ctx.memory.active--;",
        "}",
      ].join("\n"),
    );
    const answer = await host.deployProgram(1);
    expect(answer).toEqual({ ok: true, deploy: 1, exports: ["loop"] });
    await until(async () => ((Number(await memoryValue(host, "memory.lastTick")) >= 5) ? true : undefined));
    expect(await memoryValue(host, "memory.overlap === undefined")).toBe("true");
    expect(await memoryValue(host, "memory.deploy")).toBe("1");
    const all = await reportsUntil(host, (rs) => rs.reduce((n, r) => n + r.ticks, 0) > 0);
    expect(all.at(-1)!.deploy).toBe(1);
    expect(Math.max(...all.map((r) => r.longestTickMs))).toBeGreaterThanOrEqual(30);
    // The host wrote what the program saved, and memory.json never moved the import version.
    const before = ws.importVersion;
    await until(() => (existsSync(join(ws.dir, "memory.json")) ? true : undefined));
    expect(JSON.parse(readFileSync(join(ws.dir, "memory.json"), "utf8")).deploy).toBe(1);
    expect(ws.importVersion).toBe(before);
  });

  test("a tick past its budget is aborted and reported once, and the abort's echo is not a second error", async () => {
    const { host, ws } = makeHost();
    write(ws, "main.ts", "export async function loop(ctx) {\n  await sleep(10_000);\n}\n");
    expect((await host.deployProgram(1)).ok).toBe(true);
    const all = await reportsUntil(host, (rs) => rs.some((r) => r.overruns > 0));
    const errors = errorsOf(all);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.signature).toBe("loop() overran its budget");
    expect(errors[0]!.isNew).toBe(true);
    expect(errors[0]!.text).toContain(`ran past its ${FAST.tickBudgetMs} ms budget: its signal was aborted`);
    expect(errors[0]!.text).toContain("sdk.moveToAsync(target)");
  });

  test("a report names the tick still running, and the report after it finished names none", async () => {
    const { host, ws } = makeHost();
    // The first tick waits for a snippet to release it; every later tick returns at once.
    write(
      ws,
      "main.ts",
      "export async function loop(ctx) {\n  if (ctx.tick === 1) while (!ctx.memory.release) await new Promise((r) => setTimeout(r, 10));\n}\n",
    );
    expect((await host.deployProgram(1)).ok).toBe(true);
    await Bun.sleep(60);
    const running = await host.programReport();
    expect(running.ticks).toBe(0);
    expect(running.tickInFlight?.tick).toBe(1);
    expect(running.tickInFlight!.runningMs).toBeGreaterThanOrEqual(40);
    const later = await host.programReport();
    expect(later.tickInFlight!.runningMs).toBeGreaterThanOrEqual(running.tickInFlight!.runningMs);
    await host.evalSnippet("memory.release = true");
    const all = await reportsUntil(host, (rs) => rs.reduce((n, r) => n + r.ticks, 0) >= 1);
    expect(all.at(-1)!.longestTickMs).toBeGreaterThanOrEqual(40);
    // Quick ticks are rarely caught mid-flight; when one is, it is a later tick than the first.
    const after = await host.programReport();
    expect(after.tickInFlight === undefined || after.tickInFlight.tick > 1).toBe(true);
  });

  test("an on handler runs as its event arrives, and ctx.wake is reported with the hook that asked", async () => {
    const { host, ws } = makeHost();
    write(
      ws,
      "main.ts",
      'export const on = {\n  SMSG_PROBE(e, ctx) {\n    ctx.memory.heard = e.seq;\n    ctx.wake("bags full");\n  },\n};\n',
    );
    // Not an event name the stream carries: it loads, is called for what arrives under that name, and the deploy says so.
    expect(await host.deployProgram(1)).toEqual({
      ok: true,
      deploy: 1,
      exports: ["on.SMSG_PROBE"],
      warnings: ["on.SMSG_PROBE is not an event name on the event stream, so it is never called"],
    });
    await host.evalSnippet('events.ingest(JSON.stringify({ seq: 4, opcode: "SMSG_PROBE", opcodeId: 1, ts: 5, data: {} }))');
    expect(await memoryValue(host, "memory.heard")).toBe("4");
    const all = await reportsUntil(host, (rs) => rs.some((r) => r.requests.length > 0));
    const req = all.flatMap((r) => r.requests)[0]!;
    expect([req.reason, req.from, req.count]).toEqual(["bags full", "on.SMSG_PROBE", 1]);
  });

  test("the program reads no workspace path from the environment, and its imports still resolve", async () => {
    const { host, ws } = makeHost();
    write(ws, "lib/answer.ts", "export const answer = 42;\n");
    write(
      ws,
      "main.ts",
      'import { answer } from "./lib/answer.ts";\nexport function loop(ctx) {\n  ctx.memory.seen = [answer, process.env.WRATHBENCH_WORKSPACE ?? null];\n}\n',
    );
    expect((await host.deployProgram(1)).ok).toBe(true);
    expect(await until(async () => ((await memoryValue(host, "memory.seen")) === "undefined" ? undefined : await memoryValue(host, "memory.seen")))).toBe(
      "[ 42, null ]",
    );
  });

  test("the program's console goes to the report, never to a snippet's result", async () => {
    const { host, ws } = makeHost();
    write(ws, "main.ts", 'export function loop(ctx) {\n  console.log("tick from the program");\n}\n');
    expect((await host.deployProgram(1)).ok).toBe(true);
    await Bun.sleep(80);
    const snippet = await host.evalSnippet('console.log("from the snippet"); 1');
    expect(snippet.logs.map((l) => l.text)).toEqual(["from the snippet"]);
    const all = await reportsUntil(host, (rs) => rs.some((r) => r.logs.length > 0));
    const logs = all.flatMap((r) => r.logs).map((l) => l.text);
    expect(logs.some((t) => t.startsWith("tick from the program"))).toBe(true);
    expect(logs.some((t) => t.includes("from the snippet"))).toBe(false);
    expect(all.reduce((n, r) => n + r.logLines, 0)).toBeGreaterThanOrEqual(2);
  });

  test("a line printed every tick is one console entry per report, its count kept apart from its text", async () => {
    const { host, ws } = makeHost();
    write(ws, "main.ts", 'export function loop(ctx) {\n  console.log("same line");\n}\n');
    expect((await host.deployProgram(1)).ok).toBe(true);
    await host.programReport();
    // Several ticks' worth between two reports.
    const r = await until(async () => {
      await Bun.sleep(100);
      const rep = await host.programReport();
      return rep.logLines >= 2 ? rep : undefined;
    });
    expect(r.logs).toEqual([{ level: "log", ts: expect.any(Number), text: "same line", repeats: r.logLines }]);
  });
});

describe("errors: signatures, first occurrence, and the line they came from", () => {
  test("a fixture main.ts throwing on line 9 reports main.ts:9, wakes once, and a new deploy resets it", async () => {
    const { host, ws } = makeHost();
    write(
      ws,
      "main.ts",
      [
        "// A fixture program whose loop throws on line 9.",
        'import { helper } from "./lib/helper";',
        "",
        "export async function loop(ctx: { tick: number; memory: Record<string, unknown> }): Promise<void> {",
        "  ctx.memory.ticks = ctx.tick;",
        "  if (ctx.tick < 0) helper();",
        "  const bag: { items?: string[] } = {};",
        "  const n: number = bag.items?.length ?? 1;",
        "  throw new TypeError(`boom ${n}`);",
        "}",
      ].join("\n"),
    );
    write(ws, "lib/helper.ts", 'export function helper(): never {\n  throw new RangeError("from the helper");\n}\n');
    expect((await host.deployProgram(1)).ok).toBe(true);
    const all = await reportsUntil(host, (rs) => errorsOf(rs).reduce((n, e) => n + e.count, 0) >= 3);
    const errors = errorsOf(all);
    const sigs = [...new Set(errors.map((e) => e.signature))];
    expect(sigs).toHaveLength(1);
    expect(sigs[0]).toMatch(/^loop\(\) TypeError at loop \(main\.ts:9:\d+\)$/);
    const first = errors[0]!;
    expect(first.text.split("\n")[0]).toBe("TypeError: boom 1");
    expect(first.text).toContain("main.ts:9:");
    expect(first.text).not.toContain(ws.dir);
    expect(first.text).not.toContain("?v=");
    // Only the first report of the signature in this deploy is new.
    expect(errors.filter((e) => e.isNew)).toHaveLength(1);
    expect(errors[0]!.isNew).toBe(true);
    // A second deploy starts its own count.
    expect((await host.deployProgram(2)).ok).toBe(true);
    const again = await reportsUntil(host, (rs) => errorsOf(rs).some((e) => e.deploy === 2));
    const fresh = errorsOf(again).filter((e) => e.deploy === 2);
    expect(fresh[0]!.isNew).toBe(true);
  });

  test("a throw from a helper module names both frames; one after an await keeps its line", async () => {
    const { host, ws } = makeHost();
    write(ws, "lib/helper.ts", "// helper\nexport function helper(): void {\n  throw new RangeError(\"from the helper\");\n}\n");
    write(
      ws,
      "main.ts",
      [
        'import { helper } from "./lib/helper";',
        "export async function loop(ctx) {",
        "  if (ctx.tick % 2 === 1) {",
        "    helper();",
        "    return;",
        "  }",
        "  await new Promise((r) => setTimeout(r, 1));",
        '  throw new Error("after an await");',
        "}",
      ].join("\n"),
    );
    expect((await host.deployProgram(1)).ok).toBe(true);
    const all = await reportsUntil(host, (rs) => new Set(errorsOf(rs).map((e) => e.signature)).size >= 2);
    const bySig = new Map(errorsOf(all).map((e) => [e.signature, e]));
    const helperErr = [...bySig.values()].find((e) => e.text.startsWith("RangeError"))!;
    expect(helperErr.signature).toMatch(/^loop\(\) RangeError at helper \(lib\/helper\.ts:3:\d+\)$/);
    expect(helperErr.text).toContain("lib/helper.ts:3:");
    expect(helperErr.text).toContain("main.ts:4:");
    const awaited = [...bySig.values()].find((e) => e.text.startsWith("Error: after an await"))!;
    expect(awaited.text).toContain("main.ts:8:");
  });

  test("a failed load leaves the running deploy running, and says why", async () => {
    const { host, ws } = makeHost();
    write(ws, "main.ts", "export function loop(ctx) {\n  ctx.memory.gen = 1;\n  ctx.memory.n = (ctx.memory.n ?? 0) + 1;\n}\n");
    expect((await host.deployProgram(1)).ok).toBe(true);
    await until(async () => (Number(await memoryValue(host, "memory.n")) > 1 ? true : undefined));

    write(ws, "main.ts", "export function loop(ctx) {\n  ctx.memory.gen = 2;\n  const x = ;\n}\n");
    const broken = await host.deployProgram(2);
    expect(broken.ok).toBe(false);
    if (broken.ok) throw new Error("unreachable");
    expect(broken.error).toBe("BuildMessage: Unexpected ; at main.ts:3:13 — const x = ;");

    write(ws, "main.ts", "export const helper = 1;\n");
    const shapeless = await host.deployProgram(3);
    expect(shapeless.ok).toBe(false);
    if (shapeless.ok) throw new Error("unreachable");
    expect(shapeless.error).toContain("main.ts exports neither loop nor on; export async function loop(ctx)");

    // Deploy 1 is still the one ticking.
    const n = Number(await memoryValue(host, "memory.n"));
    await until(async () => (Number(await memoryValue(host, "memory.n")) > n ? true : undefined));
    expect(await memoryValue(host, "memory.gen")).toBe("1");
    expect((await host.programReport()).deploy).toBe(1);
  });
});

describe("on keys that are not event names", () => {
  test("a deploy with one loads, and its answer and its yield record name the key and the near name", async () => {
    const { host, ws } = makeHost();
    write(
      ws,
      "main.ts",
      'export const on = {\n  SMSG_LEVELUP(e, ctx) { ctx.wake("level"); },\n  SMSG_ATTACKSTART(e, ctx) {},\n  WB_MOVE_RESULTS(e, ctx) {},\n};\n',
    );
    const rec = await host.deployAtYield();
    expect(rec).toEqual({
      deploy: 1,
      version: ws.importVersion,
      ok: true,
      exports: ["on.SMSG_LEVELUP", "on.SMSG_ATTACKSTART", "on.WB_MOVE_RESULTS"],
      warnings: [
        "on.SMSG_LEVELUP is not an event name on the event stream, so it is never called; nearest: SMSG_LEVELUP_INFO",
        "on.WB_MOVE_RESULTS is not an event name on the event stream, so it is never called; nearest: WB_MOVE_RESULT",
      ],
      action: "load",
    });
    expect(host.programState.kind).toBe("running");
  });

  test("near names: a prefix either way, any case, any underscores, any family; nothing when it is a list", () => {
    expect(nearEventNames("SMSG_LEVELUP")).toEqual(["SMSG_LEVELUP_INFO"]);
    expect(nearEventNames("smsg_levelup_info")).toEqual(["SMSG_LEVELUP_INFO"]);
    expect(nearEventNames("SMSG_LEVEL_UP_INFO")).toEqual(["SMSG_LEVELUP_INFO"]);
    expect(nearEventNames("SMSG_LEVEL_UP")).toEqual(["SMSG_LEVELUP_INFO"]);
    expect(nearEventNames("SMSG_ATTACK_START")).toEqual(["SMSG_ATTACKSTART"]);
    expect(nearEventNames("MOVE_RESULT")).toEqual(["WB_MOVE_RESULT"]);
    expect(nearEventNames("SMSG_MOVE_RESULT")).toEqual(["WB_MOVE_RESULT"]);
    expect(nearEventNames("SMSG_ATTACK")).toEqual(["SMSG_ATTACKSTOP", "SMSG_ATTACKSTART", "SMSG_ATTACKERSTATEUPDATE"]);
    // Many questgiver packets share the stem, so none of them is the obvious one.
    expect(nearEventNames("SMSG_QUEST")).toEqual([]);
    expect(nearEventNames("SMSG_PROBE")).toEqual([]);
    expect(nearEventNames("*")).toEqual([]);
    expect(unknownEventWarnings(["SMSG_ATTACKSTART", "WB_MOVE_RESULT", "stream_gap", "WB_AREATRIGGER"])).toEqual([]);
    expect(unknownEventWarnings(["SMSG_LEVEL_UP_INFO"])).toEqual([
      "on.SMSG_LEVEL_UP_INFO is not an event name on the event stream, so it is never called; nearest: SMSG_LEVELUP_INFO",
    ]);
  });

  test("every event row of module/PROTOCOL.md is an event name a handler can be keyed by", () => {
    const md = readFileSync(join(import.meta.dir, "..", "..", "module", "PROTOCOL.md"), "utf8");
    const rows = [...md.matchAll(/^\| `((?:SMSG|MSG|WB)_[A-Z0-9_]+)` \|/gm)].map((m) => m[1]!);
    expect(rows.length).toBeGreaterThan(100);
    expect(rows.filter((r) => !PROGRAM_EVENT_NAMES.has(r))).toEqual([]);
  });
});

describe("sdk failures: counted whether or not the program catches them", () => {
  test("a caught rejection is a new failed signature once, an ok:false answer is an outcome only counted, each with the workspace line of the call", async () => {
    const { host, ws } = makeHost();
    write(
      ws,
      "main.ts",
      [
        "export async function loop(ctx) {",
        "  try {",
        '    await ctx.sdk.trainerList("123");',
        "  } catch {",
        "    // caught, and never logged: the harness still sees it",
        "  }",
        '  const r = await sdk.moveTo("Nobody Stands Here");',
        "  ctx.memory.status = r.status;",
        "}",
      ].join("\n"),
    );
    expect((await host.deployProgram(1)).ok).toBe(true);
    const all = await reportsUntil(host, (rs) => {
      const sdk = errorsOf(rs).filter((e) => e.kind === "failed" || e.kind === "outcome");
      return new Set(sdk.map((e) => e.signature)).size >= 2 && sdk.reduce((n, e) => n + e.count, 0) >= 4;
    });
    const failed = errorsOf(all).filter((e) => e.kind === "failed");
    const outcomes = errorsOf(all).filter((e) => e.kind === "outcome");
    const rejected = failed.find((e) => e.signature.startsWith("loop() sdk.trainerList "))!;
    expect(rejected.signature).toBe("loop() sdk.trainerList WrathTransportError");
    expect(rejected.hook).toBe("loop()");
    expect(rejected.text.split("\n")[0]).toStartWith("sdk.trainerList() threw WrathTransportError: ");
    expect(rejected.text).toContain("    at loop (main.ts:3:");
    expect(rejected.text).not.toContain(ws.dir);
    expect(failed.every((e) => e.signature === rejected.signature)).toBe(true);
    const answered = outcomes.find((e) => e.signature.startsWith("loop() sdk.moveTo "))!;
    expect(answered.signature).toBe("loop() sdk.moveTo unknown_target");
    expect(answered.text.split("\n")[0]).toBe('sdk.moveTo() returned ok:false, status "unknown_target"');
    expect(answered.text).toContain("    at loop (main.ts:7:");
    // The rejection's first occurrence in the deploy is new (it wakes), repeats are only counted;
    // the ok:false answer is counted every time and new never. Nothing reached a hook as a throw.
    const rejections = failed.filter((e) => e.signature === rejected.signature);
    expect(rejections.filter((e) => e.isNew)).toHaveLength(1);
    expect(rejections[0]!.isNew).toBe(true);
    const answers = outcomes.filter((e) => e.signature === answered.signature);
    expect(answers.reduce((n, e) => n + e.count, 0)).toBeGreaterThanOrEqual(1);
    expect(answers.filter((e) => e.isNew)).toEqual([]);
    expect(errorsOf(all).filter((e) => e.kind === "thrown")).toEqual([]);
    // The program's own result is untouched by the watch.
    expect(await memoryValue(host, "memory.status")).toBe('"unknown_target"');
  });

  test("a snippet's failed calls are its own result's, never the program's", async () => {
    const { host, ws } = makeHost();
    write(ws, "main.ts", "export function loop(ctx) {\n  ctx.memory.n = (ctx.memory.n ?? 0) + 1;\n}\n");
    expect((await host.deployProgram(1)).ok).toBe(true);
    await until(async () => (Number(await memoryValue(host, "memory.n")) > 1 ? true : undefined));
    const snippet = await host.evalSnippet('(await sdk.moveTo("Nobody Stands Here")).status');
    expect(snippet.value).toBe('"unknown_target"');
    await host.evalSnippet('try { await sdk.trainerList("123") } catch {}');
    await Bun.sleep(60);
    expect(errorsOf([await host.programReport()])).toEqual([]);
  });
});

describe("memory", () => {
  test("a snippet's memory is saved, and a new child reads it back from memory.json", async () => {
    const { host, ws } = makeHost();
    await host.evalSnippet('memory.phase = "grind";\nmemory.targets = ["Kobold"];');
    expect(JSON.parse(readFileSync(join(ws.dir, "memory.json"), "utf8"))).toEqual({ phase: "grind", targets: ["Kobold"] });
    // Replacing it wholesale works too.
    await host.evalSnippet('memory = { phase: "rest" };');
    expect(JSON.parse(readFileSync(join(ws.dir, "memory.json"), "utf8"))).toEqual({ phase: "rest" });
    await host.stop();
    const second = makeHost(ws).host;
    expect(await memoryValue(second, "memory.phase")).toBe('"rest"');
  });

  test("a memory that is not plain JSON, or too large, is not saved, and the error names the path", async () => {
    const { host, ws } = makeHost();
    await host.evalSnippet('memory.ok = 1;');
    const saved = readFileSync(join(ws.dir, "memory.json"), "utf8");
    await host.evalSnippet("memory.big = 10n;");
    await host.evalSnippet("delete memory.big;\nmemory.seen = new Map();");
    await host.evalSnippet('delete memory.seen;\nmemory.blob = "x".repeat(40_000);');
    expect(readFileSync(join(ws.dir, "memory.json"), "utf8")).toBe(saved);
    const errors = (await host.programReport()).errors;
    expect(errors.map((e) => e.signature)).toEqual([
      "memory not saved: BigInt",
      "memory not saved: Map",
      "memory not saved: too large",
    ]);
    expect(errors[0]!.text).toContain("memory.big is a BigInt");
    expect(errors[1]!.text).toContain("memory.seen is a Map");
    expect(errors[2]!.text).toContain("over its 32000-char limit");
    expect(errors.every((e) => e.isNew)).toBe(true);
    // Fixed, it saves again.
    await host.evalSnippet("delete memory.blob;\nmemory.ok = 2;");
    expect(JSON.parse(readFileSync(join(ws.dir, "memory.json"), "utf8"))).toEqual({ ok: 2 });
  });
});

describe("deploys own what they start, and an edit waits for the next deploy", () => {
  test("an edit mid-wake does not reach the running deploy; the next deploy loads it", async () => {
    const { host, ws } = makeHost();
    write(ws, "lib/val.ts", "export const val = 1;\n");
    write(ws, "main.ts", 'import { val } from "./lib/val";\nexport function loop(ctx) {\n  ctx.memory.val = val;\n}\n');
    expect((await host.deployProgram(1)).ok).toBe(true);
    await until(async () => ((await memoryValue(host, "memory.val")) === "1" ? true : undefined));
    write(ws, "lib/val.ts", "export const val = 2;\n");
    // A snippet imports the files as they are now…
    expect((await host.evalSnippet('import { val } from "./lib/val";\nval')).value).toBe("2");
    // …while the running deploy keeps the version it was loaded at.
    await Bun.sleep(80);
    expect(await memoryValue(host, "memory.val")).toBe("1");
    expect((await host.deployProgram(2)).ok).toBe(true);
    await until(async () => ((await memoryValue(host, "memory.val")) === "2" ? true : undefined));
  });

  test("a timer the program started at load dies with its deploy", async () => {
    const { host, ws } = makeHost();
    write(ws, "main.ts", "setInterval(() => { memory.n = (memory.n ?? 0) + 1; }, 10);\nexport const on = {};\n");
    expect((await host.deployProgram(1)).ok).toBe(true);
    await until(async () => (Number(await memoryValue(host, "memory.n")) > 2 ? true : undefined));
    write(ws, "main.ts", "export const on = {};\n");
    expect((await host.deployProgram(2)).ok).toBe(true);
    const a = await memoryValue(host, "memory.n");
    await Bun.sleep(60);
    expect(await memoryValue(host, "memory.n")).toBe(a);
  });
});

describe("the host: deploy at a yield, the heartbeat, halts and restarts", () => {
  const HEARTBEAT = { pollMs: 40, blockGraceMs: 400 };

  test("deployAtYield loads on a change, not otherwise; a failed load is not retried until something changes; a deleted main.ts unloads", async () => {
    const { host, ws } = makeHost();
    expect(await host.deployAtYield()).toBeNull();
    write(ws, "main.ts", "export function loop(ctx) {\n  ctx.memory.gen = 1;\n}\n");
    expect(await host.deployAtYield()).toEqual({
      deploy: 1,
      version: ws.importVersion,
      ok: true,
      exports: ["loop"],
      action: "load",
    });
    expect(host.programState.kind).toBe("running");
    // notes.md is not code: ending a turn after editing it deploys nothing.
    ws.write("notes.md", "plan");
    expect(await host.deployAtYield()).toBeNull();
    write(ws, "main.ts", "export function loop(ctx) {\n  ctx.memory.gen = ;\n}\n");
    const failed = await host.deployAtYield();
    expect(failed?.ok).toBe(false);
    expect(failed?.error).toContain("main.ts:2:");
    expect(host.programState).toMatchObject({ kind: "running", deploy: 1 });
    expect(await host.deployAtYield()).toBeNull();
    write(ws, "main.ts", "export function loop(ctx) {\n  ctx.memory.gen = 3;\n}\n");
    expect((await host.deployAtYield())?.deploy).toBe(3);
    await until(async () => ((await memoryValue(host, "memory.gen")) === "3" ? true : undefined));
    ws.delete("main.ts");
    expect(await host.deployAtYield()).toMatchObject({ deploy: 3, ok: true, action: "unload" });
    expect(host.programState.kind).toBe("none");
    expect(await host.deployAtYield()).toBeNull();
  });

  test("the heartbeat drains reports to listeners, asleep or awake", async () => {
    const { host, ws } = makeHost(undefined, HEARTBEAT);
    const reports: ProgramReport[] = [];
    host.onProgramEvent((e) => {
      if (e.kind === "report") reports.push(e.report);
    });
    write(ws, "main.ts", "export function loop(ctx) {}\n");
    expect((await host.deployAtYield())?.ok).toBe(true);
    await until(() => (reports.reduce((n, r) => n + r.ticks, 0) >= 3 ? true : undefined));
  });

  test("a program that blocks the event loop halts: the child restarts, the program waits for the yield, and the yield reloads it", async () => {
    const { host, ws } = makeHost(undefined, HEARTBEAT);
    const events: string[] = [];
    host.onProgramEvent((e) => {
      if (e.kind !== "report") events.push(e.kind);
    });
    write(ws, "main.ts", "export function loop(ctx) {\n  if (ctx.tick === 3) for (;;) {}\n}\n");
    expect((await host.deployAtYield())?.ok).toBe(true);
    await until(() => (events.includes("halted") ? true : undefined), 8_000);
    expect(host.programState).toMatchObject({ kind: "halted", deploy: 1 });
    expect(host.totalRestarts).toBe(1);
    const notice = host.drainNotices().find((n) => n.kind === "sandbox_restarted")!;
    expect(notice.text).toContain("your program (main.ts, deploy 1) blocked the event loop for 400ms");
    expect(notice.text).toContain("it stays stopped until you end your turn");
    expect(notice.text).not.toContain("background routine");
    // Nothing changed, but a halted program is due at the yield.
    const again = await host.deployAtYield();
    expect(again).toMatchObject({ deploy: 2, ok: true });
    expect(host.programState).toMatchObject({ kind: "running", deploy: 2 });
  });

  test("a snippet that blocks is blamed, not the program, which comes back by itself", async () => {
    const { host, ws } = makeHost(undefined, HEARTBEAT);
    const events: ProgramHostEventKind[] = [];
    host.onProgramEvent((e) => {
      if (e.kind !== "report") events.push(e.kind);
    });
    write(ws, "main.ts", "export function loop(ctx) {\n  ctx.memory.n = (ctx.memory.n ?? 0) + 1;\n}\n");
    expect((await host.deployAtYield())?.ok).toBe(true);
    await until(async () => (Number(await memoryValue(host, "memory.n")) > 2 ? true : undefined));
    const blocked = await host.evalSnippet("for (;;) {}");
    expect(blocked.ok).toBe(false);
    expect(blocked.restarted).toBe(true);
    expect(blocked.error).toContain("snippet blocked the sandbox event loop for 400ms");
    expect(blocked.error).toContain("memory.json included, are unchanged");
    await until(() => (events.includes("reload") ? true : undefined));
    expect(events).toEqual(["restart", "reload"]);
    expect(host.programState).toMatchObject({ kind: "running", deploy: 1 });
    // The first result from the new child says it is new, in the entrypoint loop's words.
    const next = await host.evalSnippet("memory.n");
    expect(next.resetNotice).toBe(STATE_RESET_NOTICE_ENTRYPOINT);
    const n = Number(next.value);
    await until(async () => (Number(await memoryValue(host, "memory.n")) > n ? true : undefined));
  });

  test("a restart with files changed since the deploy leaves the program stopped until the yield", async () => {
    const { host, ws } = makeHost(undefined, HEARTBEAT);
    const events: ProgramHostEventKind[] = [];
    host.onProgramEvent((e) => {
      if (e.kind !== "report") events.push(e.kind);
    });
    write(ws, "main.ts", "export function loop(ctx) {\n  ctx.memory.gen = 1;\n}\n");
    expect((await host.deployAtYield())?.ok).toBe(true);
    write(ws, "main.ts", "export function loop(ctx) {\n  ctx.memory.gen = 2;\n}\n");
    const crashed = await host.evalSnippet("process.exit(3)");
    expect(crashed.restarted).toBe(true);
    await until(() => (events.includes("stopped") ? true : undefined));
    expect(events).toEqual(["restart", "stopped"]);
    expect(host.programState).toMatchObject({ kind: "stopped", deploy: 1 });
    expect((await host.deployAtYield())?.ok).toBe(true);
    await until(async () => ((await memoryValue(host, "memory.gen")) === "2" ? true : undefined));
  });

  test("a memory the workspace has no room for is an error the next report carries", async () => {
    const { host, ws } = makeHost();
    for (let i = 0; i < 32; i++) write(ws, `big/${i}.txt`, "y".repeat(32_000));
    await host.evalSnippet('memory.blob = "z".repeat(31_000);');
    const errors = (await host.programReport()).errors;
    expect(errors).toHaveLength(1);
    expect(errors[0]!.signature).toBe("memory not saved: workspace full");
    expect(errors[0]!.text).toContain("over its 1048576-byte limit");
  });
});

type ProgramHostEventKind = "report" | "halted" | "restart" | "reload" | "stopped";

describe("facts the child sees", () => {
  test("a level gained, a quest turned in and a death are each reported once", async () => {
    const { host } = makeHost();
    const fed = await host.evalSnippet(
      [
        "let seq = 1;",
        "const feed = (opcode, opcodeId, data) => events.ingest(JSON.stringify({ seq: seq++, opcode, opcodeId, ts: 1000 + seq, data }));",
        'const selfFields = (fields) => feed("SMSG_UPDATE_OBJECT", 0xa9, { blocks: 1, objects: [{ update: "values", guid: "7", fields }] });',
        'feed("WB_SESSION_STATE", 0xff03, { character: "Fenwick", guid: "7", inWorld: true, map: 0, x: 1, y: 2, z: 3, o: 0, level: 7, zoneId: 1, zoneName: "", areaId: 2, areaName: "" });',
        "selfFields({ health: 100, maxHealth: 100, level: 7 });",
        "selfFields({ level: 8 });",
        'feed("SMSG_QUESTGIVER_QUEST_COMPLETE", 0x191, { questId: 33, xp: 120, money: 40 });',
        "selfFields({ health: 0 });",
        "selfFields({ level: 8 });",
      ].join("\n"),
    );
    expect(fed.error).toBeUndefined();
    const facts = (await host.programReport()).milestones.map((m) => [m.fact, m.level ?? m.questId ?? null]);
    expect(facts).toEqual([
      ["level", 8],
      ["quest", 33],
      ["death", null],
    ]);
    expect((await host.programReport()).milestones).toEqual([]);
    // The host's own death drain for the trajectory is untouched by this latch.
    expect((await host.deathSignals()).map((s) => s.kind)).toEqual(["death"]);
  });
});
