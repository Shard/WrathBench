/**
 * The two melee swing errors (`SMSG_ATTACKSWING_NOTINRANGE`,
 * `SMSG_ATTACKSWING_BADFACING`) on their way to the model: off the event
 * stream inside the real sandbox child, across the rpc as `EventSummary` rows,
 * into the per-turn event window, the `recent_events` tool, and the public
 * projection's prose redactor.
 *
 * Nothing between the module and the model names these opcodes, so nothing
 * needed changing for them to arrive; this file pins that. The one list that
 * could drop them is `CONTEXT_POLICY.EVENT_WINDOW_EXCLUDE` (ambient motion),
 * and a swing error is the opposite of ambient: the core latches them, so each
 * arrives once per change of error state (module/PROTOCOL.md, "Swing errors").
 *
 * There is no game stack here. The SDK client is constructed but never
 * connected, and frames are handed straight to `events.ingest`. Every frame is
 * hand-written from module/PROTOCOL.md's tables; nothing is captured from a
 * running game (CLAUDE.md).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { CONTEXT_POLICY, assembleContext, formatEventLine, formatStateSummary } from "../src/context";
import { EpisodicLog } from "../src/episodic";
import { ReflectGate } from "../src/reflect";
import { SandboxHost } from "../src/sandbox/host";
import type { EventSummary } from "../src/sandbox/ipc";
import { Scratchpad } from "../src/scratchpad";
import { callTool, type ToolContext } from "../src/tools";
import { PROSE_OPCODES, redactProseText, redactProseValue } from "../viewer/redact-prose";
import { tempDirs } from "./fixtures/temp-dirs";

const tempDir = tempDirs();

const NOT_IN_RANGE = "SMSG_ATTACKSWING_NOTINRANGE";
const BAD_FACING = "SMSG_ATTACKSWING_BADFACING";

const hosts: SandboxHost[] = [];

function makeHost(): { host: SandboxHost; dir: string } {
  const dir = tempDir("wrathbench-swing-");
  const host = new SandboxHost({
    moduleUrl: "http://worldserver:8086",
    token: "test-token",
    scratchpad: new Scratchpad(join(dir, "scratchpad.md")),
    snippetTimeoutMs: 5_000,
    pingGraceMs: 1_000,
  });
  hosts.push(host);
  return { host, dir };
}

afterEach(async () => {
  await Promise.all(hosts.splice(0, hosts.length).map((h) => h.stop()));
});

/**
 * One armed-out-of-range, walk-in, back-turned sequence as the wire would
 * carry it: the attack start, one range error, ambient motion while the
 * character closes, then one facing error. Both swing errors are bodiless.
 */
const FEED = `
state.seedSelf({ guid: "7", name: "Fenwick" });
globalThis.seq = 0;
globalThis.feed = (opcode, opcodeId, data) => {
  events.ingest(JSON.stringify({ seq: seq++, opcode, opcodeId, ts: 1_700_000_000_000 + seq, data }));
};
globalThis.heard = [];
events.on("${NOT_IN_RANGE}", (e) => heard.push(e.opcode + JSON.stringify(e.data)));
events.on("${BAD_FACING}", (e) => heard.push(e.opcode + JSON.stringify(e.data)));
feed("SMSG_ATTACKSTART", 0x143, { attackerGuid: "7", victimGuid: "99" });
feed("${NOT_IN_RANGE}", 0x145, {});
for (let i = 0; i < 3; i++) {
  feed("MSG_MOVE_HEARTBEAT", 0xee, { guid: "99", flags: 0, pos: { x: 1 + i, y: 2, z: 3, o: 0 } });
}
feed("${BAD_FACING}", 0x146, {});
return heard.join(" | ");
`;

describe("melee swing errors reach the model like any other combat event", () => {
  test("the ambient-motion exclusion does not match either opcode", () => {
    expect(CONTEXT_POLICY.EVENT_WINDOW_EXCLUDE.test(NOT_IN_RANGE)).toBe(false);
    expect(CONTEXT_POLICY.EVENT_WINDOW_EXCLUDE.test(BAD_FACING)).toBe(false);
  });

  test("a snippet hears them, and the sandbox serves them into the window and recent_events", async () => {
    const { host, dir } = makeHost();
    const fed = await host.evalSnippet(FEED);
    expect(fed.ok).toBe(true);
    // Snippet side: typed handlers fired once each, with the empty payload.
    expect(fed.value).toContain(`${NOT_IN_RANGE}{} | ${BAD_FACING}{}`);

    // Across the rpc: known opcodes (no schema mismatch), `{}` as the data.
    const served = await host.recentEvents(CONTEXT_POLICY.EVENT_WINDOW);
    const swingErrors = served.filter((e) => e.opcode === NOT_IN_RANGE || e.opcode === BAD_FACING);
    expect(swingErrors.map((e) => [e.seq, e.opcode, e.data, e.schemaError])).toEqual([
      [1, NOT_IN_RANGE, {}, undefined],
      [5, BAD_FACING, {}, undefined],
    ]);

    // The per-turn context window: both rendered, the heartbeats folded away.
    const context = assembleContext({
      stateSummary: formatStateSummary(null, { sessionLive: true }),
      events: served,
      scratchpad: "",
      notices: [],
      turn: 1,
    });
    expect(context).toContain(
      "[events: last 3, newest last; 3 ambient movement events folded into state only]\n" +
        `#0 SMSG_ATTACKSTART {"attackerGuid":"7","victimGuid":"99"}\n` +
        `#1 ${NOT_IN_RANGE} {}\n` +
        `#5 ${BAD_FACING} {}`,
    );

    // The recent_events tool, default (signal-only) form, over the same host.
    const ctx: ToolContext = {
      sandbox: host,
      scratchpad: new Scratchpad(join(dir, "tool-scratchpad.md")),
      sessionLive: () => true,
      reflect: new ReflectGate(),
      episodic: new EpisodicLog(join(dir, "episodic.jsonl")),
      turn: () => 1,
    };
    const tool = await callTool(ctx, "recent_events", {});
    expect(tool.isError).toBeFalsy();
    expect(tool.text).toContain(`#1 ${NOT_IN_RANGE} {}`);
    expect(tool.text).toContain(`#5 ${BAD_FACING} {}`);
    expect(tool.text).not.toContain("MSG_MOVE_HEARTBEAT");
    expect(tool.text).toContain("(+3 ambient movement events folded into state");
  });

  test("the event line is the opcode and the empty payload, with no note appended", () => {
    const line = (opcode: string): string => formatEventLine({ seq: 12, ts: 1, opcode, data: {} } as EventSummary);
    expect(line(NOT_IN_RANGE)).toBe(`#12 ${NOT_IN_RANGE} {}`);
    expect(line(BAD_FACING)).toBe(`#12 ${BAD_FACING} {}`);
  });

  test("the public projection's prose redactor passes them through untouched", () => {
    // They carry no game prose, so they are not prose opcodes; a batch row and
    // a recent_events line both survive byte-identical.
    expect(PROSE_OPCODES.has(NOT_IN_RANGE)).toBe(false);
    expect(PROSE_OPCODES.has(BAD_FACING)).toBe(false);
    const lines = `#2 ${NOT_IN_RANGE} {}\n#6 ${BAD_FACING} {}`;
    expect(redactProseText(lines)).toBe(lines);
    const batch = [
      { seq: 2, ts: 1, opcode: NOT_IN_RANGE, data: {} },
      { seq: 6, ts: 2, opcode: BAD_FACING, data: {} },
    ];
    expect(redactProseValue(batch)).toEqual(batch);
  });
});
