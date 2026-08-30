/**
 * The game-prose redactor, field by field: every prose field enumerated from
 * `sdk/src/protocol.ts` is replaced, every name beside it survives, and the
 * three carriers (a batch, a JSON tool result, a `recent_events` line) all
 * reach the same fields.
 */

import { describe, expect, test } from "bun:test";
import {
  PROSE_KEYS,
  PROSE_OPCODES,
  PROSE_SHAPES,
  REDACTED_PROSE,
  redactGameProse,
  redactProseText,
  redactProseValue,
} from "../viewer/redact-prose";

const P = {
  details: "prose-details",
  objectives: "prose-objectives",
  areaDescription: "prose-area",
  completedText: "prose-completed",
  npcOrGoText: "prose-npc-or-go",
  greeting: "prose-greeting",
  requestText: "prose-request",
  offerText: "prose-offer",
  gossipOption: "prose-gossip-option",
  trainerGreeting: "prose-trainer",
  itemDescription: "prose-item-description",
  pageText: "prose-page",
  itemText: "prose-item-text",
  mailBody: "prose-mail-body",
  chat: "prose-chat",
  objectiveText: "prose-objective-row",
} as const;

const N = { quest: "Kobold Camp Cleanup", item: "Worn Shortsword", subject: "Your order", npc: "Marshal McBride" } as const;

/** Every opcode → payload pair, each carrying its prose and a name. */
const CASES: { opcode: string; data: Record<string, unknown>; gone: string[]; keep: string[] }[] = [
  {
    opcode: "SMSG_QUEST_QUERY_RESPONSE",
    data: {
      questId: 7, title: N.quest, objectives: P.objectives, details: P.details, areaDescription: P.areaDescription,
      completedText: P.completedText, requiredNpcOrGo: [{ entry: 6, count: 8, text: P.npcOrGoText }], requiredItems: [],
    },
    gone: [P.objectives, P.details, P.areaDescription, P.completedText, P.npcOrGoText],
    keep: [N.quest],
  },
  {
    opcode: "SMSG_QUESTGIVER_QUEST_LIST",
    data: { guid: "1", greeting: P.greeting, quests: [{ questId: 7, icon: 0, level: 1, title: N.quest }] },
    gone: [P.greeting],
    keep: [N.quest],
  },
  {
    opcode: "SMSG_QUESTGIVER_QUEST_DETAILS",
    data: { guid: "1", questId: 7, title: N.quest, details: P.details, objectives: P.objectives, choiceRewards: [], rewards: [], money: 0, xp: 0 },
    gone: [P.details, P.objectives],
    keep: [N.quest],
  },
  {
    opcode: "SMSG_QUESTGIVER_REQUEST_ITEMS",
    data: { guid: "1", questId: 7, title: N.quest, text: P.requestText, requiredMoney: 0, requiredItems: [], completable: true },
    gone: [P.requestText],
    keep: [N.quest],
  },
  {
    opcode: "SMSG_QUESTGIVER_OFFER_REWARD",
    data: { guid: "1", questId: 7, title: N.quest, text: P.offerText, choiceRewards: [], rewards: [], money: 0, xp: 0 },
    gone: [P.offerText],
    keep: [N.quest],
  },
  {
    opcode: "SMSG_GOSSIP_MESSAGE",
    data: { guid: "1", menuId: 2, textId: 3, options: [{ optionId: 0, icon: 0, text: P.gossipOption }], quests: [{ questId: 7, icon: 0, level: 1, title: N.quest }] },
    gone: [P.gossipOption],
    keep: [N.quest, '"textId":3'],
  },
  {
    opcode: "SMSG_TRAINER_LIST",
    data: { guid: "1", trainerType: 0, spells: [{ spellId: 100, state: 0, cost: 10, reqLevel: 1, reqSkill: 0, reqSkillValue: 0 }], greeting: P.trainerGreeting },
    gone: [P.trainerGreeting],
    keep: ['"spellId":100'],
  },
  {
    opcode: "SMSG_ITEM_QUERY_SINGLE_RESPONSE",
    data: { itemId: 25, name: N.item, description: P.itemDescription, pageText: 4 },
    gone: [P.itemDescription],
    keep: [N.item, '"pageText":4'],
  },
  { opcode: "SMSG_PAGE_TEXT_QUERY_RESPONSE", data: { pageId: 4, text: P.pageText, nextPageId: 0 }, gone: [P.pageText], keep: ['"pageId":4'] },
  { opcode: "SMSG_ITEM_TEXT_QUERY_RESPONSE", data: { found: true, guid: "9", text: P.itemText }, gone: [P.itemText], keep: ['"guid":"9"'] },
  {
    opcode: "SMSG_MAIL_LIST_RESULT",
    data: { total: 1, count: 1, mails: [{ mailId: 1, type: 1, cod: 0, stationery: 0, money: 0, flags: 0, read: false, daysLeft: 1, templateId: 0, subject: N.subject, body: P.mailBody, items: [] }] },
    gone: [P.mailBody],
    keep: [N.subject],
  },
  { opcode: "SMSG_MESSAGECHAT", data: { type: 12, language: 0, senderGuid: "5", message: P.chat, chatTag: 0 }, gone: [P.chat], keep: ['"senderGuid":"5"'] },
];

function check(serialized: string, gone: readonly string[], keep: readonly string[]): void {
  for (const g of gone) expect(serialized).not.toContain(g);
  for (const k of keep) expect(serialized).toContain(k);
}

describe("redactProseValue", () => {
  for (const c of CASES) {
    test(`${c.opcode}: the prose goes, the names stay (wrapped and unwrapped)`, () => {
      const wrapped = JSON.stringify(redactProseValue({ opcode: c.opcode, seq: 1, data: c.data }));
      check(wrapped, c.gone, c.keep);
      expect(wrapped).toContain(REDACTED_PROSE);
      const bare = JSON.stringify(redactProseValue(c.data));
      check(bare, c.gone, c.keep);
    });
  }

  test("the SDK's unwrapped rows: a gossip option, a mail entry, a quest-log objective", () => {
    const out = JSON.stringify(
      redactProseValue({
        menu: { guid: "1", menuId: 2, options: [{ optionId: 1, text: P.gossipOption }], seq: 1, ts: 1 },
        mail: { mailId: 3, subject: N.subject, body: P.mailBody },
        log: [{ slot: 0, questId: 7, title: N.quest, objectives: [{ kind: "kill", entry: 6, text: P.objectiveText, required: 8, have: 3, done: false }] }],
      }),
    );
    check(out, [P.gossipOption, P.mailBody, P.objectiveText], [N.subject, N.quest, '"have":3']);
  });

  test("is pure and leaves unrelated shapes alone", () => {
    const input = { opcode: "SMSG_LOG_XPGAIN", data: { amount: 50, text: "not prose by shape" }, nested: [{ name: N.npc }] };
    const before = JSON.stringify(input);
    const out = redactProseValue(input);
    expect(JSON.stringify(out)).toBe(before);
    expect(JSON.stringify(input)).toBe(before);
    expect(out).not.toBe(input);
  });

  test("every shape with an opcode is in the whole-payload fallback set; every redacted key is a bare key", () => {
    for (const s of PROSE_SHAPES) if (s.opcode !== null) expect(PROSE_OPCODES.has(s.opcode)).toBe(true);
    expect(PROSE_KEYS).toEqual(expect.arrayContaining(["details", "objectives", "greeting", "text", "body", "description", "message"]));
  });
});

describe("redactProseText", () => {
  test("a recent_events line: parsed by opcode, note after the payload kept", () => {
    const line = `#12 SMSG_QUESTGIVER_QUEST_DETAILS ${JSON.stringify(CASES[2]!.data)} — a note`;
    const out = redactProseText(`#11 SMSG_LOG_XPGAIN {"amount":50}\n${line}`);
    check(out, [P.details, P.objectives], [N.quest, "#11 SMSG_LOG_XPGAIN {\"amount\":50}", " — a note"]);
  });

  test("a compacted (unparseable) payload of a prose opcode goes whole; of any other opcode stays", () => {
    const cut = `#3 SMSG_GOSSIP_MESSAGE {"guid":"1","menuId":2,"options":[{"optionId":0,"text":"${P.gossipOption} …`;
    expect(redactProseText(cut)).toBe(`#3 SMSG_GOSSIP_MESSAGE ${REDACTED_PROSE}`);
    const other = `#4 SMSG_UPDATE_OBJECT {"blocks":[{"guid":"1","na …`;
    expect(redactProseText(other)).toBe(other);
    const mismatch = `#5 SMSG_PAGE_TEXT_QUERY_RESPONSE [schema mismatch] {"pageId":1,"text":"${P.pageText} …`;
    expect(redactProseText(mismatch)).toBe(`#5 SMSG_PAGE_TEXT_QUERY_RESPONSE [schema mismatch] ${REDACTED_PROSE}`);
  });

  test("a snippet's => line and a whole-JSON result are parsed; a state summary's chat block is cut", () => {
    const snippet = `ok (3ms)\n=> ${JSON.stringify({ mailId: 1, subject: N.subject, body: P.mailBody })}\n--- console ---\n[log] free text passes`;
    check(redactProseText(snippet), [P.mailBody], [N.subject, "[log] free text passes", "ok (3ms)"]);
    check(redactProseText(JSON.stringify({ found: true, text: P.itemText })), [P.itemText], ['"found":true']);
    const summary = `level 3\nrecent chat (2):\n  <5> ${P.chat}\n  <6> ${P.chat}\nrecent notifications (1):\n  You are now AFK`;
    const out = redactProseText(summary);
    check(out, [P.chat], ["level 3", `  <5> ${REDACTED_PROSE}`, "You are now AFK"]);
  });

  test("a snippet's => value is a JSON string holding JSON, two levels down, with the model's own keys", () => {
    // What the sandbox writes: `=> ` then JSON.stringify(value), where value is
    // the string the model built with its own abbreviations (`op`, `d`).
    const inner = JSON.stringify([{ op: "SMSG_QUESTGIVER_QUEST_DETAILS", d: JSON.stringify({ guid: "1", questId: 313, title: N.quest, details: P.details }) }]);
    const out = redactProseText(`ok (7ms)\n=> ${JSON.stringify(inner)}`);
    check(out, [P.details], [N.quest, "questId", "313"]);
    // And a cut fragment (the model sliced its string): from the prose key on.
    const cut = JSON.stringify(inner.slice(0, inner.indexOf(P.details) + 8));
    const cutOut = redactProseText(`=> ${cut}`);
    check(cutOut, [P.details.slice(0, 8)], [N.quest]);
    expect(cutOut).toContain(REDACTED_PROSE);
    // Console lines get the same treatment.
    check(redactProseText(`[log] ${JSON.stringify({ optionId: 1, text: P.gossipOption })}`), [P.gossipOption], ["[log] {"]);
  });

  test("free text that does not parse passes through: the documented residual", () => {
    const free = `The NPC said: ${P.chat}`;
    expect(redactProseText(free)).toBe(free);
  });
});

describe("redactGameProse", () => {
  test("touches tool results and a raw batch, nothing else; the reference tool goes whole", () => {
    const base = { i: 1, ts: 1, start: 0, end: 1 };
    const result = redactGameProse({ ...base, t: "tool_result", name: "recent_events", text: `#1 SMSG_PAGE_TEXT_QUERY_RESPONSE ${JSON.stringify({ pageId: 1, text: P.pageText, nextPageId: 0 })}` });
    expect(result["text"]).toBe(`#1 SMSG_PAGE_TEXT_QUERY_RESPONSE {"pageId":1,"text":"${REDACTED_PROSE}","nextPageId":0}`);
    const wiki = redactGameProse({ ...base, t: "tool_result", name: "search_reference", text: "wiki prose" });
    expect(wiki["text"]).toBe(REDACTED_PROSE);
    const batch = redactGameProse({ ...base, t: "events_served", events: [{ opcode: "SMSG_MESSAGECHAT", data: { type: 12, language: 0, senderGuid: "5", message: P.chat, chatTag: 0 } }] });
    expect(JSON.stringify(batch)).not.toContain(P.chat);
    // Model-authored text is the model's: verbatim.
    const response = { ...base, t: "response", text: `I read: ${P.details}` };
    expect(redactGameProse(response)).toEqual(response);
    const code = { ...base, t: "snippet", code: `// ${P.details}` };
    expect(redactGameProse(code)).toEqual(code);
  });
});
