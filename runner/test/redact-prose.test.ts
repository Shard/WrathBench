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
  objectivesText: "prose-objectives-text",
  page1: "prose-page-one",
  page2: "prose-page-two",
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

/**
 * The SDK's own unwrapped objects — what a snippet gets back from a state read
 * or a helper and returns or logs as is. Each carries every text field its
 * type has, and the fields beside them that must survive.
 */
const SDK_CASES: { what: string; value: Record<string, unknown>; gone: string[]; keep: string[] }[] = [
  {
    what: "QuestInfo (state.quests)",
    value: {
      questId: 7, title: N.quest, level: 5, minLevel: 3, objectivesText: P.objectivesText, details: P.details,
      areaDescription: P.areaDescription, completedText: P.completedText,
      requiredNpcOrGo: [{ entry: 6, count: 8, text: P.npcOrGoText }, { entry: 0, count: 0 }],
      requiredItems: [{ itemId: 25, count: 1 }],
    },
    gone: [P.objectivesText, P.details, P.areaDescription, P.completedText, P.npcOrGoText],
    keep: [N.quest, '"minLevel":3', '"entry":6', '"itemId":25'],
  },
  {
    what: "requiredNpcOrGo row on its own",
    value: { entry: 6, count: 8, text: P.npcOrGoText },
    gone: [P.npcOrGoText],
    keep: ['"entry":6', '"count":8'],
  },
  {
    what: "quest-log objective row (QuestObjective)",
    value: { kind: "kill", entry: 6, text: P.objectiveText, required: 8, have: 3, done: false },
    gone: [P.objectiveText],
    keep: ['"kind":"kill"', '"have":3'],
  },
  {
    what: "exploration objective row (its text is the template's areaDescription)",
    value: { kind: "explore", entry: undefined, text: P.areaDescription, required: 1, have: 0, done: false },
    gone: [P.areaDescription],
    keep: ['"kind":"explore"', '"required":1'],
  },
  {
    what: "readItem result (ReadItemResult)",
    value: { ok: true, status: "read", item: { bag: 255, slot: 23, guid: "9", itemId: 25, name: N.item }, pages: [P.page1, P.page2], text: `${P.page1}\n\n${P.page2}` },
    gone: [P.page1, P.page2],
    keep: [N.item, '"status":"read"', '"slot":23'],
  },
  {
    what: "item text (state.itemTexts())",
    value: { guid: "9", itemId: 25, name: N.item, pages: [P.page1, P.page2], complete: true },
    gone: [P.page1, P.page2],
    keep: [N.item, '"complete":true'],
  },
  {
    what: "gossip menu (state.lastGossip)",
    value: { guid: "1", menuId: 2, options: [{ optionId: 0, text: P.gossipOption }], seq: 4, ts: 5 },
    gone: [P.gossipOption],
    keep: ['"menuId":2', '"optionId":0'],
  },
  {
    what: "trainer window (state.lastTrainerList)",
    value: { guid: "1", trainerType: 0, spells: [{ spellId: 100, state: 0, cost: 10 }], greeting: P.trainerGreeting, seq: 4, ts: 5 },
    gone: [P.trainerGreeting],
    keep: ['"spellId":100'],
  },
  {
    what: "item template (ItemInfo)",
    value: { itemId: 25, name: N.item, quality: 1, description: P.itemDescription, pageText: 4, startQuest: 7 },
    gone: [P.itemDescription],
    keep: [N.item, '"pageText":4'],
  },
  {
    what: "mail (MailEntry)",
    value: { mailId: 3, type: 0, senderName: N.npc, subject: N.subject, body: P.mailBody, money: 0, items: [] },
    gone: [P.mailBody],
    keep: [N.subject, N.npc],
  },
  {
    what: "chat line (ChatEntry)",
    value: { seq: 1, ts: 2, type: 12, language: 0, senderGuid: "5", senderName: N.npc, message: P.chat, chatTag: 0 },
    gone: [P.chat],
    keep: [N.npc, '"senderGuid":"5"'],
  },
];

function check(serialized: string, gone: readonly string[], keep: readonly string[]): void {
  for (const g of gone) expect(serialized).not.toContain(g);
  for (const k of keep) expect(serialized).toContain(k);
}

/**
 * What a redaction may change and nothing more: each prose string, as the
 * renderer quoted it, becomes the quoted placeholder. A string holding two of
 * them (`ReadItemResult.text`) goes whole.
 */
function proseReplaced(rendered: string, gone: readonly string[]): string {
  const placeholder = JSON.stringify(REDACTED_PROSE);
  const literal = /"(?:[^"\\\n]|\\.)*"/g;
  return rendered.replace(literal, (lit) => {
    const v = JSON.parse(lit) as string;
    return gone.some((g) => v.includes(g)) ? placeholder : lit;
  });
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
    expect(PROSE_KEYS).toEqual(
      expect.arrayContaining(["details", "objectives", "objectivesText", "greeting", "text", "body", "description", "message", "pages"]),
    );
    for (const k of PROSE_KEYS) expect(k).toMatch(/^[A-Za-z]+$/);
  });

  for (const c of SDK_CASES) {
    test(`the SDK's ${c.what}: every text field goes, every other field passes`, () => {
      const out = JSON.stringify(redactProseValue(c.value));
      check(out, c.gone, c.keep);
      expect(out).toBe(proseReplaced(JSON.stringify(c.value), c.gone));
    });
  }
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

  test("a state.chat entry printed by a snippet keeps its sender's name and loses its words", () => {
    // state.chat now joins a player sender's name on read. A character name
    // is the runner's, not game text ("names and ids stay"); the message goes.
    const entry = { seq: 3, ts: 1, type: 2, language: 7, senderGuid: "9", senderName: "Ordrick", message: P.chat, chatTag: 0 };
    check(redactProseText(`ok (2ms)\n=> ${JSON.stringify([entry])}`), [P.chat], ['"senderName":"Ordrick"', '"senderGuid":"9"']);
  });

  test("the chat block's typed lines are cut the same way, whatever their head", () => {
    // formatStateSummary's line shapes: a type label, then a speaker, an
    // outgoing whisper's recipient, or (system, a filled emote) no speaker.
    const summary =
      `recent chat (5):\n  [party] <Quilby> ${P.chat}\n  [whisper] to <Quilby>: ${P.chat}\n` +
      `  [npc emote] ${P.chat}\n  [General] <Quilby> ${P.chat}\n  [system] ${P.chat}\nrecent notifications (1):\n  You are now AFK`;
    check(redactProseText(summary), [P.chat], [
      `  [party] <Quilby> ${REDACTED_PROSE}`,
      `  [whisper] to <Quilby>: ${REDACTED_PROSE}`,
      `  [npc emote] ${REDACTED_PROSE}`,
      `  [General] <Quilby> ${REDACTED_PROSE}`,
      `  [system] ${REDACTED_PROSE}`,
      "You are now AFK",
    ]);
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

/** What the sandbox writes for a snippet's value and a console object (`mcp/src/sandbox/child.ts`). */
const inspect = (v: unknown): string => Bun.inspect(v, { depth: 4 });

/** A snippet result carrying `v` as its value and as a console object, between harness lines. */
const snippetText = (v: unknown): string =>
  `ok (3ms)\n=> ${inspect(v)}\n--- console ---\n[log] ${inspect(v)}\n[log] free words after`;

describe("redactProseText over the sandbox's rendering (Bun.inspect)", () => {
  for (const c of SDK_CASES) {
    test(`the SDK's ${c.what}, returned and logged: the text goes, every other byte stays`, () => {
      const text = snippetText(c.value);
      const out = redactProseText(text);
      check(out, c.gone, c.keep.map((k) => k.replace(/"(\w+)":/, "$1: ")));
      expect(out).toBe(proseReplaced(text, c.gone));
    });
  }

  for (const c of CASES) {
    test(`${c.opcode}, returned as an event and as its payload: the prose goes, every other byte stays`, () => {
      for (const v of [{ seq: 1, ts: 2, opcode: c.opcode, data: c.data }, c.data]) {
        const text = snippetText(v);
        const out = redactProseText(text);
        for (const g of c.gone) expect(out).not.toContain(g);
        expect(out).toBe(proseReplaced(text, c.gone));
      }
    });
  }

  const quest = SDK_CASES[0]!;

  test("a Map of observed values (state.quests) is read through its wrapper", () => {
    const text = snippetText(new Map([[7, { value: quest.value, seq: 1, ts: 2 }]]));
    expect(text).toContain("Map(1) {");
    expect(redactProseText(text)).toBe(proseReplaced(text, quest.gone));
  });

  test("a value cut at the sandbox's cap: every prose field the cut object got as far as goes, names stay", () => {
    const whole = inspect(quest.value);
    const cut = whole.slice(0, whole.indexOf(P.details) + 6);
    expect(cut).not.toContain("requiredNpcOrGo");
    const out = redactProseText(`ok (3ms)\n=> ${cut}\n--- console ---\n[log] after`);
    check(out, [P.objectivesText, P.details.slice(0, 6)], [N.quest, "minLevel: 3", "--- console ---\n[log] after"]);
  });

  test("objects that match no shape, and JSON a snippet read, come back byte-identical", () => {
    const own = { chars: 10, lines: 2, hits: 1, text: "the model's own words" };
    const file = ["=== package.json ===", JSON.stringify({ name: "x", scripts: { test: "bun test" } }, null, 2)];
    // (A value Bun.inspect puts on ONE line that is also JSON — a short array
    // of strings — keeps the compact JSON reading it has always had.)
    for (const v of [own, { file }, { list: [own, own], n: 1 }]) {
      const text = snippetText(v);
      expect(redactProseText(text)).toBe(text);
    }
  });

  test("a labelled console object, pretty JSON, and JSON inside an inspected string are all read", () => {
    const menu = SDK_CASES.find((c) => c.what.startsWith("gossip menu"))!;
    const labelled = `ok (1ms)\n--- console ---\n[log] menu ${inspect(menu.value)} ×2`;
    expect(redactProseText(labelled)).toBe(proseReplaced(labelled, menu.gone));
    const pretty = `ok (1ms)\n--- console ---\n[log] ${JSON.stringify(quest.value, null, 2)}`;
    expect(redactProseText(pretty)).toBe(proseReplaced(pretty, quest.gone));
    const request = CASES.find((c) => c.opcode === "SMSG_QUESTGIVER_REQUEST_ITEMS")!;
    const nested = `ok (1ms)\n=> ${inspect({ seq: 1, raw: JSON.stringify(request.data) })}`;
    const out = redactProseText(nested);
    check(out, request.gone, [N.quest, "seq: 1"]);
    expect(out.split("\n").length).toBe(nested.split("\n").length);
  });
});

describe("the SDK's option lists", () => {
  const opt = (n: number) => JSON.stringify(`${P.gossipOption}-${n}`);
  const gone = [`${P.gossipOption}-0`, `${P.gossipOption}-1`];

  test("gossipSelect's `[N] \"…\"`, and `N:\"…\"` after `pick one of:` or `Options:`, lose the text and keep the ids", () => {
    const thrown = `error (2ms)\nTypeError: gossipSelect(guid, "x"): no option on the menu currently open for 1 matches. Options are: [0] ${opt(0)}, [1] ${opt(1)}. Pass the exact text.`;
    const out = redactProseText(thrown);
    check(out, gone, ["[0] ", "[1] ", "Pass the exact text."]);
    const taxi = `error (2ms)\nError: showTaxiNodes(1): the menu that opened has no taxi option(s) (gossip icon 2) — is this NPC a flight master (state.units({ role: "flightMaster" }))? Options: 0:${opt(0)} (icon 0), 1:${opt(1)} (icon 3)`;
    check(redactProseText(taxi), gone, ["0:", "(icon 3)"]);
    // The hint as the snippet returned it: the list sits inside a string literal.
    const hint = `the menu that opened has no option(s) mentioning "unlearn" — Pass { option } to pick one of: 0:${opt(0)}, 1:${opt(1)}`;
    const returned = `ok (2ms)\n=> ${inspect({ ok: false, status: "no_option", hint })}`;
    check(redactProseText(returned), gone, ['status: "no_option"', "pick one of: 0:"]);
    check(redactProseText(`ok (2ms)\n=> ${JSON.stringify(JSON.stringify({ ok: false, hint }))}`), gone, ["pick one of"]);
  });

  test("the SDK's name lists share the `id:\"…\"` form and stay: names are kept", () => {
    const names = `error (2ms)\nTypeError: setTarget(guid) got "Kobold", which matches 2 things in view ([17:"${N.npc}", 18:"${N.npc}"])`;
    expect(redactProseText(names)).toBe(names);
  });

  test("an action note's hint loses the option text", () => {
    const base = { i: 1, ts: 1, start: 0, end: 1 };
    const hint = `Pass { option } to pick one of: 0:${opt(0)}, 1:${opt(1)}`;
    const out = redactGameProse({ ...base, t: "actions", actions: [{ ts: 1, action: "resetTalents", status: "no_option", hint }, { ts: 2, action: "say" }] });
    check(JSON.stringify(out), gone, ["resetTalents", "pick one of: 0:"]);
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
