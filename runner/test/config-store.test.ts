/**
 * The config store (FOLLOW-UPS item 127; the only fleet config since
 * 2026-09-18).
 *
 * Two invariants worth pinning. First, that a seed round-trips: the supervisor
 * cannot tell the store from the document it was seeded with —
 * `parseFleet(store.render())` deep-equals `parseFleet(doc)`. Second, that the
 * read seam keeps EMPTY (zero rows: a real config, the empty board) apart from
 * UNREADABLE (the store could not be opened: transient, keep the last good
 * config), because confusing them would drain every live job on a disk
 * hiccup.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  ConfigRejected,
  ConfigStore,
  configDbPath,
  configStoreSeeded,
  EMPTY_STORE_HINT,
  openConfigStore,
  readFleetConfig,
  renderFleet,
  splitFleet,
} from "../src/config-store";
import { parseFleet } from "../../infra/run-fleet-config";

const EXAMPLE = resolve(import.meta.dir, "..", "..", "infra", "fleet.example.json");

function tempStore(): { store: ConfigStore; root: string } {
  const root = mkdtempSync(join(tmpdir(), "config-store-"));
  return { store: new ConfigStore(join(root, "config.sqlite")), root };
}

/** A minimal file of the shipped shape, so most tests need no `data/`. */
function fixtureConfig(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    _notes: ["n"],
    accounts: { pool: ["RUNNER", "RUNNER2"] },
    roster: {
      glm: { tier: "t1", model: "z-ai/glm-5.2:free" },
      son: { tier: "t1", model: "sonnet", driver: "claude-code" },
    },
    queue: [],
    ...over,
  };
}

describe("split and render", () => {
  test("a config round-trips through rows unchanged", () => {
    const doc = fixtureConfig({ policy: { maxConcurrent: { openrouter: 1 } } });
    expect(renderFleet(splitFleet(doc))).toEqual(doc);
  });

  test("a routing block survives seed -> export unchanged, in the file's own spelling", () => {
    // Issue #25 / 2026-09-16. `parseFleet` normalises the shorthand for its own
    // readers; the store must NOT — it holds the config as written, so an
    // export diffs against an earlier export as a diff, not a reformatting.
    const doc = fixtureConfig({
      policy: { routing: { sort: "throughput", allowFallbacks: true } },
      roster: {
        glm: { tier: "t1", model: "z-ai/glm-5.2:free", routing: { order: ["Z.AI", "Together"], requireParameters: true } },
        ox: { tier: "t1", model: "stealth/ox-alpha:free", routing: "Stealth" },
        son: { tier: "t1", model: "sonnet", driver: "claude-code" },
      },
    });
    const { store } = tempStore();
    // Against a pristine copy, not against `doc`: `parseFleet` normalises a
    // routing shorthand for its own readers, and if it ever did that in place
    // the assertion would pass by both sides having been rewritten.
    const pristine = structuredClone(doc);
    store.seed(doc);
    expect(store.render()).toEqual(pristine);
    expect(doc).toEqual(pristine);
    // And the supervisor reads the store and the file as the same config.
    expect(parseFleet(store.render())).toEqual(parseFleet(pristine));
  });

  test("a routing edit through the store is accepted and read back as written", () => {
    const { store } = tempStore();
    store.seed(fixtureConfig());
    store.put("roster/glm", { tier: "t1", model: "z-ai/glm-5.2:free", routing: "DeepInfra" });
    expect((store.render()["roster"] as Record<string, unknown>)["glm"]).toEqual({
      tier: "t1",
      model: "z-ai/glm-5.2:free",
      routing: "DeepInfra",
    });
  });

  test("an edit that routes a model somewhere impossible is refused like any other", () => {
    const { store } = tempStore();
    store.seed(fixtureConfig());
    expect(() => store.put("roster/son", { tier: "t1", model: "sonnet", driver: "claude-code", routing: "Anthropic" })).toThrow(
      /routing is an OpenRouter setting/,
    );
  });

  test("a `wiki: false` entry survives seed -> export and reads the same both ways", () => {
    // Issue #61 / 2026-09-16: the off switch is config like any other, so it
    // has to come back out of the store exactly as the file wrote it.
    const doc = fixtureConfig({
      roster: {
        glm: { tier: "t1", model: "z-ai/glm-5.2:free", wiki: false },
        son: { tier: "t1", model: "sonnet", driver: "claude-code" },
      },
    });
    const { store } = tempStore();
    store.seed(doc);
    expect(store.render()).toEqual(doc);
    expect(parseFleet(store.render())).toEqual(parseFleet(doc));
    expect(parseFleet(store.render()).roster["glm"]!.wiki).toBe(false);
  });

  test("roster entries are rows of their own, in file order", () => {
    const rows = splitFleet(fixtureConfig());
    expect(rows.map((r) => r.key)).toContain("roster/glm");
    expect(rows.map((r) => r.key)).toContain("roster/son");
    // File order is load-bearing (two enabled pins on one account: first wins).
    expect(Object.keys(renderFleet(rows)["roster"] as object)).toEqual(["glm", "son"]);
  });

  test("an empty collection keeps its key, and an absent one stays absent", () => {
    expect(renderFleet(splitFleet(fixtureConfig()))["queue"]).toEqual([]);
    const noQueue = fixtureConfig();
    delete noQueue["queue"];
    expect("queue" in renderFleet(splitFleet(noQueue))).toBe(false);
  });

  test("the stored document is the RAW one, not the parsed one", () => {
    // parseFleet fills preflight's timeouts and normalises its smokes; a store
    // that kept the parsed form could never diff cleanly against the file.
    const doc = fixtureConfig({ preflight: { enabled: true, account: "SMOKE", smokes: ["x.ts"] } });
    const { store } = tempStore();
    store.seed(doc);
    expect(store.get("preflight")).toEqual({ enabled: true, account: "SMOKE", smokes: ["x.ts"] });
    expect(store.render()).toEqual(doc);
    store.close();
  });
});

describe("the bootstrap example (infra/fleet.example.json)", () => {
  test("seeds, exports identically, and parses to the same config", async () => {
    const original = JSON.parse(await Bun.file(EXAMPLE).text()) as unknown;
    const { store } = tempStore();
    const { seeded, keys } = store.seedFromFile(EXAMPLE);
    expect(seeded).toBe(true);
    expect(keys).toBeGreaterThan(5);
    expect(store.render()).toEqual(original as Record<string, unknown>);
    expect(parseFleet(store.render())).toEqual(parseFleet(original));
    store.close();
  });
});

describe("writes", () => {
  test("an invalid edit is refused with the file's own error, and nothing is written", () => {
    const { store } = tempStore();
    store.seed(fixtureConfig());
    expect(() => store.put("roster/son", { tier: "t9", model: "sonnet" })).toThrow(ConfigRejected);
    expect(() => store.put("roster/son", { tier: "t1", model: "sonnet" })).toThrow(/claude models run only via the claude-code driver/);
    expect(store.get("roster/son")).toEqual({ tier: "t1", model: "sonnet", driver: "claude-code" });
    expect(store.audit().filter((a) => a.key === "roster/son" && a.note === null)).toEqual([]);
    store.close();
  });

  test("a refusal that depends on the WHOLE config is caught at write time", () => {
    const { store } = tempStore();
    store.seed(fixtureConfig({ policy: { subscriptions: ["CLAUDE_CODE_OAUTH_TOKEN"] } }));
    // Legal in isolation; the entry is refused (not the file) for naming a lane
    // the policy does not list, which parseFleet reports as a refusal rather
    // than a throw — so this is accepted and shows up in `--status`.
    store.put("roster/son", { tier: "t1", model: "sonnet", driver: "claude-code", subscription: "NOPE" });
    const refused = parseFleet(store.render()).refusals.map((r) => r.pin);
    expect(refused).toContain("roster son");
    store.close();
  });

  test("patch merges, put replaces, delete removes", () => {
    const { store } = tempStore();
    store.seed(fixtureConfig());
    store.patch("roster/glm", { tier: "t2" }, { actor: "mark", note: "promote" });
    expect(store.get("roster/glm")).toEqual({ tier: "t2", model: "z-ai/glm-5.2:free" });
    store.put("roster/glm", { tier: "t0", model: "z-ai/glm-5.2:free" });
    expect(store.get("roster/glm")).toEqual({ tier: "t0", model: "z-ai/glm-5.2:free" });
    store.put("roster/glm", undefined);
    expect(store.get("roster/glm")).toBeUndefined();
    store.close();
  });

  test("a new roster entry lands last, so file order stays an operator's to set", () => {
    const { store } = tempStore();
    store.seed(fixtureConfig());
    store.put("roster/newbie", { tier: "t0", model: "vendor/new:free" });
    expect(Object.keys(store.render()["roster"] as object)).toEqual(["glm", "son", "newbie"]);
    store.close();
  });

  test("every change is audited, with the before and after documents", () => {
    const { store } = tempStore();
    store.seed(fixtureConfig());
    const before = store.version();
    store.patch("roster/glm", { tier: "t2" }, { actor: "mark", note: "promote" });
    const [latest] = store.audit(1);
    expect(latest?.key).toBe("roster/glm");
    expect(latest?.actor).toBe("mark");
    expect(latest?.note).toBe("promote");
    expect((latest?.before as { tier: string }).tier).toBe("t1");
    expect((latest?.after as { tier: string }).tier).toBe("t2");
    expect(store.version()).toBeGreaterThan(before);
    store.close();
  });
});

describe("seeding", () => {
  test("seed is a no-op on a store that already has rows, unless forced", () => {
    const { store } = tempStore();
    store.seed(fixtureConfig());
    store.patch("roster/glm", { tier: "t2" });
    expect(store.seed(fixtureConfig()).seeded).toBe(false);
    expect(store.get("roster/glm")).toEqual({ tier: "t2", model: "z-ai/glm-5.2:free" });
    expect(store.seed(fixtureConfig(), { force: true }).seeded).toBe(true);
    expect(store.get("roster/glm")).toEqual({ tier: "t1", model: "z-ai/glm-5.2:free" });
    store.close();
  });

  test("a store whose file exists but was never seeded is empty, not seeded", () => {
    const { store, root } = tempStore();
    expect(store.isEmpty()).toBe(true);
    store.close();
    const reader = openConfigStore(join(root, "config.sqlite"), { readonly: true });
    expect(reader?.isEmpty()).toBe(true);
    reader?.close();
  });

  test("an invalid document is refused rather than half-imported", () => {
    const { store } = tempStore();
    expect(() => store.seed({ lanes: [] })).toThrow(ConfigRejected);
    expect(store.isEmpty()).toBe(true);
    store.close();
  });
});

describe("the read seam", () => {
  test("a store that does not exist yet is EMPTY — a fresh deployment, not an error", () => {
    const root = mkdtempSync(join(tmpdir(), "config-seam-"));
    const db = join(root, "config.sqlite");
    expect(readFleetConfig(db)).toEqual({ status: "empty", path: db });
    expect(configStoreSeeded({ WRATHBENCH_CONFIG_DB: db })).toBe(false);
  });

  test("a store file with no rows is EMPTY too, and never created by reading", () => {
    const { store, root } = tempStore();
    store.close();
    const db = join(root, "config.sqlite");
    expect(readFleetConfig(db).status).toBe("empty");
    // A read-only open of a path that is not there creates nothing.
    const missing = join(root, "nope", "config.sqlite");
    expect(readFleetConfig(missing).status).toBe("empty");
    expect(openConfigStore(missing, { readonly: true })).toBeNull();
  });

  test("a seeded store is OK, and an edit is what the next read returns", () => {
    const { store, root } = tempStore();
    const db = join(root, "config.sqlite");
    store.seed(fixtureConfig());
    const first = readFleetConfig(db);
    expect(first.status).toBe("ok");
    expect(JSON.parse((first as { text: string }).text)).toEqual(fixtureConfig());
    store.patch("roster/glm", { tier: "t2" }, { actor: "mark" });
    store.close();
    const next = readFleetConfig(db) as { status: "ok"; text: string };
    expect((JSON.parse(next.text) as { roster: Record<string, { tier: string }> }).roster["glm"]?.tier).toBe("t2");
    expect(configStoreSeeded({ WRATHBENCH_CONFIG_DB: db })).toBe(true);
  });

  test("a store that cannot be read is UNREADABLE — never EMPTY", () => {
    // The distinction this seam exists for. A supervisor that read a corrupt
    // or locked store as "zero rows" would conclude every job vanished and
    // drain the board; it must instead keep its last good config and say why.
    const root = mkdtempSync(join(tmpdir(), "config-seam-bad-"));
    const db = join(root, "config.sqlite");
    writeFileSync(db, "this is not a database");
    const r = readFleetConfig(db);
    expect(r.status).toBe("unreadable");
    expect((r as { error: string }).error.length).toBeGreaterThan(0);
  });

  test("rows() rethrows anything that is not a missing table", () => {
    // `rows()` swallows exactly one error — "no such table", the never-written
    // store — and nothing else, so a real failure surfaces as UNREADABLE
    // rather than as an empty roster.
    const root = mkdtempSync(join(tmpdir(), "config-rows-bad-"));
    const db = join(root, "config.sqlite");
    writeFileSync(db, "garbage".repeat(64));
    const reader = openConfigStore(db, { readonly: true });
    expect(reader).not.toBeNull();
    expect(() => reader!.rows()).toThrow();
    reader!.close();
  });

  test("the empty-store hint names the seed command and the page", () => {
    expect(EMPTY_STORE_HINT).toContain("config-store.ts seed infra/fleet.example.json");
    expect(EMPTY_STORE_HINT).toContain("/config");
  });

  test("configDbPath prefers the explicit path, then the data dir", () => {
    expect(configDbPath({ WRATHBENCH_CONFIG_DB: "/x/c.sqlite" })).toBe("/x/c.sqlite");
    expect(configDbPath({ WRATHBENCH_DATA: "/wrathbench/data" })).toBe("/wrathbench/data/config.sqlite");
    expect(configDbPath({})).toMatch(/data\/config\.sqlite$/);
  });
});
