/**
 * The task episodes (operator, 2026-11-14): `deadmines`, five agents of one
 * model with one character each, and `deadmines-solo`, one agent driving all
 * five. Pinned here:
 *
 * - each id's definition is the build's own, consistent with its row in the
 *   episode table, and its directive is byte for byte the text the
 *   rehearsals ran (deadmines@5's one agent, deadmines@4's members);
 * - the prompt a task run renders is the rehearsal's, byte for byte, while
 *   the run stays scored (a directive is no objective);
 * - the launch takes its whole shape from the id's file, stamps the episode
 *   and no campaign, and carries `agents`, `characters` and the pins into
 *   the tuple as keys — absent on every other run;
 * - a config that does not hold together as its task episode is refused.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { campaignDefinitionSchema, campaignHash, type CampaignDefinition } from "../src/campaign-def";
import { parseCampaignFile, taskFileOf, writeCampaignFile, type CampaignFile } from "../src/campaign-file";
import { CampaignLaunchError } from "../src/campaign-launch";
import { comparabilityOf } from "../src/comparability";
import { loadRunConfig, taskEpisodeRefusal } from "../src/config";
import { EPISODES, TASK_EPISODE_IDS, isLevelEpisode, isScoredEpisode } from "../src/episodes";
import { fanoutLaunchOf, memberRunId, partyLaunchSchema } from "../src/party";
import { buildSystemPrompt, programPromptOf, steeringOf } from "../src/prompt";
import { configFromArgs } from "../src/run";
import { taskDefinition, taskDefinitionProblem, taskHash } from "../src/task-episodes";
import { tempDirs } from "./fixtures/temp-dirs";

const tempDir = tempDirs();
const ROOT = join(import.meta.dir, "..", "campaigns");
const v4 = campaignDefinitionSchema.parse(JSON.parse(readFileSync(join(ROOT, "deadmines@4.json"), "utf8"))) as CampaignDefinition;
const v5 = campaignDefinitionSchema.parse(JSON.parse(readFileSync(join(ROOT, "deadmines@5.json"), "utf8"))) as CampaignDefinition;
const MODEL = ["--driver", "claude-code", "--model", "sonnet", "--credential", "claude-2", "--credential-env", "CLAUDE_CODE_OAUTH_TOKEN_2"];
const ACCOUNTS = ["EVAL01", "EVAL02", "EVAL03", "EVAL04", "EVAL05"];

function soloFile(): CampaignFile {
  const f = taskFileOf("deadmines-solo");
  return { ...f, staging: "sha256:0123456789abcdef", fanout: fanoutLaunchOf(f.definition.party!, ACCOUNTS) };
}

function memberFile(member: string): CampaignFile {
  const f = taskFileOf("deadmines");
  const def = f.definition.party!;
  const stem = "fleet-sonnet-deadmines-20261114";
  const members = def.members.map((m, i) => ({ member: m.id, role: m.role, runId: memberRunId(stem, m.id), account: ACCOUNTS[i]!, character: m.character }));
  return { ...f, party: partyLaunchSchema.parse({ id: stem, member, members }) };
}

function refused(argv: string[]): string {
  try {
    configFromArgs([...MODEL, ...argv], {});
  } catch (err) {
    return (err as Error).message;
  }
  throw new Error(`launch was accepted: ${argv.join(" ")}`);
}

describe("the pinned definitions", () => {
  test("each holds together with its row in the episode table", () => {
    for (const id of TASK_EPISODE_IDS) {
      expect(taskDefinitionProblem(id)).toBeNull();
      expect(taskDefinition(id).id).toBe(id);
      expect(isScoredEpisode(id)).toBe(true);
      expect(isLevelEpisode(id)).toBe(false);
      expect(EPISODES[id]).toMatchObject({ minutes: 240, idleMinutes: 20, noXpMinutes: null, toolCalls: 8000, objectiveAllowed: false, scored: true });
    }
    expect(EPISODES.deadmines.task).toEqual({ agents: 5, characters: 1 });
    expect(EPISODES["deadmines-solo"].task).toEqual({ agents: 1, characters: 5 });
  });

  test("the party, start and end are the rehearsals', and the directives their texts byte for byte", () => {
    for (const id of TASK_EPISODE_IDS) {
      const def = taskDefinition(id);
      expect(def.party).toEqual(v4.party!);
      expect(def.party).toEqual(v5.party!);
      expect(def.start).toEqual(v5.start!);
      expect(def.end).toEqual(v5.end!);
      expect(def.cells).toEqual(v5.cells);
      expect(def.budget).toEqual(v5.budget);
      expect(def.wiki).toBe(v5.wiki);
      expect(def.wikiCoords).toBe(v5.wikiCoords);
    }
    // One agent: deadmines@5's top-level objective. Five agents: none at the
    // top, each member's own, which is deadmines@4's.
    expect(taskDefinition("deadmines-solo").objective).toBe(v5.objective!);
    expect(taskDefinition("deadmines").objective).toBeNull();
    expect(taskDefinition("deadmines-solo").arms).toEqual([{ id: "one-agent", note: "One agent driving all five characters.", agents: 1 }]);
    expect(taskDefinition("deadmines").arms[0]!.agents).toBeUndefined();
  });

  test("a file holding any other definition under the id is refused, and so is a probe's provenance on it", () => {
    const f = taskFileOf("deadmines-solo");
    expect(parseCampaignFile(JSON.parse(JSON.stringify(f))).episode).toBe("deadmines-solo");
    const edited = { ...f.definition, budget: { ...f.definition.budget, episodeMs: 10_800_000 } };
    const forged = { ...f, definition: edited, hash: `sha256:${new Bun.CryptoHasher("sha256").update(JSON.stringify(edited)).digest("hex").slice(0, 16)}` };
    expect(() => parseCampaignFile(forged)).toThrow();
    const rehashed = { ...forged, hash: campaignHash(edited) };
    expect(() => parseCampaignFile(rehashed)).toThrow(`not the one --episode deadmines-solo pins (${taskHash("deadmines-solo")})`);
    expect(() => parseCampaignFile({ ...f, source: { commit: "0".repeat(40), path: "x", branch: [] } })).toThrow("never a published campaign's");
    expect(() => parseCampaignFile({ ...f, episode: "deadmines" })).toThrow("not the one --episode deadmines pins");
  });
});

describe("the prompt", () => {
  test("a task run renders the rehearsal's prompt byte for byte, on every harness and loop", () => {
    const fourHours = 14_400_000;
    for (const harness of ["wrathbench", "claude-code", "codex"] as const) {
      for (const program of [undefined, programPromptOf({ loop: "program", yield: true })]) {
        expect(buildSystemPrompt(taskDefinition("deadmines-solo").objective!, "deadmines-solo", harness, true, fourHours, program)).toBe(
          buildSystemPrompt(v5.objective!, "probing", harness, true, fourHours, program),
        );
        for (const m of v4.party!.members) {
          expect(buildSystemPrompt(m.objective, "deadmines", harness, true, fourHours, program)).toBe(buildSystemPrompt(m.objective, "probing", harness, true, fourHours, program));
        }
      }
    }
    expect(buildSystemPrompt(v5.objective!, "deadmines-solo")).toContain("This run lasts four hours.");
  });

  test("the directive steers the prompt and is no objective: the run stays scored", () => {
    expect(steeringOf({ directive: "d" })).toBe("d");
    expect(steeringOf({ objective: "o" })).toBe("o");
    const path = writeCampaignFile(tempDir("wb-task-"), soloFile());
    const c = configFromArgs([...MODEL, "--episode", "deadmines-solo", "--campaign-file", path, "--ref", "sub-sonnet"], {});
    expect(c.objective).toBeUndefined();
    expect(c.directive).toBe(v5.objective!);
    expect(comparabilityOf(c, "harness-1.0-1").objective).toBe(false);
  });
});

describe("a task launch", () => {
  test("one agent: a fan-out run over the party, stamped with its episode and no campaign", () => {
    const path = writeCampaignFile(tempDir("wb-task-"), soloFile());
    const c = configFromArgs([...MODEL, "--episode", "deadmines-solo", "--campaign-file", path, "--ref", "sub-sonnet"], {});
    expect(c).toMatchObject({ episode: "deadmines-solo", ref: "sub-sonnet", race: 1, class: 1, maxToolCallsPerEpisode: 8000 });
    expect(c.campaign).toBeUndefined();
    expect(c.cell).toBeUndefined();
    expect(c.arm).toBeUndefined();
    expect(c.party).toBeUndefined();
    expect(c.fanout?.characters).toBe(5);
    expect(c.watchdogs).toMatchObject({ episodeMs: 14_400_000, idleMs: 1_200_000, noXpMs: null });
    expect(c.task).toEqual({ definition: taskHash("deadmines-solo"), staging: "sha256:0123456789abcdef" });
    const t = comparabilityOf(c, "harness-1.0-1");
    expect(t).toMatchObject({ episode: "deadmines-solo", episodeOverride: false, agents: 1, characters: 5, task: { definition: taskHash("deadmines-solo"), staging: "sha256:0123456789abcdef" } });
  });

  test("five agents: each member one character of a party of five, its own directive", () => {
    const path = writeCampaignFile(tempDir("wb-task-"), memberFile("healer"));
    const c = configFromArgs([...MODEL, "--episode", "deadmines", "--campaign-file", path, "--character", "Healpartyc"], {});
    expect(c).toMatchObject({ episode: "deadmines", character: "Healpartyc", race: 3, class: 5 });
    expect(c.directive).toBe(v4.party!.members.find((m) => m.id === "healer")!.objective);
    expect(c.party?.size).toBe(5);
    expect(c.fanout).toBeUndefined();
    expect(comparabilityOf(c, "harness-1.0-1")).toMatchObject({ agents: 5, characters: 1, task: { definition: taskHash("deadmines") } });
  });

  test("is refused by hand, against another episode, or with a probe's flags", () => {
    expect(refused(["--episode", "deadmines-solo"])).toContain("never launched by hand");
    const path = writeCampaignFile(tempDir("wb-task-"), soloFile());
    expect(refused(["--episode", "probing", "--campaign-file", path])).toContain("not --episode probing");
    expect(refused(["--campaign-file", path])).toContain("name it with --episode deadmines-solo");
    expect(refused(["--episode", "deadmines-solo", "--campaign-file", path, "--objective", "x"])).toContain("--objective is not a flag a probe may set");
  });

  test("leaves every other run's tuple without the task keys", () => {
    const c = loadRunConfig({ runId: "r", token: "t", driver: "openai", model: "m", episode: "e90", race: 1, class: 2 });
    const t = comparabilityOf(c, "harness-1.0-1");
    for (const k of ["agents", "characters", "task"]) expect(k in t).toBe(false);
  });
});

describe("what a task episode's config must be", () => {
  const base = { runId: "r", token: "t", driver: "openai", model: "m" };
  const fanout = { characters: 5, accounts: ACCOUNTS };
  test("a directive only on a task episode, never beside an objective, and never missing on one", () => {
    expect(() => loadRunConfig({ ...base, episode: "e90", directive: "d" })).toThrow("a directive is a task episode's");
    expect(() => loadRunConfig({ ...base, episode: "freeplay", task: { definition: "x" } })).toThrow("task pins are a task episode's");
    expect(taskEpisodeRefusal({ episode: "deadmines-solo", objective: "o", directive: "d", fanout })).toContain("an operator objective would steer it");
    expect(taskEpisodeRefusal({ episode: "deadmines-solo", fanout })).toContain("has none");
  });

  test("one agent drives five characters; five agents one each; fan-out stays refused on the level episodes", () => {
    expect(taskEpisodeRefusal({ episode: "deadmines-solo", directive: "d" })).toContain("grants 1");
    expect(taskEpisodeRefusal({ episode: "deadmines-solo", directive: "d", fanout: { ...fanout, characters: 3 } })).toContain("grants 3");
    expect(taskEpisodeRefusal({ episode: "deadmines-solo", directive: "d", fanout })).toBeNull();
    expect(taskEpisodeRefusal({ episode: "deadmines", directive: "d" })).toContain("no party member");
    expect(() => loadRunConfig({ ...base, episode: "deadmines", directive: "d", fanout })).toThrow("fan-out (--max-characters above 1)");
    for (const episode of ["e90", "e360"]) expect(() => loadRunConfig({ ...base, episode, fanout })).toThrow("a scored single-character episode");
  });
});

describe("the launch file's staging hash", () => {
  test("is a task file's only", () => {
    const f = { ...taskFileOf("deadmines-solo"), staging: "sha256:0123456789abcdef" };
    expect(parseCampaignFile(JSON.parse(JSON.stringify(f))).staging).toBe("sha256:0123456789abcdef");
    expect(() => parseCampaignFile({ ...f, episode: undefined, source: { commit: "0".repeat(40), path: "x", branch: [] } })).toThrow();
  });
});

// `CampaignLaunchError` is what every refusal above is; one is enough to hold.
test("a refused task launch is a CampaignLaunchError", () => {
  try {
    configFromArgs([...MODEL, "--episode", "deadmines-solo"], {});
  } catch (err) {
    expect(err).toBeInstanceOf(CampaignLaunchError);
  }
});

describe("the public projection, until the board is published", () => {
  test("leaves the task episodes out of the scheduler's words, keeping a list of nothing else whole", async () => {
    const { withoutTaskEpisodes } = await import("../viewer/public-projection");
    expect(withoutTaskEpisodes("schedulable on e90, e360, deadmines-solo")).toBe("schedulable on e90, e360");
    expect(withoutTaskEpisodes("targets met on e90, e360, deadmines-solo, deadmines — unlimited sessions while its account is idle")).toBe(
      "targets met on e90, e360 — unlimited sessions while its account is idle",
    );
    expect(withoutTaskEpisodes("schedulable on deadmines-solo")).toBe("schedulable on deadmines-solo");
    expect(withoutTaskEpisodes("cooling until 12:00")).toBe("cooling until 12:00");
  });
});
