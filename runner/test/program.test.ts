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
import { SandboxHost } from "../src/sandbox/host";
import type { ProgramErrorNote, ProgramReport } from "../src/sandbox/ipc";
import { Workspace } from "../src/workspace";

const hosts: SandboxHost[] = [];

const FAST = { tickMs: 20, tickBudgetMs: 400, eventBudgetMs: 200, deployConnectMs: 20 };

function makeHost(ws?: Workspace): { host: SandboxHost; ws: Workspace } {
  const workspace = ws ?? new Workspace(join(mkdtempSync(join(tmpdir(), "wrathbench-prog-")), "workspace"), { memory: true });
  const host = new SandboxHost({
    moduleUrl: "http://127.0.0.1:9",
    token: "test-token",
    workspace,
    snippetTimeoutMs: 5_000,
    pingGraceMs: 1_000,
    loop: "entrypoint",
    program: FAST,
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

  test("an on handler runs as its event arrives, and ctx.wake is reported with the hook that asked", async () => {
    const { host, ws } = makeHost();
    write(
      ws,
      "main.ts",
      'export const on = {\n  SMSG_PROBE(e, ctx) {\n    ctx.memory.heard = e.seq;\n    ctx.wake("bags full");\n  },\n};\n',
    );
    expect(await host.deployProgram(1)).toEqual({ ok: true, deploy: 1, exports: ["on.SMSG_PROBE"] });
    await host.evalSnippet('events.ingest(JSON.stringify({ seq: 4, opcode: "SMSG_PROBE", opcodeId: 1, ts: 5, data: {} }))');
    expect(await memoryValue(host, "memory.heard")).toBe("4");
    const all = await reportsUntil(host, (rs) => rs.some((r) => r.requests.length > 0));
    const req = all.flatMap((r) => r.requests)[0]!;
    expect([req.reason, req.from, req.count]).toEqual(["bags full", "on.SMSG_PROBE", 1]);
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
