/**
 * The sandbox's ambient `sleep(ms, options?)`, against the real child process.
 *
 * There is no game stack here: the SDK client is constructed but never
 * connected, and the "server" is a fake event stream — the snippets below seed
 * the state cache's own guid and hand frames straight to `events.ingest`, which
 * is public exactly so a replay (or a test) can drive a stream without a socket.
 *
 * Every frame is hand-written from module/PROTOCOL.md's tables. Nothing here is
 * captured from a running game (CLAUDE.md).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SandboxHost } from "../src/sandbox/host";
import { Scratchpad } from "../src/scratchpad";

const hosts: SandboxHost[] = [];

function makeHost(snippetTimeoutMs = 5_000): SandboxHost {
  const dir = mkdtempSync(join(tmpdir(), "wrathbench-sleep-"));
  const host = new SandboxHost({
    moduleUrl: "http://worldserver:8086",
    token: "test-token",
    scratchpad: new Scratchpad(join(dir, "scratchpad.md")),
    snippetTimeoutMs,
    pingGraceMs: 1_000,
  });
  hosts.push(host);
  return host;
}

afterEach(async () => {
  await Promise.all(hosts.splice(0, hosts.length).map((h) => h.stop()));
});

/**
 * Snippet preamble: claim guid "7" as our own character and give the cache a
 * health gauge (both halves, or the cache does not derive one), then expose a
 * `feed` that pushes one frame with an increasing seq.
 */
const PRELUDE = `
state.seedSelf({ guid: "7", name: "Fenwick" });
globalThis.seq = 1;
globalThis.feed = (opcode, opcodeId, data) => {
  events.ingest(JSON.stringify({ seq: seq++, opcode, opcodeId, ts: Date.now(), data }));
};
globalThis.selfFields = (fields) =>
  feed("SMSG_UPDATE_OBJECT", 0xa9, { blocks: 1, objects: [{ update: "values", guid: "7", fields }] });
globalThis.attackStart = (victimGuid) =>
  feed("SMSG_ATTACKSTART", 0x143, { attackerGuid: "99", victimGuid });
selfFields({ health: 40, maxHealth: 40 });
`;

describe("sandbox sleep(): the timer that says why it woke", () => {
  test("with nothing happening it runs the clock and resolves 'elapsed'", async () => {
    const host = makeHost();
    expect((await host.evalSnippet(PRELUDE)).ok).toBe(true);
    const res = await host.evalSnippet(
      "const t = Date.now(); const why = await sleep(200); return { why, tookAtLeast: Date.now() - t >= 190 };",
    );
    expect(res.ok).toBe(true);
    expect(res.value).toContain('"elapsed"');
    expect(res.value).toContain("true");
  });

  test("a unit starting to attack us wakes it early with 'attacked'", async () => {
    const host = makeHost();
    await host.evalSnippet(PRELUDE);
    const res = await host.evalSnippet(`
      const t = Date.now();
      setTimeout(() => attackStart("7"), 60);
      const why = await sleep(4_000);
      return { why, early: Date.now() - t < 2_000 };
    `);
    expect(res.ok).toBe(true);
    expect(res.value).toContain('"attacked"');
    expect(res.value).toContain("early: true");
  });

  test("someone else being attacked does not wake it", async () => {
    const host = makeHost();
    await host.evalSnippet(PRELUDE);
    const res = await host.evalSnippet(`
      setTimeout(() => attackStart("12345"), 40);
      return await sleep(300);
    `);
    expect(res.value).toBe(JSON.stringify("elapsed"));
  });

  test("our own health reaching zero wakes it early with 'died'", async () => {
    const host = makeHost();
    await host.evalSnippet(PRELUDE);
    const res = await host.evalSnippet(`
      const t = Date.now();
      setTimeout(() => selfFields({ health: 0 }), 60);
      const why = await sleep(4_000);
      return { why, early: Date.now() - t < 2_000 };
    `);
    expect(res.value).toContain('"died"');
    expect(res.value).toContain("early: true");
  });

  test("a snippet that is already dead is not woken by the death it is waiting out", async () => {
    // Pattern (2) from the runs: `await sleep(25000); sdk.reclaimCorpse()`.
    const host = makeHost();
    await host.evalSnippet(PRELUDE);
    await host.evalSnippet('selfFields({ health: 0 }); "dead"');
    const res = await host.evalSnippet(`
      setTimeout(() => selfFields({ health: 0 }), 40);
      return await sleep(250);
    `);
    expect(res.value).toBe(JSON.stringify("elapsed"));
  });

  test("dying again after coming back does wake it", async () => {
    const host = makeHost();
    await host.evalSnippet(PRELUDE);
    await host.evalSnippet('selfFields({ health: 0 }); "dead"');
    const res = await host.evalSnippet(`
      setTimeout(() => selfFields({ health: 20 }), 40);
      setTimeout(() => selfFields({ health: 0 }), 90);
      return await sleep(4_000);
    `);
    expect(res.value).toBe(JSON.stringify("died"));
  });

  test("{ wake: false } is a pure timer", async () => {
    const host = makeHost();
    await host.evalSnippet(PRELUDE);
    const res = await host.evalSnippet(`
      setTimeout(() => attackStart("7"), 40);
      return await sleep(250, { wake: false });
    `);
    expect(res.value).toBe(JSON.stringify("elapsed"));
  });

  test("Promise.race with a background routine is unchanged: the routine still wins", async () => {
    // Pattern (1) from the runs — sleep as a deadline. An early wake is
    // harmless here by construction, but the routine finishing first must
    // still be what the race returns.
    const host = makeHost();
    await host.evalSnippet(PRELUDE);
    const res = await host.evalSnippet(`
      const routine = (async () => { await sleep(50, { wake: false }); return "routine done"; })();
      return await Promise.race([routine, sleep(3_000)]);
    `);
    expect(res.value).toBe(JSON.stringify("routine done"));
  });

  test("an abandoned snippet's sleep still rejects with the abort reason", async () => {
    const short = makeHost(300);
    const timed = await short.evalSnippet(
      "globalThis.outcome = 'pending'; try { await sleep(5_000); globalThis.outcome = 'slept'; } catch (e) { globalThis.outcome = 'rejected: ' + e.message; }",
    );
    expect(timed.timedOut).toBe(true);
    const outcome = await short.evalSnippet("outcome");
    expect(outcome.value).toContain("rejected: snippet abandoned by the harness");
  });

  test("a bad argument is rejected with a message that says what sleep takes", async () => {
    const host = makeHost();
    const res = await host.evalSnippet("await sleep('2s')");
    expect(res.ok).toBe(false);
    expect(res.error).toContain("sleep(ms) needs a non-negative number");
    const opts = await host.evalSnippet("await sleep(10, { wake: 'yes' })");
    expect(opts.ok).toBe(false);
    expect(opts.error).toContain("{ wake: false }");
  });
});
