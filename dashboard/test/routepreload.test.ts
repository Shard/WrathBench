/**
 * The router's preloads (`src/lib/routepreload.ts`) and the head hints for
 * the data host (`src/lib/data-hints.ts`). A preload earns its place only if
 * the page's own first call then finds it in flight, so the tests pin three
 * things: each preload makes its page's calls with its page's arguments (the
 * page sources are read for the call, so a page that changes its call fails
 * here rather than quietly wasting a request); both clients answer the page
 * from the preload's request; and the hinted manifest URL is the one the
 * snapshot client fetches.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createClient } from "../src/api/client";
import { createSnapshotClient } from "../src/api/snapshot-client";
import { dataHints, manifestUrl } from "../src/lib/data-hints";
import { episodeParam } from "../src/lib/episodes";
import { HOME_EPISODE } from "../src/lib/homeladder";
import { HOME_PRELOAD_EPISODE, routePreloads, type PreloadArgs } from "../src/lib/routepreload";

type Call = [string, ...unknown[]];

/** A client that records each call and answers it with nothing. */
function recorder(fail = false): { api: Parameters<typeof routePreloads>[0]; calls: Call[] } {
  const calls: Call[] = [];
  const answer = (name: string) => (...args: unknown[]) => {
    calls.push([name, ...args]);
    return fail ? Promise.reject(new Error(name)) : Promise.resolve({} as never);
  };
  const api = {
    tools: answer("tools"),
    positions: answer("positions"),
    ladder: answer("ladder"),
    results: answer("results"),
    models: answer("models"),
    episodes: answer("episodes"),
    campaigns: answer("campaigns"),
    runs: answer("runs"),
    character: answer("character"),
  } as unknown as Parameters<typeof routePreloads>[0];
  return { api, calls };
}

const nav = (query: PreloadArgs["location"]["query"] = {}, params: PreloadArgs["params"] = {}): PreloadArgs => ({
  params,
  location: { query },
  intent: "initial",
});

const page = (name: string): string => readFileSync(fileURLToPath(new URL(`../src/pages/${name}.tsx`, import.meta.url)), "utf8");

describe("routePreloads", () => {
  test("each route asks for what its page asks for first", () => {
    const cases: [keyof ReturnType<typeof routePreloads>, PreloadArgs, Call[]][] = [
      ["home", nav(), [["tools"], ["positions"], ["ladder", "e90"]]],
      ["ladder", nav(), [["ladder", "e90"]]],
      ["ladder", nav({ episode: "freeplay" }), [["ladder", episodeParam("freeplay")]]],
      ["ladder", nav({ episode: "nonsense" }), [["ladder", episodeParam("nonsense")]]],
      ["map", nav(), [["positions"]]],
      ["runs", nav(), [["results", "all", true, "all"]]],
      ["models", nav(), [["models"], ["ladder", "freeplay"]]],
      ["about", nav(), [["episodes"]]],
      ["campaigns", nav(), [["campaigns"]]],
      ["fleet", nav(), []],
      ["character", nav({}, { id: "run-1" }), [["character", "run-1"]]],
    ];
    for (const [route, args, want] of cases) {
      const { api, calls } = recorder();
      routePreloads(api)[route](args);
      expect([route, calls]).toEqual([route, want]);
    }
  });

  test("the homepage's tier is the one the homepage reads", () => {
    expect(HOME_PRELOAD_EPISODE).toBe(HOME_EPISODE);
  });

  test("the pages still make those calls", () => {
    expect(page("Home")).toContain("api.ladder(HOME_EPISODE)");
    expect(page("Home")).toContain("api.tools()");
    expect(page("Home")).toContain("api.positions()");
    expect(page("Ladder")).toContain("api.ladder(episode())");
    expect(page("Ladder")).toContain("episodeParam(params.episode)");
    expect(page("MapPage")).toContain("api.positions()");
    expect(page("Runs")).toContain('api.results("all", true, "all")');
    expect(page("Models")).toContain("api.models()");
    expect(page("Models")).toContain('api.ladder("freeplay")');
    expect(page("About")).toContain("api.episodes()");
    expect(page("Campaigns")).toContain("api.campaigns()");
    expect(page("Fleet")).not.toContain("api.runs()");
    expect(page("Character")).toContain("api.character(params.id)");
  });

  test("a replay on the map is left to the map", () => {
    for (const query of [{ run: "r1" }, { party: "p1" }]) {
      const { api, calls } = recorder();
      routePreloads(api).map(nav(query));
      expect(calls).toEqual([]);
    }
  });

  test("a hover preloads the route's code but asks for no data", () => {
    const { api, calls } = recorder();
    const p = routePreloads(api);
    for (const route of Object.values(p)) route({ ...nav({}, { id: "x" }), intent: "preload" });
    expect(calls).toEqual([]);
  });

  test("a failed preload is dropped, not left unhandled", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown): void => {
      unhandled.push(e);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      const { api } = recorder(true);
      routePreloads(api).home(nav());
      await new Promise((r) => setTimeout(r, 10));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});

/** A fetch that counts requests per URL and answers each with `body`. */
function counting(body: (url: string) => unknown): { f: typeof fetch; hits: Map<string, number> } {
  const hits = new Map<string, number>();
  const f = (async (input: string | URL | Request) => {
    const url = String(input);
    hits.set(url, (hits.get(url) ?? 0) + 1);
    return new Response(JSON.stringify(body(url)), { headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { f, hits };
}

describe("the page finds the preload's request", () => {
  test("on the live API", async () => {
    const { f, hits } = counting(() => ({ runs: [] }));
    const api = createClient({ fetch: f, now: () => 1_000 });
    routePreloads(api).ladder(nav({ episode: "e90" }));
    await api.ladder("e90");
    expect([...hits.values()]).toEqual([1]);
  });

  test("on the published snapshot, manifest included", async () => {
    const BASE = "https://data.example";
    const { f, hits } = counting((url) =>
      url.endsWith("manifest.json") ? { gen: "g", generatedAt: 1, artifacts: { "ladder-e90.json": "v1/snap/x/ladder-e90.json" } } : { runs: [] },
    );
    const api = createSnapshotClient(BASE, { fetch: f, now: () => 1_000 });
    routePreloads(api).ladder(nav());
    await api.ladder("e90");
    expect(Object.fromEntries(hits)).toEqual({ [`${BASE}/v1/manifest.json`]: 1, [`${BASE}/v1/snap/x/ladder-e90.json`]: 1 });
  });
});

describe("dataHints", () => {
  test("the preloaded manifest is the URL the snapshot client fetches", async () => {
    for (const base of ["https://data.example", "https://data.example/", " https://data.example/sub/ "]) {
      const { f, hits } = counting(() => ({ gen: "g", generatedAt: 1, artifacts: {} }));
      await createSnapshotClient(base.trim(), { fetch: f })
        .info()
        .catch(() => undefined);
      expect([...hits.keys()]).toEqual([manifestUrl(base)]);
    }
  });

  test("a preconnect and a CORS preload for the public build, nothing for the private one", () => {
    expect(dataHints("https://data.example")).toBe(
      '<link rel="preconnect" href="https://data.example" crossorigin />\n    <link rel="preload" href="https://data.example/v1/manifest.json" as="fetch" crossorigin />',
    );
    expect(dataHints(undefined)).toBe("");
    expect(dataHints("  ")).toBe("");
  });
});
