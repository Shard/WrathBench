/**
 * The feed's tokenizer (`lib/syntax.ts`): it must never lose or reorder a
 * character, because the highlighted text is the record, and it must survive
 * code cut mid-token by a writer's cap. And a snippet's result is only laid
 * out when its value really is JSON in a string; anything else is left as
 * recorded.
 */

import { describe, expect, test } from "bun:test";
import { prettyResult, tokenize, type SynToken } from "../src/lib/syntax";

const join = (t: readonly SynToken[]): string => t.map(([, s]) => s).join("");

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
});

describe("a snippet's result", () => {
  test("the `=>` value that is JSON written as a string is laid out; the rest is left alone", () => {
    const text = 'ok (7ms)\n=> "[[234,{\\"x\\":1}]]"\n--- since your last snippet ---\nquests: new';
    expect(prettyResult(text)).toBe('ok (7ms)\n=> [[234, { x: 1 }]]\n--- since your last snippet ---\nquests: new');
    expect(prettyResult('ok (1ms)\n=> "hello"')).toBeNull();
    expect(prettyResult('ok (1ms)\n=> "{not json"')).toBeNull();
    expect(prettyResult("ok (1ms)\n=> { a: 1 }")).toBeNull();
  });
});
