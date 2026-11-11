/**
 * The deployment's groups (runner/viewer/groups.ts) as the viewer, the
 * publisher's renderer and the supervisor read them: an off group's routes are
 * unknown paths, its aggregates are not rendered, its jobs read as disabled,
 * and every group on is today's deployment, byte for byte where it is
 * published.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApi } from "../viewer/api";
import { createRenderer } from "../viewer/snapshot";
import { projectInfo } from "../viewer/public-projection";
import type { ApiInfoResponse } from "../viewer/api-types";
import {
  ALL_GROUPS,
  adminFromEnv,
  groupOfApiPath,
  groupsEnvValue,
  groupsFromEnv,
  pageMounted,
  type Groups,
} from "../viewer/groups";
import { parseFleet, rosterModels, withoutEvals } from "../../infra/run-fleet-config";
import { forGroups, formatGroupsBanner, formatModels, formatOutstandingFor, formatQueue, planDryRun } from "../../infra/run-fleet-status";
import { modelStates } from "../src/models";
import { rowOf } from "../viewer/models";

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function handle(groups?: Groups, publicMode = false): ReturnType<typeof createApi> {
  const root = mkdtempSync(join(tmpdir(), "groups-"));
  roots.push(root);
  return createApi({
    runsDir: join(root, "runs"),
    tilesDir: join(root, "tiles"),
    configDbPath: join(root, "config.sqlite"),
    moduleUrl: "http://127.0.0.1:1",
    ...(groups !== undefined ? { groups } : {}),
    ...(publicMode ? { publicMode } : {}),
  });
}

const get = async (h: ReturnType<typeof createApi>, path: string): Promise<Response> => await h(new Request(`http://x${path}`));

describe("WRATHBENCH_GROUPS", () => {
  test("unset is every group; set lists the ones that are on; empty is none", () => {
    expect(groupsFromEnv({})).toEqual(ALL_GROUPS);
    expect(groupsFromEnv({ WRATHBENCH_GROUPS: "viewer" })).toEqual({ runner: false, evals: false, viewer: true });
    expect(groupsFromEnv({ WRATHBENCH_GROUPS: " runner , viewer " })).toEqual({ runner: true, evals: false, viewer: true });
    expect(groupsFromEnv({ WRATHBENCH_GROUPS: "" })).toEqual({ runner: false, evals: false, viewer: false });
    expect(groupsEnvValue({ runner: true, evals: false, viewer: true })).toBe("runner,viewer");
  });

  test("a name that is not a group is refused, not read as off", () => {
    expect(() => groupsFromEnv({ WRATHBENCH_GROUPS: "viewer,eval" })).toThrow('"eval" is not a group');
  });

  test("the admin switch is WRATHBENCH_ADMIN=1 and nothing else", () => {
    expect(adminFromEnv({})).toBe(false);
    expect(adminFromEnv({ WRATHBENCH_ADMIN: "1" })).toBe(true);
    expect(adminFromEnv({ WRATHBENCH_ADMIN: "true" })).toBe(false);
  });

  test("routes and pages belong to the groups the issue names", () => {
    expect(groupOfApiPath("/api/fleet")).toBe("runner");
    expect(groupOfApiPath("/api/models")).toBe("runner");
    expect(groupOfApiPath("/api/ladder")).toBe("evals");
    expect(groupOfApiPath("/api/campaigns")).toBe("evals");
    expect(groupOfApiPath("/api/episodes")).toBe("evals");
    for (const p of ["/api/runs", "/api/results", "/api/positions", "/api/info", "/api/tools", "/api/run/x"]) expect(groupOfApiPath(p)).toBeNull();
    const viewerOnly: Groups = { runner: false, evals: false, viewer: true };
    for (const p of ["/", "/map", "/runs", "/run/x", "/character/x", "/party/x"]) expect(pageMounted(p, viewerOnly, false)).toBe(true);
    for (const p of ["/fleet", "/models", "/ladder", "/campaigns/x/1", "/about", "/config"]) expect(pageMounted(p, viewerOnly, false)).toBe(false);
    expect(pageMounted("/config", ALL_GROUPS, true)).toBe(true);
    expect(pageMounted("/config", ALL_GROUPS, false)).toBe(false);
  });
});

describe("the viewer's routes", () => {
  test("an off group's routes are the 404 any unknown path gets; the viewer's own stay", async () => {
    const h = handle({ runner: false, evals: false, viewer: true });
    for (const p of ["/api/fleet", "/api/models", "/api/ladder?episode=e90", "/api/campaigns", "/api/episodes"]) {
      const res = await get(h, p);
      expect([p, res.status]).toEqual([p, 404]);
      expect(await res.json()).toEqual({ error: "no such path" });
    }
    for (const p of ["/api/runs", "/api/results?episode=all", "/api/positions", "/api/tools"]) expect([p, (await get(h, p)).status]).toEqual([p, 200]);
  });

  test("/api/info names the groups only when one is off, and the public projection keeps them", async () => {
    const all = (await (await get(handle(), "/api/info")).json()) as ApiInfoResponse;
    expect(all.groups).toBeUndefined();
    const some = (await (await get(handle({ runner: false, evals: true, viewer: true }), "/api/info")).json()) as ApiInfoResponse;
    expect(some.groups).toEqual({ runner: false, evals: true, viewer: true });
    expect(projectInfo(some).groups).toEqual({ runner: false, evals: true, viewer: true });
    expect("groups" in projectInfo(all)).toBe(false);
    const pub = (await (await get(handle({ runner: false, evals: true, viewer: true }, true), "/api/info")).json()) as ApiInfoResponse;
    expect(pub.groups).toEqual({ runner: false, evals: true, viewer: true });
  });
});

describe("the public snapshot", () => {
  const render = async (groups?: Groups): Promise<{ paths: string[]; live: Record<string, unknown> }> => {
    const root = mkdtempSync(join(tmpdir(), "groups-snap-"));
    roots.push(root);
    const r = createRenderer({ runsDir: join(root, "runs"), configDbPath: join(root, "config.sqlite"), ...(groups !== undefined ? { groups } : {}) });
    const result = await r(1_000);
    const live = result.artifacts.find((a) => a.path === "v1/live.json")!;
    return { paths: Object.keys(result.snap).sort(), live: JSON.parse(live.body) as Record<string, unknown> };
  };

  test("every group on publishes today's aggregates; an off group's are not rendered", async () => {
    const all = await render();
    expect(all.paths).toContain("campaigns.json");
    expect(all.paths).toContain("models.json");
    expect(all.paths).toContain("episodes.json");
    expect(all.paths.some((p) => p.startsWith("ladder-"))).toBe(true);
    expect(all.live["fleet"]).toBeDefined();

    const evalsOff = await render({ runner: true, evals: false, viewer: true });
    expect(evalsOff.paths).toEqual(["info.json", "models.json", "results.json", "runs.json", "tools.json"]);
    expect(evalsOff.live["fleet"]).toBeDefined();

    const viewerOnly = await render({ runner: false, evals: false, viewer: true });
    expect(viewerOnly.paths).toEqual(["info.json", "results.json", "runs.json", "tools.json"]);
    expect("fleet" in viewerOnly.live).toBe(false);
    expect(Object.keys(viewerOnly.live)).toEqual(["generatedAt", "attribution", "positions", "nearbyKey"]);
  });
});

describe("the supervisor with evals off", () => {
  test("every campaign and every scored or probing job reads as disabled; freeplay jobs as written", () => {
    const cfg = parseFleet({
      accounts: { pool: ["RUNNER", "RUNNER2", "RUNNER3"] },
      roster: { a: { model: "v/a", tier: "t1" }, b: { model: "v/b", tier: "t1", idle: "unlimited" } },
      queue: [
        { ref: "a", episode: "e90", repeat: 1, enabled: true },
        { ref: "b", episode: "freeplay", repeat: "loop", enabled: true },
      ],
    });
    const off = withoutEvals(cfg);
    expect(off.jobs.map((j) => [j.episode, j.enabled])).toEqual([
      ["e90", false],
      ["freeplay", true],
    ]);
    expect(off.campaigns.every((c) => !c.enabled)).toBe(true);
    // Pure: the config read stays as it was.
    expect(cfg.jobs.map((j) => j.enabled)).toEqual([true, true]);
  });
});

describe("bun wb fleet status with evals off", () => {
  const NOW = 1_800_000_000_000;
  const cfg = parseFleet({
    accounts: { pool: ["RUNNER", "RUNNER2"] },
    credentials: { "or-paid": { provider: "openrouter", secretEnv: "OPENROUTER_KEY", slots: 8, billing: "paid", enabled: true } },
    roster: { a: { model: "v/a", tier: "t1" }, b: { model: "v/b", tier: "t1", idle: "unlimited" } },
    queue: [
      { ref: "a", episode: "e90", repeat: 1, enabled: true },
      { ref: "b", episode: "freeplay", repeat: "loop", enabled: true },
      { ref: "a", episode: "e360", repeat: 1, enabled: false },
    ],
  });
  const states = modelStates({ runsDir: "/nonexistent", roster: rosterModels(cfg.roster), runs: [], sidecar: { version: 1, cleared: {} }, now: NOW, policy: cfg.policy });
  const evalsOff: Groups = { runner: true, evals: false, viewer: true };

  test("reads the config as the supervisor runs it, and names what only the group turned off", () => {
    expect(forGroups(cfg, ALL_GROUPS).config).toBe(cfg);
    expect(forGroups(cfg, ALL_GROUPS).offByGroup.size).toBe(0);
    const { config, offByGroup } = forGroups(cfg, evalsOff);
    expect(config.jobs.map((j) => j.enabled)).toEqual([false, true, false]);
    // The e360 job was the operator's switch, not the group's.
    expect([...offByGroup]).toEqual([cfg.jobs[0]!.name]);
  });

  test("says so once, and the queue says why a job is off", () => {
    expect(formatGroupsBanner(ALL_GROUPS)).toEqual([]);
    expect(formatGroupsBanner(evalsOff)).toEqual([
      "evals group off (WRATHBENCH_GROUPS=runner,viewer): no scored or probing episode is launched or owed; campaigns and scored or probing jobs read as disabled",
    ]);
    const { config, offByGroup } = forGroups(cfg, evalsOff);
    const lines = formatQueue(config.jobs, undefined, undefined, offByGroup);
    expect(lines[0]).toBe("queue: 1 enabled manual job(s) of 3 (supervisor has not reported on it)");
    expect(lines[1]).toEndWith("e90 x1 — disabled (evals group off)");
    expect(lines[3]).toEndWith("e360 x1 — disabled");
  });

  test("owes no scored run: the models table reads free, and nothing is outstanding", () => {
    const on = formatModels(states, new Set(), NOW, new Map(), cfg.policy).join("\n");
    const off = formatModels(states, new Set(), NOW, new Map(), cfg.policy, false).join("\n");
    expect(on).toMatch(/^ {2}a .* yes: /m);
    expect(off).toMatch(/^ {2}a .* free: the evals group is off/m);
    expect(off).not.toMatch(/ yes: /);
    const input = { states, accounts: 2 };
    expect(formatOutstandingFor(input, true)).toMatch(/^outstanding: \d/);
    expect(formatOutstandingFor(input, false)).toBe("outstanding: none — the evals group is off");
  });

  test("the viewer's models table gives the same verdict", () => {
    const a = states.find((st) => st.name === "a")!;
    expect(rowOf(a, [], "/nowhere").schedulable).toMatchObject({ ok: true });
    expect(rowOf(a, [], "/nowhere", new Set(), cfg.policy, false).schedulable).toMatchObject({ why: "the evals group is off" });
  });

  test("the dry-run plans no scored pick, only the idle freeplay session", () => {
    const plan = (groups: Groups) => {
      const { config, offByGroup } = forGroups({ ...cfg, jobs: [] }, groups);
      return planDryRun({ config, runs: [], states, held: () => undefined, stamp: "20261112", now: NOW, evals: groups.evals, offByGroup }).plan.policy;
    };
    expect(plan(ALL_GROUPS).map((p) => p.job.episode)).toContain("e90");
    expect(plan(evalsOff).map((p) => p.job.episode)).toEqual(["freeplay"]);
  });
});
