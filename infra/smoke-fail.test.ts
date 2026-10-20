/**
 * A smoke's failure path (infra/smoke/lib/fail.ts): one FAIL line, the
 * cleanup run once and finished, then exit 1 — however the failure arrives.
 * The shape it replaced called `fail()` a second time from `main().catch`;
 * that call's throw was an unhandled rejection, which ends a Bun process at
 * once, so the first call's session and character delete never finished.
 * Each case runs in its own process, since what is under test is the exit.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "smoke-fail-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const LIB = JSON.stringify(join(import.meta.dir, "smoke/lib/fail.ts"));

async function run(body: string, opts: { cleanupMs?: number; hang?: boolean } = {}) {
  const file = join(dir, `driver-${crypto.randomUUID()}.ts`);
  writeFileSync(
    file,
    `import { failOnce } from ${LIB};
let step = "setup";
async function cleanup() {
  console.log("cleanup start");
  await Bun.sleep(${opts.hang ? 60_000 : 300});
  console.log("cleanup done");
}
const { fail, failed } = failOnce({ prefix: () => \`[t] FAIL[\${step}]\`, cleanup, cleanupMs: ${opts.cleanupMs ?? 10_000} });
async function main() {
  step = "walk";
  ${body}
}
main().catch(failed);
`,
  );
  const p = Bun.spawn([process.execPath, file], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  const fails = stderr.split("\n").filter((l) => l.includes("FAIL["));
  return { code, stdout, stderr, fails };
}

const count = (s: string, needle: string) => s.split(needle).length - 1;

describe("failOnce", () => {
  test("a fail() in the main chain: one FAIL line, the cleanup finished, exit 1", async () => {
    const r = await run(`await Bun.sleep(10); fail("the walk ended path_incomplete"); console.log("not reached");`);
    expect(r.code).toBe(1);
    expect(r.fails).toEqual(["[t] FAIL[walk]: the walk ended path_incomplete"]);
    expect(count(r.stdout, "cleanup start")).toBe(1);
    expect(count(r.stdout, "cleanup done")).toBe(1);
    expect(r.stdout).not.toContain("not reached");
    expect(r.stderr).not.toContain("unreachable");
  });

  test("a plain throw in the main chain is reported with its stack, once", async () => {
    const r = await run(`await Bun.sleep(10); throw new TypeError("boom");`);
    expect(r.code).toBe(1);
    expect(r.fails).toHaveLength(1);
    expect(r.fails[0]).toStartWith("[t] FAIL[walk]: TypeError: boom");
    expect(count(r.stdout, "cleanup done")).toBe(1);
  });

  test("a fail() from an event callback while main waits", async () => {
    const r = await run(`setTimeout(() => fail("no SMSG_NEW_WORLD"), 10); await Bun.sleep(5_000); console.log("not reached");`);
    expect(r.code).toBe(1);
    expect(r.fails).toEqual(["[t] FAIL[walk]: no SMSG_NEW_WORLD"]);
    expect(count(r.stdout, "cleanup start")).toBe(1);
    expect(count(r.stdout, "cleanup done")).toBe(1);
    expect(r.stdout).not.toContain("not reached");
  });

  test("a plain throw from an event callback", async () => {
    const r = await run(`setTimeout(() => { throw new Error("ws handler"); }, 10); await Bun.sleep(5_000);`);
    expect(r.code).toBe(1);
    expect(r.fails).toHaveLength(1);
    expect(r.fails[0]).toContain("ws handler");
    expect(count(r.stdout, "cleanup done")).toBe(1);
  });

  test("two failures racing still clean up once", async () => {
    const r = await run(`setTimeout(() => fail("second"), 5); fail("first");`);
    expect(r.code).toBe(1);
    expect(r.fails).toEqual(["[t] FAIL[walk]: first"]);
    expect(count(r.stdout, "cleanup start")).toBe(1);
    expect(count(r.stdout, "cleanup done")).toBe(1);
  });

  test("a cleanup that hangs is cut at the backstop, and says so", async () => {
    const r = await run(`fail("stuck");`, { cleanupMs: 200, hang: true });
    expect(r.code).toBe(1);
    expect(r.fails[0]).toBe("[t] FAIL[walk]: stuck");
    expect(r.stderr).toContain("cleanup still running after 200ms");
    expect(r.stdout).not.toContain("cleanup done");
  });
});
