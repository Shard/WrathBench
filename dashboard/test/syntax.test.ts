/**
 * The feed's tokenizer (`lib/syntax.ts`): it must never lose or reorder a
 * character, because the highlighted text is the record, and it must survive
 * code cut mid-token by a writer's cap. The classes are checked on the shapes
 * models actually write.
 */

import { describe, expect, test } from "bun:test";
import { compactJson, highlight, isCodePath, prettyResult, tokenize, type SynToken } from "../src/lib/syntax";

const join = (t: readonly SynToken[]): string => t.map(([, s]) => s).join("");
const of = (t: readonly SynToken[], kind: string): string[] => t.filter(([k]) => k === kind).map(([, s]) => s);

const SAMPLES = [
  "await sdk.questGiverStatusQuery(); await sleep(1000);\nconst { acceptAllNearby } = await import(\"./lib/quest\");",
  "if(h.current<h.max*.85){await sdk.castSpell(635);a",
  "const keep = /Hearthstone|Stormpike|Brock/; for (const it of state.bag().items) { if (keep.test(it.name)) continue; }",
  "return JSON.stringify({a, qg: state.units({questGiver:true}).map(u=>[u.name,u.questGiver,Math.round(u.distance)])});",
  "const x = a / b / c; // halves\n/* a block\n comment */ let s = `t ${x} \\` done`;",
  "export async function grind(){\n while(!signal.aborted&&state.self.level.value<6){ wake('dead'); }\n}",
  "const unterminated = \"no end\nconst next = 'also\nx; /* open",
  "x = 0x1F + 1_000 + 1e-3 + .5 + 3.14.toFixed(2) + [...rest]",
  "",
  "é = 'ünïcode' // ✧",
];

describe("tokenize", () => {
  test("joining the tokens gives the text back, whatever it is", () => {
    for (const s of SAMPLES) expect(join(tokenize(s))).toBe(s);
    // Cut at every offset, as a writer's cap might.
    const long = SAMPLES.join("\n");
    for (let n = 0; n <= long.length; n += 7) expect(join(tokenize(long.slice(0, n)))).toBe(long.slice(0, n));
  });

  test("keywords, calls, strings, numbers and comments", () => {
    const t = tokenize(SAMPLES[0]!);
    expect(of(t, "kw")).toEqual(["await", "await", "const", "await", "import"]);
    expect(of(t, "fn")).toEqual(["questGiverStatusQuery", "sleep"]);
    expect(of(t, "num")).toEqual(["1000"]);
    expect(of(t, "str")).toEqual(['"./lib/quest"']);
    const c = tokenize(SAMPLES[4]!);
    expect(of(c, "com")).toEqual(["// halves", "/* a block\n comment */"]);
    expect(of(c, "str")).toEqual(["`t ${x} \\` done`"]);
  });

  test("a less-than is a comparison, a leading-dot number a number", () => {
    const t = tokenize(SAMPLES[1]!);
    expect(of(t, "num")).toEqual([".85", "635"]);
    expect(of(t, "str")).toEqual([]);
  });

  test("a slash is a regex where a value starts, a division after one", () => {
    expect(of(tokenize(SAMPLES[2]!), "str")).toEqual(["/Hearthstone|Stormpike|Brock/"]);
    expect(of(tokenize(SAMPLES[4]!), "str")).toEqual(["`t ${x} \\` done`"]);
    expect(of(tokenize("return /a\\/b/gi.test(x)"), "str")).toEqual(["/a\\/b/gi"]);
  });

  test("a member named like a keyword is not one", () => {
    expect(of(tokenize("state.self.new + x.default"), "kw")).toEqual([]);
    expect(of(tokenize("x = true; y = null"), "lit")).toEqual(["true", "null"]);
  });

  test("an unterminated string ends at its line; an open comment at the text's end", () => {
    const t = tokenize(SAMPLES[6]!);
    expect(of(t, "str")[0]).toBe('"no end');
    expect(of(t, "kw")).toContain("const");
    expect(of(t, "com")).toEqual(["/* open"]);
  });

  test("highlight remembers by text", () => {
    expect(highlight("const a = 1")).toBe(highlight("const a = 1"));
  });
});

describe("what is code", () => {
  test("TypeScript and JavaScript files, and a snippet with no path", () => {
    expect(isCodePath("main.ts")).toBe(true);
    expect(isCodePath("lib/quest.mjs")).toBe(true);
    expect(isCodePath(undefined)).toBe(true);
    expect(isCodePath("notes.md")).toBe(false);
    expect(isCodePath("scratchpad.md")).toBe(false);
  });
});

describe("a snippet's result, its JSON-in-a-string value laid out", () => {
  test("the `=>` value that is JSON written as a string is pretty-printed; the rest is left alone", () => {
    const text = 'ok (7ms)\n=> "[[234,{\\"x\\":1}]]"\n--- since your last snippet ---\nquests: new';
    expect(prettyResult(text)).toBe('ok (7ms)\n=> [[234,{"x":1}]]\n--- since your last snippet ---\nquests: new');
  });

  test("laid out compactly: what fits on a line stays on one", () => {
    const log = { a: [["Talin Keeneye", 183, "The Boar Hunter", "accepted"], ["Talin Keeneye", 234, "Coldridge Valley Mail Delivery", "accepted"]], n: 4 };
    expect(compactJson(log)).toBe(
      ['{', '  "a": [', '    ["Talin Keeneye",183,"The Boar Hunter","accepted"],', '    ["Talin Keeneye",234,"Coldridge Valley Mail Delivery","accepted"]', "  ],", '  "n": 4', "}"].join("\n"),
    );
    expect(compactJson({ x: 1 })).toBe('{"x":1}');
  });

  test("a value that is a plain string, or not JSON inside, is left as it was", () => {
    expect(prettyResult('ok (1ms)\n=> "hello"')).toBeNull();
    expect(prettyResult('ok (1ms)\n=> "{not json"')).toBeNull();
    expect(prettyResult("ok (1ms)\n=> { a: 1 }")).toBeNull();
  });
});
