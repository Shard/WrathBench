/**
 * Retiring a roster entry its provider stopped listing (`runner/src/model-lists.ts`,
 * `infra/run-fleet-model-lists.ts`): which lists are read and how, the
 * confirmation rule, that a failed read changes nothing, that a model listed
 * again comes back by itself, and what the projection, `--status` and the
 * supervisor's poller make of it. Fixture lists and a fake fetch only; no
 * network.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { FleetModelLists, formatModelLists, modelListKey, modelListsToRead } from "../../infra/run-fleet-model-lists";
import {
  applyModelListRead,
  emptyModelLists,
  GONE_CONFIRM_MS,
  MODEL_LIST_READ_EVERY_MS,
  MODEL_LISTS_SIDECAR,
  modelGoneOf,
  modelListSourceOf,
  parseModelListBody,
  parseModelLists,
  readModelList,
  readModelListsSidecar,
  serializeModelLists,
  type ModelListResult,
  type ModelListSource,
  type ModelListsSidecar,
} from "../src/model-lists";
import { modelStates, planNextJobs, schedulability, type RosterModel } from "../src/models";
import { tempDirs } from "./fixtures/temp-dirs";

const tempDir = tempDirs();

const H = 3_600_000;
const T0 = Date.UTC(2026, 10, 12, 0, 0, 0);
const GO = "https://opencode.ai/inference/go/openai/v1";
const ENV = {};

const goEntry: RosterModel = { name: "cat-jam-go", model: "cat-jam-free", apiBase: GO, tier: "t0" };
const goStays: RosterModel = { name: "beam-go", model: "beam-free", apiBase: GO, tier: "t0" };
const orEntry: RosterModel = { name: "mercury-3", model: "inception/mercury-3", tier: "t0" };

const listed = (...ids: string[]): ModelListResult => ({ ok: true, ids: new Set(ids) });
const goSource = modelListSourceOf(goEntry, ENV)!;

/** The file after a sequence of reads of the Go list, each at its time. */
function readsOf(seq: [number, ModelListResult][], models = [goEntry.model, goStays.model]): ModelListsSidecar {
  let s = emptyModelLists();
  for (const [at, r] of seq) s = applyModelListRead(s, goSource, models, r, at);
  return s;
}

describe("which list a roster entry is on", () => {
  test("an endpoint entry's list is its base's /models; OpenRouter's asks for every modality", () => {
    expect(modelListSourceOf(orEntry, ENV)).toEqual({
      provider: "openrouter",
      label: "OpenRouter",
      apiBase: "https://openrouter.ai/api/v1",
      url: "https://openrouter.ai/api/v1/models?output_modalities=all",
      auth: "none",
    });
    expect(goSource).toMatchObject({ provider: "opencode-go", label: "OpenCode Go", url: `${GO}/models`, auth: "none" });
    expect(modelListSourceOf({ apiBase: "https://opencode.ai/zen/v1/" }, ENV)).toMatchObject({ provider: "opencode", url: "https://opencode.ai/zen/v1/models" });
    expect(modelListSourceOf({ apiBase: "https://api.cerebras.ai/v1" }, ENV)).toMatchObject({ provider: "cerebras", auth: "key" });
    expect(modelListSourceOf({ apiBase: "https://api.deepseek.com" }, ENV)).toMatchObject({ provider: "deepseek", url: "https://api.deepseek.com/models", auth: "key" });
  });

  test("a CLI subscription's and the self-hosted server's lists are not read", () => {
    expect(modelListSourceOf({ driver: "claude-code" }, ENV)).toBeNull();
    expect(modelListSourceOf({ driver: "codex" }, ENV)).toBeNull();
    expect(modelListSourceOf({ apiBase: "http://192.168.1.20:1234/v1" }, ENV)).toBeNull();
  });

  test("one read per list, carrying every roster model on it", () => {
    const lists = modelListsToRead(
      { a: goEntry, b: goStays, c: { model: goEntry.model, apiBase: GO }, d: orEntry, e: { model: "claude-opus-5-5", driver: "claude-code" } },
      ENV,
    );
    expect(lists.map((l) => [l.source.provider, l.models])).toEqual([
      ["opencode-go", ["cat-jam-free", "beam-free"]],
      ["openrouter", ["inception/mercury-3"]],
    ]);
  });
});

describe("the confirmation rule", () => {
  test("missing on one read, or on reads less than a day apart, is not gone", () => {
    expect(modelGoneOf(readsOf([[T0, listed("beam-free")]]), goEntry, ENV)).toBeUndefined();
    const twice = readsOf([
      [T0, listed("beam-free")],
      [T0 + 6 * H, listed("beam-free")],
      [T0 + 23 * H, listed("beam-free")],
    ]);
    expect(twice.missing[goSource.url]!["cat-jam-free"]).toEqual({ since: T0, last: T0 + 23 * H, reads: 3 });
    expect(modelGoneOf(twice, goEntry, ENV)).toBeUndefined();
  });

  test("missing from every successful read for a day is gone, since the first of them", () => {
    const s = readsOf([
      [T0, listed("beam-free")],
      [T0 + GONE_CONFIRM_MS, listed("beam-free")],
    ]);
    expect(modelGoneOf(s, goEntry, ENV)).toEqual({ provider: "opencode-go", label: "OpenCode Go", since: T0 });
    expect(modelGoneOf(s, goStays, ENV)).toBeUndefined();
  });

  test("a failed read neither confirms an absence nor resets one", () => {
    const failedOnly = readsOf([
      [T0, listed("beam-free")],
      [T0 + 25 * H, { ok: false, why: "HTTP 503" }],
    ]);
    expect(failedOnly.missing[goSource.url]!["cat-jam-free"]).toEqual({ since: T0, last: T0, reads: 1 });
    expect(modelGoneOf(failedOnly, goEntry, ENV)).toBeUndefined();
    expect(failedOnly.reads[goSource.url]).toEqual({ provider: "opencode-go", at: T0 + 25 * H, ok: false, why: "HTTP 503", lastOkAt: T0 });

    const s = applyModelListRead(failedOnly, goSource, ["cat-jam-free", "beam-free"], listed("beam-free"), T0 + 26 * H);
    expect(modelGoneOf(s, goEntry, ENV)?.since).toBe(T0);
  });

  test("a failed read never retires anything, whatever came before", () => {
    const s = readsOf([
      [T0, { ok: false, why: "HTTP 500" }],
      [T0 + 30 * H, { ok: false, why: "no answer within 20s" }],
    ]);
    expect(s.missing).toEqual({});
    expect(modelGoneOf(s, goEntry, ENV)).toBeUndefined();
  });

  test("listed again, it comes back at once and its absence is forgotten", () => {
    const gone = readsOf([
      [T0, listed("beam-free")],
      [T0 + 30 * H, listed("beam-free")],
    ]);
    expect(modelGoneOf(gone, goEntry, ENV)).toBeDefined();
    const back = applyModelListRead(gone, goSource, ["cat-jam-free", "beam-free"], listed("beam-free", "cat-jam-free"), T0 + 36 * H);
    expect(modelGoneOf(back, goEntry, ENV)).toBeUndefined();
    expect(back.missing).toEqual({});
    // And a later disappearance starts the day over.
    const again = applyModelListRead(back, goSource, ["cat-jam-free", "beam-free"], listed("beam-free"), T0 + 42 * H);
    expect(again.missing[goSource.url]!["cat-jam-free"]).toEqual({ since: T0 + 42 * H, last: T0 + 42 * H, reads: 1 });
  });

  test("an absence the roster no longer has a model for is dropped on the next read", () => {
    const s = readsOf([[T0, listed("beam-free")]]);
    const later = applyModelListRead(s, goSource, ["beam-free"], listed("beam-free"), T0 + 6 * H);
    expect(later.missing).toEqual({});
  });

  test("the file round-trips, and a torn or foreign one reads as empty", () => {
    const s = readsOf([
      [T0, listed("beam-free")],
      [T0 + 30 * H, { ok: false, why: "HTTP 502" }],
    ]);
    expect(parseModelLists(serializeModelLists(s))).toEqual(s);
    expect(parseModelLists("{not json")).toEqual(emptyModelLists());
    expect(parseModelLists(JSON.stringify({ missing: { u: { m: { since: "x" } } } }))).toEqual(emptyModelLists());
  });
});

describe("reading a list", () => {
  const body = (ids: string[]) => JSON.stringify({ object: "list", data: ids.map((id) => ({ id, object: "model" })) });

  test("the ids of a list; an empty or malformed one is a failed read", () => {
    expect(parseModelListBody(body(["a", "b"]))).toEqual({ ok: true, ids: new Set(["a", "b"]) });
    expect(parseModelListBody(body([]))).toEqual({ ok: false, why: "the list is empty" });
    expect(parseModelListBody("<html>")).toEqual({ ok: false, why: "the list is not JSON" });
    expect(parseModelListBody(JSON.stringify({ models: [] }))).toEqual({ ok: false, why: "the list has no data array" });
  });

  test("a public list is read with no key; a non-200 or a thrown fetch is a failed read", async () => {
    const seen: { url: string; auth: string | null }[] = [];
    const fetcher = (async (url: string, init?: RequestInit) => {
      seen.push({ url, auth: new Headers(init?.headers).get("authorization") });
      return new Response(body(["beam-free"]));
    }) as unknown as typeof fetch;
    expect(await readModelList(goSource, { fetcher, key: { env: "OPENCODE_KEY", value: "k" } })).toEqual({ ok: true, ids: new Set(["beam-free"]) });
    expect(seen).toEqual([{ url: `${GO}/models`, auth: null }]);

    const status = (async () => new Response("nope", { status: 503 })) as unknown as typeof fetch;
    expect(await readModelList(goSource, { fetcher: status })).toEqual({ ok: false, why: "HTTP 503" });
    const thrown = (async () => {
      throw new Error("ECONNRESET");
    }) as unknown as typeof fetch;
    expect(await readModelList(goSource, { fetcher: thrown })).toEqual({ ok: false, why: "ECONNRESET" });
  });

  test("a keyed list sends its key only where the provider table allows, and needs one", async () => {
    const cerebras = modelListSourceOf({ apiBase: "https://api.cerebras.ai/v1" }, ENV)!;
    let auth = "";
    const fetcher = (async (_url: string, init?: RequestInit) => {
      auth = new Headers(init?.headers).get("authorization") ?? "";
      return new Response(body(["gpt-oss-120b"]));
    }) as unknown as typeof fetch;
    expect((await readModelList(cerebras, { fetcher, key: { env: "CEREBRAS_KEY", value: "sk" } })).ok).toBe(true);
    expect(auth).toBe("Bearer sk");
    expect(await readModelList(cerebras, { fetcher })).toEqual({ ok: false, why: "no Cerebras key to read the list with" });
    const wrong = await readModelList(cerebras, { fetcher, key: { env: "OPENROUTER_KEY", value: "sk" } });
    expect(wrong.ok).toBe(false);
    if (!wrong.ok) expect(wrong.why).not.toContain("sk ");
  });

  test("a list that does not answer in time is a failed read", async () => {
    const hang = ((_url: string, init?: RequestInit) =>
      new Promise((_, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted"))))) as unknown as typeof fetch;
    expect(await readModelList(goSource, { fetcher: hang, timeoutMs: 20 })).toEqual({ ok: false, why: "no answer within 0s" });
  });

  test("the key comes from the provider's enabled credential, else its own variable", () => {
    const cerebras = modelListSourceOf({ apiBase: "https://api.cerebras.ai/v1" }, ENV)!;
    const creds = [
      { provider: "cerebras", secretEnv: "CEREBRAS_KEY_2", enabled: false },
      { provider: "cerebras", secretEnv: "CEREBRAS_KEY_3", enabled: true },
    ];
    expect(modelListKey(cerebras, creds, { CEREBRAS_KEY_3: "three", CEREBRAS_KEY: "base" })).toEqual({ env: "CEREBRAS_KEY_3", value: "three" });
    expect(modelListKey(cerebras, creds, { CEREBRAS_KEY: "base" })).toEqual({ env: "CEREBRAS_KEY", value: "base" });
    expect(modelListKey(cerebras, creds, {})).toBeUndefined();
    expect(modelListKey(goSource, creds, { OPENCODE_KEY: "k" })).toBeUndefined();
  });
});

describe("what the projection makes of it", () => {
  const roster = [goEntry, goStays];
  const gone = readsOf([
    [T0, listed("beam-free")],
    [T0 + 30 * H, listed("beam-free")],
  ]);

  test("a gone entry is retired with the provider and the date, and nothing else is", () => {
    const states = modelStates({ runsDir: tempDir("wb-model-lists-"), roster, now: T0 + 31 * H, runs: [], sidecar: { version: 1, cleared: {} }, modelLists: gone });
    const cat = states.find((s) => s.name === "cat-jam-go")!;
    expect(cat.status).toBe("retired");
    expect(cat.retired).toEqual({ at: T0, reason: "gone from OpenCode Go's model list since 2026-11-12" });
    expect(schedulability(cat).verdict).toBe("blocked");
    expect(schedulability(cat).why).toBe("retired: gone from OpenCode Go's model list since 2026-11-12 — back by itself once it is listed again");
    expect(states.find((s) => s.name === "beam-go")!.status).toBe("new");
    // The policy picks only the model still listed.
    expect(planNextJobs(states, ["A", "B"]).jobs.map((j) => j.name)).toEqual(["beam-go"]);
  });

  test("an operator clear does not lift it; the list does", () => {
    const cleared = modelStates({ runsDir: tempDir("wb-model-lists-"), roster, now: T0 + 31 * H, runs: [], sidecar: { version: 1, cleared: { "cat-jam-go": T0 + 31 * H } }, modelLists: gone });
    expect(cleared.find((s) => s.name === "cat-jam-go")!.status).toBe("retired");
    const back = applyModelListRead(gone, goSource, ["cat-jam-free", "beam-free"], listed("cat-jam-free", "beam-free"), T0 + 36 * H);
    const states = modelStates({ runsDir: tempDir("wb-model-lists-"), roster, now: T0 + 37 * H, runs: [], sidecar: { version: 1, cleared: {} }, modelLists: back });
    expect(states.find((s) => s.name === "cat-jam-go")!.status).toBe("new");
  });

  test("with no file, nothing is retired", () => {
    const states = modelStates({ runsDir: tempDir("wb-model-lists-"), roster, now: T0, runs: [], sidecar: { version: 1, cleared: {} } });
    expect(states.every((s) => s.retired === undefined)).toBe(true);
  });
});

describe("the supervisor's poller", () => {
  const roster = { "cat-jam-go": goEntry, "beam-go": goStays, sub: { model: "claude-opus-5-5", driver: "claude-code" } };

  test("reads each due list, writes the file, and waits out the interval before reading again", async () => {
    const dir = tempDir("wb-model-lists-");
    let now = T0;
    const asked: ModelListSource[] = [];
    const lines: string[] = [];
    const lists = new FleetModelLists({
      runsDir: dir,
      env: ENV,
      now: () => now,
      say: (l) => lines.push(l),
      read: async (source) => {
        asked.push(source);
        return listed("beam-free");
      },
    });
    await lists.refresh(roster, []);
    expect(asked.map((s) => s.url)).toEqual([`${GO}/models`]);
    expect(existsSync(join(dir, MODEL_LISTS_SIDECAR))).toBe(true);
    expect(readModelListsSidecar(dir).missing[`${GO}/models`]).toEqual({ "cat-jam-free": { since: T0, last: T0, reads: 1 } });
    expect(lines).toEqual(["model list OpenCode Go: cat-jam-free is not on it (retired once a day of reads agree)"]);

    now = T0 + MODEL_LIST_READ_EVERY_MS - 1;
    await lists.refresh(roster, []);
    expect(asked.length).toBe(1);
    now = T0 + MODEL_LIST_READ_EVERY_MS;
    await lists.refresh(roster, []);
    expect(asked.length).toBe(2);
  });

  test("a failed read is said and leaves the absences as they were", async () => {
    const dir = tempDir("wb-model-lists-");
    let now = T0;
    let result: ModelListResult = listed("beam-free");
    const lines: string[] = [];
    const lists = new FleetModelLists({ runsDir: dir, env: ENV, now: () => now, say: (l) => lines.push(l), read: async () => result });
    await lists.refresh(roster, []);
    now += MODEL_LIST_READ_EVERY_MS;
    result = { ok: false, why: "HTTP 502" };
    await lists.refresh(roster, []);
    expect(lines.at(-1)).toBe(`model list OpenCode Go (${GO}/models) not read: HTTP 502 — nothing retired or restored on it`);
    expect(readModelListsSidecar(dir).missing[`${GO}/models`]).toEqual({ "cat-jam-free": { since: T0, last: T0, reads: 1 } });
    expect(JSON.parse(readFileSync(join(dir, MODEL_LISTS_SIDECAR), "utf8")).reads[`${GO}/models`].ok).toBe(false);
  });

  test("--status names each list's read and what is not on it", () => {
    const s = readsOf([
      [T0, listed("beam-free")],
      [T0 + 30 * H, { ok: false, why: "HTTP 502" }],
    ]);
    const out = formatModelLists(s, T0 + 31 * H);
    expect(out[0]).toContain("the claude, chatgpt and local lists are not read");
    expect(out[1]).toBe(`  OpenCode Go ${GO}/models: NOT READ 60m ago (HTTP 502); last read 1860m ago — not listed: cat-jam-free since 2026-11-12 (1 read)`);
    expect(formatModelLists(emptyModelLists(), T0)[0]).toEndWith(": none read yet");
  });
});
