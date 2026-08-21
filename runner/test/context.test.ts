import { describe, expect, test } from "bun:test";
import {
  CONTEXT_POLICY,
  assembleContext,
  formatStateSummary,
  trimMessageWindow,
  type ChatMessage,
  type ContextInputs,
} from "../src/context";
import type { EventSummary } from "../src/sandbox/ipc";

function makeInputs(): ContextInputs {
  const events: EventSummary[] = Array.from({ length: 70 }, (_, i) => ({
    seq: i,
    ts: 1_000 + i,
    opcode: i % 2 === 0 ? "SMSG_MESSAGECHAT" : "SMSG_NOTIFICATION",
    data: { i, guid: "12345678901234567890" },
  }));
  return {
    stateSummary: formatStateSummary(
      {
        self: {
          guid: "42",
          name: "Benchy",
          level: { value: 3, seq: 10 },
          position: { value: { map: 0, x: 1.5, y: -2.5, z: 3 }, seq: 5 },
        },
        chat: [{ senderGuid: "42", message: "hello" }],
        notifications: [{ text: "You are muted" }],
        gaps: [],
        lastSeq: 69,
        eventCount: 70,
      },
      { sessionLive: true },
    ),
    events,
    scratchpad: "# plan\n- do quests",
    notices: [{ ts: 1, kind: "sandbox_restarted", text: "restarted" }],
    turn: 7,
  };
}

describe("assembleContext", () => {
  test("deterministic: same inputs give byte-identical output", () => {
    const a = assembleContext(makeInputs());
    const b = assembleContext(makeInputs());
    expect(a).toBe(b);
  });

  test("includes exactly the last EVENT_WINDOW events", () => {
    const text = assembleContext(makeInputs());
    expect(text).toContain(`[events: last ${CONTEXT_POLICY.EVENT_WINDOW}, newest last]`);
    expect(text).toContain("#69 ");
    expect(text).toContain(`#${70 - CONTEXT_POLICY.EVENT_WINDOW} `);
    expect(text).not.toContain(`#${69 - CONTEXT_POLICY.EVENT_WINDOW} `);
  });

  test("carries notices, scratchpad, turn and summary", () => {
    const text = assembleContext(makeInputs());
    expect(text).toContain("[turn 7]");
    expect(text).toContain("- sandbox_restarted: restarted");
    expect(text).toContain("# plan");
    expect(text).toContain("character: Benchy (guid 42) level 3");
    expect(text).toContain("session: in world");
  });

  test("empty inputs render honest placeholders", () => {
    const text = assembleContext({
      stateSummary: formatStateSummary(null, { sessionLive: false }),
      events: [],
      scratchpad: "",
      notices: [],
      turn: 1,
    });
    expect(text).toContain("no sandbox state yet");
    expect(text).toContain("[events]\nnone yet");
    expect(text).toContain("(empty — write your plan");
  });
});

describe("formatStateSummary", () => {
  test("unobserved fields say so instead of inventing zeros", () => {
    const text = formatStateSummary(
      { self: { name: "Benchy", guid: "1" }, lastSeq: 3, eventCount: 4 },
      { sessionLive: false },
    );
    expect(text).toContain("level unobserved");
    expect(text).toContain("position: unobserved");
    expect(text).toContain("health: unobserved  power: unobserved");
    expect(text).not.toContain("level 0");
  });
  test("gaps are surfaced", () => {
    const text = formatStateSummary({ gaps: [{}, {}] }, { sessionLive: true });
    expect(text).toContain("stream: 2 gap(s)");
  });
});

describe("trimMessageWindow", () => {
  const assistant = (i: number): ChatMessage => ({
    role: "assistant",
    content: `a${i}`,
    tool_calls: [{ id: `t${i}`, type: "function", function: { name: "x", arguments: "{}" } }],
  });
  const tool = (i: number): ChatMessage => ({ role: "tool", content: `r${i}`, tool_call_id: `t${i}` });

  test("keeps everything under the cap", () => {
    const msgs = [assistant(1), tool(1)];
    expect(trimMessageWindow(msgs)).toEqual(msgs);
  });

  test("never splits an assistant tool-call from its results", () => {
    const msgs: ChatMessage[] = [];
    for (let i = 0; i < 40; i++) {
      msgs.push(assistant(i), tool(i));
    }
    const trimmed = trimMessageWindow(msgs);
    expect(trimmed.length).toBeLessThanOrEqual(CONTEXT_POLICY.MESSAGE_WINDOW);
    expect(trimmed[0]!.role).toBe("assistant");
    // every tool message's call id has its assistant present
    const callIds = new Set(
      trimmed.flatMap((m) => (m.role === "assistant" ? (m.tool_calls ?? []).map((c) => c.id) : [])),
    );
    for (const m of trimmed) {
      if (m.role === "tool") expect(callIds.has(m.tool_call_id!)).toBe(true);
    }
  });
});
