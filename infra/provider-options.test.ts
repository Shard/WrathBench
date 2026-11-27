/**
 * One roster entry per model, with its providers in preference order
 * (operator, 2026-11-16; runner/src/provider-options.ts): the schema, the
 * launch on the first provider with room, the resume on the provider a run
 * started on, single-provider entries as they were, and the merge of the two
 * DeepSeek V4.1 Flash entries into one over a fixture of their history.
 */
import { describe, expect, test } from "bun:test";

import { parseFleet, type FleetConfig } from "./run-fleet-config";
import { charactersFrom } from "./run-fleet-plan";
import { modelListsToRead } from "./run-fleet-model-lists";
import { planOf } from "./fixtures/tick";
import { countedFact } from "../runner/test/fixtures/counted-fact";
import { entryOwnsRun, type RunFact } from "../runner/src/models";
import { rosterEntryRefusal } from "../runner/src/roster-refusal";
import { rowOf } from "../viewer/models";
import { parseCredentials } from "../runner/src/credential-slots";
import { OPENCODE_GO_ROUTING } from "../runner/src/routing";

const NOW = Date.UTC(2026, 10, 16, 12);
const H = 3_600_000;
const STAMP = "20261116";
const SERIES = "1.0";
const GO = "https://opencode.ai/inference/go/openai/v1";

const CREDENTIALS = {
  opencodego: { provider: "opencode-go", secretEnv: "OPENCODE_KEY", slots: 2, billing: "paid", enabled: true },
  "openrouter-1": { provider: "openrouter", secretEnv: "OPENROUTER_KEY", slots: 1, billing: "paid", enabled: true },
};

/** The merged entry, exactly as the migration in the PR body writes it. */
const MERGED = {
  model: "deepseek-v4.1-flash",
  tier: "t1",
  idle: "unlimited",
  chooseStart: true,
  providers: [
    { credential: "opencodego", apiBase: GO },
    { credential: "openrouter-1", model: "deepseek/deepseek-v4.1-flash", routing: "GMICloud" },
  ],
};

/** The two entries it replaces, as the live store holds them (idle made `unlimited` here, so the character's lane is open). */
const BEFORE = {
  "deepseek-v41-flash-go": { model: "deepseek-v4.1-flash", apiBase: GO, credential: "opencodego", tier: "t1", idle: "unlimited", chooseStart: true },
  "deepseek-v41-flash-or": { model: "deepseek/deepseek-v4.1-flash", routing: "GMICloud", billing: "paid", credential: "openrouter-1", tier: "t0", idle: "none", campaignOnly: true },
};

function fleet(roster: Record<string, unknown>, credentials: Record<string, unknown> = CREDENTIALS): FleetConfig {
  const cfg = parseFleet({ _notes: ["n"], credentials, roster, queue: [] }, { env: { WRATHBENCH_POOL_SIZE: "3" } });
  return { ...cfg, policy: { ...cfg.policy, series: SERIES } };
}

const goRun = (i: number, over: Partial<RunFact> = {}): RunFact => ({
  ...countedFact({ model: "deepseek-v4.1-flash", driver: "openai" }, "e90", 4, { i, now: NOW, series: SERIES }),
  runId: `fleet-deepseek-v41-flash-go-e90-deepseek-v4-1-flash-20261115-a${i}`,
  routing: { ...OPENCODE_GO_ROUTING },
  credential: "opencodego",
  account: "POOL01",
  ...over,
});
const orRun = (i: number, over: Partial<RunFact> = {}): RunFact => ({
  ...countedFact({ model: "deepseek/deepseek-v4.1-flash", driver: "openai" }, "e90", 3, { i, now: NOW, series: SERIES }),
  runId: `fleet-deepseek-v41-flash-or-e90-deepseek-deepseek-v4-1-flash-20261115-a${i}`,
  credential: "openrouter-1",
  account: "POOL02",
  ...over,
});
/** Zulkar: the Go entry's freeplay character, paused. */
const zulkar = (over: Partial<RunFact> = {}): RunFact =>
  goRun(9, {
    runId: "fleet-deepseek-v41-flash-go-freeplay-deepseek-v4-1-flash-20261115",
    episode: "freeplay",
    extra: true,
    episodeMs: null,
    character: "Zulkar",
    account: "POOL03",
    endedAt: NOW - 2 * H,
    terminationReason: null,
    pause: { reason: "offline", at: NOW - 2 * H, count: 1, episodeElapsedMs: 40 * 60_000 },
    ...over,
  });

describe("the schema", () => {
  test("a providers list parses: the entry's own model, base and routing are its first provider's", () => {
    const e = fleet({ ds: MERGED }).roster["ds"]!;
    expect(e.refused).toBeUndefined();
    expect(e.providers).toEqual([
      { credential: "opencodego", model: "deepseek-v4.1-flash", apiBase: GO },
      { credential: "openrouter-1", model: "deepseek/deepseek-v4.1-flash", routing: { order: ["GMICloud"], allowFallbacks: false } },
    ]);
    expect([e.model, e.apiBase, e.routing, e.credential]).toEqual(["deepseek-v4.1-flash", GO, undefined, undefined]);
  });

  test("a malformed list takes the file down by name", () => {
    const bad = (providers: unknown, extra: Record<string, unknown> = {}): () => FleetConfig => () => fleet({ ds: { ...MERGED, ...extra, providers } });
    expect(bad([])).toThrow(/providers is a non-empty list/);
    expect(bad([{ apiBase: GO }])).toThrow(/credential is required/);
    expect(bad([{ credential: "opencodego" }, { credential: "opencodego" }])).toThrow(/credential opencodego is named twice/);
    expect(bad([{ credential: "opencodego", key: "x" }])).toThrow(/unknown key `key`/);
    expect(bad(MERGED.providers, { apiBase: GO })).toThrow(/with providers, apiBase is each provider's/);
    expect(bad(MERGED.providers, { credential: "opencodego" })).toThrow(/with providers, credential is each provider's/);
    // A provider is validated as the entry it launches as: routing only on OpenRouter.
    expect(bad([{ credential: "opencodego", apiBase: GO, routing: "Z.AI" }])).toThrow(/routing/);
  });

  test("a provider that cannot carry the entry refuses the entry, named by its credential", () => {
    // openrouter-1 is an OpenRouter credential; the Go base is not OpenRouter's.
    const e = fleet({ ds: { ...MERGED, providers: [{ credential: "openrouter-1", apiBase: GO }] } }).roster["ds"]!;
    expect(e.refused).toMatch(/^provider openrouter-1: /);
    // The viewer's reading of the raw document says the same.
    const r = rosterEntryRefusal({ ...MERGED, providers: [{ credential: "openrouter-1", apiBase: GO }] }, parseCredentials(CREDENTIALS));
    expect(r?.why).toMatch(/^provider openrouter-1: /);
  });

  test("a single-provider entry is unchanged", () => {
    const cfg = fleet(BEFORE);
    expect(cfg.roster["deepseek-v41-flash-go"]).toMatchObject({ model: "deepseek-v4.1-flash", apiBase: GO, credential: "opencodego" });
    expect(cfg.roster["deepseek-v41-flash-go"]!.providers).toBeUndefined();
    expect(cfg.roster["deepseek-v41-flash-or"]!.routing).toEqual({ order: ["GMICloud"], allowFallbacks: false });
  });

  test("every provider's model list is read", () => {
    const lists = modelListsToRead(fleet({ ds: MERGED }).roster, {});
    expect(lists.map((l) => [l.source.provider, l.models]).sort()).toEqual([
      ["opencode-go", ["deepseek-v4.1-flash"]],
      ["openrouter", ["deepseek/deepseek-v4.1-flash"]],
    ]);
  });
});

describe("the scheduler", () => {
  test("a launch takes the first provider with room, and runs as that provider", () => {
    const plan = planOf(fleet({ ds: { ...MERGED, idle: "none" } }), { now: NOW, stamp: STAMP });
    expect(plan.picks.map((p) => [p.job.name, p.job.placed?.["ds"]?.id])).toEqual([["ds-e90", "opencodego"]]);
    const entry = plan.spawns.find((s) => s.name === "ds-e90")!.entries[0]!;
    expect([entry.model, entry.apiBase, entry.routing, entry.placedOn?.id]).toEqual(["deepseek-v4.1-flash", GO, undefined, "opencodego"]);
    expect("providers" in entry).toBe(false);
  });

  test("with the first provider's credential off, the next one takes it, as itself", () => {
    const cfg = fleet({ ds: { ...MERGED, idle: "none" } }, { ...CREDENTIALS, opencodego: { ...CREDENTIALS.opencodego, enabled: false } });
    const plan = planOf(cfg, { now: NOW, stamp: STAMP });
    expect(plan.picks.map((p) => p.job.placed?.["ds"]?.id)).toEqual(["openrouter-1"]);
    const entry = plan.spawns.find((s) => s.name === "ds-e90")!.entries[0]!;
    expect([entry.model, entry.apiBase, entry.routing]).toEqual(["deepseek/deepseek-v4.1-flash", undefined, { order: ["GMICloud"], allowFallbacks: false }]);
  });

  test("with neither provider able to take it, the pick is held and says why for each", () => {
    const off = (c: { enabled: boolean }) => ({ ...c, enabled: false });
    const cfg = fleet({ ds: { ...MERGED, idle: "none" } }, { opencodego: off(CREDENTIALS.opencodego), "openrouter-1": off(CREDENTIALS["openrouter-1"]) });
    const plan = planOf(cfg, { now: NOW, stamp: STAMP });
    expect(plan.picks).toEqual([]);
    expect(plan.holds.find((h) => h.name === "ds")?.why).toMatch(/^no provider has room \(opencodego: .*; openrouter-1: /);
  });

  test("targets count every provider's runs, which are the entry's", () => {
    const cfg = fleet({ ds: { ...MERGED, idle: "none" } });
    const plan = planOf(cfg, { now: NOW, stamp: STAMP, runs: [goRun(1), orRun(2), goRun(3)] });
    expect(plan.states[0]!.perEpisode.e90).toMatchObject({ counted: 3, target: 3, attempts: 3 });
    expect(plan.picks.map((p) => p.job.episode)).toEqual([]);
    expect(entryOwnsRun(cfg.roster["ds"]!, orRun(1))).toBe(true);
    // The models row says where each provider serves it, in order.
    expect(rowOf(plan.states[0]!, [goRun(1), orRun(2), goRun(3)], "/nonexistent").platforms).toEqual(["opencode.ai", "openrouter"]);
  });

  test("a paused run resumes on the provider it started on, waits while that provider has no room, and ends once the provider leaves the list", () => {
    const paused = zulkar({ runId: "fleet-ds-freeplay-deepseek-deepseek-v4-1-flash-20261116", model: "deepseek/deepseek-v4.1-flash", routing: undefined, credential: "openrouter-1" });
    const plan = planOf(fleet({ ds: MERGED }), { now: NOW, stamp: STAMP, runs: [goRun(1), goRun(2), goRun(3), paused] });
    const back = plan.resumed.find((r) => r.plan.runId === paused.runId)!;
    expect(back.job.placed?.["ds"]?.id).toBe("openrouter-1");
    expect(back.spawn.entries[0]).toMatchObject({ runId: paused.runId, model: "deepseek/deepseek-v4.1-flash", placedOn: { id: "openrouter-1" } });
    // Its provider's credential off: the run waits for it, never moving to Go, whose credential has room.
    const off = fleet({ ds: MERGED }, { ...CREDENTIALS, "openrouter-1": { ...CREDENTIALS["openrouter-1"], enabled: false } });
    const waiting = planOf(off, { now: NOW, stamp: STAMP, runs: [goRun(1), goRun(2), goRun(3), paused] });
    expect(waiting.resumed.map((r) => r.plan.runId)).toEqual([]);
    expect([...waiting.holds.map((h) => h.why), ...waiting.resumes.listed.filter((l) => l.runId === paused.runId).map((l) => l.why)].join("\n")).toMatch(/openrouter-1/);
    // The OpenRouter provider dropped from the entry: the entry no longer names that model, so the run is ended,
    // as a paused run whose ref now names another model always is; the character carries on in the next session.
    const goOnly = planOf(fleet({ ds: { ...MERGED, providers: [MERGED.providers[0]] } }), { now: NOW, stamp: STAMP, runs: [goRun(1), goRun(2), goRun(3), paused] });
    expect(goOnly.resumed.map((r) => r.plan.runId)).toEqual([]);
    expect(goOnly.resumes.end.map((e) => [e.runId, e.detail])).toEqual([[paused.runId, "ended by the supervisor: model deepseek/deepseek-v4.1-flash no longer under ref ds"]]);
  });
});

describe("the migration of the two DeepSeek V4.1 Flash entries into one", () => {
  const history = (): RunFact[] => [goRun(1), goRun(2), orRun(1, { episode: "probing", campaign: "c", arm: "a", ref: "deepseek-v41-flash-or" } as Partial<RunFact>), zulkar()];

  test("before: two entries, Zulkar the Go entry's character", () => {
    const cfg = fleet(BEFORE);
    expect(charactersFrom(history(), cfg.roster, SERIES).get("deepseek-v41-flash-go")?.character).toBe("Zulkar");
  });

  test("after: one entry keeps Zulkar, resumes it on Go, and owns both providers' history", () => {
    const cfg = fleet({ "deepseek-v41-flash": MERGED });
    const runs = history();
    // The character is the merged entry's: the same run, so the same account and name.
    const head = charactersFrom(runs, cfg.roster, SERIES).get("deepseek-v41-flash");
    expect([head?.runId, head?.character, head?.account]).toEqual([zulkar().runId, "Zulkar", "POOL03"]);
    // The paused run comes back under the merged entry, on its own Go credential and account.
    const plan = planOf(cfg, { now: NOW, stamp: STAMP, runs });
    const back = plan.resumed.find((r) => r.plan.runId === zulkar().runId);
    expect(back?.plan.account).toBe("POOL03");
    expect(back?.job.placed?.["deepseek-v41-flash"]?.id).toBe("opencodego");
    expect(back?.spawn.entries[0]).toMatchObject({ model: "deepseek-v4.1-flash", apiBase: GO });
    // Both providers' runs are its own: the Go e90s count toward its target, and new run ids cannot meet the old ones.
    expect(plan.states[0]!.perEpisode.e90).toMatchObject({ counted: 2, target: 3 });
    for (const f of runs) if (f.episode !== "probing") expect(entryOwnsRun(cfg.roster["deepseek-v41-flash"]!, f)).toBe(true);
  });
});
