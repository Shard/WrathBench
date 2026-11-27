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
import { ConfigStore } from "../../runner/src/config-store";
import type { DraftFetchResponse, DraftsResponse, E90TokenProfileView } from "../api-types-admin";
import { createApi } from "../api";
import { ACTOR_HEADER, NOTE_HEADER, handleConfigRequest, type ConfigApiOptions } from "../config-api";
import { CATALOGUE_URL, draftDocument } from "../drafts";
import { renderSnapshot } from "../snapshot";
import { CATALOGUE_TEXT, CLAUDE_CREDENTIAL, CONFIG, PENDING, ROSTER_MODEL, catalogueFetch, fleetOf, seededStore as seeded, storeFacts } from "../../runner/test/fixtures/drafts";
import { tempDirs } from "../../runner/test/fixtures/temp-dirs";

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
  test("a fetch proposes, makes one call, and changes nothing the fleet reads", async () => {
    const db = seededStore();
    const before = { fleet: fleetOf(db), facts: storeFacts(db) };
    const f = catalogueFetch();
    const res = await call(db, "POST", "proposed/fetch", undefined, { fetch: f.fetch });
    expect(res.status).toBe(200);
    // Five tool-calling models the roster does not run, less the Claude one, which a promotion could not write under the claude credential.
    expect((res.body as DraftFetchResponse).added.length).toBe(4);
    expect((res.body as DraftFetchResponse).added).not.toContain("anthropic/claude-fixture-5");
    expect((res.body as DraftFetchResponse).skipped).toBe(1);
    expect(f.calls).toEqual([CATALOGUE_URL]);
    expect(fleetOf(db)).toEqual(before.fleet);
    expect(storeFacts(db)).toEqual(before.facts);
  });

  test("the listing: newest first, labelled free or paid from the slug, roster models absent, estimate only with a profile", async () => {
    const db = seededStore();
    await call(db, "POST", "proposed/fetch", undefined, { fetch: catalogueFetch().fetch });
    const bare = (await call(db, "GET", "proposed")).body as DraftsResponse;
    expect(bare.drafts.map((d) => d.model)).toEqual([
      "z-ai/glm-6:free",
      "z-ai/glm-6",
      "fixturelab/mystery-7b",
      "openrouter/auto",
    ]);
    expect(bare.drafts.map((d) => d.billing)).toEqual(["free", "paid", "paid", "paid"]);
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
    expect((bad.body as { error: string }).error).toMatch(/tier must be one of t0, t1, t2, t3/);
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
    // A Claude draft a fetch from before the hiding left behind: off the listing, and still refused.
    const old = new ConfigStore(db);
    old.writeDrafts({ put: [{ model: "anthropic/claude-fixture-5", value: draftDocument({ ...PENDING, model: "anthropic/claude-fixture-5" }) }] });
    old.close();
    expect(((await call(db, "GET", "proposed")).body as DraftsResponse).drafts.map((d) => d.model)).not.toContain("anthropic/claude-fixture-5");
    const facts = storeFacts(db);
    const res = await call(db, "POST", "proposed/promote", { model: "anthropic/claude-fixture-5", name: "claude-fixture", tier: "t0" }, {}, ATTRIBUTED);
    expect(res.status).toBe(400);
    expect((res.body as { error: string }).error).toBe(
      "roster/claude-fixture: roster policy — anthropic/claude-fixture-5 is a Claude model, and with a claude credential configured Claude models run only via the claude-code driver: " +
        "write it as a claude-code entry on that credential instead (model claude-fixture-5, driver claude-code)",
    );
    expect(storeFacts(db)).toEqual(facts);
    const store = new ConfigStore(db, { readonly: true });
    expect(store.draft("anthropic/claude-fixture-5")).toBeDefined();
    store.close();
  });

  test("with no claude credential a Claude model is offered and promoted as any other; with one, a disabled one too, it is hidden", async () => {
    const { claude: _claude, ...noSubscription } = CONFIG.credentials;
    const open = seededStore({ ...CONFIG, credentials: noSubscription });
    const offered = (await call(open, "POST", "proposed/fetch", undefined, { fetch: catalogueFetch().fetch })).body as DraftFetchResponse;
    expect(offered.added).toContain("anthropic/claude-fixture-5");
    expect(((await call(open, "GET", "proposed")).body as DraftsResponse).drafts.map((d) => d.model)).toContain("anthropic/claude-fixture-5");
    const promoted = await call(open, "POST", "proposed/promote", { model: "anthropic/claude-fixture-5", name: "claude-fixture", tier: "t0" }, {}, ATTRIBUTED);
    expect(promoted.status).toBe(200);
    expect(fleetOf(open).roster["claude-fixture"]).toMatchObject({ model: "anthropic/claude-fixture-5", tier: "t0" });

    // Disabling the subscription never re-opens the endpoint.
    const disabled = seededStore({ ...CONFIG, credentials: { claude: { ...CLAUDE_CREDENTIAL, enabled: false } } });
    const hidden = (await call(disabled, "POST", "proposed/fetch", undefined, { fetch: catalogueFetch().fetch })).body as DraftFetchResponse;
    expect(hidden.added).not.toContain("anthropic/claude-fixture-5");
  });

  test("with a chatgpt credential a ChatGPT model is never offered and never promoted; gpt-oss is", async () => {
    const tools = (id: string) => ({ id, name: id, created: 1_786_000_000, supported_parameters: ["tools"], pricing: { prompt: "0.000001", completion: "0.000002" } });
    const doc = JSON.parse(CATALOGUE_TEXT) as { data: unknown[] };
    const text = JSON.stringify({ ...doc, data: [...doc.data, tools("openai/gpt-6.2-astra"), tools("openai/gpt-oss-120b")] });
    const credentials = {
      chatgpt: { provider: "chatgpt", secretEnv: "CODEX_HOME", slots: 1, billing: "paid", enabled: true },
      "or-paid": { provider: "openrouter", secretEnv: "OPENROUTER_KEY", slots: 1, billing: "paid", enabled: true },
    };
    const db = seededStore({ ...CONFIG, credentials });
    const fetched = (await call(db, "POST", "proposed/fetch", undefined, { fetch: catalogueFetch(text).fetch })).body as DraftFetchResponse;
    expect(fetched.added).toContain("openai/gpt-oss-120b");
    expect(fetched.added).not.toContain("openai/gpt-6.2-astra");
    // One left by an earlier fetch is off the listing, pending or ignored, and its promotion is refused by name.
    const old = new ConfigStore(db);
    old.writeDrafts({ put: [{ model: "openai/gpt-6.2-astra", value: draftDocument({ ...PENDING, model: "openai/gpt-6.2-astra" }) }] });
    old.close();
    const list = (await call(db, "GET", "proposed")).body as DraftsResponse;
    expect([...list.drafts, ...list.ignored].map((d) => d.model)).not.toContain("openai/gpt-6.2-astra");
    const res = await call(db, "POST", "proposed/promote", { model: "openai/gpt-6.2-astra", name: "astra", tier: "t0" }, {}, ATTRIBUTED);
    expect(res.status).toBe(400);
    expect((res.body as { error: string }).error).toMatch(/^roster\/astra: roster policy — openai\/gpt-6\.2-astra is a ChatGPT model, .*codex entry on that credential instead \(model gpt-6\.2-astra, driver codex\)/);

    // A deployment with no ChatGPT subscription is offered it, as any other model.
    const { chatgpt: _c, ...meteredOnly } = credentials;
    const open = seededStore({ ...CONFIG, credentials: meteredOnly });
    const offered = (await call(open, "POST", "proposed/fetch", undefined, { fetch: catalogueFetch(text).fetch })).body as DraftFetchResponse;
    expect(offered.added).toContain("openai/gpt-6.2-astra");
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
    const handle = createApi({ runsDir: join(root, "runs"), tilesDir: join(root, "tiles"), configDbPath: db, admin: true, ...(publicMode ? { publicMode: true } : {}) });
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
