/**
 * Two operator decisions about freeplay (2026-11-15), planned through the
 * supervisor's own tick (`planTick`) over fixture runs:
 *
 * - A held (`campaignOnly`) entry may still play freeplay: `idle: "unlimited"`
 *   on it gives the model one freeplay session at a time and no scored run.
 * - A freeplay character does not carry across a harness series: a series'
 *   first session of a model starts a fresh character, and the earlier
 *   series' characters stay in the realm, untouched by hygiene.
 */
import { describe, expect, test } from "bun:test";

import { parseFleet, type FleetConfig } from "./run-fleet-config";
import { charactersFrom, formerCharactersFrom, isExtraJob, keepFor } from "./run-fleet-plan";
import { planOf } from "./fixtures/tick";
import type { RunFact } from "../runner/src/run-fact";

const NOW = Date.UTC(2026, 10, 15, 12);
const H = 3_600_000;
const POOL = ["RUNNER4", "RUNNER5", "RUNNER6"];
const OPUS = "z-ai/glm-5.2:free";
const DSF = "stealth/ox-alpha:free";

const CREDENTIALS = {
  "or-free": { provider: "openrouter", secretEnv: "OPENROUTER_KEY", slots: 4, billing: "free", enabled: true },
};

/** The cutover's shape: two held entries that play freeplay, one held entry that plays nothing. */
const ROSTER = {
  opus: { tier: "t1", model: OPUS, campaignOnly: true, idle: "unlimited", race: 3, class: 2 },
  dsf: { tier: "t1", model: DSF, campaignOnly: true, idle: "unlimited", chooseStart: true },
  quiet: { tier: "t2", model: "z-ai/glm-5.3-flash:free", campaignOnly: true },
};

function fleet(series: string, roster: Record<string, unknown> = ROSTER): FleetConfig {
  const cfg = parseFleet({ _notes: ["n"], accounts: { pool: POOL }, credentials: CREDENTIALS, roster, queue: [] }, { env: {} });
  return { ...cfg, policy: { ...cfg.policy, series } };
}

/** A freeplay run of `model`, ended unless `over` says otherwise. */
function freeplay(runId: string, series: string, over: Partial<RunFact> = {}): RunFact {
  return {
    runId,
    model: OPUS,
    effort: null,
    driver: "openrouter",
    episode: "freeplay",
    episodeOverride: false,
    harnessVersion: `harness-${series}-1-gx`,
    harnessSeries: series,
    extra: true,
    startedAt: NOW - 30 * 24 * H,
    endedAt: NOW - 20 * 24 * H,
    terminationReason: "idle",
    modelResponses: 4000,
    bestLevel: 22,
    live: false,
    pause: null,
    account: "RUNNER2",
    character: "Brannagh",
    episodeMs: null,
    campaign: null,
    cell: null,
    credential: null,
    ...over,
  };
}

const OLD = freeplay("fleet-opus-freeplay-z-ai-glm-5-2-free-20261020", "0.5");

describe("a held (campaignOnly) entry with idle unlimited", () => {
  test("parses, and the other bad campaignOnly combinations are still refused", () => {
    const cfg = fleet("1.0");
    expect(cfg.roster["opus"]).toMatchObject({ campaignOnly: true, idle: "unlimited", race: 3, class: 2 });
    expect(cfg.roster["quiet"]).toMatchObject({ campaignOnly: true, idle: "none" });
    expect(cfg.refusals).toEqual([]);
    const ds = { tier: "t0", model: DSF };
    const parse = (e: Record<string, unknown>) => () => fleet("1.0", { ds: { ...ds, ...e } });
    expect(parse({ campaignOnly: false, idle: "unlimited" })).toThrow(/campaignOnly is true or absent/);
    expect(parse({ campaignOnly: true, idle: "unlimited", deadmines: true })).toThrow(/campaignOnly entry runs no scored episode/);
    expect(parse({ campaignOnly: true, idle: "always" })).toThrow(/idle/);
  });

  test("gets exactly one freeplay launch each, no scored pick, and its start keys reach the launch", () => {
    const plan = planOf(fleet("1.0"), { now: NOW });
    expect(plan.picks.map((p) => [p.job.ref, p.job.episode, isExtraJob(p.job)])).toEqual([
      ["opus", "freeplay", true],
      ["dsf", "freeplay", true],
    ]);
    expect(plan.holds.filter((h) => h.by === "policy")).toEqual([]);
    const spawnOf = (ref: string) => plan.spawns.find((s) => s.name === `${ref}-freeplay`)!;
    expect(spawnOf("opus").entries).toHaveLength(1);
    expect(spawnOf("opus").entries[0]).toMatchObject({ model: OPUS, episode: "freeplay", race: 3, class: 2 });
    expect(spawnOf("dsf").entries[0]).toMatchObject({ model: DSF, episode: "freeplay", chooseStart: true });
    expect(spawnOf("dsf").entries[0]!.race).toBeUndefined();
    // The held entry with no idle work stays free for a campaign and gets nothing.
    expect(plan.spawns.some((s) => s.name.startsWith("quiet-"))).toBe(false);
    const quiet = plan.states.find((s) => s.name === "quiet")!;
    expect(quiet).toMatchObject({ idle: "none", eligible: [], probeOnly: true, campaignOnly: true });
    const opus = plan.states.find((s) => s.name === "opus")!;
    expect(opus).toMatchObject({ idle: "unlimited", eligible: [], probeOnly: true, campaignOnly: true });
    expect(opus.perEpisode.e90!.target).toBe(0);
  });

  test("on the next tick its live session is kept, not drained, and no second one starts", () => {
    const liveRun = freeplay("fleet-opus-freeplay-z-ai-glm-5-2-free-20261115", "1.0", {
      startedAt: NOW - 10 * 60_000,
      endedAt: NOW - 30_000,
      heartbeatAt: NOW - 30_000,
      terminationReason: null,
      live: true,
      account: "RUNNER4",
      character: "Durgan",
    });
    const plan = planOf(fleet("1.0"), {
      now: NOW,
      runs: [liveRun],
      running: [{ name: "opus-freeplay", account: "RUNNER4", refs: ["opus"], episode: "freeplay", runIds: [liveRun.runId] }],
    });
    expect(plan.drainReasons.size).toBe(0);
    expect(plan.spawns.find((s) => s.name === "opus-freeplay")).toMatchObject({ enabled: true, account: "RUNNER4" });
    expect(plan.picks.map((p) => p.job.ref)).toEqual(["dsf"]);
  });

  test("a hand-written freeplay queue job naming it stays gated", () => {
    const cfg = parseFleet(
      { _notes: ["n"], accounts: { pool: POOL }, credentials: CREDENTIALS, roster: ROSTER, queue: [{ ref: "opus", episode: "freeplay", repeat: 1, enabled: true }] },
      { env: {} },
    );
    const plan = planOf({ ...cfg, policy: { ...cfg.policy, series: "1.0" } }, { now: NOW });
    expect(plan.queue.assign).toEqual([]);
    expect(plan.queue.skipped.map((s) => s.job.ref)).toEqual(["opus"]);
  });
});

describe("a freeplay character does not carry across a harness series", () => {
  test("an ENDED 0.5 head off the pool: the 1.0 session starts fresh on a pool account, and the 0.5 character is not swept", () => {
    const plan = planOf(fleet("1.0"), { now: NOW, runs: [OLD] });
    const pick = plan.picks.find((p) => p.job.ref === "opus")!;
    expect(POOL).toContain(pick.account);
    expect(pick.job.continueFrom).toBeUndefined();
    expect(pick.job.continueDropped).toBeUndefined();
    expect(plan.waiting).toEqual([]);
    expect(plan.dropped).toEqual([]);
    // RUNNER2 is free and is the model's last account: only the protection keeps the sweep off it.
    expect(plan.sweeps).toEqual([]);
    expect(plan.spawns.find((s) => s.name === "opus-freeplay")!.entries[0]!.continueFrom).toBeUndefined();
  });

  test("an ENDED 0.5 head ON a pool account: the fresh 1.0 launch there keeps it", () => {
    const old = { ...OLD, account: "RUNNER5" };
    const plan = planOf(fleet("1.0"), { now: NOW, runs: [old] });
    const pick = plan.picks.find((p) => p.job.ref === "opus")!;
    // Affinity still prefers the model's last account; the character there is kept, not continued.
    expect(pick.account).toBe("RUNNER5");
    expect(pick.job.continueFrom).toBeUndefined();
    expect(pick.job.keepCharacters).toEqual(["Brannagh"]);
    expect(plan.spawns.find((s) => s.name === "opus-freeplay")!.entries[0]!.keepCharacters).toEqual(["Brannagh"]);
  });

  test("a PAUSED 0.5 freeplay run is not resumed, not ended, holds nothing, and its character is kept", () => {
    const pausedOld = { ...OLD, terminationReason: null, endedAt: NOW - 2 * H, pause: { reason: "operator-pause", at: NOW - 2 * H, count: 1, episodeElapsedMs: 40 * H } };
    for (const account of ["RUNNER2", "RUNNER5"]) {
      const plan = planOf(fleet("1.0"), { now: NOW, runs: [{ ...pausedOld, account }] });
      expect(plan.resumes.resume).toEqual([]);
      expect(plan.resumed).toEqual([]);
      expect(plan.ends).toEqual([]);
      expect(plan.resumes.end).toEqual([]);
      const opus = plan.states.find((s) => s.name === "opus")!;
      expect(opus.paused).toBeUndefined();
      const pick = plan.picks.find((p) => p.job.ref === "opus")!;
      expect(pick.job.episode).toBe("freeplay");
      expect(pick.job.continueFrom).toBeUndefined();
      expect(plan.holds.filter((h) => h.refs.includes("opus"))).toEqual([]);
      expect(plan.sweeps).toEqual([]);
      if (account === "RUNNER5") expect(pick.job.keepCharacters).toEqual(["Brannagh"]);
    }
  });

  test("a pinned launch on an old account keeps the earlier series' character there", () => {
    const cfg = parseFleet(
      {
        _notes: ["n"],
        accounts: { pool: POOL },
        credentials: CREDENTIALS,
        roster: { ...ROSTER, fp: { tier: "t0", model: "z-ai/glm-5.3-flash:free" } },
        queue: [{ ref: "fp", episode: "freeplay", repeat: "loop", enabled: true, account: "RUNNER2" }],
      },
      { env: {} },
    );
    const plan = planOf({ ...cfg, policy: { ...cfg.policy, series: "1.0" } }, { now: NOW, runs: [OLD] });
    expect(plan.pinned.map((p) => [p.job.name, p.spawn.account, p.spawn.entries[0]!.keepCharacters])).toEqual([["fp-freeplay", "RUNNER2", ["Brannagh"]]]);
    // On the old series nothing is former, so nothing is kept: as before.
    const same = planOf({ ...cfg, policy: { ...cfg.policy, series: "0.5" } }, { now: NOW, runs: [OLD] });
    expect(same.pinned[0]!.spawn.entries[0]!.keepCharacters).toBeUndefined();
  });

  test("within the series the head is continued as before, the older series' character beside it kept", () => {
    // On the pool's last account, so the other held entry's fresh pick (first free) does not take it.
    const cur = freeplay("fleet-opus-freeplay-z-ai-glm-5-2-free-20261115", "1.0", { account: "RUNNER6", character: "Durgan", startedAt: NOW - 5 * H, endedAt: NOW - H });
    const old = { ...OLD, account: "RUNNER6" };
    const plan = planOf(fleet("1.0"), { now: NOW, runs: [old, cur] });
    const pick = plan.picks.find((p) => p.job.ref === "opus")!;
    expect(pick.account).toBe("RUNNER6");
    expect(pick.job.continueFrom).toBe(cur.runId);
    expect(pick.job.keepCharacters).toEqual(["Brannagh"]);
  });

  test("the head lookup and the former characters, directly", () => {
    const cfg = fleet("1.0");
    const cur = freeplay("fleet-opus-freeplay-z-ai-glm-5-2-free-20261115", "1.0", { account: "RUNNER4", character: "Durgan", startedAt: NOW - 5 * H });
    expect(charactersFrom([OLD], cfg.roster, "1.0").has("opus")).toBe(false);
    expect(charactersFrom([OLD, cur], cfg.roster, "1.0").get("opus")?.runId).toBe(cur.runId);
    // No series (an unversioned checkout) filters nothing, as `inSeries` does.
    expect(charactersFrom([OLD], cfg.roster, null).get("opus")?.runId).toBe(OLD.runId);
    expect(formerCharactersFrom([OLD, cur], cfg.roster, null)).toEqual([]);
    // Every roster entry's, whatever its idle now; the newest of each series.
    const older = freeplay("fleet-opus-freeplay-z-ai-glm-5-2-free-20260901", "0.4", { account: "RUNNER7", character: "Thalvorn" });
    const quiet = freeplay("fleet-quiet-freeplay-z-ai-glm-5-3-flash-free-20261001", "0.5", { model: "z-ai/glm-5.3-flash:free", account: "RUNNER8", character: "Ysolde" });
    const former = formerCharactersFrom([OLD, older, quiet, cur], cfg.roster, "1.0");
    expect(former.map((c) => c.character).sort()).toEqual(["Brannagh", "Thalvorn", "Ysolde"]);
    // Kept by a launch of the entry itself, which never continues it.
    expect(keepFor("RUNNER2", new Map(), "opus", former)).toEqual(["Brannagh"]);
  });
});
