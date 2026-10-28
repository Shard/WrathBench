/**
 * `bun wb inspect audit` end to end but for the container: the host side reads
 * the token from meta.json and hands it on stdin to the committed perl reducer,
 * run here over a fixture audit directory. The token and the file names, which
 * are the token, never reach what is printed.
 */

import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs, parseReduced, run, scrubAudit } from "./inspect-audit";
import { tempDirs } from "./temp-dirs";

const tmp = tempDirs();
const TOKEN = "c0ffee".repeat(10) + "abcd";
const OTHER = "beef".repeat(16);
const RUN = "run-audited";
const SMOKE_A = "smoke-edge-0f1e2d3c-4b5a-4968-8776-655443322110";
const SMOKE_B = `${SMOKE_A}-create`;
const QUEST = "smoke-quest-a1b2c3d4-0000-4000-8000-000000000001";
const QUEST_ITEM = "smoke-quest-item-start-a1b2c3d4-0000-4000-8000-000000000002";
const GROUP_A = "smoke-group-a-b2c3d4e5-0000-4000-8000-0000000000aa";
const GROUP_B = "smoke-group-b-b2c3d4e5-0000-4000-8000-0000000000bb";
const DAY1 = Date.UTC(2030, 0, 1, 23, 59, 0);
const DAY2 = Date.UTC(2030, 0, 2, 0, 1, 0);
const hasPerl = Bun.which("perl") !== null;

function action(ts: number, token: string, payload: object): string {
  return JSON.stringify({ ts, session: token, kind: "action", payload });
}
function event(ts: number, token: string, seq: number, opcode: string, data: object): string {
  return JSON.stringify({ ts, session: token, kind: "event", payload: { seq, opcode, opcodeId: 65281, ts, data } });
}

function fixture(): { runsDir: string; auditDir: string } {
  const root = tmp("inspect-audit-");
  const runsDir = join(root, "runs");
  const auditDir = join(root, "audit");
  mkdirSync(join(runsDir, RUN), { recursive: true });
  mkdirSync(auditDir, { recursive: true });
  writeFileSync(join(runsDir, RUN, "meta.json"), JSON.stringify({ runId: RUN, config: { token: TOKEN, model: "test/model" } }));
  // The undated file from before day files, then two days.
  writeFileSync(join(auditDir, `${TOKEN}.jsonl`), `${action(DAY1 - 60_000, TOKEN, { op: "move_to", x: 1, y: 2, z: 3 })}\n`);
  const day1 = [
    action(DAY1, TOKEN, { op: "move_to", x: 1, y: 2, z: 3 }),
    action(DAY1 + 1, TOKEN, { op: "move_path", moveId: 7, status: "ok", pointCount: 2 }),
    event(DAY1 + 500, TOKEN, 1, "WB_MOVE_RESULT", { moveId: 7, status: "target_off_mesh", nearest: null, note: `echo ${TOKEN}` }),
  ];
  writeFileSync(join(auditDir, `${TOKEN}.2030-01-01.jsonl`), `${day1.join("\n")}\n`);
  const day2 = [
    action(DAY2, TOKEN, { op: "move_to", x: 4, y: 5, z: 6 }),
    event(DAY2 + 400, TOKEN, 2, "WB_MOVE_RESULT", { moveId: 8, status: "arrived", pos: { x: 4, y: 5, z: 6 } }),
    event(DAY2 + 900, TOKEN, 3, "SMSG_UPDATE_OBJECT", { blocks: 1, filler: "u".repeat(50_000) }),
    event(DAY2 + 1000, TOKEN, 4, "WB_MOVE_RESULT", { moveId: 9, status: "arrived", pos: { x: 7, y: 8, z: 9 } }),
  ];
  writeFileSync(join(auditDir, `${TOKEN}.2030-01-02.jsonl`), `${day2.join("\n")}\n`);
  // Another session's file: never counted, never read into what is printed.
  writeFileSync(join(auditDir, `${OTHER}.2030-01-02.jsonl`), `${action(DAY2, OTHER, { op: "move_to", x: 0, y: 0, z: 0 })}\n`);
  // A smoke's two sessions (its fixture create, then its run), interleaved in time.
  writeFileSync(
    join(auditDir, `${SMOKE_A}.2030-01-02.jsonl`),
    `${action(DAY2 + 10, SMOKE_A, { op: "move_edge_drop", moveId: 1, taken: false, reason: "no_edge" })}\n${action(DAY2 + 30, SMOKE_A, { op: "move_edge_drop", moveId: 3, taken: true, note: SMOKE_A })}\n`,
  );
  writeFileSync(join(auditDir, `${SMOKE_B}.2030-01-02.jsonl`), `${action(DAY2 + 20, SMOKE_B, { op: "move_edge_drop", moveId: 2, taken: false, reason: "climb" })}\n`);
  // Two smokes whose names share a prefix: each reads its own alone.
  writeFileSync(join(auditDir, `${QUEST}.2030-01-02.jsonl`), `${action(DAY2, QUEST, { op: "move_to", x: 1, y: 1, z: 1 })}\n`);
  // A party smoke's session whose record names its sibling session's token.
  writeFileSync(join(auditDir, `${GROUP_A}.2030-01-02.jsonl`), `${action(DAY2, GROUP_A, { op: "party_invite", peer: GROUP_B, note: `echo ${GROUP_A}` })}\n`);
  writeFileSync(join(auditDir, `${GROUP_B}.2030-01-02.jsonl`), `${action(DAY2, GROUP_B, { op: "party_invite", peer: GROUP_A })}\n`);
  writeFileSync(join(auditDir, `${QUEST_ITEM}.2030-01-02.jsonl`), `${action(DAY2, QUEST_ITEM, { op: "move_to", x: 2, y: 2, z: 2 })}\n${action(DAY2 + 1, QUEST_ITEM, { op: "move_to", x: 3, y: 3, z: 3 })}\n`);
  return { runsDir, auditDir };
}

async function inspect(argv: string[]): Promise<{ code: number; out: string[]; err: string[] }> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await run(argv, { out: (l) => out.push(l), err: (l) => err.push(l), env: {} }, DAY2 + 60_000);
  return { code, out, err };
}

const F = fixture();
const offline = ["--audit-dir", F.auditDir, "--runs-dir", F.runsDir];

describe.skipIf(!hasPerl)("the reducer, over a fixture audit directory", () => {
  test("counts every record of the run's own files per kind, op or opcode, and status", async () => {
    const r = await inspect([RUN, ...offline]);
    expect(r.code).toBe(0);
    expect(r.out[0]).toContain("3 file(s)");
    expect(r.out[0]).toContain("8 records");
    const row = (re: RegExp): string | undefined => r.out.find((l) => re.test(l));
    expect(row(/^\s+3\s+action\s+move_to\s+-$/)).toBeDefined();
    expect(row(/^\s+2\s+event\s+WB_MOVE_RESULT\s+arrived$/)).toBeDefined();
    expect(row(/^\s+1\s+event\s+WB_MOVE_RESULT\s+target_off_mesh$/)).toBeDefined();
    expect(row(/^\s+1\s+action\s+move_path\s+ok$/)).toBeDefined();
  });

  test("--op and --status give the newest matching records, struck and capped", async () => {
    const r = await inspect([RUN, ...offline, "--op", "WB_MOVE_RESULT", "--last", "2"]);
    expect(r.code).toBe(0);
    expect(r.out[0]).toContain("3 record(s) match op WB_MOVE_RESULT");
    expect(r.out.length).toBe(3);
    expect(r.out[1]).toContain("moveId\":8");
    expect(r.out[2]).toContain("moveId\":9");
    const one = await inspect([RUN, ...offline, "--op", "WB_MOVE_RESULT", "--status", "target_off_mesh", "--width", "400"]);
    expect(one.out.length).toBe(2);
    expect(one.out[1]).toContain("[redacted]");
    const big = await inspect([RUN, ...offline, "--op", "SMSG_UPDATE_OBJECT"]);
    for (const l of big.out) expect(l.length).toBeLessThanOrEqual(200);
  });

  test("--summary with --op counts the verdicts of those ops alone", async () => {
    const r = await inspect([RUN, ...offline, "--summary", "--op", "move_path,WB_MOVE_RESULT"]);
    expect(r.out[0]).toContain("4 match op move_path,WB_MOVE_RESULT");
    const rows = r.out.slice(2);
    expect(rows.length).toBe(3);
    expect(rows.some((l) => /^\s+2\s+event\s+WB_MOVE_RESULT\s+arrived$/.test(l))).toBe(true);
    expect(rows.some((l) => l.includes("move_to"))).toBe(false);
  });

  test("--since skips the older day files and records", async () => {
    const r = await inspect([RUN, ...offline, "--since", String(DAY2)]);
    // The undated file is always read (it says nothing about its days); its record is older.
    expect(r.out[0]).toContain("2 file(s)");
    expect(r.out[0]).toContain("4 records");
    const until = await inspect([RUN, ...offline, "--until", String(DAY1 + 10)]);
    expect(until.out[0]).toContain("3 records");
  });

  test("never prints the token or a file name, in any mode", async () => {
    for (const extra of [[], ["--op", "WB_MOVE_RESULT"], ["--op", "move_to", "--last", "50"], ["--op", "WB_MOVE_RESULT", "--status", "target_off_mesh"], ["--summary", "--op", "move_to"]]) {
      const r = await inspect([RUN, ...offline, ...extra]);
      const all = [...r.out, ...r.err].join("\n");
      expect(all).not.toContain(TOKEN);
      expect(all).not.toContain(TOKEN.slice(0, 24));
      expect(all).not.toContain(OTHER);
      expect(all).not.toContain(".jsonl");
    }
  });

  test("--smoke reads every session a smoke named, newest last across them, every token struck", async () => {
    const r = await inspect(["--smoke", "edge", "--audit-dir", F.auditDir, "--op", "move_edge_drop", "--last", "2", "--width", "400"]);
    expect(r.code).toBe(0);
    expect(r.out[0]).toContain("audit smoke-edge");
    expect(r.out[0]).toContain("3 record(s) match op move_edge_drop, of 3 in 2 file(s)");
    expect(r.out.length).toBe(3);
    expect(r.out[1]).toContain('"moveId":2');
    expect(r.out[1]).toContain('"reason":"climb"');
    expect(r.out[2]).toContain('"moveId":3');
    const all = [...r.out, ...r.err].join("\n");
    expect(all).not.toContain(SMOKE_A.slice("smoke-edge-".length, "smoke-edge-".length + 8));
    expect(all).not.toContain(TOKEN);
    expect(all).not.toContain(".jsonl");
    // Another smoke's name reads none of these.
    const none = await inspect(["--smoke", "steep", "--audit-dir", F.auditDir]);
    expect(none.out[0]).toContain("0 file(s)");
  });

  test("--smoke strikes every smoke token in a record, a sibling session's included", async () => {
    const r = await inspect(["--smoke", "group-a", "--audit-dir", F.auditDir, "--op", "party_invite", "--width", "400"]);
    expect(r.code).toBe(0);
    expect(r.out[0]).toContain("audit smoke-group-a");
    expect(r.out[0]).toContain("1 record(s) match op party_invite, of 1 in 1 file(s)");
    const all = [...r.out, ...r.err].join("\n");
    expect(all).not.toContain("b2c3d4e5");
    expect(all).not.toContain(GROUP_B);
    expect(r.out[1]).toContain('"peer":"[redacted]"');
    const summary = await inspect(["--smoke", "group-b", "--audit-dir", F.auditDir]);
    expect(summary.out[0]).toContain("audit smoke-group-b");
    expect(summary.out.join("\n")).not.toContain("b2c3d4e5");
  });

  test("--smoke matches the name exactly, hyphens included: quest is not quest-item-start", async () => {
    const quest = await inspect(["--smoke", "quest", "--audit-dir", F.auditDir, "--op", "move_to"]);
    expect(quest.out[0]).toContain("1 record(s) match op move_to, of 1 in 1 file(s)");
    const item = await inspect(["--smoke", "quest-item-start", "--audit-dir", F.auditDir, "--op", "move_to"]);
    expect(item.out[0]).toContain("2 record(s) match op move_to, of 2 in 1 file(s)");
    const all = [...quest.out, ...item.out].join("\n");
    expect(all).not.toContain("a1b2c3d4");
  });

  test("a run with no meta.json, or one naming no token, is refused before anything runs", async () => {
    expect((await inspect(["run-missing", ...offline])).code).toBe(1);
    mkdirSync(join(F.runsDir, "run-tokenless"), { recursive: true });
    writeFileSync(join(F.runsDir, "run-tokenless", "meta.json"), JSON.stringify({ runId: "run-tokenless", config: {} }));
    const r = await inspect(["run-tokenless", ...offline]);
    expect(r.code).toBe(1);
    expect(r.err.join("\n")).toContain("names no session token");
  });
});

describe("the host side", () => {
  test("the token reaches the reducer on stdin only: its argv is the mode and filters", () => {
    const src = readFileSync(join(import.meta.dir, "inspect-audit.ts"), "utf8");
    expect(src).toContain("stdin: new TextEncoder().encode(`${token}\\n`)");
    const code = readFileSync(join(import.meta.dir, "inspect-audit.pl"), "utf8")
      .split("\n")
      .filter((l) => !/^\s*#/.test(l))
      .join("\n");
    expect(code).toContain("my $tok = <STDIN>;");
    // No child process, so no command line that could carry a file name.
    expect(/\b(system|exec|qx|fork)\b|`|open\([^)]*\|/.test(code)).toBe(false);
  });

  test("scrubbing strikes the token and any session field", () => {
    const line = `{"ts":1,"session":"${OTHER}","kind":"event","payload":{"x":"${TOKEN}"}}`;
    const s = scrubAudit(line, TOKEN);
    expect(s).not.toContain(TOKEN);
    expect(s).not.toContain(OTHER);
  });

  test("the reducer's output parses back", () => {
    const r = parseReduced("F\t2\t100\nR\t5\t1\t9\nC\tevent\tWB_MOVE_RESULT\tarrived\t3\nM\t1\nL\t{\"ts\":1}\n");
    expect(r).toMatchObject({ files: 2, bytes: 100, records: 5, first: 1, last: 9, matched: 1 });
    expect(r.counts).toEqual([{ kind: "event", name: "WB_MOVE_RESULT", status: "arrived", n: 3 }]);
    expect(r.lines).toEqual(['{"ts":1}']);
  });

  test("arguments: --k8s picks the cluster, a filter is a bare name, --status needs --op", () => {
    expect(parseArgs(["--k8s", RUN], 0)).toMatchObject({ target: "k8s", runId: RUN, op: null, summary: true });
    expect(parseArgs([RUN, "--op", "move_to,face"], 0)).toMatchObject({ op: "move_to,face", summary: false });
    expect(parseArgs([RUN], 0)).toMatchObject({ target: "compose" });
    expect("error" in parseArgs([RUN, "--op", "a;b"], 0)).toBe(true);
    expect("error" in parseArgs([RUN, "--status", "ok"], 0)).toBe(true);
    expect("error" in parseArgs(["../x"], 0)).toBe(true);
    expect(parseArgs(["--smoke", "edge"], 0)).toMatchObject({ smoke: "edge", runId: "smoke-edge" });
    expect("error" in parseArgs(["--smoke", "Edge-1"], 0)).toBe(true);
    expect(parseArgs(["--smoke", "chest-loot"], 0)).toMatchObject({ smoke: "chest-loot", runId: "smoke-chest-loot" });
    expect("error" in parseArgs(["--smoke", "chest--loot"], 0)).toBe(true);
    expect("error" in parseArgs(["--smoke", "loot-"], 0)).toBe(true);
    expect("error" in parseArgs(["--smoke", "edge", RUN], 0)).toBe(true);
  });
});
