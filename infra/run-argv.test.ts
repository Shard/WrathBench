/**
 * Every argv the repository builds for run.ts, run through run.ts's own
 * parser.
 *
 * run.ts refuses a flag it does not read and a flag given twice
 * (`runner/src/run-flags.ts`). That is what makes a typo in a campaign arm's
 * args fail loudly, and it is also what would turn a scored lane into
 * launch-failed on the first tick after a release if any builder emitted a
 * flag the runner does not list. So each builder is exercised here, on every
 * lane: the roster's argv for e90, e360, freeplay (the policy's uncapped
 * session and a hand-written job), a queue job, a resume and a probe; both
 * `infra/run-episode.sh` paths (a fresh launch and a resume, through each of
 * its three heads) and its hand probe; and the smoke scripts, which launch no
 * run at all and are held to that.
 */

import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { campaignFileOf, parseCampaignFile, writeCampaignFile } from "../runner/src/campaign-file";
import {
  ARM_RESERVED_FLAGS,
  PROBE_SHAPE_FLAGS,
  RUN_FLAGS,
  RunArgsError,
  SUPERVISOR_FLAGS,
  flagsOf,
  parseRunArgs,
} from "../runner/src/run-flags";
import { configFromArgs } from "../runner/src/run";
import { compactEnv } from "../runner/src/adapter-claude";
import { campaignDefinitionSchema } from "../runner/src/campaign-def";
import { comparabilityOf } from "../runner/src/comparability";
import { loadRunConfig } from "../runner/src/config";
import { checkedIn, definition, joined, partyDefinition } from "../runner/test/fixtures/campaigns";
import type { FleetJob, FleetRosterEntry } from "./run-fleet-config";
import { jobSpawn } from "./run-fleet-plan";
import { campaignFilePath, episodeArgv, episodeFlags, resolve, type Resolved, type RosterSpec } from "./run-roster";
import { tempDirs } from "./temp-dirs";

const tempDir = tempDirs();
const REPO_ROOT = join(import.meta.dir, "..");
const STAMP = "20261011";

const ROSTER: Record<string, FleetRosterEntry> = {
  "glm-free": {
    model: "z-ai/glm-5.2:free",
    tier: "t1",
    idle: "unlimited",
    routing: { order: ["Z.AI"], allowFallbacks: false },
    billing: "free",
  },
  "sonnet-100k": { model: "sonnet", driver: "claude-code", effort: "low", compactWindow: "100k", tier: "t2", idle: "none" },
  sonnet: { model: "sonnet", driver: "claude-code", effort: "low", tier: "t2", idle: "none" },
  astra: { model: "gpt-6-astra", driver: "codex", effort: "high", tier: "t1", idle: "none" },
};

function job(over: Partial<FleetJob> & Pick<FleetJob, "ref" | "episode">): FleetJob {
  return { refs: [over.ref], repeat: 1, name: `${over.ref}-${over.episode}`, enabled: true, source: "policy", ...over };
}

/** The resolved specs a job spawns, as the roster process reads them back. */
function specsOf(j: FleetJob, campaigns: Parameters<typeof jobSpawn>[5] = []): Resolved[] {
  return resolve(jobSpawn(j, ROSTER, "RUNNER1", STAMP, () => true, campaigns).entries, STAMP);
}

/** Parse an argv the way run.ts will; a refusal fails the test with run.ts's own message. */
function parses(flags: readonly string[]): Record<string, string | boolean> {
  return parseRunArgs(flags);
}

/** A probe's flags with the campaign file written where run.ts can read it, then the whole fresh-launch seam. */
function probeConfig(spec: Resolved): ReturnType<typeof configFromArgs> {
  const flags = episodeFlags(spec, false);
  const dir = tempDir("wb-argv-probe-");
  const path = writeCampaignFile(dir, spec.campaignFile!);
  const i = flags.indexOf("--campaign-file");
  return configFromArgs([...flags.slice(0, i + 1), path, ...flags.slice(i + 2)], { WRATHBENCH_RUN_IMAGE: "registry.example/wb/runner:t1" });
}

const race = checkedIn("race-probe@1");
const windows = definition({
  id: "window-probe",
  arms: [
    { id: "auto", image: "registry.example/wb/runner:t1" },
    { id: "w200k", image: "registry.example/wb/runner:t1", args: ["--compact-window", "200k", "--step-interval-ms", "4000"] },
  ],
});
const party = partyDefinition();
const PARTY_ACCOUNTS = ["PARTY1", "PARTY2", "PARTY3", "PARTY4", "PARTY5"];
const { campaigns } = joined([race, windows, party], {
  "race-probe": { version: 1, assignments: [{ model: "glm-free" }] },
  "window-probe": { version: 1, assignments: [{ model: "sonnet" }] },
  deadmines: { version: 1, assignments: [{ model: "sonnet" }], accounts: PARTY_ACCOUNTS },
});
/** A party job's five member specs, as the roster reads them back. */
function partySpecs(): Resolved[] {
  return specsOf(
    job({
      ref: "sonnet",
      episode: "probing",
      name: "deadmines-party-base",
      source: "pinned",
      account: "PARTY1",
      accounts: PARTY_ACCOUNTS,
      subscription: "CLAUDE_CODE_OAUTH_TOKEN_2",
      probe: { campaign: "deadmines", version: 1, cell: "party", arm: "base" },
    }),
    campaigns,
  );
}

/** One spec per lane and launch shape the roster emits. */
function everyLane(): { name: string; spec: Resolved; resume: boolean }[] {
  const out: { name: string; spec: Resolved; resume: boolean }[] = [];
  const add = (name: string, specs: Resolved[], resume = false): void => {
    for (const s of specs) out.push({ name, spec: s, resume });
  };
  add("e90 openai, routed and billed", specsOf(job({ ref: "glm-free", episode: "e90", attempt: 2 })));
  add("e90 extra", specsOf(job({ ref: "glm-free", episode: "e90", attempt: 4, extra: { race: 3, class: 3 } })));
  add("e360 claude-code with a window and a lane", specsOf(job({ ref: "sonnet-100k", episode: "e360", attempt: 1, subscription: "CLAUDE_CODE_OAUTH_TOKEN_2" })));
  add("e90 codex", specsOf(job({ ref: "astra", episode: "e90", attempt: 1 })));
  add(
    "freeplay, the policy's uncapped session, continued",
    specsOf(
      job({
        ref: "glm-free",
        episode: "freeplay",
        attempt: 1,
        continueFrom: "fleet-glm-free-freeplay-z-ai-glm-5-2-free-20261010",
        keepCharacters: ["Bromdir"],
      }),
    ),
  );
  add(
    "freeplay, a head dropped",
    specsOf(job({ ref: "glm-free", episode: "freeplay", attempt: 1, continueDropped: { runId: "fleet-x", reason: "account occupied" } })),
  );
  add("freeplay, a hand-written job", specsOf(job({ ref: "glm-free", episode: "freeplay", source: "queue", repeat: "loop" })));
  add("queue job, pinned", specsOf(job({ ref: "sonnet", episode: "e90", source: "pinned", account: "SHAKEOUT", repeat: 2 })));
  add("probe, release image", specsOf(job({ ref: "glm-free", episode: "probing", attempt: 1, probe: { campaign: "race-probe", version: 1, cell: "orc-warrior", arm: "base" } }), campaigns));
  add(
    "probe, an arm with its own window and args",
    specsOf(job({ ref: "sonnet", episode: "probing", attempt: 1, probe: { campaign: "window-probe", version: 1, cell: "a", arm: "w200k" } }), campaigns),
  );
  // A hand-written roster may say what the fleet never does: an objective,
  // coordinates, no wiki. The roster still builds argv for it.
  add("probe, a party's members on the second lane", partySpecs());
  add("hand roster, steered, on an account", resolve([{ model: "x/y", objective: "go north", wikiCoords: true, episode: "probing", account: "SHAKEOUT" } as RosterSpec], STAMP));
  add("hand roster, no wiki, no clock", resolve([{ model: "x/y", wiki: false, watchdogs: { episodeMs: null, idleMs: 0 } } as RosterSpec], STAMP));
  for (const { name, spec } of [...out]) out.push({ name: `${name}, resumed`, spec, resume: true });
  return out;
}

describe("the roster's argv, every lane, through run.ts's parser", () => {
  for (const { name, spec, resume } of everyLane()) {
    test(name, () => {
      const flags = episodeFlags(spec, resume);
      expect(() => parses(flags)).not.toThrow();
      // Both heads put the same flags after themselves.
      expect(episodeArgv(spec, resume, { container: true }).slice(2)).toEqual(flags);
      expect(episodeArgv(spec, resume).slice(1)).toEqual(flags);
    });
  }

  test("a fresh launch of every non-probe lane is accepted by the whole fresh-launch seam", () => {
    for (const { spec, resume } of everyLane()) {
      if (resume || spec.campaignFile !== undefined || spec.objective !== undefined) continue;
      expect(() => configFromArgs(episodeFlags(spec, false), {})).not.toThrow();
    }
  });

  test("a probe's argv carries its campaign file, its roster name and then the arm's own args, last", () => {
    const [spec] = specsOf(
      job({ ref: "sonnet", episode: "probing", attempt: 1, probe: { campaign: "window-probe", version: 1, cell: "a", arm: "w200k" } }),
      campaigns,
    );
    const flags = episodeFlags(spec!, false);
    expect(flags.slice(flags.indexOf("--episode"))).toEqual([
      "--episode",
      "probing",
      "--campaign-file",
      campaignFilePath(spec!.runId),
      "--ref",
      "sonnet",
      "--compact-window",
      "200k",
      "--step-interval-ms",
      "4000",
    ]);
    for (const f of PROBE_SHAPE_FLAGS) expect(flags).not.toContain(`--${f}`);
    const config = probeConfig(spec!);
    expect(config).toMatchObject({ episode: "probing", campaign: "window-probe", arm: "w200k", ref: "sonnet", compactWindow: "200k", stepIntervalMs: 4000 });
    expect(config.image).toBe("registry.example/wb/runner:t1");
    // A resume restates none of it: the arm's args are in the stored config.
    expect(episodeFlags(spec!, true)).not.toContain("--compact-window");
    expect(episodeFlags(spec!, true)).not.toContain("--campaign-file");
  });

  test("a party member's argv names its staged character, and the fresh-launch seam takes it as the member", () => {
    const specs = partySpecs();
    expect(specs.map((s) => [s.party?.member, s.account, s.tokenEnv])).toEqual([
      ["tank", "PARTY1", "CLAUDE_CODE_OAUTH_TOKEN_2"],
      ["healer", "PARTY2", "CLAUDE_CODE_OAUTH_TOKEN_2"],
      ["mage", "PARTY3", "CLAUDE_CODE_OAUTH_TOKEN_2"],
      ["rogue", "PARTY4", "CLAUDE_CODE_OAUTH_TOKEN_2"],
      ["paladin", "PARTY5", "CLAUDE_CODE_OAUTH_TOKEN_2"],
    ]);
    const healer = specs[1]!;
    const flags = episodeFlags(healer, false);
    expect(flags.slice(flags.indexOf("--episode"))).toEqual(["--episode", "probing", "--campaign-file", campaignFilePath(healer.runId), "--ref", "sonnet", "--character", "Brenna"]);
    const config = probeConfig(healer);
    expect(config).toMatchObject({ character: "Brenna", race: 1, class: 5, account: "PARTY2", subscription: "CLAUDE_CODE_OAUTH_TOKEN_2", party: { member: "healer", role: "healer", size: 5 } });
    expect(config.party!.id).toBe(specs[0]!.party!.id);
    // A resume restates none of it.
    expect(episodeFlags(healer, true)).not.toContain("--character");
  });

  test("a probe on the release image runs through the fresh-launch seam with the cell's shape", () => {
    const [spec] = specsOf(job({ ref: "glm-free", episode: "probing", attempt: 1, probe: { campaign: "race-probe", version: 1, cell: "orc-warrior", arm: "base" } }), campaigns);
    expect(probeConfig(spec!)).toMatchObject({ campaign: "race-probe", campaignVersion: 1, cell: "orc-warrior", arm: "base", race: 2, class: 1, stopAtLevel: 10 });
  });

  test("SUPERVISOR_FLAGS is exactly what the roster emits, and every one is a flag run.ts reads", () => {
    const emitted = new Set(everyLane().flatMap(({ spec, resume }) => flagsOf(episodeFlags(spec, resume))));
    // The arm's own args are not the supervisor's.
    emitted.delete("step-interval-ms");
    expect([...emitted].sort()).toEqual([...SUPERVISOR_FLAGS].sort());
    for (const f of SUPERVISOR_FLAGS) expect(RUN_FLAGS as readonly string[]).toContain(f);
  });

  test("an arm may set the window, and nothing else the supervisor or the definition owns", () => {
    expect(ARM_RESERVED_FLAGS).not.toContain("compact-window");
    for (const f of ["effort", "model", "driver", "ref", "campaign-file", "run-id", "runs-dir", "token", "module-url", ...PROBE_SHAPE_FLAGS]) {
      expect(ARM_RESERVED_FLAGS).toContain(f);
    }
  });
});

describe("claude-code's default compaction window, from the roster entry to the run's record (operator, 2026-11-10)", () => {
  const WINDOW_ROSTER: Record<string, FleetRosterEntry> = {
    ...ROSTER,
    "sonnet-auto": { model: "sonnet", driver: "claude-code", effort: "low", compactWindow: "auto", tier: "t2", idle: "unlimited" },
  };
  const launch = (j: FleetJob, cs: Parameters<typeof jobSpawn>[5] = []): Resolved =>
    resolve(jobSpawn(j, WINDOW_ROSTER, "RUNNER1", STAMP, () => true, cs).entries, STAMP)[0]!;
  const tupleOf = (c: ReturnType<typeof configFromArgs>): Record<string, unknown> => ({ ...comparabilityOf(c, "harness-0.5-1") });
  /** What a run launched before the default stored: no window anywhere. */
  const stored = loadRunConfig({ runId: "fleet-sonnet-e90-sonnet-low-20261001", driver: "claude-code", model: "sonnet", effort: "low", account: "RUNNER1", episode: "e90" });

  test("an entry with no window launches a scored run at 300k, recorded as the window it is; its argv and run id are what they were", () => {
    const spec = launch(job({ ref: "sonnet", episode: "e90", attempt: 1 }));
    const flags = episodeFlags(spec, false);
    // The supervisor states nothing: the runner fills the default in, so a hand launch gets it too.
    expect(flags).not.toContain("--compact-window");
    expect(launch(job({ ref: "sonnet", episode: "e90", attempt: 2 })).runId).toBe(`fleet-sonnet-e90-sonnet-low-${STAMP}-a2`);
    const config = configFromArgs(flags, {});
    expect(config.compactWindow).toBe("300k");
    expect(tupleOf(config)["compactWindow"]).toBe("300k");
    expect(compactEnv(config.compactWindow)).toEqual({ CLAUDE_CODE_AUTO_COMPACT_WINDOW: "300000" });
    // So it is never the row of a run made on auto: that run's tuple has no window.
    expect("compactWindow" in tupleOf({ ...stored, runId: "x", token: "t" })).toBe(false);
    expect(configFromArgs(["--driver", "claude-code", "--model", "sonnet"], {}).compactWindow).toBe("300k");
  });

  test("a record with no window reads as auto on a resume, whenever it was written", () => {
    // run.ts resumes through `loadRunConfig(meta.config)`, which fills nothing in.
    const resumed = loadRunConfig(JSON.parse(JSON.stringify(stored)));
    expect(resumed.compactWindow).toBeUndefined();
    expect(compactEnv(resumed.compactWindow)).toEqual({});
    expect(JSON.stringify(comparabilityOf(resumed, "harness-0.5-1"))).toBe(JSON.stringify(comparabilityOf(stored, "harness-0.5-1")));
    // And a defaulted run resumes at the 300k it recorded, restated by nothing.
    const fresh = configFromArgs(episodeFlags(launch(job({ ref: "sonnet", episode: "e90", attempt: 1 })), false), {});
    expect(loadRunConfig(JSON.parse(JSON.stringify(fresh))).compactWindow).toBe("300k");
    expect(episodeFlags(launch(job({ ref: "sonnet", episode: "e90", attempt: 1 })), true)).not.toContain("--compact-window");
  });

  test("an entry opts out with `auto`: stated on the argv, recorded as the absent field, the tuple a pre-default run's", () => {
    const spec = launch(job({ ref: "sonnet-auto", episode: "e90", attempt: 1 }));
    expect(spec.compactWindow).toBe("auto");
    const flags = episodeFlags(spec, false);
    expect(flags[flags.indexOf("--compact-window") + 1]).toBe("auto");
    // No `-auto` in the id: an auto run's id is what it always was.
    expect(spec.runId).toBe(`roster-sonnet-low-${STAMP}`);
    expect(launch(job({ ref: "sonnet-auto", episode: "e90", attempt: 2 })).runId).toBe(`fleet-sonnet-auto-e90-sonnet-low-${STAMP}-a2`);
    const config = configFromArgs(flags, {});
    expect(config.compactWindow).toBeUndefined();
    expect(Object.keys(tupleOf(config))).toEqual(Object.keys(comparabilityOf(stored, "harness-0.5-1")));
    expect(configFromArgs(["--driver", "claude-code", "--model", "sonnet", "--compact-window", "AUTO"], {}).compactWindow).toBeUndefined();
  });

  test("a stated window is still its own, and codex still defaults to its CLI's auto", () => {
    const small = launch(job({ ref: "sonnet-100k", episode: "e360", attempt: 1 }));
    expect(configFromArgs(episodeFlags(small, false), {}).compactWindow).toBe("100k");
    const codex = configFromArgs(episodeFlags(launch(job({ ref: "astra", episode: "e90", attempt: 1 })), false), {});
    expect(codex.compactWindow).toBeUndefined();
    expect("compactWindow" in tupleOf(codex)).toBe(false);
    expect(configFromArgs(["--driver", "stub"], {}).compactWindow).toBeUndefined();
  });

  test("a freeplay session takes the default on a fresh launch and on a continuation", () => {
    const spec = launch(job({ ref: "sonnet-auto", episode: "freeplay", attempt: 1 }));
    expect(configFromArgs(episodeFlags(spec, false), {}).compactWindow).toBeUndefined();
    const plain = resolve(
      jobSpawn(job({ ref: "sonnet", episode: "freeplay", attempt: 2, continueFrom: "fleet-sonnet-freeplay-sonnet-low-20261001" }), { ...ROSTER, sonnet: { ...ROSTER["sonnet"]!, idle: "unlimited" } }, "RUNNER1", STAMP, () => true, []).entries,
      STAMP,
    )[0]!;
    const config = configFromArgs(episodeFlags(plain, false), {});
    expect(config).toMatchObject({ episode: "freeplay", compactWindow: "300k", continuedFrom: "fleet-sonnet-freeplay-sonnet-low-20261001" });
  });

  test("a probe's window is its arm's or its entry's and nothing else: a published arm that passes none still runs the CLI's auto", () => {
    // The fixture's control arm, and the checked-in definition whose control is the absent flag.
    const auto = launch(job({ ref: "sonnet", episode: "probing", attempt: 1, probe: { campaign: "window-probe", version: 1, cell: "a", arm: "auto" } }), campaigns);
    expect(episodeFlags(auto, false)).not.toContain("--compact-window");
    expect(probeConfig(auto).compactWindow).toBeUndefined();
    const published = checkedIn("compact-window-claude@3");
    expect(published.arms.find((a) => a.id === "auto")!.args).toBeUndefined();
    const { campaigns: live } = joined([published], { "compact-window-claude": { version: 3, assignments: [{ model: "sonnet" }] } });
    const windowOfArm = (arm: string): string | undefined =>
      probeConfig(launch(job({ ref: "sonnet", episode: "probing", attempt: 1, probe: { campaign: "compact-window-claude", version: 3, cell: "dwarf-paladin", arm } }), live)).compactWindow;
    expect(published.arms.map((a) => [a.id, windowOfArm(a.id)])).toEqual([
      ["auto", undefined],
      ["100k", "100k"],
      ["200k", "200k"],
      ["300k", "300k"],
    ]);
    // An opted-out entry's probe states auto itself, and an arm may.
    const optOut = launch(job({ ref: "sonnet-auto", episode: "probing", attempt: 1, probe: { campaign: "window-probe", version: 1, cell: "a", arm: "auto" } }), joined([windows], { "window-probe": { version: 1, assignments: [{ model: "sonnet-auto" }] } }).campaigns);
    expect(probeConfig(optOut).compactWindow).toBeUndefined();
    expect(() => campaignDefinitionSchema.parse({ ...windows, arms: [{ id: "auto", args: ["--compact-window", "auto"] }] })).not.toThrow();
  });
});

describe("run.ts's parser", () => {
  test("refuses a flag it does not read, naming it", () => {
    expect(() => parseRunArgs(["--driver", "stub", "--step-intrval-ms", "5"])).toThrow(/--step-intrval-ms/);
    expect(() => configFromArgs(["--driver", "stub", "--campaign", "race-probe@1"], {})).toThrow(RunArgsError);
  });

  test("refuses a flag given twice, rather than letting the last win", () => {
    expect(() => parseRunArgs(["--compact-window", "100k", "--compact-window", "200k"])).toThrow(/--compact-window given more than once/);
  });

  test("refuses a word that is no flag's value", () => {
    expect(() => parseRunArgs(["--extra", "true", "stray"])).toThrow(/"stray"/);
  });

  test("reads bare and valued flags as before", () => {
    expect(parseRunArgs(["--extra", "--race", "3", "--wiki-coords", "true"])).toEqual({ extra: true, race: "3", "wiki-coords": "true" });
  });
});

// ----------------------------------------------------------- run-episode.sh

const SCRIPT = join(REPO_ROOT, "infra", "run-episode.sh");

/**
 * A shim standing in for bun, docker and kubectl: it records its argv, one
 * NUL-separated file per call, and answers the campaign-file helper with the
 * run id and path a real one prints.
 */
const SHIM = `#!/usr/bin/env bash
n=$(ls "$FAKE_CALLS" | wc -l)
printf '%s\\0' "$(basename "$0")" "$@" > "$FAKE_CALLS/$(printf '%03d' "$n")"
for a in "$@"; do
  if [ "$a" = "runner/src/campaign-file.ts" ]; then
    id=hand-run-1
    prev=""
    for b in "$@"; do [ "$prev" = "--run-id" ] && id="$b"; prev="$b"; done
    echo "$id data/runs/$id/campaign.json"
  fi
done
exit 0
`;

function runScript(args: readonly string[]): { code: number; err: string; calls: string[][] } {
  const dir = tempDir("wb-run-episode-");
  const bin = join(dir, "bin");
  const calls = join(dir, "calls");
  Bun.spawnSync(["mkdir", "-p", bin, calls]);
  for (const name of ["bun", "docker", "kubectl"]) {
    writeFileSync(join(bin, name), SHIM);
    chmodSync(join(bin, name), 0o755);
  }
  const p = Bun.spawnSync(["bash", SCRIPT, ...args], {
    cwd: REPO_ROOT,
    env: { PATH: `${bin}:/usr/bin:/bin`, HOME: dir, FAKE_CALLS: calls, WRATHBENCH_HARNESS_VERSION: "harness-0.5-test" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const recorded = existsSync(calls)
    ? readdirSync(calls)
        .sort()
        .map((f) => readFileSync(join(calls, f), "utf8").split("\0").slice(0, -1))
    : [];
  return { code: p.exitCode ?? 1, err: p.stderr.toString(), calls: recorded };
}

/** The flags after `runner/src/run.ts` in the call that launched it. */
function runFlags(calls: string[][]): string[] {
  const call = calls.find((c) => c.includes("runner/src/run.ts"));
  if (call === undefined) throw new Error(`run.ts was never launched: ${JSON.stringify(calls)}`);
  return call.slice(call.indexOf("runner/src/run.ts") + 1);
}

describe("infra/run-episode.sh, every head, through run.ts's parser", () => {
  const heads: [string, string[]][] = [
    ["--local", ["--local"]],
    ["--k8s", ["--k8s"]],
    ["compose", []],
  ];
  for (const [head, extra] of heads) {
    test(`${head}: a fresh launch passes its own flags through and strips the script's`, () => {
      const r = runScript([...extra, "--driver", "openai", "--model", "z-ai/glm-5.2:free", "--episode", "e90", "--race", "3", "--class", "2"]);
      expect(r.code).toBe(0);
      const flags = runFlags(r.calls);
      expect(flags).not.toContain("--local");
      expect(flags).not.toContain("--k8s");
      expect(parses(flags)).toMatchObject({ driver: "openai", model: "z-ai/glm-5.2:free", episode: "e90" });
    });

    test(`${head}: a resume`, () => {
      const r = runScript([...extra, "--resume", "fleet-x-e90-20261011", "--max-tool-calls", "0"]);
      expect(r.code).toBe(0);
      expect(parses(runFlags(r.calls))).toEqual({ resume: "fleet-x-e90-20261011", "max-tool-calls": "0" });
    });

    test(`${head}: a hand probe writes its campaign file where the store is, then launches run.ts on it`, () => {
      const r = runScript([...extra, "--driver", "openai", "--model", "z-ai/glm-5.2:free", "--campaign", "race-probe@1", "--cell", "orc-warrior", "--arm", "base"]);
      expect(r.code).toBe(0);
      const helper = r.calls.find((c) => c.includes("runner/src/campaign-file.ts"))!;
      expect(helper.slice(helper.indexOf("runner/src/campaign-file.ts") + 1)).toEqual(["--campaign", "race-probe@1", "--cell", "orc-warrior", "--arm", "base"]);
      // The helper runs in the same place run.ts does.
      const runCall = r.calls.find((c) => c.includes("runner/src/run.ts"))!;
      expect(helper.slice(0, helper.indexOf("bun"))).toEqual(runCall.slice(0, runCall.indexOf("bun")));
      expect(parses(runFlags(r.calls))).toEqual({
        driver: "openai",
        model: "z-ai/glm-5.2:free",
        "run-id": "hand-run-1",
        "campaign-file": "data/runs/hand-run-1/campaign.json",
      });
    });
  }

  test("a hand probe keeps the run id it was given", () => {
    const r = runScript(["--local", "--model", "m", "--run-id", "mine", "--campaign", "race-probe@1", "--cell", "orc-warrior"]);
    expect(parses(runFlags(r.calls))).toMatchObject({ "run-id": "mine", "campaign-file": "data/runs/mine/campaign.json" });
  });

  test("a cell without a campaign, and a campaign without a cell, are refused before anything runs", () => {
    expect(runScript(["--local", "--model", "m", "--cell", "orc-warrior"])).toMatchObject({ code: 2, calls: [] });
    expect(runScript(["--local", "--model", "m", "--campaign", "race-probe@1"])).toMatchObject({ code: 2, calls: [] });
  });
});

describe("the smoke scripts", () => {
  test("launch no run: none of them calls run.ts, so none has an argv to keep in step", () => {
    const dir = join(REPO_ROOT, "infra", "smoke");
    const files: string[] = [];
    const walk = (d: string): void => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        if (e.isDirectory()) walk(join(d, e.name));
        else if (e.name.endsWith(".ts") || e.name.endsWith(".sh")) files.push(join(d, e.name));
      }
    };
    walk(dir);
    expect(files.length).toBeGreaterThan(0);
    // A smoke that starts launching runs belongs in this file's argv tests.
    expect(files.filter((f) => /runner\/src\/run\.ts|run-episode\.sh/.test(readFileSync(f, "utf8")))).toEqual([]);
  });
});

describe("the campaign file a fresh probe carries", () => {
  test("reads back as itself", () => {
    const pub = joined([race], {}).definitions[0]!;
    const f = campaignFileOf(pub, "orc-warrior");
    expect(parseCampaignFile(JSON.parse(JSON.stringify(f)))).toEqual(f);
  });
});
