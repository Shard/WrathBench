/**
 * A fresh probe launch: the rule that a `probing` run exists only as a cell of
 * a checked-in, versioned campaign definition, and the shape the definition
 * hands the run.
 *
 * Asserted through `configFromArgs`, the whole fresh-launch seam, because that
 * is what every launch path — the fleet's roster, run-episode.sh, a kubectl
 * exec, a branch pod — ends in. The nine runs this rule exists for were hand
 * launches with `--episode probing` and nothing else.
 */

import { describe, expect, test } from "bun:test";
import { campaignHash, campaignDef } from "../src/campaign-defs";
import { CampaignLaunchError, PROBE_SHAPE_FLAGS } from "../src/campaign-launch";
import { loadRunConfig } from "../src/config";
import { configFromArgs } from "../src/run";

const MODEL = ["--driver", "openai", "--model", "deepseek/deepseek-v4.1-flash"];

function refused(argv: string[]): string {
  try {
    configFromArgs([...MODEL, ...argv]);
  } catch (err) {
    expect(err).toBeInstanceOf(CampaignLaunchError);
    return (err as Error).message;
  }
  throw new Error(`launch was accepted: ${argv.join(" ")}`);
}

describe("what a fresh probe launch must name", () => {
  test("--episode probing alone is refused: a probe is a cell of a checked-in campaign", () => {
    expect(refused(["--episode", "probing"])).toContain("--campaign <id>@<version> --cell <id>");
  });

  test("the version must be named; a bare id is refused", () => {
    expect(refused(["--campaign", "race-probe", "--cell", "orc-warrior"])).toContain("@<version>");
  });

  test("a version this checkout does not define is refused, naming the open ones", () => {
    const msg = refused(["--campaign", "race-probe@7", "--cell", "orc-warrior"]);
    expect(msg).toContain("no such definition");
    expect(msg).toContain("race-probe@1");
  });

  test("a closed definition launches nothing", () => {
    expect(refused(["--campaign", "class-probe@1", "--cell", "human-warrior"])).toContain("closed");
    expect(refused(["--campaign", "loop-spike@1", "--cell", "workspace"])).toContain("closed");
  });

  test("a cell must be named, and must be the definition's", () => {
    expect(refused(["--campaign", "race-probe@1"])).toContain("needs --cell");
    expect(refused(["--campaign", "race-probe@1", "--cell", "human-paladin"])).toContain("not a cell of race-probe@1");
  });

  test("a campaign is a probe: another episode is refused, and so is a cell or a ref without one", () => {
    expect(refused(["--episode", "e90", "--campaign", "race-probe@1", "--cell", "orc-warrior"])).toContain("--episode probing");
    expect(refused(["--cell", "orc-warrior"])).toContain("--campaign");
    expect(refused(["--ref", "codex-sol-61"])).toContain("--campaign");
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
    for (const f of PROBE_SHAPE_FLAGS) {
      expect(refused(["--campaign", "race-probe@1", "--cell", "orc-warrior", `--${f}`, values[f]])).toContain(`--${f}`);
    }
  });
});

describe("the shape a cell hands the run", () => {
  test("race-probe@1's orc-warrior: the cell's start, the definition's leash, stop at level 10, stamped", () => {
    const c = configFromArgs([...MODEL, "--campaign", "race-probe@1", "--cell", "orc-warrior", "--ref", "deepseek-v41-flash"]);
    expect(c).toMatchObject({
      episode: "probing",
      campaign: "race-probe",
      campaignVersion: 1,
      campaignHash: campaignHash(campaignDef("race-probe", 1)!),
      cell: "orc-warrior",
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
  });

  test("--episode probing may be spelled out; the result is the same launch", () => {
    const a = configFromArgs([...MODEL, "--campaign", "class-probe@2", "--cell", "draenei-shaman", "--run-id", "x"]);
    const b = configFromArgs([...MODEL, "--episode", "probing", "--campaign", "class-probe@2", "--cell", "draenei-shaman", "--run-id", "x"]);
    expect({ ...b, token: "" }).toEqual({ ...a, token: "" });
    expect(a).toMatchObject({ race: 11, class: 7, campaignVersion: 2 });
  });

  test("a definition with an objective and no stop level passes exactly that", () => {
    const c = configFromArgs([...MODEL, "--campaign", "nav-probe@1", "--cell", "coldridge"]);
    expect(c.objective).toContain("Travel from Coldridge Valley to Ironforge");
    expect(c.stopAtLevel).toBeUndefined();
    expect(c).toMatchObject({ wikiCoords: true, race: 3, class: 2, maxToolCallsPerEpisode: 2500 });
    expect(c.watchdogs).toMatchObject({ episodeMs: 21_600_000, noXpMs: null });
  });

  test("a launch that names no campaign is untouched", () => {
    const c = configFromArgs([...MODEL, "--episode", "e90"]);
    expect(c.campaign).toBeUndefined();
    expect(c.campaignVersion).toBeUndefined();
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
