/**
 * A party definition's one-agent arm (`arms[].agents: 1`, Shard/wrath-mcp#29
 * decision 2): one agent driving every member's staged character on one run.
 * The definition's rules for it, the campaign file's `fanout` half, and the
 * config a launch builds from them (`RunConfig.fanout`, no `party`, no
 * `--character`). Every definition without the field reads and hashes as
 * before, which `party-launch.test.ts` holds.
 */

import { describe, expect, test } from "bun:test";

import { campaignDefinitionSchema, issuesOf, isOneAgentArm } from "../src/campaign-def";
import { campaignFileOf, parseCampaignFile, writeCampaignFile, type CampaignFile } from "../src/campaign-file";
import { CampaignLaunchError } from "../src/campaign-launch";
import { campaignPairRefusals } from "../src/campaigns";
import { fanoutConfigOf, fanoutLaunchOf, memberRunId, withFanoutGuids } from "../src/party";
import { configFromArgs } from "../src/run";
import { joined, ONE_AGENT_IMAGE, oneAgentDefinition, PARTY_MEMBERS, partyDefinition } from "./fixtures/campaigns";
import { tempDirs } from "./fixtures/temp-dirs";

const tempDir = tempDirs();
const MODEL = ["--driver", "claude-code", "--model", "sonnet", "--credential", "claude-2", "--credential-env", "CLAUDE_CODE_OAUTH_TOKEN_2"];
const ENV = { WRATHBENCH_RUN_IMAGE: ONE_AGENT_IMAGE };
const ACCOUNTS = ["PARTY1", "PARTY2", "PARTY3", "PARTY4", "PARTY5"];

const def = oneAgentDefinition();
const { definitions } = joined([def], {});
const pub = definitions.find((d) => d.ref === "deadmines@5")!;

function oneAgentFile(): CampaignFile {
  return { ...campaignFileOf(pub, "party", "one-agent"), fanout: fanoutLaunchOf(def.party!, ACCOUNTS) };
}

function bad(over: Record<string, unknown>): string {
  const r = campaignDefinitionSchema.safeParse({ ...def, ...over });
  if (r.success) throw new Error("accepted");
  return issuesOf(r.error);
}

function refused(argv: string[], env: Record<string, string> = ENV): string {
  try {
    configFromArgs([...MODEL, ...argv], env);
  } catch (err) {
    expect(err).toBeInstanceOf(CampaignLaunchError);
    return (err as Error).message;
  }
  throw new Error(`launch was accepted: ${argv.join(" ")}`);
}

describe("the definition's one-agent arm", () => {
  test("a party definition may carry one, beside its five-agent arm, with the one agent's objective at the top level", () => {
    expect(def.arms.map((a) => a.agents)).toEqual([undefined, 1]);
    expect(isOneAgentArm(def, def.arms[1])).toBe(true);
    expect(isOneAgentArm(def, def.arms[0])).toBe(false);
  });

  test("its objective is the top-level one: required with such an arm, refused without", () => {
    expect(bad({ objective: null })).toContain("one-agent arm");
    expect(bad({ arms: [{ id: "party" }] })).toContain("top-level objective is null");
  });

  test("only a party has members to hand one agent", () => {
    const r = campaignDefinitionSchema.safeParse({ ...partyDefinition(), party: undefined, start: undefined, objective: "x", arms: [{ id: "solo", agents: 1 }] });
    expect(r.success).toBe(false);
    if (!r.success) expect(issuesOf(r.error)).toContain("this definition has no party");
  });

  test("agents is 1 or absent", () => {
    expect(bad({ arms: [{ id: "party", image: ONE_AGENT_IMAGE }, { id: "two", image: ONE_AGENT_IMAGE, agents: 2 }] })).toContain("agents");
  });

  test("two arms still pin every arm's image", () => {
    expect(bad({ arms: [{ id: "party", image: ONE_AGENT_IMAGE }, { id: "one-agent", agents: 1 }] })).toContain("one-agent floats");
  });
});

describe("the campaign file's one-agent half", () => {
  test("names every member's character on its own account, in member order, and round-trips", () => {
    const f = oneAgentFile();
    expect(f.fanout!.members.map((m) => [m.member, m.account, m.character])).toEqual(PARTY_MEMBERS.map((m, i) => [m.id, ACCOUNTS[i]!, m.character]));
    expect(parseCampaignFile(JSON.parse(JSON.stringify(f)))).toEqual(f);
  });

  test("is refused on the five-agent arm, and a member's half on the one-agent arm", () => {
    const party = campaignFileOf(pub, "party", "party");
    expect(() => parseCampaignFile({ ...party, fanout: fanoutLaunchOf(def.party!, ACCOUNTS) })).toThrow("is not one");
    const stem = "fleet-x";
    const member = { id: stem, member: "tank", members: PARTY_MEMBERS.map((m, i) => ({ member: m.id, role: m.role, runId: memberRunId(stem, m.id), account: ACCOUNTS[i]!, character: m.character })) };
    expect(() => parseCampaignFile({ ...campaignFileOf(pub, "party", "one-agent"), party: member })).toThrow("one agent driving the whole party");
  });

  test("must be the definition's party: its characters, its order, an account each", () => {
    const f = oneAgentFile();
    const swapped = { members: [f.fanout!.members[1]!, f.fanout!.members[0]!, ...f.fanout!.members.slice(2)] };
    expect(() => parseCampaignFile({ ...f, fanout: swapped })).toThrow("member 1 is healer");
    const shared = { members: f.fanout!.members.map((m) => ({ ...m, account: "PARTY1" })) };
    expect(() => parseCampaignFile({ ...f, fanout: shared })).toThrow("share an account");
  });
});

describe("a one-agent launch", () => {
  test("is a fan-out run on the party's accounts with every character staged, the stager's guids carried", () => {
    const guids = new Map(PARTY_MEMBERS.map((m, i) => [m.id, String(100 + i)]));
    const f = { ...oneAgentFile(), fanout: withFanoutGuids(fanoutLaunchOf(def.party!, ACCOUNTS), guids) };
    const path = writeCampaignFile(tempDir("wb-one-agent-"), f);
    const c = configFromArgs([...MODEL, "--account", "PARTY1", "--episode", "probing", "--campaign-file", path, "--ref", "sub-sonnet"], ENV);
    expect(c).toMatchObject({ episode: "probing", campaign: "deadmines", campaignVersion: 5, cell: "party", arm: "one-agent", account: "PARTY1", race: 1, class: 1 });
    expect(c.objective).toBe(def.objective!);
    expect(c.party).toBeUndefined();
    expect(c.character).toBeUndefined();
    expect(c.fanout).toEqual({
      characters: 5,
      accounts: ACCOUNTS,
      staged: PARTY_MEMBERS.map((m, i) => ({ character: m.character, account: ACCOUNTS[i]!, guid: String(100 + i) })),
    });
    expect(c.fanout).toEqual(fanoutConfigOf(f.fanout));
    expect(c.end).toEqual(def.end);
  });

  test("names no --character, and needs the file's characters", () => {
    const path = writeCampaignFile(tempDir("wb-one-agent-"), oneAgentFile());
    expect(refused(["--campaign-file", path, "--character", "Aldric"])).toContain("--character is a party member's");
    const bare = writeCampaignFile(tempDir("wb-one-agent-"), campaignFileOf(pub, "party", "one-agent"));
    expect(refused(["--campaign-file", bare])).toContain("launches through the fleet's roster");
  });

  test("takes its grant from the file: --max-characters and --accounts are refused", () => {
    const path = writeCampaignFile(tempDir("wb-one-agent-"), oneAgentFile());
    expect(refused(["--campaign-file", path, "--max-characters", "5", "--accounts", ACCOUNTS.join(",")])).toContain("--max-characters, --accounts are not flags a probe may set");
  });
});

describe("the pair check", () => {
  test("a route driver is refused on a one-agent arm before any launch, and nowhere else", () => {
    const c = { name: "deadmines", version: 5, arms: def.arms, assignments: [{ model: "ref" }, { model: "sonnet" }] };
    const refusals = campaignPairRefusals(c as never, { ref: { driver: "reference" }, sonnet: { driver: "claude-code" } });
    expect(refusals.map((r) => [r.ref, r.arm])).toEqual([["ref", "one-agent"]]);
    expect(refusals[0]!.reason).toContain("plays one character's route");
  });
});
