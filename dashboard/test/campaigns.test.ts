/**
 * The campaigns page's words, over a fixture `/api/campaigns` body
 * (`fixtures/campaigns.ts`): state labels, progress, the grid's header spans
 * and squares, where a square leads, the arm comparison's cells and the shape
 * summary.
 *
 * The page renders straight off these functions, so asserting on them is
 * asserting on what it shows (dashboard/README.md keeps the components out of
 * the tests and the maths in here). Two source checks close the file: the page
 * must not lean on what the public projection omits, and must not go back to
 * joining other feeds for what the campaign API already says.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { CampaignView, Square } from "../../runner/viewer/api-types";
import {
  argvText,
  armRowText,
  armTitle,
  assignmentLabel,
  assignmentTitle,
  assignmentsText,
  assignmentsTitle,
  buildsText,
  campaignHref,
  clockText,
  columnGroups,
  columnLabel,
  findCampaign,
  gridRows,
  imageTitle,
  endGoal,
  medianTitle,
  progressText,
  progressTitle,
  refusalsFor,
  selectedSquare,
  shortImage,
  sourceText,
  squareClass,
  squareHref,
  squareText,
  squareTitle,
  stateClass,
  stateTitle,
  terminationMix,
  truncate,
  wikiText,
  type CampaignState,
} from "../src/lib/campaigns";
import { CAMPAIGNS, square } from "./fixtures/campaigns";

const WAKE: CampaignView = CAMPAIGNS.campaigns[0]!;
const SIDE: CampaignView = CAMPAIGNS.campaigns[1]!;

describe("routes", () => {
  test("a campaign's page is its id and version, and the route finds it again", () => {
    expect(campaignHref(WAKE)).toBe("/campaigns/wake-probe/1");
    expect(findCampaign(CAMPAIGNS, "wake-probe", "1")).toBe(WAKE);
    expect(findCampaign(CAMPAIGNS, "side-probe", "2")).toBe(SIDE);
  });

  test("another version of a published id, or an unknown id, is not published", () => {
    expect(findCampaign(CAMPAIGNS, "wake-probe", "2")).toBeUndefined();
    expect(findCampaign(CAMPAIGNS, "nope", "1")).toBeUndefined();
  });

  test("an id that needs escaping survives the round trip", () => {
    expect(campaignHref({ id: "a b/c", version: 3 })).toBe("/campaigns/a%20b%2Fc/3");
  });
});

describe("state", () => {
  test("every state has a class and a hover; only motion is vivid", () => {
    const states: CampaignState[] = ["running", "queued", "complete", "disabled", "unassigned"];
    expect(states.map(stateClass)).toEqual(["ok", "", "ok-muted", "warn", "dim"]);
    for (const s of states) expect(stateTitle(s).length).toBeGreaterThan(0);
  });
});

describe("progress", () => {
  test("done of wanted and what the cap settled, with the attempts and the live runs in the hover", () => {
    expect(progressText(WAKE.progress)).toBe("5/12 · 1 capped");
    expect(progressTitle(WAKE.progress)).toBe(
      "5 of 12 counted runs done · 7 attempted · 1 capped: settled by the attempt cap without the runs owed · 1 live",
    );
    expect(progressText({ ...WAKE.progress, capped: 0 })).toBe("5/12");
  });

  test("a complete campaign short of its count says what the cap settled, so it does not read as stalled", () => {
    const done: CampaignView = { ...WAKE, state: "complete", progress: { want: 12, done: 10, attempted: 14, capped: 2, live: 0 } };
    expect(stateClass(done.state)).toBe("ok-muted");
    expect(progressText(done.progress)).toBe("10/12 · 2 capped");
  });

  test("a campaign that wants nothing shows a dash, not 0/0", () => {
    expect(progressText(SIDE.progress)).toBe("—");
    expect(progressText({ ...SIDE.progress, done: 2 })).toBe("2");
    expect(progressTitle(SIDE.progress)).toBe("0 of 0 counted runs done · 0 attempted");
  });
});

describe("the index row", () => {
  test("a long question is cut with an ellipsis; a short one is left alone", () => {
    const cut = truncate(WAKE.question, 40);
    expect(cut.length).toBeLessThanOrEqual(40);
    expect(cut.endsWith("…")).toBe(true);
    expect(WAKE.question.startsWith(cut.slice(0, -1))).toBe(true);
    expect(truncate(SIDE.question, 40)).toBe("Short question?");
    expect(truncate("  two\n lines ", 40)).toBe("two lines");
  });

  test("assignments read as roster names, and a missing row is a dash", () => {
    expect(assignmentsText(WAKE)).toBe("sonnet-low, flash");
    expect(assignmentsTitle(WAKE)).toBe("sonnet-low · anthropic/claude-sonnet-5.5 · 1/cell\nflash · vendor/flash-model:free · 1/cell");
    expect(assignmentsText(SIDE)).toBe("—");
    expect(assignmentsText({ config: { enabled: true, account: null, assignments: [] } })).toBe("none");
  });
});

describe("arms", () => {
  test("an image loses its registry path and keeps its tag; a digest is cut to twelve digits", () => {
    expect(shortImage(WAKE.arms[0]!.image)).toBe("runner:harness-0.5-920-gaaaaaaa");
    expect(shortImage(WAKE.arms[1]!.image)).toBe("runner@sha256:0123456789ab");
    expect(shortImage("runner:t@sha256:" + "f".repeat(64))).toBe("runner:t@sha256:ffffffffffff");
    expect(imageTitle(WAKE.arms[1]!.image)).toBe(WAKE.arms[1]!.image!);
  });

  test("an arm with no image runs the release image, and says so", () => {
    expect(shortImage(null)).toBe("release");
    expect(imageTitle(null)).toBe("the fleet's release image at launch");
  });

  test("args read as one line, quoting what would not split back; none is a dash", () => {
    expect(argvText(WAKE.arms[1]!.args)).toBe("--wake-on-event --wake-cap 5m");
    expect(argvText(["--note", "two words", ""])).toBe('--note "two words" ""');
    expect(argvText([])).toBe("—");
    expect(argvText(null)).toBe("—");
  });

  test("an arm's hover carries its note, image and args", () => {
    expect(armTitle(WAKE.arms[1])).toBe(`branch build, wake on\n${WAKE.arms[1]!.image}\n--wake-on-event --wake-cap 5m`);
    expect(armTitle(SIDE.arms[0])).toBe("the fleet's release image at launch");
    expect(armTitle(undefined)).toBe("");
  });
});

describe("the grid", () => {
  test("columns group by assignment, one header over each assignment's arms", () => {
    const groups = columnGroups(WAKE.columns);
    expect(groups.map((g) => [g.ref, g.span])).toEqual([
      ["sonnet-low", 2],
      ["flash", 2],
    ]);
    expect(columnLabel(groups[0]!.first)).toBe("claude-sonnet-5.5 · low");
    expect(columnLabel(groups[1]!.first)).toBe("flash-model (free)");
    expect(assignmentTitle(groups[0]!.first)).toBe("sonnet-low · anthropic/claude-sonnet-5.5 · effort low · claude-code");
  });

  test("a ref served again later gets a second heading rather than being moved", () => {
    const [a, b, c] = [WAKE.columns[0]!, WAKE.columns[2]!, WAKE.columns[1]!];
    expect(columnGroups([a, b, c]).map((g) => [g.ref, g.span])).toEqual([
      ["sonnet-low", 1],
      ["flash", 1],
      ["sonnet-low", 1],
    ]);
    expect(columnGroups([])).toEqual([]);
  });

  test("rows keep the definition's cell order and match squares by column key, not position", () => {
    const rows = gridRows(WAKE);
    expect(rows.map((r) => [r.cell.id, r.start])).toEqual([
      ["north", "Dwarf Warrior"],
      ["south", "Orc Warrior"],
      ["east", "Blood Elf Rogue"],
    ]);
    // `south` was served out of order; its first column is still sonnet-low|control.
    expect(rows[1]!.squares.map((s) => s?.column)).toEqual(WAKE.columns.map((c) => c.key));
    expect(rows[1]!.squares[0]!.mismatchedStart).toBe(1);
    // `east` has no row: four gaps.
    expect(rows[2]!.squares).toEqual([null, null, null, null]);
  });

  test("a campaign with no columns has rows with no squares", () => {
    expect(gridRows(SIDE)).toEqual([{ cell: SIDE.cells[0]!, start: "Human Paladin", squares: [] }]);
  });
});

describe("a square", () => {
  const rows = gridRows(WAKE);
  const [reached, several, short, live] = rows[0]!.squares;
  const [mismatched, capped, owed, refused] = rows[1]!.squares as [Square, Square, Square, Square];

  test("with a stop level it reads reached/counted and the median minutes to it", () => {
    expect(squareText(reached!, "L5")).toBe("1/1 41m");
    expect(squareClass(reached!, "L5")).toBe("right mono ok");
    expect(squareTitle(reached!, "L5")).toBe(
      "1 of 1 counted run reached L5 · 41/41/41 min to L5 (min/median/max) · best L5 · $1.25 billed · 1 counted run wanted\nbuild 0.5-920-gaaaaaaa",
    );
  });

  test("runs that did not count are named in the hover", () => {
    expect(squareText(several!, "L5")).toBe("1/1 38m");
    expect(squareTitle(several!, "L5")).toContain("1 not counted");
  });

  test("a counted run short of the stop level is plain, not green", () => {
    expect(squareText(short!, "L5")).toBe("0/1");
    expect(squareClass(short!, "L5")).toBe("right mono");
    expect(squareTitle(short!, "L5")).toContain("best L3");
  });

  test("a square whose only run is live says nothing itself, and its hover says live", () => {
    expect(squareText(live!, "L5")).toBe("");
    expect(squareClass(live!, "L5")).toBe("right mono dim");
    expect(squareTitle(live!, "L5")).toBe("0 of 0 counted runs reached L5 · 1 live");
  });

  test("a run started as another start is starred and named", () => {
    expect(squareText(mismatched, "L5")).toBe("1/1 52m*");
    expect(squareTitle(mismatched, "L5")).toContain("1 ran as another start");
  });

  test("a square that spent its attempts without a counted run says capped, and is still a way into its runs", () => {
    expect(squareText(capped, "L5")).toBe("capped");
    expect(squareClass(capped, "L5")).toBe("right mono dim");
    expect(squareTitle(capped, "L5")).toBe(
      "0 of 0 counted runs reached L5 · best L3 · 2 not counted · capped: its attempts are spent without the counted runs it wanted · 1 counted run wanted\nbuild 0.5-921-gbbbbbbb",
    );
    expect(squareHref(WAKE, "south", capped)).toBe("/campaigns/wake-probe/1?cell=south&column=sonnet-low%7Cwake");
    // Capped with a counted run short of its want keeps its figure.
    expect(squareText({ ...capped, counted: 1 }, "L5")).toBe("0/1");
  });

  test("a refused pair's square says refused, with the reason first in its hover", () => {
    expect(squareText(refused, "L5")).toBe("refused");
    expect(squareClass(refused, "L5")).toBe("right mono err");
    expect(squareTitle(refused, "L5")).toBe("refused: compact window 100k clashes with the arm's --compact-window 50k");
    // One that ran before the refusal keeps its figures, and the hover leads with why.
    const ran = { ...refused, runs: 1, counted: 1, reached: 1, bestLevel: 5 };
    expect(squareText(ran, "L5")).toBe("1/1");
    expect(squareClass(ran, "L5")).toBe("right mono ok");
    expect(squareTitle(ran, "L5").split("\n")[0]).toBe("refused: compact window 100k clashes with the arm's --compact-window 50k");
  });

  test("owed, gap, and no-stop-level squares", () => {
    expect(squareText(owed, "L5")).toBe("·");
    expect(squareTitle(owed, "L5")).toBe("owed: 1 counted run wanted");
    expect(squareTitle(square("x"), "L5")).toBe("owed, not run yet");
    expect(squareText(null, "L5")).toBe("");
    expect(squareClass(null, "L5")).toBe("right mono dim");
    expect(squareText(square("x", { runs: 1, counted: 1, bestLevel: 7 }), null)).toBe("L7");
    // A kill end reads like a level end: reached of counted, green once reached.
    const kill = endGoal({ stopAtLevel: null, end: [{ kill: { entry: 639 } }] });
    expect(kill).toBe("the kill of entry 639");
    const party = square("x", { runs: 1, counted: 1, reached: 1, bestLevel: 20, want: 1, settled: "done" });
    expect(squareText(party, kill)).toBe("1/1");
    expect(squareClass(party, kill)).toBe("right mono ok");
    expect(squareTitle(party, kill)).toContain("1 of 1 counted run reached the kill of entry 639");
    expect(endGoal({ stopAtLevel: 10, end: [{ level: 10 }, { kill: { entry: 639 } }] })).toBe("L10 or the kill of entry 639");
    expect(endGoal({ stopAtLevel: 5 })).toBe("L5");
    expect(endGoal({ stopAtLevel: null, end: [] })).toBeNull();
    expect(squareText(square("x", { runs: 1, counted: 1, mismatchedStart: 1 }), null)).toBe("—*");
    expect(squareTitle(square("x", { runs: 1, counted: 1, bestLevel: 7 }), null)).toBe("best L7");
  });

  test("several builds are listed in the hover", () => {
    const sq = square("x", { runs: 2, counted: 2, builds: ["harness-0.5-920", "harness-0.5-921"] });
    expect(squareTitle(sq, null).split("\n")[1]).toBe("builds 0.5-920, 0.5-921");
  });
});

describe("where a square leads", () => {
  const rows = gridRows(WAKE);

  test("one run is that run's page, live or not", () => {
    expect(squareHref(WAKE, "north", rows[0]!.squares[0]!)).toBe("/run/fleet-wake-probe-north-sonnet-low-20261011");
    expect(squareHref(WAKE, "north", rows[0]!.squares[3]!)).toBe("/run/fleet-wake-probe-north-flash-20261011-w");
  });

  test("several runs are a list on the campaign's page", () => {
    const href = squareHref(WAKE, "north", rows[0]!.squares[1]!)!;
    expect(href).toBe("/campaigns/wake-probe/1?cell=north&column=sonnet-low%7Cwake");
    const q = new URLSearchParams(href.split("?")[1]);
    const sel = selectedSquare(WAKE, q.get("cell") ?? undefined, q.get("column") ?? undefined)!;
    expect(sel.cell).toBe("north");
    expect(sel.column.arm).toBe("wake");
    expect(sel.square.runIds).toHaveLength(2);
  });

  test("no run is nowhere, and a query naming no such square selects nothing", () => {
    expect(squareHref(WAKE, "south", rows[1]!.squares[2]!)).toBeNull();
    expect(squareHref(WAKE, "east", null)).toBeNull();
    expect(selectedSquare(WAKE, undefined, undefined)).toBeNull();
    expect(selectedSquare(WAKE, "north", "nope")).toBeNull();
    expect(selectedSquare(WAKE, "south", "flash|control")).toBeNull();
  });
});

describe("the arm comparison", () => {
  test("per assignment, each arm's medians to the stop level, its endings and its builds", () => {
    const [control, wake] = WAKE.comparison[0]!.arms;
    expect(armRowText(control!)).toEqual({
      runs: "2",
      reached: "2",
      minutes: "47m",
      turns: "213",
      cost: "$1.10*",
      costTitle: "* 2 of the figures behind this median are a subscription's as-if-metered cost, which nobody was billed",
      promptTokens: "1.84M",
      terminations: "level-target 2",
      builds: "0.5-920-gaaaaaaa",
    });
    expect(armRowText(wake!).terminations).toBe("adapter-error 1 · level-target 1");
    // A metered arm's median carries no mark.
    expect([armRowText(wake!).cost, armRowText(wake!).costTitle]).toEqual(["$0.900", ""]);
  });

  test("an arm with no runs reads dashes, not zeros dressed as medians", () => {
    expect(armRowText(WAKE.comparison[1]!.arms[1]!)).toEqual({
      runs: "0",
      reached: "0",
      minutes: "—",
      turns: "—",
      cost: "—",
      costTitle: "",
      promptTokens: "—",
      terminations: "—",
      builds: "—",
    });
  });

  test("endings sort by count then name", () => {
    expect(terminationMix({ b: 1, a: 1, c: 3 })).toBe("c 3 · a 1 · b 1");
    expect(buildsText([])).toBe("—");
  });

  test("a group's heading is its assignment's column label", () => {
    expect(assignmentLabel(WAKE, "flash")).toEqual({ label: "flash-model (free)", title: "flash · vendor/flash-model:free" });
    expect(assignmentLabel(WAKE, "gone")).toEqual({ label: "gone", title: "gone" });
  });

  test("the median headings say what they are over", () => {
    expect(medianTitle("turns", 5)).toBe("median turns to L5, over the runs that reached it");
    expect(medianTitle("turns", null)).toBe("median turns: this campaign sets no stop level");
  });
});

describe("refusals and the definition's source", () => {
  test("a campaign's page lists its own pairs, its definition and its id's store row, nothing else", () => {
    const body = {
      refused: [
        ...CAMPAIGNS.refused,
        { key: "campaign-defs/wake-probe@1", reason: "hash mismatch" },
        { key: "campaigns/wake-probe", reason: "unknown key" },
        { key: "wake-probe@10:flash:wake", reason: "another version" },
        { key: "campaign-defs/wake-probe@10", reason: "another version" },
      ],
    };
    expect(refusalsFor(body, WAKE).map((r) => r.key)).toEqual([
      "wake-probe@1:flash:wake",
      "campaign-defs/wake-probe@1",
      "campaigns/wake-probe",
    ]);
    expect(refusalsFor(CAMPAIGNS, SIDE)).toEqual([]);
  });

  test("the source reads path, short commit and the branches that held it", () => {
    expect(sourceText(WAKE.source)).toBe("runner/campaigns/wake-probe@1.json @ 01234567 (master)");
    expect(sourceText({ commit: "abcdef0123", path: "p.json" })).toBe("p.json @ abcdef01");
    expect(sourceText(null)).toBe("—");
  });
});

describe("the shape summary", () => {
  test("the clock and the wiki channel", () => {
    expect(clockText(WAKE.shape)).toBe("4h00m play · 20m00s idle · no-xp off");
    expect(clockText(SIDE.shape)).toBe("1h00m play · 10m00s idle · 15m00s no-xp");
    expect(wikiText(WAKE.shape)).toBe("on");
    expect(wikiText({ wiki: true, wikiCoords: true })).toBe("on · coords");
    expect(wikiText(SIDE.shape)).toBe("off");
  });
});

describe("the page's sources", () => {
  const SRC = join(import.meta.dir, "..", "src");
  const page = readFileSync(join(SRC, "pages", "Campaigns.tsx"), "utf8");
  const lib = readFileSync(join(SRC, "lib", "campaigns.ts"), "utf8");

  test("nothing reads the store row's account, which the public projection omits", () => {
    for (const src of [page, lib]) expect(src).not.toMatch(/\.account\b/);
  });

  test("live state comes from the campaign API, never a join against the runs or fleet feeds", () => {
    expect(page).not.toMatch(/api\.runs\(|api\.fleet\(|useFeeds/);
    expect(page).toContain("api.campaigns()");
  });
});
