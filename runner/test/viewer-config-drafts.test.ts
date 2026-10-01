/**
 * The config API's draft routes (`/api/config/proposed`, GitHub issue #66):
 * fetch, list, ignore, un-ignore, promote — and the proof that no draft
 * reaches anything public: a public handle 404s every route, and the
 * publisher's render of a store holding drafts names none of them.
 *
 * The catalogue is a fixture served by an injected fetcher; nothing here
 * touches the network. The store and the pure layer are `drafts.test.ts`.
 */

import { describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { ConfigStore } from "../src/config-store";
import type { DraftFetchResponse, DraftsResponse, E90TokenProfileView } from "../viewer/api-types";
import { createApi } from "../viewer/api";
import { ACTOR_HEADER, NOTE_HEADER, handleConfigRequest, type ConfigApiOptions } from "../viewer/config-api";
import { CATALOGUE_URL } from "../viewer/drafts";
import { renderSnapshot } from "../viewer/snapshot";
import { CONFIG, PENDING, ROSTER_MODEL, catalogueFetch, fleetOf, seededStore as seeded, storeFacts } from "./fixtures/drafts";
import { tempDirs } from "./fixtures/temp-dirs";

const tempDir = tempDirs();
const seededStore = (config: unknown = CONFIG): string => seeded(tempDir, config);

async function call(
  db: string,
  method: string,
  rest: string,
  body?: unknown,
  opts: Omit<ConfigApiOptions, "dbPath"> = {},
  headers: Record<string, string> = {},
): Promise<{ status: number; body: unknown }> {
  const path = `/api/config/${rest}`;
  const req = new Request(`http://x${path}`, {
    method,
    headers,
    ...(body !== undefined ? { body: typeof body === "string" ? body : JSON.stringify(body) } : {}),
  });
  const res = await handleConfigRequest(req, new URL(req.url), path, { dbPath: db, ...opts });
  if (res === null) throw new Error(`${path} fell through`);
  return { status: res.status, body: (await res.json()) as unknown };
}

const ATTRIBUTED = { [ACTOR_HEADER]: "mark", [NOTE_HEADER]: "trial the new glm" };

describe("the draft routes", () => {
  test("the prefix belongs to the draft routes, which take no PUT: the generic row path never sees it", async () => {
    const db = seededStore();
    const res = await call(db, "PUT", "proposed/z-ai/glm-6", { status: "draft" });
    expect(res.status).toBe(405);
  });

  test("a fetch proposes, makes one call, and changes nothing the fleet reads", async () => {
    const db = seededStore();
    const before = { fleet: fleetOf(db), facts: storeFacts(db) };
    const f = catalogueFetch();
    const res = await call(db, "POST", "proposed/fetch", undefined, { fetch: f.fetch });
    expect(res.status).toBe(200);
    expect((res.body as DraftFetchResponse).added.length).toBe(5);
    expect((res.body as DraftFetchResponse).skipped).toBe(1);
    expect(f.calls).toEqual([CATALOGUE_URL]);
    expect(fleetOf(db)).toEqual(before.fleet);
    expect(storeFacts(db)).toEqual(before.facts);
  });

  test("fetching twice creates no duplicates", async () => {
    const db = seededStore();
    await call(db, "POST", "proposed/fetch", undefined, { fetch: catalogueFetch().fetch });
    const again = await call(db, "POST", "proposed/fetch", undefined, { fetch: catalogueFetch().fetch });
    expect((again.body as DraftFetchResponse).added).toEqual([]);
    const store = new ConfigStore(db, { readonly: true });
    expect(store.drafts().length).toBe(5);
    store.close();
  });

  test("the listing: newest first, labelled free or paid from the slug, roster models absent, estimate only with a profile", async () => {
    const db = seededStore();
    await call(db, "POST", "proposed/fetch", undefined, { fetch: catalogueFetch().fetch });
    const bare = (await call(db, "GET", "proposed")).body as DraftsResponse;
    expect(bare.drafts.map((d) => d.model)).toEqual([
      "z-ai/glm-6:free",
      "z-ai/glm-6",
      "anthropic/claude-fixture-5",
      "fixturelab/mystery-7b",
      "openrouter/auto",
    ]);
    expect(bare.drafts.map((d) => d.billing)).toEqual(["free", "paid", "paid", "paid", "paid"]);
    expect(bare.profile).toBeNull();
    expect(bare.drafts.every((d) => d.estimateUsd === null)).toBe(true);
    // The rule's routing: the lab's own provider where one is on record, nothing pinned where not.
    expect(bare.drafts.find((d) => d.model === "z-ai/glm-6")!.routing).toBe("Z.AI");
    expect(bare.drafts.find((d) => d.model === "fixturelab/mystery-7b")!.routing).toBe("provider default");

    const profile: E90TokenProfileView = { runs: 4, series: "harness-0.5", promptTokens: 1_000_000, completionTokens: 100_000, cacheReadTokens: 0 };
    const priced = (await call(db, "GET", "proposed", undefined, { e90Profile: async () => profile })).body as DraftsResponse;
    expect(priced.profile).toEqual(profile);
    expect(priced.drafts.find((d) => d.model === "z-ai/glm-6")!.estimateUsd).toBeCloseTo(0.6 + 0.22, 10);
    expect(priced.drafts.find((d) => d.model === "z-ai/glm-6:free")!.estimateUsd).toBe(0);
    // No price quoted, no estimate, profile or not.
    expect(priced.drafts.find((d) => d.model === "openrouter/auto")!.estimateUsd).toBeNull();
  });

  test("an ignored model stays ignored through every later fetch, until un-ignored", async () => {
    const db = seededStore();
    await call(db, "POST", "proposed/fetch", undefined, { fetch: catalogueFetch().fetch });
    const ignored = await call(db, "POST", "proposed/ignore", { model: "openrouter/auto" }, {}, { [ACTOR_HEADER]: "mark" });
    expect(ignored).toEqual({ status: 200, body: { model: "openrouter/auto", status: "ignored" } });
    await call(db, "POST", "proposed/fetch", undefined, { fetch: catalogueFetch().fetch });
    const list = (await call(db, "GET", "proposed")).body as DraftsResponse;
    expect(list.drafts.map((d) => d.model)).not.toContain("openrouter/auto");
    expect(list.ignored.map((d) => [d.model, d.ignoredBy])).toEqual([["openrouter/auto", "mark"]]);

    await call(db, "POST", "proposed/unignore", { model: "openrouter/auto" });
    const back = (await call(db, "GET", "proposed")).body as DraftsResponse;
    expect(back.drafts.map((d) => d.model)).toContain("openrouter/auto");
    expect(back.ignored).toEqual([]);
    expect((await call(db, "POST", "proposed/ignore", { model: "nobody/nothing" })).status).toBe(404);
  });

  test("promotion writes an ordinary roster entry at the chosen tier, recorded, and the draft is gone", async () => {
    const db = seededStore();
    await call(db, "POST", "proposed/fetch", undefined, { fetch: catalogueFetch().fetch });
    const audit = storeFacts(db).audit;
    const res = await call(db, "POST", "proposed/promote", { model: "z-ai/glm-6", name: "glm-6", tier: "t0", race: 1, class: 2 }, {}, ATTRIBUTED);
    expect(res.status).toBe(200);
    // No routing (absent is the rule), no billing (derived), no idle (absent is none).
    expect(res.body).toMatchObject({ key: "roster/glm-6", value: { model: "z-ai/glm-6", tier: "t0", race: 1, class: 2 } });
    const store = new ConfigStore(db, { readonly: true });
    expect(store.draft("z-ai/glm-6")).toBeUndefined();
    const [line] = store.audit(1);
    expect(line).toMatchObject({ key: "roster/glm-6", before: null, actor: "mark", note: "trial the new glm" });
    store.close();
    expect(storeFacts(db).audit).toBe(audit + 1);
    const fleet = fleetOf(db);
    expect(fleet.roster["glm-6"]).toMatchObject({ model: "z-ai/glm-6", tier: "t0", idle: "none" });
    expect(fleet.roster["glm-6"]!.routing).toBeUndefined();
    expect(fleet.roster["glm-6"]!.billing).toBeUndefined();
  });

  test("promotion never picks a tier: the request must name one, and the parser judges it", async () => {
    const db = seededStore();
    await call(db, "POST", "proposed/fetch", undefined, { fetch: catalogueFetch().fetch });
    const none = await call(db, "POST", "proposed/promote", { model: "z-ai/glm-6", name: "glm-6" }, {}, ATTRIBUTED);
    expect(none.status).toBe(400);
    expect((none.body as { error: string }).error).toMatch(/tier/);
    const bad = await call(db, "POST", "proposed/promote", { model: "z-ai/glm-6", name: "glm-6", tier: "t9" }, {}, ATTRIBUTED);
    expect(bad.status).toBe(400);
    expect((bad.body as { error: string }).error).toMatch(/tier must be one of t0, t1, t2/);
    // Strict, as an entry is: a key the promotion does not read is refused, not dropped.
    const stray = await call(db, "POST", "proposed/promote", { model: "z-ai/glm-6", name: "glm-6", tier: "t0", billing: "free" }, {}, ATTRIBUTED);
    expect(stray.status).toBe(400);
    const store = new ConfigStore(db, { readonly: true });
    expect(store.draft("z-ai/glm-6")).toBeDefined();
    store.close();
  });

  test("a refusal by the roster policy leaves the draft where it was, with the parser's sentence", async () => {
    const db = seededStore();
    await call(db, "POST", "proposed/fetch", undefined, { fetch: catalogueFetch().fetch });
    const facts = storeFacts(db);
    const res = await call(db, "POST", "proposed/promote", { model: "anthropic/claude-fixture-5", name: "claude-fixture", tier: "t0" }, {}, ATTRIBUTED);
    expect(res.status).toBe(400);
    expect((res.body as { error: string }).error).toMatch(/claude models run only via the claude-code driver/);
    expect(storeFacts(db)).toEqual(facts);
    const store = new ConfigStore(db, { readonly: true });
    expect(store.draft("anthropic/claude-fixture-5")).toBeDefined();
    store.close();
  });

  test("a name the roster already has is refused rather than overwritten", async () => {
    const db = seededStore();
    await call(db, "POST", "proposed/fetch", undefined, { fetch: catalogueFetch().fetch });
    const res = await call(db, "POST", "proposed/promote", { model: "z-ai/glm-6", name: "nemo", tier: "t0" }, {}, ATTRIBUTED);
    expect(res.status).toBe(409);
    const store = new ConfigStore(db, { readonly: true });
    expect(store.get("roster/nemo")).toEqual(CONFIG.roster.nemo);
    expect(store.draft("z-ai/glm-6")).toBeDefined();
    store.close();
    expect((await call(db, "POST", "proposed/promote", { model: "nobody/nothing", name: "x", tier: "t0" })).status).toBe(404);
  });

  test("a catalogue that cannot be read is a 502 with the reason, and writes nothing", async () => {
    const db = seededStore();
    const down = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof globalThis.fetch;
    const res = await call(db, "POST", "proposed/fetch", undefined, { fetch: down });
    expect(res.status).toBe(502);
    expect((res.body as { error: string }).error).toMatch(/could not read the catalogue/);
    const store = new ConfigStore(db, { readonly: true });
    expect(store.drafts()).toEqual([]);
    store.close();
  });

  test("with no store, the listing is empty and a fetch is refused before any call", async () => {
    const db = join(tempDir("drafts-nostore-"), "config.sqlite");
    expect(await call(db, "GET", "proposed")).toEqual({ status: 200, body: { drafts: [], ignored: [], profile: null } });
    const f = catalogueFetch();
    expect((await call(db, "POST", "proposed/fetch", undefined, { fetch: f.fetch })).status).toBe(409);
    expect(f.calls).toEqual([]);
  });
});

// ------------------------------------------------------------- never public

describe("drafts never reach anything public", () => {
  function handles(publicMode: boolean): { handle: ReturnType<typeof createApi>; db: string; root: string } {
    const db = seededStore();
    const root = tempDir("drafts-api-");
    mkdirSync(join(root, "runs"), { recursive: true });
    const handle = createApi({ runsDir: join(root, "runs"), tilesDir: join(root, "tiles"), configDbPath: db, ...(publicMode ? { publicMode: true } : {}) });
    return { handle, db, root };
  }

  test("a public handle 404s every draft route, read and write alike", async () => {
    const { handle } = handles(true);
    for (const [method, path] of [
      ["GET", "/api/config/proposed"],
      ["POST", "/api/config/proposed/fetch"],
      ["POST", "/api/config/proposed/ignore"],
      ["POST", "/api/config/proposed/unignore"],
      ["POST", "/api/config/proposed/promote"],
    ] as const) {
      const res = await handle(new Request(`http://x${path}`, { method, ...(method === "POST" ? { body: "{}" } : {}) }));
      expect([method, path, res.status]).toEqual([method, path, 404]);
    }
  });

  test("a private handle serves the listing, with no profile on an empty runs directory", async () => {
    const { handle, db } = handles(false);
    const store = new ConfigStore(db);
    store.writeDrafts({ put: [{ model: "z-ai/glm-6", value: { ...PENDING } }] });
    store.close();
    const res = await handle(new Request("http://x/api/config/proposed"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as DraftsResponse;
    expect(body.drafts.map((d) => d.model)).toEqual(["z-ai/glm-6"]);
    expect(body.profile).toBeNull();
  });

  test("the publisher renders the roster and no draft: no id, no key space, no route", async () => {
    const { db, root } = handles(false);
    const store = new ConfigStore(db);
    store.writeDrafts({
      put: [
        { model: "z-ai/glm-6", value: { ...PENDING } },
        { model: "fixturelab/mystery-7b", value: { model: "fixturelab/mystery-7b", status: "ignored", firstSeen: 1 } },
      ],
    });
    store.close();
    const out = await renderSnapshot({ runsDir: join(root, "runs"), configDbPath: db, now: 1 });
    // The positive control: this render did read the store, so an absence below means something.
    const models = out.artifacts.find((a) => a.path.endsWith("/models.json"));
    expect(models?.body).toContain(ROSTER_MODEL);
    for (const a of out.artifacts) {
      for (const needle of ["z-ai/glm-6", "fixturelab/mystery-7b", "proposed"]) {
        expect(`${a.path}: ${a.body.includes(needle)}`).toBe(`${a.path}: false`);
      }
    }
  });
});
