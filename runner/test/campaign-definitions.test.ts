/**
 * The campaign definitions as data: every file under `runner/campaigns/`
 * parses, is named for what it holds and only starts a character the server
 * creates; and the schema refuses what a definition may not say.
 *
 * There is no hash pin here any more. A published version is held still by the
 * store, which refuses a second publish of the same key with a different hash
 * (`campaign-store.test.ts`), so a file edited after publication cannot reach
 * the fleet under its old name.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { campaignDefinitionSchema, campaignHash, campaignRef, imageRefProblem, issuesOf, type CampaignDefinition } from "../src/campaign-def";
import { campaignPairRefusals, type PairRosterEntry } from "../src/campaigns";
import { rosterEntryRefusal } from "../src/roster-refusal";
import { CAMPAIGNS_DIR, checkedIn, checkedInFiles, definition } from "./fixtures/campaigns";

/**
 * The race/class pairs 3.3.5a creates, from AzerothCore's `playercreateinfo`
 * as the live world database holds it (read 2026-10-09). Death Knight (6) is
 * left out: the server creates one only on an account that already holds a
 * level-55 character, and it starts at 55.
 */
const LEGAL: Record<number, readonly number[]> = {
  1: [1, 2, 4, 5, 8, 9], // Human
  2: [1, 3, 4, 7, 9], // Orc
  3: [1, 2, 3, 4, 5], // Dwarf
  4: [1, 3, 4, 5, 11], // Night Elf
  5: [1, 4, 5, 8, 9], // Undead
  6: [1, 3, 7, 11], // Tauren
  7: [1, 4, 8, 9], // Gnome
  8: [1, 3, 4, 5, 7, 8], // Troll
  10: [2, 3, 4, 5, 8, 9], // Blood Elf
  11: [1, 2, 3, 5, 7, 8], // Draenei
};

describe("the checked-in definitions", () => {
  const files = checkedInFiles();

  test("there are some, and race-probe@1 and class-probe@2 are among them", () => {
    expect(files).toContain("race-probe@1.json");
    expect(files).toContain("class-probe@2.json");
    for (const f of ["compact-window-claude@2.json", "compact-window-codex@2.json", "pi-vs-wrathbench@1.json"]) expect(files).toContain(f);
  });

  test("compact-window @2 is @1 re-pinned: only the version, the note and the one image every arm runs move", () => {
    for (const half of ["claude", "codex"]) {
      const v1 = checkedIn(`compact-window-${half}@1`);
      const v2 = checkedIn(`compact-window-${half}@2`);
      const images = new Set(v2.arms.map((a) => a.image));
      expect(images.size).toBe(1);
      expect([...images][0]).not.toBe(v1.arms[0]!.image);
      const rest = (d: CampaignDefinition) => ({ ...d, version: 0, note: "", arms: d.arms.map((a) => ({ ...a, image: "" })) });
      expect(rest(v2)).toEqual(rest(v1));
    }
  });

  test("pi-vs-wrathbench@1: one pinned arm with no args, so its wrathbench and pi assignments refuse nothing with run pods on", () => {
    const def = checkedIn("pi-vs-wrathbench@1");
    expect(def.arms).toHaveLength(1);
    expect(def.arms[0]!.image).toBe(checkedIn("compact-window-claude@2").arms[0]!.image);
    expect(def.arms[0]!.args).toBeUndefined();
    // The two entries the comparison assigns: one model and endpoint, effort
    // high on both, and pi's 300k window on the pi entry, not on the arm.
    const endpoint = { model: "deepseek-flash", apiBase: "https://api.deepseek.com/v1", apiKeyEnv: "DEEPSEEK_KEY", effort: "high", tier: "t1" };
    const roster: Record<string, PairRosterEntry & typeof endpoint> = { ds: { ...endpoint }, "ds-pi": { ...endpoint, driver: "pi", compactWindow: "300k" } };
    for (const e of Object.values(roster)) expect(rosterEntryRefusal(e, [], {})).toBeNull();
    const c = { name: def.id, version: def.version, arms: def.arms, assignments: [{ model: "ds", runsPerCell: 1 }, { model: "ds-pi", runsPerCell: 1 }] };
    expect(campaignPairRefusals(c, roster, { runPods: "probes", onCluster: true })).toEqual([]);
  });

  test("pi-vs-wrathbench@2 is @1 on e360's clock: only the version, the question, the note, the episode length and the call guard move", () => {
    const v1 = checkedIn("pi-vs-wrathbench@1");
    const v2 = checkedIn("pi-vs-wrathbench@2");
    expect(v2.budget.episodeMs).toBe(6 * 60 * 60 * 1000);
    expect(v2.budget.maxToolCalls).toBe(12000);
    const rest = (d: CampaignDefinition) => ({ ...d, version: 0, question: "", note: "", budget: { ...d.budget, episodeMs: 0, maxToolCalls: 0 } });
    expect(rest(v2)).toEqual(rest(v1));
  });

  for (const file of files) {
    test(`${file} parses, and is named for the id and version it holds`, () => {
      const parsed = campaignDefinitionSchema.safeParse(JSON.parse(readFileSync(join(CAMPAIGNS_DIR, file), "utf8")));
      if (!parsed.success) throw new Error(issuesOf(parsed.error));
      expect(`${campaignRef(parsed.data)}.json`).toBe(file);
    });

    test(`${file}: every cell is a race and class the server creates`, () => {
      const def = campaignDefinitionSchema.parse(JSON.parse(readFileSync(join(CAMPAIGNS_DIR, file), "utf8")));
      for (const c of def.cells) expect(LEGAL[c.race] ?? []).toContain(c.class);
    });
  }
});

describe("what a definition may say", () => {
  const issues = (over: Record<string, unknown>): string => {
    const parsed = campaignDefinitionSchema.safeParse({ ...definition(), ...over });
    return parsed.success ? "" : issuesOf(parsed.error);
  };

  test("at least one arm and one cell; ids unique and safe in a path", () => {
    expect(issues({ arms: [] })).not.toBe("");
    expect(issues({ cells: [] })).not.toBe("");
    expect(issues({ arms: [{ id: "a" }, { id: "a" }] })).toContain("arm a is declared twice");
    expect(issues({ cells: [{ id: "x", race: 1, class: 1 }, { id: "x", race: 1, class: 1 }] })).toContain("cell x is declared twice");
    expect(issues({ arms: [{ id: "a/b" }] })).not.toBe("");
  });

  test("unknown keys are refused, at every level", () => {
    expect(issues({ status: "open" })).not.toBe("");
    expect(issues({ legacy: { unversioned: true } })).not.toBe("");
    expect(issues({ arms: [{ id: "a", flags: [] }] })).not.toBe("");
  });

  test("a multi-arm definition pins every arm's image; one arm may float on the release image", () => {
    expect(issues({ arms: [{ id: "a" }] })).toBe("");
    expect(issues({ arms: [{ id: "a", image: "r.example/wb:t1" }, { id: "b" }] })).toContain("b floats");
    expect(issues({ arms: [{ id: "a" }, { id: "b" }] })).toContain("a, b float");
    expect(issues({ arms: [{ id: "a", image: "r.example/wb:t1" }, { id: "b", image: "r.example/wb:t2" }] })).toBe("");
  });

  test("an arm's args may not name a shape flag, or any flag the supervisor sets", () => {
    for (const flag of ["--objective", "--race", "--max-tool-calls", "--episode-ms", "--effort", "--model", "--ref", "--run-id", "--campaign-file", "--runs-dir"]) {
      expect(issues({ arms: [{ id: "a", args: [flag, "x"] }] })).toContain(flag);
    }
  });

  test("an arm may set the compaction window, once, to a value the runner takes", () => {
    expect(issues({ arms: [{ id: "a", args: ["--compact-window", "200k"] }] })).toBe("");
    expect(issues({ arms: [{ id: "a", args: ["--compact-window", "50k"] }] })).toContain("compactWindow");
    expect(issues({ arms: [{ id: "a", args: ["--compact-window", "200k", "--compact-window", "300k"] }] })).toContain("given twice");
  });

  test("an arm on the release image may carry only flags the release's run.ts reads; an image of its own may carry its own", () => {
    expect(issues({ arms: [{ id: "a", args: ["--wake-on-event", "true"] }] })).toContain("--wake-on-event");
    expect(issues({ arms: [{ id: "a", image: "r.example/wb:branch", args: ["--wake-on-event", "true"] }] })).toBe("");
    expect(issues({ arms: [{ id: "a", command: ["python", "agent.py"], args: ["--anything"] }] })).toBe("");
  });

  test("wikiCoords needs the wiki", () => {
    expect(issues({ wiki: false, wikiCoords: true })).toContain("wikiCoords");
  });
});

describe("image references", () => {
  test("a tag, a digest, or both name a build", () => {
    const digest = `sha256:${"a".repeat(64)}`;
    expect(imageRefProblem("ghcr.io/shard/wrathbench-runner:harness-0.5-931-gabc1234-pr140")).toBeNull();
    expect(imageRefProblem(`ghcr.io/shard/wrathbench-runner@${digest}`)).toBeNull();
    expect(imageRefProblem(`ghcr.io/shard/wrathbench-runner:harness-0.5-931@${digest}`)).toBeNull();
    expect(imageRefProblem("registry.lab:5000/wb/runner:t1")).toBeNull();
  });

  test("an untagged, undigested reference and :latest are refused", () => {
    expect(imageRefProblem("ghcr.io/shard/wrathbench-runner")).toContain("names no build");
    expect(imageRefProblem("ghcr.io/shard/wrathbench-runner:latest")).toContain(":latest");
    expect(imageRefProblem(`ghcr.io/shard/wrathbench-runner:latest@sha256:${"b".repeat(64)}`)).toContain(":latest");
    // A port with no path after it is a tag, and a bare repo:port names nothing.
    expect(imageRefProblem("registry.lab:5000")).toBeNull();
    expect(imageRefProblem("Not A Ref")).toContain("not an image reference");
  });
});

describe("the hash", () => {
  test("is a function of content, not of key order", () => {
    const a = definition();
    const b = Object.fromEntries(Object.entries(a).reverse()) as typeof a;
    expect(Object.keys(b)).not.toEqual(Object.keys(a));
    expect(campaignHash(b)).toBe(campaignHash(a));
    expect(campaignHash(definition({ question: "another" }))).not.toBe(campaignHash(a));
  });
});
