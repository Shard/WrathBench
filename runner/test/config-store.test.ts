/**
 * The config store (FOLLOW-UPS item 127).
 *
 * The invariant worth pinning is not that an export is byte-identical to the
 * file — formatting is not config — but that the supervisor cannot tell the
 * difference: `parseFleet(store.render())` deep-equals `parseFleet(file)`, so
 * `--status`, the plan and every scheduling decision read the same config
 * whether the store is live or not.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  ConfigRejected,
  ConfigStore,
  configDbPath,
  openConfigStore,
  readFleetText,
  renderFleet,
  seedIfEmpty,
  splitFleet,
} from "../src/config-store";
import { parseFleet } from "../../infra/run-fleet-config";

const SHIPPED = resolve(import.meta.dir, "..", "..", "infra", "fleet.json");

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

describe("the shipped fleet.json", () => {
  test("seeds, exports identically, and parses to the same config", async () => {
    const original = JSON.parse(await Bun.file(SHIPPED).text()) as unknown;
    const { store } = tempStore();
    const { seeded, keys } = store.seedFromFile(SHIPPED);
    expect(seeded).toBe(true);
    expect(keys).toBeGreaterThan(10);
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
  test("readFleetText serves the file until the store is seeded, then the store", () => {
    const root = mkdtempSync(join(tmpdir(), "config-seam-"));
    const file = join(root, "fleet.json");
    const db = join(root, "config.sqlite");
    const env = { WRATHBENCH_CONFIG_DB: db };
    writeFileSync(file, JSON.stringify(fixtureConfig()));

    expect(JSON.parse(readFleetText(file, env))).toEqual(fixtureConfig());

    expect(seedIfEmpty(file, { actor: "fleet" }, env).seeded).toBe(true);
    const store = new ConfigStore(db);
    store.patch("roster/glm", { tier: "t2" }, { actor: "mark" });
    store.close();

    const fromStore = JSON.parse(readFleetText(file, env)) as { roster: Record<string, { tier: string }> };
    expect(fromStore.roster["glm"]?.tier).toBe("t2");
    // The file is untouched: it is the seed and the export, not the live copy.
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(fixtureConfig());
  });

  test("the boot seed happens only where a store path is configured", () => {
    // Otherwise the supervisor would seed an ephemeral store on the cluster —
    // where only subPaths of the data PVC are mounted — and stop seeing the
    // ConfigMap that Flux reconciles, which is how that deployment is steered.
    const root = mkdtempSync(join(tmpdir(), "config-seed-gate-"));
    const file = join(root, "fleet.json");
    writeFileSync(file, JSON.stringify(fixtureConfig()));
    expect(seedIfEmpty(file, {}, {}).seeded).toBe(false);
    expect(seedIfEmpty(file, {}, { WRATHBENCH_DATA: root }).seeded).toBe(true);
    expect(readFileSync(join(root, "config.sqlite")).length).toBeGreaterThan(0);
  });

  test("an unreadable store falls back to the file rather than failing the read", () => {
    const root = mkdtempSync(join(tmpdir(), "config-seam-bad-"));
    const file = join(root, "fleet.json");
    const db = join(root, "config.sqlite");
    writeFileSync(file, JSON.stringify(fixtureConfig()));
    writeFileSync(db, "this is not a database");
    expect(JSON.parse(readFleetText(file, { WRATHBENCH_CONFIG_DB: db }))).toEqual(fixtureConfig());
  });

  test("configDbPath prefers the explicit path, then the data dir", () => {
    expect(configDbPath({ WRATHBENCH_CONFIG_DB: "/x/c.sqlite" })).toBe("/x/c.sqlite");
    expect(configDbPath({ WRATHBENCH_DATA: "/wrathbench/data" })).toBe("/wrathbench/data/config.sqlite");
    expect(configDbPath({})).toMatch(/data\/config\.sqlite$/);
  });
});

