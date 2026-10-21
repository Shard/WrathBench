/**
 * A party member's launch (docs/proposals/GROUP-PLAY.md, phase 3): the
 * definition's `start` and `party` blocks, the member's campaign file, and
 * the config `configFromArgs` builds from them — `--character`, the member's
 * own start and objective, and `config.party`. Also the half that must not
 * move: every definition and probe launch that names neither block reads,
 * hashes and launches exactly as before.
 */

import { describe, expect, test } from "bun:test";


import { campaignDefinitionSchema, campaignHash, issuesOf } from "../src/campaign-def";
import { campaignFileOf, parseCampaignFile, writeCampaignFile, type CampaignFile } from "../src/campaign-file";
import { CampaignLaunchError } from "../src/campaign-launch";
import { comparabilityOf, promptHash } from "../src/comparability";
import { memberRunId, type PartyLaunch } from "../src/party";
import { SYSTEM_PROMPT, WORLD_SECTION, buildSystemPrompt, objectiveSection, stagedCharacterNote } from "../src/prompt";
import { configFromArgs, stagedLevelOf } from "../src/run";
import { parseRunArgs } from "../src/run-flags";
import { checkedIn, checkedInFiles, definition, joined, PARTY_MEMBERS, partyDefinition } from "./fixtures/campaigns";
import { tempDirs } from "./fixtures/temp-dirs";

const tempDir = tempDirs();
const MODEL = ["--driver", "claude-code", "--model", "sonnet", "--token-env", "CLAUDE_CODE_OAUTH_TOKEN_2"];
const STEM = "fleet-deadmines-party-base-sonnet-20261020";
const ACCOUNTS = ["PARTY1", "PARTY2", "PARTY3", "PARTY4", "PARTY5"];

const party = partyDefinition();
const race = checkedIn("race-probe@1");
const { definitions } = joined([party, race], {});
const pub = (ref: string): (typeof definitions)[number] => definitions.find((d) => d.ref === ref)!;

function launchOf(member: string): PartyLaunch {
  return {
    id: STEM,
    member,
    members: PARTY_MEMBERS.map((m, i) => ({ member: m.id, role: m.role, runId: memberRunId(STEM, m.id), account: ACCOUNTS[i]!, character: m.character })),
  };
}

function memberFile(member: string): CampaignFile {
  return { ...campaignFileOf(pub("deadmines@1"), "party"), party: launchOf(member) };
}

function fileOn(f: CampaignFile): string {
  return writeCampaignFile(tempDir("wb-party-"), f);
}

function refused(argv: string[]): string {
  try {
    configFromArgs([...MODEL, ...argv], {});
  } catch (err) {
    expect(err).toBeInstanceOf(CampaignLaunchError);
    return (err as Error).message;
  }
  throw new Error(`launch was accepted: ${argv.join(" ")}`);
}

describe("the definition's start and party blocks", () => {
  test("every definition checked in before the blocks hashes as it was published: the new blocks are optional, with no default", () => {
    // The published hashes (campaign-defs/<ref> in the store, read 2026-10-19).
    const published: Record<string, string> = { "class-probe@2.json": "sha256:1c285b7bc87e738c", "race-probe@1.json": "sha256:7639fb7bce3d6b6e" };
    const files = checkedInFiles();
    for (const [f, hash] of Object.entries(published)) {
      expect(files).toContain(f);
      const def = checkedIn(f.replace(/\.json$/, ""));
      expect(def.start).toBeUndefined();
      expect(def.party).toBeUndefined();
      expect(campaignHash(def)).toBe(hash);
    }
  });

  test("a party starts staged, carries per-member objectives, and its cell is the leader's start", () => {
    const bad = (over: Record<string, unknown>): string => {
      const r = campaignDefinitionSchema.safeParse({ ...party, ...over });
      if (r.success) throw new Error("accepted");
      return issuesOf(r.error);
    };
    expect(bad({ start: undefined })).toContain("staged");
    expect(bad({ start: "fresh" })).toContain("staged");
    expect(bad({ objective: "Clear the Deadmines." })).toContain("per member");
    expect(bad({ cells: [{ id: "party", race: 1, class: 5 }] })).toContain("leader's start");
    expect(bad({ party: { size: 4, members: party.party!.members } })).toContain("size 4");
    expect(bad({ party: { size: 2, members: [party.party!.members[0], { ...party.party!.members[0], id: "other" }] } })).toContain("declared twice");
    expect(bad({ party: { size: 2, members: [party.party!.members[0], { ...party.party!.members[1], character: "Bqeee" }] } })).toContain("2-12 letters");
  });

  test("the hash covers the party: a renamed member is a different definition", () => {
    const renamed = partyDefinition({ party: { size: 5, members: PARTY_MEMBERS.map((m) => ({ ...m, character: m.id === "mage" ? "Corwin" : m.character })) } });
    expect(campaignHash(renamed)).not.toBe(campaignHash(party));
  });
});

describe("a member's campaign file", () => {
  test("reads back with its party, and refuses a launch that is not the definition's party", () => {
    const f = memberFile("healer");
    expect(parseCampaignFile(JSON.parse(JSON.stringify(f))).party).toEqual(launchOf("healer"));
    const edit = (p: PartyLaunch): string => {
      try {
        parseCampaignFile({ ...JSON.parse(JSON.stringify(f)), party: p });
      } catch (err) {
        return (err as Error).message;
      }
      throw new Error("accepted");
    };
    const l = launchOf("healer");
    expect(edit({ ...l, members: l.members.map((m) => (m.member === "mage" ? { ...m, character: "Zorvin" } : m)) })).toContain("names Corvin");
    expect(edit({ ...l, members: l.members.map((m) => (m.member === "rogue" ? { ...m, runId: "elsewhere" } : m)) })).toContain("is not");
    expect(edit({ ...l, members: l.members.map((m) => ({ ...m, account: "PARTY1" })) })).toContain("share an account");
    expect(edit({ ...l, member: "bard" })).toContain("not a member");
    // A file of a definition that is no party cannot carry one.
    const plain = campaignFileOf(pub("race-probe@1"), "orc-warrior");
    expect(() => parseCampaignFile({ ...JSON.parse(JSON.stringify(plain)), party: l })).toThrow("is not a party");
  });
});

describe("a member's launch", () => {
  test("is the member's own start, character, objective and party stamp", () => {
    const path = fileOn(memberFile("mage"));
    const c = configFromArgs([...MODEL, "--episode", "probing", "--campaign-file", path, "--character", "Corvin", "--ref", "sub2-sonnet"], {});
    expect(c.character).toBe("Corvin");
    expect([c.race, c.class]).toEqual([7, 8]);
    expect(c.objective).toBe("You are Corvin, the party's damage.");
    expect(c.subscription).toBe("CLAUDE_CODE_OAUTH_TOKEN_2");
    expect(c.party).toEqual({ id: STEM, member: "mage", role: "damage", size: 5, members: launchOf("mage").members });
    expect(c.watchdogs).toMatchObject({ episodeMs: 14_400_000, idleMs: 1_200_000, noXpMs: null });
    // The party is not a key: the tuple a member stamps has no party in it.
    const tuple = comparabilityOf(c, "0.9.1") as unknown as Record<string, unknown>;
    expect(JSON.stringify(tuple)).not.toContain(STEM);
    expect(Object.keys(tuple)).not.toContain("party");
    // The launch note's level is the definition's.
    expect(stagedLevelOf(parseRunArgs(["--campaign-file", path]))).toBe(20);
  });

  test("--character is required on a staged start, must be the member's, and is refused everywhere else", () => {
    const path = fileOn(memberFile("tank"));
    expect(refused(["--episode", "probing", "--campaign-file", path])).toContain("--character");
    expect(refused(["--episode", "probing", "--campaign-file", path, "--character", "Brenna"])).toContain("staged as Aldric");
    // A party definition's file with no member in it is a square's, not a launch's.
    expect(refused(["--episode", "probing", "--campaign-file", fileOn(campaignFileOf(pub("deadmines@1"), "party")), "--character", "Aldric"])).toContain("names no member");
    // A fresh probe's name is the model's.
    expect(refused(["--episode", "probing", "--campaign-file", fileOn(campaignFileOf(pub("race-probe@1"), "orc-warrior")), "--character", "Aldric"])).toContain("starts fresh");
    // And off a campaign it means nothing.
    expect(refused(["--character", "Aldric"])).toContain("staged");
  });
});

describe("a single-character launch is what it was", () => {
  test("a fresh probe's config carries no character and no party, and its argv parser takes the same flags", () => {
    const path = fileOn(campaignFileOf(pub("race-probe@1"), "orc-warrior"));
    const c = configFromArgs(["--driver", "openai", "--model", "deepseek/deepseek-v4.1-flash", "--episode", "probing", "--campaign-file", path, "--run-id", "fleet-x-1"], {});
    expect(c.character).toBeUndefined();
    expect(c.party).toBeUndefined();
    expect(Object.keys(c)).not.toContain("party");
    expect(Object.keys(c)).not.toContain("character");
    expect(c.runId).toBe("fleet-x-1");
    expect(c.race).toBe(2);
  });

  test("a plain e90 config has neither key either", () => {
    const c = configFromArgs(["--driver", "openai", "--model", "m", "--episode", "e90", "--race", "1", "--class", "1"], {});
    expect(Object.keys(c)).not.toContain("party");
    expect(Object.keys(c)).not.toContain("character");
  });

  test("a definition with start: fresh written out launches like one with none", () => {
    const fresh = definition({ id: "fresh", start: "fresh" });
    const { definitions: d } = joined([fresh], {});
    const p = writeCampaignFile(tempDir("wb-fresh-"), campaignFileOf(d[0]!, "a"));
    const c = configFromArgs(["--driver", "openai", "--model", "m", "--episode", "probing", "--campaign-file", p], {});
    expect(c.character).toBeUndefined();
    expect([c.race, c.class]).toEqual([1, 1]);
  });
});

describe("both drivers are told the same", () => {
  test("the member's objective block renders identically for the fixed loop and the claude-code harness", () => {
    const c = configFromArgs([...MODEL, "--episode", "probing", "--campaign-file", fileOn(memberFile("healer")), "--character", "Brenna"], {});
    const block = objectiveSection("You are Brenna, the party's healer.");
    // run.ts hands both drivers the same initial notices (the staged note),
    // and each builds its system prompt from the same config.objective.
    expect(buildSystemPrompt(c.objective, c.episode, "wrathbench", c.wiki)).toContain(block);
    expect(buildSystemPrompt(c.objective, c.episode, "claude-code", c.wiki)).toContain(block);
  });
});

describe("the objective replaces the broad goal, and the probe states its clock (operator, 2026-10-21)", () => {
  const dm = checkedIn("deadmines@3");
  const { definitions: dmDefs } = joined([dm], {});
  const tankFile = (): CampaignFile => ({
    ...campaignFileOf(dmDefs.find((d) => d.ref === "deadmines@3")!, "party"),
    party: {
      id: STEM,
      member: "tank",
      members: dm.party!.members.map((m, i) => ({ member: m.id, role: m.role, runId: memberRunId(STEM, m.id), account: ACCOUNTS[i]!, character: m.character! })),
    },
  });

  test("the Deadmines tank is told its objective in place of the goal, and that the run lasts four hours", () => {
    const c = configFromArgs([...MODEL, "--episode", "probing", "--campaign-file", fileOn(tankFile()), "--character", "Tankpartyb"], {});
    expect(c.watchdogs.episodeMs).toBe(14_400_000);
    const objective = dm.party!.members.find((m) => m.id === "tank")!.objective!;
    for (const harness of ["wrathbench", "claude-code"] as const) {
      const p = buildSystemPrompt(c.objective, c.episode, harness, c.wiki, c.watchdogs.episodeMs);
      expect(p.startsWith(`${WORLD_SECTION}\n\nThis run lasts four hours.\n\n${objectiveSection(objective)}\n\n## The snippet runtime`)).toBe(true);
      expect(p).not.toContain("Your goal is to progress");
      expect(p).not.toContain("in addition to the standing goal");
      // What the drivers render is what the tuple hashes.
      if (harness === "claude-code") expect(comparabilityOf(c, "v").promptHash).toBe(promptHash(p));
    }
  });

  test("a probe without an objective keeps the prompt it always had, budget or not", () => {
    // race-probe@1 has a twelve-hour budget and no objective: no clock, no
    // change, through the same config path a launch takes.
    const path = fileOn(campaignFileOf(pub("race-probe@1"), "orc-warrior"));
    const c = configFromArgs(["--driver", "openai", "--model", "m", "--episode", "probing", "--campaign-file", path], {});
    expect(c.objective).toBeUndefined();
    expect(c.watchdogs.episodeMs).toBe(43_200_000);
    expect(buildSystemPrompt(c.objective, c.episode, "wrathbench", c.wiki, c.watchdogs.episodeMs)).toBe(SYSTEM_PROMPT);
    expect(comparabilityOf(c, "v").promptHash).toBe(promptHash(SYSTEM_PROMPT));
  });
});

describe("the staged launch note", () => {
  test("is the approved text, with the staging's level and the client's names", () => {
    expect(stagedCharacterNote({ character: "Aldric", level: 20, raceName: "Human", className: "Warrior" })).toBe(
      'Your character already exists: Aldric, a level 20 Human Warrior. Log in with `await sdk.createSession({ character: "Aldric" })`. Do not create another character.',
    );
  });
});
