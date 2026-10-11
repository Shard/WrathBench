/**
 * A fresh probe launch: the rule that a `probing` run exists only as a cell of
 * a published, versioned campaign definition, carried to the run as its
 * campaign file, and the shape that file hands the run.
 *
 * Asserted through `configFromArgs`, the whole fresh-launch seam, because that
 * is what every launch path — the fleet's roster, run-episode.sh, a kubectl
 * exec, a run pod on another image — ends in.
 */

import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { campaignFileOf, writeCampaignFile } from "../src/campaign-file";
import { CampaignLaunchError, PROBE_SHAPE_FLAGS } from "../src/campaign-launch";
import { loadRunConfig } from "../src/config";
import { configFromArgs } from "../src/run";
import { checkedIn, definition, joined } from "./fixtures/campaigns";
import { tempDirs } from "./fixtures/temp-dirs";

const tempDir = tempDirs();
const MODEL = ["--driver", "openai", "--model", "deepseek/deepseek-v4.1-flash"];

const race = checkedIn("race-probe@1");
const steered = definition({
  id: "nav",
  objective: "Travel to Ironforge and keep a log.",
  stopAtLevel: null,
  wikiCoords: true,
  budget: { episodeMs: 21_600_000, idleMs: 1_200_000, noXpMs: null, maxToolCalls: 2500 },
  cells: [{ id: "coldridge", race: 3, class: 2 }],
});
const pinned = definition({
  id: "pinned",
  arms: [
    { id: "a", image: "registry.example/wb/runner:t1" },
    { id: "b", image: "registry.example/wb/runner:t2", args: ["--compact-window", "200k"] },
  ],
});
const { definitions } = joined([race, steered, pinned], {});
const pub = (ref: string): (typeof definitions)[number] => definitions.find((d) => d.ref === ref)!;

/** A campaign file on disk for one square. */
function fileFor(ref: string, cell: string, arm?: string): string {
  return writeCampaignFile(tempDir("wb-launch-"), campaignFileOf(pub(ref), cell, arm));
}

function refused(argv: string[], env: Record<string, string> = {}): string {
  try {
    configFromArgs([...MODEL, ...argv], env);
  } catch (err) {
    expect(err).toBeInstanceOf(CampaignLaunchError);
    return (err as Error).message;
  }
  throw new Error(`launch was accepted: ${argv.join(" ")}`);
}

describe("what a fresh probe launch must name", () => {
  test("--episode probing alone is refused: a probe is a cell of a published campaign", () => {
    expect(refused(["--episode", "probing"])).toContain("--campaign-file");
  });

  test("a campaign file is a probe: another episode is refused, and so is a ref without one", () => {
    expect(refused(["--episode", "e90", "--campaign-file", fileFor("race-probe@1", "orc-warrior")])).toContain("--episode probing");
    expect(refused(["--ref", "codex-sol-61"])).toContain("--campaign-file");
  });

  test("a missing or unreadable file is refused, naming it", () => {
    expect(refused(["--campaign-file", "/nonexistent/campaign.json"])).toContain("/nonexistent/campaign.json");
    const bad = join(tempDir("wb-launch-bad-"), "campaign.json");
    writeFileSync(bad, "{");
    expect(refused(["--campaign-file", bad])).toContain(bad);
  });

  test("a file that disagrees with itself is refused: its hash, its cell and its arm are the definition's own", () => {
    const f = campaignFileOf(pub("race-probe@1"), "orc-warrior");
    const write = (doc: unknown): string => {
      const p = join(tempDir("wb-launch-edit-"), "campaign.json");
      writeFileSync(p, JSON.stringify(doc));
      return p;
    };
    expect(refused(["--campaign-file", write({ ...f, hash: "sha256:0000000000000000" })])).toContain("hashes to");
    expect(refused(["--campaign-file", write({ ...f, cell: { ...f.cell, class: 2 } })])).toContain("cell");
    expect(refused(["--campaign-file", write({ ...f, arm: { id: "other" } })])).toContain("arm");
  });

  test("every flag that would set part of the shape is refused, each by name", () => {
    const values: Record<(typeof PROBE_SHAPE_FLAGS)[number], string> = {
      objective: "reach level 10",
      race: "1",
      class: "1",
      "wiki-coords": "true",
      wiki: "false",
      "max-tool-calls": "100",
      "idle-ms": "60000",
      "no-xp-ms": "0",
      "episode-ms": "60000",
      "watchdogs-json": "{}",
    };
    const file = fileFor("race-probe@1", "orc-warrior");
    for (const f of PROBE_SHAPE_FLAGS) expect(refused(["--campaign-file", file, `--${f}`, values[f]])).toContain(`--${f}`);
  });

  test("an arm that pins an image is refused in a process its launcher did not start in an image", () => {
    const file = fileFor("pinned@1", "a", "a");
    expect(refused(["--campaign-file", file])).toContain("WRATHBENCH_RUN_IMAGE");
    expect(configFromArgs([...MODEL, "--campaign-file", file], { WRATHBENCH_RUN_IMAGE: "registry.example/wb/runner:t1" })).toMatchObject({
      arm: "a",
      image: "registry.example/wb/runner:t1",
    });
  });
});

describe("the shape a campaign file hands the run", () => {
  test("race-probe@1's orc-warrior: the cell's start, the definition's leash, stop at level 10, stamped", () => {
    const c = configFromArgs([...MODEL, "--campaign-file", fileFor("race-probe@1", "orc-warrior"), "--ref", "deepseek-v41-flash"], {});
    expect(c).toMatchObject({
      episode: "probing",
      campaign: "race-probe",
      campaignVersion: 1,
      campaignHash: pub("race-probe@1").hash,
      cell: "orc-warrior",
      arm: "base",
      ref: "deepseek-v41-flash",
      race: 2,
      class: 1,
      maxToolCallsPerEpisode: 24_000,
      wikiCoords: false,
      wiki: true,
      stopAtLevel: 10,
    });
    expect(c.watchdogs).toMatchObject({ episodeMs: 43_200_000, idleMs: 1_200_000, noXpMs: null });
    // No objective text: the standing goal drives levelling, and the run is unscored by its episode.
    expect(c.objective).toBeUndefined();
    // Not launched by a pod: no image stamp.
    expect(c.image).toBeUndefined();
  });

  test("--episode probing may be spelled out; the result is the same launch", () => {
    const file = fileFor("race-probe@1", "draenei-warrior");
    const a = configFromArgs([...MODEL, "--campaign-file", file, "--run-id", "x"], {});
    const b = configFromArgs([...MODEL, "--episode", "probing", "--campaign-file", file, "--run-id", "x"], {});
    expect({ ...b, token: "" }).toEqual({ ...a, token: "" });
    expect(a).toMatchObject({ race: 11, class: 1 });
  });

  test("a definition with an objective and no stop level passes exactly that", () => {
    const c = configFromArgs([...MODEL, "--campaign-file", fileFor("nav@1", "coldridge")], {});
    expect(c.objective).toBe("Travel to Ironforge and keep a log.");
    expect(c.stopAtLevel).toBeUndefined();
    expect(c).toMatchObject({ wikiCoords: true, race: 3, class: 2, maxToolCallsPerEpisode: 2500 });
    expect(c.watchdogs).toMatchObject({ episodeMs: 21_600_000, noXpMs: null });
  });

  test("an arm's args land in the config by ordinary parsing, after the supervisor's", () => {
    const c = configFromArgs(["--driver", "claude-code", "--model", "sonnet", "--campaign-file", fileFor("pinned@1", "a", "b"), "--compact-window", "200k"], {
      WRATHBENCH_RUN_IMAGE: "registry.example/wb/runner:t2",
    });
    expect(c).toMatchObject({ arm: "b", compactWindow: "200k" });
  });

  test("a launch that names no campaign file is untouched", () => {
    const c = configFromArgs([...MODEL, "--episode", "e90"], {});
    expect(c.campaign).toBeUndefined();
    expect(c.campaignVersion).toBeUndefined();
    expect(c.arm).toBeUndefined();
    expect(c.stopAtLevel).toBeUndefined();
  });
});

describe("old runs", () => {
  test("a stored probe config with no campaign still loads: the rule is for fresh launches only", () => {
    // What one of the nine hand-launched spike probes stored in meta.json.
    const c = loadRunConfig({
      runId: "probe-05fix-20260926-1",
      driver: "openai",
      model: "deepseek-flash",
      episode: "probing",
      race: 1,
      class: 2,
      watchdogs: { idleMs: 1_200_000, noXpMs: null, episodeMs: 5_400_000 },
      maxToolCallsPerEpisode: 3000,
    });
    expect(c.episode).toBe("probing");
    expect(c.campaign).toBeUndefined();
  });
});
