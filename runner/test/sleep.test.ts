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
import { join } from "node:path";
import { SandboxHost } from "../src/sandbox/host";
import { Scratchpad } from "../src/scratchpad";
import { tempDirs } from "./fixtures/temp-dirs";

const tempDir = tempDirs();

const hosts: SandboxHost[] = [];

function makeHost(snippetTimeoutMs = 5_000): SandboxHost {
  const dir = tempDir("wrathbench-sleep-");
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
globalThis.chat = (type, senderGuid, message) =>
  feed("SMSG_MESSAGECHAT", 0x96, { type, language: 0, senderGuid, message, chatTag: 0 });
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

  test("{ wake: false } sleeps through being attacked and dying", async () => {
    const host = makeHost();
    await host.evalSnippet(PRELUDE);
    const res = await host.evalSnippet(`
      setTimeout(() => attackStart("7"), 40);
      setTimeout(() => selfFields({ health: 0 }), 60);
      return await sleep(250, { wake: false });
    `);
    expect(res.value).toBe(JSON.stringify("elapsed"));
  });

  test("{ wake: false } is still woken by a party line from another player", async () => {
    // The reclaim-delay sleep is the one a resurrection offer arrives during.
    const host = makeHost();
    await host.evalSnippet(PRELUDE);
    await host.evalSnippet('selfFields({ health: 0 }); "dead"');
    const res = await host.evalSnippet(`
      const t = Date.now();
      setTimeout(() => chat(0x02, "12", "rezzing you"), 60);
      const why = await sleep(4_000, { wake: false });
      return { why, early: Date.now() - t < 2_000 };
    `);
    expect(res.value).toContain('"chat"');
    expect(res.value).toContain("early: true");
  });

  // `CHAT_MSG_*` codes (SharedDefines.h): 0x01 SAY, 0x02 PARTY, 0x07 WHISPER,
  // 0x09 WHISPER_INFORM, 0x0c MONSTER_SAY, 0x10 MONSTER_EMOTE, 0x33 PARTY_LEADER.
  test.each([
    ["a party line", 0x02],
    ["the party leader's line", 0x33],
    ["a whisper", 0x07],
  ])("%s from another player wakes it early with 'chat'", async (_, type) => {
    const host = makeHost();
    await host.evalSnippet(PRELUDE);
    const res = await host.evalSnippet(`
      const t = Date.now();
      setTimeout(() => chat(${type}, "12", "rez incoming"), 60);
      const why = await sleep(4_000);
      return { why, early: Date.now() - t < 2_000 };
    `);
    expect(res.value).toContain('"chat"');
    expect(res.value).toContain("early: true");
  });

  test.each([
    ["our own party line", 0x02, "7"],
    ["our whisper's echo, which names the recipient as sender", 0x09, "12"],
    ["a creature's say", 0x0c, "99"],
    ["a creature's emote", 0x10, "99"],
    ["another player's say", 0x01, "12"],
  ])("%s does not wake it", async (_, type, sender) => {
    const host = makeHost();
    await host.evalSnippet(PRELUDE);
    // The line is folded into state.chat, so the non-wake is not a dropped frame.
    const res = await host.evalSnippet(`
      setTimeout(() => chat(${type}, "${sender}", "heard"), 40);
      const why = await sleep(250);
      return { why, folded: state.chat.at(-1)?.message };
    `);
    expect(res.value).toContain('"elapsed"');
    expect(res.value).toContain('"heard"');
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

  test("an awaited sleep of the whole ceiling still times out, and the abandon message says why", async () => {
    // One e360 run awaited sleep(30000, { wake: false }) against a 30000ms
    // ceiling 32 times in six hours and was only ever told it timed out.
    // Operator decision 2026-10-01: explain, never clamp — the snippet still
    // runs out (nothing shortened the sleep), and the note names the sleep,
    // the ceiling, and that it can never finish inside one snippet.
    //
    // The ceiling-long sleep starts 150ms in, not at once. Started at once it
    // ends a few ms after the host's 300ms timer is due, and a host event loop
    // late by that much (a GC pause in a full-suite process) sees the child's
    // 'slept' reply first and takes it: the snippet passes. Bun handles the
    // waiting reply before the overdue timer every time the loop is stalled
    // across the deadline. 150ms in leaves 150ms of slack on both sides: the
    // host may be that late, and the child may start the sleep that late and
    // still have it waiting when the abort arrives.
    const host = makeHost(300);
    const res = await host.evalSnippet("await sleep(150, { wake: false }); await sleep(300, { wake: false }); 'slept'");
    expect(res.ok).toBe(false);
    expect(res.timedOut).toBe(true);
    expect(res.error).toContain(
      "any move in flight was stopped. a sleep(300) was still waiting when this was abandoned: it was asked for " +
        "300ms and the snippet time limit is 300ms, so a sleep that long can never finish inside one snippet. " +
        "The runtime (bindings, routines, session) is still alive.",
    );
    // Longer than the ceiling reads the same way, with what was asked.
    const longer = await host.evalSnippet("await sleep(5_000)");
    expect(longer.timedOut).toBe(true);
    expect(longer.error).toContain(
      "a sleep(5000) was still waiting when this was abandoned: it was asked for 5000ms and the snippet time limit " +
        "is 300ms, so a sleep that long can never finish inside one snippet.",
    );
    // Drained with the pong: a later abandon with no sleep in it says nothing of one.
    const again = await host.evalSnippet("await new Promise(() => {})");
    expect(again.timedOut).toBe(true);
    expect(again.error).not.toContain("sleep(");
  });

  test("a shorter sleep started with less than it asked for left is named against this snippet only", async () => {
    // 550ms fits a 600ms ceiling, so "can never finish inside one snippet"
    // would be false of it; started ~300ms in, it could not finish in this one.
    // 300ms in, it ends 250ms after the ceiling and starts 300ms before it:
    // slack on both sides of the race the test above describes.
    const host = makeHost(600);
    const res = await host.evalSnippet("await sleep(300, { wake: false }); await sleep(550, { wake: false }); 'slept'");
    expect(res.timedOut).toBe(true);
    expect(res.error).toMatch(
      /a sleep\(550\) was still waiting when this was abandoned: it was asked for 550ms when this snippet had \d+ms of its 600ms time limit left, so it could never finish inside this snippet\./,
    );
    expect(res.error).not.toContain("can never finish inside one snippet");
  });

  test("a sleep the snippet was not awaiting is never named as what ran it out", async () => {
    const host = makeHost(300);
    const res = await host.evalSnippet(
      "globalThis.bg = sleep(5_000).catch((e) => e.message); await new Promise(() => {})",
    );
    expect(res.timedOut).toBe(true);
    expect(res.error).not.toContain("sleep(");
    // The background sleep still rejected, with the message it always had.
    expect((await host.evalSnippet("await bg")).value).toContain("snippet abandoned by the harness");
    // And one the snippet caught itself is the snippet's business, not the note's.
    const caught = await host.evalSnippet("try { await sleep(5_000) } catch {} await new Promise(() => {})");
    expect(caught.timedOut).toBe(true);
    expect(caught.error).not.toContain("sleep(");
  });

  test("a sleep that fits what the snippet has left carries no note", async () => {
    // The note is about the sleep, not about every abandon a sleep is part of.
    const host = makeHost(300);
    const res = await host.evalSnippet("await Promise.all([sleep(20, { wake: false }), new Promise(() => {})])");
    expect(res.timedOut).toBe(true);
    expect(res.error).not.toContain("sleep(");
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
